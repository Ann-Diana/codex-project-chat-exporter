import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import dns from "node:dns";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import tls from "node:tls";
import { promisify } from "node:util";
import { inflateSync } from "node:zlib";

import PDFDocument from "pdfkit";
import { securityPdf } from "./helpers/pdf-security-fixture.mjs";
import { DOCUMENT_ROLE, createDocumentMessage, createSessionDocumentHeader } from "../lib/document-model.mjs";
import { PdfExportError, buildDeterministicPdf, resolveVerifiedPdfAsset, safePdfProjectDisplayName, validateCanonicalPdf, validateCanonicalPdfFile } from "../lib/pdf-renderer.mjs";
import { normalizeReadableMessageText } from "../lib/reading-content.mjs";

const execFileAsync = promisify(execFile);
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAGAAAAAwCAIAAABhdOiYAAABq0lEQVR4nO2b0W3DMAxEFaED3U7dIUN0h+ykZQr0ox8Fmq/INkmLR8GxeV8BAkvn5ztFjpPb989vSW2rCu+lSikfTwr4/EocndrjngnSlRWzVazL1ZWF19UmE6QoASlKQBcDhP8VhLhrqWelAxKj8wBCzF63npgOGMjqe60IqxLG909d32tFWKobuT3u3L1uFCAsiEQwWtLpXvjnDQGEDU9cRlt0uPPyAUH0zWKk0mEVjQwIa76XjJyYjNmhFI0JCNu+l2vnsGN7s+QDZwOCwbef0V46/qJxAMHs28NoLDvOohEAwXdVjaaHmyWPEw4I7qtqMe2k4ymaCxAcvu2MKNkZLto4ILh9WxixmiUPywcEkm95i8SlM3b4CCCwfa9GKSI7A0XbDQgxmZfrFvQwysJoHyBE+rbcMcTNQgCE+Ksad8+5NaYaIisgTMl8d3875zGvzKgeis5TE+jYB69HozNNxqLVa9LpJJxXvTKdZuiyBKi9fuNVzij1vJSKtYmfJseUvki3C9M5z6PnOCUgRQlIUQLa+SvX/EV5p0yQogSk6Jb/9pGVCSqy/gD5cfpUy6at1AAAAABJRU5ErkJggg==", "base64");
const JPEG = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAAgAEADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDxeiiiv3g/FAooooAKKKKACiiigAooooAKKKKACiiigAooooA//9k=", "base64");
const LONG_URL = `https://example.invalid/technical/${"a".repeat(700)}`;
const REQUIRED_SYMBOLS = Object.freeze(["→", "←", "↑", "↓", "✓", "⚠", "±", "≤", "≥"]);

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function attachment(data, mediaType) {
  return { sha256: sha256(data), sourceSha256: sha256(Buffer.concat([data, Buffer.from("source")])), mediaType, decodedBytes: data.length };
}

function inflatedPdfStreams(bytes) {
  const streamStart = Buffer.from("stream\n", "latin1");
  const streamEnd = Buffer.from("\nendstream", "latin1");
  const streams = [];
  let cursor = 0;
  while (cursor < bytes.length) {
    const marker = bytes.indexOf(streamStart, cursor);
    if (marker < 0) break;
    const start = marker + streamStart.length;
    const end = bytes.indexOf(streamEnd, start);
    assert.notEqual(end, -1, "each PDF stream must have its closing delimiter");
    const content = bytes.subarray(start, end);
    try {
      streams.push(inflateSync(content).toString("latin1"));
    } catch {
      streams.push(content.toString("latin1"));
    }
    cursor = end + streamEnd.length;
  }
  return streams;
}

async function captureRenderedPdfFragments(options) {
  const fragments = [];
  const originalFragment = PDFDocument.prototype._fragment;
  PDFDocument.prototype._fragment = function captureFragment(text, x, y, textOptions) {
    const originalAddContent = this.addContent;
    let matrixY;
    this.addContent = function captureContent(command) {
      const tokens = String(command).split(" ");
      if (tokens.length === 7 && tokens[6] === "Tm") matrixY = Number(tokens[5]);
      return originalAddContent.call(this, command);
    };
    try {
      return originalFragment.call(this, text, x, y, textOptions);
    } finally {
      this.addContent = originalAddContent;
      if (matrixY !== undefined) {
        fragments.push({
          text: String(text),
          page: this.page.dictionary.id,
          pageIndex: this._pageBuffer.indexOf(this.page),
          x,
          top: y,
          baseline: matrixY,
          font: this._font.name,
          fontSize: this._fontSize,
          lineHeight: this.currentLineHeight(true),
          requestedBaseline: textOptions.baseline,
        });
      }
    }
  };
  try {
    return { bytes: await buildDeterministicPdf(options), fragments };
  } finally {
    PDFDocument.prototype._fragment = originalFragment;
  }
}

function fragmentContaining(fragments, marker) {
  const matches = fragments.filter((fragment) => fragment.text.includes(marker));
  assert.equal(matches.length, 1, `${marker} must occur in exactly one emitted text fragment`);
  return matches[0];
}

function assertLineMarkersDoNotOverlap(fragments, markers) {
  const lines = markers.map((marker) => fragmentContaining(fragments, marker));
  for (let index = 1; index < lines.length; index += 1) {
    const previous = lines[index - 1];
    const current = lines[index];
    if (current.pageIndex === previous.pageIndex) {
      assert.ok(
        current.top >= previous.top + previous.lineHeight - 0.01,
        `${markers[index]} must start below the bounding box of ${markers[index - 1]}`,
      );
    } else {
      assert.ok(current.pageIndex > previous.pageIndex, `${markers[index]} must follow ${markers[index - 1]} on a later page`);
    }
  }
  return lines;
}

