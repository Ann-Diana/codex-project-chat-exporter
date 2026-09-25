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
const { SIDEBAR_VIEW, COMMANDS, DIAGNOSTIC_BUILD_ID, DOCUMENT_FORMATS, EXPORT_PROFILES, EXPORT_SCOPES, STATE_LAST_SUCCESS, STATE_LATEST_HTML, STATE_LATEST_HTML_TARGET, STATE_OUTPUT_DIR, STATE_OUTPUT_TARGET, createExtensionAdapter: createExtensionAdapterCore, defaultLoadExporter, formatExportSummary, isWindowsNetworkOrDevicePath, resolveConfiguredProfile } = require("../src/vscode-adapter.cjs");

function createExtensionAdapter(vscode, injected = {}) {
  const recordedPathIdentity = (value) => String(value || "").replaceAll("/", "\\").replace(/[\\]+$/, "").toLowerCase();
  return createExtensionAdapterCore(vscode, {
    discoverRecordedProjectInventory: defaultInventoryProvider,
    recordedPathIdentity,
    sameRecordedPathIdentity: (left, right) => recordedPathIdentity(left) === recordedPathIdentity(right),
    ...injected,
  });
}

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
  const treeProviders = new Map();
  const executed = [];
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
    TreeItemCollapsibleState: { None: 0 },
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
      registerTreeDataProvider: (id, provider) => { treeProviders.set(id, provider); return { dispose: () => treeProviders.delete(id) }; },
      createOutputChannel: () => ({ appendLine: (line) => output.push(line), show: () => {}, dispose: () => {} }),
      showWarningMessage: async (message, ...actions) => { messages.push({ type: "warning", message, actions }); return overrides.warningSelector?.(message, actions); },
      showErrorMessage: async (message, ...actions) => { messages.push({ type: "error", message, actions }); return overrides.errorMessageHandler?.(message, actions); },
      showInformationMessage: async (message, ...actions) => { messages.push({ type: "info", message, actions }); return overrides.infoMessageHandler ? overrides.infoMessageHandler(message, actions) : overrides.infoAction; },
      showQuickPick: async (items, options) => {
        quickPicks.push({ items, options });
        if (overrides.quickPickSelector) return overrides.quickPickSelector(items, options);
        if (Object.prototype.hasOwnProperty.call(overrides, "quickPickItem")) return overrides.quickPickItem;
        return items[0];
      },
      showOpenDialog: async (options) => { openDialogs.push(options); return overrides.openDialogSelector ? overrides.openDialogSelector(options) : overrides.openDialogResult || []; },
      withProgress: async (options, task) => {
        progressCalls.push(options);
        const callbacks = [];
        const result = task({ report: (event) => { overrides.progressReportHandler?.(event); progressReports.push(event); } }, { onCancellationRequested(callback) { callbacks.push(callback); return { dispose() {} }; } });
        if (overrides.cancelProgressImmediately) callbacks.forEach(callback => callback());
        return result;
      },
    },
    commands: {
      executeCommand: async (command, ...args) => { executed.push({ command, args }); return registered.get(command)?.(...args); },
      registerCommand: (name, callback) => { registered.set(name, callback); return { dispose: () => registered.delete(name) }; },
    },
  };
  return { vscode, registered, treeProviders, executed, messages, opened, output, quickPicks, openDialogs, progressCalls, progressReports, config };
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

async function defaultInventoryProvider() {
  return {
    sessionCount: 4,
    projects: [{
      cwd: oneWorkspace,
      recordedPaths: [oneWorkspace],
      sessionCount: 2,
      sourceBytes: 12_345,
      firstSessionAt: "2026-08-01T10:00:00.000Z",
      lastSessionAt: "2026-08-02T10:00:00.000Z",
    }],
  };
}

let lastOptions;
let exportCallCount = 0;
const exporter = {
  recordedPathIdentity(value) { return String(value || "").replaceAll("/", "\\").replace(/[\\]+$/, "").toLowerCase(); },
  sameRecordedPathIdentity(left, right) {
    const normalize = (value) => String(value || "").replaceAll("/", "\\").replace(/[\\]+$/, "").toLowerCase();
    return normalize(left) === normalize(right);
  },
  async readSessionDiscoveryMeta() { throw new Error("The injected adapter inventory must own synthetic discovery"); },
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
    openSettings: "codexArchive.openSettings",
  }, "existing internal command IDs must remain stable");
  assert.deepEqual(extensionPackage.contributes.commands.map(({ command, title }) => ({ command, title })), [
    { command: COMMANDS.exportMenu, title: "Codex Export: Export…" },
    { command: COMMANDS.openLatestArchive, title: "Codex Export: Open Latest Export" },
    { command: COMMANDS.openExportFolder, title: "Codex Export: Open Export Folder" },
    { command: COMMANDS.openSettings, title: "Codex Export: Extension Settings" },
  ], "exactly four Codex Export commands should be visible in extension metadata");
  assert.deepEqual(extensionPackage.activationEvents, [...Object.values(COMMANDS).map((command) => `onCommand:${command}`), `onView:${SIDEBAR_VIEW}`]);
  assert.deepEqual(EXPORT_PROFILES.map(({ label, profile }) => ({ label, profile })), [
    { label: "Complete export", profile: "complete" },
    { label: "Readable export", profile: "readable" },
    { label: "Source snapshots", profile: "source-snapshots" },
  ]);
  assert.equal("codexProjectChatExporter.includeOriginalJsonl" in extensionPackage.contributes.configuration.properties, false);
  assert.equal("codexProjectChatExporter.exportProfile" in extensionPackage.contributes.configuration.properties, false);
  assert.equal(extensionPackage.version, "0.2.1", "the Marketplace candidate must install as a distinguishable extension version");
  assert.equal(extensionPackage.contributes.configuration.properties["codexProjectChatExporter.diagnosticOutput"].default, false);
  assert.equal(extensionPackage.contributes.configuration.properties["codexProjectChatExporter.outputDirectory"].scope, "machine");
  assert.equal(extensionPackage.contributes.configuration.properties["codexProjectChatExporter.codexHome"].scope, "machine");
  assert.equal(extensionPackage.contributes.configuration.properties["codexProjectChatExporter.includeTools"].scope, "application");
  assert.equal(extensionPackage.contributes.configuration.properties["codexProjectChatExporter.includeTools"].description, "Include potentially sensitive Tool, Browser and view_image content and their assets in Markdown, HTML, DOCX and PDF reading views. When disabled, those records and assets are excluded from reading views.");
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
  const currentCandidate = path.join(distDir, "codex-project-chat-exporter-vscode-0.2.1.vsix");
  await fsp.mkdir(distDir, { recursive: true });
  await fsp.writeFile(currentCandidate, "previous candidate", "utf8");
  const result = await buildVsix({
    distDir,
    archiveWriter: async ({ archivePath }) => fsp.writeFile(archivePath, "synthetic VSIX", "utf8"),
  });
  assert.equal(path.basename(result.vsixPath), "codex-project-chat-exporter-vscode-0.2.1.vsix");
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
  const fake = createFakeVscode({ workspaceFolders: [folder(oneWorkspace)], openDialogResult: [{ scheme: "file", fsPath: outputDirectory }] });
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
  assert.equal(context.globalState.get(STATE_LAST_SUCCESS)?.outputDirectory, outputDirectory);
  assert.equal(context.globalState.get(STATE_LAST_SUCCESS)?.htmlIndexPath, path.join(outputDirectory, "index.html"));
  assert.equal(context.globalState.get(STATE_LAST_SUCCESS)?.output.kind, "directory");
  assert.equal(context.globalState.get(STATE_LAST_SUCCESS)?.index.kind, "file");
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
  assert.equal(context.globalState.get(STATE_LAST_SUCCESS)?.outputDirectory, outputDirectory, "only a completed export may update the remembered output folder");
  assert.equal(context.globalState.get(STATE_LAST_SUCCESS)?.htmlIndexPath, path.join(outputDirectory, "index.html"), "only a completed export may update the latest index");
}

{
  let releaseSuccessMessage;
  let successMessageShown;
  const pendingSuccessMessage = new Promise((resolve) => { releaseSuccessMessage = resolve; });
  const firstSuccessMessageShown = new Promise((resolve) => { successMessageShown = resolve; });
  const fake = createFakeVscode({ config: { outputDirectory }, infoMessageHandler: (message) => {
    if (!message.startsWith("Exported ")) return undefined;
    successMessageShown();
    return pendingSuccessMessage;
  } });
  const context = createContext(temp);
  const adapter = createExtensionAdapter(fake.vscode, { loadExporter: async () => exporter });
  await adapter.activate(context);
  const first = fake.registered.get(COMMANDS.exportAllSessions)();
  let timeout;
  try {
    await firstSuccessMessageShown;
    const settled = await Promise.race([first.then(() => true), new Promise((resolve) => { timeout = setTimeout(() => resolve(false), 500); })]);
    assert.equal(settled, true, "a pending success notification must not retain the export lock or command");
    await fake.registered.get(COMMANDS.exportAllSessions)();
    assert.equal(fake.messages.filter((message) => message.message.startsWith("Exported ")).length, 2, "a second completed export must be accepted without dismissing the first success notification");
  } finally {
    clearTimeout(timeout);
    releaseSuccessMessage();
    await first;
  }
}

{
  let releaseOpen;
  const pendingOpen = new Promise((resolve) => { releaseOpen = resolve; });
  const fake = createFakeVscode({ config: { outputDirectory }, infoAction: "Open HTML Index" });
  fake.vscode.env.openExternal = async (uri) => { fake.opened.push(uri.fsPath); await pendingOpen; return true; };
  const context = createContext(temp);
  const adapter = createExtensionAdapter(fake.vscode, { loadExporter: async () => exporter });
  await adapter.activate(context);
  try {
    await fake.registered.get(COMMANDS.exportAllSessions)();
    await fake.registered.get(COMMANDS.exportAllSessions)();
    assert.equal(fake.messages.filter((message) => message.message.startsWith("Exported ")).length, 2, "an unresolved post-export Open action must not retain the export lock");
  } finally {
    releaseOpen();
  }
}

{
  let releasePublication;
  let publicationStarted;
  let calls = 0;
  const publicationGate = new Promise((resolve) => { releasePublication = resolve; });
  const publicationStartedPromise = new Promise((resolve) => { publicationStarted = resolve; });
  const fake = createFakeVscode({ config: { outputDirectory } });
  const context = createContext(temp);
  const update = context.globalState.update;
  let firstUpdate = true;
  context.globalState.update = async (...args) => {
    if (firstUpdate) {
      firstUpdate = false;
      publicationStarted();
      await publicationGate;
    }
    return update(...args);
  };
  const adapter = createExtensionAdapter(fake.vscode, { loadExporter: async () => ({
    async exportArchive(options) { calls += 1; return exporter.exportArchive(options); },
  }) });
  await adapter.activate(context);
  const first = fake.registered.get(COMMANDS.exportAllSessions)();
  try {
    await publicationStartedPromise;
    assert.equal(await fake.registered.get(COMMANDS.exportAllSessions)(), undefined, "a second start must remain blocked until the successful export state is published");
    assert.equal(calls, 1);
    assert.equal(context.globalState.values.size, 0);
  } finally {
    releasePublication();
    await first;
  }
  await fake.registered.get(COMMANDS.exportAllSessions)();
  assert.equal(calls, 2);
}

{
  let calls = 0;
  const previousOutput = path.join(temp, "remembered-before-upgrade");
  const fake = createFakeVscode({ config: { outputDirectory } });
  const context = createContext(temp);
  await context.globalState.update(STATE_OUTPUT_DIR, previousOutput);
  await context.globalState.update(STATE_LATEST_HTML, path.join(previousOutput, "index.html"));
  const adapter = createExtensionAdapter(fake.vscode, { loadExporter: async () => ({
    async exportArchive(options) {
      calls += 1;
      if (calls === 1) throw new Error("Synthetic export failure");
      return exporter.exportArchive(options);
    },
  }) });
  await adapter.activate(context);
  await assert.rejects(() => fake.registered.get(COMMANDS.exportAllSessions)(), /Synthetic export failure/);
  assert.equal(context.globalState.get(STATE_OUTPUT_DIR), previousOutput, "a failed export must preserve the previously remembered destination");
  assert.equal(context.globalState.get(STATE_LATEST_HTML), path.join(previousOutput, "index.html"));
  await fake.registered.get(COMMANDS.exportAllSessions)();
  assert.equal(calls, 2, "an export failure must release the lock for the next attempt");
  assert.equal(context.globalState.get(STATE_LAST_SUCCESS)?.outputDirectory, outputDirectory);
  assert.ok(fake.output.some((line) => line === "Export failed: Synthetic export failure"));
  assert.ok(fake.output.some((line) => line.startsWith("Exported ")));
}

