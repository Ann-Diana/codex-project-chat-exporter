import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  BoundedBase64Error,
  decodeBase64Chunks,
  writeBase64ChunksToFile,
} from "../lib/bounded-base64.mjs";
import {
  JsonlTokenAdapterError,
  streamJsonlTokens,
} from "../lib/jsonl-token-adapter.mjs";
import { SMALL_PNG_DATA_URL } from "./fixtures/reading-output/sessions.mjs";

async function* byteChunks(buffer, size = 1) {
  for (let offset = 0; offset < buffer.length; offset += size) yield buffer.subarray(offset, offset + size);
}

async function collectTokens(input, options) {
  const tokens = [];
  for await (const token of streamJsonlTokens(input, options)) tokens.push(token);
  return tokens;
}

function assignPath(root, targetPath, value) {
  if (targetPath.length === 0) return value;
  let parent = root;
  for (const segment of targetPath.slice(0, -1)) parent = parent[segment];
  parent[targetPath.at(-1)] = value;
  return root;
}

function assembleRecords(tokens) {
  const records = [];
  let root;
  let currentString = null;
  for (const token of tokens) {
    switch (token.type) {
      case "record_start":
        root = undefined;
        break;
      case "object_start":
        root = assignPath(root, token.path, {});
        break;
      case "array_start":
        root = assignPath(root, token.path, []);
        break;
      case "string_start":
        currentString = { path: token.path, value: "" };
        break;
      case "string_chunk":
        currentString.value += token.value;
        break;
      case "string_end":
        root = assignPath(root, currentString.path, currentString.value);
        currentString = null;
        break;
      case "number":
      case "boolean":
      case "null":
        root = assignPath(root, token.path, token.value);
        break;
      case "record_end":
        records.push(root);
        break;
    }
  }
  return records;
}

async function expectAdapterError(input, code, options) {
  await assert.rejects(
    async () => collectTokens(input, options),
    (error) => error instanceof JsonlTokenAdapterError && error.code === code && error.recordIndex === 1,
  );
}

test("empty and whitespace-only JSONL input produces no records", async () => {
  assert.deepEqual(await collectTokens(byteChunks(Buffer.alloc(0))), []);
  assert.deepEqual(await collectTokens(byteChunks(Buffer.from("\n \t\r\n\u00a0\n", "utf8"))), []);
});

test("normalizes LF, CRLF, missing final newline, paths, escapes, and Unicode", async () => {
  const values = [
    { text: "Umlaute äöü ÄÖÜ ß", escaped: "quote \" and slash \\", unicode: "😀", nested: [{ empty: "" }, true, null, -12.5e3] },
    ["second", { deep: [1, 2, 3] }],
    "last record",
  ];
  const jsonl = `${JSON.stringify(values[0])}\r\n${JSON.stringify(values[1])}\n${JSON.stringify(values[2])}`;
  const tokens = await collectTokens(byteChunks(Buffer.from(jsonl, "utf8")));
  assert.deepEqual(assembleRecords(tokens), values);
  assert.deepEqual(tokens.filter((token) => token.type === "record_start").map((token) => token.recordIndex), [1, 2, 3]);
  assert.ok(tokens.some((token) => token.type === "key" && token.value === "text" && JSON.stringify(token.path) === '["text"]'));
  assert.ok(tokens.some((token) => token.type === "string_chunk" && token.path.join(".") === "nested.0.empty") === false, "empty strings should not invent chunks");
  assert.ok(tokens.some((token) => token.type === "number" && token.path.join(".") === "nested.3" && token.value === -12500));
});

test("bounds emitted string chunks without changing reconstructed content", async () => {
  const value = { payload: "ä😀\\\"".repeat(10_000) };
  const tokens = await collectTokens(byteChunks(Buffer.from(`${JSON.stringify(value)}\n`, "utf8"), 7), { maxStringChunkChars: 31 });
  const chunks = tokens.filter((token) => token.type === "string_chunk" && token.path[0] === "payload");
  assert.ok(chunks.length > 100);
  assert.ok(chunks.every((token) => token.value.length <= 31));
  assert.deepEqual(assembleRecords(tokens), [value]);
});

test("decodes Unicode escape sequences and surrogate pairs across tiny chunks", async () => {
  const input = Buffer.from('{"umlaut":"\\u00e4","surrogate":"\\uD83D\\uDE00"}\n', "utf8");
  const tokens = await collectTokens(byteChunks(input, 1), { maxStringChunkChars: 1 });
  assert.deepEqual(assembleRecords(tokens), [{ umlaut: "ä", surrogate: "😀" }]);
});

test("rejects invalid UTF-8, invalid JSON, truncation, two values, and multiline records", async () => {
  await expectAdapterError(byteChunks(Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d, 0x0a])), "JSONL_INVALID_UTF8");
  await expectAdapterError(byteChunks(Buffer.from("{bad}\n", "utf8")), "JSONL_INVALID_JSON");
  await expectAdapterError(byteChunks(Buffer.from('{"x":"cut', "utf8")), "JSONL_INVALID_JSON");
  await expectAdapterError(byteChunks(Buffer.from("{} []\n", "utf8")), "JSONL_INVALID_JSON");
  await expectAdapterError(byteChunks(Buffer.from('{"x":\n1}\n', "utf8")), "JSONL_INVALID_JSON");
});

