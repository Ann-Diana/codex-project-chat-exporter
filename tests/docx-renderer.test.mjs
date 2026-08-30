import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import dns from "node:dns";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import tls from "node:tls";

import JSZip from "jszip";
import xmlJs from "xml-js";

import { DOCUMENT_ROLE, createDocumentMessage, createSessionDocumentHeader } from "../lib/document-model.mjs";
import { DocxExportError, buildDeterministicDocx, normalizeAndValidateDocx, resolveVerifiedAsset, validateCanonicalDocx } from "../lib/docx-renderer.mjs";
import { findFirstInvalidXml10Character, normalizeOoxmlText, replaceInvalidXml10Characters } from "../lib/ooxml-text.mjs";

const { xml2js } = xmlJs;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const JPEG = Buffer.from("/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/EH//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/EH//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/EH//2Q==", "base64");

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function attachment(data, mediaType) {
  return { sha256: sha256(data), sourceSha256: sha256(Buffer.concat([data, Buffer.from("source")])), mediaType, decodedBytes: data.length };
}

function collectElements(value, name, result = []) {
  if (!value || typeof value !== "object") return result;
  if (value.type === "element" && value.name === name) result.push(value);
  for (const child of value.elements || []) collectElements(child, name, result);
  return result;
}

function elementText(value) {
  if (!value || typeof value !== "object") return "";
  if (value.type === "text") return String(value.text || "");
  return (value.elements || []).map(elementText).join("");
}

async function withoutNetwork(action) {
  const blocked = () => { throw new Error("unexpected network access"); };
  const patches = [
    [http, "get"], [http, "request"], [https, "get"], [https, "request"],
    [net, "connect"], [net, "createConnection"], [tls, "connect"], [dns, "lookup"], [dns, "resolve"],
  ].map(([owner, key]) => [owner, key, owner[key]]);
  const previousFetch = globalThis.fetch;
  try {
    for (const [owner, key] of patches) owner[key] = blocked;
    globalThis.fetch = blocked;
    return await action();
  } finally {
    for (const [owner, key, value] of patches) owner[key] = value;
    globalThis.fetch = previousFetch;
  }
}

test("OOXML text replacement preserves valid XML 1.0 Unicode and identifies forbidden UTF-16 units", () => {
  const valid = "\t\r\n \uD7FF\uE000\uFFFD\u{10000}\u{10FFFF} emoji \u{1F642}";
  assert.equal(replaceInvalidXml10Characters(valid), valid);
  assert.equal(findFirstInvalidXml10Character(valid), null);

  const invalid = `nul\u0000 vt\u000b ff\u000c esc\u001b nonchar\uFFFE high\uD800 low\uDC00`;
  assert.equal(replaceInvalidXml10Characters(invalid),
    "nul[invalid XML character U+0000] vt[invalid XML character U+000B] ff[invalid XML character U+000C] esc[invalid XML character U+001B] nonchar[invalid XML character U+FFFE] high[invalid XML character U+D800] low[invalid XML character U+DC00]");
  assert.deepEqual(findFirstInvalidXml10Character(invalid), { codePoint: 0, index: 3, width: 1 });
  assert.equal(replaceInvalidXml10Characters("a\u0000\u000b\u001bb"),
    "a[invalid XML character U+0000][invalid XML character U+000B][invalid XML character U+001B]b");
});

test("OOXML normalization removes only complete ANSI SGR formatting sequences", () => {
  assert.equal(normalizeOoxmlText("before\u001b[31mred\u001b[0mafter"), "beforeredafter");
  assert.equal(normalizeOoxmlText("before\u001b[1m\u001b[4mbetween\u001b[mafter"), "beforebetweenafter");
  assert.equal(normalizeOoxmlText("before\u001b[38;2;255;0;0mbetween\u001b[39mafter"), "beforebetweenafter");
  assert.equal(normalizeOoxmlText("incomplete\u001b[31"), "incomplete[invalid XML character U+001B][31");
  assert.equal(normalizeOoxmlText("unknown\u001b[31Kafter"), "unknown[invalid XML character U+001B][31Kafter");
  assert.equal(normalizeOoxmlText("isolated\u001bafter"), "isolated[invalid XML character U+001B]after");
  assert.equal(normalizeOoxmlText("printable before \u001b[1mprintable between\u001b[0m printable after"),
    "printable before printable between printable after");
});

