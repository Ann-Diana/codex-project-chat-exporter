import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as fontkit from "fontkit";
import PDFDocument from "pdfkit";

import { DOCUMENT_BLOCK_KIND, classifyLinkTarget } from "./document-model.mjs";
import { VerifiedAssetError, resolveVerifiedLocalAsset } from "./verified-asset.mjs";

const FIXED_PDF_DATE = new Date("2000-01-01T00:00:00.000Z");
const DEFAULT_FONT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fonts");
const PAGE_MARGINS = Object.freeze({ top: 54, right: 54, bottom: 60, left: 54 });
const BODY_SIZE = 10.5;
const BODY_LINE_GAP = 2.5;
const FOOTER_SIZE = 8;
const FONT_FILES = Object.freeze({
  regular: Object.freeze({ name: "NotoSans", file: "NotoSans-Regular.ttf", sha256: "478c558ea716033cd60c03438f628dfa75694dcf6b5f6d505a2f05fd2b4f3823" }),
  bold: Object.freeze({ name: "NotoSans-Bold", file: "NotoSans-Bold.ttf", sha256: "1df075a380fc7cb898acf64c1f7b3b4dd780de3caa860178bf929de35817a913" }),
  italic: Object.freeze({ name: "NotoSans-Italic", file: "NotoSans-Italic.ttf", sha256: "467e3f89eeca4108bb8710a2b9e0cf2281ac56d5b0609211a83776d0505eecb5" }),
  mono: Object.freeze({ name: "NotoSansMono", file: "NotoSansMono-Regular.ttf", sha256: "65b5e2b2c4a1fba9ae8be1f026cb35b03dcb8886d9b2a4147054fde12f7e767d" }),
  symbols: Object.freeze({ name: "NotoSansSymbols", file: "NotoSansSymbols-Regular.ttf", sha256: "d0e98e9a2c046594c5021437273943be7e79e0fd980fde125279e22302212595" }),
});
const FORBIDDEN_PDF_TOKENS = Object.freeze([
  "/3D", "/AA", "/AcroForm", "/EmbeddedFile", "/Filespec", "/GoToR", "/ImportData", "/JavaScript", "/JS",
  "/Launch", "/Movie", "/OpenAction", "/Rendition", "/RichMedia", "/Sound", "/SubmitForm",
]);
const loadedFontSets = new Map();

export class PdfExportError extends Error {
  constructor(code, message, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "PdfExportError";
    this.code = code;
  }
}

export async function resolveVerifiedPdfAsset(assetStore, exportRoot, attachment) {
  try {
    return await resolveVerifiedLocalAsset(assetStore, exportRoot, attachment, { includeData: (entry) => entry.extension === "png" || entry.extension === "jpg" });
  } catch (error) {
    if (!(error instanceof VerifiedAssetError)) throw error;
    throw new PdfExportError(`PDF_${error.code}`, error.message.replace("document packaging", "PDF rendering"), error);
  }
}