async function captureSyntheticLayout(text, recordOrdinal = 1) {
  const sessionId = `layout-session-${recordOrdinal}`;
  const header = createSessionDocumentHeader({ id: sessionId, title: "Vertical layout regression" });
  const messages = [createDocumentMessage({ sessionId, recordOrdinal, role: DOCUMENT_ROLE.USER, label: "User", text })];
  return captureRenderedPdfFragments({ header, messages, resolveAsset: async () => null });
}

async function withoutNetwork(action) {
  const blocked = () => { throw new Error("unexpected network access"); };
  const patches = [
    [http, "get"], [http, "request"], [https, "get"], [https, "request"],
    [net, "connect"], [net, "createConnection"], [tls, "connect"], [dns, "lookup"], [dns, "resolve"],
  ].map(([owner, key]) => [owner, key, owner[key]]);
  const previousFetch = globalThis.fetch;
  try {
    for (const [owner, key] of patches) owner[key] = blocked;
    globalThis.fetch = blocked;
    return await action();
  } finally {
    for (const [owner, key, value] of patches) owner[key] = value;
    globalThis.fetch = previousFetch;
  }
}

function createRepresentativeDocument(repeatedPng = true) {
  const sessionId = "11111111-1111-7111-8111-111111111111";
  const png = attachment(PNG, "image/png");
  const jpeg = attachment(JPEG, "image/jpeg");
  const gif = attachment(Buffer.from("GIF89a-not-embedded"), "image/gif");
  const webp = attachment(Buffer.from("RIFF-not-embedded-WEBP"), "image/webp");
  const binary = attachment(Buffer.from([0, 1, 2, 3]), "application/octet-stream");
  const assets = new Map([
    [png.sha256, { data: PNG, extension: "png", mediaType: "image/png", path: `assets/${png.sha256}.png`, renderable: true, sha256: png.sha256 }],
    [jpeg.sha256, { data: JPEG, extension: "jpg", mediaType: "image/jpeg", path: `assets/${jpeg.sha256}.jpg`, renderable: true, sha256: jpeg.sha256 }],
    [gif.sha256, { data: Buffer.from("GIF89a-not-embedded"), extension: "gif", mediaType: "image/gif", path: `assets/${gif.sha256}.gif`, renderable: true, sha256: gif.sha256 }],
    [webp.sha256, { data: Buffer.from("RIFF-not-embedded-WEBP"), extension: "webp", mediaType: "image/webp", path: `assets/${webp.sha256}.webp`, renderable: true, sha256: webp.sha256 }],
    [binary.sha256, { data: Buffer.from([0, 1, 2, 3]), extension: "bin", mediaType: "application/octet-stream", path: `assets/${binary.sha256}.bin`, renderable: false, sha256: binary.sha256 }],
  ]);
  const header = createSessionDocumentHeader({
    id: sessionId,
    displayTitle: "Sitzung äöü & <PDF>",
    cwd: "C:\\Projects\\alpha",
    timestamp: "2026-08-24T10:00:00.000Z",
    updatedAt: "2026-08-24T10:02:00.000Z",
    models: ["gpt-5.5", "gpt-5.6-sol"],
  });
  const message = createDocumentMessage({
    sessionId,
    recordOrdinal: 2,
    role: DOCUMENT_ROLE.USER,
    label: "User",
    timestamp: "2026-08-24T10:00:01.000Z",
    text: `# Überschrift\n\nUmlaute äöü & < >, “Zitat” ${REQUIRED_SYMBOLS.join(" ")}. Emoji 😄 ⚠️ 👩‍💻. Link: [OpenAI](https://openai.com/). Long URL: [technical reference](${LONG_URL}).\n\nUnsafe: [script](javascript:noop), [data](data:text/plain,secret), [file](file:///C:/secret.txt), [UNC](//server/share), [too long](https://example.invalid/${"z".repeat(2100)}).\n\n- eins → ✓\n- zwei ≤ ≥\n\n\`\`\`js\nconst value = '<&> ${REQUIRED_SYMBOLS.join(" ")}';\n${"A".repeat(5000)}\n\`\`\``,
    attachments: repeatedPng ? [png, png, jpeg, gif, webp, binary] : [png, jpeg, gif, webp, binary],
  });
  const messages = [
    message,
    createDocumentMessage({ sessionId, recordOrdinal: 3, role: DOCUMENT_ROLE.ASSISTANT, label: "Assistant", text: "Zweite Nachricht." }),
    createDocumentMessage({ sessionId, recordOrdinal: 4, role: DOCUMENT_ROLE.UNCLASSIFIED, label: "Unclassified user-role record", text: "Letzte Nachricht." }),
  ];
  return { header, messages, resolveAsset: async (reference) => assets.get(reference.sha256) };
}

test("PDF project metadata keeps only a non-path display name", () => {
  assert.equal(safePdfProjectDisplayName("C:\\Projects\\alpha"), "alpha");
  assert.equal(safePdfProjectDisplayName("/srv/private/beta"), "beta");
  assert.equal(safePdfProjectDisplayName("\\\\server\\share\\gamma"), "gamma");
  assert.equal(safePdfProjectDisplayName("C:\\"), "");
});

