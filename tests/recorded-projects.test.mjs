import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { exportArchive, readSessionDiscoveryMeta, recordedPathIdentity, sameRecordedPathIdentity } from "../bin/export-codex-project-chats.mjs";

const execute = promisify(execFile);
const oldPath = "/synthetic/old-project";

test("Windows workspace identities normalize only semantically equivalent absolute paths", () => {
  const canonical = "C:\\Users\\Example\\Project";
  const variants = [
    "c:\\users\\example\\project",
    "C:/Users/Example/Project",
    "C:\\Users\\Example\\Project\\",
    "\\\\?\\C:\\Users\\Example\\Project",
  ];
  const expectedIdentity = recordedPathIdentity(canonical, "win32");
  for (const variant of variants) {
    assert.equal(recordedPathIdentity(variant, "win32"), expectedIdentity);
    assert.equal(sameRecordedPathIdentity(canonical, variant, "win32"), true);
  }
  assert.equal(sameRecordedPathIdentity(canonical, `${canonical}-other`, "win32"), false);
  assert.equal(sameRecordedPathIdentity(canonical, "Project", "win32"), false, "relative or basename-only values must not become exact matches");
  assert.equal(sameRecordedPathIdentity(canonical, "\\\\.\\C:\\Users\\Example\\Project", "win32"), false, "device paths must not alias ordinary drive paths");
  assert.equal(sameRecordedPathIdentity("\\\\Server\\Share\\Project", "\\\\?\\UNC\\server\\share\\project\\", "win32"), true, "equivalent local UNC namespace spelling is normalized");
});

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
          assert.deepEqual(projects.find(p => p.cwd === oldPath), { cwd: oldPath, sessionCount: 2, sourceBytes: oldBytes, lastSessionAt: "2026-08-01T10:00:00.000Z" });
          assert.ok(projects.every(p => Object.keys(p).length === 4));
          return oldPath;
        },
      });
      assert.equal(calls, 1);
      assert.equal(result.exportedSessionCount, 2);
      const manifest = JSON.parse(await fs.readFile(result.manifestPath, "utf8"));
      assert.ok(manifest.sessions.every(s => s.cwd === oldPath || s.project === oldPath));
      assert.equal(diagnostics.filter(e => e.event === "routing_start").length, 1);
      assert.equal(diagnostics.filter(e => e.event === "routing_metadata_end").length, 5);
      assert.equal(diagnostics.filter(e => e.event === "discovery_start").length, 1);
    }
    const direct = await exportArchive({ codexHome, outputDirectory: path.join(temp, "direct"), scope: "recorded-project", recordedProjectPath: oldPath });
    assert.equal(direct.exportedSessionCount, 2);
    let workspacePickerCalls = 0;
    const workspaceDiagnostics = [];
    const workspace = await exportArchive({ codexHome, outputDirectory: path.join(temp, "workspace"), scope: "project", workspacePath: oldPath,
      onDiagnostic: event => workspaceDiagnostics.push(event),
      onSelectRecordedProject: () => { workspacePickerCalls += 1; return `${oldPath}-other`; },
    });
    assert.equal(workspace.exportedSessionCount, 2, "workspace selection must not silently include child paths");
    assert.equal(workspacePickerCalls, 0, "a matching Current Workspace must not enter the historical project picker");
    assert.ok(workspaceDiagnostics.filter(event => event.event === "routing_metadata_end").every(event => event.metadata_bytes_read <= 16 * 1024 * 1024 + 64 * 1024 + 4095));
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});

