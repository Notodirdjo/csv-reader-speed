// Faster drop-in for csv-reader 1.0.0 (make.fun's own CSV reader) — byte-level
// JSON-to-JSON transducer.
//
// run(input) returns csv-reader 1.0.0's answer for one case as its JSON
// serialization (a Buffer), byte for byte what JSON.stringify of the value
// would give. The input text arrives as the raw JSON-escaped span straight
// out of cases.json (a Buffer, no surrounding quotes): the parser reads the
// CSV straight from those bytes, decoding JSON escapes inline, and emits the
// answer by copying field byte-spans verbatim — no JSON.parse, no intermediate
// row objects, no JSON.stringify. Each case is answered alone; nothing is
// kept from one case to the next. Pure JS/TS, no WASM, no native code, no
// network, no clock, no randomness. Deterministic: the same input always
// gives the same bytes.
//
// Why this shape: the leaders of this bounty (see BOUNTY-STATE.md, Top-5
// study) all work the input bytes end to end — "no JSON.parse", "fields
// copied straight from the input JSON", "no rows built" — because the
// JSON.parse + object building + JSON.stringify of the plain driver costs
// more than the parse itself (~280 ms of our ~774 ms whole-program time).
// The harness grades /output/answers.json as JSON values, so the serialized
// form is the answer.
//
// Fallback: a text span holding a \uXXXX escape (the generator never emits
// one — the practice census shows only \r, \n and \" — but an adversarial
// input could) is decoded with JSON.parse and read by the string parser
// below (runString), the same algorithm as the earlier string entry, whose
// output is then JSON.stringify'd. Correct, just slower, and never taken
// on generator-drawn sets.

// Byte values.
const BS = 0x5c; // backslash, JSON escape introducer
const DQ = 0x22; // "
const COMMA = 0x2c;
const E_N = 0x6e; // n (LF escape)
const E_R = 0x72; // r (CR escape)
const E_U = 0x75; // u (\uXXXX escape)

// How a field ended.
const F_COMMA = 0;
const F_BREAK = 1;
const F_END = 2;

// Pre-made output pieces.
const B_NULL = Buffer.from('null');
const B_EMPTY_STR = Buffer.from('""');
const B_ESC_Q = Buffer.from('\\"'); // a literal " in JSON string form
const B_ESC_LF = Buffer.from('\\n'); // a literal LF in JSON string form
const B_COLS_OPEN = Buffer.from('{"columns":');
const B_ROWS_OPEN = Buffer.from(',"rows":[');
const B_ERRS_OPEN = Buffer.from('],"errors":[');
const B_CLOSE = Buffer.from(']}');
const B_EMPTY_ARR = Buffer.from('[]');

/**
 * A growing byte buffer the parser writes the answer into directly: field
 * spans are copied in, structural bytes written in place. This avoids the
 * parts-array + Buffer.concat of the first transducer version (3M parts,
 * ~150 ms of concat alone) and the per-field subarray objects.
 */
class Out {
  constructor(cap) {
    this.b = Buffer.allocUnsafe(cap);
    this.p = 0;
  }
  need(n) {
    if (this.p + n <= this.b.length) return;
    let cap = this.b.length * 2;
    while (this.p + n > cap) cap *= 2;
    const nb = Buffer.allocUnsafe(cap);
    this.b.copy(nb, 0, 0, this.p);
    this.b = nb;
  }
  byte(v) {
    this.need(1);
    this.b[this.p] = v;
    this.p += 1;
  }
  // One whole plain field: "span" plus a trailing comma when asked — a
  // single call for the fast path's four writes.
  field(src, s, e, commaAfter) {
    const len = e - s;
    this.need(len + (commaAfter ? 3 : 2));
    const b = this.b;
    let p = this.p;
    b[p] = DQ;
    p += 1;
    if (len > 0) {
      src.copy(b, p, s, e);
      p += len;
    }
    b[p] = DQ;
    p += 1;
    if (commaAfter) {
      b[p] = COMMA;
      p += 1;
    }
    this.p = p;
  }
  // A slow field's closing quote plus its trailing comma, in one call.
  endField(commaAfter) {
    this.need(commaAfter ? 2 : 1);
    this.b[this.p] = DQ;
    this.p += 1;
    if (commaAfter) {
      this.b[this.p] = COMMA;
      this.p += 1;
    }
  }
  bytes(buf) {
    this.need(buf.length);
    buf.copy(this.b, this.p);
    this.p += buf.length;
  }
  copyFrom(src, s, e) {
    const len = e - s;
    if (len <= 0) return;
    this.need(len);
    src.copy(this.b, this.p, s, e);
    this.p += len;
  }
  str(s) {
    const len = Buffer.byteLength(s);
    this.need(len);
    this.p += this.b.write(s, this.p);
  }
  slice() {
    return this.b.subarray(0, this.p);
  }
}