export async function buildDeterministicPdf(options = {}) {
  const header = options.header;
  const messages = options.messages || [];
  if (!header?.origin?.sessionId) throw new TypeError("A session document header is required");
  if (typeof options.resolveAsset !== "function") throw new TypeError("resolveAsset must be a function");
  const fonts = loadFontSet(options.fontRoot || DEFAULT_FONT_ROOT);
  const glyphCache = new Map();
  let doc;
  const chunks = [];
  const completed = new Promise((resolve, reject) => {
    try {
      doc = new PDFDocument({
        autoFirstPage: true,
        bufferPages: true,
        compress: true,
        displayTitle: true,
        info: {
          Producer: "codex-project-chat-exporter",
          Creator: "codex-project-chat-exporter",
          Title: header.title,
          Author: "codex-project-chat-exporter",
          Subject: `Codex session ${header.origin.sessionId}`,
          Keywords: "Codex session export",
          CreationDate: FIXED_PDF_DATE,
          ModDate: FIXED_PDF_DATE,
        },
        margins: PAGE_MARGINS,
        size: "A4",
      });
      doc.once("error", reject);
      if (options.outputStream) {
        options.outputStream.once("error", reject);
        options.outputStream.once("finish", () => resolve(null));
        doc.pipe(options.outputStream);
      } else {
        doc.on("data", (chunk) => chunks.push(chunk));
        doc.once("end", () => resolve(Buffer.concat(chunks)));
      }
    } catch (error) {
      reject(error);
    }
  });

  try {
    registerFonts(doc, fonts);
    renderHeader(doc, header, fonts, glyphCache);
    const imageCache = new Map();
    for (const message of messages) {
      ensureSpace(doc, 42);
      renderPlainText(doc, `${message.label}${timestampSuffix(message.timestamp)}`, {
        font: "bold", fontSize: 14, color: "#255B86", after: 7, sessionId: header.origin.sessionId,
      }, fonts, glyphCache);
      for (const block of message.blocks) renderBlock(doc, block, header.origin.sessionId, fonts, glyphCache);
      for (const attachment of message.attachments) {
        await renderAttachment(doc, attachment, options.resolveAsset, imageCache, header.origin.sessionId, fonts, glyphCache);
      }
      doc.moveDown(0.35);
    }
    addPageNumbers(doc, header.origin.sessionId, fonts, glyphCache);
    doc.end();
    const result = await completed;
    return result === null ? null : validateCanonicalPdf(result);
  } catch (error) {
    if (options.outputStream && !options.outputStream.destroyed) options.outputStream.destroy(error);
    if (doc && !doc.destroyed) doc.destroy(error);
    completed.catch(() => {});
    if (error instanceof PdfExportError) throw error;
    throw new PdfExportError(error?.code || "PDF_RENDER_ERROR", `Failed to render PDF for session ${header.origin.sessionId}`, error);
  }
}

export async function validateCanonicalPdfFile(filePath) {
  const handle = await fsp.open(filePath, "r");
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size < 64n) throw new PdfExportError("PDF_STRUCTURE_INVALID", "The generated PDF is missing or too small");
    const fileSize = Number(before.size);
    if (!Number.isSafeInteger(fileSize)) throw new PdfExportError("PDF_STRUCTURE_INVALID", "The generated PDF is too large to validate safely");
    const header = Buffer.alloc(5);
    const trailer = Buffer.alloc(Math.min(32, fileSize));
    await handle.read(header, 0, header.length, 0);
    await handle.read(trailer, 0, trailer.length, fileSize - trailer.length);
    if (!header.equals(Buffer.from("%PDF-", "ascii")) || !trailer.toString("latin1").includes("%%EOF")) {
      throw new PdfExportError("PDF_STRUCTURE_INVALID", "The generated PDF has an invalid header or trailer");
    }
    const seenActions = new Set();
    let carry = "";
    let totalBytes = 0;
    let fixedTimestamp = false;
    const scan = (text, final = false) => {
      const combined = carry + text;
      const baseOffset = totalBytes - carry.length;
      const processLimit = final ? combined.length : Math.max(0, combined.length - 4096);
      if (combined.includes("D:20000101000000Z")) fixedTimestamp = true;
      for (const token of FORBIDDEN_PDF_TOKENS) {
        if (combined.includes(token)) throw new PdfExportError("PDF_ACTIVE_CONTENT", `The generated PDF contains forbidden structure ${token}`);
      }
      let cursor = 0;
      while (cursor < processLimit) {
        const action = combined.indexOf("/S /URI", cursor);
        if (action < 0 || action >= processLimit) break;
        const absoluteAction = baseOffset + action;
        if (!seenActions.has(absoluteAction)) {
          const uri = combined.indexOf("/URI", action + 7);
          if (uri < 0) throw new PdfExportError("PDF_STRUCTURE_INVALID", "A URI action lacks its target");
          let index = uri + 4;
          while (index < combined.length && isPdfWhitespace(combined.charCodeAt(index))) index += 1;
          if (combined[index] !== "(") throw new PdfExportError("PDF_STRUCTURE_INVALID", "A URI action target is not a PDF literal string");
          const parsed = readPdfLiteralString(combined, index);
          const classified = classifyLinkTarget(parsed.value);
          if (!classified.allowed || classified.target !== parsed.value) throw new PdfExportError("PDF_EXTERNAL_ACTION_UNSAFE", "The generated PDF contains a non-canonical or unsupported URI action");
          seenActions.add(absoluteAction);
        }
        cursor = action + 7;
      }
      totalBytes += text.length;
      carry = final ? "" : combined.slice(-4096);
    };
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < fileSize) {
      const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, fileSize - position), position);
      if (bytesRead <= 0) throw new PdfExportError("PDF_STRUCTURE_INVALID", "The generated PDF ended while it was being validated");
      scan(chunk.toString("latin1", 0, bytesRead));
      position += bytesRead;
    }
    scan("", true);
    if (!fixedTimestamp) throw new PdfExportError("PDF_NOT_REPRODUCIBLE", "The generated PDF does not contain the fixed metadata timestamp");
    const after = await handle.stat({ bigint: true });
    if (!sameFileSnapshot(before, after)) throw new PdfExportError("PDF_STRUCTURE_INVALID", "The generated PDF changed while it was being validated");
    return true;
  } finally {
    await handle.close();
  }
}

