#!/usr/bin/env node
/* Log file generator.
 *
 * Produces a representative log file matching the shape:
 *   2024-03-15T14:23:01Z 192.168.1.42 GET /api/users 200 142ms
 *
 * with ~5-10% deviations of these kinds:
 *   - alternate timestamp formats (2024/03/15 14:23:01, 15-Mar-2024 14:23:01, Unix epoch)
 *   - alternate response-time units (0.142s, plain 142, no unit)
 *   - missing/replaced status codes (-)
 *   - extra appended fields (quoted user agents, referrers with spaces)
 *   - entirely malformed lines (partial writes, blanks, multi-line stack traces)
 *   - lines from a different format bolted on (JSON)
 *
 * Usage:
 *   node scripts/generate-log.js [--lines N] [--out PATH] [--deviation-rate 0.08] [--seed 42]
 *
 * Defaults to 5,000 lines into samples/generated.log with rate 0.08 and a fresh seed.
 */
'use strict';

const fs = require('fs');
const path = require('path');

// ---- args ------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    lines: 5000,
    out: path.join('samples', 'generated.log'),
    deviationRate: 0.08,
    seed: (Math.random() * 2 ** 31) | 0
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--lines' || a === '-n') opts.lines = parseInt(argv[++i], 10);
    else if (a === '--out' || a === '-o') opts.out = argv[++i];
    else if (a === '--deviation-rate' || a === '-d') opts.deviationRate = parseFloat(argv[++i]);
    else if (a === '--seed' || a === '-s') opts.seed = parseInt(argv[++i], 10);
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else { console.error('Unknown arg:', a); printHelp(); process.exit(2); }
  }
  if (!Number.isFinite(opts.lines) || opts.lines < 1) {
    console.error('--lines must be a positive integer');
    process.exit(2);
  }
  if (!(opts.deviationRate >= 0 && opts.deviationRate <= 1)) {
    console.error('--deviation-rate must be in [0, 1]');
    process.exit(2);
  }
  return opts;
}

function printHelp() {
  console.log(`Usage: node scripts/generate-log.js [options]

Options:
  -n, --lines N             Approximate number of output lines (default 5000)
  -o, --out PATH            Output path (default samples/generated.log)
  -d, --deviation-rate R    Fraction in [0,1] of deviating lines (default 0.08)
  -s, --seed N              PRNG seed for reproducible output
  -h, --help                Show this help`);
}

// ---- seedable PRNG ---------------------------------------------------

function mulberry32(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function intBetween(rng, lo, hi) { return lo + Math.floor(rng() * (hi - lo + 1)); }
function choice(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }
function pickWeighted(rng, pairs) {
  let total = 0; for (const [, w] of pairs) total += w;
  let r = rng() * total;
  for (const [v, w] of pairs) { r -= w; if (r <= 0) return v; }
  return pairs[pairs.length - 1][0];
}

// ---- realistic data --------------------------------------------------

const METHOD_W = [['GET', 70], ['POST', 18], ['PUT', 5], ['DELETE', 3], ['PATCH', 2], ['HEAD', 2]];
const STATUS_W = [
  [200, 70], [201, 3], [204, 2], [301, 1], [302, 2], [304, 5],
  [400, 2], [401, 3], [403, 2], [404, 6], [429, 1],
  [500, 2], [502, 1]
];

const PATH_TEMPLATES = [
  '/index.html', '/about', '/contact', '/healthz',
  '/static/app.css', '/static/app.js', '/static/img/logo.png', '/static/img/hero.jpg',
  '/api/users', '/api/users/{id}',
  '/api/login', '/api/logout', '/api/refresh',
  '/api/items', '/api/items/{id}',
  '/api/orders', '/api/orders/{id}',
  '/api/checkout', '/api/search',
  '/admin', '/admin/login', '/admin/dashboard'
];

const QUERY_TERMS = ['foo', 'bar', 'baz', 'qux', 'hello world', 'log analyzer', 'test'];

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64; rv:122.0) Gecko/20100101 Firefox/122.0',
  'curl/8.4.0',
  'python-requests/2.31.0',
  'PostmanRuntime/7.36.0',
  'Go-http-client/1.1'
];

const REFERERS = [
  'https://example.com/',
  'https://example.com/products?ref=home page',
  'https://google.com/search?q=log analyzer',
  'https://news.example.com/article/the latest update',
  '-'
];

function buildIpPool(rng, n) {
  // A smallish set of repeated client IPs makes top-IPs aggregations meaningful.
  const ips = [];
  for (let i = 0; i < n; i++) {
    const a = choice(rng, [10, 172, 192, 198, 203, intBetween(rng, 1, 223)]);
    const b = (a === 10) ? 0 : (a === 192) ? 168 : intBetween(rng, 0, 255);
    const c = intBetween(rng, 0, 255);
    const d = intBetween(rng, 1, 254);
    ips.push(`${a}.${b}.${c}.${d}`);
  }
  return ips;
}

