import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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

function jsonl(items) {
  return `${items.map((item) => JSON.stringify(item)).join("\n")}\n`;
}

await fs.writeFile(path.join(activeDir, "rollout-active.jsonl"), jsonl([
  { type: "session_meta", timestamp: "2026-07-20T10:00:00.000Z", payload: { id: "session-active", cwd: "C:\\Projects\\alpha", timestamp: "2026-07-20T10:00:00.000Z" } },
  { type: "turn_context", timestamp: "2026-07-20T10:00:01.000Z", payload: { cwd: "C:\\Projects\\alpha", model: "gpt-test" } },
  { type: "response_item", timestamp: "2026-07-20T10:00:02.000Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Create the release archive." }] } },
  { type: "response_item", timestamp: "2026-07-20T10:00:03.000Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] } },
]));

await fs.writeFile(path.join(activeDir, "rollout-empty-project.jsonl"), jsonl([
  { type: "session_meta", timestamp: "2026-07-19T10:00:00.000Z", payload: { id: "session-empty-project", timestamp: "2026-07-19T10:00:00.000Z" } },
  { type: "response_item", timestamp: "2026-07-19T10:00:01.000Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "No project metadata." }] } },
]));

await fs.writeFile(path.join(archivedDir, "rollout-archived.jsonl"), jsonl([
  { type: "session_meta", timestamp: "2026-06-01T08:00:00.000Z", payload: { id: "session-archived", cwd: dangerousProject, timestamp: "2026-06-01T08:00:00.000Z" } },
  { type: "response_item", timestamp: "2026-06-01T08:00:02.000Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Investigate the archived build failure.\nDetails follow." }] } },
  { type: "response_item", timestamp: "2026-06-01T08:00:03.000Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Investigating." }] } },
]));

await fs.writeFile(path.join(archivedDir, "rollout-archived-same-project.jsonl"), jsonl([
  { type: "session_meta", timestamp: "2026-05-15T08:00:00.000Z", payload: { id: "session-archived-same-project", cwd: "C:\\Projects\\alpha", timestamp: "2026-05-15T08:00:00.000Z" } },
  { type: "response_item", timestamp: "2026-05-15T08:00:02.000Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Release archive" }] } },
  { type: "response_item", timestamp: "2026-05-15T08:00:03.000Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Archived copy." }] } },
]));


const malformedArchivedId = "019f0000-1111-7222-8333-444444444444";
await fs.writeFile(path.join(archivedDir, `rollout-2026-05-10T08-00-00-${malformedArchivedId}.jsonl`), jsonl([
  { type: "response_item", timestamp: "2026-05-10T08:00:01.000Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Release archive" }] } },
  { type: "turn_context", timestamp: "2026-05-10T08:00:02.000Z", payload: { cwd: "C:\\Projects\\alpha", model: "gpt-test" } },
  { type: "response_item", timestamp: "2026-05-10T08:00:03.000Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Recovered from filename metadata." }] } },
]));

await fs.writeFile(path.join(codexHome, "session_index.jsonl"), [
  JSON.stringify({ id: "session-active", thread_name: dangerousTitle, updated_at: "2026-07-20T10:00:03.000Z" }),
  JSON.stringify({ id: "session-archived-same-project", thread_name: "Release archive", updated_at: "2026-05-15T08:00:03.000Z" }),
  JSON.stringify({ id: malformedArchivedId, thread_name: "Release archive", updated_at: "2026-05-10T08:00:03.000Z" }),
].join("\n") + "\n");

const projectList = await execFileAsync(process.execPath, [script, "--codex-home", codexHome, "--list"], { cwd: temp });
assert.match(projectList.stdout, /C:\\Projects\\alpha \(3: 1 active, 2 archived\)/);

const sessionList = await execFileAsync(process.execPath, [script, "--codex-home", codexHome, "--list-sessions"], { cwd: temp });
assert.match(sessionList.stdout, /\[active\] Escaping plain/);
assert.match(sessionList.stdout, /\[archived\] Release archive \| C:\\Projects\\alpha/);
assert.match(sessionList.stdout, new RegExp(`\\[archived\\].*${malformedArchivedId}`));

const diagnostics = await execFileAsync(process.execPath, [script, "--codex-home", codexHome, "--diagnose"], { cwd: temp });
assert.match(diagnostics.stdout, /Archived directory:/);
assert.match(diagnostics.stdout, /JSONL files found: 3/);
assert.match(diagnostics.stdout, /no session_meta record found/);

await execFileAsync(process.execPath, [script, "--codex-home", codexHome, "--all", "--out", outputDir], { cwd: temp });

const manifest = JSON.parse(await fs.readFile(path.join(outputDir, "manifest.json"), "utf8"));
assert.equal(manifest.sessions.length, 5);
assert.deepEqual(manifest.sessions.map((session) => session.storage).sort(), ["active", "active", "archived", "archived", "archived"]);
assert.equal(manifest.sessions.find((session) => session.session_id === "session-active").title, dangerousTitle);
assert.equal(manifest.sessions.find((session) => session.session_id === "session-archived").title, "Investigate the archived build failure.");
assert.equal(manifest.sessions.find((session) => session.session_id === "session-archived").project_name, "beta\rbare\nline\r\nend");
assert.equal(manifest.sessions.find((session) => session.session_id === malformedArchivedId).project_name, "alpha");

const html = await fs.readFile(path.join(outputDir, "index.html"), "utf8");
assert.match(html, /id="filter"/);
assert.match(html, /archived/);
assert.match(html, /gpt-test/);
assert.ok(html.includes(dangerousTitle), "HTML output must preserve the title independently of Markdown escaping");
assert.ok(html.includes("beta\rbare\nline\r\nend"), "HTML output must preserve project metadata independently of Markdown escaping");

const indexMarkdown = await fs.readFile(path.join(outputDir, "index.md"), "utf8");
const escapedTitle = String.raw`Escaping plain \| one\|two \\ slash\\\\ before\\\|pipe \\\\\|combo C:\\Temp\\file already\\\|escaped Unicode π`;
assert.ok(indexMarkdown.includes(escapedTitle), "Markdown index must completely escape table-cell content");

const titleRow = indexMarkdown.split("\n").find((line) => line.includes("Escaping plain"));
assert.ok(titleRow, "expected the synthetic title row in index.md");
assert.ok(
  titleRow.includes(`| alpha | ${escapedTitle} | active |`),
  "the complete escaped title must remain between the intended Markdown table delimiters",
);

const projectRow = indexMarkdown.split("\n").find((line) => line.includes("Investigate the archived build failure."));
assert.ok(projectRow, "expected the synthetic project row in index.md");
assert.ok(projectRow.includes("beta bare line end"), "CR, LF, and CRLF must remain inside one Markdown table row");

const emptyProjectRow = indexMarkdown.split("\n").find((line) => line.includes("session-empty-project"));
assert.ok(emptyProjectRow, "expected the empty-project row in index.md");
assert.ok(emptyProjectRow.startsWith("|  | session-empty-project |"), "an empty cell must remain an empty Markdown table cell");

for (const session of manifest.sessions) {
  assert.ok((await fs.stat(path.join(outputDir, session.markdown_file))).size > 0);
  assert.ok((await fs.stat(path.join(outputDir, session.raw_export_file))).size > 0);
  assert.deepEqual(
    await fs.readFile(path.join(outputDir, session.raw_export_file)),
    await fs.readFile(session.source_jsonl),
    "raw JSONL copies must remain byte-for-byte equivalent",
  );
}

await fs.rm(temp, { recursive: true, force: true });
console.log("exporter integration tests passed");