export function validateCanonicalPdf(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (bytes.length < 64 || !bytes.subarray(0, 5).equals(Buffer.from("%PDF-", "ascii")) || !bytes.subarray(-16).toString("latin1").includes("%%EOF")) {
    throw new PdfExportError("PDF_STRUCTURE_INVALID", "The generated PDF has an invalid header or trailer");
  }
  const source = bytes.toString("latin1");
  for (const token of FORBIDDEN_PDF_TOKENS) {
    if (source.includes(token)) throw new PdfExportError("PDF_ACTIVE_CONTENT", `The generated PDF contains forbidden structure ${token}`);
  }
  if (!source.includes("D:20000101000000Z")) throw new PdfExportError("PDF_NOT_REPRODUCIBLE", "The generated PDF does not contain the fixed metadata timestamp");
  for (const target of readUriActions(source)) {
    const classified = classifyLinkTarget(target);
    if (!classified.allowed || classified.target !== target) throw new PdfExportError("PDF_EXTERNAL_ACTION_UNSAFE", "The generated PDF contains a non-canonical or unsupported URI action");
  }
  return bytes;
}

function loadFontSet(fontRoot) {
  const root = path.resolve(fontRoot);
  const key = process.platform === "win32" ? root.toLowerCase() : root;
  if (loadedFontSets.has(key)) return loadedFontSets.get(key);
  const loaded = {};
  for (const [style, definition] of Object.entries(FONT_FILES)) {
    const fontPath = path.join(root, definition.file);
    let data;
    try {
      data = fs.readFileSync(fontPath);
    } catch (error) {
      throw new PdfExportError("PDF_FONT_MISSING", `Required bundled PDF font is unavailable: ${definition.file}`, error);
    }
    const sha256 = createHash("sha256").update(data).digest("hex");
    if (sha256 !== definition.sha256) throw new PdfExportError("PDF_FONT_INTEGRITY", `Bundled PDF font failed integrity verification: ${definition.file}`);
    let parsed;
    try {
      parsed = fontkit.create(data);
    } catch (error) {
      throw new PdfExportError("PDF_FONT_INVALID", `Bundled PDF font cannot be parsed: ${definition.file}`, error);
    }
    loaded[style] = Object.freeze({ ...definition, data, parsed });
  }
  const result = Object.freeze(loaded);
  loadedFontSets.set(key, result);
  return result;
}

function registerFonts(doc, fonts) {
  for (const definition of Object.values(fonts)) doc.registerFont(definition.name, definition.data);
}

function renderHeader(doc, header, fonts, glyphCache) {
  renderPlainText(doc, header.title, { font: "bold", fontSize: 20, color: "#255B86", after: 9, sessionId: header.origin.sessionId }, fonts, glyphCache);
  const metadata = [
    ["Project", safePdfProjectDisplayName(header.metadata.project)], ["Storage", header.metadata.storage], ["Session ID", header.metadata.sessionId],
    ["Started", header.metadata.startedAt], ["Updated", header.metadata.updatedAt], ["Model", header.metadata.model],
    ["Raw JSONL", header.metadata.rawReference],
  ].filter(([, value]) => value);
  for (const [label, value] of metadata) {
    renderPlainText(doc, `• ${label}: ${value}`, { font: "regular", fontSize: 9.5, color: "#202020", after: 2, sessionId: header.origin.sessionId }, fonts, glyphCache);
  }
  renderPlainText(doc, "This PDF is a classified, derived reading view. Raw JSONL remains the canonical lossless representation when included.", {
    font: "italic", fontSize: 9, color: "#555555", before: 7, after: 14, sessionId: header.origin.sessionId,
  }, fonts, glyphCache);
}