{
  let calls = 0;
  let releaseCancellationMessage;
  const pendingCancellationMessage = new Promise((resolve) => { releaseCancellationMessage = resolve; });
  const fake = createFakeVscode({ config: { outputDirectory }, infoMessageHandler: (message) => message === "Export cancelled." ? pendingCancellationMessage : undefined });
  const context = createContext(temp);
  const adapter = createExtensionAdapter(fake.vscode, { loadExporter: async () => ({
    async exportArchive(options) {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error("Synthetic cancellation"), { code: "EXPORT_CANCELLED" });
      return exporter.exportArchive(options);
    },
  }) });
  await adapter.activate(context);
  try {
    assert.equal(await fake.registered.get(COMMANDS.exportAllSessions)(), undefined);
    assert.equal(context.globalState.values.size, 0, "a cancelled export must not update the last-successful-export state");
    await fake.registered.get(COMMANDS.exportAllSessions)();
    assert.equal(calls, 2, "an unresolved cancellation message must not retain the export lock");
  } finally {
    releaseCancellationMessage();
  }
}

{
  let calls = 0;
  const fake = createFakeVscode({ config: { outputDirectory } });
  const context = createContext(temp);
  const adapter = createExtensionAdapter(fake.vscode, { loadExporter: async () => ({
    async exportArchive(options) {
      calls += 1;
      return calls === 1 ? null : exporter.exportArchive(options);
    },
  }) });
  await adapter.activate(context);
  await assert.rejects(() => fake.registered.get(COMMANDS.exportAllSessions)(), "an invalid exporter result must fail before publication");
  assert.equal(context.globalState.values.size, 0);
  await fake.registered.get(COMMANDS.exportAllSessions)();
  assert.equal(calls, 2, "an invalid exporter result must release the lock");
}

{
  let loads = 0;
  const fake = createFakeVscode({ config: { outputDirectory } });
  const context = createContext(temp);
  const adapter = createExtensionAdapter(fake.vscode, { loadExporter: async () => {
    loads += 1;
    if (loads === 1) throw new Error("Synthetic exporter load failure");
    return exporter;
  } });
  await adapter.activate(context);
  await assert.rejects(() => adapter.exportAllSessions(context), /Synthetic exporter load failure/);
  assert.equal(context.globalState.values.size, 0);
  await adapter.exportAllSessions(context);
  assert.equal(loads, 2, "a failed exporter load must release the lock without a reload");
}

{
  let failReport = true;
  const fake = createFakeVscode({ config: { outputDirectory }, progressReportHandler: () => { if (failReport) { failReport = false; throw new Error("Synthetic progress failure"); } } });
  const context = createContext(temp);
  const adapter = createExtensionAdapter(fake.vscode, { loadExporter: async () => exporter });
  await adapter.activate(context);
  await assert.rejects(() => fake.registered.get(COMMANDS.exportAllSessions)(), /Synthetic progress failure/);
  assert.equal(context.globalState.values.size, 0, "a progress UI error must not publish a last-successful-export state");
  await fake.registered.get(COMMANDS.exportAllSessions)();
  assert.equal(context.globalState.get(STATE_LAST_SUCCESS)?.outputDirectory, outputDirectory, "a progress UI error must release the lock");
}

{
  let failUpdate = true;
  const fake = createFakeVscode({ config: { outputDirectory }, infoMessageHandler: () => { throw new Error("Synthetic success notification failure"); } });
  const context = createContext(temp);
  const update = context.globalState.update;
  context.globalState.update = async (...args) => {
    if (failUpdate) { failUpdate = false; throw new Error("Synthetic status failure"); }
    return update(...args);
  };
  const adapter = createExtensionAdapter(fake.vscode, { loadExporter: async () => exporter });
  await adapter.activate(context);
  await assert.rejects(() => fake.registered.get(COMMANDS.exportAllSessions)(), /Synthetic status failure/);
  assert.equal(context.globalState.values.size, 0, "a failed state update must not claim a successful export");
  await fake.registered.get(COMMANDS.exportAllSessions)();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(context.globalState.get(STATE_LAST_SUCCESS)?.outputDirectory, outputDirectory, "a status or notification error must not retain the lock");
  assert.ok(fake.output.some((line) => line.startsWith("Export notification or follow-up action failed")));
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
  assert.equal(fake.messages.some(message => message.type === "error"), false);
  assert.deepEqual(fake.messages.filter(message => message.type === "info").map(message => message.message), ["Export cancelled."]);
  assert.equal(fake.output.at(-1), "Export cancelled.");
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
  assert.match(fake.messages.at(-1).message, /Remote, virtual and non-file/);
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
  const fake = createFakeVscode({ openDialogResult: [{ scheme: "file", fsPath: outputDirectory }] });
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
  const fake = createFakeVscode({ openDialogResult: [{ scheme: "file", fsPath: latestOutput }] });
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
  const fake = createFakeVscode({ openDialogResult: [{ scheme: "file", fsPath: incompleteOutput }] });
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
  const fake = createFakeVscode({ openDialogResult: [{ scheme: "file", fsPath: incompleteResultOutput }] });
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
  assert.match(fake.messages.at(-1).message, /complete, consistent verification/);
}

{
  const rememberedOutput = path.join(temp, "remembered-open-folder");
  const configuredButUnused = path.join(temp, "configured-but-unused");
  const fake = createFakeVscode({ config: { outputDirectory: configuredButUnused }, openDialogResult: [{ scheme: "file", fsPath: rememberedOutput }] });
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
  assert.match(fake.messages.at(-1).message, /complete, consistent verification/);
}