test("DOCX replaces forbidden XML characters in titles, paragraphs, headings, lists, code, and hyperlink labels", async () => {
  const sessionId = "xml-character-boundaries";
  const header = createSessionDocumentHeader({
    id: sessionId,
    displayTitle: "Title\u0000",
    cwd: "Project\u000b",
  });
  const messages = [createDocumentMessage({
    sessionId,
    recordOrdinal: 18,
    role: DOCUMENT_ROLE.USER,
    label: "User\u000c",
    timestamp: "2026-07-14T19:26:51.629Z\u001b",
    text: "# Heading\u000c\n\nParagraph\u0000 with valid \t tab and \u{1F642}.\n\n- List\u001b\n\n[Label\uD800](https://openai.com/).\n\n```text\nCode\uFFFF and low\uDC00\n```",
  })];
  const first = await withoutNetwork(() => buildDeterministicDocx({ header, messages, resolveAsset: async () => null }));
  const second = await withoutNetwork(() => buildDeterministicDocx({ header, messages, resolveAsset: async () => null }));
  assert.deepEqual(first, second);
  await validateCanonicalDocx(first);
  const zip = await JSZip.loadAsync(first, { checkCRC32: true });
  for (const entry of Object.values(zip.files).filter((part) => !part.dir && (part.name.endsWith(".xml") || part.name.endsWith(".rels")))) {
    const xml = await entry.async("string");
    assert.doesNotThrow(() => xml2js(xml));
  }
  const documentXml = await zip.file("word/document.xml").async("string");
  const rendered = elementText(xml2js(documentXml, { compact: false, alwaysChildren: true }));
  for (const code of ["0000", "000B", "000C", "001B", "D800", "DC00", "FFFF"]) {
    assert.ok(rendered.includes(`[invalid XML character U+${code}]`), code);
  }
  assert.ok(rendered.includes("valid \t tab and 🙂"));
  const relationships = collectElements(xml2js(await zip.file("word/_rels/document.xml.rels").async("string")), "Relationship");
  const hyperlink = relationships.find((relationship) => relationship.attributes?.Type.endsWith("/hyperlink"));
  assert.equal(hyperlink.attributes.Target, "https://openai.com/");
});

test("DOCX XML reserialization preserves query separators and literal entity text", async () => {
  const target = "https://example.invalid/?a=1&b=2&literal=&amp;#part";
  const options = {
    header: createSessionDocumentHeader({ id: "xml-regression" }),
    messages: [createDocumentMessage({ sessionId: "xml-regression", recordOrdinal: 399, role: DOCUMENT_ROLE.ASSISTANT,
      text: `Literal &amp; &lt; & < > \" '. [A &amp; B](${target}).` })], resolveAsset: async () => null,
  };
  const bytes = await withoutNetwork(() => buildDeterministicDocx(options));
  assert.deepEqual(bytes, await buildDeterministicDocx(options));
  const zip = await JSZip.loadAsync(bytes);
  for (const part of Object.values(zip.files).filter(p => p.name.endsWith(".xml") || p.name.endsWith(".rels"))) {
    const xml = await part.async("string");
    assert.doesNotThrow(() => xml2js(xml));
  }
  await validateCanonicalDocx(bytes);
  const rels = collectElements(xml2js(await zip.file("word/_rels/document.xml.rels").async("string")), "Relationship");
  assert.equal(rels.find(r => r.attributes.Type.endsWith("/hyperlink")).attributes.Target, target);
  const doc = xml2js(await zip.file("word/document.xml").async("string"));
  assert.ok(elementText(doc).includes(`Literal &amp; &lt; & < > \" '. A &amp; B (${target}).`));
  for (const control of ["\u0001", "\u000b", "\ufffe"]) {
    const invalid = await JSZip.loadAsync(bytes);
    invalid.file("word/styles.xml", `<root>${control}</root>`);
    const invalidBytes = await invalid.generateAsync({ type: "nodebuffer" });
    await assert.rejects(() => normalizeAndValidateDocx(invalidBytes), e => e.code === "DOCX_XML_INVALID");
  }
});