test("Current Workspace uses Windows path identity without entering historical fallback", { skip: process.platform !== "win32" }, async () => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "recorded-windows-identity-")));
  const codexHome = path.join(temp, "source");
  const sessions = path.join(codexHome, "sessions");
  const recorded = "C:\\Users\\Example\\Project";
  await fs.mkdir(sessions, { recursive: true });
  await fs.writeFile(path.join(sessions, "rollout-windows.jsonl"), `${JSON.stringify({ type: "session_meta", payload: { id: "windows-path", cwd: recorded, timestamp: "2026-08-01T10:00:00Z" } })}\n`);
  try {
    for (const [index, workspacePath] of ["c:\\users\\example\\project", "C:/Users/Example/Project/", "\\\\?\\C:\\Users\\Example\\Project"].entries()) {
      let pickerCalls = 0;
      const result = await exportArchive({ codexHome, outputDirectory: path.join(temp, `output-${index}`), scope: "project", workspacePath,
        onSelectRecordedProject: () => { pickerCalls += 1; return recorded; },
      });
      assert.equal(result.exportedSessionCount, 1);
      assert.equal(pickerCalls, 0);
    }
    await assert.rejects(() => exportArchive({ codexHome, outputDirectory: path.join(temp, "sibling"), scope: "project", workspacePath: `${recorded}-other` }), error => error.code === "NO_PROJECT_MATCH");
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
      { type: "session_meta", timestamp: "2026-08-02T09:30:00-02:00", payload: { id: "synthetic-date", cwd: oldPath, timestamp: "2026-08-02T09:30:00-02:00" } },
      { type: "event_msg", timestamp: "not-a-date", payload: { type: "synthetic" } },
    ];
    await fs.writeFile(path.join(codexHome, "sessions", "rollout-date.jsonl"), rows.map(row => JSON.stringify(row)).join("\n") + "\n");
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

