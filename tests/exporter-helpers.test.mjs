import assert from "node:assert/strict";
import path from "node:path";

import {
  EXPORT_PROFILE,
  ExportError,
  REDACTION_PATTERNS,
  classifyAttachmentReference,
  createProgressReporter,
  deriveTitle,
  extractCwdFromText,
  extractSessionIdFromFilename,
  formatErrorWithHints,
  isPathInside,
  inspectUnprefixedEmbeddedImage,
  markdownFence,
  portableBasename,
  readTopLevelJsonEventType,
  redactSecrets,
  resolveExportProfile,
  slug,
} from "../bin/export-codex-project-chats.mjs";

assert.equal(resolveExportProfile(undefined, false), EXPORT_PROFILE.COMPLETE);
assert.equal(resolveExportProfile(undefined, true), EXPORT_PROFILE.READABLE);
assert.equal(resolveExportProfile("source-snapshots", true), EXPORT_PROFILE.SOURCE_SNAPSHOTS, "explicit profiles must win over the legacy no-raw switch");
assert.throws(() => resolveExportProfile("future-pdf", false), /Unsupported export profile/);

const pngBase64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]).toString("base64");
const jpegBase64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]).toString("base64");
assert.equal(inspectUnprefixedEmbeddedImage(pngBase64)?.mediaType, "image/png");
assert.equal(inspectUnprefixedEmbeddedImage(jpegBase64)?.mediaType, "image/jpeg");
assert.equal(inspectUnprefixedEmbeddedImage(`${pngBase64.slice(0, -2)}!x`), null, "invalid Base64-like strings must not be classified as embedded images");
assert.equal(inspectUnprefixedEmbeddedImage(`${pngBase64}=`), null, "invalid Base64 padding must not be accepted");
assert.equal(inspectUnprefixedEmbeddedImage(Buffer.from("ordinary text").toString("base64")), null, "valid non-image Base64 must remain unknown");
assert.equal(classifyAttachmentReference("C:\\Private\\capture.png"), "local");
assert.equal(classifyAttachmentReference("https://example.invalid/capture.png"), "remote");
assert.equal(classifyAttachmentReference("opaque-attachment-token"), "unknown");

assert.deepEqual(readTopLevelJsonEventType('{"timestamp":"now","type":"session_meta","payload":{}}'), { status: "FOUND", value: "session_meta" });
assert.deepEqual(readTopLevelJsonEventType('{"payload":{"type":"nested"},"\\u0074ype":"turn_context"}'), { status: "FOUND", value: "turn_context" });
assert.deepEqual(readTopLevelJsonEventType('{"timestamp":"now","payload":{"type":"nested"}}'), { status: "NOT_FOUND", value: "" });
assert.equal(readTopLevelJsonEventType('{"timestamp":').status, "UNCERTAIN");
assert.equal(readTopLevelJsonEventType('{"type":"session_meta","type":"event_msg","payload":{}}').status, "UNCERTAIN", "duplicate top-level type keys must fall back to full JSON parsing");
assert.equal(readTopLevelJsonEventType('{"type":"session_meta","payload":{}} trailing').status, "UNCERTAIN", "trailing malformed content must not be routed optimistically");
assert.deepEqual(readTopLevelJsonEventType(`{"timestamp":"now","type":"response_item","payload":{"data":"${"A".repeat(1024 * 1024)}"}}`), { status: "FOUND", value: "response_item" }, "large JSON strings must preserve structured routing semantics");
assert.deepEqual(readTopLevelJsonEventType(JSON.stringify({ timestamp: "now", type: "response_item", payload: { data: 'quoted "value" and slash \\' } })), { status: "FOUND", value: "response_item" }, "escaped quotes and backslashes must preserve string boundaries");
const hugePayload = "A".repeat(1024 * 1024);
assert.equal(readTopLevelJsonEventType(JSON.stringify({ payload: { image: hugePayload }, timestamp: "now", type: "session_meta" })).value, "session_meta");
assert.equal(readTopLevelJsonEventType(JSON.stringify({ type: "turn_context", payload: { image: hugePayload } })).value, "turn_context");

const progressEvents = [];
const reportProgress = createProgressReporter((event) => progressEvents.push(event), 0);
reportProgress({ phase: "discovery", message: "Discovering sessions" });
reportProgress({ phase: "processing", message: "Processing session 1 of 2", current: 1, total: 2 });
reportProgress({ phase: "processing", message: "Processing session 2 of 2", current: 2, total: 2 });
reportProgress({ phase: "complete", message: "Export complete" });
assert.deepEqual(progressEvents.map((event) => event.message), ["Discovering sessions", "Processing session 1 of 2", "Processing session 2 of 2", "Export complete"]);
const throttledEvents = [];
const reportThrottledProgress = createProgressReporter((event) => throttledEvents.push(event), 60_000);
for (let current = 1; current <= 100; current += 1) reportThrottledProgress({ phase: "processing", message: `Processing session ${current} of 100`, current, total: 100 });
assert.equal(throttledEvents.length, 2, "same-phase progress must be throttled while still reporting the first and final session");
assert.equal(throttledEvents.at(-1).current, 100);

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
