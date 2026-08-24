import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import JSZip from "jszip";

import { exportArchive, INCOMPLETE_MARKER_NAME } from "../bin/export-codex-project-chats.mjs";
import { writeReadingOutputFixture } from "./fixtures/reading-output/sessions.mjs";

const execFileAsync = promisify(execFile);

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
    { type: "response_item", timestamp: "2026-08-24T10:00:01.000Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# Überschrift\n\nÄ & <XML>\n\n- eins\n- zwei\n\n[Link](https://example.invalid)\n\n```js\nconst x = '<&>';\n```" }], internal_chat_message_metadata_passthrough: { turn_id: "turn-1" } } },
    { type: "event_msg", timestamp: "2026-08-24T10:00:01.001Z", payload: { type: "user_message", message: "# Überschrift\n\nÄ & <XML>\n\n- eins\n- zwei\n\n[Link](https://example.invalid)\n\n```js\nconst x = '<&>';\n```" } },
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
      assert.equal((await zip.file("word/_rels/document.xml.rels").async("string")).includes("TargetMode=\"External\""), false);
    }
    assert.equal(await fs.stat(path.join(firstOutput, INCOMPLETE_MARKER_NAME)).then(() => true, () => false), false);
    assert.equal((await listFiles(firstOutput)).some((file) => file.includes(".partial-") || file.includes(".previous-")), false);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("single-session DOCX preserves ordering and document constructs without active relationships", async () => {
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
    assert.equal(rels.includes("TargetMode=\"External\""), false);
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

test("document formats are explicit and reject unknown or duplicate selections", async () => {
  await assert.rejects(() => exportArchive({ scope: "all", documentFormats: ["pdf"] }), (error) => error.code === "INVALID_EXPORT_FORMAT");
  await assert.rejects(() => exportArchive({ scope: "all", documentFormats: ["docx", "docx"] }), (error) => error.code === "INVALID_EXPORT_FORMAT");
  await assert.rejects(() => exportArchive({ scope: "all", documentFormats: "docx" }), (error) => error.code === "INVALID_EXPORT_FORMAT");
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
