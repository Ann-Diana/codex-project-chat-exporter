import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(repositoryRoot, "bin", "export-codex-project-chats.mjs");

function runCli(args, options = {}) {
  return new Promise((resolve, reject) => {
    const preloads = [];
    if (options.denyNetwork) preloads.push(path.join(repositoryRoot, "tests", "helpers", "deny-network-preload.mjs"));
    if (options.emitSigint) preloads.push(path.join(repositoryRoot, "tests", "helpers", "emit-sigint-preload.mjs"));
    const preloadOptions = preloads.map((file) => `--import=${pathToFileURL(file).href}`).join(" ");
    const nodeOptions = `${process.env.NODE_OPTIONS || ""} ${preloadOptions}`.trim();
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: repositoryRoot,
      env: { ...process.env, ...(nodeOptions ? { NODE_OPTIONS: nodeOptions } : {}), ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }));
    options.onChild?.(child);
  });
}

async function createFixture() {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "cli-process-")));
  const codexHome = path.join(temp, "source");
  const sessions = path.join(codexHome, "sessions");
  await fs.mkdir(sessions, { recursive: true });
  const base = process.platform === "win32" ? "C:\\Synthetic\\Recorded" : "/Synthetic/Recorded";
  const baseVariant = process.platform === "win32" ? "c:/synthetic/recorded/" : base;
  const child = process.platform === "win32" ? `${base}\\child` : `${base}/child`;
  const sibling = `${base}-sibling`;
  const paths = process.platform === "win32" ? [base, baseVariant, child, sibling] : [base, child, sibling];
  for (let index = 0; index < paths.length; index += 1) {
    const timestamp = `2026-08-0${index + 1}T10:00:00Z`;
    const rows = [
      { type: "session_meta", timestamp, payload: { id: `cli-${index}`, cwd: paths[index], timestamp } },
      { type: "response_item", timestamp, payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Synthetic CLI fixture." }] } },
      { type: "response_item", timestamp, payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Synthetic response." }] } },
    ];
    await fs.writeFile(path.join(sessions, `rollout-${index}.jsonl`), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  }
  return { temp, codexHome, base, baseVariant, child, sibling, expectedBaseSessions: process.platform === "win32" ? 2 : 1 };
}

test("direct CLI help and version remain non-interactive with locked stdin", async () => {
  const help = await runCli(["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Codex Project Chat Exporter 0\.3\.1/);
  assert.equal(help.stderr, "");
  const version = await runCli(["--version", "--report-format", "json"]);
  assert.equal(version.code, 0);
  assert.equal(version.stderr, "");
  assert.deepEqual(JSON.parse(version.stdout), { schema_version: 1, kind: "version", message: "0.3.1", exit_code: 0, version: "0.3.1" });
});

test("mixed information and action flags retain their historical priority", async () => {
  const helpBeforeVersion = await runCli(["--version", "--help", "--report-format", "json"]);
  assert.equal(helpBeforeVersion.code, 0);
  assert.equal(JSON.parse(helpBeforeVersion.stdout).kind, "help");
  const versionBeforeList = await runCli(["--list", "--version", "--report-format", "json"]);
  assert.equal(versionBeforeList.code, 0);
  assert.equal(JSON.parse(versionBeforeList.stdout).kind, "version");
  const reportLastWins = await runCli(["--report-format", "json", "--report-format", "text", "--unknown"]);
  assert.equal(reportLastWins.code, 2);
  assert.match(reportLastWins.stderr, /^Argument error:/);
});

test("interactive Windows wrapper delegates every profile, document choice and exact path to the MJS CLI", async () => {
  const wrapper = await fs.readFile(path.join(repositoryRoot, "export-codex-project-chats.cmd"), "utf8");
  for (const expected of [
    "--profile complete",
    "--profile readable",
    "--profile source-snapshots",
    "--format docx",
    "--format pdf",
    "--format docx,pdf",
    "--recorded-project",
    "set \"COMMAND_ERROR=%ERRORLEVEL%\"",
    "The command did not complete successfully. Exit code:",
  ]) assert.ok(wrapper.includes(expected), `wrapper contract is missing ${expected}`);
  assert.ok(wrapper.includes("choice /c"));
  assert.ok(wrapper.includes("set /p"));
  assert.ok(wrapper.includes("DisableDelayedExpansion"), "literal recorded paths must not be rewritten through delayed expansion");
  assert.ok(!wrapper.includes("!PROJECT_FILTER!"));
  assert.ok(!wrapper.includes("--raw-jsonl"));
});

test("direct CLI emits stable parser codes, stderr-only JSON and exit code 2", async () => {
  const cases = [
    { args: ["--unknown", "--report-format", "json"], code: "CLI_UNKNOWN_OPTION" },
    { args: ["--project", "--report-format", "json"], code: "CLI_MISSING_VALUE" },
    { args: ["positional", "--report-format", "json"], code: "CLI_UNEXPECTED_POSITIONAL" },
    { args: ["--all", "--project", "x", "--report-format", "json"], code: "CLI_SELECTION_CONFLICT" },
    { args: ["--recorded-project", "relative", "--report-format", "json"], code: "CLI_UNSUPPORTED_VALUE" },
    { args: ["--all", "--format", "", "--report-format", "json"], code: "CLI_MISSING_VALUE" },
    { args: ["--all", "--format", "epub", "--report-format", "json"], code: "CLI_UNSUPPORTED_VALUE" },
    { args: ["--all", "--format", "docx,,pdf", "--report-format", "json"], code: "CLI_UNSUPPORTED_VALUE" },
    { args: ["--all", "--format", "docx,docx", "--report-format", "json"], code: "CLI_UNSUPPORTED_VALUE" },
    { args: ["--all", "--format", "docx,pdf,docx", "--report-format", "json"], code: "CLI_UNSUPPORTED_VALUE" },
  ];
  for (const entry of cases) {
    const result = await runCli(entry.args);
    assert.equal(result.code, 2);
    assert.equal(result.stdout, "");
    const lines = result.stderr.trimEnd().split(/\r?\n/);
    assert.equal(lines.length, 1);
    const error = JSON.parse(lines[0]);
    assert.equal(error.schema_version, 1);
    assert.equal(error.kind, "error");
    assert.equal(error.code, entry.code);
    assert.equal(error.exit_code, 2);
    assert.equal(typeof error.message, "string");
  }
});

test("project list JSON groups lexical identities and preserves recorded variants without reading conversation tails", async () => {
  const fixture = await createFixture();
  try {
    const result = await runCli(["--codex-home", fixture.codexHome, "--list", "--report-format", "json"]);
    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    const lines = result.stdout.trimEnd().split(/\r?\n/);
    assert.equal(lines.length, 1);
    const report = JSON.parse(lines[0]);
    assert.equal(report.kind, "project-list");
    const project = report.projects.find((entry) => entry.recordedPaths.includes(fixture.base));
    assert.equal(project.sessionCount, fixture.expectedBaseSessions);
    assert.equal(project.firstSessionAt, "2026-08-01T10:00:00.000Z");
    assert.equal(project.lastSessionAt, process.platform === "win32" ? "2026-08-02T10:00:00.000Z" : "2026-08-01T10:00:00.000Z");
    assert.deepEqual([...project.recordedPaths].sort(), [...new Set([fixture.base, ...(process.platform === "win32" ? [fixture.baseVariant] : [])])].sort());
    const text = await runCli(["--codex-home", fixture.codexHome, "--list", "--report-format", "text"]);
    assert.equal(text.code, 0);
    assert.match(text.stdout, /Detected project\/work folders/);
    const mixedActions = await runCli(["--codex-home", fixture.codexHome, "--diagnose", "--list-sessions", "--list", "--report-format", "json"]);
    assert.equal(mixedActions.code, 0);
    assert.equal(JSON.parse(mixedActions.stdout).kind, "project-list", "list must retain priority over later session-list and diagnostic flags");
  } finally { await fs.rm(fixture.temp, { recursive: true, force: true }); }
});

test("recorded-project is lexical-exact while legacy project search remains fuzzy", async () => {
  const fixture = await createFixture();
  try {
    const exactOutput = path.join(fixture.temp, "exact");
    const exact = await runCli(["--codex-home", fixture.codexHome, "--recorded-project", fixture.baseVariant, "--profile", "readable", "--out", exactOutput, "--report-format", "json"]);
    assert.equal(exact.code, 0, exact.stderr);
    const exactManifest = JSON.parse(await fs.readFile(path.join(exactOutput, "manifest.json"), "utf8"));
    assert.equal(exactManifest.sessions.length, fixture.expectedBaseSessions);
    assert.deepEqual(exactManifest.sessions.map((session) => session.session_id).sort(), process.platform === "win32" ? ["cli-0", "cli-1"] : ["cli-0"]);
    if (process.platform === "win32") {
      const extendedOutput = path.join(fixture.temp, "extended");
      const extended = await runCli(["--codex-home", fixture.codexHome, "--recorded-project", "\\\\?\\C:\\Synthetic\\Recorded\\", "--profile", "readable", "--out", extendedOutput, "--report-format", "json"]);
      assert.equal(extended.code, 0, extended.stderr);
      const extendedManifest = JSON.parse(await fs.readFile(path.join(extendedOutput, "manifest.json"), "utf8"));
      assert.deepEqual(extendedManifest.sessions.map((session) => session.session_id).sort(), ["cli-0", "cli-1"]);
    }
    const missing = await runCli(["--codex-home", fixture.codexHome, "--recorded-project", `${fixture.base}-missing`, "--profile", "readable", "--out", path.join(fixture.temp, "missing"), "--report-format", "json"]);
    assert.equal(missing.code, 1);
    assert.equal(JSON.parse(missing.stderr).code, "NO_PROJECT_MATCH");
    const fuzzyOutput = path.join(fixture.temp, "fuzzy");
    const fuzzy = await runCli(["--codex-home", fixture.codexHome, "--project", "recorded", "--profile", "readable", "--out", fuzzyOutput]);
    assert.equal(fuzzy.code, 0, fuzzy.stderr);
    const fuzzyManifest = JSON.parse(await fs.readFile(path.join(fuzzyOutput, "manifest.json"), "utf8"));
    assert.ok(fuzzyManifest.sessions.length > fixture.expectedBaseSessions);
  } finally { await fs.rm(fixture.temp, { recursive: true, force: true }); }
});

test("CLI renders deterministic DOCX and PDF together while repeated format values remain last-wins", async () => {
  const fixture = await createFixture();
  try {
    const firstOutput = path.join(fixture.temp, "documents-first");
    const secondOutput = path.join(fixture.temp, "documents-second");
    for (const [output, format] of [[firstOutput, "docx,pdf"], [secondOutput, "pdf,docx"]]) {
      const result = await runCli(["--codex-home", fixture.codexHome, "--recorded-project", fixture.base, "--profile", "readable", "--format", format, "--out", output, "--report-format", "json"], { denyNetwork: true });
      assert.equal(result.code, 0, result.stderr);
      const report = JSON.parse(result.stdout);
      assert.equal(report.formats.docx, true);
      assert.equal(report.formats.pdf, true);
    }
    const firstManifest = JSON.parse(await fs.readFile(path.join(firstOutput, "manifest.json"), "utf8"));
    const secondManifest = JSON.parse(await fs.readFile(path.join(secondOutput, "manifest.json"), "utf8"));
    assert.equal(firstManifest.archive_format_version, 1);
    assert.equal(firstManifest.formats.docx, true);
    assert.equal(firstManifest.formats.pdf, true);
    for (let index = 0; index < firstManifest.sessions.length; index += 1) {
      const firstSession = firstManifest.sessions[index];
      const secondSession = secondManifest.sessions[index];
      assert.deepEqual(await fs.readFile(path.join(firstOutput, firstSession.docx_file)), await fs.readFile(path.join(secondOutput, secondSession.docx_file)));
      assert.deepEqual(await fs.readFile(path.join(firstOutput, firstSession.pdf_file)), await fs.readFile(path.join(secondOutput, secondSession.pdf_file)));
    }
    const lastWinsOutput = path.join(fixture.temp, "last-wins");
    const lastWins = await runCli(["--codex-home", fixture.codexHome, "--recorded-project", fixture.base, "--profile", "readable", "--format", "docx", "--format", "pdf", "--out", lastWinsOutput]);
    assert.equal(lastWins.code, 0, lastWins.stderr);
    const lastWinsManifest = JSON.parse(await fs.readFile(path.join(lastWinsOutput, "manifest.json"), "utf8"));
    assert.equal(lastWinsManifest.formats.docx, false);
    assert.equal(lastWinsManifest.formats.pdf, true);
  } finally { await fs.rm(fixture.temp, { recursive: true, force: true }); }
});

test("operational errors remain exit code 1 with one JSON error object", async () => {
  const result = await runCli(["--report-format", "json"]);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  const lines = result.stderr.trimEnd().split(/\r?\n/);
  assert.equal(lines.length, 1);
  const error = JSON.parse(lines[0]);
  assert.equal(error.kind, "error");
  assert.equal(error.code, "NO_SELECTION");
  assert.equal(error.exit_code, 1);
});

test("direct MJS CLI converts SIGINT across discovery, streaming, rendering and publication into exit code 130 after cleanup", async () => {
  const fixture = await createFixture();
  try {
    for (const mode of ["discovery", "asset-stream", "render-stream", "publication"]) {
      const outputDirectory = path.join(fixture.temp, `sigint-${mode}`);
      const result = await runCli(["--codex-home", fixture.codexHome, "--recorded-project", fixture.base, "--profile", "readable", "--format", "docx,pdf", "--out", outputDirectory, "--report-format", "json"], { emitSigint: true, env: { EXPORTER_SIGINT_TEST_MODE: mode, EXPORTER_SIGINT_STREAM_TARGET: String(fixture.expectedBaseSessions + 1) } });
      assert.equal(result.code, 130, `${mode}: ${result.stderr}`);
      assert.equal(result.stdout, "");
      const lines = result.stderr.trimEnd().split(/\r?\n/);
      assert.equal(lines.length, 1);
      const error = JSON.parse(lines[0]);
      assert.equal(error.code, "EXPORT_CANCELLED");
      assert.equal(error.exit_code, 130);
      const files = await fs.readdir(outputDirectory).catch((error) => error.code === "ENOENT" ? [] : Promise.reject(error));
      assert.equal(files.some((name) => name.includes(".partial-") || name.includes(".previous-") || name.startsWith(".staging-")), false);
      if (mode !== "discovery") assert.ok(files.includes("EXPORT_INCOMPLETE.txt"), `${mode}: expected incomplete marker, found ${files.join(", ")}`);
    }
  } finally { await fs.rm(fixture.temp, { recursive: true, force: true }); }
});
