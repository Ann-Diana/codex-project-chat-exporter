import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  SESSION_KIND,
  USER_RECORD_KIND,
  copyStableRawSnapshot,
  createSessionEventClassifier,
  readSessionRoutingMeta,
  resolveDisplayTitle,
  sha256File,
  validatedSourceRelativePath,
} from "../bin/export-codex-project-chats.mjs";

function sessionMeta(overrides = {}) {
  return { type: "session_meta", timestamp: "2026-08-16T10:00:00.000Z", payload: { id: "session-test", cwd: "C:\\Projects\\alpha", timestamp: "2026-08-16T10:00:00.000Z", source: "vscode", thread_source: "user", ...overrides } };
}

function responseUser(text, turnId, timestamp) {
  return { type: "response_item", timestamp, payload: { type: "message", role: "user", content: [{ type: "input_text", text }], internal_chat_message_metadata_passthrough: { turn_id: turnId } } };
}

function responseUserContent(content, turnId, timestamp) {
  return { type: "response_item", timestamp, payload: { type: "message", role: "user", content, internal_chat_message_metadata_passthrough: { turn_id: turnId } } };
}

function eventUser(text, timestamp, overrides = {}) {
  return { type: "event_msg", timestamp, payload: { type: "user_message", message: text, images: [], local_images: [], ...overrides } };
}

function classify(items) {
  const classifier = createSessionEventClassifier();
  items.forEach((item, index) => classifier.observe(item, index + 1));
  return classifier.finish();
}

{
  const result = classify([
    sessionMeta(),
    responseUser("# AGENTS.md instructions\n<environment_context>automatic</environment_context>", "turn-1", "2026-08-16T10:00:01.000Z"),
    { type: "turn_context", timestamp: "2026-08-16T10:00:01.100Z", payload: { cwd: "C:\\Projects\\alpha" } },
    responseUser("Please inspect AGENTS.md and the literal tag <environment_context> without treating this as runtime context.", "turn-1", "2026-08-16T10:00:02.000Z"),
    eventUser("Please inspect AGENTS.md and the literal tag <environment_context> without treating this as runtime context.", "2026-08-16T10:00:02.001Z"),
  ]);
  assert.equal(result.sessionKind, SESSION_KIND.DIRECT_USER);
  assert.equal(result.classifications.get(2).kind, USER_RECORD_KIND.AUTOMATIC_RUNTIME_CONTEXT);
  assert.deepEqual(result.classifications.get(2).runtimeContextTypes, ["AGENTS", "ENVIRONMENT"]);
  assert.equal(result.classifications.get(4).kind, USER_RECORD_KIND.DIRECT_USER_TURN, "quoted technical terms must remain a genuine user turn");
  assert.equal(result.directUserMessages, 1);
}

{
  const result = classify([
    sessionMeta(),
    responseUser("<environment_context>automatic</environment_context>", "turn-1", "2026-08-16T10:00:01.000Z"),
    responseUser("<recommended_plugins>automatic</recommended_plugins>", "turn-1", "2026-08-16T10:00:01.100Z"),
    responseUser("First request", "turn-1", "2026-08-16T10:00:02.000Z"),
    eventUser("First request", "2026-08-16T10:00:02.000Z"),
    responseUser("<plugins_instructions>later automatic</plugins_instructions>", "turn-2", "2026-08-16T10:01:01.000Z"),
    responseUser("Second request", "turn-2", "2026-08-16T10:01:02.000Z"),
    eventUser("Second request", "2026-08-16T10:01:02.000Z"),
  ]);
  assert.equal(result.runtimeContexts, 3, "multiple and later runtime contexts must remain distinct");
  assert.equal(result.directUserMessages, 2);
  assert.equal(result.classifications.get(2).kind, USER_RECORD_KIND.AUTOMATIC_RUNTIME_CONTEXT);
  assert.equal(result.classifications.get(3).kind, USER_RECORD_KIND.AUTOMATIC_RUNTIME_CONTEXT);
  assert.equal(result.classifications.get(6).kind, USER_RECORD_KIND.AUTOMATIC_RUNTIME_CONTEXT);
}

