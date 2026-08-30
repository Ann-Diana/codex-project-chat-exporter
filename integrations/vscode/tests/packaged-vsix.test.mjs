import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import dns from "node:dns";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import tls from "node:tls";
import { inflateSync } from "node:zlib";

import JSZip from "jszip";
import xmlJs from "xml-js";

import { buildVsix } from "../scripts/build-vsix.mjs";

const require = createRequire(import.meta.url);
const { xml2js } = xmlJs;
const FIXED_DATE = "2000-01-01T00:00:00.000Z";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function collectElements(value, name, result = []) {
  if (!value || typeof value !== "object") return result;
  if (value.type === "element" && value.name === name) result.push(value);
  for (const child of value.elements || []) collectElements(child, name, result);
  return result;
}

function elementText(value) {
  if (!value || typeof value !== "object") return "";
  if (value.type === "text") return String(value.text || "");
  return (value.elements || []).map(elementText).join("");
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
    assert.notEqual(end, -1);
    const content = bytes.subarray(start, end);
    try { streams.push(inflateSync(content).toString("latin1")); }
    catch { streams.push(content.toString("latin1")); }
    cursor = end + streamEnd.length;
  }
  return streams;
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

async function extractExtension(zip, installedRoot) {
  for (const entry of Object.values(zip.files).filter((candidate) => !candidate.dir && candidate.name.startsWith("extension/"))) {
    const relative = entry.name.slice("extension/".length);
    const segments = relative.split("/");
    assert.ok(relative && !relative.startsWith("/") && !relative.includes("\\") && segments.every((segment) => segment && segment !== "." && segment !== ".."));
    const destination = path.join(installedRoot, ...segments);
    assert.equal(path.relative(installedRoot, destination).startsWith(".."), false);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, await entry.async("nodebuffer"), { flag: "wx" });
  }
}

async function writeSyntheticSession(codexHome) {
  const sessionId = "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa";
  const directory = path.join(codexHome, "sessions", "2026", "08", "24");
  await fs.mkdir(directory, { recursive: true });
  const message = "# Linktest\n\nUmlaute äöü & <XML>. Symbole → ← ↑ ↓ ✓ ⚠ ± ≤ ≥. Emoji 😄 und ⚠️. ZWJ 👩‍💻 und 😄‍😄. ANSI \u001b[31m.\n\nLink: [OpenAI](https://openai.com/).\n\n- eins\n- zwei\n\n```js\nconst value = '<&> → ✓ ⚠ ≤ ≥';\n```";
  const records = [
    { type: "session_meta", timestamp: "2026-08-24T10:00:00.000Z", payload: { id: sessionId, cwd: "C:\\Synthetic\\link-check", timestamp: "2026-08-24T10:00:00.000Z", source: "vscode", thread_source: "user" } },
    { type: "response_item", timestamp: "2026-08-24T10:00:01.000Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: message }], internal_chat_message_metadata_passthrough: { turn_id: "turn-1" } } },
    { type: "event_msg", timestamp: "2026-08-24T10:00:01.001Z", payload: { type: "user_message", message } },
    { type: "response_item", timestamp: "2026-08-24T10:00:02.000Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Antwort. [Query](https://example.invalid/3D?a=1&b=2)." }] } },
  ];
  const file = path.join(directory, `rollout-2026-08-24T10-00-00-${sessionId}.jsonl`);
  await fs.writeFile(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  return file;
}