test("PDF header renders the shared chronological model summary", async () => {
  const header = createSessionDocumentHeader({ id: "model-history", models: ["gpt-5.5", "gpt-5.6-sol"] });
  const { fragments } = await captureRenderedPdfFragments({ header, messages: [], resolveAsset: async () => null });
  assert.ok(fragments.map((fragment) => fragment.text).join("").includes("Models: gpt-5.5 → gpt-5.6-sol"));
});

test("PDF renderer creates deterministic offline A4 documents with safe links and deduplicated images", async () => {
  const options = createRepresentativeDocument();
  const first = await withoutNetwork(() => buildDeterministicPdf(options));
  const second = await withoutNetwork(() => buildDeterministicPdf(options));
  assert.deepEqual(first, second, "repeated PDF exports must be byte-identical");
  assert.deepEqual(validateCanonicalPdf(first), first);
  const source = first.toString("latin1");
  const uriActionCount = source.split("/S /URI").length - 1;
  assert.ok(uriActionCount >= 1, "the controlled HTTP(S) link must become at least one clickable annotation");
  assert.ok(source.includes("/URI (https://openai.com/)"));
  assert.ok(source.includes(`/URI (${LONG_URL})`), "a long allowed URL must remain complete in its clickable annotation");
  assert.equal(source.includes("z".repeat(2100)), false, "an overlong target must remain blocked without entering the PDF structure");
  assert.equal(source.toLowerCase().includes("file:"), false);
  assert.equal(source.includes("/Launch"), false);
  assert.equal(source.includes("/JavaScript"), false);
  assert.equal(source.includes("/EmbeddedFile"), false);
  assert.equal(source.includes("/AcroForm"), false);
  assert.equal(source.includes("C:\\Projects\\alpha"), false, "absolute source paths must not enter the PDF structure");
  assert.equal(source.includes(path.resolve("fonts")), false, "absolute bundled-font paths must not enter the PDF structure");

  const withoutDuplicate = await buildDeterministicPdf(createRepresentativeDocument(false));
  assert.equal(source.split("/Subtype /Image").length, withoutDuplicate.toString("latin1").split("/Subtype /Image").length, "a repeated PNG must reuse the same embedded image object");
});

test("mixed proportional, monospace, and symbol runs emit aligned text matrices and intact Unicode mappings", async () => {
  const sessionId = "baseline-session";
  const header = createSessionDocumentHeader({ id: sessionId, title: "Baseline test" });
  const symbolSequence = "A→B←C↑D↓E✓F⚠G±H≤I≥J";
  const text = `Normal: ${symbolSequence}\n\n\`\`\`text\nMono: ${symbolSequence}\n\`\`\``;
  const messages = [createDocumentMessage({ sessionId, recordOrdinal: 1, role: DOCUMENT_ROLE.USER, label: "User", text })];
  const { bytes, fragments } = await withoutNetwork(() => captureRenderedPdfFragments({ header, messages, resolveAsset: async () => null }));

  for (const [label, fontSize, primaryFont] of [["Normal: ", 10.5, "NotoSans-Regular"], ["Mono: ", 8.5, "NotoSansMono-Regular"]]) {
    const initial = fragments.find((fragment) => fragment.text.startsWith(label));
    assert.ok(initial, `${label} must be emitted as a real PDF text fragment`);
    const line = fragments.filter((fragment) => fragment.top === initial.top && fragment.fontSize === fontSize);
    assert.equal(line.map((fragment) => fragment.text).join(""), `${label}${symbolSequence}`);
    assert.ok(line.some((fragment) => fragment.font === primaryFont));
    assert.ok(line.some((fragment) => fragment.font === "NotoSansSymbols2-Regular"));
    assert.ok(line.some((fragment) => fragment.font === "NotoSansMono-Regular"));
    if (label === "Normal: ") assert.ok(line.some((fragment) => fragment.font === "NotoSansSymbols-Regular"));
    assert.equal(new Set(line.map((fragment) => fragment.baseline)).size, 1, `${label} must use one emitted PDF text-matrix baseline`);
    assert.equal(new Set(line.map((fragment) => fragment.lineHeight)).size, 1, `${label} must retain the primary font line height`);
    assert.equal(new Set(line.map((fragment) => fragment.requestedBaseline)).size, 1, `${label} must compute one metrics-based baseline`);
    assert.equal(line[0].lineHeight, 1.362 * fontSize);
    assert.equal(line[0].requestedBaseline, -1.069 * fontSize);
  }

  const unicodeMaps = inflatedPdfStreams(bytes).filter((stream) => stream.includes("beginbfchar") || stream.includes("beginbfrange")).join("\n").toUpperCase();
  assert.notEqual(unicodeMaps.length, 0, "embedded font subsets must publish ToUnicode maps");
  for (const symbol of REQUIRED_SYMBOLS) {
    const scalar = symbol.codePointAt(0).toString(16).toUpperCase().padStart(4, "0");
    assert.ok(unicodeMaps.includes(`<${scalar}>`), `ToUnicode must preserve ${symbol} as U+${scalar} for copying and selection`);
  }
  assert.deepEqual(bytes, await buildDeterministicPdf({ header, messages, resolveAsset: async () => null }), "mixed-font PDF output must remain byte-identical");
});

