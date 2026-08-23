import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { exportArchive, INCOMPLETE_MARKER_NAME } from "../bin/export-codex-project-chats.mjs";
import {
  ACTIVE_SESSION_ID,
  FALLBACK_SESSION_ID,
  FALLBACK_STARTED_AT,
  SMALL_PNG_DATA_URL,
  SUBAGENT_SESSION_ID,
  writeReadingOutputFixture,
} from "./fixtures/reading-output/sessions.mjs";

const fixtureRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "reading-output");
const profiles = ["complete", "readable", "source-snapshots"];

async function pathExists(candidate) {
  return fs.stat(candidate).then(() => true, () => false);
}

async function listFiles(root) {
  const files = [];
  async function walk(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) files.push(path.relative(root, absolute).replaceAll("\\", "/"));
    }
  }
  await walk(root);
  return files.sort();
}

function portable(value) {
  return typeof value === "string" ? value.replaceAll("\\", "/") : value;
}

function normalizeManifest(manifest, replacements) {
  const normalized = structuredClone(manifest);
  normalized.generated_at = "<GENERATED_AT>";
  normalized.codex_home = "<CODEX_HOME>";
  normalized.sessions_dir = "<SESSIONS_DIR>";
  normalized.archived_sessions_dir = "<ARCHIVED_DIR>";
  normalized.session_index = "<SESSION_INDEX>";
  for (const session of normalized.sessions) {
    session.source_jsonl = portable(replaceExact(session.source_jsonl, replacements));
    session.source_relative_path = portable(session.source_relative_path);
    session.markdown_file = portable(session.markdown_file);
    session.raw_export_file = portable(session.raw_export_file);
    if (session.raw_verified_at) session.raw_verified_at = "<RAW_VERIFIED_AT>";
  }
  return normalized;
}

function replaceExact(text, replacements) {
  let normalized = text;
  for (const [value, token] of replacements.sort((left, right) => right[0].length - left[0].length)) {
    if (value) normalized = normalized.split(value).join(token);
  }
  return normalized;
}

async function captureGolden(outputDir, codexHome, fixturePaths) {
  const files = await listFiles(outputDir);
  const manifest = JSON.parse(await fs.readFile(path.join(outputDir, "manifest.json"), "utf8"));
  const replacements = [
    [manifest.generated_at, "<GENERATED_AT>"],
    [codexHome, "<CODEX_HOME>"],
    [fixturePaths.sessionsDir, "<SESSIONS_DIR>"],
    [fixturePaths.archivedDir, "<ARCHIVED_DIR>"],
    [path.join(codexHome, "session_index.jsonl"), "<SESSION_INDEX>"],
  ];
  const textSha256 = {};
  for (const relative of files.filter((file) => file.endsWith(".md"))) {
    const normalized = replaceExact(await fs.readFile(path.join(outputDir, relative), "utf8"), replacements);
    textSha256[relative] = createHash("sha256").update(normalized).digest("hex");
  }
  const normalizedHtml = replaceExact(await fs.readFile(path.join(outputDir, "index.html"), "utf8"), replacements);
  return {
    files,
    manifest: normalizeManifest(manifest, replacements),
    index_html_sha256: createHash("sha256").update(normalizedHtml).digest("hex"),
    text_sha256: textSha256,
  };
}

function assertOrdered(text, fragments) {
  let previous = -1;
  for (const fragment of fragments) {
    const current = text.indexOf(fragment);
    assert.ok(current > previous, `expected ordered fragment: ${fragment}`);
    previous = current;
  }
}

