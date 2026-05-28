/* Aggregates parsed log records into a report.
 *
 * Public API:
 *   const a = new LogAnalyzer();
 *   a.add(parseResult)          // accumulate one parse result (ok or not)
 *   a.finalize()                // returns { summary, charts, tables, formats, skipped }
 */
(function (global) {
  'use strict';

  const TOP_N = 10;
  const MAX_SKIPPED_SAMPLES = 50;
  const MAX_TIMELINE_BUCKETS = 60;

  // p95 over a sorted ascending array of numbers.
  function percentile(sortedAsc, p) {
    if (!sortedAsc.length) return null;
    const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1));
    return sortedAsc[idx];
  }

  function chooseBucketSizeMs(spanMs) {
    // Pick a bucket so we get ~30-60 buckets across the span, snapped to a friendly size.
    if (spanMs <= 0) return 1000;
    const target = spanMs / MAX_TIMELINE_BUCKETS;
    const friendly = [
      1000, 5000, 10000, 30000,
      60000, 5 * 60000, 10 * 60000, 30 * 60000,
      3600000, 6 * 3600000, 12 * 3600000,
      86400000, 7 * 86400000
    ];
    for (const f of friendly) if (f >= target) return f;
    return friendly[friendly.length - 1];
  }

  function bucketLabel(date, sizeMs) {
    const d = new Date(Math.floor(date.getTime() / sizeMs) * sizeMs);
    const pad = (n) => String(n).padStart(2, '0');
    if (sizeMs >= 86400000) {
      return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    }
    if (sizeMs >= 3600000) {
      return `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:00`;
    }
    if (sizeMs >= 60000) {
      return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
    }
    return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  }

  function statusClass(code) {
    if (code == null) return 'unknown';
    if (code < 200) return '1xx';
    if (code < 300) return '2xx';
    if (code < 400) return '3xx';
    if (code < 500) return '4xx';
    if (code < 600) return '5xx';
    return 'other';
  }

  function topN(map, n) {
    return Array.from(map.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, n);
  }

  function LogAnalyzer() {
    this.totalLines = 0;
    this.okCount = 0;
    this.skippedCount = 0;
    this.skippedSamples = []; // { lineNo, reason, raw }
    this.formatCounts = new Map();
    this.statusCounts = new Map();
    this.statusClassCounts = new Map();
    this.methodCounts = new Map();
    this.pathCounts = new Map();
    this.ipCounts = new Map();
    this.errorByPath = new Map(); // path -> { count, statuses: Map, sampleIp }
    this.responseTimes = [];
    this.responseTimesByPath = new Map(); // path -> array of times
    this.timestamps = [];
    this.minTime = null;
    this.maxTime = null;
    this.totalBytes = 0;
    this.bytesKnown = 0;

    // anomalies
    this.anomalies = {
      missingTimestamp: 0,
      missingStatus: 0,
      missingIp: 0,
      missingMethod: 0,
      futureTimestamp: 0,
      veryOldTimestamp: 0
    };

    // raw event series for timeline (we'll bucket at finalize)
    this._timeEvents = []; // ms epoch
  }

  LogAnalyzer.prototype.add = function (result) {
    this.totalLines += 1;

    if (!result || !result.ok) {
      this.skippedCount += 1;
      if (this.skippedSamples.length < MAX_SKIPPED_SAMPLES) {
        this.skippedSamples.push({
          lineNo: this.totalLines,
          reason: (result && result.reason) || 'unrecognized',
          raw: (result && result.record && result.record.raw) || ''
        });
      }
      const fmt = (result && result.format) || 'unrecognized';
      this.formatCounts.set(fmt, (this.formatCounts.get(fmt) || 0) + 1);
      return;
    }

    this.okCount += 1;
    const r = result.record;
    this.formatCounts.set(result.format, (this.formatCounts.get(result.format) || 0) + 1);

    // status
    if (r.status != null) {
      this.statusCounts.set(r.status, (this.statusCounts.get(r.status) || 0) + 1);
      const cls = statusClass(r.status);
      this.statusClassCounts.set(cls, (this.statusClassCounts.get(cls) || 0) + 1);
    } else {
      this.anomalies.missingStatus += 1;
      this.statusClassCounts.set('unknown', (this.statusClassCounts.get('unknown') || 0) + 1);
    }

    // method
    if (r.method) {
      this.methodCounts.set(r.method, (this.methodCounts.get(r.method) || 0) + 1);
    } else {
      this.anomalies.missingMethod += 1;
    }

    // path
    if (r.path) {
      // Strip query string for grouping
      const pathKey = r.path.split('?')[0];
      this.pathCounts.set(pathKey, (this.pathCounts.get(pathKey) || 0) + 1);
      if (r.responseTimeMs != null && isFinite(r.responseTimeMs)) {
        let arr = this.responseTimesByPath.get(pathKey);
        if (!arr) { arr = []; this.responseTimesByPath.set(pathKey, arr); }
        arr.push(r.responseTimeMs);
      }
      if (r.status != null && r.status >= 400) {
        let entry = this.errorByPath.get(pathKey);
        if (!entry) {
          entry = { count: 0, statuses: new Map(), sampleIp: null };
          this.errorByPath.set(pathKey, entry);
        }
        entry.count += 1;
        entry.statuses.set(r.status, (entry.statuses.get(r.status) || 0) + 1);
        if (!entry.sampleIp && r.ip) entry.sampleIp = r.ip;
      }
    }

    // ip
    if (r.ip) {
      this.ipCounts.set(r.ip, (this.ipCounts.get(r.ip) || 0) + 1);
    } else {
      this.anomalies.missingIp += 1;
    }

    // response time
    if (r.responseTimeMs != null && isFinite(r.responseTimeMs)) {
      this.responseTimes.push(r.responseTimeMs);
    }

    // bytes
    if (r.bytes != null && isFinite(r.bytes)) {
      this.totalBytes += r.bytes;
      this.bytesKnown += 1;
    }

    // timestamp
    if (r.timestamp instanceof Date && !isNaN(r.timestamp.getTime())) {
      const t = r.timestamp.getTime();
      this._timeEvents.push(t);
      if (this.minTime === null || t < this.minTime) this.minTime = t;
      if (this.maxTime === null || t > this.maxTime) this.maxTime = t;
      const now = Date.now();
      if (t > now + 24 * 3600 * 1000) this.anomalies.futureTimestamp += 1;
      if (t < now - 10 * 365 * 24 * 3600 * 1000) this.anomalies.veryOldTimestamp += 1;
    } else {
      this.anomalies.missingTimestamp += 1;
    }
  };

  LogAnalyzer.prototype.finalize = function () {
    // Response time stats
    const rts = this.responseTimes.slice().sort((a, b) => a - b);
    const rtStats = {
      count: rts.length,
      min: rts.length ? rts[0] : null,
      max: rts.length ? rts[rts.length - 1] : null,
      avg: rts.length ? rts.reduce((s, v) => s + v, 0) / rts.length : null,
      p50: percentile(rts, 50),
      p95: percentile(rts, 95),
      p99: percentile(rts, 99)
    };

    // Histogram for response times: log-spaced buckets.
    const rtHistogram = buildResponseTimeHistogram(rts);

    // Timeline buckets
    let timeline = { labels: [], counts: [], bucketSizeMs: null };
    if (this._timeEvents.length && this.minTime != null && this.maxTime != null) {
      const span = Math.max(1, this.maxTime - this.minTime);
      const bucketMs = chooseBucketSizeMs(span);
      const buckets = new Map();
      for (const t of this._timeEvents) {
        const b = Math.floor(t / bucketMs) * bucketMs;
        buckets.set(b, (buckets.get(b) || 0) + 1);
      }
      // Fill empty buckets in range so chart isn't lying about gaps
      const startB = Math.floor(this.minTime / bucketMs) * bucketMs;
      const endB = Math.floor(this.maxTime / bucketMs) * bucketMs;
      const labels = [];
      const counts = [];
      // Cap iterations to avoid runaway in extreme cases.
      const maxIter = MAX_TIMELINE_BUCKETS * 4;
      let iter = 0;
      for (let b = startB; b <= endB && iter < maxIter; b += bucketMs, iter++) {
        labels.push(bucketLabel(new Date(b), bucketMs));
        counts.push(buckets.get(b) || 0);
      }
      timeline = { labels, counts, bucketSizeMs: bucketMs };
    }

    // Top paths / ips
    const topPaths = topN(this.pathCounts, TOP_N);
    const topIps = topN(this.ipCounts, TOP_N);

    // Slow endpoints — only paths with at least a few timed requests.
    const slow = [];
    for (const [path, times] of this.responseTimesByPath) {
      if (times.length < 1) continue;
      const sorted = times.slice().sort((a, b) => a - b);
      const avg = sorted.reduce((s, v) => s + v, 0) / sorted.length;
      slow.push({
        path,
        count: sorted.length,
        avg,
        p95: percentile(sorted, 95),
        max: sorted[sorted.length - 1]
      });
    }
    slow.sort((a, b) => b.avg - a.avg);
    const slowTop = slow.slice(0, TOP_N);

    // Top error endpoints
    const errors = [];
    for (const [path, info] of this.errorByPath) {
      const top = Array.from(info.statuses.entries()).sort((a, b) => b[1] - a[1])[0];
      errors.push({
        path,
        count: info.count,
        topStatus: top ? top[0] : null,
        sampleIp: info.sampleIp || null
      });
    }
    errors.sort((a, b) => b.count - a.count);
    const errorsTop = errors.slice(0, TOP_N);

    // Format breakdown
    const totalForFmt = this.totalLines || 1;
    const formats = Array.from(this.formatCounts.entries())
      .map(([name, count]) => ({ name, count, pct: count / totalForFmt }))
      .sort((a, b) => b.count - a.count);

    // Status code class ordering for chart
    const classOrder = ['1xx', '2xx', '3xx', '4xx', '5xx', 'unknown', 'other'];
    const statusClassData = classOrder
      .filter(k => this.statusClassCounts.has(k))
      .map(k => ({ label: k, count: this.statusClassCounts.get(k) }));

    const statusCodeData = Array.from(this.statusCounts.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([code, count]) => ({ label: String(code), count }));

    const methodData = Array.from(this.methodCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([m, c]) => ({ label: m, count: c }));

    const errors4xx = (this.statusClassCounts.get('4xx') || 0);
    const errors5xx = (this.statusClassCounts.get('5xx') || 0);
    const errorRate = this.okCount > 0 ? (errors4xx + errors5xx) / this.okCount : 0;

    return {
      summary: {
        totalLines: this.totalLines,
        parsed: this.okCount,
        skipped: this.skippedCount,
        skipRate: this.totalLines > 0 ? this.skippedCount / this.totalLines : 0,
        firstTimestamp: this.minTime ? new Date(this.minTime) : null,
        lastTimestamp: this.maxTime ? new Date(this.maxTime) : null,
        spanMs: (this.minTime != null && this.maxTime != null) ? this.maxTime - this.minTime : null,
        uniqueIps: this.ipCounts.size,
        uniquePaths: this.pathCounts.size,
        totalBytes: this.totalBytes,
        bytesKnown: this.bytesKnown,
        errors4xx, errors5xx, errorRate,
        responseTime: rtStats,
        anomalies: this.anomalies,
        formatsDetected: formats.length
      },
      charts: {
        statusClass: statusClassData,
        statusCode: statusCodeData,
        methods: methodData,
        topPaths: topPaths.map(([label, count]) => ({ label, count })),
        topIps: topIps.map(([label, count]) => ({ label, count })),
        timeline,
        responseTimeHistogram: rtHistogram
      },
      tables: { slowTop, errorsTop },
      formats,
      skipped: {
        total: this.skippedCount,
        samples: this.skippedSamples
      }
    };
  };

  function buildResponseTimeHistogram(sortedAsc) {
    if (!sortedAsc.length) return { labels: [], counts: [] };
    // Buckets: <1, 1-5, 5-10, 10-50, 50-100, 100-250, 250-500, 500-1000, 1000-2500, 2500-5000, >5000 (ms)
    const edges = [0, 1, 5, 10, 50, 100, 250, 500, 1000, 2500, 5000];
    const labels = [];
    for (let i = 0; i < edges.length; i++) {
      if (i === 0) labels.push('<1 ms');
      else labels.push(`${edges[i - 1]}-${edges[i]} ms`);
    }
    labels.push(`>${edges[edges.length - 1]} ms`);

    const counts = new Array(labels.length).fill(0);
    for (const v of sortedAsc) {
      let idx = labels.length - 1;
      for (let i = 0; i < edges.length; i++) {
        if (v < edges[i]) { idx = i; break; }
      }
      // Map: v < edges[1] -> bucket 1 (1-5 if v in [0,1)? actually we want <1 = bucket 0)
      // Simpler: rebuild
      let bucket;
      if (v < 1) bucket = 0;
      else if (v < 5) bucket = 1;
      else if (v < 10) bucket = 2;
      else if (v < 50) bucket = 3;
      else if (v < 100) bucket = 4;
      else if (v < 250) bucket = 5;
      else if (v < 500) bucket = 6;
      else if (v < 1000) bucket = 7;
      else if (v < 2500) bucket = 8;
      else if (v < 5000) bucket = 9;
      else bucket = 10;
      counts[bucket] += 1;
    }
    return { labels, counts };
  }

  global.LogAnalyzer = LogAnalyzer;
})(typeof window !== 'undefined' ? window : globalThis);
