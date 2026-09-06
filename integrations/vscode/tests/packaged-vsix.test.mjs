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
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";

import JSZip from "jszip";
import xmlJs from "xml-js";

import { buildVsix } from "../scripts/build-vsix.mjs";

const require = createRequire(import.meta.url);
const { xml2js } = xmlJs;
const FIXED_DATE = "2000-01-01T00:00:00.000Z";
const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ONE_PIXEL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const ONE_PIXEL_PNG_SHA256 = "431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460";
const PACKAGED_PARENT_PROJECT = process.platform === "win32" ? "C:\\Synthetic\\parent" : "/synthetic/parent";
const PACKAGED_CHILD_PROJECT = process.platform === "win32" ? "C:\\Synthetic\\link-check" : "/synthetic/link-check";
const PACKAGED_MISSING_PROJECT = process.platform === "win32" ? "C:\\Synthetic\\renamed" : "/synthetic/renamed";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function markdownLinkTargets(text) {
  const targets = [];
  let cursor = 0;
  while (cursor < text.length) {
    const marker = text.indexOf("](", cursor);
    if (marker < 0) break;
    const end = text.indexOf(")", marker + 2);
    if (end < 0) break;
    targets.push(text.slice(marker + 2, end).trim());
    cursor = end + 1;
  }
  return targets;
}

function htmlImageSources(text) {
  const sources = [];
  let cursor = 0;
  while (cursor < text.length) {
    const imageStart = text.indexOf("<img", cursor);
    if (imageStart < 0) break;
    const imageEnd = text.indexOf(">", imageStart + 4);
    if (imageEnd < 0) break;
    const sourceStart = text.indexOf('src="', imageStart + 4);
    if (sourceStart >= 0 && sourceStart < imageEnd) {
      const valueStart = sourceStart + 'src="'.length;
      const valueEnd = text.indexOf('"', valueStart);
      if (valueEnd >= 0 && valueEnd < imageEnd) sources.push(text.slice(valueStart, valueEnd));
    }
    cursor = imageEnd + 1;
  }
  return sources;
}

function isAllowedAbsoluteHttpsUrl(target, allowedHostname) {
  const authorityStart = "https://".length;
  if (!target.startsWith("https://") || target.length === authorityStart || "/?#".includes(target[authorityStart])) return false;
  try {
    const url = new URL(target);
    return url.protocol === "https:"
      && url.hostname === allowedHostname
      && url.username === ""
      && url.password === ""
      && url.port === "";
  } catch {
    return false;
  }
}

function assertPackagedReadmeTargets(zip, readme) {
  const targets = [...markdownLinkTargets(readme), ...htmlImageSources(readme)];
  for (const rawTarget of targets) {
    const target = rawTarget.startsWith("<") && rawTarget.endsWith(">") ? rawTarget.slice(1, -1) : rawTarget;
    if (!target || target.startsWith("#")) continue;
    if (target.startsWith("https://") || target.startsWith("http://")) {
      assert.equal(
        isAllowedAbsoluteHttpsUrl(target, "github.com") || isAllowedAbsoluteHttpsUrl(target, "img.shields.io"),
        true,
        `packaged README absolute URL is not allowed: ${target}`,
      );
      continue;
    }

    const filePart = decodeURIComponent(target.split("#", 1)[0]);
    assert.equal(filePart.includes("\\"), false, `packaged README uses a backslash path: ${target}`);
    const segments = filePart.split("/");
    assert.ok(segments.every((segment) => segment && segment !== "." && segment !== ".."), `packaged README leaves its package folder: ${target}`);
    const packagedPath = path.posix.join("extension", ...segments);
    assert.ok(packagedPath.startsWith("extension/"), `packaged README leaves its package folder: ${target}`);
    assert.ok(zip.file(packagedPath), `packaged README target is missing: ${target}`);
  }
}

