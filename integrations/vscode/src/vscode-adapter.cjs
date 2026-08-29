const fs = require("node:fs");
const path = require("node:path");
const { AsyncLocalStorage } = require("node:async_hooks");
const { createHash } = require("node:crypto");
const { performance } = require("node:perf_hooks");
const { pathToFileURL } = require("node:url");

const CONFIG_SECTION = "codexProjectChatExporter";
const DIAGNOSTIC_BUILD_ID = "0.1.3-pre-push";
const STATE_OUTPUT_DIR = "codexProjectChatExporter.outputDirectory";
const STATE_LATEST_HTML = "codexProjectChatExporter.latestHtmlIndexPath";
const STATE_OUTPUT_TARGET = "codexProjectChatExporter.outputDirectoryTarget";
const STATE_LATEST_HTML_TARGET = "codexProjectChatExporter.latestHtmlIndexTarget";
const INCOMPLETE_MARKER_NAME = "EXPORT_INCOMPLETE.txt";
const COMMANDS = {
  exportMenu: "codexArchive.export",
  exportCurrentWorkspace: "codexArchive.exportCurrentWorkspace",
  exportAllSessions: "codexArchive.exportAllSessions",
  openLatestArchive: "codexArchive.openLatestArchive",
  openExportFolder: "codexArchive.openExportFolder",
};
const EXPORT_PROFILES = Object.freeze([
  { label: "Complete export", description: "Raw JSONL checked at export time plus Markdown reading views and HTML index", profile: "complete" },
  { label: "Readable export", description: "Markdown reading views and HTML index without Raw JSONL", profile: "readable" },
  { label: "Source snapshots", description: "Raw JSONL checked at export time and index without human-readable transcripts", profile: "source-snapshots" },
]);
const DOCUMENT_FORMATS = Object.freeze([
  { label: "Standard formats only", description: "Keep the selected profile unchanged", documentFormats: [] },
  { label: "Add DOCX", description: "Create one deterministic DOCX reading view per exported session", documentFormats: ["docx"] },
  { label: "Add PDF", description: "Create one deterministic PDF reading view per exported session", documentFormats: ["pdf"] },
]);

