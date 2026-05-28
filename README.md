# LogX

A client-side web tool that ingests a server log file and produces a useful report. Vanilla HTML, CSS, and JavaScript with [Chart.js](https://www.chartjs.org/). No backend, no build step, no data leaves the browser.


---

## Contents

- [Quick start](#quick-start)
- [Prerequisites](#prerequisites)
- [Running the analyzer](#running-the-analyzer)
- [Using the analyzer](#using-the-analyzer)
- [Generating a sample log file](#generating-a-sample-log-file)
- [Running the offline smoke tests](#running-the-offline-smoke-tests)
- [What the report shows](#what-the-report-shows)
- [Supported log formats](#supported-log-formats)
- [Tolerance behavior](#tolerance-behavior)
- [Project layout](#project-layout)
- [Troubleshooting](#troubleshooting)

---

## Quick start

```bash
# 1. Open the app
#    Either double-click index.html, or serve the folder:
python -m http.server 8080
#    Then open http://localhost:8080

# 2. (optional) Generate a realistic sample log to test with
node scripts/generate-log.js --lines 5000 --out samples/generated.log

# 3. In the browser, drop samples/generated.log onto the dropzone
```

That's it. Everything runs locally.

---

## Prerequisites

| Component       | Required for                          | Version                            |
| --------------- | -------------------------------------- | ---------------------------------- |
| Modern browser  | Running the analyzer                   | Chrome / Edge / Firefox / Safari, recent |
| Internet (once) | Loading Chart.js from the CDN          | First load only; cached afterwards |
| Node.js         | Generator script and smoke tests only  | 16+ recommended                    |
| Static server   | Optional, only if `file://` is restricted | Anything (Python, Node, etc.)   |

There are **no `npm install` steps** and **no build step**. The browser app uses three plain `.js` files and a CDN script tag for Chart.js.

---

## Running the analyzer

You have three options. Pick whichever is easiest.

### Option A — Open the file directly

Double-click `index.html`. Most modern browsers handle the file just fine over `file://`.

### Option B — Static server (recommended)

If your browser restricts any feature over `file://`, serve the directory with any static server.

Python:
```bash
python -m http.server 8080
```

Node:
```bash
npx http-server -p 8080
```


Then open `http://localhost:8080` in your browser.

### Option C — VS Code Live Server

Install the "Live Server" extension and click "Go Live" with `index.html` open.

---

## Using the analyzer

1. **Pick a file.** Drag a `.log` or `.txt` file onto the dropzone, or click it to open a file picker. A demo file is at `samples/mixed.log`; a generated one (after step below) at `samples/generated.log`.
2. **Watch the progress.** The file is streamed line by line in the browser. A progress bar shows bytes processed, total bytes, and lines parsed so far. Memory stays bounded even on multi-hundred-MB files.
3. **Read the report.** Once parsing finishes, the page populates with metrics, charts, and tables. See [What the report shows](#what-the-report-shows).
4. **Export.** Click **Download JSON report** to save the full structured report (summary, charts data, tables, format breakdown, skipped samples) as a `.json` file. Useful for diffing across runs.
5. **Reset.** Click **Analyze another file** to clear the report and load a different file.

Nothing is sent over the network. Closing the tab discards everything.

---

## Generating a sample log file

A configurable Node.js generator at `scripts/generate-log.js` produces a realistic log file matching the shape the tool is designed for, including the kinds of deviations described in the brief.

### Run it

```bash
# Default: 5,000 lines into samples/generated.log, ~8% deviating lines
node scripts/generate-log.js

# Larger file
node scripts/generate-log.js --lines 100000 --out samples/big.log

# Reproducible output via seed
node scripts/generate-log.js --seed 42

# Tweak the deviation rate
node scripts/generate-log.js --deviation-rate 0.05
```

### Options

| Flag                       | Default                  | Meaning                                          |
| -------------------------- | ------------------------ | ------------------------------------------------ |
| `-n`, `--lines`            | `5000`                   | Approximate number of output lines               |
| `-o`, `--out`              | `samples/generated.log`  | Output path (parent directories are created)     |
| `-d`, `--deviation-rate`   | `0.08`                   | Fraction in `[0, 1]` of deviating lines          |
| `-s`, `--seed`             | random                   | PRNG seed for reproducible output                |
| `-h`, `--help`             |                          | Print help                                       |

### What it produces

The primary shape:
```
2026-05-27T12:16:33Z 192.168.1.42 GET /api/users 200 142ms
```

Plus ~5–10% deviations, drawn at random:

- Alternate timestamp formats: `2026/05/27 12:20:27`, `27-May-2026 12:29:32`, Unix epoch like `1779884482`
- Alternate response-time units: `0.142s`, plain `142` (no unit)
- Missing status code: replaced with `-`, or omitted entirely
- Extra appended fields: quoted user agents and quoted referrers that contain spaces
- Multi-line stack traces interrupting the flow
- Partial-write truncations and blank lines
- JSON-formatted lines from a "bolted-on" logger

The script biases status codes per endpoint (admin login → 401 spikes, checkout → 5xx spikes) and correlates response times with method and status (5xx slow, 304 fast) so the analyzer's slow-endpoint and error-endpoint tables show meaningful patterns.

---

## Running the offline smoke tests

The parser and analyzer have no DOM dependencies, so they can be exercised from Node directly.

```bash
# Parser unit-style checks across known formats and edge cases
node test/smoke.js

# End-to-end aggregation against the curated mixed sample
node test/full-sample.js

# End-to-end aggregation against a generated file
node scripts/generate-log.js --seed 42 --out samples/generated.log
node test/against-generated.js
```

`smoke.js` prints `PASS`/`FAIL` per case and exits with a non-zero status on any failure — handy for a pre-commit check.

---

## What the report shows

| Section                          | What it tells you                                                                                  |
| -------------------------------- | -------------------------------------------------------------------------------------------------- |
| **Summary**                      | Total lines, parsed, skipped (count and rate), unique IPs, unique paths, 4xx/5xx counts, error rate, response time avg/p95/max, total bytes, first and last event timestamp, time span. |
| **Anomaly banner**               | Surfaces parsed-but-incomplete lines (missing timestamp, status, IP, method), future timestamps, and the presence of multiple log formats. |
| **Status code classes**          | Doughnut chart of 1xx / 2xx / 3xx / 4xx / 5xx / unknown.                                           |
| **HTTP methods**                 | Bar chart of method counts.                                                                         |
| **Requests over time**           | Area chart, automatically bucketed (seconds → days) so 30–60 buckets span the file.                |
| **Top paths / top client IPs**   | Horizontal bars, top 10 each.                                                                       |
| **Response time distribution**   | Histogram with log-spaced buckets, plus min / p50 / p95 / p99 / max.                                |
| **Status code detail**           | Per-status bar chart (200, 404, 500, etc.).                                                         |
| **Slowest endpoints**            | Table of paths by average response time, with request count, p95, and max.                          |
| **Top error endpoints**          | Table of paths with the most 4xx/5xx responses, the most common status, and a sample client IP.    |
| **Detected log formats**         | Bar breakdown of which formats matched which fraction of lines. Multiple entries imply a config change. |
| **Skipped & anomalous lines**    | Total skipped count plus up to 50 sampled lines with line number and reason.                        |

---

## Supported log formats

Lines are tried in this order. The first format whose pattern matches wins, and the line is tagged with that format name.

1. **Apache Combined Log Format** (with optional trailing response time)
   ```
   192.168.1.10 - - [10/Oct/2024:13:55:36 +0000] "GET /index.html HTTP/1.1" 200 2326 "-" "Mozilla/5.0" 12
   ```
2. **Apache Common Log Format** (no quoted UA/referer)
   ```
   127.0.0.1 - frank [10/Oct/2024:13:55:36 -0700] "GET /api HTTP/1.0" 200 2326
   ```
3. **ISO-leading structured** (quoted request line, optional log level)
   ```
   2024-10-10T13:56:00.123Z [INFO] 203.0.113.45 "GET /index.html HTTP/1.1" 200 2326 9ms
   ```
4. **ISO-leading structured (bare tokens)**
   ```
   2024-10-10T13:56:04.221Z [INFO] 203.0.113.46 GET /api/items 200 31ms
   ```
5. **Permissive fallback** — when no known format matches, the parser scrapes timestamp, IP, request line, status, and response time from anywhere in the line and accepts it only if at least two of these key fields can be recovered. This catches log lines wrapped in extra prefixes or suffixes without false-positive matches on plain prose.

Response time can be expressed as `12`, `12ms`, `0.012s`, `12000us`, `12000000ns`, etc. Units are normalized to milliseconds, with sensible heuristics when no unit is given.

---

## Tolerance behavior

Designed for the priority called out in the brief: degrade gracefully on malformed input.

- **Multiple formats** are parsed natively, so a mid-file logging-config change still produces a clean report. Each line is tagged with the format that matched.
- **Bad lines are never silently dropped.** Every skipped line is counted, surfaced in the headline metrics, and sampled with line number and reason in the "Skipped & anomalous lines" panel.
- **Parsed-but-incomplete lines** also surface as anomalies (missing timestamp, status, IP, method, future timestamps, very old timestamps).
- **Streaming reader.** Files are read with `File.stream()` + `TextDecoder` so multi-hundred-MB logs don't blow up memory. Line splitting handles partial chunks across reads.
- **Empty sections degrade gracefully.** Charts with no usable data show "No X data" instead of crashing.
- **No assumptions** about filename, line count, or specific values.

---

## Project layout

```
index.html               UI shell, includes Chart.js from CDN
styles.css               Theme and layout
parser.js                LogParser.parseLine — format detection and field extraction
analyzer.js              LogAnalyzer — aggregates parsed records into a report
app.js                   Streaming intake, progress, rendering, JSON export

samples/
  mixed.log              Curated demo log mixing two formats and bad lines
  generated.log          Created on demand by scripts/generate-log.js

scripts/
  generate-log.js        CLI generator producing realistic logs with deviations

test/
  smoke.js               Parser checks across known/unknown shapes
  full-sample.js         End-to-end aggregation against samples/mixed.log
  against-generated.js   End-to-end aggregation against samples/generated.log
```

---

## Troubleshooting

**The page loads but nothing happens when I drop a file.**
Check the browser console. If you see a Content Security Policy error from `file://`, switch to a local server (see [Option B](#option-b--static-server-recommended)).

**Chart.js fails to load.**
The page references Chart.js from `cdn.jsdelivr.net`. If you are offline, download `chart.umd.min.js` once and replace the `<script src="…">` URL in `index.html` with a local path.

**Skip rate looks high.**
Open the "Skipped & anomalous lines" panel; the reason field tells you whether the lines are blank, truncated, stack-trace fragments, or genuinely unrecognized. If a recognizable format keeps falling through, send a sample line so the parser can be extended.