test("version 0.2.0 reading output remains stable across all profiles", async () => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "codex-reading-golden-")));
  try {
    const codexHome = path.join(temp, ".codex");
    const fixturePaths = await writeReadingOutputFixture(codexHome);

    for (const profile of profiles) {
      const outputDir = path.join(temp, `output-${profile}`);
      await exportArchive({
        codexHome,
        scope: "all",
        outputDirectory: outputDir,
        exportProfile: profile,
        includeTools: true,
      });

      const manifest = JSON.parse(await fs.readFile(path.join(outputDir, "manifest.json"), "utf8"));
      const sessions = new Map(manifest.sessions.map((session) => [session.session_id, session]));
      const active = sessions.get(ACTIVE_SESSION_ID);
      const subagent = sessions.get(SUBAGENT_SESSION_ID);
      const fallback = sessions.get(FALLBACK_SESSION_ID);
      assert.ok(active && subagent && fallback);
      assert.equal(active.title, profile === "source-snapshots" ? "Codex session 11111111…" : "Fixture direct request with image.");
      assert.equal(active.storage, "active");
      assert.equal(active.started_at, "2026-01-02T10:00:00.000Z");
      assert.equal(subagent.storage, "active");
      assert.equal(fallback.storage, "archived");
      assert.equal(fallback.started_at, FALLBACK_STARTED_AT);
      assert.notEqual(fallback.started_at, "2025-12-31T23:59:59.000Z", "started_at must come from the source mtime, not the filename");
      assert.equal(await pathExists(path.join(outputDir, INCOMPLETE_MARKER_NAME)), false);
      assert.equal(await pathExists(path.join(outputDir, "manifest.json")), true);
      assert.equal(await pathExists(path.join(outputDir, "index.html")), true);

      if (profile === "complete" || profile === "readable") {
        assert.equal(await pathExists(path.join(outputDir, "index.md")), true);
        for (const session of manifest.sessions) assert.ok(session.markdown_file && await pathExists(path.join(outputDir, session.markdown_file)));
        const activeMarkdown = await fs.readFile(path.join(outputDir, active.markdown_file), "utf8");
        const subagentMarkdown = await fs.readFile(path.join(outputDir, subagent.markdown_file), "utf8");
        assertOrdered(activeMarkdown, [
          "<summary>Automatic runtime context – AGENTS / ENVIRONMENT",
          "## User - 2026-01-02T10:00:01.000Z",
          "## Assistant - 2026-01-02T10:00:02.000Z",
          "<summary>Unclassified user-role record",
          "## Tool function_call - fixture_tool",
        ]);
        assert.match(subagentMarkdown, /<summary>Subagent input \/ parent-agent handoff/);
        assert.equal(activeMarkdown.includes(SMALL_PNG_DATA_URL), false, "the current reading view must not inline the embedded image payload");
        const markdownIndex = await fs.readFile(path.join(outputDir, "index.md"), "utf8");
        const htmlIndex = await fs.readFile(path.join(outputDir, "index.html"), "utf8");
        assert.ok(markdownIndex.includes(portable(active.markdown_file)));
        assert.ok(htmlIndex.includes(`href="${portable(active.markdown_file)}"`));
      } else {
        assert.equal(await pathExists(path.join(outputDir, "index.md")), false);
        assert.ok(manifest.sessions.every((session) => session.markdown_file === ""));
        assert.ok(manifest.sessions.every((session) => session.user_messages === null));
        const htmlIndex = await fs.readFile(path.join(outputDir, "index.html"), "utf8");
        assert.ok(htmlIndex.includes("Source snapshots intentionally use a reduced index and do not inspect complete readable metadata."));
      }

      if (profile === "complete" || profile === "source-snapshots") {
        for (const session of manifest.sessions) {
          assert.ok(session.raw_export_file);
          assert.deepEqual(
            await fs.readFile(path.join(outputDir, session.raw_export_file)),
            await fs.readFile(session.source_jsonl),
            "Raw JSONL must remain byte-identical to its source fixture",
          );
        }
        const rawHref = portable(active.raw_export_file);
        const htmlIndex = await fs.readFile(path.join(outputDir, "index.html"), "utf8");
        assert.ok(htmlIndex.includes(`href="${rawHref}"`));
        if (profile === "complete") {
          const markdownIndex = await fs.readFile(path.join(outputDir, "index.md"), "utf8");
          assert.ok(markdownIndex.includes(rawHref));
        }
      } else {
        assert.ok(manifest.sessions.every((session) => session.raw_export_file === ""));
        assert.equal(await pathExists(path.join(outputDir, "raw")), false);
      }

      const actual = await captureGolden(outputDir, codexHome, fixturePaths);
      const expectedPath = path.join(fixtureRoot, `${profile}.golden.json`);
      const expected = JSON.parse(await fs.readFile(expectedPath, "utf8"));
      assert.deepEqual(actual, expected);
    }
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});
