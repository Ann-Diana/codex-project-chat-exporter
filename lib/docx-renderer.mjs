import { createHash } from "node:crypto";
import path from "node:path";

import {
  AlignmentType,
  Document,
  ExternalHyperlink,
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

import { DOCUMENT_BLOCK_KIND, blockedLinkLabel, classifyLinkTarget } from "./document-model.mjs";
import { findFirstInvalidXml10Character, normalizeOoxmlText } from "./ooxml-text.mjs";
import { VerifiedAssetError, resolveVerifiedLocalAsset } from "./verified-asset.mjs";

const { js2xml, xml2js } = xmlJs;
const FIXED_PACKAGE_DATE = new Date("2000-01-01T00:00:00.000Z");
const FIXED_CORE_TIMESTAMP = "2000-01-01T00:00:00.000Z";
const MAX_IMAGE_WIDTH_PX = 600;
const MAX_IMAGE_HEIGHT_PX = 700;
const REQUIRED_PACKAGE_PARTS = Object.freeze(["[Content_Types].xml", "_rels/.rels", "docProps/core.xml", "word/document.xml", "word/_rels/document.xml.rels"]);
const FORBIDDEN_PART_FRAGMENTS = Object.freeze(["activex", "embeddings", "macrosheets", "vbaproject.bin"]);
const HYPERLINK_RELATIONSHIP_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink";
const DOCUMENT_RELATIONSHIPS_PART = "word/_rels/document.xml.rels";

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
  const numbering = [{ reference: "document-bullets", levels: [{ level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540, hanging: 270 } } } }] }];
  for (const message of messages) {
    children.push(new Paragraph({
      heading: HeadingLevel.HEADING_2,
      children: [new TextRun({ text: ooxmlText(`${message.label}${timestampSuffix(message.timestamp)}`), bold: true })],
    }));
    for (const block of message.blocks) children.push(...renderBlock(block, numbering));
    for (const attachment of message.attachments) {
      children.push(...await renderAttachment(attachment, options.resolveAsset, imageCache));
    }
  }

  const document = new Document({
    title: ooxmlText(header.title),
    subject: ooxmlText(`Codex session ${header.origin.sessionId}`),
    creator: "codex-project-chat-exporter",
    lastModifiedBy: "codex-project-chat-exporter",
    revision: 1,
    styles: createStyles(),
    numbering: { config: numbering },
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
  try {
    return await resolveVerifiedLocalAsset(assetStore, exportRoot, attachment, { includeData: (entry) => entry.extension === "png" || entry.extension === "jpg" });
  } catch (error) {
    if (!(error instanceof VerifiedAssetError)) throw error;
    throw new DocxExportError(`DOCX_${error.code}`, error.message.replace("document packaging", "DOCX packaging"), error);
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
  for (const entry of Object.values(input.files).filter(entry => !entry.dir && (entry.name.endsWith(".xml") || entry.name.endsWith(".rels")))) {
    validateXmlPart(entry.name, await entry.async("string"));
  }
  const canonicalHyperlinkXml = await canonicalizeHyperlinkRelationshipIds(input);
  const output = new JSZip();
  const mediaReplacements = options.mediaReplacements || new Map();
  const usedReplacements = new Set();
  const entries = Object.values(input.files).filter((entry) => !entry.dir).sort((left, right) => compareText(left.name, right.name));
  for (const entry of entries) {
    let data;
    if (canonicalHyperlinkXml.has(entry.name)) {
      data = canonicalHyperlinkXml.get(entry.name);
    } else if (mediaReplacements.has(entry.name)) {
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
  await validateHyperlinkRelationships(verified);
  await validateMediaRelationships(verified);
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
  await validateHyperlinkRelationships(zip);
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
    [metadata.modelLabel || "Model", metadata.model],
    ["Raw JSONL", metadata.rawReference],
  ].filter(([, value]) => value);
  return [
    new Paragraph({ text: ooxmlText(header.title), heading: HeadingLevel.TITLE }),
    ...rows.map(([label, value]) => new Paragraph({
      numbering: { reference: "document-bullets", level: 0 },
      children: [new TextRun({ text: ooxmlText(`${label}: `), bold: true }), new TextRun(ooxmlText(value))],
      spacing: { after: 80, line: 300 },
    })),
    new Paragraph({
      children: [new TextRun({ text: "This DOCX is a classified, derived reading view. Raw JSONL remains the canonical lossless representation when included.", italics: true, color: "555555" })],
      spacing: { before: 120, after: 160 },
    }),
  ];
}

function renderBlock(block, numbering) {
  if (block.kind === DOCUMENT_BLOCK_KIND.HEADING) {
    const levels = [HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6];
    return [new Paragraph({ heading: levels[Math.min(Math.max(block.level - 1, 0), levels.length - 1)], children: renderInlines(block.inlines) })];
  }
  if (block.kind === DOCUMENT_BLOCK_KIND.LIST) {
    const references = new Map();
    return block.items.map((item) => {
      const sequence = item.sequence ?? 0;
      if (!references.has(sequence)) {
        const reference = `document-list-${numbering.length + 1}`;
        references.set(sequence, reference);
        const ordered = item.ordered ?? block.ordered;
        numbering.push({ reference, levels: Array.from({ length: 9 }, (_, level) => ({
          level, start: item.start ?? block.start ?? 1,
          format: ordered ? LevelFormat.DECIMAL : LevelFormat.BULLET,
          text: ordered ? `%${level + 1}.` : "•", alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 540 + level * 360, hanging: 270 } } },
        })) });
      }
      return new Paragraph({
      numbering: { reference: references.get(sequence), level: item.level ?? 0 },
      children: renderInlines(item.inlines),
      spacing: { after: 80, line: 300 },
    }); });
  }
  if (block.kind === DOCUMENT_BLOCK_KIND.CODE) {
    const lines = block.text.split("\n");
    const runs = [];
    lines.forEach((line, index) => {
      if (index > 0) runs.push(new TextRun({ break: 1 }));
      runs.push(new TextRun({ text: ooxmlText(line || " "), font: "Consolas", size: 18 }));
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
      if (inline.blocked) return new TextRun({ text: ooxmlText(`${inline.label} ${blockedLinkLabel(inline.reason)}`), color: "9C2F2F" });
      return new ExternalHyperlink({
        link: inline.target,
        children: [new TextRun({ text: ooxmlText(`${inline.label} (${inline.target})`), color: "2E74B5", underline: {} })],
      });
    }
    return new TextRun(ooxmlText(inline.text));
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
      children: [new TextRun({ text: ooxmlText(`${label}: ${path.posix.basename(asset.path)}`), bold: true })],
      spacing: { before: 120, after: 80 },
    }),
    new Paragraph({
      children: [new ImageRun({
        type: asset.extension === "jpg" ? "jpg" : "png",
        data: cached.placeholder,
        transformation: cached.dimensions,
        altText: {
          name: ooxmlText(label),
          title: ooxmlText(label),
          description: ooxmlText(`${label} from session record ${attachment.origin.recordOrdinal}`),
        },
      })],
      spacing: { after: 160 },
    }),
  ];
}

