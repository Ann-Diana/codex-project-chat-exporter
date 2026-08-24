#!/usr/bin/env node
import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import { performance } from "node:perf_hooks";
import path from "node:path";

import { DeduplicatedAssetStore, probeHardLinkSupport } from "../../lib/asset-store.mjs";
import { createSessionReaderSummary, streamSessionRecords } from "../../lib/session-record-reader.mjs";

const inputPath = process.argv[2];
if (!inputPath) throw new Error("Expected a JSONL input path");

let peakRss = 0;
let peakHeap = 0;
function sampleMemory() {
  const memory = process.memoryUsage();
  peakRss = Math.max(peakRss, memory.rss);
  peakHeap = Math.max(peakHeap, memory.heapUsed);
}

async function sha256File(file) {
  const hash = createHash("sha256");
  for await (const chunk of fsSync.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
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

const started = performance.now();
const exportRoot = path.join(path.dirname(inputPath), "asset-export");
const assetRoot = path.join(exportRoot, "assets");
const manifestPath = path.join(assetRoot, "manifest.json");
await fs.mkdir(assetRoot, { recursive: true });
await probeHardLinkSupport(exportRoot);
const store = await DeduplicatedAssetStore.create({
  assetRoot,
  exportRoot,
  assertDestination: inspectDestination,
  publishManifest: (content) => fs.writeFile(manifestPath, content, { encoding: "utf8", flag: "wx" }),
});
const summary = createSessionReaderSummary();
sampleMemory();
const sampler = setInterval(sampleMemory, 10);
try {
  for await (const _record of streamSessionRecords(inputPath, {
    calculateSha256: true,
    summary,
    onAttachmentStart: (info) => store.beginAttachment(info),
    onRecordAbort: (recordNumber) => store.abortRecord(recordNumber),
    beforeRecordCommit: (record, recordNumber) => store.commitRecord("diagnostic-session", recordNumber, record.attachments),
  })) {}
  const publication = await store.publish();
  await store.verifyPublishedAssets();
  const manifest = JSON.parse(publication.content);
  const assetFiles = (await fs.readdir(assetRoot)).filter((name) => name !== "manifest.json");
  if (manifest.assets.length !== 1 || assetFiles.length !== 1 || manifest.assets[0].uses.length !== 1) throw new Error("Expected exactly one diagnostic asset and usage");
  const assetPath = path.join(exportRoot, ...manifest.assets[0].path.split("/"));
  const writtenSha256 = await sha256File(assetPath);
  if (writtenSha256 !== manifest.assets[0].sha256) throw new Error("Written diagnostic asset SHA-256 mismatch");
  const temporaryResidue = (await fs.readdir(assetRoot)).filter((name) => name.includes(".partial") || name.startsWith(".staging-") || name.startsWith(".asset-hardlink-probe-"));
  sampleMemory();
  console.log(JSON.stringify({
    runtime_ms: Math.round((performance.now() - started) * 1000) / 1000,
    peak_rss_bytes: Math.max(peakRss, process.resourceUsage().maxRSS * 1024),
    peak_heap_bytes: peakHeap,
    records: summary.recordCount,
    decoded_bytes: summary.attachmentBytes,
    sha256: manifest.assets[0].sha256,
    written_sha256: writtenSha256,
    raw_sha256: summary.fileSha256,
    max_decoded_block_bytes: summary.maxDecodedBlockBytes || 0,
    max_write_block_bytes: publication.summary.maxWriteBlockBytes,
    asset_files: assetFiles.length,
    asset_uses: manifest.assets[0].uses.length,
    asset_extension: manifest.assets[0].extension,
    asset_renderable: manifest.assets[0].renderable,
    unique_asset_bytes: publication.summary.uniqueAssetBytes,
    temporary_residue_count: temporaryResidue.length,
  }));
} catch (error) {
  await store.abort().catch(() => {});
  throw error;
} finally {
  clearInterval(sampler);
}
