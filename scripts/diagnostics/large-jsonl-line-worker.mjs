#!/usr/bin/env node
import fs from "node:fs";
import { performance } from "node:perf_hooks";
import readline from "node:readline";

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
const input = fs.createReadStream(inputPath);
input.on("data", sampleMemory);
const lines = readline.createInterface({ input, crlfDelay: Infinity });
for await (const line of lines) {
  if (!line.trim()) continue;
  sampleMemory();
  const item = JSON.parse(line);
  sampleMemory();
  if (item?.type !== "response_item" || item?.payload?.type !== "message") throw new Error("Unexpected diagnostic record shape");
  records += 1;
}
sampleMemory();
const maxRss = process.resourceUsage().maxRSS * 1024;
console.log(JSON.stringify({
  runtime_ms: Math.round((performance.now() - started) * 1000) / 1000,
  peak_rss_bytes: Math.max(peakRss, maxRss),
  peak_heap_bytes: peakHeap,
  records,
}));
