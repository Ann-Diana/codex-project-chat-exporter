import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import readline from "node:readline";

import { BoundedBase64Error, createBase64Decoder } from "./bounded-base64.mjs";
import { JsonlTokenAdapterError, streamJsonlTokens } from "./jsonl-token-adapter.mjs";
import { throwIfAborted } from "./export-abort.mjs";

export const SESSION_READER_IMPLEMENTATION = Object.freeze({
  LEGACY_REFERENCE: "legacy-reference",
  STREAMING: "streaming",
});

const ATTACHMENT_DESCRIPTOR_KIND = "bounded-embedded-attachment";
const ATTACHMENT_PATH_NAMES = new Set(["attachment", "attachments", "data", "file", "files", "image", "image_url", "images", "local_image", "local_images"]);

export class SessionRecordReaderError extends Error {
  constructor(code, recordNumber, message, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "SessionRecordReaderError";
    this.code = code;
    this.recordNumber = recordNumber;
  }
}

export function createSessionReaderSummary() {
  return {
    physicalLineCount: 0,
    nonEmptyLineCount: 0,
    recordCount: 0,
    invalidRecordCount: 0,
    attachmentCount: 0,
    attachmentBytes: 0,
    attachmentHashes: new Set(),
    maxDecodedBlockBytes: 0,
    fileSha256: "",
    beforeSizeBytes: null,
    beforeMtimeMs: null,
    afterSizeBytes: null,
    afterMtimeMs: null,
    stable: false,
  };
}

export function isAttachmentDescriptor(value) {
  return Boolean(value && typeof value === "object" && value.kind === ATTACHMENT_DESCRIPTOR_KIND);
}

export function attachmentIdentity(value) {
  if (isAttachmentDescriptor(value)) return `embedded:${value.sourceSha256}`;
  return `reference:${String(value ?? "")}`;
}

export async function* streamSessionRecords(file, options = {}) {
  throwIfAborted(options.abortSignal, "session streaming");
  const implementation = options.implementation ?? SESSION_READER_IMPLEMENTATION.STREAMING;
  if (!Object.values(SESSION_READER_IMPLEMENTATION).includes(implementation)) throw new TypeError(`Unknown session reader implementation: ${implementation}`);
  const summary = options.summary ?? createSessionReaderSummary();
  const source = implementation === SESSION_READER_IMPLEMENTATION.STREAMING
    ? streamProjectedRecords(file, summary, options)
    : streamLegacyReferenceRecords(file, summary, options);
  yield* source;
}

async function* streamProjectedRecords(file, summary, options) {
  throwIfAborted(options.abortSignal, "session streaming");
  const before = await fsp.stat(file);
  summary.beforeSizeBytes = before.size;
  summary.beforeMtimeMs = before.mtimeMs;
  let rawHash = null;
  try {
    rawHash = options.rawHashFactory ? options.rawHashFactory() : (options.calculateSha256 ? createHash("sha256") : null);
  } catch (error) {
    throw readerError("SESSION_HASH_ERROR", 1, "Failed to initialize the session source hash", error);
  }
  const input = (options.io?.createReadStream ?? fs.createReadStream)(file, { highWaterMark: options.inputChunkBytes ?? 64 * 1024 });
  const projector = new StreamingRecordProjector(options);

  async function* sourceChunks() {
    try {
      for await (const chunk of input) {
        throwIfAborted(options.abortSignal, "session streaming");
        if (rawHash) {
          try { rawHash.update(chunk); } catch (error) { throw readerError("SESSION_HASH_ERROR", summary.recordCount + 1, "Failed while hashing the session source", error); }
        }
        yield chunk;
      }
    } catch (error) {
      if (error instanceof SessionRecordReaderError || error?.code === "EXPORT_CANCELLED") throw error;
      throw readerError("SESSION_SOURCE_ERROR", summary.recordCount + 1, "Failed while reading the session source", error);
    }
  }

  try {
    for await (const token of streamJsonlTokens(sourceChunks(), options.tokenOptions)) {
      throwIfAborted(options.abortSignal, "session streaming");
      const record = await projector.accept(token);
      if (!record) continue;
      try {
        await options.beforeRecordCommit?.(record, token.recordIndex);
      } catch (error) {
        if (error?.code === "EXPORT_CANCELLED") throw error;
        throw readerError("SESSION_RECORD_COMMIT_ERROR", token.recordIndex, `Session record ${token.recordIndex} failed before commit`, error);
      }
      observeSummaryRecord(summary, record);
      summary.nonEmptyLineCount = token.recordIndex;
      yield { item: record.item, attachments: record.attachments, recordNumber: token.recordIndex };
      throwIfAborted(options.abortSignal, "session streaming");
    }
    throwIfAborted(options.abortSignal, "session streaming");
    summary.physicalLineCount = summary.recordCount;
    const after = await fsp.stat(file);
    finishSummary(summary, before, after, rawHash);
  } catch (error) {
    const normalized = normalizeReaderError(error, summary.recordCount + 1);
    try { await options.onRecordAbort?.(normalized.recordNumber, normalized); } catch (cleanupError) {
      throw readerError("SESSION_RECORD_CLEANUP_ERROR", normalized.recordNumber, `Session record ${normalized.recordNumber} cleanup failed`, new AggregateError([normalized, cleanupError]));
    }
    throw normalized;
  } finally {
    if (!input.destroyed) input.destroy();
  }
}

