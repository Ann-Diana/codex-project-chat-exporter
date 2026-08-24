import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

import {
  AlignmentType,
  Document,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  Packer,
  PageOrientation,
  Paragraph,
  ShadingType,
  TextRun,
  convertInchesToTwip,
} from "docx";
import JSZip from "jszip";
import xmlJs from "xml-js";

import { DOCUMENT_BLOCK_KIND } from "./document-model.mjs";

const { xml2js } = xmlJs;
const FIXED_PACKAGE_DATE = new Date("2000-01-01T00:00:00.000Z");
const FIXED_CORE_TIMESTAMP = "2000-01-01T00:00:00.000Z";
const MAX_IMAGE_WIDTH_PX = 600;
const MAX_IMAGE_HEIGHT_PX = 700;
const REQUIRED_PACKAGE_PARTS = Object.freeze(["[Content_Types].xml", "_rels/.rels", "docProps/core.xml", "word/document.xml", "word/_rels/document.xml.rels"]);
const FORBIDDEN_PART_FRAGMENTS = Object.freeze(["activex", "embeddings", "macrosheets", "vbaproject.bin"]);

export class DocxExportError extends Error {
  constructor(code, message, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "DocxExportError";
    this.code = code;
  }
}

export async function buildDeterministicDocx(options = {}) {
  const header = options.header;
  const messages = options.messages || [];
  if (!header?.origin?.sessionId) throw new TypeError("A session document header is required");
  if (typeof options.resolveAsset !== "function") throw new TypeError("resolveAsset must be a function");
  const children = createHeaderParagraphs(header);
  const imageCache = new Map();
  for (const message of messages) {
    children.push(new Paragraph({
      heading: HeadingLevel.HEADING_2,
      children: [new TextRun({ text: `${message.label}${timestampSuffix(message.timestamp)}`, bold: true })],
    }));
    for (const block of message.blocks) children.push(...renderBlock(block));
    for (const attachment of message.attachments) {
      children.push(...await renderAttachment(attachment, options.resolveAsset, imageCache));
    }
  }

  const document = new Document({
    title: header.title,
    subject: `Codex session ${header.origin.sessionId}`,
    creator: "codex-project-chat-exporter",
    lastModifiedBy: "codex-project-chat-exporter",
    revision: 1,
    styles: createStyles(),
    numbering: {
      config: [
        {
          reference: "document-bullets",
          levels: [{ level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540, hanging: 270 } } } }],
        },
        {
          reference: "document-numbers",
          levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540, hanging: 270 } } } }],
        },
      ],
    },
    sections: [{
      properties: {
        page: {
          size: { orientation: PageOrientation.PORTRAIT, width: 12240, height: 15840 },
          margin: {
            top: convertInchesToTwip(1),
            right: convertInchesToTwip(1),
            bottom: convertInchesToTwip(1),
            left: convertInchesToTwip(1),
            header: 708,
            footer: 708,
          },
        },
      },
      children,
    }],
  });

  let packed;
  try {
    packed = await (options.packer || Packer).toBuffer(document);
  } catch (error) {
    throw new DocxExportError(error?.code || "DOCX_PACK_ERROR", "Failed to package the DOCX document", error);
  }
  const mediaReplacements = new Map([...imageCache.values()].map((cached) => [cached.packagePath, cached.data]));
  return normalizeAndValidateDocx(packed, { mediaReplacements });
}

export async function resolveVerifiedAsset(assetStore, exportRoot, attachment) {
  const entry = assetStore?.assetForDescriptor?.(attachment);
  if (!entry) throw new DocxExportError("DOCX_ASSET_MISSING", `The local asset for record ${attachment.origin.recordOrdinal} is missing`);
  const absolute = path.resolve(exportRoot, ...entry.path.split("/"));
  const assetRoot = path.resolve(exportRoot, "assets");
  if (!isPathInside(absolute, assetRoot)) throw new DocxExportError("DOCX_ASSET_PATH_UNSAFE", "The resolved asset path leaves the export asset directory");
  let data;
  try {
    data = await readStableRegularFile(absolute, assetRoot);
  } catch (error) {
    if (error instanceof DocxExportError) throw error;
    throw new DocxExportError("DOCX_ASSET_MISSING", `The local asset cannot be read: ${entry.path}`, error);
  }
  const sha256 = createHash("sha256").update(data).digest("hex");
  if (sha256 !== entry.sha256 || data.length !== entry.bytes) {
    throw new DocxExportError("DOCX_ASSET_MISMATCH", `The local asset changed before DOCX packaging: ${entry.path}`);
  }
  return Object.freeze({
    data,
    extension: entry.extension,
    mediaType: entry.mime_type,
    path: entry.path,
    renderable: entry.renderable,
    sha256: entry.sha256,
  });
}