{
  const result = classify([
    sessionMeta({ source: { subagent: { other: "guardian" } }, thread_source: "subagent", parent_thread_id: "parent-session" }),
    responseUser("[1] user: earlier text\n[7] assistant: later text", "turn-1", "2026-08-16T10:00:01.000Z"),
    eventUser("[1] user: earlier text\n[7] assistant: later text", "2026-08-16T10:00:01.000Z"),
  ]);
  assert.equal(result.sessionKind, SESSION_KIND.SUBAGENT);
  assert.equal(result.classifications.get(2).kind, USER_RECORD_KIND.SUBAGENT_INPUT);
  assert.equal(result.firstDirectUserText, "");
  assert.equal(resolveDisplayTitle({ id: "session-test", sessionKind: result.sessionKind, firstUserText: "", eventAnalysis: result }, "# AGENTS.md instructions").source, "neutral_subagent");
}

{
  const result = classify([
    sessionMeta({ source: "unknown", thread_source: undefined }),
    responseUser("Possibly user-authored, but structurally unconfirmed", "turn-only", "2026-08-16T10:00:01.000Z"),
  ]);
  assert.equal(result.classifications.get(2).kind, USER_RECORD_KIND.UNCLASSIFIED_USER_ROLE_RECORD);
  const title = resolveDisplayTitle({ id: "session-test", sessionKind: result.sessionKind, firstUserText: "", eventAnalysis: result }, "");
  assert.equal(title.source, "neutral_no_user");
}

{
  const repeated = "Same deliberate user message";
  const result = classify([
    sessionMeta(),
    responseUser(repeated, "turn-1", "2026-08-16T10:00:01.000Z"),
    eventUser(repeated, "2026-08-16T10:00:01.000Z"),
    responseUser(repeated, "turn-2", "2026-08-16T10:01:01.000Z"),
    eventUser(repeated, "2026-08-16T10:01:01.000Z"),
  ]);
  assert.equal(result.directUserMessages, 2, "identical genuine turns must not be merged");
}

{
  const result = classify([
    sessionMeta(),
    responseUserContent([
      { type: "input_text", text: "Deliberate user input" },
      { type: "input_text", text: "<image name=fixture>" },
      { type: "input_image", image_url: "data:image/png;base64,fixture" },
      { type: "input_text", text: "</image>" },
    ], "turn-1", "2026-08-16T10:00:01.000Z"),
    eventUser("Deliberate user input", "2026-08-16T10:00:01.001Z", { images: ["data:image/png;base64,fixture"] }),
  ]);
  assert.equal(result.directUserMessages, 1, "structural mirror records may use a different text representation");
  assert.equal(result.classifications.get(2).kind, USER_RECORD_KIND.DIRECT_USER_TURN);
}

{
  const result = classify([
    sessionMeta(),
    responseUser("First genuine message", "turn-1", "2026-08-16T10:00:01.000Z"),
    eventUser("Second, different genuine message", "2026-08-16T10:00:01.001Z"),
  ]);
  assert.equal(result.directUserMessages, 0, "adjacency and a 2 ms window must not pair different genuine messages");
  assert.equal(result.classifications.get(2).kind, USER_RECORD_KIND.UNCLASSIFIED_USER_ROLE_RECORD);
}

{
  const text = "Same text and count, different local images";
  const result = classify([
    sessionMeta(),
    responseUserContent([
      { type: "input_text", text },
      { type: "input_image", image_url: "C:\\Synthetic\\first-local-image.png" },
    ], "turn-1", "2026-08-16T10:00:01.000Z"),
    eventUser(text, "2026-08-16T10:00:01.001Z", { local_images: ["C:\\Synthetic\\second-local-image.png"] }),
    responseUser("Later genuine message in the same turn", "turn-1", "2026-08-16T10:00:02.000Z"),
    eventUser("Later genuine message in the same turn", "2026-08-16T10:00:02.001Z"),
  ]);
  assert.equal(result.directUserMessages, 1, "equal local attachment counts must not establish attachment identity");
  assert.equal(result.classifications.get(2).kind, USER_RECORD_KIND.UNCLASSIFIED_USER_ROLE_RECORD);
  assert.equal(result.classifications.get(2).mirrorRejected, true);
  assert.equal(result.runtimeContexts, 0, "a rejected mirror candidate must not fall back to automatic runtime context");
}

