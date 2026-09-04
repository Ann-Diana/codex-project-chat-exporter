import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import zlib from "node:zlib";

import JSZip from "jszip";

import { exportArchive, INCOMPLETE_MARKER_NAME, readSessionDiscoveryMeta } from "../bin/export-codex-project-chats.mjs";
import { validateCanonicalPdf } from "../lib/pdf-renderer.mjs";

const zstdCompress = typeof zlib.zstdCompress === "function" ? promisify(zlib.zstdCompress) : null;

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const PARENT_ID = "11111111-1111-7111-8111-111111111111";
const CHILD_ID = "22222222-2222-7222-8222-222222222222";
const GRANDCHILD_ID = "33333333-3333-7333-8333-333333333333";
const PROJECT_PARENT = process.platform === "win32" ? "C:\\Synthetic\\Parent" : "/synthetic/Parent";
const PROJECT_CHILD = process.platform === "win32" ? "C:\\Synthetic\\Child" : "/synthetic/Child";
const PROJECT_UNKNOWN = process.platform === "win32" ? "C:\\Synthetic\\Unknown" : "/synthetic/Unknown";

function sessionMeta(id, cwd, timestamp, extra = {}, ordinal = 0) {
  return { ordinal, type: "session_meta", timestamp, payload: { id, cwd, timestamp, source: "vscode", thread_source: "user", history_mode: "paginated", ...extra } };
}

function turn(ordinal, model, timestamp, cwd = PROJECT_PARENT) {
  return { ordinal, type: "turn_context", timestamp, payload: { cwd, model, turn_id: `turn-${ordinal}` } };
}

function user(ordinal, text, timestamp, content = null) {
  return {
    ordinal,
    type: "response_item",
    timestamp,
    payload: {
      type: "message",
      role: "user",
      content: content || [{ type: "input_text", text }],
      internal_chat_message_metadata_passthrough: { turn_id: `turn-${ordinal}` },
    },
  };
}

function userMirror(ordinal, text, timestamp) {
  return { ordinal, type: "event_msg", timestamp, payload: { type: "user_message", message: text } };
}

function assistant(ordinal, text, timestamp) {
  return { ordinal, type: "response_item", timestamp, payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] } };
}

function toolCall(ordinal, marker, timestamp) {
  return { ordinal, type: "response_item", timestamp, payload: { type: "function_call", name: "synthetic_tool", arguments: JSON.stringify({ marker }) } };
}

function toolOutput(ordinal, marker, timestamp) {
  return { ordinal, type: "response_item", timestamp, payload: { type: "function_call_output", call_id: `call-${ordinal - 1}`, output: marker } };
}

function jsonl(records) {
  return Buffer.from(`${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
}

function prefixBoundary(records) {
  const bytes = jsonl(records);
  const lastOrdinal = records.at(-1)?.ordinal;
  return { bytes, historyBase: { thread_id: PARENT_ID, end_ordinal_exclusive: lastOrdinal + 1, end_byte_offset: bytes.length } };
}

function rolloutName(timestamp, threadId, rolloutId = "") {
  const stamp = timestamp.replaceAll(":", "-").replace(/\.000Z$/, "");
  return `rollout-${stamp}-${threadId}${rolloutId ? `_${rolloutId}` : ""}.jsonl`;
}

async function writeRollout(root, storage, timestamp, threadId, records, rolloutId = "") {
  const directory = storage === "archived"
    ? path.join(root, "archived_sessions")
    : path.join(root, "sessions", "2026", "09", "01");
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, rolloutName(timestamp, threadId, rolloutId));
  await fs.writeFile(file, jsonl(records));
  return file;
}

async function writeIndex(root, entries) {
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, "session_index.jsonl"), `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
}

async function filesWithExtension(root, extension) {
  const result = [];
  async function walk(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (file.endsWith(extension)) result.push(file);
    }
  }
  await walk(root);
  return result.sort();
}

async function transcriptText(output) {
  const markdown = (await filesWithExtension(output, ".md")).find((file) => path.basename(file) !== "index.md");
  const html = await fs.readFile(path.join(output, "index.html"), "utf8");
  return { markdown: await fs.readFile(markdown, "utf8"), html };
}

async function docxText(output) {
  const [file] = await filesWithExtension(output, ".docx");
  const zip = await JSZip.loadAsync(await fs.readFile(file), { checkCRC32: true });
  return zip.file("word/document.xml").async("string");
}