{
  const swappedOutput = path.join(temp, "swapped-open-output");
  const movedOutput = path.join(temp, "swapped-open-output-original");
  const fake = createFakeVscode({ openDialogResult: [{ scheme: "file", fsPath: swappedOutput }] });
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
  const fake = createFakeVscode({ openDialogResult: [{ scheme: "file", fsPath: replacedIndexOutput }] });
  const context = createContext(temp);
  const adapter = createExtensionAdapter(fake.vscode, { loadExporter: async () => exporter });
  await adapter.activate(context);
  await adapter.exportAllSessions(context, "readable");
  const indexPath = path.join(replacedIndexOutput, "index.html");
  const originalIndexPath = path.join(replacedIndexOutput, "index-original.html");
  const storedIndex = context.globalState.get(STATE_LAST_SUCCESS)?.index;
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
  const fake = createFakeVscode({ openDialogResult: [{ scheme: "file", fsPath: linkedIndexOutput }] });
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
  const fake = createFakeVscode({ openDialogResult: [{ scheme: "file", fsPath: junctionOutput }] });
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

assert.deepEqual(EXPORT_SCOPES.map(({ label, detail }) => ({ label, detail })), [
  { label: "Current Workspace", detail: "Export sessions recorded for the folder currently open in VS Code" },
  { label: "Project from Codex history…", detail: "Choose sessions recorded for a different, moved or renamed project folder" },
  { label: "All Sessions", detail: "Export all local Codex sessions" },
]);
assert.deepEqual(DOCUMENT_FORMATS.map(item => item.label), ["Standard formats only", "Add DOCX", "Add PDF", "Add DOCX and PDF"]);

// Historical recovery is resolved before profile, formats, or output and never stores a cwd alias.
for (const mode of ["recover", "menu", "dismiss-recovery", "dismiss-picker", "dismiss-confirmation"]) {
  const recordedVariants = ["C:\\Synthetic\\Historical", "c:/synthetic/historical/"];
  const recorded = {
    cwd: recordedVariants[0],
    recordedPaths: recordedVariants,
    sessionCount: 2,
    sourceBytes: Math.round(5.3 * 1024 ** 3),
    firstSessionAt: "2026-08-01T10:00:00.000Z",
    lastSessionAt: "2026-08-02T10:00:00.000Z",
  };
  const modeOutput = path.join(temp, `historical-${mode}`);
  let coreCalls = 0;
  let selectedOptions;
  let historicalConfirmed = false;
  const fake = createFakeVscode({ workspaceFolders: [folder(oneWorkspace)], config: { outputDirectory: modeOutput },
    warningSelector: (message) => {
      if (message.startsWith("No sessions were recorded")) return mode === "dismiss-recovery" ? undefined : "Choose project from Codex history";
      if (mode === "dismiss-confirmation") return "Cancel";
      historicalConfirmed = true;
      return "Export recorded sessions";
    },
    quickPickSelector: (items, options) => {
      if (options.placeHolder === "Choose what to export") return items.find(item => item.scope === (mode === "menu" ? "recorded-project" : "project"));
      if (options.title === "Choose a project folder from Codex history") return mode === "dismiss-picker" ? undefined : items[0];
      return items[0];
    },
  });
  const context = createContext(temp);
  const adapter = createExtensionAdapter(fake.vscode, {
    discoverRecordedProjectInventory: async () => ({ sessionCount: 2, projects: [recorded] }),
    loadExporter: async () => ({ ...exporter, async exportArchive(options) {
      coreCalls += 1;
      selectedOptions = options;
      assert.equal(historicalConfirmed, true, "historical confirmation must precede the core call");
      assert.equal(await options.onSelectRecordedProject({ projects: [recorded], reason: "requested" }), recorded.cwd);
      return exporter.exportArchive(options);
    } }),
  });
  await adapter.activate(context);
  const result = await adapter.exportFromQuickPick(context);
  if (mode.startsWith("dismiss")) {
    assert.equal(result, undefined);
    assert.equal(coreCalls, 0);
    assert.equal(context.globalState.values.size, 0);
    assert.equal(fake.messages.some(message => message.type === "info" || message.type === "error"), false);
    assert.equal(fs.existsSync(modeOutput), false, "selection cancellation must not create even a configured output folder");
    assert.equal(fake.openDialogs.length, 0);
  } else {
    assert.equal(coreCalls, 1);
    assert.equal(selectedOptions.scope, "recorded-project");
    assert.equal(selectedOptions.recordedProjectPath, undefined);
    assert.equal(typeof selectedOptions.onSelectRecordedProject, "function");
    const picker = fake.quickPicks.find(entry => entry.options.title === "Choose a project folder from Codex history");
    assert.equal(picker.options.placeHolder, "Choose a project folder from Codex history");
    assert.equal(picker.items[0].label, recorded.cwd);
    assert.equal(picker.items[0].description, "2 sessions · 5.3 GiB · 2026-08-01 – 2026-08-02");
    assert.match(picker.items[0].detail, /^2 stored path variants:/);
    for (const variant of recordedVariants) assert.ok(picker.items[0].detail.includes(variant));
    const expectedWarning = `Export 2 sessions recorded under ${recorded.cwd}? This differs from the current workspace folder. Codex history may contain sessions from multiple logical projects under the same recorded folder.`;
    const confirmation = fake.messages.find(message => message.message === expectedWarning);
    assert.deepEqual(confirmation.actions, [{ modal: true }, "Export recorded sessions", "Cancel"]);
    assert.ok(fake.quickPicks.indexOf(picker) < fake.quickPicks.findIndex(entry => entry.options.placeHolder === "Choose an export profile"));
    assert.ok(fake.quickPicks.findIndex(entry => entry.options.placeHolder === "Choose an export profile") < fake.quickPicks.findIndex(entry => entry.options.placeHolder === "Choose optional document formats"));
    assert.equal([...context.globalState.values.values()].includes(recorded.cwd), false);
  }
  if (mode !== "menu") {
    const recovery = fake.messages.find(message => message.message.startsWith("No sessions were recorded"));
    assert.equal(recovery.message, "No sessions were recorded for the current workspace folder. The project may have been moved, renamed or opened from another folder.");
    assert.deepEqual(recovery.actions, ["Choose project from Codex history"]);
  }
}

{
  const expectedProject = { cwd: "C:\\Synthetic\\Stable", recordedPaths: ["C:\\Synthetic\\Stable"], sessionCount: 2, sourceBytes: 100, firstSessionAt: "2026-08-01T00:00:00.000Z", lastSessionAt: "2026-08-02T00:00:00.000Z" };
  const changedProject = { ...expectedProject, sessionCount: 3 };
  const changedOutput = path.join(temp, "historical-inventory-changed");
  const fake = createFakeVscode({ workspaceFolders: [folder(oneWorkspace)], config: { outputDirectory: changedOutput }, warningSelector: () => "Export recorded sessions", quickPickSelector: (items, options) => {
    if (options.placeHolder === "Choose what to export") return items.find(item => item.scope === "recorded-project");
    return items[0];
  } });
  const adapter = createExtensionAdapter(fake.vscode, {
    discoverRecordedProjectInventory: async () => ({ sessionCount: 2, projects: [expectedProject] }),
    loadExporter: async () => ({ ...exporter, async exportArchive(options) {
      await options.onSelectRecordedProject({ projects: [changedProject], reason: "requested" });
      throw new Error("unreachable");
    } }),
  });
  const context = createContext(temp);
  await adapter.activate(context);
  await assert.rejects(() => adapter.exportFromQuickPick(context), error => error?.code === "RECORDED_PROJECT_INVENTORY_CHANGED");
  assert.equal(fake.messages.filter(message => message.type === "error").length, 1);
  assert.equal(fake.messages.some(message => message.type === "info"), false);
  assert.equal(fs.existsSync(changedOutput), false, "a changed confirmed inventory must fail before a synthetic core publishes output");
}

{
  const bothOutput = path.join(temp, "both-document-formats");
  let coreCalls = 0;
  const diagnostics = [];
  const fake = createFakeVscode({ config: { outputDirectory: bothOutput, diagnosticOutput: true }, quickPickSelector: (items, options) => {
    if (options.placeHolder === "Choose what to export") return items.find(item => item.scope === "all");
    if (options.placeHolder === "Choose an export profile") return items.find(item => item.profile === "readable");
    return items.find(item => item.label === "Add DOCX and PDF");
  } });
  const context = createContext(temp);
  const adapter = createExtensionAdapter(fake.vscode, { loadExporter: async () => ({ ...exporter, async exportArchive(options) {
    coreCalls += 1;
    options.onDiagnostic?.({ scope: "core", event: "discovery_start" });
    options.onDiagnostic?.({ scope: "core", event: "routing_start" });
    diagnostics.push(...(options.documentFormats || []));
    return exporter.exportArchive(options);
  } }) });
  const activation = await adapter.activate(context);
  await adapter.exportFromQuickPick(context);
  assert.equal(coreCalls, 1, "DOCX and PDF must share one core export call");
  assert.deepEqual(diagnostics, ["docx", "pdf"]);
  const coreEvents = activation.getDiagnosticEvents().filter(event => event.scope === "core");
  assert.equal(coreEvents.filter(event => event.event === "discovery_start").length, 1);
  assert.equal(coreEvents.filter(event => event.event === "routing_start").length, 1);
}

{
  const compressedDiscoveryHome = path.join(temp, "adapter-compressed-discovery");
  const compressedDiscoveryRoot = path.join(compressedDiscoveryHome, "sessions", "2026", "09", "03");
  await fsp.mkdir(compressedDiscoveryRoot, { recursive: true });
  const compressedOnly = path.join(compressedDiscoveryRoot, "rollout-compressed-only.jsonl.zst");
  const shadowedPlain = path.join(compressedDiscoveryRoot, "rollout-shadowed.jsonl");
  const shadowedCompressed = `${shadowedPlain}.zst`;
  await Promise.all([
    fsp.writeFile(compressedOnly, "compressed-only-sentinel", "utf8"),
    fsp.writeFile(shadowedPlain, "plain-sentinel", "utf8"),
    fsp.writeFile(shadowedCompressed, "compressed-shadow-sentinel", "utf8"),
  ]);
  const metadataReads = [];
  const fake = createFakeVscode({ config: { codexHome: compressedDiscoveryHome }, quickPickSelector: (items, options) => {
    if (options.placeHolder === "Choose what to export") return items.find((item) => item.scope === "all");
    if (options.placeHolder === "Choose an export profile") return undefined;
    return items[0];
  } });
  const adapter = createExtensionAdapterCore(fake.vscode, { loadExporter: async () => ({
    recordedPathIdentity: (value) => value,
    async readSessionDiscoveryMeta(file) {
      metadataReads.push(file);
      const name = path.basename(file);
      return { id: name, cwd: "C:\\Synthetic\\Compressed", timestamp: "2026-09-03T00:00:00.000Z", fileSize: 1 };
    },
  }) });
  await adapter.activate(createContext(temp));
  assert.equal(await adapter.exportFromQuickPick(createContext(temp)), undefined);
  assert.deepEqual(metadataReads.sort(), [compressedOnly, shadowedPlain].sort(), "compressed rollouts must be discovered while a plain sibling shadows its compressed copy");
  assert.equal(metadataReads.includes(shadowedCompressed), false);
}

{
  const discoveryHome = path.join(temp, "adapter-metadata-discovery");
  const activeRoot = path.join(discoveryHome, "sessions", "2026", "08", "30");
  const archivedRoot = path.join(discoveryHome, "archived_sessions", "2026", "08", "29");
  const discoveryOutput = path.join(temp, "adapter-metadata-output-must-not-exist");
  const workspaceFile = path.join(oneWorkspace, "must-not-be-read.txt");
  await fsp.mkdir(activeRoot, { recursive: true });
  await fsp.mkdir(archivedRoot, { recursive: true });
  await fsp.writeFile(workspaceFile, "workspace sentinel", "utf8");
  const storedCurrent = `${oneWorkspace[0].toLowerCase()}${oneWorkspace.slice(1).replaceAll("\\", "/")}/`;
  const historicalVariants = process.platform === "win32"
    ? ["C:\\Synthetic\\Grouped", "c:/synthetic/grouped/"]
    : ["/synthetic/Grouped", "/synthetic/Grouped/"];
  const currentSource = path.join(activeRoot, "rollout-current.jsonl");
  const currentMetadata = { type: "session_meta", timestamp: "2026-08-03T10:00:00Z", payload: { id: "adapter-current", cwd: storedCurrent, timestamp: "2026-08-03T10:00:00Z" } };
  const largeConversationRecord = { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "x".repeat(1024 * 1024) }] } };
  await fsp.writeFile(currentSource, `${JSON.stringify(currentMetadata)}\n${JSON.stringify(largeConversationRecord)}\n`, "utf8");
  for (let index = 0; index < historicalVariants.length; index += 1) {
    const timestamp = `2026-08-0${index + 1}T10:00:00Z`;
    const record = { type: "session_meta", timestamp, payload: { id: `adapter-historical-${index}`, cwd: historicalVariants[index], timestamp } };
    await fsp.writeFile(path.join(activeRoot, `rollout-history-${index}.jsonl`), `${JSON.stringify(record)}\n`, "utf8");
    if (index === 0) await fsp.writeFile(path.join(archivedRoot, "rollout-history-duplicate.jsonl"), `${JSON.stringify(record)}\n`, "utf8");
  }
  const corePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "bin", "export-codex-project-chats.mjs");
  const realExporter = await import(pathToFileURL(corePath).href);
  const metadataReads = [];
  const exporterWithObservedDiscovery = {
    ...realExporter,
    async readSessionDiscoveryMeta(file, options) {
      const meta = await realExporter.readSessionDiscoveryMeta(file, options);
      metadataReads.push({ file, bytesRead: meta.discoverySnapshot.bytesRead, fileSize: meta.fileSize });
      return meta;
    },
  };
  const adapterFsPaths = [];
  const trackingFsp = {
    ...fsp,
    async readdir(candidate, options) { adapterFsPaths.push(path.resolve(candidate)); return fsp.readdir(candidate, options); },
    async stat(candidate, options) { adapterFsPaths.push(path.resolve(candidate)); return fsp.stat(candidate, options); },
  };
  const fake = createFakeVscode({ workspaceFolders: [folder(oneWorkspace)], config: { codexHome: discoveryHome, outputDirectory: discoveryOutput }, quickPickSelector: (items, options) => {
    if (options.placeHolder === "Choose what to export") return items.find(item => item.scope === "project");
    if (options.placeHolder === "Choose an export profile") return undefined;
    return items[0];
  } });
  const context = createContext(temp);
  const adapter = createExtensionAdapterCore(fake.vscode, { fsp: trackingFsp, loadExporter: async () => exporterWithObservedDiscovery });
  await adapter.activate(context);
  assert.equal(await adapter.exportFromQuickPick(context), undefined);
  assert.equal(fake.quickPicks.some(entry => entry.options.title === "Choose a project folder from Codex history"), false, "a canonical Current Workspace match must not load the historical picker");
  assert.equal(fake.messages.some(message => message.message.startsWith("No sessions were recorded")), false);
  assert.equal(metadataReads.length, 4, "active and archived files are probed once before duplicate-ID retention");
  const bounded = metadataReads.find(entry => entry.file === currentSource);
  assert.ok(bounded.bytesRead < bounded.fileSize / 4, "Current Workspace discovery must not read the large conversation tail");
  assert.equal(adapterFsPaths.some(candidate => candidate === path.resolve(workspaceFile) || candidate.startsWith(`${path.resolve(oneWorkspace)}${path.sep}`)), false, "adapter discovery must never inspect workspace files");
  assert.equal(fs.existsSync(discoveryOutput), false, "profile cancellation after successful metadata discovery must not create the configured output folder");

  const historyFake = createFakeVscode({ workspaceFolders: [folder(oneWorkspace)], config: { codexHome: discoveryHome, outputDirectory: discoveryOutput }, quickPickSelector: (items, options) => {
    if (options.placeHolder === "Choose what to export") return items.find(item => item.scope === "recorded-project");
    if (options.title === "Choose a project folder from Codex history") return undefined;
    return items[0];
  } });
  const historyAdapter = createExtensionAdapterCore(historyFake.vscode, { loadExporter: async () => realExporter });
  await historyAdapter.activate(createContext(temp));
  assert.equal(await historyAdapter.exportFromQuickPick(createContext(temp)), undefined);
  const historyPicker = historyFake.quickPicks.find(entry => entry.options.title === "Choose a project folder from Codex history");
  const grouped = historyPicker.items.find(item => item.detail.startsWith("2 stored path variants:"));
  assert.ok(grouped, "canonical host-native spellings must form one visible project identity");
  assert.match(grouped.description, /^2 sessions · \d+ bytes · 2026-08-01 – 2026-08-02$/);
  for (const variant of historicalVariants) assert.ok(grouped.detail.includes(variant));
  assert.equal(fs.existsSync(discoveryOutput), false);

  const historyExportOutput = path.join(temp, "adapter-canonical-history-output");
  const historyExportFake = createFakeVscode({
    workspaceFolders: [folder(oneWorkspace)],
    config: { codexHome: discoveryHome, outputDirectory: historyExportOutput, pathStyle: "readable", includeTools: false },
    warningSelector: (_message, actions) => actions.find((action) => action === "Export recorded sessions"),
    quickPickSelector: (items, options) => {
      if (options.placeHolder === "Choose what to export") return items.find(item => item.scope === "recorded-project");
      if (options.title === "Choose a project folder from Codex history") return items.find(item => item.detail.startsWith("2 stored path variants:"));
      if (options.placeHolder === "Choose an export profile") return items.find(item => item.profile === "readable");
      if (options.placeHolder === "Choose optional document formats") return items.find(item => item.label === "Standard formats only");
      return items[0];
    },
  });
  const historyExportAdapter = createExtensionAdapterCore(historyExportFake.vscode, { loadExporter: async () => realExporter });
  await historyExportAdapter.activate(createContext(temp));
  const historyExportResult = await historyExportAdapter.exportFromQuickPick(createContext(temp));
  assert.equal(historyExportResult.exportedProjectCount, 1, "VS Code historical selection must preserve one canonical project group");
  const historyExportManifest = JSON.parse(await fsp.readFile(path.join(historyExportOutput, "manifest.json"), "utf8"));
  assert.deepEqual(new Set(historyExportManifest.sessions.map((session) => session.project)), new Set(historicalVariants));
  assert.equal(new Set(historyExportManifest.sessions.map((session) => session.markdown_file.replaceAll("\\", "/").split("/")[1])).size, 1);
  assert.ok(historyExportFake.messages.some((message) => message.type === "info" && message.message.startsWith("Exported 2 sessions across 1 project to ")));
}

{
  const multiOutput = path.join(temp, "multi-root-cancelled");
  const fake = createFakeVscode({ workspaceFolders: [folder(oneWorkspace), folder(twoWorkspace)], config: { outputDirectory: multiOutput }, quickPickSelector: (items, options) => {
    if (options.placeHolder === "Choose what to export") return items.find(item => item.scope === "project");
    if (options.placeHolder === "Choose the local workspace folder to export") return items.find(item => item.folder.uri.fsPath === twoWorkspace);
    if (options.placeHolder === "Choose an export profile") return undefined;
    return items[0];
  } });
  const adapter = createExtensionAdapter(fake.vscode, { discoverRecordedProjectInventory: async () => ({ sessionCount: 1, projects: [{ cwd: twoWorkspace, recordedPaths: [twoWorkspace], sessionCount: 1, sourceBytes: 1, firstSessionAt: "2026-08-01T00:00:00.000Z", lastSessionAt: "2026-08-01T00:00:00.000Z" }] }), loadExporter: async () => exporter });
  await adapter.activate(createContext(temp));
  assert.equal(await adapter.exportFromQuickPick(createContext(temp)), undefined);
  assert.equal(fake.quickPicks.some(entry => entry.options.title === "Choose a project folder from Codex history"), false);
  assert.equal(fs.existsSync(multiOutput), false);
}

{
  const cancelledOutput = path.join(temp, "discovery-cancelled-output");
  let sawAbort = false;
  const fake = createFakeVscode({ cancelProgressImmediately: true, config: { outputDirectory: cancelledOutput }, quickPickSelector: (items, options) => options.placeHolder === "Choose what to export" ? items.find(item => item.scope === "all") : items[0] });
  const adapter = createExtensionAdapter(fake.vscode, { discoverRecordedProjectInventory: async ({ abortSignal }) => {
    await new Promise(resolve => setImmediate(resolve));
    sawAbort = abortSignal.aborted;
    throw Object.assign(new Error("Cancelled"), { code: "EXPORT_CANCELLED" });
  }, loadExporter: async () => ({ async exportArchive() { throw new Error("must not run"); } }) });
  await adapter.activate(createContext(temp));
  assert.equal(await adapter.exportFromQuickPick(createContext(temp)), undefined);
  assert.equal(sawAbort, true);
  assert.equal(fake.messages.length, 0, "pre-export discovery cancellation is a silent picker-stage cancellation");
  assert.equal(fs.existsSync(cancelledOutput), false);
}

