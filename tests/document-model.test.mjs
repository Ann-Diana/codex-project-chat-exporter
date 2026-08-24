import assert from "node:assert/strict";
import test from "node:test";

import {
  DOCUMENT_BLOCK_KIND,
  DOCUMENT_ROLE,
  createDocumentMessage,
  createSessionDocumentHeader,
} from "../lib/document-model.mjs";

test("document model preserves roles, block structure, links, and stable origins", () => {
  const sessionId = "11111111-1111-7111-8111-111111111111";
  const header = createSessionDocumentHeader({
    id: sessionId,
    displayTitle: "Umlaute äöü & XML <>",
    cwd: "C:\\Projects\\alpha",
    storage: "active",
    timestamp: "2026-08-24T10:00:00.000Z",
    updatedAt: "2026-08-24T10:01:00.000Z",
    model: "gpt-test",
  });
  assert.deepEqual(header.origin, { sessionId });
  assert.equal(header.metadata.sessionId, sessionId);
  assert.equal(Object.hasOwn(header, "rawSession"), false, "the document contract must not retain a complete Raw session");

  const message = createDocumentMessage({
    sessionId,
    recordOrdinal: 7,
    role: DOCUMENT_ROLE.UNCLASSIFIED,
    label: "Unclassified user-role record",
    timestamp: "2026-08-24T10:00:07.000Z",
    text: [
      "# Heading",
      "",
      "Paragraph with [safe link](https://example.invalid/a?x=1&y=2).",
      "",
      "- first",
      "- second",
      "",
      "1. ordered",
      "2. next",
      "",
      "```js",
      "const xml = '<tag>&';",
      "```",
      "",
      "[local](file:///C:/secret.txt), [drive](C:\\secret.txt), and [UNC](\\\\server\\share).",
    ].join("\n"),
    attachments: [{ sha256: "a".repeat(64), sourceSha256: "b".repeat(64), mediaType: "image/png", decodedBytes: 68 }],
  });

  assert.equal(message.role, DOCUMENT_ROLE.UNCLASSIFIED);
  assert.deepEqual(message.origin, { sessionId, recordOrdinal: 7 });
  assert.deepEqual(message.blocks.map((block) => block.kind), [
    DOCUMENT_BLOCK_KIND.HEADING,
    DOCUMENT_BLOCK_KIND.PARAGRAPH,
    DOCUMENT_BLOCK_KIND.LIST,
    DOCUMENT_BLOCK_KIND.LIST,
    DOCUMENT_BLOCK_KIND.CODE,
    DOCUMENT_BLOCK_KIND.PARAGRAPH,
  ]);
  assert.equal(message.blocks[2].ordered, false);
  assert.equal(message.blocks[3].ordered, true);
  assert.equal(message.blocks[4].language, "js");
  assert.equal(message.blocks[4].text, "const xml = '<tag>&';");
  const safeLink = message.blocks[1].inlines.find((inline) => inline.kind === "link");
  assert.equal(safeLink.target, "https://example.invalid/a?x=1&y=2");
  assert.equal(safeLink.blocked, false);
  const blockedLinks = message.blocks.at(-1).inlines.filter((inline) => inline.kind === "link");
  assert.deepEqual(blockedLinks.map((inline) => [inline.blocked, inline.reason, inline.target]), [
    [true, "file-link", ""],
    [true, "file-link", ""],
    [true, "network-path", ""],
  ]);
  assert.deepEqual(message.attachments[0].origin, { sessionId, recordOrdinal: 7, attachmentOrdinal: 1 });
  assert.ok(Object.isFrozen(message) && Object.isFrozen(message.blocks) && Object.isFrozen(message.attachments));
});

test("document model rejects ambiguous origins and unknown roles", () => {
  assert.throws(() => createSessionDocumentHeader({}), /session ID is required/);
  assert.throws(() => createDocumentMessage({ sessionId: "session", recordOrdinal: 0, role: DOCUMENT_ROLE.USER }), /positive integer/);
  assert.throws(() => createDocumentMessage({ sessionId: "session", recordOrdinal: 1, role: "GUESSED" }), /Unsupported document role/);
});