async function* streamLegacyReferenceRecords(file, summary, options) {
  throwIfAborted(options.abortSignal, "session streaming");
  const before = await fsp.stat(file);
  summary.beforeSizeBytes = before.size;
  summary.beforeMtimeMs = before.mtimeMs;
  let rawHash = null;
  let rawHashError = null;
  try {
    rawHash = options.rawHashFactory ? options.rawHashFactory() : (options.calculateSha256 ? createHash("sha256") : null);
  } catch (error) {
    throw readerError("SESSION_HASH_ERROR", 1, "Failed to initialize the session source hash", error);
  }
  const input = (options.io?.createReadStream ?? fs.createReadStream)(file);
  if (rawHash) input.on("data", (chunk) => {
    try { rawHash.update(chunk); } catch (error) {
      rawHashError = readerError("SESSION_HASH_ERROR", summary.recordCount + 1, "Failed while hashing the session source", error);
      input.destroy(rawHashError);
    }
  });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      throwIfAborted(options.abortSignal, "session streaming");
      summary.physicalLineCount += 1;
      if (!line.trim()) continue;
      summary.nonEmptyLineCount += 1;
      const recordNumber = summary.nonEmptyLineCount;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        summary.invalidRecordCount += 1;
        if (options.invalidRecordPolicy === "error") throw readerError("SESSION_JSONL_INVALID", recordNumber, `Invalid JSON in session record ${recordNumber}`, error);
        continue;
      }
      let item;
      try {
        item = await projectLegacyValue(parsed, [], { ...options, currentRecordNumber: recordNumber });
      } catch (error) {
        throw normalizeReaderError(error, recordNumber);
      }
      const record = { item, attachments: collectAttachmentDescriptors(item) };
      try {
        await options.beforeRecordCommit?.(record, recordNumber);
      } catch (error) {
        if (error?.code === "EXPORT_CANCELLED") throw error;
        throw readerError("SESSION_RECORD_COMMIT_ERROR", recordNumber, `Session record ${recordNumber} failed before commit`, error);
      }
      observeSummaryRecord(summary, record);
      yield { item, attachments: record.attachments, recordNumber };
      throwIfAborted(options.abortSignal, "session streaming");
    }
    throwIfAborted(options.abortSignal, "session streaming");
    const after = await fsp.stat(file);
    finishSummary(summary, before, after, rawHash);
  } catch (error) {
    const normalized = rawHashError || (error instanceof SessionRecordReaderError || error?.code === "EXPORT_CANCELLED"
      ? error
      : readerError("SESSION_SOURCE_ERROR", summary.recordCount + 1, "Failed while reading the session source", error));
    try { await options.onRecordAbort?.(normalized.recordNumber, normalized); } catch (cleanupError) {
      throw readerError("SESSION_RECORD_CLEANUP_ERROR", normalized.recordNumber, `Session record ${normalized.recordNumber} cleanup failed`, new AggregateError([normalized, cleanupError]));
    }
    throw normalized;
  } finally {
    lines.close();
    if (!input.destroyed) input.destroy();
  }
}

class StreamingRecordProjector {
  constructor(options) {
    this.options = options;
    this.root = undefined;
    this.activeString = null;
    this.attachments = [];
  }

  async accept(token) {
    switch (token.type) {
      case "record_start":
        this.root = undefined;
        this.activeString = null;
        this.attachments = [];
        return null;
      case "object_start":
        this.root = assignPath(this.root, token.path, {});
        return null;
      case "array_start":
        this.root = assignPath(this.root, token.path, []);
        return null;
      case "string_start":
        this.activeString = new ProjectedString(token.path, { ...this.options, currentRecordNumber: token.recordIndex });
        return null;
      case "string_chunk":
        if (!this.activeString) throw readerError("SESSION_PROJECTION_ERROR", token.recordIndex, "String chunk appeared without a projected string");
        await this.activeString.write(token.value);
        return null;
      case "string_end": {
        if (!this.activeString) throw readerError("SESSION_PROJECTION_ERROR", token.recordIndex, "String end appeared without a projected string");
        const value = await this.activeString.finish();
        if (isAttachmentDescriptor(value)) this.attachments.push(value);
        this.root = assignPath(this.root, token.path, value);
        this.activeString = null;
        return null;
      }
      case "number":
      case "boolean":
      case "null":
        this.root = assignPath(this.root, token.path, token.value);
        return null;
      case "record_end":
        if (this.activeString) throw readerError("SESSION_PROJECTION_ERROR", token.recordIndex, "Record ended with an open projected string");
        return { item: this.root, attachments: [...this.attachments] };
      case "key":
      case "object_end":
      case "array_end":
        return null;
      default:
        throw readerError("SESSION_PROJECTION_ERROR", token.recordIndex, `Unsupported normalized token type: ${String(token.type)}`);
    }
  }
}

