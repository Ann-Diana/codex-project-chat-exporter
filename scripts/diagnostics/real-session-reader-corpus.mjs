#!/usr/bin/env node
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { SESSION_READER_IMPLEMENTATION } from "../../lib/session-record-reader.mjs";

const execFileAsync = promisify(execFile);
const MIB = 1024 * 1024;

function parseArgs(argv) {
  const result = { selection: "largest", modes: Object.values(SESSION_READER_IMPLEMENTATION), maximumMiB: Infinity };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--selection") result.selection = argv[++index];
    else if (argument === "--mode") {
      const mode = argv[++index];
      result.modes = mode === "both" ? Object.values(SESSION_READER_IMPLEMENTATION) : [mode];
    } else if (argument === "--maximum-mib") result.maximumMiB = Number(argv[++index]);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!["all", "largest"].includes(result.selection)) throw new Error("--selection must be all or largest");
  if (result.modes.some((mode) => !Object.values(SESSION_READER_IMPLEMENTATION).includes(mode))) throw new Error("Unsupported --mode value");
  if (!(result.maximumMiB > 0)) throw new Error("--maximum-mib must be positive");
  return result;
}

async function listJsonlFiles(root) {
  const output = [];
  async function walk(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(candidate);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".jsonl")) output.push({ file: candidate, size: (await fs.stat(candidate)).size });
    }
  }
  await walk(root);
  return output;
}

async function runWorker(worker, file, implementation, privacyKey) {
  const runtimeArgs = implementation === SESSION_READER_IMPLEMENTATION.LEGACY_REFERENCE ? ["--max-old-space-size=1536"] : [];
  try {
    const { stdout } = await execFileAsync(process.execPath, [...runtimeArgs, worker, implementation, file, privacyKey], { encoding: "utf8", maxBuffer: MIB });
    return JSON.parse(stdout.trim());
  } catch (error) {
    return {
      status: "FAILED",
      implementation,
      error_code: "WORKER_PROCESS_FAILURE",
      error_record: null,
      runtime_ms: null,
      peak_rss_bytes: null,
      peak_heap_bytes: null,
    };
  }
}

function emptyAggregate() {
  return { sessions: 0, completed: 0, failed: 0, records: 0, attachments: 0, attachmentBytes: 0, hashes: new Set(), rawBytes: 0, runtimeMs: 0, peakRss: 0, peakHeap: 0, errors: new Map() };
}

function addResult(aggregate, result) {
  aggregate.sessions += 1;
  if (result.status !== "COMPLETED") {
    aggregate.failed += 1;
    aggregate.errors.set(result.error_code || "UNKNOWN", (aggregate.errors.get(result.error_code || "UNKNOWN") || 0) + 1);
    return;
  }
  aggregate.completed += 1;
  aggregate.records += result.records;
  aggregate.attachments += result.attachments;
  aggregate.attachmentBytes += result.attachment_bytes;
  for (const token of result.attachment_tokens) aggregate.hashes.add(token);
  aggregate.rawBytes += result.raw_bytes;
  aggregate.runtimeMs += result.runtime_ms;
  aggregate.peakRss = Math.max(aggregate.peakRss, result.peak_rss_bytes);
  aggregate.peakHeap = Math.max(aggregate.peakHeap, result.peak_heap_bytes);
}

function publicAggregate(value) {
  return {
    sessions_attempted: value.sessions,
    sessions_completed: value.completed,
    sessions_failed: value.failed,
    records: value.records,
    attachments: value.attachments,
    unique_attachment_hashes: value.hashes.size,
    attachment_bytes: value.attachmentBytes,
    raw_bytes: value.rawBytes,
    runtime_ms: Math.round(value.runtimeMs * 1000) / 1000,
    peak_rss_bytes: value.peakRss || null,
    peak_heap_bytes: value.peakHeap || null,
    error_counts: Object.fromEntries([...value.errors.entries()].sort()),
  };
}

const options = parseArgs(process.argv.slice(2));
const roots = [path.join(os.homedir(), ".codex", "sessions"), path.join(os.homedir(), ".codex", "archived_sessions")];
let files = [];
for (const root of roots) {
  try { files.push(...await listJsonlFiles(root)); } catch (error) { if (error?.code !== "ENOENT") throw error; }
}
files = files.filter((entry) => entry.size <= options.maximumMiB * MIB).sort((left, right) => right.size - left.size);
if (options.selection === "largest") files = files.slice(0, 1);
if (!files.length) throw new Error("No matching real session files were found");

const worker = path.join(path.dirname(fileURLToPath(import.meta.url)), "real-session-reader-worker.mjs");
const privacyKey = randomBytes(32).toString("hex");
const aggregates = Object.fromEntries(options.modes.map((mode) => [mode, emptyAggregate()]));
const differences = { comparable_sessions: 0, unavailable_reference_sessions: 0, record_count: 0, attachment_count: 0, attachment_hashes: 0, raw_hash: 0, semantic: 0 };
const started = performance.now();
for (const entry of files) {
  const results = {};
  for (const mode of options.modes) {
    results[mode] = await runWorker(worker, entry.file, mode, privacyKey);
    addResult(aggregates[mode], results[mode]);
  }
  const reference = results[SESSION_READER_IMPLEMENTATION.LEGACY_REFERENCE];
  const streaming = results[SESSION_READER_IMPLEMENTATION.STREAMING];
  if (reference && streaming) {
    if (reference.status !== "COMPLETED" || streaming.status !== "COMPLETED") differences.unavailable_reference_sessions += 1;
    else {
      differences.comparable_sessions += 1;
      if (reference.records !== streaming.records) differences.record_count += 1;
      if (reference.attachments !== streaming.attachments || reference.attachment_bytes !== streaming.attachment_bytes) differences.attachment_count += 1;
      if (JSON.stringify(reference.attachment_tokens) !== JSON.stringify(streaming.attachment_tokens)
        || reference.attachment_sequence_token !== streaming.attachment_sequence_token) differences.attachment_hashes += 1;
      if (reference.raw_token !== streaming.raw_token) differences.raw_hash += 1;
      if (reference.semantic_token !== streaming.semantic_token) differences.semantic += 1;
    }
  }
}

console.log(JSON.stringify({
  selection: options.selection,
  maximum_mib: Number.isFinite(options.maximumMiB) ? options.maximumMiB : null,
  selected_sessions: files.length,
  selected_bytes: files.reduce((sum, entry) => sum + entry.size, 0),
  wall_runtime_ms: Math.round((performance.now() - started) * 1000) / 1000,
  readers: Object.fromEntries(Object.entries(aggregates).map(([mode, value]) => [mode, publicAggregate(value)])),
  differences,
  privacy: "Aggregates only; no titles, prompts, source paths, attachment payloads, raw data, or hash lists are emitted.",
}, null, 2));