function attachmentParagraph(label, asset, reason) {
  return new Paragraph({
    children: [
      new TextRun({ text: ooxmlText(`${label}: `), bold: true }),
      new TextRun(ooxmlText(`${path.posix.basename(asset.path)} (${asset.mediaType}; ${reason})`)),
    ],
    spacing: { before: 100, after: 120 },
  });
}

export function imageDimensions(data, extension) {
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
  const validateCharacters = (value) => {
    if (findFirstInvalidXml10Character(value)) throw new DocxExportError("DOCX_XML_INVALID", `Invalid XML 1.0 character in ${name}`);
  };
  validateCharacters(xml);
  let parsed;
  try {
    parsed = xml2js(xml, { compact: false, alwaysChildren: true });
  } catch (error) {
    throw new DocxExportError("DOCX_XML_INVALID", `Invalid XML in ${name}`, error);
  }
  // Numeric entities can decode into characters absent from the raw XML bytes.
  const validateDecoded = (node) => {
    if (node.text !== undefined) validateCharacters(node.text);
    if (node.cdata !== undefined) validateCharacters(node.cdata);
    for (const value of Object.values(node.attributes || {})) validateCharacters(value);
    for (const child of node.elements || []) validateDecoded(child);
  };
  validateDecoded(parsed);
  if (!name.endsWith(".rels")) return;
  walkElements(parsed, (element) => {
    if (element.name !== "Relationship") return;
    const attributes = element.attributes || {};
    const target = String(attributes.Target || "");
    const targetMode = String(attributes.TargetMode || "").toLowerCase();
    const type = String(attributes.Type || "").toLowerCase();
    const isHyperlink = type === HYPERLINK_RELATIONSHIP_TYPE.toLowerCase();
    const safeHyperlink = classifyLinkTarget(target);
    const isAllowedHyperlink = name === DOCUMENT_RELATIONSHIPS_PART
      && isHyperlink
      && targetMode === "external"
      && safeHyperlink.allowed
      && safeHyperlink.target === target;
    if (isAllowedHyperlink) return;
    if (targetMode || isHyperlink || isAbsoluteRelationshipTarget(target) || type.includes("oleobject") || type.includes("externallink")) {
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

async function validateHyperlinkRelationships(zip) {
  const relationshipsXml = await zip.file(DOCUMENT_RELATIONSHIPS_PART).async("string");
  const documentXml = await zip.file("word/document.xml").async("string");
  const relationships = new Map();
  const relationshipDocument = xml2js(relationshipsXml, { compact: false, alwaysChildren: true });
  walkElements(relationshipDocument, (element) => {
    if (element.name !== "Relationship") return;
    const attributes = element.attributes || {};
    const id = String(attributes.Id || "");
    if (!id || relationships.has(id)) throw new DocxExportError("DOCX_HYPERLINK_MAPPING_INVALID", `Duplicate or empty relationship ID: ${id}`);
    relationships.set(id, Object.freeze({
      type: String(attributes.Type || ""),
      target: String(attributes.Target || ""),
      targetMode: String(attributes.TargetMode || ""),
    }));
  });
  const referencedHyperlinks = new Set();
  const parsedDocument = xml2js(documentXml, { compact: false, alwaysChildren: true });
  walkElements(parsedDocument, (element) => {
    if (element.name !== "w:hyperlink") return;
    const id = String(element.attributes?.["r:id"] || "");
    const relationship = relationships.get(id);
    const safety = classifyLinkTarget(relationship?.target || "");
    if (!id || !relationship || relationship.type !== HYPERLINK_RELATIONSHIP_TYPE || relationship.targetMode !== "External" || !safety.allowed || safety.target !== relationship.target) {
      throw new DocxExportError("DOCX_HYPERLINK_MAPPING_INVALID", `Invalid hyperlink relationship mapping: ${id}`);
    }
    referencedHyperlinks.add(id);
  });
  for (const [id, relationship] of relationships) {
    if (relationship.type === HYPERLINK_RELATIONSHIP_TYPE && !referencedHyperlinks.has(id)) {
      throw new DocxExportError("DOCX_HYPERLINK_MAPPING_INVALID", `Unreferenced hyperlink relationship: ${id}`);
    }
  }
}

async function canonicalizeHyperlinkRelationshipIds(zip) {
  const relationshipsXml = await zip.file(DOCUMENT_RELATIONSHIPS_PART).async("string");
  const documentXml = await zip.file("word/document.xml").async("string");
  const relationshipDocument = xml2js(relationshipsXml, { compact: false, alwaysChildren: true });
  const document = xml2js(documentXml, { compact: false, alwaysChildren: true });
  const existingIds = new Set();
  const hyperlinks = [];
  walkElements(relationshipDocument, (element) => {
    if (element.name !== "Relationship") return;
    const attributes = element.attributes || {};
    const id = String(attributes.Id || "");
    if (!id || existingIds.has(id)) throw new DocxExportError("DOCX_HYPERLINK_MAPPING_INVALID", `Duplicate or empty relationship ID: ${id}`);
    existingIds.add(id);
    if (String(attributes.Type || "") === HYPERLINK_RELATIONSHIP_TYPE) hyperlinks.push(element);
  });
  if (!hyperlinks.length) return new Map();
  for (const hyperlink of hyperlinks) existingIds.delete(String(hyperlink.attributes.Id));
  const replacements = new Map();
  let ordinal = 1;
  for (const hyperlink of hyperlinks) {
    let id;
    do {
      id = `rIdHyperlink${String(ordinal++).padStart(4, "0")}`;
    } while (existingIds.has(id));
    replacements.set(String(hyperlink.attributes.Id), id);
    hyperlink.attributes.Id = id;
    existingIds.add(id);
  }
  walkElements(document, (element) => {
    if (element.name !== "w:hyperlink") return;
    const id = String(element.attributes?.["r:id"] || "");
    if (!replacements.has(id)) throw new DocxExportError("DOCX_HYPERLINK_MAPPING_INVALID", `Missing hyperlink relationship: ${id}`);
    element.attributes["r:id"] = replacements.get(id);
  });
  return new Map([
    [DOCUMENT_RELATIONSHIPS_PART, Buffer.from(serializeParsedXml(relationshipDocument), "utf8")],
    ["word/document.xml", Buffer.from(serializeParsedXml(document), "utf8")],
  ]);
}

function serializeParsedXml(document) {
  // xml-js escapes quotes but not &/< in decoded attributes, and desanitizes
  // literal '&amp;' in text. Protect parsed values before that serializer step.
  const prepare = (node) => {
    if (node.attributes) for (const key of Object.keys(node.attributes)) {
      node.attributes[key] = String(node.attributes[key]).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    }
    if (node.type === "text") node.text = String(node.text).replaceAll("&", "&amp;");
    for (const child of node.elements || []) prepare(child);
  };
  prepare(document);
  return js2xml(document, { compact: false, spaces: 0 });
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
  return value ? ` – ${value}` : "";
}

function ooxmlText(value) {
  return normalizeOoxmlText(value);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
