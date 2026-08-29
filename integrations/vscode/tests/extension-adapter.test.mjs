import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildVsix } from "../scripts/build-vsix.mjs";

const require = createRequire(import.meta.url);
const { COMMANDS, DIAGNOSTIC_BUILD_ID, EXPORT_PROFILES, STATE_LATEST_HTML, STATE_LATEST_HTML_TARGET, STATE_OUTPUT_DIR, STATE_OUTPUT_TARGET, createExtensionAdapter, defaultLoadExporter, formatExportSummary, isWindowsNetworkOrDevicePath, resolveConfiguredProfile } = require("../src/vscode-adapter.cjs");

function createState() {
  const values = new Map();
  return {
    values,
    get(key, fallback) { return values.has(key) ? values.get(key) : fallback; },
    async update(key, value) { values.set(key, value); },
  };
}

function createFakeVscode(overrides = {}) {
  const registered = new Map();
  const messages = [];
  const opened = [];
  const output = [];
  const quickPicks = [];
  const openDialogs = [];
  const progressCalls = [];
  const progressReports = [];
  const config = new Map(Object.entries(overrides.config || {}));
  const configScopes = overrides.configScopes || {};
  const vscode = {
    UIKind: { Desktop: 1, Web: 2 },
    ProgressLocation: { Notification: 15 },
    env: {
      remoteName: overrides.remoteName,
      uiKind: overrides.uiKind || 1,
      openExternal: async (uri) => { opened.push(uri.fsPath); return true; },
    },
    Uri: { file: (fsPath) => ({ scheme: "file", fsPath }) },
    workspace: {
      isTrusted: overrides.isTrusted !== false,
      workspaceFolders: overrides.workspaceFolders || [],
      getConfiguration: () => ({
        get: (key, fallback) => configScopes[key]?.workspaceFolderValue ?? configScopes[key]?.workspaceValue ?? configScopes[key]?.globalValue ?? (config.has(key) ? config.get(key) : fallback),
        inspect: (key) => ({ globalValue: configScopes[key]?.globalValue ?? (config.has(key) ? config.get(key) : undefined), workspaceValue: configScopes[key]?.workspaceValue, workspaceFolderValue: configScopes[key]?.workspaceFolderValue, workspaceLanguageValue: configScopes[key]?.workspaceLanguageValue, workspaceFolderLanguageValue: configScopes[key]?.workspaceFolderLanguageValue }),
      }),
    },
    window: {
      createOutputChannel: () => ({ appendLine: (line) => output.push(line), show: () => {}, dispose: () => {} }),
      showWarningMessage: async (message, ...actions) => { messages.push({ type: "warning", message, actions }); return overrides.warningSelector?.(message, actions); },
      showErrorMessage: async (message) => { messages.push({ type: "error", message }); return undefined; },
      showInformationMessage: async (message, ...actions) => { messages.push({ type: "info", message, actions }); return overrides.infoAction; },
      showQuickPick: async (items, options) => {
        quickPicks.push({ items, options });
        if (overrides.quickPickSelector) return overrides.quickPickSelector(items, options);
        if (Object.prototype.hasOwnProperty.call(overrides, "quickPickItem")) return overrides.quickPickItem;
        return items[0];
      },
      showOpenDialog: async (options) => { openDialogs.push(options); return overrides.openDialogResult || []; },
      withProgress: async (options, task) => {
        progressCalls.push(options);
        const callbacks = [];
        const result = task({ report: (event) => progressReports.push(event) }, { onCancellationRequested(callback) { callbacks.push(callback); return { dispose() {} }; } });
        if (overrides.cancelProgressImmediately) callbacks.forEach(callback => callback());
        return result;
      },
    },
    commands: {
      registerCommand: (name, callback) => { registered.set(name, callback); return { dispose: () => registered.delete(name) }; },
    },
  };
  return { vscode, registered, messages, opened, output, quickPicks, openDialogs, progressCalls, progressReports, config };
}

function createContext(extensionPath = path.resolve(".")) {
  return { extensionPath, subscriptions: [], globalState: createState() };
}

function folder(fsPath, scheme = "file") {
  return { uri: { scheme, fsPath } };
}

function testFileIdentity(stat) {
  return `${stat.dev}:${stat.ino}`;
}

function testFileEvidence(stat) {
  return {
    type: stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other",
    dev: String(stat.dev),
    ino: String(stat.ino),
    size: String(stat.size),
    mtime_ns: String(stat.mtimeNs),
    ctime_ns: String(stat.ctimeNs),
    birthtime_ns: String(stat.birthtimeNs),
  };
}

const temp = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "codex-vscode-test-")));
const sourceFile = path.join(temp, "source.jsonl");
await fsp.writeFile(sourceFile, "synthetic source", "utf8");
const before = await fsp.readFile(sourceFile, "utf8");

const oneWorkspace = path.join(temp, "workspace-one");
const twoWorkspace = path.join(temp, "workspace-two");
const outputDirectory = path.join(temp, "archives");
await fsp.mkdir(oneWorkspace, { recursive: true });
await fsp.mkdir(twoWorkspace, { recursive: true });
await fsp.mkdir(outputDirectory, { recursive: true });

let lastOptions;
let exportCallCount = 0;
const exporter = {
  async exportArchive(options) {
    exportCallCount += 1;
    lastOptions = options;
    options.onDiagnostic?.({ monotonic_ms: 10, scope: "core", event: "core_start", profile: options.exportProfile });
    options.onProgress?.({ phase: "discovery", message: "Discovering sessions" });
    options.onProgress?.({ phase: "processing", message: "Processing session 37 of 72", current: 37, total: 72 });
    options.onProgress?.({ phase: "complete", message: "Export complete" });
    await fsp.mkdir(options.outputDirectory, { recursive: true });
    const htmlIndexPath = path.join(options.outputDirectory, "index.html");
    const manifestPath = path.join(options.outputDirectory, "manifest.json");
    await fsp.writeFile(htmlIndexPath, "<html></html>", "utf8");
    await fsp.writeFile(manifestPath, JSON.stringify({ ok: true }), "utf8");
    options.onDiagnostic?.({ monotonic_ms: 20, scope: "core", event: "core_end", exported_sessions: options.scope === "all" ? 4 : 2 });
    return {
      outputDirectory: options.outputDirectory,
      htmlIndexPath,
      manifestPath,
      exportedProjectCount: options.scope === "all" ? 2 : 1,
      exportedSessionCount: options.scope === "all" ? 4 : 2,
      runtimeTimings: { total_ms: 2100, routing_ms: 800, snapshots_ms: 900, processing_ms: 200, indexes_manifest_ms: 100, verification_ms: 100 },
      warnings: [],
    };
  },
};

