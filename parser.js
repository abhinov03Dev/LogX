/* Log line parser.
 *
 * Goal: be tolerant. Try several known web-server log shapes, tag which
 * format matched each line, and fall back to permissive field extraction
 * before declaring a line malformed. Never throw on input.
 *
 * Public API:
 *   LogParser.parseLine(line) -> {
 *     ok: boolean,
 *     format: string,                 // e.g. "combined", "common", "iso-structured", "fallback"
 *     reason?: string,                // when ok=false, why
 *     record?: {
 *       timestamp: Date | null,
 *       ip: string | null,
 *       method: string | null,
 *       path: string | null,
 *       protocol: string | null,
 *       status: number | null,
 *       bytes: number | null,
 *       responseTimeMs: number | null,
 *       userAgent: string | null,
 *       referer: string | null,
 *       raw: string
 *     }
 *   }
 */
(function (global) {
  'use strict';

  // ---- helpers ---------------------------------------------------------

  const MONTHS = {
    Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
    Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11
  };

  // Parses Apache-style "10/Oct/2000:13:55:36 -0700"
  function parseClfDate(s) {
    if (!s) return null;
    const m = s.match(/^(\d{2})\/([A-Za-z]{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2})\s*([+-]\d{4})?$/);
    if (!m) return null;
    const day = parseInt(m[1], 10);
    const mon = MONTHS[m[2]];
    if (mon === undefined) return null;
    const year = parseInt(m[3], 10);
    const hh = parseInt(m[4], 10);
    const mm = parseInt(m[5], 10);
    const ss = parseInt(m[6], 10);
    const tz = m[7];
    let iso = `${year}-${String(mon + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
    if (tz) {
      iso += tz.slice(0, 3) + ':' + tz.slice(3);
    } else {
      iso += 'Z';
    }
    const d = new Date(iso);
    return isNaN(d.getTime()) ? null : d;
  }

  // Parses ISO-ish timestamps: 2024-01-15T10:23:45[.fff][Z|±hh:mm], or "2024-01-15 10:23:45"
  function parseIsoDate(s) {
    if (!s) return null;
    // Direct attempt
    let d = new Date(s);
    if (!isNaN(d.getTime())) return d;
    // Replace space with T
    const s2 = s.replace(' ', 'T');
    d = new Date(s2);
    return isNaN(d.getTime()) ? null : d;
  }

  // Convert a number + optional unit string into milliseconds.
  // Examples: "45" + "ms" -> 45; "0.234" + "" or "s" -> 234; "1200" + "us"/"µs" -> 1.2
  function toMillis(numStr, unitRaw) {
    if (numStr == null || numStr === '') return null;
    const n = Number(numStr);
    if (!isFinite(n)) return null;
    const unit = (unitRaw || '').toLowerCase().trim();
    if (unit === 'ms') return n;
    if (unit === 'us' || unit === 'µs') return n / 1000;
    if (unit === 'ns') return n / 1e6;
    if (unit === 's' || unit === 'sec' || unit === 'secs') return n * 1000;
    // No unit: heuristic. Apache %D is microseconds (often big int).
    // Apache %T is seconds (small float). Many custom logs append ms as int.
    if (Number.isInteger(n) && n > 1000) return n / 1000; // treat as microseconds
    if (n > 0 && n < 60 && /\./.test(String(numStr))) return n * 1000; // treat as seconds
    return n; // treat as ms
  }

  function safeInt(s) {
    if (s == null || s === '' || s === '-') return null;
    const n = parseInt(s, 10);
    return Number.isFinite(n) ? n : null;
  }

  // ---- regexes ---------------------------------------------------------

  // Combined Log Format with optional trailing response time:
  //   host ident authuser [date] "METHOD path proto" status bytes "referer" "ua" [resp_time[unit]]
  // Tolerates "-" for missing fields and bytes.
  const RX_COMBINED = new RegExp(
    '^(\\S+)\\s+'                         // 1: host/ip
    + '(\\S+)\\s+'                        // 2: ident (often -)
    + '(\\S+)\\s+'                        // 3: authuser (often -)
    + '\\[([^\\]]+)\\]\\s+'               // 4: date
    + '"([^"]*)"\\s+'                     // 5: request line
    + '(\\d{3}|-)\\s+'                    // 6: status
    + '(\\d+|-)'                          // 7: bytes
    + '(?:\\s+"([^"]*)"\\s+"([^"]*)")?'   // 8,9: referer, ua (optional -> "common")
    + '(?:\\s+(\\d+(?:\\.\\d+)?)\\s*(ms|us|µs|ns|s)?)?' // 10,11: optional resp time + unit
    + '\\s*$'
  );

  // Bare Common Log Format (no quoted ua/referer, optional trailing resp time)
  const RX_COMMON = new RegExp(
    '^(\\S+)\\s+'
    + '(\\S+)\\s+'
    + '(\\S+)\\s+'
    + '\\[([^\\]]+)\\]\\s+'
    + '"([^"]*)"\\s+'
    + '(\\d{3}|-)\\s+'
    + '(\\d+|-)'
    + '(?:\\s+(\\d+(?:\\.\\d+)?)\\s*(ms|us|µs|ns|s)?)?'
    + '\\s*$'
  );

  // ISO-leading "structured" line, several variations. Time first, then either:
  //   <ip> <METHOD> <path> <status> [resp_time[unit]]
  //   <ip> "<METHOD path proto>" <status> <bytes> [resp_time[unit]]
  //   [LEVEL] <ip> "<METHOD path proto>" <status> ...
  const RX_ISO_LEADING_TIME = /^\[?\s*(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+\-]\d{2}:?\d{2})?)\s*\]?\s*(.*)$/;

  // After stripping leading time, try these tails:
  const RX_ISO_TAIL_QUOTED = new RegExp(
    '^(?:\\[?[A-Z]+\\]?\\s+)?'                                  // optional [INFO]/INFO/etc
    + '(\\S+)\\s+'                                              // 1: ip
    + '"([A-Z]+)\\s+(\\S+)(?:\\s+(HTTP\\/\\d(?:\\.\\d)?))?"\\s+' // 2,3,4 method,path,proto
    + '(\\d{3})'                                                // 5: status
    + '(?:\\s+(\\d+|-))?'                                       // 6: bytes
    + '(?:\\s+(\\d+(?:\\.\\d+)?)\\s*(ms|us|µs|ns|s)?)?'         // 7,8 resp time
    + '\\s*$'
  );

  const RX_ISO_TAIL_BARE = new RegExp(
    '^(?:\\[?[A-Z]+\\]?\\s+)?'
    + '(\\S+)\\s+'                                              // 1: ip
    + '([A-Z]+)\\s+'                                            // 2: method
    + '(\\S+)\\s+'                                              // 3: path
    + '(\\d{3})'                                                // 4: status
    + '(?:\\s+(\\d+|-))?'                                       // 5: bytes
    + '(?:\\s+(\\d+(?:\\.\\d+)?)\\s*(ms|us|µs|ns|s)?)?'         // 6,7 resp time
    + '\\s*$'
  );

  // Loose IP pattern (v4 only — v6 too varied to extract reliably from arbitrary text)
  const RX_IPV4 = /\b((?:\d{1,3}\.){3}\d{1,3})\b/;
  // Quoted request line anywhere
  const RX_REQUEST_QUOTED = /"([A-Z]+)\s+(\S+?)(?:\s+(HTTP\/\d(?:\.\d)?))?"/;
  // Status code: 3 digits, ideally surrounded by whitespace
  const RX_STATUS_LOOSE = /(?:^|\s)(1\d{2}|2\d{2}|3\d{2}|4\d{2}|5\d{2})(?:\s|$)/;
  // Trailing response time
  const RX_RESPTIME_LOOSE = /(\d+(?:\.\d+)?)\s*(ms|us|µs|ns|s)\b/i;

  function makeRecord(raw) {
    return {
      timestamp: null,
      ip: null,
      method: null,
      path: null,
      protocol: null,
      status: null,
      bytes: null,
      responseTimeMs: null,
      userAgent: null,
      referer: null,
      raw: raw
    };
  }

  function parseRequestLine(req) {
    if (!req || req === '-') return { method: null, path: null, protocol: null };
    // "GET /path HTTP/1.1"
    const parts = req.split(/\s+/);
    if (parts.length === 1) return { method: null, path: parts[0] || null, protocol: null };
    if (parts.length === 2) return { method: parts[0], path: parts[1], protocol: null };
    return { method: parts[0], path: parts[1], protocol: parts.slice(2).join(' ') };
  }

  // ---- main entry ------------------------------------------------------

  function parseLine(rawLine) {
    if (rawLine == null) {
      return { ok: false, format: 'empty', reason: 'null line' };
    }
    const line = String(rawLine).replace(/\r$/, '');
    const trimmed = line.trim();
    if (trimmed === '') {
      return { ok: false, format: 'empty', reason: 'blank line' };
    }

    // Try Combined Log Format first (it's a superset of Common)
    let m = RX_COMBINED.exec(line);
    if (m) {
      const rec = makeRecord(line);
      rec.ip = m[1] === '-' ? null : m[1];
      rec.timestamp = parseClfDate(m[4]);
      const req = parseRequestLine(m[5]);
      rec.method = req.method;
      rec.path = req.path;
      rec.protocol = req.protocol;
      rec.status = safeInt(m[6]);
      rec.bytes = safeInt(m[7]);
      rec.referer = m[8] || null;
      rec.userAgent = m[9] || null;
      rec.responseTimeMs = m[10] != null ? toMillis(m[10], m[11]) : null;
      const fmt = (m[8] != null) ? 'combined' : 'common';
      return { ok: true, format: fmt, record: rec };
    }

    // Try plain Common Log Format
    m = RX_COMMON.exec(line);
    if (m) {
      const rec = makeRecord(line);
      rec.ip = m[1] === '-' ? null : m[1];
      rec.timestamp = parseClfDate(m[4]);
      const req = parseRequestLine(m[5]);
      rec.method = req.method;
      rec.path = req.path;
      rec.protocol = req.protocol;
      rec.status = safeInt(m[6]);
      rec.bytes = safeInt(m[7]);
      rec.responseTimeMs = m[8] != null ? toMillis(m[8], m[9]) : null;
      return { ok: true, format: 'common', record: rec };
    }

    // Try ISO-leading structured format
    const iso = RX_ISO_LEADING_TIME.exec(line);
    if (iso) {
      const ts = parseIsoDate(iso[1]);
      const tail = iso[2] || '';
      let tm = RX_ISO_TAIL_QUOTED.exec(tail);
      if (tm && ts) {
        const rec = makeRecord(line);
        rec.timestamp = ts;
        rec.ip = tm[1];
        rec.method = tm[2];
        rec.path = tm[3];
        rec.protocol = tm[4] || null;
        rec.status = safeInt(tm[5]);
        rec.bytes = safeInt(tm[6]);
        rec.responseTimeMs = tm[7] != null ? toMillis(tm[7], tm[8]) : null;
        return { ok: true, format: 'iso-structured', record: rec };
      }
      tm = RX_ISO_TAIL_BARE.exec(tail);
      if (tm && ts) {
        const rec = makeRecord(line);
        rec.timestamp = ts;
        rec.ip = tm[1];
        rec.method = tm[2];
        rec.path = tm[3];
        rec.status = safeInt(tm[4]);
        rec.bytes = safeInt(tm[5]);
        rec.responseTimeMs = tm[6] != null ? toMillis(tm[6], tm[7]) : null;
        return { ok: true, format: 'iso-structured', record: rec };
      }
      // ISO timestamp present but tail unrecognized — fall through to fallback,
      // we'll still try to salvage the timestamp.
    }

    // Fallback: scrape what we can from anywhere in the line.
    // Only accept as "ok" if at least timestamp + (status or method) or (ip + status) make sense.
    const rec = makeRecord(line);

    // timestamp
    if (iso) rec.timestamp = parseIsoDate(iso[1]);
    if (!rec.timestamp) {
      const bracket = line.match(/\[([^\]]+)\]/);
      if (bracket) rec.timestamp = parseClfDate(bracket[1]) || parseIsoDate(bracket[1]);
    }
    // ip
    const ipM = RX_IPV4.exec(line);
    if (ipM) rec.ip = ipM[1];
    // request
    const reqM = RX_REQUEST_QUOTED.exec(line);
    if (reqM) {
      rec.method = reqM[1];
      rec.path = reqM[2];
      rec.protocol = reqM[3] || null;
    } else {
      // try unquoted "GET /path"
      const unq = line.match(/\b(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|CONNECT|TRACE)\s+(\S+)/);
      if (unq) { rec.method = unq[1]; rec.path = unq[2]; }
    }
    const stM = RX_STATUS_LOOSE.exec(line);
    if (stM) rec.status = safeInt(stM[1]);
    const rtM = RX_RESPTIME_LOOSE.exec(line);
    if (rtM) rec.responseTimeMs = toMillis(rtM[1], rtM[2]);

    const score =
      (rec.timestamp ? 1 : 0) +
      (rec.ip ? 1 : 0) +
      (rec.method ? 1 : 0) +
      (rec.status ? 1 : 0);

    if (score >= 2) {
      return { ok: true, format: 'fallback', record: rec };
    }

    return {
      ok: false,
      format: 'unrecognized',
      reason: rec.timestamp ? 'recognized timestamp but no request/status fields'
            : rec.ip ? 'has IP but no request/status fields'
            : 'no recognizable fields',
      record: rec
    };
  }

  global.LogParser = { parseLine };
})(typeof window !== 'undefined' ? window : globalThis);