{
  const text = "Same text and count, unprovable local image identity";
  const result = classify([
    sessionMeta(),
    responseUserContent([
      { type: "input_text", text },
      { type: "input_image", image_url: "data:image/png;base64,embedded-image-bytes" },
    ], "turn-1", "2026-08-16T10:00:01.000Z"),
    eventUser(text, "2026-08-16T10:00:01.001Z", { local_images: ["C:\\Synthetic\\local-image.png"] }),
  ]);
  assert.equal(result.directUserMessages, 0, "different attachment representations must fail closed when identity cannot be proven");
  assert.equal(result.classifications.get(2).kind, USER_RECORD_KIND.UNCLASSIFIED_USER_ROLE_RECORD);
}

{
  const text = "Same text and exact local image reference";
  const localImage = "C:\\Synthetic\\same-local-image.png";
  const result = classify([
    sessionMeta(),
    responseUserContent([
      { type: "input_text", text },
      { type: "input_image", image_url: localImage },
    ], "turn-1", "2026-08-16T10:00:01.000Z"),
    eventUser(text, "2026-08-16T10:00:01.001Z", { local_images: [localImage] }),
  ]);
  assert.equal(result.directUserMessages, 1, "an exact ordered local attachment reference may establish identity");
  assert.equal(result.classifications.get(2).kind, USER_RECORD_KIND.DIRECT_USER_TURN);
}

{
  const result = classify([
    sessionMeta(),
    { type: "response_item", timestamp: "2026-08-16T10:00:01.000Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Legacy message without turn ID" }] } },
    eventUser("Legacy message without turn ID", "2026-08-16T10:00:01.026Z"),
  ]);
  assert.equal(result.directUserMessages, 1, "matching content and adjacency must support the observed schema without turn IDs");
}

{
  const literal = "Please explain the literal <image> element.";
  const result = classify([
    sessionMeta(),
    responseUser(literal, "turn-1", "2026-08-16T10:00:01.000Z"),
    eventUser(literal, "2026-08-16T10:00:01.001Z"),
  ]);
  assert.equal(result.directUserMessages, 1, "literal image markup without an adjacent input_image must remain user content");
}

{
  const result = classify([
    sessionMeta(),
    responseUserContent([
      { type: "input_text", text: "Same text, different attachment" },
      { type: "input_image", image_url: "data:image/png;base64,first" },
    ], "turn-1", "2026-08-16T10:00:01.000Z"),
    eventUser("Same text, different attachment", "2026-08-16T10:00:01.001Z", { images: ["data:image/png;base64,second"] }),
  ]);
  assert.equal(result.directUserMessages, 0, "different non-local image attachments must not be paired by equal text alone");
  assert.equal(result.classifications.get(2).kind, USER_RECORD_KIND.UNCLASSIFIED_USER_ROLE_RECORD);
}

{
  const result = classify([
    sessionMeta(),
    responseUser("Unconfirmed user-role record", "turn-1", "2026-08-16T10:00:01.000Z"),
    eventUser("Unconfirmed user-role record", "2026-08-16T10:00:01.101Z"),
  ]);
  assert.equal(result.directUserMessages, 0, "events outside the bounded mirror timestamp window must not be coupled");
  assert.equal(result.classifications.get(2).kind, USER_RECORD_KIND.UNCLASSIFIED_USER_ROLE_RECORD);
}

