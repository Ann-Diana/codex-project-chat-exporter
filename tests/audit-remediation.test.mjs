import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import zlib from "node:zlib";

import JSZip from "jszip";
import PDFDocument from "pdfkit";

import { exportArchive } from "../bin/export-codex-project-chats.mjs";

const execFileAsync = promisify(execFile);

const THREAD_ID = "11111111-1111-7111-8111-111111111111";
const OTHER_ID = "22222222-2222-7222-8222-222222222222";
const ROLLOUT_A = "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa";
const ROLLOUT_B = "bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb";
const ROLLOUT_C = "cccccccc-cccc-7ccc-8ccc-cccccccccccc";
const ROLLOUT_D = "dddddddd-dddd-7ddd-8ddd-dddddddddddd";
const AT = "2026-09-01T10:00:00.000Z";
const PROJECT = "C:\\Synthetic\\AuditRemediation";
const PARENT_PROJECT = "C:\\Synthetic\\AuditRemediationParent";
const PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function count(text, token) {
  return text.split(token).length - 1;
}

function sessionMeta(id = THREAD_ID, cwd = PROJECT, extra = {}, ordinal = 0) {
  return { ordinal, type: "session_meta", timestamp: AT, payload: { id, cwd, timestamp: AT, thread_source: "user", history_mode: "paginated", ...extra } };
}

function message(ordinal, text, content = null) {
  return { ordinal, type: "response_item", timestamp: AT, payload: { type: "message", role: "assistant", content: content || [{ type: "output_text", text }] } };
}

function response(ordinal, type, extra) {
  return { ordinal, type: "response_item", timestamp: AT, payload: { type, ...extra } };
}

