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
const SESSION_ID = "dddddddd-dddd-7ddd-8ddd-dddddddddddd";
const PNG_HEADER = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00,
]);

function parseSize(argv) {
  const index = argv.indexOf("--size-mib");
  if (index < 0) return DEFAULT_SIZE_MIB;
  const value = Number(argv[index + 1]);
  if (!Number.isFinite(value) || value <= 0) throw new Error("--size-mib must be a positive number");
  return value;
}

async function writeLargeSession(file, requestedMiB) {
  const metadata = `${JSON.stringify({ type: "session_meta", timestamp: "2026-08-24T10:00:00.000Z", payload: { id: SESSION_ID, cwd: "C:\\Projects\\docx-large", timestamp: "2026-08-24T10:00:00.000Z", source: "vscode", thread_source: "user" } })}\n`;
  const prefix = '{"timestamp":"2026-08-24T10:00:01.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"large DOCX diagnostic"},{"type":"input_image","image_url":"data:image/png;base64,';
  const suffix = '"}]}}\n';
  const targetBytes = Math.floor(requestedMiB * MIB);
  const fixedBytes = Buffer.byteLength(metadata) + Buffer.byteLength(prefix) + Buffer.byteLength(suffix);
  const payloadCharacters = Math.floor((targetBytes - fixedBytes) / 4) * 4;
  if (payloadCharacters < 44) throw new Error("Requested input is too small");
  const decodedBytes = payloadCharacters / 4 * 3;
  let remaining = decodedBytes;
  let first = true;
  const handle = await fs.open(file, "wx");
  try {
    await handle.write(metadata, null, "utf8");
    await handle.write(prefix, null, "utf8");
    while (remaining > 0) {
      const size = Math.min(remaining, 48 * 1024);
      const chunk = Buffer.alloc(size, 0x41);
      if (first) { PNG_HEADER.copy(chunk); first = false; }
      await handle.write(chunk.toString("base64"), null, "ascii");
      remaining -= size;
    }
    await handle.write(suffix, null, "utf8");
  } finally {
    await handle.close();
  }
  return { decodedBytes, inputBytes: (await fs.stat(file)).size };
}

async function sha256File(file) {
  const hash = createHash("sha256");
  for await (const chunk of fsSync.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

const requestedMiB = parseSize(process.argv.slice(2));
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "codex-docx-large-")));
try {
  const sessionDirectory = path.join(temp, ".codex", "sessions", "2026", "08", "24");
  await fs.mkdir(sessionDirectory, { recursive: true });
  const input = path.join(sessionDirectory, `rollout-2026-08-24T10-00-00-${SESSION_ID}.jsonl`);
  const output = path.join(temp, "output");
  const created = await writeLargeSession(input, requestedMiB);
  const before = await sha256File(input);
  const worker = path.join(path.dirname(fileURLToPath(import.meta.url)), "docx-large-line-worker.mjs");
  let workerResult = {};
  let stderr = "";
  let exitStatus = 0;
  try {
    const result = await execFileAsync(process.execPath, [worker, path.join(temp, ".codex"), output], { encoding: "utf8", maxBuffer: MIB });
    workerResult = JSON.parse(result.stdout.trim());
    stderr = result.stderr || "";
  } catch (error) {
    exitStatus = Number.isInteger(error.code) ? error.code : 1;
    stderr = error.stderr || error.stack || error.message || "";
  }
  const after = await sha256File(input);
  if (exitStatus === 0 && workerResult.unique_asset_bytes !== created.decodedBytes) { exitStatus = 1; stderr += "\nDecoded asset byte count mismatch"; }
  if (exitStatus === 0 && (workerResult.docx_files !== 1 || workerResult.docx_media_files !== 1 || workerResult.asset_occurrences !== 1)) { exitStatus = 1; stderr += "\nDOCX or media count mismatch"; }
  if (exitStatus === 0 && workerResult.temporary_residue_count !== 0) { exitStatus = 1; stderr += "\nTemporary residue remained"; }
  if (exitStatus === 0 && workerResult.peak_rss_bytes >= 384 * MIB) { exitStatus = 1; stderr += "\nPeak RSS reached or exceeded 384 MiB"; }
  if (exitStatus === 0 && before !== after) { exitStatus = 1; stderr += "\nSource session changed"; }
  console.log(JSON.stringify({
    input_bytes: created.inputBytes,
    input_mib: Math.round(created.inputBytes / MIB * 1000) / 1000,
    runtime_ms: workerResult.runtime_ms ?? null,
    peak_rss_bytes: workerResult.peak_rss_bytes ?? null,
    peak_rss_mib: workerResult.peak_rss_bytes ? Math.round(workerResult.peak_rss_bytes / MIB * 1000) / 1000 : null,
    peak_heap_bytes: workerResult.peak_heap_bytes ?? null,
    docx_bytes: workerResult.docx_bytes ?? null,
    decoded_asset_bytes: created.decodedBytes,
    temporary_residue_count: workerResult.temporary_residue_count ?? null,
    source_byte_identical: before === after,
    peak_rss_limit_mib: 384,
    exit_status: exitStatus,
    stderr: stderr.trim(),
  }, null, 2));
  if (exitStatus !== 0) process.exitCode = exitStatus;
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