test("packaged README GitHub URL validation uses an exact HTTPS hostname and fails closed", () => {
  const cases = [
    ["https://github.com/Ann-Diana/codex-project-chat-exporter", true],
    ["https://github.com.evil.example/path", false],
    ["https://example.test/?next=github.com", false],
    ["http://github.com/path", false],
    ["https://[invalid", false],
    ["https:github.com/path", false],
    ["https:///github.com/path", false],
    ["https://github.com@evil.example/path", false],
    ["https://evil.example@github.com/path", false],
  ];
  for (const [target, expected] of cases) {
    assert.equal(isAllowedAbsoluteHttpsUrl(target, "github.com"), expected, target);
  }
});

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

async function copyExtensionFixture(destination) {
  await fs.mkdir(destination, { recursive: true });
  for (const name of ["package.json", "README.md", "PACKAGED_TEST_PLAN.md", "LICENSE"]) {
    await fs.copyFile(path.join(extensionRoot, name), path.join(destination, name));
  }
  await fs.cp(path.join(extensionRoot, "images"), path.join(destination, "images"), { recursive: true });
  await fs.cp(path.join(extensionRoot, "src"), path.join(destination, "src"), { recursive: true });
}

async function writeSyntheticSession(codexHome) {
  const sessionId = "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa";
  const parentId = "bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb";
  const directory = path.join(codexHome, "sessions", "2026", "08", "24");
  const archivedDirectory = path.join(codexHome, "archived_sessions");
  await fs.mkdir(directory, { recursive: true });
  await fs.mkdir(archivedDirectory, { recursive: true });
  const message = "# Linktest\n\nUmlaute äöü & <XML>. Symbole → ← ↑ ↓ ✓ ⚠ ± ≤ ≥. Emoji 😄 und ⚠️. ZWJ 👩‍💻 und 😄‍😄. ANSI \u001b[31m.\n\nLink: [OpenAI](https://openai.com/).\n\n- eins\n- zwei\n\n```js\nconst value = '<&> → ✓ ⚠ ≤ ≥';\n```";
  const imageUrl = `data:image/png;base64,${ONE_PIXEL_PNG.toString("base64")}`;
  const parentPrefix = [
    { ordinal: 0, type: "session_meta", timestamp: "2026-08-24T09:00:00.000Z", payload: { id: parentId, cwd: PACKAGED_PARENT_PROJECT, timestamp: "2026-08-24T09:00:00.000Z", source: "vscode", thread_source: "user", history_mode: "paginated" } },
    { ordinal: 1, type: "response_item", timestamp: "2026-08-24T09:00:01.000Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: message }, { type: "input_image", image_url: imageUrl }], internal_chat_message_metadata_passthrough: { turn_id: "turn-1" } } },
    { ordinal: 2, type: "event_msg", timestamp: "2026-08-24T09:00:01.001Z", payload: { type: "user_message", message, images: [imageUrl] } },
  ];
  const parentPrefixBytes = Buffer.from(`${parentPrefix.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  const parentFile = path.join(archivedDirectory, `rollout-2026-08-24T09-00-00-${parentId}.jsonl`);
  await fs.writeFile(parentFile, Buffer.concat([parentPrefixBytes, Buffer.from(`${JSON.stringify({ ordinal: 3, type: "response_item", timestamp: "2026-08-24T09:00:02.000Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "AFTER_REFERENCE_BOUNDARY" }] } })}\n`, "utf8")]));
  const historyBase = { thread_id: parentId, end_ordinal_exclusive: 3, end_byte_offset: parentPrefixBytes.length };
  const records = [
    { ordinal: 3, type: "session_meta", timestamp: "2026-08-24T10:00:00.000Z", payload: { id: sessionId, cwd: PACKAGED_CHILD_PROJECT, timestamp: "2026-08-24T10:00:00.000Z", source: "vscode", thread_source: "user", forked_from_id: parentId, history_mode: "paginated", history_base: historyBase } },
    { ordinal: 4, type: "response_item", timestamp: "2026-08-24T10:00:02.000Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Antwort. [Query](https://example.invalid/3D?a=1&b=2)." }] } },
  ];
  const childFile = path.join(directory, `rollout-2026-08-24T10-00-00-${sessionId}.jsonl`);
  await fs.writeFile(childFile, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  return { childFile, parentPrefixBytes };
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
    const packagedReadmeBytes = await zip.file("extension/README.md")?.async("nodebuffer");
    assert.ok(packagedReadmeBytes, "packaged README is missing");
    assert.deepEqual(packagedReadmeBytes, await fs.readFile(path.join(extensionRoot, "README.md")));
    const packagedReadme = packagedReadmeBytes.toString("utf8");
    assertPackagedReadmeTargets(zip, packagedReadme);
    for (const requiredTarget of [
      "extension/LICENSE",
      "extension/PACKAGED_TEST_PLAN.md",
      "extension/images/codex-project-chat-exporter-hero.png",
      "extension/images/01-scope-picker.png",
      "extension/images/02-project-history-picker.png",
      "extension/images/03-document-format-picker.png",
      "extension/images/04-export-success.png",
    ]) assert.ok(zip.file(requiredTarget), requiredTarget);
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
    const extensionPackage = JSON.parse(await fs.readFile(path.join("integrations", "vscode", "package.json"), "utf8"));
    assert.equal(extensionPackage.version, "0.1.5");
    const publicImages = new Map([
      ["codex-project-chat-exporter-hero.png", "36a0a0923c97c040d85d16e9584a80b997c8b265d93a5d8cb7a01b08c07dd311"],
      ["01-scope-picker.png", "78ba8cf95d07d48be0eb06a773ac702aac02d3155a760aaf0da664f7646ab5b0"],
      ["02-project-history-picker.png", "437b751ede0c909e6b188b0dfaddaffc066d87ba4b7f1ee3f7e9f64463c31fd5"],
      ["03-document-format-picker.png", "5167954996b948e269b8db5c3236f5297fb81ecfd6128f9c25542862254c91bf"],
      ["04-export-success.png", "f5eb92017ad651cfdbcb50171a0c8e520e901dbb450594b64e5d52c0a13c112b"],
    ]);
    for (const [name, expected] of publicImages) {
      const packaged = await zip.file(`extension/images/${name}`)?.async("nodebuffer");
      assert.ok(packaged, `missing public image: ${name}`);
      assert.equal(sha256(packaged), expected, name);
      assert.deepEqual(packaged, await fs.readFile(path.join("integrations", "vscode", "images", name)), name);
    }
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
    const paginatedFixture = await writeSyntheticSession(codexHome);
    const exporter = await withoutNetwork(() => defaultLoadExporter({ extensionPath: installedRoot }));
    let choices = 0;
    const result = await withoutNetwork(() => exporter.exportArchive({ codexHome, scope: "project", workspacePath: PACKAGED_MISSING_PROJECT, outputDirectory, exportProfile: "complete", documentFormats: ["docx", "pdf"], onSelectRecordedProject: ({ projects, reason }) => {
      choices++;
      assert.equal(reason, "no-match");
      assert.equal(projects.length, 2);
      const childProject = projects.find((project) => project.cwd === PACKAGED_CHILD_PROJECT);
      assert.equal(childProject.sessionCount, 1);
      return childProject.cwd;
    } }));
    assert.equal(choices, 1);
    const manifest = JSON.parse(await fs.readFile(result.manifestPath, "utf8"));
    assert.equal(manifest.sessions.length, 1);
    assert.equal(manifest.archive_format_version, 1);
    assert.equal(manifest.unique_assets, 1);
    assert.equal(manifest.asset_occurrences, 2);
    const assetsManifest = JSON.parse(await fs.readFile(path.join(outputDirectory, manifest.assets_manifest), "utf8"));
    assert.equal(assetsManifest.schema_version, 2);
    assert.equal(assetsManifest.assets.length, 1);
    assert.equal(assetsManifest.assets[0].sha256, ONE_PIXEL_PNG_SHA256);
    assert.deepEqual(await fs.readFile(path.join(outputDirectory, assetsManifest.assets[0].path)), ONE_PIXEL_PNG);
    assert.equal(manifest.history_reference_closure.length, 1);
    const historySegment = manifest.history_reference_closure[0].segments[0];
    assert.equal(historySegment.snapshot_kind, "DERIVED_EXACT_PREFIX");
    assert.deepEqual(await fs.readFile(path.join(outputDirectory, historySegment.snapshot_file)), paginatedFixture.parentPrefixBytes);
    assert.deepEqual(await fs.readFile(path.join(outputDirectory, manifest.sessions[0].raw_export_file)), await fs.readFile(paginatedFixture.childFile));
    const markdown = await fs.readFile(path.join(outputDirectory, manifest.sessions[0].markdown_file), "utf8");
    assert.equal(markdown.includes("AFTER_REFERENCE_BOUNDARY"), false);
    assert.ok(markdown.includes(`assets/${ONE_PIXEL_PNG_SHA256}.png`));
    const indexHtml = await fs.readFile(path.join(outputDirectory, "index.html"), "utf8");
    assert.equal(indexHtml.split("<img ").length - 1, 1);
    assert.ok(indexHtml.includes(`assets/${ONE_PIXEL_PNG_SHA256}.png`));
    const docx = await fs.readFile(path.join(outputDirectory, manifest.sessions[0].docx_file));
    const { documentXml, mediaFiles, relsXml } = await withoutNetwork(async () => {
      const documentZip = await JSZip.loadAsync(docx, { checkCRC32: true, createFolders: false });
      for (const entry of Object.values(documentZip.files)) if (!entry.dir && (entry.name.endsWith(".xml") || entry.name.endsWith(".rels"))) xml2js(await entry.async("string"));
      return {
        documentXml: await documentZip.file("word/document.xml").async("string"),
        mediaFiles: await Promise.all(Object.values(documentZip.files).filter((entry) => !entry.dir && entry.name.startsWith("word/media/")).map((entry) => entry.async("nodebuffer"))),
        relsXml: await documentZip.file("word/_rels/document.xml.rels").async("string"),
      };
    });
    assert.equal(mediaFiles.length, 1);
    assert.deepEqual(mediaFiles[0], ONE_PIXEL_PNG);
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
    assert.equal(elementText(parsedDocument).includes("AFTER_REFERENCE_BOUNDARY"), false);

    const pdf = await fs.readFile(path.join(outputDirectory, manifest.sessions[0].pdf_file));
    const pdfSource = pdf.toString("latin1");
    assert.ok(pdfSource.startsWith("%PDF-") && pdfSource.includes("/S /URI") && pdfSource.includes("/URI (https://openai.com/)"));
    assert.ok(pdfSource.split("/Subtype /Image").length - 1 >= 1, "the packaged offline PDF must embed the synthetic image");
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

test("regular builder fails closed for missing or altered approved public images", async () => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "packaged-vsix-public-images-")));
  try {
    const fixtureRoot = path.join(temp, "extension");
    await copyExtensionFixture(fixtureRoot);
    const scopeImage = path.join(fixtureRoot, "images", "01-scope-picker.png");
    await fs.rm(scopeImage);
    await assert.rejects(
      () => buildVsix({ extensionRoot: fixtureRoot, distDir: path.join(temp, "dist-missing") }),
      (error) => error?.code === "ENOENT" && String(error.path || "").endsWith("01-scope-picker.png"),
    );
    assert.deepEqual(await fs.readdir(path.join(temp, "dist-missing")), []);

    await fs.copyFile(path.join(extensionRoot, "images", "01-scope-picker.png"), scopeImage);
    await fs.appendFile(path.join(fixtureRoot, "images", "codex-project-chat-exporter-hero.png"), Buffer.from([0]));
    await assert.rejects(
      () => buildVsix({ extensionRoot: fixtureRoot, distDir: path.join(temp, "dist-altered") }),
      /Public image differs from its approved SHA-256: codex-project-chat-exporter-hero\.png/,
    );
    assert.deepEqual(await fs.readdir(path.join(temp, "dist-altered")), []);
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