test("regular VSIX builds are byte-identical and their packaged runtime exports controlled DOCX/PDF links offline", async () => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "packaged-vsix-e2e-")));
  try {
    const first = await buildVsix({ distDir: path.join(temp, "dist-1") });
    const second = await buildVsix({ distDir: path.join(temp, "dist-2") });
    const firstBytes = await fs.readFile(first.vsixPath);
    const secondBytes = await fs.readFile(second.vsixPath);
    // Avoid allocating a multi-megabyte structural assertion diff on failure.
    assert.ok(firstBytes.equals(secondBytes), `independent builds differ: ${sha256(firstBytes)} / ${sha256(secondBytes)}`);

    const zip = await JSZip.loadAsync(firstBytes, { checkCRC32: true, createFolders: false });
    const files = Object.values(zip.files).filter((entry) => !entry.dir);
    assert.ok(files.every((entry) => entry.date.toISOString() === FIXED_DATE));
    const contentTypes = xml2js(await zip.file("[Content_Types].xml").async("string"), { compact: false, alwaysChildren: true });
    const defaults = new Set(collectElements(contentTypes, "Default").map((element) => String(element.attributes?.Extension || "").toLowerCase()));
    const overrides = new Set(collectElements(contentTypes, "Override").map((element) => String(element.attributes?.PartName || "")));
    for (const file of files) {
      if (file.name === "[Content_Types].xml") continue;
      const extension = path.posix.extname(file.name).slice(1).toLowerCase();
      assert.ok(extension ? defaults.has(extension) : overrides.has(`/${file.name}`), `missing content type: ${file.name}`);
    }
    const rootPackage = JSON.parse(await fs.readFile("package.json", "utf8"));
    const lock = JSON.parse(await fs.readFile("package-lock.json", "utf8"));
    for (const name of (await fs.readdir("lib")).filter((name) => name.endsWith(".mjs"))) {
      assert.ok(zip.file(`extension/vendor/codex-project-chat-exporter/lib/${name}`), name);
    }
    for (const name of (await fs.readdir("fonts")).filter((name) => name.endsWith(".ttf") || name === "OFL.txt" || name === "OFL-SYMBOLS.txt" || name === "OFL-EMOJI.txt")) {
      assert.ok(zip.file(`extension/vendor/codex-project-chat-exporter/fonts/${name}`), name);
    }
    assert.equal(zip.file("extension/vendor/codex-project-chat-exporter/fonts/NotoEmoji-Regular.ttf"), null, "the retired emoji font must not remain packaged");
    assert.equal(zip.file("extension/vendor/codex-project-chat-exporter/fonts/APACHE-NOTO-EMOJI.txt"), null, "the retired Apache license must not remain packaged");
    assert.equal(
      sha256(await zip.file("extension/vendor/codex-project-chat-exporter/fonts/NotoEmoji-Variable.ttf").async("nodebuffer")),
      "de6c18832938afc99caf132b39d6a30a19bac7f2e812e28db2535b4608d27551",
    );
    for (const [lockPath, entry] of Object.entries(lock.packages)) {
      if (!lockPath.startsWith("node_modules/") || entry.dev === true) continue;
      assert.ok(files.some((file) => file.name.startsWith(`extension/vendor/codex-project-chat-exporter/${lockPath}/`)), lockPath);
    }
    assert.deepEqual(lock.packages[""].dependencies, rootPackage.dependencies);
    const vendorPrefix = "extension/vendor/codex-project-chat-exporter/";
    const integrity = JSON.parse(await zip.file(`${vendorPrefix}integrity.json`).async("string"));
    const actualRuntimeFiles = files.map((file) => file.name).filter((name) => name.startsWith(vendorPrefix) && name !== `${vendorPrefix}integrity.json`).map((name) => name.slice(vendorPrefix.length)).sort();
    assert.deepEqual(Object.keys(integrity.files).sort(), actualRuntimeFiles);
    for (const relative of actualRuntimeFiles) assert.equal(sha256(await zip.file(`${vendorPrefix}${relative}`).async("nodebuffer")), integrity.files[relative], relative);
    const licenses = await zip.file(`${vendorPrefix}THIRD_PARTY_LICENSES.txt`).async("string");
    for (const name of Object.keys(rootPackage.dependencies)) assert.ok(licenses.includes(`Package: ${name}@`), name);
    assert.ok(licenses.includes("Noto Sans 2.015") && licenses.includes("Noto Sans Symbols 2 2.008") && licenses.includes("SIL OPEN FONT LICENSE Version 1.1"));
    assert.ok(licenses.includes("Source: fonts/OFL-SYMBOLS.txt") && licenses.includes("Copyright 2022 The Noto Project Authors (https://github.com/notofonts/symbols)"));
    assert.ok(licenses.includes("Noto Emoji 3.002") && licenses.includes("Source: fonts/OFL-EMOJI.txt") && licenses.includes("SIL OPEN FONT LICENSE Version 1.1"));

    const installedRoot = path.join(temp, "installed-extension");
    await extractExtension(zip, installedRoot);
    const { defaultLoadExporter } = require(path.join(installedRoot, "src", "vscode-adapter.cjs"));
    const codexHome = path.join(temp, "synthetic-codex-home");
    const outputDirectory = path.join(temp, "output");
    await writeSyntheticSession(codexHome);
    const exporter = await withoutNetwork(() => defaultLoadExporter({ extensionPath: installedRoot }));
    let choices = 0;
    const result = await withoutNetwork(() => exporter.exportArchive({ codexHome, scope: "project", workspacePath: "C:\\Synthetic\\renamed", outputDirectory, exportProfile: "readable", documentFormats: ["docx", "pdf"], onSelectRecordedProject: ({ projects, reason }) => {
      choices++;
      assert.equal(reason, "no-match");
      assert.equal(projects.length, 1);
      assert.equal(projects[0].sessionCount, 1);
      return projects[0].cwd;
    } }));
    assert.equal(choices, 1);
    const manifest = JSON.parse(await fs.readFile(result.manifestPath, "utf8"));
    assert.equal(manifest.sessions.length, 1);
    const docx = await fs.readFile(path.join(outputDirectory, manifest.sessions[0].docx_file));
    const { documentXml, relsXml } = await withoutNetwork(async () => {
      const documentZip = await JSZip.loadAsync(docx, { checkCRC32: true, createFolders: false });
      for (const entry of Object.values(documentZip.files)) if (!entry.dir && (entry.name.endsWith(".xml") || entry.name.endsWith(".rels"))) xml2js(await entry.async("string"));
      return {
        documentXml: await documentZip.file("word/document.xml").async("string"),
        relsXml: await documentZip.file("word/_rels/document.xml.rels").async("string"),
      };
    });
    const relationship = collectElements(xml2js(relsXml, { compact: false, alwaysChildren: true }), "Relationship").find((element) => element.attributes?.Type.endsWith("/hyperlink"));
    assert.equal(relationship.attributes.TargetMode, "External");
    assert.equal(relationship.attributes.Target, "https://openai.com/");
    assert.ok(collectElements(xml2js(relsXml), "Relationship").some(element => element.attributes?.Target === "https://example.invalid/3D?a=1&b=2"));
    const parsedDocument = xml2js(documentXml, { compact: false, alwaysChildren: true });
    const hyperlink = collectElements(parsedDocument, "w:hyperlink")[0];
    assert.equal(hyperlink.attributes["r:id"], relationship.attributes.Id);
    assert.equal(elementText(hyperlink), "OpenAI (https://openai.com/)");
    const paragraph = collectElements(parsedDocument, "w:p").find((element) => collectElements(element, "w:hyperlink").length === 1);
    const children = paragraph.elements.filter((element) => element.type === "element");
    const index = children.findIndex((element) => element.name === "w:hyperlink");
    assert.ok(elementText(children[index - 1]).endsWith("Link: "));
    assert.equal(elementText(children[index + 1]), ".");
    assert.ok(elementText(parsedDocument).includes("ANSI ."));
    assert.equal(elementText(parsedDocument).includes("invalid XML character U+001B"), false);

    const pdf = await fs.readFile(path.join(outputDirectory, manifest.sessions[0].pdf_file));
    const pdfSource = pdf.toString("latin1");
    assert.ok(pdfSource.startsWith("%PDF-") && pdfSource.includes("/S /URI") && pdfSource.includes("/URI (https://openai.com/)"));
    assert.ok(pdfSource.includes("/URI (https://example.invalid/3D?a=1&b=2)"));
    assert.equal(pdfSource.includes("/Launch") || pdfSource.includes("/JavaScript") || pdfSource.includes("/EmbeddedFile"), false);
    const unicodeMaps = inflatedPdfStreams(pdf).filter((stream) => stream.includes("beginbfchar") || stream.includes("beginbfrange")).join("\n").toUpperCase().replaceAll(" ", "");
    assert.ok(unicodeMaps.includes("D83DDE04"), "the packaged offline PDF must retain U+1F604 in ToUnicode");
    assert.ok(unicodeMaps.includes("26A0FE0F"), "the packaged offline PDF must retain the warning variation sequence");
    assert.ok(unicodeMaps.includes("D83DDC69200DD83DDCBB"), "the packaged offline PDF must retain the supported ZWJ grapheme");
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("regular builder fails before archive creation when a packaged runtime import is missing", async () => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "packaged-vsix-missing-import-")));
  try {
    const repoRoot = path.join(temp, "repo");
    await fs.mkdir(path.join(repoRoot, "bin"), { recursive: true });
    await fs.mkdir(path.join(repoRoot, "lib"));
    await fs.mkdir(path.join(repoRoot, "fonts"));
    await fs.writeFile(path.join(repoRoot, "fonts", "OFL.txt"), "fixture font license\n");
    await fs.writeFile(path.join(repoRoot, "fonts", "OFL-SYMBOLS.txt"), "fixture symbol font license\n");
    await fs.writeFile(path.join(repoRoot, "fonts", "OFL-EMOJI.txt"), "fixture emoji font license\n");
    await fs.writeFile(path.join(repoRoot, "package.json"), `${JSON.stringify({ name: "fixture", version: "1.0.0", type: "module", dependencies: {} }, null, 2)}\n`);
    await fs.writeFile(path.join(repoRoot, "package-lock.json"), `${JSON.stringify({ name: "fixture", version: "1.0.0", lockfileVersion: 3, packages: { "": { name: "fixture", version: "1.0.0", dependencies: {} } } }, null, 2)}\n`);
    await fs.writeFile(path.join(repoRoot, "LICENSE"), "MIT\n");
    await fs.writeFile(path.join(repoRoot, "bin", "export-codex-project-chats.mjs"), 'import "../lib/missing.mjs";\nexport function exportArchive() {}\n');
    let archiveCalls = 0;
    await assert.rejects(() => buildVsix({ repoRoot, distDir: path.join(temp, "dist"), archiveWriter: async () => { archiveCalls += 1; } }), /complete import tree/);
    assert.equal(archiveCalls, 0);
    assert.deepEqual(await fs.readdir(path.join(temp, "dist")), []);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("regular builder fails before archive creation when the locked production tree is incomplete", async () => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "packaged-vsix-missing-dependency-")));
  try {
    const repoRoot = path.join(temp, "repo");
    await fs.mkdir(path.join(repoRoot, "bin"), { recursive: true });
    await fs.mkdir(path.join(repoRoot, "lib"));
    await fs.mkdir(path.join(repoRoot, "fonts"));
    await fs.writeFile(path.join(repoRoot, "fonts", "OFL.txt"), "fixture font license\n");
    await fs.writeFile(path.join(repoRoot, "fonts", "OFL-SYMBOLS.txt"), "fixture symbol font license\n");
    await fs.writeFile(path.join(repoRoot, "fonts", "OFL-EMOJI.txt"), "fixture emoji font license\n");
    const dependencies = { "missing-dependency": "1.0.0" };
    await fs.writeFile(path.join(repoRoot, "package.json"), `${JSON.stringify({ name: "fixture", version: "1.0.0", type: "module", dependencies }, null, 2)}\n`);
    await fs.writeFile(path.join(repoRoot, "package-lock.json"), `${JSON.stringify({ name: "fixture", version: "1.0.0", lockfileVersion: 3, packages: { "": { name: "fixture", version: "1.0.0", dependencies }, "node_modules/missing-dependency": { version: "1.0.0", resolved: "https://registry.npmjs.org/missing-dependency/-/missing-dependency-1.0.0.tgz", integrity: "sha512-fixture" } } }, null, 2)}\n`);
    await fs.writeFile(path.join(repoRoot, "LICENSE"), "MIT\n");
    await fs.writeFile(path.join(repoRoot, "bin", "export-codex-project-chats.mjs"), "export function exportArchive() {}\n");
    let archiveCalls = 0;
    await assert.rejects(() => buildVsix({ repoRoot, distDir: path.join(temp, "dist"), archiveWriter: async () => { archiveCalls += 1; } }), (error) => error?.code === "ENOENT");
    assert.equal(archiveCalls, 0);
    assert.deepEqual(await fs.readdir(path.join(temp, "dist")), []);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("regular builder rejects a missing upstream symbol-font license before archive creation", async () => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "packaged-vsix-missing-symbol-license-")));
  try {
    const repoRoot = path.join(temp, "repo");
    await fs.mkdir(path.join(repoRoot, "bin"), { recursive: true });
    await fs.mkdir(path.join(repoRoot, "lib"));
    await fs.mkdir(path.join(repoRoot, "fonts"));
    await fs.writeFile(path.join(repoRoot, "fonts", "OFL.txt"), "fixture font license\n");
    await fs.writeFile(path.join(repoRoot, "package.json"), `${JSON.stringify({ name: "fixture", version: "1.0.0", type: "module", dependencies: {} }, null, 2)}\n`);
    await fs.writeFile(path.join(repoRoot, "package-lock.json"), `${JSON.stringify({ name: "fixture", version: "1.0.0", lockfileVersion: 3, packages: { "": { name: "fixture", version: "1.0.0", dependencies: {} } } }, null, 2)}\n`);
    await fs.writeFile(path.join(repoRoot, "LICENSE"), "MIT\n");
    await fs.writeFile(path.join(repoRoot, "bin", "export-codex-project-chats.mjs"), "export function exportArchive() {}\n");
    let archiveCalls = 0;
    await assert.rejects(
      () => buildVsix({ repoRoot, distDir: path.join(temp, "dist"), archiveWriter: async () => { archiveCalls += 1; } }),
      (error) => error?.code === "ENOENT" && String(error.path || "").endsWith("OFL-SYMBOLS.txt"),
    );
    assert.equal(archiveCalls, 0);
    assert.deepEqual(await fs.readdir(path.join(temp, "dist")), []);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("regular builder rejects a missing upstream emoji-font license before archive creation", async () => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "packaged-vsix-missing-emoji-license-")));
  try {
    const repoRoot = path.join(temp, "repo");
    await fs.mkdir(path.join(repoRoot, "bin"), { recursive: true });
    await fs.mkdir(path.join(repoRoot, "lib"));
    await fs.mkdir(path.join(repoRoot, "fonts"));
    await fs.writeFile(path.join(repoRoot, "fonts", "OFL.txt"), "fixture font license\n");
    await fs.writeFile(path.join(repoRoot, "fonts", "OFL-SYMBOLS.txt"), "fixture symbol font license\n");
    await fs.writeFile(path.join(repoRoot, "package.json"), `${JSON.stringify({ name: "fixture", version: "1.0.0", type: "module", dependencies: {} }, null, 2)}\n`);
    await fs.writeFile(path.join(repoRoot, "package-lock.json"), `${JSON.stringify({ name: "fixture", version: "1.0.0", lockfileVersion: 3, packages: { "": { name: "fixture", version: "1.0.0", dependencies: {} } } }, null, 2)}\n`);
    await fs.writeFile(path.join(repoRoot, "LICENSE"), "MIT\n");
    await fs.writeFile(path.join(repoRoot, "bin", "export-codex-project-chats.mjs"), "export function exportArchive() {}\n");
    let archiveCalls = 0;
    await assert.rejects(
      () => buildVsix({ repoRoot, distDir: path.join(temp, "dist"), archiveWriter: async () => { archiveCalls += 1; } }),
      (error) => error?.code === "ENOENT" && String(error.path || "").endsWith("OFL-EMOJI.txt"),
    );
    assert.equal(archiveCalls, 0);
    assert.deepEqual(await fs.readdir(path.join(temp, "dist")), []);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});
