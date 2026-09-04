import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const mode = process.env.EXPORTER_SIGINT_TEST_MODE || "discovery";
let emitted = false;

function emitOnce() {
  if (emitted) return;
  emitted = true;
  process.emit("SIGINT");
}

if (mode === "discovery") {
  const interval = setInterval(() => {
    if (process.listenerCount("SIGINT") === 0) return;
    clearInterval(interval);
    setImmediate(emitOnce);
  }, 1);
} else if (mode === "asset-stream" || mode === "render-stream") {
  const target = mode === "asset-stream" ? 1 : Number(process.env.EXPORTER_SIGINT_STREAM_TARGET || 2);
  let jsonlStreams = 0;
  const originalCreateReadStream = fs.createReadStream;
  fs.createReadStream = function createReadStreamWithSigint(file, options) {
    const stream = originalCreateReadStream.call(this, file, options);
    if (path.extname(String(file)).toLowerCase() === ".jsonl" && ++jsonlStreams === target) stream.once("data", emitOnce);
    return stream;
  };
} else if (mode === "publication") {
  const originalLink = fsp.link;
  fsp.link = async function linkWithSigint(source, destination) {
    if (String(source).includes(".partial-") && path.basename(String(destination)) !== "EXPORT_INCOMPLETE.txt") emitOnce();
    return originalLink.call(this, source, destination);
  };
} else {
  throw new Error(`Unknown synthetic SIGINT test mode: ${mode}`);
}