function createExtensionAdapter(vscode, injected = {}) {
  const deps = {
    fs,
    fsp: fs.promises,
    path,
    loadExporter: defaultLoadExporter,
    ...injected,
  };
  let outputChannel;
  const diagnosticEvents = [];
  const diagnosticRunContext = new AsyncLocalStorage();
  let diagnosticRunSequence = 0;
  let exportRunning = false;

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
      { label: "Choose recorded project path…", scope: "recorded-project" },
      { label: "All Sessions", scope: "all" },
    ], { placeHolder: "Choose what to export" });
    if (!picked) return undefined;
    writeDiagnostic("scope_selected", { selected_scope: picked.scope });
    const pickedProfile = await vscode.window.showQuickPick(EXPORT_PROFILES, { placeHolder: "Choose an export profile" });
    if (!pickedProfile) return undefined;
    writeDiagnostic("profile_selected", { profile: pickedProfile.profile });
    const pickedFormats = await vscode.window.showQuickPick(DOCUMENT_FORMATS, { placeHolder: "Choose optional document formats" });
    if (!pickedFormats) return undefined;
    writeDiagnostic("document_formats_selected", { document_formats: pickedFormats.documentFormats });
    if (picked.scope === "project") return exportCurrentWorkspace(context, pickedProfile.profile, pickedFormats.documentFormats);
    if (picked.scope === "recorded-project") {
      const hasWorkspace = (vscode.workspace.workspaceFolders || []).length > 0;
      const workspacePath = hasWorkspace ? await getLocalWorkspacePath() : "";
      if (hasWorkspace && !workspacePath) return undefined;
      return runExport(context, { scope: "recorded-project", workspacePath }, pickedProfile.profile, pickedFormats.documentFormats);
    }
    return exportAllSessions(context, pickedProfile.profile, pickedFormats.documentFormats);
  }

  async function exportCurrentWorkspace(context, explicitProfile, documentFormats = []) {
    const workspacePath = await getLocalWorkspacePath();
    if (!workspacePath) return undefined;
    return runExport(context, { scope: "project", workspacePath }, explicitProfile, documentFormats);
  }

  async function exportAllSessions(context, explicitProfile, documentFormats = []) {
    ensureDesktopLocalExtensionHost();
    return runExport(context, { scope: "all" }, explicitProfile, documentFormats);
  }

  async function runExport(context, scopeOptions, explicitProfile, documentFormats) {
    ensureDesktopLocalExtensionHost();
    if (exportRunning) {
      vscode.window.showWarningMessage("A Codex export is already running. Wait for it to finish before starting another export.");
      return undefined;
    }
    exportRunning = true;
    try {
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
        documentFormats: [...documentFormats],
        pathStyle: config.get("pathStyle", "short"),
        includeTools: getUserOnlyConfigValue("includeTools", false),
      };
      if (scopeOptions.scope !== "all") {
        options.onSelectRecordedProject = async ({ projects, reason }) => {
          if (reason === "no-match") {
            const action = await vscode.window.showWarningMessage(
              "No sessions were recorded for the current workspace path. The project may have been moved, renamed, or previously opened from another folder.",
              "Choose recorded project path…",
            );
            if (action !== "Choose recorded project path…") return null;
          }
          if (!projects.length) {
            await vscode.window.showWarningMessage("No recorded project paths are available in the selected session sources.");
            return null;
          }
          const picked = await vscode.window.showQuickPick(projects.map(project => ({
            label: displayRecordedPath(project.cwd),
            description: `${project.sessionCount} sessions – ${project.sourceBytes} bytes`,
            detail: `Last session: ${project.lastSessionAt || "unknown"}`,
            project,
          })), { placeHolder: "Choose recorded project path…", matchOnDescription: true, matchOnDetail: true });
          if (!picked || !projects.includes(picked.project)) return null;
          if (picked.project.cwd !== scopeOptions.workspacePath) {
            const confirmed = await vscode.window.showWarningMessage(
              `Export all ${picked.project.sessionCount} sessions recorded under ${displayRecordedPath(picked.project.cwd)}? This differs from the current workspace path. Several logically different projects may be mixed under this historical cwd.`,
              { modal: true }, "Export recorded sessions",
            );
            if (confirmed !== "Export recorded sessions") return null;
          }
          return picked.project.cwd;
        };
      }
      const codexHome = getUserOnlyConfigValue("codexHome", "");
      if (codexHome) {
        const validatedCodexHome = validateLocalAbsolutePath(codexHome, "codexProjectChatExporter.codexHome");
        if (!validatedCodexHome) return undefined;
        options.codexHome = validatedCodexHome;
      }

      outputChannel.appendLine(`Starting ${scopeOptions.scope === "all" ? "all-session" : "workspace"} export.`);
      outputChannel.appendLine(`Export profile: ${configuredProfile}`);
      outputChannel.appendLine(`Output directory: ${outputDirectory}`);
      if (scopeOptions.workspacePath) outputChannel.appendLine(`Workspace: ${scopeOptions.workspacePath}`);

      try {
        const withProgressStartedAt = performance.now();
        writeDiagnostic("with_progress_start");
        const abortController = new AbortController();
        const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Exporting Codex sessions", cancellable: true }, async (progress, token) => {
          const coreCallStartedAt = performance.now();
          writeDiagnostic("with_progress_enter");
          options.onProgress = (event) => progress.report({ message: event.message });
          options.abortSignal = abortController.signal;
          const cancellation = token?.onCancellationRequested?.(() => abortController.abort());
          if (diagnosticsEnabled()) options.onDiagnostic = (event) => recordDiagnostic(event);
          writeDiagnostic("core_call_start");
          try {
            const coreResult = await exporter.exportArchive(options);
            writeDiagnostic("core_call_end", { status: "COMPLETED", duration_ms: roundDiagnosticMs(performance.now() - coreCallStartedAt) });
            return coreResult;
          } catch (error) {
            writeDiagnostic("core_call_end", { status: error?.code === "EXPORT_CANCELLED" ? "CANCELLED" : "FAILED", error_code: error?.code || "UNKNOWN", duration_ms: roundDiagnosticMs(performance.now() - coreCallStartedAt) });
            throw error;
          } finally {
            cancellation?.dispose?.();
          }
        });
        writeDiagnostic("with_progress_end", { duration_ms: roundDiagnosticMs(performance.now() - withProgressStartedAt) });
        const openTargets = await captureCompletedExportTargets(result);
        await context.globalState.update(STATE_OUTPUT_TARGET, openTargets.output);
        await context.globalState.update(STATE_LATEST_HTML_TARGET, openTargets.index);
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
        if (action === "Open HTML Index") await openVerifiedTarget(openTargets.index, openTargets.output);
        if (action === "Open Export Folder") await openVerifiedTarget(openTargets.output);
        return result;
      } catch (error) {
        if (error?.code === "EXPORT_CANCELLED") {
          outputChannel.appendLine("Export cancelled before selecting a recorded project.");
          return undefined;
        }
        const message = safeErrorMessage(error);
        outputChannel.appendLine(`Export failed: ${message}`);
        vscode.window.showErrorMessage(`Codex export failed: ${message}`);
        throw error;
      }
    } finally {
      exportRunning = false;
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
    if (vscode.workspace.isTrusted === false) throw new Error("Codex exports are disabled in untrusted VS Code workspaces.");
    if (vscode.env.remoteName) throw new Error(`Remote extension hosts are not supported by this MVP: ${vscode.env.remoteName}`);
    if (vscode.env.uiKind && vscode.env.uiKind !== vscode.UIKind.Desktop) throw new Error("vscode.dev and github.dev are not supported by this MVP.");
  }

  async function resolveOutputDirectory(context) {
    const configValue = getUserOnlyConfigValue("outputDirectory", "");
    if (configValue) return validateAbsoluteOutputDirectory(configValue);
    const remembered = context.globalState.get(STATE_OUTPUT_DIR, "");
    if (remembered) return validateAbsoluteOutputDirectory(remembered);
    const selected = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: "Use Export Folder", title: "Choose Codex export output folder" });
    const folder = selected?.[0]?.fsPath || "";
    return folder ? validateAbsoluteOutputDirectory(folder) : "";
  }

  async function openLatestArchive(context) {
    ensureDesktopLocalExtensionHost();
    const latest = context.globalState.get(STATE_LATEST_HTML, "");
    if (!latest) {
      vscode.window.showWarningMessage("No latest Codex export HTML index was found. Run an export first.");
      return false;
    }
    const validated = validateLocalAbsolutePath(latest, STATE_LATEST_HTML);
    if (!validated) return false;
    const storedIndex = context.globalState.get(STATE_LATEST_HTML_TARGET, null);
    const storedOutput = context.globalState.get(STATE_OUTPUT_TARGET, null);
    if (!storedIndex || !storedOutput || storedIndex.path !== validated) return refuseStaleOpenTarget("latest HTML index");
    return openVerifiedTarget(storedIndex, storedOutput);
  }

  async function openExportFolder(context) {
    ensureDesktopLocalExtensionHost();
    const folder = context.globalState.get(STATE_OUTPUT_DIR, "");
    if (!folder) {
      vscode.window.showWarningMessage("No Codex export folder is configured yet.");
      return false;
    }
    const validated = validateAbsoluteOutputDirectory(folder);
    if (!validated) return false;
    const storedOutput = context.globalState.get(STATE_OUTPUT_TARGET, null);
    if (!storedOutput || storedOutput.path !== validated) return refuseStaleOpenTarget("export folder");
    return openVerifiedTarget(storedOutput);
  }

  function validateAbsoluteOutputDirectory(folder) {
    return validateLocalAbsolutePath(folder, "codexProjectChatExporter.outputDirectory");
  }

  function validateLocalAbsolutePath(folder, settingName) {
    if (isWindowsNetworkOrDevicePath(folder)) {
      vscode.window.showWarningMessage(`The value "${folder}" is a Windows network or device path. Choose an absolute local path in the setting "${settingName}".`);
      return null;
    }
    if (deps.path.isAbsolute(folder)) return folder;
    const example = process.platform === "win32" ? "C:\\Codex-Exports" : "/Users/you/Codex-Exports";
    vscode.window.showWarningMessage(`The value "${folder}" is not an absolute local path. Use an absolute path such as "${example}" in the setting "${settingName}".`);
    return null;
  }

  function getUserOnlyConfigValue(key, fallback) {
    const inspected = getConfig().inspect(key);
    if (!inspected) return fallback;
    const workspaceFields = ["workspaceValue", "workspaceFolderValue", "workspaceLanguageValue", "workspaceFolderLanguageValue"];
    if (workspaceFields.some((field) => inspected[field] !== undefined)) {
      throw new Error(`The sensitive setting "${CONFIG_SECTION}.${key}" must be configured in VS Code User settings, not Workspace or Workspace Folder settings.`);
    }
    return inspected.globalValue ?? inspected.defaultValue ?? fallback;
  }

  async function openFile(filePath) {
    return vscode.env.openExternal(vscode.Uri.file(filePath));
  }

  async function captureCompletedExportTargets(result) {
    const output = await inspectOpenTarget(result.outputDirectory, "directory");
    await assertCompleteExportDirectory(output);
    const index = await inspectOpenTarget(result.htmlIndexPath, "file", output);
    return { index, output };
  }

  async function openVerifiedTarget(record, expectedOutput = null) {
    try {
      const verifiedOutput = expectedOutput ? await verifyOpenTarget(expectedOutput) : null;
      const verified = await verifyOpenTarget(record, verifiedOutput);
      await assertCompleteExportDirectory(verifiedOutput || (verified.kind === "directory" ? verified : null));
      await openFile(verified.path);
      return true;
    } catch (error) {
      if (error?.code === "INCOMPLETE_EXPORT") {
        vscode.window.showWarningMessage(`The saved Codex export is incomplete because ${INCOMPLETE_MARKER_NAME} is present. Use a new empty export folder, or manually inspect and remove the incomplete export before opening it.`);
        return false;
      }
      vscode.window.showWarningMessage(`The saved Codex export target cannot be opened safely because it changed after export. Run a new export before opening it. ${safeErrorMessage(error)}`);
      return false;
    }
  }

  async function assertCompleteExportDirectory(output) {
    if (!output || output.kind !== "directory") throw new Error("Verified export directory data is unavailable");
    const markerPath = deps.path.join(output.canonicalPath, INCOMPLETE_MARKER_NAME);
    try {
      await deps.fsp.lstat(markerPath);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    const error = new Error(`${INCOMPLETE_MARKER_NAME} is present`);
    error.code = "INCOMPLETE_EXPORT";
    throw error;
  }

  function refuseStaleOpenTarget(label) {
    vscode.window.showWarningMessage(`The saved Codex ${label} has no current verification record. Run a new export before opening it.`);
    return false;
  }

  async function verifyOpenTarget(record, expectedOutput = null) {
    if (!record || !["file", "directory"].includes(record.kind) || !record.path || !record.canonicalPath || !record.identity) {
      throw new Error("Stored export target verification data is incomplete");
    }
    const current = await inspectOpenTarget(record.path, record.kind, expectedOutput);
    if (openPathKey(current.canonicalPath) !== openPathKey(record.canonicalPath) || current.identity !== record.identity) {
      throw new Error("Stored export target identity no longer matches");
    }
    return current;
  }

  async function inspectOpenTarget(candidate, kind, expectedOutput = null) {
    if (!deps.path.isAbsolute(candidate) || isWindowsNetworkOrDevicePath(candidate)) throw new Error("Export target is not an absolute local path");
    const absolutePath = deps.path.resolve(candidate);
    const lstat = await deps.fsp.lstat(absolutePath);
    if (lstat.isSymbolicLink()) throw new Error("Symbolic-link or junction export targets are not opened");
    if (kind === "file" && !lstat.isFile()) throw new Error("Expected the export target to be a regular file");
    if (kind === "directory" && !lstat.isDirectory()) throw new Error("Expected the export target to be a directory");
    const canonicalPath = await deps.fsp.realpath(absolutePath);
    if (isWindowsNetworkOrDevicePath(canonicalPath)) throw new Error("Canonical export target is a network or device path");
    if (openPathKey(canonicalPath) !== openPathKey(absolutePath)) throw new Error("Export target resolves through an alias or reparse point");
    const stat = await deps.fsp.stat(canonicalPath, { bigint: true });
    if (kind === "file" && !stat.isFile()) throw new Error("Expected the canonical export target to be a regular file");
    if (kind === "directory" && !stat.isDirectory()) throw new Error("Expected the canonical export target to be a directory");
    const identity = reliableOpenIdentity(stat);
    if (!identity) throw new Error("Reliable export target identity is unavailable");
    if (expectedOutput && !isOpenPathInside(canonicalPath, expectedOutput.canonicalPath)) throw new Error("Export index is outside the verified export folder");
    return { canonicalPath, identity, kind, path: absolutePath, verifiedAt: new Date().toISOString() };
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
  const extensionRoot = await fs.promises.realpath(path.resolve(context.extensionPath));
  const vendorRoot = path.join(context.extensionPath, "vendor", "codex-project-chat-exporter");
  const packagedPath = path.join(vendorRoot, "bin", "export-codex-project-chats.mjs");
  const integrityPath = path.join(vendorRoot, "integrity.json");
  const [vendorStat, packagedStat, integrityStat] = await Promise.all([fs.promises.lstat(vendorRoot), fs.promises.lstat(packagedPath), fs.promises.lstat(integrityPath)]).catch((error) => {
    throw Object.assign(new Error(`The packaged Codex exporter core is missing or inaccessible: ${error?.message || error}`), { code: "PACKAGED_EXPORTER_MISSING" });
  });
  if (!vendorStat.isDirectory() || vendorStat.isSymbolicLink() || !packagedStat.isFile() || packagedStat.isSymbolicLink() || !integrityStat.isFile() || integrityStat.isSymbolicLink()) {
    throw Object.assign(new Error("The packaged Codex exporter core or integrity record is not a regular package file"), { code: "PACKAGED_EXPORTER_INTEGRITY_FAILED" });
  }
  const [canonicalVendorRoot, canonicalModule, canonicalIntegrity] = await Promise.all([fs.promises.realpath(vendorRoot), fs.promises.realpath(packagedPath), fs.promises.realpath(integrityPath)]);
  if (openPathKey(canonicalVendorRoot) !== openPathKey(vendorRoot) || !isOpenPathInside(canonicalVendorRoot, extensionRoot) || !isOpenPathInside(canonicalModule, canonicalVendorRoot) || !isOpenPathInside(canonicalIntegrity, canonicalVendorRoot)) {
    throw Object.assign(new Error("The packaged Codex exporter core resolves outside the installed extension"), { code: "PACKAGED_EXPORTER_INTEGRITY_FAILED" });
  }
  let integrity;
  try {
    integrity = JSON.parse(await fs.promises.readFile(canonicalIntegrity, "utf8"));
  } catch (error) {
    throw Object.assign(new Error(`The packaged Codex exporter integrity record cannot be read: ${error?.message || error}`), { code: "PACKAGED_EXPORTER_INTEGRITY_FAILED" });
  }
  if (integrity?.format !== 1 || !integrity.files || typeof integrity.files !== "object" || Array.isArray(integrity.files)) {
    throw Object.assign(new Error("The packaged Codex exporter integrity record is invalid"), { code: "PACKAGED_EXPORTER_INTEGRITY_FAILED" });
  }
  const expectedFiles = Object.keys(integrity.files).sort(compareOpenPaths);
  if (!expectedFiles.length || !expectedFiles.includes("bin/export-codex-project-chats.mjs") || expectedFiles.some((relative) => !isSafeIntegrityRelativePath(relative) || !isLowerHexSha256(integrity.files[relative]))) {
    throw Object.assign(new Error("The packaged Codex exporter integrity file list is invalid"), { code: "PACKAGED_EXPORTER_INTEGRITY_FAILED" });
  }
  const actualFiles = [];
  async function visit(directory) {
    const entries = (await fs.promises.readdir(directory, { withFileTypes: true })).sort((left, right) => compareOpenPaths(left.name, right.name));
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      const stat = await fs.promises.lstat(candidate);
      if (stat.isSymbolicLink()) throw Object.assign(new Error(`Symbolic links are forbidden in the packaged exporter: ${entry.name}`), { code: "PACKAGED_EXPORTER_INTEGRITY_FAILED" });
      const canonical = await fs.promises.realpath(candidate);
      if (openPathKey(canonical) !== openPathKey(candidate) || !isOpenPathInside(canonical, canonicalVendorRoot)) throw Object.assign(new Error("The packaged exporter tree resolves through an alias or outside its root"), { code: "PACKAGED_EXPORTER_INTEGRITY_FAILED" });
      if (stat.isDirectory()) await visit(candidate);
      else if (stat.isFile()) {
        const relative = path.relative(vendorRoot, candidate).replaceAll("\\", "/");
        if (relative !== "integrity.json") actualFiles.push(relative);
      } else throw Object.assign(new Error("Special files are forbidden in the packaged exporter"), { code: "PACKAGED_EXPORTER_INTEGRITY_FAILED" });
    }
  }
  await visit(vendorRoot);
  actualFiles.sort(compareOpenPaths);
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw Object.assign(new Error("The packaged exporter file tree does not exactly match its integrity record"), { code: "PACKAGED_EXPORTER_INTEGRITY_FAILED" });
  }
  for (const relative of expectedFiles) {
    const actualSha256 = await sha256LocalFile(path.join(vendorRoot, ...relative.split("/")));
    if (actualSha256 !== integrity.files[relative]) throw Object.assign(new Error(`The packaged exporter file does not match its integrity record: ${relative}`), { code: "PACKAGED_EXPORTER_INTEGRITY_FAILED" });
  }
  return import(pathToFileURL(canonicalModule).href);
}

