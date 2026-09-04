import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import JSZip from "jszip";
import xmlJs from "xml-js";

import { exportArchive } from "../bin/export-codex-project-chats.mjs";
import { validateCanonicalPdf } from "../lib/pdf-renderer.mjs";

const { xml2js } = xmlJs;
const execFileAsync = promisify(execFile);

function elementText(value) {
  if (!value || typeof value !== "object") return "";
  if (value.type === "text") return String(value.text || "");
  return (value.elements || []).map(elementText).join("");
}

function elements(value, name, output = []) {
  if (!value || typeof value !== "object") return output;
  if (value.type === "element" && value.name === name) output.push(value);
  for (const child of value.elements || []) elements(child, name, output);
  return output;
}

async function writeFixture(codexHome) {
  const id = "44444444-4444-7444-8444-444444444444";
  const directory = path.join(codexHome, "sessions", "2026", "08", "30");
  await fs.mkdir(directory, { recursive: true });
  const citation = [
    "<oai-mem-citation>",
    "<citation_entries>",
    "MEMORY.md:1-2|note=[synthetic]",
    "</citation_entries>",
    "<rollout_ids>",
    "44444444-4444-7444-8444-444444444444",
    "</rollout_ids>",
    "</oai-mem-citation>",
  ].join("\n");
  const unsupported = String.fromCodePoint(0x10ffff);
  const user = [
    "\tNatural — prose begins here.",
    "",
    "– first point",
    "– second point",
    "",
    "Announcement:",
    "- announced point",
    "  * nested point",
    "",
    "Inline `literal — code` remains — prose.",
    "",
    "```text",
    "fenced — technical",
    "```",
    "",
    "├── tree-one",
    "│   └── tree-two",
    "└── tree-three",
  ].join("\n");
  const assistant = `Visible before — prose. ${unsupported}\n${citation}\nVisible after — prose.`;
  const records = [
    { type: "session_meta", timestamp: "2026-08-30T10:00:00.000Z", payload: { id, cwd: "C:\\Projects\\readable", timestamp: "2026-08-30T10:00:00.000Z", source: "vscode", thread_source: "user" } },
    { type: "turn_context", timestamp: "2026-08-30T10:00:00.500Z", payload: { cwd: "C:\\Projects\\readable", model: "gpt-5.5" } },
    { type: "response_item", timestamp: "2026-08-30T10:00:01.000Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: user }], internal_chat_message_metadata_passthrough: { turn_id: "turn-readable" } } },
    { type: "event_msg", timestamp: "2026-08-30T10:00:01.001Z", payload: { type: "user_message", message: user } },
    { type: "response_item", timestamp: "2026-08-30T10:00:02.000Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: assistant }] } },
  ];
  const bytes = Buffer.from(`${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  const file = path.join(directory, `rollout-2026-08-30T10-00-00-${id}.jsonl`);
  await fs.writeFile(file, bytes);
  return { bytes, citation, id, unsupported };
}

test("Readable text semantics are shared by Markdown, DOCX, and PDF while Complete and Raw stay source-faithful", async (t) => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "readable-text-semantics-")));
  try {
    const codexHome = path.join(temp, ".codex");
    const fixture = await writeFixture(codexHome);
    const readableRoot = path.join(temp, "readable-docx");
    const readablePdfRoot = path.join(temp, "readable-pdf");
    const completeRoot = path.join(temp, "complete-docx");
    const completePdfRoot = path.join(temp, "complete-pdf");
    const readableResult = await exportArchive({ codexHome, scope: "all", outputDirectory: readableRoot, exportProfile: "readable", documentFormats: ["docx"] });
    const readablePdfResult = await exportArchive({ codexHome, scope: "all", outputDirectory: readablePdfRoot, exportProfile: "readable", documentFormats: ["pdf"] });
    const completeResult = await exportArchive({ codexHome, scope: "all", outputDirectory: completeRoot, exportProfile: "complete", documentFormats: ["docx"] });
    const completePdfResult = await exportArchive({ codexHome, scope: "all", outputDirectory: completePdfRoot, exportProfile: "complete", documentFormats: ["pdf"] });
    const readableManifest = JSON.parse(await fs.readFile(readableResult.manifestPath, "utf8"));
    const completeManifest = JSON.parse(await fs.readFile(completeResult.manifestPath, "utf8"));
    const readablePdfManifest = JSON.parse(await fs.readFile(readablePdfResult.manifestPath, "utf8"));
    const completePdfManifest = JSON.parse(await fs.readFile(completePdfResult.manifestPath, "utf8"));
    const readableSession = readableManifest.sessions.find((session) => session.session_id === fixture.id);
    const completeSession = completeManifest.sessions.find((session) => session.session_id === fixture.id);
    const readablePdfSession = readablePdfManifest.sessions.find((session) => session.session_id === fixture.id);
    const completePdfSession = completePdfManifest.sessions.find((session) => session.session_id === fixture.id);
    assert.ok(readableSession.title.includes("Natural – prose"));
    assert.ok(completeSession.title.includes("Natural — prose"));

    const readableMarkdown = await fs.readFile(path.join(readableRoot, readableSession.markdown_file), "utf8");
    const completeMarkdown = await fs.readFile(path.join(completeRoot, completeSession.markdown_file), "utf8");
    assert.equal(readableMarkdown.includes("oai-mem-citation"), false);
    assert.ok(readableMarkdown.includes("Natural – prose") && readableMarkdown.includes("Visible before – prose") && readableMarkdown.includes("Visible after – prose"));
    assert.ok(readableMarkdown.includes(fixture.unsupported), "non-PDF reading formats must retain an unsupported PDF glyph verbatim");
    assert.ok(readableMarkdown.includes("`literal — code`") && readableMarkdown.includes("fenced — technical"));
    assert.ok(readableMarkdown.includes("– first point\n– second point"));
    assert.ok(readableMarkdown.includes("```text\n├── tree-one\n│   └── tree-two\n└── tree-three\n```"));
    assert.ok(completeMarkdown.includes("oai-mem-citation") && completeMarkdown.includes("Natural — prose"));

    const readableDocx = await JSZip.loadAsync(await fs.readFile(path.join(readableRoot, readableSession.docx_file)), { checkCRC32: true });
    const completeDocx = await JSZip.loadAsync(await fs.readFile(path.join(completeRoot, completeSession.docx_file)), { checkCRC32: true });
    const readableDocument = xml2js(await readableDocx.file("word/document.xml").async("string"), { compact: false, alwaysChildren: true });
    const completeDocumentText = elementText(xml2js(await completeDocx.file("word/document.xml").async("string"), { compact: false, alwaysChildren: true }));
    const readableDocumentText = elementText(readableDocument);
    assert.equal(readableDocumentText.includes("oai-mem-citation"), false);
    assert.ok(readableDocumentText.includes("Natural – prose") && readableDocumentText.includes("literal — code"));
    assert.ok(readableDocumentText.includes(fixture.unsupported), "DOCX must retain an unsupported PDF glyph verbatim");
    assert.ok(completeDocumentText.includes("oai-mem-citation") && completeDocumentText.includes("Natural — prose") && completeDocumentText.includes(fixture.unsupported));
    const paragraphs = elements(readableDocument, "w:p");
    for (const point of ["first point", "second point", "announced point", "nested point"]) {
      assert.equal(paragraphs.filter((paragraph) => elementText(paragraph) === point).length, 1, `${point} must have one distinct DOCX paragraph`);
    }
    const treeParagraph = paragraphs.find((paragraph) => elementText(paragraph).includes("├── tree-one"));
    assert.equal(elements(treeParagraph, "w:br").length, 2);

    const readablePdfPath = path.join(readablePdfRoot, readablePdfSession.pdf_file);
    const completePdfPath = path.join(completePdfRoot, completePdfSession.pdf_file);
    validateCanonicalPdf(await fs.readFile(readablePdfPath));
    validateCanonicalPdf(await fs.readFile(completePdfPath));
    const popplerBin = process.env.POPPLER_BIN || "";
    const pdftotext = popplerBin ? path.join(popplerBin, process.platform === "win32" ? "pdftotext.exe" : "pdftotext") : "pdftotext";
    try {
      const readableText = (await execFileAsync(pdftotext, ["-enc", "UTF-8", readablePdfPath, "-"], { encoding: "utf8" })).stdout;
      const completeText = (await execFileAsync(pdftotext, ["-enc", "UTF-8", completePdfPath, "-"], { encoding: "utf8" })).stdout;
      assert.equal(readableText.includes("oai-mem-citation"), false);
      assert.ok(readableText.includes("Natural – prose") && readableText.includes("literal — code"));
      assert.ok(readableText.includes("[unsupported glyph U+10FFFF]") && !readableText.includes(fixture.unsupported));
      assert.ok(completeText.includes("oai-mem-citation") && completeText.includes("Natural — prose"));
    } catch (error) {
      if (error?.code === "ENOENT") t.diagnostic("Poppler text extraction unavailable; renderer-level selectable-text tests remain authoritative");
      else throw error;
    }

    const exportedRaw = await fs.readFile(path.join(completeRoot, completeSession.raw_export_file));
    assert.deepEqual(exportedRaw, fixture.bytes);
    assert.equal(completeSession.raw_sha256, createHash("sha256").update(fixture.bytes).digest("hex"));
    const assetsManifest = JSON.parse(await fs.readFile(path.join(readableRoot, readableManifest.assets_manifest), "utf8"));
    assert.deepEqual(Object.keys(assetsManifest).sort(), ["assets", "hash_algorithm", "schema_version"]);
    const html = await fs.readFile(path.join(readableRoot, "index.html"), "utf8");
    assert.equal(html.includes("oai-mem-citation"), false, "the metadata-only responsive index must not surface message internals");
    assert.ok(html.includes("Natural – prose") && !html.includes("Natural — prose"), "the Readable HTML title must share the prose normalization");
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});
