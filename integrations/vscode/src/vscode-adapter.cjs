const fs = require("node:fs");
const path = require("node:path");
const { AsyncLocalStorage } = require("node:async_hooks");
const { performance } = require("node:perf_hooks");
const { pathToFileURL } = require("node:url");

const CONFIG_SECTION = "codexProjectChatExporter";
const DIAGNOSTIC_BUILD_ID = "0.1.1-raw-hash-optimized";
const STATE_OUTPUT_DIR = "codexProjectChatExporter.outputDirectory";
const STATE_LATEST_HTML = "codexProjectChatExporter.latestHtmlIndexPath";
const COMMANDS = {
  exportMenu: "codexArchive.export",
  exportCurrentWorkspace: "codexArchive.exportCurrentWorkspace",
  exportAllSessions: "codexArchive.exportAllSessions",
  openLatestArchive: "codexArchive.openLatestArchive",
  openExportFolder: "codexArchive.openExportFolder",
};
const EXPORT_PROFILES = Object.freeze([
  { label: "Complete export", description: "Verified Raw JSONL plus Markdown reading views and HTML index", profile: "complete" },
  { label: "Readable export", description: "Markdown reading views and HTML index without Raw JSONL", profile: "readable" },
  { label: "Verified source snapshots", description: "Verified Raw JSONL and index without human-readable transcripts", profile: "source-snapshots" },
]);