function renderBlock(doc, block, sessionId, fonts, glyphCache) {
  if (block.kind === DOCUMENT_BLOCK_KIND.HEADING) {
    ensureSpace(doc, 30);
    const size = [13, 12, 11.5, 11, 10.5, 10.5][Math.min(Math.max(block.level - 1, 0), 5)];
    renderInlines(doc, block.inlines, { font: "bold", fontSize: size, color: "#255B86", before: 5, after: 5, sessionId }, fonts, glyphCache);
    return;
  }
  if (block.kind === DOCUMENT_BLOCK_KIND.LIST) {
    block.items.forEach((item, index) => {
      const prefix = block.ordered ? `${index + 1}. ` : "• ";
      renderInlines(doc, [{ kind: "text", text: prefix }, ...item.inlines], {
        font: "regular", fontSize: BODY_SIZE, color: "#202020", indent: 18, hanging: 18, after: 3, sessionId,
      }, fonts, glyphCache);
    });
    doc.moveDown(0.2);
    return;
  }
  if (block.kind === DOCUMENT_BLOCK_KIND.CODE) {
    renderCodeBlock(doc, block.text, sessionId, fonts, glyphCache);
    return;
  }
  renderInlines(doc, block.inlines, { font: "regular", fontSize: BODY_SIZE, color: "#202020", after: 7, sessionId }, fonts, glyphCache);
}

function renderCodeBlock(doc, text, sessionId, fonts, glyphCache) {
  const normalized = normalizeText(text || " ");
  validateAndSegment(normalized, "mono", sessionId, fonts, glyphCache);
  const x = doc.page.margins.left + 8;
  const width = contentWidth(doc) - 16;
  doc.font(fonts.mono.name).fontSize(8.5);
  const estimated = Math.max(18, doc.heightOfString(normalized, { width, lineGap: 2 }) + 10);
  if (estimated <= usablePageHeight(doc)) ensureSpace(doc, Math.min(estimated, usablePageHeight(doc)));
  const top = doc.y;
  const available = doc.page.height - doc.page.margins.bottom - top;
  if (estimated <= available) {
    doc.save().fillColor("#F3F5F7").rect(doc.page.margins.left, top - 4, contentWidth(doc), estimated).fill().restore();
  }
  renderPlainText(doc, normalized, { font: "mono", fontSize: 8.5, color: "#202020", x, width, lineGap: 2, after: 8, sessionId }, fonts, glyphCache);
}

async function renderAttachment(doc, attachment, resolveAsset, imageCache, sessionId, fonts, glyphCache) {
  let asset;
  try {
    asset = await resolveAsset(attachment);
  } catch (error) {
    if (error instanceof PdfExportError) throw error;
    throw new PdfExportError(error?.code || "PDF_ASSET_ERROR", `Failed to resolve a PDF asset for session ${sessionId}`, error);
  }
  const label = `Attachment ${attachment.origin.attachmentOrdinal}`;
  const basename = path.posix.basename(asset.path);
  if (!asset.renderable || (asset.extension !== "png" && asset.extension !== "jpg")) {
    renderPlainText(doc, `${label}: ${basename} (${asset.mediaType}; not embedded; retained as an attachment reference)`, {
      font: "italic", fontSize: 9.5, color: "#555555", before: 4, after: 7, sessionId,
    }, fonts, glyphCache);
    return;
  }
  let image = imageCache.get(asset.sha256);
  if (!image) {
    try {
      image = doc.openImage(asset.data);
    } catch (error) {
      throw new PdfExportError("PDF_ASSET_INVALID", `The image asset for session ${sessionId} cannot be decoded`, error);
    }
    imageCache.set(asset.sha256, image);
  }
  renderPlainText(doc, `${label}: ${basename}`, { font: "bold", fontSize: 9.5, color: "#202020", before: 5, after: 4, sessionId }, fonts, glyphCache);
  const maxWidth = contentWidth(doc);
  const maxHeight = Math.min(360, usablePageHeight(doc) - 28);
  const scale = Math.min(1, maxWidth / image.width, maxHeight / image.height);
  const renderedWidth = image.width * scale;
  const renderedHeight = image.height * scale;
  ensureSpace(doc, renderedHeight + 10);
  const imageTop = doc.y;
  doc.image(image, doc.page.margins.left, imageTop, { width: renderedWidth, height: renderedHeight });
  doc.y = imageTop + renderedHeight + 8;
}

