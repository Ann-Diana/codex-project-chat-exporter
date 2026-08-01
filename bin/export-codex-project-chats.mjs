#!/usr/bin/env node
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

const VERSION = "0.1.0";
let argumentError = null;
let args = {};
try {
  args = parseArgs(process.argv.slice(2));
} catch (error) {
  argumentError = error;
}
const toolRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const codexHome = path.resolve(args["codex-home"] || process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
const sessionsDir = path.resolve(args["sessions-dir"] || path.join(codexHome, "sessions"));
const archivedSessionsDir = path.resolve(args["archived-dir"] || path.join(codexHome, "archived_sessions"));
const sessionIndexPath = path.resolve(args["session-index"] || path.join(codexHome, "session_index.jsonl"));
const pathStyle = args["readable-paths"] ? "readable" : "short";
const markdownDirName = pathStyle === "readable" ? "markdown" : "md";
const outputPrefix = pathStyle === "readable" ? "codex-chat-export" : "cx";
const defaultOutputBase = isPathInside(process.cwd(), toolRoot) ? path.join(os.homedir(), "Documents") : process.cwd();
const outputDir = path.resolve(args.out || path.join(defaultOutputBase, `${outputPrefix}-${stampForName(new Date())}`));
const projectFilter = args.project || "";
const exportAll = args.all || !projectFilter;
const includeTools = Boolean(args["include-tools"]);
const copyRaw = !args["no-raw"];
const redactMarkdown = !args["no-redact-markdown"];
const listOnly = Boolean(args.list);
const listSessionsOnly = Boolean(args["list-sessions"]);
const diagnoseOnly = Boolean(args.diagnose);
const includeArchived = !args["no-archived"];
const allowOutputInToolDir = Boolean(args["allow-output-in-tool-dir"]);
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
  }
  lines.push("See FAQ.md in the tool folder for common fixes.");
  return lines.join("\n");
}

