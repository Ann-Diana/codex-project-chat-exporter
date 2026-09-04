import fs from "node:fs";
import { Readable } from "node:stream";

import { parserStream } from "stream-json";

export const DEFAULT_INPUT_CHUNK_BYTES = 64 * 1024;
export const DEFAULT_MAX_DEPTH = 256;
export const DEFAULT_MAX_KEY_CHARS = 64 * 1024;
export const DEFAULT_MAX_NUMBER_CHARS = 4 * 1024;
export const DEFAULT_MAX_STRING_CHUNK_CHARS = 256;

const CR = Buffer.from([0x0d]);

export class JsonlTokenAdapterError extends Error {
  constructor(code, recordIndex, message, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "JsonlTokenAdapterError";
    this.code = code;
    this.recordIndex = recordIndex;
  }
}

function adapterError(code, recordIndex, message, cause) {
  return new JsonlTokenAdapterError(code, recordIndex, message, cause);
}

function assertPositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive safe integer`);
}

function asBuffer(value) {
  if (!ArrayBuffer.isView(value)) throw new TypeError("JSONL input chunks must be Uint8Array values");
  return Buffer.isBuffer(value) ? value : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

class PhysicalLineReader {
  constructor(source) {
    this.iterator = source[Symbol.asyncIterator]();
    this.chunk = null;
    this.offset = 0;
    this.finished = false;
  }

  async *readLine() {
    let pendingCr = false;
    while (!this.finished) {
      if (!this.chunk || this.offset >= this.chunk.length) {
        const next = await this.iterator.next();
        if (next.done) {
          if (pendingCr) yield CR;
          this.finished = true;
          return;
        }
        this.chunk = asBuffer(next.value);
        this.offset = 0;
        if (this.chunk.length === 0) continue;
      }

      const newline = this.chunk.indexOf(0x0a, this.offset);
      const end = newline < 0 ? this.chunk.length : newline;
      let segment = this.chunk.subarray(this.offset, end);
      this.offset = newline < 0 ? end : newline + 1;

      if (pendingCr) {
        if (segment.length > 0 || newline < 0) yield CR;
        pendingCr = false;
      }
      if (segment.length > 0 && segment[segment.length - 1] === 0x0d) {
        if (segment.length > 1) yield segment.subarray(0, -1);
        pendingCr = true;
      } else if (segment.length > 0) {
        yield segment;
      }

      if (newline >= 0) {
        pendingCr = false;
        return;
      }
      this.chunk = null;
    }
  }

  async close() {
    this.finished = true;
    if (typeof this.iterator.return === "function") await this.iterator.return();
  }
}

async function* validateUtf8(chunks, state) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    for await (const chunk of chunks) {
      let text;
      try {
        text = decoder.decode(chunk, { stream: true });
      } catch (error) {
        state.utf8Error = error;
        throw error;
      }
      if (!state.hasNonWhitespace && text.trim().length > 0) state.hasNonWhitespace = true;
      yield chunk;
    }
    try {
      const tail = decoder.decode();
      if (!state.hasNonWhitespace && tail.trim().length > 0) state.hasNonWhitespace = true;
    } catch (error) {
      state.utf8Error = error;
      throw error;
    }
    state.complete = true;
  } catch (error) {
    if (!state.utf8Error) state.inputError = error;
    throw error;
  }
}

class TokenNormalizer {
  constructor(recordIndex, options) {
    this.recordIndex = recordIndex;
    this.maxDepth = options.maxDepth;
    this.maxKeyChars = options.maxKeyChars;
    this.maxNumberChars = options.maxNumberChars;
    this.maxStringChunkChars = options.maxStringChunkChars;
    this.stack = [];
    this.rootSeen = false;
    this.inKey = false;
    this.keyParts = [];
    this.keyChars = 0;
    this.stringPath = null;
    this.inNumber = false;
    this.numberParts = [];
    this.numberChars = 0;
  }

  fail(message, cause) {
    throw adapterError("JSONL_TOKEN_STATE_ERROR", this.recordIndex, message, cause);
  }

  consumeValuePath() {
    if (this.stack.length === 0) {
      if (this.rootSeen) this.fail("A record produced more than one root value");
      this.rootSeen = true;
      return [];
    }
    const parent = this.stack[this.stack.length - 1];
    if (parent.kind === "array") return [...parent.path, parent.nextIndex++];
    if (parent.pendingKey === null) this.fail("An object value appeared without a key");
    const path = [...parent.path, parent.pendingKey];
    parent.pendingKey = null;
    return path;
  }

  token(type, path, value) {
    const token = { recordIndex: this.recordIndex, path: [...path], type };
    if (value !== undefined) token.value = value;
    return token;
  }

  accept(raw) {
    switch (raw?.name) {
      case "startObject":
      case "startArray": {
        const path = this.consumeValuePath();
        if (this.stack.length + 1 > this.maxDepth) {
          throw adapterError("JSONL_MAX_DEPTH_EXCEEDED", this.recordIndex, `JSON nesting exceeds the configured maximum depth of ${this.maxDepth}`);
        }
        const kind = raw.name === "startObject" ? "object" : "array";
        this.stack.push({ kind, path, nextIndex: 0, pendingKey: null });
        return [this.token(`${kind}_start`, path)];
      }
      case "endObject":
      case "endArray": {
        const expectedKind = raw.name === "endObject" ? "object" : "array";
        const frame = this.stack.pop();
        if (!frame || frame.kind !== expectedKind) this.fail(`Unexpected ${raw.name} token`);
        if (frame.kind === "object" && frame.pendingKey !== null) this.fail("An object key has no value");
        return [this.token(`${expectedKind}_end`, frame.path)];
      }
      case "startKey":
        if (this.inKey || this.stringPath || this.inNumber) this.fail("Unexpected startKey token");
        if (this.stack.at(-1)?.kind !== "object" || this.stack.at(-1).pendingKey !== null) this.fail("Object key appeared in an invalid position");
        this.inKey = true;
        this.keyParts = [];
        this.keyChars = 0;
        return [];
      case "endKey": {
        if (!this.inKey) this.fail("Unexpected endKey token");
        const key = this.keyParts.join("");
        this.inKey = false;
        this.keyParts = [];
        const frame = this.stack.at(-1);
        if (!frame || frame.kind !== "object") this.fail("Completed key outside an object");
        frame.pendingKey = key;
        return [this.token("key", [...frame.path, key], key)];
      }
      case "startString": {
        if (this.inKey || this.stringPath || this.inNumber) this.fail("Unexpected startString token");
        this.stringPath = this.consumeValuePath();
        return [this.token("string_start", this.stringPath)];
      }
      case "stringChunk": {
        if (typeof raw.value !== "string") this.fail("String chunk has no string value");
        if (this.inKey) {
          this.keyChars += raw.value.length;
          if (this.keyChars > this.maxKeyChars) {
            throw adapterError("JSONL_KEY_TOO_LARGE", this.recordIndex, `JSON object key exceeds ${this.maxKeyChars} characters`);
          }
          this.keyParts.push(raw.value);
          return [];
        }
        if (!this.stringPath) this.fail("String chunk appeared outside a string value");
        const tokens = [];
        for (let offset = 0; offset < raw.value.length; offset += this.maxStringChunkChars) {
          tokens.push(this.token("string_chunk", this.stringPath, raw.value.slice(offset, offset + this.maxStringChunkChars)));
        }
        return tokens;
      }
      case "endString": {
        if (!this.stringPath || this.inKey) this.fail("Unexpected endString token");
        const path = this.stringPath;
        this.stringPath = null;
        return [this.token("string_end", path)];
      }
      case "startNumber":
        if (this.inKey || this.stringPath || this.inNumber) this.fail("Unexpected startNumber token");
        this.inNumber = true;
        this.numberPath = this.consumeValuePath();
        this.numberParts = [];
        this.numberChars = 0;
        return [];
      case "numberChunk":
        if (!this.inNumber || typeof raw.value !== "string") this.fail("Unexpected numberChunk token");
        this.numberChars += raw.value.length;
        if (this.numberChars > this.maxNumberChars) {
          throw adapterError("JSONL_NUMBER_TOO_LARGE", this.recordIndex, `JSON number exceeds ${this.maxNumberChars} characters`);
        }
        this.numberParts.push(raw.value);
        return [];
      case "endNumber": {
        if (!this.inNumber) this.fail("Unexpected endNumber token");
        const path = this.numberPath;
        const value = Number(this.numberParts.join(""));
        this.inNumber = false;
        this.numberPath = null;
        this.numberParts = [];
        return [this.token("number", path, value)];
      }
      case "trueValue":
      case "falseValue":
      case "nullValue": {
        const type = raw.name === "nullValue" ? "null" : "boolean";
        return [this.token(type, this.consumeValuePath(), raw.value)];
      }
      default:
        this.fail(`Unsupported parser token: ${String(raw?.name)}`);
    }
  }

  finish() {
    if (!this.rootSeen || this.stack.length || this.inKey || this.stringPath || this.inNumber) this.fail("Parser token stream ended in an incomplete state");
  }
}

function createSource(input, inputChunkBytes) {
  if (typeof input === "string") {
    const stream = fs.createReadStream(input, { highWaterMark: inputChunkBytes });
    return { source: stream, owned: stream };
  }
  if (!input || typeof input[Symbol.asyncIterator] !== "function") throw new TypeError("input must be a file path or an AsyncIterable of Uint8Array chunks");
  return { source: input, owned: null };
}

export async function* streamJsonlTokens(input, options = {}) {
  const inputChunkBytes = options.inputChunkBytes ?? DEFAULT_INPUT_CHUNK_BYTES;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxKeyChars = options.maxKeyChars ?? DEFAULT_MAX_KEY_CHARS;
  const maxNumberChars = options.maxNumberChars ?? DEFAULT_MAX_NUMBER_CHARS;
  const maxStringChunkChars = options.maxStringChunkChars ?? DEFAULT_MAX_STRING_CHUNK_CHARS;
  for (const [value, name] of [[inputChunkBytes, "inputChunkBytes"], [maxDepth, "maxDepth"], [maxKeyChars, "maxKeyChars"], [maxNumberChars, "maxNumberChars"], [maxStringChunkChars, "maxStringChunkChars"]]) {
    assertPositiveInteger(value, name);
  }

  const { source, owned } = createSource(input, inputChunkBytes);
  const lineReader = new PhysicalLineReader(source);
  let completedRecords = 0;
  try {
    while (!lineReader.finished) {
      const state = { complete: false, hasNonWhitespace: false, inputError: null, utf8Error: null };
      const parserInput = Readable.from(validateUtf8(lineReader.readLine(), state), { objectMode: false, highWaterMark: 1 });
      const tokenizer = parserStream({
        packKeys: false,
        packNumbers: false,
        packStrings: false,
        streamKeys: true,
        streamNumbers: true,
        streamStrings: true,
        writableHighWaterMark: 1,
      });
      parserInput.once("error", (error) => tokenizer.destroy(error));
      parserInput.pipe(tokenizer);
      const recordIndex = completedRecords + 1;
      const normalizer = new TokenNormalizer(recordIndex, { maxDepth, maxKeyChars, maxNumberChars, maxStringChunkChars });
      let recordStarted = false;
      try {
        for await (const rawToken of tokenizer) {
          if (!recordStarted) {
            recordStarted = true;
            yield { recordIndex, path: [], type: "record_start" };
          }
          for (const token of normalizer.accept(rawToken)) yield token;
        }
        if (!state.hasNonWhitespace && state.complete) continue;
        if (!recordStarted) throw adapterError("JSONL_INVALID_JSON", recordIndex, "A non-empty JSONL record produced no JSON value");
        normalizer.finish();
        yield { recordIndex, path: [], type: "record_end" };
        completedRecords += 1;
      } catch (error) {
        if (!state.hasNonWhitespace && state.complete && !state.utf8Error && !state.inputError) continue;
        if (error instanceof JsonlTokenAdapterError) throw error;
        if (state.utf8Error) throw adapterError("JSONL_INVALID_UTF8", recordIndex, `Invalid UTF-8 in JSONL record ${recordIndex}`, state.utf8Error);
        if (state.inputError) throw adapterError("JSONL_INPUT_ERROR", recordIndex, `Failed while reading JSONL record ${recordIndex}`, state.inputError);
        throw adapterError("JSONL_INVALID_JSON", recordIndex, `Invalid JSON in JSONL record ${recordIndex}`, error);
      } finally {
        parserInput.unpipe(tokenizer);
        parserInput.destroy();
        tokenizer.destroy();
      }
    }
  } finally {
    await lineReader.close();
    if (owned && !owned.destroyed) owned.destroy();
  }
}