function pickPath(rng) {
  const tmpl = choice(rng, PATH_TEMPLATES);
  let p = tmpl.replace('{id}', String(intBetween(rng, 1, 999)));
  if (rng() < 0.12 && p.startsWith('/api/')) {
    const term = choice(rng, QUERY_TERMS).replace(/ /g, '+');
    p += '?q=' + term + '&limit=' + intBetween(rng, 10, 100);
  }
  return p;
}

// Status weighted toward 200 normally, but skewed for some endpoints.
function pickStatus(rng, p) {
  if (p.includes('/admin/login') && rng() < 0.5) return 401;
  if (p.endsWith('/api/checkout') && rng() < 0.25) return choice(rng, [500, 500, 502]);
  if (/\/api\/items\/\d+$/.test(p) && rng() < 0.10) return 404;
  return pickWeighted(rng, STATUS_W);
}

// Response time correlated with method and status.
function pickResponseTimeMs(rng, method, status) {
  // base shape: small for static, larger for POST/checkout, much larger on 5xx
  let base;
  if (method === 'GET') base = 5 + rng() * 60;
  else if (method === 'POST') base = 20 + rng() * 200;
  else base = 10 + rng() * 100;
  if (status >= 500) base *= 6 + rng() * 4;
  if (status === 304) base = 1 + rng() * 4;
  // long tail
  if (rng() < 0.03) base *= 5 + rng() * 10;
  return Math.max(0.1, base);
}

// ---- timestamp formatting -------------------------------------------

const MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const pad2 = n => String(n).padStart(2, '0');

function fmtIso(d) {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth()+1)}-${pad2(d.getUTCDate())}T`
    + `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}Z`;
}
function fmtSlash(d) {
  return `${d.getUTCFullYear()}/${pad2(d.getUTCMonth()+1)}/${pad2(d.getUTCDate())} `
    + `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}
