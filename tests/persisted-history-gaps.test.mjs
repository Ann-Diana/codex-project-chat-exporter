import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import JSZip from "jszip";
import xmlJs from "xml-js";

import { exportArchive } from "../bin/export-codex-project-chats.mjs";
import { validateCanonicalPdf } from "../lib/pdf-renderer.mjs";

const execFileAsync = promisify(execFile);
const fixtureRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "persisted-history-gaps");
const projectPath = "C:\\Synthetic\\Persisted-History-Gaps";
const mainSessionId = "a1000000-0000-7000-8000-000000000001";
const subagentSessionId = "a2000000-0000-7000-8000-000000000002";
const orphanedSessionId = "a3000000-0000-7000-8000-000000000003";
const staleIndexSessionId = "a4000000-0000-7000-8000-000000000004";
const { xml2js } = xmlJs;

function count(text, token) {
  return text.split(token).length - 1;
}

async function fixtureCopy(prefix) {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  const codexHome = path.join(temp, "codex-home");
  await fs.cp(fixtureRoot, codexHome, { recursive: true, errorOnExist: true });
  return { codexHome, temp };
}

async function manifestFor(result) {
  return JSON.parse(await fs.readFile(result.manifestPath, "utf8"));
}

function sessionById(manifest, sessionId) {
  const session = manifest.sessions.find((candidate) => candidate.session_id === sessionId);
  assert.ok(session, `missing fixture session ${sessionId}`);
  return session;
}

async function assertRawSnapshotsEqualSources(result) {
  const manifest = await manifestFor(result);
  for (const session of manifest.sessions) {
    assert.ok(session.raw_export_file, `${manifest.export_profile} must publish a verified Raw snapshot`);
    assert.deepEqual(
      await fs.readFile(path.join(result.outputDirectory, session.raw_export_file)),
      await fs.readFile(session.source_jsonl),
      `${manifest.export_profile} must preserve ${session.session_id} byte-for-byte`,
    );
  }
}

async function docxXml(outputDirectory, relativePath) {
  const zip = await JSZip.loadAsync(await fs.readFile(path.join(outputDirectory, relativePath)), { checkCRC32: true });
  return zip.file("word/document.xml").async("string");
}

function xmlText(xml) {
  const values = [];
  function visit(node) {
    if (!node || typeof node !== "object") return;
    if (node.type === "text") values.push(node.text || "");
    for (const child of node.elements || []) visit(child);
  }
  visit(xml2js(xml, { compact: false, alwaysChildren: true }));
  return values.join("");
}

async function pdfText(t, absolutePath) {
  const executable = process.env.PDFTOTEXT_PATH || "pdftotext";
  try {
    return (await execFileAsync(executable, ["-enc", "UTF-8", absolutePath, "-"], { encoding: "utf8", windowsHide: true })).stdout;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    t.diagnostic("Poppler text extraction unavailable; shared-model DOCX assertions and canonical PDF validation remain active");
    return null;
  }
}