function renderInlines(doc, inlines, options, fonts, glyphCache) {
  const runs = [];
  for (const inline of inlines || []) {
    if (inline.kind === "link") {
      if (inline.blocked) {
        runs.push({ text: `${inline.label} [blocked ${inline.reason}]`, color: "#9C2F2F" });
      } else {
        const classified = classifyLinkTarget(inline.target);
        if (!classified.allowed || classified.target !== inline.target) {
          runs.push({ text: `${inline.label} [blocked invalid-link]`, color: "#9C2F2F" });
        } else {
          runs.push({ text: `${inline.label} (${inline.target})`, color: "#255B86", link: inline.target, underline: true });
        }
      }
    } else {
      runs.push({ text: String(inline.text || "") });
    }
  }
  renderTextRuns(doc, runs, options, fonts, glyphCache);
}

function renderPlainText(doc, text, options, fonts, glyphCache) {
  renderTextRuns(doc, [{ text }], options, fonts, glyphCache);
}

function renderTextRuns(doc, sourceRuns, options, fonts, glyphCache) {
  if (options.before) doc.moveDown(options.before / Math.max(1, options.fontSize || BODY_SIZE));
  const defaultFont = options.font || "regular";
  const runs = [];
  for (const source of sourceRuns) {
    const text = normalizeText(source.text);
    for (const segment of validateAndSegment(text, defaultFont, options.sessionId, fonts, glyphCache)) {
      runs.push({ ...source, ...segment });
    }
  }
  if (!runs.length) runs.push({ text: " ", font: defaultFont });
  const x = options.x ?? (doc.page.margins.left + (options.indent || 0) - (options.hanging || 0));
  const width = options.width ?? (contentWidth(doc) - (options.indent || 0));
  runs.forEach((run, index) => {
    doc.font(fonts[run.font].name).fontSize(options.fontSize || BODY_SIZE).fillColor(run.color || options.color || "#202020");
    const textOptions = {
      continued: index < runs.length - 1,
      lineGap: options.lineGap ?? BODY_LINE_GAP,
      link: run.link,
      underline: run.underline === true,
      width,
    };
    if (index === 0) doc.text(run.text, x, doc.y, textOptions);
    else doc.text(run.text, textOptions);
  });
  doc.fillColor("#202020");
  if (options.after) doc.moveDown(options.after / Math.max(1, options.fontSize || BODY_SIZE));
}

function validateAndSegment(text, primaryStyle, sessionId, fonts, glyphCache) {
  const segments = [];
  let currentFont = "";
  let currentText = "";
  for (const character of Array.from(text)) {
    const codePoint = character.codePointAt(0);
    const font = selectFont(primaryStyle, codePoint, sessionId, fonts, glyphCache);
    if (font !== currentFont && currentText) {
      segments.push({ text: currentText, font: currentFont });
      currentText = "";
    }
    currentFont = font;
    currentText += character;
  }
  if (currentText) segments.push({ text: currentText, font: currentFont });
  return segments;
}

