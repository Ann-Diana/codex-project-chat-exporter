import xmlJs from "xml-js";

const { xml2js } = xmlJs;
const MEMORY_CITATION_OPEN = "<oai-mem-citation>";
const MEMORY_CITATION_CLOSE = "</oai-mem-citation>";
const TECHNICAL_COMMANDS = new Set(["node", "npm", "npx", "git", "pwsh", "powershell", "cmd", "bash", "sh", "python", "python3", "curl", "wget", "docker", "code", "set", "export", "echo", "const", "let", "var", "function", "class", "import"]);

// Only standalone marker parts paired with actual image parts are omitted.
// Literal examples, fences, quotes and all forensic input stay untouched.
export function extractReadingText(content, isRenderedImage = () => false) {
  const text = part => typeof part === "string" ? part : part?.text || part?.input_text || part?.output_text || "";
  if (!Array.isArray(content)) return typeof content === "string" ? content : content?.text || "";
  const omitted = new Set();
  let fence = null;
  for (let i = 0; i < content.length; i++) {
    const value = text(content[i]);
    if (!fence && content[i]?.type === "input_text" && isOpeningImageMarker(value)
      && content[i + 1]?.type === "input_image" && isRenderedImage(content[i + 1])) {
      omitted.add(i);
      if (content[i + 2]?.type === "input_text" && text(content[i + 2]) === "</image>") omitted.add(i + 2);
    }
    for (const line of value.split("\n")) {
      // CommonMark permits up to three leading spaces before a fence.
      let indent = 0; while (line[indent] === " " && indent < 4) indent++;
      if (indent > 3) continue;
      const marker = line[indent];
      if (marker !== "`" && marker !== "~") continue;
      let count = 0; while (line[indent + count] === marker) count++;
      if (count < 3) continue;
      if (!fence) fence = { marker, count };
      else if (marker === fence.marker && count >= fence.count && !line.slice(indent + count).trim()) fence = null;
    }
  }
  return content.filter((_, i) => !omitted.has(i)).map(text).filter(Boolean).join("\n\n");
}

export function normalizeReadableMessageText(value, options = {}) {
  const role = String(options.role || "").toUpperCase();
  let text = String(value || "");
  if (role === "ASSISTANT") text = omitInternalMemoryCitations(text);
  if (role !== "USER" && role !== "ASSISTANT") return text;
  if (!needsReadableProseNormalization(text)) return text;
  return normalizeReadableProse(text);
}

export function omitInternalMemoryCitations(value) {
  if (!String(value || "").includes(MEMORY_CITATION_OPEN)) return String(value || "");
  const lines = splitLines(value);
  const output = [];
  let fence = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const marker = markdownFenceMarker(line);
    if (marker) {
      if (!fence) fence = marker;
      else if (marker.character === fence.character && marker.length >= fence.length && marker.trailing.length === 0) fence = null;
      output.push(line);
      continue;
    }
    if (fence || line !== MEMORY_CITATION_OPEN) {
      output.push(line);
      continue;
    }
    let closing = -1;
    let ambiguous = false;
    for (let candidate = index + 1; candidate < lines.length; candidate += 1) {
      if (lines[candidate] === MEMORY_CITATION_OPEN) { ambiguous = true; break; }
      if (lines[candidate] === MEMORY_CITATION_CLOSE) { closing = candidate; break; }
    }
    if (ambiguous || closing < 0 || !isCanonicalMemoryCitation(lines.slice(index, closing + 1).join("\n"))) {
      output.push(line);
      continue;
    }
    index = closing;
  }
  return output.join("\n");
}

function normalizeReadableProse(value) {
  const lines = splitLines(value);
  const output = [];
  let fence = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const marker = markdownFenceMarker(line);
    if (marker) {
      if (!fence) fence = marker;
      else if (marker.character === fence.character && marker.length >= fence.length && marker.trailing.length === 0) fence = null;
      output.push(line);
      continue;
    }
    if (fence) { output.push(line); continue; }

    const tree = readTreeLineGroup(lines, index);
    if (tree) {
      const delimiter = safeBacktickFence(tree.lines);
      output.push(`${delimiter}text`, ...tree.lines, delimiter);
      index = tree.end;
      continue;
    }

    output.push(normalizeNaturalLine(line));
  }
  return output.join("\n");
}

