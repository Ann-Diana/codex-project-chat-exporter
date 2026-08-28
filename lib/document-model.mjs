import path from "node:path";

export const DOCUMENT_ROLE = Object.freeze({
  USER: "USER",
  ASSISTANT: "ASSISTANT",
  SUBAGENT: "SUBAGENT",
  RUNTIME_CONTEXT: "RUNTIME_CONTEXT",
  UNCLASSIFIED: "UNCLASSIFIED",
  TOOL: "TOOL",
});

export const DOCUMENT_BLOCK_KIND = Object.freeze({
  PARAGRAPH: "paragraph",
  HEADING: "heading",
  LIST: "list",
  CODE: "code",
});

export const MAX_DOCUMENT_LINK_TARGET_LENGTH = 2048;

const DOCUMENT_ROLES = new Set(Object.values(DOCUMENT_ROLE));

export function createSessionDocumentHeader(meta = {}) {
  const sessionId = requiredText(meta.id || meta.sessionId, "session ID");
  return Object.freeze({
    kind: "session-document",
    origin: Object.freeze({ sessionId }),
    title: String(meta.displayTitle || meta.title || "Codex Project Chat Export"),
    metadata: Object.freeze({
      project: String(meta.cwd || ""),
      storage: String(meta.storage || "active"),
      sessionId,
      startedAt: String(meta.timestamp || ""),
      updatedAt: String(meta.latestTimestamp || meta.updatedAt || meta.timestamp || ""),
      model: String(meta.model || ""),
      rawReference: String(meta.rawReference || ""),
    }),
  });
}

export function createDocumentMessage(options = {}) {
  const sessionId = requiredText(options.sessionId, "session ID");
  const recordOrdinal = positiveInteger(options.recordOrdinal, "record ordinal");
  if (!DOCUMENT_ROLES.has(options.role)) throw new TypeError(`Unsupported document role: ${String(options.role)}`);
  const origin = Object.freeze({ sessionId, recordOrdinal });
  const blocks = parseDocumentBlocks(String(options.text || ""), origin);
  const attachments = Object.freeze((options.attachments || []).map((attachment, index) => createAttachmentReference(attachment, origin, index + 1)));
  return Object.freeze({
    kind: "message",
    origin,
    role: options.role,
    label: String(options.label || options.role),
    timestamp: String(options.timestamp || ""),
    blocks,
    attachments,
  });
}

