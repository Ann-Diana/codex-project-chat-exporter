import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { beginExportGeneration, completeExportGeneration, copyStableRawSnapshot, exportArchive, INCOMPLETE_MARKER_NAME, readSessionRoutingMeta, sha256File } from "../bin/export-codex-project-chats.mjs";
import { SESSION_READER_IMPLEMENTATION } from "../lib/session-record-reader.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const retiredContinuingIntegrityField = ["raw", "integrity", "verified"].join("_");
const retiredImportReadinessField = ["import", "ready"].join("_");
const script = path.join(repoRoot, "bin", "export-codex-project-chats.mjs");
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "codex-exporter-test-")));
const codexHome = path.join(temp, ".codex");
const activeDir = path.join(codexHome, "sessions", "2026", "07", "20");
const archivedDir = path.join(codexHome, "archived_sessions");
const outputDir = path.join(temp, "output");
const dangerousTitle = "Escaping plain | one|two \\ slash\\\\ before\\|pipe \\\\|combo C:\\Temp\\file already\\|escaped Unicode π";
const dangerousProject = "/home/demo/projects/beta\rbare\nline\r\nend";

await fs.mkdir(activeDir, { recursive: true });
await fs.mkdir(archivedDir, { recursive: true });

async function pathExists(candidate) {
  try {
    await fs.stat(candidate);
    return true;
  } catch {
    return false;
  }
}

function jsonl(items) {
  return `${items.map((item) => JSON.stringify(item)).join("\n")}\n`;
}

await fs.writeFile(path.join(activeDir, "rollout-active.jsonl"), jsonl([
  { type: "session_meta", timestamp: "2026-07-20T10:00:00.000Z", payload: { id: "session-active", cwd: "C:\\Projects\\alpha", timestamp: "2026-07-20T10:00:00.000Z", source: "vscode", thread_source: "user" } },
  { type: "response_item", timestamp: "2026-07-20T10:00:00.500Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions\n<environment_context>automatic startup context</environment_context>" }, { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" }, { type: "input_image", image_url: "iVBORw0KGgoBAgME" }, { type: "local_image", path: "C:\\Private\\screenshot.png" }, { type: "input_image", image_url: "https://example.invalid/capture.png" }, { type: "input_image", image_url: "opaque-attachment-token" }], internal_chat_message_metadata_passthrough: { turn_id: "turn-active-1" } } },
  { type: "turn_context", timestamp: "2026-07-20T10:00:01.000Z", payload: { cwd: "C:\\Projects\\alpha", model: "gpt-test" } },
  { type: "response_item", timestamp: "2026-07-20T10:00:02.000Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Create the release archive and preserve the literal terms AGENTS.md and <environment_context>." }], internal_chat_message_metadata_passthrough: { turn_id: "turn-active-1" } } },
  { type: "event_msg", timestamp: "2026-07-20T10:00:02.001Z", payload: { type: "user_message", message: "Create the release archive and preserve the literal terms AGENTS.md and <environment_context>." } },
  { type: "event_msg", timestamp: "2026-07-20T10:00:03.000Z", payload: { type: "agent_message", message: "Done." } },
  { type: "response_item", timestamp: "2026-07-20T10:00:03.000Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] } },
  { type: "response_item", timestamp: "2026-07-20T10:01:00.000Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>later automatic context</environment_context>" }], internal_chat_message_metadata_passthrough: { turn_id: "turn-active-2" } } },
  { type: "response_item", timestamp: "2026-07-20T10:01:00.100Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<recommended_plugins>later plugin context</recommended_plugins>" }], internal_chat_message_metadata_passthrough: { turn_id: "turn-active-2" } } },
  { type: "response_item", timestamp: "2026-07-20T10:01:01.000Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Continue with the second genuine turn." }], internal_chat_message_metadata_passthrough: { turn_id: "turn-active-2" } } },
  { type: "event_msg", timestamp: "2026-07-20T10:01:01.000Z", payload: { type: "user_message", message: "Continue with the second genuine turn." } },
  { type: "event_msg", timestamp: "2026-07-20T10:01:02.000Z", payload: { type: "agent_message", message: "Continued." } },
  { type: "response_item", timestamp: "2026-07-20T10:01:02.000Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Continued." }] } },
]));

await fs.writeFile(path.join(activeDir, "rollout-empty-project.jsonl"), jsonl([
  { type: "session_meta", timestamp: "2026-07-19T10:00:00.000Z", payload: { id: "session-empty-project", timestamp: "2026-07-19T10:00:00.000Z", source: "vscode", thread_source: "user" } },
  { type: "response_item", timestamp: "2026-07-19T10:00:00.500Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: dangerousTitle }], internal_chat_message_metadata_passthrough: { turn_id: "turn-empty-project" } } },
  { type: "event_msg", timestamp: "2026-07-19T10:00:00.501Z", payload: { type: "user_message", message: dangerousTitle } },
  { type: "event_msg", timestamp: "2026-07-19T10:00:01.000Z", payload: { type: "agent_message", message: "No project metadata." } },
  { type: "response_item", timestamp: "2026-07-19T10:00:01.000Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "No project metadata." }] } },
]));

await fs.writeFile(path.join(archivedDir, "rollout-archived.jsonl"), jsonl([
  { type: "session_meta", timestamp: "2026-06-01T08:00:00.000Z", payload: { id: "session-archived", cwd: dangerousProject, timestamp: "2026-06-01T08:00:00.000Z", source: "vscode", thread_source: "user" } },
  { type: "response_item", timestamp: "2026-06-01T08:00:02.000Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Investigate the archived build failure.\nDetails follow." }], internal_chat_message_metadata_passthrough: { turn_id: "turn-archived" } } },
  { type: "event_msg", timestamp: "2026-06-01T08:00:02.000Z", payload: { type: "user_message", message: "Investigate the archived build failure.\nDetails follow." } },
  { type: "event_msg", timestamp: "2026-06-01T08:00:03.000Z", payload: { type: "agent_message", message: "Investigating." } },
  { type: "response_item", timestamp: "2026-06-01T08:00:03.000Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Investigating." }] } },
]));

await fs.writeFile(path.join(archivedDir, "rollout-archived-same-project.jsonl"), jsonl([
  { type: "session_meta", timestamp: "2026-05-15T08:00:00.000Z", payload: { id: "session-archived-same-project", cwd: "C:\\Projects\\alpha", timestamp: "2026-05-15T08:00:00.000Z", source: "vscode", thread_source: "user" } },
  { type: "response_item", timestamp: "2026-05-15T08:00:02.000Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Release archive" }], internal_chat_message_metadata_passthrough: { turn_id: "turn-archived-alpha" } } },
  { type: "event_msg", timestamp: "2026-05-15T08:00:02.000Z", payload: { type: "user_message", message: "Release archive" } },
  { type: "event_msg", timestamp: "2026-05-15T08:00:03.000Z", payload: { type: "agent_message", message: "Archived copy." } },
  { type: "response_item", timestamp: "2026-05-15T08:00:03.000Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Archived copy." }] } },
]));

await fs.writeFile(path.join(activeDir, "rollout-subagent.jsonl"), jsonl([
  { type: "session_meta", timestamp: "2026-07-21T10:00:00.000Z", payload: { id: "session-subagent", cwd: "C:\\Projects\\alpha", timestamp: "2026-07-21T10:00:00.000Z", source: { subagent: { other: "guardian" } }, thread_source: "subagent", parent_thread_id: "session-active" } },
  { type: "response_item", timestamp: "2026-07-21T10:00:00.500Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions\n<environment_context>automatic subagent context</environment_context>" }], internal_chat_message_metadata_passthrough: { turn_id: "turn-subagent" } } },
  { type: "response_item", timestamp: "2026-07-21T10:00:01.000Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "[1] user: retained parent material\n[7] assistant: retained parent material" }], internal_chat_message_metadata_passthrough: { turn_id: "turn-subagent" } } },
  { type: "event_msg", timestamp: "2026-07-21T10:00:01.000Z", payload: { type: "user_message", message: "[1] user: retained parent material\n[7] assistant: retained parent material" } },
  { type: "event_msg", timestamp: "2026-07-21T10:00:02.000Z", payload: { type: "agent_message", message: "Subagent response." } },
  { type: "response_item", timestamp: "2026-07-21T10:00:02.000Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Subagent response." }] } },
]));

await fs.writeFile(path.join(activeDir, "rollout-no-user.jsonl"), jsonl([
  { type: "session_meta", timestamp: "2026-07-22T10:00:00.000Z", payload: { id: "session-no-user", cwd: "C:\\Projects\\alpha", timestamp: "2026-07-22T10:00:00.000Z", source: "unknown" } },
  { type: "response_item", timestamp: "2026-07-22T10:00:01.000Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions" }], internal_chat_message_metadata_passthrough: { turn_id: "turn-unconfirmed" } } },
]));

const malformedArchivedId = "019f0000-1111-7222-8333-444444444444";
await fs.writeFile(path.join(archivedDir, `rollout-2026-05-10T08-00-00-${malformedArchivedId}.jsonl`), jsonl([
  { type: "response_item", timestamp: "2026-05-10T08:00:01.000Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Release archive" }] } },
  { type: "turn_context", timestamp: "2026-05-10T08:00:02.000Z", payload: { cwd: "C:\\Projects\\alpha", model: "gpt-test" } },
  { type: "response_item", timestamp: "2026-05-10T08:00:03.000Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Recovered from filename metadata." }] } },
]));

await fs.writeFile(path.join(codexHome, "session_index.jsonl"), [
  JSON.stringify({ id: "session-active", thread_name: "# AGENTS.md instructions", updated_at: "2026-07-20T10:01:02.000Z" }),
  JSON.stringify({ id: "session-empty-project", thread_name: dangerousTitle, updated_at: "2026-07-19T10:00:01.000Z" }),
  JSON.stringify({ id: "session-archived-same-project", thread_name: "Release archive", updated_at: "2026-05-15T08:00:03.000Z" }),
  JSON.stringify({ id: malformedArchivedId, thread_name: "Release archive", updated_at: "2026-05-10T08:00:03.000Z" }),
  JSON.stringify({ id: "session-subagent", thread_name: "# AGENTS.md instructions", updated_at: "2026-07-21T10:00:02.000Z" }),
].join("\n") + "\n");

const version = await execFileAsync(process.execPath, [script, "--version"], { cwd: temp });
assert.equal(version.stdout.trim(), "0.3.0");

const projectList = await execFileAsync(process.execPath, [script, "--codex-home", codexHome, "--list"], { cwd: temp });
assert.match(projectList.stdout, /C:\\Projects\\alpha \(4: 3 active, 1 archived\)/);
assert.match(projectList.stdout, /\(unknown\) \(2: 1 active, 1 archived\)/, "metadata-only listing must not inspect later conversation/context records for a missing first-record cwd");

const sessionList = await execFileAsync(process.execPath, [script, "--codex-home", codexHome, "--list-sessions"], { cwd: temp });
assert.match(sessionList.stdout, /\[active\] Create the release archive and preserve the literal terms AGENTS\.md and <environment_context>\. \| C:\\Projects\\alpha/);
assert.match(sessionList.stdout, /\[archived\] Release archive \| C:\\Projects\\alpha/);
assert.match(sessionList.stdout, new RegExp(`\\[archived\\].*${malformedArchivedId}`));

const diagnostics = await execFileAsync(process.execPath, [script, "--codex-home", codexHome, "--diagnose"], { cwd: temp });
assert.match(diagnostics.stdout, /Archived directory:/);
assert.match(diagnostics.stdout, /JSONL files found: 3/);
assert.match(diagnostics.stdout, /no session_meta record found/);

await execFileAsync(process.execPath, [script, "--codex-home", codexHome, "--all", "--out", outputDir], { cwd: temp });