async function readStableRegularFile(absolute, assetRoot) {
  const canonicalRoot = await fsp.realpath(assetRoot);
  if (pathKey(canonicalRoot) !== pathKey(assetRoot)) throw new DocxExportError("DOCX_ASSET_PATH_UNSAFE", "The asset directory resolves through a symbolic link or junction");
  const before = await fsp.lstat(absolute, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile()) throw new DocxExportError("DOCX_ASSET_PATH_UNSAFE", "The DOCX asset must be a regular file, not a symbolic link");
  const beforeIdentity = reliableIdentity(before);
  if (!beforeIdentity) throw new DocxExportError("DOCX_ASSET_PATH_UNSAFE", "Reliable DOCX asset identity is unavailable");
  const canonicalFile = await fsp.realpath(absolute);
  if (pathKey(canonicalFile) !== pathKey(absolute)) throw new DocxExportError("DOCX_ASSET_PATH_UNSAFE", "The DOCX asset resolves through a symbolic link or junction");
  const handle = await fsp.open(absolute, "r");
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || reliableIdentity(opened) !== beforeIdentity) throw new DocxExportError("DOCX_ASSET_PATH_UNSAFE", "The DOCX asset changed before it was opened");
    const data = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const pathAfter = await fsp.lstat(absolute, { bigint: true });
    if (reliableIdentity(after) !== beforeIdentity || pathAfter.isSymbolicLink() || !pathAfter.isFile() || reliableIdentity(pathAfter) !== beforeIdentity) {
      throw new DocxExportError("DOCX_ASSET_PATH_UNSAFE", "The DOCX asset changed while it was read");
    }
    return data;
  } finally {
    await handle.close();
  }
}

