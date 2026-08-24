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

import { DOCUMENT_ROLE, createDocumentMessage, createSessionDocumentHeader } from "../lib/document-model.mjs";
import { PdfExportError, buildDeterministicPdf, resolveVerifiedPdfAsset, safePdfProjectDisplayName, validateCanonicalPdf, validateCanonicalPdfFile } from "../lib/pdf-renderer.mjs";

const execFileAsync = promisify(execFile);
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAGAAAAAwCAIAAABhdOiYAAABq0lEQVR4nO2b0W3DMAxEFaED3U7dIUN0h+ykZQr0ox8Fmq/INkmLR8GxeV8BAkvn5ztFjpPb989vSW2rCu+lSikfTwr4/EocndrjngnSlRWzVazL1ZWF19UmE6QoASlKQBcDhP8VhLhrqWelAxKj8wBCzF63npgOGMjqe60IqxLG909d32tFWKobuT3u3L1uFCAsiEQwWtLpXvjnDQGEDU9cRlt0uPPyAUH0zWKk0mEVjQwIa76XjJyYjNmhFI0JCNu+l2vnsGN7s+QDZwOCwbef0V46/qJxAMHs28NoLDvOohEAwXdVjaaHmyWPEw4I7qtqMe2k4ymaCxAcvu2MKNkZLto4ILh9WxixmiUPywcEkm95i8SlM3b4CCCwfa9GKSI7A0XbDQgxmZfrFvQwysJoHyBE+rbcMcTNQgCE+Ksad8+5NaYaIisgTMl8d3875zGvzKgeis5TE+jYB69HozNNxqLVa9LpJJxXvTKdZuiyBKi9fuNVzij1vJSKtYmfJseUvki3C9M5z6PnOCUgRQlIUQLa+SvX/EV5p0yQogSk6Jb/9pGVCSqy/gD5cfpUy6at1AAAAABJRU5ErkJggg==", "base64");
const JPEG = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAAgAEADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDxeiiiv3g/FAooooAKKKKACiiigAooooAKKKKACiiigAooooA//9k=", "base64");
const LONG_URL = `https://example.invalid/technical/${"a".repeat(700)}`;

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function attachment(data, mediaType) {
  return { sha256: sha256(data), sourceSha256: sha256(Buffer.concat([data, Buffer.from("source")])), mediaType, decodedBytes: data.length };
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
  });
  const message = createDocumentMessage({
    sessionId,
    recordOrdinal: 2,
    role: DOCUMENT_ROLE.USER,
    label: "User",
    timestamp: "2026-08-24T10:00:01.000Z",
    text: `# Überschrift\n\nUmlaute äöü & < >, “Zitat” →. Link: [OpenAI](https://openai.com/). Long URL: [technical reference](${LONG_URL}).\n\nUnsafe: [script](javascript:noop), [data](data:text/plain,secret), [file](file:///C:/secret.txt), [UNC](//server/share), [too long](https://example.invalid/${"z".repeat(2100)}).\n\n- eins\n- zwei\n\n\`\`\`js\nconst value = '<&>';\n${"A".repeat(5000)}\n\`\`\``,
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

test("PDF renderer fails closed for missing glyphs and corrupt image data without leaking content", async () => {
  const sessionId = "glyph-session";
  const header = createSessionDocumentHeader({ id: sessionId, title: "Glyph test" });
  const secretMarker = `private-${String.fromCodePoint(0x10ffff)}-content`;
  const messages = [createDocumentMessage({ sessionId, recordOrdinal: 1, role: DOCUMENT_ROLE.USER, label: "User", text: secretMarker })];
  await assert.rejects(
    () => buildDeterministicPdf({ header, messages, resolveAsset: async () => null }),
    (error) => error instanceof PdfExportError && error.code === "PDF_GLYPH_MISSING" && error.message.includes("glyph-session") && error.message.includes("U+10FFFF") && !error.message.includes("private-"),
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

test("PDF validation rejects active actions and non-HTTP URI actions", async () => {
  const safe = await buildDeterministicPdf(createRepresentativeDocument(false));
  for (const token of ["/Launch", "/JavaScript", "/EmbeddedFile", "/AcroForm", "/GoToR"]) {
    const modified = Buffer.concat([safe.subarray(0, -6), Buffer.from(`\n${token}\n%%EOF\n`, "latin1")]);
    assert.throws(() => validateCanonicalPdf(modified), (error) => error instanceof PdfExportError && error.code === "PDF_ACTIVE_CONTENT", token);
  }
  const fileAction = Buffer.concat([safe.subarray(0, -6), Buffer.from("\n/S /URI /URI (file:///C:/secret.txt)\n%%EOF\n", "latin1")]);
  assert.throws(() => validateCanonicalPdf(fileAction), (error) => error instanceof PdfExportError && error.code === "PDF_EXTERNAL_ACTION_UNSAFE");
});

test("streaming PDF validation accepts canonical output and rejects active actions", async () => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pdf-stream-validation-")));
  try {
    const safe = await buildDeterministicPdf(createRepresentativeDocument(false));
    const safePath = path.join(temp, "safe.pdf");
    await fs.writeFile(safePath, safe);
    assert.equal(await validateCanonicalPdfFile(safePath), true);

    const unsafePath = path.join(temp, "unsafe.pdf");
    await fs.writeFile(unsafePath, Buffer.concat([safe.subarray(0, -6), Buffer.from("\n/SubmitForm\n%%EOF\n", "latin1")]));
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
    } catch (error) {
      if (error?.code === "ENOENT") t.skip("Poppler is not available on PATH; set POPPLER_BIN to enable rendering verification");
      else throw error;
    }
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});
