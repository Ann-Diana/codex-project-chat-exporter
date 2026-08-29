import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import JSZip from "jszip";

import { exportArchive } from "../bin/export-codex-project-chats.mjs";

const execFileAsync = promisify(execFile);
const PNG_A = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const PNG_B = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aCioAAAAASUVORK5CYII=";
const PNG_C = "iVBORw0KGgoAAAANSUhEUgAAAGAAAAAwCAIAAABhdOiYAAABq0lEQVR4nO2b0W3DMAxEFaED3U7dIUN0h+ykZQr0ox8Fmq/INkmLR8GxeV8BAkvn5ztFjpPb989vSW2rCu+lSikfTwr4/EocndrjngnSlRWzVazL1ZWF19UmE6QoASlKQBcDhP8VhLhrqWelAxKj8wBCzF63npgOGMjqe60IqxLG909d32tFWKobuT3u3L1uFCAsiEQwWtLpXvjnDQGEDU9cRlt0uPPyAUH0zWKk0mEVjQwIa76XjJyYjNmhFI0JCNu+l2vnsGN7s+QDZwOCwbef0V46/qJxAMHs28NoLDvOohEAwXdVjaaHmyWPEw4I7qtqMe2k4ymaCxAcvu2MKNkZLto4ILh9WxixmiUPywcEkm95i8SlM3b4CCCwfa9GKSI7A0XbDQgxmZfrFvQwysJoHyBE+rbcMcTNQgCE+Ksad8+5NaYaIisgTMl8d3875zGvzKgeis5TE+jYB69HozNNxqLVa9LpJJxXvTKdZuiyBKi9fuNVzij1vJSKtYmfJseUvki3C9M5z6PnOCUgRQlIUQLa+SvX/EV5p0yQogSk6Jb/9pGVCSqy/gD5cfpUy6at1AAAAABJRU5ErkJggg==";

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngWithTextChunk(base64) {
  const source = Buffer.from(base64, "base64");
  const type = Buffer.from("tEXt", "ascii");
  const data = Buffer.from("fixture\0view-only", "latin1");
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  type.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([type, data])), 8 + data.length);
  return Buffer.concat([source.subarray(0, source.length - 12), chunk, source.subarray(source.length - 12)]).toString("base64");
}

const PNG_D = pngWithTextChunk(PNG_A);
const PNG_E = pngWithTextChunk(PNG_B);

const dataUrl = (base64) => `data:image/png;base64,${base64}`;
const sha256 = (base64) => createHash("sha256").update(Buffer.from(base64, "base64")).digest("hex");
const count = (text, token) => text.split(token).length - 1;