{
  let coreCalls = 0;
  const fake = createFakeVscode({ quickPickSelector: (items, options) => {
    if (options.placeHolder === "Choose what to export") return items.find(item => item.scope === "all");
    return items[0];
  }, openDialogResult: [] });
  const adapter = createExtensionAdapter(fake.vscode, { loadExporter: async () => ({ async exportArchive() { coreCalls += 1; } }) });
  await adapter.activate(createContext(temp));
  assert.equal(await adapter.exportFromQuickPick(createContext(temp)), undefined);
  assert.equal(coreCalls, 0);
  assert.equal(fake.messages.some(message => message.type === "info" || message.type === "error" || message.message === "No export folder selected."), false);
}

// UX 0.2.1 regressions use public commands and asynchronous notification actions.
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function waitFor(predicate, label) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
function collision() { return Object.assign(new Error("synthetic collision"), { code: "EXPORT_DESTINATION_COLLISION" }); }
const chooseFolder = "Anderen Ordner wählen…";
const inspectFolder = "Ordner öffnen";

{
  const fake = createFakeVscode({ config: { outputDirectory } });
  const context = createContext(temp);
  const adapter = createExtensionAdapter(fake.vscode, { loadExporter: async () => exporter });
  await adapter.activate(context);
  const provider = fake.treeProviders.get(SIDEBAR_VIEW);
  assert.ok(provider, "the manifest view must register a native tree provider");
  const rows = provider.getChildren().map(action => provider.getTreeItem(action));
  assert.deepEqual(rows.map(row => row.label), ["Export…", "Open Latest Export", "Open Export Folder", "Extension Settings"]);
  assert.deepEqual(rows.map(row => row.command.command), [COMMANDS.exportMenu, COMMANDS.openLatestArchive, COMMANDS.openExportFolder, COMMANDS.openSettings]);
  for (const row of rows) {
    assert.equal(row.collapsibleState, 0);
    assert.deepEqual(provider.getChildren(row), []);
    assert.ok(fake.registered.has(row.command.command));
  }
  // Choose all sessions for the shared export command, then open its saved result.
  fake.vscode.window.showQuickPick = async items => items.find(item => item.scope === "all") || items[0];
  for (const row of rows) await fake.vscode.commands.executeCommand(row.command.command);
  assert.deepEqual(fake.opened, [path.join(outputDirectory, "index.html"), outputDirectory]);
  assert.deepEqual(fake.executed.at(-1), { command: "workbench.action.openSettings", args: ["@ext:ann-diana.codex-project-chat-exporter-vscode"] });
  for (const registration of context.subscriptions) registration.dispose();
  assert.equal(fake.treeProviders.size, 0);
  assert.equal(fake.registered.size, 0);
}

for (const outcome of ["dismiss", "cancel", "remote", "relative", "network", "dialog-error", "open", "replaced-open", "notification-error"]) {
  const target = path.join(temp, `collision-${outcome}`);
  await fsp.mkdir(target);
  const action = deferred();
  let attempts = 0;
  const fake = createFakeVscode({ config: { outputDirectory: target }, errorMessageHandler: () => action.promise });
  const context = createContext(temp);
  const adapter = createExtensionAdapter(fake.vscode, { loadExporter: async () => ({ async exportArchive(options) {
    attempts += 1;
    if (attempts === 2) throw collision();
    return exporter.exportArchive(options);
  } }) });
  await adapter.activate(context);
  await adapter.exportAllSessions(context);
  const saved = [...context.globalState.values];
  assert.equal(await adapter.exportAllSessions(context), undefined);
  const notification = fake.messages.find(message => message.type === "error");
  assert.ok(notification.message.includes("Es wurde nichts überschrieben"));
  assert.deepEqual(notification.actions, [chooseFolder, inspectFolder]);
  assert.deepEqual([...context.globalState.values], saved);
  if (outcome === "notification-error") {
    action.resolve(Promise.reject(new Error("notification failure")));
  } else if (outcome === "dismiss") {
    action.resolve();
  } else if (outcome === "open" || outcome === "replaced-open") {
    if (outcome === "replaced-open") {
      await fsp.rename(target, `${target}-old`);
      await fsp.mkdir(target);
    }
    // Opening a collision is inspection, including when an incomplete marker exists.
    await fsp.writeFile(path.join(target, "EXPORT_INCOMPLETE.txt"), "incomplete");
    action.resolve(inspectFolder);
    await waitFor(() => fake.opened.length || fake.messages.some(m => m.message.includes("nicht mehr sicher")), outcome);
    assert.deepEqual(fake.opened, outcome === "open" ? [target] : []);
    await fsp.unlink(path.join(target, "EXPORT_INCOMPLETE.txt"));
  } else {
    fake.vscode.window.showOpenDialog = async () => {
      if (outcome === "dialog-error") throw new Error("dialog failure");
      if (outcome === "cancel") return [];
      return [{ scheme: outcome === "remote" ? "vscode-remote" : "file", fsPath: outcome === "relative" ? "relative" : outcome === "network" ? "\\\\server\\share" : target }];
    };
    action.resolve(chooseFolder);
  }
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(attempts, 2, `${outcome}: no retry`);
  assert.deepEqual([...context.globalState.values], saved, `${outcome}: last success unchanged`);
  await adapter.exportAllSessions(context);
  assert.equal(attempts, 3, `${outcome}: lock released`);
}

{
  const firstTarget = path.join(temp, "retry-configured");
  const freshTarget = path.join(temp, "retry-fresh");
  const anotherTarget = path.join(temp, "retry-another");
  await fsp.mkdir(firstTarget);
  const action = deferred();
  const picker = deferred();
  const retryGate = deferred();
  const calls = [];
  const core = await import("../../../bin/export-codex-project-chats.mjs");
  const codexHome = path.join(temp, "delayed-binding-home");
  await fsp.mkdir(path.join(codexHome, "sessions"), { recursive: true });
  await fsp.writeFile(path.join(codexHome, "sessions", "session.jsonl"), JSON.stringify({ type: "session_meta", payload: { id: "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa", cwd: oneWorkspace } }) + "\n");
  const fake = createFakeVscode({ config: { outputDirectory: firstTarget, codexHome, includeTools: true, pathStyle: "readable" }, errorMessageHandler: () => action.promise });
  const context = createContext(temp);
  let gateRetry = false;
  const adapter = createExtensionAdapter(fake.vscode, { loadExporter: async () => ({ ...core, async exportArchive(options) {
    calls.push(options);
    if (calls.length === 1) throw collision();
    if (gateRetry && options.outputDirectory === freshTarget) await retryGate.promise;
    return exporter.exportArchive(options);
  } }) });
  await adapter.activate(context);
  const selectedProject = (await defaultInventoryProvider()).projects[0];
  await adapter.runExport(context, { scope: "recorded-project", selectedProject }, "source-snapshots", ["docx", "pdf"]);
  // An unresolved collision notification and folder picker must not retain a lock.
  fake.config.set("outputDirectory", anotherTarget);
  await adapter.exportAllSessions(context);
  assert.equal(calls.length, 2);
  const successfulState = [...context.globalState.values];
  fake.vscode.window.showOpenDialog = () => picker.promise;
  action.resolve(chooseFolder);
  await new Promise(resolve => setImmediate(resolve));
  await adapter.exportAllSessions(context);
  assert.equal(calls.length, 3, "a pending folder picker must not hold the lock");
  fake.config.set("includeTools", false);
  fake.config.set("pathStyle", "short");
  gateRetry = true;
  picker.resolve([{ scheme: "file", fsPath: freshTarget }]);
  await waitFor(() => calls.length === 4, "retry start");
  assert.equal(await adapter.exportAllSessions(context), undefined, "retry core holds the lock");
  const original = calls[0];
  const retry = calls[3];
  for (const key of ["scope", "workspacePath", "recordedProjectPath", "exportProfile", "documentFormats", "pathStyle", "includeTools", "codexHome", "onSelectRecordedProject"]) assert.deepEqual(retry[key], original[key], key);
  assert.equal(retry.onSelectRecordedProject({ projects: [selectedProject], reason: "requested" }), selectedProject.cwd);
  assert.throws(() => retry.onSelectRecordedProject({ projects: [{ ...selectedProject, sourceBytes: 1 }], reason: "requested" }), { code: "RECORDED_PROJECT_INVENTORY_CHANGED" });
  assert.notEqual(retry.abortSignal, original.abortSignal);
  assert.equal(retry.outputDirectory, freshTarget);
  assert.equal(fake.quickPicks.length, 0, "retry does not repeat any configuration pickers");
  retryGate.resolve();
  await waitFor(() => context.globalState.get(STATE_LAST_SUCCESS)?.outputDirectory === freshTarget, "retry success");
  assert.equal(fake.config.get("outputDirectory"), anotherTarget, "retry never edits settings");
  assert.equal(context.globalState.values.has("codexProjectChatExporter.rememberedOutputDirectory"), false, "a delayed retry must not store an automatic destination");
  await adapter.exportAllSessions(context);
  assert.equal(calls.at(-1).outputDirectory, anotherTarget, "next export uses settings");
  assert.notDeepEqual([...context.globalState.values], successfulState);
}

// UX-01: first collision with empty state, using the registered command and real
// core. Selected output folders must never become automatic future destinations.
for (const destinationMode of ["empty", "configured"]) {
  const core = await import("../../../bin/export-codex-project-chats.mjs");
  const codexHome = path.join(temp, `ux01-${destinationMode}-home`);
  const originalTarget = path.join(temp, `ux01-${destinationMode}-original`);
  const retryTarget = path.join(temp, `ux01-${destinationMode}-retry`);
  const nextTarget = path.join(temp, `ux01-${destinationMode}-next`);
  await fsp.mkdir(path.join(codexHome, "sessions"), { recursive: true });
  const source = path.join(codexHome, "sessions", "rollout-synthetic.jsonl");
  const records = [
    { type: "session_meta", timestamp: "2026-09-24T10:00:00Z", payload: { id: "cccccccc-cccc-7ccc-8ccc-cccccccccccc", cwd: oneWorkspace } },
    { type: "response_item", timestamp: "2026-09-24T10:00:01Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Synthetic collision retry" }] } },
  ];
  const sourceBytes = Buffer.from(records.map(record => JSON.stringify(record)).join("\n") + "\n");
  await fsp.writeFile(source, sourceBytes);
  // A was created outside this adapter; there must be no previous adapter state.
  await core.exportArchive({ scope: "all", codexHome, outputDirectory: originalTarget, exportProfile: "complete" });
  const manifestBefore = await fsp.readFile(path.join(originalTarget, "manifest.json"));
  const action = deferred();
  const destinations = destinationMode === "empty" ? [originalTarget, retryTarget, nextTarget, originalTarget, undefined, nextTarget] : [retryTarget];
  const calls = [];
  const fake = createFakeVscode({
    config: { codexHome, outputDirectory: destinationMode === "configured" ? originalTarget : "" },
    openDialogSelector: () => { const target = destinations.shift(); return target ? [{ scheme: "file", fsPath: target }] : []; },
    errorMessageHandler: (_message, actions) => actions.includes(chooseFolder) ? action.promise : undefined,
    quickPickSelector: items => items.find(item => item.scope === "all" || item.profile === "readable" || item.documentFormats?.length === 2),
  });
  const configBytes = Buffer.from(JSON.stringify([...fake.config]));
  const context = createContext(temp);
  context.workspaceState = createState();
  const updates = [];
  const update = context.globalState.update;
  context.globalState.update = async (key, value) => { updates.push({ key, value }); return update(key, value); };
  const adapter = createExtensionAdapter(fake.vscode, { loadExporter: async () => ({ ...core, async exportArchive(options) {
    calls.push(options);
    return core.exportArchive(options);
  } }) });
  await adapter.activate(context);
  const run = () => fake.registered.get(COMMANDS.exportMenu)();
  await run();
  assert.equal(calls.length, 1);
  assert.deepEqual([...context.globalState.values], [], "first collision must not save any destination");
  assert.deepEqual(updates, []);
  assert.ok(fake.messages.some(message => message.actions?.includes(chooseFolder)));
  const pickerCount = fake.openDialogs.length;
  const selectionCount = fake.quickPicks.length;
  action.resolve(chooseFolder);
  await waitFor(() => context.globalState.get(STATE_LAST_SUCCESS)?.htmlIndexPath === path.join(retryTarget, "index.html"), "first collision retry success");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 2);
  assert.equal(fake.quickPicks.length, selectionCount, "retry preserves the configured scope/profile/formats");
  assert.equal(fake.openDialogs.length, pickerCount + 1);
  for (const key of ["scope", "exportProfile", "documentFormats", "codexHome", "includeTools", "pathStyle"]) assert.deepEqual(calls[1][key], calls[0][key], key);
  assert.notEqual(calls[1].abortSignal, calls[0].abortSignal);
  assert.equal(await adapter.openLatestArchive(context), true);
  assert.equal(await adapter.openExportFolder(context), true);
  assert.deepEqual(fake.opened, [path.join(retryTarget, "index.html"), retryTarget]);

  if (destinationMode === "empty") {
    await run();
    assert.equal(fake.openDialogs.length, pickerCount + 2, "next normal export must ask for a folder again");
    assert.equal(calls.at(-1).outputDirectory, nextTarget);
  }
  const saved = [...context.globalState.values];
  const updatesBeforeFailure = updates.length;
  // Selecting/configuring A again must still refuse the incomplete generation.
  const markerBefore = await fsp.readFile(path.join(originalTarget, "EXPORT_INCOMPLETE.txt"));
  await assert.rejects(run, { code: "INCOMPLETE_EXPORT_EXISTS" });
  assert.deepEqual([...context.globalState.values], saved);
  assert.equal(updates.length, updatesBeforeFailure);
  assert.deepEqual(await fsp.readFile(path.join(originalTarget, "manifest.json")), manifestBefore);
  assert.deepEqual(await fsp.readFile(path.join(originalTarget, "EXPORT_INCOMPLETE.txt")), markerBefore);
  const dialogsBeforeNext = fake.openDialogs.length;
  if (destinationMode === "empty") {
    assert.equal(await run(), undefined, "cancelling the next normal picker starts no export");
    assert.equal(fake.openDialogs.length, dialogsBeforeNext + 1);
    assert.deepEqual([...context.globalState.values], saved);
    assert.equal(updates.length, updatesBeforeFailure);
    await run();
    assert.equal(fake.openDialogs.length, dialogsBeforeNext + 2, "picker cancellation releases the runtime lock");
    assert.equal(calls.at(-1).outputDirectory, nextTarget);
  } else {
    await assert.rejects(run, { code: "INCOMPLETE_EXPORT_EXISTS" });
    assert.equal(fake.openDialogs.length, dialogsBeforeNext, "configured target remains authoritative");
    assert.equal(calls.at(-1).outputDirectory, originalTarget, "failed configured run releases the runtime lock");
    assert.deepEqual([...context.globalState.values], saved);
  }
  assert.deepEqual(Buffer.from(JSON.stringify([...fake.config])), configBytes, "settings remain byte-identical");
  const successKeys = [STATE_LAST_SUCCESS];
  assert.deepEqual([...context.globalState.values.keys()].sort(), [...successKeys].sort(), "only last-success records may be stored");
  assert.ok(updates.every(({ key }) => successKeys.includes(key)), "no automatic destination preference may ever be written");
  for (const { value } of updates) {
    assert.notEqual(value, originalTarget);
    assert.notEqual(value?.path, originalTarget);
    assert.notEqual(value?.canonicalPath, originalTarget);
  }
  assert.deepEqual([...context.workspaceState.values], []);
  assert.deepEqual(await fsp.readFile(source), sourceBytes);
  assert.equal(fs.existsSync(path.join(originalTarget, ".codex-export.lock")), false);
  assert.equal(fs.existsSync(path.join(retryTarget, ".codex-export.lock")), false);
  assert.equal(fs.existsSync(path.join(retryTarget, "EXPORT_INCOMPLETE.txt")), false);
  const manifest = JSON.parse(await fsp.readFile(path.join(retryTarget, "manifest.json"), "utf8"));
  assert.equal(manifest.export_profile, "readable");
  assert.equal(manifest.formats.docx, true);
  assert.equal(manifest.formats.pdf, true);
  console.log(`UX-01 real-core ${destinationMode}: PASS`);
}