function createExtensionAdapter(vscode, injected = {}) {
  const deps = {
    fs,
    path,
    loadExporter: defaultLoadExporter,
    ...injected,
  };
  let outputChannel;
  const diagnosticEvents = [];
  const diagnosticRunContext = new AsyncLocalStorage();
  let diagnosticRunSequence = 0;

  async function activate(context) {
    outputChannel = vscode.window.createOutputChannel("Codex Project Chat Exporter");
    const registrations = [
      vscode.commands.registerCommand(COMMANDS.exportMenu, () => runRegisteredCommand(COMMANDS.exportMenu, () => exportFromQuickPick(context))),
      vscode.commands.registerCommand(COMMANDS.exportCurrentWorkspace, () => runRegisteredCommand(COMMANDS.exportCurrentWorkspace, () => exportCurrentWorkspace(context))),
      vscode.commands.registerCommand(COMMANDS.exportAllSessions, () => runRegisteredCommand(COMMANDS.exportAllSessions, () => exportAllSessions(context))),
      vscode.commands.registerCommand(COMMANDS.openLatestArchive, () => openLatestArchive(context)),
      vscode.commands.registerCommand(COMMANDS.openExportFolder, () => openExportFolder(context)),
    ];
    context.subscriptions.push(outputChannel, ...registrations);
    return {
      commands: COMMANDS,
      getDiagnosticEvents: () => diagnosticEvents.map((event) => ({ ...event })),
    };
  }

  async function runRegisteredCommand(command, callback) {
    const runId = `export-${++diagnosticRunSequence}`;
    const diagnosticEnabled = getConfig().get("diagnosticOutput", false) === true;
    return diagnosticRunContext.run({ run_id: runId, enabled: diagnosticEnabled }, async () => {
      const startedAt = performance.now();
      writeDiagnostic("command_start", { command });
      try {
        const result = await callback();
        writeDiagnostic("command_end", { command, status: result === undefined ? "CANCELLED" : "COMPLETED", duration_ms: roundDiagnosticMs(performance.now() - startedAt) });
        return result;
      } catch (error) {
        writeDiagnostic("command_end", { command, status: "FAILED", error_code: error?.code || "UNKNOWN", duration_ms: roundDiagnosticMs(performance.now() - startedAt) });
        throw error;
      }
    });
  }

  async function exportFromQuickPick(context) {
    ensureDesktopLocalExtensionHost();
    const picked = await vscode.window.showQuickPick([
      { label: "Current Workspace", scope: "project" },
      { label: "All Sessions", scope: "all" },
    ], { placeHolder: "Choose what to export" });
    if (!picked) return undefined;
    writeDiagnostic("scope_selected", { selected_scope: picked.scope });
    const pickedProfile = await vscode.window.showQuickPick(EXPORT_PROFILES, { placeHolder: "Choose an export profile" });
    if (!pickedProfile) return undefined;
    writeDiagnostic("profile_selected", { profile: pickedProfile.profile });
    return picked.scope === "project" ? exportCurrentWorkspace(context, pickedProfile.profile) : exportAllSessions(context, pickedProfile.profile);
  }

  async function exportCurrentWorkspace(context, explicitProfile) {
    const workspacePath = await getLocalWorkspacePath();
    if (!workspacePath) return undefined;
    return runExport(context, { scope: "project", workspacePath }, explicitProfile);
  }

  async function exportAllSessions(context, explicitProfile) {
    ensureDesktopLocalExtensionHost();
    return runExport(context, { scope: "all" }, explicitProfile);
  }

  async function runExport(context, scopeOptions, explicitProfile) {
    const adapterExportStartedAt = performance.now();
    writeDiagnostic("adapter_export_start", { selected_scope: scopeOptions.scope, profile: explicitProfile || "complete" });
    const outputDirectory = await resolveOutputDirectory(context);
    if (outputDirectory === null) return undefined;
    if (!outputDirectory) {
      vscode.window.showWarningMessage("No export folder selected.");
      return undefined;
    }

    const config = getConfig();
    const exporter = await deps.loadExporter(context);
    const configuredProfile = resolveConfiguredProfile(explicitProfile);
    const options = {
      scope: scopeOptions.scope,
      workspacePath: scopeOptions.workspacePath,
      outputDirectory,
      exportProfile: configuredProfile,
      pathStyle: config.get("pathStyle", "short"),
      includeTools: config.get("includeTools", false),
    };
    const codexHome = config.get("codexHome", "");
    if (codexHome) options.codexHome = codexHome;

    outputChannel.appendLine(`Starting ${scopeOptions.scope === "all" ? "all-session" : "workspace"} export.`);
    outputChannel.appendLine(`Export profile: ${configuredProfile}`);
    outputChannel.appendLine(`Output directory: ${outputDirectory}`);
    if (scopeOptions.workspacePath) outputChannel.appendLine(`Workspace: ${scopeOptions.workspacePath}`);

    try {
      const withProgressStartedAt = performance.now();
      writeDiagnostic("with_progress_start");
      const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Exporting Codex sessions", cancellable: false }, async (progress) => {
        const coreCallStartedAt = performance.now();
        writeDiagnostic("with_progress_enter");
        options.onProgress = (event) => progress.report({ message: event.message });
        if (diagnosticsEnabled()) options.onDiagnostic = (event) => recordDiagnostic(event);
        writeDiagnostic("core_call_start");
        try {
          const coreResult = await exporter.exportArchive(options);
          writeDiagnostic("core_call_end", { status: "COMPLETED", duration_ms: roundDiagnosticMs(performance.now() - coreCallStartedAt) });
          return coreResult;
        } catch (error) {
          writeDiagnostic("core_call_end", { status: "FAILED", error_code: error?.code || "UNKNOWN", duration_ms: roundDiagnosticMs(performance.now() - coreCallStartedAt) });
          throw error;
        }
      });
      writeDiagnostic("with_progress_end", { duration_ms: roundDiagnosticMs(performance.now() - withProgressStartedAt) });
      await context.globalState.update(STATE_OUTPUT_DIR, result.outputDirectory);
      await context.globalState.update(STATE_LATEST_HTML, result.htmlIndexPath);
      const summary = formatExportSummary(result.exportedSessionCount, result.exportedProjectCount);
      outputChannel.appendLine(`Exported ${summary}.`);
      outputChannel.appendLine(`Output directory: ${result.outputDirectory}`);
      outputChannel.appendLine(`HTML index: ${result.htmlIndexPath}`);
      outputChannel.appendLine(`Manifest: ${result.manifestPath}`);
      if (result.runtimeTimings) outputChannel.appendLine(formatRuntimeSummary(result.runtimeTimings));
      writeDiagnostic("success_message_show", { duration_ms: roundDiagnosticMs(performance.now() - adapterExportStartedAt) });
      const action = await vscode.window.showInformationMessage(`Exported ${summary} to ${result.outputDirectory}.`, "Open HTML Index", "Open Export Folder");
      writeDiagnostic("success_message_resolved", { action: action === "Open HTML Index" ? "OPEN_INDEX" : action === "Open Export Folder" ? "OPEN_FOLDER" : "DISMISSED", duration_ms: roundDiagnosticMs(performance.now() - adapterExportStartedAt) });
      if (action === "Open HTML Index") await openFile(result.htmlIndexPath);
      if (action === "Open Export Folder") await openFile(result.outputDirectory);
      return result;
    } catch (error) {
      const message = safeErrorMessage(error);
      outputChannel.appendLine(`Export failed: ${message}`);
      vscode.window.showErrorMessage(`Codex export failed: ${message}`);
      throw error;
    }
  }

  async function getLocalWorkspacePath() {
    ensureDesktopLocalExtensionHost();
    const folders = vscode.workspace.workspaceFolders || [];
    if (folders.length === 0) {
      vscode.window.showWarningMessage("Open a local folder or workspace before exporting the current workspace.");
      return "";
    }
    const localFolders = folders.filter((folder) => folder.uri?.scheme === "file");
    if (localFolders.length !== folders.length) {
      vscode.window.showWarningMessage("Remote, virtual, and non-file workspaces are not supported by this MVP.");
      return "";
    }
    if (localFolders.length === 1) return localFolders[0].uri.fsPath;
    const picked = await vscode.window.showQuickPick(localFolders.map((folder) => ({ label: path.basename(folder.uri.fsPath) || folder.uri.fsPath, description: folder.uri.fsPath, folder })), { placeHolder: "Choose the local workspace folder to export" });
    return picked?.folder?.uri?.fsPath || "";
  }

  function ensureDesktopLocalExtensionHost() {
    if (vscode.env.remoteName) throw new Error(`Remote extension hosts are not supported by this MVP: ${vscode.env.remoteName}`);
    if (vscode.env.uiKind && vscode.env.uiKind !== vscode.UIKind.Desktop) throw new Error("vscode.dev and github.dev are not supported by this MVP.");
  }

  async function resolveOutputDirectory(context) {
    const configValue = getConfig().get("outputDirectory", "");
    if (configValue) return validateAbsoluteOutputDirectory(configValue);
    const remembered = context.globalState.get(STATE_OUTPUT_DIR, "");
    if (remembered) return validateAbsoluteOutputDirectory(remembered);
    const selected = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: "Use Export Folder", title: "Choose Codex export output folder" });
    const folder = selected?.[0]?.fsPath || "";
    const validated = folder ? validateAbsoluteOutputDirectory(folder) : "";
    if (validated) await context.globalState.update(STATE_OUTPUT_DIR, validated);
    return validated;
  }

  async function openLatestArchive(context) {
    const latest = context.globalState.get(STATE_LATEST_HTML, "");
    if (!latest || !deps.fs.existsSync(latest)) {
      vscode.window.showWarningMessage("No latest Codex export HTML index was found. Run an export first.");
      return false;
    }
    await openFile(latest);
    return true;
  }

  async function openExportFolder(context) {
    const folder = getConfig().get("outputDirectory", "") || context.globalState.get(STATE_OUTPUT_DIR, "");
    if (!folder) {
      vscode.window.showWarningMessage("No Codex export folder is configured yet.");
      return false;
    }
    const validated = validateAbsoluteOutputDirectory(folder);
    if (!validated) return false;
    await openFile(validated);
    return true;
  }

  function validateAbsoluteOutputDirectory(folder) {
    if (deps.path.isAbsolute(folder)) return folder;
    const example = process.platform === "win32" ? "C:\\Codex-Exports" : "/Users/you/Codex-Exports";
    vscode.window.showWarningMessage(`The value "${folder}" is not an absolute output folder. Use an absolute path such as "${example}" in the setting "codexProjectChatExporter.outputDirectory".`);
    return null;
  }

  async function openFile(filePath) {
    return vscode.env.openExternal(vscode.Uri.file(filePath));
  }

  function getConfig() {
    return vscode.workspace.getConfiguration(CONFIG_SECTION);
  }

  function writeDiagnostic(event, details = {}) {
    if (!diagnosticsEnabled()) return;
    recordDiagnostic({ monotonic_ms: roundDiagnosticMs(performance.now()), scope: "adapter", event, ...details });
  }

  function recordDiagnostic(event) {
    if (!diagnosticsEnabled()) return;
    const runId = diagnosticRunContext.getStore()?.run_id;
    const controlledEvent = { ...event, ...(runId && !event.run_id ? { run_id: runId } : {}) };
    diagnosticEvents.push(controlledEvent);
    if (controlledEvent.scope === "adapter" && controlledEvent.event === "command_start") {
      outputChannel?.appendLine(`[DIAG] Diagnostic build ${DIAGNOSTIC_BUILD_ID} | run_id ${controlledEvent.run_id} | command_start`);
    } else {
      outputChannel?.appendLine(`[DIAG] ${JSON.stringify(controlledEvent)}`);
    }
  }

  function diagnosticsEnabled() {
    const active = diagnosticRunContext.getStore();
    if (active) return active.enabled === true;
    return getConfig().get("diagnosticOutput", false) === true;
  }

  return {
    activate,
    exportFromQuickPick,
    exportCurrentWorkspace,
    exportAllSessions,
    getLocalWorkspacePath,
    openExportFolder,
    openLatestArchive,
    resolveOutputDirectory,
    runExport,
  };
}