async function writeFixture(codexHome) {
  const sessionId = "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa";
  const directory = path.join(codexHome, "sessions", "2026", "08", "29");
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, `rollout-2026-08-29T10-00-00-${sessionId}.jsonl`);
  const directOne = [{ type: "input_text", text: "First image turn." }, { type: "input_image", image_url: dataUrl(PNG_A) }];
  const directTwo = [{ type: "input_text", text: "Second image turn." }, { type: "input_image", image_url: dataUrl(PNG_A) }];
  const storedOnly = [{ type: "input_text", text: "Stored context image." }, { type: "input_image", image_url: dataUrl(PNG_E) }];
  const ambiguousRepeated = [{ type: "input_text", text: "Repeated identical turn." }, { type: "input_image", image_url: dataUrl(PNG_A) }];
  const replacementHistory = [
    { type: "message", role: "user", content: directOne },
    { type: "message", role: "user", content: storedOnly },
    { type: "message", role: "user", content: ambiguousRepeated },
  ];
  const items = [
    { type: "session_meta", timestamp: "2026-08-29T10:00:00.000Z", payload: { id: sessionId, cwd: "C:\\Projects\\asset-semantics", timestamp: "2026-08-29T10:00:00.000Z", source: "vscode", thread_source: "user" } },
    { type: "response_item", timestamp: "2026-08-29T10:00:01.000Z", payload: { type: "message", role: "user", content: directOne, internal_chat_message_metadata_passthrough: { turn_id: "turn-1" } } },
    { type: "event_msg", timestamp: "2026-08-29T10:00:01.001Z", payload: { type: "user_message", message: "First image turn.", images: [dataUrl(PNG_A)] } },
    { type: "response_item", timestamp: "2026-08-29T10:00:02.000Z", payload: { type: "message", role: "user", content: directTwo, internal_chat_message_metadata_passthrough: { turn_id: "turn-2" } } },
    { type: "event_msg", timestamp: "2026-08-29T10:00:02.001Z", payload: { type: "user_message", message: "Second image turn.", images: [dataUrl(PNG_A)] } },
    { type: "event_msg", timestamp: "2026-08-29T10:00:03.000Z", payload: { type: "mcp_tool_call_end", call_id: "browser-call", duration: { secs: 0, nanos: 1 }, invocation: { server: "browser", tool: "run", arguments: {} }, result: { Ok: { _meta: { "codex/browserUse": true }, content: [{ type: "image", data: PNG_B, mimeType: "image/png" }], isError: false } } } },
    { type: "response_item", timestamp: "2026-08-29T10:00:03.001Z", payload: { type: "function_call_output", call_id: "browser-call", output: [{ type: "input_image", image_url: dataUrl(PNG_B) }] } },
    { type: "response_item", timestamp: "2026-08-29T10:00:04.000Z", payload: { type: "function_call", call_id: "view-call", name: "view_image", arguments: "{}" } },
    { type: "response_item", timestamp: "2026-08-29T10:00:04.001Z", payload: { type: "function_call_output", call_id: "view-call", output: [{ type: "input_image", image_url: dataUrl(PNG_C) }] } },
    { type: "response_item", timestamp: "2026-08-29T10:00:05.000Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Unclassified image record." }, { type: "input_image", image_url: dataUrl(PNG_C) }], internal_chat_message_metadata_passthrough: { turn_id: "unpaired" } } },
    { type: "response_item", timestamp: "2026-08-29T10:00:06.000Z", payload: { type: "function_call", call_id: "view-only-call", name: "view_image", arguments: "{}" } },
    { type: "response_item", timestamp: "2026-08-29T10:00:06.001Z", payload: { type: "function_call_output", call_id: "view-only-call", output: [{ type: "input_image", image_url: dataUrl(PNG_D) }] } },
    { type: "response_item", timestamp: "2026-08-29T10:00:06.002Z", payload: { type: "message", role: "user", content: ambiguousRepeated, internal_chat_message_metadata_passthrough: { turn_id: "repeat-1" } } },
    { type: "response_item", timestamp: "2026-08-29T10:00:06.003Z", payload: { type: "message", role: "user", content: ambiguousRepeated, internal_chat_message_metadata_passthrough: { turn_id: "repeat-2" } } },
    { type: "compacted", timestamp: "2026-08-29T10:00:07.000Z", payload: { message: "compacted", replacement_history: replacementHistory } },
    { type: "compacted", timestamp: "2026-08-29T10:00:08.000Z", payload: { message: "compacted again", replacement_history: replacementHistory } },
    { type: "response_item", timestamp: "2026-08-29T10:00:09.000Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] } },
  ];
  const rawBytes = Buffer.from(`${items.map(item => JSON.stringify(item)).join("\n")}\n`, "utf8");
  await fs.writeFile(file, rawBytes);
  return { rawBytes, sessionId };
}

