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
const SESSION_ID = "eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee";

function parseSize(argv) {
  const index = argv.indexOf("--size-mib");
  if (index < 0) return DEFAULT_SIZE_MIB;
  const value = Number(argv[index + 1]);
  if (!Number.isFinite(value) || value <= 0) throw new Error("--size-mib must be a positive number");
  return value;
}

async function writeLargeSession(file, requestedMiB) {
  const metadata = `${JSON.stringify({ type: "session_meta", timestamp: "2026-08-25T10:00:00.000Z", payload: { id: SESSION_ID, cwd: "C:\\Projects\\pdf-large", timestamp: "2026-08-25T10:00:00.000Z", source: "vscode", thread_source: "user" } })}\n`;
  const prefix = '{"timestamp":"2026-08-25T10:00:01.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"large PDF diagnostic"},{"type":"input_image","image_url":"data:application/octet-stream;base64,';
  const suffix = '"}]}}\n';
  const targetBytes = Math.floor(requestedMiB * MIB);
  const fixedBytes = Buffer.byteLength(metadata) + Buffer.byteLength(prefix) + Buffer.byteLength(suffix);
  const payloadCharacters = Math.floor((targetBytes - fixedBytes) / 4) * 4;
  if (payloadCharacters < 1024) throw new Error("Requested input is too small");
  const decodedBytes = payloadCharacters / 4 * 3;
  let remaining = decodedBytes;
  let first = true;
  const handle = await fs.open(file, "wx");
  try {
    await handle.write(metadata, null, "utf8");
    await handle.write(prefix, null, "utf8");
    while (remaining > 0) {
      const size = Math.min(remaining, 48 * 1024);
      const chunk = Buffer.alloc(size, first ? 0x41 : 0);
      first = false;
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

async function runWorker(worker, codexHome, output, format) {
  const result = await execFileAsync(process.execPath, [worker, codexHome, output, format], { encoding: "utf8", maxBuffer: MIB });
  return JSON.parse(result.stdout.trim());
}

const requestedMiB = parseSize(process.argv.slice(2));
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "codex-pdf-large-")));
let exitStatus = 0;
let stderr = "";
try {
  const codexHome = path.join(temp, ".codex");
  const sessionDirectory = path.join(codexHome, "sessions", "2026", "08", "25");
  await fs.mkdir(sessionDirectory, { recursive: true });
  const input = path.join(sessionDirectory, `rollout-2026-08-25T10-00-00-${SESSION_ID}.jsonl`);
  const created = await writeLargeSession(input, requestedMiB);
  const before = await sha256File(input);
  const worker = path.join(path.dirname(fileURLToPath(import.meta.url)), "pdf-large-line-worker.mjs");
  let pdf = {};
  let docx = {};
  try {
    pdf = await runWorker(worker, codexHome, path.join(temp, "pdf-output"), "pdf");
    docx = await runWorker(worker, codexHome, path.join(temp, "docx-output"), "docx");
  } catch (error) {
    exitStatus = Number.isInteger(error.code) ? error.code : 1;
    stderr = error.stderr || error.stack || error.message || "";
  }
  const after = await sha256File(input);
  const ratio = pdf.runtime_ms && docx.runtime_ms ? pdf.runtime_ms / docx.runtime_ms : null;
  if (exitStatus === 0 && (pdf.unique_asset_bytes !== created.decodedBytes || docx.unique_asset_bytes !== created.decodedBytes)) { exitStatus = 1; stderr += "\nDecoded asset byte count mismatch"; }
  if (exitStatus === 0 && (pdf.document_files !== 1 || docx.document_files !== 1 || pdf.asset_occurrences !== 1 || docx.asset_occurrences !== 1)) { exitStatus = 1; stderr += "\nDocument or occurrence count mismatch"; }
  if (exitStatus === 0 && (pdf.embedded_media_files !== 0 || docx.embedded_media_files !== 0)) { exitStatus = 1; stderr += "\nNon-renderable diagnostic attachment was unexpectedly embedded"; }
  if (exitStatus === 0 && (pdf.temporary_residue_count !== 0 || docx.temporary_residue_count !== 0)) { exitStatus = 1; stderr += "\nTemporary residue remained"; }
  if (exitStatus === 0 && pdf.peak_rss_bytes >= 384 * MIB) { exitStatus = 1; stderr += "\nPDF Peak RSS reached or exceeded 384 MiB"; }
  if (exitStatus === 0 && ratio > 1.5) { exitStatus = 1; stderr += "\nPDF runtime exceeded the corresponding DOCX runtime by more than 50 percent"; }
  if (exitStatus === 0 && before !== after) { exitStatus = 1; stderr += "\nSource session changed"; }
  console.log(JSON.stringify({
    input_bytes: created.inputBytes,
    input_mib: Math.round(created.inputBytes / MIB * 1000) / 1000,
    decoded_asset_bytes: created.decodedBytes,
    pdf_runtime_ms: pdf.runtime_ms ?? null,
    docx_runtime_ms: docx.runtime_ms ?? null,
    pdf_vs_docx_ratio: ratio === null ? null : Math.round(ratio * 1000) / 1000,
    pdf_peak_rss_bytes: pdf.peak_rss_bytes ?? null,
    pdf_peak_rss_mib: pdf.peak_rss_bytes ? Math.round(pdf.peak_rss_bytes / MIB * 1000) / 1000 : null,
    pdf_bytes: pdf.document_bytes ?? null,
    temporary_residue_count: (pdf.temporary_residue_count ?? 0) + (docx.temporary_residue_count ?? 0),
    source_byte_identical: before === after,
    peak_rss_limit_mib: 384,
    runtime_investigation_threshold_ratio: 1.5,
    exit_status: exitStatus,
    stderr: stderr.trim(),
  }, null, 2));
  if (exitStatus !== 0) process.exitCode = exitStatus;
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