export function parseDocumentBlocks(text, origin) {
  const lines = String(text).split("\n").map((line) => line.endsWith("\r") ? line.slice(0, -1) : line);
  const blocks = [];
  let paragraph = [];
  let list = null;
  let code = null;

  const pushParagraph = () => {
    if (!paragraph.length) return;
    const value = paragraph.join("\n");
    blocks.push(createTextBlock(DOCUMENT_BLOCK_KIND.PARAGRAPH, value, origin, blocks.length + 1));
    paragraph = [];
  };
  const pushList = () => {
    if (!list) return;
    const blockOrdinal = blocks.length + 1;
    blocks.push(Object.freeze({
      kind: DOCUMENT_BLOCK_KIND.LIST,
      origin: blockOrigin(origin, blockOrdinal),
      ordered: list.ordered,
      start: list.items[0]?.start ?? 1,
      items: Object.freeze(list.items.map((item, index) => Object.freeze({
        origin: inlineOrigin(origin, blockOrdinal, index + 1),
        level: item.level,
        sequence: item.sequence,
        ordered: item.ordered,
        start: item.start,
        inlines: parseInlineContent(item.text, origin, blockOrdinal),
      }))),
    }));
    list = null;
  };
  const pushCode = () => {
    if (!code) return;
    const blockOrdinal = blocks.length + 1;
    blocks.push(Object.freeze({
      kind: DOCUMENT_BLOCK_KIND.CODE,
      origin: blockOrigin(origin, blockOrdinal),
      language: code.language,
      text: code.lines.join("\n"),
    }));
    code = null;
  };

  for (const line of lines) {
    if (code) {
      if (isClosingFence(line, code.marker, code.length)) pushCode();
      else code.lines.push(line);
      continue;
    }

    const fence = readOpeningFence(line);
    if (fence) {
      pushParagraph();
      pushList();
      code = { marker: fence.marker, length: fence.length, language: fence.info, lines: [] };
      continue;
    }

    const heading = readHeading(line);
    if (heading) {
      pushParagraph();
      pushList();
      const blockOrdinal = blocks.length + 1;
      blocks.push(Object.freeze({
        kind: DOCUMENT_BLOCK_KIND.HEADING,
        origin: blockOrigin(origin, blockOrdinal),
        level: heading.level,
        inlines: parseInlineContent(heading.text, origin, blockOrdinal),
      }));
      continue;
    }

    const marker = readListMarker(line);
    if (marker) {
      pushParagraph();
      if (list && marker.indent === list.stack[0].indent && list.ordered !== marker.ordered) pushList();
      if (!list) list = { ordered: marker.ordered, items: [], stack: [], nextSequence: 0 };
      while (list.stack.length && marker.indent < list.stack.at(-1).indent) list.stack.pop();
      if (list.stack.length && marker.indent === list.stack.at(-1).indent && marker.ordered !== list.stack.at(-1).ordered) list.stack.pop();
      if (!list.stack.length || marker.indent > list.stack.at(-1).indent) {
        list.stack.push({ indent: marker.indent, ordered: marker.ordered, start: marker.start, sequence: list.nextSequence++ });
      }
      const group = list.stack.at(-1);
      // OOXML has nine list levels. Deeper source remains literal, never dropped.
      if (list.stack.length > 9) { pushList(); paragraph.push(line); continue; }
      list.items.push({ text: marker.text, level: list.stack.length - 1, ...group });
      continue;
    }

    if (line.trim() === "") {
      pushParagraph();
      pushList();
      continue;
    }
    pushList();
    paragraph.push(line);
  }
  if (code) pushCode();
  pushParagraph();
  pushList();
  return Object.freeze(blocks);
}

function createAttachmentReference(attachment, origin, attachmentOrdinal) {
  return Object.freeze({
    kind: "local-asset",
    origin: Object.freeze({ ...origin, attachmentOrdinal }),
    sha256: String(attachment?.sha256 || ""),
    sourceSha256: String(attachment?.sourceSha256 || ""),
    mediaType: String(attachment?.mediaType || "application/octet-stream").toLowerCase(),
    decodedBytes: Number.isSafeInteger(attachment?.decodedBytes) ? attachment.decodedBytes : null,
  });
}

function createTextBlock(kind, text, origin, blockOrdinal) {
  return Object.freeze({
    kind,
    origin: blockOrigin(origin, blockOrdinal),
    inlines: parseInlineContent(text, origin, blockOrdinal),
  });
}

function parseInlineContent(text, origin, blockOrdinal) {
  const inlines = [];
  let cursor = 0;
  while (cursor < text.length) {
    const open = text.indexOf("[", cursor);
    if (open < 0) {
      pushTextInline(inlines, text.slice(cursor), origin, blockOrdinal);
      break;
    }
    const closeLabel = text.indexOf("](", open + 1);
    const closeTarget = closeLabel < 0 ? -1 : text.indexOf(")", closeLabel + 2);
    if (closeLabel < 0 || closeTarget < 0) {
      pushTextInline(inlines, text.slice(cursor), origin, blockOrdinal);
      break;
    }
    pushTextInline(inlines, text.slice(cursor, open), origin, blockOrdinal);
    const label = text.slice(open + 1, closeLabel);
    const target = text.slice(closeLabel + 2, closeTarget).trim();
    if (!label || !target) {
      pushTextInline(inlines, text.slice(open, closeTarget + 1), origin, blockOrdinal);
    } else {
      const safety = classifyLinkTarget(target);
      inlines.push(Object.freeze({
        kind: "link",
        origin: inlineOrigin(origin, blockOrdinal, inlines.length + 1),
        label,
        target: safety.allowed ? safety.target : "",
        blocked: !safety.allowed,
        reason: safety.reason,
      }));
    }
    cursor = closeTarget + 1;
  }
  if (!inlines.length) pushTextInline(inlines, "", origin, blockOrdinal);
  return Object.freeze(inlines);
}

