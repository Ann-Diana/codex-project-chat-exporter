#!/usr/bin/env node
import fs from "node:fs";
import fsp from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import readline from "node:readline";
import { Writable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  SESSION_READER_IMPLEMENTATION,
  attachmentIdentity,
  createSessionReaderSummary,
  isAttachmentDescriptor,
  streamSessionRecords,
} from "../lib/session-record-reader.mjs";
import {
  ASSET_EXTENSIONS,
  AssetStoreError,
  DeduplicatedAssetStore,
  probeHardLinkSupport,
} from "../lib/asset-store.mjs";
import {
  DOCUMENT_ROLE,
  createDocumentMessage,
  createSessionDocumentHeader,
} from "../lib/document-model.mjs";
import {
  buildDeterministicDocx,
  imageDimensions,
  resolveVerifiedAsset,
  validateCanonicalDocx,
} from "../lib/docx-renderer.mjs";
import {
  buildDeterministicPdf,
  resolveVerifiedPdfAsset,
  validateCanonicalPdfFile,
} from "../lib/pdf-renderer.mjs";
import { extractReadingText } from "../lib/reading-content.mjs";
import { ReadingAssetSelection } from "../lib/reading-asset-selection.mjs";
import { streamJsonlTokens } from "../lib/jsonl-token-adapter.mjs";

const VERSION = "0.3.0";
const ARCHIVE_FORMAT_VERSION = 1;
const EXPORT_PROFILE = Object.freeze({
  COMPLETE: "complete",
  READABLE: "readable",
  SOURCE_SNAPSHOTS: "source-snapshots",
});
const EXPORT_PROFILES = Object.freeze({
  [EXPORT_PROFILE.COMPLETE]: Object.freeze({ raw: true, markdown: true, html: true }),
  [EXPORT_PROFILE.READABLE]: Object.freeze({ raw: false, markdown: true, html: true }),
  [EXPORT_PROFILE.SOURCE_SNAPSHOTS]: Object.freeze({ raw: true, markdown: false, html: true }),
});
const RAW_COPY_STATUS = Object.freeze({
  VERIFIED_AT_EXPORT: "VERIFIED_AT_EXPORT",
  NOT_INCLUDED: "NOT_INCLUDED",
});
const INCOMPLETE_MARKER_NAME = "EXPORT_INCOMPLETE.txt";
const GENERATION_ROOT_FILES = Object.freeze(["manifest.json", "README.txt", "index.html", "index.md"]);
const ASSET_MANIFEST_PATH = "assets/manifest.json";
const ADDITIONAL_EXPORT_FORMATS = Object.freeze({ attachments: true });
const MIRRORED_USER_EVENT_MAX_DELAY_MS = 100;
const attachmentSequenceHashes = new WeakMap();
const USER_RECORD_KIND = Object.freeze({
  DIRECT_USER_TURN: "DIRECT_USER_TURN",
  SUBAGENT_INPUT: "SUBAGENT_INPUT",
  AUTOMATIC_RUNTIME_CONTEXT: "AUTOMATIC_RUNTIME_CONTEXT",
  UNCLASSIFIED_USER_ROLE_RECORD: "UNCLASSIFIED_USER_ROLE_RECORD",
});
const SESSION_KIND = Object.freeze({
  DIRECT_USER: "DIRECT_USER",
  SUBAGENT: "SUBAGENT",
  UNKNOWN: "UNKNOWN",
});
const { args: cliArgs, error: argumentError } = parseCliInvocation(process.argv.slice(2));
const toolRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isCli = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

class ExportError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ExportError";
    this.code = code;
  }
}

if (isCli) {
  if (argumentError) {
    console.error(`Argument error: ${argumentError.message}`);
    console.error("Use --help to show supported options.");
    process.exitCode = 2;
  } else {
    main().catch((error) => {
      console.error("");
      console.error(formatErrorWithHints(error));
      process.exitCode = 1;
    });
  }
}


function formatErrorWithHints(error) {
  const message = error?.message || String(error);
  const lines = ["Export failed:", message, ""];
  if (error?.code === "NO_SESSIONS") {
    lines.push("Common reasons:");
    lines.push("- Codex has not created local session files on this machine.");
    lines.push("- You are using a different CODEX_HOME.");
    lines.push("- Use --sessions-dir, --archived-dir, or --codex-home to point at the right folder.");
    lines.push("");
  } else if (error?.code === "NO_SELECTION") {
    lines.push("Choose one:");
    lines.push("  node ./bin/export-codex-project-chats.mjs --all");
    lines.push("  node ./bin/export-codex-project-chats.mjs --project my-project");
    lines.push("  node ./bin/export-codex-project-chats.mjs --list");
    lines.push("  node ./bin/export-codex-project-chats.mjs --list-sessions");
    lines.push("  node ./bin/export-codex-project-chats.mjs --diagnose");
    lines.push("");
  } else if (error?.code === "NO_PROJECT_MATCH") {
    lines.push("Try this:");
    lines.push("  node ./bin/export-codex-project-chats.mjs --list");
    lines.push("");
    lines.push("Common reasons:");
    lines.push("- The project/work folder name differs from what Codex stored in cwd.");
    lines.push("- The session is not present as a local Codex session file.");
    lines.push("- You are pointing at the wrong Codex home or sessions directory.");
    lines.push("");
  } else if (error?.code === "OUTPUT_IN_TOOL_DIR") {
    lines.push("Common reasons:");
    lines.push("- The output folder points into this exporter tool or repository folder.");
    lines.push("- Generated exports may contain private chat data and should stay outside the public project folder.");
    lines.push("- Choose a separate output folder such as C:\\cx\\codex-export.");
    lines.push("If you really know what you are doing, use:");
    lines.push("  --allow-output-in-tool-dir");
    lines.push("");
  } else if (error?.code === "EXPORT_VERIFICATION_FAILED") {
    lines.push("Common reasons:");
    lines.push("- The output folder is on a restricted or unreliable location.");
    lines.push("- Windows path length or security software interfered with file creation.");
    lines.push("- Try a short output path such as C:\\cx\\codex-export.");
    lines.push("");
  } else if (error?.code === "INCOMPLETE_EXPORT_EXISTS") {
    lines.push("The output folder contains EXPORT_INCOMPLETE.txt and cannot be reused automatically.");
    lines.push("Use a new empty output folder, or manually inspect and remove the incomplete export before retrying.");
    lines.push("");
  }
  lines.push("See FAQ.md in the tool folder for common fixes.");
  return lines.join("\n");
}

async function main() {
  return runCommand(createExportContext(cliArgs), { print: true });
}

async function exportArchive(options = {}) {
  const scope = options.scope || (options.workspacePath ? "project" : "all");
  const context = createExportContext(argsFromExportOptions(options), options.cwd || process.cwd(), {
    onProgress: options.onProgress,
    progressThrottleMs: options.progressThrottleMs,
    onDiagnostic: options.onDiagnostic,
    readerImplementation: options._readerImplementation,
    readerOptions: options._readerOptions,
    assetStoreOptions: options._assetStoreOptions,
    docxOptions: options._docxOptions,
    pdfOptions: options._pdfOptions,
    exactWorkspacePath: scope === "project" && typeof options.workspacePath === "string",
    onSelectRecordedProject: options.onSelectRecordedProject,
    abortSignal: options.abortSignal,
  });
  return runCommand(context, { print: false });
}

function argsFromExportOptions(options) {
  const next = {};
  const scope = options.scope || (options.workspacePath ? "project" : "all");
  if (!["all", "project", "recorded-project"].includes(scope)) throw new ExportError("INVALID_EXPORT_SCOPE", "Unsupported export scope");
  if (scope === "all") next.all = true;
  else if (scope === "recorded-project") {
    if (options.recordedProjectPath !== undefined && (typeof options.recordedProjectPath !== "string" || !options.recordedProjectPath)) throw new ExportError("INVALID_PROJECT_SELECTION", "A recorded project path must be a nonempty string");
    if (!options.recordedProjectPath && typeof options.onSelectRecordedProject !== "function") throw new ExportError("INVALID_PROJECT_SELECTION", "Recorded-project export requires a path or selection callback");
    next["recorded-project"] = options.recordedProjectPath || "";
  } else next.project = options.workspacePath || options.projectFilter || "";
  if (options.recordedProjectPath !== undefined && scope !== "recorded-project") throw new ExportError("INVALID_PROJECT_SELECTION", "recordedProjectPath requires recorded-project scope");
  if (options.outputDirectory) next.out = options.outputDirectory;
  if (options.codexHome) next["codex-home"] = options.codexHome;
  if (options.sessionsDir) next["sessions-dir"] = options.sessionsDir;
  if (options.archivedDir) next["archived-dir"] = options.archivedDir;
  if (options.sessionIndexPath) next["session-index"] = options.sessionIndexPath;
  if (options.pathStyle === "readable") next["readable-paths"] = true;
  if (options.includeTools) next["include-tools"] = true;
  if (options.exportProfile) next.profile = options.exportProfile;
  else if (options.includeOriginalJsonl === false) next["no-raw"] = true;
  if (options.redactMarkdown === false) next["no-redact-markdown"] = true;
  if (options.includeArchived === false) next["no-archived"] = true;
  if (options.allowOutputInToolDir) next["allow-output-in-tool-dir"] = true;
  if (options.performanceProfilePath) next["performance-profile"] = options.performanceProfilePath;
  if (options.documentFormats !== undefined) {
    if (!Array.isArray(options.documentFormats)) throw new ExportError("INVALID_EXPORT_FORMAT", "documentFormats must be an array");
    const unique = new Set(options.documentFormats);
    if (unique.size !== options.documentFormats.length || unique.size > 1 || [...unique].some((format) => format !== "docx" && format !== "pdf")) throw new ExportError("INVALID_EXPORT_FORMAT", `Unsupported document format selection: ${options.documentFormats.join(", ")}`);
    if (unique.size === 1) next.format = [...unique][0];
  }
  return next;
}

function createExportContext(args = {}, cwd = process.cwd(), runtimeOptions = {}) {
  const codexHome = path.resolve(args["codex-home"] || process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
  const sessionsDir = path.resolve(args["sessions-dir"] || path.join(codexHome, "sessions"));
  const archivedSessionsDir = path.resolve(args["archived-dir"] || path.join(codexHome, "archived_sessions"));
  const sessionIndexPath = path.resolve(args["session-index"] || path.join(codexHome, "session_index.jsonl"));
  const pathStyle = args["readable-paths"] ? "readable" : "short";
  const markdownDirName = pathStyle === "readable" ? "markdown" : "md";
  const outputPrefix = pathStyle === "readable" ? "codex-chat-export" : "cx";
  const defaultOutputBase = isPathInside(cwd, toolRoot) ? path.join(os.homedir(), "Documents") : cwd;
  const outputDir = path.resolve(args.out || path.join(defaultOutputBase, `${outputPrefix}-${stampForName(new Date())}`));
  const recordedProjectSelection = Object.hasOwn(args, "recorded-project");
  const projectFilter = recordedProjectSelection ? args["recorded-project"] : args.project || "";
  const exportAll = Boolean(args.all || (!projectFilter && !recordedProjectSelection));
  const exportProfile = resolveExportProfile(args.profile, Boolean(args["no-raw"]));
  const documentFormats = resolveDocumentFormats(args.format);
  const exportFormats = Object.freeze({ ...EXPORT_PROFILES[exportProfile], docx: documentFormats.includes("docx"), pdf: documentFormats.includes("pdf"), ...ADDITIONAL_EXPORT_FORMATS });
  return Object.freeze({
    args: Object.freeze({ ...args }),
    codexHome,
    sessionsDir,
    archivedSessionsDir,
    sessionIndexPath,
    pathStyle,
    markdownDirName,
    outputPrefix,
    defaultOutputBase,
    outputDir,
    projectFilter,
    exportAll,
    recordedProjectSelection,
    exactProjectMatch: recordedProjectSelection || runtimeOptions.exactWorkspacePath === true,
    exactWorkspacePath: runtimeOptions.exactWorkspacePath === true,
    onSelectRecordedProject: runtimeOptions.onSelectRecordedProject,
    abortSignal: runtimeOptions.abortSignal,
    includeTools: Boolean(args["include-tools"]),
    copyRaw: exportFormats.raw,
    redactMarkdown: !args["no-redact-markdown"],
    listOnly: Boolean(args.list),
    listSessionsOnly: Boolean(args["list-sessions"]),
    diagnoseOnly: Boolean(args.diagnose),
    includeArchived: !args["no-archived"],
    allowOutputInToolDir: Boolean(args["allow-output-in-tool-dir"]),
    performanceProfilePath: args["performance-profile"] ? path.resolve(args["performance-profile"]) : "",
    exportProfile,
    documentFormats,
    exportFormats,
    progressReporter: createProgressReporter(runtimeOptions.onProgress, runtimeOptions.progressThrottleMs),
    diagnosticReporter: createDiagnosticReporter(runtimeOptions.onDiagnostic),
    readerImplementation: runtimeOptions.readerImplementation || SESSION_READER_IMPLEMENTATION.STREAMING,
    readerOptions: runtimeOptions.readerOptions || Object.freeze({}),
    assetStoreOptions: runtimeOptions.assetStoreOptions || Object.freeze({}),
    docxOptions: runtimeOptions.docxOptions || Object.freeze({}),
    pdfOptions: runtimeOptions.pdfOptions || Object.freeze({}),
  });
}

function resolveDocumentFormats(requestedFormat) {
  if (!requestedFormat) return Object.freeze([]);
  if (requestedFormat !== "docx" && requestedFormat !== "pdf") throw new ExportError("INVALID_EXPORT_FORMAT", `Unsupported export format: ${requestedFormat}`);
  return Object.freeze([requestedFormat]);
}

function resolveExportProfile(requestedProfile, legacyNoRaw = false) {
  if (requestedProfile) {
    if (!Object.hasOwn(EXPORT_PROFILES, requestedProfile)) throw new ExportError("INVALID_EXPORT_PROFILE", `Unsupported export profile: ${requestedProfile}`);
    return requestedProfile;
  }
  return legacyNoRaw ? EXPORT_PROFILE.READABLE : EXPORT_PROFILE.COMPLETE;
}

function createProgressReporter(callback, throttleMs = 125) {
  if (typeof callback !== "function") return () => {};
  const minimumInterval = Math.max(0, Number.isFinite(throttleMs) ? throttleMs : 125);
  let lastAt = 0;
  let lastPhase = "";
  return (event) => {
    const now = performance.now();
    const phaseChanged = event.phase !== lastPhase;
    const terminal = event.phase === "complete" || (event.phase === "processing" && event.current === event.total);
    if (!phaseChanged && !terminal && now - lastAt < minimumInterval) return;
    lastAt = now;
    lastPhase = event.phase;
    try { callback({ ...event }); } catch {}
  };
}

function createDiagnosticReporter(callback) {
  if (typeof callback !== "function") return () => {};
  return (event, details = {}) => {
    try {
      callback({ monotonic_ms: roundMs(performance.now()), scope: "core", event, ...details });
    } catch {}
  };
}

async function runCommand(context, { print }) {
  const { performanceProfilePath, copyRaw, exportAll, exportProfile } = context;
  const profiler = performanceProfilePath ? createPerformanceProfiler({ rawEnabled: copyRaw, scope: exportAll ? "all" : "workspace", profile: exportProfile }) : null;
  const runState = { sourceProtection: null };
  let result;
  let failure;
  try {
    result = await runCommandInternal(context, { print, profiler, runState });
  } catch (error) {
    failure = context.abortSignal?.aborted && error?.code !== "EXPORT_CANCELLED"
      ? new ExportError("EXPORT_CANCELLED", "Export cancelled during session discovery")
      : error;
  }
  if (profiler && runState.sourceProtection) {
    const profile = profiler.finish({ status: failure ? "FAILED" : "COMPLETED", errorCode: failure?.code || "" });
    await assertPerformanceProfileSeparated(performanceProfilePath, context.outputDir, runState.sourceProtection);
    await ensureSeparatedOutputDirectory(path.dirname(performanceProfilePath), runState.sourceProtection, { rejectSourceDescendants: false });
    await writeSeparatedOutputFile(performanceProfilePath, runState.sourceProtection, (handle) => handle.writeFile(`${JSON.stringify(profile, null, 2)}\n`, "utf8"));
    if (result) {
      result.performanceProfilePath = performanceProfilePath;
      result.performanceProfile = profile;
    }
  }
  if (failure) throw failure;
  return result;
}

async function runCommandInternal(context, { print, profiler, runState }) {
  const {
    args,
    codexHome,
    sessionsDir,
    archivedSessionsDir,
    sessionIndexPath,
    pathStyle,
    markdownDirName,
    outputDir,
    projectFilter,
    exportAll,
    copyRaw,
    listOnly,
    listSessionsOnly,
    diagnoseOnly,
    includeArchived,
    allowOutputInToolDir,
    exportProfile,
    exportFormats,
    progressReporter,
    diagnosticReporter,
  } = context;
  const coreStartedAt = performance.now();
  const runtimeTimings = {
    discovery_ms: 0,
    routing_ms: 0,
    snapshots_ms: 0,
    processing_ms: 0,
    indexes_manifest_ms: 0,
    verification_ms: 0,
  };
  diagnosticReporter("core_start", { profile: exportProfile, scope_kind: exportAll ? "all" : "workspace" });
  throwIfExportAborted(context.abortSignal);
  if (args.help) {
    if (print) printHelp();
    return null;
  }

  if (args.version) {
    if (print) console.log(VERSION);
    return null;
  }

  if (!args.all && !projectFilter && !context.recordedProjectSelection && !listOnly && !listSessionsOnly && !diagnoseOnly) {
    throw new ExportError("NO_SELECTION", "Choose --all or --project <name-or-path>.");
  }

  if (!listOnly && !listSessionsOnly && !diagnoseOnly && !allowOutputInToolDir && isPathInside(outputDir, toolRoot)) {
    throw new ExportError("OUTPUT_IN_TOOL_DIR", `Refusing to export into the tool/repository folder: ${outputDir}`);
  }

  progressReporter({ phase: "discovery", message: "Discovering sessions" });
  diagnosticReporter("discovery_start");
  const discoveryStart = performance.now();
  const locations = [];
  if (fs.existsSync(sessionsDir)) locations.push({ root: sessionsDir, storage: "active" });
  if (includeArchived && fs.existsSync(archivedSessionsDir)) locations.push({ root: archivedSessionsDir, storage: "archived" });
  if (!locations.length) {
    throw new ExportError("NO_SESSIONS", `No Codex session folders found under: ${codexHome}`);
  }

  const files = [];
  for (const location of locations) {
    for (const file of await findJsonlFiles(location.root, context.abortSignal)) files.push({ file, sourceRootPath: location.root, storage: location.storage });
  }
  if (!files.length) {
    throw new ExportError("NO_SESSIONS", `No rollout JSONL files found under: ${locations.map((location) => location.root).join(", ")}`);
  }
  files.sort((a, b) => a.file.localeCompare(b.file));
  const sourceProtection = await createSourceProtection(files, locations, [sessionIndexPath], context.abortSignal);
  runState.sourceProtection = sourceProtection;
  if (!listOnly && !listSessionsOnly && !diagnoseOnly) {
    await assertSeparatedExportRoot(outputDir, locations.map((location) => location.root));
    await ensureSeparatedOutputDirectory(outputDir, sourceProtection);
    await probeHardLinkSupport(outputDir, { io: context.assetStoreOptions.preflightIo });
  }
  throwIfExportAborted(context.abortSignal);
  const titleIndex = await readSessionIndex(sessionIndexPath, profiler, context.abortSignal);
  profiler?.addPhase("session_discovery_and_metadata", performance.now() - discoveryStart);
  runtimeTimings.discovery_ms = roundMs(performance.now() - discoveryStart);
  profiler?.setCounts({ scannedSessions: files.length });
  diagnosticReporter("discovery_end", { duration_ms: roundMs(performance.now() - discoveryStart), scanned_sessions: files.length });
  const needsCompleteInventory = listSessionsOnly || diagnoseOnly || (exportProfile === EXPORT_PROFILE.READABLE && exportAll);
  const parsedEntries = [];
  let metas;
  let projectListMetas;
  if (needsCompleteInventory) {
    const metaMap = new Map();
    for (const entry of files) {
      throwIfExportAborted(context.abortSignal);
      const enriched = await readAndEnrichSession(entry, titleIndex, profiler, "initial_parse_ms", context);
      parsedEntries.push(enriched);
      retainPreferredSession(metaMap, enriched);
    }
    metas = sortedSessionValues(metaMap);
  } else {
    progressReporter({ phase: "routing", message: "Routing sessions" });
    const allRoutingStartedAt = performance.now();
    diagnosticReporter("routing_start", { scanned_sessions: files.length });
    const routingMap = new Map();
    for (let routingIndex = 0; routingIndex < files.length; routingIndex += 1) {
      const entry = files[routingIndex];
      const routingStart = performance.now();
      throwIfExportAborted(context.abortSignal);
      const routing = await readSessionDiscoveryMeta(entry.file, { abortSignal: context.abortSignal });
      const routingMs = performance.now() - routingStart;
      diagnosticReporter("routing_metadata_end", {
        ordinal: routingIndex + 1,
        total: files.length,
        short_id: shortenSessionId(routing.id || routing.session_id || ""),
        size_bytes: routing.fileSize || 0,
        metadata_bytes_read: routing.discoverySnapshot?.bytesRead || 0,
      });
      profiler?.addPhase("routing", routingMs, routing.discoverySnapshot?.bytesRead || 0, 0);
      profiler?.recordSession(routing, "routing_metadata_ms", routingMs, routing.discoverySnapshot?.bytesRead || 0, 0);
      const retained = { ...routing, file: entry.file, sourceRootPath: entry.sourceRootPath, storage: entry.storage };
      diagnosticReporter("routing_session_end", {
        ordinal: routingIndex + 1,
        total: files.length,
        short_id: shortenSessionId(routing.id || routing.session_id || ""),
        size_bytes: routing.fileSize || 0,
        duration_ms: roundMs(performance.now() - routingStart),
        storage: entry.storage,
      });
      retainPreferredSession(routingMap, retained);
    }
    const routed = sortedSessionValues(routingMap);
    projectListMetas = routed;
    metas = routed;
    runtimeTimings.routing_ms = roundMs(performance.now() - allRoutingStartedAt);
    diagnosticReporter("routing_end", { duration_ms: roundMs(performance.now() - allRoutingStartedAt), retained_sessions: routed.length });
  }

  if (listOnly) {
    if (print) printProjectList(metas, context);
    return { projects: metas.length, locations };
  }

  if (listSessionsOnly) {
    if (print) printSessionList(metas, context);
    return { sessions: metas.length, locations };
  }

  if (diagnoseOnly) {
    if (print) printDiagnostics(parsedEntries, metas, locations, context);
    return { parsedEntries: parsedEntries.length, sessions: metas.length, locations };
  }

  let exactSelection = !exportAll && context.exactProjectMatch;
  let selected = metas.filter((meta) => exportAll || (projectFilter && (context.exactWorkspacePath
    ? sameRecordedPathIdentity(meta.cwd, projectFilter)
    : exactSelection ? meta.cwd === projectFilter : matchesProject(meta.cwd, projectFilter))));
  const requestedSelection = context.recordedProjectSelection && !projectFilter;
  if ((requestedSelection || !selected.length) && typeof context.onSelectRecordedProject === "function") {
    const projects = recordedProjectInventory(metas);
    const chosen = await context.onSelectRecordedProject(Object.freeze({ projects, reason: requestedSelection ? "requested" : "no-match" }));
    if (chosen === null || chosen === undefined) throw new ExportError("EXPORT_CANCELLED", "Recorded-project selection was cancelled");
    if (typeof chosen !== "string" || !projects.some(project => project.cwd === chosen)) throw new ExportError("INVALID_PROJECT_SELECTION", "Selected project was not in the recorded inventory");
    selected = metas.filter(meta => meta.cwd === chosen);
    exactSelection = true;
  }
  if (!selected.length) {
    if (print) printProjectList(projectListMetas || metas, context);
    throw new ExportError("NO_PROJECT_MATCH", "No sessions were recorded for the current workspace path. The project may have been moved, renamed, or previously opened from another folder.");
  }
  profiler?.setCounts({ exportedSessions: selected.length });

  if (exactSelection) {
    for (const meta of selected) await assertDiscoveryMetadataUnchanged(meta, context.abortSignal);
  }

  await assertSeparatedExportRoot(outputDir, locations.map((location) => location.root));
  await ensureSeparatedOutputDirectory(outputDir, sourceProtection);
  const exportLock = await acquireExportLock(outputDir, sourceProtection);
  let assetStore = null;
  try {
  const projectDirs = new Map();
  const tasks = selected.map((meta, selectedIndex) => {
    const projectDir = pathStyle === "readable" ? readableProjectDir(projectDirs, meta.cwd) : shortProjectDir(projectDirs, meta.cwd);
    const sessionCode = `s${String(selectedIndex + 1).padStart(4, "0")}`;
    const sourceOriginalFilename = path.basename(meta.file);
    const rawExportName = pathStyle === "readable" ? `${sessionCode}-${sourceOriginalFilename}` : `${sessionCode}.jsonl`;
    const rawRel = path.join("raw", projectDir, rawExportName);
    return { meta, projectDir, sessionCode, sourceOriginalFilename, rawExportName, rawRel, snapshot: null, assetSnapshot: null, parsedSnapshotMeta: null, metadataAlreadyParsed: needsCompleteInventory };
  });
  const plannedPaths = ["manifest.json", "README.txt", ASSET_MANIFEST_PATH];
  if (exportFormats.html) plannedPaths.push("index.html");
  if (exportFormats.markdown) plannedPaths.push("index.md");
  if (copyRaw) plannedPaths.push(...tasks.map((task) => task.rawRel));
  const generation = await beginExportGeneration(outputDir, sourceProtection, { plannedPaths });

  if (exportFormats.markdown) await ensureSeparatedOutputDirectory(path.join(outputDir, markdownDirName), sourceProtection);
  if (exportFormats.docx) await ensureSeparatedOutputDirectory(path.join(outputDir, "docx"), sourceProtection);
  if (exportFormats.pdf) await ensureSeparatedOutputDirectory(path.join(outputDir, "pdf"), sourceProtection);
  if (copyRaw) await ensureSeparatedOutputDirectory(path.join(outputDir, "raw"), sourceProtection);
  await ensureSeparatedOutputDirectory(path.join(outputDir, "assets"), sourceProtection);
  assetStore = await DeduplicatedAssetStore.create({
    assetRoot: path.join(outputDir, "assets"),
    exportRoot: outputDir,
    assertDestination: (destinationPath) => assertGenerationDestinationWritable(destinationPath, generation),
    publishManifest: (content) => writeSeparatedOutputFile(path.join(outputDir, ASSET_MANIFEST_PATH), sourceProtection, (handle) => handle.writeFile(content, "utf8"), generation),
    io: context.assetStoreOptions.io,
  });

  const snapshotsStartedAt = performance.now();
  if (copyRaw) progressReporter({ phase: "snapshot", message: "Verifying source snapshots" });
  for (let selectedIndex = 0; selectedIndex < tasks.length; selectedIndex += 1) {
    const task = tasks[selectedIndex];
    const { meta, projectDir, sessionCode, sourceOriginalFilename, rawExportName, rawRel } = task;
    const sessionStartedAt = performance.now();
    const diagnosticContext = {
      ordinal: selectedIndex + 1,
      total: selected.length,
      short_id: shortenSessionId(meta.id || meta.session_id || ""),
      size_bytes: meta.fileSize || 0,
      storage: meta.storage || "active",
    };
    diagnosticReporter("session_start", diagnosticContext);
    progressReporter({
      phase: "processing",
      message: `Processing session ${selectedIndex + 1} of ${selected.length}`,
      current: selectedIndex + 1,
      total: selected.length,
      sessionId: shortenSessionId(meta.id || meta.session_id || ""),
    });
    let snapshot = null;
    if (copyRaw) {
      await ensureSeparatedOutputDirectory(path.join(outputDir, "raw", projectDir), sourceProtection);
      const rawPath = path.join(outputDir, rawRel);
      const verifyPublishedSnapshot = (exportFormats.markdown || exportFormats.docx || exportFormats.pdf) && !needsCompleteInventory
        ? async (publishedPath) => {
            const parseStart = performance.now();
            const parsedMeta = await readSessionMeta(publishedPath, {
              fallbackSessionId: meta.idSource === "metadata_fallback" ? "" : meta.id,
              fallbackTimestamp: meta.timestamp,
              collectAttachmentMetrics: Boolean(profiler),
              calculateSha256: true,
              readerImplementation: context.readerImplementation,
              readerOptions: context.readerOptions,
            });
            const parseMs = performance.now() - parseStart;
            profiler?.addPhase("parse_and_classify", parseMs, parsedMeta.fileSize, 0);
            profiler?.recordSession(meta, "snapshot_parse_ms", parseMs, parsedMeta.fileSize, 0);
            return {
              sha256: parsedMeta.fileSha256,
              sizeBytes: parsedMeta.fileReadAfterSizeBytes,
              stable: parsedMeta.fileReadStable,
              value: parsedMeta,
            };
          }
        : null;
      snapshot = await copyStableRawSnapshot(meta.file, rawPath, {
        profiler,
        profileSession: meta,
        diagnostic: diagnosticReporter,
        diagnosticContext,
        routingSnapshot: meta.routingSnapshot,
        requiredSourceSha256: exactSelection ? meta.routingSnapshot?.sha256 || meta.fileSha256 : undefined,
        verifyPublishedSnapshot,
        generation,
      });
    }
    task.snapshot = snapshot;
    task.parsedSnapshotMeta = snapshot?.verificationValue || null;
    diagnosticReporter("session_end", { ...diagnosticContext, duration_ms: roundMs(performance.now() - sessionStartedAt), snapshot_attempts: snapshot?.attempts || 0 });
  }
  runtimeTimings.snapshots_ms = roundMs(performance.now() - snapshotsStartedAt);

  progressReporter({ phase: "assets", message: "Collecting deduplicated assets" });
  const assetsStartedAt = performance.now();
  diagnosticReporter("assets_start", { sessions: tasks.length });
  for (const task of tasks) {
    const parsePath = copyRaw ? path.join(outputDir, task.rawRel) : task.meta.file;
    task.assetSnapshot = await collectSessionAssets(parsePath, task.parsedSnapshotMeta?.id || task.meta.id || task.meta.session_id, assetStore, context.includeTools, context.readerImplementation, context.readerOptions);
    const expectedSha256 = copyRaw ? task.snapshot?.sha256 : task.meta.fileSha256;
    if (expectedSha256 && task.assetSnapshot.sha256 !== expectedSha256) throw new ExportError("SOURCE_CHANGED_DURING_EXPORT", "Session content changed before its assets were collected");
  }
  runtimeTimings.assets_ms = roundMs(performance.now() - assetsStartedAt);
  profiler?.addPhase("assets", performance.now() - assetsStartedAt);
  diagnosticReporter("assets_end", { duration_ms: runtimeTimings.assets_ms, sessions: tasks.length });

  if (exportFormats.markdown || exportFormats.docx || exportFormats.pdf) progressReporter({ phase: "rendering", message: "Rendering reading views" });
  const processingStartedAt = performance.now();
  const rows = [];
  for (const task of tasks) rows.push(await processExportTask(task, titleIndex, profiler, context, sourceProtection, generation, assetStore));
  runtimeTimings.processing_ms = roundMs(performance.now() - processingStartedAt);

  const assetPublication = await assetStore.publish();

  progressReporter({ phase: "writing", message: "Writing indexes and manifest" });
  const indexesManifestStartedAt = performance.now();
  diagnosticReporter("indexes_and_manifest_start");
  const manifest = await writeIndexFiles(outputDir, rows, profiler, context, sourceProtection, generation, assetPublication.summary, assetStore);
  const summaryStart = performance.now();
  diagnosticReporter("summary_start");
  await writeSummary(outputDir, rows, context, sourceProtection, generation, assetPublication.summary);
  profiler?.addPhase("other", performance.now() - summaryStart, 0, (await fsp.stat(path.join(outputDir, "README.txt"))).size);
  diagnosticReporter("summary_end", { duration_ms: roundMs(performance.now() - summaryStart) });
  let verificationElapsedMs = 0;
  const contentVerificationStartedAt = performance.now();
  diagnosticReporter("verification_start", { sessions: rows.length });
  await verifyExport(outputDir, rows, profiler, context, { assetManifest: assetPublication.content, assetStore, includeManifest: false });
  verificationElapsedMs += performance.now() - contentVerificationStartedAt;
  const manifestStart = performance.now();
  diagnosticReporter("manifest_start", { sessions: rows.length });
  await writeSeparatedOutputFile(path.join(outputDir, "manifest.json"), sourceProtection, (handle) => handle.writeFile(manifest, "utf8"), generation);
  profiler?.addPhase("manifest", performance.now() - manifestStart, 0, Buffer.byteLength(manifest));
  diagnosticReporter("manifest_end", { duration_ms: roundMs(performance.now() - manifestStart), bytes_written: Buffer.byteLength(manifest) });
  diagnosticReporter("indexes_and_manifest_end");
  runtimeTimings.indexes_manifest_ms = roundMs(performance.now() - indexesManifestStartedAt);
  const finalVerificationStartedAt = performance.now();
  await verifyExport(outputDir, rows, profiler, context, { assetManifest: assetPublication.content, assetStore, includeManifest: true, expectedManifest: manifest });
  await completeExportGeneration(generation);
  verificationElapsedMs += performance.now() - finalVerificationStartedAt;
  runtimeTimings.verification_ms = roundMs(verificationElapsedMs);
  diagnosticReporter("verification_end", { duration_ms: runtimeTimings.verification_ms, sessions: rows.length });
  progressReporter({ phase: "complete", message: "Export complete" });
  diagnosticReporter("core_end", { duration_ms: roundMs(performance.now() - coreStartedAt), exported_sessions: rows.length });

  const result = {
    outputDirectory: outputDir,
    htmlIndexPath: exportFormats.html ? path.join(outputDir, "index.html") : "",
    markdownIndexPath: exportFormats.markdown ? path.join(outputDir, "index.md") : "",
    manifestPath: path.join(outputDir, "manifest.json"),
    assetManifestPath: path.join(outputDir, ...ASSET_MANIFEST_PATH.split("/")),
    assetSummary: assetPublication.summary,
    exportProfile,
    formats: { ...exportFormats },
    exportedProjectCount: new Set(rows.map((row) => row.project || "unknown")).size,
    exportedSessionCount: rows.length,
    activeSessionCount: rows.filter((row) => row.storage === "active").length,
    archivedSessionCount: rows.filter((row) => row.storage === "archived").length,
    warnings: [],
    runtimeTimings: {
      ...runtimeTimings,
      total_ms: roundMs(performance.now() - coreStartedAt),
    },
    rows,
  };

  if (print) printExportResult(result, context);
  return result;
  } catch (error) {
    try { await assetStore?.abort(); } catch (cleanupError) {
      throw new AssetStoreError("ASSET_CLEANUP_ERROR", "Asset cleanup failed while aborting an incomplete export", new AggregateError([error, cleanupError]));
    }
    throw error;
  } finally {
    await releaseExportLock(exportLock);
  }
}

function printExportResult(result, context) {
  const { exportProfile, pathStyle, exportFormats, markdownDirName, copyRaw } = context;
  console.log("");
  console.log(`Export complete: ${result.outputDirectory}`);
  console.log(`Sessions: ${result.exportedSessionCount}`);
  console.log(`Active: ${result.activeSessionCount}`);
  console.log(`Archived: ${result.archivedSessionCount}`);
  console.log(`Assets: ${result.assetSummary.assetOccurrences} occurrence(s), ${result.assetSummary.uniqueAssets} unique, ${result.assetSummary.uniqueAssetBytes} byte(s)`);
  console.log(`Profile: ${exportProfile}`);
  console.log(`Path style: ${pathStyle}`);
  if (exportFormats.markdown) console.log(`Markdown: ${path.join(result.outputDirectory, markdownDirName)}`);
  if (copyRaw) console.log(`Raw data: ${path.join(result.outputDirectory, "raw")}`);
  console.log(`Asset data: ${path.join(result.outputDirectory, "assets")}`);
  if (result.htmlIndexPath) console.log(`HTML index: ${result.htmlIndexPath}`);
  if (result.markdownIndexPath) console.log(`Markdown index: ${result.markdownIndexPath}`);
  console.log("");
  console.log("Next steps:");
  const nextSteps = [];
  if (result.htmlIndexPath) nextSteps.push(`Open ${result.htmlIndexPath} to browse the export in your browser.`);
  if (exportFormats.markdown) nextSteps.push(`Spot-check a few files in ${path.join(result.outputDirectory, markdownDirName)}.${result.markdownIndexPath ? ` Markdown users can also open ${result.markdownIndexPath}.` : ""}`);
  if (copyRaw) nextSteps.push("Keep the raw/ folder private.");
  nextSteps.push("Keep assets/ and both manifests private until they have been reviewed.");
  nextSteps.forEach((step, index) => console.log(`${index + 1}. ${step}`));
}
function recordedProjectInventory(metas) {
  const groups = new Map();
  for (const meta of metas) {
    if (typeof meta.cwd !== "string" || !meta.cwd) continue;
    let group = groups.get(meta.cwd);
    if (!group) { group = { cwd: meta.cwd, sessionCount: 0, sourceBytes: 0, lastSessionAt: "" }; groups.set(meta.cwd, group); }
    group.sessionCount++;
    group.sourceBytes += Number.isSafeInteger(meta.fileSize) && meta.fileSize > 0 ? meta.fileSize : 0;
    const timestamp = meta.recordedLastSessionAt || meta.timestamp;
    const date = typeof timestamp === "string" ? Date.parse(timestamp) : NaN;
    if (Number.isFinite(date) && (!group.lastSessionAt || date > Date.parse(group.lastSessionAt))) group.lastSessionAt = new Date(date).toISOString();
  }
  return Object.freeze([...groups.values()].sort((a, b) => a.cwd < b.cwd ? -1 : a.cwd > b.cwd ? 1 : 0).map(Object.freeze));
}

function observeRecordedTimestamp(meta, value) {
  if (typeof value !== "string") return;
  const milliseconds = Date.parse(value);
  if (Number.isFinite(milliseconds) && (meta.recordedLastSessionMs === undefined || milliseconds > meta.recordedLastSessionMs)) {
    meta.recordedLastSessionMs = milliseconds;
    meta.recordedLastSessionAt = new Date(milliseconds).toISOString();
  }
}

function parseArgs(argv) {
  const parsed = {};
  const flagArgs = new Set(["all", "include-tools", "no-raw", "no-redact-markdown", "no-archived", "list", "list-sessions", "diagnose", "help", "version", "readable-paths", "allow-output-in-tool-dir"]);
  const valueArgs = new Set(["project", "recorded-project", "out", "codex-home", "sessions-dir", "archived-dir", "session-index", "performance-profile", "profile", "format"]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "-v") {
      parsed.version = true;
      continue;
    }
    if (!arg.startsWith("--")) throw new Error(`Unexpected positional argument: ${arg}`);
    const name = arg.slice(2);
    if (flagArgs.has(name)) {
      parsed[name] = true;
    } else if (valueArgs.has(name)) {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) throw new Error(`Argument --${name} needs a value.`);
      parsed[name] = value;
      i += 1;
    } else {
      throw new Error(`Unknown option: --${name}`);
    }
  }
  if ([parsed.all, parsed.project, parsed["recorded-project"]].filter(Boolean).length > 1) throw new Error("Use only one of --all, --project or --recorded-project.");
  if (parsed.profile && !Object.hasOwn(EXPORT_PROFILES, parsed.profile)) throw new Error(`Unsupported export profile: ${parsed.profile}`);
  return parsed;
}

