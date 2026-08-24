#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import { performance } from "node:perf_hooks";
import path from "node:path";

import { readSessionMeta } from "../../bin/export-codex-project-chats.mjs";

const inputPath = process.argv[2];
if (!inputPath) throw new Error("Expected a JSONL input path");

let peakRss = 0;
let peakHeap = 0;
function sampleMemory() {
  const memory = process.memoryUsage();
  peakRss = Math.max(peakRss, memory.rss);
  peakHeap = Math.max(peakHeap, memory.heapUsed);
}

async function writeAll(handle, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, null);
    if (bytesWritten <= 0) throw new Error("Diagnostic attachment write made no progress");
    offset += bytesWritten;
  }
}

async function sha256File(file) {
  const hash = createHash("sha256");
  for await (const chunk of fsSync.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

const started = performance.now();
const outputPath = path.join(path.dirname(inputPath), "decoded-image.bin");
const temporaryPath = path.join(path.dirname(inputPath), `.decoded-image.${randomUUID()}.partial`);
let handle;
let maxWriteBlockBytes = 0;
sampleMemory();
try {
  handle = await fs.open(temporaryPath, "wx");
  const meta = await readSessionMeta(inputPath, {
    collectAttachmentMetrics: true,
    readerOptions: {
      onAttachmentDecodedChunk: async (chunk) => {
        maxWriteBlockBytes = Math.max(maxWriteBlockBytes, chunk.length);
        await writeAll(handle, chunk);
        sampleMemory();
      },
    },
  });
  if (meta.attachmentMetrics.embeddedCount !== 1 || meta.attachmentMetrics.embeddedHashes.size !== 1) throw new Error("Expected exactly one diagnostic attachment");
  const [decodedSha256] = meta.attachmentMetrics.embeddedHashes;
  await handle.sync();
  await handle.close();
  handle = null;
  await fs.link(temporaryPath, outputPath);
  await fs.unlink(temporaryPath);
  const writtenSha256 = await sha256File(outputPath);
  if (writtenSha256 !== decodedSha256) throw new Error("Written diagnostic attachment SHA-256 mismatch");
  sampleMemory();
  const maxRss = process.resourceUsage().maxRSS * 1024;
  console.log(JSON.stringify({
    runtime_ms: Math.round((performance.now() - started) * 1000) / 1000,
    peak_rss_bytes: Math.max(peakRss, maxRss),
    peak_heap_bytes: peakHeap,
    records: meta.parsedEventCount,
    decoded_bytes: meta.attachmentMetrics.embeddedBytes,
    sha256: decodedSha256,
    written_sha256: writtenSha256,
    max_decoded_block_bytes: meta.attachmentMetrics.maxDecodedBlockBytes,
    max_write_block_bytes: maxWriteBlockBytes,
  }));
} finally {
  await handle?.close().catch(() => {});
  await fs.unlink(temporaryPath).catch((error) => { if (error?.code !== "ENOENT") throw error; });
}
