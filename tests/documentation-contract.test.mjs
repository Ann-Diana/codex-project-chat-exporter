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
const publicImages = new Map([
  ["docs/assets/codex-project-chat-exporter-hero.png", "36a0a0923c97c040d85d16e9584a80b997c8b265d93a5d8cb7a01b08c07dd311"],
  ["docs/screenshots/export-html-images.png", "0f1aaeab8e30fb642dea7bd147b4a1dddbbeb92623343cbef8af13a63cd21edd"],
  ["docs/screenshots/export-docx-images.png", "d93212878b708acff4e0c3f56add910ad15e8ffd9e6f3fe9b582a0dce56dd96d"],
  ["docs/screenshots/export-pdf-images.png", "333e676763748332faf291683c9a35f6ca17fb48d5518a392eb4c9b33983b7dd"],
  ["integrations/vscode/images/codex-project-chat-exporter-hero.png", "36a0a0923c97c040d85d16e9584a80b997c8b265d93a5d8cb7a01b08c07dd311"],
  ["integrations/vscode/images/01-scope-picker.png", "78ba8cf95d07d48be0eb06a773ac702aac02d3155a760aaf0da664f7646ab5b0"],
  ["integrations/vscode/images/02-project-history-picker.png", "437b751ede0c909e6b188b0dfaddaffc066d87ba4b7f1ee3f7e9f64463c31fd5"],
  ["integrations/vscode/images/03-document-format-picker.png", "5167954996b948e269b8db5c3236f5297fb81ecfd6128f9c25542862254c91bf"],
  ["integrations/vscode/images/04-export-success.png", "f5eb92017ad651cfdbcb50171a0c8e520e901dbb450594b64e5d52c0a13c112b"],
]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalizeTextLineEndings(value) {
  return value.replaceAll("\r\n", "\n");
}

function hasSemanticTextPrefix(actual, expected) {
  return normalizeTextLineEndings(actual).startsWith(normalizeTextLineEndings(expected));
}

function includesSemanticText(actual, expected) {
  return normalizeTextLineEndings(actual).includes(normalizeTextLineEndings(expected));
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

test("semantic documentation prefixes accept CRLF without accepting changed content", () => {
  const expected = "# Heading\n\nStable content.\n";
  const releaseHeading = "## Unreleased\n\n## 0.3.0 – 2026-09-04";
  assert.equal(hasSemanticTextPrefix(expected, expected), true);
  assert.equal(hasSemanticTextPrefix(expected.replaceAll("\n", "\r\n"), expected), true);
  assert.equal(hasSemanticTextPrefix("# Heading\r\n\r\nChanged content.\r\n", expected), false);
  assert.equal(hasSemanticTextPrefix("# Heading\r\nStable content.\r\n", expected), false);
  assert.equal(includesSemanticText(`Before\n${expected}After\n`, expected), true);
  assert.equal(includesSemanticText(`Before\r\n${expected.replaceAll("\n", "\r\n")}After\r\n`, expected), true);
  assert.equal(includesSemanticText("Before\r\n# Heading\r\n\r\nChanged content.\r\nAfter\r\n", expected), false);
  assert.equal(includesSemanticText("Before\r\n# Heading\r\nStable content.\r\nAfter\r\n", expected), false);
  assert.equal(includesSemanticText(releaseHeading.replaceAll("\n", "\r\n"), releaseHeading), true);
  assert.equal(includesSemanticText(releaseHeading, "## Pending\n\n## 0.3.0 – 2026-09-04"), false);
  assert.equal(includesSemanticText(releaseHeading, "## Unreleased\n\n## 0.3.1 – 2026-09-04"), false);
  assert.equal(includesSemanticText(releaseHeading, "## Unreleased\n\n## 0.3.0 – 2026-09-05"), false);
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
  const positioning = [
    "Export local Codex project history into independent, portable archives – including editable Word documents and searchable PDFs.",
    "",
    "> **To our knowledge, the only Codex session exporter with built-in DOCX and PDF output.**",
    ">",
    "> Based on publicly documented exporter features reviewed on 31 August 2026.",
    "",
    "- Export the current workspace, another recorded project or all local sessions.",
    "- Get Markdown, responsive HTML, manifests and optional verified source snapshots.",
    "- Add DOCX, PDF or both from the same readable document model.",
    "- Local and read-only toward original Codex data. No telemetry, import or repair.",
  ].join("\n");
  const readmePositioning = positioning.replace(
    "- Get Markdown, responsive HTML, manifests and optional verified source snapshots.",
    "- Reconstruct paginated fork histories from validated local rollout references.\n- Get Markdown, responsive HTML, manifests and optional verified source snapshots.",
  );
  const whyDocuments = [
    "## Why DOCX and PDF?",
    "",
    "- **Word:** editable documents for review, comments, handoff and further documentation.",
    "- **PDF:** searchable, fixed-layout files for sharing, printing and archiving.",
    "- **One source:** Markdown, HTML, DOCX and PDF follow the same session order and readable content selection.",
  ].join("\n");
  const requirements = [
    "## Requirements at a glance",
    "",
    "- <kbd>VSIX</kbd> <kbd>VS Code Desktop 1.101+</kbd> <kbd>Local Codex data</kbd> <kbd>Trusted local environment</kbd>: no separate Node.js, Word or LibreOffice required.",
    "- <kbd>CLI</kbd> <kbd>Node.js 22+</kbd> <kbd>Package dependencies installed</kbd> <kbd>Local Codex data</kbd> <kbd>Local output destination</kbd>",
  ].join("\n");
  assert.ok(hasSemanticTextPrefix(documents["README.md"], `# Codex Project Chat Exporter\n\n${readmePositioning}\n\n${requirements}\n\n${whyDocuments}\n`));
  assert.ok(hasSemanticTextPrefix(documents["integrations/vscode/README.md"], `# Codex Project Chat Exporter for Visual Studio Code\n\n${positioning}\n\n${requirements}\n`));
  for (const relative of ["README.md", "integrations/vscode/README.md"]) {
    assert.ok(includesSemanticText(documents[relative], requirements), `${relative}: requirements`);
    for (const scope of scopes) assert.ok(documents[relative].includes(scope), `${relative}: ${scope}`);
    for (const format of formatChoices) assert.ok(documents[relative].includes(format), `${relative}: ${format}`);
    assert.equal(documents[relative].includes("—"), false, `${relative}: em dash`);
  }

  const allPublicText = Object.values(documents).join("\n");
  for (const forbidden of [
    "PDF is not implemented", "PDF is not selectable", "exportProfile", "includeOriginalJsonl",
    "archive format v2", "archive_format_version: 2", "C:\\Users\\ann-d", "Hoofilou", "pec_intranet",
  ]) assert.equal(allPublicText.includes(forbidden), false, forbidden);
  // Check the public lists changed in this work package explicitly. A broad
  // comma search would incorrectly reject commas between independent clauses.
  for (const forbiddenOxfordPhrase of [
    "moved, renamed, or", "different, moved, or", "Markdown, responsive HTML, and",
    "Tool, Browser, and", "DOCX, PDF, and", "complete, readable, or", "Remote, virtual, and",
  ]) assert.equal(allPublicText.includes(forbiddenOxfordPhrase), false, forbiddenOxfordPhrase);
  assert.ok(documents["README.md"].includes("there is no separate JSON document per session"));
  assert.ok(documents["README.md"].includes("Raw JSONL is source-faithful and is not automatically safe to share"));
  assert.ok(documents["integrations/vscode/README.md"].includes("The folder is created only when an export actually starts."));

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
  for (const forbiddenOxfordPhrase of ["text, monospace, symbol, and", "DOCX, PDF, and", "active, truncated, or"]) {
    assert.equal(releasePreparation.includes(forbiddenOxfordPhrase), false, forbiddenOxfordPhrase);
  }

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
