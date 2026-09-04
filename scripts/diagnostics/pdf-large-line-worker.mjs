#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import JSZip from "jszip";

import { exportArchive, INCOMPLETE_MARKER_NAME } from "../../bin/export-codex-project-chats.mjs";
import { validateCanonicalPdf } from "../../lib/pdf-renderer.mjs";

const codexHome = process.argv[2];
const outputDirectory = process.argv[3];
const format = process.argv[4];
if (!codexHome || !outputDirectory || (format !== "pdf" && format !== "docx")) throw new Error("Expected Codex home, output directory, and pdf/docx format");

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
  const result = await exportArchive({ codexHome, scope: "all", outputDirectory, exportProfile: "readable", documentFormats: [format] });
  sampleMemory();
  const manifest = JSON.parse(await fs.readFile(result.manifestPath, "utf8"));
  const documentRelative = manifest.sessions[0]?.[`${format}_file`];
  if (manifest.sessions.length !== 1 || !documentRelative) throw new Error(`Expected one session and one ${format.toUpperCase()} output`);
  const documentBytes = await fs.readFile(path.join(outputDirectory, documentRelative));
  let embeddedMediaFiles;
  if (format === "pdf") {
    validateCanonicalPdf(documentBytes);
    embeddedMediaFiles = documentBytes.toString("latin1").split("/Subtype /Image").length - 1;
  } else {
    const zip = await JSZip.loadAsync(documentBytes, { checkCRC32: true });
    embeddedMediaFiles = Object.values(zip.files).filter((entry) => !entry.dir && entry.name.startsWith("word/media/")).length;
  }
  const names = await listNames(outputDirectory);
  const residue = names.filter((name) => name.includes(".partial-") || name.includes(".previous-") || name.includes(".staging-") || name.includes(".asset-hardlink-probe-") || name === INCOMPLETE_MARKER_NAME);
  sampleMemory();
  console.log(JSON.stringify({
    format,
    runtime_ms: Math.round((performance.now() - started) * 1000) / 1000,
    peak_rss_bytes: Math.max(peakRss, process.resourceUsage().maxRSS * 1024),
    peak_heap_bytes: peakHeap,
    document_bytes: documentBytes.length,
    document_files: names.filter((name) => name.endsWith(`.${format}`)).length,
    embedded_media_files: embeddedMediaFiles,
    asset_occurrences: manifest.asset_occurrences,
    unique_asset_bytes: manifest.unique_asset_bytes,
    temporary_residue_count: residue.length,
  }));
} finally {
  clearInterval(sampler);
}