test("DOCX restarts logical lists, retains explicit starts and resumes nested parents", async () => {
  const messages = [
    createDocumentMessage({sessionId:"lists",recordOrdinal:1,role:DOCUMENT_ROLE.USER,text:"1. first\n2. second\n\ntext\n\n1. new\n2. next\n\n4. explicit\n5. continue\n  7. nested\n  8. nested next\n6. parent"}),
    createDocumentMessage({sessionId:"lists",recordOrdinal:2,role:DOCUMENT_ROLE.ASSISTANT,text:"1. assistant\n2. assistant next"}),
    createDocumentMessage({sessionId:"lists",recordOrdinal:3,role:DOCUMENT_ROLE.TOOL,text:"tool"}),
    createDocumentMessage({sessionId:"lists",recordOrdinal:4,role:DOCUMENT_ROLE.USER,text:"1. after tool"}),
  ];
  const bytes=await buildDeterministicDocx({header:createSessionDocumentHeader({id:"lists"}),messages,resolveAsset:async()=>null});
  const zip=await JSZip.loadAsync(bytes);
  const doc=xml2js(await zip.file("word/document.xml").async("string"));
  const ids=collectElements(doc,"w:numId").map(e=>e.attributes["w:val"]).slice(-12);
  assert.equal(ids[0],ids[1]); assert.notEqual(ids[1],ids[2]); assert.equal(ids[2],ids[3]);
  assert.equal(ids[4],ids[5]); assert.notEqual(ids[5],ids[6]); assert.equal(ids[6],ids[7]); assert.equal(ids[5],ids[8]);
  assert.notEqual(ids[8],ids[9]); assert.notEqual(ids[10],ids[11]);
  const numbering=xml2js(await zip.file("word/numbering.xml").async("string"));
  const starts=collectElements(numbering,"w:start").map(e=>e.attributes["w:val"]);
  assert.ok(starts.includes("4")&&starts.includes("7"));
  assert.equal(collectElements(doc,"w:ilvl").slice(-12)[6].attributes["w:val"],"1");
});

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
      text: "# Heading\n\nUmlaute äöü & < >. Link: [OpenAI](https://openai.com/).\n\nUnsafe: [script](javascript:noop), [data](data:text/plain,secret), [file](file:///C:/secret.txt).\n\n- one\n- two\n\n```js\nconst value = '<&>';\n```",
      attachments: [png, png, jpeg, gif, webp, binary],
    }),
    createDocumentMessage({ sessionId, recordOrdinal: 3, role: DOCUMENT_ROLE.ASSISTANT, label: "Assistant", text: "Second message." }),
    createDocumentMessage({ sessionId, recordOrdinal: 4, role: DOCUMENT_ROLE.UNCLASSIFIED, label: "Unclassified user-role record", text: "Last message." }),
  ];
  const options = { header, messages, resolveAsset: async (reference) => assets.get(reference.sha256) };
  const first = await withoutNetwork(() => buildDeterministicDocx(options));
  const second = await withoutNetwork(() => buildDeterministicDocx(options));
  assert.deepEqual(first, second, "repeated exports must be byte-identical");
  await withoutNetwork(() => validateCanonicalDocx(first));

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
  const parsedRelationships = xml2js(relationships, { compact: false, alwaysChildren: true });
  const hyperlinkRelationships = collectElements(parsedRelationships, "Relationship")
    .filter((element) => element.attributes?.Type === "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink");
  assert.equal(hyperlinkRelationships.length, 1);
  assert.equal(hyperlinkRelationships[0].attributes.TargetMode, "External");
  assert.equal(hyperlinkRelationships[0].attributes.Target, "https://openai.com/");
  assert.equal(hyperlinkRelationships[0].attributes.Id, "rIdHyperlink0001");
  assert.equal(relationships.toLowerCase().includes("file:"), false);
  assert.ok(documentXml.includes("Sitzung äöü &amp; &lt;XML&gt;"));
  assert.ok(documentXml.indexOf("User") < documentXml.indexOf("Assistant") && documentXml.indexOf("Assistant") < documentXml.indexOf("Unclassified user-role record"));
  assert.ok(documentXml.includes("descr=\"Attachment 1 from session record 2\""), "embedded images need alternative text");
  assert.ok(documentXml.includes(`assets/${gif.sha256}.gif`.split("/").at(-1)));
  assert.ok(documentXml.includes(`assets/${webp.sha256}.webp`.split("/").at(-1)));
  assert.ok(documentXml.includes(`assets/${binary.sha256}.bin`.split("/").at(-1)));
  const parsedDocument = xml2js(documentXml, { compact: false, alwaysChildren: true });
  const hyperlinks = collectElements(parsedDocument, "w:hyperlink");
  assert.equal(hyperlinks.length, 1);
  assert.equal(hyperlinks[0].attributes["r:id"], hyperlinkRelationships[0].attributes.Id);
  assert.equal(elementText(hyperlinks[0]), "OpenAI (https://openai.com/)");
  assert.ok(documentXml.includes("script [blocked unsupported-protocol]") && documentXml.includes("data [blocked unsupported-protocol]") && documentXml.includes("file [local file not included]"));
  const hyperlinkParagraph = collectElements(parsedDocument, "w:p").find((paragraph) => collectElements(paragraph, "w:hyperlink").length === 1);
  const directChildren = hyperlinkParagraph.elements.filter((element) => element.type === "element");
  const hyperlinkIndex = directChildren.findIndex((element) => element.name === "w:hyperlink");
  assert.ok(elementText(directChildren[hyperlinkIndex - 1]).endsWith("Link: "), "Link prefix must remain ordinary text");
  assert.equal(elementText(directChildren[hyperlinkIndex + 1]), ".", "final punctuation must remain outside the hyperlink");
  assert.equal(files.some((entry) => ["activex", "embeddings", "vbaproject"].some((part) => entry.name.toLowerCase().includes(part))), false);
});

