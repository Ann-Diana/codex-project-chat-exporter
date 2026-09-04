import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { throwIfAborted } from "./export-abort.mjs";

export const ASSET_MANIFEST_SCHEMA_VERSION = 2;
export const ASSET_EXTENSIONS = Object.freeze(["bin", "gif", "jpg", "png", "webp"]);

const HEADER_BYTES = 64;
const MAX_WRITE_BLOCK_BYTES = 3072;
const TYPE_UNKNOWN = Object.freeze({ extension: "bin", mimeType: "application/octet-stream", renderable: false });

export class AssetStoreError extends Error {
  constructor(code, message, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "AssetStoreError";
    this.code = code;
  }
}

function errorWithCode(code, message, cause) {
  return new AssetStoreError(code, message, cause);
}

function defaultIo() {
  return {
    link: fsp.link,
    lstat: fsp.lstat,
    mkdir: fsp.mkdir,
    open: fsp.open,
    realpath: fsp.realpath,
    rm: fsp.rm,
    rmdir: fsp.rmdir,
    stat: fsp.stat,
    unlink: fsp.unlink,
  };
}

function fileIdentity(stat) {
  if (typeof stat?.dev === "bigint" && typeof stat?.ino === "bigint" && stat.dev >= 0n && stat.ino > 0n) return `${stat.dev}:${stat.ino}`;
  if (Number.isSafeInteger(stat?.dev) && Number.isSafeInteger(stat?.ino) && stat.dev >= 0 && stat.ino > 0) return `${stat.dev}:${stat.ino}`;
  return "";
}

function samePath(left, right) {
  const normalize = (value) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(left) === normalize(right);
}

function isLowerHexSha256(value) {
  if (typeof value !== "string" || value.length !== 64) return false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (!((code >= 0x30 && code <= 0x39) || (code >= 0x61 && code <= 0x66))) return false;
  }
  return true;
}

function normalizeDeclaredMime(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text || text.length > 127 || text.split("/").length !== 2) return "";
  for (const character of text) {
    const code = character.charCodeAt(0);
    const alphanumeric = (code >= 48 && code <= 57) || (code >= 97 && code <= 122);
    if (!alphanumeric && !"!#$&^_.+-/".includes(character)) return "";
  }
  return text;
}

function normalizeSessionReference(value) {
  const text = String(value || "").trim();
  if (!text || text.length > 256) return "";
  for (const character of text) {
    const code = character.charCodeAt(0);
    if (code < 0x20 || code === 0x7f || "/\\:".includes(character)) return "";
  }
  return text;
}

function normalizeManifestText(value, fallback = "") {
  const text = String(value ?? "");
  if (!text || text.length > 256) return fallback;
  for (const character of text) {
    const code = character.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return fallback;
  }
  return text;
}