function throwIfExportAborted(signal) {
  if (signal?.aborted) throw new ExportError("EXPORT_CANCELLED", "Export cancelled during session discovery");
}

async function findJsonlFiles(root, signal) {
  const results = [];
  async function walk(dir) {
    throwIfExportAborted(signal);
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      throwIfExportAborted(signal);
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".jsonl")) results.push(full);
    }
  }
  await walk(root);
  return results;
}

async function readSessionIndex(indexPath, profiler = null, signal = undefined) {
  const result = new Map();
  throwIfExportAborted(signal);
  if (!fs.existsSync(indexPath)) return result;
  const indexStat = await fsp.stat(indexPath).catch(() => null);
  profiler?.addPhase("session_discovery_and_metadata", 0, indexStat?.size || 0, 0);
  const rl = readline.createInterface({ input: fs.createReadStream(indexPath, { encoding: "utf8", signal }), crlfDelay: Infinity });
  for await (const line of rl) {
    throwIfExportAborted(signal);
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line);
      if (item.id) result.set(item.id, { threadName: item.thread_name || "", updatedAt: item.updated_at || "" });
    } catch {}
  }
  return result;
}

async function readSessionMeta(file, {
  fallbackSessionId = "",
  fallbackTimestamp = "",
  collectAttachmentMetrics = false,
  calculateSha256 = false,
  readerImplementation = SESSION_READER_IMPLEMENTATION.STREAMING,
  readerOptions = {},
} = {}) {
  const filenameId = extractSessionIdFromFilename(file);
  const stat = await fsp.stat(file).catch(() => null);
  const readerSummary = createSessionReaderSummary();
  const classifier = createSessionEventClassifier();
  const meta = {
    file,
    id: filenameId || fallbackSessionId,
    session_id: filenameId || fallbackSessionId,
    idSource: filenameId ? "filename" : (fallbackSessionId ? "source_mapping" : ""),
    metadataId: "",
    metadataIdMismatch: false,
    cwd: "",
    timestamp: "",
    source: "",
    threadSource: "",
    parentThreadId: "",
    model: "",
    firstUserText: "",
    firstCwdText: "",
    hasSessionMeta: false,
    parsedLines: 0,
    jsonlLineCount: 0,
    parsedEventCount: 0,
    invalidJsonLines: 0,
    fileSize: stat?.size || 0,
    latestTimestamp: "",
    attachmentMetrics: collectAttachmentMetrics ? createAttachmentMetrics() : null,
    fileSha256: "",
    fileReadBeforeSizeBytes: stat?.size ?? null,
    fileReadBeforeMtimeMs: stat?.mtimeMs ?? null,
    fileReadAfterSizeBytes: null,
    fileReadAfterMtimeMs: null,
    fileReadStable: false,
  };
  for await (const { item, recordNumber } of streamSessionRecords(file, {
    ...readerOptions,
    calculateSha256,
    implementation: readerImplementation,
    summary: readerSummary,
  })) {
    if (meta.attachmentMetrics) observeAttachmentMetrics(item, meta.attachmentMetrics);
    classifier.observe(item, recordNumber);
    observeRecordedTimestamp(meta, item.timestamp);
    if (item.timestamp && (!meta.latestTimestamp || item.timestamp > meta.latestTimestamp)) meta.latestTimestamp = item.timestamp;
    if (item.type === "session_meta" && item.payload) {
      const payloadId = item.payload.id || item.payload.session_id || "";
      if (!meta.hasSessionMeta) {
        meta.hasSessionMeta = true;
        meta.metadataId = payloadId;
        if (!meta.id && payloadId) {
          meta.id = payloadId;
          meta.session_id = item.payload.session_id || payloadId;
          meta.idSource = "session_meta";
        } else if (payloadId && meta.id && payloadId !== meta.id) {
          meta.metadataIdMismatch = true;
        }
        meta.cwd = item.payload.cwd || meta.cwd;
        meta.timestamp = item.payload.timestamp || item.timestamp || meta.timestamp;
        meta.source = item.payload.source || meta.source;
        meta.threadSource = item.payload.thread_source || meta.threadSource;
        meta.parentThreadId = item.payload.parent_thread_id || meta.parentThreadId;
      } else {
        meta.cwd = meta.cwd || item.payload.cwd || "";
        meta.timestamp = meta.timestamp || item.payload.timestamp || item.timestamp || "";
      }
    }
    if (item.type === "turn_context" && item.payload) {
      meta.cwd = item.payload.cwd || meta.cwd;
      meta.model = item.payload.model || meta.model;
    }
    if (item.type === "response_item" && item.payload?.type === "message" && item.payload?.role === "user" && !meta.firstCwdText) {
      meta.firstCwdText = extractText(item.payload.content);
    }
  }
  if (meta.attachmentMetrics) finishAttachmentMetrics(meta.attachmentMetrics);
  meta.parsedLines = readerSummary.physicalLineCount;
  meta.jsonlLineCount = readerSummary.nonEmptyLineCount;
  meta.parsedEventCount = readerSummary.recordCount;
  meta.invalidJsonLines = readerSummary.invalidRecordCount;
  const eventAnalysis = classifier.finish();
  meta.eventAnalysis = eventAnalysis;
  meta.firstUserText = eventAnalysis.firstDirectUserText;
  meta.sessionKind = eventAnalysis.sessionKind;
  if (!meta.cwd && meta.firstCwdText) meta.cwd = extractCwdFromText(meta.firstCwdText) || meta.cwd;
  if (!meta.timestamp) meta.timestamp = fallbackTimestamp || (stat ? stat.mtime.toISOString() : "");
  if (!meta.latestTimestamp) meta.latestTimestamp = meta.timestamp;
  if (calculateSha256) {
    meta.fileSha256 = readerSummary.fileSha256;
    meta.fileReadAfterSizeBytes = readerSummary.afterSizeBytes;
    meta.fileReadAfterMtimeMs = readerSummary.afterMtimeMs;
    meta.fileReadStable = readerSummary.stable;
  }
  return meta;
}

const DISCOVERY_RECORD_MAX_BYTES = 16 * 1024 * 1024;
const DISCOVERY_TYPE_PROBE_MAX_BYTES = 64 * 1024;
// Type probing stays small so a non-metadata first record stops immediately.
// Confirmed metadata is tokenized from a bounded first-record stream without
// retaining unrelated fields. At most 4095 bytes beyond its newline can enter
// the read buffer, and those bytes are never tokenized, hashed, or exposed.
const DISCOVERY_TYPE_READ_CHUNK_BYTES = 64;
const DISCOVERY_METADATA_READ_CHUNK_BYTES = 4096;
const DISCOVERY_FIELD_LIMITS = Object.freeze({
  type: 64,
  "payload.cwd": 32 * 1024,
  "payload.id": 4 * 1024,
  "payload.session_id": 4 * 1024,
  "payload.timestamp": 256,
  "payload.source": 4 * 1024,
  "payload.thread_source": 4 * 1024,
  "payload.parent_thread_id": 4 * 1024,
});

async function readSessionDiscoveryMeta(file, { abortSignal, maxRecordBytes = DISCOVERY_RECORD_MAX_BYTES, io = {} } = {}) {
  if (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes <= 0) throw new TypeError("maxRecordBytes must be a positive safe integer");
  throwIfExportAborted(abortSignal);
  const before = await (io.stat || fsp.stat)(file, { bigint: true });
  throwIfExportAborted(abortSignal);
  const beforeIdentity = reliableFileIdentity(before);
  if (!before.isFile() || !beforeIdentity) throw new ExportError("UNSAFE_SESSION_SOURCE", "Session discovery requires a regular source with reliable identity");
  const probe = await probeDiscoveryRecordType(file, { abortSignal, io });
  throwIfExportAborted(abortSignal);
  const metadataTypeConfirmed = probe.type.status === "FOUND" && ["session_meta", "turn_context"].includes(probe.type.value);
  const streamed = metadataTypeConfirmed
    ? await streamDiscoveryRecordFields(file, { abortSignal, maxRecordBytes, io })
    : null;
  throwIfExportAborted(abortSignal);
  const after = await (io.stat || fsp.stat)(file, { bigint: true });
  if (reliableFileIdentity(after) !== beforeIdentity || before.size !== after.size || before.mtimeNs !== after.mtimeNs) {
    throw new ExportError("SOURCE_CHANGED_DURING_EXPORT", "Session metadata changed while it was discovered");
  }
  const filenameId = extractSessionIdFromFilename(file);
  const fields = streamed?.fields || null;
  const firstRecordSha256 = streamed?.firstRecordSha256 || probe.firstRecordPrefixSha256;
  const payloadId = fields?.type === "session_meta" ? fields.id || fields.sessionId || "" : "";
  const fallbackId = `metadata-${firstRecordSha256.slice(0, 16)}`;
  return {
    file,
    id: filenameId || payloadId || fallbackId,
    session_id: filenameId || fields?.sessionId || payloadId || fallbackId,
    idSource: filenameId ? "filename" : (payloadId ? "session_meta" : "metadata_fallback"),
    metadataId: payloadId,
    metadataIdMismatch: Boolean(filenameId && payloadId && filenameId !== payloadId),
    cwd: fields?.cwd || "",
    timestamp: fields?.timestamp || new Date(Number(before.mtimeMs)).toISOString(),
    recordedLastSessionAt: fields?.timestamp || "",
    source: fields?.source || "",
    threadSource: fields?.threadSource || "",
    parentThreadId: fields?.parentThreadId || "",
    hasSessionMeta: fields?.type === "session_meta",
    fileSize: Number(before.size),
    discoverySnapshot: Object.freeze({
      bytesRead: probe.bytesRead + (streamed?.bytesRead || 0),
      firstRecordSizeBytes: streamed?.firstRecordSizeBytes ?? probe.prefixSizeBytes,
      firstRecordTruncated: streamed?.truncated === true,
      firstRecordSha256,
      identity: beforeIdentity,
      sizeBytes: Number(before.size),
      mtimeNs: before.mtimeNs.toString(),
    }),
  };
}

async function probeDiscoveryRecordType(file, { abortSignal, io }) {
  const handle = await (io.open || fsp.open)(file, "r");
  const chunks = [];
  let prefixSizeBytes = 0;
  let bytesRead = 0;
  let position = 0;
  let type = { status: "UNCERTAIN", value: "" };
  try {
    while (prefixSizeBytes <= DISCOVERY_TYPE_PROBE_MAX_BYTES) {
      throwIfExportAborted(abortSignal);
      const buffer = Buffer.allocUnsafe(DISCOVERY_TYPE_READ_CHUNK_BYTES);
      const result = await handle.read(buffer, 0, buffer.length, position);
      if (!result.bytesRead) break;
      bytesRead += result.bytesRead;
      position += result.bytesRead;
      const chunk = buffer.subarray(0, result.bytesRead);
      const newline = chunk.indexOf(0x0a);
      const part = newline >= 0 ? chunk.subarray(0, newline) : chunk;
      chunks.push(Buffer.from(part));
      prefixSizeBytes += part.length;
      const probeText = Buffer.concat(chunks, prefixSizeBytes).toString("utf8");
      type = readTopLevelJsonEventTypePrefix(probeText.charCodeAt(0) === 0xfeff ? probeText.slice(1) : probeText);
      if (type.status === "FOUND" || newline >= 0 || prefixSizeBytes > DISCOVERY_TYPE_PROBE_MAX_BYTES) break;
    }
  } finally {
    await handle.close();
  }
  const prefixBytes = Buffer.concat(chunks, prefixSizeBytes);
  return { bytesRead, firstRecordPrefixSha256: createHash("sha256").update(prefixBytes).digest("hex"), prefixSizeBytes, type };
}

async function streamDiscoveryRecordFields(file, { abortSignal, maxRecordBytes, io }) {
  const handle = await (io.open || fsp.open)(file, "r");
  const state = { bytesRead: 0, firstRecordSizeBytes: 0, firstChunk: true, inputError: null, truncated: false };
  const firstRecordHash = createHash("sha256");
  async function* firstRecordChunks() {
    let position = 0;
    try {
      while (true) {
        throwIfExportAborted(abortSignal);
        const buffer = Buffer.allocUnsafe(DISCOVERY_METADATA_READ_CHUNK_BYTES);
        let result;
        try { result = await handle.read(buffer, 0, buffer.length, position); }
        catch (error) { state.inputError = error; throw error; }
        if (!result.bytesRead) return;
        state.bytesRead += result.bytesRead;
        position += result.bytesRead;
        const chunk = buffer.subarray(0, result.bytesRead);
        const newline = chunk.indexOf(0x0a);
        const part = newline >= 0 ? chunk.subarray(0, newline) : chunk;
        const remaining = maxRecordBytes - state.firstRecordSizeBytes;
        if (part.length > remaining) {
          const retained = part.subarray(0, Math.max(0, remaining));
          if (retained.length) {
            firstRecordHash.update(retained);
            state.firstRecordSizeBytes += retained.length;
            yield state.firstChunk && retained.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? retained.subarray(3) : retained;
          }
          state.truncated = true;
          return;
        }
        firstRecordHash.update(part);
        state.firstRecordSizeBytes += part.length;
        const tokenBytes = state.firstChunk && part.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? part.subarray(3) : part;
        state.firstChunk = false;
        if (tokenBytes.length) yield tokenBytes;
        if (newline >= 0) return;
      }
    } finally {
      await handle.close();
    }
  }

  let fields = null;
  try {
    fields = await collectDiscoveryFields(streamJsonlTokens(firstRecordChunks(), { maxStringChunkChars: 256 }), abortSignal);
  } catch (error) {
    throwIfExportAborted(abortSignal);
    if (state.inputError) throw state.inputError;
    fields = null;
  }
  return {
    bytesRead: state.bytesRead,
    fields: state.truncated ? null : fields,
    firstRecordSha256: firstRecordHash.digest("hex"),
    firstRecordSizeBytes: state.firstRecordSizeBytes,
    truncated: state.truncated,
  };
}

async function collectDiscoveryFields(tokens, abortSignal) {
  const values = new Map(Object.keys(DISCOVERY_FIELD_LIMITS).map((field) => [field, []]));
  const keyCounts = new Map(Object.keys(DISCOVERY_FIELD_LIMITS).map((field) => [field, 0]));
  let payloadKeyCount = 0;
  let payloadObjectCount = 0;
  let active = null;
  for await (const token of tokens) {
    throwIfExportAborted(abortSignal);
    if (token.recordIndex !== 1) break;
    const field = discoveryFieldForPath(token.path);
    if (token.type === "key" && field) keyCounts.set(field, keyCounts.get(field) + 1);
    if (token.type === "key" && token.path.length === 1 && token.path[0] === "payload") payloadKeyCount += 1;
    if (token.type === "object_start" && token.path.length === 1 && token.path[0] === "payload") payloadObjectCount += 1;
    if (token.type === "string_start" && field) active = { field, length: 0, overflow: false, parts: [] };
    else if (token.type === "string_chunk" && active?.field === field) {
      active.length += token.value.length;
      if (active.length > DISCOVERY_FIELD_LIMITS[field]) active.overflow = true;
      else active.parts.push(token.value);
    } else if (token.type === "string_end" && active?.field === field) {
      values.get(field).push(active.overflow ? null : active.parts.join(""));
      active = null;
    }
    if (token.type === "record_end") break;
  }
  const single = (field) => keyCounts.get(field) === 1 && values.get(field).length === 1 ? values.get(field)[0] : null;
  const type = single("type");
  if (!["session_meta", "turn_context"].includes(type) || payloadKeyCount !== 1 || payloadObjectCount !== 1) return null;
  return {
    type,
    cwd: single("payload.cwd") || "",
    id: single("payload.id") || "",
    sessionId: single("payload.session_id") || "",
    timestamp: single("payload.timestamp") || "",
    source: single("payload.source") || "",
    threadSource: single("payload.thread_source") || "",
    parentThreadId: single("payload.parent_thread_id") || "",
  };
}

