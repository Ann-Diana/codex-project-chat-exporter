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

function isOpeningImageMarker(value) {
  if (value === "<image>") return true;
  const prefix = "<image name=[Image #", suffix = "]>";
  if (!value.startsWith(prefix) || !value.endsWith(suffix)) return false;
  const number = value.slice(prefix.length, -suffix.length);
  return number.length > 0 && number.length < 10 && [...number].every(c => c >= "0" && c <= "9") && Number(number) > 0;
}