function normalizeCanonicalOrdinal(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function defaultUsageMetadata(recordNumber, attachmentOrdinal) {
  return {
    canonical_attachment_ordinal: attachmentOrdinal,
    canonical_record_ordinal: recordNumber,
    classification: "UNCLASSIFIED_ATTACHMENT_RECORD",
    content_type: "attachment",
    mirror_kind: "",
    reading_disposition: "VISIBLE",
    record_type: "unknown",
    role: "UNCLASSIFIED",
    timestamp: "",
    tool_origin: "NONE",
  };
}

function normalizedUsageMetadata(value, recordNumber, attachmentOrdinal) {
  const fallback = defaultUsageMetadata(recordNumber, attachmentOrdinal);
  return {
    canonical_attachment_ordinal: normalizeCanonicalOrdinal(value?.canonical_attachment_ordinal),
    canonical_record_ordinal: normalizeCanonicalOrdinal(value?.canonical_record_ordinal),
    classification: normalizeManifestText(value?.classification, fallback.classification),
    content_type: normalizeManifestText(value?.content_type, fallback.content_type),
    mirror_kind: normalizeManifestText(value?.mirror_kind, ""),
    reading_disposition: normalizeManifestText(value?.reading_disposition, fallback.reading_disposition),
    record_type: normalizeManifestText(value?.record_type, fallback.record_type),
    role: normalizeManifestText(value?.role, fallback.role),
    timestamp: normalizeManifestText(value?.timestamp, ""),
    tool_origin: normalizeManifestText(value?.tool_origin, fallback.tool_origin),
  };
}

function startsWithBytes(buffer, bytes) {
  if (buffer.length < bytes.length) return false;
  return bytes.every((value, index) => buffer[index] === value);
}

export function detectAssetType(header, totalBytes = undefined) {
  const bytes = Buffer.isBuffer(header) ? header : Buffer.from(header || []);
  const exactBytes = totalBytes === undefined ? bytes.length : totalBytes;
  const validExactBytes = Number.isSafeInteger(exactBytes) && exactBytes >= bytes.length;
  const pngBitDepth = bytes.length >= 29 ? bytes[24] : 0;
  const pngColorType = bytes.length >= 29 ? bytes[25] : 0xff;
  const validPngDepth = ({ 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] }[pngColorType] || []).includes(pngBitDepth);
  if (validExactBytes && exactBytes >= 33 && bytes.length >= 29
    && startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    && bytes.readUInt32BE(8) === 13
    && bytes.subarray(12, 16).equals(Buffer.from("IHDR", "ascii"))
    && bytes.readUInt32BE(16) > 0
    && bytes.readUInt32BE(20) > 0
    && validPngDepth
    && bytes[26] === 0
    && bytes[27] === 0
    && bytes[28] <= 1) {
    return Object.freeze({ extension: "png", mimeType: "image/png", renderable: true });
  }
  const jpegMarker = bytes.length >= 4 ? bytes[3] : 0;
  const jpegSegmentLength = bytes.length >= 6 ? bytes.readUInt16BE(4) : 0;
  const knownJpegSegment = (jpegMarker >= 0xc0 && jpegMarker <= 0xcf && jpegMarker !== 0xc8)
    || jpegMarker === 0xda
    || jpegMarker === 0xdb
    || jpegMarker === 0xdd
    || jpegMarker === 0xfe
    || (jpegMarker >= 0xe0 && jpegMarker <= 0xef);
  if (validExactBytes && bytes.length >= 6 && startsWithBytes(bytes, [0xff, 0xd8, 0xff]) && knownJpegSegment && jpegSegmentLength >= 2 && exactBytes >= 4 + jpegSegmentLength) {
    return Object.freeze({ extension: "jpg", mimeType: "image/jpeg", renderable: true });
  }
  if (validExactBytes && exactBytes >= 13 && bytes.length >= 13
    && (bytes.subarray(0, 6).equals(Buffer.from("GIF87a", "ascii")) || bytes.subarray(0, 6).equals(Buffer.from("GIF89a", "ascii")))
    && bytes.readUInt16LE(6) > 0
    && bytes.readUInt16LE(8) > 0) {
    return Object.freeze({ extension: "gif", mimeType: "image/gif", renderable: true });
  }
  const webpChunk = bytes.length >= 20 ? bytes.subarray(12, 16).toString("ascii") : "";
  const webpChunkBytes = bytes.length >= 20 ? bytes.readUInt32LE(16) : 0;
  const webpMinimumChunkBytes = { "VP8 ": 10, VP8L: 5, VP8X: 10 }[webpChunk] || Number.MAX_SAFE_INTEGER;
  if (validExactBytes && bytes.length >= 20
    && bytes.subarray(0, 4).equals(Buffer.from("RIFF", "ascii"))
    && bytes.readUInt32LE(4) + 8 === exactBytes
    && bytes.subarray(8, 12).equals(Buffer.from("WEBP", "ascii"))
    && webpChunkBytes >= webpMinimumChunkBytes
    && 20 + webpChunkBytes + (webpChunkBytes % 2) <= exactBytes) {
    return Object.freeze({ extension: "webp", mimeType: "image/webp", renderable: true });
  }
  return TYPE_UNKNOWN;
}

async function writeAll(handle, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, null);
    if (bytesWritten <= 0) throw new Error("Asset write made no progress");
    offset += bytesWritten;
  }
}

async function inspectDirectory(directory, io) {
  const absolute = path.resolve(directory);
  const linkStat = await io.lstat(absolute);
  if (linkStat.isSymbolicLink() || !linkStat.isDirectory()) throw errorWithCode("ASSET_PATH_UNSAFE", "The asset directory must be a real directory, not a symbolic link or junction");
  const canonical = await io.realpath(absolute);
  if (!samePath(canonical, absolute)) throw errorWithCode("ASSET_PATH_UNSAFE", "The asset directory resolves through an alias or junction");
  const identityStat = await io.stat(canonical, { bigint: true });
  const identity = fileIdentity(identityStat);
  if (!identity) throw errorWithCode("ASSET_PATH_UNSAFE", "Reliable asset-directory identity is unavailable");
  return { absolute, canonical, identity };
}

async function verifyDirectory(snapshot, io) {
  const current = await inspectDirectory(snapshot.absolute, io);
  if (current.identity !== snapshot.identity || !samePath(current.canonical, snapshot.canonical)) throw errorWithCode("ASSET_PATH_UNSAFE", "The asset directory changed during export");
  return current;
}

