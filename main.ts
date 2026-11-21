// csv-reader-speed-01-run-20261121: the harness runs `node /bot/main.ts`
// (node22). It reads every case from /input/cases.json, answers each one
// alone with run() from solve.js, and writes /output/answers.json: a JSON
// array of the answers, one per case and in the cases' order. Outside a
// container MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for /input
// and /output.
//
// The driver reads cases.json as raw bytes and walks its JSON structure to
// find each case's text span and header flag, so no JSON.parse of the whole
// file is needed; solve.js parses the CSV straight from those bytes and
// returns each answer already serialized, so no JSON.stringify is needed
// either. If the structure scan ever fails (an unexpected shape), it falls
// back to the plain driver: JSON.parse the file and answer each case with
// run() on the decoded input.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// V8's incremental marking off, set before solve.js is imported so all of
// its work runs under it (the rules: the house baseline runs with
// --no-incremental-marking, and an entry may tune V8's flags too).
setFlagsFromString('--no-incremental-marking');

/** solve.js, imported by its URL (a .js module carries no types). */
const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as {
  run: (input: unknown) => Buffer;
};

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const B_OB = Buffer.from('[');
const B_CB = Buffer.from(']');
const B_COMMA = Buffer.from(',');

const raw = readFileSync(join(INPUT_DIR, 'cases.json'));

/** One case located in the raw bytes: its text span and header flag. */
interface Located {
  start: number;
  end: number;
  header: boolean;
}

/**
 * Walks the raw JSON bytes of cases.json — an array of {"id", "input"}
 * with input {"text", "header"} — and locates each case's text span
 * (content bytes, quotes excluded) and header flag. Throws on any
 * unexpected shape, which the caller turns into the JSON.parse fallback.
 */
