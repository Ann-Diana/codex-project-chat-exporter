import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import JSZip from "jszip";
import PDFDocument from "pdfkit";

import { exportArchive } from "../bin/export-codex-project-chats.mjs";
import { CoverageLedger } from "../lib/coverage-ledger.mjs";
import {
  ReadingProjection,
  VALID_MESSAGE_ROLES,
  assertReadingProjectionInvariants,
} from "../lib/reading-projection.mjs";

const THREAD_ID = "11111111-1111-7111-8111-111111111111";
const AT = "2026-09-20T10:00:00.000Z";
const PROJECT = path.join(path.parse(process.cwd()).root, "Synthetic", "ReadingProjectionBoundary");
const PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function source(recordNumber) {
  return {
    file: "synthetic.jsonl",
    fileSize: 1,
    logicalRecordNumber: recordNumber,
    sourceKey: "synthetic-source",
    sourceRecordNumber: recordNumber,
    sourceRootPath: "synthetic.jsonl",
  };
}

function sessionMeta() {
  return { ordinal: 0, type: "session_meta", timestamp: AT, payload: { id: THREAD_ID, cwd: PROJECT, timestamp: AT, thread_source: "user" } };
}

function directMessage(ordinal, role, content, { omitRole = false, omitContent = false } = {}) {
  const payload = { type: "message" };
  if (!omitRole) payload.role = role;
  if (!omitContent) payload.content = content;
  return { ordinal, type: "response_item", timestamp: AT, payload };
}

function historyMessage(ordinal, message) {
  return { ordinal, type: "compacted", timestamp: AT, payload: { replacement_history: [message] } };
}

