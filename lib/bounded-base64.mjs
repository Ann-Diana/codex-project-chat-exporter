import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const DEFAULT_MAX_ENCODED_BLOCK_CHARS = 4096;

export class BoundedBase64Error extends Error {
  constructor(code, message, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "BoundedBase64Error";
    this.code = code;
  }
}

function isBase64Code(code) {
  return (code >= 0x41 && code <= 0x5a)
    || (code >= 0x61 && code <= 0x7a)
    || (code >= 0x30 && code <= 0x39)
    || code === 0x2b
    || code === 0x2f;
}

function validateCharacters(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (!isBase64Code(code) && code !== 0x3d) throw new BoundedBase64Error("BASE64_INVALID_CHARACTER", `Invalid Base64 character at chunk offset ${index}`);
  }
}

function decodeFinalBlock(value) {
  if (value.length === 0) return Buffer.alloc(0);
  const padding = value.indexOf("=");
  if (padding >= 0) {
    if (value.length !== 4 || padding < 2 || (padding === 2 && value[3] !== "=") || (padding === 3 && value.slice(0, 3).includes("="))) {
      throw new BoundedBase64Error("BASE64_INVALID_PADDING", "Invalid Base64 padding");
    }
    return Buffer.from(value, "base64");
  }
  if (value.length === 1) throw new BoundedBase64Error("BASE64_INVALID_LENGTH", "Base64 input has an invalid final length");
  if (value.length > 4) throw new BoundedBase64Error("BASE64_INVALID_LENGTH", "Base64 final block is too large");
  return Buffer.from(value.padEnd(4, "="), "base64");
}

export async function decodeBase64Chunks(chunks, onDecodedChunk, options = {}) {
  if (!chunks || typeof chunks[Symbol.asyncIterator] !== "function") throw new TypeError("chunks must be an AsyncIterable of strings");
  if (typeof onDecodedChunk !== "function") throw new TypeError("onDecodedChunk must be a function");
  const maxEncodedBlockChars = options.maxEncodedBlockChars ?? DEFAULT_MAX_ENCODED_BLOCK_CHARS;
  if (!Number.isSafeInteger(maxEncodedBlockChars) || maxEncodedBlockChars < 4) throw new TypeError("maxEncodedBlockChars must be an integer of at least 4");
  const alignedLimit = maxEncodedBlockChars - (maxEncodedBlockChars % 4);
  const hash = createHash("sha256");
  let remainder = "";
  let paddedTail = "";
  let decodedBytes = 0;
  let maxDecodedBlockBytes = 0;

  async function consumeDecoded(decoded) {
    if (!decoded.length) return;
    hash.update(decoded);
    decodedBytes += decoded.length;
    maxDecodedBlockBytes = Math.max(maxDecodedBlockBytes, decoded.length);
    try {
      await onDecodedChunk(decoded);
    } catch (error) {
      throw new BoundedBase64Error("BASE64_WRITE_ERROR", "Base64 consumer failed while writing a decoded block", error);
    }
  }

  async function emit(encoded) {
    if (!encoded) return;
    await consumeDecoded(Buffer.from(encoded, "base64"));
  }

  async function emitBlocks(encoded) {
    for (let offset = 0; offset < encoded.length; offset += alignedLimit) await emit(encoded.slice(offset, offset + alignedLimit));
  }

  try {
    for await (const value of chunks) {
      if (typeof value !== "string") throw new BoundedBase64Error("BASE64_INVALID_CHUNK", "Base64 chunks must be strings");
      for (let offset = 0; offset < value.length; offset += alignedLimit) {
        const part = value.slice(offset, offset + alignedLimit);
        validateCharacters(part);
        if (paddedTail) {
          if ([...part].some((character) => character !== "=") || paddedTail.length + part.length > 4) {
            throw new BoundedBase64Error("BASE64_TRAILING_DATA", "Base64 data appears after padding");
          }
          paddedTail += part;
          continue;
        }
        const combined = remainder + part;
        const padding = combined.indexOf("=");
        if (padding >= 0) {
          const finalStart = padding - (padding % 4);
          await emitBlocks(combined.slice(0, finalStart));
          paddedTail = combined.slice(finalStart);
          remainder = "";
          if (paddedTail.length > 4) throw new BoundedBase64Error("BASE64_TRAILING_DATA", "Base64 data appears after padding");
          continue;
        }
        if (combined.length >= alignedLimit) {
          const processLength = combined.length - (combined.length % 4);
          await emitBlocks(combined.slice(0, processLength));
          remainder = combined.slice(processLength);
        } else {
          remainder = combined;
        }
      }
    }
    if (!paddedTail && remainder.length > 3) {
      const processLength = remainder.length - (remainder.length % 4);
      await emitBlocks(remainder.slice(0, processLength));
      remainder = remainder.slice(processLength);
    }
    const finalDecoded = decodeFinalBlock(paddedTail || remainder);
    await consumeDecoded(finalDecoded);
    return { decodedBytes, maxDecodedBlockBytes, sha256: hash.digest("hex") };
  } catch (error) {
    if (error instanceof BoundedBase64Error) throw error;
    throw new BoundedBase64Error("BASE64_INPUT_ERROR", "Base64 input stream failed", error);
  }
}

async function writeAll(handle, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, null);
    if (bytesWritten <= 0) throw new Error("File write made no progress");
    offset += bytesWritten;
  }
}

export async function writeBase64ChunksToFile(chunks, destination, options = {}) {
  const absoluteDestination = path.resolve(destination);
  const directory = path.dirname(absoluteDestination);
  const temporary = path.join(directory, `.${path.basename(absoluteDestination)}.${randomUUID()}.tmp`);
  let handle;
  let result;
  let failure;
  try {
    handle = await fs.open(temporary, "wx");
    result = await decodeBase64Chunks(chunks, (buffer) => writeAll(handle, buffer), options);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.link(temporary, absoluteDestination);
  } catch (error) {
    failure = error instanceof BoundedBase64Error
      ? error
      : new BoundedBase64Error("BASE64_FILE_ERROR", `Failed to publish decoded Base64 file: ${absoluteDestination}`, error);
  }
  const cleanupErrors = [];
  if (handle) {
    try { await handle.close(); } catch (error) { cleanupErrors.push(error); }
  }
  try {
    await fs.unlink(temporary);
  } catch (error) {
    if (error?.code !== "ENOENT") cleanupErrors.push(error);
  }
  if (cleanupErrors.length) {
    const causes = failure ? [failure, ...cleanupErrors] : cleanupErrors;
    throw new BoundedBase64Error("BASE64_CLEANUP_ERROR", `Failed to clean the temporary Base64 file: ${temporary}`, new AggregateError(causes));
  }
  if (failure) throw failure;
  return { ...result, outputPath: absoluteDestination };
}