test("fallback-heavy proportional and monospace text preserves wrapping, baseline, and every symbol", async () => {
  const sessionId = "wrapped-baseline-session";
  const header = createSessionDocumentHeader({ id: sessionId, title: "Wrapped baseline test" });
  const repeated = Array.from({ length: 36 }, (_, index) => `A→B←C↑D↓E✓F⚠G±H≤I≥J${index}`).join(" ");
  const text = `${repeated}\n\n\`\`\`text\n${repeated}\n\`\`\``;
  const messages = [createDocumentMessage({ sessionId, recordOrdinal: 1, role: DOCUMENT_ROLE.USER, label: "User", text })];
  const { bytes, fragments } = await captureRenderedPdfFragments({ header, messages, resolveAsset: async () => null });

  for (const fontSize of [10.5, 8.5]) {
    const runs = fragments.filter((fragment) => fragment.fontSize === fontSize);
    const lines = new Map();
    for (const run of runs) {
      const key = `${run.page}:${run.top}`;
      if (!lines.has(key)) lines.set(key, []);
      lines.get(key).push(run);
    }
    assert.ok(lines.size > 1, `${fontSize}-point text must wrap instead of being clipped`);
    for (const [key, line] of lines) {
      assert.equal(new Set(line.map((fragment) => fragment.baseline)).size, 1, `${key} must retain one emitted baseline`);
      assert.equal(new Set(line.map((fragment) => fragment.lineHeight)).size, 1, `${key} must retain one line height`);
    }
    const rendered = runs.map((run) => run.text).join("");
    for (const symbol of REQUIRED_SYMBOLS) {
      assert.equal(rendered.split(symbol).length - 1, 36, `wrapped ${fontSize}-point text must retain every ${symbol}`);
    }
  }
  assert.deepEqual(bytes, await buildDeterministicPdf({ header, messages, resolveAsset: async () => null }));
});

test("paragraphs and lists ending in fallback glyphs preserve subsequent vertical spacing", async () => {
  const sessionId = "terminal-fallback-spacing-session";
  const header = createSessionDocumentHeader({ id: sessionId, title: "Terminal fallback spacing test" });
  const render = async (ending) => captureRenderedPdfFragments({
    header,
    messages: [
      createDocumentMessage({ sessionId, recordOrdinal: 1, role: DOCUMENT_ROLE.USER, label: "First message", text: `- List item ${ending}\n\nFollowing paragraph ${ending}` }),
      createDocumentMessage({ sessionId, recordOrdinal: 2, role: DOCUMENT_ROLE.USER, label: "Second message", text: "Final paragraph" }),
    ],
    resolveAsset: async () => null,
  });

  const normal = await render("A");
  const fallback = await render("✓");
  for (const label of ["Following paragraph ", "Second message", "Final paragraph"]) {
    const regularFragment = normal.fragments.find((fragment) => fragment.text.startsWith(label));
    const fallbackFragment = fallback.fragments.find((fragment) => fragment.text.startsWith(label));
    assert.ok(regularFragment && fallbackFragment, `${label} must be emitted in both documents`);
    assert.equal(fallbackFragment.top, regularFragment.top, `${label} must not shift when the previous run ends in a fallback glyph`);
  }
});

test("an inline arrow retains the primary baseline and advances to the next hard line", async () => {
  const { fragments } = await captureSyntheticLayout("INLINE_ARROW A → B\nINLINE_ARROW_FOLLOW");
  const first = fragmentContaining(fragments, "INLINE_ARROW A ");
  const line = fragments.filter((fragment) => fragment.pageIndex === first.pageIndex && fragment.top === first.top && fragment.fontSize === 10.5);
  assert.ok(line.some((fragment) => fragment.font === "NotoSans-Regular"));
  assert.ok(line.some((fragment) => fragment.font === "NotoSansSymbols-Regular"));
  assert.equal(new Set(line.map((fragment) => fragment.baseline)).size, 1, "the inline arrow must share the primary text baseline");
  assertLineMarkersDoNotOverlap(fragments, ["INLINE_ARROW A ", "INLINE_ARROW_FOLLOW"]);
});

test("separate arrow-led paragraphs retain independent vertical boxes", async () => {
  const { fragments } = await captureSyntheticLayout("→ ARROW_PARAGRAPH_1\n\n→ ARROW_PARAGRAPH_2\n\n→ ARROW_PARAGRAPH_3", 2);
  assertLineMarkersDoNotOverlap(fragments, ["ARROW_PARAGRAPH_1", "ARROW_PARAGRAPH_2", "ARROW_PARAGRAPH_3"]);
});

test("arrow-led hard lines and following non-arrow lines never reuse a vertical box", async () => {
  const { fragments } = await captureSyntheticLayout("→ ARROW_HARD_1\nPLAIN_HARD_1\n→ ARROW_HARD_2\nPLAIN_HARD_2", 3);
  assertLineMarkersDoNotOverlap(fragments, ["ARROW_HARD_1", "PLAIN_HARD_1", "ARROW_HARD_2", "PLAIN_HARD_2"]);
});

test("a trailing hard break does not create an extra empty output line", async () => {
  const withoutBreak = await captureSyntheticLayout("TRAILING_BREAK_LINE", 31);
  const withBreak = await captureSyntheticLayout("TRAILING_BREAK_LINE\n", 32);
  const withoutLine = fragmentContaining(withoutBreak.fragments, "TRAILING_BREAK_LINE");
  const withLine = fragmentContaining(withBreak.fragments, "TRAILING_BREAK_LINE");
  assert.equal(withLine.top, withoutLine.top);
  assert.equal(withBreak.fragments.filter((fragment) => fragment.fontSize === 10.5).length, withoutBreak.fragments.filter((fragment) => fragment.fontSize === 10.5).length);
});