for (const failure of ["cancelled", "core-error", "invalid-result", "status-error", "second-collision"]) {
  const target = path.join(temp, `retry-failure-${failure}`);
  const alternate = path.join(temp, `retry-failure-${failure}-alternate`);
  await fsp.mkdir(target);
  let calls = 0;
  const fake = createFakeVscode({ config: { outputDirectory: target }, openDialogResult: [{ scheme: "file", fsPath: alternate }], errorMessageHandler: (message, actions) => actions.includes(chooseFolder) && calls === 2 ? chooseFolder : undefined });
  const context = createContext(temp);
  const adapter = createExtensionAdapter(fake.vscode, { loadExporter: async () => ({ async exportArchive(options) {
    calls += 1;
    if (calls === 2) throw collision();
    if (calls === 3) {
      if (failure === "cancelled") throw Object.assign(new Error("cancelled"), { code: "EXPORT_CANCELLED" });
      if (failure === "core-error") throw new Error("retry core failed");
      if (failure === "second-collision") throw collision();
      if (failure === "invalid-result") return { outputDirectory: alternate, htmlIndexPath: path.join(alternate, "missing.html") };
    }
    return exporter.exportArchive(options);
  } }) });
  await adapter.activate(context);
  await adapter.exportAllSessions(context);
  const saved = [...context.globalState.values];
  const update = context.globalState.update;
  if (failure === "status-error") context.globalState.update = async () => { throw new Error("status unavailable"); };
  await adapter.exportAllSessions(context);
  await waitFor(() => calls === 3, failure);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual([...context.globalState.values], saved, `${failure}: no success publication`);
  context.globalState.update = update;
  await adapter.exportAllSessions(context);
  assert.equal(calls, 4, `${failure}: retry failure releases lock`);
}

{
  const target = path.join(temp, "retry-busy-target");
  const alternate = path.join(temp, "retry-busy-alternate");
  await fsp.mkdir(target);
  const action = deferred();
  const activeExport = deferred();
  let calls = 0;
  const fake = createFakeVscode({ config: { outputDirectory: target }, openDialogResult: [{ scheme: "file", fsPath: alternate }], errorMessageHandler: () => action.promise });
  const adapter = createExtensionAdapter(fake.vscode, { loadExporter: async () => ({ async exportArchive(options) {
    calls += 1;
    if (calls === 1) throw collision();
    if (calls === 2) await activeExport.promise;
    return exporter.exportArchive(options);
  } }) });
  const context = createContext(temp);
  await adapter.activate(context);
  await adapter.exportAllSessions(context);
  const running = adapter.exportAllSessions(context);
  await waitFor(() => calls === 2, "independent export active");
  action.resolve(chooseFolder);
  await waitFor(() => fake.messages.some(message => message.message.includes("already running")), "busy retry refused");
  assert.equal(calls, 2);
  assert.equal(fs.existsSync(alternate), false);
  assert.equal(await adapter.exportAllSessions(context), undefined, "refused delayed retry cannot unlock another export");
  activeExport.resolve();
  await running;
  await adapter.exportAllSessions(context);
  assert.equal(calls, 3);
}

// Empty outputDirectory must keep asking after every unsuccessful retry path,
// both on first use and after a different export succeeded previously.
for (const previousSuccess of [false, true]) {
  for (const outcome of ["dismiss", "picker-cancel", "picker-error", "core-cancel", "core-error", "incomplete", "invalid-result"]) {
    const caseId = `${previousSuccess ? "prior" : "fresh"}-${outcome}`;
    const previous = path.join(temp, `ux01-${caseId}-previous`);
    const original = path.join(temp, `ux01-${caseId}-original`);
    const retry = path.join(temp, `ux01-${caseId}-retry`);
    const next = path.join(temp, `ux01-${caseId}-next`);
    await fsp.mkdir(original);
    const action = deferred();
    let calls = 0;
    const destinations = previousSuccess ? [previous, original] : [original];
    const fake = createFakeVscode({
      config: { outputDirectory: "" },
      openDialogSelector: () => {
        const target = destinations.shift();
        if (target instanceof Error) throw target;
        return target ? [{ scheme: "file", fsPath: target }] : [];
      },
      errorMessageHandler: (_message, actions) => actions.includes(chooseFolder) ? action.promise : undefined,
    });
    const context = createContext(temp);
    context.workspaceState = createState();
    const writes = [];
    const update = context.globalState.update;
    context.globalState.update = async (key, value) => { writes.push(key); return update(key, value); };
    const adapter = createExtensionAdapter(fake.vscode, { loadExporter: async () => ({ async exportArchive(options) {
      calls += 1;
      if (options.outputDirectory === original) throw collision();
      if (options.outputDirectory === retry) {
        if (outcome === "core-cancel") throw Object.assign(new Error("cancelled"), { code: "EXPORT_CANCELLED" });
        if (outcome === "incomplete") throw Object.assign(new Error("incomplete"), { code: "INCOMPLETE_EXPORT_EXISTS" });
        if (outcome === "invalid-result") return { outputDirectory: retry, htmlIndexPath: path.join(retry, "missing.html") };
        throw new Error("synthetic retry error");
      }
      return exporter.exportArchive(options);
    } }) });
    await adapter.activate(context);
    const run = () => fake.registered.get(COMMANDS.exportAllSessions)();
    if (previousSuccess) await run();
    const saved = [...context.globalState.values];
    const savedWrites = [...writes];
    await run();
    assert.deepEqual([...context.globalState.values], saved, `${outcome}: collision preserves last success`);
    const dialogsAfterCollision = fake.openDialogs.length;
    if (outcome === "dismiss") action.resolve();
    else {
      destinations.push(outcome === "picker-cancel" ? undefined : outcome === "picker-error" ? new Error("picker error") : retry);
      action.resolve(chooseFolder);
      await waitFor(() => fake.openDialogs.length === dialogsAfterCollision + 1, `${outcome}: retry picker`);
      if (outcome === "picker-error") await waitFor(() => fake.output.some(line => line.startsWith("Export notification or follow-up action failed")), outcome);
      if (outcome === "core-cancel") await waitFor(() => fake.output.includes("Export cancelled."), outcome);
      if (["core-error", "incomplete", "invalid-result"].includes(outcome)) await waitFor(() => fake.output.some(line => line.startsWith("Export failed:")), outcome);
    }
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual([...context.globalState.values], saved, `${outcome}: no unsuccessful retry state`);
    assert.deepEqual(writes, savedWrites, `${outcome}: no state writes before success`);
    assert.deepEqual([...context.workspaceState.values], []);
    assert.deepEqual([...fake.config], [["outputDirectory", ""]]);
    for (const forbidden of [original, retry]) {
      for (const [, value] of context.globalState.values) {
        assert.notEqual(value, forbidden);
        assert.notEqual(value?.path, forbidden);
        assert.notEqual(value?.canonicalPath, forbidden);
      }
    }
    assert.equal(await adapter.openLatestArchive(context), previousSuccess);
    assert.equal(await adapter.openExportFolder(context), previousSuccess);
    assert.deepEqual(fake.opened, previousSuccess ? [path.join(previous, "index.html"), previous] : []);
    const attemptsBeforeNext = calls;
    const dialogsBeforeNext = fake.openDialogs.length;
    destinations.push(next);
    await run();
    assert.equal(fake.openDialogs.length, dialogsBeforeNext + 1, `${outcome}: next normal export asks again`);
    assert.equal(calls, attemptsBeforeNext + 1, `${outcome}: runtime lock is released`);
    assert.equal(context.globalState.get(STATE_LAST_SUCCESS)?.outputDirectory, next);
    assert.deepEqual([...context.globalState.values.keys()].sort(), [STATE_LAST_SUCCESS].sort());
    console.log(`UX-01 retry ${caseId}: PASS`);
  }
}

{
  // Older states must not resurrect implicit output preferences after an upgrade.
  const context = createContext(temp);
  await context.globalState.update("codexProjectChatExporter.rememberedOutputDirectory", path.join(temp, "obsolete-default"));
  await context.globalState.update(STATE_OUTPUT_DIR, path.join(temp, "legacy-success"));
  const saved = [...context.globalState.values];
  const first = path.join(temp, "picker-first");
  const second = path.join(temp, "picker-second");
  const choices = [first, second];
  const fake = createFakeVscode({ openDialogSelector: () => [{ scheme: "file", fsPath: choices.shift() }] });
  const adapter = createExtensionAdapter(fake.vscode);
  await adapter.activate(context);
  assert.equal(await adapter.resolveOutputDirectory(), first);
  assert.equal(await adapter.resolveOutputDirectory(), second);
  assert.equal(fake.openDialogs.length, 2);
  assert.deepEqual([...context.globalState.values], saved, "selecting a folder stores no preference or success");
  console.log("UX-01 obsolete/legacy state ignored: PASS");
}

console.log("UX regressions passed: sidebar, collision actions, cancellation, retry selection/state and real-core preservation");

