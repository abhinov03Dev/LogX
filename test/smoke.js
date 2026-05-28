// Run: node test/smoke.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadIntoSandbox(sandbox, file) {
  const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  vm.runInContext(src, sandbox, { filename: file });
}

const sandbox = { console };
sandbox.window = sandbox;
vm.createContext(sandbox);

loadIntoSandbox(sandbox, 'parser.js');
loadIntoSandbox(sandbox, 'analyzer.js');

const { LogParser, LogAnalyzer } = sandbox;

const cases = [
  // Combined Log Format
  '192.168.1.10 - - [10/Oct/2024:13:55:36 +0000] "GET /index.html HTTP/1.1" 200 2326 "-" "Mozilla/5.0" 12',
  // Common (no quoted ua/referer)
  '127.0.0.1 - frank [10/Oct/2024:13:55:36 -0700] "GET /api HTTP/1.0" 200 2326',
  // ISO structured quoted
  '2024-10-10T13:56:00.123Z [INFO] 203.0.113.45 "GET /index.html HTTP/1.1" 200 2326 9ms',
  // ISO structured bare
  '2024-10-10T13:56:04.221Z [INFO] 203.0.113.46 GET /api/items 200 31ms',
  // Combined with "-" bytes
  '192.168.1.12 - - [10/Oct/2024:13:55:55 +0000] "GET /api/items HTTP/1.1" 200 - "-" "Mozilla/5.0" 22',
  // Plainly bad
  'this is not a valid log line at all',
  // Empty
  '',
  // Fallback-able: scattered fields
  '[2024-10-10 13:56:30] some prefix 198.51.100.7 GET /weird/path 502 thing 250ms',
];

let pass = 0, fail = 0;
const a = new LogAnalyzer();

for (const line of cases) {
  const r = LogParser.parseLine(line);
  a.add(r);
  console.log(JSON.stringify({
    ok: r.ok,
    fmt: r.format,
    reason: r.reason,
    ts: r.record && r.record.timestamp ? r.record.timestamp.toISOString() : null,
    ip: r.record && r.record.ip,
    method: r.record && r.record.method,
    path: r.record && r.record.path,
    status: r.record && r.record.status,
    rt: r.record && r.record.responseTimeMs
  }));
}

// Spot expectations
function expect(cond, msg) { if (cond) { pass++; console.log('PASS ' + msg); } else { fail++; console.log('FAIL ' + msg); } }

let r;
r = LogParser.parseLine(cases[0]);
expect(r.ok && r.format === 'combined' && r.record.status === 200 && r.record.responseTimeMs === 12, 'combined parses');
r = LogParser.parseLine(cases[1]);
expect(r.ok && (r.format === 'common' || r.format === 'combined') && r.record.method === 'GET', 'common parses');
r = LogParser.parseLine(cases[2]);
expect(r.ok && r.format === 'iso-structured' && r.record.responseTimeMs === 9, 'iso quoted parses');
r = LogParser.parseLine(cases[3]);
expect(r.ok && r.format === 'iso-structured' && r.record.method === 'GET' && r.record.responseTimeMs === 31, 'iso bare parses');
r = LogParser.parseLine(cases[4]);
expect(r.ok && r.record.bytes === null, 'dash-bytes tolerated');
r = LogParser.parseLine(cases[5]);
expect(!r.ok, 'garbage rejected');
r = LogParser.parseLine(cases[6]);
expect(!r.ok, 'empty rejected');
r = LogParser.parseLine(cases[7]);
expect(r.ok, 'fallback salvages mixed line');

const report = a.finalize();
console.log('\n--- summary ---');
console.log(JSON.stringify({
  total: report.summary.totalLines,
  parsed: report.summary.parsed,
  skipped: report.summary.skipped,
  formats: report.formats,
  uniqueIps: report.summary.uniqueIps,
  errors: report.summary.errors4xx + report.summary.errors5xx
}, null, 2));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
