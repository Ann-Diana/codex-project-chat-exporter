import assert from "node:assert/strict";
import test from "node:test";
import { extractReadingText, normalizeReadableMessageText, omitInternalMemoryCitations } from "../lib/reading-content.mjs";

import {
  DOCUMENT_BLOCK_KIND,
  DOCUMENT_ROLE,
  MAX_DOCUMENT_LINK_TARGET_LENGTH,
  classifyLinkTarget,
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
    models: ["gpt-5.5", "gpt-5.6-sol"],
  });
  assert.deepEqual(header.origin, { sessionId });
  assert.equal(header.metadata.sessionId, sessionId);
  assert.deepEqual(header.metadata.models, ["gpt-5.5", "gpt-5.6-sol"]);
  assert.equal(header.metadata.modelLabel, "Models");
  assert.equal(header.metadata.model, "gpt-5.5 → gpt-5.6-sol");
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
      "[local](file:///C:/secret.txt), [drive](C:\\secret.txt), [UNC](\\\\server\\share), [script](javascript:alert(1)), [data](data:text/plain,secret), and [mail](mailto:test@example.com).",
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
    [true, "unsupported-protocol", ""],
    [true, "unsupported-protocol", ""],
    [true, "unsupported-protocol", ""],
  ]);
  assert.deepEqual(message.attachments[0].origin, { sessionId, recordOrdinal: 7, attachmentOrdinal: 1 });
  assert.ok(Object.isFrozen(message) && Object.isFrozen(message.blocks) && Object.isFrozen(message.attachments));
});

test("document model allows only canonical bounded HTTP and HTTPS targets", () => {
  assert.deepEqual(classifyLinkTarget("https://openai.com/"), { allowed: true, reason: "", target: "https://openai.com/" });
  assert.deepEqual(classifyLinkTarget("HTTP://Example.COM"), { allowed: true, reason: "", target: "http://example.com/" });
  assert.equal(classifyLinkTarget("https://exa mple.com/").reason, "invalid-link");
  assert.equal(classifyLinkTarget(`https://example.com/${"a".repeat(MAX_DOCUMENT_LINK_TARGET_LENGTH)}`).reason, "link-too-long");
  for (const target of ["javascript:alert(1)", "data:text/plain,secret", "ftp://example.com/", "mailto:test@example.com", "file:///C:/secret.txt", "\\\\server\\share", "C:\\secret.txt"]) {
    assert.equal(classifyLinkTarget(target).allowed, false, target);
  }
});

test("document model rejects ambiguous origins and unknown roles", () => {
  assert.throws(() => createSessionDocumentHeader({}), /session ID is required/);
  assert.throws(() => createDocumentMessage({ sessionId: "session", recordOrdinal: 0, role: DOCUMENT_ROLE.USER }), /positive integer/);
  assert.throws(() => createDocumentMessage({ sessionId: "session", recordOrdinal: 1, role: "GUESSED" }), /Unsupported document role/);
});

test("technical image markers require adjacent renderable image parts and preserve literal source", () => {
  const t = text => ({type:"input_text",text});
  const image = {type:"input_image",image_url:"synthetic-descriptor"};
  for (const marker of ["<image>","<image name=[Image #1]>"]) {
    const content=[t("Text — ‘source’ **bold**"),t(marker),image,t("</image>")];
    assert.equal(extractReadingText(content,p=>p===image),"Text — ‘source’ **bold**");
    assert.ok(extractReadingText(content,()=>false).includes(marker));
    assert.equal(content[1].text,marker);
  }
  for (const marker of ["<image name=[Image #0]>","<image name=[Image #x]>","<image> example","> <image>","    <image>","`<image>`"]) {
    assert.ok(extractReadingText([t(marker),image],()=>true).includes(marker));
  }
  assert.equal(extractReadingText([t("<image>"),t("ordinary text"),image],()=>true),"<image>\n\nordinary text");
  const fenced=[t("```text"),t("<image>"),image,t("</image>"),t("```")];
  assert.ok(extractReadingText(fenced,()=>true).includes("<image>"));
  for (const prefix of [" ", "  ", "   "]) {
    assert.ok(extractReadingText([t(`${prefix}~~~text`),t("<image>"),image,t("</image>"),t(`${prefix}~~~`)],()=>true).includes("<image>"));
  }
  assert.equal(extractReadingText([t("</image>")],()=>true),"</image>");
});

