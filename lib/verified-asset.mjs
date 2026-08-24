import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

export class VerifiedAssetError extends Error {
  constructor(code, message, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "VerifiedAssetError";
    this.code = code;
  }
}

export async function resolveVerifiedLocalAsset(assetStore, exportRoot, attachment, options = {}) {
  const entry = assetStore?.assetForDescriptor?.(attachment);
  if (!entry) throw new VerifiedAssetError("ASSET_MISSING", `The local asset for record ${attachment.origin.recordOrdinal} is missing`);
  const absolute = path.resolve(exportRoot, ...entry.path.split("/"));
  const assetRoot = path.resolve(exportRoot, "assets");
  if (!isPathInside(absolute, assetRoot)) throw new VerifiedAssetError("ASSET_PATH_UNSAFE", "The resolved asset path leaves the export asset directory");
  let readResult;
  try {
    const includeData = typeof options.includeData === "function" ? options.includeData(entry) : options.includeData !== false;
    readResult = await readStableRegularFile(absolute, assetRoot, includeData);
  } catch (error) {
    if (error instanceof VerifiedAssetError) throw error;
    throw new VerifiedAssetError("ASSET_MISSING", `The local asset cannot be read: ${entry.path}`, error);
  }
  if (readResult.sha256 !== entry.sha256 || readResult.bytes !== entry.bytes) {
    throw new VerifiedAssetError("ASSET_MISMATCH", `The local asset changed before document packaging: ${entry.path}`);
  }
  return Object.freeze({
    data: readResult.data,
    extension: entry.extension,
    mediaType: entry.mime_type,
    path: entry.path,
    renderable: entry.renderable,
    sha256: entry.sha256,
  });
}

async function readStableRegularFile(absolute, assetRoot, includeData) {
  const canonicalRoot = await fsp.realpath(assetRoot);
  if (pathKey(canonicalRoot) !== pathKey(assetRoot)) throw new VerifiedAssetError("ASSET_PATH_UNSAFE", "The asset directory resolves through a symbolic link or junction");
  const before = await fsp.lstat(absolute, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile()) throw new VerifiedAssetError("ASSET_PATH_UNSAFE", "The document asset must be a regular file, not a symbolic link");
  const beforeIdentity = reliableIdentity(before);
  if (!beforeIdentity) throw new VerifiedAssetError("ASSET_PATH_UNSAFE", "Reliable document asset identity is unavailable");
  const canonicalFile = await fsp.realpath(absolute);
  if (pathKey(canonicalFile) !== pathKey(absolute)) throw new VerifiedAssetError("ASSET_PATH_UNSAFE", "The document asset resolves through a symbolic link or junction");
  const handle = await fsp.open(absolute, "r");
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || reliableIdentity(opened) !== beforeIdentity) throw new VerifiedAssetError("ASSET_PATH_UNSAFE", "The document asset changed before it was opened");
    let data;
    let bytes;
    let sha256;
    if (includeData) {
      data = await handle.readFile();
      bytes = data.length;
      sha256 = createHash("sha256").update(data).digest("hex");
    } else {
      const hash = createHash("sha256");
      const chunk = Buffer.allocUnsafe(64 * 1024);
      bytes = 0;
      while (true) {
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
        if (bytesRead === 0) break;
        hash.update(chunk.subarray(0, bytesRead));
        bytes += bytesRead;
      }
      sha256 = hash.digest("hex");
    }
    const after = await handle.stat({ bigint: true });
    const pathAfter = await fsp.lstat(absolute, { bigint: true });
    if (reliableIdentity(after) !== beforeIdentity || pathAfter.isSymbolicLink() || !pathAfter.isFile() || reliableIdentity(pathAfter) !== beforeIdentity) {
      throw new VerifiedAssetError("ASSET_PATH_UNSAFE", "The document asset changed while it was read");
    }
    return { bytes, data, sha256 };
  } finally {
    await handle.close();
  }
}

function reliableIdentity(stat) {
  if (typeof stat?.dev === "bigint" && typeof stat?.ino === "bigint") {
    if (stat.dev < 0n || stat.ino <= 0n) return null;
    return `${stat.dev}:${stat.ino}`;
  }
  if (!Number.isSafeInteger(stat?.dev) || !Number.isSafeInteger(stat?.ino) || stat.dev < 0 || stat.ino <= 0) return null;
  return `${stat.dev}:${stat.ino}`;
}

function pathKey(candidate) {
  const resolved = path.resolve(candidate);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isPathInside(candidate, root) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}
