import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { COMMANDS, DIAGNOSTIC_BUILD_ID, EXPORT_PROFILES, STATE_LATEST_HTML, STATE_OUTPUT_DIR, createExtensionAdapter, formatExportSummary, resolveConfiguredProfile } = require("../src/vscode-adapter.cjs");

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
      workspaceFolders: overrides.workspaceFolders || [],
      getConfiguration: () => ({
        get: (key, fallback) => config.has(key) ? config.get(key) : fallback,
        inspect: (key) => ({ globalValue: config.has(key) ? config.get(key) : undefined, workspaceValue: undefined, workspaceFolderValue: undefined }),
      }),
    },
    window: {
      createOutputChannel: () => ({ appendLine: (line) => output.push(line), show: () => {}, dispose: () => {} }),
      showWarningMessage: async (message) => { messages.push({ type: "warning", message }); return undefined; },
      showErrorMessage: async (message) => { messages.push({ type: "error", message }); return undefined; },
      showInformationMessage: async (message, ...actions) => { messages.push({ type: "info", message, actions }); return overrides.infoAction; },
      showQuickPick: async (items, options) => {
        quickPicks.push({ items, options });
        if (overrides.quickPickSelector) return overrides.quickPickSelector(items, options);
        if (Object.prototype.hasOwnProperty.call(overrides, "quickPickItem")) return overrides.quickPickItem;
        return items[0];
      },
      showOpenDialog: async (options) => { openDialogs.push(options); return overrides.openDialogResult || []; },
      withProgress: async (options, task) => { progressCalls.push(options); return task({ report: (event) => progressReports.push(event) }); },
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

const temp = await fsp.mkdtemp(path.join(os.tmpdir(), "codex-vscode-test-"));
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
    { label: "Verified source snapshots", profile: "source-snapshots" },
  ]);
  assert.equal("codexProjectChatExporter.includeOriginalJsonl" in extensionPackage.contributes.configuration.properties, false);
  assert.equal("codexProjectChatExporter.exportProfile" in extensionPackage.contributes.configuration.properties, false);
  assert.equal(extensionPackage.version, "0.1.1", "the optimized diagnostic candidate must install as a distinguishable extension version");
  assert.equal(extensionPackage.contributes.configuration.properties["codexProjectChatExporter.diagnosticOutput"].default, false);
  assert.equal(formatExportSummary(1, 1), "1 session across 1 project");
  assert.equal(formatExportSummary(2, 1), "2 sessions across 1 project");
  assert.equal(formatExportSummary(100, 20), "100 sessions across 20 projects");
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
  const infoMessage = fake.messages.find((message) => message.type === "info");
  assert.match(infoMessage.message, /2 sessions across 1 project/);
  assert.match(infoMessage.message, new RegExp(outputDirectory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.deepEqual(infoMessage.actions, ["Open HTML Index", "Open Export Folder"]);
  assert.equal(fake.openDialogs[0].title, "Choose Codex export output folder");
  assert.equal(fake.progressCalls[0].title, "Exporting Codex sessions");
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
  const overlappingExporter = {
    async exportArchive(options) {
      options.onDiagnostic?.({ monotonic_ms: 10, scope: "core", event: "core_start" });
      await new Promise((resolve) => setTimeout(resolve, 10));
      options.onDiagnostic?.({ monotonic_ms: 20, scope: "core", event: "core_end" });
      return { outputDirectory, htmlIndexPath: path.join(outputDirectory, "index.html"), manifestPath: path.join(outputDirectory, "manifest.json"), exportedProjectCount: 1, exportedSessionCount: 1, warnings: [] };
    },
  };
  const adapter = createExtensionAdapter(fake.vscode, { loadExporter: async () => overlappingExporter });
  const activation = await adapter.activate(context);
  await Promise.all([
    fake.registered.get(COMMANDS.exportAllSessions)(),
    fake.registered.get(COMMANDS.exportAllSessions)(),
  ]);
  const diagnostics = activation.getDiagnosticEvents();
  const runIds = [...new Set(diagnostics.map((event) => event.run_id))];
  assert.equal(runIds.length, 2, "overlapping registered commands must retain separate traces");
  for (const runId of runIds) {
    const runEvents = diagnostics.filter((event) => event.run_id === runId);
    assert.equal(runEvents.filter((event) => event.scope === "core" && event.event === "core_start").length, 1);
    assert.equal(runEvents[0].event, "command_start");
    assert.equal(runEvents.at(-1).event, "command_end");
  }
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
  assert.equal(fake.quickPicks.length, 2, "the central command should ask for scope and profile");
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
  const fake = createFakeVscode({ config: { outputDirectory }, quickPickSelector: (items, options) => options?.placeHolder === "Choose what to export" ? items.find((item) => item.label === "All Sessions") : items.find((item) => item.label === "Readable export") });
  const context = createContext(temp);
  const adapter = createExtensionAdapter(fake.vscode, { loadExporter: async () => exporter });
  await adapter.activate(context);
  await fake.registered.get(COMMANDS.exportMenu)();
  assert.equal(lastOptions.scope, "all", "central quick pick should route All Sessions to the all-session export");
  assert.equal(lastOptions.exportProfile, "readable");
}

{
  lastOptions = undefined;
  const fake = createFakeVscode({ config: { outputDirectory }, quickPickSelector: (items, options) => options?.placeHolder === "Choose what to export" ? items.find((item) => item.label === "All Sessions") : items.find((item) => item.label === "Verified source snapshots") });
  const context = createContext(temp);
  const adapter = createExtensionAdapter(fake.vscode, { loadExporter: async () => exporter });
  await adapter.activate(context);
  await fake.registered.get(COMMANDS.exportMenu)();
  assert.equal(lastOptions.exportProfile, "source-snapshots", "the source-snapshot profile must be selectable from the native Quick Pick");
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
  assert.equal(result.exportedSessionCount, 4);
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
  const fake = createFakeVscode({ config: { outputDirectory } });
  const context = createContext(temp);
  const adapter = createExtensionAdapter(fake.vscode, { loadExporter: async () => ({ exportArchive: async () => { throw Object.assign(new Error("Synthetic core failure"), { code: "SYNTHETIC" }); } }) });
  await adapter.activate(context);
  await assert.rejects(() => adapter.exportAllSessions(context), /Synthetic core failure/);
  assert.match(fake.messages.at(-1).message, /SYNTHETIC: Synthetic core failure/);
}

{
  const fake = createFakeVscode({});
  const context = createContext(temp);
  const adapter = createExtensionAdapter(fake.vscode, { loadExporter: async () => exporter });
  await adapter.activate(context);
  assert.equal(await adapter.openLatestArchive(context), false);
  assert.match(fake.messages.at(-1).message, /No latest Codex export/);
  const html = path.join(outputDirectory, "index.html");
  await context.globalState.update(STATE_LATEST_HTML, html);
  assert.equal(await adapter.openLatestArchive(context), true);
  assert.equal(fake.opened.at(-1), html);
}

{
  const fake = createFakeVscode({ config: { outputDirectory } });
  const context = createContext(temp);
  const adapter = createExtensionAdapter(fake.vscode, { loadExporter: async () => exporter });
  await adapter.activate(context);
  assert.equal(await adapter.openExportFolder(context), true);
  assert.equal(fake.opened.at(-1), outputDirectory);
}

{
  const realCodexHome = path.join(temp, "real-core-codex-home");
  const realSessionsDir = path.join(realCodexHome, "sessions", "2026", "08", "16");
  const directOutput = path.join(temp, "real-core-direct-output");
  const adapterOutput = path.join(temp, "real-core-adapter-output");
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
  const directResult = await realExporter.exportArchive({ codexHome: realCodexHome, scope: "all", outputDirectory: directOutput, pathStyle: "readable" });

  const fake = createFakeVscode({ config: { outputDirectory: adapterOutput, codexHome: realCodexHome, pathStyle: "readable" } });
  const context = createContext(temp);
  const adapter = createExtensionAdapter(fake.vscode, { loadExporter: async () => realExporter });
  await adapter.activate(context);
  const adapterResult = await adapter.exportAllSessions(context);
  const directManifest = JSON.parse(await fsp.readFile(directResult.manifestPath, "utf8"));
  const adapterManifest = JSON.parse(await fsp.readFile(adapterResult.manifestPath, "utf8"));
  assert.deepEqual(adapterManifest.sessions, directManifest.sessions, "VS Code delegation and direct shared-core use must produce identical session metadata");
  for (const session of directManifest.sessions) {
    assert.equal(await fsp.readFile(path.join(adapterOutput, session.markdown_file), "utf8"), await fsp.readFile(path.join(directOutput, session.markdown_file), "utf8"));
    assert.deepEqual(await fsp.readFile(path.join(adapterOutput, session.raw_export_file)), await fsp.readFile(path.join(directOutput, session.raw_export_file)));
  }
}

const after = await fsp.readFile(sourceFile, "utf8");
assert.equal(after, before, "synthetic source data must not be modified");

await fsp.rm(temp, { recursive: true, force: true });
console.log("VS Code adapter tests passed");
