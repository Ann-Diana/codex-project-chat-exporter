import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import JSZip from "jszip";
import xmlJs from "xml-js";

import { DOCUMENT_ROLE, createDocumentMessage, createSessionDocumentHeader } from "../lib/document-model.mjs";
import { DocxExportError, buildDeterministicDocx, normalizeAndValidateDocx, resolveVerifiedAsset, validateCanonicalDocx } from "../lib/docx-renderer.mjs";

const { xml2js } = xmlJs;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const JPEG = Buffer.from("/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/EH//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/EH//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/EH//2Q==", "base64");

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function attachment(data, mediaType) {
  return { sha256: sha256(data), sourceSha256: sha256(Buffer.concat([data, Buffer.from("source")])), mediaType, decodedBytes: data.length };
}

test("DOCX renderer creates deterministic safe OOXML with deduplicated PNG/JPEG media", async () => {
  const sessionId = "11111111-1111-7111-8111-111111111111";
  const png = attachment(PNG, "image/png");
  const jpeg = attachment(JPEG, "image/jpeg");
  const gif = attachment(Buffer.from("GIF89a-not-embedded"), "image/gif");
  const webp = attachment(Buffer.from("RIFF-not-embedded-WEBP"), "image/webp");
  const binary = attachment(Buffer.from([0, 1, 2, 3]), "application/octet-stream");
  const assets = new Map([
    [png.sha256, { data: PNG, extension: "png", mediaType: "image/png", path: `assets/${png.sha256}.png`, renderable: true, sha256: png.sha256 }],
    [jpeg.sha256, { data: JPEG, extension: "jpg", mediaType: "image/jpeg", path: `assets/${jpeg.sha256}.jpg`, renderable: true, sha256: jpeg.sha256 }],
    [gif.sha256, { data: Buffer.from("GIF89a-not-embedded"), extension: "gif", mediaType: "image/gif", path: `assets/${gif.sha256}.gif`, renderable: true, sha256: gif.sha256 }],
    [webp.sha256, { data: Buffer.from("RIFF-not-embedded-WEBP"), extension: "webp", mediaType: "image/webp", path: `assets/${webp.sha256}.webp`, renderable: true, sha256: webp.sha256 }],
    [binary.sha256, { data: Buffer.from([0, 1, 2, 3]), extension: "bin", mediaType: "application/octet-stream", path: `assets/${binary.sha256}.bin`, renderable: false, sha256: binary.sha256 }],
  ]);
  const header = createSessionDocumentHeader({
    id: sessionId,
    displayTitle: "Sitzung äöü & <XML>",
    cwd: "C:\\Projects\\alpha",
    timestamp: "2026-08-24T10:00:00.000Z",
    updatedAt: "2026-08-24T10:02:00.000Z",
  });
  const messages = [
    createDocumentMessage({
      sessionId,
      recordOrdinal: 2,
      role: DOCUMENT_ROLE.USER,
      label: "User",
      timestamp: "2026-08-24T10:00:01.000Z",
      text: "# Heading\n\nUmlaute äöü & < > with [remote](https://example.invalid/path).\n\n- one\n- two\n\n```js\nconst value = '<&>';\n```",
      attachments: [png, png, jpeg, gif, webp, binary],
    }),
    createDocumentMessage({ sessionId, recordOrdinal: 3, role: DOCUMENT_ROLE.ASSISTANT, label: "Assistant", text: "Second message." }),
    createDocumentMessage({ sessionId, recordOrdinal: 4, role: DOCUMENT_ROLE.UNCLASSIFIED, label: "Unclassified user-role record", text: "Last message." }),
  ];
  const options = { header, messages, resolveAsset: async (reference) => assets.get(reference.sha256) };
  const first = await buildDeterministicDocx(options);
  const second = await buildDeterministicDocx(options);
  assert.deepEqual(first, second, "repeated exports must be byte-identical");

  const zip = await JSZip.loadAsync(first, { checkCRC32: true });
  const files = Object.values(zip.files).filter((entry) => !entry.dir);
  assert.ok(files.every((entry) => entry.date.toISOString() === "2000-01-01T00:00:00.000Z"));
  for (const entry of files.filter((candidate) => candidate.name.endsWith(".xml") || candidate.name.endsWith(".rels"))) {
    const xml = await entry.async("string");
    assert.doesNotThrow(() => xml2js(xml, { compact: false }));
  }
  const documentXml = await zip.file("word/document.xml").async("string");
  const relationships = await zip.file("word/_rels/document.xml.rels").async("string");
  const media = files.filter((entry) => entry.name.startsWith("word/media/"));
  assert.equal(media.length, 2, "two uses of the same PNG must share one media part while JPEG remains distinct");
  assert.equal((relationships.split("/image\"").length - 1), 2, "each unique embedded image needs one relationship");
  assert.equal(relationships.includes("TargetMode=\"External\""), false);
  assert.equal(relationships.toLowerCase().includes("file:"), false);
  assert.ok(documentXml.includes("Sitzung äöü &amp; &lt;XML&gt;"));
  assert.ok(documentXml.indexOf("User") < documentXml.indexOf("Assistant") && documentXml.indexOf("Assistant") < documentXml.indexOf("Unclassified user-role record"));
  assert.ok(documentXml.includes("descr=\"Attachment 1 from session record 2\""), "embedded images need alternative text");
  assert.ok(documentXml.includes(`assets/${gif.sha256}.gif`.split("/").at(-1)));
  assert.ok(documentXml.includes(`assets/${webp.sha256}.webp`.split("/").at(-1)));
  assert.ok(documentXml.includes(`assets/${binary.sha256}.bin`.split("/").at(-1)));
  assert.equal(relationships.includes("example.invalid"), false, "plain-text links must not create external relationships");
  assert.equal(files.some((entry) => ["activex", "embeddings", "vbaproject"].some((part) => entry.name.toLowerCase().includes(part))), false);
});