class ProjectedString {
  constructor(valuePath, options) {
    this.path = [...valuePath];
    this.options = options;
    this.mode = "probing";
    this.parts = [];
    this.probe = "";
    this.decoder = null;
    this.mediaType = "";
    this.sourceKind = "";
    this.sourceHash = createHash("sha256");
    this.assetSink = null;
  }

  async write(value) {
    this.sourceHash.update(value, "utf8");
    if (this.mode === "ordinary") {
      this.parts.push(value);
      return;
    }
    if (this.mode === "embedded") {
      await this.decoder.write(stripBase64Whitespace(value));
      return;
    }
    this.probe += value;
    await this.classify(false);
  }

  async classify(final) {
    const lower = this.probe.slice(0, 5).toLowerCase();
    if ("data:".startsWith(lower) && this.probe.length < 5 && !final) return;
    if (lower === "data:") {
      if (!isAttachmentPath(this.path)) {
        this.becomeOrdinary();
        return;
      }
      const comma = this.probe.indexOf(",");
      if (comma < 0 && !final) return;
      if (comma >= 0) {
        const header = this.probe.slice(5, comma);
        const fields = header.split(";");
        if (fields.slice(1).some((field) => field.toLowerCase() === "base64")) {
          const mediaType = fields[0] || "application/octet-stream";
          const payload = this.probe.slice(comma + 1);
          this.probe = "";
          await this.startEmbedded(mediaType, "data_url", payload);
          return;
        }
      }
      this.becomeOrdinary();
      return;
    }

    if (!isAttachmentPath(this.path)) {
      this.becomeOrdinary();
      return;
    }
    const enoughForSignature = stripBase64Whitespace(this.probe).length >= 16;
    if (!enoughForSignature && !final) return;
    const mediaType = embeddedImageMediaType(this.probe);
    if (mediaType) {
      const payload = this.probe;
      this.probe = "";
      await this.startEmbedded(mediaType, "unprefixed_base64", payload);
    } else this.becomeOrdinary();
  }

  becomeOrdinary() {
    this.mode = "ordinary";
    this.parts.push(this.probe);
    this.probe = "";
  }

  async startEmbedded(mediaType, sourceKind, payload) {
    this.mode = "embedded";
    this.mediaType = mediaType.toLowerCase();
    this.sourceKind = sourceKind;
    this.assetSink = await this.options.onAttachmentStart?.({
      mediaType: this.mediaType,
      path: [...this.path],
      recordNumber: this.options.currentRecordNumber,
      sourceKind: this.sourceKind,
    }) || null;
    this.decoder = createBase64Decoder(async (chunk) => {
      await this.assetSink?.write?.(chunk);
      await this.options.onAttachmentDecodedChunk?.(chunk, {
        mediaType: this.mediaType,
        path: [...this.path],
        sourceKind: this.sourceKind,
      });
    }, this.options.base64Options);
    await this.decoder.write(stripBase64Whitespace(payload));
  }

  async finish() {
    if (this.mode === "probing") await this.classify(true);
    if (this.mode === "ordinary") return this.parts.join("");
    try {
      const decoded = await this.decoder.finish();
      const descriptor = Object.freeze({
        kind: ATTACHMENT_DESCRIPTOR_KIND,
        encoding: "base64",
        mediaType: this.mediaType,
        decodedBytes: decoded.decodedBytes,
        sha256: decoded.sha256,
        sourceSha256: this.sourceHash.digest("hex"),
        sourceKind: this.sourceKind,
        maxDecodedBlockBytes: decoded.maxDecodedBlockBytes,
      });
      await this.assetSink?.finish?.(descriptor);
      return descriptor;
    } catch (error) {
      try { await this.assetSink?.abort?.(error); } catch {}
      throw error;
    }
  }
}

