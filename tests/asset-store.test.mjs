import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  AssetStoreError,
  DeduplicatedAssetStore,
  detectAssetType,
  probeHardLinkSupport,
} from "../lib/asset-store.mjs";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
const GIF = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00]);
const WEBP = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x12, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x4c, 0x05, 0x00, 0x00, 0x00, 0x2f, 0x00, 0x00, 0x00, 0x00, 0x00]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', "utf8");
const PNG_VARIANT = Buffer.from(PNG);
PNG_VARIANT[PNG_VARIANT.length - 1] ^= 0x01;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function statIdentity(stat) {
  return `${stat.dev}:${stat.ino}`;
}

async function inspectDestination(destination) {
  try {
    const stat = await fs.lstat(destination, { bigint: true });
    return { exists: true, identity: statIdentity(stat), stat };
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false };
    throw error;
  }
}

async function createHarness(root, options = {}) {
  const exportRoot = path.resolve(root);
  const assetRoot = path.join(exportRoot, "assets");
  const manifestPath = path.join(assetRoot, "manifest.json");
  await fs.mkdir(assetRoot, { recursive: true });
  const publishManifest = options.publishManifest || (async (content) => {
    try {
      await fs.writeFile(manifestPath, content, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if (error?.code !== "EEXIST" || await fs.readFile(manifestPath, "utf8") !== content) throw error;
    }
  });
  const store = await DeduplicatedAssetStore.create({
    assetRoot,
    exportRoot,
    assertDestination: options.assertDestination || inspectDestination,
    publishManifest,
    io: options.io,
  });
  return { assetRoot, exportRoot, manifestPath, store };
}

async function addRecord(store, sessionId, recordNumber, attachments) {
  const descriptors = [];
  for (const attachment of attachments) {
    const sink = await store.beginAttachment({
      mediaType: attachment.declaredMime || "",
      recordNumber,
      sourceKind: attachment.sourceKind || "data_url",
    });
    const chunks = attachment.chunks || [attachment.bytes];
    for (const chunk of chunks) await sink.write(chunk);
    const descriptor = {
      decodedBytes: attachment.bytes.length,
      mediaType: attachment.declaredMime || "",
      sha256: sha256(attachment.bytes),
      sourceKind: attachment.sourceKind || "data_url",
    };
    await sink.finish(descriptor);
    descriptors.push(descriptor);
  }
  await store.commitRecord(sessionId, recordNumber, descriptors);
  return descriptors;
}

async function assetEntries(assetRoot) {
  return (await fs.readdir(assetRoot, { withFileTypes: true })).map((entry) => entry.name).sort();
}

test("bounded header detection accepts allowlisted raster signatures and rejects active or truncated content", () => {
  assert.deepEqual(detectAssetType(PNG), { extension: "png", mimeType: "image/png", renderable: true });
  assert.deepEqual(detectAssetType(JPEG), { extension: "jpg", mimeType: "image/jpeg", renderable: true });
  assert.deepEqual(detectAssetType(GIF), { extension: "gif", mimeType: "image/gif", renderable: true });
  assert.deepEqual(detectAssetType(WEBP), { extension: "webp", mimeType: "image/webp", renderable: true });
  for (const bytes of [PNG.subarray(0, 8), PNG.subarray(0, 32), JPEG.subarray(0, 3), JPEG.subarray(0, 19), Buffer.from([0xff, 0xd8, 0xff, 0x01, 0x00, 0x02]), GIF.subarray(0, 6), WEBP.subarray(0, 12), WEBP.subarray(0, 25), SVG, Buffer.from("<html><img src=x onerror=alert(1)>")]) {
    assert.deepEqual(detectAssetType(bytes), { extension: "bin", mimeType: "application/octet-stream", renderable: false });
  }
  const manipulatedPng = Buffer.from(PNG);
  manipulatedPng.writeUInt32BE(0, 16);
  assert.equal(detectAssetType(manipulatedPng).renderable, false);
  const ambiguous = Buffer.concat([PNG, GIF]);
  assert.equal(detectAssetType(ambiguous).extension, "png", "the first complete allowlisted signature has deterministic precedence");
});

test("the store rejects a write block larger than the productive decoder bound", async () => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "codex-assets-block-bound-")));
  try {
    const { assetRoot, store } = await createHarness(temp);
    const sink = await store.beginAttachment({ mediaType: "application/octet-stream", recordNumber: 1, sourceKind: "data_url" });
    await assert.rejects(() => sink.write(Buffer.alloc(3073)), (error) => error instanceof AssetStoreError && error.code === "ASSET_WRITE_ERROR");
    await store.abort();
    assert.deepEqual(await assetEntries(assetRoot), []);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("declared MIME and session metadata cannot create paths or leak path-like manifest values", async () => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "codex-assets-metadata-")));
  try {
    const { store } = await createHarness(temp);
    await addRecord(store, "session-safe", 1, [{ bytes: SVG, declaredMime: "image/png/../../escape" }]);
    const publication = await store.publish();
    const manifest = JSON.parse(publication.content);
    assert.equal(manifest.assets[0].path, `assets/${sha256(SVG)}.bin`);
    assert.equal(Object.hasOwn(manifest.assets[0].uses[0], "declared_mime"), false);
    assert.doesNotMatch(publication.content, /escape|\.\.|\\/);

    const unsafeSession = await createHarness(path.join(temp, "unsafe-session"));
    const sink = await unsafeSession.store.beginAttachment({ mediaType: "image/png", recordNumber: 1, sourceKind: "data_url" });
    await sink.write(PNG);
    const descriptor = { decodedBytes: PNG.length, mediaType: "image/png", sha256: sha256(PNG), sourceKind: "data_url" };
    await sink.finish(descriptor);
    await assert.rejects(() => unsafeSession.store.commitRecord("C:\\private\\session", 1, [descriptor]), (error) => error instanceof AssetStoreError && error.code === "ASSET_RECORD_STATE_ERROR");
    await unsafeSession.store.abortRecord(1);
    await unsafeSession.store.abort();
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("deduplication preserves every ordered usage while canonical bytes control MIME, extension, and links", async () => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "codex-assets-dedupe-")));
  try {
    const { assetRoot, store } = await createHarness(temp);
    const firstDescriptors = await addRecord(store, "session-a", 2, [
      { bytes: PNG, chunks: [PNG.subarray(0, 3), PNG.subarray(3, 17), PNG.subarray(17)], declaredMime: "image/jpeg" },
      { bytes: PNG, declaredMime: "image/png" },
    ]);
    await addRecord(store, "session-b", 4, [{ bytes: PNG, declaredMime: "IMAGE/PNG" }]);
    await addRecord(store, "session-a", 7, [{ bytes: JPEG, declaredMime: "image/jpeg" }, { bytes: SVG, declaredMime: "image/svg+xml" }]);
    const publication = await store.publish();
    const manifest = JSON.parse(publication.content);
    assert.equal(manifest.schema_version, 1);
    assert.equal(manifest.hash_algorithm, "sha256");
    assert.deepEqual(manifest.assets.map((asset) => asset.sha256), manifest.assets.map((asset) => asset.sha256).toSorted());
    assert.equal(manifest.assets.length, 3);
    assert.equal(publication.summary.assetOccurrences, 5);
    assert.equal(publication.summary.uniqueAssets, 3);
    assert.equal(publication.summary.uniqueAssetBytes, PNG.length + JPEG.length + SVG.length);
    assert.equal(publication.summary.deduplicatedBytesSaved, PNG.length * 2);
    assert.ok(publication.summary.maxWriteBlockBytes <= Math.max(PNG.length, JPEG.length, SVG.length));
    const png = manifest.assets.find((asset) => asset.sha256 === sha256(PNG));
    assert.equal(png.path, `assets/${sha256(PNG)}.png`);
    assert.equal(png.mime_type, "image/png");
    assert.equal(png.renderable, true);
    assert.deepEqual(png.uses, [
      { attachment_ordinal: 1, record_ordinal: 2, session_id: "session-a", declared_mime: "image/jpeg", mime_mismatch: true },
      { attachment_ordinal: 2, record_ordinal: 2, session_id: "session-a", declared_mime: "image/png", mime_mismatch: false },
      { attachment_ordinal: 1, record_ordinal: 4, session_id: "session-b", declared_mime: "image/png", mime_mismatch: false },
    ]);
    const svg = manifest.assets.find((asset) => asset.sha256 === sha256(SVG));
    assert.equal(svg.extension, "bin");
    assert.equal(svg.mime_type, "application/octet-stream");
    assert.equal(svg.renderable, false);
    assert.equal(svg.uses[0].declared_mime, "image/svg+xml");
    assert.equal(svg.uses[0].mime_mismatch, true);
    assert.deepEqual(store.referencesForSession("session-a").map((reference) => reference.path), [png.path, png.path, manifest.assets.find((asset) => asset.sha256 === sha256(JPEG)).path, svg.path]);
    assert.equal(store.assetForDescriptor(firstDescriptors[0]).path, png.path);
    assert.ok(manifest.assets.every((asset) => !path.isAbsolute(asset.path) && !asset.path.includes("\\") && !asset.path.includes("..")));
    assert.deepEqual(await assetEntries(assetRoot), [
      `${sha256(JPEG)}.jpg`,
      `${sha256(PNG)}.png`,
      `${sha256(SVG)}.bin`,
      "manifest.json",
    ].sort());
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("an attachment-free export still publishes the stable empty schema", async () => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "codex-assets-empty-")));
  try {
    const { store } = await createHarness(temp);
    await store.commitRecord("session-empty", 1, []);
    const publication = await store.publish();
    assert.equal(publication.content, '{\n  "schema_version": 1,\n  "hash_algorithm": "sha256",\n  "assets": []\n}\n');
    assert.deepEqual(publication.summary, { assetOccurrences: 0, deduplicatedBytesSaved: 0, maxWriteBlockBytes: 0, uniqueAssetBytes: 0, uniqueAssets: 0 });
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("independent runs are byte-reproducible and safely reuse only verified identical assets", async () => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "codex-assets-repeat-")));
  try {
    const first = await createHarness(path.join(temp, "first"));
    await addRecord(first.store, "session-repeat", 1, [{ bytes: GIF, declaredMime: "image/gif" }, { bytes: PNG, declaredMime: "image/png" }, { bytes: PNG_VARIANT, declaredMime: "image/png" }]);
    const firstPublication = await first.store.publish();
    const second = await createHarness(path.join(temp, "second"));
    await addRecord(second.store, "session-repeat", 1, [{ bytes: GIF, declaredMime: "image/gif" }, { bytes: PNG, declaredMime: "image/png" }, { bytes: PNG_VARIANT, declaredMime: "image/png" }]);
    const secondPublication = await second.store.publish();
    assert.equal(secondPublication.content, firstPublication.content);
    assert.deepEqual(await fs.readFile(path.join(first.assetRoot, `${sha256(PNG)}.png`)), await fs.readFile(path.join(second.assetRoot, `${sha256(PNG)}.png`)));

    const reuse = await createHarness(path.join(temp, "first"));
    await addRecord(reuse.store, "session-repeat", 1, [{ bytes: GIF, declaredMime: "image/gif" }, { bytes: PNG, declaredMime: "image/png" }, { bytes: PNG_VARIANT, declaredMime: "image/png" }]);
    assert.equal((await reuse.store.publish()).content, firstPublication.content);

    const conflictRoot = path.join(temp, "conflict");
    const conflict = await createHarness(conflictRoot);
    const conflictPath = path.join(conflict.assetRoot, `${sha256(PNG)}.png`);
    const foreign = Buffer.from("foreign-content");
    await fs.writeFile(conflictPath, foreign, { flag: "wx" });
    await assert.rejects(() => addRecord(conflict.store, "session-conflict", 1, [{ bytes: PNG, declaredMime: "image/png" }]), (error) => error instanceof AssetStoreError && error.code === "ASSET_EXISTING_MISMATCH");
    await conflict.store.abort();
    assert.deepEqual(await fs.readFile(conflictPath), foreign, "a conflicting pre-existing file must remain untouched");
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("asset and manifest failures clean only proven run-owned files at first, middle, and last publication points", async () => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "codex-assets-errors-")));
  try {
    for (const failAt of [1, 2, 3]) {
      let links = 0;
      const root = path.join(temp, `asset-${failAt}`);
      const harness = await createHarness(root, {
        io: {
          link: async (source, destination) => {
            links += 1;
            if (links === failAt) throw Object.assign(new Error("synthetic asset publication failure"), { code: "ENOSPC" });
            return fs.link(source, destination);
          },
        },
      });
      await assert.rejects(async () => {
        await addRecord(harness.store, "session-errors", 1, [{ bytes: PNG, declaredMime: "image/png" }]);
        await addRecord(harness.store, "session-errors", 2, [{ bytes: JPEG, declaredMime: "image/jpeg" }]);
        await addRecord(harness.store, "session-errors", 3, [{ bytes: GIF, declaredMime: "image/gif" }]);
      }, (error) => error instanceof AssetStoreError && error.code === "ASSET_PUBLISH_ERROR");
      await harness.store.abort();
      assert.deepEqual(await assetEntries(harness.assetRoot), []);
    }

    for (const mode of ["generate", "publish", "existing", "concurrent"] ) {
      const root = path.join(temp, `manifest-${mode}`);
      const manifestPath = path.join(root, "assets", "manifest.json");
      if (mode === "existing") {
        await fs.mkdir(path.dirname(manifestPath), { recursive: true });
        await fs.writeFile(manifestPath, "foreign manifest\n", "utf8");
      }
      const harness = await createHarness(root, {
        publishManifest: mode === "publish"
          ? async () => { throw Object.assign(new Error("synthetic manifest publication failure"), { code: "ENOSPC" }); }
          : mode === "existing"
            ? async (content) => fs.writeFile(manifestPath, content, { encoding: "utf8", flag: "wx" })
            : mode === "concurrent"
              ? async () => {
                  await fs.writeFile(manifestPath, "concurrent manifest\n", { encoding: "utf8", flag: "wx" });
                  throw Object.assign(new Error("concurrent manifest publication"), { code: "EEXIST" });
                }
            : undefined,
      });
      await addRecord(harness.store, "session-manifest", 1, [{ bytes: PNG, declaredMime: "image/png" }]);
      if (mode === "generate") harness.store.manifestObject = () => { throw new Error("synthetic manifest generation failure"); };
      await assert.rejects(() => harness.store.publish(), (error) => error instanceof AssetStoreError && error.code === "ASSET_MANIFEST_ERROR");
      await harness.store.abort();
      const remaining = await assetEntries(harness.assetRoot);
      assert.deepEqual(remaining, ["existing", "concurrent"].includes(mode) ? ["manifest.json"] : []);
      if (mode === "existing") assert.equal(await fs.readFile(manifestPath, "utf8"), "foreign manifest\n");
      if (mode === "concurrent") assert.equal(await fs.readFile(manifestPath, "utf8"), "concurrent manifest\n");
    }

    const pending = await createHarness(path.join(temp, "pending"));
    const firstPending = await pending.store.beginAttachment({ mediaType: "image/png", recordNumber: 1, sourceKind: "data_url" });
    const secondPending = await pending.store.beginAttachment({ mediaType: "image/png", recordNumber: 1, sourceKind: "data_url" });
    await firstPending.write(PNG);
    await secondPending.write(PNG_VARIANT);
    await pending.store.abort();
    assert.deepEqual(await assetEntries(pending.assetRoot), [], "abort must clean every pending stage even when multiple stages share a record");
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("concurrent asset publication and unsafe roots fail closed without deleting foreign files", async () => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "codex-assets-races-")));
  try {
    for (const [name, foreign] of [["different", Buffer.from("concurrent foreign file")], ["identical", PNG]]) {
      let foreignPath = "";
      const concurrent = await createHarness(path.join(temp, `concurrent-${name}`), {
        io: {
          link: async (_source, destination) => {
            foreignPath = destination;
            await fs.writeFile(destination, foreign, { flag: "wx" });
            throw Object.assign(new Error("concurrent target"), { code: "EEXIST" });
          },
        },
      });
      await assert.rejects(() => addRecord(concurrent.store, "session-race", 1, [{ bytes: PNG, declaredMime: "image/png" }]), (error) => error instanceof AssetStoreError && error.code === "ASSET_PUBLISH_ERROR");
      await concurrent.store.abort();
      assert.deepEqual(await fs.readFile(foreignPath), foreign, `a concurrently published ${name} target must remain untouched`);
    }

    const exchanged = await createHarness(path.join(temp, "exchanged"), {
      io: {
        link: async (_source, destination) => {
          await fs.unlink(destination);
          await fs.writeFile(destination, SVG, { flag: "wx" });
          throw Object.assign(new Error("checked target exchanged"), { code: "EEXIST" });
        },
      },
    });
    const exchangedPath = path.join(exchanged.assetRoot, `${sha256(PNG)}.png`);
    await fs.writeFile(exchangedPath, PNG, { flag: "wx" });
    await assert.rejects(() => addRecord(exchanged.store, "session-exchange", 1, [{ bytes: PNG, declaredMime: "image/png" }]), (error) => error instanceof AssetStoreError && error.code === "ASSET_EXISTING_MISMATCH");
    await exchanged.store.abort();
    assert.deepEqual(await fs.readFile(exchangedPath), SVG, "an exchanged pre-existing target must not be deleted");

    const manipulated = await createHarness(path.join(temp, "manipulated"));
    await addRecord(manipulated.store, "session-manipulated", 1, [{ bytes: PNG, declaredMime: "image/png" }]);
    const manipulatedPath = path.join(manipulated.assetRoot, `${sha256(PNG)}.png`);
    await fs.writeFile(manipulatedPath, SVG);
    await assert.rejects(() => manipulated.store.publish(), (error) => error instanceof AssetStoreError && error.code === "ASSET_EXISTING_MISMATCH");
    await manipulated.store.abort();
    assert.equal(await fs.stat(manipulatedPath).then(() => true, () => false), false, "a manipulated file still proven run-owned must be removed on abort");

    assert.throws(() => new DeduplicatedAssetStore({
      assetRoot: path.join(temp, "outside"),
      exportRoot: path.join(temp, "export"),
      assertDestination() {},
      publishManifest() {},
    }), /assetRoot must be/);

    const target = path.join(temp, "junction-target");
    const exportRoot = path.join(temp, "junction-export");
    await fs.mkdir(target);
    await fs.mkdir(exportRoot);
    const junction = path.join(exportRoot, "assets");
    try {
      await fs.symlink(target, junction, process.platform === "win32" ? "junction" : "dir");
      await assert.rejects(() => DeduplicatedAssetStore.create({
        assetRoot: junction,
        exportRoot,
        assertDestination: inspectDestination,
        publishManifest() {},
      }), (error) => error instanceof AssetStoreError && error.code === "ASSET_PATH_UNSAFE");
    } catch (error) {
      if (!["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) throw error;
    }
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("hard-link preflight reports supported targets and every required simulated failure without residue", async () => {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "codex-assets-probe-")));
  try {
    assert.deepEqual(await probeHardLinkSupport(temp), { supported: true });
    assert.deepEqual(await fs.readdir(temp), []);
    for (const code of ["ENOTSUP", "EPERM", "EXDEV", "EACCES", "ENOSPC", "EEXIST"]) {
      await assert.rejects(() => probeHardLinkSupport(temp, {
        io: { link: async () => { throw Object.assign(new Error(`synthetic ${code}`), { code }); } },
      }), (error) => error instanceof AssetStoreError
        && error.code === "ASSET_HARDLINK_UNSUPPORTED"
        && /No existing files were overwritten/.test(error.message)
        && /supported local filesystem/.test(error.message));
      assert.deepEqual(await fs.readdir(temp), [], `probe residue after ${code}`);
    }
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});
