import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { readSessionMeta } from "../bin/export-codex-project-chats.mjs";
import {
  SESSION_READER_IMPLEMENTATION,
  SessionRecordReaderError,
  createSessionReaderSummary,
  isAttachmentDescriptor,
  streamSessionRecords,
} from "../lib/session-record-reader.mjs";

const implementations = Object.values(SESSION_READER_IMPLEMENTATION);

async function collect(file, implementation, options = {}) {
  const summary = createSessionReaderSummary();
  const records = [];
  for await (const record of streamSessionRecords(file, { ...options, calculateSha256: true, implementation, summary })) records.push(record);
  return {
    records,
    summary: {
      ...summary,
      attachmentHashes: [...summary.attachmentHashes].sort(),
    },
  };
}

function pngPayload(size, fill) {
  const bytes = Buffer.alloc(size, fill);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  return { bytes, url: `data:image/png;base64,${bytes.toString("base64")}` };
}

function embeddedDescriptors(value, output = []) {
  if (isAttachmentDescriptor(value)) output.push(value);
  else if (Array.isArray(value)) value.forEach((child) => embeddedDescriptors(child, output));
  else if (value && typeof value === "object") Object.values(value).forEach((child) => embeddedDescriptors(child, output));
  return output;
}

test("legacy reference and streaming bridge produce identical committed record projections", async () => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "codex-reader-diff-")));
  try {
    const file = path.join(temp, "session.jsonl");
    const first = pngPayload(2 * 1024 * 1024 + 5, 0x41);
    const second = pngPayload(1536 * 1024 + 7, 0x42);
    const unprefixed = pngPayload(1024 * 1024 + 3, 0x43);
    const userMessage = 'Umlaute äöü, 😀, quote " and slash \\';
    const records = [
      { type: "session_meta", timestamp: "2026-08-24T10:00:00.000Z", payload: { id: "reader-diff", cwd: "C:\\Prüfung", source: "vscode", thread_source: "user" } },
      { type: "response_item", timestamp: "2026-08-24T10:00:01.000Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: userMessage }, { type: "input_image", image_url: first.url }, { type: "input_image", image_url: second.url }], internal_chat_message_metadata_passthrough: { turn_id: "turn-1" } } },
      { type: "event_msg", timestamp: "2026-08-24T10:00:01.001Z", payload: { type: "user_message", message: userMessage, images: [first.url, second.url] } },
      { type: "response_item", timestamp: "2026-08-24T10:00:02.000Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Antwort" }] } },
      { type: "response_item", timestamp: "2026-08-24T10:00:03.000Z", payload: { type: "message", role: "user", content: [{ type: "input_image", image_url: unprefixed.bytes.toString("base64") }] } },
      { type: "unknown_event", payload: { escaped: "ä😀", nested: [[[[{ value: true }]]]], remote: "https://example.invalid/image.png" } },
      { type: "record_without_attachment", payload: null },
      { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: first.url }] } },
    ];
    const lines = records.map((record) => JSON.stringify(record));
    lines[5] = lines[5].replace("ä😀", "\\u00e4\\uD83D\\uDE00");
    await fs.writeFile(file, lines.join("\r\n"), "utf8");

    const legacy = await collect(file, SESSION_READER_IMPLEMENTATION.LEGACY_REFERENCE);
    const streaming = await collect(file, SESSION_READER_IMPLEMENTATION.STREAMING, { inputChunkBytes: 4096, tokenOptions: { maxDepth: 256, maxStringChunkChars: 17 } });
    assert.deepEqual(streaming, legacy);
    assert.equal(streaming.records.length, records.length);
    assert.deepEqual(streaming.records.map((record) => record.item.type), records.map((record) => record.type));
    const attachments = streaming.records.flatMap((record) => embeddedDescriptors(record.item));
    assert.equal(attachments.length, 5);
    assert.ok(attachments.every((attachment) => attachment.maxDecodedBlockBytes <= 3072));
    assert.deepEqual(attachments.slice(0, 2).map((attachment) => attachment.sha256), attachments.slice(2, 4).map((attachment) => attachment.sha256));
    assert.equal(attachments.some((attachment) => Object.values(attachment).some((value) => typeof value === "string" && value.length > 1024)), false);
    assert.equal(streaming.records.at(-1).item.payload.content[0].text, first.url, "ordinary message text that resembles a data URL must remain text");
    assert.equal(streaming.summary.fileSha256, createHash("sha256").update(await fs.readFile(file)).digest("hex"));
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("metadata, classification, attachment metrics, and raw hash match between readers", async () => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "codex-reader-meta-")));
  try {
    const file = path.join(temp, "rollout-reader-meta.jsonl");
    const image = pngPayload(128 * 1024 + 1, 0x51);
    const items = [
      { type: "session_meta", timestamp: "2026-08-24T11:00:00.000Z", payload: { id: "reader-meta", cwd: "C:\\Project", source: "vscode", thread_source: "user" } },
      { type: "response_item", timestamp: "2026-08-24T11:00:01.000Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "A real request" }, { type: "input_image", image_url: image.url }], internal_chat_message_metadata_passthrough: { turn_id: "turn" } } },
      { type: "event_msg", timestamp: "2026-08-24T11:00:01.001Z", payload: { type: "user_message", message: "A real request", images: [image.url] } },
      { type: "response_item", timestamp: "2026-08-24T11:00:02.000Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Answer" }] } },
    ];
    await fs.writeFile(file, `${items.map(JSON.stringify).join("\n")}\n`, "utf8");
    const values = [];
    for (const implementation of implementations) {
      values.push(await readSessionMeta(file, { calculateSha256: true, collectAttachmentMetrics: true, readerImplementation: implementation }));
    }
    assert.deepEqual(values[1], values[0]);
    assert.equal(values[1].eventAnalysis.directUserMessages, 1);
    assert.equal(values[1].attachmentMetrics.embeddedCount, 2);
    assert.equal(values[1].attachmentMetrics.embeddedHashes.size, 1);
    assert.match(values[1].attachmentMetrics.embeddedSequenceSha256, /^[0-9a-f]{64}$/);
    assert.equal(values[1].fileSha256, createHash("sha256").update(await fs.readFile(file)).digest("hex"));
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("invalid input and pre-commit failures expose no partial current record", async () => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "codex-reader-errors-")));
  try {
    const cases = [
      { name: "invalid-json", text: '{}\n{"bad":}\n{"later":true}\n', code: "SESSION_JSONL_INVALID" },
      { name: "truncated", text: '{}\n{"cut":"value', code: "SESSION_JSONL_INVALID" },
      { name: "invalid-base64", text: '{}\n{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_image","image_url":"data:image/png;base64,AAAA*"}]}}\n', code: "SESSION_ATTACHMENT_DECODE_ERROR" },
    ];
    for (const fixture of cases) {
      const file = path.join(temp, `${fixture.name}.jsonl`);
      await fs.writeFile(file, fixture.text, "utf8");
      for (const implementation of implementations) {
        const committed = [];
        await assert.rejects(async () => {
          for await (const record of streamSessionRecords(file, {
            implementation,
            invalidRecordPolicy: "error",
            legacyPreserveInvalidAttachments: false,
          })) committed.push(record.recordNumber);
        }, (error) => error instanceof SessionRecordReaderError && error.code === fixture.code && error.recordNumber === 2);
        assert.deepEqual(committed, [1]);
      }
    }

    const commitFile = path.join(temp, "commit-error.jsonl");
    await fs.writeFile(commitFile, '{}\n{"complete":true}\n{"later":true}\n', "utf8");
    for (const implementation of implementations) {
      const committed = [];
      await assert.rejects(async () => {
        for await (const record of streamSessionRecords(commitFile, {
          beforeRecordCommit: async (_record, recordNumber) => { if (recordNumber === 2) throw new Error("synthetic pre-commit failure"); },
          implementation,
        })) committed.push(record.recordNumber);
      }, (error) => error.code === "SESSION_RECORD_COMMIT_ERROR" && error.recordNumber === 2);
      assert.deepEqual(committed, [1]);
    }
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("source and hashing failures propagate with stable classes", async () => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "codex-reader-io-")));
  try {
    const file = path.join(temp, "source.jsonl");
    await fs.writeFile(file, '{"type":"record_without_attachment"}\n', "utf8");
    await assert.rejects(async () => {
      for await (const _record of streamSessionRecords(file, {
        implementation: SESSION_READER_IMPLEMENTATION.STREAMING,
        io: { createReadStream: () => Readable.from((async function* () { yield Buffer.from('{"type":'); throw new Error("synthetic source failure"); })()) },
      })) {}
    }, (error) => error.code === "SESSION_SOURCE_ERROR");

    await assert.rejects(async () => {
      for await (const _record of streamSessionRecords(file, {
        calculateSha256: true,
        implementation: SESSION_READER_IMPLEMENTATION.STREAMING,
        rawHashFactory: () => ({ update() { throw new Error("synthetic raw hash failure"); }, digest() { return ""; } }),
      })) {}
    }, (error) => error.code === "SESSION_HASH_ERROR");

    const image = pngPayload(128, 0x61);
    await fs.writeFile(file, `${JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_image", image_url: image.url }] } })}\n`, "utf8");
    await assert.rejects(async () => {
      for await (const _record of streamSessionRecords(file, {
        base64Options: { hashFactory: () => ({ update() { throw new Error("synthetic attachment hash failure"); }, digest() { return ""; } }) },
        implementation: SESSION_READER_IMPLEMENTATION.STREAMING,
      })) {}
    }, (error) => error.code === "SESSION_ATTACHMENT_DECODE_ERROR" && error.recordNumber === 1);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("full session streaming observes cancellation before and between source chunks", async () => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "codex-reader-abort-")));
  try {
    const file = path.join(temp, "source.jsonl");
    await fs.writeFile(file, `${JSON.stringify({ type: "session_meta", payload: { id: "abort", cwd: "/synthetic" } })}\n`);
    for (const implementation of implementations) {
      const preAborted = new AbortController();
      preAborted.abort();
      await assert.rejects(async () => {
        for await (const _record of streamSessionRecords(file, { implementation, abortSignal: preAborted.signal })) {}
      }, (error) => error.code === "EXPORT_CANCELLED");
    }

    const controller = new AbortController();
    await assert.rejects(async () => {
      for await (const _record of streamSessionRecords(file, {
        implementation: SESSION_READER_IMPLEMENTATION.STREAMING,
        abortSignal: controller.signal,
        io: {
          createReadStream: () => Readable.from((async function* () {
            yield Buffer.from('{"type":"session_meta",');
            controller.abort();
            yield Buffer.from('"payload":{"id":"abort"}}\n');
          })()),
        },
      })) {}
    }, (error) => error.code === "EXPORT_CANCELLED");
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});