async function inspectExport(output, result, exportProfile, includeTools, documentFormat, rawBytes) {
  const rootManifest = JSON.parse(await fs.readFile(result.manifestPath, "utf8"));
  const assetManifest = JSON.parse(await fs.readFile(result.assetManifestPath, "utf8"));
  const session = rootManifest.sessions[0];
  const markdown = await fs.readFile(path.join(output, session.markdown_file), "utf8");
  const html = await fs.readFile(result.htmlIndexPath, "utf8");
  const includeStoredContext = exportProfile === "complete";
  const expectedVisible = (includeTools ? 8 : 5) + (includeStoredContext ? 2 : 0);
  const expectedUnique = (includeTools ? 4 : 2) + (includeStoredContext ? 1 : 0);

  assert.equal(rootManifest.include_tools, includeTools);
  assert.equal(rootManifest.replacement_history_in_reading_views, includeStoredContext);
  assert.equal(rootManifest.replacement_history_source_unchanged, true);
  assert.equal(assetManifest.schema_version, 2);
  assert.equal(rootManifest.unique_assets, expectedUnique);
  assert.equal(count(markdown, "![Attachment "), expectedVisible);
  assert.equal(count(html, "<img "), expectedVisible);
  assert.equal(count(markdown, "## Additional stored context"), includeStoredContext ? 1 : 0);
  assert.equal(count(html, "<summary>Additional stored context</summary>"), includeStoredContext ? 1 : 0);
  if (documentFormat === "docx") {
    const docx = await JSZip.loadAsync(await fs.readFile(path.join(output, session.docx_file)), { checkCRC32: true });
    const documentXml = await docx.file("word/document.xml").async("string");
    const media = Object.keys(docx.files).filter(name => name.startsWith("word/media/") && !docx.files[name].dir);
    assert.equal(count(documentXml, "<a:blip"), expectedVisible);
    assert.equal(media.length, expectedUnique);
    assert.equal(count(documentXml, "Additional stored context"), includeStoredContext ? 1 : 0);
    assert.equal(count(documentXml, "Attachments retained in session replacement history"), includeStoredContext ? 1 : 0);
  }

  const requiredUseKeys = ["role", "record_type", "content_type", "timestamp", "classification", "tool_origin", "mirror_kind", "canonical_record_ordinal", "canonical_attachment_ordinal", "reading_disposition"];
  assert.ok(assetManifest.assets.flatMap(asset => asset.uses).every(use => requiredUseKeys.every(key => Object.hasOwn(use, key))));

  const assetA = assetManifest.assets.find(asset => asset.sha256 === sha256(PNG_A));
  const assetB = assetManifest.assets.find(asset => asset.sha256 === sha256(PNG_B));
  const assetC = assetManifest.assets.find(asset => asset.sha256 === sha256(PNG_C));
  const assetD = assetManifest.assets.find(asset => asset.sha256 === sha256(PNG_D));
  const assetE = assetManifest.assets.find(asset => asset.sha256 === sha256(PNG_E));
  assert.ok(assetA && assetC);
  assert.equal(assetA.uses.filter(use => use.reading_disposition === "VISIBLE").length, 4, "identical bytes in genuine turns remain separate displays");
  assert.equal(assetA.uses.filter(use => use.reading_disposition === "ADDITIONAL_STORED_CONTEXT").length, includeStoredContext ? 1 : 0);
  assert.equal(assetA.uses.filter(use => use.mirror_kind === "USER_EVENT").length, 2);
  assert.equal(assetA.uses.filter(use => use.mirror_kind === "REPLACEMENT_HISTORY").length, includeStoredContext ? 3 : 2);
  assert.equal(assetA.uses.filter(use => use.classification === "REPLACEMENT_HISTORY_SUPPRESSED").length, includeStoredContext ? 0 : 2);
  if (includeStoredContext) {
    assert.ok(assetE, "Complete must retain a replacement-history-only asset");
    assert.equal(assetE.uses.filter(use => use.reading_disposition === "ADDITIONAL_STORED_CONTEXT").length, 1);
    assert.equal(assetE.uses.filter(use => use.mirror_kind === "REPLACEMENT_HISTORY").length, 1);
  } else {
    assert.equal(assetE, undefined, "Readable must not publish a replacement-history-only asset");
  }
  assert.equal(assetC.uses.some(use => use.tool_origin === "VIEW_IMAGE" && use.reading_disposition === (includeTools ? "VISIBLE" : "EXCLUDED")), true);
  assert.equal(assetC.uses.some(use => use.role === "USER" && use.classification === "UNCLASSIFIED_USER_ROLE_RECORD" && use.reading_disposition === "VISIBLE"), true);
  if (includeTools) {
    assert.ok(assetB);
    assert.equal(assetB.uses.filter(use => use.reading_disposition === "VISIBLE").length, 1);
    assert.equal(assetB.uses.filter(use => use.mirror_kind === "TOOL_RESULT").length, 1);
    assert.ok(assetB.uses.every(use => use.tool_origin === "BROWSER"));
    assert.ok(assetD);
    assert.equal(assetD.uses.length, 1);
    assert.equal(assetD.uses[0].tool_origin, "VIEW_IMAGE");
    assert.equal(assetD.uses[0].reading_disposition, "VISIBLE");
  } else {
    assert.equal(assetB, undefined, "a tool-only browser image must not be collected when tools are excluded");
    assert.equal(assetD, undefined, "a tool-only view_image result must not be collected when tools are excluded");
  }
  assert.equal(rootManifest.asset_occurrences, assetManifest.assets.reduce((sum, asset) => sum + asset.uses.length, 0));

  if (documentFormat === "pdf") {
    const pdfPath = path.join(output, session.pdf_file);
    try {
      const { stdout } = await execFileAsync("pdftotext", [pdfPath, "-"]);
      assert.equal(count(stdout, `${sha256(PNG_A)}.png`), includeStoredContext ? 5 : 4);
      assert.equal(count(stdout, `${sha256(PNG_B)}.png`), includeTools ? 1 : 0);
      assert.equal(count(stdout, `${sha256(PNG_C)}.png`), includeTools ? 2 : 1);
      assert.equal(count(stdout, `${sha256(PNG_D)}.png`), includeTools ? 1 : 0);
      assert.equal(count(stdout, `${sha256(PNG_E)}.png`), includeStoredContext ? 1 : 0);
      assert.equal(count(stdout, "Additional stored context"), includeStoredContext ? 1 : 0);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

test("Readable suppresses replacement history while Complete retains labelled stored context across every reading view", async () => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "reading-assets-")));
  try {
    const codexHome = path.join(temp, ".codex");
    const { rawBytes } = await writeFixture(codexHome);
    for (const exportProfile of ["readable", "complete"]) {
      for (const includeTools of [false, true]) {
        for (const documentFormat of ["docx", "pdf"]) {
          const output = path.join(temp, `${exportProfile}-${includeTools ? "with" : "without"}-tools-${documentFormat}`);
          const result = await exportArchive({
            codexHome,
            scope: "all",
            outputDirectory: output,
            exportProfile,
            includeTools,
            documentFormats: [documentFormat],
          });
          await inspectExport(output, result, exportProfile, includeTools, documentFormat, rawBytes);
          const rootManifest = JSON.parse(await fs.readFile(result.manifestPath, "utf8"));
          if (exportProfile === "complete") assert.deepEqual(await fs.readFile(path.join(output, rootManifest.sessions[0].raw_export_file)), rawBytes);
        }
      }
    }
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});