test("DOCX normalization rejects external relationships and active content", async () => {
  const header = createSessionDocumentHeader({ id: "session", title: "safe" });
  const safe = await buildDeterministicDocx({ header, messages: [], resolveAsset: async () => null });
  const externalZip = await JSZip.loadAsync(safe);
  const rels = await externalZip.file("word/_rels/document.xml.rels").async("string");
  externalZip.file("word/_rels/document.xml.rels", rels.replace("</Relationships>", "<Relationship Id=\"rId999\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink\" Target=\"https://example.invalid\" TargetMode=\"External\"/></Relationships>"));
  await assert.rejects(() => normalizeAndValidateDocx(externalZip.generateAsync({ type: "nodebuffer" })), (error) => error instanceof DocxExportError && error.code === "DOCX_EXTERNAL_RELATIONSHIP");

  const disguisedExternalZip = await JSZip.loadAsync(safe);
  disguisedExternalZip.file("word/_rels/document.xml.rels", rels.replace("</Relationships>", "<Relationship Id=\"rId998\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink\" Target=\"https://example.invalid/without-target-mode\"/></Relationships>"));
  await assert.rejects(() => normalizeAndValidateDocx(disguisedExternalZip.generateAsync({ type: "nodebuffer" })), (error) => error instanceof DocxExportError && error.code === "DOCX_EXTERNAL_RELATIONSHIP");

  const drivePathZip = await JSZip.loadAsync(safe);
  drivePathZip.file("word/_rels/document.xml.rels", rels.replace("</Relationships>", "<Relationship Id=\"rId997\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/image\" Target=\"C:\\secret.png\"/></Relationships>"));
  await assert.rejects(() => normalizeAndValidateDocx(drivePathZip.generateAsync({ type: "nodebuffer" })), (error) => error instanceof DocxExportError && error.code === "DOCX_EXTERNAL_RELATIONSHIP");

  const activeZip = await JSZip.loadAsync(safe);
  activeZip.file("word/vbaProject.bin", Buffer.from("macro"));
  await assert.rejects(() => normalizeAndValidateDocx(activeZip.generateAsync({ type: "nodebuffer" })), (error) => error instanceof DocxExportError && error.code === "DOCX_ACTIVE_CONTENT");

  const mediaHeader = createSessionDocumentHeader({ id: "media-session", title: "media" });
  const pngReference = attachment(PNG, "image/png");
  const withMedia = await buildDeterministicDocx({
    header: mediaHeader,
    messages: [createDocumentMessage({ sessionId: "media-session", recordOrdinal: 1, role: DOCUMENT_ROLE.USER, attachments: [pngReference] })],
    resolveAsset: async () => ({ data: PNG, extension: "png", mediaType: "image/png", path: `assets/${pngReference.sha256}.png`, renderable: true, sha256: pngReference.sha256 }),
  });
  const missingMediaZip = await JSZip.loadAsync(withMedia);
  const mediaName = Object.keys(missingMediaZip.files).find((name) => name.startsWith("word/media/") && !missingMediaZip.files[name].dir);
  missingMediaZip.remove(mediaName);
  await assert.rejects(() => validateCanonicalDocx(missingMediaZip.generateAsync({ type: "nodebuffer" })), (error) => error instanceof DocxExportError && error.code === "DOCX_MEDIA_MAPPING_INVALID");
});

test("verified asset resolution fails closed for missing and manipulated files", async () => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "docx-assets-")));
  try {
    const assetRoot = path.join(temp, "assets");
    await fs.mkdir(assetRoot);
    const hash = sha256(PNG);
    const relative = `assets/${hash}.png`;
    const entry = { bytes: PNG.length, extension: "png", mime_type: "image/png", path: relative, renderable: true, sha256: hash };
    const store = { assetForDescriptor: () => entry };
    const reference = { sha256: hash, origin: { recordOrdinal: 1 } };
    await assert.rejects(() => resolveVerifiedAsset(store, temp, reference), (error) => error.code === "DOCX_ASSET_MISSING");
    await fs.writeFile(path.join(temp, relative), Buffer.concat([PNG, Buffer.from("changed")]));
    await assert.rejects(() => resolveVerifiedAsset(store, temp, reference), (error) => error.code === "DOCX_ASSET_MISMATCH");
    await fs.writeFile(path.join(temp, relative), PNG);
    const resolved = await resolveVerifiedAsset(store, temp, reference);
    assert.deepEqual(resolved.data, PNG);
    const outside = path.join(temp, "outside.png");
    await fs.writeFile(outside, PNG);
    await fs.rm(path.join(temp, relative));
    try {
      await fs.symlink(outside, path.join(temp, relative), "file");
      await assert.rejects(() => resolveVerifiedAsset(store, temp, reference), (error) => error.code === "DOCX_ASSET_PATH_UNSAFE");
    } catch (error) {
      if (!["EPERM", "EACCES", "ENOSYS"].includes(error?.code)) throw error;
    }
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});
