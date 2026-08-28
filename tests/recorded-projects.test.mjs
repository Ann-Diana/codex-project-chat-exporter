import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { exportArchive } from "../bin/export-codex-project-chats.mjs";

const execute = promisify(execFile);
const oldPath = "/synthetic/old-project";
async function fixture() {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "recorded-projects-")));
  const codexHome = path.join(temp, "source");
  await fs.mkdir(path.join(codexHome, "sessions"), { recursive: true });
  await fs.mkdir(path.join(codexHome, "archived_sessions"));
  let oldBytes = 0;
  for (const [i, cwd] of [oldPath, oldPath, `${oldPath}/child`, `${oldPath}-other`].entries()) {
    const rows = [
      { type: "session_meta", timestamp: "2026-08-01T10:00:00Z", payload: { id: `synthetic-${i}`, cwd, timestamp: "2026-08-01T10:00:00Z" } },
      { type: "response_item", timestamp: "2026-08-02T10:00:00Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Synthetic." }] } },
    ];
    const bytes = Buffer.from(rows.map(row => JSON.stringify(row)).join("\n") + "\n");
    await fs.writeFile(path.join(codexHome, "sessions", `rollout-${i}.jsonl`), bytes);
    if (i < 2) oldBytes += bytes.length;
    if (i === 0) await fs.writeFile(path.join(codexHome, "archived_sessions", "rollout-duplicate.jsonl"), bytes);
  }
  return { temp, codexHome, oldBytes };
}

test("recorded-project recovery uses one inventory, exact cwd and bounded metadata for every profile", async () => {
  const { temp, codexHome, oldBytes } = await fixture();
  try {
    for (const exportProfile of ["complete", "readable", "source-snapshots"]) {
      let calls = 0;
      const diagnostics = [];
      const outputDirectory = path.join(temp, exportProfile);
      const result = await exportArchive({ codexHome, outputDirectory, scope: "project", workspacePath: "/synthetic/renamed", exportProfile,
        onDiagnostic: e => diagnostics.push(e),
        onSelectRecordedProject: async ({ projects, reason }) => {
          calls++;
          assert.equal(reason, "no-match");
          assert.equal(projects.length, 3);
          assert.ok(Object.isFrozen(projects) && projects.every(Object.isFrozen));
          assert.deepEqual(projects.find(p => p.cwd === oldPath), { cwd: oldPath, sessionCount: 2, sourceBytes: oldBytes, lastSessionAt: "2026-08-02T10:00:00.000Z" });
          assert.ok(projects.every(p => Object.keys(p).length === 4));
          return oldPath;
        },
      });
      assert.equal(calls, 1);
      assert.equal(result.exportedSessionCount, 2);
      const manifest = JSON.parse(await fs.readFile(result.manifestPath, "utf8"));
      assert.ok(manifest.sessions.every(s => s.cwd === oldPath || s.project === oldPath));
      assert.equal(diagnostics.filter(e => e.event === "routing_start").length, exportProfile === "readable" ? 0 : 1);
      assert.equal(diagnostics.filter(e => e.event === "discovery_start").length, 1);
    }
    const direct = await exportArchive({ codexHome, outputDirectory: path.join(temp, "direct"), scope: "recorded-project", recordedProjectPath: oldPath });
    assert.equal(direct.exportedSessionCount, 2);
    const workspace = await exportArchive({ codexHome, outputDirectory: path.join(temp, "workspace"), scope: "project", workspacePath: oldPath });
    assert.equal(workspace.exportedSessionCount, 2, "workspace selection must not silently include child paths");
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});

test("recorded selection fails closed on cancellation, fabricated paths and absent choices", async () => {
  const { temp, codexHome } = await fixture();
  try {
    for (const [i, choice] of [null, undefined, "old-project", "../old-project", {}, "/synthetic/missing"].entries()) {
      const outputDirectory = path.join(temp, `cancel-${i}`);
      await assert.rejects(() => exportArchive({ codexHome, outputDirectory, scope: "recorded-project", onSelectRecordedProject: ({ reason }) => {
        assert.equal(reason, "requested"); return choice;
      } }), error => error.code === (choice == null ? "EXPORT_CANCELLED" : "INVALID_PROJECT_SELECTION"));
      assert.deepEqual(await fs.readdir(outputDirectory), [], "no export or temporary files before explicit selection");
    }
    await assert.rejects(() => exportArchive({ scope: "recorded-project" }), e => e.code === "INVALID_PROJECT_SELECTION");
    await assert.rejects(() => exportArchive({ scope: "other" }), e => e.code === "INVALID_EXPORT_SCOPE");
    await assert.rejects(() => exportArchive({ codexHome, outputDirectory: path.join(temp, "missing"), scope: "project", workspacePath: "/synthetic/new" }), e => e.code === "NO_PROJECT_MATCH" && e.message.startsWith("No sessions were recorded for the current workspace path."));
    const outputDirectory = path.join(temp, "cli");
    await execute(process.execPath, [path.resolve("bin/export-codex-project-chats.mjs"), "--codex-home", codexHome, "--out", outputDirectory, "--recorded-project", oldPath]);
    assert.equal(JSON.parse(await fs.readFile(path.join(outputDirectory, "manifest.json"), "utf8")).sessions.length, 2);
    for (const args of [["--recorded-project"], ["--all", "--recorded-project", oldPath], ["--project", "old", "--recorded-project", oldPath]]) {
      await assert.rejects(() => execute(process.execPath, [path.resolve("bin/export-codex-project-chats.mjs"), ...args]), e => e.code === 2);
    }
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});

test("source changes while the historical-path dialog is open cannot change the authorized project", async () => {
  for (const exportProfile of ["complete", "readable", "source-snapshots"]) {
    const { temp, codexHome } = await fixture();
    try {
      const outputDirectory = path.join(temp, "changed");
      await assert.rejects(() => exportArchive({ codexHome, outputDirectory, scope: "recorded-project", exportProfile,
        onSelectRecordedProject: async () => {
          await fs.appendFile(path.join(codexHome, "sessions", "rollout-0.jsonl"), JSON.stringify({ type: "turn_context", payload: { cwd: "/synthetic/not-selected" } }) + "\n");
          return oldPath;
        },
      }), e => e.code === "SOURCE_CHANGED_DURING_EXPORT");
      await assert.rejects(() => fs.stat(path.join(outputDirectory, "manifest.json")), e => e.code === "ENOENT");
    } finally { await fs.rm(temp, { recursive: true, force: true }); }
  }
});

test("recorded inventory compares actual instants and ignores malformed event dates in every profile", async () => {
  const { temp, codexHome } = await fixture();
  try {
    const rows = [
      { type: "event_msg", timestamp: "2026-08-02T09:30:00-02:00", payload: { type: "synthetic" } },
      { type: "event_msg", timestamp: "not-a-date", payload: { type: "synthetic" } },
    ];
    await fs.appendFile(path.join(codexHome, "sessions", "rollout-0.jsonl"), rows.map(row => JSON.stringify(row)).join("\n") + "\n");
    for (const exportProfile of ["complete", "readable", "source-snapshots"]) {
      await assert.rejects(() => exportArchive({ codexHome, outputDirectory: path.join(temp, `dates-${exportProfile}`), scope: "recorded-project", exportProfile,
        onSelectRecordedProject: ({ projects }) => {
          assert.equal(projects.find(project => project.cwd === oldPath).lastSessionAt, "2026-08-02T11:30:00.000Z");
          return null;
        },
      }), error => error.code === "EXPORT_CANCELLED");
    }
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});