const extensionPackage = JSON.parse(await fsp.readFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"));

{
  assert.deepEqual(COMMANDS, {
    exportMenu: "codexArchive.export",
    exportCurrentWorkspace: "codexArchive.exportCurrentWorkspace",
    exportAllSessions: "codexArchive.exportAllSessions",
    openLatestArchive: "codexArchive.openLatestArchive",
    openExportFolder: "codexArchive.openExportFolder",
  }, "existing internal command IDs must remain stable");
  assert.deepEqual(extensionPackage.contributes.commands.map(({ command, title }) => ({ command, title })), [
    { command: COMMANDS.exportMenu, title: "Codex Export: Export…" },
    { command: COMMANDS.openLatestArchive, title: "Codex Export: Open Latest Export" },
    { command: COMMANDS.openExportFolder, title: "Codex Export: Open Export Folder" },
  ], "exactly three Codex Export commands should be visible in extension metadata");
  assert.deepEqual(extensionPackage.activationEvents, Object.values(COMMANDS).map((command) => `onCommand:${command}`));
  assert.deepEqual(EXPORT_PROFILES.map(({ label, profile }) => ({ label, profile })), [
    { label: "Complete export", profile: "complete" },
    { label: "Readable export", profile: "readable" },
    { label: "Source snapshots", profile: "source-snapshots" },
  ]);
  assert.equal("codexProjectChatExporter.includeOriginalJsonl" in extensionPackage.contributes.configuration.properties, false);
  assert.equal("codexProjectChatExporter.exportProfile" in extensionPackage.contributes.configuration.properties, false);
  assert.equal(extensionPackage.version, "0.1.3", "the final pre-push candidate must install as a distinguishable extension version");
  assert.equal(extensionPackage.contributes.configuration.properties["codexProjectChatExporter.diagnosticOutput"].default, false);
  assert.equal(extensionPackage.contributes.configuration.properties["codexProjectChatExporter.outputDirectory"].scope, "machine");
  assert.equal(extensionPackage.contributes.configuration.properties["codexProjectChatExporter.codexHome"].scope, "machine");
  assert.equal(extensionPackage.contributes.configuration.properties["codexProjectChatExporter.includeTools"].scope, "application");
  assert.deepEqual(Object.fromEntries(Object.entries(extensionPackage.contributes.configuration.properties).map(([key, value]) => [key, value.default])), {
    "codexProjectChatExporter.outputDirectory": "",
    "codexProjectChatExporter.codexHome": "",
    "codexProjectChatExporter.pathStyle": "short",
    "codexProjectChatExporter.includeTools": false,
    "codexProjectChatExporter.diagnosticOutput": false,
  }, "all five setting defaults must remain stable");
  assert.equal(formatExportSummary(1, 1), "1 session across 1 project");
  assert.equal(formatExportSummary(2, 1), "2 sessions across 1 project");
  assert.equal(formatExportSummary(100, 20), "100 sessions across 20 projects");
}

{
  const buildTemp = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "codex-vsix-build-foreign-")));
  const distDir = path.join(buildTemp, "dist");
  const foreignCandidate = path.join(distDir, "codex-project-chat-exporter-vscode-0.0.0.vsix");
  await fsp.mkdir(distDir, { recursive: true });
  await fsp.writeFile(foreignCandidate, "foreign candidate", "utf8");
  await assert.rejects(() => buildVsix({ distDir }), /Unexpected dist artifacts/);
  assert.equal(await fsp.readFile(foreignCandidate, "utf8"), "foreign candidate", "same-prefix files not owned by the current build must remain untouched");
  assert.deepEqual(await fsp.readdir(distDir), [path.basename(foreignCandidate)], "a blocked build must not create stage or partial artifacts");
  await fsp.rm(buildTemp, { recursive: true, force: true });
}

{
  const buildTemp = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "codex-vsix-build-success-")));
  const distDir = path.join(buildTemp, "dist");
  const currentCandidate = path.join(distDir, "codex-project-chat-exporter-vscode-0.1.3.vsix");
  await fsp.mkdir(distDir, { recursive: true });
  await fsp.writeFile(currentCandidate, "previous candidate", "utf8");
  const result = await buildVsix({
    distDir,
    archiveWriter: async ({ archivePath }) => fsp.writeFile(archivePath, "synthetic VSIX", "utf8"),
  });
  assert.equal(path.basename(result.vsixPath), "codex-project-chat-exporter-vscode-0.1.3.vsix");
  assert.equal(await fsp.readFile(result.vsixPath, "utf8"), "synthetic VSIX", "the exact canonical candidate may be replaced in a controlled publication step");
  assert.equal((await fsp.stat(result.vsixPath)).isFile(), true);
  assert.equal(await fsp.stat(result.stage).then(() => true, () => false), false, "successful builds must remove their stage directory");
  assert.equal(await fsp.stat(result.archivePath).then(() => true, () => false), false, "successful builds must remove their temporary archive path");
  assert.deepEqual(await fsp.readdir(distDir), [path.basename(currentCandidate)], "successful builds must leave only the exact canonical candidate");
  await fsp.rm(buildTemp, { recursive: true, force: true });
}

{
  const buildTemp = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "codex-vsix-build-failure-")));
  const distDir = path.join(buildTemp, "dist");
  await fsp.mkdir(distDir, { recursive: true });
  let attemptedArchivePath;
  let attemptedStage;
  await assert.rejects(
    () => buildVsix({
      distDir,
      archiveWriter: async ({ stage, archivePath }) => {
        attemptedArchivePath = archivePath;
        attemptedStage = stage;
        throw new Error("Synthetic archive failure");
      },
    }),
    /Synthetic archive failure/,
  );
  assert.equal(await fsp.stat(attemptedStage).then(() => true, () => false), false, "failed builds must remove their stage directory");
  assert.equal(await fsp.stat(attemptedArchivePath).then(() => true, () => false), false, "failed builds must remove their temporary archive path");
  assert.deepEqual(await fsp.readdir(distDir), [], "failed builds must leave no run-owned stage or partial artifacts");
  await fsp.rm(buildTemp, { recursive: true, force: true });
}

{
  const buildTemp = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "codex-vsix-build-create-new-")));
  const distDir = path.join(buildTemp, "dist");
  const foreignBytes = Buffer.from("foreign temporary archive");
  let occupiedArchivePath;
  let archiveWriterCalls = 0;
  await assert.rejects(
    () => buildVsix({
      distDir,
      beforeArchiveWrite: async ({ archivePath }) => {
        occupiedArchivePath = archivePath;
        await fsp.writeFile(archivePath, foreignBytes, { flag: "wx" });
      },
      archiveWriter: async ({ archivePath }) => {
        archiveWriterCalls += 1;
        await fsp.writeFile(archivePath, "synthetic archive", { flag: "wx" });
      },
    }),
    (error) => error?.code === "EEXIST",
  );
  assert.equal(archiveWriterCalls, 1, "the injected archive writer must attempt exclusive creation exactly once");
  assert.deepEqual(await fsp.readFile(occupiedArchivePath), foreignBytes, "the actual archive writer must not truncate or replace a foreign temporary file");
  const remaining = await fsp.readdir(distDir);
  assert.deepEqual(remaining, [path.basename(occupiedArchivePath)], "failed exclusive archive creation must leave only the unowned foreign file for manual review");
  await fsp.rm(buildTemp, { recursive: true, force: true });
}

{
  const buildTemp = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "codex-vsix-stage-foreign-")));
  const distDir = path.join(buildTemp, "dist");
  let foreignStageFile;
  let archiveWriterCalls = 0;
  await assert.rejects(
    () => buildVsix({
      distDir,
      beforeArchiveWrite: async ({ stage }) => {
        foreignStageFile = path.join(stage, "extension", "foreign.txt");
        await fsp.writeFile(foreignStageFile, "foreign stage content", { flag: "wx" });
      },
      archiveWriter: async () => { archiveWriterCalls += 1; },
    }),
    /not empty|not empty|ENOTEMPTY/i,
  );
  assert.equal(archiveWriterCalls, 0, "unexpected stage contents must fail closed before the archive writer mutates its destination");
  assert.equal(await fsp.readFile(foreignStageFile, "utf8"), "foreign stage content", "nonrecursive cleanup must not delete unexpected stage content");
  await fsp.rm(buildTemp, { recursive: true, force: true });
}