function locateCases(buf: Buffer): Located[] {
  const n = buf.length;
  let p = 0;

  const isWs = (c: number) => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
  function skipWs() {
    while (p < n && isWs(buf[p])) p += 1;
  }
  function keyEq(s: number, e: number, word: string): boolean {
    if (e - s !== word.length) return false;
    for (let k = 0; k < word.length; k++) {
      if (buf[s + k] !== word.charCodeAt(k)) return false;
    }
    return true;
  }
  // The content span of the JSON string at p (buf[p] === '"'); leaves p
  // just past the closing quote. One indexOf per quote: a quote preceded
  // by an odd run of backslashes is escaped, an even run (or none) ends
  // the string.
  function stringSpan(): [number, number] {
    if (buf[p] !== 0x22) throw new Error('expected a string');
    p += 1;
    const s = p;
    for (;;) {
      const q = buf.indexOf(0x22, p);
      if (q === -1) throw new Error('unterminated string');
      let bs = 0;
      for (let k = q - 1; k >= s && buf[k] === 0x5c; k--) bs += 1;
      if (bs % 2 === 0) {
        p = q + 1;
        return [s, q];
      }
      p = q + 1;
    }
  }
  function skipValue(): void {
    skipWs();
    const c = buf[p];
    if (c === 0x22) {
      stringSpan();
      return;
    }
    if (c === 0x7b) {
      p += 1;
      skipWs();
      if (buf[p] === 0x7d) {
        p += 1;
        return;
      }
      for (;;) {
        stringSpan();
        skipWs();
        if (buf[p] !== 0x3a) throw new Error('expected :');
        p += 1;
        skipValue();
        skipWs();
        if (buf[p] === 0x2c) {
          p += 1;
          continue;
        }
        if (buf[p] !== 0x7d) throw new Error('expected }');
        p += 1;
        return;
      }
    }
    if (c === 0x5b) {
      p += 1;
      skipWs();
      if (buf[p] === 0x5d) {
        p += 1;
        return;
      }
      for (;;) {
        skipValue();
        skipWs();
        if (buf[p] === 0x2c) {
          p += 1;
          continue;
        }
        if (buf[p] !== 0x5d) throw new Error('expected ]');
        p += 1;
        return;
      }
    }
    // A literal (true, false, null) or a number: run to the next delimiter.
    while (p < n) {
      const d = buf[p];
      if (d === 0x2c || d === 0x7d || d === 0x5d || isWs(d)) break;
      p += 1;
    }
  }

  const found: Located[] = [];
  skipWs();
  if (buf[p] !== 0x5b) throw new Error('expected [');
  p += 1;
  for (;;) {
    skipWs();
    if (p >= n) throw new Error('unexpected end');
    if (buf[p] === 0x5d) break; // ]
    if (buf[p] !== 0x7b) throw new Error('expected {');
    p += 1;
    let span: [number, number] | null = null;
    let header = false;
    for (;;) {
      skipWs();
      if (buf[p] === 0x7d) {
        p += 1;
        break;
      }
      const [ks, ke] = stringSpan();
      skipWs();
      if (buf[p] !== 0x3a) throw new Error('expected :');
      p += 1;
      skipWs();
      if (keyEq(ks, ke, 'input')) {
        if (buf[p] !== 0x7b) throw new Error('expected {');
        p += 1;
        for (;;) {
          skipWs();
          if (buf[p] === 0x7d) {
            p += 1;
            break;
          }
          const [ks2, ke2] = stringSpan();
          skipWs();
          if (buf[p] !== 0x3a) throw new Error('expected :');
          p += 1;
          skipWs();
          if (keyEq(ks2, ke2, 'text')) {
            span = stringSpan();
          } else if (keyEq(ks2, ke2, 'header')) {
            if (buf[p] === 0x74) header = true; // true
            else if (buf[p] === 0x66) header = false; // false
            else throw new Error('expected a boolean header');
            while (p < n && buf[p] !== 0x2c && buf[p] !== 0x7d) p += 1;
          } else {
            skipValue();
          }
          skipWs();
          if (buf[p] === 0x2c) {
            p += 1;
            continue;
          }
        }
      } else {
        skipValue();
      }
      skipWs();
      if (buf[p] === 0x2c) {
        p += 1;
        continue;
      }
    }
    if (span === null) throw new Error('case without text');
    found.push({ start: span[0], end: span[1], header });
    skipWs();
    if (buf[p] === 0x2c) {
      p += 1;
      continue;
    }
  }
  return found;
}

let answers: Buffer[];
try {
  const cases = locateCases(raw);

  // Prime the JIT: every timed run is a fresh process, so the parser
  // would otherwise run its first case unoptimized. A few hundred runs
  // over a small synthetic input that exercises every path (fast and
  // slow records, quoted fields, doubled quotes, CR/LF inside quotes,
  // junk, unterminated quotes, stray CRs, short and long rows) get the
  // hot functions optimized first, for a few milliseconds.
  const PRIME_TEXT =
    'a,b,c\r\n"x""y",2,3\n"x\r\ny",2\n"x"junk,2,3\n"unterminated,2\n1\r,2,3\nshort\n1,2,3,4,5\n';
  const PRIME_SPAN = Buffer.from(JSON.stringify(PRIME_TEXT).slice(1, -1), 'utf8');
  for (let k = 0; k < 300; k++) run({ text: PRIME_SPAN, header: true });

  answers = cases.map((c) =>
    run({ text: raw.subarray(c.start, c.end), header: c.header }),
  );
} catch {
  // Fallback: the plain driver — parse the file and answer each case
  // with run() on the decoded input.
  const cases = JSON.parse(raw.toString('utf8')) as { id: string; input: unknown }[];
  answers = cases.map((c) => run(c.input));
}

const parts: Buffer[] = [B_OB];
for (let i = 0; i < answers.length; i++) {
  if (i > 0) parts.push(B_COMMA);
  parts.push(answers[i]);
}
parts.push(B_CB);
writeFileSync(join(OUTPUT_DIR, 'answers.json'), Buffer.concat(parts));