function discoveryFieldForPath(tokenPath) {
  if (tokenPath.length === 1 && tokenPath[0] === "type") return "type";
  if (tokenPath.length !== 2 || tokenPath[0] !== "payload") return "";
  const field = `payload.${tokenPath[1]}`;
  return Object.hasOwn(DISCOVERY_FIELD_LIMITS, field) ? field : "";
}

async function assertDiscoveryMetadataUnchanged(meta, abortSignal) {
  const expected = meta.discoverySnapshot;
  if (!expected) return;
  const current = await readSessionDiscoveryMeta(meta.file, { abortSignal });
  const actual = current.discoverySnapshot;
  if (actual.identity !== expected.identity || actual.sizeBytes !== expected.sizeBytes || actual.mtimeNs !== expected.mtimeNs || actual.firstRecordSha256 !== expected.firstRecordSha256) {
    throw new ExportError("SOURCE_CHANGED_DURING_EXPORT", "Selected session metadata changed after discovery; select the project again");
  }
}

async function collectSessionAssets(file, sessionId, assetStore, includeTools, readerImplementation, readerOptions = {}) {
  const summary = createSessionReaderSummary();
  const classifier = createSessionEventClassifier();
  const readingSelection = new ReadingAssetSelection({ includeTools });
  for await (const _record of streamSessionRecords(file, {
    ...readerOptions,
    calculateSha256: true,
    implementation: readerImplementation,
    summary,
    onAttachmentStart: (info) => assetStore.beginAttachment(info),
    onRecordAbort: (recordNumber) => assetStore.abortRecord(recordNumber),
    beforeRecordCommit: (record, recordNumber) => {
      classifier.observe(record.item, recordNumber);
      const selection = readingSelection.observe(record.item, recordNumber);
      return assetStore.commitRecord(sessionId, recordNumber, record.attachments, selection);
    },
  })) {}
  if (!summary.stable) throw new ExportError("SOURCE_CHANGED_DURING_EXPORT", "A session source changed while its assets were collected");
  const eventAnalysis = classifier.finish();
  readingSelection.finish(eventAnalysis);
  assetStore.applyReadingAnnotations(sessionId, readingSelection.manifestAnnotations());
  return Object.freeze({ eventAnalysis, readingSelection, sha256: summary.fileSha256, sizeBytes: summary.afterSizeBytes });
}

async function processExportTask(task, titleIndex, profiler, context, sourceProtection, generation, assetStore) {
  const { exportFormats, copyRaw, outputDir, redactMarkdown, pathStyle, markdownDirName } = context;
  const { meta, projectDir, sessionCode, sourceOriginalFilename, rawExportName, rawRel, snapshot, assetSnapshot, parsedSnapshotMeta, metadataAlreadyParsed } = task;
  let renderMeta = meta;
  let stats = { userMessages: 0, assistantMessages: 0, subagentInputs: 0, runtimeContexts: 0, unclassifiedUserRoleRecords: 0, toolEvents: 0, model: meta.model || "", updatedAt: meta.updatedAt || meta.timestamp || "" };
  let markdownRel = "";
  let docxRel = "";
  let pdfRel = "";
  const documentViewEnabled = exportFormats.markdown || exportFormats.docx || exportFormats.pdf;

  if (documentViewEnabled) {
    const parsePath = copyRaw ? path.join(outputDir, rawRel) : meta.file;
    let parsedMeta = parsedSnapshotMeta || meta;
    if (!metadataAlreadyParsed && !parsedSnapshotMeta) {
      const parseStart = performance.now();
      parsedMeta = await readSessionMeta(parsePath, {
        fallbackSessionId: meta.idSource === "metadata_fallback" ? "" : meta.id,
        fallbackTimestamp: meta.timestamp,
        collectAttachmentMetrics: Boolean(profiler),
        calculateSha256: true,
        readerImplementation: context.readerImplementation,
        readerOptions: context.readerOptions,
      });
      if (!parsedMeta.fileReadStable || parsedMeta.fileSha256 !== assetSnapshot?.sha256) throw new ExportError("SOURCE_CHANGED_DURING_EXPORT", "Session content changed between asset collection and metadata classification");
      const parseMs = performance.now() - parseStart;
      profiler?.addPhase("parse_and_classify", parseMs, parsedMeta.fileSize, 0);
      profiler?.recordSession(meta, copyRaw ? "snapshot_parse_ms" : "selected_parse_ms", parseMs, parsedMeta.fileSize, 0);
    }
    if (meta.idSource !== "metadata_fallback" && meta.id && parsedMeta.id && meta.id !== parsedMeta.id) throw new ExportError("SOURCE_SNAPSHOT_MISMATCH", `Parsed session ID differs from scanned source: ${sourceOriginalFilename}`);
    const indexed = parsedMeta.id ? (titleIndex.get(parsedMeta.id) || {}) : {};
    const titleResolution = resolveDisplayTitle(parsedMeta, indexed.threadName);
    const displayTitle = redactMarkdown ? redactSecrets(titleResolution.displayTitle) : titleResolution.displayTitle;
    renderMeta = {
      ...parsedMeta,
      displayTitle,
      file: parsePath,
      indexedTitleStatus: titleResolution.indexedTitleStatus,
      sourceRootPath: meta.sourceRootPath,
      sourceOriginalPath: meta.file,
      storage: meta.storage,
      title: displayTitle,
      titleSource: titleResolution.source,
      updatedAt: indexed.updatedAt || meta.updatedAt || "",
      eventAnalysis: assetSnapshot?.eventAnalysis || parsedMeta.eventAnalysis,
    };
    const sessionSlug = slug(renderMeta.displayTitle || renderMeta.title || renderMeta.id || sourceOriginalFilename).slice(0, 80);
    const start = renderMeta.timestamp ? stampForName(new Date(renderMeta.timestamp)) : stampForName(new Date());
    const baseName = pathStyle === "readable" ? `${start}-${sessionSlug || "codex-session"}-${sessionCode}` : sessionCode;
    if (exportFormats.markdown) {
      markdownRel = path.join(markdownDirName, projectDir, `${baseName}.md`);
      await ensureSeparatedOutputDirectory(path.join(outputDir, markdownDirName, projectDir), sourceProtection);
    }
    if (exportFormats.docx) {
      docxRel = path.join("docx", projectDir, `${baseName}.docx`);
      await ensureSeparatedOutputDirectory(path.join(outputDir, "docx", projectDir), sourceProtection);
    }
    if (exportFormats.pdf) {
      pdfRel = path.join("pdf", projectDir, `${baseName}.pdf`);
      await ensureSeparatedOutputDirectory(path.join(outputDir, "pdf", projectDir), sourceProtection);
    }
    profiler?.recordAttachments(renderMeta.attachmentMetrics);
    stats = await writeSessionDocuments(renderMeta, {
      markdownPath: markdownRel ? path.join(outputDir, markdownRel) : "",
      docxPath: docxRel ? path.join(outputDir, docxRel) : "",
      pdfPath: pdfRel ? path.join(outputDir, pdfRel) : "",
      rawRel: copyRaw ? rawRel : "",
    }, profiler, meta, context, sourceProtection, generation, assetStore, assetSnapshot);
  } else {
    const title = neutralSessionTitle(meta);
    renderMeta = { ...meta, title, displayTitle: title, titleSource: "neutral_unclassified_snapshot", indexedTitleStatus: "NOT_EVALUATED", sessionKind: SESSION_KIND.UNKNOWN };
  }

  const sourceRoot = meta.storage === "archived" ? "archived_sessions" : "sessions";
  const sourceRelativePath = validatedSourceRelativePath(meta.file, meta.sourceRootPath);
  return {
    project: renderMeta.cwd || "",
    project_name: renderMeta.cwd ? portableBasename(renderMeta.cwd) : "",
    title: renderMeta.displayTitle || renderMeta.title || "",
    display_title: renderMeta.displayTitle || renderMeta.title || "",
    title_source: renderMeta.titleSource || "",
    indexed_title_status: renderMeta.indexedTitleStatus || "NOT_PRESENT",
    storage: meta.storage || "active",
    session_id: renderMeta.id || "",
    session_kind: renderMeta.sessionKind || SESSION_KIND.UNKNOWN,
    started_at: renderMeta.timestamp || "",
    updated_at: stats.updatedAt || renderMeta.updatedAt || "",
    model: stats.model || renderMeta.model || "",
    user_messages: documentViewEnabled ? stats.userMessages : null,
    assistant_messages: documentViewEnabled ? stats.assistantMessages : null,
    subagent_inputs: documentViewEnabled ? stats.subagentInputs : null,
    automatic_runtime_contexts: documentViewEnabled ? stats.runtimeContexts : null,
    unclassified_user_role_records: documentViewEnabled ? stats.unclassifiedUserRoleRecords : null,
    tool_events: documentViewEnabled ? stats.toolEvents : null,
    source_jsonl: meta.file,
    source_original_filename: sourceOriginalFilename,
    source_root: sourceRoot,
    source_relative_path: sourceRelativePath,
    markdown_file: markdownRel,
    ...(exportFormats.docx ? { docx_file: docxRel } : {}),
    ...(exportFormats.pdf ? { pdf_file: pdfRel } : {}),
    raw_export_file: copyRaw ? rawRel : "",
    raw_export_name: copyRaw ? rawExportName : "",
    raw_sha256: snapshot?.sha256 || "",
    raw_size_bytes: snapshot?.sizeBytes ?? null,
    snapshot_status: copyRaw ? "STABLE" : "NOT_INCLUDED",
    raw_copy_status: copyRaw ? snapshot?.copyStatus || "" : RAW_COPY_STATUS.NOT_INCLUDED,
    raw_verified_at: copyRaw ? snapshot?.verifiedAt || null : null,
    source_snapshot_before_size_bytes: snapshot?.sourceBeforeSizeBytes ?? null,
    source_snapshot_before_mtime_ms: snapshot?.sourceBeforeMtimeMs ?? null,
    source_snapshot_after_size_bytes: snapshot?.sourceAfterSizeBytes ?? null,
    source_snapshot_after_mtime_ms: snapshot?.sourceAfterMtimeMs ?? null,
    jsonl_line_count: documentViewEnabled ? renderMeta.jsonlLineCount : null,
    parsed_event_count: documentViewEnabled ? renderMeta.parsedEventCount : null,
    invalid_jsonl_line_count: documentViewEnabled ? renderMeta.invalidJsonLines : null,
  };
}

async function readAndEnrichSession(entry, titleIndex, profiler, profilePhaseName, context) {
  const { redactMarkdown } = context;
  const parseStart = performance.now();
  const meta = await readSessionMeta(entry.file, {
    collectAttachmentMetrics: Boolean(profiler),
    calculateSha256: true,
    readerImplementation: context.readerImplementation,
    readerOptions: context.readerOptions,
  });
  const parseMs = performance.now() - parseStart;
  profiler?.addPhase("parse_and_classify", parseMs, meta.fileSize, 0);
  profiler?.recordSession(meta, profilePhaseName, parseMs, meta.fileSize, 0);
  const indexed = meta.id ? (titleIndex.get(meta.id) || {}) : {};
  const titleResolution = resolveDisplayTitle(meta, indexed.threadName);
  const title = redactMarkdown ? redactSecrets(titleResolution.displayTitle) : titleResolution.displayTitle;
  return {
    ...meta,
    title,
    displayTitle: title,
    titleSource: titleResolution.source,
    indexedTitleStatus: titleResolution.indexedTitleStatus,
    updatedAt: indexed.updatedAt || "",
    file: entry.file,
    sourceRootPath: entry.sourceRootPath,
    storage: entry.storage,
  };
}

async function readSessionRoutingMeta(file, {
  implementation = SESSION_READER_IMPLEMENTATION.STREAMING,
  readerOptions = {},
} = {}) {
  const filenameId = extractSessionIdFromFilename(file);
  const stat = await fsp.stat(file).catch(() => null);
  const readerSummary = createSessionReaderSummary();
  const meta = {
    file,
    id: filenameId,
    session_id: filenameId,
    idSource: filenameId ? "filename" : "",
    metadataId: "",
    metadataIdMismatch: false,
    cwd: "",
    timestamp: "",
    source: "",
    threadSource: "",
    parentThreadId: "",
    hasSessionMeta: false,
    fileSize: stat?.size || 0,
  };
  for await (const { item } of streamSessionRecords(file, {
    ...readerOptions,
    calculateSha256: true,
    implementation,
    summary: readerSummary,
  })) {
    const type = item?.type || "";
    observeRecordedTimestamp(meta, item.timestamp);
    if (type !== "session_meta" && type !== "turn_context") continue;
    if (type === "session_meta" && item.payload) {
      const payloadId = item.payload.id || item.payload.session_id || "";
      if (!meta.hasSessionMeta) {
        meta.hasSessionMeta = true;
        meta.metadataId = payloadId;
        if (!meta.id && payloadId) {
          meta.id = payloadId;
          meta.session_id = item.payload.session_id || payloadId;
          meta.idSource = "session_meta";
        } else if (payloadId && meta.id && payloadId !== meta.id) {
          meta.metadataIdMismatch = true;
        }
        meta.cwd = item.payload.cwd || meta.cwd;
        meta.timestamp = item.payload.timestamp || item.timestamp || meta.timestamp;
        meta.source = item.payload.source || meta.source;
        meta.threadSource = item.payload.thread_source || meta.threadSource;
        meta.parentThreadId = item.payload.parent_thread_id || meta.parentThreadId;
      } else {
        meta.cwd = meta.cwd || item.payload.cwd || "";
        meta.timestamp = meta.timestamp || item.payload.timestamp || item.timestamp || "";
      }
    }
    if (type === "turn_context" && item.payload) meta.cwd = item.payload.cwd || meta.cwd;
  }
  if (!meta.timestamp && stat) meta.timestamp = stat.mtime.toISOString();
  meta.routingSnapshot = {
    sha256: readerSummary.fileSha256,
    beforeSizeBytes: readerSummary.beforeSizeBytes,
    beforeMtimeMs: readerSummary.beforeMtimeMs,
    afterSizeBytes: readerSummary.afterSizeBytes,
    afterMtimeMs: readerSummary.afterMtimeMs,
    stable: readerSummary.stable,
  };
  return meta;
}

function readTopLevelJsonEventType(line) {
  const text = String(line || "");
  let index = skipJsonWhitespace(text, 0);
  if (text[index] !== "{") return { status: "UNCERTAIN", value: "" };
  index += 1;
  let foundType = "";
  let foundTypeCount = 0;
  while (index < text.length) {
    index = skipJsonWhitespace(text, index);
    if (text[index] === "}") return finishTopLevelTypeScan(text, index + 1, foundType, foundTypeCount);
    const key = readJsonStringToken(text, index);
    if (!key) return { status: "UNCERTAIN", value: "" };
    index = skipJsonWhitespace(text, key.end);
    if (text[index] !== ":") return { status: "UNCERTAIN", value: "" };
    index = skipJsonWhitespace(text, index + 1);
    if (key.value === "type") {
      const value = readJsonStringToken(text, index);
      if (!value) return { status: "UNCERTAIN", value: "" };
      foundType = value.value;
      foundTypeCount += 1;
      index = value.end;
    } else {
      const valueEnd = skipJsonValue(text, index);
      if (valueEnd === null) return { status: "UNCERTAIN", value: "" };
      index = valueEnd;
    }
    index = skipJsonWhitespace(text, index);
    if (text[index] === ",") {
      index += 1;
      continue;
    }
    if (text[index] === "}") return finishTopLevelTypeScan(text, index + 1, foundType, foundTypeCount);
    return { status: "UNCERTAIN", value: "" };
  }
  return { status: "UNCERTAIN", value: "" };
}

function finishTopLevelTypeScan(text, end, foundType, foundTypeCount) {
  if (skipJsonWhitespace(text, end) !== text.length || foundTypeCount > 1) return { status: "UNCERTAIN", value: "" };
  return foundTypeCount === 1 ? { status: "FOUND", value: foundType } : { status: "NOT_FOUND", value: "" };
}

function skipJsonWhitespace(text, start) {
  let index = start;
  while (index < text.length && (text[index] === " " || text[index] === "\t" || text[index] === "\r" || text[index] === "\n")) index += 1;
  return index;
}

function skipJsonValue(text, start) {
  if (text[start] === "\"") return skipJsonString(text, start);
  if (text[start] === "{" || text[start] === "[") {
    const stack = [text[start] === "{" ? "}" : "]"];
    let index = start + 1;
    while (index < text.length) {
      if (text[index] === "\"") {
        const end = skipJsonString(text, index);
        if (end === null) return null;
        index = end;
        continue;
      }
      if (text[index] === "{" || text[index] === "[") stack.push(text[index] === "{" ? "}" : "]");
      else if (text[index] === "}" || text[index] === "]") {
        if (stack.pop() !== text[index]) return null;
        if (!stack.length) return index + 1;
      }
      index += 1;
    }
    return null;
  }
  let index = start;
  while (index < text.length && text[index] !== "," && text[index] !== "}" && text[index] !== "]" && ![" ", "\t", "\r", "\n"].includes(text[index])) index += 1;
  if (index === start) return null;
  try {
    JSON.parse(text.slice(start, index));
    return index;
  } catch {
    return null;
  }
}

function skipJsonString(text, start) {
  if (text[start] !== "\"") return null;
  let searchFrom = start + 1;
  while (searchFrom < text.length) {
    const quote = text.indexOf("\"", searchFrom);
    if (quote === -1) return null;
    let slashCount = 0;
    for (let index = quote - 1; index > start && text[index] === "\\"; index -= 1) slashCount += 1;
    if (slashCount % 2 === 0) return quote + 1;
    searchFrom = quote + 1;
  }
  return null;
}

function readJsonStringToken(text, start) {
  if (text[start] !== "\"") return null;
  let escaped = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const character = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "\"") {
      try {
        return { value: JSON.parse(text.slice(start, index + 1)), end: index + 1 };
      } catch {
        return null;
      }
    }
  }
  return null;
}

function retainPreferredSession(map, meta) {
  const key = meta.id || normalizePathForCompare(meta.file);
  const existing = map.get(key);
  if (!existing || (existing.storage === "archived" && meta.storage === "active")) map.set(key, meta);
}

function sortedSessionValues(map) {
  return Array.from(map.values()).sort((left, right) => (left.timestamp || "").localeCompare(right.timestamp || ""));
}

function createSessionEventClassifier() {
  let sessionMeta = {};
  let sessionKind = SESSION_KIND.UNKNOWN;
  let previousParsed = null;
  let firstPairedInputText = "";
  const userRecords = [];
  const mirrorPairs = new Map();

  function observe(item, recordNumber) {
    if (item.type === "session_meta" && item.payload) {
      sessionMeta = { ...sessionMeta, ...item.payload };
      sessionKind = classifySessionKind(sessionMeta);
    }

    const current = { item, recordNumber, userRecord: null };
    if (item.type === "response_item" && item.payload?.type === "message" && item.payload?.role === "user") {
      const text = extractText(item.payload.content);
      const userRecord = {
        recordNumber,
        timestamp: item.timestamp || "",
        turnId: item.payload.internal_chat_message_metadata_passthrough?.turn_id || "",
        mirrorRejected: false,
        paired: false,
        titleCandidate: deriveUserDisplayTitle(text, 120),
        runtimeContextTypes: classifyRuntimeContextTypes(text),
        fullText: text,
      };
      userRecords.push(userRecord);
      current.userRecord = userRecord;
    }

    if (item.type === "event_msg" && item.payload?.type === "user_message" && previousParsed?.userRecord) {
      if (isMirroredUserEvent(previousParsed.item, item)) {
        previousParsed.userRecord.paired = true;
        mirrorPairs.set(recordNumber, previousParsed.recordNumber);
        if (!firstPairedInputText) firstPairedInputText = previousParsed.userRecord.fullText;
      } else {
        previousParsed.userRecord.mirrorRejected = true;
      }
    }

    if (previousParsed?.userRecord) delete previousParsed.userRecord.fullText;
    previousParsed = current;
  }

  function finish() {
    if (previousParsed?.userRecord) delete previousParsed.userRecord.fullText;
    const recordsByTurn = new Map();
    for (const record of userRecords) {
      if (!recordsByTurn.has(record.turnId)) recordsByTurn.set(record.turnId, []);
      recordsByTurn.get(record.turnId).push(record);
    }

    const classifications = new Map();
    let directUserMessages = 0;
    let subagentInputs = 0;
    let runtimeContexts = 0;
    let unclassifiedUserRoleRecords = 0;
    const nonDirectTitleCandidates = [];

    for (const record of userRecords) {
      let kind;
      if (record.paired) {
        if (sessionKind === SESSION_KIND.DIRECT_USER) {
          kind = USER_RECORD_KIND.DIRECT_USER_TURN;
          directUserMessages += 1;
        } else if (sessionKind === SESSION_KIND.SUBAGENT) {
          kind = USER_RECORD_KIND.SUBAGENT_INPUT;
          subagentInputs += 1;
        } else {
          kind = USER_RECORD_KIND.UNCLASSIFIED_USER_ROLE_RECORD;
          unclassifiedUserRoleRecords += 1;
        }
      } else if (record.mirrorRejected) {
        kind = USER_RECORD_KIND.UNCLASSIFIED_USER_ROLE_RECORD;
        unclassifiedUserRoleRecords += 1;
      } else {
        const sameTurn = recordsByTurn.get(record.turnId) || [];
        if (record.turnId && sameTurn.some((candidate) => candidate.paired)) {
          kind = USER_RECORD_KIND.AUTOMATIC_RUNTIME_CONTEXT;
          runtimeContexts += 1;
        } else {
          kind = USER_RECORD_KIND.UNCLASSIFIED_USER_ROLE_RECORD;
          unclassifiedUserRoleRecords += 1;
        }
      }
      const classification = {
        kind,
        mirrorRejected: record.mirrorRejected,
        runtimeContextTypes: [...record.runtimeContextTypes],
        pairedResponseRecord: record.paired,
      };
      classifications.set(record.recordNumber, classification);
      if (kind !== USER_RECORD_KIND.DIRECT_USER_TURN && record.titleCandidate) nonDirectTitleCandidates.push(record.titleCandidate);
    }

    return {
      classifications,
      directUserMessages,
      firstDirectUserText: sessionKind === SESSION_KIND.DIRECT_USER ? firstPairedInputText : "",
      mirrorPairs,
      nonDirectTitleCandidates,
      runtimeContexts,
      sessionKind,
      subagentInputs,
      unclassifiedUserRoleRecords,
    };
  }

  return { finish, observe };
}

function classifySessionKind(payload = {}) {
  if (payload.thread_source === "subagent" || payload.source?.subagent) return SESSION_KIND.SUBAGENT;
  if (payload.thread_source === "user") return SESSION_KIND.DIRECT_USER;
  if (typeof payload.source === "string" && ["cli", "exec", "vscode"].includes(payload.source.toLowerCase())) return SESSION_KIND.DIRECT_USER;
  return SESSION_KIND.UNKNOWN;
}

function isMirroredUserEvent(responseItem, eventMessage) {
  if (responseItem?.type !== "response_item" || responseItem.payload?.type !== "message" || responseItem.payload?.role !== "user") return false;
  if (eventMessage?.type !== "event_msg" || eventMessage.payload?.type !== "user_message") return false;
  const responseTime = Date.parse(responseItem.timestamp || "");
  const eventTime = Date.parse(eventMessage.timestamp || "");
  const delay = eventTime - responseTime;
  if (!Number.isFinite(delay) || delay < 0 || delay > MIRRORED_USER_EVENT_MAX_DELAY_MS) return false;
  const eventText = typeof eventMessage.payload.message === "string" ? eventMessage.payload.message : "";
  return eventText.length > 0
    && canonicalResponseUserMessage(responseItem.payload.content) === eventText
    && mirroredUserAttachmentsMatch(responseItem.payload.content, eventMessage.payload);
}

function canonicalResponseUserMessage(content) {
  if (!Array.isArray(content)) return "";
  return content.map((item, index) => {
    if (typeof item?.text !== "string") return "";
    const trimmed = item.text.trim();
    const imageOpeningWrapper = trimmed.startsWith("<image") && content[index + 1]?.type === "input_image";
    const imageClosingWrapper = trimmed === "</image>" && content[index - 1]?.type === "input_image";
    return imageOpeningWrapper || imageClosingWrapper ? "" : item.text;
  }).join("");
}

function mirroredUserAttachmentsMatch(content, eventPayload) {
  const responseImages = Array.isArray(content) ? content.filter((item) => item?.type === "input_image").map((item) => item.image_url) : [];
  const eventImages = Array.isArray(eventPayload?.images) ? eventPayload.images : [];
  const eventLocalImages = Array.isArray(eventPayload?.local_images) ? eventPayload.local_images : [];
  const eventAttachments = [...eventImages, ...eventLocalImages];
  return responseImages.length === eventAttachments.length
    && responseImages.every((image, index) => attachmentIdentity(image) === attachmentIdentity(eventAttachments[index]));
}

function classifyRuntimeContextTypes(text) {
  const value = String(text || "");
  const trimmed = value.trimStart();
  const lines = value.split(/\r?\n/).map((line) => line.trim());
  const types = [];
  if (lines.includes("# AGENTS.md instructions")) types.push("AGENTS");
  if (trimmed.startsWith("<recommended_plugins>") || trimmed.startsWith("<plugins_instructions>") || value.includes("\n<recommended_plugins>") || value.includes("\n<plugins_instructions>")) types.push("PLUGIN");
  if (trimmed.startsWith("<environment_context>") || trimmed.startsWith("<app-context") || value.includes("\n<environment_context>") || value.includes("\n<app-context")) types.push("ENVIRONMENT");
  return types;
}

function deriveUserDisplayTitle(text, maxLength = 96) {
  const lines = String(text || "").split(/\r?\n/);
  const requestMarker = lines.findIndex((line) => line.trim() === "## My request for Codex:");
  if (requestMarker >= 0) return deriveTitle(lines.slice(requestMarker + 1).join("\n"), maxLength);
  return deriveTitle(text, maxLength);
}

function extractSessionIdFromFilename(file) {
  const base = path.basename(file, path.extname(file));
  const uuid = base.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  if (uuid) return uuid[1];
  const thread = base.match(/(thr_[A-Za-z0-9_-]+)$/);
  return thread ? thread[1] : "";
}

function extractCwdFromText(text) {
  const value = String(text || "");
  const xml = value.match(/<cwd>([^<]+)<\/cwd>/i);
  if (xml) return xml[1].trim();
  const line = value.match(/(?:current working directory|working directory|cwd)\s*[:=]\s*([^\r\n]+)/i);
  return line ? line[1].trim() : "";
}