/**
 * The byte-level parser: buf is the raw JSON-escaped text span (no quotes).
 * Returns the answer's JSON serialization as a Buffer.
 */
function runBytes(buf, header) {
  const n = buf.length;

  // A \uXXXX escape anywhere: fall back to the string path (correct, slower).
  // indexOf can false-positive on \\u (an escaped backslash then 'u'), which
  // only costs speed, never correctness.
  if (buf.indexOf('\\u') !== -1) {
    return Buffer.from(JSON.stringify(runString(JSON.parse(`"${buf.toString('utf8')}"`), header)));
  }

  // BOM: U+FEFF at the very start is dropped (literal UTF-8 EF BB BF here;
  // a \ufeff escape took the string path above).
  let pos = 0;
  if (n >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) pos = 3;
  let line = 1;

  // Error descriptors, in the order met; written at the end. A long_row
  // carries its extra fields' bytes (copied out at cut time).
  const errs = [];
  const pushErr = (code, recLine, recRow) => {
    errs.push({ code, line: recLine, row: recRow });
  };

  // Record state, set at each record start; the readers report errors on it.
  let recordLine = 1;
  let recordRow = null;

  // Next-backslash cache, refreshed lazily (valid while >= pos).
  let bsCache = -1;
  const nextBs = (from) => {
    if (bsCache >= from) return bsCache;
    bsCache = buf.indexOf(BS, from);
    return bsCache;
  };

  // Reads an unquoted field's content into out (chunks only, no quotes).
  // Returns {ended, added}: added counts whether any content character was
  // kept (a dropped stray CR adds nothing).
  function readUnquoted(out) {
    let added = false;
    let chunkStart = pos;
    for (;;) {
      const cIdx = buf.indexOf(COMMA, pos);
      const bIdx = nextBs(pos);
      if (bIdx !== -1 && (cIdx === -1 || bIdx < cIdx)) {
        const e = buf[bIdx + 1];
        if (e === E_N) {
          out.copyFrom(buf, chunkStart, bIdx);
          if (bIdx > chunkStart) added = true;
          pos = bIdx + 2;
          line += 1;
          return { ended: F_BREAK, added };
        }
        if (e === E_R) {
          if (buf[bIdx + 2] === BS && buf[bIdx + 3] === E_N) {
            out.copyFrom(buf, chunkStart, bIdx);
            if (bIdx > chunkStart) added = true;
            pos = bIdx + 4;
            line += 1;
            return { ended: F_BREAK, added };
          }
          // Lone CR: dropped, stray_cr, the field goes on.
          out.copyFrom(buf, chunkStart, bIdx);
          if (bIdx > chunkStart) added = true;
          pushErr('stray_cr', recordLine, recordRow);
          pos = bIdx + 2;
          chunkStart = pos;
          continue;
        }
        // Any other escape is one literal character of the field; it stays
        // inside the chunk, so just step past it and keep scanning.
        added = true;
        pos = bIdx + 2;
        continue;
      }
      if (cIdx !== -1) {
        out.copyFrom(buf, chunkStart, cIdx);
        if (cIdx > chunkStart) added = true;
        pos = cIdx + 1;
        return { ended: F_COMMA, added };
      }
      out.copyFrom(buf, chunkStart, n);
      if (n > chunkStart) added = true;
      pos = n;
      return { ended: F_END, added };
    }
  }

  // Reads a quoted field whose opening \" is at pos. Writes its content
  // chunks into out (no quotes). fieldStart is out.p at the field's start
  // (after its opening quote), for the unterminated rollback.
  // Returns {ended}.
  function readQuoted(out, fieldStart) {
    const open = pos;
    const openLine = line;
    pos += 2;
    let chunkStart = pos;
    let closed = false;
    for (;;) {
      const bIdx = buf.indexOf(BS, pos);
      if (bIdx === -1 || bIdx >= n) break;
      const e = buf[bIdx + 1];
      if (e === DQ) {
        if (buf[bIdx + 2] === BS && buf[bIdx + 3] === DQ) {
          // Doubled "": one literal quote in the value.
          out.copyFrom(buf, chunkStart, bIdx);
          out.bytes(B_ESC_Q);
          pos = bIdx + 4;
          chunkStart = pos;
          continue;
        }
        out.copyFrom(buf, chunkStart, bIdx);
        pos = bIdx + 2;
        closed = true;
        break;
      }
      if (e === E_N || e === E_R) {
        // CRLF and a lone CR inside quotes are each one LF; so is an LF.
        out.copyFrom(buf, chunkStart, bIdx);
        out.bytes(B_ESC_LF);
        line += 1;
        if (e === E_R && buf[bIdx + 2] === BS && buf[bIdx + 3] === E_N) pos = bIdx + 4;
        else pos = bIdx + 2;
        chunkStart = pos;
        continue;
      }
      // Any other escape is one literal character of the field.
      pos = bIdx + 2;
    }
    if (!closed) {
      // The quote never closes: it is a literal character, and the text
      // after it is read again as unquoted. Roll the field's bytes back.
      out.p = fieldStart;
      pos = open + 2;
      line = openLine;
      pushErr('unterminated_quote', recordLine, recordRow);
      out.bytes(B_ESC_Q);
      return readUnquoted(out);
    }
    if (pos >= n) return { ended: F_END };
    const c = buf[pos];
    if (c === COMMA) {
      pos += 1;
      return { ended: F_COMMA };
    }
    if (c === BS) {
      const e = buf[pos + 1];
      if (e === E_N) {
        pos += 2;
        line += 1;
        return { ended: F_BREAK };
      }
      if (e === E_R && buf[pos + 2] === BS && buf[pos + 3] === E_N) {
        pos += 4;
        line += 1;
        return { ended: F_BREAK };
      }
    }
    // What follows the closing quote is appended as it stands, up to the
    // next comma or line break.
    const junk = readUnquoted(out);
    if (junk.added) pushErr('quote_junk', recordLine, recordRow);
    return junk;
  }

  // Tries the whole-record fast path: a record whose span holds no quote,
  // no CR and no \u escape. Writes the record's fields into out (with
  // fb holding each field's opening-quote byte offset) and returns the
  // field count, or -1 when the slow path must take it. Advances pos past
  // the record.
  function tryFastRecord(out, fb) {
    let scan = pos;
    let recEnd;
    let nextPos;
    let broke;
    for (;;) {
      const bIdx = buf.indexOf(BS, scan);
      if (bIdx === -1 || bIdx >= n) {
        recEnd = n;
        nextPos = n;
        broke = false;
        break;
      }
      const e = buf[bIdx + 1];
      if (e === E_N) {
        recEnd = bIdx;
        nextPos = bIdx + 2;
        broke = true;
        break;
      }
      if (e === E_R) {
        if (buf[bIdx + 2] === BS && buf[bIdx + 3] === E_N) {
          recEnd = bIdx;
          nextPos = bIdx + 4;
          broke = true;
          break;
        }
        return -1; // lone CR: slow path
      }
      if (e === DQ || e === E_U) return -1; // quote or \u: slow path
      scan = bIdx + 2; // a plain escape: keep scanning for the terminator
    }
    let fpos = pos;
    let count = 0;
    for (;;) {
      const cIdx = buf.indexOf(COMMA, fpos);
      const fEnd = cIdx === -1 || cIdx > recEnd ? recEnd : cIdx;
      fb.push(out.p);
      const last = fEnd === recEnd;
      out.field(buf, fpos, fEnd, !last);
      count += 1;
      if (last) break;
      fpos = fEnd + 1;
    }
    pos = nextPos;
    if (broke) line += 1;
    return count;
  }

  // Parses one record field by field (the slow path) into out, with fb
  // holding each field's opening-quote byte offset. Returns
  // {fieldCount, singleEmpty}.
  function slowRecord(out, fb) {
    let ended;
    let firstQuoted = false;
    let firstAdded = false;
    let first = true;
    let count = 0;
    do {
      fb.push(out.p);
      out.byte(DQ);
      const fieldStart = out.p;
      let f;
      if (buf[pos] === BS && buf[pos + 1] === DQ) {
        if (first) firstQuoted = true;
        f = readQuoted(out, fieldStart);
        if (first) firstAdded = true; // a quoted field is never "empty" here
      } else {
        f = readUnquoted(out);
        if (first) firstAdded = f.added;
      }
      first = false;
      ended = f.ended;
      out.endField(ended === F_COMMA);
      count += 1;
    } while (ended === F_COMMA);
    return { fieldCount: count, singleEmpty: count === 1 && !firstAdded && !firstQuoted };
  }

  // Reads the next record into out (fields only, no brackets), skipping
  // empty lines and lines that held only stray CRs. Returns
  // {fieldCount, fb} or null at the end of the text. `isFirst` says
  // whether this is the first record (its row is null when header is
  // true); `rowsSoFar` is the index the record takes in rows.
  function nextRecord(out, isFirst, rowsSoFar) {
    for (;;) {
      while (pos < n) {
        if (buf[pos] === BS && buf[pos + 1] === E_N) {
          pos += 2;
          line += 1;
        } else if (buf[pos] === BS && buf[pos + 1] === E_R && buf[pos + 2] === BS && buf[pos + 3] === E_N) {
          pos += 4;
          line += 1;
        } else break;
      }
      if (pos >= n) return null;
      recordLine = line;
      recordRow = header && isFirst ? null : rowsSoFar;
      const startP = out.p;
      const fb = [];
      const fast = tryFastRecord(out, fb);
      let rec;
      if (fast !== -1) {
        rec = { fieldCount: fast, singleEmpty: false };
      } else {
        out.p = startP;
        rec = slowRecord(out, fb);
      }
      // A line that held only stray CRs is left with no characters: no
      // record (its stray_cr errors stay).
      if (rec.singleEmpty) {
        out.p = startP;
        continue;
      }
      return { fieldCount: rec.fieldCount, fb, startP };
    }
  }

  // Finishes a record against the width: pads short rows, cuts long rows
  // (the cut fields' bytes are saved for the long_row error). `rec` holds
  // the record's fieldCount, fb (opening-quote offsets) and startP (where
  // its bytes begin in out).
  let width = -1;
  function finishRecord(out, rec) {
    if (width < 0) width = rec.fieldCount;
    if (rec.fieldCount < width) {
      errs.push({ code: 'short_row', line: recordLine, row: recordRow, fields: rec.fieldCount });
      for (let k = rec.fieldCount; k < width; k++) {
        out.byte(COMMA);
        out.bytes(B_EMPTY_STR);
      }
      return;
    }
    if (rec.fieldCount > width) {
      // The comma before field `width` sits one byte before its opening
      // quote; the row ends before it, and the extra fields (with their
      // separators) are saved for the error.
      const cutAt = rec.fb[width] - 1;
      const extra = Buffer.from(out.b.subarray(rec.fb[width], out.p));
      errs.push({ code: 'long_row', line: recordLine, row: recordRow, extra });
      out.p = cutAt;
    }
  }

  // Writes the errors section into out (after the rows).
  function writeErrors(out) {
    out.bytes(B_ERRS_OPEN);
    for (let i = 0; i < errs.length; i++) {
      const e = errs[i];
      if (i > 0) out.byte(COMMA);
      const row = e.row === null ? 'null' : e.row;
      if (e.code === 'short_row') {
        out.str(`{"code":"short_row","line":${e.line},"row":${row},"fields":${e.fields}}`);
      } else if (e.code === 'long_row') {
        out.str(`{"code":"long_row","line":${e.line},"row":${row},"extra":[`);
        out.bytes(e.extra);
        out.str(']}');
      } else {
        out.str(`{"code":"${e.code}","line":${e.line},"row":${row}}`);
      }
    }
    out.bytes(B_CLOSE);
  }

  // The answer is built in one Out sized for the whole case (the answer
  // runs ~1.1x the span; the Out grows if an adversarial input needs more).
  // The first record goes into a scratch Out: the columns/rows prefix
  // depends on whether a record exists and on the header flag.
  const scratch = new Out(4096);
  const first = nextRecord(scratch, true, 0);
  const out = new Out(Math.max(4096, Math.floor(n * 1.3)));
  out.bytes(B_COLS_OPEN);
  if (first === null) {
    out.bytes(header ? B_EMPTY_ARR : B_NULL);
    out.bytes(B_ROWS_OPEN);
    writeErrors(out);
    return out.slice();
  }
  finishRecord(scratch, first);
  let rowsEmitted = 0;
  if (header) {
    out.byte(0x5b);
    out.bytes(scratch.slice());
    out.byte(0x5d);
  } else {
    out.bytes(B_NULL);
  }
  out.bytes(B_ROWS_OPEN);
  if (!header) {
    out.byte(0x5b);
    out.bytes(scratch.slice());
    out.byte(0x5d);
    rowsEmitted = 1;
  }
  let rec;
  while ((rec = nextRecord(out, false, rowsEmitted)) !== null) {
    // nextRecord wrote the fields straight into out, right where the row
    // goes — but the row needs its [ ] and the comma before it. The fields
    // start at rec.startP; shift them right by the opener's bytes.
    const need = rowsEmitted > 0 ? 2 : 1; // ",[" or "["
    out.need(need);
    out.b.copyWithin(rec.startP + need, rec.startP, out.p);
    out.b[rec.startP] = rowsEmitted > 0 ? COMMA : 0x5b;
    if (rowsEmitted > 0) out.b[rec.startP + 1] = 0x5b;
    out.p += need;
    // fb offsets moved right by `need`; finishRecord's cut math uses them.
    for (let j = 0; j < rec.fb.length; j++) rec.fb[j] += need;
    finishRecord(out, rec);
    out.byte(0x5d);
    rowsEmitted += 1;
  }
  writeErrors(out);
  return out.slice();
}