test("stops after the first invalid record", async () => {
  const seen = [];
  await assert.rejects(async () => {
    for await (const token of streamJsonlTokens(byteChunks(Buffer.from('{}\n{"bad":}\n{"later":true}\n')))) seen.push(token);
  }, (error) => error.code === "JSONL_INVALID_JSON" && error.recordIndex === 2);
  assert.equal(seen.some((token) => token.recordIndex === 3), false);
  assert.deepEqual(seen.filter((token) => token.type === "record_end").map((token) => token.recordIndex), [1]);
});

test("enforces the explicit nesting and scalar protection limits", async () => {
  const accepted = "[[[0]]]\n";
  assert.deepEqual(assembleRecords(await collectTokens(byteChunks(Buffer.from(accepted)), { maxDepth: 3 })), [[[[0]]]]);
  await expectAdapterError(byteChunks(Buffer.from("[[[[0]]]]\n")), "JSONL_MAX_DEPTH_EXCEEDED", { maxDepth: 3 });
  await expectAdapterError(byteChunks(Buffer.from('{"toolong":1}\n')), "JSONL_KEY_TOO_LARGE", { maxKeyChars: 3 });
  await expectAdapterError(byteChunks(Buffer.from("12345\n")), "JSONL_NUMBER_TOO_LARGE", { maxNumberChars: 4 });

  const supportedDepth = `${"[".repeat(256)}0${"]".repeat(256)}\n`;
  assert.equal((await collectTokens(byteChunks(Buffer.from(supportedDepth)), { inputChunkBytes: 17 })).filter((token) => token.type === "array_start").length, 256);
  await expectAdapterError(byteChunks(Buffer.from(`${"[".repeat(257)}0${"]".repeat(257)}\n`)), "JSONL_MAX_DEPTH_EXCEEDED");
});

test("consumer cancellation and source errors close the input iterator", async () => {
  let cancelled = false;
  let produced = 0;
  async function* cancellable() {
    try {
      yield Buffer.from('{"large":"');
      for (;;) {
        produced += 1;
        yield Buffer.from("x".repeat(64 * 1024));
      }
    } finally {
      cancelled = true;
    }
  }
  for await (const token of streamJsonlTokens(cancellable())) {
    if (token.type === "string_chunk") break;
  }
  assert.equal(cancelled, true);
  assert.ok(produced <= 8, `consumer backpressure should bound source read-ahead, observed ${produced} chunks`);

  async function* failingSource() {
    yield Buffer.from('{"x":');
    throw new Error("synthetic read failure");
  }
  await expectAdapterError(failingSource(), "JSONL_INPUT_ERROR");
});

test("incrementally decodes Base64 with bounded blocks, SHA parity, and backpressure", async () => {
  const bytes = Buffer.alloc(512 * 1024 + 17, 0x5a);
  const encoded = bytes.toString("base64");
  let active = 0;
  let maxActive = 0;
  const output = [];
  const result = await decodeBase64Chunks((async function* () {
    for (let offset = 0; offset < encoded.length; offset += 7) yield encoded.slice(offset, offset + 7);
  })(), async (chunk) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await Promise.resolve();
    output.push(chunk);
    active -= 1;
  });
  assert.equal(maxActive, 1);
  assert.ok(result.maxDecodedBlockBytes <= 3072);
  assert.equal(result.decodedBytes, bytes.length);
  assert.equal(result.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.deepEqual(Buffer.concat(output), bytes);
});

test("preserves the synthetic embedded PNG SHA through tokenization and incremental decode", async () => {
  const record = { payload: { image_url: SMALL_PNG_DATA_URL } };
  const tokens = await collectTokens(byteChunks(Buffer.from(`${JSON.stringify(record)}\n`, "utf8"), 3), { maxStringChunkChars: 5 });
  const streamedValue = tokens
    .filter((token) => token.type === "string_chunk" && token.path.join(".") === "payload.image_url")
    .map((token) => token.value)
    .join("");
  const encoded = streamedValue.slice("data:image/png;base64,".length);
  const decoded = [];
  const result = await decodeBase64Chunks((async function* () {
    for (let offset = 0; offset < encoded.length; offset += 3) yield encoded.slice(offset, offset + 3);
  })(), async (chunk) => decoded.push(chunk));
  const expected = Buffer.from(SMALL_PNG_DATA_URL.slice("data:image/png;base64,".length), "base64");
  assert.deepEqual(Buffer.concat(decoded), expected);
  assert.equal(result.sha256, createHash("sha256").update(expected).digest("hex"));
});