async function removeOwnedFile(owned, io) {
  if (!owned) return;
  let current;
  try { current = await io.lstat(owned.path, { bigint: true }); } catch (error) { if (error?.code === "ENOENT") return; throw error; }
  if (current.isSymbolicLink() || !current.isFile() || fileIdentity(current) !== owned.identity) {
    throw errorWithCode("ASSET_CLEANUP_ERROR", "Refusing to remove a file whose current identity is not proven to belong to this run");
  }
  await io.unlink(owned.path);
}

async function hashOpenFile(file, io) {
  const handle = await io.open(file, "r");
  try {
    const before = await handle.stat({ bigint: true });
    const identity = fileIdentity(before);
    if (!before.isFile() || !identity) throw errorWithCode("ASSET_PATH_UNSAFE", "Asset target is not a regular file with reliable identity");
    const hash = createHash("sha256");
    const header = Buffer.alloc(HEADER_BYTES);
    let headerLength = 0;
    const stream = fs.createReadStream(file, { autoClose: false, fd: handle.fd });
    for await (const chunk of stream) {
      hash.update(chunk);
      if (headerLength < HEADER_BYTES) {
        const length = Math.min(HEADER_BYTES - headerLength, chunk.length);
        chunk.copy(header, headerLength, 0, length);
        headerLength += length;
      }
    }
    const after = await handle.stat({ bigint: true });
    if (fileIdentity(after) !== identity || before.size !== after.size || before.mtimeNs !== after.mtimeNs) throw errorWithCode("ASSET_EXISTING_MISMATCH", "Asset target changed while it was verified");
    const bytes = Number(after.size);
    if (!Number.isSafeInteger(bytes)) throw errorWithCode("ASSET_EXISTING_MISMATCH", "Asset size exceeds the supported exact integer range");
    return { bytes, header: header.subarray(0, headerLength), identity, sha256: hash.digest("hex") };
  } finally {
    await handle.close();
  }
}

async function verifyAssetFile(file, expected, io) {
  let linkStat;
  try { linkStat = await io.lstat(file, { bigint: true }); } catch (error) {
    if (error?.code === "ENOENT") throw errorWithCode("ASSET_EXISTING_MISMATCH", "Expected asset target is missing", error);
    throw error;
  }
  if (linkStat.isSymbolicLink() || !linkStat.isFile()) throw errorWithCode("ASSET_PATH_UNSAFE", "Asset target is not a regular file");
  const opened = await hashOpenFile(file, io);
  const current = await io.lstat(file, { bigint: true });
  if (fileIdentity(current) !== opened.identity) throw errorWithCode("ASSET_EXISTING_MISMATCH", "Asset target changed after verification");
  const detected = detectAssetType(opened.header, opened.bytes);
  if (opened.bytes !== expected.bytes || opened.sha256 !== expected.sha256 || detected.extension !== expected.extension || detected.mimeType !== expected.mimeType) {
    throw errorWithCode("ASSET_EXISTING_MISMATCH", "Existing asset content, size, or validated type does not match the expected asset");
  }
  return opened;
}

