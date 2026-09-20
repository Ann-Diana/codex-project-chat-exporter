import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { exportArchive } from "../bin/export-codex-project-chats.mjs";
import { CoverageLedger, assertCoverageInvariants } from "../lib/coverage-ledger.mjs";
import { ReadingProjection } from "../lib/reading-projection.mjs";

const PROJECT = process.platform === "win32" ? "C:\\Synthetic\\Coverage" : "/synthetic/Coverage";
const THREAD = "11111111-1111-7111-8111-111111111111";
const ROLLOUT_A = "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa";
const ROLLOUT_B = "bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb";
const ROLLOUT_C = "cccccccc-cccc-7ccc-8ccc-cccccccccccc";
const PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function meta(id, timestamp, extra = {}, ordinal = 0) {
  return { ordinal, type: "session_meta", timestamp, payload: { id, cwd: PROJECT, timestamp, source: "vscode", thread_source: "user", history_mode: "paginated", ...extra } };
}

function assistant(ordinal, text, timestamp) {
  return { ordinal, type: "response_item", timestamp, payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] } };
}

function bytes(records) {
  return Buffer.from(`${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
}

function name(timestamp, stableId, rolloutId = "") {
  return `rollout-${timestamp.replaceAll(":", "-").replace(/\.000Z$/, "")}-${stableId}${rolloutId ? `_${rolloutId}` : ""}.jsonl`;
}

async function writeRollout(root, storage, timestamp, stableId, records, rolloutId = "") {
  const directory = storage === "archived" ? path.join(root, "archived_sessions") : path.join(root, "sessions", "2026", "09", "18");
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, name(timestamp, stableId, rolloutId));
  await fs.writeFile(file, bytes(records));
  return file;
}

async function markdownText(output, manifest) {
  return fs.readFile(path.join(output, manifest.sessions[0].markdown_file), "utf8");
}

function classifyOneRecord(item, { includeReplacementHistory = true, readingSelection } = {}) {
  const projection = new ReadingProjection({
    includeReplacementHistory,
    includeTools: true,
    readingViewEnabled: true,
  });
  const ledger = new CoverageLedger({
    readingViewEnabled: true,
  });
  let logicalRecordNumber = 1;
  let finalizedSelection = readingSelection;
  if (readingSelection && item?.type === "compacted") {
    const message = item.payload?.replacement_history?.find((entry) => entry?.type === "message" && Array.isArray(entry.content));
    if (message) {
      projection.observePhysicalRecord({ type: "response_item", payload: { type: "message", role: message.role, content: message.content } }, {
        logicalRecordNumber: 1,
        sourceKey: "synthetic-canonical",
        sourceRecordNumber: 1,
      });
      logicalRecordNumber = 2;
      finalizedSelection = {
        ...readingSelection,
        replacementHistoryCanonicalUnitId: (_recordNumber, _historyIndex, contentIndex) => `record:1:message:content:${contentIndex}`,
      };
    }
  }
  const source = {
    file: "synthetic.jsonl",
    fileSize: 1,
    logicalRecordNumber,
    sourceKey: "synthetic-source",
    sourceRecordNumber: logicalRecordNumber,
    sourceRootPath: "synthetic.jsonl",
  };
  const projected = projection.observePhysicalRecord(item, source);
  ledger.observePhysicalRecord({ item }, {
    ...source,
  }, projected);
  projection.finalize({ readingSelection: finalizedSelection });
  return ledger.finish();
}

const KNOWN_TEXT_VALUE_CASES = Object.freeze([
  { name: "nonempty string", value: "VISIBLE", direct: { RENDERED: 1, status: "ACCOUNTED_FOR" }, history: { KNOWN_CONTENT_RAW_ONLY: 1, status: "PARTIAL" } },
  { name: "empty string", value: "", direct: { KNOWN_CONTENT_RAW_ONLY: 1, status: "PARTIAL" }, history: { status: "ACCOUNTED_FOR" } },
  { name: "number", value: 42, reason: "SCHEMA_INVALID_KNOWN_TEXT_EXPECTED_STRING_ACTUAL_NUMBER" },
  { name: "boolean true", value: true, reason: "SCHEMA_INVALID_KNOWN_TEXT_EXPECTED_STRING_ACTUAL_BOOLEAN" },
  { name: "boolean false", value: false, reason: "SCHEMA_INVALID_KNOWN_TEXT_EXPECTED_STRING_ACTUAL_BOOLEAN" },
  { name: "null", value: null, reason: "SCHEMA_INVALID_KNOWN_TEXT_EXPECTED_STRING_ACTUAL_NULL" },
  { name: "object", value: { private_marker: "OBJECT_VALUE_MUST_NOT_LEAK" }, reason: "SCHEMA_INVALID_KNOWN_TEXT_EXPECTED_STRING_ACTUAL_OBJECT" },
  { name: "empty object", value: {}, reason: "SCHEMA_INVALID_KNOWN_TEXT_EXPECTED_STRING_ACTUAL_OBJECT" },
  { name: "array", value: ["ARRAY_VALUE_MUST_NOT_LEAK"], reason: "SCHEMA_INVALID_KNOWN_TEXT_EXPECTED_STRING_ACTUAL_ARRAY" },
  { name: "empty array", value: [], reason: "SCHEMA_INVALID_KNOWN_TEXT_EXPECTED_STRING_ACTUAL_ARRAY" },
  { name: "missing field", omitText: true, reason: "SCHEMA_INVALID_KNOWN_TEXT_EXPECTED_STRING_ACTUAL_MISSING" },
]);

test("known text content types classify every JSON text-field shape explicitly", async (t) => {
  for (const contentType of ["input_text", "output_text", "text"]) {
    for (const fixture of KNOWN_TEXT_VALUE_CASES) {
      await t.test(`${contentType}: ${fixture.name}`, () => {
        const part = fixture.omitText ? { type: contentType } : { type: contentType, text: fixture.value };
        const direct = classifyOneRecord({ type: "response_item", payload: { type: "message", role: "assistant", content: [part] } });
        const history = classifyOneRecord({ type: "compacted", payload: { replacement_history: [{ type: "message", role: "assistant", content: [part] }] } });
        if (fixture.reason) {
          const directGap = [{ disposition: "SCHEMA_INVALID_RAW_ONLY", reason_code: fixture.reason, structure_path: "payload.content[*]", record_type: "response_item", inner_type: contentType, count: 1 }];
          const historyGap = [{ disposition: "SCHEMA_INVALID_RAW_ONLY", reason_code: fixture.reason, structure_path: "payload.replacement_history[*].content[*]", record_type: "compacted", inner_type: contentType, count: 1 }];
          assert.equal(direct.inner_units.total, 1);
          assert.equal(direct.inner_units.dispositions.SCHEMA_INVALID_RAW_ONLY, 1);
          assert.equal(direct.reading_view_status, "INDETERMINATE");
          assert.deepEqual(direct.semantic_gaps, directGap);
          assert.equal(history.inner_units.total, 1);
          assert.equal(history.inner_units.dispositions.SCHEMA_INVALID_RAW_ONLY, 1);
          assert.equal(history.reading_view_status, "INDETERMINATE");
          assert.deepEqual(history.semantic_gaps, historyGap);
          assert.equal(JSON.stringify([direct, history]).includes("VALUE_MUST_NOT_LEAK"), false);
          return;
        }
        assert.equal(direct.inner_units.total, 1);
        assert.equal(direct.inner_units.dispositions.RENDERED, fixture.direct.RENDERED || 0);
        assert.equal(direct.inner_units.dispositions.KNOWN_CONTENT_RAW_ONLY, fixture.direct.KNOWN_CONTENT_RAW_ONLY || 0);
        assert.equal(direct.reading_view_status, fixture.direct.status);
        assert.equal(history.inner_units.total, fixture.history.KNOWN_CONTENT_RAW_ONLY || 0);
        assert.equal(history.inner_units.dispositions.KNOWN_CONTENT_RAW_ONLY, fixture.history.KNOWN_CONTENT_RAW_ONLY || 0);
        assert.equal(history.reading_view_status, fixture.history.status);
      });
    }
  }
});

test("known message containers exhaustively account for mixed immediate content", () => {
  const invalid = { type: "output_text", text: { private_marker: "DO_NOT_COPY" } };
  const unknown = { type: "future_content", nested: [1, 2, 3] };
  const directContent = [{ type: "output_text", text: "VISIBLE" }, invalid, unknown];
  const direct = classifyOneRecord({ type: "response_item", payload: { type: "message", role: "assistant", content: directContent } });
  assert.equal(direct.inner_units.total, 3, "one valid message group plus each invalid and unknown immediate child");
  assert.deepEqual(direct.inner_units.dispositions, {
    RENDERED: 1,
    SUPPRESSED_BY_PROFILE: 0,
    MIRRORED_OR_DEDUPLICATED: 0,
    KNOWN_CONTENT_RAW_ONLY: 0,
    UNKNOWN_RAW_ONLY: 1,
    SCHEMA_INVALID_RAW_ONLY: 1,
  });

  const historyContent = [{ type: "output_text", text: "STORED" }, invalid, unknown, { type: "input_image", image_url: PNG_DATA_URL }];
  const mirrored = classifyOneRecord(
    { type: "compacted", payload: { replacement_history: [{ type: "message", role: "assistant", content: historyContent }] } },
    { readingSelection: { replacementHistoryDisposition: () => "MIRRORED" } },
  );
  assert.equal(mirrored.inner_units.total, historyContent.length);
  assert.deepEqual(mirrored.inner_units.dispositions, {
    RENDERED: 0,
    SUPPRESSED_BY_PROFILE: 0,
    MIRRORED_OR_DEDUPLICATED: 2,
    KNOWN_CONTENT_RAW_ONLY: 0,
    UNKNOWN_RAW_ONLY: 1,
    SCHEMA_INVALID_RAW_ONLY: 1,
  });
  assert.equal(mirrored.reading_view_status, "INDETERMINATE");
  assert.equal(JSON.stringify(mirrored).includes("DO_NOT_COPY"), false);
});

test("coverage keeps physical records, inner units and reading dispositions disjoint", async () => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "coverage-contract-")));
  try {
    const root = path.join(temp, "codex-home");
    const timestamp = "2026-09-18T10:00:00.000Z";
    const records = [
      meta(THREAD, timestamp),
      { ordinal: 1, type: "response_item", timestamp, payload: { type: "function_call", call_id: "known", name: "fixture", arguments: { z: 2, a: 1 } } },
      { ordinal: 2, type: "response_item", timestamp, payload: { type: "function_call_output", call_id: "known", output: "STRING_OUTPUT" } },
      { ordinal: 3, type: "response_item", timestamp, payload: { type: "function_call_output", output: { z: 2, a: { b: 1 } } } },
      { ordinal: 4, type: "response_item", timestamp, payload: { type: "custom_tool_call_output", call_id: "", output: ["ARRAY_OUTPUT", { b: 2, a: 1 }] } },
      { ordinal: 5, type: "response_item", timestamp, payload: { type: "custom_tool_call_output", call_id: "foreign", output: { OBJECT_OUTPUT: true } } },
      assistant(6, "ASSISTANT_VISIBLE", timestamp),
      { ordinal: 7, type: "future_outer", timestamp, payload: { conversation_like: "UNKNOWN_OUTER" } },
      { ordinal: 8, type: "event_msg", timestamp, payload: { type: "thread_settings", model: "gpt-5.6-sol" } },
      { ordinal: 9, type: "response_item", timestamp, payload: { type: "future_inner", content: "UNKNOWN_INNER" } },
      { ordinal: 10, type: "compacted", timestamp, payload: { replacement_history: [
        { type: "message", role: "assistant", content: [{ type: "input_image", image_url: PNG_DATA_URL }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "STORED_TEXT_ONLY" }] },
        { type: "future_history", content: "UNKNOWN_HISTORY" },
      ] } },
    ];
    await writeRollout(root, "active", timestamp, THREAD, records);
    const output = path.join(temp, "visible");
    await exportArchive({ codexHome: root, scope: "all", outputDirectory: output, exportProfile: "complete", includeTools: true });
    const manifest = JSON.parse(await fs.readFile(path.join(output, "manifest.json"), "utf8"));
    assert.equal(manifest.archive_format_version, 1);
    assert.equal(manifest.coverage_schema_version, 1);
    assert.equal(Object.hasOwn(manifest.sessions[0], "coverage"), false, "coverage is additive at the root only");
    assert.deepEqual(manifest.coverage.formats, {
      raw_jsonl: { role: "CANONICAL_SOURCE_SNAPSHOT", status: "HASH_VERIFIED_AT_EXPORT" },
      manifest_json: { role: "STRUCTURED_SOURCE_AND_COVERAGE_METADATA", status: "VERIFIED_AT_EXPORT" },
      html: { role: "METADATA_INDEX", status: "VERIFIED_AT_EXPORT" },
      markdown: { role: "DERIVED_READING_VIEW", status: "VERIFIED_AT_EXPORT" },
      docx: { role: "DERIVED_READING_VIEW", status: "NOT_GENERATED" },
      pdf: { role: "DERIVED_READING_VIEW", status: "NOT_GENERATED" },
    });
    const coverage = manifest.coverage.logical_threads[0];
    assert.deepEqual(coverage.outer_records, {
      total: 11,
      classifications: { KNOWN_CONTENT_RECORD: 8, KNOWN_CONTROL_RECORD: 2, UNKNOWN_RECORD_TYPE: 1, SCHEMA_INVALID_RECORD: 0 },
    });
    assert.deepEqual(coverage.inner_units, {
      total: 11,
      dispositions: { RENDERED: 7, SUPPRESSED_BY_PROFILE: 0, MIRRORED_OR_DEDUPLICATED: 0, KNOWN_CONTENT_RAW_ONLY: 1, UNKNOWN_RAW_ONLY: 3, SCHEMA_INVALID_RAW_ONLY: 0 },
    });
    assert.equal(coverage.anomalies.unknown_outer_record_type, 1);
    assert.equal(coverage.anomalies.unknown_inner_type, 2);
    assert.equal(coverage.anomalies.tool_output_no_call_id_present, 1);
    assert.equal(coverage.anomalies.tool_output_empty_call_id, 1);
    assert.equal(coverage.anomalies.tool_output_unmatched_call_id, 1);
    assert.deepEqual(coverage.tool_output_linkage, { MATCHED: 1, NO_CALL_ID_PRESENT: 1, EMPTY_CALL_ID: 1, UNMATCHED: 1, AMBIGUOUS_CALL_ID: 0, SCHEMA_INVALID_CALL_ID: 0 });
    assert.equal(coverage.reading_view.status, "INDETERMINATE");
    assert.equal(assertCoverageInvariants(manifest.coverage), true);
    const missingInnerDisposition = structuredClone(manifest.coverage);
    delete missingInnerDisposition.logical_threads[0].inner_units.dispositions.UNKNOWN_RAW_ONLY;
    assert.throws(() => assertCoverageInvariants(missingInnerDisposition), /inner-unit dispositions/);
    const mismatchedPhysicalTotal = structuredClone(manifest.coverage);
    mismatchedPhysicalTotal.physical_sources[0].usages[0].read_ranges[0].record_count += 1;
    assert.throws(() => assertCoverageInvariants(mismatchedPhysicalTotal), /physical outer-record invariant/);
    const markdown = await markdownText(output, manifest);
    assert.equal(markdown.includes("[object Object]"), false);
    assert.match(markdown, /STRING_OUTPUT/);
    assert.match(markdown, /ARRAY_OUTPUT/);
    assert.match(markdown, /OBJECT_OUTPUT/);
    assert.match(markdown, /"a": \{\s+"b": 1\s+\},\s+"z": 2/, "object keys are rendered deterministically");

    const hidden = path.join(temp, "hidden");
    await exportArchive({ codexHome: root, scope: "all", outputDirectory: hidden, exportProfile: "complete", includeTools: false });
    const hiddenManifest = JSON.parse(await fs.readFile(path.join(hidden, "manifest.json"), "utf8"));
    const hiddenUnits = hiddenManifest.coverage.logical_threads[0].inner_units.dispositions;
    assert.equal(hiddenUnits.SUPPRESSED_BY_PROFILE, 5);
    assert.equal(hiddenUnits.RENDERED, 2);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("present nonidentical sources fail with evidence-specific relation states", async (t) => {
  const cases = [
    ["unlinked", "PRESENT_BUT_UNLINKED", async (root) => {
      await writeRollout(root, "active", "2026-09-18T10:00:00.000Z", THREAD, [meta(THREAD, "2026-09-18T10:00:00.000Z"), assistant(1, "ONE", "2026-09-18T10:00:00.000Z")], ROLLOUT_A);
      await writeRollout(root, "active", "2026-09-18T11:00:00.000Z", THREAD, [meta(THREAD, "2026-09-18T11:00:00.000Z"), assistant(1, "TWO", "2026-09-18T11:00:00.000Z")], ROLLOUT_B);
    }],
    ["forked order", "AMBIGUOUS_ORDER", async (root) => {
      const parent = [meta(THREAD, "2026-09-18T10:00:00.000Z"), assistant(1, "PARENT", "2026-09-18T10:00:00.000Z")];
      const boundary = { thread_id: ROLLOUT_A, end_ordinal_exclusive: 2, end_byte_offset: bytes(parent).length };
      await writeRollout(root, "active", "2026-09-18T10:00:00.000Z", THREAD, parent, ROLLOUT_A);
      await writeRollout(root, "active", "2026-09-18T11:00:00.000Z", THREAD, [meta(THREAD, "2026-09-18T11:00:00.000Z", { history_base: boundary }, 2), assistant(3, "FORK_ONE", "2026-09-18T11:00:00.000Z")], ROLLOUT_B);
      await writeRollout(root, "active", "2026-09-18T12:00:00.000Z", THREAD, [meta(THREAD, "2026-09-18T12:00:00.000Z", { history_base: boundary }, 2), assistant(3, "FORK_TWO", "2026-09-18T12:00:00.000Z")], ROLLOUT_C);
    }],
    ["conflicting target", "CONFLICTING_REFERENCE", async (root) => {
      const first = [meta(THREAD, "2026-09-18T10:00:00.000Z"), assistant(1, "PARENT_ONE", "2026-09-18T10:00:00.000Z")];
      const second = [meta(THREAD, "2026-09-18T10:30:00.000Z"), assistant(1, "PARENT_TWO", "2026-09-18T10:30:00.000Z")];
      const boundary = { thread_id: ROLLOUT_A, end_ordinal_exclusive: 2, end_byte_offset: bytes(first).length };
      await writeRollout(root, "active", "2026-09-18T10:00:00.000Z", THREAD, first, ROLLOUT_A);
      await writeRollout(root, "active", "2026-09-18T10:30:00.000Z", THREAD, second, ROLLOUT_A);
      await writeRollout(root, "active", "2026-09-18T11:00:00.000Z", THREAD, [meta(THREAD, "2026-09-18T11:00:00.000Z", { history_base: boundary }, 2), assistant(3, "CHILD", "2026-09-18T11:00:00.000Z")], ROLLOUT_B);
    }],
  ];
  for (const [name, relationStatus, arrange] of cases) {
    await t.test(name, async () => {
      const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "coverage-relations-")));
      try {
        const root = path.join(temp, "codex-home");
        await arrange(root);
        await assert.rejects(
          () => exportArchive({ codexHome: root, scope: "all", outputDirectory: path.join(temp, "output"), exportProfile: "complete" }),
          (error) => error?.code === "PHYSICAL_SOURCE_RELATION_UNRESOLVED" && error?.relationStatus === relationStatus,
        );
      } finally {
        await fs.rm(temp, { recursive: true, force: true });
      }
    });
  }
});

test("one explicit same-thread history chain selects its unique terminal source", async () => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "coverage-chain-gate-")));
  try {
    const root = path.join(temp, "codex-home");
    const parentTime = "2026-09-18T10:00:00.000Z";
    const childTime = "2026-09-18T11:00:00.000Z";
    const parent = [meta(THREAD, parentTime), assistant(1, "CHAIN_PARENT", parentTime)];
    const boundary = { thread_id: ROLLOUT_A, end_ordinal_exclusive: 2, end_byte_offset: bytes(parent).length };
    await writeRollout(root, "active", parentTime, THREAD, parent, ROLLOUT_A);
    await writeRollout(root, "active", childTime, THREAD, [meta(THREAD, childTime, { history_base: boundary }, 2), assistant(3, "CHAIN_CHILD", childTime)], ROLLOUT_B);
    const output = path.join(temp, "output");
    const result = await exportArchive({ codexHome: root, scope: "all", outputDirectory: output, exportProfile: "complete" });
    assert.equal(result.rows.length, 1);
    const manifest = JSON.parse(await fs.readFile(path.join(output, "manifest.json"), "utf8"));
    assert.equal(manifest.coverage.logical_threads[0].reconstruction.status, "CHAIN_VALID");
    const markdown = await markdownText(output, manifest);
    assert.match(markdown, /CHAIN_PARENT/);
    assert.match(markdown, /CHAIN_CHILD/);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});