test("rejects malformed Base64 and forwards sink failures", async () => {
  await assert.rejects(() => decodeBase64Chunks((async function* () { yield "not*base64"; })(), async () => {}), (error) => error instanceof BoundedBase64Error && error.code === "BASE64_INVALID_CHARACTER");
  await assert.rejects(() => decodeBase64Chunks((async function* () { yield "A"; })(), async () => {}), (error) => error.code === "BASE64_INVALID_LENGTH");
  await assert.rejects(() => decodeBase64Chunks((async function* () { yield "YQ==extra"; })(), async () => {}), (error) => error.code === "BASE64_TRAILING_DATA");
  await assert.rejects(() => decodeBase64Chunks((async function* () { yield "YQ=="; })(), async () => { throw new Error("synthetic write failure"); }), (error) => error.code === "BASE64_WRITE_ERROR");
  await assert.rejects(() => decodeBase64Chunks((async function* () { yield "YQ=="; })(), async () => {}, {
    hashFactory: () => ({ update() { throw new Error("synthetic hash failure"); }, digest() { return ""; } }),
  }), (error) => error.code === "BASE64_HASH_ERROR");
  const unpadded = [];
  await decodeBase64Chunks((async function* () { yield "Y"; yield "WI"; })(), async (chunk) => unpadded.push(chunk));
  assert.equal(Buffer.concat(unpadded).toString("utf8"), "ab");
});

test("file sink fails closed for write and unsupported hard-link errors", async () => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "codex-bounded-base64-io-")));
  try {
    const unsupported = path.join(temp, "unsupported.bin");
    await assert.rejects(() => writeBase64ChunksToFile((async function* () { yield "YQ=="; })(), unsupported, {
      io: { link: async () => { const error = new Error("synthetic unsupported hard link"); error.code = "ENOTSUP"; throw error; } },
    }), (error) => error.code === "BASE64_FILE_ERROR");
    assert.equal(await fs.stat(unsupported).then(() => true, () => false), false);
    assert.deepEqual(await fs.readdir(temp), []);

    const writeFailure = path.join(temp, "write-failure.bin");
    await assert.rejects(() => writeBase64ChunksToFile((async function* () { yield "YQ=="; })(), writeFailure, {
      io: {
        open: async (...args) => {
          const handle = await fs.open(...args);
          return {
            close: () => handle.close(),
            sync: () => handle.sync(),
            write: async () => { const error = new Error("synthetic full disk"); error.code = "ENOSPC"; throw error; },
          };
        },
      },
    }), (error) => error.code === "BASE64_WRITE_ERROR");
    assert.equal(await fs.stat(writeFailure).then(() => true, () => false), false);
    assert.deepEqual(await fs.readdir(temp), []);

    const denied = path.join(temp, "permission-denied.bin");
    await assert.rejects(() => writeBase64ChunksToFile((async function* () { yield "YQ=="; })(), denied, {
      io: {
        open: async () => { const error = new Error("synthetic permission denial"); error.code = "EACCES"; throw error; },
      },
    }), (error) => error.code === "BASE64_FILE_ERROR");
    assert.equal(await fs.stat(denied).then(() => true, () => false), false);
    assert.deepEqual(await fs.readdir(temp), []);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("publishes decoded files atomically and cleans temporary files on success and failure", async () => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "codex-bounded-base64-")));
  try {
    const payload = Buffer.from("bounded file payload");
    const destination = path.join(temp, "payload.bin");
    const result = await writeBase64ChunksToFile((async function* () { yield payload.toString("base64"); })(), destination);
    assert.deepEqual(await fs.readFile(destination), payload);
    assert.equal(result.sha256, createHash("sha256").update(payload).digest("hex"));
    assert.deepEqual((await fs.readdir(temp)).sort(), ["payload.bin"]);

    const preserved = path.join(temp, "preserved.bin");
    await fs.writeFile(preserved, "keep", "utf8");
    await assert.rejects(() => writeBase64ChunksToFile((async function* () { yield "YQ=="; })(), preserved), (error) => error.code === "BASE64_FILE_ERROR");
    assert.equal(await fs.readFile(preserved, "utf8"), "keep");
    assert.deepEqual((await fs.readdir(temp)).sort(), ["payload.bin", "preserved.bin"]);

    const failed = path.join(temp, "failed.bin");
    await assert.rejects(() => writeBase64ChunksToFile((async function* () { yield "YQ"; throw new Error("synthetic decode source failure"); })(), failed), (error) => error.code === "BASE64_INPUT_ERROR");
    assert.equal(await fs.stat(failed).then(() => true, () => false), false);
    assert.deepEqual((await fs.readdir(temp)).sort(), ["payload.bin", "preserved.bin"]);

    const concurrent = path.join(temp, "concurrent.bin");
    const first = Buffer.from("first complete payload");
    const second = Buffer.from("second complete payload");
    const outcomes = await Promise.allSettled([
      writeBase64ChunksToFile((async function* () { yield first.toString("base64"); })(), concurrent),
      writeBase64ChunksToFile((async function* () { yield second.toString("base64"); })(), concurrent),
    ]);
    assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
    assert.equal(outcomes.filter((outcome) => outcome.status === "rejected" && outcome.reason.code === "BASE64_FILE_ERROR").length, 1);
    const published = await fs.readFile(concurrent);
    assert.ok(published.equals(first) || published.equals(second));
    assert.deepEqual((await fs.readdir(temp)).sort(), ["concurrent.bin", "payload.bin", "preserved.bin"]);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});