function roundDiagnosticMs(value) {
  return Math.round(Number(value || 0) * 1000) / 1000;
}

function resolveConfiguredProfile(explicitProfile) {
  return explicitProfile || "complete";
}

function formatExportSummary(sessionCount, projectCount) {
  const sessions = `${sessionCount} ${sessionCount === 1 ? "session" : "sessions"}`;
  const projects = `${projectCount} ${projectCount === 1 ? "project" : "projects"}`;
  return `${sessions} across ${projects}`;
}

function formatRuntimeSummary(timings = {}) {
  const seconds = (value) => `${(Number(value || 0) / 1000).toFixed(1)}s`;
  return `Runtime: ${seconds(timings.total_ms)} total | ${seconds(timings.routing_ms)} routing | ${seconds(timings.snapshots_ms)} snapshots | ${seconds((timings.processing_ms || 0) + (timings.indexes_manifest_ms || 0) + (timings.verification_ms || 0))} output`;
}

async function defaultLoadExporter(context) {
  const devPath = path.resolve(context.extensionPath, "..", "..", "bin", "export-codex-project-chats.mjs");
  const packagedPath = path.join(context.extensionPath, "vendor", "codex-project-chat-exporter", "bin", "export-codex-project-chats.mjs");
  const modulePath = fs.existsSync(devPath) ? devPath : packagedPath;
  return import(pathToFileURL(modulePath).href);
}

function safeErrorMessage(error) {
  if (!error) return "Unknown error";
  const code = error.code ? `${error.code}: ` : "";
  return `${code}${error.message || String(error)}`;
}

module.exports = { COMMANDS, CONFIG_SECTION, DIAGNOSTIC_BUILD_ID, EXPORT_PROFILES, STATE_LATEST_HTML, STATE_OUTPUT_DIR, createExtensionAdapter, formatExportSummary, formatRuntimeSummary, resolveConfiguredProfile, safeErrorMessage };
