import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { exportArchive, readSessionRoutingMeta, sha256File } from "../bin/export-codex-project-chats.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const retiredContinuingIntegrityField = ["raw", "integrity", "verified"].join("_");
const retiredImportReadinessField = ["import", "ready"].join("_");
const script = path.join(repoRoot, "bin", "export-codex-project-chats.mjs");
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "codex-exporter-test-"));
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

const projectList = await execFileAsync(process.execPath, [script, "--codex-home", codexHome, "--list"], { cwd: temp });
assert.match(projectList.stdout, /C:\\Projects\\alpha \(5: 3 active, 2 archived\)/);

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
assert.equal((activeMarkdown.match(/^## User - /gm) || []).length, 2);
assert.equal((activeMarkdown.match(/^## Assistant - /gm) || []).length, 2);
assert.equal((activeMarkdown.match(/<summary>Automatic runtime context/g) || []).length, 3);
assert.match(activeMarkdown, /Create the release archive/);
assert.match(activeMarkdown, /literal terms AGENTS\.md and <environment_context>/);
const subagentMarkdown = await fs.readFile(path.join(outputDir, subagentSession.markdown_file), "utf8");
assert.doesNotMatch(subagentMarkdown, /^## User - /m);
assert.match(subagentMarkdown, /<summary>Subagent input \/ parent-agent handoff/);
assert.match(subagentMarkdown, /\[1\] user: retained parent material/);
assert.match(subagentMarkdown, /\[7\] assistant: retained parent material/);

const html = await fs.readFile(path.join(outputDir, "index.html"), "utf8");
assert.match(html, /id="filter"/);
assert.match(html, /archived/);
assert.match(html, /gpt-test/);
assert.match(html, /<th>Raw<\/th>/, "raw-enabled HTML indexes should include the Raw column");
assert.match(html, /href="raw\//, "raw-enabled HTML indexes should link to current raw snapshots");

const apiOutputDir = path.join(temp, "api-output");
const apiProfilePath = path.join(temp, "api-performance-profile.json");
const apiResult = await exportArchive({ codexHome, scope: "project", workspacePath: "C:\\Projects\\alpha", outputDirectory: apiOutputDir, includeOriginalJsonl: false, performanceProfilePath: apiProfilePath });
assert.equal(apiResult.exportedSessionCount, 5);
assert.equal(apiResult.exportedProjectCount, 1);
assert.equal(apiResult.activeSessionCount, 3);
assert.equal(apiResult.archivedSessionCount, 2);
assert.ok(apiResult.htmlIndexPath.endsWith("index.html"));
assert.ok(apiResult.manifestPath.endsWith("manifest.json"));
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

const protectedSource = path.join(activeDir, "rollout-active.jsonl");
const protectedSourceHash = await sha256File(protectedSource);
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
const markdownAliasPath = path.join(markdownAliasOutput, activeSession.markdown_file);
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
assert.equal(apiProfile.counts.exported_sessions, 5);
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
  path.join(activeDir, "rollout-empty-project.jsonl"),
  path.join(activeDir, "rollout-subagent.jsonl"),
  path.join(activeDir, "rollout-no-user.jsonl"),
  path.join(archivedDir, "rollout-archived.jsonl"),
  path.join(archivedDir, "rollout-archived-same-project.jsonl"),
  path.join(archivedDir, `rollout-2026-05-10T08-00-00-${malformedArchivedId}.jsonl`),
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
assert.deepEqual(profiledRawManifest.sessions.map(semanticSession), manifest.sessions.filter((session) => session.project === "C:\\Projects\\alpha").map(semanticSession), "routing preflight must preserve selected-session manifest semantics");
const uncertainRoutingFallbackBytes = (await fs.stat(path.join(activeDir, "rollout-empty-project.jsonl"))).size;
assert.equal(profiledRaw.phases.parse_and_classify.bytes_read, profiledRawManifest.sessions.reduce((sum, session) => sum + session.raw_size_bytes, 0) + uncertainRoutingFallbackBytes, "raw exports should parse accepted snapshots once while retaining the conservative full-parser fallback for uncertain routing metadata");
assert.ok(profiledRaw.phases.routing.bytes_read > profiledRaw.phases.parse_and_classify.bytes_read, "routing should scan all source bytes without fully classifying unselected sessions");
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
assert.deepEqual(progressEvents.map((event) => event.phase).filter((phase, index, phases) => index === 0 || phase !== phases[index - 1]), ["discovery", "routing", "snapshot", "processing", "writing", "complete"]);
assert.ok(progressEvents.some((event) => event.message === `Processing session ${sourceSnapshotsManifest.sessions.length} of ${sourceSnapshotsManifest.sessions.length}`));
assert.doesNotMatch(JSON.stringify(progressEvents), /Projects|codex-exporter-test/, "progress events must not expose project names or full paths");
for (const event of ["core_start", "discovery_start", "discovery_end", "routing_start", "routing_hash_end", "routing_end", "session_start", "snapshot_attempt_start", "source_hash_reused", "snapshot_copy_start", "snapshot_copy_end", "export_hash_start", "export_hash_end", "snapshot_stability_check", "snapshot_attempt_end", "session_end", "index_start", "index_end", "manifest_start", "manifest_end", "verification_start", "verification_end", "core_end"]) {
  assert.ok(diagnosticEvents.some((entry) => entry.event === event), `diagnostic trace should contain ${event}`);
}
assert.equal(diagnosticEvents.filter((event) => event.event === "routing_hash_end").length, diagnosticEvents.find((event) => event.event === "discovery_end").scanned_sessions, "each scanned source must be hashed exactly once by routing");
assert.equal(diagnosticEvents.filter((event) => event.event === "source_hash_start").length, 0, "stable selected sources must not receive a second source hash pass");
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
assert.deepEqual(completeProgress.map((event) => event.phase).filter((phase, index, phases) => index === 0 || phase !== phases[index - 1]), ["discovery", "routing", "snapshot", "processing", "rendering", "writing", "complete"], "complete-profile progress phases must be ordered and finite");
assert.equal(completeDiagnostics.filter((event) => event.event === "source_hash_start").length, 0, "complete exports must reuse stable routing hashes");
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
const routedMeta = await readSessionRoutingMeta(routerSource);
assert.equal(routedMeta.id, "router-session");
assert.equal(routedMeta.cwd, "C:\\Projects\\router");
const fallbackSource = path.join(temp, "router-json-parse-fallback.jsonl");
await fs.writeFile(fallbackSource, '{"type":"event_msg","type":"session_meta","payload":{"id":"fallback-session","cwd":"C:\\\\Projects\\\\fallback"}}\n', "utf8");
const fallbackMeta = await readSessionRoutingMeta(fallbackSource);
assert.equal(fallbackMeta.id, "fallback-session", "an uncertain structured scan must fall back to full JSON parsing");
assert.equal(fallbackMeta.cwd, "C:\\Projects\\fallback");
const routerOutput = path.join(temp, "router-output");
const routerResult = await exportArchive({ codexHome: routerHome, scope: "all", outputDirectory: routerOutput, exportProfile: "complete" });
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

for (const session of manifest.sessions) {
  assert.ok((await fs.stat(path.join(outputDir, session.markdown_file))).size > 0);
  assert.ok((await fs.stat(path.join(outputDir, session.raw_export_file))).size > 0);
  assert.deepEqual(
    await fs.readFile(path.join(outputDir, session.raw_export_file)),
    await fs.readFile(session.source_jsonl),
    "raw JSONL copies must remain byte-for-byte equivalent",
  );
}

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
