#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { DeduplicatedAssetStore, probeHardLinkSupport } from "../../lib/asset-store.mjs";
import { createSessionReaderSummary, streamSessionRecords } from "../../lib/session-record-reader.mjs";

const MIB = 1024 * 1024;

function parseArgs(argv) {
  const options = { maximumMiB: Infinity, selection: "largest" };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--selection") options.selection = argv[++index];
    else if (argv[index] === "--maximum-mib") options.maximumMiB = Number(argv[++index]);
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  if (!["all", "largest"].includes(options.selection)) throw new Error("--selection must be all or largest");
  if (!(options.maximumMiB > 0)) throw new Error("--maximum-mib must be positive");
  return options;
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

async function inspectDestination(destination) {
  try {
    const stat = await fs.lstat(destination, { bigint: true });
    return { exists: true, identity: `${stat.dev}:${stat.ino}` };
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false };
    throw error;
  }
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

const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "codex-real-assets-")));
const exportRoot = path.join(temp, "export");
const assetRoot = path.join(exportRoot, "assets");
const manifestPath = path.join(assetRoot, "manifest.json");
let peakRss = 0;
let peakHeap = 0;
function sampleMemory() {
  const memory = process.memoryUsage();
  peakRss = Math.max(peakRss, memory.rss);
  peakHeap = Math.max(peakHeap, memory.heapUsed);
}

const started = performance.now();
let store;
const totals = { rawBytes: 0, records: 0 };
sampleMemory();
const sampler = setInterval(sampleMemory, 10);
try {
  await fs.mkdir(assetRoot, { recursive: true });
  await probeHardLinkSupport(exportRoot);
  store = await DeduplicatedAssetStore.create({
    assetRoot,
    exportRoot,
    assertDestination: inspectDestination,
    publishManifest: (content) => fs.writeFile(manifestPath, content, { encoding: "utf8", flag: "wx" }),
  });
  for (let index = 0; index < files.length; index += 1) {
    const summary = createSessionReaderSummary();
    for await (const _record of streamSessionRecords(files[index].file, {
      summary,
      onAttachmentStart: (info) => store.beginAttachment(info),
      onRecordAbort: (recordNumber) => store.abortRecord(recordNumber),
      beforeRecordCommit: (record, recordNumber) => store.commitRecord(`session-${index + 1}`, recordNumber, record.attachments),
    })) {}
    if (!summary.stable) throw Object.assign(new Error("A real source changed during the asset diagnostic"), { code: "SESSION_SOURCE_CHANGED" });
    totals.rawBytes += summary.afterSizeBytes;
    totals.records += summary.recordCount;
  }
  const publication = await store.publish();
  await store.verifyPublishedAssets();
  const manifest = JSON.parse(publication.content);
  const assetFiles = (await fs.readdir(assetRoot, { withFileTypes: true })).filter((entry) => entry.isFile() && entry.name !== "manifest.json");
  const extensionCounts = {};
  for (const asset of manifest.assets) extensionCounts[asset.extension] = (extensionCounts[asset.extension] || 0) + 1;
  const occurrenceBytes = publication.summary.uniqueAssetBytes + publication.summary.deduplicatedBytesSaved;
  const temporaryResidue = (await fs.readdir(assetRoot)).filter((name) => name.includes(".partial") || name.startsWith(".staging-") || name.startsWith(".asset-hardlink-probe-"));
  sampleMemory();
  console.log(JSON.stringify({
    status: "COMPLETED",
    selection: options.selection,
    sessions_attempted: files.length,
    sessions_completed: files.length,
    sessions_failed: 0,
    records: totals.records,
    raw_bytes: totals.rawBytes,
    asset_occurrences: publication.summary.assetOccurrences,
    unique_assets: publication.summary.uniqueAssets,
    published_asset_files: assetFiles.length,
    unique_asset_bytes: publication.summary.uniqueAssetBytes,
    occurrence_asset_bytes: occurrenceBytes,
    deduplicated_bytes_saved: publication.summary.deduplicatedBytesSaved,
    deduplication_ratio: occurrenceBytes ? Math.round((publication.summary.deduplicatedBytesSaved / occurrenceBytes) * 1_000_000) / 1_000_000 : 0,
    extension_counts: Object.fromEntries(Object.entries(extensionCounts).sort()),
    max_write_block_bytes: publication.summary.maxWriteBlockBytes,
    runtime_ms: Math.round((performance.now() - started) * 1000) / 1000,
    peak_rss_bytes: Math.max(peakRss, process.resourceUsage().maxRSS * 1024),
    peak_heap_bytes: peakHeap,
    temporary_residue_count: temporaryResidue.length,
    privacy: "Aggregates only; no titles, prompts, source paths, payloads, source hashes, asset hashes, or asset lists are emitted.",
  }, null, 2));
} catch (error) {
  await store?.abort().catch(() => {});
  sampleMemory();
  console.log(JSON.stringify({
    status: "FAILED",
    selection: options.selection,
    sessions_attempted: files.length,
    sessions_completed: null,
    sessions_failed: null,
    error_code: error?.code || "UNKNOWN",
    runtime_ms: Math.round((performance.now() - started) * 1000) / 1000,
    peak_rss_bytes: Math.max(peakRss, process.resourceUsage().maxRSS * 1024),
    peak_heap_bytes: peakHeap,
    privacy: "Failure aggregate only; no source or payload details are emitted.",
  }, null, 2));
  process.exitCode = 1;
} finally {
  clearInterval(sampler);
  await fs.rm(temp, { recursive: true, force: true });
}