function jsonl(records) {
  return Buffer.from(`${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

function count(value, token) {
  return value.split(token).length - 1;
}

async function withTemp(prefix, run) {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  try {
    return await run(temp);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}

async function exportRecords(temp, records, profile, { documents = false } = {}) {
  const root = path.join(temp, "home");
  const sessions = path.join(root, "sessions");
  const output = path.join(temp, `out-${profile}`);
  await fs.mkdir(sessions, { recursive: true });
  const bytes = jsonl(records);
  const sourceFile = path.join(sessions, `rollout-2026-09-20T10-00-00-${THREAD_ID}.jsonl`);
  await fs.writeFile(sourceFile, bytes);
  const pdfText = [];
  let pdfImages = 0;
  const originalFragment = PDFDocument.prototype._fragment;
  const originalImage = PDFDocument.prototype.image;
  PDFDocument.prototype._fragment = function captureFragment(value, ...args) {
    pdfText.push(String(value));
    return originalFragment.call(this, value, ...args);
  };
  PDFDocument.prototype.image = function captureImage(...args) {
    pdfImages += 1;
    return originalImage.apply(this, args);
  };
  try {
    await exportArchive({
      codexHome: root,
      scope: "all",
      outputDirectory: output,
      exportProfile: profile,
      includeTools: true,
      ...(documents ? { documentFormats: ["docx", "pdf"] } : {}),
    });
  } finally {
    PDFDocument.prototype._fragment = originalFragment;
    PDFDocument.prototype.image = originalImage;
  }
  const manifest = JSON.parse(await fs.readFile(path.join(output, "manifest.json"), "utf8"));
  const session = manifest.sessions[0];
  const markdown = session.markdown_file ? await fs.readFile(path.join(output, session.markdown_file), "utf8") : "";
  const html = await fs.readFile(path.join(output, "index.html"), "utf8");
  let documentXml = "";
  let docxMedia = [];
  if (session.docx_file) {
    const zip = await JSZip.loadAsync(await fs.readFile(path.join(output, session.docx_file)), { checkCRC32: true });
    documentXml = await zip.file("word/document.xml").async("string");
    docxMedia = Object.keys(zip.files).filter((name) => name.startsWith("word/media/") && !zip.files[name].dir);
  }
  const assetManifest = JSON.parse(await fs.readFile(path.join(output, manifest.assets_manifest), "utf8"));
  const raw = session.raw_export_file ? await fs.readFile(path.join(output, session.raw_export_file)) : null;
  return { assetManifest, bytes, documentXml, docxMedia, html, manifest, markdown, output, pdfImages, pdfText: pdfText.join("\n"), raw, session, sourceFile };
}

test("message-container roles and content shapes are validated before any child projection", async (t) => {
  assert.deepEqual(VALID_MESSAGE_ROLES, ["user", "assistant", "developer", "tool"]);
  for (const role of VALID_MESSAGE_ROLES) {
    await t.test(`valid role ${role}`, () => {
      const projection = new ReadingProjection();
      projection.observePhysicalRecord(directMessage(1, role, [{ type: "output_text", text: "VALID" }]), source(1));
      projection.finalize();
      const record = projection.snapshot()[0];
      assert.equal(record.outer, "KNOWN_CONTENT_RECORD");
      assert.equal(record.containers[0].validity, "VALID");
      assert.equal(record.containers[0].content_count, 1);
      assert.equal(record.containers[0].child_unit_ids.length, 1);
      assert.equal(assertReadingProjectionInvariants(projection), true);
    });
  }

  const invalidRoles = [
    ["missing", undefined, true],
    ["empty", ""],
    ["whitespace", "  "],
    ["number", 7],
    ["boolean", true],
    ["null", null],
    ["object", { invalid: true }],
    ["array", ["assistant"]],
    ["unknown string", "future_role"],
  ];
  for (const [name, role, omitRole = false] of invalidRoles) {
    await t.test(`invalid role ${name}`, () => {
      const projection = new ReadingProjection();
      projection.observePhysicalRecord(directMessage(1, role, [{ type: "output_text", text: "MUST_NOT_PROJECT" }, { type: "input_image", image_url: PNG_DATA_URL }], { omitRole }), source(1));
      projection.finalize();
      const record = projection.snapshot()[0];
      assert.equal(record.outer, "SCHEMA_INVALID_RECORD");
      assert.equal(record.containers[0].validity, "SCHEMA_INVALID");
      assert.deepEqual(record.containers[0].child_unit_ids, []);
      assert.equal(record.units.length, 1);
      assert.equal(record.units[0].disposition, "SCHEMA_INVALID_RAW_ONLY");
    });
  }

  const invalidContent = [
    ["missing", undefined, true],
    ["object", { type: "output_text", text: "MUST_NOT_PROJECT" }],
    ["string", "MUST_NOT_PROJECT"],
    ["number", 4],
    ["boolean", false],
    ["null", null],
    ["nested invalid structure", { nested: [[{ type: "input_image", image_url: PNG_DATA_URL }]] }],
  ];
  for (const [name, content, omitContent = false] of invalidContent) {
    await t.test(`invalid content ${name}`, () => {
      const projection = new ReadingProjection();
      projection.observePhysicalRecord(directMessage(1, "assistant", content, { omitContent }), source(1));
      projection.finalize();
      const record = projection.snapshot()[0];
      assert.equal(record.outer, "SCHEMA_INVALID_RECORD");
      assert.equal(record.containers[0].validity, "SCHEMA_INVALID");
      assert.deepEqual(record.containers[0].child_unit_ids, []);
      assert.equal(record.units[0].disposition, "SCHEMA_INVALID_RAW_ONLY");
    });
  }

  await t.test("nested array is one opaque invalid-position child of an otherwise valid container", () => {
    const projection = new ReadingProjection();
    projection.observePhysicalRecord(directMessage(1, "assistant", [[{ type: "output_text", text: "MUST_NOT_PROJECT" }]]), source(1));
    projection.finalize();
    const record = projection.snapshot()[0];
    assert.equal(record.containers[0].validity, "VALID");
    assert.equal(record.containers[0].content_count, 1);
    assert.equal(record.units.length, 1);
    assert.equal(record.units[0].disposition, "UNKNOWN_RAW_ONLY");
  });
});

test("the common projection is the sole coverage and materialization authority", () => {
  const projection = new ReadingProjection();
  const valid = directMessage(1, "assistant", [
    { type: "output_text", text: "PROJECTED_TEXT" },
    { type: "output_text", text: { nested: "RAW_ONLY" } },
  ]);
  const invalid = directMessage(2, undefined, [
    { type: "output_text", text: "INVALID_PARENT_TEXT" },
    { type: "input_image", image_url: PNG_DATA_URL },
  ], { omitRole: true });
  const validRecord = projection.observePhysicalRecord(valid, source(1));
  const invalidRecord = projection.observePhysicalRecord(invalid, source(2));
  const coverage = new CoverageLedger({ readingViewEnabled: true });
  assert.throws(() => coverage.observePhysicalRecord({ item: valid }, source(1)), /common reading projection/);
  coverage.observePhysicalRecord({ item: valid }, source(1), validRecord);
  coverage.observePhysicalRecord({ item: invalid }, source(2), invalidRecord);
  projection.finalize();
  const result = coverage.finish();
  assert.deepEqual(result.inner_units.dispositions, {
    RENDERED: 1,
    SUPPRESSED_BY_PROFILE: 0,
    MIRRORED_OR_DEDUPLICATED: 0,
    KNOWN_CONTENT_RAW_ONLY: 0,
    UNKNOWN_RAW_ONLY: 0,
    SCHEMA_INVALID_RAW_ONLY: 2,
  });
  const materialized = projection.materializeRecord(valid, 1, { attachmentsForUnit: () => [] });
  assert.equal(materialized.kind, "MESSAGE");
  assert.deepEqual(materialized.parts.map((part) => [part.kind, part.text]), [["TEXT", "PROJECTED_TEXT"]]);
  assert.equal(projection.materializeRecord(invalid, 2, { attachmentsForUnit: () => [] }).kind, "NONE");
  assert.throws(() => projection.materializeRecord(valid, 3, { attachmentsForUnit: () => [] }), /record is missing/);
  const snapshot = projection.snapshot();
  assert.equal(JSON.stringify(snapshot).includes("INVALID_PARENT_TEXT"), false);
  assert.equal(JSON.stringify(snapshot).includes(PNG_DATA_URL), false);
  assert.ok(snapshot.flatMap((record) => record.units).every((unit) => !Object.hasOwn(unit, "render_data")));
  assert.equal(assertReadingProjectionInvariants(projection), true);
});

test("a finalized projection can be compacted and rejects semantic reuse", () => {
  const projection = new ReadingProjection();
  const record = directMessage(1, "assistant", [
    { type: "output_text", text: "RELEASE_CONTROL" },
    { type: "input_image", image_url: PNG_DATA_URL },
  ]);
  projection.observePhysicalRecord(record, source(1));
  projection.finalize();
  assert.deepEqual(projection.retainedCounts(), { records: 1, units: 3 });

  projection.release();

  assert.deepEqual(projection.retainedCounts(), { records: 0, units: 0 });
  assert.throws(() => projection.record(1), /released/);
  assert.throws(() => projection.units(), /released/);
  assert.throws(() => projection.snapshot(), /released/);
  assert.throws(() => projection.materializeRecord(record, 1), /released/);
  assert.throws(() => projection.observePhysicalRecord(record, source(2)), /released/);
  assert.throws(() => assertReadingProjectionInvariants(projection), /released/);
});

test("source projection classifies text presence without changing whitespace semantics", () => {
  const projection = new ReadingProjection({ readingViewEnabled: false });
  projection.observePhysicalRecord(directMessage(1, "assistant", [
    { type: "output_text", text: "VISIBLE" },
    { type: "output_text", text: "" },
    { type: "output_text", text: " \t\r\n\u00a0" },
  ]), source(1));
  projection.finalize();
  const children = projection.snapshot()[0].units.filter((unit) => unit.parent_unit_id);
  assert.deepEqual(children.map((unit) => unit.disposition), [
    "SUPPRESSED_BY_PROFILE",
    "KNOWN_CONTENT_RAW_ONLY",
    "KNOWN_CONTENT_RAW_ONLY",
  ]);
});

test("source compaction preserves every content identity needed by a later history mirror", () => {
  const projection = new ReadingProjection({ readingViewEnabled: false });
  const direct = projection.observePhysicalRecord(directMessage(1, "assistant", [
    { type: "output_text", text: "FIRST" },
    { type: "output_text", text: "SECOND" },
    { type: "input_image", image_url: PNG_DATA_URL },
  ]), source(1));
  const secondText = direct.units.find((unit) => unit.kind === "TEXT" && unit.contentIndex === 1);
  assert(secondText);
  assert.equal(projection.compactStableRecord(1), true);
  assert.equal(projection.record(1), null);

  projection.observePhysicalRecord(historyMessage(2, {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "SECOND" }],
  }), source(2));
  projection.finalize({
    readingSelection: {
      replacementHistoryDisposition: () => "MIRRORED",
      replacementHistoryCanonicalUnitId: () => secondText.unit_id,
    },
  });

  const historyUnit = projection.snapshot()[0].units.find((unit) => unit.kind === "TEXT");
  assert.equal(historyUnit.disposition, "MIRRORED_OR_DEDUPLICATED");
  assert.equal(historyUnit.canonical_unit_id, secondText.unit_id);
  assert.equal(assertReadingProjectionInvariants(projection), true);
});

test("source-snapshots releases every full projection before the next session", () => withTemp("exporter-source-projection-lifecycle-", async (temp) => {
  const root = path.join(temp, "home");
  const sessions = path.join(root, "sessions");
  const output = path.join(temp, "out");
  await fs.mkdir(sessions, { recursive: true });
  const expectedRaw = new Map();
  const threadIds = [
    "21111111-1111-7111-8111-111111111111",
    "22222222-2222-7222-8222-222222222222",
    "23333333-3333-7333-8333-333333333333",
  ];
  for (const [index, threadId] of threadIds.entries()) {
    const bytes = jsonl([
      { ordinal: 0, type: "session_meta", timestamp: AT, payload: { id: threadId, cwd: PROJECT, timestamp: AT, thread_source: "user" } },
      directMessage(1, "assistant", [
        { type: "output_text", text: `SESSION_${index + 1}_TEXT` },
        { type: "input_image", image_url: PNG_DATA_URL },
      ]),
    ]);
    expectedRaw.set(threadId, bytes);
    await fs.writeFile(path.join(sessions, `rollout-2026-09-20T10-00-0${index}-${threadId}.jsonl`), bytes);
  }

  const lifecycle = [];
  await exportArchive({
    codexHome: root,
    scope: "all",
    outputDirectory: output,
    exportProfile: "source-snapshots",
    includeTools: true,
    _projectionLifecycleObserver: (event) => lifecycle.push(event),
  });

  const phases = lifecycle.map((event) => event.phase);
  assert.deepEqual(phases, ["created", "released", "created", "released", "created", "released"]);
  let active = 0;
  let maximumActive = 0;
  for (const event of lifecycle) {
    if (event.phase === "created") active += 1;
    if (event.phase === "released") {
      assert.deepEqual(event.before.projection, { records: 0, units: 0 });
      assert.ok(event.before.selection.occurrences > 0);
      assert.deepEqual(event.after, {
        projection: { records: 0, units: 0 },
        selection: { occurrences: 0, records: 0 },
      });
      active -= 1;
    }
    maximumActive = Math.max(maximumActive, active);
  }
  assert.equal(maximumActive, 1);
  assert.equal(active, 0);
  assert.equal(lifecycle.some((event) => event.phase === "retained"), false);

  const manifest = JSON.parse(await fs.readFile(path.join(output, "manifest.json"), "utf8"));
  assert.equal(manifest.sessions.length, threadIds.length);
  assert.equal(manifest.coverage.logical_threads.length, threadIds.length);
  for (const session of manifest.sessions) {
    assert.deepEqual(await fs.readFile(path.join(output, session.raw_export_file)), expectedRaw.get(session.session_id));
    const coverage = manifest.coverage.logical_threads.find((thread) => thread.session_id === session.session_id);
    assert.equal(coverage.inner_units.total, 1);
    assert.equal(coverage.inner_units.dispositions.SUPPRESSED_BY_PROFILE, 1);
    assert.equal(coverage.reading_view.status, "NOT_GENERATED");
  }
}));

test("schema-invalid direct and history containers cannot project text or assets in any profile", async (t) => {
  const markers = [
    "DIRECT_MISSING_ROLE",
    "DIRECT_INVALID_ROLE",
    "HISTORY_MISSING_ROLE",
    "HISTORY_INVALID_ROLE",
    "DIRECT_OBJECT_CONTENT",
    "HISTORY_OBJECT_CONTENT",
    "NESTED_TEXT_INVALID_PARENT",
    "NESTED_IMAGE_INVALID_PARENT",
    "MIXED_INVALID_PARENT",
    "DEEP_ASSET_INVALID_PARENT",
  ];
  const textImage = (marker) => [{ type: "output_text", text: marker }, { type: "input_image", image_url: PNG_DATA_URL }];
  const records = [
    sessionMeta(),
    directMessage(1, "assistant", [{ type: "output_text", text: "PROJECTION_VISIBLE_CONTROL" }]),
    directMessage(2, undefined, textImage(markers[0]), { omitRole: true }),
    directMessage(3, { invalid: true }, textImage(markers[1])),
    historyMessage(4, { type: "message", content: textImage(markers[2]) }),
    historyMessage(5, { type: "message", role: ["assistant"], content: textImage(markers[3]) }),
    directMessage(6, "assistant", { type: "output_text", text: markers[4] }),
    historyMessage(7, { type: "message", role: "assistant", content: { type: "output_text", text: markers[5] } }),
    directMessage(8, undefined, [{ type: "future", nested: { type: "output_text", text: markers[6] } }], { omitRole: true }),
    directMessage(9, { invalid: true }, [{ type: "future", nested: { type: "input_image", image_url: PNG_DATA_URL }, marker: markers[7] }]),
    historyMessage(10, { type: "message", content: [{ type: "output_text", text: markers[8] }, { type: "input_image", image_url: PNG_DATA_URL }] }),
    directMessage(11, undefined, [{ type: "future", one: { two: { three: { type: "input_image", image_url: PNG_DATA_URL } } }, marker: markers[9] }], { omitRole: true }),
  ];

  for (const profile of ["complete", "readable", "source-snapshots"]) {
    await t.test(profile, () => withTemp("exporter-invalid-container-projection-", async (temp) => {
      const result = await exportRecords(temp, records, profile, { documents: profile !== "source-snapshots" });
      const thread = result.manifest.coverage.logical_threads[0];
      assert.equal(thread.inner_units.total, 11);
      assert.equal(thread.inner_units.dispositions.SCHEMA_INVALID_RAW_ONLY, 10);
      assert.equal(thread.inner_units.dispositions.RENDERED, profile === "source-snapshots" ? 0 : 1);
      assert.equal(thread.inner_units.dispositions.SUPPRESSED_BY_PROFILE, profile === "source-snapshots" ? 1 : 0);
      assert.equal(thread.reading_view.status, profile === "source-snapshots" ? "NOT_GENERATED" : "INDETERMINATE");
      assert.equal(result.assetManifest.assets.length, 0);
      assert.equal(count(result.html, "<img "), 0);
      assert.equal(result.pdfImages, 0);
      assert.equal(result.docxMedia.length, 0);
      assert.equal(count(result.documentXml, "<w:drawing>"), 0);
      for (const marker of markers) {
        for (const representation of [result.markdown, result.html, result.documentXml, result.pdfText]) assert.equal(representation.includes(marker), false, `${profile} leaked ${marker}`);
      }
      if (profile !== "source-snapshots") {
        assert.equal(count(result.markdown, "PROJECTION_VISIBLE_CONTROL"), 1);
        assert.equal(count(result.documentXml, "PROJECTION_VISIBLE_CONTROL"), 1);
        assert.equal(count(result.pdfText, "PROJECTION_VISIBLE_CONTROL"), 1);
      }
      assert.deepEqual(await fs.readFile(result.sourceFile), result.bytes);
      if (result.raw) assert.deepEqual(result.raw, result.bytes);
    }));
  }
});

test("valid mixed siblings remain individually authorized while invalid and unknown siblings stay opaque", async (t) => {
  const records = [
    sessionMeta(),
    directMessage(1, "assistant", [
      { type: "output_text", text: "VALID_TEXT_BEFORE" },
      { type: "output_text", text: { nested: { type: "output_text", text: "INVALID_CHILD_TEXT" }, image: { type: "input_image", image_url: PNG_DATA_URL } } },
      { type: "input_image", image_url: PNG_DATA_URL },
      { type: "future_content", nested: { type: "input_image", image_url: PNG_DATA_URL }, text: "UNKNOWN_CHILD_TEXT" },
      { type: "output_text", text: "VALID_TEXT_AFTER" },
    ]),
  ];

  for (const profile of ["complete", "readable", "source-snapshots"]) {
    await t.test(profile, () => withTemp("exporter-valid-sibling-projection-", async (temp) => {
      const result = await exportRecords(temp, records, profile, { documents: profile !== "source-snapshots" });
      const thread = result.manifest.coverage.logical_threads[0];
      assert.equal(thread.inner_units.total, 3);
      assert.equal(thread.inner_units.dispositions.SCHEMA_INVALID_RAW_ONLY, 1);
      assert.equal(thread.inner_units.dispositions.UNKNOWN_RAW_ONLY, 1);
      assert.equal(thread.inner_units.dispositions.RENDERED, profile === "source-snapshots" ? 0 : 1);
      assert.equal(thread.inner_units.dispositions.SUPPRESSED_BY_PROFILE, profile === "source-snapshots" ? 1 : 0);
      assert.equal(thread.reading_view.status, profile === "source-snapshots" ? "NOT_GENERATED" : "INDETERMINATE");
      assert.equal(result.assetManifest.assets.length, 1);
      const uses = result.assetManifest.assets[0].uses;
      assert.equal(uses.filter((use) => use.reading_disposition === "VISIBLE").length, 1);
      assert.equal(uses.filter((use) => use.reading_disposition === "EXCLUDED").length, 2);
      if (profile !== "source-snapshots") {
        for (const marker of ["VALID_TEXT_BEFORE", "VALID_TEXT_AFTER"]) {
          assert.equal(count(result.markdown, marker), 1);
          assert.equal(count(result.documentXml, marker), 1);
          assert.equal(count(result.pdfText, marker), 1);
        }
        assert.equal(count(result.markdown, "![Attachment "), 1);
        assert.equal(count(result.html, "<img "), 1);
        assert.equal(count(result.documentXml, "<w:drawing>"), 1);
        assert.equal(result.docxMedia.length, 1);
        assert.equal(result.pdfImages, 1);
      }
      for (const marker of ["INVALID_CHILD_TEXT", "UNKNOWN_CHILD_TEXT"]) {
        for (const representation of [result.markdown, result.html, result.documentXml, result.pdfText]) assert.equal(representation.includes(marker), false);
      }
      assert.deepEqual(await fs.readFile(result.sourceFile), result.bytes);
      if (result.raw) assert.deepEqual(result.raw, result.bytes);
    }));
  }
});
