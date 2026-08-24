#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MIB = 1024 * 1024;
const DEFAULT_SIZE_MIB = 16;
const prefix = '{"timestamp":"2026-01-01T00:00:00.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"large-line diagnostic"},{"type":"input_image","image_url":"data:image/png;base64,';
const suffix = '"}],"nested":{"array":[{"escaped":"quote \\\" slash \\\\ unicode π"}]}}}\n';

function parseSize(argv) {
  const index = argv.indexOf("--size-mib");
  if (index < 0) return DEFAULT_SIZE_MIB;
  const value = Number(argv[index + 1]);
  if (!Number.isFinite(value) || value <= 0) throw new Error("--size-mib must be a positive number");
  return value;
}

async function writeLargeJsonl(file, requestedMiB) {
  const targetBytes = Math.floor(requestedMiB * MIB);
  const fixedBytes = Buffer.byteLength(prefix) + Buffer.byteLength(suffix);
  const payloadCharacters = Math.floor((targetBytes - fixedBytes) / 4) * 4;
  if (payloadCharacters < 12) throw new Error("Requested input is too small for the diagnostic record");
  const expectedDecodedBytes = (payloadCharacters / 4) * 3;
  let decodedBytesRemaining = expectedDecodedBytes;
  let firstChunk = true;
  const decodedHash = createHash("sha256");
  const handle = await fs.open(file, "wx");
  try {
    await handle.write(prefix, null, "utf8");
    while (decodedBytesRemaining > 0) {
      const size = Math.min(decodedBytesRemaining, 48 * 1024);
      const chunk = Buffer.alloc(size, 0x41);
      if (firstChunk) {
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(chunk);
        firstChunk = false;
      }
      decodedHash.update(chunk);
      await handle.write(chunk.toString("base64"), null, "ascii");
      decodedBytesRemaining -= size;
    }
    await handle.write(suffix, null, "utf8");
  } finally {
    await handle.close();
  }
  return { decodedSha256: decodedHash.digest("hex"), expectedDecodedBytes, inputBytes: (await fs.stat(file)).size };
}

async function sha256File(file) {
  const hash = createHash("sha256");
  for await (const chunk of fsSync.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function main() {
  const requestedMiB = parseSize(process.argv.slice(2));
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "codex-large-line-")));
  try {
    const input = path.join(temp, "large-line.jsonl");
    const { decodedSha256, expectedDecodedBytes, inputBytes } = await writeLargeJsonl(input, requestedMiB);
    const sourceSha256Before = await sha256File(input);
    const worker = path.join(path.dirname(fileURLToPath(import.meta.url)), "large-jsonl-line-worker.mjs");
    let stdout = "";
    let stderr = "";
    let exitStatus = 0;
    try {
      const result = await execFileAsync(process.execPath, [worker, input], { encoding: "utf8", maxBuffer: MIB });
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (error) {
      stdout = error.stdout || "";
      stderr = error.stderr || error.message || "";
      exitStatus = Number.isInteger(error.code) ? error.code : 1;
    }
    const workerResult = stdout.trim() ? JSON.parse(stdout) : {};
    const sourceSha256After = await sha256File(input);
    if (exitStatus === 0 && workerResult.sha256 !== decodedSha256) {
      exitStatus = 1;
      stderr += `${stderr ? "\n" : ""}Decoded SHA-256 mismatch`;
    }
    if (exitStatus === 0 && workerResult.written_sha256 !== decodedSha256) {
      exitStatus = 1;
      stderr += `${stderr ? "\n" : ""}Written attachment SHA-256 mismatch`;
    }
    if (exitStatus === 0 && workerResult.records !== 1) {
      exitStatus = 1;
      stderr += `${stderr ? "\n" : ""}Expected exactly one completed JSONL record`;
    }
    if (exitStatus === 0 && workerResult.decoded_bytes !== expectedDecodedBytes) {
      exitStatus = 1;
      stderr += `${stderr ? "\n" : ""}Decoded byte count mismatch`;
    }
    if (exitStatus === 0 && (!Number.isSafeInteger(workerResult.max_decoded_block_bytes)
      || !Number.isSafeInteger(workerResult.max_write_block_bytes)
      || workerResult.max_decoded_block_bytes > 3072
      || workerResult.max_write_block_bytes > 3072)) {
      exitStatus = 1;
      stderr += `${stderr ? "\n" : ""}Decoded or write block exceeds 3072 bytes`;
    }
    if (exitStatus === 0 && workerResult.peak_rss_bytes > 192 * MIB) {
      exitStatus = 1;
      stderr += `${stderr ? "\n" : ""}Peak RSS exceeds 192 MiB`;
    }
    if (exitStatus === 0 && sourceSha256After !== sourceSha256Before) {
      exitStatus = 1;
      stderr += `${stderr ? "\n" : ""}Source JSONL changed during the diagnostic`;
    }
    console.log(JSON.stringify({
      input_bytes: inputBytes,
      input_mib: Math.round((inputBytes / MIB) * 1000) / 1000,
      runtime_ms: workerResult.runtime_ms ?? null,
      peak_rss_bytes: workerResult.peak_rss_bytes ?? null,
      peak_heap_bytes: workerResult.peak_heap_bytes ?? null,
      records: workerResult.records ?? 0,
      decoded_bytes: workerResult.decoded_bytes ?? null,
      expected_decoded_bytes: expectedDecodedBytes,
      decoded_sha256: workerResult.sha256 ?? null,
      written_sha256: workerResult.written_sha256 ?? null,
      expected_decoded_sha256: decodedSha256,
      max_decoded_block_bytes: workerResult.max_decoded_block_bytes ?? null,
      max_write_block_bytes: workerResult.max_write_block_bytes ?? null,
      source_sha256_before: sourceSha256Before,
      source_sha256_after: sourceSha256After,
      source_byte_identical: sourceSha256After === sourceSha256Before,
      peak_rss_limit_mib: 192,
      exit_status: exitStatus,
      stderr: stderr.trim(),
    }, null, 2));
    if (exitStatus !== 0) process.exitCode = exitStatus;
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