const manifest = JSON.parse(await fs.readFile(path.join(outputDir, "manifest.json"), "utf8"));
assert.equal(manifest.archive_format_version, 1);
assert.equal(manifest.canonical_representation, "raw_jsonl");
assert.equal(manifest.assets_manifest, "assets/manifest.json");
assert.equal(manifest.asset_occurrences, 2);
assert.equal(manifest.unique_assets, 2);
assert.equal(manifest.unique_asset_bytes, 17);
assert.equal(manifest.deduplicated_asset_bytes_saved, 0);
assert.equal(manifest.formats.attachments, true);
assert.equal(manifest.include_tools, false);
const assetsManifest = JSON.parse(await fs.readFile(path.join(outputDir, manifest.assets_manifest), "utf8"));
assert.equal(assetsManifest.schema_version, 2);
assert.equal(assetsManifest.hash_algorithm, "sha256");
assert.equal(assetsManifest.assets.length, 2);
assert.deepEqual(assetsManifest.assets.map((asset) => asset.sha256), assetsManifest.assets.map((asset) => asset.sha256).toSorted());
assert.ok(assetsManifest.assets.every((asset) => asset.extension === "bin" && asset.mime_type === "application/octet-stream" && asset.renderable === false));
assert.ok(assetsManifest.assets.every((asset) => asset.path === `assets/${asset.sha256}.bin` && !asset.path.includes("\\") && asset.uses.length === 1));
assert.equal(assetsManifest.assets.flatMap((asset) => asset.uses).some((use) => use.declared_mime === "image/png" && use.mime_mismatch === true), true);
assert.equal("event_order" in manifest, false, "raw JSONL line order is canonical and must not be duplicated in the manifest");
assert.equal(manifest.sessions.length, 7);
assert.deepEqual(manifest.sessions.map((session) => session.storage).sort(), ["active", "active", "active", "active", "archived", "archived", "archived"]);
const activeSession = manifest.sessions.find((session) => session.session_id === "session-active");
assert.equal(activeSession.title, "Create the release archive and preserve the literal terms AGENTS.md and <environment_context>.");
assert.equal(activeSession.title_source, "direct_user_message");
assert.equal(activeSession.indexed_title_status, "REJECTED_TECHNICAL_CONTEXT_MATCH");
assert.equal(activeSession.user_messages, 2);
assert.equal(activeSession.assistant_messages, 2);
assert.equal(activeSession.automatic_runtime_contexts, 3);
assert.equal(manifest.sessions.find((session) => session.session_id === "session-empty-project").title, dangerousTitle);
assert.equal(manifest.sessions.find((session) => session.session_id === "session-archived").title, "Investigate the archived build failure.");
assert.equal(manifest.sessions.find((session) => session.session_id === "session-archived").project_name, "beta\rbare\nline\r\nend");
assert.equal(manifest.sessions.find((session) => session.session_id === malformedArchivedId).project_name, "alpha");
const subagentSession = manifest.sessions.find((session) => session.session_id === "session-subagent");
assert.match(subagentSession.title, /^Subagent session session-/);
assert.equal(subagentSession.title_source, "neutral_subagent");
assert.equal(subagentSession.user_messages, 0);
assert.equal(subagentSession.subagent_inputs, 1);
assert.equal(subagentSession.automatic_runtime_contexts, 1);
const noUserSession = manifest.sessions.find((session) => session.session_id === "session-no-user");
assert.match(noUserSession.title, /^Codex session session-/);
assert.equal(noUserSession.title_source, "neutral_no_user");
assert.equal(noUserSession.user_messages, 0);
assert.equal(noUserSession.unclassified_user_role_records, 1);

for (const session of manifest.sessions) {
  assert.equal(session.snapshot_status, "STABLE");
  assert.equal(session.raw_copy_status, "VERIFIED_AT_EXPORT");
  assert.equal(new Date(session.raw_verified_at).toISOString(), session.raw_verified_at);
  assert.equal(retiredContinuingIntegrityField in session, false, "the manifest must not claim a continuing integrity state");
  assert.equal(retiredImportReadinessField in session, false, "snapshot verification must not imply a tested Codex import path");
  assert.match(session.raw_sha256, /^[0-9a-f]{64}$/);
  assert.ok(session.raw_size_bytes > 0);
  assert.ok(session.jsonl_line_count >= session.parsed_event_count);
  assert.ok(["sessions", "archived_sessions"].includes(session.source_root));
  assert.ok(session.source_relative_path && !path.isAbsolute(session.source_relative_path));
  assert.equal(path.basename(session.source_relative_path), session.source_original_filename);
  assert.equal(session.source_snapshot_before_size_bytes, session.source_snapshot_after_size_bytes);
  assert.equal(session.source_snapshot_before_mtime_ms, session.source_snapshot_after_mtime_ms);
  assert.equal("source_snapshot_size_bytes" in session, false);
  assert.equal("source_snapshot_mtime_ms" in session, false);
  assert.equal(path.basename(session.raw_export_file), session.raw_export_name);
  const original = await fs.readFile(session.source_jsonl);
  const exportedRaw = await fs.readFile(path.join(outputDir, session.raw_export_file));
  assert.deepEqual(exportedRaw, original, "raw export must remain byte-identical to its stable source snapshot");
}