function jsonl(records) {
  return Buffer.from(`${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

async function writeRollout(root, { records, stable = THREAD_ID, rollout = "", storage = "active" }) {
  const directory = path.join(root, storage === "archived" ? "archived_sessions" : "sessions");
  await fs.mkdir(directory, { recursive: true });
  const suffix = rollout ? `_${rollout}` : "";
  const file = path.join(directory, `rollout-2026-09-01T10-00-00-${stable}${suffix}.jsonl`);
  await fs.writeFile(file, jsonl(records));
  return file;
}

async function exportFixture(root, output, options = {}) {
  await exportArchive({ codexHome: root, scope: "all", outputDirectory: output, exportProfile: "complete", includeTools: true, ...options });
  return JSON.parse(await fs.readFile(path.join(output, "manifest.json"), "utf8"));
}

async function withTemp(prefix, run) {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  try {
    return await run(temp);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}

async function arrangeSameThreadChain(root, aliases, referencedRollout = aliases[0].rollout) {
  const parent = [sessionMeta(THREAD_ID, PARENT_PROJECT), message(1, "SYNTHETIC_PARENT")];
  const boundary = { thread_id: referencedRollout, end_ordinal_exclusive: 2, end_byte_offset: jsonl(parent).length };
  for (const alias of aliases) await writeRollout(root, { records: parent, stable: THREAD_ID, ...alias });
  await writeRollout(root, {
    records: [sessionMeta(THREAD_ID, PROJECT, { history_base: boundary }, 2), message(3, "SYNTHETIC_CHILD")],
    stable: THREAD_ID,
    rollout: ROLLOUT_B,
  });
}

test("full-byte alias equivalence resolves canonical, noncanonical and three-alias continuation references", async (t) => {
  for (const fixture of [
    { name: "canonical active alias", aliases: [{ rollout: ROLLOUT_A }, { rollout: ROLLOUT_A, storage: "archived" }], referenced: ROLLOUT_A, expected: 3 },
    { name: "noncanonical archived alias", aliases: [{ rollout: ROLLOUT_A }, { rollout: ROLLOUT_C, storage: "archived" }], referenced: ROLLOUT_C, expected: 3 },
    { name: "three aliases", aliases: [{ rollout: ROLLOUT_A }, { rollout: ROLLOUT_C, storage: "archived" }, { rollout: ROLLOUT_D }], referenced: ROLLOUT_D, expected: 4 },
  ]) {
    await t.test(fixture.name, () => withTemp("exporter-alias-equivalence-", async (temp) => {
      const root = path.join(temp, "home");
      await arrangeSameThreadChain(root, fixture.aliases, fixture.referenced);
      const manifest = await exportFixture(root, path.join(temp, "out"), { scope: "recorded-project", recordedProjectPath: PROJECT });
      const thread = manifest.coverage.logical_threads[0];
      assert.equal(thread.reconstruction.status, "CHAIN_VALID");
      assert.equal(manifest.coverage.physical_sources.length, fixture.expected);
      assert.equal(thread.outer_records.total, fixture.expected * 2);
      assert.equal(thread.inner_units.total, 2);
      const aliases = manifest.coverage.physical_sources.filter((source) => source.rollout_id !== ROLLOUT_B);
      assert.ok(aliases.every((source) => source.full_sha256 && source.full_size_bytes));
      assert.equal(new Set(aliases.map((source) => `${source.full_size_bytes}:${source.full_sha256}`)).size, 1);
    }));
  }
});

test("same-size nonidentical and prefix-only sources are never promoted to full-byte aliases", async (t) => {
  await t.test("same size but different bytes", () => withTemp("exporter-nonidentical-alias-", async (temp) => {
    const root = path.join(temp, "home");
    const first = [sessionMeta(THREAD_ID, PARENT_PROJECT), message(1, "PARENT_A")];
    const second = [sessionMeta(THREAD_ID, PARENT_PROJECT), message(1, "PARENT_B")];
    assert.equal(jsonl(first).length, jsonl(second).length);
    await writeRollout(root, { records: first, rollout: ROLLOUT_A });
    await writeRollout(root, { records: second, rollout: ROLLOUT_C, storage: "archived" });
    await writeRollout(root, { records: [sessionMeta(THREAD_ID, PROJECT, { history_base: { thread_id: ROLLOUT_A, end_ordinal_exclusive: 2, end_byte_offset: jsonl(first).length } }, 2), message(3, "CHILD")], rollout: ROLLOUT_B });
    await assert.rejects(() => exportFixture(root, path.join(temp, "out"), { scope: "recorded-project", recordedProjectPath: PROJECT }), (error) => error?.code === "PHYSICAL_SOURCE_RELATION_UNRESOLVED");
  }));
  await t.test("matching prefix but different suffix", () => withTemp("exporter-prefix-only-alias-", async (temp) => {
    const root = path.join(temp, "home");
    const prefix = [sessionMeta(THREAD_ID, PARENT_PROJECT), message(1, "COMMON")];
    const first = [...prefix, message(2, "SUFFIX_A")];
    const second = [...prefix, message(2, "SUFFIX_B")];
    await writeRollout(root, { records: first, rollout: ROLLOUT_A });
    await writeRollout(root, { records: second, rollout: ROLLOUT_C, storage: "archived" });
    await writeRollout(root, { records: [sessionMeta(THREAD_ID, PROJECT, { history_base: { thread_id: ROLLOUT_A, end_ordinal_exclusive: 2, end_byte_offset: jsonl(prefix).length } }, 2), message(3, "CHILD")], rollout: ROLLOUT_B });
    await assert.rejects(() => exportFixture(root, path.join(temp, "out"), { scope: "recorded-project", recordedProjectPath: PROJECT }), (error) => error?.code === "PHYSICAL_SOURCE_RELATION_UNRESOLVED");
  }));
});

test("a full-byte alias changed after inventory fails closed", () => withTemp("exporter-mutated-alias-", async (temp) => {
  const root = path.join(temp, "home");
  const aliases = [{ rollout: ROLLOUT_A }, { rollout: ROLLOUT_C, storage: "archived" }];
  await arrangeSameThreadChain(root, aliases, ROLLOUT_C);
  const mutated = path.join(root, "archived_sessions", `rollout-2026-09-01T10-00-00-${THREAD_ID}_${ROLLOUT_C}.jsonl`);
  let changed = false;
  await assert.rejects(() => exportFixture(root, path.join(temp, "out"), {
    scope: "recorded-project",
    recordedProjectPath: PROJECT,
    onDiagnostic(event) {
      if (!changed && event.event === "session_start") {
        changed = true;
        fsSync.appendFileSync(mutated, " ", "utf8");
      }
    },
  }), (error) => ["SOURCE_CHANGED_DURING_EXPORT", "PROTECTED_SOURCE_CHANGED"].includes(error?.code));
  assert.equal(changed, true);
}));

test("shadowed compressed sources remain physical inventory entries without parsed or identity claims", async (t) => {
  await t.test("plain only", () => withTemp("exporter-plain-only-", async (temp) => {
    const root = path.join(temp, "home");
    await writeRollout(root, { records: [sessionMeta(), message(1, "PLAIN")] });
    const manifest = await exportFixture(root, path.join(temp, "out"));
    assert.equal(manifest.coverage.physical_sources.length, 1);
    assert.equal(manifest.coverage.physical_sources[0].source_representation, "jsonl");
  }));
  await t.test("compressed only", () => withTemp("exporter-compressed-only-", async (temp) => {
    const root = path.join(temp, "home");
    const plain = await writeRollout(root, { records: [sessionMeta(), message(1, "COMPRESSED")] });
    await fs.writeFile(`${plain}.zst`, zlib.zstdCompressSync(await fs.readFile(plain)));
    await fs.unlink(plain);
    await assert.rejects(() => exportFixture(root, path.join(temp, "out")), (error) => error?.code === "COMPRESSED_ROLLOUT_UNSUPPORTED");
  }));
  await t.test("active and archived pairs", () => withTemp("exporter-shadow-pairs-", async (temp) => {
    const root = path.join(temp, "home");
    for (const fixture of [
      { stable: THREAD_ID, storage: "active", text: "ACTIVE" },
      { stable: OTHER_ID, storage: "archived", text: "ARCHIVED" },
    ]) {
      const plain = await writeRollout(root, { records: [sessionMeta(fixture.stable), message(1, fixture.text)], stable: fixture.stable, storage: fixture.storage });
      await fs.writeFile(`${plain}.zst`, zlib.zstdCompressSync(jsonl([sessionMeta(fixture.stable), message(1, `${fixture.text}_DIFFERENT`)])));
    }
    const manifest = await exportFixture(root, path.join(temp, "out"));
    assert.equal(manifest.coverage.physical_sources.length, 4);
    const shadows = manifest.coverage.physical_sources.filter((source) => source.source_representation === "jsonl_zstd");
    assert.equal(shadows.length, 2);
    for (const shadow of shadows) {
      assert.equal(shadow.full_sha256, null);
      assert.equal(shadow.full_file_record_count, null);
      assert.equal(shadow.usages.length, 1);
      assert.equal(shadow.usages[0].relation_status, "SHADOWED_BY_UNCOMPRESSED");
      assert.equal(shadow.usages[0].identity_evidence, null);
      assert.deepEqual(shadow.usages[0].read_ranges, []);
      assert.ok(shadow.usages[0].canonical_source_id);
    }
  }));
});

test("history-prefix aliases and repeated Child metadata have independent hand-counted physical coverage", async (t) => {
  await t.test("one range per byte-identical prefix occurrence", () => withTemp("exporter-prefix-count-", async (temp) => {
    const root = path.join(temp, "home");
    const parent = [sessionMeta(THREAD_ID, PARENT_PROJECT), message(1, "PARENT")];
    const boundary = { thread_id: THREAD_ID, end_ordinal_exclusive: 2, end_byte_offset: jsonl(parent).length };
    await writeRollout(root, { records: parent });
    await writeRollout(root, { records: parent, storage: "archived" });
    await writeRollout(root, { records: [sessionMeta(OTHER_ID, PROJECT, { history_base: boundary }, 2), message(3, "CHILD")], stable: OTHER_ID });
    const manifest = await exportFixture(root, path.join(temp, "out"), { scope: "recorded-project", recordedProjectPath: PROJECT });
    const thread = manifest.coverage.logical_threads[0];
    assert.equal(thread.outer_records.total, 6);
    assert.equal(thread.inner_units.total, 2);
    const parentSources = manifest.coverage.physical_sources.filter((source) => source.thread_id === THREAD_ID);
    assert.equal(parentSources.length, 2);
    assert.ok(parentSources.every((source) => source.usages[0].read_ranges.length === 1));
    assert.ok(parentSources.every((source) => source.usages[0].read_ranges[0].record_count === 2));
  }));
  await t.test("repeated Child metadata is consumed once as a repeated record", () => withTemp("exporter-child-meta-count-", async (temp) => {
    const root = path.join(temp, "home");
    const parent = [sessionMeta(THREAD_ID, PARENT_PROJECT), message(1, "PARENT")];
    const boundary = { thread_id: THREAD_ID, end_ordinal_exclusive: 2, end_byte_offset: jsonl(parent).length };
    await writeRollout(root, { records: parent });
    const childMeta = sessionMeta(OTHER_ID, PROJECT, { history_base: boundary }, 2);
    await writeRollout(root, { records: [childMeta, childMeta, message(3, "CHILD")], stable: OTHER_ID });
    const manifest = await exportFixture(root, path.join(temp, "out"), { scope: "recorded-project", recordedProjectPath: PROJECT });
    const thread = manifest.coverage.logical_threads[0];
    assert.equal(thread.outer_records.total, 5);
    assert.equal(thread.outer_records.classifications.KNOWN_CONTROL_RECORD, 3);
    assert.equal(thread.anomalies.duplicate_ordinal, 1);
    const childSource = manifest.coverage.physical_sources.find((source) => source.thread_id === OTHER_ID);
    assert.equal(childSource.full_file_record_count, 3);
    assert.equal(childSource.usages[0].read_ranges[0].record_count, 3);
  }));
});

test("message-content coverage separates known, unsupported and unknown inner units", () => withTemp("exporter-content-coverage-", async (temp) => {
  const root = path.join(temp, "home");
  await writeRollout(root, { records: [
    sessionMeta(),
    { ordinal: 1, type: "event_msg", timestamp: AT, payload: { type: "token_count", input_tokens: 1 } },
    { ordinal: 2, type: "future_outer", timestamp: AT },
    { ordinal: 3, type: "future_outer_with_payload", timestamp: AT, payload: { data: "RAW_ONLY" } },
    message(4, "", [{ type: "output_text", text: "VISIBLE" }, { type: "future_content", data: "RAW_ONLY" }]),
  ] });
  const base = await exportFixture(root, path.join(temp, "base"), { includeTools: false });
  const manifest = await exportFixture(root, path.join(temp, "documents"), { includeTools: false, documentFormats: ["docx", "pdf"] });
  const thread = manifest.coverage.logical_threads[0];
  assert.deepEqual(manifest.coverage.logical_threads, base.coverage.logical_threads);
  assert.equal(thread.outer_records.total, 5);
  assert.equal(thread.outer_records.classifications.UNKNOWN_RECORD_TYPE, 2);
  assert.equal(thread.inner_units.total, 4);
  assert.equal(thread.inner_units.dispositions.RENDERED, 1);
  assert.equal(thread.inner_units.dispositions.UNKNOWN_RAW_ONLY, 3);
  assert.equal(thread.reading_view.status, "INDETERMINATE");
  assert.equal(thread.anomalies.unknown_inner_type, 1);
  assert.equal(manifest.archive_format_version, 1);
  assert.equal(manifest.coverage_schema_version, 1);
  assert.equal(manifest.coverage.formats.markdown.status, "VERIFIED_AT_EXPORT");
  assert.equal(manifest.coverage.formats.docx.status, "VERIFIED_AT_EXPORT");
  assert.equal(manifest.coverage.formats.pdf.status, "VERIFIED_AT_EXPORT");
}));

test("known unsupported conversation content is PARTIAL while unknown outer records stay indeterminate", async (t) => {
  await t.test("known unsupported message part", () => withTemp("exporter-known-raw-only-", async (temp) => {
    const root = path.join(temp, "home");
    await writeRollout(root, { records: [sessionMeta(), message(1, "", [{ type: "refusal", refusal: "SYNTHETIC" }])] });
    const manifest = await exportFixture(root, path.join(temp, "out"));
    const thread = manifest.coverage.logical_threads[0];
    assert.equal(thread.inner_units.total, 1);
    assert.equal(thread.inner_units.dispositions.KNOWN_CONTENT_RAW_ONLY, 1);
    assert.equal(thread.reading_view.status, "PARTIAL");
  }));
  await t.test("payload-free unknown outer record", () => withTemp("exporter-technical-unknown-", async (temp) => {
    const root = path.join(temp, "home");
    await writeRollout(root, { records: [sessionMeta(), { ordinal: 1, type: "future_technical", timestamp: AT }, message(2, "VISIBLE")] });
    const manifest = await exportFixture(root, path.join(temp, "out"));
    const thread = manifest.coverage.logical_threads[0];
    assert.equal(thread.outer_records.classifications.UNKNOWN_RECORD_TYPE, 1);
    assert.equal(thread.inner_units.dispositions.UNKNOWN_RAW_ONLY, 1);
    assert.equal(thread.reading_view.status, "INDETERMINATE");
    assert.deepEqual(thread.semantic_gaps, [{
      disposition: "UNKNOWN_RAW_ONLY",
      reason_code: "UNKNOWN_OUTER_RECORD_BODY",
      structure_path: "$",
      record_type: "future_technical",
      inner_type: "empty_string",
      count: 1,
    }]);
  }));
});

test("inherited child assets use the canonical logical record number without weakening integrity", () => withTemp("exporter-history-asset-", async (temp) => {
  const root = path.join(temp, "home");
  const parent = [sessionMeta(THREAD_ID, PARENT_PROJECT), message(1, "PARENT")];
  const boundary = { thread_id: THREAD_ID, end_ordinal_exclusive: 2, end_byte_offset: jsonl(parent).length };
  await writeRollout(root, { records: parent });
  const child = [sessionMeta(OTHER_ID, PROJECT, { history_base: boundary }, 2), message(3, "", [{ type: "input_image", image_url: PNG_DATA_URL }])];
  const childFile = await writeRollout(root, { records: child, stable: OTHER_ID });
  const manifest = await exportFixture(root, path.join(temp, "out"), { scope: "recorded-project", recordedProjectPath: PROJECT });
  const assets = JSON.parse(await fs.readFile(path.join(temp, "out", "assets", "manifest.json"), "utf8"));
  assert.equal(assets.assets.length, 1);
  assert.equal(assets.assets[0].uses.length, 1);
  assert.equal(assets.assets[0].uses[0].record_ordinal, 3);
  assert.equal(manifest.coverage.logical_threads[0].outer_records.total, 4);
  assert.deepEqual(await fs.readFile(path.join(temp, "out", manifest.sessions[0].raw_export_file)), await fs.readFile(childFile));
}));

test("empty call IDs never mirror while nonempty boundary whitespace remains opaque", () => withTemp("exporter-call-id-", async (temp) => {
  const root = path.join(temp, "home");
  const records = [sessionMeta()];
  let ordinal = 1;
  const content = [{ type: "text", text: "SYNTHETIC_TOOL_RESULT" }];
  for (const callId of ["", " ", "\t", "\n"]) {
    records.push({ ordinal: ordinal++, type: "event_msg", timestamp: AT, payload: { type: "mcp_tool_call_end", call_id: callId, result: { Ok: { content } } } });
    records.push(response(ordinal++, "function_call_output", { call_id: callId, output: content }));
  }
  records.push(response(ordinal++, "function_call", { call_id: " x ", name: "synthetic", arguments: "" }));
  records.push({ ordinal: ordinal++, type: "event_msg", timestamp: AT, payload: { type: "mcp_tool_call_end", call_id: " x ", result: { Ok: { content } } } });
  records.push(response(ordinal++, "function_call_output", { call_id: " x ", output: content }));
  records.push(response(ordinal++, "function_call_output", { call_id: "x", output: content }));
  await writeRollout(root, { records });
  const manifest = await exportFixture(root, path.join(temp, "out"));
  const thread = manifest.coverage.logical_threads[0];
  assert.equal(thread.inner_units.total, 12);
  assert.equal(thread.inner_units.dispositions.MIRRORED_OR_DEDUPLICATED, 1);
  assert.equal(thread.inner_units.dispositions.KNOWN_CONTENT_RAW_ONLY, 4);
  assert.equal(thread.tool_output_linkage.EMPTY_CALL_ID, 4);
  assert.equal(thread.tool_output_linkage.MATCHED, 1);
  assert.equal(thread.tool_output_linkage.UNMATCHED, 1);
  assert.equal(thread.anomalies.tool_output_empty_call_id, 4);
}));

test("replacement_history classifies each immediate content element without recursively multiplying unknown structures", async (t) => {
  const historyRecord = (content, extra = {}) => ({
    ordinal: 2,
    type: "compacted",
    timestamp: AT,
    payload: { replacement_history: [{ type: "message", role: "assistant", content, ...extra }] },
  });
  const cases = [
    {
      name: "known content only",
      content: [{ type: "output_text", text: "KNOWN_STORED" }],
      expected: { total: 2, rendered: 1, known: 1, unknown: 0, invalid: 0, status: "PARTIAL" },
    },
    {
      name: "one unknown typed element",
      content: [{ type: "future_content", data: "SYNTHETIC_UNKNOWN" }],
      expected: { total: 2, rendered: 1, known: 0, unknown: 1, invalid: 0, status: "INDETERMINATE" },
    },
    {
      name: "known and unknown content",
      content: [{ type: "output_text", text: "KNOWN_STORED" }, { type: "future_content", data: "SYNTHETIC_UNKNOWN" }],
      expected: { total: 3, rendered: 1, known: 1, unknown: 1, invalid: 0, status: "INDETERMINATE" },
    },
    {
      name: "two distinct unknown elements",
      content: [{ type: "future_one", data: 1 }, { type: "future_two", data: 2 }],
      expected: { total: 3, rendered: 1, known: 0, unknown: 2, invalid: 0, status: "INDETERMINATE" },
    },
    {
      name: "unknown object without type",
      content: [{ nested: { still: "one immediate unit" } }],
      expected: { total: 2, rendered: 1, known: 0, unknown: 1, invalid: 0, status: "INDETERMINATE" },
      expectedInnerType: "object",
    },
    {
      name: "unknown array element",
      content: [[{ type: "nested_future", data: [1, 2, 3] }]],
      expected: { total: 2, rendered: 1, known: 0, unknown: 1, invalid: 0, status: "INDETERMINATE" },
      expectedInnerType: "array",
    },
    {
      name: "nested unknown structure",
      content: [{ type: "future_nested", data: { branch: { leaves: [1, 2, 3] } } }],
      expected: { total: 2, rendered: 1, known: 0, unknown: 1, invalid: 0, status: "INDETERMINATE" },
      expectedInnerType: "future_nested",
    },
    {
      name: "known message metadata without conversation content is not an inner unit",
      content: [],
      extra: { status: "completed", metadata: { technical: true } },
      expected: { total: 1, rendered: 1, known: 0, unknown: 0, invalid: 0, status: "ACCOUNTED_FOR" },
    },
    {
      name: "known unsupported content",
      content: [{ type: "refusal", refusal: "SYNTHETIC_REFUSAL" }],
      expected: { total: 2, rendered: 1, known: 1, unknown: 0, invalid: 0, status: "PARTIAL" },
    },
    {
      name: "schema-invalid immediate content",
      content: [null],
      expected: { total: 2, rendered: 1, known: 0, unknown: 0, invalid: 1, status: "INDETERMINATE" },
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, () => withTemp("exporter-replacement-coverage-", async (temp) => {
      const root = path.join(temp, "home");
      const records = [sessionMeta(), message(1, "VISIBLE"), historyRecord(fixture.content, fixture.extra)];
      const source = await writeRollout(root, { records });
      const output = path.join(temp, "out");
      const manifest = await exportFixture(root, output);
      const thread = manifest.coverage.logical_threads[0];
      assert.equal(thread.outer_records.total, 3);
      assert.equal(thread.inner_units.total, fixture.expected.total);
      assert.equal(thread.inner_units.dispositions.RENDERED, fixture.expected.rendered);
      assert.equal(thread.inner_units.dispositions.KNOWN_CONTENT_RAW_ONLY, fixture.expected.known);
      assert.equal(thread.inner_units.dispositions.UNKNOWN_RAW_ONLY, fixture.expected.unknown);
      assert.equal(thread.inner_units.dispositions.SCHEMA_INVALID_RAW_ONLY, fixture.expected.invalid);
      assert.equal(thread.reading_view.status, fixture.expected.status);
      const gaps = thread.semantic_gaps || [];
      assert.equal(gaps.filter((entry) => entry.disposition === "UNKNOWN_RAW_ONLY").reduce((sum, entry) => sum + entry.count, 0), fixture.expected.unknown);
      assert.ok(gaps.every((entry) => entry.structure_path === "payload.replacement_history[*].content[*]"));
      assert.equal(JSON.stringify(gaps).includes("SYNTHETIC_UNKNOWN"), false);
      if (fixture.expectedInnerType) assert.equal(gaps.find((entry) => entry.disposition === "UNKNOWN_RAW_ONLY")?.inner_type, fixture.expectedInnerType);
      assert.deepEqual(await fs.readFile(path.join(output, manifest.sessions[0].raw_export_file)), await fs.readFile(source));
    }));
  }

  await t.test("shared semantic coverage is identical with Markdown, HTML, DOCX and PDF", () => withTemp("exporter-replacement-format-parity-", async (temp) => {
    const root = path.join(temp, "home");
    await writeRollout(root, { records: [
      sessionMeta(),
      message(1, "VISIBLE"),
      historyRecord([{ type: "input_image", image_url: PNG_DATA_URL }, { type: "future_content", nested: { value: true } }]),
    ] });
    const base = await exportFixture(root, path.join(temp, "base"));
    const documents = await exportFixture(root, path.join(temp, "documents"), { documentFormats: ["docx", "pdf"] });
    assert.deepEqual(documents.coverage.logical_threads, base.coverage.logical_threads);
    const thread = documents.coverage.logical_threads[0];
    assert.equal(thread.inner_units.total, 3);
    assert.equal(thread.inner_units.dispositions.RENDERED, 2);
    assert.equal(thread.inner_units.dispositions.UNKNOWN_RAW_ONLY, 1);
    assert.equal(thread.reading_view.status, "INDETERMINATE");
    assert.equal(documents.coverage.formats.markdown.status, "VERIFIED_AT_EXPORT");
    assert.equal(documents.coverage.formats.html.status, "VERIFIED_AT_EXPORT");
    assert.equal(documents.coverage.formats.docx.status, "VERIFIED_AT_EXPORT");
    assert.equal(documents.coverage.formats.pdf.status, "VERIFIED_AT_EXPORT");
  }));
});

test("replacement_history text and attachment children receive independent hand-counted dispositions", async (t) => {
  const marker = "SYNTHETIC_HISTORY_TEXT_MUST_NOT_BE_COVERED_BY_IMAGE";
  const textPart = (text = marker) => ({ type: "output_text", text });
  const imagePart = () => ({ type: "input_image", image_url: PNG_DATA_URL });
  const historyRecord = (content) => ({
    ordinal: 2,
    type: "compacted",
    timestamp: AT,
    payload: { replacement_history: [{ type: "message", role: "assistant", content }] },
  });
  const fixtures = [
    {
      name: "text before image",
      content: [textPart(), imagePart()],
      expected: { total: 3, rendered: 2, known: 1, unknown: 0, status: "PARTIAL" },
    },
    {
      name: "image before text",
      content: [imagePart(), textPart()],
      expected: { total: 3, rendered: 2, known: 1, unknown: 0, status: "PARTIAL" },
    },
    {
      name: "two texts and one image",
      content: [textPart(`${marker}_ONE`), imagePart(), textPart(`${marker}_TWO`)],
      expected: { total: 4, rendered: 2, known: 2, unknown: 0, status: "PARTIAL" },
    },
    {
      name: "text only",
      content: [textPart()],
      expected: { total: 2, rendered: 1, known: 1, unknown: 0, status: "PARTIAL" },
    },
    {
      name: "image only",
      content: [imagePart()],
      expected: { total: 2, rendered: 2, known: 0, unknown: 0, status: "ACCOUNTED_FOR" },
    },
    {
      name: "empty text and image",
      content: [textPart(""), imagePart()],
      expected: { total: 2, rendered: 2, known: 0, unknown: 0, status: "ACCOUNTED_FOR" },
    },
    {
      name: "known text and unknown content",
      content: [textPart(), { type: "future_content", value: "SYNTHETIC_UNKNOWN" }],
      expected: { total: 3, rendered: 1, known: 1, unknown: 1, status: "INDETERMINATE" },
    },
  ];

  for (const fixture of fixtures) {
    await t.test(fixture.name, () => withTemp("exporter-replacement-child-coverage-", async (temp) => {
      const root = path.join(temp, "home");
      const source = await writeRollout(root, { records: [sessionMeta(), message(1, "VISIBLE_CONTROL"), historyRecord(fixture.content)] });
      const output = path.join(temp, "out");
      const manifest = await exportFixture(root, output);
      const thread = manifest.coverage.logical_threads[0];
      assert.equal(thread.outer_records.total, 3);
      assert.equal(thread.inner_units.total, fixture.expected.total);
      assert.equal(thread.inner_units.dispositions.RENDERED, fixture.expected.rendered);
      assert.equal(thread.inner_units.dispositions.KNOWN_CONTENT_RAW_ONLY, fixture.expected.known);
      assert.equal(thread.inner_units.dispositions.UNKNOWN_RAW_ONLY, fixture.expected.unknown);
      assert.equal(thread.reading_view.status, fixture.expected.status);
      const markdown = await fs.readFile(path.join(output, manifest.sessions[0].markdown_file), "utf8");
      assert.equal(count(markdown, marker), 0, "unrepresented history text must not be reported as rendered");
      assert.equal(count(markdown, "VISIBLE_CONTROL"), 1);
      assert.deepEqual(await fs.readFile(path.join(output, manifest.sessions[0].raw_export_file)), await fs.readFile(source));
    }));
  }

  await t.test("Readable suppresses both known children while Source snapshots report no reading view", () => withTemp("exporter-replacement-profiles-", async (temp) => {
    const root = path.join(temp, "home");
    const source = await writeRollout(root, { records: [sessionMeta(), message(1, "VISIBLE_CONTROL"), historyRecord([textPart(), imagePart()])] });
    const readableOutput = path.join(temp, "readable");
    const readable = await exportFixture(root, readableOutput, { exportProfile: "readable" });
    const readableThread = readable.coverage.logical_threads[0];
    assert.equal(readableThread.inner_units.total, 3);
    assert.equal(readableThread.inner_units.dispositions.RENDERED, 1);
    assert.equal(readableThread.inner_units.dispositions.SUPPRESSED_BY_PROFILE, 2);
    assert.equal(readableThread.inner_units.dispositions.KNOWN_CONTENT_RAW_ONLY, 0);
    assert.equal(readableThread.reading_view.status, "ACCOUNTED_FOR");
    assert.equal(count(await fs.readFile(path.join(readableOutput, readable.sessions[0].markdown_file), "utf8"), marker), 0);
    assert.equal(readable.sessions[0].raw_export_file, "");

    const snapshotOutput = path.join(temp, "snapshots");
    const snapshots = await exportFixture(root, snapshotOutput, { exportProfile: "source-snapshots" });
    const snapshotThread = snapshots.coverage.logical_threads[0];
    assert.equal(snapshotThread.inner_units.total, 3);
    assert.equal(snapshotThread.inner_units.dispositions.SUPPRESSED_BY_PROFILE, 2);
    assert.equal(snapshotThread.inner_units.dispositions.KNOWN_CONTENT_RAW_ONLY, 1);
    assert.equal(snapshotThread.reading_view.status, "NOT_GENERATED");
    assert.deepEqual(await fs.readFile(path.join(snapshotOutput, snapshots.sessions[0].raw_export_file)), await fs.readFile(source));

    const unknownRoot = path.join(temp, "unknown-home");
    await writeRollout(unknownRoot, { records: [sessionMeta(), message(1, "VISIBLE_CONTROL"), historyRecord([textPart(), { type: "future_content", value: true }])] });
    const unknown = await exportFixture(unknownRoot, path.join(temp, "unknown-readable"), { exportProfile: "readable" });
    const unknownThread = unknown.coverage.logical_threads[0];
    assert.equal(unknownThread.inner_units.total, 3);
    assert.equal(unknownThread.inner_units.dispositions.RENDERED, 1);
    assert.equal(unknownThread.inner_units.dispositions.SUPPRESSED_BY_PROFILE, 1);
    assert.equal(unknownThread.inner_units.dispositions.UNKNOWN_RAW_ONLY, 1);
    assert.equal(unknownThread.reading_view.status, "INDETERMINATE");
  }));

  await t.test("an exact visible message mirrors both children without duplicate text", () => withTemp("exporter-replacement-mirror-", async (temp) => {
    const root = path.join(temp, "home");
    const content = [textPart(), imagePart()];
    const source = await writeRollout(root, { records: [sessionMeta(), message(1, "", content), historyRecord(content)] });
    const output = path.join(temp, "out");
    const manifest = await exportFixture(root, output);
    const thread = manifest.coverage.logical_threads[0];
    assert.equal(thread.inner_units.total, 3);
    assert.equal(thread.inner_units.dispositions.RENDERED, 1);
    assert.equal(thread.inner_units.dispositions.MIRRORED_OR_DEDUPLICATED, 2);
    assert.equal(thread.inner_units.dispositions.KNOWN_CONTENT_RAW_ONLY, 0);
    assert.equal(thread.reading_view.status, "ACCOUNTED_FOR");
    const markdown = await fs.readFile(path.join(output, manifest.sessions[0].markdown_file), "utf8");
    assert.equal(count(markdown, marker), 1);
    assert.deepEqual(await fs.readFile(path.join(output, manifest.sessions[0].raw_export_file)), await fs.readFile(source));
  }));

  await t.test("Markdown, HTML, DOCX and PDF retain one shared PARTIAL result for the reverse-order audit case", () => withTemp("exporter-replacement-formats-", async (temp) => {
    const root = path.join(temp, "home");
    const source = await writeRollout(root, { records: [sessionMeta(), message(1, "VISIBLE_CONTROL"), historyRecord([imagePart(), textPart()])] });
    const baseOutput = path.join(temp, "base");
    const documentOutput = path.join(temp, "documents");
    const base = await exportFixture(root, baseOutput);
    const pdfFragments = [];
    const originalFragment = PDFDocument.prototype._fragment;
    PDFDocument.prototype._fragment = function captureFragment(text, ...args) {
      pdfFragments.push(String(text));
      return originalFragment.call(this, text, ...args);
    };
    let documents;
    try {
      documents = await exportFixture(root, documentOutput, { documentFormats: ["docx", "pdf"] });
    } finally {
      PDFDocument.prototype._fragment = originalFragment;
    }
    assert.deepEqual(documents.coverage.logical_threads, base.coverage.logical_threads);
    const thread = documents.coverage.logical_threads[0];
    assert.equal(thread.inner_units.total, 3);
    assert.equal(thread.inner_units.dispositions.RENDERED, 2);
    assert.equal(thread.inner_units.dispositions.KNOWN_CONTENT_RAW_ONLY, 1);
    assert.equal(thread.reading_view.status, "PARTIAL");
    assert.equal(documents.coverage.status_axes.reading_view_coverage.status, "PARTIAL");
    const session = documents.sessions[0];
    const markdown = await fs.readFile(path.join(documentOutput, session.markdown_file), "utf8");
    const html = await fs.readFile(path.join(documentOutput, "index.html"), "utf8");
    const docx = await JSZip.loadAsync(await fs.readFile(path.join(documentOutput, session.docx_file)), { checkCRC32: true });
    const documentXml = await docx.file("word/document.xml").async("string");
    assert.equal(count(markdown, marker), 0);
    assert.equal(count(html, marker), 0);
    assert.equal(count(documentXml, marker), 0);
    assert.equal(count(pdfFragments.join("\n"), marker), 0);
    assert.equal(count(markdown, "VISIBLE_CONTROL"), 1);
    assert.equal(count(documentXml, "VISIBLE_CONTROL"), 1);
    assert.equal(count(pdfFragments.join("\n"), "VISIBLE_CONTROL"), 1);
    try {
      const executable = process.env.PDFTOTEXT_PATH || "pdftotext";
      const { stdout } = await execFileAsync(executable, [path.join(documentOutput, session.pdf_file), "-"], { encoding: "utf8", windowsHide: true });
      assert.equal(count(stdout, marker), 0);
      assert.equal(count(stdout, "VISIBLE_CONTROL"), 1);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      t.diagnostic("Poppler text extraction unavailable; shared-model coverage and DOCX assertions remain active");
    }
    assert.deepEqual(await fs.readFile(path.join(documentOutput, session.raw_export_file)), await fs.readFile(source));
  }));
});

test("schema-invalid known text children remain explicit Raw-only coverage units", async (t) => {
  const historyRecord = (content) => ({
    ordinal: 2,
    type: "compacted",
    timestamp: AT,
    payload: { replacement_history: [{ type: "message", role: "assistant", content }] },
  });
  const imagePart = () => ({ type: "input_image", image_url: PNG_DATA_URL });
  const auditCases = [
    {
      name: "audit object with image in Complete",
      profile: "complete",
      content: [{ type: "output_text", text: { content: "SYNTHETIC_UNRECOGNIZED_84371" } }, imagePart()],
      expected: { rendered: 2, suppressed: 0, reason: "SCHEMA_INVALID_KNOWN_TEXT_EXPECTED_STRING_ACTUAL_OBJECT" },
    },
    {
      name: "audit number with image in Readable",
      profile: "readable",
      content: [{ type: "output_text", text: 42 }, imagePart()],
      expected: { rendered: 1, suppressed: 1, reason: "SCHEMA_INVALID_KNOWN_TEXT_EXPECTED_STRING_ACTUAL_NUMBER" },
    },
    {
      name: "invalid text after a valid image",
      profile: "complete",
      content: [imagePart(), { type: "output_text", text: false }],
      expected: { rendered: 2, suppressed: 0, reason: "SCHEMA_INVALID_KNOWN_TEXT_EXPECTED_STRING_ACTUAL_BOOLEAN" },
    },
  ];
  for (const fixture of auditCases) {
    await t.test(fixture.name, () => withTemp("exporter-known-text-invalid-", async (temp) => {
      const root = path.join(temp, "home");
      const records = [sessionMeta(), message(1, "SYNTHETIC_VISIBLE_84371"), historyRecord(fixture.content)];
      const source = await writeRollout(root, { records });
      const sourceBytes = await fs.readFile(source);
      const output = path.join(temp, "out");
      const manifest = await exportFixture(root, output, { exportProfile: fixture.profile });
      const thread = manifest.coverage.logical_threads[0];
      assert.equal(thread.inner_units.total, 3);
      assert.equal(thread.inner_units.dispositions.RENDERED, fixture.expected.rendered);
      assert.equal(thread.inner_units.dispositions.SUPPRESSED_BY_PROFILE, fixture.expected.suppressed);
      assert.equal(thread.inner_units.dispositions.SCHEMA_INVALID_RAW_ONLY, 1);
      assert.equal(thread.reading_view.status, "INDETERMINATE");
      assert.deepEqual(thread.semantic_gaps, [{
        disposition: "SCHEMA_INVALID_RAW_ONLY",
        reason_code: fixture.expected.reason,
        structure_path: "payload.replacement_history[*].content[*]",
        record_type: "compacted",
        inner_type: "output_text",
        count: 1,
      }]);
      const markdown = await fs.readFile(path.join(output, manifest.sessions[0].markdown_file), "utf8");
      assert.equal(count(markdown, "SYNTHETIC_VISIBLE_84371"), 1);
      assert.equal(count(markdown, "SYNTHETIC_UNRECOGNIZED_84371"), 0);
      assert.equal(JSON.stringify(manifest).includes("SYNTHETIC_UNRECOGNIZED_84371"), false);
      assert.deepEqual(await fs.readFile(source), sourceBytes);
      if (manifest.sessions[0].raw_export_file) {
        assert.deepEqual(await fs.readFile(path.join(output, manifest.sessions[0].raw_export_file)), sourceBytes);
      } else {
        assert.equal(fixture.profile, "readable");
      }
    }));
  }

  await t.test("multiple invalid children are counted once each by actual JSON type", () => withTemp("exporter-known-text-invalid-many-", async (temp) => {
    const root = path.join(temp, "home");
    const content = [
      { type: "output_text", text: 7 },
      { type: "output_text", text: null },
      { type: "output_text", text: { private_marker: "INVALID_OBJECT_MUST_NOT_LEAK" } },
      { type: "output_text", text: ["INVALID_ARRAY_MUST_NOT_LEAK"] },
    ];
    await writeRollout(root, { records: [sessionMeta(), message(1, "VISIBLE"), historyRecord(content)] });
    const manifest = await exportFixture(root, path.join(temp, "out"));
    const thread = manifest.coverage.logical_threads[0];
    assert.equal(thread.inner_units.total, 5);
    assert.equal(thread.inner_units.dispositions.RENDERED, 1);
    assert.equal(thread.inner_units.dispositions.SCHEMA_INVALID_RAW_ONLY, 4);
    assert.equal(thread.reading_view.status, "INDETERMINATE");
    assert.deepEqual(thread.semantic_gaps.map((entry) => [entry.reason_code, entry.count]), [
      ["SCHEMA_INVALID_KNOWN_TEXT_EXPECTED_STRING_ACTUAL_ARRAY", 1],
      ["SCHEMA_INVALID_KNOWN_TEXT_EXPECTED_STRING_ACTUAL_NULL", 1],
      ["SCHEMA_INVALID_KNOWN_TEXT_EXPECTED_STRING_ACTUAL_NUMBER", 1],
      ["SCHEMA_INVALID_KNOWN_TEXT_EXPECTED_STRING_ACTUAL_OBJECT", 1],
    ]);
    assert.equal(JSON.stringify(manifest).includes("INVALID_OBJECT_MUST_NOT_LEAK"), false);
    assert.equal(JSON.stringify(manifest).includes("INVALID_ARRAY_MUST_NOT_LEAK"), false);
  }));

  await t.test("normal known messages omit invalid values and retain later valid conversation in every reading format", () => withTemp("exporter-known-text-invalid-formats-", async (temp) => {
    const root = path.join(temp, "home");
    const marker = "NORMAL_INVALID_VALUE_MUST_NOT_RENDER";
    const fallbackMarker = "ALTERNATE_TEXT_FIELD_MUST_NOT_RENDER";
    const records = [
      sessionMeta(),
      message(1, "", [{ type: "output_text", text: { private_marker: marker }, output_text: fallbackMarker }]),
      message(2, "LATER_VALID_CONVERSATION"),
    ];
    const source = await writeRollout(root, { records });
    const base = await exportFixture(root, path.join(temp, "base"));
    const output = path.join(temp, "out");
    const pdfFragments = [];
    const originalFragment = PDFDocument.prototype._fragment;
    PDFDocument.prototype._fragment = function captureFragment(text, ...args) {
      pdfFragments.push(String(text));
      return originalFragment.call(this, text, ...args);
    };
    let manifest;
    try {
      manifest = await exportFixture(root, output, { documentFormats: ["docx", "pdf"] });
    } finally {
      PDFDocument.prototype._fragment = originalFragment;
    }
    assert.deepEqual(manifest.coverage.logical_threads, base.coverage.logical_threads);
    const thread = manifest.coverage.logical_threads[0];
    assert.equal(thread.inner_units.total, 2);
    assert.equal(thread.inner_units.dispositions.RENDERED, 1);
    assert.equal(thread.inner_units.dispositions.SCHEMA_INVALID_RAW_ONLY, 1);
    assert.equal(thread.reading_view.status, "INDETERMINATE");
    assert.equal(manifest.coverage.status_axes.reading_view_coverage.status, "INDETERMINATE");
    for (const format of ["markdown", "html", "docx", "pdf"]) assert.equal(manifest.coverage.formats[format].status, "VERIFIED_AT_EXPORT");
    assert.deepEqual(thread.semantic_gaps, [{
      disposition: "SCHEMA_INVALID_RAW_ONLY",
      reason_code: "SCHEMA_INVALID_KNOWN_TEXT_EXPECTED_STRING_ACTUAL_OBJECT",
      structure_path: "payload.content[*]",
      record_type: "response_item",
      inner_type: "output_text",
      count: 1,
    }]);
    const session = manifest.sessions[0];
    const markdown = await fs.readFile(path.join(output, session.markdown_file), "utf8");
    const html = await fs.readFile(path.join(output, "index.html"), "utf8");
    const docx = await JSZip.loadAsync(await fs.readFile(path.join(output, session.docx_file)), { checkCRC32: true });
    const documentXml = await docx.file("word/document.xml").async("string");
    for (const representation of [markdown, html, documentXml, pdfFragments.join("\n")]) {
      assert.equal(count(representation, marker), 0);
      assert.equal(count(representation, fallbackMarker), 0);
      assert.equal(count(representation, "[object Object]"), 0);
    }
    assert.equal(count(markdown, "LATER_VALID_CONVERSATION"), 1);
    assert.equal(count(documentXml, "LATER_VALID_CONVERSATION"), 1);
    assert.equal(count(pdfFragments.join("\n"), "LATER_VALID_CONVERSATION"), 1);
    assert.equal(JSON.stringify(manifest).includes(marker), false);
    assert.equal(JSON.stringify(manifest).includes(fallbackMarker), false);
    assert.deepEqual(await fs.readFile(path.join(output, session.raw_export_file)), await fs.readFile(source));
  }));
});

test("Raw-only message-content subtrees cannot project nested text or assets into reading views", async (t) => {
  const invalidMarker = "RAW_ONLY_NESTED_TEXT_MUST_NOT_RENDER";
  const validMarker = "VALID_SIBLING_TEXT_MUST_RENDER";
  const imagePart = () => ({ type: "input_image", image_url: PNG_DATA_URL });
  const invalidImage = () => ({ type: "output_text", text: { nested: imagePart() } });
  const invalidText = () => ({ type: "output_text", text: { nested: { type: "output_text", text: invalidMarker } } });
  const invalidMixed = () => ({ type: "output_text", text: { image: imagePart(), text: invalidMarker } });
  const invalidDeep = () => ({ type: "output_text", text: { one: { two: { three: imagePart() } } } });
  const invalidArray = () => ({ type: "output_text", text: [imagePart()] });
  const unknownImage = () => ({ type: "future_content", nested: imagePart(), text: invalidMarker });
  const knownRawImage = () => ({ type: "refusal", nested: imagePart(), text: invalidMarker });
  const validText = () => ({ type: "output_text", text: validMarker });
  const historyRecord = (content) => ({
    ordinal: 2,
    type: "compacted",
    timestamp: AT,
    payload: { replacement_history: [{ type: "message", role: "assistant", content }] },
  });
  const fixtures = [
    { name: "audit direct Complete", location: "direct", profile: "complete", content: [invalidImage()], total: 2, rendered: 1, invalid: 1, images: 0, texts: 0 },
    { name: "audit direct Readable", location: "direct", profile: "readable", content: [invalidImage()], total: 2, rendered: 1, invalid: 1, images: 0, texts: 0 },
    { name: "audit replacement history Complete", location: "history", profile: "complete", content: [invalidImage()], total: 2, rendered: 1, invalid: 1, images: 0, texts: 0 },
    { name: "invalid nested text", location: "direct", profile: "complete", content: [invalidText()], total: 2, rendered: 1, invalid: 1, images: 0, texts: 0 },
    { name: "invalid nested image and text", location: "direct", profile: "complete", content: [invalidMixed()], total: 2, rendered: 1, invalid: 1, images: 0, texts: 0 },
    { name: "invalid deeply nested image", location: "direct", profile: "complete", content: [invalidDeep()], total: 2, rendered: 1, invalid: 1, images: 0, texts: 0 },
    { name: "invalid array with image", location: "direct", profile: "complete", content: [invalidArray()], total: 2, rendered: 1, invalid: 1, images: 0, texts: 0 },
    { name: "unknown content with image", location: "direct", profile: "complete", content: [unknownImage()], total: 2, rendered: 1, unknown: 1, images: 0, texts: 0 },
    { name: "known Raw-only content with image", location: "direct", profile: "complete", content: [knownRawImage()], total: 2, rendered: 1, known: 1, status: "PARTIAL", images: 0, texts: 0 },
    ...["complete", "readable"].flatMap((profile) => [
      { name: `direct valid text sibling ${profile}`, location: "direct", profile, content: [invalidImage(), validText()], total: 3, rendered: 2, invalid: 1, images: 0, texts: 1 },
      { name: `direct valid image sibling ${profile}`, location: "direct", profile, content: [invalidImage(), imagePart()], total: 3, rendered: 2, invalid: 1, images: 1, texts: 0 },
      { name: `direct valid text and image siblings ${profile}`, location: "direct", profile, content: [invalidImage(), validText(), imagePart()], total: 3, rendered: 2, invalid: 1, images: 1, texts: 1 },
    ]),
    ...["complete", "readable"].flatMap((profile) => {
      const complete = profile === "complete";
      return [
        { name: `history valid text sibling ${profile}`, location: "history", profile, content: [invalidImage(), validText()], total: 3, rendered: 1, suppressed: complete ? 0 : 1, known: complete ? 1 : 0, invalid: 1, images: 0, texts: 0 },
        { name: `history valid image sibling ${profile}`, location: "history", profile, content: [invalidImage(), imagePart()], total: 3, rendered: complete ? 2 : 1, suppressed: complete ? 0 : 1, invalid: 1, images: complete ? 1 : 0, texts: 0 },
        { name: `history valid text and image siblings ${profile}`, location: "history", profile, content: [invalidImage(), validText(), imagePart()], total: 4, rendered: complete ? 2 : 1, suppressed: complete ? 0 : 2, known: complete ? 1 : 0, invalid: 1, images: complete ? 1 : 0, texts: 0 },
      ];
    }),
  ];

  for (const fixture of fixtures) {
    await t.test(fixture.name, () => withTemp("exporter-reading-projection-", async (temp) => {
      const root = path.join(temp, "home");
      const target = fixture.location === "history"
        ? historyRecord(fixture.content)
        : message(2, "", fixture.content);
      const source = await writeRollout(root, { records: [sessionMeta(), message(1, "VISIBLE_PROJECTION_CONTROL"), target] });
      const sourceBytes = await fs.readFile(source);
      const output = path.join(temp, "out");
      const pdfFragments = [];
      let pdfImageCalls = 0;
      const originalFragment = PDFDocument.prototype._fragment;
      const originalImage = PDFDocument.prototype.image;
      PDFDocument.prototype._fragment = function captureFragment(text, ...args) {
        pdfFragments.push(String(text));
        return originalFragment.call(this, text, ...args);
      };
      PDFDocument.prototype.image = function captureImage(...args) {
        pdfImageCalls += 1;
        return originalImage.apply(this, args);
      };
      let manifest;
      try {
        manifest = await exportFixture(root, output, { exportProfile: fixture.profile, documentFormats: ["docx", "pdf"] });
      } finally {
        PDFDocument.prototype._fragment = originalFragment;
        PDFDocument.prototype.image = originalImage;
      }

      const thread = manifest.coverage.logical_threads[0];
      assert.equal(thread.inner_units.total, fixture.total);
      assert.equal(thread.inner_units.dispositions.RENDERED, fixture.rendered);
      assert.equal(thread.inner_units.dispositions.SUPPRESSED_BY_PROFILE, fixture.suppressed || 0);
      assert.equal(thread.inner_units.dispositions.KNOWN_CONTENT_RAW_ONLY, fixture.known || 0);
      assert.equal(thread.inner_units.dispositions.UNKNOWN_RAW_ONLY, fixture.unknown || 0);
      assert.equal(thread.inner_units.dispositions.SCHEMA_INVALID_RAW_ONLY, fixture.invalid || 0);
      assert.equal(thread.reading_view.status, fixture.status || "INDETERMINATE");
      assert.equal(manifest.coverage.status_axes.reading_view_coverage.status, fixture.status || "INDETERMINATE");
      for (const format of ["markdown", "html", "docx", "pdf"]) assert.equal(manifest.coverage.formats[format].status, "VERIFIED_AT_EXPORT");

      const session = manifest.sessions[0];
      const markdown = await fs.readFile(path.join(output, session.markdown_file), "utf8");
      const html = await fs.readFile(path.join(output, "index.html"), "utf8");
      const docx = await JSZip.loadAsync(await fs.readFile(path.join(output, session.docx_file)), { checkCRC32: true });
      const documentXml = await docx.file("word/document.xml").async("string");
      const media = Object.keys(docx.files).filter((name) => name.startsWith("word/media/") && !docx.files[name].dir);
      const assetManifest = JSON.parse(await fs.readFile(path.join(output, manifest.assets_manifest), "utf8"));
      assert.equal(count(markdown, "![Attachment "), fixture.images);
      assert.equal(count(html, "<img "), fixture.images);
      assert.equal(count(documentXml, "<w:drawing>"), fixture.images);
      assert.equal(media.length, fixture.images);
      assert.equal(pdfImageCalls, fixture.images);
      const assetUses = assetManifest.assets.flatMap((asset) => asset.uses);
      assert.equal(assetUses.filter((use) => ["VISIBLE", "ADDITIONAL_STORED_CONTEXT"].includes(use.reading_disposition)).length, fixture.images);
      assert.equal(assetUses.filter((use) => use.reading_disposition === "EXCLUDED").length, fixture.images ? 1 : 0);
      assert.equal(count(markdown, validMarker), fixture.texts);
      assert.equal(count(documentXml, validMarker), fixture.texts);
      assert.equal(count(pdfFragments.join("\n"), validMarker), fixture.texts);
      for (const representation of [markdown, html, documentXml, pdfFragments.join("\n")]) {
        assert.equal(count(representation, invalidMarker), 0);
        assert.equal(count(representation, "[object Object]"), 0);
      }
      assert.equal(JSON.stringify(manifest).includes(invalidMarker), false);
      assert.equal(JSON.stringify(manifest).includes(PNG_DATA_URL), false);
      assert.deepEqual(await fs.readFile(source), sourceBytes);
      if (fixture.profile === "complete") assert.deepEqual(await fs.readFile(path.join(output, session.raw_export_file)), sourceBytes);
      else assert.equal(session.raw_export_file, "");
    }));
  }
});

test("every unknown outer record contributes one conservative body unit independent of field placement", async (t) => {
  const bodies = [
    ["payload only", { payload: { content: "SYNTHETIC_UNKNOWN" } }],
    ["content only", { content: "SYNTHETIC_UNKNOWN" }],
    ["arbitrary root field", { future_field: "SYNTHETIC_UNKNOWN" }],
    ["empty body", {}],
    ["known metadata plus unknown field", { timestamp: AT, future_field: "SYNTHETIC_UNKNOWN" }],
    ["multiple unknown root fields", { first_future: "ONE", second_future: "TWO" }],
    ["array value", { future_array: [1, { nested: true }] }],
    ["object value", { future_object: { nested: { value: true } } }],
  ];
  for (const [name, body] of bodies) {
    await t.test(name, () => withTemp("exporter-unknown-outer-", async (temp) => {
      const root = path.join(temp, "home");
      const unknown = { ordinal: 2, type: "future_outer", timestamp: AT, ...body };
      const records = [sessionMeta(), message(1, "BEFORE"), unknown, message(3, "AFTER")];
      const source = await writeRollout(root, { records });
      const output = path.join(temp, "out");
      const manifest = await exportFixture(root, output);
      const thread = manifest.coverage.logical_threads[0];
      assert.equal(thread.outer_records.total, 4);
      assert.equal(thread.outer_records.classifications.UNKNOWN_RECORD_TYPE, 1);
      assert.equal(thread.inner_units.total, 3);
      assert.equal(thread.inner_units.dispositions.RENDERED, 2);
      assert.equal(thread.inner_units.dispositions.UNKNOWN_RAW_ONLY, 1);
      assert.equal(thread.reading_view.status, "INDETERMINATE");
      assert.deepEqual(thread.semantic_gaps, [{
        disposition: "UNKNOWN_RAW_ONLY",
        reason_code: "UNKNOWN_OUTER_RECORD_BODY",
        structure_path: "$",
        record_type: "future_outer",
        inner_type: "empty_string",
        count: 1,
      }]);
      assert.equal(JSON.stringify(thread.semantic_gaps).includes("SYNTHETIC_UNKNOWN"), false);
      assert.deepEqual(await fs.readFile(path.join(output, manifest.sessions[0].raw_export_file)), await fs.readFile(source));
    }));
  }
});

test("history-only parents contribute every shadowed compressed partner from the common inventory", async (t) => {
  const writeShadow = async (file) => fs.writeFile(`${file}.zst`, zlib.zstdCompressSync(await fs.readFile(file)));
  for (const storage of ["active", "archived"]) {
    await t.test(`${storage} referenced parent`, () => withTemp("exporter-history-shadow-", async (temp) => {
      const root = path.join(temp, "home");
      const parentRecords = [sessionMeta(THREAD_ID, PARENT_PROJECT), message(1, "PARENT")];
      const parent = await writeRollout(root, { records: parentRecords, stable: THREAD_ID, storage });
      await writeShadow(parent);
      await writeRollout(root, {
        records: [sessionMeta(OTHER_ID, PROJECT, { history_base: { thread_id: THREAD_ID, end_ordinal_exclusive: 2, end_byte_offset: jsonl(parentRecords).length } }, 2), message(3, "CHILD")],
        stable: OTHER_ID,
      });
      const manifest = await exportFixture(root, path.join(temp, "out"), { scope: "recorded-project", recordedProjectPath: PROJECT });
      const thread = manifest.coverage.logical_threads[0];
      assert.equal(manifest.coverage.physical_sources.length, 3);
      assert.equal(thread.outer_records.total, 4);
      assert.equal(thread.inner_units.total, 2);
      assert.equal(thread.reconstruction.status, "CHAIN_VALID");
      const shadow = manifest.coverage.physical_sources.find((source) => source.source_representation === "jsonl_zstd");
      assert.ok(shadow);
      assert.equal(shadow.storage, storage);
      assert.equal(shadow.full_sha256, null);
      assert.equal(shadow.full_file_record_count, null);
      assert.equal(shadow.usages.length, 1);
      assert.equal(shadow.usages[0].relation_status, "SHADOWED_BY_UNCOMPRESSED");
      assert.equal(shadow.usages[0].identity_evidence, null);
      assert.deepEqual(shadow.usages[0].read_ranges, []);
      assert.ok(shadow.usages[0].canonical_source_id);
    }));
  }

  await t.test("multi-stage history includes shadows for every referenced level", () => withTemp("exporter-history-shadow-multistage-", async (temp) => {
    const root = path.join(temp, "home");
    const oldestRecords = [sessionMeta(THREAD_ID, PARENT_PROJECT), message(1, "OLDEST")];
    const oldest = await writeRollout(root, { records: oldestRecords, stable: THREAD_ID, storage: "archived" });
    await writeShadow(oldest);
    const middleRecords = [
      sessionMeta(OTHER_ID, "C:\\Synthetic\\Middle", { history_base: { thread_id: THREAD_ID, end_ordinal_exclusive: 2, end_byte_offset: jsonl(oldestRecords).length } }, 2),
      message(3, "MIDDLE"),
    ];
    const middle = await writeRollout(root, { records: middleRecords, stable: OTHER_ID });
    await writeShadow(middle);
    await writeRollout(root, {
      records: [sessionMeta(ROLLOUT_C, PROJECT, { history_base: { thread_id: OTHER_ID, end_ordinal_exclusive: 4, end_byte_offset: jsonl(middleRecords).length } }, 4), message(5, "CHILD")],
      stable: ROLLOUT_C,
    });
    const manifest = await exportFixture(root, path.join(temp, "out"), { scope: "recorded-project", recordedProjectPath: PROJECT });
    const thread = manifest.coverage.logical_threads[0];
    assert.equal(manifest.coverage.physical_sources.length, 5);
    assert.equal(manifest.coverage.physical_sources.filter((source) => source.source_representation === "jsonl_zstd").length, 2);
    assert.equal(thread.outer_records.total, 6);
    assert.equal(thread.inner_units.total, 3);
    assert.equal(thread.reconstruction.status, "CHAIN_VALID");
    for (const shadow of manifest.coverage.physical_sources.filter((source) => source.source_representation === "jsonl_zstd")) {
      assert.equal(shadow.usages[0].relation_status, "SHADOWED_BY_UNCOMPRESSED");
      assert.deepEqual(shadow.usages[0].read_ranges, []);
    }
  }));

  await t.test("referenced parent without a shadow remains a two-source chain", () => withTemp("exporter-history-no-shadow-", async (temp) => {
    const root = path.join(temp, "home");
    const parentRecords = [sessionMeta(THREAD_ID, PARENT_PROJECT), message(1, "PARENT")];
    await writeRollout(root, { records: parentRecords, stable: THREAD_ID });
    await writeRollout(root, {
      records: [sessionMeta(OTHER_ID, PROJECT, { history_base: { thread_id: THREAD_ID, end_ordinal_exclusive: 2, end_byte_offset: jsonl(parentRecords).length } }, 2), message(3, "CHILD")],
      stable: OTHER_ID,
    });
    const manifest = await exportFixture(root, path.join(temp, "out"), { scope: "recorded-project", recordedProjectPath: PROJECT });
    assert.equal(manifest.coverage.physical_sources.length, 2);
    assert.equal(manifest.coverage.physical_sources.some((source) => source.source_representation === "jsonl_zstd"), false);
    assert.equal(manifest.coverage.logical_threads[0].outer_records.total, 4);
    assert.equal(manifest.coverage.logical_threads[0].inner_units.total, 2);
  }));
});