async function projectLegacyValue(value, valuePath, options) {
  if (typeof value === "string") {
    const projected = new ProjectedString(valuePath, options);
    try {
      await projected.write(value);
      return await projected.finish();
    } catch (error) {
      if (error instanceof BoundedBase64Error && options.legacyPreserveInvalidAttachments !== false) return value;
      throw error;
    }
  }
  if (Array.isArray(value)) {
    const projected = [];
    for (let index = 0; index < value.length; index += 1) projected.push(await projectLegacyValue(value[index], [...valuePath, index], options));
    return projected;
  }
  if (value && typeof value === "object") {
    const projected = {};
    for (const [key, child] of Object.entries(value)) projected[key] = await projectLegacyValue(child, [...valuePath, key], options);
    return projected;
  }
  return value;
}

function assignPath(root, valuePath, value) {
  if (valuePath.length === 0) return value;
  let parent = root;
  for (const segment of valuePath.slice(0, -1)) parent = parent[segment];
  parent[valuePath.at(-1)] = value;
  return root;
}

function isAttachmentPath(valuePath) {
  return valuePath.some((segment) => typeof segment === "string" && ATTACHMENT_PATH_NAMES.has(segment.toLowerCase()));
}

function stripBase64Whitespace(value) {
  let result = "";
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== " " && character !== "\t" && character !== "\r" && character !== "\n") continue;
    result += value.slice(start, index);
    start = index + 1;
  }
  return start === 0 ? value : result + value.slice(start);
}

function embeddedImageMediaType(value) {
  const compact = stripBase64Whitespace(value);
  if (compact.length < 12 || !isBase64Text(compact)) return "";
  const signature = Buffer.from(compact.slice(0, 32), "base64");
  const png = signature.length >= 8 && signature[0] === 0x89 && signature[1] === 0x50 && signature[2] === 0x4e && signature[3] === 0x47 && signature[4] === 0x0d && signature[5] === 0x0a && signature[6] === 0x1a && signature[7] === 0x0a;
  const jpeg = signature.length >= 3 && signature[0] === 0xff && signature[1] === 0xd8 && signature[2] === 0xff;
  return png ? "image/png" : (jpeg ? "image/jpeg" : "");
}

function isBase64Text(value) {
  for (const character of value) {
    const code = character.charCodeAt(0);
    const valid = (code >= 0x41 && code <= 0x5a)
      || (code >= 0x61 && code <= 0x7a)
      || (code >= 0x30 && code <= 0x39)
      || code === 0x2b
      || code === 0x2f
      || code === 0x3d;
    if (!valid) return false;
  }
  return true;
}

function collectAttachmentDescriptors(value, output = []) {
  if (isAttachmentDescriptor(value)) {
    output.push(value);
    return output;
  }
  if (Array.isArray(value)) {
    for (const child of value) collectAttachmentDescriptors(child, output);
  } else if (value && typeof value === "object") {
    for (const child of Object.values(value)) collectAttachmentDescriptors(child, output);
  }
  return output;
}

function observeSummaryRecord(summary, record) {
  summary.recordCount += 1;
  summary.attachmentCount += record.attachments.length;
  for (const attachment of record.attachments) {
    summary.attachmentBytes += attachment.decodedBytes;
    summary.attachmentHashes.add(attachment.sha256);
    summary.maxDecodedBlockBytes = Math.max(summary.maxDecodedBlockBytes, attachment.maxDecodedBlockBytes || 0);
  }
}

function finishSummary(summary, before, after, rawHash) {
  summary.afterSizeBytes = after.size;
  summary.afterMtimeMs = after.mtimeMs;
  summary.stable = before.size === after.size && before.mtimeMs === after.mtimeMs;
  if (rawHash) {
    try { summary.fileSha256 = rawHash.digest("hex"); } catch (error) { throw readerError("SESSION_HASH_ERROR", summary.recordCount + 1, "Failed to finalize the session source hash", error); }
  }
}

function normalizeReaderError(error, recordNumber) {
  if (error?.code === "EXPORT_CANCELLED") return error;
  if (error instanceof SessionRecordReaderError) return error;
  let cause = error?.cause;
  while (cause) {
    if (cause?.code === "EXPORT_CANCELLED") return cause;
    if (cause instanceof SessionRecordReaderError) return cause;
    cause = cause.cause;
  }
  if (error instanceof BoundedBase64Error) return readerError("SESSION_ATTACHMENT_DECODE_ERROR", recordNumber, `Embedded attachment decoding failed in session record ${recordNumber}`, error);
  if (error instanceof JsonlTokenAdapterError) {
    const code = error.code === "JSONL_INPUT_ERROR" ? "SESSION_SOURCE_ERROR" : "SESSION_JSONL_INVALID";
    return readerError(code, error.recordIndex, `${code === "SESSION_SOURCE_ERROR" ? "Source reading" : "JSON validation"} failed in session record ${error.recordIndex}`, error);
  }
  return readerError("SESSION_READER_ERROR", recordNumber, `Session reader failed at record ${recordNumber}`, error);
}

function readerError(code, recordNumber, message, cause) {
  return new SessionRecordReaderError(code, recordNumber, message, cause);
}