test("Readable normalization removes only canonical assistant memory citations", () => {
  const citation = [
    "<oai-mem-citation>",
    "<citation_entries>",
    "MEMORY.md:1-2|note=[synthetic]",
    "</citation_entries>",
    "<rollout_ids>",
    "11111111-1111-7111-8111-111111111111",
    "</rollout_ids>",
    "</oai-mem-citation>",
  ].join("\n");
  assert.equal(normalizeReadableMessageText(`before\n${citation}\nafter`, { role: "ASSISTANT" }), "before\nafter");
  assert.equal(normalizeReadableMessageText(citation, { role: "USER" }), citation, "a user-supplied literal must remain visible");
  for (const literal of [
    `\`${citation}\``,
    `> ${citation.split("\n").join("\n> ")}`,
    `\`\`\`xml\n${citation}\n\`\`\``,
  ]) assert.equal(omitInternalMemoryCitations(literal), literal);
  for (const ambiguous of [
    `${citation.slice(0, -"</oai-mem-citation>".length)}`,
    `<oai-mem-citation>\n<unknown/>\n</oai-mem-citation>`,
    citation.replace("<oai-mem-citation>", "<oai-mem-citation data-synthetic=\"1\">"),
    citation.replace("<citation_entries>", "<!-- literal comment -->\n<citation_entries>"),
    `prefix ${citation}`,
  ]) assert.equal(omitInternalMemoryCitations(ambiguous), ambiguous);
});

test("Readable typography changes natural prose only and retains technical text", () => {
  const source = [
    "Natural — prose and another — phrase.",
    "Inline `literal — code` remains — prose.",
    "A [natural — label](https://example.invalid/a—b/) remains linked.",
    "- List — prose",
    "— Unicode list marker — natural item",
    "https://example.invalid/a—b C:\\Temp\\a—b.txt id—0123456789abcdef",
    "const option = '—value';",
    "{\"value\":\"—\"}",
    "```text",
    "fenced — code",
    "```",
  ].join("\n");
  const rendered = normalizeReadableMessageText(source, { role: "USER" });
  assert.ok(rendered.includes("Natural – prose and another – phrase."));
  assert.ok(rendered.includes("Inline `literal — code` remains – prose."));
  assert.ok(rendered.includes("[natural – label](https://example.invalid/a—b/)"));
  assert.ok(rendered.includes("- List – prose"));
  assert.ok(rendered.includes("— Unicode list marker – natural item"));
  for (const literal of ["https://example.invalid/a—b", "C:\\Temp\\a—b.txt", "id—0123456789abcdef", "const option = '—value';", "{\"value\":\"—\"}", "fenced — code"]) {
    assert.ok(rendered.includes(literal), literal);
  }
  assert.equal(normalizeReadableMessageText(source, { role: "RUNTIME_CONTEXT" }), source);
});

test("Readable normalization removes incidental prose indentation and fences only structural trees", () => {
  const tree = ["root", "├── folder", "│   └── file", "└── other"].join("\n");
  const rendered = normalizeReadableMessageText(`\tNormal prose starts here.\n\n${tree}\n\nA single └ glyph remains prose.`, { role: "ASSISTANT" });
  assert.ok(rendered.startsWith("Normal prose starts here."));
  assert.ok(rendered.includes("```text\n├── folder\n│   └── file\n└── other\n```"));
  assert.ok(rendered.includes("A single └ glyph remains prose."));
  assert.equal(normalizeReadableMessageText("    const value = 1;", { role: "ASSISTANT" }), "    const value = 1;");
});

test("document model separates Unicode bullets, tracks announcements, nesting, and hard lines", () => {
  const message = createDocumentMessage({
    sessionId: "readable-structure",
    recordOrdinal: 1,
    role: DOCUMENT_ROLE.USER,
    text: [
      "# Heading",
      "Following heading",
      "",
      "– first",
      "– second",
      "",
      "Normal after list",
      "",
      "Introduction:",
      "- announced",
      "  * nested",
      "",
      "Colon inside a sentence: does not announce",
      "- standalone",
      "",
      "Inline code `value:`",
      "- not announced by code",
      "",
      "> quoted introduction:",
      "- not announced by quote",
      "",
      "> quote",
      "",
      "```text",
      "code",
      "```",
      "After code line one",
      "After code line two",
      "",
      "1. ordered",
      "2. next",
      "",
      "1. restarted",
    ].join("\n"),
  });
  const lists = message.blocks.filter((block) => block.kind === DOCUMENT_BLOCK_KIND.LIST);
  assert.deepEqual(lists[0].items.map((item) => [item.marker, item.level]), [["–", 0], ["–", 0]]);
  assert.equal(lists[0].announced, false);
  assert.equal(lists[1].announced, true);
  assert.deepEqual(lists[1].items.map((item) => [item.marker, item.level]), [["-", 0], ["*", 1]]);
  assert.equal(lists[2].announced, false, "a colon inside a sentence must not announce a list");
  assert.equal(lists[3].announced, false, "a colon inside inline code must not announce a list");
  assert.equal(lists[4].announced, false, "a quoted colon must not announce a list");
  assert.equal(lists.at(-2).start, 1);
  assert.equal(lists.at(-1).start, 1);
  const afterCode = message.blocks.find((block) => block.kind === DOCUMENT_BLOCK_KIND.PARAGRAPH
    && block.inlines.some((inline) => inline.kind === "text" && inline.text.startsWith("After code")));
  assert.equal(afterCode.inlines[0].text, "After code line one\nAfter code line two");
});
