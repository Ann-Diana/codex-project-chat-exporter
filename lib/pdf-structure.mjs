import fs from "node:fs";
import { classifyLinkTarget } from "./document-model.mjs";

// Accept only PDFKit's classic, single-revision PDF subset. This is not a PDF
// importer. Streams are skipped using exact Length, not searched for tokens.
const FORBIDDEN = new Set([
  "3D", "3DD", "3DA", "3DV", "3DB", "3DI", "AA", "AcroForm", "EmbeddedFile", "EmbeddedFiles",
  "Filespec", "FileAttachment", "GoToR", "GoToE", "ImportData", "JavaScript", "JS", "Launch",
  "Movie", "OpenAction", "Rendition", "RichMedia", "RichMediaContent", "RichMediaSettings",
  "Sound", "SubmitForm", "ResetForm", "Hide", "SetOCGState", "Trans", "Widget", "Screen",
  "XFA", "Collection", "FFilter", "FDecodeParms", "OPI", "Ref",
]);
const UNSUPPORTED = new Set(["Encrypt", "Prev", "XRefStm", "ObjStm", "XRef"]);
const whitespace = b => [0, 9, 10, 12, 13, 32].includes(b);
const delimiter = b => b < 0 || whitespace(b) || "()<>[]{}/%".includes(String.fromCharCode(b));
const digit = b => b >= 48 && b <= 57;
const hex = b => digit(b) ? b - 48 : b >= 65 && b <= 70 ? b - 55 : b >= 97 && b <= 102 ? b - 87 : -1;

export function pdfByteReader(source, size) {
  const buffer = Buffer.isBuffer(source) ? source : null;
  let cache = Buffer.alloc(0), base = -1;
  return {
    size: buffer ? buffer.length : size,
    byte(position) {
      if (position < 0 || position >= this.size) return -1;
      if (buffer) return buffer[position];
      if (position < base || position >= base + cache.length) {
        base = position;
        cache = Buffer.allocUnsafe(Math.min(65536, this.size - position));
        let read = 0;
        while (read < cache.length) {
          const count = fs.readSync(source, cache, read, cache.length - read, position + read);
          if (!count) throw Object.assign(new Error("PDF ended during validation"), { code: "PDF_STRUCTURE_INVALID" });
          read += count;
        }
      }
      return cache[position - base];
    },
  };
}