test("first-record discovery is bounded, ignores conversation bytes and aborts before a full scan", async () => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "recorded-discovery-")));
  const codexHome = path.join(temp, "source");
  const sessions = path.join(codexHome, "sessions");
  const outputDirectory = path.join(temp, "output");
  await fs.mkdir(sessions, { recursive: true });
  try {
    const metadata = { type: "session_meta", timestamp: "2026-08-01T10:00:00Z", payload: { id: "bounded", cwd: oldPath, timestamp: "2026-08-01T10:00:00Z" } };
    const tail = JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "x".repeat(8 * 1024 * 1024) }] } });
    const source = path.join(sessions, "rollout-bounded.jsonl");
    await fs.writeFile(source, `${JSON.stringify(metadata)}\n${tail}\n`);
    const discovered = await readSessionDiscoveryMeta(source);
    assert.equal(discovered.cwd, oldPath);
    assert.ok(discovered.discoverySnapshot.bytesRead <= Buffer.byteLength(JSON.stringify(metadata)) + 4096, "discovery must not scan the large conversation record beyond bounded stream over-read");

    const conversationFirst = path.join(sessions, "rollout-conversation-first.jsonl");
    await fs.writeFile(conversationFirst, `${tail}\n${JSON.stringify(metadata)}\n`);
    const ignored = await readSessionDiscoveryMeta(conversationFirst);
    assert.equal(ignored.cwd, "");
    assert.ok(ignored.discoverySnapshot.bytesRead <= 64, "a first conversation record must stop as soon as its non-metadata type is known");

    const probes = path.join(temp, "first-record-probes");
    await fs.mkdir(probes);
    const reorderedMetadata = path.join(probes, "reordered.jsonl");
    await fs.writeFile(reorderedMetadata, `${JSON.stringify({ timestamp: metadata.timestamp, payload: metadata.payload, type: "session_meta" })}\n`);
    assert.equal((await readSessionDiscoveryMeta(reorderedMetadata)).cwd, oldPath, "structured probing must find a metadata type after earlier complete properties");
    const contextFirst = path.join(probes, "context.jsonl");
    await fs.writeFile(contextFirst, `${JSON.stringify({ payload: { cwd: oldPath }, type: "turn_context" })}\n`);
    assert.equal((await readSessionDiscoveryMeta(contextFirst)).cwd, oldPath, "a first-record turn_context is permitted metadata");
    const duplicateType = path.join(probes, "duplicate-type.jsonl");
    await fs.writeFile(duplicateType, `{"type":"session_meta","payload":{"cwd":"${oldPath}"},"type":"response_item"}\n`);
    assert.equal((await readSessionDiscoveryMeta(duplicateType)).cwd, "", "ambiguous duplicate top-level types must not authorize a project path");
    const duplicatePayload = path.join(probes, "duplicate-payload.jsonl");
    await fs.writeFile(duplicatePayload, `{"type":"session_meta","payload":{"cwd":"${oldPath}"},"payload":{"cwd":"/synthetic/other"}}\n`);
    assert.equal((await readSessionDiscoveryMeta(duplicatePayload)).cwd, "", "ambiguous duplicate payload objects must not authorize a project path");
    const delayedType = path.join(probes, "delayed-type.jsonl");
    await fs.writeFile(delayedType, `${JSON.stringify({ padding: "x".repeat(70 * 1024), type: "session_meta", payload: { cwd: oldPath } })}\n`);
    const delayed = await readSessionDiscoveryMeta(delayedType);
    assert.equal(delayed.cwd, "", "a type beyond the bounded prefix probe must not authorize a project path");
    assert.ok(delayed.discoverySnapshot.bytesRead <= 64 * 1024 + 64);
    const empty = path.join(probes, "empty.jsonl");
    await fs.writeFile(empty, "");
    assert.equal((await readSessionDiscoveryMeta(empty)).cwd, "", "an empty source remains unclassified rather than triggering content fallback");
    const longMetadata = path.join(probes, "long-metadata.jsonl");
    const longRecord = JSON.stringify({ type: "session_meta", payload: { id: "long-metadata", cwd: oldPath, timestamp: "2026-08-01T10:00:00Z", unrelated: "x".repeat(2 * 1024 * 1024) } });
    await fs.writeFile(longMetadata, `${longRecord}\n${tail}\n`);
    const longDiscovered = await readSessionDiscoveryMeta(longMetadata);
    assert.equal(longDiscovered.cwd, oldPath, "long first-record metadata must be projected without retaining the unrelated field");
    assert.equal(longDiscovered.discoverySnapshot.firstRecordSizeBytes, Buffer.byteLength(longRecord));
    assert.equal(longDiscovered.discoverySnapshot.firstRecordTruncated, false);
    assert.ok(longDiscovered.discoverySnapshot.bytesRead <= Buffer.byteLength(longRecord) + 4096 + 64, "discovery must stop after the long first metadata record and bounded stream over-read");
    const capped = await readSessionDiscoveryMeta(longMetadata, { maxRecordBytes: 1024 });
    assert.equal(capped.cwd, "", "metadata beyond the explicit first-record byte cap must fail closed");
    assert.equal(capped.discoverySnapshot.firstRecordTruncated, true);
    assert.equal(capped.discoverySnapshot.firstRecordSizeBytes, 1024);

    const midRecordController = new AbortController();
    let readCalls = 0;
    await assert.rejects(() => readSessionDiscoveryMeta(source, {
      abortSignal: midRecordController.signal,
      io: {
        open: async (...args) => {
          const handle = await fs.open(...args);
          return {
            read: async (...readArgs) => {
              const result = await handle.read(...readArgs);
              readCalls += 1;
              midRecordController.abort();
              return result;
            },
            close: () => handle.close(),
          };
        },
      },
    }), error => error.code === "EXPORT_CANCELLED");
    assert.equal(readCalls, 1, "cancellation must stop first-record discovery between streamed reads");

    const controller = new AbortController();
    const diagnostics = [];
    await assert.rejects(() => exportArchive({ codexHome, outputDirectory, scope: "project", workspacePath: oldPath, abortSignal: controller.signal,
      onDiagnostic: event => {
        diagnostics.push(event);
        if (event.event === "routing_end") controller.abort();
      },
    }), error => error.code === "EXPORT_CANCELLED");
    const metadataDiagnostics = diagnostics.filter(event => event.event === "routing_metadata_end");
    assert.equal(metadataDiagnostics.length, 2);
    assert.ok(metadataDiagnostics.every(event => event.metadata_bytes_read <= Buffer.byteLength(JSON.stringify(metadata)) + 4096));
    assert.equal(await fs.stat(source).then(stat => stat.size), Buffer.byteLength(`${JSON.stringify(metadata)}\n${tail}\n`));
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});