async function copyStableRawSnapshot(sourcePath, destinationPath, options = {}) {
  const io = { copyOpenedFile, hashFile: sha256File, link: fsp.link, lstat: fsp.lstat, open: fsp.open, realpath: fsp.realpath, rename: fsp.rename, rm: fsp.rm, stat: fsp.stat, statIdentity: (file) => fsp.stat(file, { bigint: true }), ...options.io };
  const maxAttempts = Math.max(1, options.maxAttempts || 3);
  const diagnostic = typeof options.diagnostic === "function" ? options.diagnostic : () => {};
  const diagnosticContext = options.diagnosticContext || {};
  const sourceIdentity = await inspectSeparatedPath(sourcePath, { io, requireRegularFile: true, requireReliableIdentity: true });
  await assertSnapshotDestinationSeparated(sourceIdentity, destinationPath, io);
  const generationDestination = options.generation ? await assertGenerationDestinationWritable(destinationPath, options.generation) : null;
  await fsp.mkdir(path.dirname(destinationPath), { recursive: true });
  let lastReason = "source changed during export";
  let routingSnapshotReusable = isStableRoutingSnapshot(options.routingSnapshot);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    options.profiler?.recordSnapshotAttempt(options.profileSession);
    const attemptStartedAt = performance.now();
    diagnostic("snapshot_attempt_start", { ...diagnosticContext, attempt });
    const temporaryPath = options.makeTemporaryPath
      ? options.makeTemporaryPath({ destinationPath, attempt })
      : `${destinationPath}.partial-${process.pid}-${attempt}-${randomUUID()}`;
    let published = false;
    let temporaryOwned = false;
    let previousDestination = null;
    let publishedIdentity = null;
    let destinationCompromised = false;
    await assertSnapshotTemporarySeparated(sourceIdentity, destinationPath, temporaryPath, io);
    try {
      const before = await timedSnapshotStat(sourcePath, "source_before_copy", attempt);
      if (before.identity !== sourceIdentity.identity) throw new ExportError("UNSAFE_EXPORT_PATH", "The source session identity changed before snapshot copying");
      let sourceSha256 = "";
      let sourceHashBasis = "FALLBACK";
      if (routingSnapshotReusable && routingSnapshotMatches(options.routingSnapshot, before)) {
        sourceSha256 = options.routingSnapshot.sha256;
        sourceHashBasis = "ROUTING";
        diagnostic("source_hash_reused", { ...diagnosticContext, attempt, bytes: before.size });
      } else {
        const sourceHashBefore = await timedSnapshotStat(sourcePath, "source_before_hash", attempt);
        const sourceHashStart = performance.now();
        diagnostic("source_hash_start", { ...diagnosticContext, attempt, stage: "fallback" });
        sourceSha256 = await io.hashFile(sourcePath);
        const sourceHashMs = performance.now() - sourceHashStart;
        diagnostic("source_hash_end", { ...diagnosticContext, attempt, stage: "fallback", duration_ms: roundMs(sourceHashMs), bytes: sourceHashBefore.size });
        options.profiler?.addPhase("source_hashing", sourceHashMs, sourceHashBefore.size, 0);
        options.profiler?.recordSession(options.profileSession, "source_hash_ms", sourceHashMs, sourceHashBefore.size, 0);
        const sourceHashAfter = await timedSnapshotStat(sourcePath, "source_after_hash", attempt);
        if (sourceHashBefore.identity !== sourceIdentity.identity || sourceHashAfter.identity !== sourceIdentity.identity || !sameFileVersion(sourceHashBefore, sourceHashAfter) || !sameFileVersion(before, sourceHashAfter)) {
          lastReason = "source size or modification time changed while calculating its hash";
          routingSnapshotReusable = false;
          diagnostic("snapshot_attempt_end", { ...diagnosticContext, attempt, status: "RETRY", reason: "SOURCE_CHANGED", duration_ms: roundMs(performance.now() - attemptStartedAt) });
          if (attempt < maxAttempts) options.profiler?.recordSnapshotRetryCount(1);
          continue;
        }
      }
      if (options.requiredSourceSha256 && sourceSha256 !== options.requiredSourceSha256) {
        throw new ExportError("SOURCE_CHANGED_DURING_EXPORT", "The selected session changed after the project inventory was read; select it again");
      }
      if (options.beforeCopy) await options.beforeCopy({ attempt, sourcePath, temporaryPath, sourceHashBasis });
      const copyStart = performance.now();
      diagnostic("snapshot_copy_start", { ...diagnosticContext, attempt });
      let sourceHandle;
      let temporaryHandle;
      try {
        sourceHandle = await io.open(sourcePath, "r");
        const openedSourceStat = await sourceHandle.stat({ bigint: true });
        if (!openedSourceStat.isFile() || reliableFileIdentity(openedSourceStat) !== sourceIdentity.identity) {
          throw new ExportError("UNSAFE_EXPORT_PATH", "The opened source session does not match the validated source file");
        }
        temporaryHandle = await io.open(temporaryPath, "wx");
        const openedTemporaryStat = await temporaryHandle.stat({ bigint: true });
        if (!openedTemporaryStat.isFile()) throw new ExportError("UNSAFE_EXPORT_PATH", `Expected a regular raw snapshot temporary file: ${path.basename(temporaryPath)}`);
        const openedTemporaryIdentity = reliableFileIdentity(openedTemporaryStat);
        if (!openedTemporaryIdentity) throw new ExportError("UNSAFE_EXPORT_PATH", `Reliable file identity is unavailable for ${path.basename(temporaryPath)}`);
        if (openedTemporaryIdentity === sourceIdentity.identity) throw new ExportError("OUTPUT_OVERLAPS_SOURCE", "Raw temporary file aliases its source session file");
        temporaryOwned = { path: temporaryPath, identity: { identity: openedTemporaryIdentity } };
        await io.copyOpenedFile(sourceHandle, temporaryHandle, before.size);
        const writtenTemporaryStat = await temporaryHandle.stat({ bigint: true });
        if (reliableFileIdentity(writtenTemporaryStat) !== openedTemporaryIdentity) {
          throw new ExportError("UNSAFE_EXPORT_PATH", `Raw temporary file identity changed while copying: ${path.basename(temporaryPath)}`);
        }
      } finally {
        await temporaryHandle?.close().catch(() => {});
        await sourceHandle?.close().catch(() => {});
      }
      const copiedIdentity = await inspectSeparatedPath(temporaryPath, { io, requireRegularFile: true, requireReliableIdentity: true });
      if (!sameReliableFileIdentity(temporaryOwned?.identity, copiedIdentity)) {
        temporaryOwned = null;
        throw new ExportError("UNSAFE_EXPORT_PATH", `Raw temporary file was replaced after copying: ${path.basename(temporaryPath)}`);
      }
      assertDistinctPathIdentity(sourceIdentity, copiedIdentity, "Raw temporary file aliases its source session file");
      const copiedStat = await timedSnapshotStat(temporaryPath, "temporary_after_copy", attempt);
      const copyMs = performance.now() - copyStart;
      diagnostic("snapshot_copy_end", { ...diagnosticContext, attempt, duration_ms: roundMs(copyMs), bytes: copiedStat.size });
      options.profiler?.addPhase("raw_snapshot_copy", copyMs, before.size, copiedStat.size);
      options.profiler?.recordSession(options.profileSession, "raw_copy_ms", copyMs, before.size, copiedStat.size);
      if (options.afterCopy) await options.afterCopy({ attempt, sourcePath, temporaryPath });
      const afterCopy = await timedSnapshotStat(sourcePath, "source_after_copy", attempt);
      const stableMetadata = afterCopy.identity === sourceIdentity.identity && sameFileVersion(before, afterCopy) && copiedStat.size === before.size;
      if (stableMetadata) {
        if (options.beforeExportVerification) await options.beforeExportVerification({ attempt, sourcePath, temporaryPath });
        const publicationCandidate = await inspectSeparatedPath(temporaryPath, { io, requireRegularFile: true, requireReliableIdentity: true });
        if (!sameReliableFileIdentity(temporaryOwned?.identity, publicationCandidate)) {
          temporaryOwned = null;
          throw new ExportError("UNSAFE_EXPORT_PATH", `Raw temporary file was replaced before publication: ${path.basename(temporaryPath)}`);
        }
        assertDistinctPathIdentity(sourceIdentity, publicationCandidate, "Raw temporary file aliases its source session file");
        if (options.generation) {
          const currentDestination = await inspectSeparatedPath(destinationPath, { allowMissing: true, io, rejectAliases: true, requireRegularFile: true, requireReliableIdentity: true });
          if (generationDestination.exists !== currentDestination.exists || (generationDestination.exists && !sameReliableFileIdentity(generationDestination, currentDestination))) {
            throw new ExportError("UNSAFE_EXPORT_PATH", `Raw destination changed before reuse verification: ${path.basename(destinationPath)}`);
          }
          if (currentDestination.exists) {
            assertDistinctPathIdentity(sourceIdentity, currentDestination, "Existing Raw destination aliases its source session file");
            const exportedBeforeVerification = await timedSnapshotStat(destinationPath, "published_before_verification", attempt);
            if (exportedBeforeVerification.identity !== currentDestination.identity) {
              throw new ExportError("UNSAFE_EXPORT_PATH", `Existing Raw destination changed before verification: ${path.basename(destinationPath)}`);
            }
            const exportHashStart = performance.now();
            const exportHashStage = options.verifyPublishedSnapshot ? "snapshot_parse" : "snapshot";
            diagnostic("export_hash_start", { ...diagnosticContext, attempt, stage: exportHashStage });
            let verification;
            try {
              verification = options.verifyPublishedSnapshot
                ? await options.verifyPublishedSnapshot(destinationPath)
                : { sha256: await io.hashFile(destinationPath), sizeBytes: exportedBeforeVerification.size, stable: true, value: null };
            } catch (error) {
              throw new ExportError("EXPORT_DESTINATION_COLLISION", `Refusing to replace an existing Raw file that cannot be verified as the stable source: ${path.basename(destinationPath)}`);
            }
            const exportHashMs = performance.now() - exportHashStart;
            diagnostic("export_hash_end", { ...diagnosticContext, attempt, stage: exportHashStage, duration_ms: roundMs(exportHashMs), bytes: verification.sizeBytes ?? exportedBeforeVerification.size });
            if (!options.verifyPublishedSnapshot) {
              options.profiler?.addPhase("export_hashing", exportHashMs, exportedBeforeVerification.size, 0);
              options.profiler?.recordSession(options.profileSession, "snapshot_hash_ms", exportHashMs, exportedBeforeVerification.size, 0);
            }
            const exportedAfterVerification = await timedSnapshotStat(destinationPath, "published_after_verification", attempt);
            if (exportedAfterVerification.identity !== currentDestination.identity) {
              throw new ExportError("UNSAFE_EXPORT_PATH", `Existing Raw destination changed during verification: ${path.basename(destinationPath)}`);
            }
            const exportedStable = verification.stable !== false && sameFileVersion(exportedBeforeVerification, exportedAfterVerification);
            if (!exportedStable || verification.sizeBytes !== before.size || verification.sha256 !== sourceSha256) {
              throw new ExportError("EXPORT_DESTINATION_COLLISION", `Refusing to replace an existing Raw file whose bytes do not match the stable source: ${path.basename(destinationPath)}`);
            }
            await removeOwnedTemporary(temporaryOwned, io);
            temporaryOwned = null;
            const previousSession = previousRawSession(options.generation, destinationPath);
            const verifiedAt = previousSession?.raw_sha256 === verification.sha256 && isCanonicalIsoTimestamp(previousSession.raw_verified_at)
              ? previousSession.raw_verified_at
              : new Date().toISOString();
            diagnostic("snapshot_attempt_end", { ...diagnosticContext, attempt, status: "STABLE", duration_ms: roundMs(performance.now() - attemptStartedAt) });
            return {
              sha256: verification.sha256,
              sizeBytes: exportedAfterVerification.size,
              sourceAfterMtimeMs: afterCopy.mtimeMs,
              sourceAfterSizeBytes: afterCopy.size,
              sourceBeforeMtimeMs: before.mtimeMs,
              sourceBeforeSizeBytes: before.size,
              attempts: attempt,
              sourceHashBasis,
              verificationValue: verification.value || null,
              copyStatus: RAW_COPY_STATUS.VERIFIED_AT_EXPORT,
              verifiedAt,
            };
          }
        }
        const runOwnedIdentity = temporaryOwned.identity;
        if (options.generation) {
          await io.link(temporaryPath, destinationPath);
        } else {
          previousDestination = await moveExistingDestinationAside(sourceIdentity, destinationPath, io);
          await io.rename(temporaryPath, destinationPath);
          temporaryOwned = null;
        }
        publishedIdentity = await inspectSeparatedPath(destinationPath, { io, requireRegularFile: true, requireReliableIdentity: true });
        if (!sameReliableFileIdentity(runOwnedIdentity, publishedIdentity)) {
          destinationCompromised = true;
          publishedIdentity = null;
          throw new ExportError("UNSAFE_EXPORT_PATH", `Published Raw destination was replaced during publication: ${path.basename(destinationPath)}`);
        }
        assertDistinctPathIdentity(sourceIdentity, publishedIdentity, "Published Raw destination aliases its source session file");
        if (options.generation) {
          await removeOwnedTemporary(temporaryOwned, io);
          temporaryOwned = null;
        }
        published = true;
        const exportedBeforeVerification = await timedSnapshotStat(destinationPath, "published_before_verification", attempt);
        if (exportedBeforeVerification.identity !== publishedIdentity.identity) {
          destinationCompromised = true;
          published = false;
          publishedIdentity = null;
          throw new ExportError("UNSAFE_EXPORT_PATH", `Published Raw destination changed before verification: ${path.basename(destinationPath)}`);
        }
        const exportHashStart = performance.now();
        const exportHashStage = options.verifyPublishedSnapshot ? "snapshot_parse" : "snapshot";
        diagnostic("export_hash_start", { ...diagnosticContext, attempt, stage: exportHashStage });
        const verification = options.verifyPublishedSnapshot
          ? await options.verifyPublishedSnapshot(destinationPath)
          : { sha256: await io.hashFile(destinationPath), sizeBytes: exportedBeforeVerification.size, stable: true, value: null };
        const exportHashMs = performance.now() - exportHashStart;
        diagnostic("export_hash_end", { ...diagnosticContext, attempt, stage: exportHashStage, duration_ms: roundMs(exportHashMs), bytes: verification.sizeBytes ?? exportedBeforeVerification.size });
        if (!options.verifyPublishedSnapshot) {
          options.profiler?.addPhase("export_hashing", exportHashMs, exportedBeforeVerification.size, 0);
          options.profiler?.recordSession(options.profileSession, "snapshot_hash_ms", exportHashMs, exportedBeforeVerification.size, 0);
        }
        const exportedAfterVerification = await timedSnapshotStat(destinationPath, "published_after_verification", attempt);
        if (exportedAfterVerification.identity !== publishedIdentity.identity) {
          destinationCompromised = true;
          published = false;
          publishedIdentity = null;
          throw new ExportError("UNSAFE_EXPORT_PATH", `Published Raw destination changed during verification: ${path.basename(destinationPath)}`);
        }
        const exportedStable = verification.stable !== false && sameFileVersion(exportedBeforeVerification, exportedAfterVerification);
        if (exportedStable && verification.sizeBytes === before.size && verification.sha256 === sourceSha256) {
          await removeOwnedTemporary(previousDestination, io);
          previousDestination = null;
          diagnostic("snapshot_attempt_end", { ...diagnosticContext, attempt, status: "STABLE", duration_ms: roundMs(performance.now() - attemptStartedAt) });
          return {
            sha256: verification.sha256,
            sizeBytes: exportedAfterVerification.size,
            sourceAfterMtimeMs: afterCopy.mtimeMs,
            sourceAfterSizeBytes: afterCopy.size,
            sourceBeforeMtimeMs: before.mtimeMs,
            sourceBeforeSizeBytes: before.size,
            attempts: attempt,
            sourceHashBasis,
            verificationValue: verification.value || null,
            copyStatus: RAW_COPY_STATUS.VERIFIED_AT_EXPORT,
            verifiedAt: new Date().toISOString(),
          };
        }
        lastReason = exportedStable ? "published bytes differ from the stable source hash" : "published snapshot changed while it was verified";
        routingSnapshotReusable = false;
        diagnostic("snapshot_attempt_end", { ...diagnosticContext, attempt, status: "RETRY", reason: exportedStable ? "HASH_MISMATCH" : "EXPORT_CHANGED", duration_ms: roundMs(performance.now() - attemptStartedAt) });
        await rollbackPublishedDestination(destinationPath, publishedIdentity, previousDestination, io);
        previousDestination = null;
        published = false;
      } else {
        lastReason = copiedStat.size === before.size ? "source size or modification time changed" : "copied snapshot size differs from the source";
        routingSnapshotReusable = false;
        diagnostic("snapshot_attempt_end", { ...diagnosticContext, attempt, status: "RETRY", reason: copiedStat.size === before.size ? "SOURCE_CHANGED" : "COPY_INCOMPLETE", duration_ms: roundMs(performance.now() - attemptStartedAt) });
      }
    } catch (error) {
      diagnostic("snapshot_attempt_end", { ...diagnosticContext, attempt, status: "ERROR", error_code: error?.code || "UNKNOWN", duration_ms: roundMs(performance.now() - attemptStartedAt) });
      if (published) {
        try {
          await rollbackPublishedDestination(destinationPath, publishedIdentity, previousDestination, io);
          previousDestination = null;
        } catch (rollbackError) {
          throw new ExportError("UNSAFE_EXPORT_PATH", `Could not safely roll back the published raw snapshot: ${rollbackError?.message || rollbackError}`);
        }
      }
      if (destinationCompromised) {
        throw new ExportError("UNSAFE_EXPORT_PATH", `The Raw destination changed during publication and was left untouched for manual inspection: ${path.basename(destinationPath)}`);
      }
      if (temporaryOwned) await removeOwnedTemporary(temporaryOwned, io);
      if (previousDestination) await restorePreviousDestination(destinationPath, previousDestination, io);
      if (error instanceof ExportError) throw error;
      if (["EACCES", "EBUSY", "EPERM"].includes(error?.code)) throw new ExportError("SOURCE_SNAPSHOT_LOCKED", `Could not create a stable raw snapshot because the source file is locked or inaccessible: ${path.basename(sourcePath)}`);
      throw new ExportError("SOURCE_SNAPSHOT_FAILED", `Could not create a stable raw snapshot for ${path.basename(sourcePath)}: ${error?.message || error}`);
    }
    if (temporaryOwned) await removeOwnedTemporary(temporaryOwned, io);
    if (attempt < maxAttempts) options.profiler?.recordSnapshotRetryCount(1);
  }

  throw new ExportError("SOURCE_CHANGED_DURING_EXPORT", `Could not create a stable raw snapshot because ${lastReason}: ${path.basename(sourcePath)}`);

  async function timedSnapshotStat(file, checkpoint, attempt) {
    const startedAt = performance.now();
    const [stat, identityStat] = await Promise.all([io.stat(file), io.statIdentity(file)]);
    const durationMs = performance.now() - startedAt;
    options.profiler?.addPhase("snapshot_stability_checks", durationMs);
    options.profiler?.recordSession(options.profileSession, "snapshot_stability_check_ms", durationMs);
    diagnostic("snapshot_stability_check", { ...diagnosticContext, attempt, checkpoint, duration_ms: roundMs(durationMs), size_bytes: stat.size });
    return { identity: reliableFileIdentity(identityStat), mtimeMs: stat.mtimeMs, size: stat.size };
  }
}

async function copyOpenedFile(sourceHandle, destinationHandle, expectedSize) {
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  while (position < expectedSize) {
    const requested = Math.min(buffer.length, expectedSize - position);
    const { bytesRead } = await sourceHandle.read(buffer, 0, requested, position);
    if (bytesRead === 0) break;
    let written = 0;
    while (written < bytesRead) {
      const result = await destinationHandle.write(buffer, written, bytesRead - written, position + written);
      if (result.bytesWritten === 0) throw new Error("Could not write the complete raw snapshot temporary file");
      written += result.bytesWritten;
    }
    position += bytesRead;
  }
  if (position !== expectedSize) throw new Error("Copied raw snapshot size differs from the validated source size");
}

function isStableRoutingSnapshot(snapshot) {
  return Boolean(snapshot?.stable
    && snapshot.sha256
    && Number.isFinite(snapshot.beforeSizeBytes)
    && Number.isFinite(snapshot.beforeMtimeMs)
    && snapshot.beforeSizeBytes === snapshot.afterSizeBytes
    && snapshot.beforeMtimeMs === snapshot.afterMtimeMs);
}

function routingSnapshotMatches(snapshot, stat) {
  return isStableRoutingSnapshot(snapshot)
    && snapshot.afterSizeBytes === stat.size
    && snapshot.afterMtimeMs === stat.mtimeMs;
}