function pushTextInline(inlines, text, origin, blockOrdinal) {
  if (!text) return;
  inlines.push(Object.freeze({
    kind: "text",
    origin: inlineOrigin(origin, blockOrdinal, inlines.length + 1),
    text,
  }));
}

export function classifyLinkTarget(target) {
  const value = String(target || "");
  const lower = value.toLowerCase();
  if (value.startsWith("\\\\") || value.startsWith("//")) return { allowed: false, reason: "network-path", target: "" };
  if (lower.startsWith("file:") || path.win32.isAbsolute(value) || path.posix.isAbsolute(value)) return { allowed: false, reason: "file-link", target: "" };
  if (!value || value.length > MAX_DOCUMENT_LINK_TARGET_LENGTH) return { allowed: false, reason: value ? "link-too-long" : "invalid-link", target: "" };
  if ([...value].some((character) => {
    const code = character.codePointAt(0);
    return code <= 0x1f || code === 0x7f;
  })) return { allowed: false, reason: "invalid-link", target: "" };
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return { allowed: false, reason: "invalid-link", target: "" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { allowed: false, reason: "unsupported-protocol", target: "" };
  if (!parsed.hostname || parsed.href.length > MAX_DOCUMENT_LINK_TARGET_LENGTH) return { allowed: false, reason: "invalid-link", target: "" };
  return { allowed: true, reason: "", target: parsed.href };
}

export function blockedLinkLabel(reason) {
  return reason === "file-link" || reason === "network-path" ? "[local file not included]" : `[blocked ${reason}]`;
}

function readOpeningFence(line) {
  const marker = line[0];
  if (marker !== "`" && marker !== "~") return null;
  let length = 0;
  while (line[length] === marker) length += 1;
  if (length < 3) return null;
  return { marker, length, info: line.slice(length).trim() };
}

function isClosingFence(line, marker, minimumLength) {
  let length = 0;
  while (line[length] === marker) length += 1;
  return length >= minimumLength && line.slice(length).trim() === "";
}

function readHeading(line) {
  let level = 0;
  while (line[level] === "#" && level < 6) level += 1;
  if (level === 0 || line[level] !== " ") return null;
  return { level, text: line.slice(level + 1) };
}

function readListMarker(line) {
  let indent = 0;
  while (line[indent] === " ") indent += 1;
  line = line.slice(indent);
  if ((line[0] === "-" || line[0] === "*" || line[0] === "+") && line[1] === " ") {
    return { ordered: false, text: line.slice(2), indent, start: 1 };
  }
  let index = 0;
  while (index < line.length && line.charCodeAt(index) >= 0x30 && line.charCodeAt(index) <= 0x39) index += 1;
  if (index === 0 || line[index] !== "." || line[index + 1] !== " ") return null;
  const start = Number(line.slice(0, index));
  if (!Number.isSafeInteger(start) || start > 2147483647) return null;
  return { ordered: true, text: line.slice(index + 2), indent, start };
}

function blockOrigin(origin, blockOrdinal) {
  return Object.freeze({ ...origin, blockOrdinal });
}

function inlineOrigin(origin, blockOrdinal, inlineOrdinal) {
  return Object.freeze({ ...origin, blockOrdinal, inlineOrdinal });
}

function requiredText(value, label) {
  const text = String(value || "");
  if (!text) throw new TypeError(`Document ${label} is required`);
  return text;
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new TypeError(`Document ${label} must be a positive integer`);
  return number;
}