function selectFont(primaryStyle, codePoint, sessionId, fonts, glyphCache) {
  if (codePoint === 0x0a || codePoint === 0x0d) return primaryStyle;
  const key = `${primaryStyle}:${codePoint}`;
  if (glyphCache.has(key)) return glyphCache.get(key);
  let selected = "";
  if (fonts[primaryStyle].parsed.hasGlyphForCodePoint(codePoint)) selected = primaryStyle;
  else if (fonts.symbols.parsed.hasGlyphForCodePoint(codePoint)) selected = "symbols";
  if (!selected) {
    const formatted = codePoint.toString(16).toUpperCase().padStart(4, "0");
    throw new PdfExportError("PDF_GLYPH_MISSING", `PDF export for session ${sessionId} cannot represent Unicode code point U+${formatted}`);
  }
  glyphCache.set(key, selected);
  return selected;
}

function normalizeText(value) {
  return String(value ?? "").replaceAll("\t", "    ");
}

function addPageNumbers(doc, sessionId, fonts, glyphCache) {
  const range = doc.bufferedPageRange();
  for (let offset = 0; offset < range.count; offset += 1) {
    doc.switchToPage(range.start + offset);
    const label = `Page ${offset + 1} of ${range.count}`;
    validateAndSegment(label, "regular", sessionId, fonts, glyphCache);
    const bottomMargin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font(fonts.regular.name).fontSize(FOOTER_SIZE).fillColor("#666666").text(
      label,
      doc.page.margins.left,
      doc.page.height - 38,
      { align: "center", lineBreak: false, width: contentWidth(doc) },
    );
    doc.page.margins.bottom = bottomMargin;
  }
  if (doc.bufferedPageRange().count !== range.count) throw new PdfExportError("PDF_PAGE_NUMBER_LAYOUT", `PDF page numbering changed the page count for session ${sessionId}`);
}

function ensureSpace(doc, height) {
  if (doc.y + height <= doc.page.height - doc.page.margins.bottom) return;
  doc.addPage();
}

function contentWidth(doc) {
  return doc.page.width - doc.page.margins.left - doc.page.margins.right;
}

function usablePageHeight(doc) {
  return doc.page.height - doc.page.margins.top - doc.page.margins.bottom;
}

function timestampSuffix(value) {
  return value ? ` — ${value}` : "";
}

export function safePdfProjectDisplayName(value) {
  const segments = String(value || "").replaceAll("\\", "/").split("/").filter(Boolean);
  const candidate = segments.at(-1) || "";
  return candidate.endsWith(":") ? "" : candidate;
}

function readUriActions(source) {
  const targets = [];
  let cursor = 0;
  while (cursor < source.length) {
    const action = source.indexOf("/S /URI", cursor);
    if (action < 0) break;
    const uri = source.indexOf("/URI", action + 7);
    if (uri < 0) throw new PdfExportError("PDF_STRUCTURE_INVALID", "A URI action lacks its target");
    let index = uri + 4;
    while (index < source.length && isPdfWhitespace(source.charCodeAt(index))) index += 1;
    if (source[index] !== "(") throw new PdfExportError("PDF_STRUCTURE_INVALID", "A URI action target is not a PDF literal string");
    const parsed = readPdfLiteralString(source, index);
    targets.push(parsed.value);
    cursor = parsed.next;
  }
  return targets;
}

function readPdfLiteralString(source, start) {
  let depth = 1;
  let index = start + 1;
  let value = "";
  while (index < source.length && depth > 0) {
    const character = source[index++];
    if (character === "\\") {
      if (index >= source.length) break;
      const escaped = source[index++];
      const mapping = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\" };
      if (Object.hasOwn(mapping, escaped)) value += mapping[escaped];
      else if (escaped >= "0" && escaped <= "7") {
        let octal = escaped;
        while (octal.length < 3 && index < source.length && source[index] >= "0" && source[index] <= "7") octal += source[index++];
        value += String.fromCharCode(Number.parseInt(octal, 8));
      } else if (escaped !== "\n" && escaped !== "\r") value += escaped;
      continue;
    }
    if (character === "(") {
      depth += 1;
      value += character;
    } else if (character === ")") {
      depth -= 1;
      if (depth > 0) value += character;
    } else {
      value += character;
    }
  }
  if (depth !== 0) throw new PdfExportError("PDF_STRUCTURE_INVALID", "A URI action target is unterminated");
  return { value, next: index };
}

function isPdfWhitespace(code) {
  return code === 0x00 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d || code === 0x20;
}

function sameFileSnapshot(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}