test("nested list items with arrows retain distinct vertical boxes", async () => {
  const { fragments } = await captureSyntheticLayout("- → ARROW_LIST_0\n  - → ARROW_LIST_1\n    - → ARROW_LIST_2\n- PLAIN_LIST_0", 4);
  assertLineMarkersDoNotOverlap(fragments, ["ARROW_LIST_0", "ARROW_LIST_1", "ARROW_LIST_2", "PLAIN_LIST_0"]);
});

test("wrapped mixed-font runs return their complete height to the following hard line", async () => {
  const mixed = Array.from({ length: 48 }, (_, index) => `segment${index}→`).join(" ");
  const { fragments } = await captureSyntheticLayout(`WRAP_MIXED_BEGIN ${mixed} WRAP_MIXED_END\nWRAP_MIXED_FOLLOW`, 5);
  const beginning = fragmentContaining(fragments, "WRAP_MIXED_BEGIN");
  const ending = fragmentContaining(fragments, "WRAP_MIXED_END");
  assert.ok(
    ending.pageIndex > beginning.pageIndex || ending.top >= beginning.top + beginning.lineHeight - 0.01,
    "the mixed-font source line must wrap to at least one additional vertical box",
  );
  assertLineMarkersDoNotOverlap(fragments, ["WRAP_MIXED_END", "WRAP_MIXED_FOLLOW"]);
});

test("one arrow-heavy block remains non-overlapping across page breaks", async () => {
  const markers = Array.from({ length: 96 }, (_, index) => `PAGE_BREAK_LINE_${String(index).padStart(3, "0")}`);
  const { bytes, fragments } = await captureSyntheticLayout(markers.map((marker) => `→ ${marker}`).join("\n"), 6);
  const lines = assertLineMarkersDoNotOverlap(fragments, markers);
  assert.ok(new Set(lines.map((line) => line.pageIndex)).size >= 3, "the single document block must cross at least two page boundaries");
  assert.deepEqual(bytes, (await captureSyntheticLayout(markers.map((marker) => `→ ${marker}`).join("\n"), 6)).bytes, "page-breaking layout must remain byte-identical");
});

test("emoji fallback preserves graphemes, extraction mappings, baselines, wrapping, and pagination", async () => {
  const emoji = String.fromCodePoint(0x1f604);
  const warning = `⚠${String.fromCodePoint(0xfe0f)}`;
  const supportedZwj = "👩‍💻";
  const decomposed = "a\u0308";
  const markers = Array.from({ length: 72 }, (_, index) => `EMOJI_PAGE_LINE_${String(index).padStart(3, "0")}`);
  const text = [
    `EMOJI_MIX A${emoji}B→C${emoji}D✓E⚠F`,
    `EMOJI_REPEAT ${emoji}${emoji}${emoji}`,
    `EMOJI_BEFORE_BREAK ${emoji}`,
    `${emoji} EMOJI_AFTER_BREAK`,
    `EMOJI_VARIATION ${warning}`,
    `EMOJI_SUPPORTED_ZWJ ${supportedZwj}`,
    `DECOMPOSED_VALID ${decomposed}`,
    ...markers.map((marker, index) => `${index % 2 ? emoji : "→"} ${marker}`),
  ].join("\n");
  const first = await captureSyntheticLayout(text, 61);
  const second = await captureSyntheticLayout(text, 61);
  assert.deepEqual(first.bytes, second.bytes, "emoji fallback and page breaks must remain byte-identical");
  const emojiRuns = first.fragments.filter((fragment) => fragment.font.startsWith("NotoEmoji"));
  assert.ok(emojiRuns.some((fragment) => fragment.text.includes(emoji)), "emoji must be emitted as real font text");
  assert.ok(emojiRuns.some((fragment) => fragment.text.includes(warning)), "emoji-presentation variation sequences must use the separate emoji subset");
  assert.ok(emojiRuns.some((fragment) => fragment.text.includes(`${emoji}${emoji}${emoji}`)), "adjacent emoji must remain adjacent selectable graphemes");
  assert.ok(emojiRuns.some((fragment) => fragment.text.includes(supportedZwj)), "a supported ZWJ grapheme must remain one selectable emoji-font run");
  assert.ok(first.fragments.some((fragment) => fragment.font.startsWith("NotoSans") && fragment.text.includes(decomposed)), "a valid decomposed grapheme must remain primary-font text");
  assert.ok(first.fragments.some((fragment) => fragment.font.startsWith("NotoSansSymbols2") && fragment.text.includes("⚠")), "plain-text warning signs must retain their symbol-font subset");
  const mixedStart = fragmentContaining(first.fragments, "EMOJI_MIX A");
  const mixedLine = first.fragments.filter((fragment) => fragment.pageIndex === mixedStart.pageIndex && fragment.top === mixedStart.top && fragment.fontSize === 10.5);
  assert.ok(new Set(mixedLine.map((fragment) => fragment.font)).size >= 3, "one line must exercise normal, emoji, and symbol fonts");
  assert.equal(new Set(mixedLine.map((fragment) => fragment.baseline)).size, 1, "mixed emoji runs must share the primary baseline");
  assert.equal(new Set(mixedLine.map((fragment) => fragment.lineHeight)).size, 1, "mixed emoji runs must retain the primary line height");
  assertLineMarkersDoNotOverlap(first.fragments, ["EMOJI_BEFORE_BREAK ", "EMOJI_AFTER_BREAK", "EMOJI_VARIATION"]);
  const pageLines = assertLineMarkersDoNotOverlap(first.fragments, markers);
  assert.ok(new Set(pageLines.map((line) => line.pageIndex)).size >= 2, "the emoji block must cross a page boundary");
  const unicodeMaps = inflatedPdfStreams(first.bytes).filter((stream) => stream.includes("beginbfchar") || stream.includes("beginbfrange")).join("\n").toUpperCase();
  const compactUnicodeMaps = unicodeMaps.replaceAll(" ", "");
  assert.ok(compactUnicodeMaps.includes("D83DDE04"), "ToUnicode must retain U+1F604 as its UTF-16 surrogate pair");
  assert.ok(compactUnicodeMaps.includes("26A0FE0F"), "ToUnicode must retain the warning grapheme and variation selector");
  assert.ok(compactUnicodeMaps.includes("D83DDC69200DD83DDCBB"), "ToUnicode must retain every code point of the supported ZWJ grapheme");
});