{
  const root = path.join("C:\\CodexHome", "sessions");
  const source = path.join(root, "2026", "08", "16", "rollout-test.jsonl");
  assert.equal(validatedSourceRelativePath(source, root), "2026/08/16/rollout-test.jsonl");
  assert.throws(() => validatedSourceRelativePath("C:\\outside\\rollout.jsonl", root), /outside its declared/);
}

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "codex-exporter-classifier-"));
try {
  const source = path.join(temp, "source.jsonl");
  const destination = path.join(temp, "raw", "snapshot.jsonl");
  await fs.writeFile(source, `${JSON.stringify(sessionMeta())}\n`, "utf8");
  const snapshot = await copyStableRawSnapshot(source, destination);
  assert.equal(snapshot.attempts, 1);
  assert.equal(snapshot.sha256, await sha256File(destination));
  assert.equal(await sha256File(source), await sha256File(destination), "stable snapshot bytes must match the source bytes");
  assert.equal(snapshot.sourceBeforeSizeBytes, snapshot.sourceAfterSizeBytes);
  assert.equal(snapshot.sourceBeforeMtimeMs, snapshot.sourceAfterMtimeMs);

  await assert.rejects(() => copyStableRawSnapshot(source, source, { maxAttempts: 1 }), (error) => error?.code === "OUTPUT_OVERLAPS_SOURCE");
  assert.equal(await fs.readFile(source, "utf8"), `${JSON.stringify(sessionMeta())}\n`, "the validated same-path reproduction must leave the source unchanged");

  const existingDestination = path.join(temp, "raw", "existing.jsonl");
  await fs.mkdir(path.dirname(existingDestination), { recursive: true });
  await fs.writeFile(existingDestination, "PREVIOUS", "utf8");
  await assert.rejects(() => copyStableRawSnapshot(source, existingDestination, {
    maxAttempts: 1,
    io: {
      hashFile: async (file) => {
        if (path.resolve(file) === path.resolve(existingDestination)) {
          const error = new Error("synthetic published hash failure");
          error.code = "EIO";
          throw error;
        }
        return sha256File(file);
      },
    },
  }), (error) => error?.code === "SOURCE_SNAPSHOT_FAILED");
  assert.equal(await fs.readFile(existingDestination, "utf8"), "PREVIOUS", "a failed export must restore rather than delete a pre-existing destination");

  const hardlinkDestination = path.join(temp, "raw", "hardlink-source.jsonl");
  await fs.link(source, hardlinkDestination);
  await assert.rejects(() => copyStableRawSnapshot(source, hardlinkDestination, { maxAttempts: 1 }), (error) => error?.code === "OUTPUT_OVERLAPS_SOURCE");
  assert.equal(await fs.readFile(source, "utf8"), `${JSON.stringify(sessionMeta())}\n`, "hardlink alias rejection must preserve the source");

  const symlinkDestination = path.join(temp, "raw", "symlink-source.jsonl");
  try {
    await fs.symlink(source, symlinkDestination, "file");
    await assert.rejects(() => copyStableRawSnapshot(source, symlinkDestination, { maxAttempts: 1 }), (error) => error?.code === "UNSAFE_EXPORT_PATH");
    assert.equal(await fs.readFile(source, "utf8"), `${JSON.stringify(sessionMeta())}\n`, "symlink alias rejection must preserve the source");
  } catch (error) {
    if (!["EPERM", "EACCES", "ENOSYS"].includes(error?.code)) throw error;
  }

  const occupiedTemporary = path.join(temp, "raw", "occupied.partial");
  await fs.link(source, occupiedTemporary);
  await assert.rejects(() => copyStableRawSnapshot(source, path.join(temp, "raw", "occupied-target.jsonl"), {
    maxAttempts: 1,
    makeTemporaryPath: () => occupiedTemporary,
  }), (error) => error?.code === "UNSAFE_EXPORT_PATH");
  assert.equal(await fs.readFile(source, "utf8"), `${JSON.stringify(sessionMeta())}\n`, "an occupied temporary alias must never be removed or overwritten");

  const changedDestination = path.join(temp, "raw", "changed.jsonl");
  await assert.rejects(() => copyStableRawSnapshot(source, changedDestination, {
    maxAttempts: 1,
    afterCopy: async () => fs.appendFile(source, `${JSON.stringify({ type: "event_msg", payload: { type: "task_started" } })}\n`, "utf8"),
  }), (error) => error?.code === "SOURCE_CHANGED_DURING_EXPORT");
  await assert.rejects(() => fs.stat(changedDestination), /ENOENT/, "unstable snapshots must not be published");

  const retryDestination = path.join(temp, "raw", "retry.jsonl");
  let changedOnce = false;
  const retried = await copyStableRawSnapshot(source, retryDestination, {
    maxAttempts: 2,
    afterCopy: async ({ attempt }) => {
      if (attempt === 1 && !changedOnce) {
        changedOnce = true;
        await fs.appendFile(source, `${JSON.stringify({ type: "event_msg", payload: { type: "task_started" } })}\n`, "utf8");
      }
    },
  });
  assert.equal(retried.attempts, 2, "a changed source should retry before publishing a stable snapshot");
  assert.equal(await sha256File(source), await sha256File(retryDestination));

  const lockedDestination = path.join(temp, "raw", "locked.jsonl");
  await assert.rejects(() => copyStableRawSnapshot(source, lockedDestination, {
    maxAttempts: 1,
    io: {
      copyFile: async () => { const error = new Error("locked"); error.code = "EBUSY"; throw error; },
    },
  }), (error) => error?.code === "SOURCE_SNAPSHOT_LOCKED");

  const routingSource = path.join(temp, "routing.jsonl");
  const routingItems = [
    { timestamp: "2026-08-16T10:00:00.000Z", type: "session_meta", payload: { id: "routing-session", cwd: "C:\\Projects\\initial", timestamp: "2026-08-16T10:00:00.000Z" } },
    responseUser("Large content should not determine routing.", "routing-turn", "2026-08-16T10:00:01.000Z"),
    { timestamp: "2026-08-16T10:00:02.000Z", type: "turn_context", payload: { cwd: "C:\\Projects\\final" } },
  ];
  await fs.writeFile(routingSource, `${routingItems.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
  const routing = await readSessionRoutingMeta(routingSource);
  assert.equal(routing.id, "routing-session");
  assert.equal(routing.cwd, "C:\\Projects\\final", "routing scan must honor later turn_context records even when type is not the first property");
  assert.equal(routing.routingSnapshot.stable, true);
  assert.equal(routing.routingSnapshot.sha256, await sha256File(routingSource), "routing must hash the exact source bytes it scanned");

  const byteVariants = [
    { name: "lf", bytes: Buffer.from('{"type":"event_msg","payload":{"type":"task_started"}}\n') },
    { name: "crlf", bytes: Buffer.from('{"type":"event_msg","payload":{"type":"task_started"}}\r\n') },
    { name: "no-final-newline", bytes: Buffer.from('{"type":"event_msg","payload":{"type":"task_started"}}') },
    { name: "very-large-line", bytes: Buffer.from(`${JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "x".repeat(16 * 1024 * 1024) } })}\n`) },
  ];
  for (const variant of byteVariants) {
    const variantPath = path.join(temp, `${variant.name}.jsonl`);
    await fs.writeFile(variantPath, variant.bytes);
    const variantRouting = await readSessionRoutingMeta(variantPath);
    assert.equal(variantRouting.routingSnapshot.sha256, await sha256File(variantPath), `${variant.name} routing hash must cover exact bytes`);
  }

  const changedAfterRoutingSource = path.join(temp, "changed-after-routing.jsonl");
  const changedAfterRoutingDestination = path.join(temp, "raw", "changed-after-routing.jsonl");
  await fs.writeFile(changedAfterRoutingSource, "AAAA", "utf8");
  const staleRouting = await readSessionRoutingMeta(changedAfterRoutingSource);
  await fs.writeFile(changedAfterRoutingSource, "BBBB", "utf8");
  const currentStat = await fs.stat(changedAfterRoutingSource);
  staleRouting.routingSnapshot.beforeSizeBytes = currentStat.size;
  staleRouting.routingSnapshot.afterSizeBytes = currentStat.size;
  staleRouting.routingSnapshot.beforeMtimeMs = currentStat.mtimeMs;
  staleRouting.routingSnapshot.afterMtimeMs = currentStat.mtimeMs;
  const afterRoutingDiagnostics = [];
  const changedAfterRouting = await copyStableRawSnapshot(changedAfterRoutingSource, changedAfterRoutingDestination, {
    maxAttempts: 2,
    routingSnapshot: staleRouting.routingSnapshot,
    diagnostic: (event, details) => afterRoutingDiagnostics.push({ event, ...details }),
  });
  assert.equal(changedAfterRouting.attempts, 2, "a stale routing hash with matching size and mtime must fail cryptographic comparison and retry");
  assert.equal(changedAfterRouting.sourceHashBasis, "FALLBACK");
  assert.equal(await sha256File(changedAfterRoutingSource), await sha256File(changedAfterRoutingDestination));
  assert.ok(afterRoutingDiagnostics.some((event) => event.reason === "HASH_MISMATCH"), "size and mtime alone must never establish snapshot integrity");

  const manipulatedDestination = path.join(temp, "raw", "manipulated.jsonl");
  const manipulatedRouting = await readSessionRoutingMeta(changedAfterRoutingSource);
  await assert.rejects(() => copyStableRawSnapshot(changedAfterRoutingSource, manipulatedDestination, {
    maxAttempts: 1,
    routingSnapshot: manipulatedRouting.routingSnapshot,
    beforeExportVerification: async ({ temporaryPath }) => fs.writeFile(temporaryPath, "CCCC", "utf8"),
  }), (error) => error?.code === "SOURCE_CHANGED_DURING_EXPORT");
  await assert.rejects(() => fs.stat(manipulatedDestination), /ENOENT/, "a manipulated snapshot candidate must never be published");

  const replacedAfterRenameDestination = path.join(temp, "raw", "replaced-after-rename.jsonl");
  await assert.rejects(() => copyStableRawSnapshot(changedAfterRoutingSource, replacedAfterRenameDestination, {
    maxAttempts: 1,
    routingSnapshot: manipulatedRouting.routingSnapshot,
    io: {
      rename: async (temporaryPath, destinationPath) => {
        await fs.rename(temporaryPath, destinationPath);
        await fs.writeFile(destinationPath, "CCCC", "utf8");
      },
    },
  }), (error) => error?.code === "SOURCE_CHANGED_DURING_EXPORT");
  await assert.rejects(() => fs.stat(replacedAfterRenameDestination), /ENOENT/, "an equal-size replacement after rename must never retain verified output");

  const incompleteDestination = path.join(temp, "raw", "incomplete.jsonl");
  const incompleteRouting = await readSessionRoutingMeta(changedAfterRoutingSource);
  await assert.rejects(() => copyStableRawSnapshot(changedAfterRoutingSource, incompleteDestination, {
    maxAttempts: 1,
    routingSnapshot: incompleteRouting.routingSnapshot,
    io: { copyFile: async (sourcePath, temporaryPath) => fs.writeFile(temporaryPath, (await fs.readFile(sourcePath)).subarray(0, 2)) },
  }), (error) => error?.code === "SOURCE_CHANGED_DURING_EXPORT");
  assert.equal((await fs.readdir(path.dirname(incompleteDestination))).some((name) => name.includes(".partial-")), false, "failed snapshots must not leave partial files behind");

  const countedDestination = path.join(temp, "raw", "counted.jsonl");
  const countedRouting = await readSessionRoutingMeta(changedAfterRoutingSource);
  const hashCalls = [];
  const countedDiagnostics = [];
  const counted = await copyStableRawSnapshot(changedAfterRoutingSource, countedDestination, {
    routingSnapshot: countedRouting.routingSnapshot,
    diagnostic: (event, details) => countedDiagnostics.push({ event, ...details }),
    io: {
      hashFile: async (file) => {
        hashCalls.push(path.resolve(file));
        return sha256File(file);
      },
    },
  });
  assert.equal(counted.sourceHashBasis, "ROUTING");
  assert.equal(hashCalls.length, 1, "stable source snapshots must hash the export exactly once");
  assert.equal(hashCalls[0], path.resolve(countedDestination), "the published snapshot must be the file hashed for integrity verification");
  assert.notEqual(hashCalls[0], path.resolve(changedAfterRoutingSource), "stable routing evidence must avoid a separate source hash pass");
  assert.equal(countedDiagnostics.filter((event) => event.event === "source_hash_reused").length, 1);
  assert.equal(countedDiagnostics.filter((event) => event.event === "source_hash_start").length, 0);
  assert.equal(countedDiagnostics.filter((event) => event.event === "export_hash_start").length, 1);
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}

console.log("event classification tests passed");