// Logical-summary changes are also covered by the complete physical binding.
for (const mutation of ["swap-id", "workspace-swap", "swap-path", "replace-file", "touch", "add", "remove", "remove-all", "storage", "discovery-cancel", "discovery-error", "stable", "reorder"]) {
  const core = await import("../../../bin/export-codex-project-chats.mjs");
  const home = path.join(temp, `bound-${mutation}-home`);
  const active = path.join(home, "sessions");
  const archived = path.join(home, "archived_sessions");
  await fsp.mkdir(active, { recursive: true });
  await fsp.mkdir(archived);
  const sources = [path.join(active, "a.jsonl"), path.join(active, "b.jsonl")];
  const recordBytes = (letter) => Buffer.from(JSON.stringify({ type: "session_meta", timestamp: "2026-09-24T10:00:00Z", payload: {
    id: `${letter.repeat(8)}-${letter.repeat(4)}-7${letter.repeat(3)}-8${letter.repeat(3)}-${letter.repeat(12)}`, cwd: oneWorkspace, timestamp: "2026-09-24T10:00:00Z",
  } }) + "\n");
  await fsp.writeFile(sources[0], recordBytes("a"));
  await fsp.writeFile(sources[1], recordBytes("b"));
  const prior = path.join(temp, `bound-${mutation}-prior`);
  const original = path.join(temp, `bound-${mutation}-original`);
  const retry = path.join(temp, `bound-${mutation}-retry`);
  const next = path.join(temp, `bound-${mutation}-next`);
  await core.exportArchive({ scope: "all", codexHome: home, outputDirectory: original, exportProfile: "complete" });
  const sentinel = await fsp.readFile(path.join(original, "manifest.json"));
  const action = deferred();
  const calls = [];
  const discoveryHomes = [];
  let reverse = false;
  let retryDiscovery = false;
  let synthetic = true;
  const fake = createFakeVscode({ config: { codexHome: home, outputDirectory: prior }, workspaceFolders: [folder(oneWorkspace)],
    openDialogResult: [{ scheme: "file", fsPath: retry }],
    errorMessageHandler: (_message, actions) => actions.includes(chooseFolder) ? action.promise : undefined,
    quickPickSelector: (items, options) => {
      if (options.placeHolder === "Choose what to export") return items.find(item => item.scope === (mutation === "workspace-swap" ? "project" : "recorded-project"));
      if (options.placeHolder === "Choose an export profile") return items.find(item => item.profile === "readable");
      if (options.placeHolder === "Choose optional document formats") return items.find(item => item.documentFormats.length === 2);
      return items[0];
    },
  });
  const context = createContext(temp);
  const adapter = createExtensionAdapterCore(fake.vscode, { fsp: { ...fsp, async readdir(directory, options) {
    discoveryHomes.push(directory);
    const entries = await fsp.readdir(directory, options);
    return reverse ? entries.reverse() : entries;
  } }, loadExporter: async () => ({ ...core,
    async readSessionDiscoveryMeta(...args) {
      if (retryDiscovery && mutation === "discovery-cancel") throw Object.assign(new Error("synthetic discovery cancellation"), { code: "EXPORT_CANCELLED" });
      if (retryDiscovery && mutation === "discovery-error") throw Object.assign(new Error("synthetic discovery read failure"), { code: "EACCES" });
      const meta = await core.readSessionDiscoveryMeta(...args);
      if (!reverse) return meta;
      // Stable metadata must not depend on property insertion order or I/O counts.
      return Object.fromEntries(Object.entries({ ...meta, discoverySnapshot: {
        ...meta.discoverySnapshot, bytesRead: meta.discoverySnapshot.bytesRead + 1,
      } }).reverse());
    },
    async exportArchive(options) {
      if (synthetic) return exporter.exportArchive(options);
      calls.push(options);
      return core.exportArchive(options);
    },
  }) });
  await adapter.activate(context);
  await adapter.exportAllSessions(context);
  const saved = structuredClone([...context.globalState.values]);
  const successMessages = fake.messages.filter(message => message.message.startsWith("Exported ")).length;
  synthetic = false;
  fake.config.set("outputDirectory", original);
  await fake.registered.get(COMMANDS.exportMenu)();
  assert.equal(calls.length, 1);
  assert.ok(fake.messages.some(message => message.actions.includes(chooseFolder)), "the first real export must collide");
  const project = fake.quickPicks.find(pick => pick.options.title === "Choose a project folder from Codex history")?.items[0].project;
  if (project) {
    assert.equal(project.sessionCount, 2);
    assert.equal(Object.hasOwn(project, "sessionInventory"), false, "display inventory is not a security binding");
  }
  const marker = await fsp.readFile(path.join(original, "EXPORT_INCOMPLETE.txt"));
  const picks = fake.quickPicks.length;
  if (mutation === "swap-id" || mutation === "workspace-swap") {
    assert.equal(recordBytes("a").length, recordBytes("c").length, "replacement preserves byte totals");
    await fsp.writeFile(sources[0], recordBytes("c"));
    const replacement = await core.readSessionDiscoveryMeta(sources[0]);
    if (project) {
      assert.equal(replacement.fileSize * 2, project.sourceBytes);
      assert.equal(new Date(replacement.timestamp).toISOString(), project.firstSessionAt);
      assert.equal(new Date(replacement.timestamp).toISOString(), project.lastSessionAt);
      assert.deepEqual(project.recordedPaths, [replacement.cwd]);
    }
  }
  if (mutation === "swap-path") await fsp.rename(sources[0], path.join(active, "replacement.jsonl"));
  if (mutation === "replace-file") {
    const before = await fsp.stat(sources[0], { bigint: true });
    await fsp.rename(sources[0], path.join(temp, "retired-binding-source.jsonl"));
    await fsp.writeFile(sources[0], recordBytes("a"));
    assert.notEqual(testFileIdentity(await fsp.stat(sources[0], { bigint: true })), testFileIdentity(before));
  }
  if (mutation === "touch") await fsp.utimes(sources[0], new Date("2026-09-25T01:00:00Z"), new Date("2026-09-25T01:00:00Z"));
  if (mutation === "add") await fsp.writeFile(path.join(active, "c.jsonl"), recordBytes("c"));
  if (mutation === "remove" || mutation === "remove-all") await fsp.unlink(sources[0]);
  if (mutation === "remove-all") await fsp.unlink(sources[1]);
  if (mutation === "storage") await fsp.rename(sources[0], path.join(archived, "a.jsonl"));
  reverse = mutation === "reorder";
  // The retry must retain the original validated home even if settings change.
  fake.config.set("codexHome", path.join(temp, "different-home-must-not-be-read"));
  discoveryHomes.length = 0;
  retryDiscovery = true;
  action.resolve(chooseFolder);
  const allowed = mutation === "stable" || mutation === "reorder";
  const expectedFailure = mutation === "discovery-cancel" ? "Export cancelled." : mutation === "discovery-error" ? "RECORDED_PROJECT_INVENTORY_UNVERIFIABLE" : "RECORDED_PROJECT_INVENTORY_CHANGED";
  await waitFor(() => allowed ? context.globalState.get(STATE_LAST_SUCCESS)?.outputDirectory === retry
    : fake.output.some(line => line.includes(expectedFailure)), `bound retry ${mutation}`);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(discoveryHomes.length > 0, "retry rediscovers before core export");
  assert.ok(discoveryHomes.every(directory => directory === active || directory === archived));
  assert.equal(fake.quickPicks.length, picks, "no project/profile/format reselection during retry");
  if (allowed) {
    assert.equal(calls.length, 2);
    for (const key of ["scope", "exportProfile", "documentFormats", "codexHome", "onSelectRecordedProject"]) assert.deepEqual(calls[1][key], calls[0][key]);
    const manifest = JSON.parse(await fsp.readFile(path.join(retry, "manifest.json"), "utf8"));
    assert.equal(manifest.sessions.length, 2);
    assert.equal(await adapter.openLatestArchive(context), true);
  } else {
    assert.equal(calls.length, 1, "changed inventory must fail before the retry core call");
    assert.equal(fs.existsSync(retry), false, "no retry output or replacement session may be published");
    assert.deepEqual([...context.globalState.values], saved);
    assert.equal(fake.messages.filter(message => message.message.startsWith("Exported ")).length, successMessages);
    assert.equal(await adapter.openLatestArchive(context), true);
    assert.equal(fake.opened.at(-1), path.join(prior, "index.html"));
  }
  assert.deepEqual(await fsp.readFile(path.join(original, "manifest.json")), sentinel);
  assert.deepEqual(await fsp.readFile(path.join(original, "EXPORT_INCOMPLETE.txt")), marker);
  assert.equal(fs.existsSync(path.join(original, ".codex-export.lock")), false);
  synthetic = true;
  fake.config.set("outputDirectory", next);
  assert.equal((await adapter.exportAllSessions(context)).outputDirectory, next, "all inventory paths release the adapter lock");
  console.log(`Security inventory ${mutation}: PASS`);
}