export async function normalizeAndValidateDocx(buffer, options = {}) {
  let input;
  try {
    input = await JSZip.loadAsync(buffer, { checkCRC32: true, createFolders: false });
  } catch (error) {
    throw new DocxExportError("DOCX_PACKAGE_INVALID", "The generated DOCX is not a valid ZIP package", error);
  }
  validatePackagePaths(input);
  const output = new JSZip();
  const mediaReplacements = options.mediaReplacements || new Map();
  const usedReplacements = new Set();
  const entries = Object.values(input.files).filter((entry) => !entry.dir).sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    let data;
    if (mediaReplacements.has(entry.name)) {
      data = mediaReplacements.get(entry.name);
      usedReplacements.add(entry.name);
    } else {
      data = await entry.async("nodebuffer");
    }
    if (entry.name.endsWith(".xml") || entry.name.endsWith(".rels")) {
      let xml = data.toString("utf8");
      validateXmlPart(entry.name, xml);
      if (entry.name === "docProps/core.xml") {
        xml = replaceElementText(xml, "dcterms:created", FIXED_CORE_TIMESTAMP);
        xml = replaceElementText(xml, "dcterms:modified", FIXED_CORE_TIMESTAMP);
      }
      data = Buffer.from(xml, "utf8");
    }
    output.file(entry.name, data, {
      binary: true,
      createFolders: false,
      date: FIXED_PACKAGE_DATE,
      compression: "DEFLATE",
      compressionOptions: { level: 9 },
    });
  }
  for (const name of mediaReplacements.keys()) {
    if (!usedReplacements.has(name)) throw new DocxExportError("DOCX_MEDIA_MAPPING_INVALID", `The generated DOCX did not contain the expected media placeholder: ${name}`);
  }
  const normalized = await output.generateAsync({
    type: "nodebuffer",
    platform: "DOS",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
  const verified = await JSZip.loadAsync(normalized, { checkCRC32: false, createFolders: false });
  validatePackagePaths(verified);
  for (const entry of Object.values(verified.files).filter((candidate) => !candidate.dir && (candidate.name.endsWith(".xml") || candidate.name.endsWith(".rels")))) {
    validateXmlPart(entry.name, await entry.async("string"));
  }
  return normalized;
}

export async function validateCanonicalDocx(buffer) {
  let zip;
  try {
    zip = await JSZip.loadAsync(buffer, { checkCRC32: false, createFolders: false });
  } catch (error) {
    throw new DocxExportError("DOCX_PACKAGE_INVALID", "The published DOCX is not a valid ZIP package", error);
  }
  validatePackagePaths(zip);
  for (const entry of Object.values(zip.files).filter((candidate) => !candidate.dir)) {
    if (entry.date.toISOString() !== FIXED_PACKAGE_DATE.toISOString()) throw new DocxExportError("DOCX_NOT_REPRODUCIBLE", `Variable ZIP timestamp in ${entry.name}`);
    if (!entry.name.endsWith(".xml") && !entry.name.endsWith(".rels")) continue;
    const xml = await entry.async("string");
    validateXmlPart(entry.name, xml);
    if (entry.name === "docProps/core.xml" && (!xml.includes(`<dcterms:created xsi:type="dcterms:W3CDTF">${FIXED_CORE_TIMESTAMP}</dcterms:created>`) || !xml.includes(`<dcterms:modified xsi:type="dcterms:W3CDTF">${FIXED_CORE_TIMESTAMP}</dcterms:modified>`))) {
      throw new DocxExportError("DOCX_NOT_REPRODUCIBLE", "Core-property timestamps are not normalized");
    }
  }
  await validateMediaRelationships(zip);
  return true;
}

function createStyles() {
  return {
    default: {
      document: {
        run: { font: "Calibri", size: 22, color: "202020" },
        paragraph: { spacing: { after: 120, line: 300 } },
      },
    },
    paragraphStyles: [
      { id: "Title", name: "Title", basedOn: "Normal", next: "Normal", quickFormat: true, run: { font: "Calibri", size: 32, bold: true, color: "2E74B5" }, paragraph: { spacing: { before: 360, after: 200 } } },
      { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true, run: { font: "Calibri", size: 32, bold: true, color: "2E74B5" }, paragraph: { spacing: { before: 360, after: 200 }, keepNext: true } },
      { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true, run: { font: "Calibri", size: 26, bold: true, color: "2E74B5" }, paragraph: { spacing: { before: 280, after: 140 }, keepNext: true } },
      { id: "Heading3", name: "Heading 3", basedOn: "Normal", next: "Normal", quickFormat: true, run: { font: "Calibri", size: 24, bold: true, color: "1F4D78" }, paragraph: { spacing: { before: 200, after: 100 }, keepNext: true } },
      { id: "Heading4", name: "Heading 4", basedOn: "Normal", next: "Normal", quickFormat: true, run: { font: "Calibri", size: 22, bold: true, color: "1F4D78" }, paragraph: { spacing: { before: 160, after: 80 }, keepNext: true } },
      { id: "Heading5", name: "Heading 5", basedOn: "Normal", next: "Normal", quickFormat: true, run: { font: "Calibri", size: 22, bold: true, color: "1F4D78" }, paragraph: { spacing: { before: 140, after: 80 }, keepNext: true } },
      { id: "Heading6", name: "Heading 6", basedOn: "Normal", next: "Normal", quickFormat: true, run: { font: "Calibri", size: 22, bold: true, color: "1F4D78" }, paragraph: { spacing: { before: 120, after: 80 }, keepNext: true } },
    ],
  };
}

function createHeaderParagraphs(header) {
  const metadata = header.metadata;
  const rows = [
    ["Project", metadata.project],
    ["Storage", metadata.storage],
    ["Session ID", metadata.sessionId],
    ["Started", metadata.startedAt],
    ["Updated", metadata.updatedAt],
    ["Model", metadata.model],
    ["Raw JSONL", metadata.rawReference],
  ].filter(([, value]) => value);
  return [
    new Paragraph({ text: header.title, heading: HeadingLevel.TITLE }),
    ...rows.map(([label, value]) => new Paragraph({
      numbering: { reference: "document-bullets", level: 0 },
      children: [new TextRun({ text: `${label}: `, bold: true }), new TextRun(String(value))],
      spacing: { after: 80, line: 300 },
    })),
    new Paragraph({
      children: [new TextRun({ text: "This DOCX is a classified, derived reading view. Raw JSONL remains the canonical lossless representation when included.", italics: true, color: "555555" })],
      spacing: { before: 120, after: 160 },
    }),
  ];
}

function renderBlock(block) {
  if (block.kind === DOCUMENT_BLOCK_KIND.HEADING) {
    const levels = [HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6];
    return [new Paragraph({ heading: levels[Math.min(Math.max(block.level - 1, 0), levels.length - 1)], children: renderInlines(block.inlines) })];
  }
  if (block.kind === DOCUMENT_BLOCK_KIND.LIST) {
    return block.items.map((item) => new Paragraph({
      numbering: { reference: block.ordered ? "document-numbers" : "document-bullets", level: 0 },
      children: renderInlines(item.inlines),
      spacing: { after: 80, line: 300 },
    }));
  }
  if (block.kind === DOCUMENT_BLOCK_KIND.CODE) {
    const lines = block.text.split("\n");
    const runs = [];
    lines.forEach((line, index) => {
      if (index > 0) runs.push(new TextRun({ break: 1 }));
      runs.push(new TextRun({ text: line || " ", font: "Consolas", size: 18 }));
    });
    return [new Paragraph({
      children: runs,
      shading: { type: ShadingType.CLEAR, fill: "F3F5F7", color: "auto" },
      indent: { left: 240, right: 240 },
      spacing: { before: 80, after: 120, line: 240 },
    })];
  }
  return [new Paragraph({ children: renderInlines(block.inlines), spacing: { after: 120, line: 300 } })];
}

function renderInlines(inlines) {
  return inlines.map((inline) => {
    if (inline.kind === "link") {
      const text = inline.blocked
        ? `${inline.label} [blocked ${inline.reason}]`
        : `${inline.label} (${inline.target})`;
      return new TextRun({ text, color: inline.blocked ? "9C2F2F" : "2E74B5", underline: inline.blocked ? undefined : {} });
    }
    return new TextRun(String(inline.text || ""));
  });
}

async function renderAttachment(attachment, resolveAsset, imageCache) {
  const asset = await resolveAsset(attachment);
  const label = `Attachment ${attachment.origin.attachmentOrdinal}`;
  if (!asset.renderable || (asset.extension !== "png" && asset.extension !== "jpg")) {
    return [attachmentParagraph(label, asset, "not embedded; retained as an attachment reference")];
  }
  let cached = imageCache.get(asset.sha256);
  if (!cached) {
    const dimensions = imageDimensions(asset.data, asset.extension);
    if (!dimensions) return [attachmentParagraph(label, asset, "not embedded; image dimensions could not be validated")];
    const placeholder = Buffer.from(`codex-project-chat-exporter:${asset.extension}:${asset.sha256}`, "ascii");
    const placeholderHash = createHash("sha1").update(placeholder).digest("hex");
    cached = Object.freeze({
      data: asset.data,
      dimensions: fitImage(dimensions.width, dimensions.height),
      packagePath: `word/media/${placeholderHash}.${asset.extension}`,
      placeholder,
    });
    imageCache.set(asset.sha256, cached);
  }
  return [
    new Paragraph({
      children: [new TextRun({ text: `${label}: ${path.posix.basename(asset.path)}`, bold: true })],
      spacing: { before: 120, after: 80 },
    }),
    new Paragraph({
      children: [new ImageRun({
        type: asset.extension === "jpg" ? "jpg" : "png",
        data: cached.placeholder,
        transformation: cached.dimensions,
        altText: { name: label, title: label, description: `${label} from session record ${attachment.origin.recordOrdinal}` },
      })],
      spacing: { after: 160 },
    }),
  ];
}

function attachmentParagraph(label, asset, reason) {
  return new Paragraph({
    children: [
      new TextRun({ text: `${label}: `, bold: true }),
      new TextRun(`${path.posix.basename(asset.path)} (${asset.mediaType}; ${reason})`),
    ],
    spacing: { before: 100, after: 120 },
  });
}

function imageDimensions(data, extension) {
  if (extension === "png" && data.length >= 24) {
    const width = data.readUInt32BE(16);
    const height = data.readUInt32BE(20);
    return width > 0 && height > 0 ? { width, height } : null;
  }
  if (extension !== "jpg" || data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 4 <= data.length) {
    if (data[offset] !== 0xff) { offset += 1; continue; }
    while (offset < data.length && data[offset] === 0xff) offset += 1;
    const marker = data[offset++];
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > data.length) return null;
    const length = data.readUInt16BE(offset);
    if (length < 2 || offset + length > data.length) return null;
    const isStartOfFrame = (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf);
    if (isStartOfFrame && length >= 7) {
      const height = data.readUInt16BE(offset + 3);
      const width = data.readUInt16BE(offset + 5);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    offset += length;
  }
  return null;
}

function fitImage(width, height) {
  const scale = Math.min(1, MAX_IMAGE_WIDTH_PX / width, MAX_IMAGE_HEIGHT_PX / height);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

function validatePackagePaths(zip) {
  const names = Object.keys(zip.files);
  for (const required of REQUIRED_PACKAGE_PARTS) {
    if (!zip.files[required] || zip.files[required].dir) throw new DocxExportError("DOCX_PACKAGE_INVALID", `The generated DOCX is missing ${required}`);
  }
  for (const name of names) {
    const lower = name.toLowerCase();
    const segments = name.split("/");
    if (!name || name.startsWith("/") || name.includes("\\") || segments.includes("..") || segments.includes("") && !name.endsWith("/")) {
      throw new DocxExportError("DOCX_PACKAGE_PATH_UNSAFE", `Unsafe DOCX package path: ${name}`);
    }
    if (FORBIDDEN_PART_FRAGMENTS.some((fragment) => lower.includes(fragment))) {
      throw new DocxExportError("DOCX_ACTIVE_CONTENT", `Active or embedded DOCX content is forbidden: ${name}`);
    }
  }
}

function validateXmlPart(name, xml) {
  let parsed;
  try {
    parsed = xml2js(xml, { compact: false, alwaysChildren: true });
  } catch (error) {
    throw new DocxExportError("DOCX_XML_INVALID", `Invalid XML in ${name}`, error);
  }
  if (!name.endsWith(".rels")) return;
  walkElements(parsed, (element) => {
    if (element.name !== "Relationship") return;
    const attributes = element.attributes || {};
    const target = String(attributes.Target || "");
    const targetMode = String(attributes.TargetMode || "").toLowerCase();
    const type = String(attributes.Type || "").toLowerCase();
    if (targetMode === "external" || isAbsoluteRelationshipTarget(target) || type.includes("oleobject") || type.includes("externallink")) {
      throw new DocxExportError("DOCX_EXTERNAL_RELATIONSHIP", `External or active relationship is forbidden in ${name}`);
    }
  });
}

function isAbsoluteRelationshipTarget(target) {
  if (target.startsWith("\\\\") || target.startsWith("//") || path.win32.isAbsolute(target) || path.posix.isAbsolute(target)) return true;
  try {
    new URL(target);
    return true;
  } catch {
    return false;
  }
}

async function validateMediaRelationships(zip) {
  const relationshipsXml = await zip.file("word/_rels/document.xml.rels").async("string");
  const parsed = xml2js(relationshipsXml, { compact: false, alwaysChildren: true });
  const targets = [];
  walkElements(parsed, (element) => {
    if (element.name !== "Relationship") return;
    const attributes = element.attributes || {};
    if (String(attributes.Type || "").toLowerCase().endsWith("/image")) targets.push(String(attributes.Target || ""));
  });
  const referenced = new Set();
  for (const target of targets) {
    const normalized = path.posix.normalize(path.posix.join("word", target));
    if (!normalized.startsWith("word/media/") || !zip.file(normalized)) throw new DocxExportError("DOCX_MEDIA_MAPPING_INVALID", `Image relationship leaves or misses the media directory: ${target}`);
    referenced.add(normalized);
  }
  const media = Object.values(zip.files).filter((entry) => !entry.dir && entry.name.startsWith("word/media/")).map((entry) => entry.name);
  if (media.some((name) => !referenced.has(name))) throw new DocxExportError("DOCX_MEDIA_MAPPING_INVALID", "The DOCX contains an unreferenced media part");
}

function walkElements(value, visit) {
  if (!value || typeof value !== "object") return;
  if (value.type === "element") visit(value);
  for (const child of value.elements || []) walkElements(child, visit);
}

function replaceElementText(xml, elementName, value) {
  const openStart = `<${elementName}`;
  const start = xml.indexOf(openStart);
  if (start < 0) throw new DocxExportError("DOCX_CORE_PROPERTIES_INVALID", `Missing ${elementName} in core properties`);
  const openEnd = xml.indexOf(">", start + openStart.length);
  const close = `</${elementName}>`;
  const end = openEnd < 0 ? -1 : xml.indexOf(close, openEnd + 1);
  if (openEnd < 0 || end < 0) throw new DocxExportError("DOCX_CORE_PROPERTIES_INVALID", `Malformed ${elementName} in core properties`);
  return `${xml.slice(0, openEnd + 1)}${value}${xml.slice(end)}`;
}

function timestampSuffix(value) {
  return value ? ` — ${value}` : "";
}

function isPathInside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function reliableIdentity(stat) {
  if (typeof stat?.dev === "bigint" && typeof stat?.ino === "bigint") return stat.dev >= 0n && stat.ino > 0n ? `${stat.dev}:${stat.ino}` : "";
  return Number.isSafeInteger(stat?.dev) && Number.isSafeInteger(stat?.ino) && stat.dev >= 0 && stat.ino > 0 ? `${stat.dev}:${stat.ino}` : "";
}

function pathKey(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
