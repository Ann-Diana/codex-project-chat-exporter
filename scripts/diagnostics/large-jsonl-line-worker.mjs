#!/usr/bin/env node
import { performance } from "node:perf_hooks";
import path from "node:path";

import { writeBase64ChunksToFile } from "../../lib/bounded-base64.mjs";
import { streamJsonlTokens } from "../../lib/jsonl-token-adapter.mjs";

const inputPath = process.argv[2];
if (!inputPath) throw new Error("Expected a JSONL input path");

let peakRss = 0;
let peakHeap = 0;
function sampleMemory() {
  const memory = process.memoryUsage();
  peakRss = Math.max(peakRss, memory.rss);
  peakHeap = Math.max(peakHeap, memory.heapUsed);
}

const started = performance.now();
let records = 0;
sampleMemory();

const targetPath = ["payload", "content", 1, "image_url"];
function samePath(candidate) {
  return candidate.length === targetPath.length && candidate.every((segment, index) => segment === targetPath[index]);
}

async function* imagePayloadChunks() {
  const dataUrlPrefix = "data:image/png;base64,";
  let prefixOffset = 0;
  let inTarget = false;
  let completed = false;
  for await (const token of streamJsonlTokens(inputPath)) {
    sampleMemory();
    if (token.type === "record_end") records += 1;
    if (!samePath(token.path)) continue;
    if (token.type === "string_start") {
      if (inTarget || completed) throw new Error("Duplicate diagnostic image value");
      inTarget = true;
      continue;
    }
    if (token.type === "string_chunk" && inTarget) {
      let offset = 0;
      while (prefixOffset < dataUrlPrefix.length && offset < token.value.length) {
        if (token.value[offset] !== dataUrlPrefix[prefixOffset]) throw new Error("Unexpected diagnostic image prefix");
        offset += 1;
        prefixOffset += 1;
      }
      if (offset < token.value.length) yield token.value.slice(offset);
      continue;
    }
    if (token.type === "string_end" && inTarget) {
      if (prefixOffset !== dataUrlPrefix.length) throw new Error("Incomplete diagnostic image prefix");
      inTarget = false;
      completed = true;
    }
  }
  if (!completed || inTarget) throw new Error("Diagnostic image value was not completed");
}

const outputPath = path.join(path.dirname(inputPath), "decoded-image.bin");
const decoded = await writeBase64ChunksToFile(imagePayloadChunks(), outputPath);
sampleMemory();
const maxRss = process.resourceUsage().maxRSS * 1024;
console.log(JSON.stringify({
  runtime_ms: Math.round((performance.now() - started) * 1000) / 1000,
  peak_rss_bytes: Math.max(peakRss, maxRss),
  peak_heap_bytes: peakHeap,
  records,
  decoded_bytes: decoded.decodedBytes,
  sha256: decoded.sha256,
  max_decoded_block_bytes: decoded.maxDecodedBlockBytes,
  max_write_block_bytes: decoded.maxDecodedBlockBytes,
}));