async function createParentChild(root, { parentStorage = "active", includeAfter = true } = {}) {
  const parentTimestamp = "2026-09-01T10:00:00.000Z";
  const childTimestamp = "2026-09-01T11:00:00.000Z";
  const parentPrefix = [
    sessionMeta(PARENT_ID, PROJECT_PARENT, parentTimestamp),
    turn(1, "gpt-5.5", "2026-09-01T10:00:01.000Z"),
    user(2, "PARENT_PREFIX_USER", "2026-09-01T10:00:02.000Z", [
      { type: "input_text", text: "PARENT_PREFIX_USER" },
      { type: "input_image", image_url: `data:image/png;base64,${PNG}` },
    ]),
    userMirror(3, "PARENT_PREFIX_USER", "2026-09-01T10:00:02.001Z"),
    toolCall(4, "PARENT_PREFIX_TOOL", "2026-09-01T10:00:03.000Z"),
    toolOutput(5, "PARENT_PREFIX_TOOL_OUTPUT", "2026-09-01T10:00:03.001Z"),
    assistant(6, "PARENT_PREFIX_ASSISTANT", "2026-09-01T10:00:04.000Z"),
  ];
  const boundary = prefixBoundary(parentPrefix);
  const parentRecords = includeAfter
    ? [...parentPrefix, toolCall(7, "PARENT_AFTER_TOOL", "2026-09-01T10:00:05.000Z"), toolOutput(8, "PARENT_AFTER_TOOL_OUTPUT", "2026-09-01T10:00:05.001Z"), user(9, "PARENT_AFTER_BOUNDARY", "2026-09-01T10:00:06.000Z")]
    : parentPrefix;
  const childRecords = [
    sessionMeta(CHILD_ID, PROJECT_CHILD, childTimestamp, {
      forked_from_id: PARENT_ID,
      history_base: boundary.historyBase,
    }, boundary.historyBase.end_ordinal_exclusive),
    turn(8, "gpt-5.6-sol", "2026-09-01T11:00:01.000Z", PROJECT_CHILD),
    user(9, "CHILD_DELTA_USER", "2026-09-01T11:00:02.000Z"),
    userMirror(10, "CHILD_DELTA_USER", "2026-09-01T11:00:02.001Z"),
    assistant(11, "CHILD_DELTA_ASSISTANT", "2026-09-01T11:00:03.000Z"),
  ];
  const parentFile = await writeRollout(root, parentStorage, parentTimestamp, PARENT_ID, parentRecords);
  const childFile = await writeRollout(root, "active", childTimestamp, CHILD_ID, childRecords);
  await writeIndex(root, [
    { id: PARENT_ID, thread_name: "Synthetic parent", updated_at: "2026-09-01T10:00:05.000Z" },
    { id: CHILD_ID, thread_name: "Synthetic child", updated_at: "2026-09-01T11:00:03.000Z" },
  ]);
  return { boundary, childFile, childRecords, parentFile, parentPrefix, parentRecords };
}

function errorCode(code) {
  return (error) => error?.code === code;
}