/**
 * The string parser (fallback): csv-reader 1.0.0's answer for {text, header}
 * as a value. The same algorithm as the earlier string entry: bulk native
 * scans on the common paths, a char-by-char mirror of the reference only
 * for rare broken constructs.
 */
function runString(text, header) {
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;
  const quoteOrCr = /["\r]/;

  function readUnquoted(initial) {
    let value = initial;
    let added = 0;
    for (;;) {
      const cIdx = text.indexOf(',', i);
      const lIdx = text.indexOf('\n', i);
      let d;
      let ended;
      if (cIdx === -1 && lIdx === -1) {
        d = n;
        ended = F_END;
      } else if (lIdx !== -1 && (cIdx === -1 || lIdx < cIdx)) {
        d = lIdx;
        ended = F_BREAK;
      } else {
        d = cIdx;
        ended = F_COMMA;
      }
      if (ended === F_BREAK && d > i && text.charCodeAt(d - 1) === 13) {
        const v = text.slice(i, d - 1);
        if (v.indexOf('\r') !== -1) return readUnquotedSlow(value);
        added += v.length;
        value += v;
        i = d + 1;
        line += 1;
        return { value, ended: F_BREAK, added };
      }
      const v = text.slice(i, d);
      if (v.indexOf('\r') !== -1) return readUnquotedSlow(value);
      added += v.length;
      value += v;
      if (ended === F_END) {
        i = n;
        return { value, ended: F_END, added };
      }
      if (ended === F_COMMA) {
        i = d + 1;
        return { value, ended: F_COMMA, added };
      }
      i = d + 1;
      line += 1;
      return { value, ended: F_BREAK, added };
    }
  }

  function readUnquotedSlow(initial) {
    let value = initial;
    let added = 0;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 44) {
        i += 1;
        return { value, ended: F_COMMA, added };
      }
      if (c === 10) {
        i += 1;
        line += 1;
        return { value, ended: F_BREAK, added };
      }
      if (c === 13) {
        if (text.charCodeAt(i + 1) === 10) {
          i += 2;
          line += 1;
          return { value, ended: F_BREAK, added };
        }
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        i += 1;
        continue;
      }
      value += text[i];
      added += 1;
      i += 1;
    }
    return { value, ended: F_END, added };
  }

  function readQuotedSlow() {
    const open = i;
    const openLine = line;
    let value = '';
    i += 1;
    let closed = false;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 34) {
        if (text.charCodeAt(i + 1) === 34) {
          value += '"';
          i += 2;
          continue;
        }
        i += 1;
        closed = true;
        break;
      }
      if (c === 13) {
        value += '\n';
        line += 1;
        i += text.charCodeAt(i + 1) === 10 ? 2 : 1;
        continue;
      }
      if (c === 10) line += 1;
      value += text[i];
      i += 1;
    }
    if (!closed) {
      i = open + 1;
      line = openLine;
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      return readUnquoted('"');
    }
    if (i >= n) return { value, ended: F_END, added: 0 };
    const c = text.charCodeAt(i);
    if (c === 44) {
      i += 1;
      return { value, ended: F_COMMA, added: 0 };
    }
    if (c === 10) {
      i += 1;
      line += 1;
      return { value, ended: F_BREAK, added: 0 };
    }
    if (c === 13 && text.charCodeAt(i + 1) === 10) {
      i += 2;
      line += 1;
      return { value, ended: F_BREAK, added: 0 };
    }
    const junk = readUnquoted(value);
    if (junk.added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
    return junk;
  }

  function readQuoted() {
    const open = i;
    let p = i + 1;
    let parts = null;
    let close;
    for (;;) {
      const m = text.indexOf('"', p);
      if (m === -1) {
        i = open + 1;
        errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
        return readUnquoted('"');
      }
      if (text.charCodeAt(m + 1) === 34) {
        if (parts === null) parts = [];
        parts.push(text.slice(p, m + 1));
        p = m + 2;
        continue;
      }
      close = m;
      break;
    }
    const raw = text.slice(open + 1, close);
    if (raw.indexOf('\n') !== -1 || raw.indexOf('\r') !== -1) {
      i = open;
      return readQuotedSlow();
    }
    const value = parts === null ? raw : parts.join('') + text.slice(p, close);
    const after = close + 1;
    if (after >= n) {
      i = n;
      return { value, ended: F_END, added: 0 };
    }
    const c = text.charCodeAt(after);
    if (c === 44) {
      i = after + 1;
      return { value, ended: F_COMMA, added: 0 };
    }
    if (c === 10) {
      i = after + 1;
      line += 1;
      return { value, ended: F_BREAK, added: 0 };
    }
    if (c === 13 && text.charCodeAt(after + 1) === 10) {
      i = after + 2;
      line += 1;
      return { value, ended: F_BREAK, added: 0 };
    }
    i = after;
    const junk = readUnquoted(value);
    if (junk.added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
    return junk;
  }

  function finishRecord(fields) {
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  let recordLine = 1;
  let recordRow = null;

  while (true) {
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 10) {
        i += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(i + 1) === 10) {
        i += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (i >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    const eol = text.indexOf('\n', i);
    const end = eol === -1 ? n : eol;
    let lineEnd = end;
    if (eol !== -1 && end > i && text.charCodeAt(end - 1) === 13) lineEnd = end - 1;
    const lineStr = text.slice(i, lineEnd);
    if (!quoteOrCr.test(lineStr)) {
      const fields = lineStr.split(',');
      if (eol === -1) {
        i = n;
      } else {
        i = eol + 1;
        line += 1;
      }
      if (fields.length === 1 && fields[0] === '') continue;
      finishRecord(fields);
      continue;
    }

    const fields = [];
    let ended;
    let quoted = false;
    do {
      let field;
      if (text.charCodeAt(i) === 34) {
        quoted = true;
        field = readQuoted();
      } else {
        quoted = false;
        field = readUnquoted('');
      }
      fields.push(field.value);
      ended = field.ended;
    } while (ended === F_COMMA);

    if (fields.length === 1 && fields[0] === '' && !quoted) continue;
    finishRecord(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}

/**
 * csv-reader 1.0.0's answer for one case's input, as its JSON serialization.
 * input.text is the raw JSON-escaped span (Buffer, the fast path) or a
 * decoded string (the fallback path); input.header is the header flag.
 */
export function run(input) {
  const header = input.header === true;
  const text = input.text;
  if (typeof text === 'string') {
    return Buffer.from(JSON.stringify(runString(text, header)));
  }
  if (Buffer.isBuffer(text)) {
    return runBytes(text, header);
  }
  return Buffer.from(JSON.stringify(runString(String(text), header)));
}