{
  const buildTemp = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "codex-vsix-stage-replaced-")));
  const distDir = path.join(buildTemp, "dist");
  let replacedStageFile;
  let movedOwnedFile;
  let archiveWriterCalls = 0;
  await assert.rejects(
    () => buildVsix({
      distDir,
      beforeArchiveWrite: async ({ stage }) => {
        replacedStageFile = path.join(stage, "extension", "package.json");
        movedOwnedFile = path.join(stage, "extension", "package-owned-moved.json");
        await fsp.rename(replacedStageFile, movedOwnedFile);
        await fsp.writeFile(replacedStageFile, "foreign replacement", { flag: "wx" });
      },
      archiveWriter: async () => { archiveWriterCalls += 1; },
    }),
    /identity changed/i,
  );
  assert.equal(archiveWriterCalls, 0, "a replaced stage file must fail closed before archive creation");
  assert.equal(await fsp.readFile(replacedStageFile, "utf8"), "foreign replacement", "cleanup must preserve a foreign replacement at an owned stage path");
  assert.equal((await fsp.stat(movedOwnedFile)).isFile(), true, "cleanup must not search for or delete a moved run-owned stage file");
  await fsp.rm(buildTemp, { recursive: true, force: true });
}

{
  const installedRoot = path.join(temp, "installed-extension", "extensions", "candidate");
  const packagedCore = path.join(installedRoot, "vendor", "codex-project-chat-exporter", "bin", "export-codex-project-chats.mjs");
  const integrityFile = path.join(installedRoot, "vendor", "codex-project-chat-exporter", "integrity.json");
  const externalCore = path.resolve(installedRoot, "..", "..", "bin", "export-codex-project-chats.mjs");
  const packagedBytes = 'export const loadedFrom = "packaged";\n';
  await fsp.mkdir(path.dirname(packagedCore), { recursive: true });
  await fsp.mkdir(path.dirname(externalCore), { recursive: true });
  await fsp.writeFile(packagedCore, packagedBytes, "utf8");
  await fsp.writeFile(externalCore, 'export const loadedFrom = "external";\n', "utf8");
  await fsp.writeFile(integrityFile, JSON.stringify({ format: 1, files: { "bin/export-codex-project-chats.mjs": createHash("sha256").update(packagedBytes).digest("hex") } }), "utf8");
  const loaded = await defaultLoadExporter({ extensionPath: installedRoot });
  assert.equal(loaded.loadedFrom, "packaged", "installed extensions must ignore any external development core");

  const unexpectedRuntimeFile = path.join(installedRoot, "vendor", "codex-project-chat-exporter", "unlisted.mjs");
  await fsp.writeFile(unexpectedRuntimeFile, "export {};\n", "utf8");
  await assert.rejects(() => defaultLoadExporter({ extensionPath: installedRoot }), (error) => error?.code === "PACKAGED_EXPORTER_INTEGRITY_FAILED");
  await fsp.rm(unexpectedRuntimeFile);

  await fsp.writeFile(integrityFile, JSON.stringify({ format: 1, files: { "bin/export-codex-project-chats.mjs": createHash("sha256").update(packagedBytes).digest("hex"), "lib/missing.mjs": "0".repeat(64) } }), "utf8");
  await assert.rejects(() => defaultLoadExporter({ extensionPath: installedRoot }), (error) => error?.code === "PACKAGED_EXPORTER_INTEGRITY_FAILED");
  await fsp.writeFile(integrityFile, JSON.stringify({ format: 1, files: { "bin/export-codex-project-chats.mjs": createHash("sha256").update(packagedBytes).digest("hex") } }), "utf8");

  const missingRoot = path.join(temp, "installed-extension-missing");
  await fsp.mkdir(missingRoot, { recursive: true });
  await assert.rejects(() => defaultLoadExporter({ extensionPath: missingRoot }), (error) => error?.code === "PACKAGED_EXPORTER_MISSING");

  const tamperedRoot = path.join(temp, "installed-extension-tampered");
  const tamperedCore = path.join(tamperedRoot, "vendor", "codex-project-chat-exporter", "bin", "export-codex-project-chats.mjs");
  const tamperedIntegrity = path.join(tamperedRoot, "vendor", "codex-project-chat-exporter", "integrity.json");
  await fsp.mkdir(path.dirname(tamperedCore), { recursive: true });
  await fsp.writeFile(tamperedCore, 'export const loadedFrom = "tampered";\n', "utf8");
  await fsp.writeFile(tamperedIntegrity, JSON.stringify({ format: 1, files: { "bin/export-codex-project-chats.mjs": "0".repeat(64) } }), "utf8");
  await assert.rejects(() => defaultLoadExporter({ extensionPath: tamperedRoot }), (error) => error?.code === "PACKAGED_EXPORTER_INTEGRITY_FAILED");
}

{
  assert.equal(isWindowsNetworkOrDevicePath("\\\\server\\share\\exports"), true);
  assert.equal(isWindowsNetworkOrDevicePath("\\\\?\\UNC\\server\\share\\exports"), true);
  assert.equal(isWindowsNetworkOrDevicePath("\\\\.\\C:\\exports"), true);
  assert.equal(isWindowsNetworkOrDevicePath("C:\\Codex-Exports"), false);
}

