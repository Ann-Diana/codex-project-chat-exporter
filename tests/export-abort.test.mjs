import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Packer } from "docx";
import { exportArchive, INCOMPLETE_MARKER_NAME } from "../bin/export-codex-project-chats.mjs";

const ONE_PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aCioAAAAASUVORK5CYII=";

async function fixture() {
  const temp = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "export-abort-")));
  const codexHome = path.join(temp, "source");
  const sessions = path.join(codexHome, "sessions");
  await fsp.mkdir(sessions, { recursive: true });
  const cwd = process.platform === "win32" ? "C:\\Synthetic\\Abort" : "/synthetic/abort";
  const rows = [
    { type: "session_meta", timestamp: "2026-08-01T10:00:00Z", payload: { id: "abort-session", cwd, timestamp: "2026-08-01T10:00:00Z" } },
    { type: "response_item", timestamp: "2026-08-01T10:00:01Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Synthetic." }, { type: "input_image", image_url: `data:image/png;base64,${ONE_PIXEL_PNG}` }] } },
    { type: "response_item", timestamp: "2026-08-01T10:00:02Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "# Heading\n\n- item\n\nParagraph." }] } },
  ];
  await fsp.writeFile(path.join(sessions, "rollout-abort.jsonl"), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  return { temp, codexHome };
}

async function filesBelow(root) {
  const output = [];
  async function walk(directory) {
    for (const entry of await fsp.readdir(directory, { withFileTypes: true }).catch((error) => error.code === "ENOENT" ? [] : Promise.reject(error))) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else output.push(path.relative(root, absolute).replaceAll("\\", "/"));
    }
  }
  await walk(root);
  return output.sort();
}

async function expectCancelled(action) {
  await assert.rejects(action, (error) => error.code === "EXPORT_CANCELLED");
}

test("core cancellation is observed in discovery and full session streaming", async () => {
  const source = await fixture();
  try {
    const discoveryController = new AbortController();
    await expectCancelled(() => exportArchive({ codexHome: source.codexHome, scope: "all", outputDirectory: path.join(source.temp, "discovery"), exportProfile: "readable", abortSignal: discoveryController.signal, onProgress(event) {
      if (event.phase === "discovery") discoveryController.abort();
    } }));
    assert.equal((await filesBelow(path.join(source.temp, "discovery"))).length, 0);

    const streamingController = new AbortController();
    let armed = false;
    await expectCancelled(() => exportArchive({
      codexHome: source.codexHome,
      scope: "all",
      outputDirectory: path.join(source.temp, "streaming"),
      exportProfile: "readable",
      abortSignal: streamingController.signal,
      onProgress(event) {
        if (event.phase === "processing") armed = true;
      },
      _readerOptions: {
        io: {
          createReadStream(file, options) {
            const stream = fs.createReadStream(file, options);
            if (armed) stream.once("data", () => { armed = false; streamingController.abort(); });
            return stream;
          },
        },
      },
    }));
    const streamedFiles = await filesBelow(path.join(source.temp, "streaming"));
    assert.ok(streamedFiles.includes(INCOMPLETE_MARKER_NAME));
    assert.equal(streamedFiles.some((name) => name.includes(".partial-") || name.includes(".staging-")), false);
  } finally { await fsp.rm(source.temp, { recursive: true, force: true }); }
});

test("asset, document-model and renderer phase cancellations retain only a verified incomplete generation", async () => {
  const source = await fixture();
  try {
    const assetController = new AbortController();
    let abortOnStageWrite = true;
    await expectCancelled(() => exportArchive({
      codexHome: source.codexHome,
      scope: "all",
      outputDirectory: path.join(source.temp, "assets"),
      exportProfile: "readable",
      abortSignal: assetController.signal,
      _assetStoreOptions: {
        io: {
          async open(file, flags) {
            const handle = await fsp.open(file, flags);
            if (!file.includes(".staging-")) return handle;
            return {
              stat: (...args) => handle.stat(...args),
              sync: (...args) => handle.sync(...args),
              close: (...args) => handle.close(...args),
              async write(...args) {
                const result = await handle.write(...args);
                if (abortOnStageWrite) { abortOnStageWrite = false; assetController.abort(); }
                return result;
              },
            };
          },
        },
      },
    }));
    const assetFiles = await filesBelow(path.join(source.temp, "assets"));
    assert.ok(assetFiles.includes(INCOMPLETE_MARKER_NAME));
    assert.equal(assetFiles.some((name) => name.includes(".partial-") || name.includes(".staging-")), false);

    const modelController = new AbortController();
    await expectCancelled(() => exportArchive({ codexHome: source.codexHome, scope: "all", outputDirectory: path.join(source.temp, "model"), exportProfile: "readable", documentFormats: ["docx"], abortSignal: modelController.signal, onProgress(event) {
      if (event.phase === "rendering") modelController.abort();
    } }));
    assert.ok((await filesBelow(path.join(source.temp, "model"))).includes(INCOMPLETE_MARKER_NAME));

    const rendererController = new AbortController();
    const abortingPacker = { async toBuffer(document) {
      const bytes = await Packer.toBuffer(document);
      rendererController.abort();
      return bytes;
    } };
    await expectCancelled(() => exportArchive({ codexHome: source.codexHome, scope: "all", outputDirectory: path.join(source.temp, "renderer"), exportProfile: "readable", documentFormats: ["docx"], abortSignal: rendererController.signal, _docxOptions: { packer: abortingPacker } }));
    const rendererFiles = await filesBelow(path.join(source.temp, "renderer"));
    assert.ok(rendererFiles.includes(INCOMPLETE_MARKER_NAME));
    assert.equal(rendererFiles.some((name) => name.endsWith(".docx") || name.includes(".partial-")), false);

    const pdfController = new AbortController();
    await expectCancelled(() => exportArchive({
      codexHome: source.codexHome,
      scope: "all",
      outputDirectory: path.join(source.temp, "pdf-renderer"),
      exportProfile: "readable",
      documentFormats: ["pdf"],
      abortSignal: pdfController.signal,
      _pdfOptions: {
        async resolveAsset() {
          pdfController.abort();
          return { data: Buffer.from(ONE_PIXEL_PNG, "base64"), dimensions: { width: 1, height: 1 }, extension: "png", sha256: "synthetic" };
        },
      },
    }));
    const pdfRendererFiles = await filesBelow(path.join(source.temp, "pdf-renderer"));
    assert.ok(pdfRendererFiles.includes(INCOMPLETE_MARKER_NAME));
    assert.equal(pdfRendererFiles.some((name) => name.endsWith(".pdf") || name.includes(".partial-")), false);
  } finally { await fsp.rm(source.temp, { recursive: true, force: true }); }
});