function needsReadableProseNormalization(text) {
  return text.includes("—")
    || text.includes("\t")
    || text.includes("\u00a0")
    || text.includes("\u202f")
    || text.includes("├")
    || text.includes("└")
    || text.includes("│")
    || text.startsWith(" ")
    || text.includes("\n ");
}

function normalizeNaturalLine(value) {
  let line = String(value || "");
  const prefix = readableMarkupPrefix(line);
  const body = line.slice(prefix.length);
  if (isNaturalProse(body)) line = prefix + removeIncidentalLeadingWhitespace(body);
  if (isTechnicalReadableLine(line.slice(prefix.length))) return line;
  return replaceNaturalEmDashes(line, prefix.length);
}

function removeIncidentalLeadingWhitespace(value) {
  let index = 0;
  let spaces = 0;
  let unusual = false;
  while (index < value.length) {
    const character = value[index];
    if (character === " ") { spaces += 1; index += 1; continue; }
    if (character === "\t" || character === "\u00a0" || character === "\u202f") { unusual = true; index += 1; continue; }
    break;
  }
  if (index === 0 || (!unusual && spaces > 3)) return value;
  return value.slice(index);
}

function replaceNaturalEmDashes(line, contentStart) {
  let result = "";
  let cursor = 0;
  let inlineFence = 0;
  while (cursor < line.length) {
    if (line[cursor] === "`") {
      let length = 1;
      while (line[cursor + length] === "`") length += 1;
      inlineFence = inlineFence === length ? 0 : (inlineFence === 0 ? length : inlineFence);
      result += line.slice(cursor, cursor + length);
      cursor += length;
      continue;
    }
    if (line[cursor] !== "—") {
      result += line[cursor++];
      continue;
    }
    const linkSection = markdownLinkSectionAt(line, cursor);
    if (inlineFence || cursor < contentStart || linkSection === "target"
      || (linkSection !== "label" && protectedTechnicalTokenAt(line, cursor))) {
      result += line[cursor++];
      continue;
    }
    result += "–";
    cursor += 1;
  }
  return result;
}

function protectedTechnicalTokenAt(line, index) {
  let start = index;
  let end = index + 1;
  while (start > 0 && !isWhitespace(line[start - 1])) start -= 1;
  while (end < line.length && !isWhitespace(line[end])) end += 1;
  const token = line.slice(start, end);
  for (const marker of ["/", "\\", ":", "=", "{", "}", "[", "]", "<", ">", "\"", "'", "@", "#", "?", "&", "%", "$"]) {
    if (token.includes(marker)) return true;
  }
  const lower = token.toLowerCase();
  if (lower.startsWith("id—") || lower.startsWith("sha—") || lower.startsWith("hash—")) return true;
  let digits = 0;
  let identifierCharacters = 0;
  for (const character of token) if (character >= "0" && character <= "9") digits += 1;
  for (const character of token) if (isAsciiLetter(character) || (character >= "0" && character <= "9") || character === "-" || character === "_" || character === "—") identifierCharacters += 1;
  if (digits >= 6) return true;
  if (identifierCharacters === token.length && token.length >= 24) return true;
  const dot = token.lastIndexOf(".");
  if (dot > 0 && dot < token.length - 1 && token.length - dot <= 11
    && [...token.slice(dot + 1)].every((character) => isAsciiLetter(character) || (character >= "0" && character <= "9"))) return true;
  return false;
}

function markdownLinkSectionAt(line, index) {
  let cursor = 0;
  while (cursor < line.length) {
    const open = line.indexOf("[", cursor);
    if (open < 0) return "";
    const labelEnd = line.indexOf("](", open + 1);
    if (labelEnd < 0) return "";
    const targetEnd = line.indexOf(")", labelEnd + 2);
    if (targetEnd < 0) return "";
    if (index > open && index < labelEnd) return "label";
    if (index >= labelEnd + 2 && index < targetEnd) return "target";
    cursor = targetEnd + 1;
  }
  return "";
}

function isTechnicalReadableLine(value) {
  const line = String(value || "").trimStart();
  if (!line) return false;
  if (["{", "[", "<", "<?", "</", "\\\\", "/"].some((prefix) => line.startsWith(prefix))) return true;
  if (line.length >= 3 && isAsciiLetter(line[0]) && line[1] === ":" && (line[2] === "\\" || line[2] === "/")) return true;
  if (["├", "└", "│"].some((character) => line.includes(character))) return true;
  const firstToken = line.slice(0, firstWhitespaceIndex(line));
  return TECHNICAL_COMMANDS.has(firstToken.toLowerCase());
}