test("DOCX normalization allows only controlled HTTP(S) hyperlinks and rejects external resources or active content", async () => {
  const header = createSessionDocumentHeader({ id: "session", title: "safe" });
  const safe = await buildDeterministicDocx({ header, messages: [], resolveAsset: async () => null });
  const externalZip = await JSZip.loadAsync(safe);
  const rels = await externalZip.file("word/_rels/document.xml.rels").async("string");
  for (const entity of ["&#0;", "&#x1;", "&#xFFFE;"]) {
    const invalid = await JSZip.loadAsync(safe);
    invalid.file("word/document.xml", (await invalid.file("word/document.xml").async("string")).replace("safe", entity));
    await assert.rejects(() => normalizeAndValidateDocx(invalid.generateAsync({ type: "nodebuffer" })), error => error.code === "DOCX_XML_INVALID");
  }
  externalZip.file("word/_rels/document.xml.rels", rels.replace("</Relationships>", "<Relationship Id=\"rId999\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/image\" Target=\"https://example.invalid/pixel.png\" TargetMode=\"External\"/></Relationships>"));
  await assert.rejects(() => normalizeAndValidateDocx(externalZip.generateAsync({ type: "nodebuffer" })), (error) => error instanceof DocxExportError && error.code === "DOCX_EXTERNAL_RELATIONSHIP");

  const disguisedExternalZip = await JSZip.loadAsync(safe);
  disguisedExternalZip.file("word/_rels/document.xml.rels", rels.replace("</Relationships>", "<Relationship Id=\"rId998\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink\" Target=\"https://example.invalid/without-target-mode\"/></Relationships>"));
  await assert.rejects(() => normalizeAndValidateDocx(disguisedExternalZip.generateAsync({ type: "nodebuffer" })), (error) => error instanceof DocxExportError && error.code === "DOCX_EXTERNAL_RELATIONSHIP");

  for (const [ordinal, target] of ["file:///C:/secret.txt", "javascript:alert(1)", "data:text/plain,secret", "ftp://example.invalid/file", "//server/share"].entries()) {
    const unsafeZip = await JSZip.loadAsync(safe);
    unsafeZip.file("word/_rels/document.xml.rels", rels.replace("</Relationships>", `<Relationship Id="rIdUnsafe${ordinal}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${target}" TargetMode="External"/></Relationships>`));
    await assert.rejects(() => normalizeAndValidateDocx(unsafeZip.generateAsync({ type: "nodebuffer" })), (error) => error instanceof DocxExportError && error.code === "DOCX_EXTERNAL_RELATIONSHIP", target);
  }

  const drivePathZip = await JSZip.loadAsync(safe);
  drivePathZip.file("word/_rels/document.xml.rels", rels.replace("</Relationships>", "<Relationship Id=\"rId997\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/image\" Target=\"C:/secret.png\"/></Relationships>"));
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

test("DOCX hyperlink relationship IDs and order stay deterministic for multiple links", async () => {
  const sessionId = "ordered-links";
  const header = createSessionDocumentHeader({ id: sessionId, title: "Ordered links" });
  const messages = [createDocumentMessage({
    sessionId,
    recordOrdinal: 1,
    role: DOCUMENT_ROLE.USER,
    label: "User",
    text: "[First](https://openai.com/) then [Second](http://example.com/path).",
  })];
  const options = { header, messages, resolveAsset: async () => null };
  const first = await buildDeterministicDocx(options);
  const second = await buildDeterministicDocx(options);
  assert.deepEqual(first, second);
  const zip = await JSZip.loadAsync(first, { checkCRC32: true });
  const relationships = collectElements(xml2js(await zip.file("word/_rels/document.xml.rels").async("string"), { compact: false, alwaysChildren: true }), "Relationship")
    .filter((element) => element.attributes?.Type.endsWith("/hyperlink"));
  assert.deepEqual(relationships.map((element) => [element.attributes.Id, element.attributes.Target]), [
    ["rIdHyperlink0001", "https://openai.com/"],
    ["rIdHyperlink0002", "http://example.com/path"],
  ]);
  const hyperlinks = collectElements(xml2js(await zip.file("word/document.xml").async("string"), { compact: false, alwaysChildren: true }), "w:hyperlink");
  assert.deepEqual(hyperlinks.map((element) => element.attributes["r:id"]), ["rIdHyperlink0001", "rIdHyperlink0002"]);
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