test("unsupported valid graphemes receive a visible deterministic PDF-only marker", async () => {
  const unsupported = String.fromCodePoint(0x10ffff);
  const sessionId = "unsupported-glyph-session";
  const header = createSessionDocumentHeader({ id: sessionId, title: "Unsupported glyph test" });
  const message = createDocumentMessage({ sessionId, recordOrdinal: 1, role: DOCUMENT_ROLE.USER, label: "User", text: `Before ${unsupported} after` });
  const originalText = message.blocks[0].inlines[0].text;
  const first = await captureRenderedPdfFragments({ header, messages: [message], resolveAsset: async () => null });
  const second = await captureRenderedPdfFragments({ header, messages: [message], resolveAsset: async () => null });
  assert.deepEqual(first.bytes, second.bytes);
  assert.equal(message.blocks[0].inlines[0].text, originalText, "PDF fallback must not mutate the shared document model");
  const rendered = first.fragments.map((fragment) => fragment.text).join("");
  assert.ok(rendered.includes("[unsupported glyph U+10FFFF]"));
  assert.equal(rendered.includes(unsupported), false);
});

test("an unsupported ZWJ grapheme receives one complete ordered code-point marker", async () => {
  const unsupportedZwj = "😄‍😄";
  const sessionId = "unsupported-zwj-session";
  const header = createSessionDocumentHeader({ id: sessionId, title: "Unsupported ZWJ test" });
  const message = createDocumentMessage({ sessionId, recordOrdinal: 1, role: DOCUMENT_ROLE.USER, label: "User", text: `Before ${unsupportedZwj} after` });
  const originalText = message.blocks[0].inlines[0].text;
  const first = await captureRenderedPdfFragments({ header, messages: [message], resolveAsset: async () => null });
  const second = await captureRenderedPdfFragments({ header, messages: [message], resolveAsset: async () => null });
  assert.deepEqual(first.bytes, second.bytes);
  assert.equal(message.blocks[0].inlines[0].text, originalText, "PDF fallback must not mutate the shared document model");
  const rendered = first.fragments.map((fragment) => fragment.text).join("");
  assert.ok(rendered.includes("[unsupported glyph U+1F604 U+200D U+1F604]"));
  assert.equal(rendered.includes(unsupportedZwj), false);
});

test("Readable PDF keeps standalone and announced lists distinct and renders path trees as stable monospace lines", async () => {
  const text = normalizeReadableMessageText([
    "- STANDALONE_ITEM",
    "",
    "Announcement:",
    "– ANNOUNCED_ITEM",
    "  * NESTED_ITEM",
    "",
    "├── TREE_LINE_1",
    "│   └── TREE_LINE_2",
    `└── TREE_LONG_${"segment_".repeat(70)}`,
    "",
    "FOLLOWING_NORMAL",
  ].join("\n"), { role: "USER" });
  const first = await captureSyntheticLayout(text, 41);
  const second = await captureSyntheticLayout(text, 41);
  assert.deepEqual(first.bytes, second.bytes);
  const standalone = fragmentContaining(first.fragments, "STANDALONE_ITEM");
  const announced = fragmentContaining(first.fragments, "ANNOUNCED_ITEM");
  const nested = fragmentContaining(first.fragments, "NESTED_ITEM");
  assert.ok(announced.x > standalone.x, "an announced list must be moderately block-indented");
  assert.ok(nested.x > announced.x, "only a true nested item may receive the additional level indent");
  const treeLines = ["TREE_LINE_1", "TREE_LINE_2", "TREE_LONG_"];
  const treeFragments = treeLines.map((marker) => fragmentContaining(first.fragments, marker));
  assert.ok(treeFragments.every((fragment) => fragment.font === "NotoSansMono-Regular"));
  assertLineMarkersDoNotOverlap(first.fragments, [...treeLines, "FOLLOWING_NORMAL"]);
});