function sameFileVersion(left, right) {
  return left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function parseCliInvocation(argv) {
  try {
    return { args: parseArgs(argv), error: null };
  } catch (error) {
    return { args: {}, error };
  }
}

async function acquireExportLock(outputRoot, sourceProtection) {
  const lockPath = path.join(outputRoot, ".codex-export.lock");
  await assertSeparatedOutputPath(lockPath, sourceProtection, { allowMissing: true });
  let handle;
  try {
    handle = await fsp.open(lockPath, "wx");
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() })}\n`, "utf8");
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error?.code === "EEXIST") throw new ExportError("EXPORT_ALREADY_RUNNING", `Another export is already using the output folder: ${path.basename(outputRoot)}`);
    throw new ExportError("EXPORT_LOCK_FAILED", `Could not lock the output folder: ${error?.message || error}`);
  }
  await handle.close();
  const identity = await inspectSeparatedPath(lockPath, { requireRegularFile: true, requireReliableIdentity: true });
  return { path: lockPath, identity };
}

async function releaseExportLock(lock) {
  await removeOwnedTemporary(lock, { lstat: fsp.lstat, realpath: fsp.realpath, rm: fsp.rm, stat: fsp.stat });
}

async function createSourceProtection(files, locations, protectedInputPaths = [], abortSignal = undefined) {
  const rootCanonicalPaths = new Set();
  const fileCanonicalPaths = new Set();
  const fileIdentities = new Set();
  for (const location of locations) {
    throwIfExportAborted(abortSignal);
    const root = await inspectSeparatedPath(location.root, { requireDirectory: true });
    rootCanonicalPaths.add(normalizePathForCompare(root.canonicalPath));
  }
  for (const entry of files) {
    throwIfExportAborted(abortSignal);
    const source = await inspectSeparatedPath(entry.file, { requireRegularFile: true, requireReliableIdentity: true });
    fileCanonicalPaths.add(normalizePathForCompare(source.canonicalPath));
    fileIdentities.add(source.identity);
  }
  for (const protectedInputPath of protectedInputPaths) {
    throwIfExportAborted(abortSignal);
    const input = await inspectSeparatedPath(protectedInputPath, { allowMissing: true, requireRegularFile: true, requireReliableIdentity: true });
    fileCanonicalPaths.add(normalizePathForCompare(input.canonicalPath));
    if (input.identity) fileIdentities.add(input.identity);
  }
  return Object.freeze({ rootCanonicalPaths, fileCanonicalPaths, fileIdentities });
}

async function ensureSeparatedOutputDirectory(directoryPath, sourceProtection, options = {}) {
  const candidate = await inspectSeparatedPath(directoryPath, { allowMissing: true, rejectAliases: true });
  assertSeparatedFromSources(candidate, sourceProtection, options);
  await fsp.mkdir(directoryPath, { recursive: true });
  const created = await inspectSeparatedPath(directoryPath, { rejectAliases: true, requireDirectory: true });
  assertSeparatedFromSources(created, sourceProtection, options);
  return created;
}

async function assertSeparatedOutputPath(candidatePath, sourceProtection, options = {}) {
  const parent = await inspectSeparatedPath(path.dirname(candidatePath), { rejectAliases: true, requireDirectory: true });
  assertSeparatedFromSources(parent, sourceProtection, { rejectSourceDescendants: false });
  const candidate = await inspectSeparatedPath(candidatePath, { allowMissing: options.allowMissing === true, rejectAliases: true, requireRegularFile: options.requireRegularFile === true, requireReliableIdentity: options.requireReliableIdentity === true });
  assertSeparatedFromSources(candidate, sourceProtection);
  return candidate;
}

function assertSeparatedFromSources(candidate, sourceProtection, options = {}) {
  const canonicalKey = normalizePathForCompare(candidate.canonicalPath);
  if (sourceProtection.fileCanonicalPaths.has(canonicalKey) || (candidate.identity && sourceProtection.fileIdentities.has(candidate.identity))) {
    throw new ExportError("OUTPUT_OVERLAPS_SOURCE", `Refusing to write an export file that aliases a protected Codex input: ${path.basename(candidate.absolutePath)}`);
  }
  for (const sourceRoot of sourceProtection.rootCanonicalPaths) {
    const insideSource = isPathInside(candidate.canonicalPath, sourceRoot);
    const containsSource = options.rejectSourceDescendants !== false && isPathInside(sourceRoot, candidate.canonicalPath);
    if (insideSource || containsSource) throw new ExportError("OUTPUT_OVERLAPS_SOURCE", `Refusing to write inside or above a Codex session source folder: ${path.basename(candidate.absolutePath)}`);
  }
}

function createFileHandleWritable(handle) {
  return new Writable({
    write(chunk, encoding, callback) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
      writeCompleteBuffer(handle, bytes).then(() => callback(), callback);
    },
  });
}

function readTopLevelJsonEventTypePrefix(line) {
  const text = String(line || "");
  let index = skipJsonWhitespace(text, 0);
  if (text[index] !== "{") return { status: "UNCERTAIN", value: "" };
  index += 1;
  while (index < text.length) {
    index = skipJsonWhitespace(text, index);
    if (text[index] === "}") return { status: "NOT_FOUND", value: "" };
    const key = readJsonStringToken(text, index);
    if (!key) return { status: "UNCERTAIN", value: "" };
    index = skipJsonWhitespace(text, key.end);
    if (text[index] !== ":") return { status: "UNCERTAIN", value: "" };
    index = skipJsonWhitespace(text, index + 1);
    if (key.value === "type") {
      const value = readJsonStringToken(text, index);
      return value ? { status: "FOUND", value: value.value } : { status: "UNCERTAIN", value: "" };
    }
    const valueEnd = skipJsonValue(text, index);
    if (valueEnd === null) return { status: "UNCERTAIN", value: "" };
    index = skipJsonWhitespace(text, valueEnd);
    if (text[index] !== ",") return text[index] === "}" ? { status: "NOT_FOUND", value: "" } : { status: "UNCERTAIN", value: "" };
    index += 1;
  }
  return { status: "UNCERTAIN", value: "" };
}

async function writeCompleteBuffer(handle, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, null);
    if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0) throw new ExportError("EXPORT_WRITE_FAILED", "PDF stream made no progress while writing its temporary file");
    offset += bytesWritten;
  }
}

async function writeSeparatedOutputFile(destinationPath, sourceProtection, writer, generation = null) {
  const generationDestination = generation ? await assertGenerationDestinationWritable(destinationPath, generation) : null;
  const destinationBefore = await assertSeparatedOutputPath(destinationPath, sourceProtection, { allowMissing: true, requireRegularFile: true, requireReliableIdentity: true });
  const temporaryPath = `${destinationPath}.partial-${process.pid}-${randomUUID()}`;
  await assertSeparatedOutputPath(temporaryPath, sourceProtection, { allowMissing: true });
  let handle;
  let temporaryOwned = null;
  let previousDestination = null;
  let publishedIdentity = null;
  try {
    handle = await fsp.open(temporaryPath, "wx");
    const openedStat = await handle.stat({ bigint: true });
    if (!openedStat.isFile()) throw new ExportError("UNSAFE_EXPORT_PATH", `Expected a regular export file: ${path.basename(destinationPath)}`);
    const openedIdentity = reliableFileIdentity(openedStat);
    if (!openedIdentity) throw new ExportError("UNSAFE_EXPORT_PATH", `Reliable file identity is unavailable for ${path.basename(temporaryPath)}`);
    temporaryOwned = { path: temporaryPath, identity: { identity: openedIdentity } };
    await writer(handle, temporaryPath);
    const writtenStat = await handle.stat({ bigint: true });
    if (reliableFileIdentity(writtenStat) !== openedIdentity) throw new ExportError("UNSAFE_EXPORT_PATH", `Export destination identity changed while writing: ${path.basename(destinationPath)}`);
    await handle.close();
    handle = null;
    const temporary = await assertSeparatedOutputPath(temporaryPath, sourceProtection, { requireRegularFile: true, requireReliableIdentity: true });
    if (temporary.identity !== openedIdentity) throw new ExportError("UNSAFE_EXPORT_PATH", `Temporary export file was replaced before publication: ${path.basename(destinationPath)}`);
    temporaryOwned = { path: temporaryPath, identity: temporary };
    const currentDestination = await assertSeparatedOutputPath(destinationPath, sourceProtection, { allowMissing: true, requireRegularFile: true, requireReliableIdentity: true });
    if (destinationBefore.exists !== currentDestination.exists || (destinationBefore.exists && !sameReliableFileIdentity(destinationBefore, currentDestination))) {
      throw new ExportError("UNSAFE_EXPORT_PATH", `Export destination changed before publication: ${path.basename(destinationPath)}`);
    }
    if (generation && currentDestination.exists) {
      if (!generationDestination.exists || !sameReliableFileIdentity(generationDestination, currentDestination)) {
        throw new ExportError("UNSAFE_EXPORT_PATH", `Export destination changed before reuse verification: ${path.basename(destinationPath)}`);
      }
      const identical = await filesHaveIdenticalVerifiedBytes(temporaryPath, temporary, destinationPath, currentDestination, sourceProtection);
      if (!identical) throw new ExportError("EXPORT_DESTINATION_COLLISION", `Refusing to replace an existing export file whose bytes differ: ${path.basename(destinationPath)}`);
      await removeOwnedTemporary(temporaryOwned, { lstat: fsp.lstat, realpath: fsp.realpath, rm: fsp.rm, stat: fsp.stat });
      temporaryOwned = null;
      return;
    }
    if (!generation) previousDestination = await moveExistingOutputAside(destinationPath, currentDestination, sourceProtection);
    await fsp.link(temporaryPath, destinationPath);
    publishedIdentity = await assertSeparatedOutputPath(destinationPath, sourceProtection, { requireRegularFile: true, requireReliableIdentity: true });
    if (publishedIdentity.identity !== openedIdentity) throw new ExportError("UNSAFE_EXPORT_PATH", `Published export file does not match its temporary file: ${path.basename(destinationPath)}`);
    await removeOwnedTemporary(temporaryOwned, { lstat: fsp.lstat, realpath: fsp.realpath, rm: fsp.rm, stat: fsp.stat });
    temporaryOwned = null;
    await removeOwnedTemporary(previousDestination, { lstat: fsp.lstat, realpath: fsp.realpath, rm: fsp.rm, stat: fsp.stat });
    previousDestination = null;
  } catch (error) {
    await handle?.close().catch(() => {});
    if (publishedIdentity) {
      await rollbackPublishedDestination(destinationPath, publishedIdentity, previousDestination, { lstat: fsp.lstat, realpath: fsp.realpath, rename: fsp.rename, rm: fsp.rm, stat: fsp.stat });
      previousDestination = null;
    }
    if (temporaryOwned) await removeOwnedTemporary(temporaryOwned, { lstat: fsp.lstat, realpath: fsp.realpath, rm: fsp.rm, stat: fsp.stat });
    if (previousDestination) await restorePreviousDestination(destinationPath, previousDestination, { lstat: fsp.lstat, realpath: fsp.realpath, rename: fsp.rename, stat: fsp.stat });
    throw error;
  }
}

async function moveExistingOutputAside(destinationPath, destination, sourceProtection) {
  if (!destination.exists) return null;
  assertSeparatedFromSources(destination, sourceProtection);
  const backupPath = `${destinationPath}.previous-${process.pid}-${randomUUID()}`;
  const backup = await assertSeparatedOutputPath(backupPath, sourceProtection, { allowMissing: true });
  if (backup.exists) throw new ExportError("UNSAFE_EXPORT_PATH", `Refusing to reuse an existing export backup file: ${path.basename(backupPath)}`);
  await fsp.rename(destinationPath, backupPath);
  const moved = await assertSeparatedOutputPath(backupPath, sourceProtection, { requireRegularFile: true, requireReliableIdentity: true });
  if (!sameReliableFileIdentity(destination, moved)) {
    await restoreUnexpectedMove(destinationPath, backupPath, moved, { lstat: fsp.lstat, realpath: fsp.realpath, rename: fsp.rename, stat: fsp.stat });
    throw new ExportError("UNSAFE_EXPORT_PATH", "Existing export destination identity changed while it was moved aside");
  }
  return { path: backupPath, identity: moved };
}

async function assertPerformanceProfileSeparated(profilePath, outputRoot, sourceProtection) {
  const profile = await inspectSeparatedPath(profilePath, { allowMissing: true, rejectAliases: true });
  assertSeparatedFromSources(profile, sourceProtection);
  const output = await inspectSeparatedPath(outputRoot, { allowMissing: true, rejectAliases: true });
  if (pathsOverlap(profile.canonicalPath, output.canonicalPath)) throw new ExportError("UNSAFE_EXPORT_PATH", "The performance profile must be stored outside the export output folder");
}

async function assertSeparatedExportRoot(candidateOutputRoot, sourceRoots) {
  const output = await inspectSeparatedPath(candidateOutputRoot, { allowMissing: true, rejectAliases: true });
  for (const sourceRoot of sourceRoots) {
    const source = await inspectSeparatedPath(sourceRoot, { requireDirectory: true });
    if (pathsOverlap(output.canonicalPath, source.canonicalPath)) {
      throw new ExportError("OUTPUT_OVERLAPS_SOURCE", `Refusing to export into or above a Codex session source folder: ${path.basename(candidateOutputRoot)}`);
    }
  }
}

async function assertSnapshotDestinationSeparated(sourceIdentity, destinationPath, io) {
  const destination = await inspectSeparatedPath(destinationPath, { allowMissing: true, io, rejectAliases: true });
  assertDistinctPathIdentity(sourceIdentity, destination, "Raw destination aliases its source session file");
}

async function assertSnapshotTemporarySeparated(sourceIdentity, destinationPath, temporaryPath, io) {
  const destination = await inspectSeparatedPath(destinationPath, { allowMissing: true, io, rejectAliases: true });
  const temporary = await inspectSeparatedPath(temporaryPath, { allowMissing: true, io, rejectAliases: true });
  if (temporary.exists) throw new ExportError("UNSAFE_EXPORT_PATH", `Refusing to reuse an existing raw snapshot temporary file: ${path.basename(temporaryPath)}`);
  assertDistinctPathIdentity(sourceIdentity, destination, "Raw destination aliases its source session file");
  assertDistinctPathIdentity(sourceIdentity, temporary, "Raw temporary path aliases its source session file");
  if (sameCanonicalPath(destination.canonicalPath, temporary.canonicalPath)) throw new ExportError("UNSAFE_EXPORT_PATH", "Raw destination and temporary path resolve to the same path");
}

async function moveExistingDestinationAside(sourceIdentity, destinationPath, io) {
  const destination = await inspectSeparatedPath(destinationPath, { allowMissing: true, io, rejectAliases: true, requireRegularFile: true, requireReliableIdentity: true });
  if (!destination.exists) return null;
  assertDistinctPathIdentity(sourceIdentity, destination, "Existing Raw destination aliases its source session file");
  const backupPath = `${destinationPath}.previous-${process.pid}-${randomUUID()}`;
  const backup = await inspectSeparatedPath(backupPath, { allowMissing: true, io, rejectAliases: true });
  if (backup.exists) throw new ExportError("UNSAFE_EXPORT_PATH", `Refusing to reuse an existing raw snapshot backup file: ${path.basename(backupPath)}`);
  await io.rename(destinationPath, backupPath);
  const moved = await inspectSeparatedPath(backupPath, { io, rejectAliases: true, requireRegularFile: true, requireReliableIdentity: true });
  if (!sameReliableFileIdentity(destination, moved)) {
    await restoreUnexpectedMove(destinationPath, backupPath, moved, io);
    throw new ExportError("UNSAFE_EXPORT_PATH", "Existing Raw destination identity changed while it was moved aside");
  }
  return { path: backupPath, identity: moved };
}

async function rollbackPublishedDestination(destinationPath, publishedIdentity, previousDestination, io) {
  if (!publishedIdentity) throw new ExportError("UNSAFE_EXPORT_PATH", "Published Raw destination identity was not established");
  const current = await inspectSeparatedPath(destinationPath, { io, rejectAliases: true, requireRegularFile: true, requireReliableIdentity: true });
  if (!sameReliableFileIdentity(publishedIdentity, current)) throw new ExportError("UNSAFE_EXPORT_PATH", "Published Raw destination was replaced before rollback");
  const failedPath = `${destinationPath}.failed-${process.pid}-${randomUUID()}`;
  const failedCandidate = await inspectSeparatedPath(failedPath, { allowMissing: true, io, rejectAliases: true });
  if (failedCandidate.exists) throw new ExportError("UNSAFE_EXPORT_PATH", `Refusing to reuse an existing failed snapshot path: ${path.basename(failedPath)}`);
  await io.rename(destinationPath, failedPath);
  const failedIdentity = await inspectSeparatedPath(failedPath, { io, rejectAliases: true, requireRegularFile: true, requireReliableIdentity: true });
  if (!sameReliableFileIdentity(publishedIdentity, failedIdentity)) {
    await restoreUnexpectedMove(destinationPath, failedPath, failedIdentity, io);
    throw new ExportError("UNSAFE_EXPORT_PATH", "Published Raw destination identity changed during rollback");
  }
  if (previousDestination) await restorePreviousDestination(destinationPath, previousDestination, io);
  await removeOwnedTemporary({ path: failedPath, identity: failedIdentity }, io);
}

async function restorePreviousDestination(destinationPath, previousDestination, io) {
  const destination = await inspectSeparatedPath(destinationPath, { allowMissing: true, io, rejectAliases: true });
  if (destination.exists) throw new ExportError("UNSAFE_EXPORT_PATH", "Refusing to overwrite a destination while restoring the previous Raw snapshot");
  const previous = await inspectSeparatedPath(previousDestination.path, { io, rejectAliases: true, requireRegularFile: true, requireReliableIdentity: true });
  if (!sameReliableFileIdentity(previousDestination.identity, previous)) throw new ExportError("UNSAFE_EXPORT_PATH", "Previous Raw destination identity changed before restoration");
  await io.rename(previousDestination.path, destinationPath);
}

async function restoreUnexpectedMove(destinationPath, movedPath, movedIdentity, io) {
  const destination = await inspectSeparatedPath(destinationPath, { allowMissing: true, io, rejectAliases: true });
  if (destination.exists) throw new ExportError("UNSAFE_EXPORT_PATH", "Could not restore a moved file because the destination was replaced");
  const moved = await inspectSeparatedPath(movedPath, { io, rejectAliases: true, requireRegularFile: true, requireReliableIdentity: true });
  if (!sameReliableFileIdentity(movedIdentity, moved)) throw new ExportError("UNSAFE_EXPORT_PATH", "Could not restore a moved file because its identity changed");
  await io.rename(movedPath, destinationPath);
}

async function removeOwnedTemporary(owned, io) {
  if (!owned) return;
  const current = await inspectSeparatedPath(owned.path, { io, rejectAliases: true, requireRegularFile: true, requireReliableIdentity: true });
  if (!sameReliableFileIdentity(owned.identity, current)) throw new ExportError("UNSAFE_EXPORT_PATH", `Refusing to remove a temporary file whose identity changed: ${path.basename(owned.path)}`);
  await io.rm(owned.path);
}

async function inspectSeparatedPath(candidatePath, options = {}) {
  const io = { lstat: fsp.lstat, realpath: fsp.realpath, stat: fsp.stat, statIdentity: (file) => fsp.stat(file, { bigint: true }), ...options.io };
  const absolutePath = path.resolve(candidatePath);
  let lstat;
  try {
    lstat = await io.lstat(absolutePath);
  } catch (error) {
    if (error?.code !== "ENOENT" || !options.allowMissing) throw new ExportError("UNSAFE_EXPORT_PATH", `Could not inspect path separation for ${path.basename(candidatePath)}: ${error?.message || error}`);
  }
  if (lstat) {
    if (lstat.isSymbolicLink()) throw new ExportError("UNSAFE_EXPORT_PATH", `Symbolic-link or junction path is not accepted for snapshot publication: ${path.basename(candidatePath)}`);
    const canonicalPath = await io.realpath(absolutePath);
    if (options.rejectAliases && !sameCanonicalPath(canonicalPath, absolutePath)) {
      throw new ExportError("UNSAFE_EXPORT_PATH", `Output path resolves through a symbolic-link, junction, or alias component: ${path.basename(candidatePath)}`);
    }
    const [stat, identityStat] = await Promise.all([io.stat(canonicalPath), io.statIdentity(canonicalPath)]);
    if (options.requireRegularFile && !stat.isFile()) throw new ExportError("UNSAFE_EXPORT_PATH", `Expected a regular file while checking path separation: ${path.basename(candidatePath)}`);
    if (options.requireDirectory && !stat.isDirectory()) throw new ExportError("UNSAFE_EXPORT_PATH", `Expected a directory while checking path separation: ${path.basename(candidatePath)}`);
    const identity = reliableFileIdentity(identityStat);
    if (options.requireReliableIdentity && !identity) throw new ExportError("UNSAFE_EXPORT_PATH", `Reliable file identity is unavailable for ${path.basename(candidatePath)}`);
    return { absolutePath, canonicalPath, exists: true, identity, stat };
  }
  const canonicalPath = await canonicalizeMissingPath(absolutePath, io);
  if (options.rejectAliases && !sameCanonicalPath(canonicalPath, absolutePath)) {
    throw new ExportError("UNSAFE_EXPORT_PATH", `Output path resolves through a symbolic-link, junction, or alias component: ${path.basename(candidatePath)}`);
  }
  return { absolutePath, canonicalPath, exists: false, identity: null, stat: null };
}

async function canonicalizeMissingPath(absolutePath, io) {
  let ancestor = absolutePath;
  const suffix = [];
  while (true) {
    try {
      const lstat = await io.lstat(ancestor);
      if (lstat.isSymbolicLink()) throw new ExportError("UNSAFE_EXPORT_PATH", `Symbolic-link or junction ancestor is not accepted: ${path.basename(ancestor)}`);
      const realAncestor = await io.realpath(ancestor);
      return path.join(realAncestor, ...suffix);
    } catch (error) {
      if (error instanceof ExportError) throw error;
      if (error?.code !== "ENOENT") throw new ExportError("UNSAFE_EXPORT_PATH", `Could not resolve path separation for ${path.basename(absolutePath)}: ${error?.message || error}`);
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw new ExportError("UNSAFE_EXPORT_PATH", `No existing ancestor could be resolved for ${path.basename(absolutePath)}`);
      suffix.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
}

function reliableFileIdentity(stat) {
  if (typeof stat?.dev === "bigint" && typeof stat?.ino === "bigint") {
    if (stat.dev < 0n || stat.ino <= 0n) return null;
    return `${stat.dev}:${stat.ino}`;
  }
  if (!Number.isSafeInteger(stat?.dev) || !Number.isSafeInteger(stat?.ino) || stat.dev < 0 || stat.ino <= 0) return null;
  return `${stat.dev}:${stat.ino}`;
}

async function filesHaveIdenticalVerifiedBytes(leftPath, leftIdentity, rightPath, rightIdentity, sourceProtection) {
  const leftBefore = await assertSeparatedOutputPath(leftPath, sourceProtection, { requireRegularFile: true, requireReliableIdentity: true });
  const rightBefore = await assertSeparatedOutputPath(rightPath, sourceProtection, { requireRegularFile: true, requireReliableIdentity: true });
  if (!sameReliableFileIdentity(leftIdentity, leftBefore) || !sameReliableFileIdentity(rightIdentity, rightBefore)) {
    throw new ExportError("UNSAFE_EXPORT_PATH", "An export file changed before byte comparison");
  }
  if (leftBefore.stat.size !== rightBefore.stat.size) return false;
  const [leftHash, rightHash] = await Promise.all([sha256File(leftPath), sha256File(rightPath)]);
  const leftAfter = await assertSeparatedOutputPath(leftPath, sourceProtection, { requireRegularFile: true, requireReliableIdentity: true });
  const rightAfter = await assertSeparatedOutputPath(rightPath, sourceProtection, { requireRegularFile: true, requireReliableIdentity: true });
  if (!sameReliableFileIdentity(leftBefore, leftAfter) || !sameReliableFileIdentity(rightBefore, rightAfter)
    || !sameFileVersion(leftBefore.stat, leftAfter.stat) || !sameFileVersion(rightBefore.stat, rightAfter.stat)) {
    throw new ExportError("UNSAFE_EXPORT_PATH", "An export file changed during byte comparison");
  }
  return leftHash === rightHash;
}

async function beginExportGeneration(outputRoot, sourceProtection, options = {}) {
  const root = path.resolve(outputRoot);
  const markerPath = path.join(root, INCOMPLETE_MARKER_NAME);
  const existingMarker = await fsp.lstat(markerPath).then(() => true, (error) => {
    if (error?.code === "ENOENT") return false;
    throw error;
  });
  if (existingMarker) {
    throw new ExportError("INCOMPLETE_EXPORT_EXISTS", `The output folder already contains ${INCOMPLETE_MARKER_NAME}. Use a new empty output folder, or manually inspect and remove the incomplete export.`);
  }
  const markerCandidate = await assertSeparatedOutputPath(markerPath, sourceProtection, { allowMissing: true, requireRegularFile: true, requireReliableIdentity: true });
  if (markerCandidate.exists) {
    throw new ExportError("INCOMPLETE_EXPORT_EXISTS", `The output folder already contains ${INCOMPLETE_MARKER_NAME}. Use a new empty output folder, or manually inspect and remove the incomplete export.`);
  }

  const previous = await inspectPreviousExportGeneration(root, sourceProtection);
  const generation = {
    root,
    sourceProtection,
    marker: null,
    describedPreviousPaths: previous.describedPaths,
    generatedAt: previous.generatedAt,
    previousRawSessions: previous.rawSessions,
  };
  for (const candidate of options.plannedPaths || []) await assertGenerationDestinationWritable(candidate, generation);

  const temporaryPath = `${markerPath}.partial-${process.pid}-${randomUUID()}`;
  await assertSeparatedOutputPath(temporaryPath, sourceProtection, { allowMissing: true });
  let handle;
  let temporaryOwned = null;
  let markerPublished = false;
  try {
    handle = await fsp.open(temporaryPath, "wx");
    const openedStat = await handle.stat({ bigint: true });
    const openedIdentity = reliableFileIdentity(openedStat);
    if (!openedStat.isFile() || !openedIdentity) throw new ExportError("UNSAFE_EXPORT_PATH", `Reliable file identity is unavailable for ${INCOMPLETE_MARKER_NAME}`);
    temporaryOwned = { path: temporaryPath, identity: { identity: openedIdentity } };
    await handle.writeFile([
      "Codex Project Chat Export",
      "Status: INCOMPLETE",
      "",
      "This export generation did not complete successfully.",
      "Do not use manifest.json, index.html, or index.md while this marker exists.",
      "Use a new empty output folder, or manually inspect and remove this incomplete export.",
      "",
    ].join("\n"), "utf8");
    await handle.sync();
    const writtenStat = await handle.stat({ bigint: true });
    if (reliableFileIdentity(writtenStat) !== openedIdentity) throw new ExportError("UNSAFE_EXPORT_PATH", `The ${INCOMPLETE_MARKER_NAME} identity changed while it was written`);
    await handle.close();
    handle = null;
    const temporary = await assertSeparatedOutputPath(temporaryPath, sourceProtection, { requireRegularFile: true, requireReliableIdentity: true });
    if (temporary.identity !== openedIdentity) throw new ExportError("UNSAFE_EXPORT_PATH", `The temporary ${INCOMPLETE_MARKER_NAME} was replaced before publication`);
    temporaryOwned = { path: temporaryPath, identity: temporary };
    await fsp.link(temporaryPath, markerPath);
    markerPublished = true;
    const published = await assertSeparatedOutputPath(markerPath, sourceProtection, { requireRegularFile: true, requireReliableIdentity: true });
    if (published.identity !== openedIdentity) throw new ExportError("UNSAFE_EXPORT_PATH", `The published ${INCOMPLETE_MARKER_NAME} does not match the run-owned marker`);
    await removeOwnedTemporary(temporaryOwned, { lstat: fsp.lstat, realpath: fsp.realpath, rm: fsp.rm, stat: fsp.stat });
    temporaryOwned = null;
    generation.marker = { path: markerPath, identity: published };
    return generation;
  } catch (error) {
    await handle?.close().catch(() => {});
    if (temporaryOwned) await removeOwnedTemporary(temporaryOwned, { lstat: fsp.lstat, realpath: fsp.realpath, rm: fsp.rm, stat: fsp.stat });
    if (error?.code === "EEXIST") throw new ExportError("INCOMPLETE_EXPORT_EXISTS", `The output folder already contains ${INCOMPLETE_MARKER_NAME}. Use a new empty output folder, or manually inspect and remove the incomplete export.`);
    if (markerPublished) throw new ExportError(error?.code || "EXPORT_MARKER_FAILED", `${error?.message || error}. ${INCOMPLETE_MARKER_NAME} remains present and the export is incomplete.`);
    throw error;
  }
}

async function inspectPreviousExportGeneration(outputRoot, sourceProtection) {
  const manifestPath = path.join(outputRoot, "manifest.json");
  const manifestBefore = await assertSeparatedOutputPath(manifestPath, sourceProtection, { allowMissing: true, requireRegularFile: true, requireReliableIdentity: true });
  if (!manifestBefore.exists) {
    for (const name of GENERATION_ROOT_FILES.filter((value) => value !== "manifest.json")) {
      const candidate = await assertSeparatedOutputPath(path.join(outputRoot, name), sourceProtection, { allowMissing: true, requireRegularFile: true, requireReliableIdentity: true });
      if (candidate.exists) throw new ExportError("UNOWNED_EXPORT_FILE", `Refusing to overwrite ${name} because no valid previous manifest assigns it to an exporter generation`);
    }
    await verifyPreviousAssetDirectoryOwnership(outputRoot, new Map(), sourceProtection);
    return { describedPaths: new Map(), generatedAt: new Date().toISOString(), rawSessions: new Map() };
  }

  let manifest;
  try {
    manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new ExportError("INVALID_PREVIOUS_MANIFEST", `The previous manifest is not valid JSON: ${error?.message || error}`);
  }
  const manifestAfter = await assertSeparatedOutputPath(manifestPath, sourceProtection, { requireRegularFile: true, requireReliableIdentity: true });
  if (!sameReliableFileIdentity(manifestBefore, manifestAfter) || manifestBefore.stat.size !== manifestAfter.stat.size || manifestBefore.stat.mtimeMs !== manifestAfter.stat.mtimeMs) {
    throw new ExportError("INVALID_PREVIOUS_MANIFEST", "The previous manifest changed while it was being validated");
  }

  const assetManifest = await readPreviousAssetManifest(outputRoot, manifest, sourceProtection);
  const describedPaths = collectPreviousGenerationPaths(manifest, assetManifest);
  for (const name of GENERATION_ROOT_FILES) {
    const candidate = await assertSeparatedOutputPath(path.join(outputRoot, name), sourceProtection, { allowMissing: true, requireRegularFile: true, requireReliableIdentity: true });
    if (candidate.exists && !describedPaths.has(generationPathKey(name))) {
      throw new ExportError("UNOWNED_EXPORT_FILE", `Refusing to reuse ${name} because the previous manifest does not describe it`);
    }
  }
  await verifyPreviousAssetDirectoryOwnership(outputRoot, describedPaths, sourceProtection);
  const rawSessions = new Map();
  for (const session of manifest.sessions) {
    if (!session.raw_export_file) continue;
    rawSessions.set(generationPathKey(validatedGenerationRelativePath(session.raw_export_file, "raw")), session);
  }
  return {
    describedPaths,
    generatedAt: isCanonicalIsoTimestamp(manifest.generated_at) ? manifest.generated_at : new Date().toISOString(),
    rawSessions,
  };
}

async function readPreviousAssetManifest(outputRoot, manifest, sourceProtection) {
  if (manifest.assets_manifest === undefined) return null;
  const relativePath = validatedGenerationRelativePath(manifest.assets_manifest, "asset_manifest");
  const manifestPath = path.join(outputRoot, ...relativePath.split("/"));
  const before = await assertSeparatedOutputPath(manifestPath, sourceProtection, { allowMissing: true, requireRegularFile: true, requireReliableIdentity: true });
  if (!before.exists) throw new ExportError("INVALID_PREVIOUS_MANIFEST", "The previous root manifest points to a missing asset manifest");
  let assetManifest;
  try {
    assetManifest = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new ExportError("INVALID_PREVIOUS_MANIFEST", `The previous asset manifest is not valid JSON: ${error?.message || error}`);
  }
  const after = await assertSeparatedOutputPath(manifestPath, sourceProtection, { requireRegularFile: true, requireReliableIdentity: true });
  if (!sameReliableFileIdentity(before, after) || !sameFileVersion(before.stat, after.stat)) {
    throw new ExportError("INVALID_PREVIOUS_MANIFEST", "The previous asset manifest changed while it was being validated");
  }
  return assetManifest;
}

async function verifyPreviousAssetDirectoryOwnership(outputRoot, describedPaths, sourceProtection) {
  const assetsDirectory = path.join(outputRoot, "assets");
  const inspected = await inspectSeparatedPath(assetsDirectory, { allowMissing: true, rejectAliases: true, requireDirectory: true, requireReliableIdentity: true });
  assertSeparatedFromSources(inspected, sourceProtection);
  if (!inspected.exists) return;
  const entries = await fsp.readdir(assetsDirectory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) throw new ExportError("UNOWNED_EXPORT_FILE", `Refusing to reuse an unowned or non-regular assets entry: ${entry.name}`);
    const relativePath = validatedGenerationRelativePath(`assets/${entry.name}`, entry.name === "manifest.json" ? "asset_manifest" : "asset");
    if (!describedPaths.has(generationPathKey(relativePath))) throw new ExportError("UNOWNED_EXPORT_FILE", `Refusing to reuse ${relativePath} because the previous manifests do not describe it`);
    await assertSeparatedOutputPath(path.join(assetsDirectory, entry.name), sourceProtection, { requireRegularFile: true, requireReliableIdentity: true });
  }
  const after = await inspectSeparatedPath(assetsDirectory, { rejectAliases: true, requireDirectory: true, requireReliableIdentity: true });
  if (!sameReliableFileIdentity(inspected, after)) throw new ExportError("UNSAFE_EXPORT_PATH", "The assets directory changed while previous-generation ownership was validated");
}

function collectPreviousGenerationPaths(manifest, assetManifest = null) {
  if (!manifest || manifest.archive_format_version !== ARCHIVE_FORMAT_VERSION || !Array.isArray(manifest.sessions) || !manifest.formats || typeof manifest.formats !== "object") {
    throw new ExportError("INVALID_PREVIOUS_MANIFEST", "The previous manifest does not match archive format version 1");
  }
  const authorized = new Map();
  addAuthorizedGenerationPath(authorized, "manifest.json", "root");
  addAuthorizedGenerationPath(authorized, "README.txt", "root");
  if (manifest.formats.html === true) addAuthorizedGenerationPath(authorized, "index.html", "root");
  if (manifest.formats.markdown === true) addAuthorizedGenerationPath(authorized, "index.md", "root");
  if ((manifest.formats.attachments === true) !== Boolean(assetManifest)) throw new ExportError("INVALID_PREVIOUS_MANIFEST", "The previous root and asset manifest attachment declarations disagree");
  if (assetManifest) {
    if (manifest.assets_manifest !== ASSET_MANIFEST_PATH || ![1, 2].includes(assetManifest.schema_version) || assetManifest.hash_algorithm !== "sha256" || !Array.isArray(assetManifest.assets)) {
      throw new ExportError("INVALID_PREVIOUS_MANIFEST", "The previous asset manifest does not match a supported schema version");
    }
    addAuthorizedGenerationPath(authorized, ASSET_MANIFEST_PATH, "asset_manifest");
    const sortedAssetHashes = assetManifest.assets.map((asset) => asset?.sha256);
    const lexicalAssetHashes = [...sortedAssetHashes].sort((left, right) => String(left) < String(right) ? -1 : String(left) > String(right) ? 1 : 0);
    if (JSON.stringify(sortedAssetHashes) !== JSON.stringify(lexicalAssetHashes)) throw new ExportError("INVALID_PREVIOUS_MANIFEST", "The previous asset manifest is not sorted by SHA-256");
    const sessionOrder = new Map();
    for (let index = 0; index < manifest.sessions.length; index += 1) {
      const sessionId = manifest.sessions[index]?.session_id;
      if (typeof sessionId !== "string" || sessionOrder.has(sessionId)) throw new ExportError("INVALID_PREVIOUS_MANIFEST", "The previous manifest cannot establish a unique asset session order");
      sessionOrder.set(sessionId, index);
    }
    for (const asset of assetManifest.assets) {
      if (!isValidPreviousAssetEntry(asset, sessionOrder, assetManifest.schema_version)) throw new ExportError("INVALID_PREVIOUS_MANIFEST", "The previous asset manifest contains an invalid asset record");
      addAuthorizedGenerationPath(authorized, asset.path, "asset");
    }
    const occurrences = assetManifest.assets.reduce((sum, asset) => sum + asset.uses.length, 0);
    const uniqueBytes = assetManifest.assets.reduce((sum, asset) => sum + asset.bytes, 0);
    const occurrenceBytes = assetManifest.assets.reduce((sum, asset) => sum + asset.bytes * asset.uses.length, 0);
    if (manifest.asset_occurrences !== occurrences || manifest.unique_assets !== assetManifest.assets.length || manifest.unique_asset_bytes !== uniqueBytes || manifest.deduplicated_asset_bytes_saved !== occurrenceBytes - uniqueBytes) {
      throw new ExportError("INVALID_PREVIOUS_MANIFEST", "The previous root manifest asset summaries do not match its asset manifest");
    }
  }
  for (const session of manifest.sessions) {
    if (!session || typeof session !== "object") throw new ExportError("INVALID_PREVIOUS_MANIFEST", "The previous manifest contains an invalid session record");
    if (session.raw_export_file) addAuthorizedGenerationPath(authorized, session.raw_export_file, "raw");
    if (session.markdown_file) addAuthorizedGenerationPath(authorized, session.markdown_file, "markdown");
    if (session.docx_file) {
      if (manifest.formats.docx !== true) throw new ExportError("INVALID_PREVIOUS_MANIFEST", "The previous manifest contains a DOCX path without declaring the DOCX format");
      addAuthorizedGenerationPath(authorized, session.docx_file, "docx");
    }
    if (session.pdf_file) {
      if (manifest.formats.pdf !== true) throw new ExportError("INVALID_PREVIOUS_MANIFEST", "The previous manifest contains a PDF path without declaring the PDF format");
      addAuthorizedGenerationPath(authorized, session.pdf_file, "pdf");
    }
  }
  return authorized;
}

function isValidPreviousAssetEntry(asset, sessionOrder, schemaVersion) {
  if (!asset || typeof asset !== "object" || !isLowerHexSha256Text(asset.sha256) || !ASSET_EXTENSIONS.includes(asset.extension)) return false;
  if (asset.path !== `assets/${asset.sha256}.${asset.extension}` || !Number.isSafeInteger(asset.bytes) || asset.bytes < 0 || typeof asset.renderable !== "boolean" || !Array.isArray(asset.uses)) return false;
  const expectedMime = { bin: "application/octet-stream", gif: "image/gif", jpg: "image/jpeg", png: "image/png", webp: "image/webp" }[asset.extension];
  const allowedKeys = new Set(["sha256", "path", "mime_type", "extension", "bytes", "renderable", "uses"]);
  if (Object.keys(asset).some((key) => !allowedKeys.has(key)) || !asset.uses.every((use) => isValidPreviousAssetUse(use, expectedMime, sessionOrder, schemaVersion))) return false;
  for (let index = 1; index < asset.uses.length; index += 1) {
    if (compareAssetUses(asset.uses[index - 1], asset.uses[index], sessionOrder) > 0) return false;
  }
  return asset.mime_type === expectedMime && asset.renderable === (asset.extension !== "bin");
}

function isValidPreviousAssetUse(use, canonicalMime, sessionOrder, schemaVersion) {
  if (!use || typeof use !== "object" || !isSafeAssetSessionReference(use.session_id) || !sessionOrder.has(use.session_id) || !Number.isSafeInteger(use.record_ordinal) || use.record_ordinal <= 0 || !Number.isSafeInteger(use.attachment_ordinal) || use.attachment_ordinal <= 0) return false;
  const hasMime = Object.hasOwn(use, "declared_mime");
  const legacyKeys = hasMime
    ? new Set(["attachment_ordinal", "record_ordinal", "session_id", "declared_mime", "mime_mismatch"])
    : new Set(["attachment_ordinal", "record_ordinal", "session_id"]);
  const provenanceKeys = new Set([
    "canonical_attachment_ordinal", "canonical_record_ordinal", "classification", "content_type", "mirror_kind",
    "reading_disposition", "record_type", "role", "timestamp", "tool_origin",
  ]);
  const allowedKeys = schemaVersion === 2 ? new Set([...legacyKeys, ...provenanceKeys]) : legacyKeys;
  if (Object.keys(use).some((key) => !allowedKeys.has(key))) return false;
  if (hasMime && (!isSafeDeclaredMime(use.declared_mime) || use.mime_mismatch !== (use.declared_mime !== canonicalMime))) return false;
  if (schemaVersion === 1) return true;
  if ([...provenanceKeys].some((key) => !Object.hasOwn(use, key))) return false;
  const nullableOrdinal = (value) => value === null || (Number.isSafeInteger(value) && value > 0);
  return nullableOrdinal(use.canonical_attachment_ordinal)
    && nullableOrdinal(use.canonical_record_ordinal)
    && [use.classification, use.content_type, use.mirror_kind, use.reading_disposition, use.record_type, use.role, use.timestamp, use.tool_origin].every(isSafeManifestUseText);
}

function isSafeManifestUseText(value) {
  if (typeof value !== "string" || value.length > 256) return false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

function compareAssetUses(left, right, sessionOrder) {
  return sessionOrder.get(left.session_id) - sessionOrder.get(right.session_id)
    || left.record_ordinal - right.record_ordinal
    || left.attachment_ordinal - right.attachment_ordinal;
}

function isSafeAssetSessionReference(value) {
  const text = typeof value === "string" ? value : "";
  if (!text || text.length > 256 || text !== text.trim()) return false;
  for (const character of text) {
    const code = character.charCodeAt(0);
    if (code < 0x20 || code === 0x7f || "/\\:".includes(character)) return false;
  }
  return true;
}

function isSafeDeclaredMime(value) {
  if (typeof value !== "string" || !value || value.length > 127 || value !== value.toLowerCase() || value.split("/").length !== 2) return false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    const alphanumeric = (code >= 48 && code <= 57) || (code >= 97 && code <= 122);
    if (!alphanumeric && !"!#$&^_.+-/".includes(character)) return false;
  }
  return true;
}

function isLowerHexSha256Text(value) {
  if (typeof value !== "string" || value.length !== 64) return false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (!((code >= 48 && code <= 57) || (code >= 97 && code <= 102))) return false;
  }
  return true;
}

function addAuthorizedGenerationPath(authorized, value, kind) {
  const relativePath = validatedGenerationRelativePath(value, kind);
  const key = generationPathKey(relativePath);
  if (authorized.has(key)) throw new ExportError("INVALID_PREVIOUS_MANIFEST", `The previous manifest assigns the same export path more than once: ${relativePath}`);
  authorized.set(key, relativePath);
}

function validatedGenerationRelativePath(value, kind = "any") {
  if (typeof value !== "string" || !value || value.includes("\0") || path.win32.isAbsolute(value) || path.posix.isAbsolute(value)) {
    throw new ExportError("INVALID_PREVIOUS_MANIFEST", "The previous manifest contains an absolute or invalid export path");
  }
  const portable = value.replaceAll("\\", "/");
  const segments = portable.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.includes(":"))) {
    throw new ExportError("INVALID_PREVIOUS_MANIFEST", `The previous manifest contains a non-canonical export path: ${portable}`);
  }
  const normalized = segments.join("/");
  const validRoot = GENERATION_ROOT_FILES.includes(normalized);
  const validRaw = normalized.startsWith("raw/") && normalized.toLowerCase().endsWith(".jsonl");
  const validMarkdown = (normalized.startsWith("md/") || normalized.startsWith("markdown/")) && normalized.toLowerCase().endsWith(".md");
  const validDocx = normalized.startsWith("docx/") && normalized.toLowerCase().endsWith(".docx");
  const validPdf = normalized.startsWith("pdf/") && normalized.toLowerCase().endsWith(".pdf");
  const validAssetManifest = normalized === ASSET_MANIFEST_PATH;
  const validAsset = isCanonicalAssetPath(normalized);
  if ((kind === "root" && !validRoot) || (kind === "raw" && !validRaw) || (kind === "markdown" && !validMarkdown) || (kind === "docx" && !validDocx) || (kind === "pdf" && !validPdf) || (kind === "asset_manifest" && !validAssetManifest) || (kind === "asset" && !validAsset) || (kind === "any" && !validRoot && !validRaw && !validMarkdown && !validDocx && !validPdf && !validAssetManifest && !validAsset)) {
    throw new ExportError("INVALID_PREVIOUS_MANIFEST", `The previous manifest contains an unexpected export path: ${normalized}`);
  }
  return normalized;
}

function isCanonicalAssetPath(value) {
  const segments = String(value).split("/");
  if (segments.length !== 2 || segments[0] !== "assets") return false;
  const nameParts = segments[1].split(".");
  return nameParts.length === 2 && isLowerHexSha256Text(nameParts[0]) && ASSET_EXTENSIONS.includes(nameParts[1]);
}

function generationPathKey(value) {
  const normalized = String(value).replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function generationAbsolutePath(outputRoot, relativePath) {
  const validated = validatedGenerationRelativePath(relativePath);
  const absolutePath = path.resolve(outputRoot, ...validated.split("/"));
  if (!isPathInside(absolutePath, outputRoot) || sameCanonicalPath(absolutePath, outputRoot)) throw new ExportError("INVALID_PREVIOUS_MANIFEST", `Export path escapes the output folder: ${validated}`);
  return absolutePath;
}

async function assertGenerationDestinationWritable(candidatePath, generation) {
  const absolutePath = path.isAbsolute(candidatePath) ? path.resolve(candidatePath) : generationAbsolutePath(generation.root, candidatePath);
  if (!isPathInside(absolutePath, generation.root) || sameCanonicalPath(absolutePath, generation.root)) throw new ExportError("UNSAFE_EXPORT_PATH", "Export generation path is outside the output folder");
  const relativePath = validatedGenerationRelativePath(path.relative(generation.root, absolutePath));
  const key = generationPathKey(relativePath);
  const candidate = await inspectSeparatedPath(absolutePath, { allowMissing: true, rejectAliases: true, requireRegularFile: true, requireReliableIdentity: true });
  assertSeparatedFromSources(candidate, generation.sourceProtection);
  if (candidate.exists && !generation.describedPreviousPaths.has(key)) {
    throw new ExportError("UNOWNED_EXPORT_FILE", `Refusing to reuse ${relativePath} because the previous manifest does not describe it`);
  }
  return candidate;
}

function previousRawSession(generation, destinationPath) {
  if (!generation?.previousRawSessions) return null;
  const relativePath = validatedGenerationRelativePath(path.relative(generation.root, destinationPath), "raw");
  return generation.previousRawSessions.get(generationPathKey(relativePath)) || null;
}

async function completeExportGeneration(generation) {
  if (!generation?.marker) throw new ExportError("EXPORT_VERIFICATION_FAILED", "The export generation has no verified incomplete marker");
  await removeOwnedTemporary(generation.marker, { lstat: fsp.lstat, realpath: fsp.realpath, rm: fsp.rm, stat: fsp.stat });
  generation.marker = null;
}

function sameReliableFileIdentity(left, right) {
  return Boolean(left?.identity && right?.identity && left.identity === right.identity);
}

function assertDistinctPathIdentity(left, right, message) {
  if (sameCanonicalPath(left.canonicalPath, right.canonicalPath) || sameReliableFileIdentity(left, right)) throw new ExportError("OUTPUT_OVERLAPS_SOURCE", message);
  if (left.exists && right.exists && (!left.identity || !right.identity)) throw new ExportError("UNSAFE_EXPORT_PATH", "Reliable file identity is required to prove source and destination separation");
}

function sameCanonicalPath(left, right) {
  return normalizePathForCompare(left) === normalizePathForCompare(right);
}

function pathsOverlap(left, right) {
  return isPathInside(left, right) || isPathInside(right, left);
}

function isCanonicalIsoTimestamp(value) {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

async function sha256File(file) {
  const hash = createHash("sha256");
  const input = fs.createReadStream(file);
  for await (const chunk of input) hash.update(chunk);
  return hash.digest("hex");
}

function validatedSourceRelativePath(sourcePath, sourceRootPath) {
  const relative = path.relative(path.resolve(sourceRootPath), path.resolve(sourcePath));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new ExportError("INVALID_SOURCE_RELATIVE_PATH", `Source file is outside its declared ${path.basename(sourceRootPath)} root: ${path.basename(sourcePath)}`);
  return toPosixPath(relative);
}

function normalizePathForCompare(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function recordedPathIdentity(value, platform = process.platform) {
  if (typeof value !== "string" || !value) return "";
  if (platform !== "win32") return path.posix.isAbsolute(value) ? trimNonRootTrailingSeparators(path.posix.normalize(value), path.posix) : "";
  let candidate = value.replaceAll("/", "\\");
  const lowerCandidate = candidate.toLowerCase();
  if (lowerCandidate.startsWith("\\\\?\\unc\\")) {
    candidate = `\\\\${candidate.slice(8)}`;
  } else if (candidate.startsWith("\\\\?\\") && candidate.length >= 7 && candidate[5] === ":" && candidate[6] === "\\" && isAsciiLetter(candidate[4])) {
    candidate = candidate.slice(4);
  }
  if (!path.win32.isAbsolute(candidate)) return "";
  return trimNonRootTrailingSeparators(path.win32.normalize(candidate), path.win32).toLowerCase();
}

function trimNonRootTrailingSeparators(value, pathApi) {
  const root = pathApi.parse(value).root;
  let end = value.length;
  while (end > root.length && (value[end - 1] === "/" || value[end - 1] === "\\")) end -= 1;
  return value.slice(0, end);
}

function isAsciiLetter(value) {
  if (typeof value !== "string" || value.length !== 1) return false;
  const code = value.charCodeAt(0) | 32;
  return code >= 97 && code <= 122;
}

function sameRecordedPathIdentity(left, right, platform = process.platform) {
  const leftIdentity = recordedPathIdentity(left, platform);
  return Boolean(leftIdentity && leftIdentity === recordedPathIdentity(right, platform));
}

function isPathInside(candidate, root) {
  const normalizedCandidate = normalizePathForCompare(candidate);
  const normalizedRoot = normalizePathForCompare(root);
  const relative = path.relative(normalizedRoot, normalizedCandidate);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}
function matchesProject(cwd, filter) {
  if (!filter) return true;
  if (!cwd) return false;
  const cleanFilter = normalizeLoose(filter);
  const cleanCwd = normalizeLoose(cwd);
  const cwdLeaf = normalizeLoose(portableBasename(cwd));
  if (cleanCwd === cleanFilter || cwdLeaf === cleanFilter) return true;
  if (cleanCwd.startsWith(`${cleanFilter}/`) || cleanCwd.includes(`/${cleanFilter}/`)) return true;
  return cwdLeaf.includes(cleanFilter);
}

function normalizeLoose(value) {
  return String(value || "").replace(/\\/g, "/").replace(/\/+$/g, "").toLowerCase();
}

function portableBasename(value) {
  const normalized = String(value || "").replace(/\\/g, "/").replace(/\/+$/g, "");
  return path.posix.basename(normalized);
}

function deriveTitle(text, maxLength = 96) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const candidate = lines.find((line) => !/^<[^>]+>$/.test(line) && !/^\[.*\]$/.test(line)) || lines[0] || "";
  const compact = candidate.replace(/\s+/g, " ");
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

function resolveDisplayTitle(meta, indexedThreadName) {
  const indexedTitle = deriveTitle(indexedThreadName, 120);
  const firstDirectTitle = deriveUserDisplayTitle(meta.firstUserText, 120);
  const indexedTitleStatus = validateIndexedTitle(indexedTitle, firstDirectTitle, meta.eventAnalysis?.nonDirectTitleCandidates || []);
  if (indexedTitle && indexedTitleStatus === "ACCEPTED") return { displayTitle: indexedTitle, indexedTitleStatus, source: "session_index" };
  if (firstDirectTitle) return { displayTitle: firstDirectTitle, indexedTitleStatus, source: "direct_user_message" };
  return { displayTitle: neutralSessionTitle(meta), indexedTitleStatus, source: meta.sessionKind === SESSION_KIND.SUBAGENT ? "neutral_subagent" : "neutral_no_user" };
}

function validateIndexedTitle(indexedTitle, firstDirectTitle, nonDirectTitleCandidates = []) {
  if (!indexedTitle) return "NOT_PRESENT";
  const normalizedIndexed = normalizeTitleForCompare(indexedTitle);
  if (firstDirectTitle && normalizedIndexed === normalizeTitleForCompare(firstDirectTitle)) return "ACCEPTED";
  if (nonDirectTitleCandidates.some((candidate) => normalizeTitleForCompare(candidate) === normalizedIndexed)) return "REJECTED_TECHNICAL_CONTEXT_MATCH";
  if (["agents.md instructions", "environment context", "plugin instructions", "recommended plugins"].includes(normalizedIndexed)) return "REJECTED_TECHNICAL_CONTEXT_TITLE";
  return "ACCEPTED";
}

function normalizeTitleForCompare(value) {
  return String(value || "").trim().replace(/^#+\s*/, "").replace(/[<>_]+/g, " ").replace(/\s+/g, " ").toLowerCase();
}

function neutralSessionTitle(meta) {
  const id = String(meta.id || meta.session_id || path.basename(meta.file || "", ".jsonl") || "unknown");
  const shortId = id.length > 12 ? `${id.slice(0, 8)}…` : id;
  return `${meta.sessionKind === SESSION_KIND.SUBAGENT ? "Subagent session" : "Codex session"} ${shortId}`;
}

function shortProjectDir(projectDirs, cwd) {
  const key = cwd || "unknown";
  if (!projectDirs.has(key)) {
    const number = String(projectDirs.size + 1).padStart(3, "0");
    const leaf = slug(portableBasename(key)).slice(0, 24);
    projectDirs.set(key, `p${number}${leaf ? `-${leaf}` : ""}`);
  }
  return projectDirs.get(key);
}

function readableProjectDir(projectDirs, cwd) {
  const key = cwd || "unknown";
  if (!projectDirs.has(key)) {
    const used = new Set(projectDirs.values());
    const base = slug(portableBasename(key));
    let candidate = base;
    let suffix = 2;
    while (used.has(candidate)) {
      candidate = `${base}-${suffix}`;
      suffix += 1;
    }
    projectDirs.set(key, candidate);
  }
  return projectDirs.get(key);
}

async function writeSessionDocuments(meta, paths, profiler = null, profileSession = meta, context, sourceProtection, generation, assetStore, assetSnapshot) {
  const { redactMarkdown, includeTools } = context;
  const { markdownPath, docxPath, pdfPath, rawRel } = paths;
  const renderStart = performance.now();
  const stats = { userMessages: 0, assistantMessages: 0, subagentInputs: 0, runtimeContexts: 0, unclassifiedUserRoleRecords: 0, toolEvents: 0, model: meta.model || "", updatedAt: meta.latestTimestamp || meta.updatedAt || meta.timestamp || "" };
  const readerSummary = createSessionReaderSummary();
  const documentMessages = [];
  const additionalStoredContext = [];
  const readingSelection = assetSnapshot?.readingSelection;
  const renderedImageChecks = new Map();
  const selectedAttachments = (item, recordNumber, kind = "visible") => {
    const descriptors = collectAttachmentDescriptorsInOrder(item);
    const ordinals = new Set(kind === "additional"
      ? readingSelection?.additionalAttachmentOrdinals(recordNumber) || []
      : readingSelection?.visibleAttachmentOrdinals(recordNumber) || descriptors.map((_descriptor, index) => index + 1));
    return descriptors.filter((_descriptor, index) => ordinals.has(index + 1));
  };
  const readingMessageText = async (content, recordNumber) => {
    if (!Array.isArray(content) || !content.some(part => part?.type === "input_text" && String(part.text || "").startsWith("<image"))) return extractText(content);
    const candidates = new Set();
    extractReadingText(content, part => { candidates.add(part); return false; });
    const accepted = new Set();
    for (const part of candidates) {
      const descriptors = collectAttachmentDescriptorsInOrder(part);
      if (descriptors.length !== 1) continue;
      const descriptor = descriptors[0];
      const entry = assetStore.assetForDescriptor(descriptor);
      if (!entry?.renderable || !["png", "jpg"].includes(entry.extension)) continue;
      if (!renderedImageChecks.has(entry.sha256)) {
        const asset = await resolveVerifiedAsset(assetStore, context.outputDir, { ...descriptor, origin: { recordOrdinal: recordNumber } });
        renderedImageChecks.set(entry.sha256, Boolean(imageDimensions(asset.data, asset.extension)));
      }
      if (renderedImageChecks.get(entry.sha256)) accepted.add(part);
    }
    return extractReadingText(content, part => accepted.has(part));
  };

  const addDocumentMessage = (role, label, text, attachments, timestamp, recordNumber) => {
    if (!docxPath && !pdfPath) return;
    documentMessages.push(createDocumentMessage({
      sessionId: meta.id,
      recordOrdinal: recordNumber,
      role,
      label,
      text,
      attachments,
      timestamp: formatDerivedTimestamp(timestamp),
    }));
  };

  const processRecords = async (out) => {
    if (out) {
      writeLine(out, `# ${meta.displayTitle || meta.title || "Codex Project Chat Export"}`);
      writeLine(out, "");
      writeLine(out, `- Project: ${meta.cwd || ""}`);
      writeLine(out, `- Storage: ${meta.storage || "active"}`);
      writeLine(out, `- Session ID: ${meta.id || ""}`);
      writeLine(out, `- Started: ${formatDerivedTimestamp(meta.timestamp)}`);
      writeLine(out, `- Updated: ${formatDerivedTimestamp(stats.updatedAt)}`);
      if (meta.model) writeLine(out, `- Model: ${meta.model}`);
      if (rawRel) writeLine(out, `- Raw JSONL: ${rawRel.replace(/\\/g, "/")}`);
      writeLine(out, "");
      writeLine(out, "> Markdown is a classified, derived reading view. The raw JSONL file is the canonical lossless session snapshot.");
      if (redactMarkdown) writeLine(out, "> Known token-shaped secrets are masked when detected in this reading view; the raw snapshot remains unchanged.");
      writeLine(out, "");
    }

    for await (const { item, recordNumber } of streamSessionRecords(meta.file, {
      ...context.readerOptions,
      calculateSha256: true,
      implementation: context.readerImplementation,
      summary: readerSummary,
    })) {
      if (item.timestamp && (!stats.updatedAt || item.timestamp > stats.updatedAt)) stats.updatedAt = item.timestamp;
      if (item.type === "turn_context" && item.payload?.model && !stats.model) stats.model = item.payload.model;
      if (item.type === "compacted") {
        const attachments = selectedAttachments(item, recordNumber, "additional");
        if (attachments.length) additionalStoredContext.push({ attachments, recordNumber, timestamp: item.timestamp });
        continue;
      }
      if (item.type !== "response_item" || !item.payload) continue;
      const payload = item.payload;
      if (payload.type === "message" && payload.role === "user") {
        const text = await readingMessageText(payload.content, recordNumber);
        const renderedText = redactMarkdown ? redactSecrets(text) : text;
        const attachments = selectedAttachments(item, recordNumber);
        if (!text.trim() && !attachments.length) continue;
        const classification = meta.eventAnalysis?.classifications?.get(recordNumber) || { kind: USER_RECORD_KIND.UNCLASSIFIED_USER_ROLE_RECORD, runtimeContextTypes: [] };
        if (classification.kind === USER_RECORD_KIND.DIRECT_USER_TURN) {
          stats.userMessages += 1;
          if (out) {
            writeLine(out, `## User${formatDerivedTimestampSuffix(item.timestamp)}`);
            writeLine(out, "");
            if (text.trim()) { writeLine(out, renderedText); writeLine(out, ""); }
            writeAssetReferences(out, attachments, assetStore, markdownPath);
          }
          addDocumentMessage(DOCUMENT_ROLE.USER, "User", renderedText, attachments, item.timestamp, recordNumber);
        } else if (classification.kind === USER_RECORD_KIND.SUBAGENT_INPUT) {
          stats.subagentInputs += 1;
          if (out) {
            if (text.trim()) writeClassifiedContext(out, "Subagent input / parent-agent handoff", text, item.timestamp, redactMarkdown);
            writeAssetReferences(out, attachments, assetStore, markdownPath);
          }
          addDocumentMessage(DOCUMENT_ROLE.SUBAGENT, "Subagent input / parent-agent handoff", renderedText, attachments, item.timestamp, recordNumber);
        } else if (classification.kind === USER_RECORD_KIND.AUTOMATIC_RUNTIME_CONTEXT) {
          stats.runtimeContexts += 1;
          const suffix = classification.runtimeContextTypes.length ? ` – ${classification.runtimeContextTypes.join(" / ")}` : "";
          const label = `Automatic runtime context${suffix}`;
          if (out) {
            if (text.trim()) writeClassifiedContext(out, label, text, item.timestamp, redactMarkdown);
            writeAssetReferences(out, attachments, assetStore, markdownPath);
          }
          addDocumentMessage(DOCUMENT_ROLE.RUNTIME_CONTEXT, label, renderedText, attachments, item.timestamp, recordNumber);
        } else {
          stats.unclassifiedUserRoleRecords += 1;
          if (out) {
            if (text.trim()) writeClassifiedContext(out, "Unclassified user-role record", text, item.timestamp, redactMarkdown);
            writeAssetReferences(out, attachments, assetStore, markdownPath);
          }
          addDocumentMessage(DOCUMENT_ROLE.UNCLASSIFIED, "Unclassified user-role record", renderedText, attachments, item.timestamp, recordNumber);
        }
        continue;
      }
      if (payload.type === "message" && payload.role === "assistant") {
        const text = await readingMessageText(payload.content, recordNumber);
        const renderedText = redactMarkdown ? redactSecrets(text) : text;
        const attachments = selectedAttachments(item, recordNumber);
        if (!text.trim() && !attachments.length) continue;
        stats.assistantMessages += 1;
        if (out) {
          writeLine(out, `## Assistant${formatDerivedTimestampSuffix(item.timestamp)}`);
          writeLine(out, "");
          if (text.trim()) { writeLine(out, renderedText); writeLine(out, ""); }
          writeAssetReferences(out, attachments, assetStore, markdownPath);
        }
        addDocumentMessage(DOCUMENT_ROLE.ASSISTANT, "Assistant", renderedText, attachments, item.timestamp, recordNumber);
        continue;
      }
      if (["function_call", "custom_tool_call", "function_call_output", "custom_tool_call_output"].includes(payload.type)) {
        stats.toolEvents += 1;
        if (includeTools) {
          const toolText = payload.arguments || payload.input || payload.output || JSON.stringify(payload, null, 2);
          const renderedToolText = redactMarkdown ? redactSecrets(String(toolText)) : String(toolText);
          const attachments = selectedAttachments(item, recordNumber);
          const label = `Tool ${payload.type}${payload.name ? ` – ${payload.name}` : ""}`;
          const fence = markdownFence(renderedToolText);
          if (out) {
            writeLine(out, `## ${label}${formatDerivedTimestampSuffix(item.timestamp)}`);
            writeLine(out, "");
            writeLine(out, `${fence}text`);
            writeLine(out, renderedToolText);
            writeLine(out, fence);
            writeLine(out, "");
            writeAssetReferences(out, attachments, assetStore, markdownPath);
          }
          addDocumentMessage(DOCUMENT_ROLE.TOOL, label, `${fence}text\n${renderedToolText}\n${fence}`, attachments, item.timestamp, recordNumber);
        }
      }
    }

    if (additionalStoredContext.length) {
      if (out) {
        writeLine(out, "## Additional stored context");
        writeLine(out, "");
        writeLine(out, "> Attachments retained in session replacement history without a matching visible original occurrence.");
        writeLine(out, "");
        for (const entry of additionalStoredContext) writeAssetReferences(out, entry.attachments, assetStore, markdownPath);
      }
      for (let index = 0; index < additionalStoredContext.length; index += 1) {
        const entry = additionalStoredContext[index];
        addDocumentMessage(
          DOCUMENT_ROLE.UNCLASSIFIED,
          index === 0 ? "Additional stored context" : "Additional stored context (continued)",
          index === 0 ? "Attachments retained in session replacement history without a matching visible original occurrence." : "",
          entry.attachments,
          entry.timestamp,
          entry.recordNumber,
        );
      }
    }
  };

  if (markdownPath) {
    const writeStart = performance.now();
    await writeSeparatedOutputFile(markdownPath, sourceProtection, async (handle) => {
      const out = fs.createWriteStream(markdownPath, { fd: handle.fd, encoding: "utf8", autoClose: false });
      await processRecords(out);
      await new Promise((resolve, reject) => { out.end(resolve); out.on("error", reject); });
    }, generation);
    const writeMs = performance.now() - writeStart;
    const outputSize = (await fsp.stat(markdownPath)).size;
    profiler?.addPhase("markdown_writing", writeMs, 0, outputSize);
    profiler?.recordSession(profileSession, "markdown_write_ms", writeMs, 0, outputSize);
  } else {
    await processRecords(null);
  }

  if (!readerSummary.stable || readerSummary.fileSha256 !== assetSnapshot?.sha256) {
    const renderingLabel = markdownPath ? "Markdown rendering" : (docxPath ? "DOCX rendering" : "PDF rendering");
    throw new ExportError("SOURCE_CHANGED_DURING_EXPORT", `Session content changed between asset collection and ${renderingLabel}`);
  }
  const renderMs = performance.now() - renderStart;
  if (markdownPath) {
    profiler?.addPhase("markdown_rendering", renderMs, meta.fileSize || 0, 0);
    profiler?.recordSession(profileSession, "markdown_render_ms", renderMs, meta.fileSize || 0, 0);
  }

  if (docxPath) {
    const docxStart = performance.now();
    const header = createSessionDocumentHeader({
      ...meta,
      latestTimestamp: stats.updatedAt,
      model: stats.model,
      rawReference: rawRel ? rawRel.replaceAll("\\", "/") : "",
    });
    const resolveAsset = context.docxOptions.resolveAsset || ((attachment) => resolveVerifiedAsset(assetStore, context.outputDir, attachment));
    const buffer = await buildDeterministicDocx({ header, messages: documentMessages, resolveAsset, packer: context.docxOptions.packer });
    const writeBuffer = context.docxOptions.writeBuffer || ((handle, value) => handle.writeFile(value));
    await writeSeparatedOutputFile(docxPath, sourceProtection, (handle) => writeBuffer(handle, buffer), generation);
    const docxMs = performance.now() - docxStart;
    const outputSize = (await fsp.stat(docxPath)).size;
    profiler?.addPhase("docx_rendering", docxMs, meta.fileSize || 0, outputSize);
    profiler?.recordSession(profileSession, "docx_render_ms", docxMs, meta.fileSize || 0, outputSize);
  }
  if (pdfPath) {
    const pdfStart = performance.now();
    const header = createSessionDocumentHeader({
      ...meta,
      latestTimestamp: stats.updatedAt,
      model: stats.model,
      rawReference: rawRel ? rawRel.replaceAll("\\", "/") : "",
    });
    const resolveAsset = context.pdfOptions.resolveAsset || ((attachment) => resolveVerifiedPdfAsset(assetStore, context.outputDir, attachment));
    if (context.pdfOptions.writeBuffer) {
      const buffer = await buildDeterministicPdf({ header, messages: documentMessages, resolveAsset, fontRoot: context.pdfOptions.fontRoot });
      await writeSeparatedOutputFile(pdfPath, sourceProtection, (handle) => context.pdfOptions.writeBuffer(handle, buffer), generation);
    } else {
      await writeSeparatedOutputFile(pdfPath, sourceProtection, async (handle, temporaryPath) => {
        const outputStream = createFileHandleWritable(handle);
        await buildDeterministicPdf({ header, messages: documentMessages, resolveAsset, fontRoot: context.pdfOptions.fontRoot, outputStream });
        await handle.sync();
        await validateCanonicalPdfFile(temporaryPath);
      }, generation);
    }
    const pdfMs = performance.now() - pdfStart;
    const outputSize = (await fsp.stat(pdfPath)).size;
    profiler?.addPhase("pdf_rendering", pdfMs, meta.fileSize || 0, outputSize);
    profiler?.recordSession(profileSession, "pdf_render_ms", pdfMs, meta.fileSize || 0, outputSize);
  }
  return stats;
}