// R1: the independent audit's 12 continuation variants plus shadows, aliases,
// byte identity and ordering. No logical-inventory injection in these tests.
const bindingCore = await import("../../../bin/export-codex-project-chats.mjs");
const bindingThread = "11111111-1111-7111-8111-111111111111";
const bindingParent = "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa";
const bindingChild = "bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb";
const bindingName = id => "rollout-2026-09-24T10-00-00-" + bindingThread + "_" + id + ".jsonl";
function bindingBytes(child, label = "ADDED_CHILD_CONTENT", cwd = oneWorkspace) {
  const at = "2026-09-24T10:00:00Z";
  const records = [
    { ordinal: child ? 2 : 0, type: "session_meta", timestamp: at, payload: {
      id: bindingThread, cwd, timestamp: at, thread_source: "user", history_mode: "paginated",
      ...(child ? { history_base: { thread_id: bindingParent, end_ordinal_exclusive: 2, end_byte_offset: 1600 } } : {}),
    } },
    { ordinal: child ? 3 : 1, type: "response_item", timestamp: at, payload: {
      type: "message", role: "assistant", content: [{ type: "output_text", text: child ? label : "ORIGINAL_PARENT_CONTENT" }],
    } },
  ];
  const encode = () => Buffer.from(records.map(record => JSON.stringify(record)).join("\n") + "\n");
  records[1].payload.content[0].text += "x".repeat(1600 - encode().length);
  assert.equal(encode().length, 1600);
  return encode();
}
function trackedBindingIo({ fault = () => {}, mapStat = (_file, stat) => stat, reverse = () => false } = {}) {
  const active = new Set(), reads = [], opened = [];
  return { active, reads, opened, io: {
    ...fsp,
    async readdir(directory, options) {
      fault("enumerate", directory);
      const entries = await fsp.readdir(directory, options);
      return reverse() ? entries.reverse() : entries;
    },
    async lstat(file, options) { return mapStat(file, await fsp.lstat(file, options)); },
    async open(file, flags) {
      fault("open", file);
      const handle = await fsp.open(file, flags);
      active.add(handle);
      opened.push(file);
      assert.equal(active.size, 1, "hash sources sequentially");
      return {
        async stat(options) { fault("stat", file); return mapStat(file, await handle.stat(options)); },
        async read(buffer, offset, length, position) {
          assert.ok(length <= 64 * 1024, "bounded streaming hash buffer");
          fault("read", file);
          const result = await handle.read(buffer, offset, length, position);
          reads.push({ file, bytes: result.bytesRead });
          return result;
        },
        async close() {
          try { await handle.close(); } finally { active.delete(handle); }
          fault("close", file);
        },
      };
    },
  } };
}
const physicalCases = [];
for (const scope of ["recorded-project", "project"]) {
  for (const storage of ["active", "archived"]) {
    for (const mutation of ["add", "change", "remove"]) physicalCases.push({ scope, storage, mutation, kind: "chain" });
  }
}
for (const kind of ["chain", "aliases", "shadow"]) {
  for (const mutation of ["stable", "reorder", "same-size-restored", "hash-only"]) physicalCases.push({ scope: "recorded-project", storage: "archived", kind, mutation });
}
for (const kind of ["aliases", "shadow"]) {
  for (const mutation of ["add", "change", "remove"]) physicalCases.push({ scope: "project", storage: "active", kind, mutation });
}
physicalCases.push({ scope: "recorded-project", storage: "archived", kind: "chain", mutation: "unknown-added" });
physicalCases.push({ scope: "project", storage: "archived", kind: "chain", mutation: "unrelated-added" });
for (const mutation of ["stable", "add", "remove"]) physicalCases.push({ scope: "project", storage: "archived", kind: "hardlinks", mutation });
for (const test of physicalCases) {
  const { scope, storage, kind, mutation } = test;
  const label = [scope, storage, kind, mutation].join("-");
  const home = path.join(temp, "physical-" + label), active = path.join(home, "sessions"), archive = path.join(home, "archived_sessions");
  await fsp.mkdir(active, { recursive: true });
  await fsp.mkdir(archive);
  const parent = path.join(active, bindingName(bindingParent));
  const child = kind === "shadow" ? parent + ".zst" : path.join(storage === "active" ? active : archive, bindingName(bindingChild));
  const parentBytes = bindingBytes(false);
  const initialChild = kind === "chain" ? bindingBytes(true) : parentBytes;
  // Use a raw zstd frame so same-length payload edits also preserve compressed
  // file size. It is a standard single-segment frame containing one raw block.
  const encodeChild = bytes => {
    if (kind !== "shadow") return bytes;
    const header = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x60, 0, 0, 0, 0, 0]);
    header.writeUInt16LE(bytes.length - 256, 5);
    header.writeUIntLE((bytes.length << 3) | 1, 7, 3);
    return Buffer.concat([header, bytes]);
  };
  await fsp.writeFile(parent, parentBytes);
  if (mutation !== "add") {
    if (kind === "hardlinks") await fsp.link(parent, child);
    else await fsp.writeFile(child, encodeChild(initialChild));
  }
  if (kind === "aliases") await fsp.writeFile(path.join(active, "byte-identical-alias.jsonl"), parentBytes);
  const original = path.join(temp, "physical-original-" + label), retry = path.join(temp, "physical-retry-" + label);
  await bindingCore.exportArchive({ scope: "all", codexHome: home, outputDirectory: original, exportProfile: "complete" });
  const originalManifest = await fsp.readFile(path.join(original, "manifest.json"));
  const prior = await savedExportFixture("physical-prior-" + label);
  const context = createContext(temp);
  context.globalState.values.set(STATE_LAST_SUCCESS, prior);
  const saved = structuredClone([...context.globalState.values]), action = deferred(), calls = [];
  let retrying = false, synthetic = false;
  const frozenStat = mutation === "hash-only" ? await fsp.lstat(child, { bigint: true }) : null;
  const frozenMeta = frozenStat ? await bindingCore.readSessionDiscoveryMeta(child) : null;
  const tracker = trackedBindingIo({
    reverse: () => retrying && mutation === "reorder",
    mapStat: (file, stat) => file === child && frozenStat ? frozenStat : stat,
  });
  const fake = createFakeVscode({
    config: { codexHome: home, outputDirectory: original }, workspaceFolders: [folder(oneWorkspace)],
    errorMessageHandler: (_message, actions) => actions.includes(chooseFolder) ? action.promise : undefined,
    openDialogResult: [{ scheme: "file", fsPath: retry }],
    quickPickSelector: (items, options) => {
      if (options.placeHolder === "Choose what to export") return items.find(item => item.scope === scope);
      if (options.placeHolder === "Choose an export profile") return items.find(item => item.profile === "readable");
      return items[0];
    },
  });
  const adapter = createExtensionAdapterCore(fake.vscode, { fsp: tracker.io, loadExporter: async () => ({ ...bindingCore,
    async readSessionDiscoveryMeta(file, options) {
      const meta = await bindingCore.readSessionDiscoveryMeta(file, options);
      // Digest-only counterexample: report unchanged properties/metadata while
      // real physical bytes beyond the bounded first record are changed.
      return file === child && frozenMeta ? frozenMeta : meta;
    },
    async exportArchive(options) {
      if (synthetic) return exporter.exportArchive(options);
      calls.push(options);
      return bindingCore.exportArchive(options);
    },
  }) });
  await adapter.activate(context);
  await fake.registered.get(COMMANDS.exportMenu)();
  assert.equal(calls.length, 1, label);
  assert.ok(fake.messages.some(message => message.actions.includes(chooseFolder)), label);
  assert.deepEqual([...context.globalState.values], saved, "collision preserves status");
  assert.equal(tracker.active.size, 0, "baseline closes handles before notification");
  assert.ok(tracker.opened.includes(parent));
  if (mutation !== "add") assert.ok(tracker.opened.includes(child), "include duplicate/continuation/shadow before reductions");
  const beforeProperties = mutation === "same-size-restored" ? await fsp.stat(child) : null;
  if (mutation === "remove") await fsp.unlink(child);
  if (["add", "change", "same-size-restored", "hash-only"].includes(mutation)) {
    const bytes = kind === "chain" ? bindingBytes(true, "CHANGED_CHILD_CONTENT") : Buffer.from(parentBytes);
    if (kind !== "chain") bytes[bytes.lastIndexOf("x")] = 121;
    const encoded = encodeChild(bytes);
    if (beforeProperties) assert.equal(encoded.length, beforeProperties.size);
    if (kind === "hardlinks") await fsp.link(parent, child);
    else await fsp.writeFile(child, encoded);
    if (beforeProperties) await fsp.utimes(child, beforeProperties.atime, beforeProperties.mtime);
  }
  if (mutation === "unknown-added") await fsp.writeFile(path.join(archive, "unknown.jsonl"), '{"type":"session_meta","payload":{"id":"unknown"}}\n');
  if (mutation === "unrelated-added") await fsp.writeFile(path.join(active, "unrelated.jsonl"), bindingBytes(false, "", twoWorkspace));
  tracker.opened.length = 0;
  retrying = true;
  action.resolve(chooseFolder);
  const allowed = mutation === "stable" || mutation === "reorder";
  const status = mutation === "unknown-added" ? "RECORDED_PROJECT_INVENTORY_UNVERIFIABLE" : "RECORDED_PROJECT_INVENTORY_CHANGED";
  await waitFor(() => allowed ? context.globalState.get(STATE_LAST_SUCCESS)?.outputDirectory === retry : fake.output.some(line => line.includes(status)), label);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(tracker.active.size, 0, "retry closes handles");
  if (mutation !== "unknown-added") assert.ok(tracker.opened.includes(parent));
  if (allowed) {
    assert.equal(calls.length, 2);
    assert.ok(tracker.opened.includes(child));
    for (const key of ["scope", "codexHome", "exportProfile", "documentFormats", "onSelectRecordedProject"]) assert.deepEqual(calls[1][key], calls[0][key]);
    const manifest = JSON.parse(await fsp.readFile(path.join(retry, "manifest.json"), "utf8"));
    assert.equal(manifest.sessions.length, 1);
    if (kind === "chain") assert.ok((await fsp.readFile(path.join(retry, manifest.sessions[0].markdown_file), "utf8")).includes("ADDED_CHILD_CONTENT"));
  } else {
    assert.equal(calls.length, 1, "reject before retry core");
    assert.equal(fs.existsSync(retry), false);
    assert.deepEqual([...context.globalState.values], saved);
    assert.equal(fake.messages.some(message => message.message.startsWith("Exported ")), false);
    assert.equal(await adapter.openLatestArchive(context), true);
    assert.equal(fake.opened.at(-1), prior.htmlIndexPath);
    assert.equal(await adapter.openExportFolder(context), true);
    assert.equal(fake.opened.at(-1), prior.outputDirectory);
  }
  assert.deepEqual(await fsp.readFile(parent), parentBytes);
  assert.deepEqual(await fsp.readFile(path.join(original, "manifest.json")), originalManifest);
  assert.equal(fs.existsSync(path.join(original, ".codex-export.lock")), false);
  synthetic = true;
  fake.config.set("outputDirectory", path.join(temp, "physical-unlocked-" + label));
  await adapter.exportAllSessions(context);
  assert.equal(context.globalState.get(STATE_LAST_SUCCESS).outputDirectory, fake.config.get("outputDirectory"), "released runtime lock");
  console.log("Security physical " + label + ": PASS");
}

// Failure injection exercises both baseline capture and pre-core retry checks.
// All adapter-owned handles are observed; the real metadata reader is retained.
for (const phase of ["baseline", "retry"]) {
  for (const failure of ["enumerate-error", "enumerate-cancel", "metadata-error", "metadata-cancel", "open-error", "stat-error", "read-error", "read-cancel", "close-error", "unassignable", "mismatched-id", "truncated", "invalid-shadow", "linked-subtree"]) {
    const label = phase + "-" + failure;
    const home = path.join(temp, "binding-fault-" + label), sessions = path.join(home, "sessions");
    await fsp.mkdir(sessions, { recursive: true });
    const source = path.join(sessions, "session.jsonl");
    const bytes = Buffer.concat([bindingBytes(false), Buffer.from(JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "x".repeat(200_000) } }) + "\n")]);
    await fsp.writeFile(source, bytes);
    const prior = path.join(temp, "binding-fault-prior-" + label), original = path.join(temp, "binding-fault-original-" + label), retry = path.join(temp, "binding-fault-retry-" + label);
    const action = deferred(), context = createContext(temp);
    async function addUnverifiableSource() {
      if (failure === "invalid-shadow") await fsp.writeFile(source + ".zst", "invalid zstd bytes");
      if (failure === "linked-subtree") {
        const outside = path.join(temp, "binding-outside-" + label);
        await fsp.mkdir(outside);
        await fsp.writeFile(path.join(outside, "session.jsonl"), bindingBytes(false));
        await fsp.symlink(outside, path.join(sessions, "linked"), process.platform === "win32" ? "junction" : "dir");
      }
    }
    let mode = "success", armed = false, cancel, subscriptions = 0, calls = 0;
    const injectedFailure = () => Object.assign(new Error("injected physical-source failure"), { code: "EACCES" });
    const tracker = trackedBindingIo({ fault(operation) {
      if (!armed) return;
      if (failure === operation + "-cancel") cancel();
      if (failure === operation + "-error") throw injectedFailure();
    } });
    const fake = createFakeVscode({
      config: { codexHome: home, outputDirectory: prior }, workspaceFolders: [folder(oneWorkspace)],
      errorMessageHandler: (_message, actions) => actions.includes(chooseFolder) ? action.promise : undefined,
      openDialogResult: [{ scheme: "file", fsPath: retry }],
    });
    fake.vscode.window.withProgress = async (_options, task) => task({ report() {} }, {
      onCancellationRequested(callback) {
        cancel = callback;
        subscriptions++;
        return { dispose() { subscriptions--; } };
      },
    });
    const adapter = createExtensionAdapterCore(fake.vscode, { fsp: tracker.io, loadExporter: async () => ({ ...bindingCore,
      async readSessionDiscoveryMeta(file, options) {
        if (armed && failure === "metadata-error") throw injectedFailure();
        if (armed && failure === "metadata-cancel") cancel();
        const meta = await bindingCore.readSessionDiscoveryMeta(file, options);
        if (armed && failure === "unassignable") return { ...meta, cwd: "" };
        if (armed && failure === "mismatched-id") return { ...meta, metadataIdMismatch: true };
        if (armed && failure === "truncated") return { ...meta, discoverySnapshot: { ...meta.discoverySnapshot, firstRecordTruncated: true } };
        return meta;
      },
      async exportArchive(options) {
        calls++;
        if (mode === "success") return exporter.exportArchive(options);
        assert.equal(tracker.opened.length, 0, "no full hash before the first collision");
        if (phase === "baseline") armed = true;
        if (armed) await addUnverifiableSource();
        throw collision();
      },
    }) });
    await adapter.activate(context);
    // An ordinary, collision-free project export must never open a full-hash
    // handle, even though the source extends far beyond bounded discovery.
    await fake.registered.get(COMMANDS.exportCurrentWorkspace)();
    assert.equal(calls, 1);
    assert.equal(tracker.opened.length, 0);
    assert.equal(tracker.reads.length, 0);
    assert.equal(subscriptions, 0);
    const saved = structuredClone([...context.globalState.values]);
    const successfulMessages = fake.messages.filter(message => message.message.startsWith("Exported ")).length;
    fake.config.set("outputDirectory", original);
    mode = "collision";
    // Also covers the direct current-workspace entry point (no picker inventory).
    const attempt = adapter.exportCurrentWorkspace(context);
    const cancelled = failure.endsWith("-cancel");
    const code = "RECORDED_PROJECT_INVENTORY_UNVERIFIABLE";
    if (phase === "baseline" && !cancelled) await assert.rejects(attempt, { code });
    else await attempt;
    if (phase === "retry") {
      assert.ok(fake.messages.some(message => message.actions.includes(chooseFolder)));
      assert.equal(tracker.active.size, 0);
      assert.equal(subscriptions, 0);
      const reads = tracker.reads.filter(read => read.file === source);
      assert.equal(reads.reduce((sum, read) => sum + read.bytes, 0), bytes.length, "baseline reads every byte");
      assert.ok(reads.length > 3, "source spans multiple bounded hash reads");
      armed = true;
      await addUnverifiableSource();
      action.resolve(chooseFolder);
    }
    await waitFor(() => fake.output.some(line => line.includes(cancelled ? "Export cancelled." : code)), label);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 2, "no retry core call after capture/check failure");
    assert.equal(tracker.active.size, 0, "close handles on all errors and cancellations");
    assert.equal(subscriptions, 0, "dispose cancellation subscriptions");
    assert.equal(fs.existsSync(retry), false);
    assert.equal(fs.existsSync(original), false, "synthetic collision creates no output");
    assert.deepEqual([...context.globalState.values], saved);
    assert.equal(fake.messages.filter(message => message.message.startsWith("Exported ")).length, successfulMessages);
    if (phase === "baseline") assert.equal(fake.messages.some(message => message.actions.includes(chooseFolder)), false, "never offer a retry without a complete baseline");
    assert.equal(await adapter.openLatestArchive(context), true);
    assert.equal(fake.opened.at(-1), path.join(prior, "index.html"));
    mode = "success";
    armed = false;
    fake.config.set("outputDirectory", path.join(temp, "binding-fault-unlocked-" + label));
    await adapter.exportAllSessions(context);
    assert.equal(calls, 3, "release runtime lock after capture/check failure");
    console.log("Security physical failure " + label + ": PASS");
  }
}