{
  const fake = createFakeVscode({ workspaceFolders: [folder(oneWorkspace)], openDialogResult: [{ fsPath: outputDirectory }] });
  const context = createContext(temp);
  const adapter = createExtensionAdapter(fake.vscode, { loadExporter: async () => exporter });
  await adapter.activate(context);
  assert.deepEqual([...fake.registered.keys()].sort(), Object.values(COMMANDS).sort(), "all five commands should register");
  const workspacePath = await adapter.getLocalWorkspacePath();
  assert.equal(workspacePath, oneWorkspace, "single local workspace should be selected automatically");
  const result = await adapter.exportCurrentWorkspace(context);
  assert.equal(lastOptions.scope, "project");
  assert.equal(lastOptions.workspacePath, oneWorkspace);
  assert.equal(result.exportedSessionCount, 2);
  assert.equal(context.globalState.get(STATE_OUTPUT_DIR), outputDirectory);
  assert.equal(context.globalState.get(STATE_LATEST_HTML), path.join(outputDirectory, "index.html"));
  assert.equal(context.globalState.get(STATE_OUTPUT_TARGET).kind, "directory");
  assert.equal(context.globalState.get(STATE_LATEST_HTML_TARGET).kind, "file");
  const infoMessage = fake.messages.find((message) => message.type === "info");
  assert.match(infoMessage.message, /2 sessions across 1 project/);
  assert.match(infoMessage.message, new RegExp(outputDirectory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.deepEqual(infoMessage.actions, ["Open HTML Index", "Open Export Folder"]);
  assert.equal(fake.openDialogs[0].title, "Choose Codex export output folder");
  assert.equal(fake.progressCalls[0].title, "Exporting Codex sessions");
  assert.equal(fake.progressCalls[0].cancellable, true);
  assert.ok(fake.output.includes(`Output directory: ${outputDirectory}`));
  assert.ok(fake.output.includes(`HTML index: ${path.join(outputDirectory, "index.html")}`));
  assert.ok(fake.output.includes(`Manifest: ${path.join(outputDirectory, "manifest.json")}`));
  assert.ok(fake.output.includes("Runtime: 2.1s total | 0.8s routing | 0.9s snapshots | 0.4s output"));
  assert.equal(fake.output.some((line) => line.startsWith("[DIAG]")), false, "detailed diagnostics must stay disabled in normal production output");
  assert.ok(fake.progressReports.some((event) => event.message === "Processing session 37 of 72"), "shared-core progress must reach the native VS Code progress UI");
}

{
  const fake = createFakeVscode({ config: { outputDirectory, diagnosticOutput: true } });
  const context = createContext(temp);
  let exportCalls = 0;
  let releaseFirstExport;
  let firstExportStarted;
  const firstExportStartedPromise = new Promise((resolve) => { firstExportStarted = resolve; });
  const firstExportGate = new Promise((resolve) => { releaseFirstExport = resolve; });
  const overlappingExporter = {
    async exportArchive(options) {
      exportCalls += 1;
      options.onDiagnostic?.({ monotonic_ms: 10, scope: "core", event: "core_start" });
      if (exportCalls === 1) {
        firstExportStarted();
        await firstExportGate;
      }
      options.onDiagnostic?.({ monotonic_ms: 20, scope: "core", event: "core_end" });
      return { outputDirectory, htmlIndexPath: path.join(outputDirectory, "index.html"), manifestPath: path.join(outputDirectory, "manifest.json"), exportedProjectCount: 1, exportedSessionCount: 1, warnings: [] };
    },
  };
  const adapter = createExtensionAdapter(fake.vscode, { loadExporter: async () => overlappingExporter });
  const activation = await adapter.activate(context);
  const firstExport = fake.registered.get(COMMANDS.exportAllSessions)();
  await firstExportStartedPromise;
  assert.equal(await fake.registered.get(COMMANDS.exportAllSessions)(), undefined, "the adapter must reject a second simultaneous export");
  assert.equal(exportCalls, 1, "the rejected command must not reach the shared exporter");
  assert.match(fake.messages.at(-1).message, /already running/);
  releaseFirstExport();
  await firstExport;
  await fake.registered.get(COMMANDS.exportAllSessions)();
  assert.equal(exportCalls, 2, "the adapter must accept a new export after the first one completed");
  const diagnostics = activation.getDiagnosticEvents();
  const runIds = [...new Set(diagnostics.map((event) => event.run_id))];
  assert.equal(runIds.length, 3, "both completed commands and the rejected command must retain separate traces");
  const rejectedRun = runIds.map((runId) => diagnostics.filter((event) => event.run_id === runId)).find((events) => !events.some((event) => event.scope === "core" && event.event === "core_start"));
  assert.ok(rejectedRun, "the rejected simultaneous command must not contain core events");
  assert.equal(rejectedRun[0].event, "command_start");
  assert.equal(rejectedRun.at(-1).event, "command_end");
  assert.equal(context.globalState.get(STATE_OUTPUT_DIR), outputDirectory, "only a completed export may update the remembered output folder");
  assert.equal(context.globalState.get(STATE_LATEST_HTML), path.join(outputDirectory, "index.html"), "only a completed export may update the latest index");
}

{
  lastOptions = undefined;
  const fake = createFakeVscode({ workspaceFolders: [folder(oneWorkspace)], config: { outputDirectory, diagnosticOutput: true }, quickPickSelector: (items, options) => options?.placeHolder === "Choose what to export" ? items.find((item) => item.label === "Current Workspace") : items[0] });
  const context = createContext(temp);
  const adapter = createExtensionAdapter(fake.vscode, { loadExporter: async () => exporter });
  const activation = await adapter.activate(context);
  exportCallCount = 0;
  await fake.registered.get(COMMANDS.exportMenu)();
  assert.equal(exportCallCount, 1, "one registered command invocation must start exactly one export");
  assert.equal(lastOptions.scope, "project", "central quick pick should route Current Workspace to the project export");
  assert.equal(lastOptions.workspacePath, oneWorkspace);
  assert.equal(lastOptions.exportProfile, "complete");
  assert.equal(fake.quickPicks.length, 3, "the central command should ask for scope, profile, and optional document formats");
  assert.deepEqual(lastOptions.documentFormats, [], "DOCX must remain opt-in");
  const diagnosticOutput = fake.output.filter((line) => line.startsWith("[DIAG] "));
  assert.match(diagnosticOutput[0], new RegExp(`Diagnostic build ${DIAGNOSTIC_BUILD_ID} \\| run_id export-\\d+ \\| command_start`), "the visible output must identify the diagnostic build and run immediately");
  const diagnosticLines = activation.getDiagnosticEvents();
  assert.equal(diagnosticLines[0].event, "command_start");
  assert.ok(diagnosticLines.some((event) => event.event === "with_progress_start"));
  assert.ok(diagnosticLines.some((event) => event.event === "core_call_start"));
  assert.ok(diagnosticLines.some((event) => event.scope === "core" && event.event === "core_start"));
  assert.ok(diagnosticLines.some((event) => event.event === "core_call_end" && event.status === "COMPLETED"));
  assert.ok(diagnosticLines.some((event) => event.event === "success_message_show"));
  assert.equal(diagnosticLines.at(-1).event, "command_end");
  assert.equal(new Set(diagnosticLines.map((event) => event.run_id)).size, 1, "one command trace should carry one correlation ID across adapter and core events");
  assert.match(diagnosticLines[0].run_id, /^export-\d+$/);
  assert.equal(diagnosticOutput.length, diagnosticLines.length, "every recorded diagnostic must have a visible output-channel line");
  assert.doesNotMatch(JSON.stringify(diagnosticLines), new RegExp(temp.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "diagnostic events must not expose full private paths");
}

{
  lastOptions = undefined;
  const fake = createFakeVscode({ config: { outputDirectory }, quickPickSelector: (items, options) => {
    if (options?.placeHolder === "Choose what to export") return items.find((item) => item.label === "All Sessions");
    if (options?.placeHolder === "Choose an export profile") return items.find((item) => item.label === "Readable export");
    return items.find((item) => item.label === "Standard formats only");
  } });
  const context = createContext(temp);
  const adapter = createExtensionAdapter(fake.vscode, { loadExporter: async () => exporter });
  await adapter.activate(context);
  await fake.registered.get(COMMANDS.exportMenu)();
  assert.equal(lastOptions.scope, "all", "central quick pick should route All Sessions to the all-session export");
  assert.equal(lastOptions.exportProfile, "readable");
}

{
  lastOptions = undefined;
  const fake = createFakeVscode({ config: { outputDirectory }, quickPickSelector: (items, options) => {
    if (options?.placeHolder === "Choose what to export") return items.find((item) => item.label === "All Sessions");
    if (options?.placeHolder === "Choose an export profile") return items.find((item) => item.label === "Source snapshots");
    return items.find((item) => item.label === "Standard formats only");
  } });
  const context = createContext(temp);
  const adapter = createExtensionAdapter(fake.vscode, { loadExporter: async () => exporter });
  await adapter.activate(context);
  await fake.registered.get(COMMANDS.exportMenu)();
  assert.equal(lastOptions.exportProfile, "source-snapshots", "the source-snapshot profile must be selectable from the native Quick Pick");
}

{
  const fake = createFakeVscode({ workspaceFolders: [folder(oneWorkspace)], config: { outputDirectory }, cancelProgressImmediately: true });
  const context = createContext(temp);
  const adapter = createExtensionAdapter(fake.vscode, { loadExporter: async () => ({ async exportArchive(options) {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(options.abortSignal.aborted, true, "VS Code cancellation must reach the shared core");
    throw Object.assign(new Error("Cancelled"), { code: "EXPORT_CANCELLED" });
  } }) });
  await adapter.activate(context);
  assert.equal(await adapter.exportCurrentWorkspace(context), undefined);
  assert.equal(context.globalState.values.size, 0);
  assert.equal(fake.messages.some(message => message.type === "error" || message.type === "info"), false);
}

{
  lastOptions = undefined;
  const fake = createFakeVscode({ config: { outputDirectory }, quickPickSelector: (items, options) => {
    if (options?.placeHolder === "Choose what to export") return items.find((item) => item.label === "All Sessions");
    if (options?.placeHolder === "Choose an export profile") return items.find((item) => item.label === "Readable export");
    return items.find((item) => item.label === "Add DOCX");
  } });
  const context = createContext(temp);
  const adapter = createExtensionAdapter(fake.vscode, { loadExporter: async () => exporter });
  await adapter.activate(context);
  await fake.registered.get(COMMANDS.exportMenu)();
  assert.deepEqual(lastOptions.documentFormats, ["docx"], "the adapter must pass the shared explicit document-format contract");
}

{
  lastOptions = undefined;
  const fake = createFakeVscode({ config: { outputDirectory }, quickPickSelector: (items, options) => {
    if (options?.placeHolder === "Choose what to export") return items.find((item) => item.label === "All Sessions");
    if (options?.placeHolder === "Choose an export profile") return items.find((item) => item.label === "Readable export");
    return items.find((item) => item.label === "Add PDF");
  } });
  const context = createContext(temp);
  const adapter = createExtensionAdapter(fake.vscode, { loadExporter: async () => exporter });
  await adapter.activate(context);
  await fake.registered.get(COMMANDS.exportMenu)();
  assert.deepEqual(lastOptions.documentFormats, ["pdf"], "Add PDF must pass the same shared explicit document-format contract");
}

{
  let exportCalled = false;
  const fake = createFakeVscode({ quickPickItem: undefined, config: { diagnosticOutput: true } });
  const context = createContext(temp);
  const adapter = createExtensionAdapter(fake.vscode, { loadExporter: async () => ({ exportArchive: async () => { exportCalled = true; } }) });
  const activation = await adapter.activate(context);
  assert.equal(await fake.registered.get(COMMANDS.exportMenu)(), undefined, "cancelling the central quick pick should stop cleanly");
  assert.equal(exportCalled, false);
  assert.equal(activation.getDiagnosticEvents().at(-1).status, "CANCELLED", "cancellation before scope selection must not be reported as completed");
}

{
  let exportCalled = false;
  const fake = createFakeVscode({ quickPickSelector: (items, options) => options?.placeHolder === "Choose what to export" ? items[0] : undefined, config: { diagnosticOutput: true } });
  const context = createContext(temp);
  const adapter = createExtensionAdapter(fake.vscode, { loadExporter: async () => ({ exportArchive: async () => { exportCalled = true; } }) });
  const activation = await adapter.activate(context);
  assert.equal(await fake.registered.get(COMMANDS.exportMenu)(), undefined, "cancelling the profile quick pick should stop cleanly");
  assert.equal(exportCalled, false);
  assert.equal(fake.openDialogs.length, 0, "profile cancellation must not ask for or write an output folder");
  assert.equal(activation.getDiagnosticEvents().at(-1).status, "CANCELLED", "cancellation before profile selection must not be reported as completed");
}

{
  let exportCalled = false;
  const fake = createFakeVscode({ quickPickSelector: (items, options) => {
    if (options?.placeHolder === "Choose what to export") return items[0];
    if (options?.placeHolder === "Choose an export profile") return items[0];
    return undefined;
  }, config: { diagnosticOutput: true } });
  const context = createContext(temp);
  const adapter = createExtensionAdapter(fake.vscode, { loadExporter: async () => ({ exportArchive: async () => { exportCalled = true; } }) });
  const activation = await adapter.activate(context);
  assert.equal(await fake.registered.get(COMMANDS.exportMenu)(), undefined, "cancelling the document-format quick pick should stop cleanly");
  assert.equal(exportCalled, false);
  assert.equal(fake.openDialogs.length, 0, "format cancellation must happen before output selection");
  assert.equal(activation.getDiagnosticEvents().at(-1).status, "CANCELLED");
}

{
  const singularExporter = {
    async exportArchive(options) {
      return { outputDirectory: options.outputDirectory, htmlIndexPath: path.join(options.outputDirectory, "index.html"), manifestPath: path.join(options.outputDirectory, "manifest.json"), exportedProjectCount: 1, exportedSessionCount: 1, warnings: [] };
    },
  };
  const fake = createFakeVscode({ config: { outputDirectory } });
  const context = createContext(temp);
  const adapter = createExtensionAdapter(fake.vscode, { loadExporter: async () => singularExporter });
  await adapter.activate(context);
  await adapter.exportAllSessions(context);
  assert.match(fake.messages.find((message) => message.type === "info").message, /1 session across 1 project/);
}

{
  const fake = createFakeVscode({ workspaceFolders: [folder(oneWorkspace), folder(twoWorkspace)], quickPickItem: { folder: folder(twoWorkspace) }, config: { outputDirectory } });
  const context = createContext(temp);
  const adapter = createExtensionAdapter(fake.vscode, { loadExporter: async () => exporter });
  await adapter.activate(context);
  assert.equal(await adapter.getLocalWorkspacePath(), twoWorkspace, "multi-root workspace should use quick pick selection");
}

{
  const fake = createFakeVscode({ workspaceFolders: [] });
  const adapter = createExtensionAdapter(fake.vscode, { loadExporter: async () => exporter });
  assert.equal(await adapter.getLocalWorkspacePath(), "", "missing workspace should abort clearly");
  assert.match(fake.messages.at(-1).message, /Open a local folder/);
}

{
  const fake = createFakeVscode({ workspaceFolders: [folder("vscode-remote://ssh/project", "vscode-remote")] });
  const adapter = createExtensionAdapter(fake.vscode, { loadExporter: async () => exporter });
  assert.equal(await adapter.getLocalWorkspacePath(), "", "remote workspace should be rejected");
  assert.match(fake.messages.at(-1).message, /Remote, virtual, and non-file/);
}

{
  const fake = createFakeVscode({ workspaceFolders: [folder(oneWorkspace)], remoteName: "ssh-remote" });
  const adapter = createExtensionAdapter(fake.vscode, { loadExporter: async () => exporter });
  assert.rejects(() => adapter.getLocalWorkspacePath(), /Remote extension hosts are not supported/);
}

{
  const fake = createFakeVscode({ workspaceFolders: [folder(oneWorkspace)], config: { outputDirectory, pathStyle: "readable", includeTools: true, codexHome: path.join(temp, ".codex") } });
  const context = createContext(temp);
  const adapter = createExtensionAdapter(fake.vscode, { loadExporter: async () => exporter });
  await adapter.activate(context);
  const result = await adapter.exportAllSessions(context);
  assert.equal(lastOptions.scope, "all");
  assert.equal("includeOriginalJsonl" in lastOptions, false, "the removed VS Code legacy setting must not reach the shared core");
  assert.equal(lastOptions.exportProfile, "complete", "hidden compatibility commands use the complete profile");
  assert.equal(lastOptions.pathStyle, "readable");
  assert.equal(lastOptions.includeTools, true);
  assert.deepEqual(lastOptions.documentFormats, [], "hidden compatibility commands must not enable DOCX");
  assert.equal(result.exportedSessionCount, 4);
}

{
  const callsBeforeWorkspaceToolOverride = exportCallCount;
  const fake = createFakeVscode({ config: { outputDirectory }, configScopes: { includeTools: { workspaceValue: true } } });
  const context = createContext(temp);
  const adapter = createExtensionAdapter(fake.vscode, { loadExporter: async () => exporter });
  await adapter.activate(context);
  await assert.rejects(() => adapter.exportAllSessions(context), /includeTools.*User settings/);
  assert.equal(exportCallCount, callsBeforeWorkspaceToolOverride, "workspace-controlled includeTools must fail before the export core runs");
}

{
  assert.equal(resolveConfiguredProfile("source-snapshots"), "source-snapshots");
  assert.equal(resolveConfiguredProfile(), "complete");
}

{
  lastOptions = undefined;
  const fake = createFakeVscode({ config: { outputDirectory } });
  const context = createContext(temp);
  const adapter = createExtensionAdapter(fake.vscode, { loadExporter: async () => exporter });
  await adapter.activate(context);
  await adapter.exportAllSessions(context);
  assert.equal(lastOptions.exportProfile, "complete", "hidden compatibility commands must remain deterministic without a profile setting");
}

{
  let exportCalled = false;
  const fake = createFakeVscode({ config: { outputDirectory: path.join("relative", "archives") } });
  const context = createContext(temp);
  const adapter = createExtensionAdapter(fake.vscode, { loadExporter: async () => ({ exportArchive: async () => { exportCalled = true; } }) });
  await adapter.activate(context);
  assert.equal(await adapter.exportAllSessions(context), undefined, "relative configured output folders must fail closed");
  assert.equal(exportCalled, false, "the shared core must not run with a relative VS Code output folder");
  assert.match(fake.messages.at(-1).message, /relative[\\/]archives/);
  assert.match(fake.messages.at(-1).message, /codexProjectChatExporter\.outputDirectory/);
  assert.match(fake.messages.at(-1).message, /Codex-Exports/);
}

{
  let exportCalled = false;
  const workspaceOutput = path.join(temp, "workspace-controlled-output");
  const fake = createFakeVscode({ configScopes: { outputDirectory: { workspaceValue: workspaceOutput } } });
  const context = createContext(temp);
  const adapter = createExtensionAdapter(fake.vscode, { loadExporter: async () => ({ exportArchive: async () => { exportCalled = true; } }) });
  await adapter.activate(context);
  await assert.rejects(() => adapter.exportAllSessions(context), /must be configured in VS Code User settings/);
  assert.equal(exportCalled, false, "workspace-scoped outputDirectory must never reach the exporter");
}

{
  let exportCalled = false;
  const workspaceCodexHome = path.join(temp, "workspace-controlled-codex-home");
  const fake = createFakeVscode({ config: { outputDirectory }, configScopes: { codexHome: { workspaceFolderValue: workspaceCodexHome } } });
  const context = createContext(temp);
  const adapter = createExtensionAdapter(fake.vscode, { loadExporter: async () => ({ exportArchive: async () => { exportCalled = true; } }) });
  await adapter.activate(context);
  await assert.rejects(() => adapter.exportAllSessions(context), /must be configured in VS Code User settings/);
  assert.equal(exportCalled, false, "workspace-folder codexHome must never reach the exporter");
}

{
  let exportCalled = false;
  const fake = createFakeVscode({ config: { outputDirectory: "\\\\server\\share\\exports" } });
  const context = createContext(temp);
  const adapter = createExtensionAdapter(fake.vscode, { loadExporter: async () => ({ exportArchive: async () => { exportCalled = true; } }) });
  await adapter.activate(context);
  assert.equal(await adapter.exportAllSessions(context), undefined, "UNC export targets must fail closed");
  assert.equal(exportCalled, false);
  assert.match(fake.messages.at(-1).message, /network or device path/);
}

{
  let exportCalled = false;
  const fake = createFakeVscode({ config: { outputDirectory }, isTrusted: false });
  const context = createContext(temp);
  const adapter = createExtensionAdapter(fake.vscode, { loadExporter: async () => ({ exportArchive: async () => { exportCalled = true; } }) });
  await adapter.activate(context);
  await assert.rejects(() => adapter.exportAllSessions(context), /disabled in untrusted VS Code workspaces/);
  assert.equal(exportCalled, false);
}

{
  const fake = createFakeVscode({ openDialogResult: [{ fsPath: outputDirectory }] });
  const context = createContext(temp);
  const adapter = createExtensionAdapter(fake.vscode, { loadExporter: async () => ({ exportArchive: async () => { throw Object.assign(new Error("Synthetic core failure"), { code: "SYNTHETIC" }); } }) });
  await adapter.activate(context);
  await assert.rejects(() => adapter.exportAllSessions(context), /Synthetic core failure/);
  assert.match(fake.messages.at(-1).message, /SYNTHETIC: Synthetic core failure/);
  assert.equal(context.globalState.get(STATE_OUTPUT_DIR, ""), "", "a failed export must not remember even a newly selected output folder");
  assert.equal(context.globalState.get(STATE_LATEST_HTML, ""), "", "a failed export must not update the latest index");
}

{
  const latestOutput = path.join(temp, "open-latest-output");
  const fake = createFakeVscode({ openDialogResult: [{ fsPath: latestOutput }] });
  const context = createContext(temp);
  const adapter = createExtensionAdapter(fake.vscode, { loadExporter: async () => exporter });
  await adapter.activate(context);
  assert.equal(await adapter.openLatestArchive(context), false);
  assert.match(fake.messages.at(-1).message, /No latest Codex export/);
  await adapter.exportAllSessions(context, "readable");
  const html = path.join(latestOutput, "index.html");
  assert.equal(await adapter.openLatestArchive(context), true);
  assert.equal(fake.opened.at(-1), html);
}

{
  const incompleteOutput = path.join(temp, "open-incomplete-output");
  const fake = createFakeVscode({ openDialogResult: [{ fsPath: incompleteOutput }] });
  const context = createContext(temp);
  const adapter = createExtensionAdapter(fake.vscode, { loadExporter: async () => exporter });
  await adapter.activate(context);
  await adapter.exportAllSessions(context, "readable");
  await fsp.writeFile(path.join(incompleteOutput, "EXPORT_INCOMPLETE.txt"), "Status: INCOMPLETE\n", "utf8");
  assert.equal(await adapter.openLatestArchive(context), false, "Open Latest Export must reject a generation with an incomplete marker");
  assert.match(fake.messages.at(-1).message, /EXPORT_INCOMPLETE\.txt is present/);
  assert.equal(await adapter.openExportFolder(context), false, "Open Export Folder must reject a generation with an incomplete marker");
  assert.match(fake.messages.at(-1).message, /new empty export folder/i);
  assert.equal(fake.opened.length, 0, "no target from an incomplete generation may be opened");
}

{
  const incompleteResultOutput = path.join(temp, "incomplete-result-output");
  const incompleteExporter = {
    async exportArchive(options) {
      await fsp.mkdir(options.outputDirectory, { recursive: true });
      const htmlIndexPath = path.join(options.outputDirectory, "index.html");
      const manifestPath = path.join(options.outputDirectory, "manifest.json");
      await fsp.writeFile(htmlIndexPath, "<html></html>", "utf8");
      await fsp.writeFile(manifestPath, "{}\n", "utf8");
      await fsp.writeFile(path.join(options.outputDirectory, "EXPORT_INCOMPLETE.txt"), "Status: INCOMPLETE\n", "utf8");
      return { outputDirectory: options.outputDirectory, htmlIndexPath, manifestPath, exportedProjectCount: 1, exportedSessionCount: 1, warnings: [] };
    },
  };
  const fake = createFakeVscode({ openDialogResult: [{ fsPath: incompleteResultOutput }] });
  const context = createContext(temp);
  const adapter = createExtensionAdapter(fake.vscode, { loadExporter: async () => incompleteExporter });
  await adapter.activate(context);
  await assert.rejects(() => adapter.exportAllSessions(context, "readable"), /EXPORT_INCOMPLETE\.txt is present/);
  assert.equal(context.globalState.get(STATE_OUTPUT_DIR, ""), "", "an incomplete result must not become the latest export folder");
  assert.equal(context.globalState.get(STATE_LATEST_HTML, ""), "", "an incomplete result must not become the latest HTML index");
}

{
  const fake = createFakeVscode({});
  const context = createContext(temp);
  const adapter = createExtensionAdapter(fake.vscode, { loadExporter: async () => exporter });
  await adapter.activate(context);
  await context.globalState.update(STATE_LATEST_HTML, "\\\\server\\share\\index.html");
  assert.equal(await adapter.openLatestArchive(context), false, "a remembered UNC index must not be opened");
  assert.equal(fake.opened.length, 0);
  assert.match(fake.messages.at(-1).message, /network or device path/);
}

{
  const rememberedOutput = path.join(temp, "remembered-open-folder");
  const configuredButUnused = path.join(temp, "configured-but-unused");
  const fake = createFakeVscode({ config: { outputDirectory: configuredButUnused }, openDialogResult: [{ fsPath: rememberedOutput }] });
  const context = createContext(temp);
  const adapter = createExtensionAdapter(fake.vscode, { loadExporter: async () => exporter });
  await adapter.activate(context);
  assert.equal(await adapter.openExportFolder(context), false, "a configured folder without a completed export must not be confused with the last verified export");
  fake.config.delete("outputDirectory");
  await adapter.exportAllSessions(context, "readable");
  assert.equal(await adapter.openExportFolder(context), true);
  assert.equal(fake.opened.at(-1), rememberedOutput);
}

{
  const fake = createFakeVscode({});
  const context = createContext(temp);
  const adapter = createExtensionAdapter(fake.vscode, { loadExporter: async () => exporter });
  await adapter.activate(context);
  await context.globalState.update(STATE_OUTPUT_DIR, "\\\\server\\share\\exports");
  assert.equal(await adapter.openExportFolder(context), false, "a remembered UNC output folder must not be opened");
  assert.equal(fake.opened.length, 0);
  assert.match(fake.messages.at(-1).message, /network or device path/);
}

{
  const swappedOutput = path.join(temp, "swapped-open-output");
  const movedOutput = path.join(temp, "swapped-open-output-original");
  const fake = createFakeVscode({ openDialogResult: [{ fsPath: swappedOutput }] });
  const context = createContext(temp);
  const adapter = createExtensionAdapter(fake.vscode, { loadExporter: async () => exporter });
  await adapter.activate(context);
  await adapter.exportAllSessions(context, "readable");
  await fsp.rename(swappedOutput, movedOutput);
  await fsp.mkdir(swappedOutput, { recursive: true });
  await fsp.writeFile(path.join(swappedOutput, "index.html"), "replacement", "utf8");
  assert.equal(await adapter.openExportFolder(context), false, "a replaced output directory must be rejected");
  assert.equal(await adapter.openLatestArchive(context), false, "an index below a replaced output directory must be rejected");
  assert.match(fake.messages.at(-1).message, /changed after export/);
}

{
  const replacedIndexOutput = path.join(temp, "replaced-index-output");
  const fake = createFakeVscode({ openDialogResult: [{ fsPath: replacedIndexOutput }] });
  const context = createContext(temp);
  const adapter = createExtensionAdapter(fake.vscode, { loadExporter: async () => exporter });
  await adapter.activate(context);
  await adapter.exportAllSessions(context, "readable");
  const indexPath = path.join(replacedIndexOutput, "index.html");
  const originalIndexPath = path.join(replacedIndexOutput, "index-original.html");
  const storedIndex = context.globalState.get(STATE_LATEST_HTML_TARGET);
  const originalCanonicalPath = await fsp.realpath(indexPath);
  const originalStat = await fsp.stat(indexPath, { bigint: true });
  assert.equal(storedIndex.canonicalPath, originalCanonicalPath, "the stored canonical index path must describe the original file");
  assert.equal(storedIndex.identity, testFileIdentity(originalStat), "the stored identity must match the original index file");
  await fsp.rename(indexPath, originalIndexPath);
  await fsp.writeFile(indexPath, Buffer.alloc(Number(originalStat.size), 0x78));
  const replacementCanonicalPath = await fsp.realpath(indexPath);
  const replacementStat = await fsp.stat(indexPath, { bigint: true });
  assert.equal(replacementCanonicalPath, originalCanonicalPath, "the replacement must occupy the same canonical index path");
  assert.equal(replacementStat.isFile(), true, "the replacement must be a regular file");
  assert.equal(replacementStat.size, originalStat.size, "the replacement must have the same size as the original index");
  assert.notEqual(
    testFileIdentity(replacementStat),
    testFileIdentity(originalStat),
    `the fixture must create a distinct filesystem identity: ${JSON.stringify({ original: testFileEvidence(originalStat), replacement: testFileEvidence(replacementStat) })}`,
  );
  console.log(`index replacement identity evidence: ${JSON.stringify({ canonical_path: "same exported index path", stored_identity: storedIndex.identity, original: testFileEvidence(originalStat), replacement: testFileEvidence(replacementStat) })}`);
  assert.equal(await adapter.openLatestArchive(context), false, "a replaced index file must be rejected even at the same path");
  assert.equal(await adapter.openExportFolder(context), true, "an unchanged verified output directory remains openable independently of a replaced index");
}

{
  const linkedIndexOutput = path.join(temp, "linked-index-output");
  const outsideIndex = path.join(temp, "outside-index.html");
  const fake = createFakeVscode({ openDialogResult: [{ fsPath: linkedIndexOutput }] });
  const context = createContext(temp);
  const adapter = createExtensionAdapter(fake.vscode, { loadExporter: async () => exporter });
  await adapter.activate(context);
  await adapter.exportAllSessions(context, "readable");
  const indexPath = path.join(linkedIndexOutput, "index.html");
  await fsp.writeFile(outsideIndex, "outside", "utf8");
  await fsp.unlink(indexPath);
  try {
    await fsp.symlink(outsideIndex, indexPath, "file");
    assert.equal(await adapter.openLatestArchive(context), false, "a symlinked index outside the verified export must be rejected");
  } catch (error) {
    if (!["EPERM", "EACCES", "ENOSYS"].includes(error?.code)) throw error;
  }
}

{
  const junctionOutput = path.join(temp, "junction-open-output");
  const movedOutput = path.join(temp, "junction-open-output-original");
  const outsideDirectory = path.join(temp, "junction-outside-directory");
  const fake = createFakeVscode({ openDialogResult: [{ fsPath: junctionOutput }] });
  const context = createContext(temp);
  const adapter = createExtensionAdapter(fake.vscode, { loadExporter: async () => exporter });
  await adapter.activate(context);
  await adapter.exportAllSessions(context, "readable");
  await fsp.rename(junctionOutput, movedOutput);
  await fsp.mkdir(outsideDirectory, { recursive: true });
  try {
    await fsp.symlink(outsideDirectory, junctionOutput, process.platform === "win32" ? "junction" : "dir");
    assert.equal(await adapter.openExportFolder(context), false, "a junction or directory symlink replacing the verified export folder must be rejected");
    assert.equal(await adapter.openLatestArchive(context), false, "an index reached through a replaced export-folder junction must be rejected");
  } catch (error) {
    if (!["EPERM", "EACCES", "ENOSYS"].includes(error?.code)) throw error;
  }
}

{
  const realCodexHome = path.join(temp, "real-core-codex-home");
  const realSessionsDir = path.join(realCodexHome, "sessions", "2026", "08", "16");
  const directOutput = path.join(temp, "real-core-direct-output");
  const adapterOutput = path.join(temp, "real-core-adapter-output");
  const directPdfOutput = path.join(temp, "real-core-direct-pdf-output");
  const adapterPdfOutput = path.join(temp, "real-core-adapter-pdf-output");
  await fsp.mkdir(realSessionsDir, { recursive: true });
  const realSource = path.join(realSessionsDir, "rollout-real-adapter.jsonl");
  const realItems = [
    { type: "session_meta", timestamp: "2026-08-16T12:00:00.000Z", payload: { id: "real-adapter-session", cwd: oneWorkspace, timestamp: "2026-08-16T12:00:00.000Z", source: "vscode", thread_source: "user" } },
    { type: "response_item", timestamp: "2026-08-16T12:00:00.500Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions\n<environment_context>automatic</environment_context>" }], internal_chat_message_metadata_passthrough: { turn_id: "turn-real" } } },
    { type: "response_item", timestamp: "2026-08-16T12:00:01.000Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Export through both entry points." }], internal_chat_message_metadata_passthrough: { turn_id: "turn-real" } } },
    { type: "event_msg", timestamp: "2026-08-16T12:00:01.000Z", payload: { type: "user_message", message: "Export through both entry points." } },
    { type: "event_msg", timestamp: "2026-08-16T12:00:02.000Z", payload: { type: "agent_message", message: "Equivalent output." } },
    { type: "response_item", timestamp: "2026-08-16T12:00:02.000Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Equivalent output." }] } },
  ];
  await fsp.writeFile(realSource, `${realItems.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
  const corePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "bin", "export-codex-project-chats.mjs");
  const realExporter = await import(pathToFileURL(corePath).href);
  const directResult = await realExporter.exportArchive({ codexHome: realCodexHome, scope: "all", outputDirectory: directOutput, pathStyle: "readable", documentFormats: ["docx"] });

  const fake = createFakeVscode({ config: { outputDirectory: adapterOutput, codexHome: realCodexHome, pathStyle: "readable" } });
  const context = createContext(temp);
  const adapter = createExtensionAdapter(fake.vscode, { loadExporter: async () => realExporter });
  await adapter.activate(context);
  const adapterResult = await adapter.exportAllSessions(context, undefined, ["docx"]);
  const directManifest = JSON.parse(await fsp.readFile(directResult.manifestPath, "utf8"));
  const adapterManifest = JSON.parse(await fsp.readFile(adapterResult.manifestPath, "utf8"));
  for (const manifest of [directManifest, adapterManifest]) {
    for (const session of manifest.sessions) assert.equal(new Date(session.raw_verified_at).toISOString(), session.raw_verified_at);
  }
  const stableSessionMetadata = ({ raw_verified_at, ...session }) => session;
  assert.deepEqual(adapterManifest.sessions.map(stableSessionMetadata), directManifest.sessions.map(stableSessionMetadata), "VS Code delegation and direct shared-core use must produce identical stable session metadata");
  for (const session of directManifest.sessions) {
    assert.equal(await fsp.readFile(path.join(adapterOutput, session.markdown_file), "utf8"), await fsp.readFile(path.join(directOutput, session.markdown_file), "utf8"));
    assert.deepEqual(await fsp.readFile(path.join(adapterOutput, session.raw_export_file)), await fsp.readFile(path.join(directOutput, session.raw_export_file)));
    assert.deepEqual(await fsp.readFile(path.join(adapterOutput, session.docx_file)), await fsp.readFile(path.join(directOutput, session.docx_file)), "VS Code and direct shared-core DOCX bytes must match");
  }

  const directPdfResult = await realExporter.exportArchive({ codexHome: realCodexHome, scope: "all", outputDirectory: directPdfOutput, pathStyle: "readable", documentFormats: ["pdf"] });
  const pdfFake = createFakeVscode({ config: { outputDirectory: adapterPdfOutput, codexHome: realCodexHome, pathStyle: "readable" } });
  const pdfContext = createContext(temp);
  const pdfAdapter = createExtensionAdapter(pdfFake.vscode, { loadExporter: async () => realExporter });
  await pdfAdapter.activate(pdfContext);
  const adapterPdfResult = await pdfAdapter.exportAllSessions(pdfContext, undefined, ["pdf"]);
  const directPdfManifest = JSON.parse(await fsp.readFile(directPdfResult.manifestPath, "utf8"));
  const adapterPdfManifest = JSON.parse(await fsp.readFile(adapterPdfResult.manifestPath, "utf8"));
  assert.deepEqual(adapterPdfManifest.sessions.map(stableSessionMetadata), directPdfManifest.sessions.map(stableSessionMetadata), "VS Code and direct shared-core PDF metadata must match");
  for (const session of directPdfManifest.sessions) {
    assert.deepEqual(await fsp.readFile(path.join(adapterPdfOutput, session.pdf_file)), await fsp.readFile(path.join(directPdfOutput, session.pdf_file)), "VS Code and direct shared-core PDF bytes must match");
  }

  if (process.platform === "win32") {
    const identityOutput = path.join(temp, "real-core-workspace-identity-output");
    const workspaceVariant = `${oneWorkspace[0].toLowerCase()}${oneWorkspace.slice(1)}\\`;
    const identityFake = createFakeVscode({ workspaceFolders: [folder(workspaceVariant)], config: { outputDirectory: identityOutput, codexHome: realCodexHome } });
    const identityContext = createContext(temp);
    let identityOptions;
    const identityAdapter = createExtensionAdapter(identityFake.vscode, { loadExporter: async () => ({ ...realExporter, exportArchive(options) { identityOptions = options; return realExporter.exportArchive(options); } }) });
    await identityAdapter.activate(identityContext);
    const identityResult = await identityAdapter.exportCurrentWorkspace(identityContext);
    assert.equal(identityResult.exportedSessionCount, 1);
    assert.equal(identityOptions.workspacePath, workspaceVariant, "the adapter must pass uri.fsPath to the shared core without rewriting it");
    assert.equal(identityFake.messages.some(message => message.message.startsWith("No sessions were recorded")), false, "a Windows-equivalent workspace spelling must not enter historical recovery");
  }
}

// Recovery is explicit at every boundary and never stores a cwd alias.
for (const mode of ["recover", "menu", "dismiss-recovery", "dismiss-picker", "dismiss-confirmation"]) {
  const recorded = { cwd: "/synthetic/historical", sessionCount: 2, sourceBytes: 12345, lastSessionAt: "2026-08-02T10:00:00.000Z" };
  let selected;
  const fake = createFakeVscode({ workspaceFolders: [folder(oneWorkspace)], config: { outputDirectory },
    warningSelector: (message) => message.startsWith("No sessions were recorded")
      ? (mode === "dismiss-recovery" ? undefined : "Choose recorded project path…")
      : (mode === "dismiss-confirmation" ? undefined : "Export recorded sessions"),
    quickPickSelector: (items, options) => {
      if (options.placeHolder === "Choose what to export") return items.find(item => item.scope === "recorded-project");
      if (options.placeHolder === "Choose recorded project path…") return mode === "dismiss-picker" ? undefined : items[0];
      return items[0];
    },
  });
  const context = createContext(temp);
  const adapter = createExtensionAdapter(fake.vscode, { loadExporter: async () => ({ async exportArchive(options) {
    selected = await options.onSelectRecordedProject({ projects: [recorded], reason: mode === "menu" ? "requested" : "no-match" });
    if (selected === null) throw Object.assign(new Error("Cancelled"), { code: "EXPORT_CANCELLED" });
    return exporter.exportArchive(options);
  } }) });
  await adapter.activate(context);
  const result = mode === "menu" ? await adapter.exportFromQuickPick(context) : await adapter.exportCurrentWorkspace(context);
  if (mode.startsWith("dismiss")) {
    assert.equal(result, undefined);
    assert.equal(selected, null);
    assert.equal(context.globalState.values.size, 0);
    assert.equal(fake.messages.some(m => m.type === "info" || m.type === "error"), false);
  } else {
    assert.equal(selected, recorded.cwd);
    const picker = fake.quickPicks.find(p => p.options.placeHolder === "Choose recorded project path…");
    assert.equal(picker.items[0].label, recorded.cwd);
    assert.ok(picker.items[0].description.includes("2 sessions") && picker.items[0].description.includes("12345 bytes"));
    assert.ok(picker.items[0].detail.includes(recorded.lastSessionAt));
    const confirmation = fake.messages.find(m => m.message.includes("Several logically different projects"));
    assert.deepEqual(confirmation.actions, [{ modal: true }, "Export recorded sessions"]);
    assert.equal([...context.globalState.values.values()].includes(recorded.cwd), false);
    if (mode === "menu") assert.equal(lastOptions.scope, "recorded-project");
  }
}

const after = await fsp.readFile(sourceFile, "utf8");
assert.equal(after, before, "synthetic source data must not be modified");

await fsp.rm(temp, { recursive: true, force: true });
console.log("VS Code adapter tests passed");
