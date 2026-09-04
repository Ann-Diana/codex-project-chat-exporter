import assert from "node:assert/strict";
import test from "node:test";

import {
  MODEL_HISTORY_STATUS,
  createRuntimeModelHistoryTracker,
  formatModelHistory,
} from "../lib/model-history.mjs";

function history(items) {
  const tracker = createRuntimeModelHistoryTracker();
  items.forEach((item, index) => tracker.observe(item, index + 1));
  return tracker.finish();
}

const turn = (model, turnId = "") => ({ type: "turn_context", timestamp: "2026-08-30T10:00:00.000Z", payload: { model, turn_id: turnId } });
const setting = (model) => ({ type: "event_msg", payload: { type: "thread_settings", model } });

test("runtime model history retains confirmed chronological changes only", () => {
  assert.deepEqual(history([turn("gpt-5.5")]).models, ["gpt-5.5"]);
  assert.deepEqual(history([turn("gpt-5.5"), turn("gpt-5.6-sol")]).models, ["gpt-5.5", "gpt-5.6-sol"]);
  assert.deepEqual(history([turn("A"), turn("B"), turn("A")]).models, ["A", "B", "A"]);
  assert.deepEqual(history([turn("A"), turn("A"), turn("A"), turn("B"), turn("B")]).models, ["A", "B"]);
  assert.deepEqual(formatModelHistory(["gpt-5.5"]), { label: "Model", value: "gpt-5.5" });
  assert.deepEqual(formatModelHistory(["gpt-5.5", "gpt-5.6-sol"]), { label: "Models", value: "gpt-5.5 → gpt-5.6-sol" });
});

test("thread settings corroborate but never prove runtime model use", () => {
  const result = history([turn("gpt-5.5"), setting("gpt-5.6-sol")]);
  assert.deepEqual(result.models, ["gpt-5.5"]);
  assert.deepEqual(result.threadSettings.map((entry) => entry.model), ["gpt-5.6-sol"]);
});

test("main and subagent histories remain file-local", () => {
  const main = history([turn("gpt-5.5"), turn("gpt-5.6-sol")]);
  const subagent = history([turn("codex-auto-review")]);
  assert.deepEqual(main.models, ["gpt-5.5", "gpt-5.6-sol"]);
  assert.deepEqual(subagent.models, ["codex-auto-review"]);
  assert.equal(main.models.includes("codex-auto-review"), false);
});

test("fork histories are withheld when inherited and fork-local turns cannot be proven apart", () => {
  const result = history([
    { type: "session_meta", payload: { id: "fork", forked_from_id: "parent" } },
    turn("gpt-5.5", "inherited-turn"),
    turn("gpt-5.6-sol", "possibly-own-turn"),
  ]);
  assert.equal(result.status, MODEL_HISTORY_STATUS.WITHHELD_FORK_INHERITANCE);
  assert.deepEqual(result.models, []);
  assert.deepEqual(result.changes, []);
});

test("validated paginated reconstruction permits confirmed inherited model history", () => {
  const tracker = createRuntimeModelHistoryTracker({ allowForkInheritance: true });
  [
    { type: "session_meta", payload: { id: "fork", forked_from_id: "parent", history_mode: "paginated" } },
    turn("gpt-5.5", "parent-turn"),
    turn("gpt-5.6-sol", "child-turn"),
  ].forEach((item, index) => tracker.observe(item, index + 1));
  const result = tracker.finish();
  assert.equal(result.status, MODEL_HISTORY_STATUS.CONFIRMED);
  assert.deepEqual(result.models, ["gpt-5.5", "gpt-5.6-sol"]);
});
