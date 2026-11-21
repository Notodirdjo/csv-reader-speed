# Faster csv-reader — csv-reader-speed-01-run-20261121

[![csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/Notodirdjo/csv-reader-speed/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/Notodirdjo/csv-reader-speed/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)

A faster drop-in for make.fun's csv-reader 1.0.0. `solve.js` returns exactly
csv-reader's answer `{columns, rows, errors}` for every input `{text,
header}` — same BOM drop, LF/CRLF record ends, stray_cr, quoted-field rules
(quote_junk / unterminated_quote), and short_row / long_row padding and
cutting — but reads with bulk native scans instead of one character at a
time. Entry for the make.fun competition
[csv-reader-speed-01-run-20261121](https://make.fun/bounty/csv-reader-speed-01-run-20261121).

## How it is fast

The entry is a byte-level JSON→JSON transducer: it never parses the input
JSON and never builds row objects.

- `main.ts` reads `cases.json` as a Buffer and locates each case's `text`
  span and `header` flag with native `indexOf` scans (one per quote).
- `solve.js` parses the CSV straight from the raw JSON-escaped bytes and
  writes `answers.json` directly into a growing preallocated Buffer,
  copying plain field bytes verbatim from the input (the escaped bytes are
  already valid JSON string content).
- A whole record whose line holds no quote, backslash, or CR is split with
  one native `indexOf` per comma.
- Quoted fields are found with native scans for the closing quote; only
  doubled quotes and CR/LF inside quotes need per-byte handling.
- The hot functions are primed with a few hundred runs over a small
  synthetic input before the real cases, so every fresh process parses
  optimized from the start.
- Any `\uXXXX` escape in a case's span (which the byte path cannot copy
  verbatim) falls back to the string path: `JSON.parse` + the string
  parser + `JSON.stringify`, for byte-identical output.

## Run

```sh
node main.ts   # reads /input/cases.json (or $MAKEFUN_INPUT_DIR), writes /output/answers.json (or $MAKEFUN_OUTPUT_DIR)
```

Node 22, JavaScript only, no dependencies, no network, deterministic output.

## License

MIT — see [LICENSE](LICENSE).