test("publication and manifest cancellation clean temporaries without deleting foreign files", async () => {
  const source = await fixture();
  try {
    const publicationOutput = path.join(source.temp, "publication");
    await fsp.mkdir(publicationOutput);
    await fsp.writeFile(path.join(publicationOutput, "foreign.keep"), "foreign");
    const publicationController = new AbortController();
    await expectCancelled(() => exportArchive({
      codexHome: source.codexHome,
      scope: "all",
      outputDirectory: publicationOutput,
      exportProfile: "readable",
      documentFormats: ["docx"],
      abortSignal: publicationController.signal,
      _docxOptions: {
        async writeBuffer(handle, bytes) {
          await handle.writeFile(bytes);
          publicationController.abort();
        },
      },
    }));
    const publicationFiles = await filesBelow(publicationOutput);
    assert.ok(publicationFiles.includes("foreign.keep"));
    assert.ok(publicationFiles.includes(INCOMPLETE_MARKER_NAME));
    assert.equal(publicationFiles.some((name) => name.includes(".partial-") || name.includes(".previous-")), false);

    const manifestOutput = path.join(source.temp, "manifest");
    const manifestController = new AbortController();
    await expectCancelled(() => exportArchive({ codexHome: source.codexHome, scope: "all", outputDirectory: manifestOutput, exportProfile: "readable", abortSignal: manifestController.signal, onDiagnostic(event) {
      if (event.event === "manifest_start") manifestController.abort();
    } }));
    const manifestFiles = await filesBelow(manifestOutput);
    assert.ok(manifestFiles.includes(INCOMPLETE_MARKER_NAME));
    assert.equal(manifestFiles.includes("manifest.json"), false);
    assert.equal(manifestFiles.some((name) => name.includes(".partial-") || name.includes(".previous-")), false);

    const finalizationOutput = path.join(source.temp, "finalization");
    const finalizationController = new AbortController();
    await expectCancelled(() => exportArchive({ codexHome: source.codexHome, scope: "all", outputDirectory: finalizationOutput, exportProfile: "readable", abortSignal: finalizationController.signal, onDiagnostic(event) {
      if (event.event === "finalization_start") finalizationController.abort();
    } }));
    const finalizationFiles = await filesBelow(finalizationOutput);
    assert.ok(finalizationFiles.includes(INCOMPLETE_MARKER_NAME));
    assert.ok(finalizationFiles.includes("manifest.json"));
    assert.equal(finalizationFiles.some((name) => name.includes(".partial-") || name.includes(".previous-")), false);
  } finally { await fsp.rm(source.temp, { recursive: true, force: true }); }
});

test("failure in the second document format leaves DOCX validated, PDF absent and the entire run incomplete", async () => {
  const source = await fixture();
  try {
    const outputDirectory = path.join(source.temp, "second-format");
    await fsp.mkdir(outputDirectory);
    await fsp.writeFile(path.join(outputDirectory, "foreign.keep"), "foreign");
    await assert.rejects(() => exportArchive({
      codexHome: source.codexHome,
      scope: "all",
      outputDirectory,
      exportProfile: "readable",
      documentFormats: ["docx", "pdf"],
      _pdfOptions: { writeBuffer: async () => { throw Object.assign(new Error("synthetic PDF publication failure"), { code: "ENOSPC" }); } },
    }), (error) => error.code === "ENOSPC");
    const files = await filesBelow(outputDirectory);
    assert.ok(files.includes("foreign.keep"));
    assert.ok(files.includes(INCOMPLETE_MARKER_NAME));
    assert.ok(files.some((name) => name.endsWith(".docx")));
    assert.equal(files.some((name) => name.endsWith(".pdf") || name.includes(".partial-") || name.includes(".previous-")), false);
  } finally { await fsp.rm(source.temp, { recursive: true, force: true }); }
});
