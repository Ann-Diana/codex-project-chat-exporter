import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import JSZip from "jszip";
import { Packer } from "docx";
import xmlJs from "xml-js";

import { exportArchive, INCOMPLETE_MARKER_NAME, resolveDocumentFormats } from "../bin/export-codex-project-chats.mjs";
import { ACTIVE_SESSION_ID, writeReadingOutputFixture } from "./fixtures/reading-output/sessions.mjs";

const execFileAsync = promisify(execFile);
const { xml2js } = xmlJs;

function relationshipElements(xml) {
  const parsed = xml2js(xml, { compact: false, alwaysChildren: true });
  const result = [];
  function visit(value) {
    if (!value || typeof value !== "object") return;
    if (value.type === "element" && value.name === "Relationship") result.push(value);
    for (const child of value.elements || []) visit(child);
  }
  visit(parsed);
  return result;
}

async function listFiles(root) {
  const output = [];
  async function walk(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else output.push(path.relative(root, absolute).replaceAll("\\", "/"));
    }
  }
  await walk(root);
  return output.sort();
}

async function writeSingleSession(codexHome) {
  const sessionId = "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa";
  const directory = path.join(codexHome, "sessions", "2026", "08", "24");
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, `rollout-2026-08-24T10-00-00-${sessionId}.jsonl`);
  const items = [
    { type: "session_meta", timestamp: "2026-08-24T10:00:00.000Z", payload: { id: sessionId, cwd: "C:\\Projects\\single", timestamp: "2026-08-24T10:00:00.000Z", source: "vscode", thread_source: "user" } },
    { type: "response_item", timestamp: "2026-08-24T10:00:01.000Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# Überschrift\n\nÄ & <XML>\n\n- eins\n- zwei\n\nLink: [OpenAI](https://openai.com/).\n\n```js\nconst x = '<&>';\n```" }], internal_chat_message_metadata_passthrough: { turn_id: "turn-1" } } },
    { type: "event_msg", timestamp: "2026-08-24T10:00:01.001Z", payload: { type: "user_message", message: "# Überschrift\n\nÄ & <XML>\n\n- eins\n- zwei\n\nLink: [OpenAI](https://openai.com/).\n\n```js\nconst x = '<&>';\n```" } },
    { type: "response_item", timestamp: "2026-08-24T10:00:02.000Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Antwort äöü." }] } },
  ];
  await fs.writeFile(file, `${items.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
  return { file, sessionId };
}

test("opt-in DOCX export creates exactly one deterministic document per session", async () => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "docx-export-integration-")));
  try {
    const codexHome = path.join(temp, ".codex");
    await writeReadingOutputFixture(codexHome);
    const firstOutput = path.join(temp, "first");
    const secondOutput = path.join(temp, "second");
    const first = await exportArchive({ codexHome, scope: "all", outputDirectory: firstOutput, exportProfile: "readable", includeTools: true, documentFormats: ["docx"] });
    const second = await exportArchive({ codexHome, scope: "all", outputDirectory: secondOutput, exportProfile: "readable", includeTools: true, documentFormats: ["docx"] });
    const firstManifest = JSON.parse(await fs.readFile(first.manifestPath, "utf8"));
    const secondManifest = JSON.parse(await fs.readFile(second.manifestPath, "utf8"));
    assert.equal(firstManifest.formats.docx, true);
    assert.equal(firstManifest.sessions.length, 3);
    assert.equal(new Set(firstManifest.sessions.map((session) => session.docx_file)).size, 3);
    assert.ok(firstManifest.sessions.every((session) => session.docx_file.startsWith(`docx${path.sep}`) && session.docx_file.endsWith(".docx")));
    assert.equal((await listFiles(firstOutput)).filter((file) => file.endsWith(".docx")).length, 3);
    for (let index = 0; index < firstManifest.sessions.length; index += 1) {
      const left = await fs.readFile(path.join(firstOutput, firstManifest.sessions[index].docx_file));
      const right = await fs.readFile(path.join(secondOutput, secondManifest.sessions[index].docx_file));
      assert.deepEqual(left, right, "equivalent exports into different folders must be byte-identical");
      const zip = await JSZip.loadAsync(left, { checkCRC32: true });
      assert.ok(zip.file("word/document.xml"));
      if (firstManifest.sessions[index].session_id === ACTIVE_SESSION_ID) {
        const xml = await zip.file("word/document.xml").async("string");
        assert.ok(xml.includes("Models: ") && xml.includes("gpt-5.5 → gpt-5.6-sol"), "the packaged session pipeline must place the full model history in DOCX metadata");
      }
      const relationships = relationshipElements(await zip.file("word/_rels/document.xml.rels").async("string"));
      assert.ok(relationships.filter((relationship) => relationship.attributes?.TargetMode === "External").every((relationship) => relationship.attributes?.Type.endsWith("/hyperlink") && ["http:", "https:"].includes(new URL(relationship.attributes.Target).protocol)));
    }
    assert.equal(await fs.stat(path.join(firstOutput, INCOMPLETE_MARKER_NAME)).then(() => true, () => false), false);
    assert.equal((await listFiles(firstOutput)).some((file) => file.includes(".partial-") || file.includes(".previous-")), false);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("DOCX and PDF can be rendered and validated together without changing archive format v1", async () => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "document-pair-export-")));
  try {
    const codexHome = path.join(temp, "source");
    await writeSingleSession(codexHome);
    const first = await exportArchive({ codexHome, scope: "all", outputDirectory: path.join(temp, "first"), exportProfile: "readable", documentFormats: ["pdf", "docx"] });
    const second = await exportArchive({ codexHome, scope: "all", outputDirectory: path.join(temp, "second"), exportProfile: "readable", documentFormats: ["docx", "pdf"] });
    assert.deepEqual(first.formats, second.formats);
    assert.equal(first.formats.docx, true);
    assert.equal(first.formats.pdf, true);
    const firstDocx = first.rows[0].docx_file;
    const firstPdf = first.rows[0].pdf_file;
    const secondDocx = second.rows[0].docx_file;
    const secondPdf = second.rows[0].pdf_file;
    assert.deepEqual(await fs.readFile(path.join(first.outputDirectory, firstDocx)), await fs.readFile(path.join(second.outputDirectory, secondDocx)));
    assert.deepEqual(await fs.readFile(path.join(first.outputDirectory, firstPdf)), await fs.readFile(path.join(second.outputDirectory, secondPdf)));
    const manifest = JSON.parse(await fs.readFile(first.manifestPath, "utf8"));
    assert.equal(manifest.archive_format_version, 1);
    assert.equal(manifest.formats.docx, true);
    assert.equal(manifest.formats.pdf, true);
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});

test("single-session DOCX preserves ordering, constructs, and controlled hyperlink relationships", async () => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "docx-single-")));
  try {
    const codexHome = path.join(temp, ".codex");
    await writeSingleSession(codexHome);
    const output = path.join(temp, "output");
    const result = await exportArchive({ codexHome, scope: "all", outputDirectory: output, exportProfile: "source-snapshots", documentFormats: ["docx"] });
    const manifest = JSON.parse(await fs.readFile(result.manifestPath, "utf8"));
    assert.equal(manifest.sessions.length, 1);
    assert.equal(manifest.sessions[0].markdown_file, "");
    assert.ok(manifest.sessions[0].docx_file);
    const bytes = await fs.readFile(path.join(output, manifest.sessions[0].docx_file));
    const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
    const xml = await zip.file("word/document.xml").async("string");
    const rels = await zip.file("word/_rels/document.xml.rels").async("string");
    assert.ok(xml.indexOf("User") < xml.indexOf("Assistant"));
    assert.ok(xml.includes("Überschrift") && xml.includes("Ä &amp; &lt;XML&gt;") && xml.includes("Antwort äöü."));
    assert.ok(xml.includes("w:numPr"), "lists must use real OOXML numbering");
    assert.ok(xml.includes("Consolas"), "code blocks must use the code style");
    const externalRelationships = relationshipElements(rels).filter((relationship) => relationship.attributes?.TargetMode === "External");
    assert.equal(externalRelationships.length, 1);
    assert.equal(externalRelationships[0].attributes.Type, "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink");
    assert.equal(externalRelationships[0].attributes.Target, "https://openai.com/");
    assert.ok(xml.includes(`<w:hyperlink w:history="1" r:id="${externalRelationships[0].attributes.Id}">`));
    assert.equal(rels.toLowerCase().includes("file:"), false);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("DOCX failures preserve existing targets and remove run-owned temporary files", async () => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "docx-failure-")));
  try {
    const codexHome = path.join(temp, ".codex");
    await writeSingleSession(codexHome);
    for (const code of ["EACCES", "ENOSPC"]) {
      const output = path.join(temp, code.toLowerCase());
      const writeBuffer = async () => { throw Object.assign(new Error(`synthetic ${code}`), { code }); };
      await assert.rejects(() => exportArchive({ codexHome, scope: "all", outputDirectory: output, exportProfile: "readable", documentFormats: ["docx"], _docxOptions: { writeBuffer } }), (error) => error.code === code);
      const files = await listFiles(output);
      assert.equal(files.some((file) => file.endsWith(".docx") || file.includes(".partial-") || file.includes(".previous-")), false, `${code} must not leave a document or run-owned temporary file`);
    }

    const collisionOutput = path.join(temp, "collision");
    const existing = path.join(collisionOutput, "docx", "p001-single", "s0001.docx");
    await fs.mkdir(path.dirname(existing), { recursive: true });
    const sentinel = Buffer.from("existing-docx-sentinel");
    await fs.writeFile(existing, sentinel);
    await assert.rejects(() => exportArchive({ codexHome, scope: "all", outputDirectory: collisionOutput, exportProfile: "readable", documentFormats: ["docx"] }), (error) => error.code === "UNOWNED_EXPORT_FILE");
    assert.deepEqual(await fs.readFile(existing), sentinel, "an existing DOCX target must never be silently overwritten");
    const files = await listFiles(collisionOutput);
    assert.equal(files.some((file) => file.includes(".partial-") || file.includes(".previous-")), false);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("diagnosed ANSI SGR input is removed only from DOCX while Raw JSONL stays byte-identical", async () => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "docx-xml-controls-")));
  try {
    const codexHome = path.join(temp, ".codex");
    const { file } = await writeSingleSession(codexHome);
    const records = (await fs.readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const diagnosed = "# Heading\u000c\n\n- List\u001b[31m\n\n[Label\u000b](https://openai.com/).\n\nMessage\u0000 and valid \t \r \n 🙂.";
    records[1].payload.content[0].text = diagnosed;
    records[2].payload.message = diagnosed;
    const source = Buffer.from(`${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
    await fs.writeFile(file, source);
    const outputDirectory = path.join(temp, "output");
    const result = await exportArchive({ codexHome, scope: "all", outputDirectory, exportProfile: "complete", documentFormats: ["docx"] });
    const manifest = JSON.parse(await fs.readFile(result.manifestPath, "utf8"));
    const rawFile = (await listFiles(outputDirectory)).find((name) => name.endsWith(".jsonl"));
    assert.deepEqual(await fs.readFile(path.join(outputDirectory, rawFile)), source);
    const zip = await JSZip.loadAsync(await fs.readFile(path.join(outputDirectory, manifest.sessions[0].docx_file)), { checkCRC32: true });
    const documentXml = await zip.file("word/document.xml").async("string");
    for (const code of ["0000", "000B", "000C"]) assert.ok(documentXml.includes(`[invalid XML character U+${code}]`), code);
    assert.equal(documentXml.includes("[invalid XML character U+001B]"), false);
    assert.equal(documentXml.includes("[31m"), false);
    for (const entry of Object.values(zip.files)) if (!entry.dir && (entry.name.endsWith(".xml") || entry.name.endsWith(".rels"))) xml2js(await entry.async("string"));
    assert.equal(await fs.stat(path.join(outputDirectory, INCOMPLETE_MARKER_NAME)).then(() => true, () => false), false);
    assert.equal((await listFiles(outputDirectory)).some((name) => name.includes(".partial-") || name.includes(".previous-")), false);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("invalid packed OOXML publishes no failed DOCX or temporary file and leaves the generation visibly incomplete", async () => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "docx-invalid-package-cleanup-")));
  try {
    const codexHome = path.join(temp, ".codex");
    await writeSingleSession(codexHome);
    const outputDirectory = path.join(temp, "output");
    const invalidPacker = {
      async toBuffer(document) {
        const bytes = await Packer.toBuffer(document);
        const zip = await JSZip.loadAsync(bytes);
        const xml = await zip.file("word/document.xml").async("string");
        zip.file("word/document.xml", xml.replace("</w:body>", "\u001b</w:body>"));
        return zip.generateAsync({ type: "nodebuffer" });
      },
    };
    await assert.rejects(
      () => exportArchive({ codexHome, scope: "all", outputDirectory, exportProfile: "readable", documentFormats: ["docx"], _docxOptions: { packer: invalidPacker } }),
      (error) => error.code === "DOCX_XML_INVALID",
    );
    const files = await listFiles(outputDirectory);
    assert.equal(files.some((name) => name.endsWith(".docx") || name.includes(".partial-") || name.includes(".previous-")), false);
    assert.ok(files.includes(INCOMPLETE_MARKER_NAME));
    assert.equal(files.includes("manifest.json"), false);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("document formats are explicit and reject unknown or duplicate selections", async () => {
  await assert.rejects(() => exportArchive({ scope: "all", documentFormats: ["epub"] }), (error) => error.code === "INVALID_EXPORT_FORMAT");
  await assert.rejects(() => exportArchive({ scope: "all", documentFormats: ["docx", "docx"] }), (error) => error.code === "INVALID_EXPORT_FORMAT");
  await assert.rejects(() => exportArchive({ scope: "all", documentFormats: ["docx", "pdf", "epub"] }), (error) => error.code === "INVALID_EXPORT_FORMAT");
  assert.deepEqual(resolveDocumentFormats("docx"), ["docx"]);
  assert.deepEqual(resolveDocumentFormats("pdf"), ["pdf"]);
  assert.deepEqual(resolveDocumentFormats("docx,pdf"), ["docx", "pdf"]);
  assert.deepEqual(resolveDocumentFormats("pdf,docx"), ["docx", "pdf"]);
  assert.deepEqual(resolveDocumentFormats(["pdf", "docx"]), ["docx", "pdf"]);
  assert.deepEqual(resolveDocumentFormats([]), []);
});

test("paired image markers disappear only from reading views while raw bytes and literal examples survive", async () => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "image-marker-export-")));
  try {
    const codexHome = path.join(temp, "source");
    const { file } = await writeSingleSession(codexHome);
    const records = (await fs.readFile(file, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const image = { type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aCioAAAAASUVORK5CYII=" };
    const text = value => ({ type: "input_text", text: value });
    records[1].payload.content = [text("1. Before image\n2. Second"), text("<image name=[Image #1]>"), image, text("</image>")];
    records[2].payload.message = "1. Before image\n2. Second";
    records[3].payload.content = [text("1. After image\n2. Second\n\n```text\n<image>\n</image>\n```\n\nQuelle — ‘Zitat’ **fett**")];
    const source = Buffer.from(records.map(record => JSON.stringify(record)).join("\n") + "\n");
    await fs.writeFile(file, source);
    const outputDirectory = path.join(temp, "output");
    const result = await exportArchive({ codexHome, scope: "all", outputDirectory, exportProfile: "complete", documentFormats: ["docx"] });
    const manifest = JSON.parse(await fs.readFile(result.manifestPath, "utf8"));
    const session = manifest.sessions[0];
    const rawFile = (await listFiles(outputDirectory)).find(name => name.endsWith(".jsonl"));
    assert.deepEqual(await fs.readFile(path.join(outputDirectory, rawFile)), source);
    const markdown = await fs.readFile(path.join(outputDirectory, session.markdown_file), "utf8");
    assert.equal(markdown.includes("<image name="), false);
    assert.ok(markdown.includes("```text\n<image>\n</image>\n```") && markdown.includes("Quelle — ‘Zitat’ **fett**"));
    const zip = await JSZip.loadAsync(await fs.readFile(path.join(outputDirectory, session.docx_file)));
    assert.equal(Object.keys(zip.files).filter(name => name.startsWith("word/media/") && !zip.files[name].dir).length, 1);
    const xml = await zip.file("word/document.xml").async("string");
    assert.equal(xml.includes("image name="), false);
    assert.ok(xml.includes("&lt;image&gt;") && xml.includes("&lt;/image&gt;"));
    for (const entry of Object.values(zip.files)) if (!entry.dir && (entry.name.endsWith(".xml") || entry.name.endsWith(".rels"))) xml2js(await entry.async("string"));
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});

test("CLI --format docx uses the same explicit export contract", async () => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "docx-cli-")));
  try {
    const codexHome = path.join(temp, ".codex");
    await writeSingleSession(codexHome);
    const output = path.join(temp, "output");
    const executable = path.resolve("bin", "export-codex-project-chats.mjs");
    await execFileAsync(process.execPath, [executable, "--all", "--codex-home", codexHome, "--out", output, "--profile", "readable", "--format", "docx"], { encoding: "utf8" });
    const manifest = JSON.parse(await fs.readFile(path.join(output, "manifest.json"), "utf8"));
    assert.equal(manifest.formats.docx, true);
    assert.equal(manifest.sessions.length, 1);
    assert.ok(manifest.sessions[0].docx_file && await fs.stat(path.join(output, manifest.sessions[0].docx_file)).then((stat) => stat.isFile()));
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});
