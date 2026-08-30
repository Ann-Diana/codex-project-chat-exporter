const REPLACEMENT_PREFIX = "[invalid XML character U+";

export function replaceInvalidXml10Characters(value) {
  return transformOoxmlText(value, false);
}

export function normalizeOoxmlText(value) {
  return transformOoxmlText(value, true);
}

function transformOoxmlText(value, removeAnsiSgr) {
  const text = String(value ?? "");
  let output = null;
  let retainedFrom = 0;

  for (let index = 0; index < text.length; index += 1) {
    const ansiSgrWidth = removeAnsiSgr && text.charCodeAt(index) === 0x1b ? recognizedAnsiSgrWidth(text, index) : 0;
    if (ansiSgrWidth) {
      if (!output) output = [];
      output.push(text.slice(retainedFrom, index));
      retainedFrom = index + ansiSgrWidth;
      index += ansiSgrWidth - 1;
      continue;
    }
    const character = xml10CharacterAt(text, index);
    if (character.valid) {
      index += character.width - 1;
      continue;
    }
    if (!output) output = [];
    output.push(text.slice(retainedFrom, index), replacementFor(character.codePoint));
    retainedFrom = index + character.width;
  }

  if (!output) return text;
  output.push(text.slice(retainedFrom));
  return output.join("");
}

export function findFirstInvalidXml10Character(value) {
  const text = String(value ?? "");
  for (let index = 0; index < text.length; index += 1) {
    const character = xml10CharacterAt(text, index);
    if (!character.valid) return Object.freeze({ codePoint: character.codePoint, index, width: character.width });
    index += character.width - 1;
  }
  return null;
}

function xml10CharacterAt(text, index) {
  const first = text.charCodeAt(index);
  if (first >= 0xd800 && first <= 0xdbff) {
    const second = text.charCodeAt(index + 1);
    if (second >= 0xdc00 && second <= 0xdfff) {
      return { codePoint: 0x10000 + ((first - 0xd800) << 10) + second - 0xdc00, valid: true, width: 2 };
    }
    return { codePoint: first, valid: false, width: 1 };
  }
  if (first >= 0xdc00 && first <= 0xdfff) return { codePoint: first, valid: false, width: 1 };
  return { codePoint: first, valid: isXml10CodePoint(first), width: 1 };
}

function isXml10CodePoint(codePoint) {
  return codePoint === 0x9
    || codePoint === 0xa
    || codePoint === 0xd
    || (codePoint >= 0x20 && codePoint <= 0xd7ff)
    || (codePoint >= 0xe000 && codePoint <= 0xfffd);
}

function replacementFor(codePoint) {
  return `${REPLACEMENT_PREFIX}${codePoint.toString(16).toUpperCase().padStart(4, "0")}]`;
}

function recognizedAnsiSgrWidth(text, index) {
  if (text.charCodeAt(index) !== 0x1b || text.charCodeAt(index + 1) !== 0x5b) return 0;
  let cursor = index + 2;
  while (cursor < text.length) {
    const character = text[cursor];
    if ((character >= "0" && character <= "9") || character === ";" || character === ":") cursor += 1;
    else break;
  }
  return text[cursor] === "m" ? cursor - index + 1 : 0;
}
