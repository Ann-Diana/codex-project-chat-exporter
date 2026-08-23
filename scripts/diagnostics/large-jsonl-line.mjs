#!/usr/bin/env node
import { execFile } from "node:child_process";
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
  let decodedBytesRemaining = (payloadCharacters / 4) * 3;
  let firstChunk = true;
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
      await handle.write(chunk.toString("base64"), null, "ascii");
      decodedBytesRemaining -= size;
    }
    await handle.write(suffix, null, "utf8");
  } finally {
    await handle.close();
  }
  return (await fs.stat(file)).size;
}

async function main() {
  const requestedMiB = parseSize(process.argv.slice(2));
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "codex-large-line-")));
  try {
    const input = path.join(temp, "large-line.jsonl");
    const inputBytes = await writeLargeJsonl(input, requestedMiB);
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
    console.log(JSON.stringify({
      input_bytes: inputBytes,
      input_mib: Math.round((inputBytes / MIB) * 1000) / 1000,
      runtime_ms: workerResult.runtime_ms ?? null,
      peak_rss_bytes: workerResult.peak_rss_bytes ?? null,
      peak_heap_bytes: workerResult.peak_heap_bytes ?? null,
      records: workerResult.records ?? 0,
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
