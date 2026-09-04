import fs from "node:fs";
import { Readable } from "node:stream";
import zlib from "node:zlib";

const ZSTD_SUFFIX = ".jsonl.zst";

export class RolloutSourceError extends Error {
  constructor(code, message, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "RolloutSourceError";
    this.code = code;
  }
}

export function isCompressedRolloutPath(file) {
  return String(file || "").toLowerCase().endsWith(ZSTD_SUFFIX);
}

export function createRolloutReadStream(file, options = {}) {
  const input = fs.createReadStream(file, { highWaterMark: options.highWaterMark ?? 64 * 1024, signal: options.signal });
  if (!isCompressedRolloutPath(file)) return input;
  if (typeof zlib.createZstdDecompress !== "function") {
    input.destroy();
    throw new RolloutSourceError(
      "COMPRESSED_ROLLOUT_UNSUPPORTED",
      "Compressed Codex rollouts require Node.js 22.15.0 or newer",
    );
  }
  let decoder;
  try {
    decoder = zlib.createZstdDecompress({ rejectGarbageAfterEnd: true });
  } catch (error) {
    input.destroy();
    throw new RolloutSourceError("COMPRESSED_ROLLOUT_UNSUPPORTED", "The current Node.js runtime cannot open compressed Codex rollouts", error);
  }
  input.on("error", (error) => decoder.destroy(error));
  decoder.on("close", () => input.destroy());
  return input.pipe(decoder);
}

export function createRolloutPrefixStream(file, endByteOffset, options = {}) {
  if (!Number.isSafeInteger(endByteOffset) || endByteOffset <= 0) {
    throw new RolloutSourceError("HISTORY_INVALID_BOUNDARY", "A history prefix byte offset must be a positive safe integer");
  }
  const source = isCompressedRolloutPath(file)
    ? createRolloutReadStream(file, options)
    : fs.createReadStream(file, { highWaterMark: options.highWaterMark ?? 64 * 1024, signal: options.signal, start: 0, end: endByteOffset - 1 });
  return Readable.from((async function* () {
    let remaining = endByteOffset;
    try {
      for await (const chunk of source) {
        if (remaining <= 0) break;
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const take = Math.min(bytes.length, remaining);
        if (take) yield bytes.subarray(0, take);
        remaining -= take;
        if (remaining === 0) break;
      }
      if (remaining !== 0) {
        throw new RolloutSourceError("HISTORY_BYTE_OFFSET_OUT_OF_RANGE", "A history prefix byte offset exceeds the logical rollout length");
      }
    } finally {
      source.destroy();
    }
  })(), { objectMode: false });
}
