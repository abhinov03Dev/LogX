const fs = require('fs');
const path = require('path');
const vm = require('vm');

const sandbox = { console };
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'parser.js'), 'utf8'), sandbox, { filename: 'parser.js' });
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'analyzer.js'), 'utf8'), sandbox, { filename: 'analyzer.js' });

const { LogParser, LogAnalyzer } = sandbox;
const file = path.join(__dirname, '..', 'samples', 'generated.log');
const text = fs.readFileSync(file, 'utf8');
const a = new LogAnalyzer();
let n = 0;
for (const line of text.split('\n')) {
  // mimic app.js: skip a final trailing empty after split
  if (line === '' && n >= text.split('\n').length - 1) continue;
  a.add(LogParser.parseLine(line));
  n++;
}
const r = a.finalize();
console.log('total:', r.summary.totalLines, 'parsed:', r.summary.parsed, 'skipped:', r.summary.skipped, `(${(r.summary.skipRate*100).toFixed(2)}%)`);
console.log('formats:', r.formats.map(f => `${f.name}=${f.count}`).join(', '));
console.log('uniqueIps:', r.summary.uniqueIps, 'uniquePaths:', r.summary.uniquePaths);
console.log('4xx:', r.summary.errors4xx, '5xx:', r.summary.errors5xx, 'errRate:', (r.summary.errorRate*100).toFixed(2)+'%');
if (r.summary.responseTime.count) {
  console.log('rt avg:', r.summary.responseTime.avg.toFixed(1), 'p95:', r.summary.responseTime.p95.toFixed(1), 'max:', r.summary.responseTime.max.toFixed(1));
}
console.log('skipped sample reasons:');
const seen = new Map();
for (const s of r.skipped.samples) seen.set(s.reason, (seen.get(s.reason) || 0) + 1);
for (const [k, v] of seen) console.log('  -', k, '×', v);