class Parser {
  constructor(reader, ErrorType) { this.reader = reader; this.ErrorType = ErrorType; this.position = 0; this.references = []; }
  fail(code = "PDF_STRUCTURE_INVALID") { throw new this.ErrorType(code, "The generated PDF failed structural validation"); }
  peek() { return this.reader.byte(this.position); }
  skip() {
    while (true) {
      while (whitespace(this.peek())) this.position++;
      if (this.peek() !== 37) return;
      while (this.peek() >= 0 && this.peek() !== 10 && this.peek() !== 13) this.position++;
    }
  }
  word() {
    this.skip(); let value = "";
    while (!delimiter(this.peek())) { value += String.fromCharCode(this.peek()); this.position++; if (value.length > 128) this.fail(); }
    if (!value) this.fail();
    return value;
  }
  expect(value) { if (this.word() !== value) this.fail(); }
  integer() {
    const value = this.word();
    if (![...value].every(c => digit(c.charCodeAt(0)))) this.fail();
    const number = Number(value); if (!Number.isSafeInteger(number)) this.fail(); return number;
  }
  name() {
    this.position++; let value = "";
    while (!delimiter(this.peek())) {
      let b = this.peek(); this.position++;
      if (b === 35) { const a = hex(this.peek()), c = hex(this.reader.byte(this.position + 1)); if (a < 0 || c < 0) this.fail(); b = a * 16 + c; this.position += 2; }
      value += String.fromCharCode(b);
      if (value.length > 4096) this.fail();
    }
    return { name: value };
  }
  string() {
    this.position++; let depth = 1, value = "";
    while (depth) {
      let b = this.peek(); this.position++; if (b < 0) this.fail();
      if (b === 92) {
        b = this.peek(); this.position++; if (b < 0) this.fail();
        const escaped = new Map([[110,10],[114,13],[116,9],[98,8],[102,12]]);
        if (escaped.has(b)) b = escaped.get(b);
        else if (b === 10) continue;
        else if (b === 13) { if (this.peek() === 10) this.position++; continue; }
        else if (b >= 48 && b <= 55) {
          let n = b - 48;
          for (let i = 0; i < 2 && this.peek() >= 48 && this.peek() <= 55; i++) { n = n * 8 + this.peek() - 48; this.position++; }
          b = n & 255;
        }
      } else if (b === 40) depth++;
      else if (b === 41) { depth--; if (!depth) break; }
      else if (b === 13) { if (this.peek() === 10) this.position++; b = 10; }
      value += String.fromCharCode(b);
      if (value.length > 16 * 1024 * 1024) this.fail();
    }
    return { string: decodeString(value) };
  }
  value(depth = 0) {
    if (depth > 64) this.fail(); this.skip(); const b = this.peek();
    if (b === 47) return this.name();
    if (b === 40) return this.string();
    if (b === 91) {
      this.position++; const values = [];
      while (true) { this.skip(); if (this.peek() === 93) { this.position++; return values; } values.push(this.value(depth + 1)); }
    }
    if (b === 60) {
      this.position++;
      if (this.peek() !== 60) {
        let text = "", high = null;
        while (true) { const c = this.peek(); this.position++; if (c === 62) break; if (whitespace(c)) continue; const n = hex(c); if (n < 0) this.fail(); if (high === null) high = n; else { text += String.fromCharCode(high * 16 + n); high = null; } if (text.length > 16 * 1024 * 1024) this.fail(); }
        if (high !== null) text += String.fromCharCode(high * 16);
        return { string: decodeString(text) };
      }
      this.position++; const dict = new Map();
      while (true) {
        this.skip(); if (this.peek() === 62) { this.position++; if (this.peek() !== 62) this.fail(); this.position++; return dict; }
        if (this.peek() !== 47) this.fail(); const key = this.name().name;
        if (dict.has(key)) this.fail(); dict.set(key, this.value(depth + 1));
      }
    }
    const token = this.word();
    if (token === "null") return null;
    if (token === "true" || token === "false") return token === "true";
    let dots = 0; const chars = [...token];
    if (!chars.some(c => digit(c.charCodeAt(0))) || !chars.every((c,i) => digit(c.charCodeAt(0)) || (c === "." && ++dots <= 1) || (i === 0 && (c === "+" || c === "-")))) this.fail();
    const number = Number(token); if (!Number.isFinite(number)) this.fail();
    if (Number.isSafeInteger(number) && number >= 0) {
      const saved = this.position; this.skip();
      if (digit(this.peek())) {
        const next = this.word(); this.skip();
        if ([...next].every(c => digit(c.charCodeAt(0))) && this.peek() === 82 && delimiter(this.reader.byte(this.position + 1))) {
          this.position++; if (Number(next) !== 0) this.fail(); const ref = { ref: number }; this.references.push(ref); return ref;
        }
      }
      this.position = saved;
    }
    return number;
  }
}

function decodeString(value) {
  if (!value.startsWith("\xfe\xff")) return value;
  let result = "";
  if (value.length % 2) return value;
  for (let i = 2; i < value.length; i += 2) result += String.fromCharCode(value.charCodeAt(i) * 256 + value.charCodeAt(i + 1));
  return result;
}

