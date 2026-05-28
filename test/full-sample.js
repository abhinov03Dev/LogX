const fs = require('fs');
const path = require('path');
const vm = require('vm');

const sandbox = { console };
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'parser.js'), 'utf8'), sandbox, { filename: 'parser.js' });
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'analyzer.js'), 'utf8'), sandbox, { filename: 'analyzer.js' });

const { LogParser, LogAnalyzer } = sandbox;
const text = fs.readFileSync(path.join(__dirname, '..', 'samples', 'mixed.log'), 'utf8');
const a = new LogAnalyzer();
for (const line of text.split('\n')) {
  if (line === '' && text.endsWith('\n')) {} // ignore final empty after split
  a.add(LogParser.parseLine(line));
}
const r = a.finalize();
console.log('total:', r.summary.totalLines, 'parsed:', r.summary.parsed, 'skipped:', r.summary.skipped);
console.log('uniqueIps:', r.summary.uniqueIps, 'uniquePaths:', r.summary.uniquePaths);
console.log('4xx:', r.summary.errors4xx, '5xx:', r.summary.errors5xx);
console.log('rt avg:', r.summary.responseTime.avg, 'p95:', r.summary.responseTime.p95);
console.log('formats:', r.formats.map(f => `${f.name}=${f.count}`).join(', '));
console.log('top paths:', r.charts.topPaths.slice(0,5).map(p => `${p.label}(${p.count})`).join(', '));
console.log('skipped samples:');
for (const s of r.skipped.samples) console.log('  -', s.lineNo, s.reason, '|', s.raw.slice(0,80));