test("the additional bundled symbol and emoji faces fail closed when missing or modified", async () => {
  const sessionId = "font-integrity-session";
  const header = createSessionDocumentHeader({ id: sessionId, title: "Font integrity test" });
  const messages = [createDocumentMessage({ sessionId, recordOrdinal: 1, role: DOCUMENT_ROLE.USER, label: "User", text: "✓ ⚠" })];
  const fontRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pdf-symbol-font-integrity-")));
  const symbolPath = path.join(fontRoot, "NotoSansSymbols2-Regular.ttf");
  try {
    await fs.cp(path.resolve("fonts"), fontRoot, { recursive: true });
    await fs.rm(symbolPath);
    await assert.rejects(
      () => buildDeterministicPdf({ header, messages, fontRoot, resolveAsset: async () => null }),
      (error) => error instanceof PdfExportError && error.code === "PDF_FONT_MISSING" && error.message.includes("NotoSansSymbols2-Regular.ttf"),
    );

    const modified = Buffer.from(await fs.readFile(path.resolve("fonts", "NotoSansSymbols2-Regular.ttf")));
    modified[modified.length - 1] ^= 1;
    await fs.writeFile(symbolPath, modified, { flag: "wx" });
    await assert.rejects(
      () => buildDeterministicPdf({ header, messages, fontRoot, resolveAsset: async () => null }),
      (error) => error instanceof PdfExportError && error.code === "PDF_FONT_INTEGRITY" && error.message.includes("NotoSansSymbols2-Regular.ttf"),
    );

    await fs.cp(path.resolve("fonts", "NotoSansSymbols2-Regular.ttf"), symbolPath);
    const emojiPath = path.join(fontRoot, "NotoEmoji-Variable.ttf");
    await fs.rm(emojiPath);
    await assert.rejects(
      () => buildDeterministicPdf({ header, messages, fontRoot, resolveAsset: async () => null }),
      (error) => error instanceof PdfExportError && error.code === "PDF_FONT_MISSING" && error.message.includes("NotoEmoji-Variable.ttf"),
    );
    const modifiedEmoji = Buffer.from(await fs.readFile(path.resolve("fonts", "NotoEmoji-Variable.ttf")));
    modifiedEmoji[modifiedEmoji.length - 1] ^= 1;
    await fs.writeFile(emojiPath, modifiedEmoji, { flag: "wx" });
    await assert.rejects(
      () => buildDeterministicPdf({ header, messages, fontRoot, resolveAsset: async () => null }),
      (error) => error instanceof PdfExportError && error.code === "PDF_FONT_INTEGRITY" && error.message.includes("NotoEmoji-Variable.ttf"),
    );
  } finally {
    await fs.rm(fontRoot, { recursive: true, force: true });
  }
});

test("PDF renderer rejects invalid UTF-16 and corrupt image data without leaking content", async () => {
  const sessionId = "glyph-session";
  const header = createSessionDocumentHeader({ id: sessionId, title: "Glyph test" });
  const secretMarker = "private-\ud800-content";
  const messages = [createDocumentMessage({ sessionId, recordOrdinal: 1, role: DOCUMENT_ROLE.USER, label: "User", text: secretMarker })];
  await assert.rejects(
    () => buildDeterministicPdf({ header, messages, resolveAsset: async () => null }),
    (error) => error instanceof PdfExportError && error.code === "PDF_INVALID_UNICODE" && error.message.includes("glyph-session") && error.message.includes("U+D800") && !error.message.includes("private-"),
  );

  const broken = attachment(Buffer.from("not-a-png"), "image/png");
  const brokenMessages = [createDocumentMessage({ sessionId, recordOrdinal: 2, role: DOCUMENT_ROLE.USER, label: "User", attachments: [broken] })];
  await assert.rejects(
    () => buildDeterministicPdf({
      header,
      messages: brokenMessages,
      resolveAsset: async () => ({ data: Buffer.from("not-a-png"), extension: "png", mediaType: "image/png", path: `assets/${broken.sha256}.png`, renderable: true, sha256: broken.sha256 }),
    }),
    (error) => error instanceof PdfExportError && error.code === "PDF_ASSET_INVALID",
  );
});

test("PDF validation distinguishes harmless text/URL/stream bytes from structural active content", async () => {
  const safe = await securityPdf(doc => {
    doc.link(10, 10, 100, 10, "https://example.invalid/3D?x=1&y=2");
    const stream = doc.ref({}); stream.end(Buffer.from("/3D /Launch /JavaScript endobj startxref 1 %%EOF"));
    doc.info.Title = "/3D /JavaScript (nested) & metadata";
  });
  assert.doesNotThrow(() => validateCanonicalPdf(safe));
  for (const key of ["3D", "3#44", "AA", "JavaScript", "Launch", "EmbeddedFile", "AcroForm", "RichMedia", "Filespec", "GoToR"]) {
    const unsafe = await securityPdf(doc => { const ref = doc.ref({ [key]: true }); ref.end(); doc._root.data.Test = ref; });
    assert.throws(() => validateCanonicalPdf(unsafe), e => e.code === "PDF_ACTIVE_CONTENT", key);
  }
  for (const action of ["JavaScript", "Launch", "GoToR", "SubmitForm", "UnknownAction"]) {
    const unsafe = await securityPdf(doc => { const ref = doc.ref({ S: action }); ref.end(); doc._root.data.A = ref; });
    assert.throws(() => validateCanonicalPdf(unsafe), e => e.code === "PDF_ACTIVE_CONTENT", action);
  }
  for (const target of ["file:///C:/secret.txt", "javascript:noop", "data:text/plain,x", "\\\\host\\share", "https://exa mple.invalid", "https://example.invalid/" + "a".repeat(2050)]) {
    const unsafe = await securityPdf(doc => doc.link(10, 10, 100, 10, target));
    assert.throws(() => validateCanonicalPdf(unsafe), e => e.code === "PDF_EXTERNAL_ACTION_UNSAFE", target);
  }
  const external = await securityPdf(doc => { const stream = doc.ref({ F: new String("https://example.invalid/image") }); stream.end("ignored"); });
  assert.throws(() => validateCanonicalPdf(external), e => e.code === "PDF_ACTIVE_CONTENT");
  const malformed = Buffer.concat([safe.subarray(0,-6), Buffer.from("/Launch\n%%EOF\n")]);
  assert.throws(() => validateCanonicalPdf(malformed), e => e.code === "PDF_STRUCTURE_INVALID");
});