function isNaturalProse(value) {
  const text = String(value || "").trim();
  if (!text || isTechnicalReadableLine(text)) return false;
  let words = 0;
  let inWord = false;
  for (const character of text) {
    const letter = character.toLocaleLowerCase() !== character.toLocaleUpperCase();
    if (letter && !inWord) words += 1;
    inWord = letter;
  }
  return words >= 2;
}

function readableMarkupPrefix(line) {
  let index = 0;
  while (index < 3 && line[index] === " ") index += 1;
  const start = index;
  while (line[index] === "#" && index - start < 6) index += 1;
  if (index > start && line[index] === " ") return line.slice(0, index + 1);
  index = start;
  if (["-", "*", "+", "–", "—", "•"].includes(line[index]) && line[index + 1] === " ") return line.slice(0, index + 2);
  let digits = index;
  while (line[digits] >= "0" && line[digits] <= "9") digits += 1;
  if (digits > index && line[digits] === "." && line[digits + 1] === " ") return line.slice(0, digits + 2);
  return "";
}

function readTreeLineGroup(lines, start) {
  if (!isTreeLine(lines[start])) return null;
  const grouped = [];
  let branches = 0;
  let end = start;
  while (end < lines.length && isTreeLine(lines[end])) {
    grouped.push(lines[end]);
    if (lines[end].includes("├") || lines[end].includes("└")) branches += 1;
    end += 1;
  }
  if (grouped.length < 2 || branches < 1) return null;
  return { lines: grouped, end: end - 1 };
}

function isTreeLine(value) {
  const line = String(value || "");
  return line.includes("├") || line.includes("└") || line.trimStart().startsWith("│");
}

function safeBacktickFence(lines) {
  let maximum = 2;
  for (const line of lines) {
    let run = 0;
    for (const character of line) {
      if (character === "`") { run += 1; maximum = Math.max(maximum, run); }
      else run = 0;
    }
  }
  return "`".repeat(maximum + 1);
}

function isCanonicalMemoryCitation(value) {
  let parsed;
  try {
    parsed = xml2js(value, { compact: false, alwaysChildren: true });
  } catch {
    return false;
  }
  const roots = elementChildren(parsed);
  if (roots.length !== 1 || roots[0].name !== "oai-mem-citation" || Object.keys(roots[0].attributes || {}).length) return false;
  const children = elementChildren(roots[0]);
  if (children.length !== 2 || children[0].name !== "citation_entries" || children[1].name !== "rollout_ids") return false;
  return hasOnlyWhitespaceOutsideElements(parsed)
    && hasOnlyWhitespaceOutsideElements(roots[0])
    && children.every((child) => Object.keys(child.attributes || {}).length === 0
      && (child.elements || []).every((entry) => entry.type === "text"));
}

function elementChildren(node) {
  return (node.elements || []).filter((entry) => entry.type === "element");
}

function hasOnlyWhitespaceOutsideElements(node) {
  return (node.elements || []).every((entry) => entry.type === "element" || (entry.type === "text" && !String(entry.text || "").trim()));
}

function markdownFenceMarker(line) {
  let indent = 0;
  while (line[indent] === " " && indent < 4) indent += 1;
  if (indent > 3) return null;
  const character = line[indent];
  if (character !== "`" && character !== "~") return null;
  let length = 0;
  while (line[indent + length] === character) length += 1;
  if (length < 3) return null;
  return { character, length, trailing: line.slice(indent + length).trim() };
}

function splitLines(value) {
  return String(value || "").split("\n").map((line) => line.endsWith("\r") ? line.slice(0, -1) : line);
}

function isWhitespace(character) {
  return character === " " || character === "\t" || character === "\r" || character === "\n";
}

function isAsciiLetter(character) {
  const lower = character.toLowerCase();
  return lower >= "a" && lower <= "z";
}

function firstWhitespaceIndex(value) {
  for (let index = 0; index < value.length; index += 1) if (isWhitespace(value[index])) return index;
  return value.length;
}

function isOpeningImageMarker(value) {
  if (value === "<image>") return true;
  const prefix = "<image name=[Image #", suffix = "]>";
  if (!value.startsWith(prefix) || !value.endsWith(suffix)) return false;
  const number = value.slice(prefix.length, -suffix.length);
  return number.length > 0 && number.length < 10 && [...number].every(c => c >= "0" && c <= "9") && Number(number) > 0;
}