function displayRecordedPath(value) {
  // The label is plain text; make control characters visible without changing
  // the exact inventory value used by the core for selection.
  return [...value].map(character => {
    const code = character.codePointAt(0);
    return code < 32 || code === 127 ? `\\u${code.toString(16).padStart(4, "0")}` : character;
  }).join("");
}

function isSafeIntegrityRelativePath(value) {
  if (typeof value !== "string" || !value || value.startsWith("/") || value.includes("\\")) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment && segment !== "." && segment !== "..");
}

function compareOpenPaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function sha256LocalFile(filePath) {
  const hash = createHash("sha256");
  const input = fs.createReadStream(filePath);
  for await (const chunk of input) hash.update(chunk);
  return hash.digest("hex");
}

function reliableOpenIdentity(stat) {
  if (typeof stat?.dev === "bigint" && typeof stat?.ino === "bigint") {
    if (stat.dev < 0n || stat.ino <= 0n) return null;
    return `${stat.dev}:${stat.ino}`;
  }
  if (!Number.isSafeInteger(stat?.dev) || !Number.isSafeInteger(stat?.ino) || stat.dev < 0 || stat.ino <= 0) return null;
  return `${stat.dev}:${stat.ino}`;
}

function isLowerHexSha256(value) {
  if (typeof value !== "string" || value.length !== 64) return false;
  for (const character of value) {
    if (!(character >= "0" && character <= "9") && !(character >= "a" && character <= "f")) return false;
  }
  return true;
}

function openPathKey(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isOpenPathInside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function safeErrorMessage(error) {
  if (!error) return "Unknown error";
  const code = error.code ? `${error.code}: ` : "";
  return `${code}${error.message || String(error)}`;
}

function isWindowsNetworkOrDevicePath(value) {
  return String(value || "").replaceAll("/", "\\").startsWith("\\\\");
}

module.exports = { COMMANDS, CONFIG_SECTION, DIAGNOSTIC_BUILD_ID, EXPORT_PROFILES, STATE_LATEST_HTML, STATE_LATEST_HTML_TARGET, STATE_OUTPUT_DIR, STATE_OUTPUT_TARGET, createExtensionAdapter, defaultLoadExporter, formatExportSummary, formatRuntimeSummary, isWindowsNetworkOrDevicePath, resolveConfiguredProfile, safeErrorMessage };
