/* App glue: file intake -> streaming parse -> analyzer -> render. */
(function () {
  'use strict';

  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('fileInput');
  const fileMeta = document.getElementById('fileMeta');
  const progressCard = document.getElementById('progress');
  const progressFill = document.getElementById('progressFill');
  const progressText = document.getElementById('progressText');
  const reportSection = document.getElementById('report');
  const resetBtn = document.getElementById('resetBtn');
  const downloadBtn = document.getElementById('downloadBtn');

  let lastReport = null;
  let lastFileName = null;
  const charts = {}; // keep refs so we can destroy on rerun

  // ---- intake ---------------------------------------------------------

  function handleFiles(files) {
    if (!files || !files.length) return;
    const file = files[0];
    if (!file) return;
    lastFileName = file.name;
    fileMeta.classList.remove('hidden');
    fileMeta.textContent = `Selected: ${file.name} (${formatBytes(file.size)})`;
    runAnalysis(file).catch(err => {
      console.error(err);
      progressText.textContent = `Error: ${err && err.message ? err.message : err}`;
    });
  }

  fileInput.addEventListener('change', e => handleFiles(e.target.files));
  dropzone.addEventListener('dragover', e => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
  dropzone.addEventListener('drop', e => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    if (e.dataTransfer && e.dataTransfer.files) handleFiles(e.dataTransfer.files);
  });
  dropzone.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
  });

  resetBtn.addEventListener('click', () => {
    reportSection.classList.add('hidden');
    progressCard.classList.add('hidden');
    fileMeta.classList.add('hidden');
    fileInput.value = '';
    destroyCharts();
    lastReport = null;
    lastFileName = null;
  });

  downloadBtn.addEventListener('click', () => {
    if (!lastReport) return;
    const exportable = makeExportable(lastReport);
    const blob = new Blob([JSON.stringify(exportable, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (lastFileName || 'log') + '.report.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });

  // ---- analysis pipeline ---------------------------------------------

  async function runAnalysis(file) {
    destroyCharts();
    reportSection.classList.add('hidden');
    progressCard.classList.remove('hidden');
    progressFill.style.width = '0%';
    progressText.textContent = 'Reading…';

    const analyzer = new LogAnalyzer();
    const totalSize = file.size || 0;
    let bytesRead = 0;
    let leftover = '';

    const stream = file.stream ? file.stream() : null;

    if (stream && typeof TextDecoder !== 'undefined') {
      const decoder = new TextDecoder('utf-8', { fatal: false });
      const reader = stream.getReader();
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        bytesRead += value.byteLength;
        const text = leftover + decoder.decode(value, { stream: true });
        const lastNl = text.lastIndexOf('\n');
        let chunk;
        if (lastNl === -1) {
          leftover = text;
          chunk = '';
        } else {
          chunk = text.slice(0, lastNl);
          leftover = text.slice(lastNl + 1);
        }
        if (chunk) processChunk(chunk, analyzer);
        updateProgress(bytesRead, totalSize, analyzer.totalLines);
        // Yield to keep UI responsive
        await new Promise(r => setTimeout(r, 0));
      }
      // flush decoder
      const tail = leftover + decoder.decode();
      if (tail) processChunk(tail, analyzer);
    } else {
      // Fallback: read whole file as text
      const text = await file.text();
      bytesRead = totalSize;
      processChunk(text, analyzer);
      updateProgress(bytesRead, totalSize, analyzer.totalLines);
    }

    progressText.textContent = 'Building report…';
    await new Promise(r => setTimeout(r, 0));

    const report = analyzer.finalize();
    lastReport = report;
    render(report);

    progressCard.classList.add('hidden');
  }

  function processChunk(chunk, analyzer) {
    // Split on \n; \r is stripped inside parseLine.
    const lines = chunk.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // skip purely empty trailing entries
      if (line === '' && i === lines.length - 1) continue;
      let result;
      try {
        result = LogParser.parseLine(line);
      } catch (e) {
        result = { ok: false, format: 'parse-error', reason: 'parser threw: ' + e.message, record: { raw: line } };
      }
      analyzer.add(result);
    }
  }

  function updateProgress(bytesRead, totalSize, lines) {
    let pct = totalSize > 0 ? Math.min(100, (bytesRead / totalSize) * 100) : 0;
    progressFill.style.width = pct.toFixed(1) + '%';
    progressText.textContent = `Reading… ${formatBytes(bytesRead)}${totalSize ? ' / ' + formatBytes(totalSize) : ''} • ${lines.toLocaleString()} lines`;
  }

  // ---- rendering ------------------------------------------------------

  function render(report) {
    reportSection.classList.remove('hidden');
    renderSummary(report.summary);
    renderAnomalyBanner(report);
    renderStatusClass(report.charts.statusClass);
    renderMethods(report.charts.methods);
    renderTimeline(report.charts.timeline);
    renderTopPaths(report.charts.topPaths);
    renderTopIps(report.charts.topIps);
    renderResponseTimeHistogram(report.charts.responseTimeHistogram, report.summary.responseTime);
    renderStatusCodes(report.charts.statusCode);
    renderSlowTable(report.tables.slowTop);
    renderErrorTable(report.tables.errorsTop);
    renderFormats(report.formats, report.summary.totalLines);
    renderSkipped(report.skipped);
  }

  function metric(label, value, cls) {
    const el = document.createElement('div');
    el.className = 'metric' + (cls ? ' ' + cls : '');
    const l = document.createElement('span'); l.className = 'label'; l.textContent = label;
    const v = document.createElement('span'); v.className = 'value'; v.textContent = value;
    el.appendChild(l); el.appendChild(v);
    return el;
  }

  function renderSummary(s) {
    const grid = document.getElementById('summaryGrid');
    grid.innerHTML = '';
    grid.appendChild(metric('Total lines', s.totalLines.toLocaleString()));
    grid.appendChild(metric('Parsed', s.parsed.toLocaleString(), s.skipped > 0 ? '' : 'good'));
    const skipCls = s.skipRate > 0.10 ? 'bad' : s.skipRate > 0 ? 'warn' : 'good';
    grid.appendChild(metric('Skipped', `${s.skipped.toLocaleString()} (${(s.skipRate * 100).toFixed(2)}%)`, skipCls));
    grid.appendChild(metric('Unique IPs', s.uniqueIps.toLocaleString()));
    grid.appendChild(metric('Unique paths', s.uniquePaths.toLocaleString()));
    const errCls = s.errorRate > 0.10 ? 'bad' : s.errorRate > 0.02 ? 'warn' : 'good';
    grid.appendChild(metric('4xx errors', s.errors4xx.toLocaleString()));
    grid.appendChild(metric('5xx errors', s.errors5xx.toLocaleString(), s.errors5xx > 0 ? 'bad' : 'good'));
    grid.appendChild(metric('Error rate', (s.errorRate * 100).toFixed(2) + '%', errCls));

    if (s.responseTime.count > 0) {
      grid.appendChild(metric('Avg response', formatMs(s.responseTime.avg)));
      grid.appendChild(metric('p95 response', formatMs(s.responseTime.p95)));
      grid.appendChild(metric('Max response', formatMs(s.responseTime.max)));
    }

    grid.appendChild(metric('Bytes sent', s.bytesKnown > 0 ? formatBytes(s.totalBytes) : 'n/a'));

    if (s.firstTimestamp && s.lastTimestamp) {
      grid.appendChild(metric('First event', s.firstTimestamp.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC')));
      grid.appendChild(metric('Last event', s.lastTimestamp.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC')));
      grid.appendChild(metric('Time span', formatDuration(s.spanMs)));
    }
  }

  function renderAnomalyBanner(report) {
    const b = document.getElementById('anomalyBanner');
    const issues = [];
    const a = report.summary.anomalies;
    if (report.summary.skipped > 0) {
      issues.push(`${report.summary.skipped.toLocaleString()} line(s) could not be parsed and were skipped`);
    }
    if (a.missingTimestamp) issues.push(`${a.missingTimestamp} parsed line(s) had no usable timestamp`);
    if (a.missingStatus) issues.push(`${a.missingStatus} parsed line(s) had no status code`);
    if (a.missingIp) issues.push(`${a.missingIp} parsed line(s) had no client IP`);
    if (a.missingMethod) issues.push(`${a.missingMethod} parsed line(s) had no HTTP method`);
    if (a.futureTimestamp) issues.push(`${a.futureTimestamp} line(s) had timestamps in the future`);
    if (report.formats.length > 1) issues.push(`Multiple log formats detected (${report.formats.length})`);

    if (!issues.length) {
      b.classList.add('hidden');
      return;
    }
    b.classList.remove('hidden');
    b.innerHTML = '<strong>Anomalies surfaced:</strong> ' + issues.map(escapeHtml).join(' • ');
  }

  // ---- charts ---------------------------------------------------------

  const palette = {
    accent:  '#6aa9ff',
    accent2: '#8a78ff',
    good:    '#46c98b',
    warn:    '#f1b454',
    bad:     '#ef6b73',
    grid:    'rgba(255,255,255,0.07)',
    text:    '#cdd4f5'
  };

  Chart.defaults.color = palette.text;
  Chart.defaults.borderColor = palette.grid;
  Chart.defaults.font.family = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

  function destroyCharts() {
    for (const k of Object.keys(charts)) {
      try { charts[k].destroy(); } catch (_) { /* ignore */ }
      delete charts[k];
    }
  }

  function classColor(label) {
    switch (label) {
      case '2xx': return palette.good;
      case '3xx': return palette.accent;
      case '4xx': return palette.warn;
      case '5xx': return palette.bad;
      case '1xx': return palette.accent2;
      default:    return '#7d86b8';
    }
  }

  function renderStatusClass(data) {
    const ctx = document.getElementById('statusClassChart');
    if (!data.length) { drawEmpty(ctx, 'No status data'); return; }
    charts.statusClass = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: data.map(d => d.label),
        datasets: [{
          data: data.map(d => d.count),
          backgroundColor: data.map(d => classColor(d.label)),
          borderColor: '#1b2040',
          borderWidth: 2
        }]
      },
      options: {
        plugins: { legend: { position: 'bottom' } },
        responsive: true,
        maintainAspectRatio: false
      }
    });
    sizeFor(ctx, 280);
  }

  function renderMethods(data) {
    const ctx = document.getElementById('methodChart');
    if (!data.length) { drawEmpty(ctx, 'No method data'); return; }
    charts.method = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: data.map(d => d.label),
        datasets: [{
          data: data.map(d => d.count),
          backgroundColor: palette.accent,
          borderRadius: 4
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { color: palette.grid } },
          y: { grid: { color: palette.grid }, beginAtZero: true }
        }
      }
    });
    sizeFor(ctx, 280);
  }

  function renderTimeline(timeline) {
    const ctx = document.getElementById('timelineChart');
    const note = document.getElementById('timelineNote');
    if (!timeline.labels.length) {
      drawEmpty(ctx, 'No usable timestamps');
      note.textContent = '';
      return;
    }
    charts.timeline = new Chart(ctx, {
      type: 'line',
      data: {
        labels: timeline.labels,
        datasets: [{
          label: 'Requests',
          data: timeline.counts,
          borderColor: palette.accent,
          backgroundColor: 'rgba(106,169,255,0.18)',
          fill: true,
          tension: 0.25,
          pointRadius: 0
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { color: palette.grid }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 12 } },
          y: { grid: { color: palette.grid }, beginAtZero: true }
        }
      }
    });
    note.textContent = `Bucket size: ${formatDuration(timeline.bucketSizeMs)}`;
  }

  function renderTopPaths(data) {
    const ctx = document.getElementById('topPathsChart');
    if (!data.length) { drawEmpty(ctx, 'No paths'); return; }
    charts.topPaths = horizontalBar(ctx, data, palette.accent2);
  }

  function renderTopIps(data) {
    const ctx = document.getElementById('topIpsChart');
    if (!data.length) { drawEmpty(ctx, 'No IPs'); return; }
    charts.topIps = horizontalBar(ctx, data, palette.accent);
  }

  function horizontalBar(ctx, data, color) {
    return new Chart(ctx, {
      type: 'bar',
      data: {
        labels: data.map(d => truncate(d.label, 50)),
        datasets: [{
          data: data.map(d => d.count),
          backgroundColor: color,
          borderRadius: 4
        }]
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: items => data[items[0].dataIndex].label
            }
          }
        },
        scales: {
          x: { grid: { color: palette.grid }, beginAtZero: true },
          y: { grid: { display: false } }
        }
      }
    });
  }

  function renderResponseTimeHistogram(hist, stats) {
    const ctx = document.getElementById('responseTimeChart');
    const note = document.getElementById('responseTimeNote');
    if (!hist.labels.length || !stats || stats.count === 0) {
      drawEmpty(ctx, 'No response time data found');
      note.textContent = 'Tip: response time is read from the trailing numeric field (with optional ms/s/us unit) or any "Nms" pattern.';
      return;
    }
    charts.rt = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: hist.labels,
        datasets: [{
          data: hist.counts,
          backgroundColor: palette.warn,
          borderRadius: 4
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { color: palette.grid }, ticks: { maxRotation: 45, minRotation: 30 } },
          y: { grid: { color: palette.grid }, beginAtZero: true }
        }
      }
    });
    sizeFor(ctx, 280);
    note.textContent = `n=${stats.count.toLocaleString()} • min ${formatMs(stats.min)} • p50 ${formatMs(stats.p50)} • p95 ${formatMs(stats.p95)} • p99 ${formatMs(stats.p99)} • max ${formatMs(stats.max)}`;
  }

  function renderStatusCodes(data) {
    const ctx = document.getElementById('statusCodeChart');
    if (!data.length) { drawEmpty(ctx, 'No status codes'); return; }
    charts.statusCode = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: data.map(d => d.label),
        datasets: [{
          data: data.map(d => d.count),
          backgroundColor: data.map(d => classColor(statusClassFromCode(parseInt(d.label, 10)))),
          borderRadius: 4
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { color: palette.grid } },
          y: { grid: { color: palette.grid }, beginAtZero: true }
        }
      }
    });
    sizeFor(ctx, 280);
  }

  function statusClassFromCode(code) {
    if (!isFinite(code)) return 'unknown';
    if (code < 200) return '1xx';
    if (code < 300) return '2xx';
    if (code < 400) return '3xx';
    if (code < 500) return '4xx';
    if (code < 600) return '5xx';
    return 'other';
  }

  function sizeFor(canvas, h) {
    canvas.style.height = h + 'px';
  }

  function drawEmpty(canvas, msg) {
    const ctx = canvas.getContext('2d');
    canvas.width = canvas.clientWidth || 400;
    canvas.height = 160;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = palette.text;
    ctx.font = '14px -apple-system, "Segoe UI", Roboto, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(msg, canvas.width / 2, canvas.height / 2);
  }

  // ---- tables / lists --------------------------------------------------

  function renderSlowTable(rows) {
    const tbody = document.querySelector('#slowTable tbody');
    const note = document.getElementById('slowNote');
    tbody.innerHTML = '';
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="5">No response-time data found in this log.</td></tr>';
      note.textContent = '';
      return;
    }
    note.textContent = `Showing top ${rows.length} by average response time.`;
    for (const r of rows) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${escapeHtml(r.path)}</td>
        <td>${r.count.toLocaleString()}</td>
        <td>${formatMs(r.avg)}</td>
        <td>${formatMs(r.p95)}</td>
        <td>${formatMs(r.max)}</td>`;
      tbody.appendChild(tr);
    }
  }

  function renderErrorTable(rows) {
    const tbody = document.querySelector('#errorTable tbody');
    tbody.innerHTML = '';
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="4">No 4xx/5xx responses found.</td></tr>';
      return;
    }
    for (const r of rows) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${escapeHtml(r.path)}</td>
        <td>${r.count.toLocaleString()}</td>
        <td>${r.topStatus != null ? r.topStatus : '—'}</td>
        <td>${r.sampleIp ? escapeHtml(r.sampleIp) : '—'}</td>`;
      tbody.appendChild(tr);
    }
  }

  function renderFormats(formats, total) {
    const wrap = document.getElementById('formatBreakdown');
    wrap.innerHTML = '';
    const max = formats.reduce((m, f) => Math.max(m, f.count), 1);
    for (const f of formats) {
      const row = document.createElement('div');
      row.className = 'format-row';
      const name = document.createElement('div');
      name.className = 'format-name';
      name.textContent = f.name;
      const bar = document.createElement('div');
      bar.className = 'format-bar';
      const fill = document.createElement('div');
      fill.className = 'format-bar-fill';
      fill.style.width = ((f.count / max) * 100).toFixed(1) + '%';
      bar.appendChild(fill);
      const count = document.createElement('div');
      count.className = 'format-count';
      const pct = total > 0 ? ((f.count / total) * 100).toFixed(1) : '0.0';
      count.textContent = `${f.count.toLocaleString()} (${pct}%)`;
      row.appendChild(name);
      row.appendChild(bar);
      row.appendChild(count);
      wrap.appendChild(row);
    }
  }

  function renderSkipped(skipped) {
    const summary = document.getElementById('skippedSummary');
    const list = document.getElementById('skippedList');
    list.innerHTML = '';
    if (!skipped.total) {
      summary.textContent = 'No lines were skipped. Every line parsed cleanly.';
      document.getElementById('skippedDetails').classList.add('hidden');
      return;
    }
    document.getElementById('skippedDetails').classList.remove('hidden');
    const shown = skipped.samples.length;
    summary.textContent = `${skipped.total.toLocaleString()} line(s) were skipped. Showing ${shown} sample(s).`;
    for (const s of skipped.samples) {
      const li = document.createElement('li');
      const reason = document.createElement('span');
      reason.className = 'reason';
      reason.textContent = `[line ${s.lineNo}: ${s.reason}]`;
      li.appendChild(reason);
      li.appendChild(document.createTextNode(' ' + truncate(s.raw, 400)));
      list.appendChild(li);
    }
  }

  // ---- export ---------------------------------------------------------

  function makeExportable(report) {
    // Strip Date objects to ISO strings; keep everything else.
    const s = report.summary;
    return {
      summary: {
        ...s,
        firstTimestamp: s.firstTimestamp ? s.firstTimestamp.toISOString() : null,
        lastTimestamp: s.lastTimestamp ? s.lastTimestamp.toISOString() : null
      },
      charts: report.charts,
      tables: report.tables,
      formats: report.formats,
      skipped: report.skipped,
      generatedAt: new Date().toISOString(),
      sourceFile: lastFileName
    };
  }

  // ---- utils ----------------------------------------------------------

  function formatBytes(n) {
    if (n == null || !isFinite(n)) return 'n/a';
    if (n < 1024) return n + ' B';
    const units = ['KB', 'MB', 'GB', 'TB'];
    let v = n / 1024, i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2) + ' ' + units[i];
  }

  function formatMs(v) {
    if (v == null || !isFinite(v)) return '—';
    if (v >= 1000) return (v / 1000).toFixed(2) + ' s';
    if (v >= 10) return v.toFixed(1) + ' ms';
    if (v >= 1) return v.toFixed(2) + ' ms';
    return v.toFixed(3) + ' ms';
  }

  function formatDuration(ms) {
    if (ms == null || !isFinite(ms)) return 'n/a';
    if (ms < 1000) return ms + ' ms';
    const s = Math.floor(ms / 1000);
    if (s < 60) return s + ' s';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm ' + (s % 60) + 's';
    const h = Math.floor(m / 60);
    if (h < 24) return h + 'h ' + (m % 60) + 'm';
    const d = Math.floor(h / 24);
    return d + 'd ' + (h % 24) + 'h';
  }

  function truncate(s, n) {
    if (s == null) return '';
    s = String(s);
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
  }
})();