async function main() {
  if (args.help) {
    printHelp();
    return;
  }

  if (args.version) {
    console.log(VERSION);
    return;
  }

  if (!args.all && !projectFilter && !listOnly && !listSessionsOnly && !diagnoseOnly) {
    throw new ExportError("NO_SELECTION", "Choose --all or --project <name-or-path>.");
  }

  if (!listOnly && !listSessionsOnly && !diagnoseOnly && !allowOutputInToolDir && isPathInside(outputDir, toolRoot)) {
    throw new ExportError("OUTPUT_IN_TOOL_DIR", `Refusing to export into the tool/repository folder: ${outputDir}`);
  }

  const locations = [];
  if (fs.existsSync(sessionsDir)) locations.push({ root: sessionsDir, storage: "active" });
  if (includeArchived && fs.existsSync(archivedSessionsDir)) locations.push({ root: archivedSessionsDir, storage: "archived" });
  if (!locations.length) {
    throw new ExportError("NO_SESSIONS", `No Codex session folders found under: ${codexHome}`);
  }

  const files = [];
  for (const location of locations) {
    for (const file of await findJsonlFiles(location.root)) files.push({ file, storage: location.storage });
  }
  if (!files.length) {
    throw new ExportError("NO_SESSIONS", `No rollout JSONL files found under: ${locations.map((location) => location.root).join(", ")}`);
  }
  files.sort((a, b) => a.file.localeCompare(b.file));
  const titleIndex = await readSessionIndex(sessionIndexPath);
  const metaMap = new Map();
  const parsedEntries = [];

  for (const entry of files) {
    const meta = await readSessionMeta(entry.file);
    const indexed = meta.id ? (titleIndex.get(meta.id) || {}) : {};
    const indexedTitle = deriveTitle(indexed.threadName, 120);
    const fallbackTitle = deriveTitle(meta.firstUserText, 120);
    const rawTitle = indexedTitle || fallbackTitle || "";
    const title = redactMarkdown ? redactSecrets(rawTitle) : rawTitle;
    const enriched = {
      ...meta,
      title,
      titleSource: indexedTitle ? "session_index" : (fallbackTitle ? "first_user_message" : ""),
      updatedAt: indexed.updatedAt || "",
      file: entry.file,
      storage: entry.storage,
    };
    parsedEntries.push(enriched);
    const key = meta.id || normalizePathForCompare(entry.file);
    const existing = metaMap.get(key);
    if (!existing || (existing.storage === "archived" && entry.storage === "active")) metaMap.set(key, enriched);
  }
  const metas = Array.from(metaMap.values()).sort((a, b) => (a.timestamp || "").localeCompare(b.timestamp || ""));

  if (listOnly) {
    printProjectList(metas);
    return;
  }

  if (listSessionsOnly) {
    printSessionList(metas);
    return;
  }

  if (diagnoseOnly) {
    printDiagnostics(parsedEntries, metas, locations);
    return;
  }

  const selected = metas.filter((meta) => exportAll || matchesProject(meta.cwd, projectFilter));
  if (!selected.length) {
    printProjectList(metas);
    throw new ExportError("NO_PROJECT_MATCH", `No sessions matched project filter: ${projectFilter}`);
  }

  await fsp.mkdir(outputDir, { recursive: true });
  await fsp.mkdir(path.join(outputDir, markdownDirName), { recursive: true });
  if (copyRaw) await fsp.mkdir(path.join(outputDir, "raw"), { recursive: true });

  const rows = [];
  const projectDirs = new Map();
  for (const meta of selected) {
    const sessionSlug = slug(meta.title || meta.id || path.basename(meta.file, ".jsonl")).slice(0, 80);
    const start = meta.timestamp ? stampForName(new Date(meta.timestamp)) : stampForName(new Date());
    const projectDir = pathStyle === "readable" ? readableProjectDir(projectDirs, meta.cwd) : shortProjectDir(projectDirs, meta.cwd);
    const sessionCode = `s${String(rows.length + 1).padStart(4, "0")}`;
    const baseName = pathStyle === "readable" ? `${start}-${sessionSlug || "codex-session"}-${sessionCode}` : sessionCode;
    const markdownRel = path.join(markdownDirName, projectDir, `${baseName}.md`);
    const rawRel = path.join("raw", projectDir, pathStyle === "readable" ? path.basename(meta.file) : `${baseName}.jsonl`);

    await fsp.mkdir(path.join(outputDir, markdownDirName, projectDir), { recursive: true });
    if (copyRaw) {
      await fsp.mkdir(path.join(outputDir, "raw", projectDir), { recursive: true });
      await fsp.copyFile(meta.file, path.join(outputDir, rawRel));
    }

    const stats = await writeMarkdownTranscript(meta, path.join(outputDir, markdownRel), copyRaw ? rawRel : "");
    rows.push({
      project: meta.cwd || "",
      project_name: meta.cwd ? portableBasename(meta.cwd) : "",
      title: meta.title || "",
      title_source: meta.titleSource || "",
      storage: meta.storage || "active",
      session_id: meta.id || "",
      started_at: meta.timestamp || "",
      updated_at: stats.updatedAt || meta.updatedAt || "",
      model: stats.model || meta.model || "",
      user_messages: stats.userMessages,
      assistant_messages: stats.assistantMessages,
      tool_events: stats.toolEvents,
      source_jsonl: meta.file,
      source_jsonl_name: path.basename(meta.file),
      markdown_file: markdownRel,
      raw_export_file: copyRaw ? rawRel : "",
    });
  }

  await writeIndexFiles(outputDir, rows);
  await writeSummary(outputDir, rows);
  await verifyExport(outputDir, rows);

  console.log("");
  console.log(`Export complete: ${outputDir}`);
  console.log(`Sessions: ${rows.length}`);
  console.log(`Active: ${rows.filter((row) => row.storage === "active").length}`);
  console.log(`Archived: ${rows.filter((row) => row.storage === "archived").length}`);
  console.log(`Path style: ${pathStyle}`);
  console.log(`Markdown: ${path.join(outputDir, markdownDirName)}`);
  if (copyRaw) console.log(`Raw data: ${path.join(outputDir, "raw")}`);
  console.log(`HTML index: ${path.join(outputDir, "index.html")}`);
  console.log(`Markdown index: ${path.join(outputDir, "index.md")}`);
  console.log("");
  console.log("Next steps:");
  console.log(`1. Open ${path.join(outputDir, "index.html")} to browse the export in your browser.`);
  console.log(`2. Spot-check a few files in ${path.join(outputDir, markdownDirName)}.`);
  console.log(`   Markdown users can also open ${path.join(outputDir, "index.md")}.`);
  console.log("3. If your export contains a raw/ folder, keep it private.");
}