// A second collision cannot replace the original physical binding.
{
  const home = path.join(temp, "binding-second-collision"), sessions = path.join(home, "sessions");
  await fsp.mkdir(sessions, { recursive: true });
  const source = path.join(sessions, "session.jsonl");
  await fsp.writeFile(source, bindingBytes(false));
  const first = path.join(temp, "binding-second-first"), second = path.join(temp, "binding-second-next"), third = path.join(temp, "binding-second-third");
  const actions = [deferred(), deferred()], destinations = [second, third], context = createContext(temp);
  const tracker = trackedBindingIo();
  let calls = 0, synthetic = false, notifications = 0;
  const fake = createFakeVscode({
    config: { codexHome: home, outputDirectory: first }, workspaceFolders: [folder(oneWorkspace)],
    errorMessageHandler: (_message, buttons) => buttons.includes(chooseFolder) ? actions[notifications++].promise : undefined,
    openDialogSelector: () => [{ scheme: "file", fsPath: destinations.shift() }],
  });
  const adapter = createExtensionAdapterCore(fake.vscode, { fsp: tracker.io, loadExporter: async () => ({ ...bindingCore,
    async exportArchive(options) {
      if (synthetic) return exporter.exportArchive(options);
      calls++;
      if (calls === 2) {
        assert.equal(tracker.opened.length, 2, "one baseline hash and one pre-retry hash");
        // The next notification is not yet displayed; recapturing after this
        // collision would bless the new physical source for a third attempt.
        await fsp.writeFile(path.join(sessions, "new-alias.jsonl"), bindingBytes(false));
      }
      throw collision();
    },
  }) });
  await adapter.activate(context);
  await adapter.exportCurrentWorkspace(context);
  await waitFor(() => notifications === 1, "first physical collision");
  actions[0].resolve(chooseFolder);
  await waitFor(() => notifications === 2, "second physical collision");
  assert.equal(tracker.opened.length, 2, "second collision does not reset or rehash the baseline");
  actions[1].resolve(chooseFolder);
  await waitFor(() => fake.output.some(line => line.includes("RECORDED_PROJECT_INVENTORY_CHANGED")), "third collision binding");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 2);
  assert.equal(tracker.active.size, 0);
  assert.equal(context.globalState.values.size, 0);
  for (const directory of [first, second, third]) assert.equal(fs.existsSync(directory), false);
  synthetic = true;
  fake.config.set("outputDirectory", path.join(temp, "binding-second-unlocked"));
  assert.ok(await adapter.exportAllSessions(context));
  console.log("Security physical repeated collision: PASS");
}

async function savedExportFixture(name) {
  const directory = path.join(temp, name);
  await fsp.mkdir(directory);
  const indexPath = path.join(directory, "index.html");
  await fsp.writeFile(indexPath, "<html>synthetic successful export</html>");
  const target = async (targetPath, kind) => ({ path: targetPath, canonicalPath: await fsp.realpath(targetPath),
    identity: testFileIdentity(await fsp.stat(targetPath, { bigint: true })), kind, verifiedAt: "2026-09-24T00:00:00.000Z" });
  return { version: 1, outputDirectory: directory, htmlIndexPath: indexPath, output: await target(directory, "directory"), index: await target(indexPath, "file") };
}
function legacyEntries(record) {
  return [[STATE_OUTPUT_TARGET, record.output], [STATE_LATEST_HTML_TARGET, record.index], [STATE_OUTPUT_DIR, record.outputDirectory], [STATE_LATEST_HTML, record.htmlIndexPath]];
}
const legacyA = await savedExportFixture("security-legacy-a");
const legacyB = await savedExportFixture("security-legacy-b");
// Every possible mix of the old four writes, and every missing component.
for (const scenario of [...Array.from({ length: 16 }, (_, mask) => ({ mask })), ...Array.from({ length: 4 }, (_, missing) => ({ missing }))]) {
  const context = createContext(temp);
  const a = legacyEntries(legacyA);
  const b = legacyEntries(legacyB);
  for (let index = 0; index < a.length; index += 1) {
    if (scenario.missing === index) continue;
    const [key, value] = scenario.mask & (1 << index) ? b[index] : a[index];
    context.globalState.values.set(key, structuredClone(value));
  }
  const before = structuredClone([...context.globalState.values]);
  const fake = createFakeVscode();
  const adapter = createExtensionAdapter(fake.vscode);
  await adapter.activate(context);
  const valid = scenario.missing === undefined && (scenario.mask === 0 || scenario.mask === 15);
  assert.equal(await adapter.openLatestArchive(context), valid, `legacy index ${JSON.stringify(scenario)}`);
  assert.equal(await adapter.openExportFolder(context), valid, `legacy folder ${JSON.stringify(scenario)}`);
  assert.deepEqual([...context.globalState.values], before, "legacy read must not migrate/write state");
}
console.log("Security legacy migration: 20 complete/mixed/incomplete cases PASS");

{
  const nested = await savedExportFixture(path.join("security-legacy-a", "nested-export"));
  for (const storage of ["legacy", "composite"]) {
    const mixed = { ...legacyA, htmlIndexPath: nested.htmlIndexPath, index: nested.index };
    const context = createContext(temp);
    for (const [key, value] of storage === "legacy" ? legacyEntries(mixed) : [[STATE_LAST_SUCCESS, mixed]]) context.globalState.values.set(key, value);
    const fake = createFakeVscode();
    const adapter = createExtensionAdapter(fake.vscode);
    await adapter.activate(context);
    assert.equal(await adapter.openLatestArchive(context), false, "a nested different export is not the folder's own index");
    assert.equal(await adapter.openExportFolder(context), false);
    assert.deepEqual(fake.opened, []);
  }
  const invalidOutput = path.join(temp, "status-nested-core-result");
  const fake = createFakeVscode({ config: { outputDirectory: invalidOutput } });
  const context = createContext(temp);
  context.globalState.values.set(STATE_LAST_SUCCESS, legacyA);
  const saved = structuredClone([...context.globalState.values]);
  let invalid = true;
  const adapter = createExtensionAdapter(fake.vscode, { loadExporter: async () => ({ async exportArchive(options) {
    if (!invalid) return exporter.exportArchive(options);
    await fsp.mkdir(options.outputDirectory);
    const nested = await savedExportFixture(path.join("status-nested-core-result", "different-export"));
    return { outputDirectory: options.outputDirectory, htmlIndexPath: nested.htmlIndexPath };
  } }) });
  await adapter.activate(context);
  await assert.rejects(() => adapter.exportAllSessions(context), /does not belong/);
  assert.deepEqual([...context.globalState.values], saved);
  invalid = false;
  fake.config.set("outputDirectory", `${invalidOutput}-next`);
  await adapter.exportAllSessions(context);
  console.log("Security nested index migration/result: 3 fail-closed cases PASS");
}

for (const invalid of [null, { ...legacyA, version: 2 }, { ...legacyA, index: legacyB.index }, { ...legacyA, htmlIndexPath: legacyB.htmlIndexPath }]) {
  const context = createContext(temp);
  for (const [key, value] of legacyEntries(legacyA)) context.globalState.values.set(key, value);
  context.globalState.values.set(STATE_LAST_SUCCESS, invalid);
  const fake = createFakeVscode();
  const adapter = createExtensionAdapter(fake.vscode);
  await adapter.activate(context);
  assert.equal(await adapter.openLatestArchive(context), false, "invalid new records must not fall back to legacy state");
  assert.equal(await adapter.openExportFolder(context), false);
  assert.deepEqual(fake.opened, []);
}
console.log("Security malformed composite: 4 fail-closed cases PASS");

for (const previousKind of ["legacy", "composite"]) {
  for (const oldFailurePosition of [1, 2, 3, 4]) {
    const context = createContext(temp);
    const entries = previousKind === "legacy" ? legacyEntries(legacyA) : [[STATE_LAST_SUCCESS, legacyA]];
    for (const [key, value] of entries) context.globalState.values.set(key, structuredClone(value));
    context.workspaceState = createState();
    const before = structuredClone([...context.globalState.values]);
    const target = path.join(temp, `atomic-${previousKind}-${oldFailurePosition}`);
    const fake = createFakeVscode({ config: { outputDirectory: target } });
    const adapter = createExtensionAdapter(fake.vscode, { loadExporter: async () => exporter });
    await adapter.activate(context);
    const update = context.globalState.update;
    const writes = [];
    context.globalState.update = async (key, value) => {
      writes.push(key);
      // The old implementation fails at each individual write. Its replacement
      // has one atomic persistence boundary, tested with the same rejection.
      if (key === STATE_LAST_SUCCESS || writes.length === oldFailurePosition) throw new Error("synthetic persistence rejection");
      return update(key, value);
    };
    await assert.rejects(() => adapter.exportAllSessions(context), /synthetic persistence rejection/);
    assert.deepEqual(writes, [STATE_LAST_SUCCESS]);
    assert.deepEqual([...context.globalState.values], before, "failed persistence leaves the complete previous state unchanged");
    assert.equal(await adapter.openLatestArchive(context), true);
    assert.equal(await adapter.openExportFolder(context), true);
    assert.deepEqual(fake.opened, [legacyA.htmlIndexPath, legacyA.outputDirectory]);
    assert.equal(fake.messages.some(message => message.message.startsWith("Exported ")), false);
    context.globalState.update = async (key, value) => { writes.push(key); return update(key, value); };
    const next = `${target}-next`;
    fake.config.set("outputDirectory", next);
    await adapter.exportAllSessions(context);
    assert.deepEqual(writes, [STATE_LAST_SUCCESS, STATE_LAST_SUCCESS], "exactly one update per successful core result; no legacy follow-up writes");
    assert.equal(context.globalState.get(STATE_LAST_SUCCESS).version, 1);
    assert.equal(context.globalState.get(STATE_LAST_SUCCESS).outputDirectory, next);
    if (previousKind === "legacy") for (const [key, value] of entries) assert.deepEqual(context.globalState.get(key), value);
    const reloaded = createExtensionAdapter(fake.vscode);
    await reloaded.activate(context);
    assert.equal(await reloaded.openLatestArchive(context), true);
    assert.equal(await reloaded.openExportFolder(context), true);
    assert.deepEqual(fake.opened.slice(-2), [path.join(next, "index.html"), next]);
    assert.equal(context.workspaceState.values.size, 0);
    console.log(`Security atomic state ${previousKind}-${oldFailurePosition}: PASS`);
  }
}

// Model VS Code's eager Memento cache separately from durable storage. Opening
// while an update is pending or after rejection must still use the old record.
{
  const context = createContext(temp);
  context.globalState.values.set(STATE_LAST_SUCCESS, structuredClone(legacyA));
  const durable = structuredClone([...context.globalState.values]);
  const pending = deferred();
  const started = deferred();
  const target = path.join(temp, "atomic-eager-cache");
  const fake = createFakeVscode({ config: { outputDirectory: target } });
  const adapter = createExtensionAdapter(fake.vscode, { loadExporter: async () => exporter });
  await adapter.activate(context);
  context.globalState.update = async (key, value) => {
    context.globalState.values.set(key, value);
    started.resolve();
    await pending.promise;
    throw new Error("eager cache persistence rejected");
  };
  const running = adapter.exportAllSessions(context);
  const rejection = assert.rejects(running, /eager cache persistence rejected/);
  await started.promise;
  assert.equal(await adapter.openLatestArchive(context), true);
  assert.equal(await adapter.openExportFolder(context), true);
  pending.resolve();
  await rejection;
  assert.equal(await adapter.openLatestArchive(context), true);
  assert.equal(await adapter.openExportFolder(context), true);
  assert.deepEqual(fake.opened, [legacyA.htmlIndexPath, legacyA.outputDirectory, legacyA.htmlIndexPath, legacyA.outputDirectory]);
  const restartedContext = createContext(temp);
  for (const [key, value] of durable) restartedContext.globalState.values.set(key, value);
  const restarted = createExtensionAdapter(fake.vscode);
  await restarted.activate(restartedContext);
  assert.equal(await restarted.openLatestArchive(restartedContext), true);
  assert.equal(fake.opened.at(-1), legacyA.htmlIndexPath);
  context.globalState.update = async (key, value) => { context.globalState.values.set(key, value); };
  fake.config.set("outputDirectory", `${target}-next`);
  await adapter.exportAllSessions(context);
  assert.equal(await adapter.openExportFolder(context), true);
  assert.equal(fake.opened.at(-1), `${target}-next`);
  console.log("Security pending/rejected Memento cache: PASS");
}

for (const scheme of ["vscode-remote", "untitled", "https", "File", undefined]) {
  const invalid = path.join(temp, `non-file-${scheme ?? "missing"}`);
  const valid = `${invalid}-valid`;
  let calls = 0;
  const fake = createFakeVscode({ openDialogResult: [{ scheme, fsPath: invalid }] });
  const context = createContext(temp);
  const adapter = createExtensionAdapter(fake.vscode, { loadExporter: async () => ({ async exportArchive(options) {
    calls += 1;
    return exporter.exportArchive(options);
  } }) });
  await adapter.activate(context);
  assert.equal(await adapter.exportAllSessions(context), undefined);
  assert.equal(calls, 0);
  assert.equal(fs.existsSync(invalid), false);
  assert.equal(context.globalState.values.size, 0);
  assert.match(fake.messages.at(-1).message, /local export folder.*file URI/);
  fake.vscode.window.showOpenDialog = async () => [{ scheme: "file", fsPath: valid }];
  await adapter.exportAllSessions(context);
  assert.equal(calls, 1, "invalid URI must release the runtime lock");
  assert.equal(context.globalState.get(STATE_LAST_SUCCESS).outputDirectory, valid);
  console.log(`Security normal picker ${scheme ?? "missing"}: PASS`);
}

const after = await fsp.readFile(sourceFile, "utf8");
assert.equal(after, before, "synthetic source data must not be modified");

await fsp.rm(temp, { recursive: true, force: true });
console.log("VS Code adapter tests passed");