test("paginated child reconstructs an archived parent prefix once across every reading format", async () => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paginated-history-positive-")));
  try {
    const codexHome = path.join(temp, "codex-home");
    const fixture = await createParentChild(codexHome, { parentStorage: "archived" });
    const output = path.join(temp, "output");
    const result = await exportArchive({
      codexHome,
      scope: "recorded-project",
      recordedProjectPath: PROJECT_CHILD,
      outputDirectory: output,
      exportProfile: "complete",
      includeTools: false,
      documentFormats: ["docx", "pdf"],
    });
    assert.equal(result.rows.length, 1);
    const manifest = JSON.parse(await fs.readFile(path.join(output, "manifest.json"), "utf8"));
    const row = manifest.sessions[0];
    assert.equal(row.session_id, CHILD_ID);
    assert.equal(row.project, PROJECT_CHILD);
    assert.equal(row.title, "Synthetic child");
    assert.deepEqual(manifest.session_model_histories[0].models, ["gpt-5.5", "gpt-5.6-sol"]);
    assert.deepEqual(manifest.history_reference_closure[0].segments.map((segment) => segment.storage), ["archived"]);
    assert.equal(manifest.history_reference_closure[0].segments[0].snapshot_kind, "DERIVED_EXACT_PREFIX");
    const { markdown, html } = await transcriptText(output);
    const wordXml = await docxText(output);
    for (const rendered of [markdown, wordXml]) {
      assert.equal(rendered.split("PARENT_PREFIX_USER").length - 1, 1);
      assert.equal(rendered.split("PARENT_PREFIX_ASSISTANT").length - 1, 1);
      assert.equal(rendered.split("CHILD_DELTA_USER").length - 1, 1);
      assert.equal(rendered.includes("PARENT_AFTER_BOUNDARY"), false);
      assert.equal(rendered.includes("PARENT_PREFIX_TOOL"), false);
      assert.equal(rendered.includes("PARENT_PREFIX_TOOL_OUTPUT"), false);
      assert.equal(rendered.includes("PARENT_AFTER_TOOL"), false);
      assert.equal(rendered.includes("PARENT_AFTER_TOOL_OUTPUT"), false);
    }
    assert.match(html, /Synthetic child/);
    assert.ok(html.includes("gpt-5.5") && html.includes("gpt-5.6-sol"));
    assert.equal(html.includes("PARENT_AFTER_BOUNDARY"), false);
    const [pdfFile] = await filesWithExtension(output, ".pdf");
    validateCanonicalPdf(await fs.readFile(pdfFile));
    const closure = manifest.history_reference_closure[0].segments[0];
    const prefix = await fs.readFile(path.join(output, closure.snapshot_file));
    assert.deepEqual(prefix, fixture.boundary.bytes);
    assert.equal(createHash("sha256").update(prefix).digest("hex"), closure.prefix_sha256);
    assert.deepEqual(await fs.readFile(path.join(output, row.raw_export_file)), await fs.readFile(fixture.childFile));
    const assets = JSON.parse(await fs.readFile(path.join(output, "assets", "manifest.json"), "utf8"));
    assert.equal(assets.assets.length, 1);
    assert.equal(assets.assets[0].uses.filter((use) => use.reading_disposition === "VISIBLE").length, 1);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("tool selection applies equally to inherited and child records", async () => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paginated-history-tools-")));
  try {
    const codexHome = path.join(temp, "codex-home");
    await createParentChild(codexHome);
    const hidden = path.join(temp, "hidden");
    const visible = path.join(temp, "visible");
    await exportArchive({ codexHome, scope: "recorded-project", recordedProjectPath: PROJECT_CHILD, outputDirectory: hidden, exportProfile: "readable" });
    await exportArchive({ codexHome, scope: "recorded-project", recordedProjectPath: PROJECT_CHILD, outputDirectory: visible, exportProfile: "readable", includeTools: true });
    assert.equal((await transcriptText(hidden)).markdown.includes("PARENT_PREFIX_TOOL"), false);
    const visibleMarkdown = (await transcriptText(visible)).markdown;
    assert.equal(visibleMarkdown.includes("PARENT_PREFIX_TOOL"), true);
    assert.equal(visibleMarkdown.includes("PARENT_PREFIX_TOOL_OUTPUT"), true);
    assert.equal(visibleMarkdown.includes("PARENT_AFTER_TOOL"), false);
    assert.equal(visibleMarkdown.includes("PARENT_AFTER_TOOL_OUTPUT"), false);
    const hiddenManifest = JSON.parse(await fs.readFile(path.join(hidden, "manifest.json"), "utf8"));
    assert.equal(hiddenManifest.history_reference_closure[0].segments[0].snapshot_kind, "NOT_INCLUDED");
    assert.equal(hiddenManifest.history_reference_closure[0].segments[0].snapshot_file, "");
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("Source snapshots preserve Child Raw plus the exact bounded Parent closure", async () => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paginated-history-source-profile-")));
  try {
    const root = path.join(temp, "codex-home");
    const fixture = await createParentChild(root);
    const output = path.join(temp, "output");
    await exportArchive({ codexHome: root, scope: "recorded-project", recordedProjectPath: PROJECT_CHILD, outputDirectory: output, exportProfile: "source-snapshots" });
    const manifest = JSON.parse(await fs.readFile(path.join(output, "manifest.json"), "utf8"));
    const segment = manifest.history_reference_closure[0].segments[0];
    assert.equal(manifest.sessions[0].markdown_file, "");
    assert.equal(segment.snapshot_kind, "DERIVED_EXACT_PREFIX");
    assert.deepEqual(await fs.readFile(path.join(output, segment.snapshot_file)), fixture.boundary.bytes);
    assert.deepEqual(await fs.readFile(path.join(output, manifest.sessions[0].raw_export_file)), await fs.readFile(fixture.childFile));
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("a reverted Parent resolves by rollout ID while retaining its stable thread ID", async () => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paginated-history-reverted-")));
  try {
    const root = path.join(temp, "codex-home");
    const stableThreadId = "55555555-5555-7555-8555-555555555555";
    const parentTimestamp = "2026-09-01T09:00:00.000Z";
    const childTimestamp = "2026-09-01T10:00:00.000Z";
    const parent = [sessionMeta(stableThreadId, PROJECT_PARENT, parentTimestamp), assistant(1, "REVERTED_PARENT_PREFIX", parentTimestamp)];
    const boundary = prefixBoundary(parent).historyBase;
    boundary.thread_id = PARENT_ID;
    await writeRollout(root, "archived", parentTimestamp, stableThreadId, parent, PARENT_ID);
    await writeRollout(root, "active", childTimestamp, CHILD_ID, [sessionMeta(CHILD_ID, PROJECT_CHILD, childTimestamp, { forked_from_id: stableThreadId, history_base: boundary }, 2), assistant(3, "REVERTED_CHILD_DELTA", childTimestamp)]);
    const output = path.join(temp, "output");
    await exportArchive({ codexHome: root, scope: "recorded-project", recordedProjectPath: PROJECT_CHILD, outputDirectory: output, exportProfile: "complete" });
    const manifest = JSON.parse(await fs.readFile(path.join(output, "manifest.json"), "utf8"));
    const segment = manifest.history_reference_closure[0].segments[0];
    assert.equal(segment.rollout_id, PARENT_ID);
    assert.equal(segment.thread_id, stableThreadId);
    assert.match((await transcriptText(output)).markdown, /REVERTED_PARENT_PREFIX/);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("a reverted Child retains its stable thread ID after Complete Raw publication", async () => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paginated-history-reverted-child-")));
  try {
    const codexHome = path.join(temp, "codex-home");
    const parentTimestamp = "2026-09-01T10:00:00.000Z";
    const childTimestamp = "2026-09-01T11:00:00.000Z";
    const parent = [sessionMeta(PARENT_ID, PROJECT_PARENT, parentTimestamp), assistant(1, "PARENT", parentTimestamp)];
    const boundary = prefixBoundary(parent);
    await writeRollout(codexHome, "archived", parentTimestamp, PARENT_ID, parent);
    const child = [
      sessionMeta(CHILD_ID, PROJECT_CHILD, childTimestamp, { forked_from_id: PARENT_ID, history_base: boundary.historyBase }, 2),
      assistant(3, "CHILD", childTimestamp),
    ];
    await writeRollout(codexHome, "active", childTimestamp, CHILD_ID, child, GRANDCHILD_ID);
    const output = path.join(temp, "output");
    await exportArchive({ codexHome, scope: "recorded-project", recordedProjectPath: PROJECT_CHILD, outputDirectory: output, exportProfile: "complete", pathStyle: "readable" });
    const manifest = JSON.parse(await fs.readFile(path.join(output, "manifest.json"), "utf8"));
    assert.equal(manifest.sessions[0].session_id, CHILD_ID);
    assert.match(manifest.sessions[0].source_original_filename, new RegExp(`${CHILD_ID}_${GRANDCHILD_ID}\\.jsonl$`));
    assert.match(manifest.sessions[0].raw_export_name, new RegExp(`^s0001-rollout-.+${CHILD_ID}_${GRANDCHILD_ID}\\.jsonl$`));
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("duplicate rollout ordinals never truncate later valid records or alter Raw JSONL", async () => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paginated-history-duplicate-ordinal-")));
  try {
    const codexHome = path.join(temp, "codex-home");
    const timestamp = "2026-09-01T12:00:00.000Z";
    const id = "44444444-4444-7444-8444-444444444444";
    const records = [
      sessionMeta(id, PROJECT_CHILD, timestamp),
      turn(1, "gpt-5.5", "2026-09-01T12:00:01.000Z"),
      { ordinal: 1, type: "event_msg", timestamp: "2026-09-01T12:00:01.001Z", payload: { type: "thread_settings", model: "gpt-5.5" } },
      user(2, "DUPLICATE_ORDINAL_LATER_USER", "2026-09-01T12:00:02.000Z"),
      userMirror(3, "DUPLICATE_ORDINAL_LATER_USER", "2026-09-01T12:00:02.001Z"),
      assistant(4, "DUPLICATE_ORDINAL_LATER_ASSISTANT", "2026-09-01T12:00:03.000Z"),
    ];
    const source = await writeRollout(codexHome, "active", timestamp, id, records);
    await writeIndex(codexHome, [{ id, thread_name: "Duplicate ordinal fixture", updated_at: "2026-09-01T12:00:03.000Z" }]);
    const output = path.join(temp, "output");
    await exportArchive({ codexHome, scope: "all", outputDirectory: output, exportProfile: "complete" });
    const manifest = JSON.parse(await fs.readFile(path.join(output, "manifest.json"), "utf8"));
    const markdown = (await transcriptText(output)).markdown;
    assert.match(markdown, /DUPLICATE_ORDINAL_LATER_USER/);
    assert.match(markdown, /DUPLICATE_ORDINAL_LATER_ASSISTANT/);
    assert.deepEqual(await fs.readFile(path.join(output, manifest.sessions[0].raw_export_file)), await fs.readFile(source));
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("history references fail closed for missing, ambiguous, cyclic and invalid boundaries", async (t) => {
  const cases = [
    ["missing parent", "HISTORY_PARENT_MISSING", async (root) => {
      const timestamp = "2026-09-01T13:00:00.000Z";
      await writeRollout(root, "active", timestamp, CHILD_ID, [sessionMeta(CHILD_ID, PROJECT_CHILD, timestamp, { forked_from_id: PARENT_ID, history_base: { thread_id: PARENT_ID, end_ordinal_exclusive: 2, end_byte_offset: 10 } })]);
    }],
    ["ambiguous parent", "HISTORY_PARENT_AMBIGUOUS", async (root) => {
      const parent = [sessionMeta(PARENT_ID, PROJECT_PARENT, "2026-09-01T10:00:00.000Z"), turn(1, "gpt-5.5", "2026-09-01T10:00:01.000Z")];
      const boundary = prefixBoundary(parent).historyBase;
      await writeRollout(root, "active", "2026-09-01T10:00:00.000Z", PARENT_ID, parent);
      await writeRollout(root, "archived", "2026-09-01T10:00:00.000Z", PARENT_ID, parent);
      await writeRollout(root, "active", "2026-09-01T11:00:00.000Z", CHILD_ID, [sessionMeta(CHILD_ID, PROJECT_CHILD, "2026-09-01T11:00:00.000Z", { forked_from_id: PARENT_ID, history_base: boundary })]);
    }],
    ["cycle", "HISTORY_REFERENCE_CYCLE", async (root) => {
      const parentTime = "2026-09-01T10:00:00.000Z";
      const childTime = "2026-09-01T11:00:00.000Z";
      const parent = [sessionMeta(PARENT_ID, PROJECT_PARENT, parentTime, { history_base: { thread_id: CHILD_ID, end_ordinal_exclusive: 1, end_byte_offset: 1 } }, 1)];
      const parentBoundary = prefixBoundary(parent).historyBase;
      await writeRollout(root, "active", parentTime, PARENT_ID, parent);
      await writeRollout(root, "active", childTime, CHILD_ID, [sessionMeta(CHILD_ID, PROJECT_CHILD, childTime, { forked_from_id: PARENT_ID, history_base: parentBoundary })]);
    }],
    ["unsafe identifier", "HISTORY_INVALID_BOUNDARY", async (root) => {
      const timestamp = "2026-09-01T13:00:00.000Z";
      await writeRollout(root, "active", timestamp, CHILD_ID, [sessionMeta(CHILD_ID, PROJECT_CHILD, timestamp, { forked_from_id: PARENT_ID, history_base: { thread_id: "..\\outside", end_ordinal_exclusive: 2, end_byte_offset: 10 } })]);
    }],
    ["non-paginated child", "HISTORY_MODE_INVALID", async (root) => {
      const timestamp = "2026-09-01T13:00:00.000Z";
      await writeRollout(root, "active", timestamp, CHILD_ID, [sessionMeta(CHILD_ID, PROJECT_CHILD, timestamp, { forked_from_id: PARENT_ID, history_mode: "legacy", history_base: { thread_id: PARENT_ID, end_ordinal_exclusive: 2, end_byte_offset: 10 } })]);
    }],
  ];
  for (const [name, expected, arrange] of cases) {
    await t.test(name, async () => {
      const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paginated-history-invalid-")));
      try {
        const root = path.join(temp, "codex-home");
        await arrange(root);
        await assert.rejects(() => exportArchive({ codexHome: root, scope: "recorded-project", recordedProjectPath: PROJECT_CHILD, outputDirectory: path.join(temp, "output"), exportProfile: "readable" }), errorCode(expected));
      } finally {
        await fs.rm(temp, { recursive: true, force: true });
      }
    });
  }
});

test("paginated source and Child metadata ordinals are validated", async (t) => {
  for (const [name, expected, parentOrdinal, childOrdinal] of [
    ["source metadata", "HISTORY_SOURCE_ORDINAL_MISMATCH", 4, 2],
    ["Child metadata", "HISTORY_CHILD_ORDINAL_MISMATCH", 0, 9],
  ]) {
    await t.test(name, async () => {
      const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paginated-history-metadata-ordinal-")));
      try {
        const root = path.join(temp, "codex-home");
        const parentTimestamp = "2026-09-01T10:00:00.000Z";
        const childTimestamp = "2026-09-01T11:00:00.000Z";
        const parent = [sessionMeta(PARENT_ID, PROJECT_PARENT, parentTimestamp, {}, parentOrdinal), assistant(parentOrdinal + 1, "ORDINAL_PARENT", parentTimestamp)];
        const bytes = jsonl(parent);
        const historyBase = { thread_id: PARENT_ID, end_ordinal_exclusive: parentOrdinal + 2, end_byte_offset: bytes.length };
        await writeRollout(root, "active", parentTimestamp, PARENT_ID, parent);
        await writeRollout(root, "active", childTimestamp, CHILD_ID, [sessionMeta(CHILD_ID, PROJECT_CHILD, childTimestamp, { forked_from_id: PARENT_ID, history_base: historyBase }, childOrdinal), assistant(childOrdinal + 1, "ORDINAL_CHILD", childTimestamp)]);
        await assert.rejects(() => exportArchive({ codexHome: root, scope: "recorded-project", recordedProjectPath: PROJECT_CHILD, outputDirectory: path.join(temp, "output"), exportProfile: "readable" }), errorCode(expected));
      } finally {
        await fs.rm(temp, { recursive: true, force: true });
      }
    });
  }
});

test("history boundaries reject negative, past-end, inside-record and ordinal-mismatched values", async (t) => {
  const variants = [
    ["negative", "HISTORY_INVALID_BOUNDARY", (base) => ({ ...base, end_byte_offset: -1 })],
    ["past end", "HISTORY_BYTE_OFFSET_OUT_OF_RANGE", (base) => ({ ...base, end_byte_offset: base.end_byte_offset + 10_000 })],
    ["inside record", "HISTORY_BOUNDARY_NOT_RECORD_ALIGNED", (base) => ({ ...base, end_byte_offset: base.end_byte_offset - 2 })],
    ["ordinal mismatch", "HISTORY_BOUNDARY_MISMATCH", (base) => ({ ...base, end_ordinal_exclusive: base.end_ordinal_exclusive + 1 })],
  ];
  for (const [name, expected, mutate] of variants) {
    await t.test(name, async () => {
      const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paginated-history-boundary-")));
      try {
        const root = path.join(temp, "codex-home");
        const parentTimestamp = "2026-09-01T10:00:00.000Z";
        const childTimestamp = "2026-09-01T11:00:00.000Z";
        const parent = [sessionMeta(PARENT_ID, PROJECT_PARENT, parentTimestamp), turn(1, "gpt-5.5", "2026-09-01T10:00:01.000Z")];
        const base = prefixBoundary(parent).historyBase;
        await writeRollout(root, "active", parentTimestamp, PARENT_ID, parent);
        await writeRollout(root, "active", childTimestamp, CHILD_ID, [sessionMeta(CHILD_ID, PROJECT_CHILD, childTimestamp, { forked_from_id: PARENT_ID, history_base: mutate(base) })]);
        await assert.rejects(() => exportArchive({ codexHome: root, scope: "recorded-project", recordedProjectPath: PROJECT_CHILD, outputDirectory: path.join(temp, "output"), exportProfile: "readable" }), errorCode(expected));
      } finally {
        await fs.rm(temp, { recursive: true, force: true });
      }
    });
  }
});

test("multi-stage history reuses selected full Raw sources without duplicate physical prefixes", async () => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paginated-history-chain-")));
  try {
    const root = path.join(temp, "codex-home");
    const parentTimestamp = "2026-09-01T10:00:00.000Z";
    const childTimestamp = "2026-09-01T11:00:00.000Z";
    const grandTimestamp = "2026-09-01T12:00:00.000Z";
    const parent = [sessionMeta(PARENT_ID, PROJECT_CHILD, parentTimestamp), turn(1, "gpt-5.5", "2026-09-01T10:00:01.000Z"), assistant(2, "CHAIN_PARENT", "2026-09-01T10:00:02.000Z")];
    const parentBoundary = prefixBoundary(parent);
    const child = [sessionMeta(CHILD_ID, PROJECT_CHILD, childTimestamp, { forked_from_id: PARENT_ID, history_base: parentBoundary.historyBase }, 3), turn(4, "gpt-5.6-sol", "2026-09-01T11:00:01.000Z", PROJECT_CHILD), assistant(5, "CHAIN_CHILD", "2026-09-01T11:00:02.000Z")];
    const childBytes = jsonl(child);
    const childBoundary = { thread_id: CHILD_ID, end_ordinal_exclusive: 6, end_byte_offset: childBytes.length };
    const grand = [sessionMeta(GRANDCHILD_ID, PROJECT_CHILD, grandTimestamp, { forked_from_id: CHILD_ID, history_base: childBoundary }, 6), assistant(7, "CHAIN_GRANDCHILD", "2026-09-01T12:00:01.000Z")];
    await writeRollout(root, "active", parentTimestamp, PARENT_ID, parent);
    await writeRollout(root, "active", childTimestamp, CHILD_ID, child);
    await writeRollout(root, "active", grandTimestamp, GRANDCHILD_ID, grand);
    await writeIndex(root, [
      { id: PARENT_ID, thread_name: "Chain parent" },
      { id: CHILD_ID, thread_name: "Chain child" },
      { id: GRANDCHILD_ID, thread_name: "Chain grandchild" },
    ]);
    const output = path.join(temp, "output");
    await exportArchive({ codexHome: root, scope: "all", outputDirectory: output, exportProfile: "complete" });
    const manifest = JSON.parse(await fs.readFile(path.join(output, "manifest.json"), "utf8"));
    assert.equal(manifest.sessions.length, 3);
    assert.equal(manifest.history_reference_closure.length, 2);
    assert.ok(manifest.history_reference_closure.flatMap((entry) => entry.segments).every((segment) => segment.snapshot_kind === "SELECTED_FULL_SOURCE"));
    assert.equal((await filesWithExtension(path.join(output, "raw"), ".jsonl")).length, 3);
    assert.equal(await fs.stat(path.join(output, "raw", "history-prefixes")).then(() => true, () => false), false);
    const grandRow = manifest.sessions.find((row) => row.session_id === GRANDCHILD_ID);
    const grandMarkdown = await fs.readFile(path.join(output, grandRow.markdown_file), "utf8");
    for (const marker of ["CHAIN_PARENT", "CHAIN_CHILD", "CHAIN_GRANDCHILD"]) assert.equal(grandMarkdown.split(marker).length - 1, 1);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("shared parent prefixes are stored once and accepted by previous-generation validation", async () => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paginated-history-shared-prefix-")));
  try {
    const root = path.join(temp, "codex-home");
    const parentTimestamp = "2026-09-01T10:00:00.000Z";
    const parent = [sessionMeta(PARENT_ID, PROJECT_PARENT, parentTimestamp), assistant(1, "SHARED_PARENT_PREFIX", "2026-09-01T10:00:01.000Z")];
    const historyBase = prefixBoundary(parent).historyBase;
    await writeRollout(root, "active", parentTimestamp, PARENT_ID, parent);
    for (const [id, timestamp, marker] of [
      [CHILD_ID, "2026-09-01T11:00:00.000Z", "SHARED_CHILD_ONE"],
      [GRANDCHILD_ID, "2026-09-01T12:00:00.000Z", "SHARED_CHILD_TWO"],
    ]) {
      await writeRollout(root, "active", timestamp, id, [sessionMeta(id, PROJECT_CHILD, timestamp, { forked_from_id: PARENT_ID, history_base: historyBase }, 2), assistant(3, marker, timestamp)]);
    }
    const output = path.join(temp, "output");
    await exportArchive({ codexHome: root, scope: "recorded-project", recordedProjectPath: PROJECT_CHILD, outputDirectory: output, exportProfile: "complete" });
    const firstManifest = JSON.parse(await fs.readFile(path.join(output, "manifest.json"), "utf8"));
    const segments = firstManifest.history_reference_closure.flatMap((closure) => closure.segments);
    assert.equal(new Set(segments.map((segment) => segment.snapshot_file)).size, 1);
    assert.equal((await filesWithExtension(path.join(output, "raw", "history-prefixes"), ".jsonl")).length, 1);
    await exportArchive({ codexHome: root, scope: "recorded-project", recordedProjectPath: PROJECT_CHILD, outputDirectory: output, exportProfile: "complete" });
    assert.equal((await filesWithExtension(path.join(output, "raw", "history-prefixes"), ".jsonl")).length, 1);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("cancellation during parent-prefix publication preserves foreign files and leaves no temporary prefix", async () => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paginated-history-abort-")));
  try {
    const root = path.join(temp, "codex-home");
    await createParentChild(root);
    const output = path.join(temp, "output");
    await fs.mkdir(output);
    const foreign = path.join(output, "foreign.txt");
    await fs.writeFile(foreign, "FOREIGN", "utf8");
    const controller = new AbortController();
    await assert.rejects(() => exportArchive({
      codexHome: root,
      scope: "recorded-project",
      recordedProjectPath: PROJECT_CHILD,
      outputDirectory: output,
      exportProfile: "complete",
      abortSignal: controller.signal,
      _historyOptions: { beforePrefixChunk: () => controller.abort() },
    }), errorCode("EXPORT_CANCELLED"));
    assert.equal(await fs.readFile(foreign, "utf8"), "FOREIGN");
    assert.equal(await fs.stat(path.join(output, INCOMPLETE_MARKER_NAME)).then(() => true, () => false), true);
    const allFiles = await filesWithExtension(output, "");
    assert.equal(allFiles.some((file) => file.includes(".partial-") || file.includes(".previous-")), false);
    assert.equal(allFiles.some((file) => file.includes(`${path.sep}history-prefixes${path.sep}`)), false);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("cancellation during inherited parent streaming stops before a completed export", async () => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paginated-history-stream-abort-")));
  try {
    const root = path.join(temp, "codex-home");
    await createParentChild(root);
    const output = path.join(temp, "output");
    const controller = new AbortController();
    let hashInstance = 0;
    const rawHashFactory = () => {
      hashInstance += 1;
      const hash = createHash("sha256");
      return {
        update(chunk) {
          hash.update(chunk);
          if (hashInstance === 2) controller.abort();
          return this;
        },
        digest(encoding) { return hash.digest(encoding); },
      };
    };
    await assert.rejects(() => exportArchive({
      codexHome: root,
      scope: "recorded-project",
      recordedProjectPath: PROJECT_CHILD,
      outputDirectory: output,
      exportProfile: "readable",
      abortSignal: controller.signal,
      _readerOptions: { inputChunkBytes: 32, rawHashFactory },
    }), errorCode("EXPORT_CANCELLED"));
    assert.equal(await fs.stat(path.join(output, INCOMPLETE_MARKER_NAME)).then(() => true, () => false), true);
    assert.equal(await fs.stat(path.join(output, "manifest.json")).then(() => true, () => false), false);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("a parent changed during prefix publication fails closed", async () => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paginated-history-change-")));
  try {
    const root = path.join(temp, "codex-home");
    const fixture = await createParentChild(root);
    let changed = false;
    await assert.rejects(() => exportArchive({
      codexHome: root,
      scope: "recorded-project",
      recordedProjectPath: PROJECT_CHILD,
      outputDirectory: path.join(temp, "output"),
      exportProfile: "complete",
      _historyOptions: {
        beforePrefixChunk: async () => {
          if (changed) return;
          changed = true;
          await fs.appendFile(fixture.parentFile, "\n");
        },
      },
    }), errorCode("SOURCE_CHANGED_DURING_EXPORT"));
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("a child changed between metadata and delta streaming fails closed", async () => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paginated-history-child-race-")));
  try {
    const codexHome = path.join(temp, "codex-home");
    const fixture = await createParentChild(codexHome);
    const originalBytes = await fs.readFile(fixture.childFile);
    let childOpenCount = 0;
    const output = path.join(temp, "output");
    await assert.rejects(() => exportArchive({
      codexHome,
      scope: "recorded-project",
      recordedProjectPath: PROJECT_CHILD,
      outputDirectory: output,
      exportProfile: "readable",
      _readerOptions: {
        io: {
          createReadStream(file, options) {
            const input = fsSync.createReadStream(file, options);
            if (path.resolve(file) !== path.resolve(fixture.childFile) || ++childOpenCount !== 1) return input;
            const destroy = input._destroy.bind(input);
            input._destroy = (error, callback) => destroy(error, (destroyError) => {
              fsSync.writeFileSync(fixture.childFile, Buffer.concat([originalBytes, Buffer.from(" ")]));
              callback(destroyError);
            });
            return input;
          },
        },
      },
    }), errorCode("SOURCE_CHANGED_DURING_EXPORT"));
    assert.equal(await fs.stat(path.join(output, "manifest.json")).then(() => true, () => false), false);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("final verification rejects a published prefix changed after its initial hash check", async () => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paginated-history-published-change-")));
  try {
    const root = path.join(temp, "codex-home");
    await createParentChild(root);
    const output = path.join(temp, "output");
    const foreign = path.join(output, "foreign.txt");
    await fs.mkdir(output);
    await fs.writeFile(foreign, "FOREIGN", "utf8");
    await assert.rejects(() => exportArchive({
      codexHome: root,
      scope: "recorded-project",
      recordedProjectPath: PROJECT_CHILD,
      outputDirectory: output,
      exportProfile: "complete",
      _historyOptions: {
        afterPrefixPublication: async ({ destination }) => fs.writeFile(destination, "CHANGED", "utf8"),
      },
    }), errorCode("EXPORT_VERIFICATION_FAILED"));
    assert.equal(await fs.readFile(foreign, "utf8"), "FOREIGN");
    assert.equal(await fs.stat(path.join(output, INCOMPLETE_MARKER_NAME)).then(() => true, () => false), true);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("selected metadata beyond the bounded first-record limit fails closed", async () => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paginated-history-metadata-limit-")));
  try {
    const root = path.join(temp, "codex-home");
    const parentTimestamp = "2026-09-01T10:00:00.000Z";
    const childTimestamp = "2026-09-01T11:00:00.000Z";
    const parent = [sessionMeta(PARENT_ID, PROJECT_PARENT, parentTimestamp), assistant(1, "PARENT", parentTimestamp)];
    const boundary = prefixBoundary(parent).historyBase;
    await writeRollout(root, "active", parentTimestamp, PARENT_ID, parent);
    const oversizedMeta = sessionMeta(CHILD_ID, PROJECT_CHILD, childTimestamp, {
      unrelated: "x".repeat((16 * 1024 * 1024) + 1),
      forked_from_id: PARENT_ID,
      history_base: boundary,
    }, boundary.end_ordinal_exclusive);
    await writeRollout(root, "active", childTimestamp, CHILD_ID, [oversizedMeta, assistant(3, "CHILD", childTimestamp)]);
    await assert.rejects(() => exportArchive({
      codexHome: root,
      scope: "all",
      outputDirectory: path.join(temp, "output"),
      exportProfile: "complete",
    }), errorCode("SESSION_METADATA_LIMIT_EXCEEDED"));
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("project selection cannot silently omit an unclassifiable oversized metadata record", async () => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paginated-history-metadata-selection-limit-")));
  try {
    const root = path.join(temp, "codex-home");
    const timestamp = "2026-09-01T12:00:00.000Z";
    await writeRollout(root, "active", timestamp, CHILD_ID, [sessionMeta(CHILD_ID, PROJECT_CHILD, timestamp), assistant(1, "VISIBLE", timestamp)]);
    const oversizedMeta = sessionMeta(GRANDCHILD_ID, PROJECT_UNKNOWN, timestamp, {
      unrelated: "x".repeat((16 * 1024 * 1024) + 1),
    });
    await writeRollout(root, "active", "2026-09-01T12:01:00.000Z", GRANDCHILD_ID, [oversizedMeta]);
    await assert.rejects(() => exportArchive({
      codexHome: root,
      scope: "recorded-project",
      recordedProjectPath: PROJECT_CHILD,
      outputDirectory: path.join(temp, "output"),
      exportProfile: "complete",
    }), errorCode("SESSION_METADATA_LIMIT_EXCEEDED"));
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("compressed rollouts are discovered but fail explicitly before export", { skip: !zstdCompress }, async () => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paginated-history-zstd-")));
  try {
    const root = path.join(temp, "codex-home");
    const timestamp = "2026-09-01T14:00:00.000Z";
    const records = [sessionMeta(CHILD_ID, PROJECT_CHILD, timestamp), assistant(1, "COMPRESSED_CONTENT", timestamp)];
    const directory = path.join(root, "sessions", "2026", "09", "01");
    await fs.mkdir(directory, { recursive: true });
    const compressed = path.join(directory, `${rolloutName(timestamp, CHILD_ID)}.zst`);
    await fs.writeFile(compressed, await zstdCompress(jsonl(records), { params: { [zlib.constants.ZSTD_c_compressionLevel]: 3 } }));
    const discovery = await readSessionDiscoveryMeta(compressed);
    assert.equal(discovery.compressed, true);
    assert.equal(discovery.id, CHILD_ID);
    assert.equal(discovery.cwd, PROJECT_CHILD);
    await assert.rejects(() => exportArchive({ codexHome: root, scope: "recorded-project", recordedProjectPath: PROJECT_CHILD, outputDirectory: path.join(temp, "output"), exportProfile: "readable" }), errorCode("COMPRESSED_ROLLOUT_UNSUPPORTED"));

    const corrupt = path.join(directory, `${rolloutName("2026-09-01T15:00:00.000Z", GRANDCHILD_ID)}.zst`);
    await fs.writeFile(corrupt, Buffer.from("not-zstandard", "utf8"));
    await assert.rejects(() => readSessionDiscoveryMeta(corrupt), errorCode("COMPRESSED_ROLLOUT_INVALID"));
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("a compressed Parent reference fails before history-prefix reconstruction", { skip: !zstdCompress }, async () => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paginated-history-zstd-parent-")));
  try {
    const root = path.join(temp, "codex-home");
    const parentTimestamp = "2026-09-01T14:00:00.000Z";
    const childTimestamp = "2026-09-01T15:00:00.000Z";
    const parent = [sessionMeta(PARENT_ID, PROJECT_PARENT, parentTimestamp), assistant(1, "COMPRESSED_PARENT", parentTimestamp)];
    const boundary = prefixBoundary(parent).historyBase;
    const archived = path.join(root, "archived_sessions");
    await fs.mkdir(archived, { recursive: true });
    await fs.writeFile(path.join(archived, `${rolloutName(parentTimestamp, PARENT_ID)}.zst`), await zstdCompress(jsonl(parent)));
    await writeRollout(root, "active", childTimestamp, CHILD_ID, [sessionMeta(CHILD_ID, PROJECT_CHILD, childTimestamp, { forked_from_id: PARENT_ID, history_base: boundary }, 2), assistant(3, "CHILD", childTimestamp)]);
    await assert.rejects(() => exportArchive({
      codexHome: root,
      scope: "recorded-project",
      recordedProjectPath: PROJECT_CHILD,
      outputDirectory: path.join(temp, "output"),
      exportProfile: "readable",
    }), errorCode("COMPRESSED_ROLLOUT_UNSUPPORTED"));
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("an uncompressed rollout shadows its compressed sibling deterministically", { skip: !zstdCompress }, async () => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paginated-history-shadow-")));
  try {
    const root = path.join(temp, "codex-home");
    const timestamp = "2026-09-01T16:00:00.000Z";
    const records = [sessionMeta(CHILD_ID, PROJECT_CHILD, timestamp), assistant(1, "PLAIN_SOURCE_WINS", timestamp)];
    const plain = await writeRollout(root, "active", timestamp, CHILD_ID, records);
    await fs.writeFile(`${plain}.zst`, await zstdCompress(jsonl([sessionMeta(CHILD_ID, PROJECT_CHILD, timestamp), assistant(1, "COMPRESSED_SHADOW", timestamp)])));
    const output = path.join(temp, "output");
    await exportArchive({ codexHome: root, scope: "all", outputDirectory: output, exportProfile: "readable" });
    const markdown = (await transcriptText(output)).markdown;
    assert.match(markdown, /PLAIN_SOURCE_WINS/);
    assert.equal(markdown.includes("COMPRESSED_SHADOW"), false);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});