function parseArgs(argv) {
  const parsed = {};
  const flagArgs = new Set(["all", "include-tools", "no-raw", "no-redact-markdown", "no-archived", "list", "list-sessions", "diagnose", "help", "version", "readable-paths", "allow-output-in-tool-dir"]);
  const valueArgs = new Set(["project", "out", "codex-home", "sessions-dir", "archived-dir", "session-index"]);
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
  if (parsed.all && parsed.project) throw new Error("Use either --all or --project, not both.");
  return parsed;
}

async function findJsonlFiles(root) {
  const results = [];
  async function walk(dir) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".jsonl")) results.push(full);
    }
  }
  await walk(root);
  return results;
}

async function readSessionIndex(indexPath) {
  const result = new Map();
  if (!fs.existsSync(indexPath)) return result;
  const rl = readline.createInterface({ input: fs.createReadStream(indexPath, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line);
      if (item.id) result.set(item.id, { threadName: item.thread_name || "", updatedAt: item.updated_at || "" });
    } catch {}
  }
  return result;
}

async function readSessionMeta(file) {
  const filenameId = extractSessionIdFromFilename(file);
  const stat = await fsp.stat(file).catch(() => null);
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
    model: "",
    firstUserText: "",
    hasSessionMeta: false,
    parsedLines: 0,
    invalidJsonLines: 0,
    fileSize: stat?.size || 0,
  };
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    meta.parsedLines += 1;
    if (!line.trim()) continue;
    let item;
    try {
      item = JSON.parse(line);
    } catch {
      meta.invalidJsonLines += 1;
      continue;
    }
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
      } else {
        meta.cwd = meta.cwd || item.payload.cwd || "";
        meta.timestamp = meta.timestamp || item.payload.timestamp || item.timestamp || "";
      }
    }
    if (item.type === "turn_context" && item.payload) {
      meta.cwd = item.payload.cwd || meta.cwd;
      meta.model = item.payload.model || meta.model;
    }
    if (item.type === "response_item" && item.payload?.type === "message" && item.payload?.role === "user" && !meta.firstUserText) {
      meta.firstUserText = extractText(item.payload.content);
    }
    if (item.type === "event_msg" && item.payload?.type === "user_message" && !meta.firstUserText) {
      meta.firstUserText = item.payload.message || item.payload.text || "";
    }
    if (!meta.cwd && meta.firstUserText) {
      meta.cwd = extractCwdFromText(meta.firstUserText) || meta.cwd;
    }
    if (meta.cwd && meta.id && meta.timestamp && meta.firstUserText && meta.model) {
      rl.close();
      break;
    }
  }
  if (!meta.timestamp && stat) meta.timestamp = stat.mtime.toISOString();
  return meta;
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

async function readLatestTimestamp(file, fallback = "") {
  let latest = fallback;
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line);
      if (item.timestamp && (!latest || item.timestamp > latest)) latest = item.timestamp;
    } catch {}
  }
  return latest;
}

