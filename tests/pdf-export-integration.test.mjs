import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { exportArchive, INCOMPLETE_MARKER_NAME } from "../bin/export-codex-project-chats.mjs";
import { validateCanonicalPdf } from "../lib/pdf-renderer.mjs";
import { ACTIVE_SESSION_ID, writeReadingOutputFixture } from "./fixtures/reading-output/sessions.mjs";

const execFileAsync = promisify(execFile);
const EXPECTED_MODEL_HISTORY = ["gpt-5.5", "gpt-5.6-sol"];

function includesExtractedModelHistory(text, models) {
  return text.replace(/\s+/gu, " ").includes(`Models: ${models.join(" → ")}`);
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
  const text = "# Überschrift\n\nÄ & <PDF> →\n\n- eins\n- zwei\n\nLink: [OpenAI](https://openai.com/).\n\n```js\nconst x = '<&>';\n```";
  const items = [
    { type: "session_meta", timestamp: "2026-08-24T10:00:00.000Z", payload: { id: sessionId, cwd: "C:\\Projects\\single", timestamp: "2026-08-24T10:00:00.000Z", source: "vscode", thread_source: "user" } },
    { type: "response_item", timestamp: "2026-08-24T10:00:01.000Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text }], internal_chat_message_metadata_passthrough: { turn_id: "turn-1" } } },
    { type: "event_msg", timestamp: "2026-08-24T10:00:01.001Z", payload: { type: "user_message", message: text } },
    { type: "response_item", timestamp: "2026-08-24T10:00:02.000Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Antwort äöü." }] } },
  ];
  await fs.writeFile(file, `${items.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
  return { file, sessionId };
}

test("extracted model history tolerates layout whitespace but rejects a missing stage", () => {
  assert.equal(includesExtractedModelHistory("Models:\r\n gpt-5.5\t→  gpt-5.6-sol", EXPECTED_MODEL_HISTORY), true);
  assert.equal(includesExtractedModelHistory("Models: gpt-5.5", EXPECTED_MODEL_HISTORY), false);
  assert.equal(includesExtractedModelHistory("Models: gpt-5.6-sol", EXPECTED_MODEL_HISTORY), false);
});

test("opt-in PDF export creates exactly one byte-identical document per session", async (t) => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pdf-export-integration-")));
  try {
    const codexHome = path.join(temp, ".codex");
    await writeReadingOutputFixture(codexHome);
    const firstOutput = path.join(temp, "first");
    const secondOutput = path.join(temp, "second");
    const first = await exportArchive({ codexHome, scope: "all", outputDirectory: firstOutput, exportProfile: "readable", includeTools: true, documentFormats: ["pdf"] });
    const second = await exportArchive({ codexHome, scope: "all", outputDirectory: secondOutput, exportProfile: "readable", includeTools: true, documentFormats: ["pdf"] });
    const firstManifest = JSON.parse(await fs.readFile(first.manifestPath, "utf8"));
    const secondManifest = JSON.parse(await fs.readFile(second.manifestPath, "utf8"));
    assert.equal(firstManifest.formats.pdf, true);
    assert.equal(firstManifest.formats.docx, false);
    assert.equal(firstManifest.sessions.length, 3);
    assert.equal(new Set(firstManifest.sessions.map((session) => session.pdf_file)).size, 3);
    assert.ok(firstManifest.sessions.every((session) => session.pdf_file.startsWith(`pdf${path.sep}`) && session.pdf_file.endsWith(".pdf")));
    assert.equal((await listFiles(firstOutput)).filter((file) => file.endsWith(".pdf")).length, 3);
    for (let index = 0; index < firstManifest.sessions.length; index += 1) {
      const left = await fs.readFile(path.join(firstOutput, firstManifest.sessions[index].pdf_file));
      const right = await fs.readFile(path.join(secondOutput, secondManifest.sessions[index].pdf_file));
      assert.deepEqual(left, right, "equivalent exports into different folders must be byte-identical");
      validateCanonicalPdf(left);
      if (firstManifest.sessions[index].session_id === ACTIVE_SESSION_ID) {
        const pdfPath = path.join(firstOutput, firstManifest.sessions[index].pdf_file);
        const popplerBin = process.env.POPPLER_BIN || "";
        const executable = popplerBin ? path.join(popplerBin, process.platform === "win32" ? "pdftotext.exe" : "pdftotext") : "pdftotext";
        try {
          const { stdout } = await execFileAsync(executable, ["-enc", "UTF-8", pdfPath, "-"], { encoding: "utf8" });
          assert.ok(includesExtractedModelHistory(stdout, EXPECTED_MODEL_HISTORY), "the exported PDF must expose the full model history as selectable text");
        } catch (error) {
          if (error?.code === "ENOENT") t.diagnostic("Poppler text extraction unavailable; renderer-level selectable-text regression remains authoritative");
          else throw error;
        }
      }
    }
    assert.equal(await fs.stat(path.join(firstOutput, INCOMPLETE_MARKER_NAME)).then(() => true, () => false), false);
    assert.equal((await listFiles(firstOutput)).some((file) => file.includes(".partial-") || file.includes(".previous-")), false);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("single-session PDF follows source-snapshot naming and emits only controlled URI actions", async () => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pdf-single-")));
  try {
    const codexHome = path.join(temp, ".codex");
    await writeSingleSession(codexHome);
    const output = path.join(temp, "output");
    const result = await exportArchive({ codexHome, scope: "all", outputDirectory: output, exportProfile: "source-snapshots", documentFormats: ["pdf"] });
    const manifest = JSON.parse(await fs.readFile(result.manifestPath, "utf8"));
    assert.equal(manifest.sessions.length, 1);
    assert.equal(manifest.sessions[0].markdown_file, "");
    assert.ok(manifest.sessions[0].pdf_file);
    const bytes = await fs.readFile(path.join(output, manifest.sessions[0].pdf_file));
    const source = bytes.toString("latin1");
    assert.ok(source.includes("/S /URI") && source.includes("/URI (https://openai.com/)"));
    assert.equal(source.toLowerCase().includes("file:"), false);
    assert.equal(source.includes("/Launch") || source.includes("/JavaScript") || source.includes("/EmbeddedFile"), false);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("PDF publication failures preserve existing targets and remove only run-owned temporary files", async () => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pdf-failure-")));
  try {
    const codexHome = path.join(temp, ".codex");
    await writeSingleSession(codexHome);
    for (const code of ["EACCES", "ENOSPC"]) {
      const output = path.join(temp, code.toLowerCase());
      const writeBuffer = async (handle) => {
        await handle.writeFile(Buffer.from("partial-pdf"));
        throw Object.assign(new Error(`synthetic ${code}`), { code });
      };
      await assert.rejects(() => exportArchive({ codexHome, scope: "all", outputDirectory: output, exportProfile: "readable", documentFormats: ["pdf"], _pdfOptions: { writeBuffer } }), (error) => error.code === code);
      const files = await listFiles(output);
      assert.equal(files.some((file) => file.endsWith(".pdf") || file.includes(".partial-") || file.includes(".previous-")), false, `${code} must not leave a PDF or run-owned temporary file`);
    }

    const collisionOutput = path.join(temp, "collision");
    const existing = path.join(collisionOutput, "pdf", "p001-single", "s0001.pdf");
    await fs.mkdir(path.dirname(existing), { recursive: true });
    const sentinel = Buffer.from("existing-pdf-sentinel");
    await fs.writeFile(existing, sentinel);
    await assert.rejects(() => exportArchive({ codexHome, scope: "all", outputDirectory: collisionOutput, exportProfile: "readable", documentFormats: ["pdf"] }), (error) => error.code === "UNOWNED_EXPORT_FILE");
    assert.deepEqual(await fs.readFile(existing), sentinel, "an existing PDF target must never be silently overwritten");
    assert.equal((await listFiles(collisionOutput)).some((file) => file.includes(".partial-") || file.includes(".previous-")), false);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("CLI --format pdf uses the same explicit export contract", async () => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pdf-cli-")));
  try {
    const codexHome = path.join(temp, ".codex");
    await writeSingleSession(codexHome);
    const output = path.join(temp, "output");
    const executable = path.resolve("bin", "export-codex-project-chats.mjs");
    await execFileAsync(process.execPath, [executable, "--all", "--codex-home", codexHome, "--out", output, "--profile", "readable", "--format", "pdf"], { encoding: "utf8" });
    const manifest = JSON.parse(await fs.readFile(path.join(output, "manifest.json"), "utf8"));
    assert.equal(manifest.formats.pdf, true);
    assert.equal(manifest.sessions.length, 1);
    assert.ok(manifest.sessions[0].pdf_file && await fs.stat(path.join(output, manifest.sessions[0].pdf_file)).then((stat) => stat.isFile()));
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});