test("streaming PDF validation accepts canonical output and rejects active actions", async () => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pdf-stream-validation-")));
  try {
    const safe = await buildDeterministicPdf(createRepresentativeDocument(false));
    const safePath = path.join(temp, "safe.pdf");
    await fs.writeFile(safePath, safe);
    assert.equal(await validateCanonicalPdfFile(safePath), true);

    const unsafePath = path.join(temp, "unsafe.pdf");
    await fs.writeFile(unsafePath, await securityPdf(doc => { doc._root.data.OpenAction = { S: "SubmitForm" }; }));
    await assert.rejects(() => validateCanonicalPdfFile(unsafePath), (error) => error instanceof PdfExportError && error.code === "PDF_ACTIVE_CONTENT");
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("verified PDF asset resolution fails closed for missing and manipulated files", async () => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pdf-assets-")));
  try {
    const assetRoot = path.join(temp, "assets");
    await fs.mkdir(assetRoot);
    const hash = sha256(PNG);
    const relative = `assets/${hash}.png`;
    const entry = { bytes: PNG.length, extension: "png", mime_type: "image/png", path: relative, renderable: true, sha256: hash };
    const store = { assetForDescriptor: () => entry };
    const reference = { sha256: hash, origin: { recordOrdinal: 1 } };
    await assert.rejects(() => resolveVerifiedPdfAsset(store, temp, reference), (error) => error.code === "PDF_ASSET_MISSING");
    await fs.writeFile(path.join(temp, relative), Buffer.concat([PNG, Buffer.from("changed")]));
    await assert.rejects(() => resolveVerifiedPdfAsset(store, temp, reference), (error) => error.code === "PDF_ASSET_MISMATCH");
    await fs.writeFile(path.join(temp, relative), PNG);
    assert.deepEqual((await resolveVerifiedPdfAsset(store, temp, reference)).data, PNG);

    const binary = Buffer.alloc(1024 * 1024, 0x41);
    const binaryHash = sha256(binary);
    const binaryRelative = `assets/${binaryHash}.bin`;
    const binaryEntry = { bytes: binary.length, extension: "bin", mime_type: "application/octet-stream", path: binaryRelative, renderable: false, sha256: binaryHash };
    await fs.writeFile(path.join(temp, binaryRelative), binary);
    const binaryAsset = await resolveVerifiedPdfAsset({ assetForDescriptor: () => binaryEntry }, temp, { sha256: binaryHash, origin: { recordOrdinal: 2 } });
    assert.equal(binaryAsset.data, undefined, "non-renderable attachments must be integrity-checked without retaining their bytes");
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("Poppler parses, extracts, and renders the representative multi-page PDF", async (t) => {
  const popplerBin = process.env.POPPLER_BIN || "";
  const executable = (name) => popplerBin ? path.join(popplerBin, process.platform === "win32" ? `${name}.exe` : name) : name;
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pdf-poppler-")));
  try {
    const pdfPath = path.join(temp, "representative.pdf");
    await fs.writeFile(pdfPath, await buildDeterministicPdf(createRepresentativeDocument()));
    try {
      const info = await execFileAsync(executable("pdfinfo"), [pdfPath], { encoding: "utf8" });
      assert.match(info.stdout, /Page size:\s+595\.28 x 841\.89 pts \(A4\)/);
      assert.match(info.stdout, /Pages:\s+[2-9][0-9]*/);
      const outputPrefix = path.join(temp, "page");
      await execFileAsync(executable("pdftoppm"), ["-f", "1", "-singlefile", "-png", "-r", "96", pdfPath, outputPrefix]);
      const rendered = await fs.stat(`${outputPrefix}.png`);
      assert.ok(rendered.isFile() && rendered.size > 0);
      const textPath = path.join(temp, "representative.txt");
      const pdftotext = process.env.PDFTOTEXT_PATH || executable("pdftotext");
      try {
        await execFileAsync(pdftotext, ["-enc", "UTF-8", pdfPath, textPath]);
        const extracted = await fs.readFile(textPath, "utf8");
        assert.ok(extracted.includes("😄"), "UTF-8 extraction must retain U+1F604");
        assert.ok(extracted.includes("⚠️"), "UTF-8 extraction must retain the warning variation sequence");
        assert.ok(extracted.includes("👩‍💻"), "UTF-8 extraction must retain the supported ZWJ grapheme");
      } catch (error) {
        if (error?.code === "ENOENT") t.diagnostic("pdftotext is unavailable; ToUnicode assertions remain authoritative");
        else throw error;
      }
    } catch (error) {
      if (error?.code === "ENOENT") t.skip("Poppler is not available on PATH; set POPPLER_BIN to enable rendering verification");
      else throw error;
    }
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});