function normalizePathForCompare(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
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

async function writeMarkdownTranscript(meta, outputPath, rawRel) {
  const out = fs.createWriteStream(outputPath, { encoding: "utf8" });
  const latestTimestamp = await readLatestTimestamp(meta.file, meta.updatedAt || meta.timestamp || "");
  const stats = { userMessages: 0, assistantMessages: 0, toolEvents: 0, model: meta.model || "", updatedAt: latestTimestamp };
  writeLine(out, `# ${meta.title || "Codex Project Chat Export"}`);
  writeLine(out, "");
  writeLine(out, `- Project: ${meta.cwd || ""}`);
  writeLine(out, `- Storage: ${meta.storage || "active"}`);
  writeLine(out, `- Session ID: ${meta.id || ""}`);
  writeLine(out, `- Started: ${meta.timestamp || ""}`);
  writeLine(out, `- Updated: ${stats.updatedAt || ""}`);
  if (meta.model) writeLine(out, `- Model: ${meta.model}`);
  if (rawRel) writeLine(out, `- Raw JSONL: ${rawRel.replace(/\\/g, "/")}`);
  writeLine(out, "");
  writeLine(out, "> Markdown is a readable view. The raw JSONL file is the complete local session export.");
  if (redactMarkdown) writeLine(out, "> Known token-shaped secrets are redacted in this Markdown view only.");
  writeLine(out, "");

  const rl = readline.createInterface({ input: fs.createReadStream(meta.file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let item;
    try { item = JSON.parse(line); } catch { continue; }
    if (item.timestamp && (!stats.updatedAt || item.timestamp > stats.updatedAt)) stats.updatedAt = item.timestamp;
    if (item.type === "turn_context" && item.payload?.model && !stats.model) stats.model = item.payload.model;
    if (item.type !== "response_item" || !item.payload) continue;
    const payload = item.payload;
    if (payload.type === "message" && ["user", "assistant"].includes(payload.role)) {
      const text = extractText(payload.content);
      if (!text.trim()) continue;
      if (payload.role === "user") stats.userMessages += 1;
      if (payload.role === "assistant") stats.assistantMessages += 1;
      writeLine(out, `## ${payload.role === "user" ? "User" : "Assistant"}${item.timestamp ? ` - ${item.timestamp}` : ""}`);
      writeLine(out, "");
      writeLine(out, redactMarkdown ? redactSecrets(text) : text);
      writeLine(out, "");
      continue;
    }
    if (["function_call", "custom_tool_call", "function_call_output", "custom_tool_call_output"].includes(payload.type)) {
      stats.toolEvents += 1;
      if (includeTools) {
        writeLine(out, `## Tool ${payload.type}${payload.name ? ` - ${payload.name}` : ""}${item.timestamp ? ` - ${item.timestamp}` : ""}`);
        writeLine(out, "");
        const toolText = payload.arguments || payload.input || payload.output || JSON.stringify(payload, null, 2);
        const renderedToolText = redactMarkdown ? redactSecrets(String(toolText)) : String(toolText);
        const fence = markdownFence(renderedToolText);
        writeLine(out, `${fence}text`);
        writeLine(out, renderedToolText);
        writeLine(out, fence);
        writeLine(out, "");
      }
    }
  }
  await new Promise((resolve, reject) => { out.end(resolve); out.on("error", reject); });
  return stats;
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

async function writeIndexFiles(dir, rows) {
  const generatedAt = new Date().toISOString();
  const indexRows = [...rows].sort((a, b) => (b.updated_at || b.started_at || "").localeCompare(a.updated_at || a.started_at || ""));
  const md = ["# Codex Project Chat Export Index", "", `Generated: ${generatedAt}`, "", "| Project | Title | Storage | Started | Markdown | Raw |", "| --- | --- | --- | --- | --- | --- |"];
  for (const row of indexRows) md.push(`| ${mdCell(row.project_name || row.project)} | ${mdCell(row.title || row.session_id)} | ${mdCell(row.storage)} | ${mdCell(row.started_at)} | ${mdLink(row.markdown_file)} | ${row.raw_export_file ? mdLink(row.raw_export_file) : ""} |`);
  md.push("");
  await fsp.writeFile(path.join(dir, "index.md"), `${md.join("\n")}\n`, "utf8");
  await fsp.writeFile(path.join(dir, "index.html"), renderHtmlIndex(indexRows, generatedAt), "utf8");
  await fsp.writeFile(path.join(dir, "manifest.json"), `${JSON.stringify({ generated_at: generatedAt, codex_home: codexHome, sessions_dir: sessionsDir, archived_sessions_dir: includeArchived ? archivedSessionsDir : "", session_index: sessionIndexPath, path_style: pathStyle, sessions: rows }, null, 2)}\n`, "utf8");
}

async function writeSummary(dir, rows) {
  const projects = new Map();
  for (const row of rows) projects.set(row.project || "unknown", (projects.get(row.project || "unknown") || 0) + 1);
  const activeCount = rows.filter((row) => row.storage === "active").length;
  const archivedCount = rows.filter((row) => row.storage === "archived").length;
  const lines = ["Codex Project Chat Export", "=========================", "", `Generated: ${new Date().toISOString()}`, `Codex home: ${codexHome}`, `Sessions dir: ${sessionsDir}`, `Archived sessions dir: ${includeArchived ? archivedSessionsDir : "disabled"}`, `Path style: ${pathStyle}`, `Sessions exported: ${rows.length}`, `Active sessions: ${activeCount}`, `Archived sessions: ${archivedCount}`, "", "Projects:", ...Array.from(projects.entries()).map(([project, count]) => `- ${project}: ${count}`), "", "Notes:", "- md/ contains readable user and assistant messages when short path style is used.", "- markdown/ contains readable user and assistant messages when readable path style is used.", "- raw/ contains complete original session JSONL files, if raw export was enabled.", "- Raw export file names may be shortened; manifest.json maps them back to the original source files.", "- index.html can be filtered by project, title, date, model, or storage location.", "- manifest.json preserves metadata for later tooling."];
  await fsp.writeFile(path.join(dir, "README.txt"), `${lines.join("\n")}\n`, "utf8");
}

async function verifyExport(dir, rows) {
  const required = ["index.html", "index.md", "manifest.json", "README.txt"];
  for (const name of required) {
    const file = path.join(dir, name);
    const stat = await fsp.stat(file).catch(() => null);
    if (!stat?.isFile() || stat.size === 0) throw new ExportError("EXPORT_VERIFICATION_FAILED", `Missing or empty output file: ${file}`);
  }
  for (const row of rows) {
    for (const rel of [row.markdown_file, row.raw_export_file].filter(Boolean)) {
      const file = path.join(dir, rel);
      const stat = await fsp.stat(file).catch(() => null);
      if (!stat?.isFile() || stat.size === 0) throw new ExportError("EXPORT_VERIFICATION_FAILED", `Missing or empty session export: ${file}`);
    }
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
  --no-raw                    Do not copy raw JSONL files.
  --no-redact-markdown        Disable redaction in Markdown and derived display titles.
  --readable-paths            Use longer human-readable export file names.
  --allow-output-in-tool-dir  Allow exporting into this tool/repository folder.
  --help, -h                  Show this help.
  --version, -v               Show the version.

By default, exports use short paths such as md/p001-project/s0001.md and
raw/p001-project/s0001.jsonl to make copied or unzipped archives safer on Windows.\n\nIf node is not found, use export-codex-project-chats.cmd or install Node.js 18+.`);
}

function printProjectList(metas) {
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

function printSessionList(metas) {
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

function printDiagnostics(parsedEntries, metas, locations) {
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
function renderHtmlIndex(rows, generatedAt) {
  const bodyRows = rows.map((row) => {
    const searchable = [row.project_name || row.project, row.title || row.session_id, row.storage, row.started_at, row.updated_at, row.model].join(" ").toLowerCase();
    return `      <tr data-search="${htmlEscape(searchable)}"><td>${htmlEscape(row.project_name || row.project)}</td><td>${htmlEscape(row.title || row.session_id)}</td><td>${htmlEscape(row.storage || "active")}</td><td>${htmlEscape(row.started_at)}</td><td>${htmlEscape(row.model || "")}</td><td>${htmlLink(row.markdown_file, path.posix.basename(toPosixPath(row.markdown_file)))}</td><td>${row.raw_export_file ? htmlLink(row.raw_export_file, path.posix.basename(toPosixPath(row.raw_export_file))) : ""}</td></tr>`;
  }).join("\n");
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
  </style>
</head>
<body>
  <h1>Codex Project Chat Export Index</h1>
  <p class="meta">Generated: ${htmlEscape(generatedAt)}</p>
  <div class="toolbar">
    <label for="filter">Filter sessions</label>
    <input id="filter" type="search" placeholder="Project, title, date, model, active or archived" autocomplete="off">
    <span class="count" id="count">${rows.length} sessions</span>
  </div>
  <table>
    <thead><tr><th>Project</th><th>Title</th><th>Storage</th><th>Started</th><th>Model</th><th>Markdown</th><th>Raw</th></tr></thead>
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
  ExportError,
  REDACTION_PATTERNS,
  deriveTitle,
  extractCwdFromText,
  extractSessionIdFromFilename,
  formatErrorWithHints,
  isPathInside,
  markdownFence,
  portableBasename,
  redactSecrets,
  slug,
};