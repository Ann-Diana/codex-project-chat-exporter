import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { EXPORT_PROFILES, parseArgs } from "../bin/export-codex-project-chats.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(repositoryRoot, "bin", "export-codex-project-chats.mjs");
const publicDocuments = [
  "README.md",
  "FAQ.md",
  "integrations/vscode/README.md",
  "docs/recorded-project-selection.md",
];
const scopes = ["Current Workspace", "Project from Codex history…", "All Sessions"];
const formatChoices = ["Standard formats only", "Add DOCX", "Add PDF", "Add DOCX and PDF"];
const approvedBadges = [
  {
    alt: "Latest release",
    image: "https://img.shields.io/github/v/release/Ann-Diana/codex-project-chat-exporter?style=flat-square&label=release",
    target: "https://github.com/Ann-Diana/codex-project-chat-exporter/releases/latest",
  },
  {
    alt: "CLI platforms",
    image: "https://img.shields.io/badge/CLI-Windows%20%7C%20macOS%20%7C%20Linux-555?style=flat-square",
    target: "#choose-how-to-run",
  },
  {
    alt: "License",
    image: "https://img.shields.io/github/license/Ann-Diana/codex-project-chat-exporter?style=flat-square",
    target: "LICENSE",
  },
  {
    alt: "Tests",
    image: "https://img.shields.io/github/actions/workflow/status/Ann-Diana/codex-project-chat-exporter/test.yml?branch=main&style=flat-square&label=tests",
    target: "https://github.com/Ann-Diana/codex-project-chat-exporter/actions/workflows/test.yml",
  },
];
const approvedVsixBadges = [
  {
    alt: "VS Code",
    image: "https://img.shields.io/badge/VS%20Code-1.101%2B-007ACC?style=flat-square",
    target: "#requirements",
  },
  {
    alt: "Manual test",
    image: "https://img.shields.io/badge/manual%20test-Windows-0078D4?style=flat-square",
    target: "#tested-scope-and-limits",
  },
  {
    alt: "License",
    image: "https://img.shields.io/github/license/Ann-Diana/codex-project-chat-exporter?style=flat-square",
    target: "LICENSE",
  },
  {
    alt: "Tests",
    image: "https://img.shields.io/github/actions/workflow/status/Ann-Diana/codex-project-chat-exporter/test.yml?branch=main&style=flat-square&label=tests",
    target: "https://github.com/Ann-Diana/codex-project-chat-exporter/actions/workflows/test.yml",
  },
];
const publicImages = new Map([
  ["docs/assets/codex-project-chat-exporter-hero.png", "36a0a0923c97c040d85d16e9584a80b997c8b265d93a5d8cb7a01b08c07dd311"],
  ["docs/screenshots/export-html-images.png", "0f1aaeab8e30fb642dea7bd147b4a1dddbbeb92623343cbef8af13a63cd21edd"],
  ["docs/screenshots/export-docx-images.png", "d93212878b708acff4e0c3f56add910ad15e8ffd9e6f3fe9b582a0dce56dd96d"],
  ["docs/screenshots/export-pdf-images.png", "333e676763748332faf291683c9a35f6ca17fb48d5518a392eb4c9b33983b7dd"],
  ["docs/screenshots/export-output-overview.png", "31d11787d57d1355ab15b5f9eb0617fe8d0eff4387c69b8c2a67cae45528dfb8"],
  ["integrations/vscode/images/codex-project-chat-exporter-hero.png", "36a0a0923c97c040d85d16e9584a80b997c8b265d93a5d8cb7a01b08c07dd311"],
  ["integrations/vscode/images/01-scope-picker.png", "78ba8cf95d07d48be0eb06a773ac702aac02d3155a760aaf0da664f7646ab5b0"],
  ["integrations/vscode/images/02-project-history-picker.png", "437b751ede0c909e6b188b0dfaddaffc066d87ba4b7f1ee3f7e9f64463c31fd5"],
  ["integrations/vscode/images/03-document-format-picker.png", "5167954996b948e269b8db5c3236f5297fb81ecfd6128f9c25542862254c91bf"],
  ["integrations/vscode/images/04-export-success.png", "f5eb92017ad651cfdbcb50171a0c8e520e901dbb450594b64e5d52c0a13c112b"],
]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function pngDimensions(bytes) {
  assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert.equal(bytes.subarray(12, 16).toString("ascii"), "IHDR");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function normalizeTextLineEndings(value) {
  return value.replaceAll("\r\n", "\n");
}

function includesSemanticText(actual, expected) {
  return normalizeTextLineEndings(actual).includes(normalizeTextLineEndings(expected));
}

function literalOccurrenceCount(value, literal) {
  let count = 0;
  let cursor = 0;
  while ((cursor = value.indexOf(literal, cursor)) >= 0) {
    count += 1;
    cursor += literal.length;
  }
  return count;
}

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: repositoryRoot,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({
      code,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
  });
}

async function createCliFixture() {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "documentation-contract-")));
  const codexHome = path.join(temp, "source");
  const sessions = path.join(codexHome, "sessions");
  await fs.mkdir(sessions, { recursive: true });
  const current = process.platform === "win32" ? "C:\\Synthetic\\Current Project" : "/Synthetic/Current Project";
  const historical = process.platform === "win32" ? "C:\\Synthetic\\Former Project" : "/Synthetic/Former Project";
  for (const [index, cwd] of [current, historical].entries()) {
    const timestamp = `2026-08-0${index + 1}T10:00:00.000Z`;
    const records = [
      { type: "session_meta", timestamp, payload: { id: `docs-${index}`, cwd, timestamp } },
      { type: "response_item", timestamp, payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Synthetic documentation fixture." }] } },
      { type: "response_item", timestamp, payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Synthetic response." }] } },
    ];
    await fs.writeFile(path.join(sessions, `rollout-${index}.jsonl`), `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  }
  return { temp, codexHome, current, historical };
}

function markdownLinkTargets(text) {
  const targets = [];
  let cursor = 0;
  while (cursor < text.length) {
    const marker = text.indexOf("](", cursor);
    if (marker < 0) break;
    let end = marker + 2;
    let escaped = false;
    while (end < text.length) {
      const character = text[end];
      if (!escaped && character === ")") break;
      escaped = !escaped && character === "\\";
      if (character !== "\\") escaped = false;
      end += 1;
    }
    if (end < text.length) targets.push(text.slice(marker + 2, end).trim());
    cursor = end + 1;
  }
  return targets;
}

function markdownImageTargets(text) {
  const targets = [];
  let cursor = 0;
  while (cursor < text.length) {
    const imageStart = text.indexOf("![", cursor);
    if (imageStart < 0) break;
    const marker = text.indexOf("](", imageStart + 2);
    if (marker < 0) break;
    let end = marker + 2;
    while (end < text.length && text[end] !== ")") end += 1;
    if (end < text.length) targets.push(text.slice(marker + 2, end).trim());
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

function markdownSection(markdown, heading) {
  const normalized = normalizeTextLineEndings(markdown);
  const start = normalized.indexOf(`${heading}\n`);
  assert.ok(start >= 0, `missing section: ${heading}`);
  const next = normalized.indexOf("\n## ", start + heading.length);
  return normalized.slice(start, next < 0 ? normalized.length : next);
}

function tableRows(markdown, headingStart) {
  const lines = markdown.slice(markdown.indexOf(headingStart)).split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => line.startsWith("| Profile |"));
  assert.ok(headerIndex >= 0, "profile matrix header is missing");
  const rows = new Map();
  for (const line of lines.slice(headerIndex + 2)) {
    if (!line.startsWith("|")) break;
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    rows.set(cells[0].replaceAll("`", ""), cells);
  }
  return rows;
}

test("CLI help documents exactly the supported parser surface and exit contract", async () => {
  const helpResult = await runCli(["--help"]);
  assert.equal(helpResult.code, 0);
  assert.equal(helpResult.stderr, "");
  const help = helpResult.stdout;
  const expectedOptions = new Set([
    "--project", "--recorded-project", "--all", "--list", "--list-sessions", "--diagnose", "--out",
    "--codex-home", "--sessions-dir", "--archived-dir", "--no-archived", "--session-index", "--include-tools",
    "--profile", "--format", "--report-format", "--no-raw", "--no-redact-markdown", "--readable-paths",
    "--performance-profile", "--allow-output-in-tool-dir", "--help", "--version",
  ]);
  const helpOptions = new Set(help.split(/\r?\n/)
    .map((line) => line.trimStart())
    .filter((line) => line.startsWith("--"))
    .map((line) => line.split(/[ ,<]/, 1)[0]));
  assert.deepEqual(helpOptions, expectedOptions);

  const sampleValues = {
    "--project": "fixture",
    "--recorded-project": process.platform === "win32" ? "C:\\Synthetic" : "/Synthetic",
    "--out": path.resolve(os.tmpdir(), "docs-help-output"),
    "--codex-home": path.resolve(os.tmpdir(), "docs-help-home"),
    "--sessions-dir": path.resolve(os.tmpdir(), "docs-help-sessions"),
    "--archived-dir": path.resolve(os.tmpdir(), "docs-help-archived"),
    "--session-index": path.resolve(os.tmpdir(), "docs-help-index.jsonl"),
    "--profile": "readable",
    "--format": "docx,pdf",
    "--report-format": "json",
    "--performance-profile": path.resolve(os.tmpdir(), "docs-help-performance.json"),
  };
  for (const option of expectedOptions) {
    const value = sampleValues[option];
    assert.doesNotThrow(() => parseArgs(value ? [option, value] : [option]), option);
  }
  for (const text of ["0 = success or information", "1 = operational failure", "2 = usage error", "130 = cleaned-up SIGINT"]) assert.ok(help.includes(text));
  assert.ok(help.includes("The .cmd launcher is interactive. This MJS entry point is the direct headless CLI."));
  assert.ok(help.includes("--project <name-or-path>    Legacy fuzzy name/path search."));
});

test("documented CLI workflows execute against synthetic sessions", async () => {
  const fixture = await createCliFixture();
  try {
    const workflows = [
      { name: "current recorded path", args: ["--recorded-project", fixture.current, "--profile", "readable"] },
      { name: "historical recorded path", args: ["--recorded-project", fixture.historical, "--profile", "complete"] },
      { name: "all readable", args: ["--all", "--profile", "readable"] },
      { name: "all complete", args: ["--all", "--profile", "complete"] },
      { name: "all source snapshots", args: ["--all", "--profile", "source-snapshots"] },
      { name: "DOCX", args: ["--all", "--profile", "readable", "--format", "docx"] },
      { name: "PDF", args: ["--all", "--profile", "readable", "--format", "pdf"] },
      { name: "DOCX and PDF", args: ["--all", "--profile", "readable", "--format", "docx,pdf"] },
    ];
    for (const [index, workflow] of workflows.entries()) {
      const output = path.join(fixture.temp, `output-${index}`);
      const result = await runCli(["--codex-home", fixture.codexHome, ...workflow.args, "--out", output, "--report-format", "json"]);
      assert.equal(result.code, 0, `${workflow.name}: ${result.stderr}`);
      assert.equal(result.stderr, "", workflow.name);
      assert.equal(JSON.parse(result.stdout).kind, "export-result", workflow.name);
    }

    const list = await runCli(["--codex-home", fixture.codexHome, "--list", "--report-format", "json"]);
    assert.equal(list.code, 0, list.stderr);
    assert.equal(JSON.parse(list.stdout).kind, "project-list");
    const error = await runCli(["--unknown-option", "--report-format", "json"]);
    assert.equal(error.code, 2);
    assert.equal(error.stdout, "");
    assert.equal(JSON.parse(error.stderr).code, "CLI_UNKNOWN_OPTION");
  } finally {
    await fs.rm(fixture.temp, { recursive: true, force: true });
  }
});

test("README profile matrix agrees with committed profile goldens", async () => {
  const readme = await fs.readFile(path.join(repositoryRoot, "README.md"), "utf8");
  const rows = tableRows(readme, "## Export profiles");
  assert.deepEqual([...rows.keys()], ["complete", "readable", "source-snapshots"]);
  for (const profile of rows.keys()) {
    const golden = JSON.parse(await fs.readFile(path.join(repositoryRoot, "tests", "fixtures", "reading-output", `${profile}.golden.json`), "utf8"));
    const row = rows.get(profile);
    assert.equal(row[1].startsWith(EXPORT_PROFILES[profile].markdown ? "Yes" : "No"), true, `${profile} Markdown`);
    assert.equal(row[2].length > 0, EXPORT_PROFILES[profile].html, `${profile} HTML`);
    assert.equal(row[3].startsWith(EXPORT_PROFILES[profile].raw ? "Yes" : "No"), true, `${profile} Raw`);
    assert.equal(golden.manifest.formats.markdown, EXPORT_PROFILES[profile].markdown);
    assert.equal(golden.manifest.formats.html, EXPORT_PROFILES[profile].html);
    assert.equal(golden.manifest.formats.raw, EXPORT_PROFILES[profile].raw);
    assert.equal(golden.manifest.replacement_history_in_reading_views, profile !== "readable");
    assert.ok(row[4].includes(profile === "readable" ? "Suppressed" : profile === "complete" ? "Additional stored context" : "Preserved"));
  }
});

test("CHANGELOG published release statement matches its first release heading without Git history", async () => {
  const changelog = normalizeTextLineEndings(await fs.readFile(path.join(repositoryRoot, "CHANGELOG.md"), "utf8"));
  const lines = changelog.split("\n");
  const unreleasedIndex = lines.indexOf("## Unreleased");
  assert.ok(unreleasedIndex >= 0, "Unreleased heading is missing");

  const releaseHeading = lines.slice(unreleasedIndex + 1).find((line) => line.startsWith("## "));
  assert.ok(releaseHeading, "published release heading is missing");
  const headingText = releaseHeading.slice("## ".length);
  const separator = " – ";
  const separatorIndex = headingText.indexOf(separator);
  assert.ok(separatorIndex > 0, "published release heading must contain a version and date");

  const version = headingText.slice(0, separatorIndex);
  const date = headingText.slice(separatorIndex + separator.length);
  const introduction = lines.slice(0, unreleasedIndex).join("\n");
  assert.ok(
    introduction.includes(`The latest published release is \`v${version}\`, dated ${date}.`),
    "published release statement must match the first release heading",
  );
  assert.equal(
    introduction.includes(`no \`v${version}\` tag exists`),
    false,
    "introduction must not deny the published release tag",
  );
});

test("public documentation keeps scope, format, privacy and version contracts consistent", async () => {
  const documents = Object.fromEntries(await Promise.all(publicDocuments.map(async (relative) => [relative, await fs.readFile(path.join(repositoryRoot, relative), "utf8")])));
  for (const relative of ["README.md", "integrations/vscode/README.md"]) {
    for (const scope of scopes) assert.ok(documents[relative].includes(scope), `${relative}: ${scope}`);
  }
  for (const format of formatChoices) assert.ok(documents["README.md"].includes(format), `README.md: ${format}`);
  const vscodeReadmeLower = documents["integrations/vscode/README.md"].toLowerCase();
  for (const format of ["standard formats only", "docx", "pdf", "both"]) assert.ok(vscodeReadmeLower.includes(format), `integrations/vscode/README.md: ${format}`);

  const allPublicText = Object.values(documents).join("\n");
  for (const forbidden of [
    "PDF is not implemented", "PDF is not selectable", "exportProfile", "includeOriginalJsonl",
    "archive format v2", "archive_format_version: 2", "C:\\Users\\ann-d", "Hoofilou", "pec_intranet",
  ]) assert.equal(allPublicText.includes(forbidden), false, forbidden);
  assert.ok(documents["README.md"].includes("there is no separate JSON document per session"));
  assert.ok(documents["README.md"].includes("Raw JSONL is source-faithful and is not automatically safe to share"));
  assert.ok(vscodeReadmeLower.includes("folder is created only when an export actually starts"));
  assert.ok(documents["integrations/vscode/README.md"].includes("Raw JSONL is source-faithful and is not automatically safe to share"));
  assert.ok(documents["integrations/vscode/README.md"].includes("No telemetry, uploader or application-level remote content fetch"));

  const archiveContract = await fs.readFile(path.join(repositoryRoot, "docs", "archive-format-v1.md"), "utf8");
  for (const required of [
    "session_meta.payload.history_base", "end_ordinal_exclusive", "end_byte_offset",
    "history_reference_closure", "DERIVED_EXACT_PREFIX", "COMPRESSED_ROLLOUT_UNSUPPORTED",
    "COMPRESSED_ROLLOUT_INVALID", "raw/history-prefixes/",
  ]) assert.ok(archiveContract.includes(required), required);

  const changelog = await fs.readFile(path.join(repositoryRoot, "CHANGELOG.md"), "utf8");
  const releasePreparation = changelog.slice(0, changelog.indexOf("## 0.2.0"));
  assert.ok(includesSemanticText(releasePreparation, "## Unreleased\n\n## 0.3.0 – 2026-09-04"));
  assert.ok(releasePreparation.includes("The latest published release is `v0.3.0`, dated 2026-09-04."));

  const rootPackage = JSON.parse(await fs.readFile(path.join(repositoryRoot, "package.json"), "utf8"));
  const lockfile = JSON.parse(await fs.readFile(path.join(repositoryRoot, "package-lock.json"), "utf8"));
  assert.equal(rootPackage.version, "0.3.0");
  assert.equal(lockfile.version, rootPackage.version);
  assert.equal(lockfile.packages[""].version, rootPackage.version);
  const extensionPackage = JSON.parse(await fs.readFile(path.join(repositoryRoot, "integrations", "vscode", "package.json"), "utf8"));
  assert.equal(extensionPackage.version, "0.1.4");
  for (const [relative, expected] of publicImages) {
    assert.equal(sha256(await fs.readFile(path.join(repositoryRoot, relative))), expected, relative);
  }
  assert.deepEqual(
    await fs.readFile(path.join(repositoryRoot, "docs", "assets", "codex-project-chat-exporter-hero.png")),
    await fs.readFile(path.join(repositoryRoot, "integrations", "vscode", "images", "codex-project-chat-exporter-hero.png")),
  );
});

test("root README uses only the four approved dynamic badges", async () => {
  const readme = await fs.readFile(path.join(repositoryRoot, "README.md"), "utf8");
  for (const badge of approvedBadges) {
    const markdown = `[![${badge.alt}](${badge.image})](${badge.target})`;
    assert.equal(literalOccurrenceCount(readme, markdown), 1, badge.alt);
  }

  const externalImageSources = [...markdownImageTargets(readme), ...htmlImageSources(readme)]
    .filter((target) => target.startsWith("https://") || target.startsWith("http://"));
  assert.deepEqual(externalImageSources, approvedBadges.map((badge) => badge.image));
  assert.equal(externalImageSources.length, 4);
});

test("GitHub URL validation uses an exact HTTPS hostname and fails closed", () => {
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

test("VSIX README uses the four approved badges and syntactic HTTPS links", async () => {
  const readme = await fs.readFile(path.join(repositoryRoot, "integrations", "vscode", "README.md"), "utf8");
  for (const badge of approvedVsixBadges) {
    const markdown = `[![${badge.alt}](${badge.image})](${badge.target})`;
    assert.equal(literalOccurrenceCount(readme, markdown), 1, badge.alt);
  }

  const externalImageSources = [...markdownImageTargets(readme), ...htmlImageSources(readme)]
    .filter((target) => target.startsWith("https://") || target.startsWith("http://"));
  assert.deepEqual(externalImageSources, approvedVsixBadges.map((badge) => badge.image));
  assert.equal(externalImageSources.length, 4);

  for (const target of markdownLinkTargets(readme)) {
    if (!target.startsWith("https://") && !target.startsWith("http://")) continue;
    assert.equal(
      isAllowedAbsoluteHttpsUrl(target, "github.com") || isAllowedAbsoluteHttpsUrl(target, "img.shields.io"),
      true,
      `VSIX README absolute URL is not allowed: ${target}`,
    );
  }
});

test("root README keeps the three entry points and their runtime requirements accurate", async () => {
  const readme = await fs.readFile(path.join(repositoryRoot, "README.md"), "utf8");
  const introduction = normalizeTextLineEndings(readme).slice(0, normalizeTextLineEndings(readme).indexOf("## Requirements"));
  const requirements = markdownSection(readme, "## Requirements");
  const launcherSection = markdownSection(readme, "## Windows launcher");
  const vscodeSection = markdownSection(readme, "## Visual Studio Code quick start");
  const cliSection = markdownSection(readme, "## Direct CLI");
  const entryPointSection = markdownSection(readme, "## Choose how to run");
  const rootPackage = JSON.parse(await fs.readFile(path.join(repositoryRoot, "package.json"), "utf8"));
  const extensionPackage = JSON.parse(await fs.readFile(path.join(repositoryRoot, "integrations", "vscode", "package.json"), "utf8"));
  const launcher = await fs.readFile(path.join(repositoryRoot, "export-codex-project-chats.cmd"), "utf8");

  assert.equal(rootPackage.engines.node, ">=22.0.0");
  assert.equal(extensionPackage.engines.vscode, "^1.101.0");
  assert.equal(extensionPackage.capabilities.untrustedWorkspaces.supported, false);
  assert.ok(introduction.split("\n").some((line) => ["Markdown", "HTML", "DOCX", "PDF", "same", "order"].every((term) => line.includes(term))));
  assert.ok(introduction.toLowerCase().split("\n").some((line) => ["images", "inline", "deduplicated", "asset"].every((term) => line.includes(term))));
  for (const entryPoint of ["Windows launcher", "Visual Studio Code extension", "Direct Node.js CLI"]) {
    assert.ok(entryPointSection.includes(entryPoint), entryPoint);
  }
  for (const requirement of [
    "local Codex session data", "VS Code Desktop 1.101+", "packaged VSIX",
    "No separate Node.js installation", "Node.js 22+", "package dependencies",
    "Microsoft Word", "LibreOffice",
  ]) assert.ok(requirements.includes(requirement), requirement);
  assert.equal(requirements.includes("Local output destination"), false);
  assert.equal(requirements.includes("Trusted local environment"), false);

  assert.ok(vscodeSection.includes("trust the local workspace"));
  assert.ok(vscodeSection.includes("does not support untrusted workspaces"));
  assert.ok(launcherSection.includes("npm ci"));
  assert.ok(launcherSection.includes("`node` from `PATH`"));
  assert.ok(launcherSection.includes("Codex Desktop's bundled Node runtime"));
  assert.ok(includesSemanticText(launcherSection, "```powershell\n.\\export-codex-project-chats.cmd\n```"));
  assert.ok(cliSection.includes("node .\\bin\\export-codex-project-chats.mjs --help"));
  assert.ok(launcher.includes("where node >nul 2>nul"));
  assert.ok(launcher.includes("codex-primary-runtime\\dependencies\\node\\bin\\node.exe"));
});

test("root README references the approved local visuals and output targets", async () => {
  const readme = await fs.readFile(path.join(repositoryRoot, "README.md"), "utf8");
  const heroImage = '<img src="docs/assets/codex-project-chat-exporter-hero.png" alt="Illustration of Codex chat windows being exported" width="820">';
  const compositeTarget = "docs/screenshots/export-output-overview.png";
  const compositeAlt = "Synthetic export overview showing an HTML index, an editable Word document and a searchable PDF";
  const compositeImage = `<img src="${compositeTarget}" alt="${compositeAlt}" width="700">`;
  const originalLinks = [
    ["HTML index", "docs/screenshots/export-html-images.png"],
    ["Editable Word", "docs/screenshots/export-docx-images.png"],
    ["Searchable PDF", "docs/screenshots/export-pdf-images.png"],
  ];
  for (const imageElement of [heroImage, compositeImage]) assert.equal(literalOccurrenceCount(readme, imageElement), 1, imageElement);
  assert.equal(literalOccurrenceCount(readme, `href="${compositeTarget}"`), 1, `${compositeTarget}: original link`);
  assert.equal(literalOccurrenceCount(readme, `src="${compositeTarget}"`), 1, `${compositeTarget}: image source`);
  for (const [label, target] of originalLinks) {
    assert.equal(literalOccurrenceCount(readme, `[${label}](${target})`), 1, `${target}: full-size link`);
    assert.equal(literalOccurrenceCount(readme, `](${target})`), 1, `${target}: separate embedding`);
    assert.equal(literalOccurrenceCount(readme, `src="${target}"`), 0, `${target}: HTML embedding`);
  }
  assert.equal(readme.includes('align="center"'), false);

  assert.deepEqual(
    pngDimensions(await fs.readFile(path.join(repositoryRoot, compositeTarget))),
    { width: 1400, height: 1548 },
  );
  assert.deepEqual(
    pngDimensions(await fs.readFile(path.join(repositoryRoot, originalLinks[1][1]))),
    { width: 1300, height: 1255 },
  );
});

test("internal relative documentation links resolve to repository files", async () => {
  for (const relative of [...publicDocuments, "CHANGELOG.md"]) {
    const absolute = path.join(repositoryRoot, relative);
    const markdown = await fs.readFile(absolute, "utf8");
    for (const rawTarget of markdownLinkTargets(markdown)) {
      const target = rawTarget.startsWith("<") && rawTarget.endsWith(">") ? rawTarget.slice(1, -1) : rawTarget;
      if (!target || target.startsWith("#") || target.startsWith("https://") || target.startsWith("http://") || target.startsWith("mailto:")) continue;
      const filePart = decodeURIComponent(target.split("#", 1)[0]);
      const resolved = path.resolve(path.dirname(absolute), filePart.replaceAll("/", path.sep));
      const stat = await fs.stat(resolved).catch(() => null);
      assert.ok(stat, `${relative}: missing ${target}`);
    }
  }
});