function writeClassifiedContext(stream, label, text, timestamp, redactMarkdown) {
  const rendered = redactMarkdown ? redactSecrets(text) : text;
  const fence = markdownFence(rendered);
  writeLine(stream, "<details>");
  writeLine(stream, `<summary>${label}${formatDerivedTimestampSuffix(timestamp)}</summary>`);
  writeLine(stream, "");
  writeLine(stream, `${fence}text`);
  writeLine(stream, rendered);
  writeLine(stream, fence);
  writeLine(stream, "");
  writeLine(stream, "</details>");
  writeLine(stream, "");
}

function extractText(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content.text || "";
  return content.map((part) => typeof part === "string" ? part : (part?.text || part?.input_text || part?.output_text || "")).filter(Boolean).join("\n\n");
}

function markdownFence(text) {
  const runs = String(text || "").match(/`+/g) || [];
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 0);
  return "`".repeat(Math.max(3, longest + 1));
}

const REDACTION_PATTERNS = [
  [/sk-(proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g, "sk-<REDACTED>"],
  [/AIza[0-9A-Za-z_-]{25,}/g, "AIza<REDACTED>"],
  [/gh[pousr]_[A-Za-z0-9_]{30,}/g, "gh<REDACTED>"],
  [/AKIA[0-9A-Z]{16}/g, "AKIA<REDACTED>"],
  [/xox[baprs]-[A-Za-z0-9-]{20,}/g, "xox<REDACTED>"],
  [/npm_[A-Za-z0-9]{30,}/g, "npm_<REDACTED>"],
  [/glpat-[A-Za-z0-9_-]{20,}/g, "glpat-<REDACTED>"],
  [/sk_(live|test)_[A-Za-z0-9]{16,}/g, "sk_$1_<REDACTED>"],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{20,}/gi, "Bearer <REDACTED>"],
  [/(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{48,}={0,2}(?![A-Za-z0-9+/])/g, (match) => /[+/=]/.test(match) ? "<POSSIBLE_BASE64_SECRET_REDACTED>" : match],
];

function redactSecrets(text) {
  let result = String(text);
  for (const [pattern, replacement] of REDACTION_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

async function writeIndexFiles(dir, rows, profiler = null, context, sourceProtection, generation, assetSummary, assetStore) {
  const { diagnosticReporter, exportFormats, exportProfile, copyRaw, codexHome, sessionsDir, includeArchived, archivedSessionsDir, sessionIndexPath, pathStyle, includeTools } = context;
  const generatedAt = generation?.generatedAt || new Date().toISOString();
  const indexRows = [...rows].sort((a, b) => (b.updated_at || b.started_at || "").localeCompare(a.updated_at || a.started_at || ""));
  const includeRawColumn = indexRows.some((row) => Boolean(row.raw_export_file));
  const includeDocxColumn = indexRows.some((row) => Boolean(row.docx_file));
  const includePdfColumn = indexRows.some((row) => Boolean(row.pdf_file));
  const indexStart = performance.now();
  diagnosticReporter("index_start", { rows: indexRows.length, html: Boolean(exportFormats.html), markdown: Boolean(exportFormats.markdown) });
  let indexBytes = 0;
  if (exportFormats.markdown) {
    const md = ["# Codex Project Chat Export Index", "", `Generated: ${generatedAt}`, ""];
    if (includeDocxColumn) {
      md.push(includeRawColumn ? "| Project | Title | Storage | Started | Markdown | DOCX | Raw |" : "| Project | Title | Storage | Started | Markdown | DOCX |", includeRawColumn ? "| --- | --- | --- | --- | --- | --- | --- |" : "| --- | --- | --- | --- | --- | --- |");
      for (const row of indexRows) md.push(includeRawColumn ? `| ${mdCell(row.project_name || row.project)} | ${mdCell(row.title || row.session_id)} | ${mdCell(row.storage)} | ${mdCell(formatDerivedTimestamp(row.started_at))} | ${mdLink(row.markdown_file)} | ${mdLink(row.docx_file)} | ${row.raw_export_file ? mdLink(row.raw_export_file) : ""} |` : `| ${mdCell(row.project_name || row.project)} | ${mdCell(row.title || row.session_id)} | ${mdCell(row.storage)} | ${mdCell(formatDerivedTimestamp(row.started_at))} | ${mdLink(row.markdown_file)} | ${mdLink(row.docx_file)} |`);
    } else if (includePdfColumn) {
      md.push(includeRawColumn ? "| Project | Title | Storage | Started | Markdown | PDF | Raw |" : "| Project | Title | Storage | Started | Markdown | PDF |", includeRawColumn ? "| --- | --- | --- | --- | --- | --- | --- |" : "| --- | --- | --- | --- | --- | --- |");
      for (const row of indexRows) md.push(includeRawColumn ? `| ${mdCell(row.project_name || row.project)} | ${mdCell(row.title || row.session_id)} | ${mdCell(row.storage)} | ${mdCell(formatDerivedTimestamp(row.started_at))} | ${mdLink(row.markdown_file)} | ${mdLink(row.pdf_file)} | ${row.raw_export_file ? mdLink(row.raw_export_file) : ""} |` : `| ${mdCell(row.project_name || row.project)} | ${mdCell(row.title || row.session_id)} | ${mdCell(row.storage)} | ${mdCell(formatDerivedTimestamp(row.started_at))} | ${mdLink(row.markdown_file)} | ${mdLink(row.pdf_file)} |`);
    } else {
      md.push(includeRawColumn ? "| Project | Title | Storage | Started | Markdown | Raw |" : "| Project | Title | Storage | Started | Markdown |", includeRawColumn ? "| --- | --- | --- | --- | --- | --- |" : "| --- | --- | --- | --- | --- |");
      for (const row of indexRows) md.push(includeRawColumn ? `| ${mdCell(row.project_name || row.project)} | ${mdCell(row.title || row.session_id)} | ${mdCell(row.storage)} | ${mdCell(formatDerivedTimestamp(row.started_at))} | ${mdLink(row.markdown_file)} | ${row.raw_export_file ? mdLink(row.raw_export_file) : ""} |` : `| ${mdCell(row.project_name || row.project)} | ${mdCell(row.title || row.session_id)} | ${mdCell(row.storage)} | ${mdCell(formatDerivedTimestamp(row.started_at))} | ${mdLink(row.markdown_file)} |`);
    }
    md.push("");
    const markdownIndex = `${md.join("\n")}\n`;
    await writeSeparatedOutputFile(path.join(dir, "index.md"), sourceProtection, (handle) => handle.writeFile(markdownIndex, "utf8"), generation);
    indexBytes += Buffer.byteLength(markdownIndex);
  }
  if (exportFormats.html) {
    const htmlIndex = renderHtmlIndex(indexRows, generatedAt, { assetStore, reducedMetadata: exportProfile === EXPORT_PROFILE.SOURCE_SNAPSHOTS && !exportFormats.docx && !exportFormats.pdf });
    await writeSeparatedOutputFile(path.join(dir, "index.html"), sourceProtection, (handle) => handle.writeFile(htmlIndex, "utf8"), generation);
    indexBytes += Buffer.byteLength(htmlIndex);
  }
  profiler?.addPhase("indexes", performance.now() - indexStart, 0, indexBytes);
  diagnosticReporter("index_end", { duration_ms: roundMs(performance.now() - indexStart), bytes_written: indexBytes });
  const manifest = `${JSON.stringify({ archive_format_version: ARCHIVE_FORMAT_VERSION, canonical_representation: "raw_jsonl", canonical_representation_included: copyRaw, export_profile: exportProfile, formats: exportFormats, include_tools: Boolean(includeTools), generated_at: generatedAt, codex_home: codexHome, sessions_dir: sessionsDir, archived_sessions_dir: includeArchived ? archivedSessionsDir : "", session_index: sessionIndexPath, path_style: pathStyle, assets_manifest: ASSET_MANIFEST_PATH, asset_occurrences: assetSummary.assetOccurrences, unique_assets: assetSummary.uniqueAssets, unique_asset_bytes: assetSummary.uniqueAssetBytes, deduplicated_asset_bytes_saved: assetSummary.deduplicatedBytesSaved, sessions: rows }, null, 2)}\n`;
  return manifest;
}

function createAttachmentMetrics() {
  const metrics = {
    embeddedCount: 0,
    embeddedBytes: 0,
    dataUrlCount: 0,
    dataUrlBytes: 0,
    unprefixedEmbeddedCount: 0,
    unprefixedEmbeddedBytes: 0,
    localReferenceCount: 0,
    remoteReferenceCount: 0,
    unknownCount: 0,
    referencedCount: 0,
    referencedKnownBytes: 0,
    referencedUnknownSizeCount: 0,
    embeddedHashes: new Set(),
    embeddedSequenceSha256: "",
    maxDecodedBlockBytes: 0,
  };
  attachmentSequenceHashes.set(metrics, createHash("sha256"));
  return metrics;
}

function collectAttachmentDescriptorsInOrder(value, output = []) {
  if (isAttachmentDescriptor(value)) {
    output.push(value);
    return output;
  }
  if (Array.isArray(value)) {
    for (const child of value) collectAttachmentDescriptorsInOrder(child, output);
  } else if (value && typeof value === "object") {
    for (const child of Object.values(value)) collectAttachmentDescriptorsInOrder(child, output);
  }
  return output;
}

function writeAssetReferences(stream, descriptors, assetStore, outputPath) {
  let ordinal = 0;
  for (const descriptor of descriptors) {
    ordinal += 1;
    const asset = assetStore?.assetForDescriptor(descriptor);
    if (!asset) throw new ExportError("ASSET_REFERENCE_MISSING", "A rendered attachment has no published local asset");
    const absoluteAsset = path.join(assetStore.exportRoot, ...asset.path.split("/"));
    const relativeAsset = toPosixPath(path.relative(path.dirname(outputPath), absoluteAsset));
    const target = encodeURI(relativeAsset);
    writeLine(stream, asset.renderable ? `![Attachment ${ordinal}](${target})` : `[Attachment ${ordinal} (file)](${target})`);
    writeLine(stream, "");
  }
}

function observeAttachmentMetrics(item, metrics) {
  const seen = new Set();
  visit(item, false);

  function visit(value, attachmentContext) {
    if (value === null || value === undefined) return;
    if (isAttachmentDescriptor(value)) {
      if (attachmentContext) recordAttachmentValue(value, null, metrics);
      return;
    }
    if (typeof value === "string") {
      if (attachmentContext) recordAttachmentValue(value, null, metrics);
      return;
    }
    if (typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, attachmentContext);
      return;
    }

    const type = String(value.type || "").toLowerCase();
    const attachmentLike = ["attachment", "file", "image", "image_url", "input_file", "input_image", "local_image"].includes(type);
    if (attachmentLike) {
      const candidate = value.image_url?.url || value.image_url || value.url || value.file_path || value.image_path || value.path || value.data || "";
      const knownBytes = firstFiniteNumber(value.size_bytes, value.sizeBytes, value.byte_length, value.byteLength, value.size);
      recordAttachmentValue(candidate, knownBytes, metrics);
    }

    for (const [key, child] of Object.entries(value)) {
      const childContext = ["attachments", "files", "images"].includes(key.toLowerCase());
      visit(child, childContext);
    }
  }
}

function recordAttachmentValue(value, knownBytes, metrics) {
  if (isAttachmentDescriptor(value)) {
    metrics.embeddedCount += 1;
    metrics.embeddedBytes += value.decodedBytes;
    metrics.embeddedHashes.add(value.sha256);
    attachmentSequenceHashes.get(metrics)?.update(value.sha256, "ascii");
    metrics.maxDecodedBlockBytes = Math.max(metrics.maxDecodedBlockBytes, value.maxDecodedBlockBytes || 0);
    if (value.sourceKind === "data_url") {
      metrics.dataUrlCount += 1;
      metrics.dataUrlBytes += value.decodedBytes;
    } else {
      metrics.unprefixedEmbeddedCount += 1;
      metrics.unprefixedEmbeddedBytes += value.decodedBytes;
    }
    return;
  }
  const text = typeof value === "string" ? value : "";
  if (text.startsWith("data:") && text.includes(",")) {
    const payloadStart = text.indexOf(",") + 1;
    const encoded = text.slice(0, payloadStart).toLowerCase().includes(";base64,");
    metrics.embeddedCount += 1;
    const byteLength = encoded ? estimateBase64Bytes(text, payloadStart) : estimatePercentEncodedBytes(text.slice(payloadStart));
    metrics.embeddedBytes += byteLength;
    metrics.dataUrlCount += 1;
    metrics.dataUrlBytes += byteLength;
    return;
  }
  const unprefixed = inspectUnprefixedEmbeddedImage(text);
  if (unprefixed) {
    metrics.embeddedCount += 1;
    metrics.embeddedBytes += unprefixed.bytes;
    metrics.unprefixedEmbeddedCount += 1;
    metrics.unprefixedEmbeddedBytes += unprefixed.bytes;
    return;
  }
  const referenceKind = classifyAttachmentReference(text);
  if (referenceKind === "local") metrics.localReferenceCount += 1;
  else if (referenceKind === "remote") metrics.remoteReferenceCount += 1;
  else metrics.unknownCount += 1;
  if (referenceKind !== "unknown") {
    metrics.referencedCount += 1;
    if (Number.isFinite(knownBytes) && knownBytes >= 0) metrics.referencedKnownBytes += knownBytes;
    else metrics.referencedUnknownSizeCount += 1;
  }
}

function finishAttachmentMetrics(metrics) {
  const hash = attachmentSequenceHashes.get(metrics);
  if (!hash) return;
  metrics.embeddedSequenceSha256 = hash.digest("hex");
  attachmentSequenceHashes.delete(metrics);
}

function classifyAttachmentReference(value) {
  const text = String(value || "").trim();
  if (!text) return "unknown";
  if (path.win32.isAbsolute(text) || path.posix.isAbsolute(text) || text.toLowerCase().startsWith("file:")) return "local";
  try {
    const url = new URL(text);
    if (url.protocol === "http:" || url.protocol === "https:") return "remote";
  } catch {}
  return "unknown";
}

function inspectUnprefixedEmbeddedImage(value) {
  const text = String(value || "");
  if (text.length < 12) return null;
  let encodedLength = 0;
  let padding = 0;
  let sawPadding = false;
  let prefix = "";
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === " " || character === "\t" || character === "\r" || character === "\n") continue;
    if (character === "=") {
      sawPadding = true;
      padding += 1;
      if (padding > 2) return null;
    } else {
      const code = character.charCodeAt(0);
      const alphabetic = (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
      const numeric = code >= 48 && code <= 57;
      if (!alphabetic && !numeric && character !== "+" && character !== "/") return null;
      if (sawPadding) return null;
    }
    encodedLength += 1;
    if (prefix.length < 24) prefix += character;
  }
  if (!encodedLength || encodedLength % 4 === 1 || (padding > 0 && encodedLength % 4 !== 0)) return null;
  let signature;
  try { signature = Buffer.from(prefix, "base64"); } catch { return null; }
  const png = signature.length >= 8 && signature[0] === 0x89 && signature[1] === 0x50 && signature[2] === 0x4e && signature[3] === 0x47 && signature[4] === 0x0d && signature[5] === 0x0a && signature[6] === 0x1a && signature[7] === 0x0a;
  const jpeg = signature.length >= 3 && signature[0] === 0xff && signature[1] === 0xd8 && signature[2] === 0xff;
  if (!png && !jpeg) return null;
  return { bytes: Math.max(0, Math.floor((encodedLength * 3) / 4) - padding), mediaType: png ? "image/png" : "image/jpeg" };
}

function estimateBase64Bytes(value, start = 0) {
  const text = String(value || "");
  let encodedLength = 0;
  for (let index = start; index < text.length; index += 1) {
    if (![" ", "\t", "\r", "\n"].includes(text[index])) encodedLength += 1;
  }
  if (!encodedLength) return 0;
  let padding = 0;
  for (let index = text.length - 1; index >= start && padding < 2; index -= 1) {
    if ([" ", "\t", "\r", "\n"].includes(text[index])) continue;
    if (text[index] === "=") padding += 1;
    else break;
  }
  return Math.max(0, Math.floor((encodedLength * 3) / 4) - padding);
}

function estimatePercentEncodedBytes(value) {
  try {
    return Buffer.byteLength(decodeURIComponent(String(value || "")));
  } catch {
    return Buffer.byteLength(String(value || ""));
  }
}

function firstFiniteNumber(...values) {
  return values.find((value) => Number.isFinite(value));
}

function createPerformanceProfiler({ rawEnabled, scope, profile }) {
  const phaseNames = [
    "session_discovery_and_metadata",
    "routing",
    "parse_and_classify",
    "raw_snapshot_copy",
    "snapshot_stability_checks",
    "assets",
    "source_hashing",
    "export_hashing",
    "markdown_rendering",
    "markdown_writing",
    "indexes",
    "manifest",
    "other",
  ];
  const startedAt = performance.now();
  const phases = Object.fromEntries(phaseNames.map((name) => [name, { durationMs: 0, bytesRead: 0, bytesWritten: 0 }]));
  const sessions = new Map();
  const attachments = createAttachmentMetrics();
  const counts = { scannedSessions: 0, exportedSessions: 0 };
  const memorySamples = [];
  let snapshotRetries = 0;
  sampleMemory();

  function addPhase(name, durationMs = 0, bytesRead = 0, bytesWritten = 0) {
    const phase = phases[name] || phases.other;
    phase.durationMs += Math.max(0, durationMs || 0);
    phase.bytesRead += Math.max(0, bytesRead || 0);
    phase.bytesWritten += Math.max(0, bytesWritten || 0);
    sampleMemory();
  }

  function recordSession(meta, phaseName, durationMs, bytesRead = 0, bytesWritten = 0) {
    const key = meta?.sourceOriginalPath || meta?.file || meta?.id || `unknown-${sessions.size}`;
    if (!sessions.has(key)) {
      const rawId = String(meta?.id || meta?.session_id || "");
      const shortId = rawId ? shortenSessionId(rawId) : `file-${createHash("sha256").update(String(key)).digest("hex").slice(0, 8)}`;
      sessions.set(key, { shortId, sizeBytes: Math.max(0, meta?.fileSize || 0), phases: {} });
    }
    const session = sessions.get(key);
    session.sizeBytes = Math.max(session.sizeBytes, meta?.fileSize || 0);
    session.phases[phaseName] = roundMs((session.phases[phaseName] || 0) + Math.max(0, durationMs || 0));
    session.bytesRead = (session.bytesRead || 0) + Math.max(0, bytesRead || 0);
    session.bytesWritten = (session.bytesWritten || 0) + Math.max(0, bytesWritten || 0);
  }

  function recordAttachments(value) {
    if (!value) return;
    attachments.embeddedCount += value.embeddedCount || 0;
    attachments.embeddedBytes += value.embeddedBytes || 0;
    attachments.referencedCount += value.referencedCount || 0;
    attachments.referencedKnownBytes += value.referencedKnownBytes || 0;
    attachments.referencedUnknownSizeCount += value.referencedUnknownSizeCount || 0;
    attachments.dataUrlCount += value.dataUrlCount || 0;
    attachments.dataUrlBytes += value.dataUrlBytes || 0;
    attachments.unprefixedEmbeddedCount += value.unprefixedEmbeddedCount || 0;
    attachments.unprefixedEmbeddedBytes += value.unprefixedEmbeddedBytes || 0;
    attachments.localReferenceCount += value.localReferenceCount || 0;
    attachments.remoteReferenceCount += value.remoteReferenceCount || 0;
    attachments.unknownCount += value.unknownCount || 0;
  }

  function sampleMemory() {
    memorySamples.push(process.memoryUsage().rss);
  }

  function finish({ status, errorCode }) {
    sampleMemory();
    const totalDurationMs = performance.now() - startedAt;
    const measuredWithoutOther = phaseNames.filter((name) => name !== "other").reduce((sum, name) => sum + phases[name].durationMs, 0);
    phases.other.durationMs += Math.max(0, totalDurationMs - measuredWithoutOther - phases.other.durationMs);
    const slowestSessions = [...sessions.values()].map((session) => ({
      short_id: session.shortId,
      size_bytes: session.sizeBytes,
      total_phase_ms: roundMs(Object.values(session.phases).reduce((sum, value) => sum + value, 0)),
      phase_ms: session.phases,
      snapshot_attempts: session.snapshotAttempts || 0,
      bytes_read: session.bytesRead || 0,
      bytes_written: session.bytesWritten || 0,
    })).sort((left, right) => right.total_phase_ms - left.total_phase_ms).slice(0, 10);
    const roundedPhases = Object.fromEntries(phaseNames.map((name) => [name, {
      duration_ms: roundMs(phases[name].durationMs),
      bytes_read: phases[name].bytesRead,
      bytes_written: phases[name].bytesWritten,
    }]));
    return {
      performance_profile_version: 1,
      privacy: "No message text, full source paths, output paths, or attachment payloads are included.",
      measurement_notes: [
        "Memory values are sampled RSS, not continuous process maxima.",
        "Markdown rendering covers streaming parse, classification lookup, transformation, and write enqueue time; Markdown writing covers final stream completion wait.",
        "Attachment counts are structured event occurrences; repeated payloads or references are not deduplicated without stable attachment identity.",
        "Unprefixed embedded images are recognized only when valid Base64 has a PNG or JPEG byte signature.",
        "Referenced attachment bytes include only explicit structured size metadata; unknown forms and unknown-size references are counted separately.",
      ],
      status,
      error_code: errorCode,
      node_version: process.version,
      platform: process.platform,
      scope,
      export_profile: profile,
      raw_enabled: rawEnabled,
      total_duration_ms: roundMs(totalDurationMs),
      counts: { scanned_sessions: counts.scannedSessions, exported_sessions: counts.exportedSessions },
      phases: roundedPhases,
      io_totals: {
        bytes_read: Object.values(phases).reduce((sum, phase) => sum + phase.bytesRead, 0),
        bytes_written: Object.values(phases).reduce((sum, phase) => sum + phase.bytesWritten, 0),
      },
      attachments: {
        embedded_count: attachments.embeddedCount,
        embedded_bytes: attachments.embeddedBytes,
        data_url_count: attachments.dataUrlCount,
        data_url_bytes: attachments.dataUrlBytes,
        unprefixed_embedded_count: attachments.unprefixedEmbeddedCount,
        unprefixed_embedded_bytes: attachments.unprefixedEmbeddedBytes,
        local_reference_count: attachments.localReferenceCount,
        remote_reference_count: attachments.remoteReferenceCount,
        unknown_count: attachments.unknownCount,
        referenced_count: attachments.referencedCount,
        referenced_known_bytes: attachments.referencedKnownBytes,
        referenced_unknown_size_count: attachments.referencedUnknownSizeCount,
      },
      snapshot_retries: snapshotRetries,
      memory: {
        sample_count: memorySamples.length,
        average_rss_bytes: Math.round(memorySamples.reduce((sum, value) => sum + value, 0) / memorySamples.length),
        peak_sampled_rss_bytes: Math.max(...memorySamples),
      },
      slowest_sessions: slowestSessions,
    };
  }

  return {
    addPhase,
    finish,
    recordAttachments,
    recordSession,
    recordSnapshotAttempt(meta) {
      recordSession(meta, "snapshot_stability_check_ms", 0);
      const key = meta?.sourceOriginalPath || meta?.file || meta?.id || `unknown-${sessions.size}`;
      sessions.get(key).snapshotAttempts = (sessions.get(key).snapshotAttempts || 0) + 1;
    },
    recordSnapshotRetryCount(count) { snapshotRetries += Math.max(0, count || 0); },
    setCounts(next) { Object.assign(counts, next); },
  };
}

function shortenSessionId(value) {
  const text = String(value || "");
  return text.length <= 13 ? text : `${text.slice(0, 8)}…${text.slice(-4)}`;
}

function roundMs(value) {
  return Math.round(Number(value || 0) * 1000) / 1000;
}

async function writeSummary(dir, rows, context, sourceProtection, generation, assetSummary) {
  const { codexHome, sessionsDir, includeArchived, archivedSessionsDir, exportProfile, pathStyle, exportFormats, markdownDirName, copyRaw } = context;
  const projects = new Map();
  for (const row of rows) projects.set(row.project || "unknown", (projects.get(row.project || "unknown") || 0) + 1);
  const activeCount = rows.filter((row) => row.storage === "active").length;
  const archivedCount = rows.filter((row) => row.storage === "archived").length;
  const lines = ["Codex Project Chat Export", "=========================", "", `Generated: ${generation?.generatedAt || new Date().toISOString()}`, `Codex home: ${codexHome}`, `Sessions dir: ${sessionsDir}`, `Archived sessions dir: ${includeArchived ? archivedSessionsDir : "disabled"}`, `Export profile: ${exportProfile}`, `Path style: ${pathStyle}`, `Sessions exported: ${rows.length}`, `Active sessions: ${activeCount}`, `Archived sessions: ${archivedCount}`, `Attachment occurrences: ${assetSummary.assetOccurrences}`, `Unique assets: ${assetSummary.uniqueAssets}`, `Unique asset bytes: ${assetSummary.uniqueAssetBytes}`, `Deduplicated asset bytes saved: ${assetSummary.deduplicatedBytesSaved}`, "", "Projects:", ...Array.from(projects.entries()).map(([project, count]) => `- ${project}: ${count}`), "", "Notes:"];
  if (exportFormats.markdown) lines.push(`- ${markdownDirName}/ contains classified, derived reading views.`);
  else if (!exportFormats.docx && !exportFormats.pdf) lines.push("- This profile intentionally does not create human-readable session transcripts; attachment provenance still follows the shared streamed reading selection.");
  if (exportFormats.docx) lines.push("- docx/ contains one deterministic, classified DOCX reading view per exported session.");
  if (exportFormats.pdf) lines.push("- pdf/ contains one deterministic, classified PDF reading view per exported session.");
  if (copyRaw) lines.push("- raw/ contains canonical byte-preserving session JSONL snapshots.");
  else lines.push("- This profile does not include canonical raw JSONL snapshots.");
  lines.push("- assets/ contains content-addressed decoded attachments selected for reading views; assets/manifest.json records validated types, provenance, visibility, and verified mirrors.");
  lines.push("- Raw export file names may be collision-safe archive names; manifest.json preserves the original name and portable restore path.", "- raw_copy_status=VERIFIED_AT_EXPORT means the export-time hash check completed at raw_verified_at and the bytes read from the published Raw path matched raw_sha256 during that check; Raw files remain mutable afterward.", "- A future importer must hash the current Raw file again and reject any mismatch; no Codex import path is implemented or validated.", "- Event order is the physical line order inside each canonical raw JSONL file; the manifest does not duplicate that sequence.");
  if (exportFormats.html && exportProfile === EXPORT_PROFILE.SOURCE_SNAPSHOTS) lines.push("- index.html uses only project, storage, start time, session ID, and Raw links because this profile intentionally skips complete readable metadata.");
  else if (exportFormats.html) lines.push("- index.html can be filtered by project, title, date, model, or storage location.");
  lines.push("- Absolute source paths are local metadata and must be omitted from any share-safe derivative.");
  await writeSeparatedOutputFile(path.join(dir, "README.txt"), sourceProtection, (handle) => handle.writeFile(`${lines.join("\n")}\n`, "utf8"), generation);
}

async function verifyExport(dir, rows, profiler = null, context, options = {}) {
  const { exportFormats } = context;
  const required = ["README.txt", ASSET_MANIFEST_PATH];
  if (options.includeManifest) required.push("manifest.json");
  if (exportFormats.html) required.push("index.html");
  if (exportFormats.markdown) required.push("index.md");
  for (const name of required) {
    const file = path.join(dir, name);
    const stat = await fsp.stat(file).catch(() => null);
    if (!stat?.isFile() || stat.size === 0) throw new ExportError("EXPORT_VERIFICATION_FAILED", `Missing or empty output file: ${file}`);
  }
  for (const row of rows) {
    for (const rel of [row.markdown_file, row.docx_file, row.pdf_file, row.raw_export_file].filter(Boolean)) {
      const file = path.join(dir, rel);
      const stat = await fsp.stat(file).catch(() => null);
      if (!stat?.isFile() || stat.size === 0) throw new ExportError("EXPORT_VERIFICATION_FAILED", `Missing or empty session export: ${file}`);
    }
    if (row.docx_file) {
      const docxPath = path.join(dir, row.docx_file);
      const bytes = await fsp.readFile(docxPath);
      await validateCanonicalDocx(bytes);
    }
    if (row.pdf_file) {
      const pdfPath = path.join(dir, row.pdf_file);
      await validateCanonicalPdfFile(pdfPath);
    }
    if (row.raw_export_file) {
      if (row.raw_copy_status !== RAW_COPY_STATUS.VERIFIED_AT_EXPORT || !isCanonicalIsoTimestamp(row.raw_verified_at) || row.snapshot_status !== "STABLE" || !row.raw_sha256) throw new ExportError("EXPORT_VERIFICATION_FAILED", `Raw snapshot verification metadata is incomplete: ${row.raw_export_file}`);
      const rawPath = path.join(dir, row.raw_export_file);
      const rawStat = await fsp.stat(rawPath);
      if (rawStat.size !== row.raw_size_bytes) throw new ExportError("EXPORT_VERIFICATION_FAILED", `Raw snapshot size mismatch: ${row.raw_export_file}`);
      if (!row.source_root || !row.source_relative_path || path.isAbsolute(row.source_relative_path) || row.source_relative_path.split("/").includes("..")) throw new ExportError("EXPORT_VERIFICATION_FAILED", `Portable restore metadata is invalid: ${row.raw_export_file}`);
      if (!row.source_original_filename || path.basename(row.source_relative_path) !== row.source_original_filename) throw new ExportError("EXPORT_VERIFICATION_FAILED", `Original source filename metadata is invalid: ${row.raw_export_file}`);
      if (row.source_snapshot_before_size_bytes !== row.source_snapshot_after_size_bytes || row.source_snapshot_before_mtime_ms !== row.source_snapshot_after_mtime_ms) throw new ExportError("EXPORT_VERIFICATION_FAILED", `Source changed while its raw snapshot was copied: ${row.raw_export_file}`);
    }
  }
  const publishedAssetManifest = await fsp.readFile(path.join(dir, ...ASSET_MANIFEST_PATH.split("/")), "utf8");
  if (!options.assetManifest || publishedAssetManifest !== options.assetManifest) throw new ExportError("EXPORT_VERIFICATION_FAILED", "Published asset manifest bytes differ from the verified in-memory generation");
  await options.assetStore?.verifyPublishedAssets();
  if (options.includeManifest) {
    const publishedManifest = await fsp.readFile(path.join(dir, "manifest.json"), "utf8");
    if (!options.expectedManifest || publishedManifest !== options.expectedManifest) throw new ExportError("EXPORT_VERIFICATION_FAILED", "Published manifest bytes differ from the verified in-memory generation");
  }
}

function printHelp() {
  console.log(`Codex Project Chat Exporter ${VERSION}

Usage:
  node ./bin/export-codex-project-chats.mjs --list
  node ./bin/export-codex-project-chats.mjs --list-sessions
  node ./bin/export-codex-project-chats.mjs --diagnose
  node ./bin/export-codex-project-chats.mjs --project my-project
  node ./bin/export-codex-project-chats.mjs --all

Options:
  --project <name-or-path>    Export sessions matching a project/work folder name or path.
  --recorded-project <cwd>    Export only sessions with this exact recorded cwd (no aliases).
  --all                       Export all detected local Codex sessions, including project/work chats found on disk.
  --list                      List unique project/work folders and active/archived counts.
  --list-sessions             List every detected session with storage, title, project, date, and ID.
  --diagnose                  Show scan paths, file counts, incomplete metadata, and parser warnings.
  --out <dir>                 Write the export to a specific directory.
  --codex-home <dir>          Use a custom Codex home directory. Defaults to CODEX_HOME or ~/.codex.
  --sessions-dir <dir>        Use a custom active sessions directory instead of <codex-home>/sessions.
  --archived-dir <dir>        Use a custom archived sessions directory instead of <codex-home>/archived_sessions.
  --no-archived               Do not scan the archived sessions directory.
  --session-index <file>      Use a custom session_index.jsonl file.
  --include-tools             Include tool call input/output in Markdown.
  --profile <name>            Use complete, readable, or source-snapshots. Explicit profile wins over --no-raw.
  --format <docx|pdf>         Add one deterministic document reading view per exported session.
  --no-raw                    Legacy shorthand for the readable profile when --profile is omitted.
  --no-redact-markdown        Disable redaction in Markdown and derived display titles.
  --readable-paths            Use longer human-readable export file names.
  --performance-profile <file> Write a message-free, path-redacted local JSON performance profile.
  --allow-output-in-tool-dir  Allow exporting into this tool/repository folder.
  --help, -h                  Show this help.
  --version, -v               Show the version.

By default, exports use short paths such as md/p001-project/s0001.md and
raw/p001-project/s0001.jsonl to make copied or unzipped archives safer on Windows.\n\nIf node is not found, use export-codex-project-chats.cmd or install Node.js 22+.`);
}

function printProjectList(metas, context) {
  const { sessionsDir, includeArchived, archivedSessionsDir } = context;
  const projects = new Map();
  for (const meta of metas) {
    const key = meta.cwd || "(unknown)";
    const current = projects.get(key) || { active: 0, archived: 0 };
    current[meta.storage === "archived" ? "archived" : "active"] += 1;
    projects.set(key, current);
  }
  console.log(`Active sessions directory: ${sessionsDir}`);
  console.log(`Archived sessions directory: ${includeArchived ? archivedSessionsDir : "disabled"}`);
  console.log(`Detected sessions after duplicate-ID handling: ${metas.length}`);
  console.log("");
  console.log("Detected project/work folders from local session files:");
  for (const [project, counts] of Array.from(projects.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
    const total = counts.active + counts.archived;
    console.log(`- ${project} (${total}: ${counts.active} active, ${counts.archived} archived)`);
  }
}

function printSessionList(metas, context) {
  const { sessionsDir, includeArchived, archivedSessionsDir } = context;
  console.log(`Active sessions directory: ${sessionsDir}`);
  console.log(`Archived sessions directory: ${includeArchived ? archivedSessionsDir : "disabled"}`);
  console.log(`Detected sessions after duplicate-ID handling: ${metas.length}`);
  console.log("");
  console.log("Detected sessions from local session files:");
  const rows = [...metas].sort((a, b) => {
    const projectCompare = String(a.cwd || "").localeCompare(String(b.cwd || ""));
    if (projectCompare !== 0) return projectCompare;
    return String(b.timestamp || "").localeCompare(String(a.timestamp || ""));
  });
  for (const meta of rows) {
    const storage = meta.storage || "active";
    const title = meta.title || "(untitled)";
    const project = meta.cwd || "(unknown project)";
    const started = meta.timestamp || "unknown date";
    const id = meta.id || path.basename(meta.file || "", ".jsonl") || "unknown id";
    console.log(`- [${storage}] ${title} | ${project} | ${started} | ${id} | ${path.basename(meta.file || "")}`);
  }
  console.log("");
  console.log("Note: duplicate copies with the same session ID are shown once; an active copy takes precedence over an archived copy.");
}

function printDiagnostics(parsedEntries, metas, locations, context) {
  const { codexHome, sessionIndexPath, sessionsDir, archivedSessionsDir, includeArchived } = context;
  const byStorage = new Map();
  for (const location of locations) byStorage.set(location.storage, { root: location.root, files: 0, retained: 0 });
  for (const entry of parsedEntries) {
    const current = byStorage.get(entry.storage) || { root: "", files: 0, retained: 0 };
    current.files += 1;
    byStorage.set(entry.storage, current);
  }
  for (const meta of metas) {
    const current = byStorage.get(meta.storage) || { root: "", files: 0, retained: 0 };
    current.retained += 1;
    byStorage.set(meta.storage, current);
  }

  console.log(`Codex home: ${codexHome}`);
  console.log(`Session index: ${sessionIndexPath} (${fs.existsSync(sessionIndexPath) ? "found" : "missing"})`);
  console.log("");
  for (const storage of ["active", "archived"]) {
    const info = byStorage.get(storage);
    const configuredRoot = storage === "active" ? sessionsDir : archivedSessionsDir;
    const enabled = storage === "active" || includeArchived;
    console.log(`${storage === "active" ? "Active" : "Archived"} directory: ${enabled ? configuredRoot : "disabled"}`);
    console.log(`  Directory exists: ${enabled && fs.existsSync(configuredRoot) ? "yes" : "no"}`);
    console.log(`  JSONL files found: ${info?.files || 0}`);
    console.log(`  Sessions retained after duplicate-ID handling: ${info?.retained || 0}`);
  }
  console.log("");
  console.log(`Total JSONL files scanned: ${parsedEntries.length}`);
  console.log(`Unique sessions retained: ${metas.length}`);

  const warnings = parsedEntries.filter((entry) => !entry.hasSessionMeta || !entry.id || !entry.cwd || !entry.title || entry.invalidJsonLines || entry.metadataIdMismatch);
  console.log(`Files needing attention: ${warnings.length}`);
  if (!warnings.length) {
    console.log("No incomplete or contradictory session metadata was detected.");
    return;
  }

  console.log("");
  console.log("Files needing attention:");
  for (const entry of warnings) {
    const problems = [];
    if (!entry.hasSessionMeta) problems.push("no session_meta record found");
    if (!entry.id) problems.push("no session ID");
    if (!entry.cwd) problems.push("no stored cwd/project");
    if (!entry.title) problems.push("no title or first user message");
    if (entry.invalidJsonLines) problems.push(`${entry.invalidJsonLines} invalid JSON line(s)`);
    if (entry.metadataIdMismatch) problems.push(`filename ID differs from session_meta ID ${entry.metadataId || ""}`.trim());
    console.log(`- [${entry.storage}] ${path.basename(entry.file)}`);
    console.log(`  ${problems.join("; ")}`);
    console.log(`  ID used: ${entry.id || "(none)"}${entry.idSource ? ` (${entry.idSource})` : ""}`);
    console.log(`  Project: ${entry.cwd || "(unknown)"}`);
    console.log(`  File: ${entry.file}`);
  }
  console.log("");
  console.log("A file can still be listed and exported when its ID is recoverable from the filename, even if session_meta is missing.");
}

function writeLine(stream, text) { stream.write(`${text}\n`); }
const DERIVED_ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
function formatDerivedTimestamp(value) {
  if (!value) return "";
  const timestamp = String(value);
  return DERIVED_ISO_TIMESTAMP_PATTERN.test(timestamp) && Number.isFinite(Date.parse(timestamp)) ? timestamp : "invalid timestamp";
}
function formatDerivedTimestampSuffix(value) {
  const timestamp = formatDerivedTimestamp(value);
  return timestamp ? ` – ${timestamp}` : "";
}
function mdCell(value) {
  return String(value ?? "")
    .replaceAll("\\", "\\\\")
    .replaceAll("|", "\\|")
    .replaceAll("\r\n", " ")
    .replaceAll("\r", " ")
    .replaceAll("\n", " ");
}
function mdLink(relPath) { const link = toPosixPath(relPath); return `[${mdCell(path.posix.basename(link))}](${encodeURI(link)})`; }
function toPosixPath(value) { return String(value || "").replace(/\\/g, "/"); }
function htmlEscape(value) { return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function htmlLink(relPath, label) { const link = toPosixPath(relPath); return link ? `<a href="${htmlEscape(encodeURI(link))}">${htmlEscape(label || path.posix.basename(link))}</a>` : ""; }
function renderHtmlAssetReferences(references) {
  if (!references.length) return "";
  const render = (items, offset = 0) => `<div class="assets">${items.map((reference, index) => {
    const target = htmlEscape(encodeURI(toPosixPath(reference.path)));
    const label = `Attachment ${offset + index + 1}`;
    return reference.renderable
      ? `<a href="${target}"><img src="${target}" alt="${label}" loading="lazy"></a>`
      : `<a href="${target}">${label} (file)</a>`;
  }).join("")}</div>`;
  const ordinary = references.filter(reference => reference.reading_disposition !== "ADDITIONAL_STORED_CONTEXT");
  const additional = references.filter(reference => reference.reading_disposition === "ADDITIONAL_STORED_CONTEXT");
  return `${ordinary.length ? render(ordinary) : ""}${additional.length ? `<details class="additional-context"><summary>Additional stored context</summary>${render(additional, ordinary.length)}</details>` : ""}`;
}
function renderHtmlIndex(rows, generatedAt, options = {}) {
  const reducedMetadata = Boolean(options.reducedMetadata);
  const assetStore = options.assetStore;
  const includeRawColumn = rows.some((row) => Boolean(row.raw_export_file));
  const includeMarkdownColumn = rows.some((row) => Boolean(row.markdown_file));
  const includeDocxColumn = rows.some((row) => Boolean(row.docx_file));
  const includePdfColumn = rows.some((row) => Boolean(row.pdf_file));
  const bodyRows = rows.map((row) => {
    const startedAt = formatDerivedTimestamp(row.started_at);
    const updatedAt = formatDerivedTimestamp(row.updated_at);
    const searchable = reducedMetadata
      ? [row.project_name || row.project, row.storage, startedAt, row.session_id].join(" ").toLowerCase()
      : [row.project_name || row.project, row.title || row.session_id, row.storage, startedAt, updatedAt, row.model].join(" ").toLowerCase();
    const rawCell = includeRawColumn ? `<td>${row.raw_export_file ? htmlLink(row.raw_export_file, path.posix.basename(toPosixPath(row.raw_export_file))) : ""}</td>` : "";
    const markdownCell = includeMarkdownColumn ? `<td>${row.markdown_file ? htmlLink(row.markdown_file, path.posix.basename(toPosixPath(row.markdown_file))) : ""}</td>` : "";
    const docxCell = includeDocxColumn ? `<td>${row.docx_file ? htmlLink(row.docx_file, path.posix.basename(toPosixPath(row.docx_file))) : ""}</td>` : "";
    const pdfCell = includePdfColumn ? `<td>${row.pdf_file ? htmlLink(row.pdf_file, path.posix.basename(toPosixPath(row.pdf_file))) : ""}</td>` : "";
    const assetsCell = `<td>${renderHtmlAssetReferences(assetStore?.readingReferencesForSession(row.session_id) || [])}</td>`;
    if (reducedMetadata) return `      <tr data-search="${htmlEscape(searchable)}"><td>${htmlEscape(row.project_name || row.project)}</td><td>${htmlEscape(row.storage || "active")}</td><td>${htmlEscape(startedAt)}</td><td>${htmlEscape(row.session_id)}</td>${assetsCell}${docxCell}${pdfCell}${rawCell}</tr>`;
    return `      <tr data-search="${htmlEscape(searchable)}"><td>${htmlEscape(row.project_name || row.project)}</td><td>${htmlEscape(row.title || row.session_id)}</td><td>${htmlEscape(row.storage || "active")}</td><td>${htmlEscape(startedAt)}</td><td>${htmlEscape(row.model || "")}</td>${assetsCell}${markdownCell}${docxCell}${pdfCell}${rawCell}</tr>`;
  }).join("\n");
  const filterPlaceholder = reducedMetadata ? "Project, storage, date, or session ID" : "Project, title, date, model, active or archived";
  const profileNote = reducedMetadata ? "\n  <p class=\"meta\">Source snapshots intentionally use a reduced index and do not inspect complete readable metadata.</p>" : "";
  const header = reducedMetadata
    ? `<th>Project</th><th>Storage</th><th>Started</th><th>Session ID</th><th>Assets</th>${includeDocxColumn ? "<th>DOCX</th>" : ""}${includePdfColumn ? "<th>PDF</th>" : ""}${includeRawColumn ? "<th>Raw</th>" : ""}`
    : `<th>Project</th><th>Title</th><th>Storage</th><th>Started</th><th>Model</th><th>Assets</th>${includeMarkdownColumn ? "<th>Markdown</th>" : ""}${includeDocxColumn ? "<th>DOCX</th>" : ""}${includePdfColumn ? "<th>PDF</th>" : ""}${includeRawColumn ? "<th>Raw</th>" : ""}`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Codex Project Chat Export Index</title>
  <style>
    body { font-family: system-ui, -apple-system, Segoe UI, sans-serif; margin: 2rem; color: #1f2937; background: #ffffff; }
    h1 { margin-bottom: 0.25rem; }
    .meta { color: #4b5563; margin-top: 0; }
    .toolbar { display: flex; gap: 0.75rem; align-items: center; margin-top: 1.5rem; flex-wrap: wrap; }
    label { font-weight: 650; }
    input { width: min(32rem, 80vw); max-width: 100%; padding: 0.55rem 0.65rem; border: 1px solid #cbd5e1; border-radius: 0.35rem; font: inherit; }
    .count { color: #4b5563; }
    table { border-collapse: collapse; width: 100%; margin-top: 1.5rem; }
    th, td { border-bottom: 1px solid #e5e7eb; padding: 0.55rem 0.65rem; text-align: left; vertical-align: top; }
    th { background: #f9fafb; font-weight: 650; }
    a { color: #075985; }
    .assets { display: flex; flex-wrap: wrap; gap: 0.4rem; align-items: flex-start; }
    .assets img { display: block; max-width: 8rem; max-height: 6rem; object-fit: contain; border: 1px solid #e5e7eb; border-radius: 0.25rem; }
    .additional-context { margin-top: 0.6rem; }
    .additional-context summary { cursor: pointer; font-weight: 650; }
  </style>
</head>
<body>
  <h1>Codex Project Chat Export Index</h1>
  <p class="meta">Generated: ${htmlEscape(generatedAt)}</p>${profileNote}
  <div class="toolbar">
    <label for="filter">Filter sessions</label>
    <input id="filter" type="search" placeholder="${filterPlaceholder}" autocomplete="off">
    <span class="count" id="count">${rows.length} sessions</span>
  </div>
  <table>
    <thead><tr>${header}</tr></thead>
    <tbody>
${bodyRows}
    </tbody>
  </table>
  <script>
    const input = document.getElementById("filter");
    const count = document.getElementById("count");
    const rows = Array.from(document.querySelectorAll("tbody tr"));
    function applyFilter() {
      const terms = input.value.toLowerCase().trim().split(/\\s+/).filter(Boolean);
      let visible = 0;
      for (const row of rows) {
        const haystack = row.dataset.search || "";
        const show = terms.every((term) => haystack.includes(term));
        row.hidden = !show;
        if (show) visible += 1;
      }
      count.textContent = visible + (visible === 1 ? " session" : " sessions");
    }
    input.addEventListener("input", applyFilter);
  </script>
</body>
</html>
`;
}
function slug(value) { return String(value || "").normalize("NFKD").replace(/[^\w.\-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "unknown"; }
function stampForName(date) { const valid = Number.isNaN(date.getTime()) ? new Date() : date; const pad = (n) => String(n).padStart(2, "0"); return `${valid.getFullYear()}${pad(valid.getMonth() + 1)}${pad(valid.getDate())}-${pad(valid.getHours())}${pad(valid.getMinutes())}${pad(valid.getSeconds())}`; }
export {
  ARCHIVE_FORMAT_VERSION,
  INCOMPLETE_MARKER_NAME,
  EXPORT_PROFILE,
  EXPORT_PROFILES,
  ExportError,
  REDACTION_PATTERNS,
  SESSION_KIND,
  USER_RECORD_KIND,
  classifyRuntimeContextTypes,
  classifySessionKind,
  beginExportGeneration,
  completeExportGeneration,
  copyStableRawSnapshot,
  createProgressReporter,
  createSessionEventClassifier,
  deriveTitle,
  deriveUserDisplayTitle,
  exportArchive,
  extractCwdFromText,
  extractSessionIdFromFilename,
  formatErrorWithHints,
  isPathInside,
  markdownFence,
  matchesProject,
  parseArgs,
  portableBasename,
  redactSecrets,
  readSessionMeta,
  readSessionDiscoveryMeta,
  readSessionRoutingMeta,
  readTopLevelJsonEventType,
  recordedPathIdentity,
  sameRecordedPathIdentity,
  inspectUnprefixedEmbeddedImage,
  classifyAttachmentReference,
  resolveExportProfile,
  resolveDisplayTitle,
  sha256File,
  slug,
  validateIndexedTitle,
  validatedSourceRelativePath,
};
