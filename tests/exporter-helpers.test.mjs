import assert from "node:assert/strict";
import path from "node:path";

import {
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
} from "../bin/export-codex-project-chats.mjs";

assert.ok(REDACTION_PATTERNS.length >= 5, "expected common redaction patterns");

const redacted = redactSecrets([
  "openai " + "sk-" + "proj-" + "abcdefghijklmnopqrstuvwxyz1234567890",
  "google " + "AI" + "za" + "ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890",
  "github " + "gh" + "p_" + "abcdefghijklmnopqrstuvwxyz1234567890",
  "aws " + "AK" + "IA" + "ABCDEFGHIJKLMNOP",
  "blob QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFB+Q==",
].join("\n"));

assert.match(redacted, /sk-<REDACTED>/);
assert.match(redacted, /AIza<REDACTED>/);
assert.match(redacted, /gh<REDACTED>/);
assert.match(redacted, /AKIA<REDACTED>/);
assert.match(redacted, /<POSSIBLE_BASE64_SECRET_REDACTED>/);
assert.doesNotMatch(redacted, new RegExp("abcdefghijklmnopqrstuvwxyz" + "1234567890"));

const sha256 = "0123456789abcdef".repeat(4);
assert.equal(redactSecrets(sha256), sha256, "SHA-256 hashes must remain intact");

assert.equal(slug("My Project v1.2"), "my-project-v1.2");
assert.equal(slug("  Weird --- Name!!!  "), "weird-name");
assert.equal(slug(""), "unknown");
assert.equal(portableBasename("C:\\Users\\demo\\Projects\\alpha"), "alpha");
assert.equal(portableBasename("/home/demo/projects/beta/"), "beta");
assert.equal(deriveTitle("\n  Build a portable archive for this project.\nMore details"), "Build a portable archive for this project.");
assert.equal(deriveTitle("A".repeat(120)).length, 96);
assert.equal(extractSessionIdFromFilename("rollout-2026-07-22T10-50-14-019f1234-5678-7abc-8def-0123456789ab.jsonl"), "019f1234-5678-7abc-8def-0123456789ab");
assert.equal(extractCwdFromText("<environment_context>\n  <cwd>C:\\Projects\\alpha</cwd>\n</environment_context>"), "C:\\Projects\\alpha");
assert.equal(markdownFence("plain text"), "```");
assert.equal(markdownFence("contains ``` inside"), "````");

const root = path.resolve("C:\\Projects\\codex-project-chat-exporter");
assert.equal(isPathInside(root, root), true);
assert.equal(isPathInside(path.join(root, "md", "p001"), root), true);
assert.equal(isPathInside(path.resolve(root, "..", "codex-project-chat-exporter-other"), root), false);

const guardHints = formatErrorWithHints(new ExportError("OUTPUT_IN_TOOL_DIR", `Refusing to export into the tool/repository folder: ${root}`));
assert.match(guardHints, /If you really know what you are doing, use:/);
assert.match(guardHints, /--allow-output-in-tool-dir/);

const noSessionHints = formatErrorWithHints(new ExportError("NO_SESSIONS", "No Codex sessions found: C:\\missing"));
assert.match(noSessionHints, /--archived-dir/);

const noSelectionHints = formatErrorWithHints(new ExportError("NO_SELECTION", "Choose a selection."));
assert.match(noSelectionHints, /--all/);

console.log("exporter helper tests passed");