export async function probeHardLinkSupport(directory, options = {}) {
  throwIfAborted(options.abortSignal, "asset preflight");
  const io = { ...defaultIo(), ...options.io };
  const root = await inspectDirectory(directory, io);
  const probeDirectory = path.join(root.absolute, `.asset-hardlink-probe-${randomUUID()}`);
  const source = path.join(probeDirectory, "source.bin");
  const target = path.join(probeDirectory, "target.bin");
  let sourceOwned = null;
  let targetOwned = null;
  let probeCreated = false;
  let failure = null;
  try {
    throwIfAborted(options.abortSignal, "asset preflight");
    await io.mkdir(probeDirectory);
    probeCreated = true;
    const handle = await io.open(source, "wx");
    try {
      const stat = await handle.stat({ bigint: true });
      sourceOwned = { path: source, identity: fileIdentity(stat) };
      if (!sourceOwned.identity) throw errorWithCode("ASSET_HARDLINK_UNSUPPORTED", "Reliable file identity is unavailable on the target filesystem");
      await handle.writeFile(randomBytes(32));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await io.link(source, target);
    throwIfAborted(options.abortSignal, "asset preflight");
    const [sourceStat, targetStat] = await Promise.all([io.lstat(source, { bigint: true }), io.lstat(target, { bigint: true })]);
    const sourceIdentity = fileIdentity(sourceStat);
    const targetIdentity = fileIdentity(targetStat);
    if (!sourceIdentity || sourceIdentity !== targetIdentity || sourceIdentity !== sourceOwned.identity) throw errorWithCode("ASSET_HARDLINK_UNSUPPORTED", "Hard-link identity verification failed on the target filesystem");
    targetOwned = { path: target, identity: targetIdentity };
    const [sourceBytes, targetBytes] = await Promise.all([hashOpenFile(source, io), hashOpenFile(target, io)]);
    if (sourceBytes.sha256 !== targetBytes.sha256 || sourceBytes.bytes !== targetBytes.bytes) throw errorWithCode("ASSET_HARDLINK_UNSUPPORTED", "Hard-link content verification failed on the target filesystem");
  } catch (error) {
    failure = error?.code === "EXPORT_CANCELLED"
      ? error
      : error instanceof AssetStoreError && error.code === "ASSET_HARDLINK_UNSUPPORTED"
      ? error
      : errorWithCode("ASSET_HARDLINK_UNSUPPORTED", "The target filesystem does not support safe exclusive hard-link publication. No existing files were overwritten; choose a target on a supported local filesystem.", error);
  }
  const cleanupErrors = [];
  for (const owned of [targetOwned, sourceOwned]) {
    try { await removeOwnedFile(owned, io); } catch (error) { cleanupErrors.push(error); }
  }
  if (probeCreated) {
    try { await io.rmdir(probeDirectory); } catch (error) { cleanupErrors.push(error); }
  }
  if (cleanupErrors.length) throw errorWithCode("ASSET_CLEANUP_ERROR", "Hard-link capability probe cleanup failed", new AggregateError(failure ? [failure, ...cleanupErrors] : cleanupErrors));
  if (failure) throw failure;
  return Object.freeze({ supported: true });
}

export class DeduplicatedAssetStore {
  static async create(options) {
    const store = new DeduplicatedAssetStore(options);
    await store.initialize();
    return store;
  }

  constructor(options = {}) {
    if (!options.assetRoot || !options.exportRoot) throw new TypeError("assetRoot and exportRoot are required");
    if (typeof options.assertDestination !== "function" || typeof options.publishManifest !== "function") throw new TypeError("assertDestination and publishManifest callbacks are required");
    this.assetRoot = path.resolve(options.assetRoot);
    this.exportRoot = path.resolve(options.exportRoot);
    if (!samePath(this.assetRoot, path.join(this.exportRoot, "assets"))) throw new TypeError("assetRoot must be the exportRoot assets directory");
    this.assertDestination = options.assertDestination;
    this.publishManifest = options.publishManifest;
    this.io = { ...defaultIo(), ...options.io };
    this.abortSignal = options.abortSignal;
    this.entries = new Map();
    this.pending = new Map();
    this.ownedAssets = [];
    this.usageSequence = 0;
    this.manifestUsageSequence = 0;
    this.maxWriteBlockBytes = 0;
    this.sealed = false;
  }

  async initialize() {
    this.checkAbort();
    this.rootSnapshot = await inspectDirectory(this.assetRoot, this.io);
    this.stagingDirectory = path.join(this.assetRoot, `.staging-${randomUUID()}`);
    await this.io.mkdir(this.stagingDirectory);
    this.stagingSnapshot = await inspectDirectory(this.stagingDirectory, this.io);
  }

  async beginAttachment(info = {}) {
    this.checkAbort();
    if (this.sealed) throw errorWithCode("ASSET_RECORD_STATE_ERROR", "Cannot add attachments after the asset manifest was published");
    await verifyDirectory(this.rootSnapshot, this.io);
    await verifyDirectory(this.stagingSnapshot, this.io);
    const recordNumber = Number(info.recordNumber);
    if (!Number.isSafeInteger(recordNumber) || recordNumber <= 0) throw errorWithCode("ASSET_RECORD_STATE_ERROR", "Attachment record ordinal is invalid");
    const temporaryPath = path.join(this.stagingDirectory, `${recordNumber}-${randomUUID()}.partial`);
    let handle;
    let owned = null;
    try {
      handle = await this.io.open(temporaryPath, "wx");
      const opened = await handle.stat({ bigint: true });
      owned = { path: temporaryPath, identity: fileIdentity(opened) };
      if (!owned.identity || !opened.isFile()) throw errorWithCode("ASSET_PATH_UNSAFE", "Staged asset does not have reliable regular-file identity");
    } catch (error) {
      const cleanupErrors = [];
      await handle?.close().catch((cleanupError) => cleanupErrors.push(cleanupError));
      if (owned?.identity) await removeOwnedFile(owned, this.io).catch((cleanupError) => cleanupErrors.push(cleanupError));
      if (cleanupErrors.length) throw errorWithCode("ASSET_CLEANUP_ERROR", "Failed to clean a staged asset after initialization failed", new AggregateError([error, ...cleanupErrors]));
      throw error;
    }
    const state = {
      bytes: 0,
      declaredMime: info.sourceKind === "data_url" ? normalizeDeclaredMime(info.mediaType) : "",
      mediaType: String(info.mediaType || "").toLowerCase(),
      handle,
      hash: createHash("sha256"),
      header: Buffer.alloc(HEADER_BYTES),
      headerLength: 0,
      owned,
      recordNumber,
      sourceKind: String(info.sourceKind || ""),
      finished: false,
      ready: false,
    };
    const pending = this.pending.get(recordNumber) || [];
    pending.push(state);
    this.pending.set(recordNumber, pending);
    return Object.freeze({
      abort: async () => this.abortStage(state),
      finish: async (descriptor) => this.finishStage(state, descriptor),
      write: async (chunk) => this.writeStage(state, chunk),
    });
  }

  async writeStage(state, chunk) {
    this.checkAbort();
    if (state.finished || !state.handle) throw errorWithCode("ASSET_RECORD_STATE_ERROR", "Cannot write to a finished asset stage");
    if (!chunk || !Number.isSafeInteger(chunk.byteLength) || chunk.byteLength > MAX_WRITE_BLOCK_BYTES) throw errorWithCode("ASSET_WRITE_ERROR", `Decoded asset blocks must not exceed ${MAX_WRITE_BLOCK_BYTES} bytes`);
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (state.bytes > Number.MAX_SAFE_INTEGER - buffer.length) throw errorWithCode("ASSET_WRITE_ERROR", "Decoded asset size exceeds the supported exact integer range");
    state.hash.update(buffer);
    state.bytes += buffer.length;
    this.maxWriteBlockBytes = Math.max(this.maxWriteBlockBytes, buffer.length);
    if (state.headerLength < HEADER_BYTES) {
      const length = Math.min(HEADER_BYTES - state.headerLength, buffer.length);
      buffer.copy(state.header, state.headerLength, 0, length);
      state.headerLength += length;
    }
    try { await writeAll(state.handle, buffer); } catch (error) { throw errorWithCode("ASSET_WRITE_ERROR", "Failed while writing a staged asset", error); }
    this.checkAbort();
  }

  async finishStage(state, descriptor) {
    this.checkAbort();
    if (state.finished || !state.handle) throw errorWithCode("ASSET_RECORD_STATE_ERROR", "Asset stage was already finished");
    state.finished = true;
    await state.handle.sync();
    await state.handle.close();
    state.handle = null;
    const sha256 = state.hash.digest("hex");
    if (!isLowerHexSha256(descriptor?.sha256)
      || descriptor.sha256 !== sha256
      || descriptor.decodedBytes !== state.bytes
      || String(descriptor.mediaType || "").toLowerCase() !== state.mediaType
      || String(descriptor.sourceKind || "") !== state.sourceKind) {
      throw errorWithCode("ASSET_DESCRIPTOR_MISMATCH", "Streaming descriptor does not match the staged decoded asset");
    }
    state.sha256 = sha256;
    state.type = detectAssetType(state.header.subarray(0, state.headerLength), state.bytes);
    state.ready = true;
  }

  async abortStage(state) {
    const errors = [];
    if (state.handle) {
      try {
        await state.handle.close();
        state.handle = null;
      } catch (error) { errors.push(error); }
    }
    await removeOwnedFile(state.owned, this.io).catch((error) => errors.push(error));
    state.finished = true;
    if (errors.length) throw errorWithCode("ASSET_CLEANUP_ERROR", "Failed to close or remove a staged asset", new AggregateError(errors));
    const stages = this.pending.get(state.recordNumber);
    if (stages) {
      const index = stages.indexOf(state);
      if (index >= 0) stages.splice(index, 1);
      if (stages.length === 0) this.pending.delete(state.recordNumber);
    }
  }

  async abortRecord(recordNumber) {
    const stages = this.pending.get(recordNumber) || [];
    this.pending.delete(recordNumber);
    for (const stage of stages) await this.abortStage(stage);
  }

  async commitRecord(sessionId, recordNumber, descriptors, options = {}) {
    this.checkAbort();
    const stableSessionId = normalizeSessionReference(sessionId);
    if (!stableSessionId) throw errorWithCode("ASSET_RECORD_STATE_ERROR", "Asset usage requires a safe stable session ID");
    if (!Array.isArray(descriptors)) throw errorWithCode("ASSET_RECORD_STATE_ERROR", "Committed record attachments must be an array");
    const stages = this.pending.get(recordNumber) || [];
    this.pending.delete(recordNumber);
    if (stages.length !== descriptors.length || stages.some((stage) => !stage.ready)) {
      const mismatch = errorWithCode("ASSET_RECORD_STATE_ERROR", "Committed record attachment stages do not match its descriptors");
      await this.cleanupFailedRecordStages(recordNumber, stages, mismatch);
      throw mismatch;
    }
    const selected = options.storedAttachmentOrdinals === undefined
      ? null
      : new Set(options.storedAttachmentOrdinals);
    if (selected && [...selected].some((ordinal) => !Number.isSafeInteger(ordinal) || ordinal <= 0 || ordinal > stages.length)) {
      const mismatch = errorWithCode("ASSET_RECORD_STATE_ERROR", "Selected attachment ordinals do not match the committed record");
      await this.cleanupFailedRecordStages(recordNumber, stages, mismatch);
      throw mismatch;
    }
    try {
      for (let index = 0; index < stages.length; index += 1) {
        this.checkAbort();
        const attachmentOrdinal = index + 1;
        if (selected && !selected.has(attachmentOrdinal)) {
          await this.abortStage(stages[index]);
          continue;
        }
        await this.commitStage(stages[index], {
          attachmentOrdinal,
          recordNumber,
          sessionId: stableSessionId,
        });
      }
    } catch (error) {
      await this.cleanupFailedRecordStages(recordNumber, stages, error);
      throw error;
    }
  }

  async cleanupFailedRecordStages(recordNumber, stages, primaryError) {
    const cleanupErrors = [];
    const failedStages = [];
    for (const stage of stages) {
      try { await this.abortStage(stage); } catch (error) {
        cleanupErrors.push(error);
        failedStages.push(stage);
      }
    }
    if (failedStages.length) this.pending.set(recordNumber, failedStages);
    if (cleanupErrors.length) throw errorWithCode("ASSET_CLEANUP_ERROR", "Failed to clean all asset stages after a record error", new AggregateError([primaryError, ...cleanupErrors]));
  }

  async commitStage(stage, usage) {
    this.checkAbort();
    const expected = {
      bytes: stage.bytes,
      extension: stage.type.extension,
      mimeType: stage.type.mimeType,
      renderable: stage.type.renderable,
      sha256: stage.sha256,
    };
    let entry = this.entries.get(stage.sha256);
    if (entry) {
      await verifyDirectory(this.rootSnapshot, this.io);
      await verifyAssetFile(path.join(this.exportRoot, ...entry.path.split("/")), expected, this.io);
      await verifyDirectory(this.rootSnapshot, this.io);
      await this.abortStage(stage);
    } else {
      const relativePath = `assets/${stage.sha256}.${stage.type.extension}`;
      const destination = path.join(this.exportRoot, ...relativePath.split("/"));
      const destinationBefore = await this.assertDestination(destination, relativePath);
      await verifyDirectory(this.rootSnapshot, this.io);
      let publishedByRun = false;
      try {
        await this.io.link(stage.owned.path, destination);
        publishedByRun = true;
      } catch (error) {
        if (error?.code !== "EEXIST") throw errorWithCode("ASSET_PUBLISH_ERROR", "Failed to publish an asset with an exclusive hard link", error);
        if (!destinationBefore?.exists) throw errorWithCode("ASSET_PUBLISH_ERROR", "An asset target appeared concurrently after destination validation", error);
      }
      if (publishedByRun) {
        const [stageStat, destinationStat] = await Promise.all([this.io.lstat(stage.owned.path, { bigint: true }), this.io.lstat(destination, { bigint: true })]);
        const stageIdentity = fileIdentity(stageStat);
        const destinationIdentity = fileIdentity(destinationStat);
        if (!stageStat.isFile() || !destinationStat.isFile() || !stageIdentity || stageIdentity !== destinationIdentity || stageIdentity !== stage.owned.identity) {
          throw errorWithCode("ASSET_PUBLISH_ERROR", "Published asset identity does not match its staged file");
        }
        this.ownedAssets.push({ path: destination, identity: destinationIdentity });
        if (destinationBefore?.exists) throw errorWithCode("ASSET_PUBLISH_ERROR", "A previously validated asset target disappeared before publication");
      }
      await verifyDirectory(this.rootSnapshot, this.io);
      const verified = await verifyAssetFile(destination, expected, this.io);
      if (!publishedByRun && destinationBefore?.identity && destinationBefore.identity !== verified.identity) throw errorWithCode("ASSET_EXISTING_MISMATCH", "Existing asset identity changed before reuse");
      await verifyDirectory(this.rootSnapshot, this.io);
      await this.abortStage(stage);
      entry = {
        bytes: stage.bytes,
        extension: stage.type.extension,
        mime_type: stage.type.mimeType,
        path: relativePath,
        renderable: stage.type.renderable,
        sha256: stage.sha256,
        uses: [],
      };
      this.entries.set(stage.sha256, entry);
    }
    const use = {
      attachment_ordinal: usage.attachmentOrdinal,
      record_ordinal: usage.recordNumber,
      session_id: usage.sessionId,
      sequence: this.usageSequence++,
      ...defaultUsageMetadata(usage.recordNumber, usage.attachmentOrdinal),
    };
    if (!Number.isSafeInteger(use.sequence)) throw errorWithCode("ASSET_MANIFEST_ERROR", "Asset usage count exceeds the supported exact integer range");
    if (stage.declaredMime) {
      use.declared_mime = stage.declaredMime;
      use.mime_mismatch = stage.declaredMime !== entry.mime_type;
    }
    entry.uses.push(use);
  }

  applyReadingAnnotations(sessionId, annotations) {
    this.checkAbort();
    const stableSessionId = normalizeSessionReference(sessionId);
    if (!stableSessionId) throw errorWithCode("ASSET_MANIFEST_ERROR", "Reading annotations require a safe stable session ID");
    if (!Array.isArray(annotations)) throw errorWithCode("ASSET_MANIFEST_ERROR", "Reading annotations must be an array");
    const existing = new Map();
    for (const entry of this.entries.values()) {
      for (const use of entry.uses) {
        if (use.session_id === stableSessionId) existing.set(`${use.record_ordinal}:${use.attachment_ordinal}`, { entry, use });
      }
    }
    for (const annotation of annotations) {
      const recordNumber = annotation?.record_ordinal;
      const attachmentOrdinal = annotation?.attachment_ordinal;
      if (!Number.isSafeInteger(recordNumber) || recordNumber <= 0 || !Number.isSafeInteger(attachmentOrdinal) || attachmentOrdinal <= 0) {
        throw errorWithCode("ASSET_MANIFEST_ERROR", "Reading annotation ordinals are invalid");
      }
      const descriptor = annotation?.descriptor;
      const entry = this.entries.get(String(descriptor?.sha256 || ""));
      if (!entry) continue;
      const key = `${recordNumber}:${attachmentOrdinal}`;
      let use = existing.get(key)?.use;
      if (!use) {
        use = {
          attachment_ordinal: attachmentOrdinal,
          record_ordinal: recordNumber,
          session_id: stableSessionId,
          sequence: this.usageSequence++,
        };
        const declaredMime = descriptor?.sourceKind === "data_url" ? normalizeDeclaredMime(descriptor.mediaType) : "";
        if (declaredMime) {
          use.declared_mime = declaredMime;
          use.mime_mismatch = declaredMime !== entry.mime_type;
        }
        entry.uses.push(use);
        existing.set(key, { entry, use });
      } else if (existing.get(key).entry !== entry) {
        throw errorWithCode("ASSET_MANIFEST_ERROR", "Reading annotation asset identity conflicts with the committed use");
      }
      const manifestSequence = this.manifestUsageSequence++;
      if (!Number.isSafeInteger(manifestSequence)) throw errorWithCode("ASSET_MANIFEST_ERROR", "Asset reading-usage count exceeds the supported exact integer range");
      Object.assign(use, normalizedUsageMetadata(annotation, recordNumber, attachmentOrdinal), { manifest_sequence: manifestSequence });
    }
  }

  assetForDescriptor(descriptor) {
    return this.entries.get(String(descriptor?.sha256 || "")) || null;
  }

  referencesForSession(sessionId) {
    const output = [];
    for (const entry of this.entries.values()) {
      for (const use of entry.uses) {
        if (use.session_id === sessionId) output.push({ attachment_ordinal: use.attachment_ordinal, path: entry.path, record_ordinal: use.record_ordinal, renderable: entry.renderable, sequence: use.manifest_sequence ?? use.sequence });
      }
    }
    return output.sort((left, right) => left.sequence - right.sequence).map(({ sequence: _sequence, ...value }) => value);
  }

  readingReferencesForSession(sessionId) {
    const output = [];
    for (const entry of this.entries.values()) {
      for (const use of entry.uses) {
        if (use.session_id !== sessionId || !["VISIBLE", "ADDITIONAL_STORED_CONTEXT"].includes(use.reading_disposition)) continue;
        output.push({
          attachment_ordinal: use.attachment_ordinal,
          path: entry.path,
          reading_disposition: use.reading_disposition,
          record_ordinal: use.record_ordinal,
          renderable: entry.renderable,
          sequence: use.manifest_sequence ?? use.sequence,
        });
      }
    }
    return output.sort((left, right) => left.sequence - right.sequence).map(({ sequence: _sequence, ...value }) => value);
  }

  manifestObject() {
    const assets = [...this.entries.values()].sort((left, right) => left.sha256 < right.sha256 ? -1 : left.sha256 > right.sha256 ? 1 : 0).map((entry) => ({
      sha256: entry.sha256,
      path: entry.path,
      mime_type: entry.mime_type,
      extension: entry.extension,
      bytes: entry.bytes,
      renderable: entry.renderable,
      uses: [...entry.uses].sort((left, right) => (left.manifest_sequence ?? left.sequence) - (right.manifest_sequence ?? right.sequence)).map(({ manifest_sequence: _manifestSequence, sequence: _sequence, ...use }) => use),
    }));
    return { schema_version: ASSET_MANIFEST_SCHEMA_VERSION, hash_algorithm: "sha256", assets };
  }

  summary() {
    const assets = [...this.entries.values()];
    const occurrences = assets.reduce((sum, entry) => sum + entry.uses.length, 0);
    const uniqueBytes = assets.reduce((sum, entry) => sum + entry.bytes, 0);
    const occurrenceBytes = assets.reduce((sum, entry) => sum + entry.bytes * entry.uses.length, 0);
    if (![occurrences, uniqueBytes, occurrenceBytes].every(Number.isSafeInteger)) throw errorWithCode("ASSET_MANIFEST_ERROR", "Asset summary exceeds the supported exact integer range");
    return Object.freeze({
      assetOccurrences: occurrences,
      deduplicatedBytesSaved: occurrenceBytes - uniqueBytes,
      maxWriteBlockBytes: this.maxWriteBlockBytes,
      uniqueAssetBytes: uniqueBytes,
      uniqueAssets: assets.length,
    });
  }

  async publish() {
    this.checkAbort();
    if (this.sealed) throw errorWithCode("ASSET_MANIFEST_ERROR", "Asset manifest was already published");
    if ([...this.pending.values()].some((stages) => stages.length)) throw errorWithCode("ASSET_MANIFEST_ERROR", "Cannot publish an asset manifest with pending records");
    const summary = this.summary();
    await this.verifyPublishedAssets();
    this.checkAbort();
    await this.cleanupStagingDirectory();
    this.checkAbort();
    let content;
    try {
      content = `${JSON.stringify(this.manifestObject(), null, 2)}\n`;
      this.checkAbort();
      await this.publishManifest(content);
      this.checkAbort();
    } catch (error) {
      if (error?.code === "EXPORT_CANCELLED") throw error;
      throw errorWithCode("ASSET_MANIFEST_ERROR", "Failed to generate or publish the complete asset manifest", error);
    }
    this.sealed = true;
    return { content, summary };
  }

  async verifyPublishedAssets() {
    this.checkAbort();
    await verifyDirectory(this.rootSnapshot, this.io);
    for (const entry of [...this.entries.values()].sort((left, right) => left.sha256 < right.sha256 ? -1 : left.sha256 > right.sha256 ? 1 : 0)) {
      this.checkAbort();
      await verifyAssetFile(path.join(this.exportRoot, ...entry.path.split("/")), {
        bytes: entry.bytes,
        extension: entry.extension,
        mimeType: entry.mime_type,
        renderable: entry.renderable,
        sha256: entry.sha256,
      }, this.io);
    }
    await verifyDirectory(this.rootSnapshot, this.io);
    return true;
  }

  async cleanupStagingDirectory() {
    this.checkAbort();
    if (!this.stagingSnapshot) return;
    const current = await verifyDirectory(this.stagingSnapshot, this.io);
    const entries = await fsp.readdir(current.absolute);
    if (entries.length) throw errorWithCode("ASSET_CLEANUP_ERROR", "Asset staging directory is not empty");
    await verifyDirectory(this.stagingSnapshot, this.io);
    await this.io.rmdir(current.absolute);
    this.stagingSnapshot = null;
  }

  async abort() {
    if (this.sealed) return;
    const errors = [];
    for (const stages of this.pending.values()) for (const stage of [...stages]) await this.abortStage(stage).catch((error) => errors.push(error));
    this.pending.clear();
    for (const owned of [...this.ownedAssets].reverse()) await removeOwnedFile(owned, this.io).catch((error) => errors.push(error));
    this.ownedAssets = [];
    if (this.stagingSnapshot) {
      try {
        const current = await verifyDirectory(this.stagingSnapshot, this.io);
        const children = await fsp.readdir(current.absolute);
        if (children.length === 0) {
          await verifyDirectory(this.stagingSnapshot, this.io);
          await this.io.rmdir(current.absolute);
        }
      } catch (error) { errors.push(error); }
      this.stagingSnapshot = null;
    }
    if (errors.length) throw errorWithCode("ASSET_CLEANUP_ERROR", "Asset-store cleanup failed", new AggregateError(errors));
  }

  checkAbort() {
    throwIfAborted(this.abortSignal, "asset processing");
  }
}
