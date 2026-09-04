#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import JSZip from "jszip";

import { exportArchive, INCOMPLETE_MARKER_NAME } from "../../bin/export-codex-project-chats.mjs";

const codexHome = process.argv[2];
const outputDirectory = process.argv[3];
if (!codexHome || !outputDirectory) throw new Error("Expected Codex home and output directory paths");

let peakRss = 0;
let peakHeap = 0;
function sampleMemory() {
  const memory = process.memoryUsage();
  peakRss = Math.max(peakRss, memory.rss);
  peakHeap = Math.max(peakHeap, memory.heapUsed);
}

async function listNames(root) {
  const names = [];
  async function walk(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else names.push(path.relative(root, absolute).replaceAll("\\", "/"));
    }
  }
  await walk(root);
  return names;
}

const started = performance.now();
sampleMemory();
const sampler = setInterval(sampleMemory, 5);
try {
  const result = await exportArchive({
    codexHome,
    scope: "all",
    outputDirectory,
    exportProfile: "readable",
    documentFormats: ["docx"],
  });
  sampleMemory();
  const manifest = JSON.parse(await fs.readFile(result.manifestPath, "utf8"));
  if (manifest.sessions.length !== 1 || !manifest.sessions[0].docx_file) throw new Error("Expected one session and one DOCX output");
  const docxPath = path.join(outputDirectory, manifest.sessions[0].docx_file);
  const docxBytes = await fs.readFile(docxPath);
  const zip = await JSZip.loadAsync(docxBytes, { checkCRC32: true });
  const mediaFiles = Object.values(zip.files).filter((entry) => !entry.dir && entry.name.startsWith("word/media/"));
  const names = await listNames(outputDirectory);
  const residue = names.filter((name) => name.includes(".partial-") || name.includes(".previous-") || name.includes(".staging-") || name.includes(".asset-hardlink-probe-") || name === INCOMPLETE_MARKER_NAME);
  sampleMemory();
  console.log(JSON.stringify({
    runtime_ms: Math.round((performance.now() - started) * 1000) / 1000,
    peak_rss_bytes: Math.max(peakRss, process.resourceUsage().maxRSS * 1024),
    peak_heap_bytes: peakHeap,
    docx_bytes: docxBytes.length,
    docx_files: names.filter((name) => name.endsWith(".docx")).length,
    docx_media_files: mediaFiles.length,
    asset_occurrences: manifest.asset_occurrences,
    unique_asset_bytes: manifest.unique_asset_bytes,
    temporary_residue_count: residue.length,
  }));
} finally {
  clearInterval(sampler);
}