function fmtDDMon(d) {
  return `${pad2(d.getUTCDate())}-${MONTH_ABBR[d.getUTCMonth()]}-${d.getUTCFullYear()} `
    + `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}
function fmtEpoch(d) {
  return String(Math.floor(d.getTime() / 1000));
}

// ---- response-time formatting ---------------------------------------

function fmtRtMs(ms) {
  if (ms >= 10) return `${Math.round(ms)}ms`;
  return `${ms.toFixed(2)}ms`;
}
function fmtRtSec(ms) {
  return `${(ms / 1000).toFixed(3)}s`;
}
function fmtRtPlain(ms) {
  // No unit. Tools must guess (often ms).
  return `${Math.round(ms)}`;
}

// ---- line builders ---------------------------------------------------

function primaryLine(d, ip, method, p, status, rtMs) {
  return `${fmtIso(d)} ${ip} ${method} ${p} ${status} ${fmtRtMs(rtMs)}`;
}

function deviationLine(rng, d, ip, method, p, status, rtMs) {
  // Pick a deviation kind. Multiple kinds can compose for extra realism.
  const kind = pickWeighted(rng, [
    ['alt-timestamp', 22],
    ['alt-rt-unit', 18],
    ['missing-status', 10],
    ['extra-fields', 18],
    ['malformed', 14],
    ['stacktrace', 6],
    ['json', 12]
  ]);

  switch (kind) {
    case 'alt-timestamp': {
      const fmt = choice(rng, [fmtSlash, fmtDDMon, fmtEpoch]);
      const ts = fmt(d);
      return { kind, lines: [`${ts} ${ip} ${method} ${p} ${status} ${fmtRtMs(rtMs)}`] };
    }
    case 'alt-rt-unit': {
      const fmt = choice(rng, [fmtRtSec, fmtRtPlain]);
      return { kind, lines: [`${fmtIso(d)} ${ip} ${method} ${p} ${status} ${fmt(rtMs)}`] };
    }
    case 'missing-status': {
      // Either replace with '-' or drop entirely.
      if (rng() < 0.6) {
        return { kind, lines: [`${fmtIso(d)} ${ip} ${method} ${p} - ${fmtRtMs(rtMs)}`] };
      }
      return { kind, lines: [`${fmtIso(d)} ${ip} ${method} ${p} ${fmtRtMs(rtMs)}`] };
    }
    case 'extra-fields': {
      const ua = choice(rng, USER_AGENTS);
      const ref = choice(rng, REFERERS);
      // Append quoted referrer (often with spaces) and quoted UA, sometimes both, sometimes one.
      const which = pickWeighted(rng, [['ua', 4], ['ref', 3], ['both', 5]]);
      let extra;
      if (which === 'ua') extra = `"${ua}"`;
      else if (which === 'ref') extra = `"${ref}"`;
      else extra = `"${ref}" "${ua}"`;
      return { kind, lines: [`${fmtIso(d)} ${ip} ${method} ${p} ${status} ${fmtRtMs(rtMs)} ${extra}`] };
    }
    case 'malformed': {
      const sub = pickWeighted(rng, [['blank', 3], ['partial', 5], ['junk', 2]]);
      if (sub === 'blank') return { kind, lines: [''] };
      if (sub === 'partial') {
        // Truncated mid-line, as if a write was cut off.
        const full = primaryLine(d, ip, method, p, status, rtMs);
        const cut = intBetween(rng, Math.floor(full.length * 0.2), Math.max(1, full.length - 5));
        return { kind, lines: [full.slice(0, cut)] };
      }
      // junk
      const junk = choice(rng, [
        '*** logger restart ***',
        '## checkpoint',
        'NOTICE: rotating log files',
        '????? unknown ?????',
        'connection reset by peer',
        '----- end of batch -----'
      ]);
      return { kind, lines: [junk] };
    }
    case 'stacktrace': {
      // A multi-line stack trace interrupting the flow. Each line is malformed.
      const exc = choice(rng, [
        'ValueError: invalid literal for int() with base 10: \'xyz\'',
        'NullPointerException at com.example.Foo.handle(Foo.java:42)',
        'TypeError: Cannot read properties of undefined (reading \'id\')',
        'sqlalchemy.exc.OperationalError: (psycopg2.OperationalError) connection refused'
      ]);
      const lines = [
        'Traceback (most recent call last):',
        '  File "app.py", line ' + intBetween(rng, 10, 400) + ', in handler',
        '    result = service.process(payload)',
        '  File "service.py", line ' + intBetween(rng, 10, 400) + ', in process',
        '    raise ' + exc.split(':')[0] + '(' + JSON.stringify(exc) + ')',
        exc
      ];
      return { kind, lines };
    }
    case 'json': {
      // A bolted-on JSON logger format, possibly with extra fields.
      const obj = {
        ts: fmtIso(d),
        ip,
        method,
        path: p,
        status,
        latency_ms: Math.round(rtMs * 100) / 100,
        ua: choice(rng, USER_AGENTS)
      };
      if (rng() < 0.3) obj.referer = choice(rng, REFERERS);
      if (status >= 400 && rng() < 0.5) obj.error = 'request failed';
      return { kind, lines: [JSON.stringify(obj)] };
    }
  }
}

// ---- main ------------------------------------------------------------

function main() {
  const opts = parseArgs(process.argv);
  const rng = mulberry32(opts.seed);

  // Resolve output relative to cwd; create parent dir.
  const outPath = path.resolve(process.cwd(), opts.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const ipPool = buildIpPool(rng, intBetween(rng, 25, 60));
  // Time base: a random recent date, advancing by a small jitter per line.
  let cursor = Date.now() - intBetween(rng, 1, 30) * 86400 * 1000;

  const stats = {
    total: 0,
    primary: 0,
    deviationsByKind: {}
  };

  const stream = fs.createWriteStream(outPath);
  const BUF_FLUSH = 1024;
  let buf = [];

  let written = 0;
  while (written < opts.lines) {
    cursor += intBetween(rng, 50, 5000); // 50ms - 5s gap
    const d = new Date(cursor);
    const ip = choice(rng, ipPool);
    const method = pickWeighted(rng, METHOD_W);
    const p = pickPath(rng);
    const status = pickStatus(rng, p);
    const rtMs = pickResponseTimeMs(rng, method, status);

    if (rng() < opts.deviationRate) {
      const dev = deviationLine(rng, d, ip, method, p, status, rtMs);
      stats.deviationsByKind[dev.kind] = (stats.deviationsByKind[dev.kind] || 0) + 1;
      for (const ln of dev.lines) {
        buf.push(ln);
        written++;
        stats.total++;
        if (written >= opts.lines) break;
      }
    } else {
      buf.push(primaryLine(d, ip, method, p, status, rtMs));
      written++;
      stats.total++;
      stats.primary++;
    }

    if (buf.length >= BUF_FLUSH) {
      stream.write(buf.join('\n') + '\n');
      buf = [];
    }
  }
  if (buf.length) stream.write(buf.join('\n') + '\n');
  stream.end();

  stream.on('finish', () => {
    const totalDev = Object.values(stats.deviationsByKind).reduce((a, b) => a + b, 0);
    const devPct = stats.total > 0 ? (totalDev / stats.total) * 100 : 0;
    console.log(`Wrote ${stats.total.toLocaleString()} lines to ${outPath}`);
    console.log(`Seed: ${opts.seed}  Target deviation rate: ${(opts.deviationRate * 100).toFixed(1)}%`);
    console.log(`Primary lines: ${stats.primary.toLocaleString()}`);
    console.log(`Deviation events: ${totalDev.toLocaleString()} (~${devPct.toFixed(2)}% of lines, note: stacktrace/multiline events expand into several lines)`);
    const kinds = Object.entries(stats.deviationsByKind).sort((a, b) => b[1] - a[1]);
    for (const [k, v] of kinds) console.log(`  ${k.padEnd(16)} ${v}`);
  });
}

main();