test("#41590 persisted collaboration and Unified Exec records remain classified, coupled and tool-filtered", async (t) => {
  const { codexHome, temp } = await fixtureCopy("persisted-41590-");
  try {
    for (const profile of ["complete", "source-snapshots"]) {
      const result = await exportArchive({
        codexHome,
        scope: "all",
        outputDirectory: path.join(temp, `raw-${profile}`),
        exportProfile: profile,
        includeTools: true,
      });
      await assertRawSnapshotsEqualSources(result);
    }

    const withoutTools = await exportArchive({
      codexHome,
      scope: "all",
      outputDirectory: path.join(temp, "without-tools"),
      exportProfile: "readable",
      includeTools: false,
      documentFormats: ["docx", "pdf"],
    });
    const withTools = await exportArchive({
      codexHome,
      scope: "all",
      outputDirectory: path.join(temp, "with-tools"),
      exportProfile: "readable",
      includeTools: true,
      documentFormats: ["docx", "pdf"],
    });
    const withoutManifest = await manifestFor(withoutTools);
    const withManifest = await manifestFor(withTools);
    const withoutMain = sessionById(withoutManifest, mainSessionId);
    const withMain = sessionById(withManifest, mainSessionId);
    const withSubagent = sessionById(withManifest, subagentSessionId);
    assert.equal(withoutMain.session_kind, "DIRECT_USER");
    assert.equal(withMain.session_kind, "DIRECT_USER");
    assert.equal(withSubagent.session_kind, "SUBAGENT");
    assert.equal(withMain.user_messages, 1);
    assert.equal(withMain.assistant_messages, 1);
    assert.equal(withMain.tool_events, 8);

    const mainRecords = (await fs.readFile(withMain.source_jsonl, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const spawnCall = mainRecords.find((record) => record.payload?.type === "function_call" && record.payload.name === "spawn_agent");
    const spawnResult = mainRecords.find((record) => record.payload?.type === "function_call_output" && record.payload.call_id === spawnCall?.payload.call_id);
    const waitCall = mainRecords.find((record) => record.payload?.type === "function_call" && record.payload.name === "wait_agent");
    const waitResult = mainRecords.find((record) => record.payload?.type === "function_call_output" && record.payload.call_id === waitCall?.payload.call_id);
    const execCall = mainRecords.find((record) => record.payload?.type === "custom_tool_call" && record.payload.name === "exec");
    const execResult = mainRecords.find((record) => record.payload?.type === "custom_tool_call_output" && record.payload.call_id === execCall?.payload.call_id);
    assert.deepEqual(Object.keys(JSON.parse(spawnCall.payload.arguments)), ["agent_type", "message", "fork_context"]);
    assert.deepEqual(Object.keys(JSON.parse(waitCall.payload.arguments)), ["timeout_ms"]);
    assert.ok(spawnResult && waitResult, "collaboration results must correlate by call_id");
    assert.equal(typeof execCall.payload.input, "string");
    assert.deepEqual(execResult.payload.output.map((item) => Object.keys(item)), [["type", "text"], ["type", "text"]]);
    assert.deepEqual(execResult.payload.output.map((item) => item.type), ["input_text", "input_text"]);

    const subagentSource = (await fs.readFile(withSubagent.source_jsonl, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(subagentSource[0].payload.parent_thread_id, mainSessionId, "the independent subagent source must retain its explicit parent link");

    const withoutMarkdown = await fs.readFile(path.join(withoutTools.outputDirectory, withoutMain.markdown_file), "utf8");
    const withMarkdown = await fs.readFile(path.join(withTools.outputDirectory, withMain.markdown_file), "utf8");
    const withoutHtml = await fs.readFile(withoutTools.htmlIndexPath, "utf8");
    const withHtml = await fs.readFile(withTools.htmlIndexPath, "utf8");
    const withoutDocx = xmlText(await docxXml(withoutTools.outputDirectory, withoutMain.docx_file));
    const withDocx = xmlText(await docxXml(withTools.outputDirectory, withMain.docx_file));
    const withoutPdfPath = path.join(withoutTools.outputDirectory, withoutMain.pdf_file);
    const withPdfPath = path.join(withTools.outputDirectory, withMain.pdf_file);
    const withoutPdfBytes = await fs.readFile(withoutPdfPath);
    const withPdfBytes = await fs.readFile(withPdfPath);
    validateCanonicalPdf(withoutPdfBytes);
    validateCanonicalPdf(withPdfBytes);
    const withoutPdf = await pdfText(t, withoutPdfPath);
    const withPdf = await pdfText(t, withPdfPath);

    const finalAnswer = "The synthetic collaboration check is complete.";
    const toolNeedles = ["Tool function_call – spawn_agent", "Tool function_call – wait_agent", "Tool custom_tool_call – exec", "synthetic offline command"];
    for (const [view, text] of [["Markdown", withoutMarkdown], ["DOCX", withoutDocx], ["PDF", withoutPdf]].filter(([, value]) => value !== null)) {
      assert.equal(count(text, finalAnswer), 1, `${view} must retain the final assistant answer exactly once`);
      for (const needle of toolNeedles) assert.equal(text.includes(needle), false, `${view} with includeTools=false must hide ${needle}`);
    }
    for (const [view, text] of [["Markdown", withMarkdown], ["DOCX", withDocx], ["PDF", withPdf]].filter(([, value]) => value !== null)) {
      assert.equal(count(text, finalAnswer), 1, `${view} must not mirror the final assistant answer`);
      for (const needle of toolNeedles) assert.equal(text.includes(needle), true, `${view} with includeTools=true must retain ${needle}`);
    }
    assert.equal(count(withMarkdown, "## User –"), 1, "the mirrored user event must not create a second visible user message");
    assert.equal(count(withMarkdown, "## Assistant –"), 1, "the final assistant answer must remain one message");
    assert.equal(withoutHtml.includes(withoutMain.display_title), true, "the responsive HTML index must retain the main session row");
    assert.equal(withHtml.includes(withMain.display_title), true, "the responsive HTML index must retain the main session row with tools enabled");
    assert.equal(count(withoutHtml, "<img "), 0, "HTML must hide tool-only images when tools are excluded");
    assert.equal(count(withHtml, "<img "), 1, "HTML must show the tool-only image once when tools are included");
    for (const needle of toolNeedles) {
      assert.equal(withoutHtml.includes(needle), false, "the HTML index must not leak hidden tool payloads");
      assert.equal(withHtml.includes(needle), false, "the HTML index is metadata navigation rather than a transcript");
    }
    const withoutAssets = JSON.parse(await fs.readFile(withoutTools.assetManifestPath, "utf8"));
    const withAssets = JSON.parse(await fs.readFile(withTools.assetManifestPath, "utf8"));
    assert.equal(withoutAssets.assets.length, 0, "a tool-only image must not be published when tools are excluded");
    assert.equal(withAssets.assets.length, 1, "the tool-only image must be published once when tools are included");
    assert.equal(withAssets.assets[0].uses.filter((use) => use.reading_disposition === "VISIBLE").length, 1);
    assert.equal(withoutMain.tool_events, 8, "tool records remain classified even when their reading representation is hidden");
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("#41591 an orphaned historical task_started record does not truncate later complete turns", async () => {
  const { codexHome, temp } = await fixtureCopy("persisted-41591-");
  try {
    const result = await exportArchive({ codexHome, scope: "all", outputDirectory: path.join(temp, "output"), exportProfile: "complete" });
    const manifest = await manifestFor(result);
    const session = sessionById(manifest, orphanedSessionId);
    assert.equal(session.user_messages, 2);
    assert.equal(session.assistant_messages, 2);
    const markdown = await fs.readFile(path.join(result.outputDirectory, session.markdown_file), "utf8");
    for (const marker of ["The first later synthetic turn is complete.", "The second later synthetic turn is complete."]) assert.equal(count(markdown, marker), 1, "each later assistant turn must survive exactly once");
    assert.equal(count(markdown, "Create the second later synthetic turn."), 1, "the later user turn must survive exactly once");
    const sourceRecords = (await fs.readFile(session.source_jsonl, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const orphanStart = sourceRecords.filter((record) => record.type === "event_msg" && record.payload?.type === "task_started" && record.payload.turn_id === "orphaned-turn");
    const inventedTerminal = sourceRecords.filter((record) => record.type === "event_msg" && record.payload?.type === "task_complete" && record.payload.turn_id === "orphaned-turn");
    assert.equal(orphanStart.length, 1);
    assert.equal(inventedTerminal.length, 0, "the fixture and byte-identical Raw snapshot must retain the orphan without repairing it");
    assert.deepEqual(await fs.readFile(path.join(result.outputDirectory, session.raw_export_file)), await fs.readFile(session.source_jsonl));
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("#41707 a stale session index supplies only the title and never bounds later rollout records", { skip: process.platform !== "win32" }, async () => {
  const { codexHome, temp } = await fixtureCopy("persisted-41707-");
  try {
    for (const [scope, extra] of [
      ["project", { workspacePath: projectPath }],
      ["recorded-project", { recordedProjectPath: projectPath }],
    ]) {
      const diagnostics = [];
      const result = await exportArchive({
        codexHome,
        scope,
        ...extra,
        outputDirectory: path.join(temp, scope),
        exportProfile: "complete",
        onDiagnostic: (event) => diagnostics.push(event),
      });
      assert.equal(result.exportedSessionCount, 4);
      const metadataReads = diagnostics.filter((event) => event.event === "routing_metadata_end");
      assert.equal(metadataReads.length, 4);
      assert.ok(metadataReads.every((event) => event.metadata_bytes_read <= 4096), "selection routing must remain bounded to first-record metadata");
      const manifest = await manifestFor(result);
      const session = sessionById(manifest, staleIndexSessionId);
      assert.equal(session.display_title, "Persisted history fixture");
      assert.equal(session.title_source, "session_index");
      assert.equal(session.updated_at, "2026-08-31T08:04:02.100Z", "last activity must come from the complete rollout rather than the stale index");
      assert.equal(session.user_messages, 3);
      assert.equal(session.assistant_messages, 3);
      const markdown = await fs.readFile(path.join(result.outputDirectory, session.markdown_file), "utf8");
      for (const marker of ["indexed synthetic first answer", "indexed synthetic second answer", "indexed synthetic final answer"]) assert.equal(count(markdown, marker), 1);
      assert.deepEqual(await fs.readFile(path.join(result.outputDirectory, session.raw_export_file)), await fs.readFile(session.source_jsonl));
    }
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});