const activeMarkdown = await fs.readFile(path.join(outputDir, activeSession.markdown_file), "utf8");
assert.equal((activeMarkdown.match(/^## User – /gm) || []).length, 2);
assert.equal((activeMarkdown.match(/^## Assistant – /gm) || []).length, 2);
assert.equal((activeMarkdown.match(/<summary>Automatic runtime context/g) || []).length, 3);
assert.match(activeMarkdown, /Create the release archive/);
assert.match(activeMarkdown, /literal terms AGENTS\.md and <environment_context>/);
assert.equal((activeMarkdown.match(/\[Attachment [12] \(file\)\]\(\.\.\/\.\.\/assets\/[0-9a-f]{64}\.bin\)/g) || []).length, 2);
assert.doesNotMatch(activeMarkdown, /data:image|file:\/\/|https?:\/\//, "derived Markdown must use only local relative asset references");
const subagentMarkdown = await fs.readFile(path.join(outputDir, subagentSession.markdown_file), "utf8");
assert.doesNotMatch(subagentMarkdown, /^## User – /m);
assert.match(subagentMarkdown, /<summary>Subagent input \/ parent-agent handoff/);
assert.match(subagentMarkdown, /\[1\] user: retained parent material/);
assert.match(subagentMarkdown, /\[7\] assistant: retained parent material/);

const html = await fs.readFile(path.join(outputDir, "index.html"), "utf8");
assert.match(html, /id="filter"/);
assert.match(html, /archived/);
assert.match(html, /gpt-test/);
assert.match(html, /<th>Raw<\/th>/, "raw-enabled HTML indexes should include the Raw column");
assert.match(html, /href="raw\//, "raw-enabled HTML indexes should link to current raw snapshots");
assert.equal((html.match(/href="assets\/[0-9a-f]{64}\.bin">Attachment [12] \(file\)<\/a>/g) || []).length, 2);
assert.doesNotMatch(html, /<img src="assets\/[0-9a-f]{64}\.bin"/, "non-renderable assets must never be emitted as images");

const apiOutputDir = path.join(temp, "api-output");
const apiProfilePath = path.join(temp, "api-performance-profile.json");
const apiResult = await exportArchive({ codexHome, scope: "project", workspacePath: "C:\\Projects\\alpha", outputDirectory: apiOutputDir, includeOriginalJsonl: false, performanceProfilePath: apiProfilePath });
assert.equal(apiResult.exportedSessionCount, 4);
assert.equal(apiResult.exportedProjectCount, 1);
assert.equal(apiResult.activeSessionCount, 3);
assert.equal(apiResult.archivedSessionCount, 1);
assert.ok(apiResult.htmlIndexPath.endsWith("index.html"));
assert.ok(apiResult.manifestPath.endsWith("manifest.json"));
assert.ok(apiResult.assetManifestPath.endsWith(path.join("assets", "manifest.json")));
assert.deepEqual(apiResult.assetSummary, { assetOccurrences: 2, deduplicatedBytesSaved: 0, maxWriteBlockBytes: 12, uniqueAssetBytes: 17, uniqueAssets: 2 });
assert.equal(await pathExists(path.join(apiOutputDir, "raw")), false);
const apiHtml = await fs.readFile(path.join(apiOutputDir, "index.html"), "utf8");
assert.doesNotMatch(apiHtml, /<th>Raw<\/th>/, "raw-disabled HTML indexes should omit the Raw column");
assert.doesNotMatch(apiHtml, /href="raw\//, "raw-disabled HTML indexes should omit raw links");
const apiMarkdownIndex = await fs.readFile(path.join(apiOutputDir, "index.md"), "utf8");
assert.doesNotMatch(apiMarkdownIndex, /\| Raw \|/, "raw-disabled Markdown indexes should omit the Raw column too");
const apiManifest = JSON.parse(await fs.readFile(path.join(apiOutputDir, "manifest.json"), "utf8"));
for (const session of apiManifest.sessions) {
  assert.equal(session.snapshot_status, "NOT_INCLUDED");
  assert.equal(session.raw_copy_status, "NOT_INCLUDED");
  assert.equal(session.raw_verified_at, null);
  assert.equal(retiredContinuingIntegrityField in session, false);
  assert.equal(retiredImportReadinessField in session, false);
}
const apiProfileText = await fs.readFile(apiProfilePath, "utf8");
const apiProfile = JSON.parse(apiProfileText);
assert.equal(apiProfile.performance_profile_version, 1);
assert.equal(apiProfile.status, "COMPLETED");

const earlyPreflightHome = path.join(temp, "preflight-home");
const earlyPreflightSession = path.join(earlyPreflightHome, "sessions", "rollout-preflight.jsonl");
const earlyPreflightOutput = path.join(temp, "preflight-output");
await fs.mkdir(path.dirname(earlyPreflightSession), { recursive: true });
await fs.writeFile(earlyPreflightSession, "this session must not be read\n", "utf8");
let preflightSessionReads = 0;
await assert.rejects(() => exportArchive({
  codexHome: earlyPreflightHome,
  scope: "all",
  outputDirectory: earlyPreflightOutput,
  _assetStoreOptions: { preflightIo: { link: async () => { throw Object.assign(new Error("synthetic unsupported links"), { code: "ENOTSUP" }); } } },
  _readerOptions: { io: { createReadStream: (...args) => { preflightSessionReads += 1; return fsSync.createReadStream(...args); } } },
}), (error) => error?.code === "ASSET_HARDLINK_UNSUPPORTED" && /No existing files were overwritten/.test(error.message));
assert.equal(preflightSessionReads, 0, "hard-link capability failure must occur before any session stream is opened");
assert.deepEqual(await fs.readdir(earlyPreflightOutput), [], "the failed capability probe must leave no output artifacts");

const changingAssetHome = path.join(temp, "changing-asset-home");
const changingAssetSource = path.join(changingAssetHome, "sessions", "rollout-changing-assets.jsonl");
const changingAssetOutput = path.join(temp, "changing-asset-output");
const changingAssetBytes = Buffer.alloc(1024 * 1024, 0x41);
Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(changingAssetBytes);
await fs.mkdir(path.dirname(changingAssetSource), { recursive: true });
await fs.writeFile(changingAssetSource, jsonl([
  { type: "session_meta", payload: { id: "session-changing-assets", cwd: "C:\\Projects\\changing-assets", source: "vscode", thread_source: "user" } },
  { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_image", image_url: `data:image/png;base64,${changingAssetBytes.toString("base64")}` }] } },
]));
let assetPhaseActive = false;
let assetSourceMutated = false;
await assert.rejects(() => exportArchive({
  codexHome: changingAssetHome,
  scope: "all",
  outputDirectory: changingAssetOutput,
  exportProfile: "readable",
  progressThrottleMs: 0,
  onProgress: (event) => { if (event.phase === "assets") assetPhaseActive = true; },
  _readerOptions: {
    onAttachmentDecodedChunk: () => {
      if (assetPhaseActive && !assetSourceMutated) {
        assetSourceMutated = true;
        fsSync.appendFileSync(changingAssetSource, "{}\n", "utf8");
      }
    },
  },
}), (error) => error?.code === "SOURCE_CHANGED_DURING_EXPORT" && /assets were collected/.test(error.message));
assert.equal(assetSourceMutated, true, "the source-change injection must occur during asset collection");
assert.equal(await pathExists(path.join(changingAssetOutput, "assets", "manifest.json")), false, "an unstable asset pass must not publish its manifest");
assert.deepEqual(await fs.readdir(path.join(changingAssetOutput, "assets")), [], "an unstable asset pass must remove all run-owned assets and staging files");
assert.equal(await pathExists(path.join(changingAssetOutput, INCOMPLETE_MARKER_NAME)), true, "an unstable asset pass must leave the generation visibly incomplete");

const betweenPassHome = path.join(temp, "between-pass-home");
const betweenPassSource = path.join(betweenPassHome, "sessions", "rollout-between-passes.jsonl");
const betweenPassOutput = path.join(temp, "between-pass-output");
await fs.mkdir(path.dirname(betweenPassSource), { recursive: true });
await fs.writeFile(betweenPassSource, jsonl([
  { type: "session_meta", payload: { id: "session-between-passes", cwd: "C:\\Projects\\between-passes", source: "vscode", thread_source: "user" } },
  { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "before" }, { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" }] } },
]));
let betweenPassMutated = false;
await assert.rejects(() => exportArchive({
  codexHome: betweenPassHome,
  scope: "all",
  outputDirectory: betweenPassOutput,
  exportProfile: "readable",
  onDiagnostic: (event) => {
    if (event.event === "assets_end" && !betweenPassMutated) {
      betweenPassMutated = true;
      fsSync.appendFileSync(betweenPassSource, `${JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "after" }] } })}\n`, "utf8");
    }
  },
}), (error) => error?.code === "SOURCE_CHANGED_DURING_EXPORT" && /Markdown rendering/.test(error.message));
assert.equal(betweenPassMutated, true, "the source-change injection must occur between asset collection and rendering");
assert.equal(await pathExists(path.join(betweenPassOutput, "assets", "manifest.json")), false, "a cross-pass mismatch must not publish the asset manifest");
assert.deepEqual(await fs.readdir(path.join(betweenPassOutput, "assets")), [], "a cross-pass mismatch must remove every run-owned asset");
assert.equal(await pathExists(path.join(betweenPassOutput, INCOMPLETE_MARKER_NAME)), true, "a cross-pass mismatch must leave the generation visibly incomplete");

const protectedSource = path.join(activeDir, "rollout-active.jsonl");
const protectedSourceHash = await sha256File(protectedSource);
const protectedSessionIndex = path.join(codexHome, "session_index.jsonl");
const protectedSessionIndexHash = await sha256File(protectedSessionIndex);
const normalLocalOutput = path.join(temp, "normal-local-output");
await exportArchive({ codexHome, scope: "all", outputDirectory: normalLocalOutput, exportProfile: "readable" });
assert.equal(await pathExists(path.join(normalLocalOutput, "manifest.json")), true, "a normal local output path must remain supported");

async function assertSessionIndexProfileRejected(profilePath, outputName, expectedCode = "OUTPUT_OVERLAPS_SOURCE") {
  const outputDirectory = path.join(temp, outputName);
  await assert.rejects(
    () => exportArchive({ codexHome, scope: "all", outputDirectory, exportProfile: "readable", performanceProfilePath: profilePath }),
    (error) => error?.code === expectedCode,
  );
  assert.equal(await sha256File(protectedSessionIndex), protectedSessionIndexHash, "a rejected performance profile must not change the session index");
  const profileParentEntries = await fs.readdir(path.dirname(profilePath));
  assert.equal(profileParentEntries.some((name) => name.startsWith(`${path.basename(profilePath)}.partial-`)), false, "a rejected performance profile must not leave partial files");
}

await assertSessionIndexProfileRejected(protectedSessionIndex, "profile-exact-index-output");
await assertSessionIndexProfileRejected(path.join(codexHome, "sessions", "..", "session_index.jsonl"), "profile-canonical-index-output");

const sessionIndexHardlink = path.join(temp, "session-index-hardlink.jsonl");
await fs.link(protectedSessionIndex, sessionIndexHardlink);
await assertSessionIndexProfileRejected(sessionIndexHardlink, "profile-index-hardlink-output");

const sessionIndexAliasParent = path.join(temp, "session-index-alias-home");
try {
  await fs.symlink(codexHome, sessionIndexAliasParent, process.platform === "win32" ? "junction" : "dir");
  await assertSessionIndexProfileRejected(path.join(sessionIndexAliasParent, "session_index.jsonl"), "profile-index-alias-output", "UNSAFE_EXPORT_PATH");
} catch (error) {
  if (!["EPERM", "EACCES", "ENOSYS", "EINVAL"].includes(error?.code)) throw error;
}

const profileOutputCollision = path.join(temp, "profile-output-collision");
await assert.rejects(
  () => exportArchive({ codexHome, scope: "all", outputDirectory: profileOutputCollision, exportProfile: "readable", performanceProfilePath: path.join(profileOutputCollision, "manifest.json") }),
  (error) => error?.code === "UNSAFE_EXPORT_PATH",
);
assert.equal(await sha256File(protectedSessionIndex), protectedSessionIndexHash, "an output-overlapping performance profile must not change the session index");
assert.equal((await fs.readdir(profileOutputCollision)).some((name) => name.startsWith("manifest.json.partial-")), false, "an output-overlapping performance profile must not leave profile partials");
assert.equal("performance_profile_version" in JSON.parse(await fs.readFile(path.join(profileOutputCollision, "manifest.json"), "utf8")), false, "an output-overlapping profile must not replace the generated manifest");

async function assertAliasedOutputRejected({ aliasPath, outputPath, realOutputPath, type }) {
  try {
    await fs.symlink(path.dirname(realOutputPath), aliasPath, type);
  } catch (error) {
    if (["EPERM", "EACCES", "ENOSYS", "EINVAL"].includes(error?.code)) return false;
    throw error;
  }
  await assert.rejects(
    () => exportArchive({ codexHome, scope: "all", outputDirectory: outputPath, exportProfile: "readable" }),
    (error) => error?.code === "UNSAFE_EXPORT_PATH" && /symbolic-link|junction|alias/i.test(error.message),
  );
  assert.equal(await pathExists(path.join(realOutputPath, "manifest.json")), false, "an aliased output path must not publish outside the lexically selected path");
  assert.equal(await pathExists(path.join(realOutputPath, INCOMPLETE_MARKER_NAME)), false, "an alias rejection must occur before generation mutation or cleanup");
  return true;
}

const symlinkRealParent = path.join(temp, "output-symlink-real");
const symlinkRealOutput = path.join(symlinkRealParent, "existing-output");
const symlinkAliasParent = path.join(temp, "output-symlink-alias");
await fs.mkdir(symlinkRealOutput, { recursive: true });
await assertAliasedOutputRejected({ aliasPath: symlinkAliasParent, outputPath: path.join(symlinkAliasParent, "existing-output"), realOutputPath: symlinkRealOutput, type: "dir" });

if (process.platform === "win32") {
  const junctionRealParent = path.join(temp, "output-junction-real");
  const junctionRealOutput = path.join(junctionRealParent, "existing-output");
  const junctionAliasParent = path.join(temp, "output-junction-alias");
  await fs.mkdir(junctionRealOutput, { recursive: true });
  assert.equal(await assertAliasedOutputRejected({ aliasPath: junctionAliasParent, outputPath: path.join(junctionAliasParent, "existing-output"), realOutputPath: junctionRealOutput, type: "junction" }), true, "Windows junction rejection must be exercised when junctions are available");
}

const missingAliasRealParent = path.join(temp, "output-missing-alias-real");
const missingAliasParent = path.join(temp, "output-missing-alias");
const missingAliasRealOutput = path.join(missingAliasRealParent, "not-created");
await fs.mkdir(missingAliasRealParent, { recursive: true });
await assertAliasedOutputRejected({ aliasPath: missingAliasParent, outputPath: path.join(missingAliasParent, "not-created"), realOutputPath: missingAliasRealOutput, type: process.platform === "win32" ? "junction" : "dir" });
assert.equal(await pathExists(missingAliasRealOutput), false, "a missing target under an alias ancestor must not be created");

const directAliasRealOutput = path.join(temp, "output-direct-alias-real");
const directAliasOutput = path.join(temp, "output-direct-alias");
await fs.mkdir(directAliasRealOutput, { recursive: true });
try {
  await fs.symlink(directAliasRealOutput, directAliasOutput, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(
    () => exportArchive({ codexHome, scope: "all", outputDirectory: directAliasOutput, exportProfile: "readable" }),
    (error) => error?.code === "UNSAFE_EXPORT_PATH" && /symbolic-link|junction|alias/i.test(error.message),
  );
  assert.deepEqual(await fs.readdir(directAliasRealOutput), [], "a direct output alias must be rejected without mutating its target");
} catch (error) {
  if (!["EPERM", "EACCES", "ENOSYS", "EINVAL"].includes(error?.code)) throw error;
}

const nestedAliasOutput = path.join(temp, "output-nested-alias");
const nestedAliasTarget = path.join(temp, "output-nested-alias-target");
await fs.mkdir(nestedAliasOutput, { recursive: true });
await fs.mkdir(nestedAliasTarget, { recursive: true });
try {
  await fs.symlink(nestedAliasTarget, path.join(nestedAliasOutput, "raw"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(
    () => exportArchive({ codexHome, scope: "all", outputDirectory: nestedAliasOutput, exportProfile: "complete" }),
    (error) => error?.code === "UNSAFE_EXPORT_PATH" && /symbolic-link|junction|alias/i.test(error.message),
  );
  assert.deepEqual(await fs.readdir(nestedAliasTarget), [], "a nested output alias must not receive export files");
  assert.equal(await pathExists(path.join(nestedAliasOutput, INCOMPLETE_MARKER_NAME)), false, "a nested alias must be rejected before generation mutation");
} catch (error) {
  if (!["EPERM", "EACCES", "ENOSYS", "EINVAL"].includes(error?.code)) throw error;
}

const manifestAliasOutput = path.join(temp, "manifest-alias-output");
await fs.mkdir(manifestAliasOutput, { recursive: true });
await fs.link(protectedSource, path.join(manifestAliasOutput, "manifest.json"));
await assert.rejects(() => exportArchive({ codexHome, scope: "all", outputDirectory: manifestAliasOutput, exportProfile: "readable" }), (error) => error?.code === "OUTPUT_OVERLAPS_SOURCE");
assert.equal(await sha256File(protectedSource), protectedSourceHash, "a hard-linked manifest destination must never modify its source session");

const manifestSymlinkOutput = path.join(temp, "manifest-symlink-output");
await fs.mkdir(manifestSymlinkOutput, { recursive: true });
try {
  await fs.symlink(protectedSource, path.join(manifestSymlinkOutput, "manifest.json"), "file");
  await assert.rejects(() => exportArchive({ codexHome, scope: "all", outputDirectory: manifestSymlinkOutput, exportProfile: "readable" }), (error) => error?.code === "UNSAFE_EXPORT_PATH");
  assert.equal(await sha256File(protectedSource), protectedSourceHash, "a symlinked manifest destination must never modify its source session");
} catch (error) {
  if (!["EPERM", "EACCES", "ENOSYS"].includes(error?.code)) throw error;
}

const markdownAliasOutput = path.join(temp, "markdown-alias-output");
const markdownPlanOutput = path.join(temp, "markdown-alias-plan");
const markdownPlan = await exportArchive({ codexHome, scope: "all", outputDirectory: markdownPlanOutput, exportProfile: "readable" });
const markdownPlanManifest = JSON.parse(await fs.readFile(markdownPlan.manifestPath, "utf8"));
const markdownAliasRelative = markdownPlanManifest.sessions.find(session => session.session_id === activeSession.session_id).markdown_file;
await fs.rm(markdownPlanOutput, { recursive: true, force: true });
const markdownAliasPath = path.join(markdownAliasOutput, markdownAliasRelative);
await fs.mkdir(path.dirname(markdownAliasPath), { recursive: true });
await fs.link(protectedSource, markdownAliasPath);
await assert.rejects(() => exportArchive({ codexHome, scope: "all", outputDirectory: markdownAliasOutput, exportProfile: "readable" }), (error) => error?.code === "OUTPUT_OVERLAPS_SOURCE");
assert.equal(await sha256File(protectedSource), protectedSourceHash, "a hard-linked Markdown destination must never modify its source session");

const profileAliasOutput = path.join(temp, "profile-alias-output");
const profileAliasPath = path.join(temp, "profile-alias.json");
await fs.link(protectedSource, profileAliasPath);
await assert.rejects(() => exportArchive({ codexHome, scope: "all", outputDirectory: profileAliasOutput, exportProfile: "readable", performanceProfilePath: profileAliasPath }), (error) => error?.code === "OUTPUT_OVERLAPS_SOURCE");
assert.equal(await sha256File(protectedSource), protectedSourceHash, "a hard-linked performance profile must never modify its source session");
assert.equal(await pathExists(path.join(profileAliasOutput, ".codex-export.lock")), false, "a rejected performance profile must not leave the output lock behind");

const profileInsideSource = path.join(activeDir, "unsafe-performance-profile.json");
await assert.rejects(() => exportArchive({ codexHome, scope: "all", outputDirectory: path.join(temp, "profile-inside-source-output"), exportProfile: "readable", performanceProfilePath: profileInsideSource }), (error) => error?.code === "OUTPUT_OVERLAPS_SOURCE");
assert.equal(await pathExists(profileInsideSource), false, "a performance profile must never be created inside a source-session directory");

await assert.rejects(() => exportArchive({
  codexHome,
  scope: "all",
  outputDirectory: path.join(codexHome, "sessions", "unsafe-export"),
  exportProfile: "source-snapshots",
}), (error) => error?.code === "OUTPUT_OVERLAPS_SOURCE");
assert.equal(await pathExists(path.join(codexHome, "sessions", "unsafe-export")), false, "overlapping output roots must be rejected before mkdir or any export write");
assert.equal(apiProfile.raw_enabled, false);
assert.equal(apiProfile.counts.scanned_sessions, 7);
assert.equal(apiProfile.counts.exported_sessions, 4);
assert.equal(apiProfile.attachments.embedded_count, 2);
assert.equal(apiProfile.attachments.embedded_bytes, 17);
assert.equal(apiProfile.attachments.data_url_count, 1);
assert.equal(apiProfile.attachments.unprefixed_embedded_count, 1);
assert.equal(apiProfile.attachments.unprefixed_embedded_bytes, 12);
assert.equal(apiProfile.attachments.local_reference_count, 1);
assert.equal(apiProfile.attachments.remote_reference_count, 1);
assert.equal(apiProfile.attachments.unknown_count, 1);
assert.equal(apiProfile.attachments.referenced_count, 2);
assert.equal(apiProfile.attachments.referenced_unknown_size_count, 2);
assert.ok(apiProfile.phases.parse_and_classify.duration_ms > 0);
const readableSourceFiles = [
  path.join(activeDir, "rollout-active.jsonl"),
  path.join(activeDir, "rollout-subagent.jsonl"),
  path.join(activeDir, "rollout-no-user.jsonl"),
  path.join(archivedDir, "rollout-archived-same-project.jsonl"),
];
const readableSourceBytes = (await Promise.all(readableSourceFiles.map((file) => fs.stat(file)))).reduce((sum, stat) => sum + stat.size, 0);
assert.equal(apiProfile.phases.parse_and_classify.bytes_read, readableSourceBytes, "readable exports should classify each discovered source exactly once instead of routing and reparsing selected sessions");
assert.ok(apiProfile.phases.markdown_rendering.bytes_read > 0);
assert.ok(apiProfile.memory.peak_sampled_rss_bytes >= apiProfile.memory.average_rss_bytes);
assert.ok(apiProfile.slowest_sessions.length > 0 && apiProfile.slowest_sessions.length <= 10);
assert.doesNotMatch(apiProfileText, /automatic startup context/);
assert.doesNotMatch(apiProfileText, /Private[\\/]screenshot\.png/);
assert.doesNotMatch(apiProfileText, new RegExp(temp.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
assert.doesNotMatch(apiProfileText, /C:\\\\Projects/);

const profiledRawOutputDir = path.join(temp, "profiled-raw-output");
const profiledRawPath = path.join(temp, "profiled-raw-performance.json");
const profiledRawResult = await exportArchive({ codexHome, scope: "project", workspacePath: "C:\\Projects\\alpha", outputDirectory: profiledRawOutputDir, performanceProfilePath: profiledRawPath });
const profiledRawManifest = JSON.parse(await fs.readFile(profiledRawResult.manifestPath, "utf8"));
const profiledRaw = JSON.parse(await fs.readFile(profiledRawPath, "utf8"));
const semanticSession = ({ markdown_file, raw_export_file, raw_export_name, raw_verified_at, ...session }) => session;
assert.deepEqual(profiledRawManifest.sessions.map(semanticSession), manifest.sessions.filter((session) => session.project === "C:\\Projects\\alpha" && session.session_id !== malformedArchivedId).map(semanticSession), "first-record routing must preserve selected-session manifest semantics without assigning a later turn_context cwd");
assert.equal(profiledRaw.phases.parse_and_classify.bytes_read, profiledRawManifest.sessions.reduce((sum, session) => sum + session.raw_size_bytes, 0), "only selected sources should receive complete metadata classification");
assert.ok(profiledRaw.phases.routing.bytes_read > 0, "routing should account for first-record metadata reads");
assert.ok(profiledRaw.phases.snapshot_stability_checks.duration_ms >= 0, "performance profiles should report snapshot stability checks separately");
assert.ok(profiledRaw.slowest_sessions.some((session) => session.snapshot_attempts >= 1), "profiled raw sessions should expose snapshot attempt counts without attributing attempts to routing-only sessions");
for (const session of profiledRawManifest.sessions) {
  const originalSession = manifest.sessions.find((candidate) => candidate.session_id === session.session_id);
  const normalizeRawLink = (value) => value.replace(/^- Raw JSONL: .*$/m, "- Raw JSONL: <CURRENT_EXPORT_PATH>");
  assert.equal(normalizeRawLink(await fs.readFile(path.join(profiledRawOutputDir, session.markdown_file), "utf8")), normalizeRawLink(await fs.readFile(path.join(outputDir, originalSession.markdown_file), "utf8")));
  assert.deepEqual(await fs.readFile(path.join(profiledRawOutputDir, session.raw_export_file)), await fs.readFile(path.join(outputDir, originalSession.raw_export_file)));
}

const reusedOutputDir = path.join(temp, "reused-output");
await fs.mkdir(path.join(reusedOutputDir, "raw"), { recursive: true });
await fs.writeFile(path.join(reusedOutputDir, "raw", "stale.jsonl"), "stale raw data\n", "utf8");
await exportArchive({ codexHome, scope: "project", workspacePath: "C:\\Projects\\alpha", outputDirectory: reusedOutputDir, includeOriginalJsonl: false });
const reusedHtml = await fs.readFile(path.join(reusedOutputDir, "index.html"), "utf8");
assert.equal(await pathExists(path.join(reusedOutputDir, "raw", "stale.jsonl")), true, "reused outputs should not delete older files");
assert.doesNotMatch(reusedHtml, /<th>Raw<\/th>/, "an old raw directory must not add a Raw column to the current index");
assert.doesNotMatch(reusedHtml, /href="raw\//, "an old raw directory must not create current raw links");

const sourceSnapshotsOutput = path.join(temp, "source-snapshots-output");
const progressEvents = [];
const diagnosticEvents = [];
const sourceSnapshotsResult = await exportArchive({
  codexHome,
  scope: "project",
  workspacePath: "C:\\Projects\\alpha",
  outputDirectory: sourceSnapshotsOutput,
  exportProfile: "source-snapshots",
  progressThrottleMs: 0,
  onProgress: (event) => progressEvents.push(event),
  onDiagnostic: (event) => diagnosticEvents.push(event),
});
assert.equal(sourceSnapshotsResult.exportProfile, "source-snapshots");
assert.equal(await pathExists(path.join(sourceSnapshotsOutput, "md")), false, "source-snapshots must not create short-path Markdown transcripts");
assert.equal(await pathExists(path.join(sourceSnapshotsOutput, "markdown")), false, "source-snapshots must not create readable-path Markdown transcripts");
assert.equal(await pathExists(path.join(sourceSnapshotsOutput, "index.md")), false, "source-snapshots must not create a Markdown index");
const sourceSnapshotsHtml = await fs.readFile(sourceSnapshotsResult.htmlIndexPath, "utf8");
assert.doesNotMatch(sourceSnapshotsHtml, /<th>Markdown<\/th>/, "source-snapshots HTML index must not advertise transcript links");
assert.doesNotMatch(sourceSnapshotsHtml, /href="m(?:d|arkdown)\//, "source-snapshots HTML index must not link transcripts");
assert.match(sourceSnapshotsHtml, /<th>Raw<\/th>/);
assert.doesNotMatch(sourceSnapshotsHtml, /<th>Title<\/th>/, "source-snapshots must not display unavailable readable titles");
assert.doesNotMatch(sourceSnapshotsHtml, /<th>Model<\/th>/, "source-snapshots must not display unavailable model metadata");
assert.match(sourceSnapshotsHtml, /<th>Session ID<\/th>/, "source-snapshots should retain session identity in the reduced index");
assert.match(sourceSnapshotsHtml, /Project, storage, date, or session ID/);
assert.match(sourceSnapshotsHtml, /intentionally use a reduced index and do not inspect complete readable metadata/);
const sourceSnapshotsManifest = JSON.parse(await fs.readFile(sourceSnapshotsResult.manifestPath, "utf8"));
assert.equal(sourceSnapshotsManifest.export_profile, "source-snapshots");
assert.equal(sourceSnapshotsManifest.canonical_representation_included, true);
assert.equal(sourceSnapshotsManifest.formats.markdown, false);
for (const session of sourceSnapshotsManifest.sessions) {
  assert.equal(session.markdown_file, "");
  assert.match(session.title, /^Codex session /, "the manifest should retain its neutral deterministic snapshot title");
  assert.equal(session.user_messages, null, "unparsed source snapshots must not claim message classification counts");
  assert.equal(session.snapshot_status, "STABLE");
  assert.equal(session.raw_copy_status, "VERIFIED_AT_EXPORT");
  assert.equal(new Date(session.raw_verified_at).toISOString(), session.raw_verified_at);
  assert.equal(retiredContinuingIntegrityField in session, false);
  assert.deepEqual(await fs.readFile(path.join(sourceSnapshotsOutput, session.raw_export_file)), await fs.readFile(session.source_jsonl));
}
assert.deepEqual(progressEvents.map((event) => event.phase).filter((phase, index, phases) => index === 0 || phase !== phases[index - 1]), ["discovery", "routing", "snapshot", "processing", "assets", "writing", "complete"]);
assert.ok(progressEvents.some((event) => event.message === `Processing session ${sourceSnapshotsManifest.sessions.length} of ${sourceSnapshotsManifest.sessions.length}`));
assert.doesNotMatch(JSON.stringify(progressEvents), /Projects|codex-exporter-test/, "progress events must not expose project names or full paths");
for (const event of ["core_start", "discovery_start", "discovery_end", "routing_start", "routing_metadata_end", "routing_end", "session_start", "snapshot_attempt_start", "source_hash_start", "source_hash_end", "snapshot_copy_start", "snapshot_copy_end", "export_hash_start", "export_hash_end", "snapshot_stability_check", "snapshot_attempt_end", "session_end", "assets_start", "assets_end", "index_start", "index_end", "manifest_start", "manifest_end", "verification_start", "verification_end", "core_end"]) {
  assert.ok(diagnosticEvents.some((entry) => entry.event === event), `diagnostic trace should contain ${event}`);
}
assert.equal(diagnosticEvents.filter((event) => event.event === "routing_metadata_end").length, diagnosticEvents.find((event) => event.event === "discovery_end").scanned_sessions, "each scanned source must contribute only first-record routing metadata");
assert.ok(diagnosticEvents.filter((event) => event.event === "routing_metadata_end").every(event => event.metadata_bytes_read <= 16 * 1024 * 1024 + 64 * 1024 + 4095));
assert.equal(diagnosticEvents.filter((event) => event.event === "source_hash_start").length, sourceSnapshotsManifest.sessions.length, "only selected sources should receive a complete source hash pass");
assert.equal(diagnosticEvents.filter((event) => event.event === "export_hash_start").length, sourceSnapshotsManifest.sessions.length, "each source snapshot must receive exactly one export hash pass");
assert.equal(diagnosticEvents.filter((event) => event.event === "verification_hash_start").length, 0, "final verification must not hash Raw snapshots a second time");
assert.ok(diagnosticEvents.every((event) => Number.isFinite(event.monotonic_ms)), "diagnostic events must use monotonic timestamps");
assert.doesNotMatch(JSON.stringify(diagnosticEvents), new RegExp(temp.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "diagnostic traces must not expose full private paths");
assert.doesNotMatch(JSON.stringify(diagnosticEvents), /automatic startup context|Export both/);

const explicitReadableOutput = path.join(temp, "explicit-readable-output");
const explicitReadableResult = await exportArchive({ codexHome, scope: "project", workspacePath: "C:\\Projects\\alpha", outputDirectory: explicitReadableOutput, exportProfile: "readable", includeOriginalJsonl: true });
assert.equal(await pathExists(path.join(explicitReadableOutput, "raw")), false, "an explicit readable profile must override the legacy raw boolean");
assert.equal(JSON.parse(await fs.readFile(explicitReadableResult.manifestPath, "utf8")).export_profile, "readable");

const explicitCompleteOutput = path.join(temp, "explicit-complete-output");
const completeProgress = [];
const completeDiagnostics = [];
const explicitCompleteResult = await exportArchive({ codexHome, scope: "project", workspacePath: "C:\\Projects\\alpha", outputDirectory: explicitCompleteOutput, exportProfile: "complete", includeOriginalJsonl: false, progressThrottleMs: 0, onProgress: (event) => completeProgress.push(event), onDiagnostic: (event) => completeDiagnostics.push(event) });
assert.equal(await pathExists(path.join(explicitCompleteOutput, "raw")), true, "an explicit complete profile must override the legacy no-raw boolean");
for (const session of JSON.parse(await fs.readFile(explicitCompleteResult.manifestPath, "utf8")).sessions) {
  const baseline = profiledRawManifest.sessions.find((candidate) => candidate.session_id === session.session_id);
  assert.equal(await fs.readFile(path.join(explicitCompleteOutput, session.markdown_file), "utf8"), await fs.readFile(path.join(profiledRawOutputDir, baseline.markdown_file), "utf8"), "the complete profile must preserve established Markdown semantics");
}
assert.deepEqual(completeProgress.map((event) => event.phase).filter((phase, index, phases) => index === 0 || phase !== phases[index - 1]), ["discovery", "routing", "snapshot", "processing", "assets", "rendering", "writing", "complete"], "complete-profile progress phases must be ordered and finite");
assert.equal(completeDiagnostics.filter((event) => event.event === "source_hash_start").length, explicitCompleteResult.exportedSessionCount, "complete exports must hash only selected sources after metadata-only routing");
assert.equal(completeDiagnostics.filter((event) => event.event === "export_hash_start" && event.stage === "snapshot_parse").length, explicitCompleteResult.exportedSessionCount, "complete exports must hash each Raw snapshot during its existing parse pass");
assert.equal(completeDiagnostics.filter((event) => event.event === "verification_hash_start").length, 0, "complete exports must not add a final duplicate Raw hash pass");

const nestedOuterOutput = path.join(temp, "nested-outer-output");
const nestedInnerOutput = path.join(temp, "nested-inner-output");
let nestedInnerPromise;
let nestedInnerStarted = false;
const nestedOuterPromise = exportArchive({
  codexHome,
  scope: "all",
  outputDirectory: nestedOuterOutput,
  exportProfile: "source-snapshots",
  onDiagnostic: (event) => {
    if (event.event === "core_start" && !nestedInnerStarted) {
      nestedInnerStarted = true;
      nestedInnerPromise = exportArchive({
        codexHome,
        scope: "project",
        workspacePath: "C:\\Projects\\alpha",
        outputDirectory: nestedInnerOutput,
        exportProfile: "readable",
        pathStyle: "readable",
      });
    }
  },
});
const [nestedOuterResult, nestedInnerResult] = await Promise.all([nestedOuterPromise, nestedInnerPromise]);
const nestedOuterManifest = JSON.parse(await fs.readFile(nestedOuterResult.manifestPath, "utf8"));
const nestedInnerManifest = JSON.parse(await fs.readFile(nestedInnerResult.manifestPath, "utf8"));
assert.equal(nestedOuterManifest.export_profile, "source-snapshots", "the outer export must retain its own profile");
assert.equal(nestedInnerManifest.export_profile, "readable", "the nested export must retain its own profile");
assert.equal(await pathExists(path.join(nestedOuterOutput, "raw")), true);
assert.equal(await pathExists(path.join(nestedOuterOutput, "index.md")), false);
assert.equal(await pathExists(path.join(nestedInnerOutput, "raw")), false);
assert.equal(await pathExists(path.join(nestedInnerOutput, "index.md")), true);
assert.ok(nestedInnerManifest.sessions.every((session) => session.project === "C:\\Projects\\alpha"), "the nested workspace filter must not leak into the outer export");
assert.equal(nestedOuterManifest.sessions.length, manifest.sessions.length, "the outer all-session selection must remain isolated from the nested workspace export");

const lockedOutput = path.join(temp, "concurrent-locked-output");
let competingExport;
const lockedPrimaryResult = await exportArchive({
  codexHome,
  scope: "project",
  workspacePath: "C:\\Projects\\alpha",
  outputDirectory: lockedOutput,
  exportProfile: "source-snapshots",
  progressThrottleMs: 0,
  onProgress: (event) => {
    if (event.phase === "snapshot" && !competingExport) {
      competingExport = exportArchive({
        codexHome,
        scope: "project",
        workspacePath: "C:\\Projects\\alpha",
        outputDirectory: lockedOutput,
        exportProfile: "readable",
      }).then(
        (result) => ({ result }),
        (error) => ({ error }),
      );
    }
  },
});
const competingResult = await competingExport;
assert.equal(competingResult.error?.code, "EXPORT_ALREADY_RUNNING", "the same output directory must reject a concurrent export");
assert.equal(lockedPrimaryResult.exportProfile, "source-snapshots");
assert.equal(await pathExists(path.join(lockedOutput, ".codex-export.lock")), false, "the successful owner must remove its own export lock");
assert.equal(JSON.parse(await fs.readFile(lockedPrimaryResult.manifestPath, "utf8")).export_profile, "source-snapshots", "the rejected export must not overwrite the owner manifest");

const legacyCliOutput = path.join(temp, "legacy-cli-no-raw-output");
await execFileAsync(process.execPath, [script, "--codex-home", codexHome, "--project", "C:\\Projects\\alpha", "--out", legacyCliOutput, "--no-raw"], { cwd: temp });
assert.equal(await pathExists(path.join(legacyCliOutput, "raw")), false, "the existing CLI --no-raw switch must remain compatible");
assert.equal(JSON.parse(await fs.readFile(path.join(legacyCliOutput, "manifest.json"), "utf8")).export_profile, "readable");

const routerHome = path.join(temp, "router-codex-home");
const routerSessions = path.join(routerHome, "sessions");
const routerSource = path.join(routerSessions, "rollout-router-fallback.jsonl");
await fs.mkdir(routerSessions, { recursive: true });
const routerLines = [
  '{"timestamp":',
  JSON.stringify({ timestamp: "2026-08-16T12:00:00.000Z", payload: { id: "router-session", cwd: "C:\\Projects\\router", timestamp: "2026-08-16T12:00:00.000Z" }, type: "session_meta" }),
  JSON.stringify({ payload: { nested: { type: "not-top-level" }, cwd: "C:\\Projects\\router" }, timestamp: "2026-08-16T12:00:01.000Z", type: "turn_context" }),
  JSON.stringify({ timestamp: "2026-08-16T12:00:02.000Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Router differential control." }] }, type: "response_item" }),
];
await fs.writeFile(routerSource, `${routerLines.join("\n")}\n`, "utf8");
await assert.rejects(() => readSessionRoutingMeta(routerSource), (error) => error?.code === "SESSION_JSONL_INVALID" && error?.recordNumber === 1);
const routedMeta = await readSessionRoutingMeta(routerSource, { implementation: SESSION_READER_IMPLEMENTATION.LEGACY_REFERENCE });
assert.equal(routedMeta.id, "router-session");
assert.equal(routedMeta.cwd, "C:\\Projects\\router");
const fallbackSource = path.join(temp, "router-json-parse-fallback.jsonl");
await fs.writeFile(fallbackSource, '{"type":"event_msg","type":"session_meta","payload":{"id":"fallback-session","cwd":"C:\\\\Projects\\\\fallback"}}\n', "utf8");
const fallbackMeta = await readSessionRoutingMeta(fallbackSource);
assert.equal(fallbackMeta.id, "fallback-session", "an uncertain structured scan must fall back to full JSON parsing");
assert.equal(fallbackMeta.cwd, "C:\\Projects\\fallback");
const routerOutput = path.join(temp, "router-output");
const streamingInvalidOutput = path.join(temp, "router-streaming-invalid-output");
await assert.rejects(
  () => exportArchive({ codexHome: routerHome, scope: "all", outputDirectory: streamingInvalidOutput, exportProfile: "complete" }),
  (error) => error?.code === "SOURCE_SNAPSHOT_FAILED" && error.message.includes("JSON validation failed in session record 1"),
);
assert.equal(await pathExists(path.join(streamingInvalidOutput, "manifest.json")), false, "the streaming reader must reject invalid JSONL before publishing visible output");
const routerResult = await exportArchive({ codexHome: routerHome, scope: "all", outputDirectory: routerOutput, exportProfile: "complete", _readerImplementation: SESSION_READER_IMPLEMENTATION.LEGACY_REFERENCE });
const routerManifest = JSON.parse(await fs.readFile(routerResult.manifestPath, "utf8"));
assert.equal(routerManifest.sessions[0].session_id, routedMeta.id, "structured routing and full selected-session parsing must agree on session identity");
assert.equal(routerManifest.sessions[0].project, routedMeta.cwd, "structured routing and full selected-session parsing must agree on project routing");
assert.equal(routerManifest.sessions[0].invalid_jsonl_line_count, 1);
assert.deepEqual(await fs.readFile(path.join(routerOutput, routerManifest.sessions[0].raw_export_file)), await fs.readFile(routerSource), "invalid JSONL lines must remain byte-identical in canonical Raw output");

const timestampHome = path.join(temp, "timestamp-codex-home");
const timestampSessions = path.join(timestampHome, "sessions", "2026", "08", "18");
const fallbackSessionId = "019f0000-1111-7222-8333-555555555555";
const metadataSessionId = "019f0000-1111-7222-8333-666666666666";
const timestampFallbackSource = path.join(timestampSessions, `rollout-${fallbackSessionId}.jsonl`);
const timestampMetadataSource = path.join(timestampSessions, `rollout-${metadataSessionId}.jsonl`);
const fallbackSourceTime = new Date("2001-02-03T04:05:06.000Z");
const metadataSourceTime = new Date("2002-03-04T05:06:07.000Z");
const forcedCopyTime = new Date("2040-05-06T07:08:09.000Z");
const authoritativeMetadataTime = "2020-11-12T13:14:15.000Z";
await fs.mkdir(timestampSessions, { recursive: true });
await fs.writeFile(timestampFallbackSource, jsonl([
  { type: "turn_context", timestamp: "2026-08-18T10:00:00.000Z", payload: { cwd: "C:\\Projects\\timestamp-fallback", model: "gpt-test" } },
  { type: "response_item", timestamp: "2026-08-18T10:00:01.000Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Verify source-derived timestamps." }] } },
  { type: "response_item", timestamp: "2026-08-18T10:00:02.000Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Verified." }] } },
]));
await fs.writeFile(timestampMetadataSource, jsonl([
  { type: "session_meta", timestamp: authoritativeMetadataTime, payload: { id: metadataSessionId, cwd: "C:\\Projects\\timestamp-metadata", timestamp: authoritativeMetadataTime, source: "vscode", thread_source: "user" } },
  { type: "response_item", timestamp: "2026-08-18T11:00:01.000Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Keep authoritative session metadata." }] } },
  { type: "response_item", timestamp: "2026-08-18T11:00:02.000Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Kept." }] } },
]));
await fs.utimes(timestampFallbackSource, fallbackSourceTime, fallbackSourceTime);
await fs.utimes(timestampMetadataSource, metadataSourceTime, metadataSourceTime);

for (const profile of ["complete", "readable", "source-snapshots"]) {
  const timestampOutput = path.join(temp, `timestamp-${profile}-output`);
  const result = await exportArchive({
    codexHome: timestampHome,
    scope: "all",
    outputDirectory: timestampOutput,
    exportProfile: profile,
    onDiagnostic: (event) => {
      if (event.event !== "snapshot_copy_end") return;
      const pending = [];
      const visit = (directory) => {
        for (const entry of fsSync.readdirSync(directory, { withFileTypes: true })) {
          const candidate = path.join(directory, entry.name);
          if (entry.isDirectory()) visit(candidate);
          else if (entry.isFile() && entry.name.includes(".partial-")) pending.push(candidate);
        }
      };
      visit(timestampOutput);
      assert.equal(pending.length, 1, `${profile} must expose exactly one in-progress Raw copy`);
      fsSync.utimesSync(pending[0], forcedCopyTime, forcedCopyTime);
    },
  });
  const timestampManifest = JSON.parse(await fs.readFile(result.manifestPath, "utf8"));
  const fallbackSession = timestampManifest.sessions.find((session) => session.session_id === fallbackSessionId);
  const metadataSession = timestampManifest.sessions.find((session) => session.session_id === metadataSessionId);
  assert.equal(fallbackSession.started_at, fallbackSourceTime.toISOString(), `${profile} must preserve the source-derived started_at fallback`);
  assert.equal(metadataSession.started_at, authoritativeMetadataTime, `${profile} must preserve authoritative session_meta timestamps`);
  assert.notEqual(metadataSession.started_at, metadataSourceTime.toISOString(), `${profile} must not replace session_meta with the source mtime`);

  const timestampHtml = await fs.readFile(result.htmlIndexPath, "utf8");
  assert.match(timestampHtml, new RegExp(fallbackSourceTime.toISOString()), `${profile} HTML index must use the source-derived started_at`);
  assert.match(timestampHtml, new RegExp(authoritativeMetadataTime), `${profile} HTML index must use the authoritative session_meta timestamp`);

  if (profile === "complete" || profile === "source-snapshots") {
    for (const session of [fallbackSession, metadataSession]) {
      const copiedStat = await fs.stat(path.join(timestampOutput, session.raw_export_file));
      assert.ok(Math.abs(copiedStat.mtimeMs - forcedCopyTime.getTime()) < 1_000, `${profile} fixture must retain the forced Raw-copy mtime`);
    }
  } else {
    assert.equal(fallbackSession.raw_export_file, "");
    assert.equal(metadataSession.raw_export_file, "");
  }

  if (profile === "source-snapshots") {
    assert.equal(await pathExists(path.join(timestampOutput, "index.md")), false);
  } else {
    const timestampMarkdownIndex = await fs.readFile(path.join(timestampOutput, "index.md"), "utf8");
    assert.match(timestampMarkdownIndex, new RegExp(fallbackSourceTime.toISOString()), `${profile} Markdown index must use the source-derived started_at`);
    assert.match(timestampMarkdownIndex, new RegExp(authoritativeMetadataTime), `${profile} Markdown index must use the authoritative session_meta timestamp`);
  }
}

async function listFiles(candidate) {
  const files = [];
  for (const entry of await fs.readdir(candidate, { withFileTypes: true })) {
    const child = path.join(candidate, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(child));
    else files.push(child);
  }
  return files;
}

assert.ok(html.includes(dangerousTitle), "HTML output must preserve the title independently of Markdown escaping");
assert.ok(html.includes("beta\rbare\nline\r\nend"), "HTML output must preserve project metadata independently of Markdown escaping");

const indexMarkdown = await fs.readFile(path.join(outputDir, "index.md"), "utf8");
const escapedTitle = String.raw`Escaping plain \| one\|two \\ slash\\\\ before\\\|pipe \\\\\|combo C:\\Temp\\file already\\\|escaped Unicode π`;
assert.ok(indexMarkdown.includes(escapedTitle), "Markdown index must completely escape table-cell content");

const titleRow = indexMarkdown.split("\n").find((line) => line.includes("Escaping plain"));
assert.ok(titleRow, "expected the synthetic title row in index.md");
assert.ok(
  titleRow.includes(`|  | ${escapedTitle} | active |`),
  "the complete escaped title must remain between the intended Markdown table delimiters",
);

const projectRow = indexMarkdown.split("\n").find((line) => line.includes("Investigate the archived build failure."));
assert.ok(projectRow, "expected the synthetic project row in index.md");
assert.ok(projectRow.includes("beta bare line end"), "CR, LF, and CRLF must remain inside one Markdown table row");

const emptyProjectRow = indexMarkdown.split("\n").find((line) => line.includes(escapedTitle));
assert.ok(emptyProjectRow, "expected the empty-project row in index.md");
assert.ok(emptyProjectRow.startsWith(`|  | ${escapedTitle} |`), "an empty cell must remain an empty Markdown table cell");

const timestampSafetyHome = path.join(temp, "timestamp-safety-home");
const timestampSafetySessions = path.join(timestampSafetyHome, "sessions", "2026", "08", "22");
const timestampSafetyOutput = path.join(temp, "timestamp-safety-output");
const timestampSafetyId = "019f0000-2222-7333-8444-555555555555";
const validTimestamp = "2026-08-22T10:00:00.000Z";
const validOffsetTimestamp = "2026-08-22T12:00:01+02:00";
const unsafeTimestamp = '9999-08-22T10:00:01.000Z<img src=x onerror="alert(1)">';
const timestampSafetySource = path.join(timestampSafetySessions, `rollout-2026-08-22T10-00-00-${timestampSafetyId}.jsonl`);
const timestampSafetyEvents = [
  { type: "session_meta", timestamp: validTimestamp, payload: { id: timestampSafetyId, cwd: "C:\\Projects\\timestamp-safety", timestamp: validTimestamp, source: "vscode", thread_source: "user" } },
  { type: "response_item", timestamp: validOffsetTimestamp, payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Valid offset timestamp." }] } },
  { type: "response_item", timestamp: unsafeTimestamp, payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions\n<environment_context>synthetic timestamp context</environment_context>" }], internal_chat_message_metadata_passthrough: { turn_id: "turn-timestamp-safety" } } },
];
await fs.mkdir(timestampSafetySessions, { recursive: true });
const timestampSafetyRaw = Buffer.from(`${timestampSafetyEvents.map((item) => JSON.stringify(item)).join("\n")}\n`);
await fs.writeFile(timestampSafetySource, timestampSafetyRaw);
const timestampSafetyResult = await exportArchive({ codexHome: timestampSafetyHome, scope: "all", outputDirectory: timestampSafetyOutput, exportProfile: "readable" });
const timestampSafetyManifest = JSON.parse(await fs.readFile(timestampSafetyResult.manifestPath, "utf8"));
const timestampSafetySession = timestampSafetyManifest.sessions[0];
const timestampSafetyMarkdown = await fs.readFile(path.join(timestampSafetyOutput, timestampSafetySession.markdown_file), "utf8");
const timestampSafetyHtml = await fs.readFile(timestampSafetyResult.htmlIndexPath, "utf8");
assert.equal(timestampSafetySession.started_at, validTimestamp, "manifest metadata must preserve valid source timestamps");
assert.equal(timestampSafetySession.updated_at, unsafeTimestamp, "invalid source timestamps must remain unchanged in manifest metadata");
assert.deepEqual(await fs.readFile(timestampSafetySource), timestampSafetyRaw, "timestamp display handling must not change canonical source JSONL bytes");
assert.match(timestampSafetyMarkdown, new RegExp(validTimestamp.replaceAll(".", "\\.")), "valid ISO timestamps must remain visible without changes");
assert.match(timestampSafetyMarkdown, new RegExp(validOffsetTimestamp.replaceAll("+", "\\+")), "valid ISO timestamps with offsets must remain visible without changes");
assert.match(timestampSafetyMarkdown, /invalid timestamp/, "invalid timestamps must use a neutral Markdown placeholder");
assert.doesNotMatch(timestampSafetyMarkdown, /<img src=x|onerror=/, "invalid timestamps must not inject HTML into Markdown reading views");
assert.match(timestampSafetyHtml, /invalid timestamp/, "invalid timestamps must use a neutral HTML index placeholder");
assert.doesNotMatch(timestampSafetyHtml, /<img src=x|onerror=/, "invalid timestamps must not reach HTML index markup or search data");

for (const session of manifest.sessions) {
  assert.ok((await fs.stat(path.join(outputDir, session.markdown_file))).size > 0);
  assert.ok((await fs.stat(path.join(outputDir, session.raw_export_file))).size > 0);
  assert.deepEqual(
    await fs.readFile(path.join(outputDir, session.raw_export_file)),
    await fs.readFile(session.source_jsonl),
    "raw JSONL copies must remain byte-for-byte equivalent",
  );
}

const generationHome = path.join(temp, "generation-home");
const generationSessions = path.join(generationHome, "sessions", "2026", "08", "22");
const generationSource = path.join(generationSessions, "rollout-generation.jsonl");
const generationOutput = path.join(temp, "generation-output");
const generationRaw = Buffer.from(jsonl([
  { type: "session_meta", timestamp: "2026-08-22T12:00:00.000Z", payload: { id: "generation-session", cwd: "C:\\Projects\\generation", timestamp: "2026-08-22T12:00:00.000Z", source: "vscode", thread_source: "user" } },
  { type: "response_item", timestamp: "2026-08-22T12:00:01.000Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Verify generation transactions." }] } },
]));
await fs.mkdir(generationSessions, { recursive: true });
await fs.writeFile(generationSource, generationRaw);
const generationDiagnostics = [];
const firstGeneration = await exportArchive({ codexHome: generationHome, scope: "all", outputDirectory: generationOutput, exportProfile: "complete", onDiagnostic: (event) => generationDiagnostics.push(event) });
assert.equal(await pathExists(path.join(generationOutput, INCOMPLETE_MARKER_NAME)), false, "a successful first export must remove its incomplete marker");
assert.equal(generationDiagnostics.filter((event) => event.event === "export_hash_start").length, 1, "the stable one-session export must perform exactly one published Raw hash pass");
const firstGenerationManifest = await fs.readFile(firstGeneration.manifestPath, "utf8");
const firstGenerationRecord = JSON.parse(firstGenerationManifest);
const repeatedGenerationDiagnostics = [];
const repeatedGeneration = await exportArchive({ codexHome: generationHome, scope: "all", outputDirectory: generationOutput, exportProfile: "complete", onDiagnostic: (event) => repeatedGenerationDiagnostics.push(event) });
assert.equal(await pathExists(path.join(generationOutput, INCOMPLETE_MARKER_NAME)), false, "a successful repetition export must remove its incomplete marker");
assert.deepEqual(await fs.readFile(path.join(generationOutput, JSON.parse(await fs.readFile(repeatedGeneration.manifestPath, "utf8")).sessions[0].raw_export_file)), generationRaw, "a repetition export must keep Raw bytes byte-identical");
assert.equal(await fs.readFile(repeatedGeneration.manifestPath, "utf8"), firstGenerationManifest, "an unchanged repetition must reuse verified identical files without replacing the previous generation");
assert.equal(repeatedGenerationDiagnostics.filter((event) => event.event === "export_hash_start").length, 1, "an unchanged repetition must still verify the published Raw path exactly once");
assert.notEqual(firstGenerationManifest, "", "the first generation manifest must be complete before repetition");

const additiveRootOutput = path.join(temp, "generation-additive-root-field");
await fs.cp(generationOutput, additiveRootOutput, { recursive: true });
const additiveRootManifestPath = path.join(additiveRootOutput, "manifest.json");
const additiveRootManifest = JSON.parse(await fs.readFile(additiveRootManifestPath, "utf8"));
additiveRootManifest.future_optional_metadata = { opaque: "ignored by version-1 consumers", path: "future.bin" };
const additiveRootManifestBytes = Buffer.from(`${JSON.stringify(additiveRootManifest, null, 2)}\n`, "utf8");
await fs.writeFile(additiveRootManifestPath, additiveRootManifestBytes);
const additiveRootProtection = Object.freeze({ rootCanonicalPaths: new Set(), fileCanonicalPaths: new Set(), fileIdentities: new Set() });
const additiveRootGeneration = await beginExportGeneration(additiveRootOutput, additiveRootProtection, { plannedPaths: [] });
assert.equal(await pathExists(path.join(additiveRootOutput, INCOMPLETE_MARKER_NAME)), true, "a version-1 consumer must tolerate unknown additive root-manifest fields");
await completeExportGeneration(additiveRootGeneration);
assert.equal(await pathExists(path.join(additiveRootOutput, INCOMPLETE_MARKER_NAME)), false, "the additive-field compatibility check must clean its run-owned marker");
assert.deepEqual(await fs.readFile(additiveRootManifestPath), additiveRootManifestBytes, "the version-1 consumer must ignore rather than rewrite unknown additive root fields");
await fs.writeFile(path.join(additiveRootOutput, "future.bin"), "foreign future file", "utf8");
await assert.rejects(
  () => beginExportGeneration(additiveRootOutput, additiveRootProtection, { plannedPaths: ["future.bin"] }),
  (error) => error?.code === "INVALID_PREVIOUS_MANIFEST" && /unexpected export path/.test(error.message),
  "an unknown additive root field must never authorize an additional generation path",
);
assert.equal(await pathExists(path.join(additiveRootOutput, INCOMPLETE_MARKER_NAME)), false, "rejected unknown-field path authorization must fail before generation mutation");

const repeatedRawPath = path.join(generationOutput, firstGenerationRecord.sessions[0].raw_export_file);
const repeatedRawBeforeProfileChange = await fs.readFile(repeatedRawPath);
await assert.rejects(
  () => exportArchive({ codexHome: generationHome, scope: "all", outputDirectory: generationOutput, exportProfile: "readable" }),
  (error) => error?.code === "EXPORT_DESTINATION_COLLISION",
);
assert.equal(await pathExists(path.join(generationOutput, INCOMPLETE_MARKER_NAME)), true, "a profile-changing repetition must remain visibly incomplete when existing files differ");
assert.deepEqual(await fs.readFile(repeatedRawPath), repeatedRawBeforeProfileChange, "a failed profile-changing repetition must not remove previous Raw files");
assert.equal(await fs.readFile(repeatedGeneration.manifestPath, "utf8"), firstGenerationManifest, "a failed repetition must not replace the previous manifest");

async function writePreviousManifest(output, mutate = () => {}) {
  const manifest = structuredClone(firstGenerationRecord);
  mutate(manifest);
  await fs.mkdir(output, { recursive: true });
  await fs.cp(path.join(generationOutput, "assets"), path.join(output, "assets"), { recursive: true });
  await fs.writeFile(path.join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

const missingAssetManifestOutput = path.join(temp, "generation-missing-asset-manifest");
await writePreviousManifest(missingAssetManifestOutput);
await fs.unlink(path.join(missingAssetManifestOutput, "assets", "manifest.json"));
await assert.rejects(
  () => exportArchive({ codexHome: generationHome, scope: "all", outputDirectory: missingAssetManifestOutput, exportProfile: "complete" }),
  (error) => error?.code === "INVALID_PREVIOUS_MANIFEST" && /missing asset manifest/.test(error.message),
);
assert.equal(await pathExists(path.join(missingAssetManifestOutput, INCOMPLETE_MARKER_NAME)), false, "invalid previous asset metadata must fail before generation mutation");

const invalidAssetUsageOutput = path.join(temp, "generation-invalid-asset-usage");
await writePreviousManifest(invalidAssetUsageOutput);
const invalidAssetUsagePath = path.join(invalidAssetUsageOutput, "assets", "manifest.json");
const invalidAssetUsageManifest = JSON.parse(await fs.readFile(invalidAssetUsagePath, "utf8"));
const invalidAssetBytes = Buffer.from("synthetic invalid previous asset");
const invalidAssetHash = createHash("sha256").update(invalidAssetBytes).digest("hex");
invalidAssetUsageManifest.assets.push({
  sha256: invalidAssetHash,
  path: `assets/${invalidAssetHash}.bin`,
  mime_type: "application/octet-stream",
  extension: "bin",
  bytes: invalidAssetBytes.length,
  renderable: false,
  uses: [{ attachment_ordinal: 1, record_ordinal: 1, session_id: "synthetic-session", source_path: "C:\\private\\source" }],
});
await fs.writeFile(path.join(invalidAssetUsageOutput, ...invalidAssetUsageManifest.assets[0].path.split("/")), invalidAssetBytes);
await fs.writeFile(invalidAssetUsagePath, `${JSON.stringify(invalidAssetUsageManifest, null, 2)}\n`, "utf8");
await assert.rejects(
  () => exportArchive({ codexHome: generationHome, scope: "all", outputDirectory: invalidAssetUsageOutput, exportProfile: "complete" }),
  (error) => error?.code === "INVALID_PREVIOUS_MANIFEST" && /invalid asset record/.test(error.message),
);

const invalidAssetSummaryOutput = path.join(temp, "generation-invalid-asset-summary");
await writePreviousManifest(invalidAssetSummaryOutput, (previousManifest) => { previousManifest.asset_occurrences += 1; });
await assert.rejects(
  () => exportArchive({ codexHome: generationHome, scope: "all", outputDirectory: invalidAssetSummaryOutput, exportProfile: "complete" }),
  (error) => error?.code === "INVALID_PREVIOUS_MANIFEST" && /summaries/.test(error.message),
);

const unownedAssetOutput = path.join(temp, "generation-unowned-asset");
await writePreviousManifest(unownedAssetOutput);
const unownedAssetPath = path.join(unownedAssetOutput, "assets", "foreign.bin");
await fs.writeFile(unownedAssetPath, "foreign asset", "utf8");
await assert.rejects(
  () => exportArchive({ codexHome: generationHome, scope: "all", outputDirectory: unownedAssetOutput, exportProfile: "complete" }),
  (error) => ["INVALID_PREVIOUS_MANIFEST", "UNOWNED_EXPORT_FILE"].includes(error?.code),
);
assert.equal(await fs.readFile(unownedAssetPath, "utf8"), "foreign asset", "unowned asset files must remain untouched");

const forgedRawOutput = path.join(temp, "generation-forged-raw");
const forgedRawManifest = await writePreviousManifest(forgedRawOutput);
const forgedRawPath = path.join(forgedRawOutput, forgedRawManifest.sessions[0].raw_export_file);
const forgedRawBytes = Buffer.from("foreign raw bytes\n");
await fs.mkdir(path.dirname(forgedRawPath), { recursive: true });
await fs.writeFile(forgedRawPath, forgedRawBytes);
await assert.rejects(
  () => exportArchive({ codexHome: generationHome, scope: "all", outputDirectory: forgedRawOutput, exportProfile: "complete" }),
  (error) => error?.code === "EXPORT_DESTINATION_COLLISION",
);
assert.deepEqual(await fs.readFile(forgedRawPath), forgedRawBytes, "a forged manifest must not authorize replacing or deleting a foreign Raw file");
assert.deepEqual(await fs.readFile(generationSource), generationRaw, "a forged Raw manifest must not change the source session");
assert.equal(await pathExists(path.join(forgedRawOutput, INCOMPLETE_MARKER_NAME)), true, "a forged Raw collision must leave the generation incomplete");
assert.equal((await listFiles(forgedRawOutput)).some((file) => /\.(?:partial|previous|failed)-/.test(path.basename(file))), false, "a failed Raw collision must clean only its current-run temporary files");

const forgedMarkdownOutput = path.join(temp, "generation-forged-markdown");
const forgedMarkdownManifest = await writePreviousManifest(forgedMarkdownOutput, (manifest) => {
  manifest.canonical_representation_included = false;
  manifest.export_profile = "readable";
  manifest.formats.raw = false;
  manifest.sessions[0].raw_export_file = "";
  manifest.sessions[0].raw_export_name = "";
});
const forgedMarkdownPath = path.join(forgedMarkdownOutput, forgedMarkdownManifest.sessions[0].markdown_file);
const forgedMarkdownBytes = Buffer.from("foreign markdown bytes\n");
await fs.mkdir(path.dirname(forgedMarkdownPath), { recursive: true });
await fs.writeFile(forgedMarkdownPath, forgedMarkdownBytes);
await assert.rejects(
  () => exportArchive({ codexHome: generationHome, scope: "all", outputDirectory: forgedMarkdownOutput, exportProfile: "readable" }),
  (error) => error?.code === "EXPORT_DESTINATION_COLLISION",
);
assert.deepEqual(await fs.readFile(forgedMarkdownPath), forgedMarkdownBytes, "a forged manifest must not authorize replacing or deleting a foreign Markdown file");
assert.deepEqual(await fs.readFile(generationSource), generationRaw, "a forged Markdown manifest must not change the source session");

const forgedStaleOutput = path.join(temp, "generation-forged-stale");
const staleRawRelative = "raw/foreign/customer-private.jsonl";
const staleMarkdownRelative = "markdown/foreign/customer-private.md";
await writePreviousManifest(forgedStaleOutput, (manifest) => {
  manifest.sessions.push({ raw_export_file: staleRawRelative, markdown_file: staleMarkdownRelative });
});
const staleRawPath = path.join(forgedStaleOutput, staleRawRelative);
const staleMarkdownPath = path.join(forgedStaleOutput, staleMarkdownRelative);
await fs.mkdir(path.dirname(staleRawPath), { recursive: true });
await fs.mkdir(path.dirname(staleMarkdownPath), { recursive: true });
await fs.writeFile(staleRawPath, "foreign stale raw\n", "utf8");
await fs.writeFile(staleMarkdownPath, "foreign stale markdown\n", "utf8");
await assert.rejects(() => exportArchive({ codexHome: generationHome, scope: "all", outputDirectory: forgedStaleOutput, exportProfile: "complete" }));
assert.equal(await fs.readFile(staleRawPath, "utf8"), "foreign stale raw\n", "a formally valid foreign Raw path in a prior manifest must not be deleted as stale");
assert.equal(await fs.readFile(staleMarkdownPath, "utf8"), "foreign stale markdown\n", "a formally valid foreign Markdown path in a prior manifest must not be deleted as stale");

const exporterLikeOutput = path.join(temp, "generation-exporter-like-foreign");
await writePreviousManifest(exporterLikeOutput, (manifest) => { manifest.sessions = []; });
const exporterLikePath = path.join(exporterLikeOutput, firstGenerationRecord.sessions[0].raw_export_file);
await fs.mkdir(path.dirname(exporterLikePath), { recursive: true });
await fs.writeFile(exporterLikePath, "foreign exporter-like file\n", "utf8");
await assert.rejects(
  () => exportArchive({ codexHome: generationHome, scope: "all", outputDirectory: exporterLikeOutput, exportProfile: "complete" }),
  (error) => error?.code === "UNOWNED_EXPORT_FILE",
);
assert.equal(await fs.readFile(exporterLikePath, "utf8"), "foreign exporter-like file\n", "an exporter-like filename is not evidence of current-run ownership");
assert.equal(await pathExists(path.join(exporterLikeOutput, INCOMPLETE_MARKER_NAME)), false, "an undescribed collision must fail before marker publication");

const emptyProtection = Object.freeze({ rootCanonicalPaths: new Set(), fileCanonicalPaths: new Set(), fileIdentities: new Set() });
const afterMarkerOutput = path.join(temp, "generation-after-marker");
await fs.mkdir(afterMarkerOutput, { recursive: true });
await beginExportGeneration(afterMarkerOutput, emptyProtection, { plannedPaths: ["manifest.json", "README.txt"] });
assert.equal(await pathExists(path.join(afterMarkerOutput, INCOMPLETE_MARKER_NAME)), true, "an error after marker publication and before Raw publication must leave the marker");

const afterRawOutput = path.join(temp, "generation-after-raw");
await fs.mkdir(afterRawOutput, { recursive: true });
await beginExportGeneration(afterRawOutput, emptyProtection, { plannedPaths: ["manifest.json", "README.txt", "raw/p001/s0001.jsonl"] });
await fs.mkdir(path.join(afterRawOutput, "raw", "p001"), { recursive: true });
await fs.writeFile(path.join(afterRawOutput, "raw", "p001", "s0001.jsonl"), generationRaw);
assert.equal(await pathExists(path.join(afterRawOutput, INCOMPLETE_MARKER_NAME)), true, "an error after Raw publication must leave the generation invalid");

const publicationRaceOutput = path.join(temp, "generation-publication-race");
const publicationRaceDestination = path.join(publicationRaceOutput, "raw", "p001", "s0001.jsonl");
await fs.mkdir(publicationRaceOutput, { recursive: true });
const publicationRaceGeneration = await beginExportGeneration(publicationRaceOutput, emptyProtection, { plannedPaths: ["manifest.json", "README.txt", "raw/p001/s0001.jsonl"] });
let injectedPublicationCollision = false;
await assert.rejects(() => copyStableRawSnapshot(generationSource, publicationRaceDestination, {
  generation: publicationRaceGeneration,
  maxAttempts: 1,
  io: {
    async link(temporaryPath, destinationPath) {
      injectedPublicationCollision = true;
      await fs.writeFile(destinationPath, "foreign publication-race file\n", "utf8");
      return fs.link(temporaryPath, destinationPath);
    },
  },
}));
assert.equal(injectedPublicationCollision, true, "the synthetic race must place a foreign file immediately before exclusive publication");
assert.equal(await fs.readFile(publicationRaceDestination, "utf8"), "foreign publication-race file\n", "exclusive publication must not replace or clean up the foreign collision");
assert.deepEqual(await fs.readFile(generationSource), generationRaw, "an exclusive publication collision must leave the source byte-identical");
assert.equal(await pathExists(path.join(publicationRaceOutput, INCOMPLETE_MARKER_NAME)), true, "a publication collision must leave the generation incomplete");
assert.equal((await listFiles(publicationRaceOutput)).some((file) => /\.partial-/.test(path.basename(file))), false, "the failed publication must remove only its current-run temporary file");

const afterManifestOutput = path.join(temp, "generation-after-manifest");
await fs.mkdir(afterManifestOutput, { recursive: true });
await beginExportGeneration(afterManifestOutput, emptyProtection, { plannedPaths: ["manifest.json", "README.txt"] });
await fs.writeFile(path.join(afterManifestOutput, "manifest.json"), "{}\n", "utf8");
assert.equal(await pathExists(path.join(afterManifestOutput, INCOMPLETE_MARKER_NAME)), true, "a published manifest is not a commit while the marker remains");

const completedMarkerOutput = path.join(temp, "generation-complete-helper");
await fs.mkdir(completedMarkerOutput, { recursive: true });
const completedGeneration = await beginExportGeneration(completedMarkerOutput, emptyProtection, { plannedPaths: ["manifest.json", "README.txt"] });
await completeExportGeneration(completedGeneration);
assert.equal(await pathExists(path.join(completedMarkerOutput, INCOMPLETE_MARKER_NAME)), false, "only the identity-bound completion step removes the marker");

const replacedMarkerOutput = path.join(temp, "generation-replaced-marker");
await fs.mkdir(replacedMarkerOutput, { recursive: true });
const replacedMarkerGeneration = await beginExportGeneration(replacedMarkerOutput, emptyProtection, { plannedPaths: ["manifest.json", "README.txt"] });
const movedMarker = path.join(replacedMarkerOutput, "moved-marker.txt");
await fs.rename(path.join(replacedMarkerOutput, INCOMPLETE_MARKER_NAME), movedMarker);
await fs.writeFile(path.join(replacedMarkerOutput, INCOMPLETE_MARKER_NAME), "foreign replacement", "utf8");
await assert.rejects(() => completeExportGeneration(replacedMarkerGeneration), (error) => error?.code === "UNSAFE_EXPORT_PATH");
assert.equal(await fs.readFile(path.join(replacedMarkerOutput, INCOMPLETE_MARKER_NAME), "utf8"), "foreign replacement", "an identity-mismatched marker must not be removed");

const existingMarkerOutput = path.join(temp, "generation-existing-marker");
await fs.mkdir(existingMarkerOutput, { recursive: true });
await fs.writeFile(path.join(existingMarkerOutput, INCOMPLETE_MARKER_NAME), "existing incomplete export", "utf8");
await assert.rejects(() => exportArchive({ codexHome: generationHome, scope: "all", outputDirectory: existingMarkerOutput, exportProfile: "complete" }), (error) => error?.code === "INCOMPLETE_EXPORT_EXISTS" && /new empty output folder/i.test(error.message));

const foreignOutput = path.join(temp, "generation-foreign-file");
await fs.mkdir(foreignOutput, { recursive: true });
await fs.writeFile(path.join(foreignOutput, "index.html"), "foreign index", "utf8");
await assert.rejects(() => exportArchive({ codexHome: generationHome, scope: "all", outputDirectory: foreignOutput, exportProfile: "complete" }), (error) => error?.code === "UNOWNED_EXPORT_FILE");
assert.equal(await fs.readFile(path.join(foreignOutput, "index.html"), "utf8"), "foreign index", "a foreign same-named file must remain unchanged");
assert.equal(await pathExists(path.join(foreignOutput, INCOMPLETE_MARKER_NAME)), false, "preflight failures must occur before marker publication");

const beforeRawFailureOutput = path.join(temp, "generation-before-raw-failure");
const beforeRawFailurePath = path.join(beforeRawFailureOutput, firstGenerationRecord.sessions[0].raw_export_file);
await fs.mkdir(path.dirname(beforeRawFailurePath), { recursive: true });
await fs.writeFile(beforeRawFailurePath, "foreign path blocker", "utf8");
await assert.rejects(
  () => exportArchive({ codexHome: generationHome, scope: "all", outputDirectory: beforeRawFailureOutput, exportProfile: "complete" }),
  (error) => error?.code === "UNOWNED_EXPORT_FILE",
);
assert.equal(await pathExists(path.join(beforeRawFailureOutput, INCOMPLETE_MARKER_NAME)), false, "a Raw collision rejected before the first mutation must not publish an incomplete marker");
assert.equal(await fs.readFile(beforeRawFailurePath, "utf8"), "foreign path blocker", "a preflight rejection must not alter the foreign Raw collision");
assert.equal(await pathExists(path.join(beforeRawFailureOutput, "manifest.json")), false);

const afterMarkerRawFailureOutput = path.join(temp, "generation-after-marker-raw-failure");
const afterMarkerBlockerPath = path.join(afterMarkerRawFailureOutput, path.dirname(firstGenerationRecord.sessions[0].raw_export_file));
await fs.mkdir(afterMarkerRawFailureOutput, { recursive: true });
let afterMarkerBlockerCreated = false;
await assert.rejects(
  () => exportArchive({
    codexHome: generationHome,
    scope: "all",
    outputDirectory: afterMarkerRawFailureOutput,
    exportProfile: "complete",
    progressThrottleMs: 0,
    onProgress(event) {
      if (event.phase !== "snapshot" || afterMarkerBlockerCreated) return;
      fsSync.writeFileSync(afterMarkerBlockerPath, "foreign path blocker", "utf8");
      afterMarkerBlockerCreated = true;
    },
  }),
  (error) => error?.code === "EEXIST",
);
assert.equal(afterMarkerBlockerCreated, true, "the synthetic failure must be injected only after marker publication");
assert.equal(await pathExists(path.join(afterMarkerRawFailureOutput, INCOMPLETE_MARKER_NAME)), true, "a real export failure after marker publication but before Raw publication must leave the marker");
assert.equal(await fs.readFile(afterMarkerBlockerPath, "utf8"), "foreign path blocker", "the exporter must not delete the post-marker foreign blocker");
assert.deepEqual(await fs.readFile(generationSource), generationRaw, "the post-marker failure must leave the source byte-identical");
assert.equal(await pathExists(path.join(afterMarkerRawFailureOutput, "manifest.json")), false);

const partialHome = path.join(temp, "generation-partial-home");
const partialSessions = path.join(partialHome, "sessions", "2026", "08", "22");
const partialOutput = path.join(temp, "generation-partial-output");
const partialSourceA = path.join(partialSessions, "rollout-a.jsonl");
const partialSourceB = path.join(partialSessions, "rollout-b.jsonl");
const partialMovedB = `${partialSourceB}.moved`;
const partialRawA = Buffer.from(jsonl([{ type: "session_meta", timestamp: "2026-08-22T13:00:00.000Z", payload: { id: "partial-a", cwd: "C:\\Projects\\partial", timestamp: "2026-08-22T13:00:00.000Z" } }]));
const partialRawB = Buffer.from(jsonl([{ type: "session_meta", timestamp: "2026-08-22T13:01:00.000Z", payload: { id: "partial-b", cwd: "C:\\Projects\\partial", timestamp: "2026-08-22T13:01:00.000Z" } }]));
await fs.mkdir(partialSessions, { recursive: true });
await fs.writeFile(partialSourceA, partialRawA);
await fs.writeFile(partialSourceB, partialRawB);
let movedSecondSource = false;
await assert.rejects(() => exportArchive({
  codexHome: partialHome,
  scope: "all",
  outputDirectory: partialOutput,
  exportProfile: "source-snapshots",
  onDiagnostic(event) {
    if (!movedSecondSource && event.event === "session_end" && event.ordinal === 1) {
      fsSync.renameSync(partialSourceB, partialMovedB);
      movedSecondSource = true;
    }
  },
}));
assert.equal(movedSecondSource, true);
assert.equal(await pathExists(path.join(partialOutput, INCOMPLETE_MARKER_NAME)), true, "a failure after one published Raw file must keep the marker");
assert.equal((await listFiles(path.join(partialOutput, "raw"))).length, 1, "the synthetic failure must occur after exactly one Raw publication");
assert.deepEqual(await fs.readFile(partialSourceA), partialRawA, "the exporter must not change the first source");
await fs.rename(partialMovedB, partialSourceB);
assert.deepEqual(await fs.readFile(partialSourceB), partialRawB, "the externally moved second source remains byte-identical");

const postManifestOutput = path.join(temp, "generation-post-manifest-failure");
const displacedOwnedMarker = path.join(postManifestOutput, "displaced-run-marker.txt");
let replacedMarkerAfterManifest = false;
await assert.rejects(() => exportArchive({
  codexHome: generationHome,
  scope: "all",
  outputDirectory: postManifestOutput,
  exportProfile: "complete",
  onDiagnostic(event) {
    if (!replacedMarkerAfterManifest && event.event === "manifest_end") {
      fsSync.renameSync(path.join(postManifestOutput, INCOMPLETE_MARKER_NAME), displacedOwnedMarker);
      fsSync.writeFileSync(path.join(postManifestOutput, INCOMPLETE_MARKER_NAME), "foreign replacement after manifest", "utf8");
      replacedMarkerAfterManifest = true;
    }
  },
}), (error) => error?.code === "UNSAFE_EXPORT_PATH");
assert.equal(replacedMarkerAfterManifest, true);
assert.equal(await pathExists(path.join(postManifestOutput, "manifest.json")), true, "the synthetic fault must occur after manifest publication");
assert.equal(await fs.readFile(path.join(postManifestOutput, INCOMPLETE_MARKER_NAME), "utf8"), "foreign replacement after manifest", "a foreign marker replacement must remain untouched");
assert.equal(await pathExists(displacedOwnedMarker), true, "the exporter must not search for or delete the displaced run-owned marker");

for (const [name, maliciousPath] of [
  ["traversal", "raw/../private.jsonl"],
  ["absolute", path.resolve(temp, "outside.jsonl")],
  ["unexpected", "documents/private.txt"],
]) {
  const maliciousOutput = path.join(temp, `generation-malicious-${name}`);
  await fs.mkdir(maliciousOutput, { recursive: true });
  const maliciousManifest = { archive_format_version: 1, formats: { raw: true, markdown: false, html: true }, sessions: [{ raw_export_file: maliciousPath, markdown_file: "" }] };
  await fs.writeFile(path.join(maliciousOutput, "manifest.json"), `${JSON.stringify(maliciousManifest)}\n`, "utf8");
  await assert.rejects(() => beginExportGeneration(maliciousOutput, emptyProtection, { plannedPaths: ["manifest.json", "README.txt"] }), (error) => error?.code === "INVALID_PREVIOUS_MANIFEST");
  assert.equal(await pathExists(path.join(maliciousOutput, INCOMPLETE_MARKER_NAME)), false, `the ${name} manifest must fail before marker publication`);
}

const markerText = await fs.readFile(path.join(afterMarkerOutput, INCOMPLETE_MARKER_NAME), "utf8");
assert.doesNotMatch(markerText, /generation-home|generation-after-marker|Codex-Exporter-Test|Users[\\/]|Verify generation transactions/i, "the marker must not contain session content or local paths");
assert.match(markerText, /Status: INCOMPLETE/);

const hardAbortOutput = path.join(temp, "generation-hard-abort");
await fs.mkdir(hardAbortOutput, { recursive: true });
const hardAbortScript = [
  `import fs from "node:fs/promises";`,
  `import path from "node:path";`,
  `import { beginExportGeneration } from ${JSON.stringify(pathToFileURL(script).href)};`,
  `const output = ${JSON.stringify(hardAbortOutput)};`,
  `const protection = { rootCanonicalPaths: new Set(), fileCanonicalPaths: new Set(), fileIdentities: new Set() };`,
  `await beginExportGeneration(output, protection, { plannedPaths: ["manifest.json", "README.txt", "raw/p001/s0001.jsonl"] });`,
  `await fs.mkdir(path.join(output, "raw", "p001"), { recursive: true });`,
  `await fs.writeFile(path.join(output, "raw", "p001", "s0001.jsonl"), "synthetic raw\\n", "utf8");`,
  `process.exit(23);`,
].join("\n");
await assert.rejects(() => execFileAsync(process.execPath, ["--input-type=module", "--eval", hardAbortScript], { cwd: temp }), (error) => error?.code === 23);
assert.equal(await pathExists(path.join(hardAbortOutput, INCOMPLETE_MARKER_NAME)), true, "a hard process exit after publication must leave the incomplete marker");
assert.equal(await pathExists(path.join(hardAbortOutput, "manifest.json")), false, "a hard process exit before commit must not create a valid-looking manifest");

const mutableRawPath = path.join(outputDir, activeSession.raw_export_file);
const recordedRawHash = activeSession.raw_sha256;
await fs.appendFile(mutableRawPath, "later change", "utf8");
assert.notEqual(await sha256File(mutableRawPath), recordedRawHash, "raw_sha256 must detect changes made after export-time verification");
const persistedManifest = JSON.parse(await fs.readFile(path.join(outputDir, "manifest.json"), "utf8"));
const persistedActiveSession = persistedManifest.sessions.find((session) => session.session_id === activeSession.session_id);
assert.equal(persistedActiveSession.raw_copy_status, "VERIFIED_AT_EXPORT", "the status must remain an explicitly historical export-time statement");
assert.equal(persistedActiveSession.raw_verified_at, activeSession.raw_verified_at);
assert.equal(persistedActiveSession.raw_sha256, recordedRawHash);
assert.equal(retiredContinuingIntegrityField in persistedActiveSession, false);

await fs.rm(temp, { recursive: true, force: true });
console.log("exporter integration tests passed");