export function validatePdfStructure(reader, ErrorType) {
  const p = new Parser(reader, ErrorType);
  const ascii = (at, count) => { let s = ""; for (let i = at; i < at + count && i < reader.size; i++) s += String.fromCharCode(reader.byte(i)); return s; };
  if (reader.size < 64 || !ascii(0, 9).startsWith("%PDF-1.")) p.fail();
  const tailStart = Math.max(0, reader.size - 1024), tail = ascii(tailStart, reader.size - tailStart);
  const start = tail.lastIndexOf("startxref");
  if (start < 0) p.fail(); p.position = tailStart + start; p.expect("startxref"); const xref = p.integer();
  p.skip();
  if (p.position !== reader.size || !tail.slice(start).trimEnd().endsWith("%%EOF") || xref < 15 || xref >= tailStart + start) p.fail();
  p.position = xref; p.expect("xref");
  const offsets = new Map();
  while (true) {
    p.skip(); if (p.peek() === 116) break;
    const first = p.integer(), count = p.integer(); if (count > reader.size || first + count > reader.size) p.fail();
    for (let i = 0; i < count; i++) {
      const offset = p.integer(), generation = p.integer(), state = p.word(), id = first + i;
      if (offsets.has(id)) p.fail();
      if (id === 0) { if (state !== "f" || generation !== 65535) p.fail(); offsets.set(0, 0); }
      else { if (state !== "n" || generation !== 0 || offset < 15 || offset >= xref) p.fail(); offsets.set(id, offset); }
    }
  }
  p.expect("trailer"); const trailer = p.value(); if (!(trailer instanceof Map)) p.fail();
  p.skip(); if (p.position !== tailStart + start) p.fail();
  if (trailer.get("Size") !== offsets.size || !offsets.has(0)) p.fail();
  const objects = new Map();
  const check = (value, isStream = false) => {
    if (value instanceof Map) {
      for (const [key, child] of value) {
        if (FORBIDDEN.has(key) || (key === "F" && (isStream || !Number.isSafeInteger(child)))) p.fail("PDF_ACTIVE_CONTENT");
        if (UNSUPPORTED.has(key)) p.fail();
        check(child);
      }
      if (value.has("S")) {
        const action = value.get("S")?.name;
        const group = action === "Transparency" && value.get("Type")?.name === "Group";
        if (!group && action !== "URI") p.fail("PDF_ACTIVE_CONTENT");
        if (action === "URI") {
          const target = value.get("URI")?.string, safety = classifyLinkTarget(target);
          if (typeof target !== "string" || !safety.allowed || safety.target !== target) p.fail("PDF_EXTERNAL_ACTION_UNSAFE");
        }
      }
      if (value.has("URI") && value.get("S")?.name !== "URI") p.fail("PDF_EXTERNAL_ACTION_UNSAFE");
    } else if (Array.isArray(value)) value.forEach(v => check(v));
    else if (value?.name) {
      if (FORBIDDEN.has(value.name)) p.fail("PDF_ACTIVE_CONTENT");
      if (UNSUPPORTED.has(value.name)) p.fail();
    }
  };
  check(trailer);
  const ordered = [...offsets].filter(([id]) => id !== 0).sort((a,b) => a[1] - b[1]);
  p.position = 0; p.skip();
  for (const [id, offset] of ordered) {
    if (p.position !== offset) p.fail();
    if (p.integer() !== id || p.integer() !== 0) p.fail(); p.expect("obj");
    const value = p.value(); p.skip(); let stream = false;
    if (p.peek() === 115) {
      p.expect("stream"); stream = true;
      if (p.peek() === 13) p.position++;
      if (p.peek() !== 10) p.fail(); p.position++;
      const length = value instanceof Map ? value.get("Length") : undefined;
      if (!Number.isSafeInteger(length) || length < 0 || p.position + length >= xref) p.fail();
      p.position += length; p.expect("endstream");
    }
    p.expect("endobj"); check(value, stream); objects.set(id, value); p.skip();
  }
  if (p.position !== xref) p.fail();
  for (const ref of p.references) if (!objects.has(ref.ref)) p.fail();
  const catalog = objects.get(trailer.get("Root")?.ref);
  if (!(catalog instanceof Map) || catalog.get("Type")?.name !== "Catalog") p.fail();
  const info = objects.get(trailer.get("Info")?.ref);
  const resolve = value => value?.ref === undefined ? value : objects.get(value.ref);
  if (!(info instanceof Map) || resolve(info.get("CreationDate"))?.string !== "D:20000101000000Z" || resolve(info.get("ModDate"))?.string !== "D:20000101000000Z") p.fail("PDF_NOT_REPRODUCIBLE");
  return true;
}
