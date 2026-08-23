import fs from "node:fs/promises";
import path from "node:path";

export const PROJECT_PATH = "/projects/golden";
export const FALLBACK_STARTED_AT = "2026-01-04T04:05:06.000Z";
export const ACTIVE_SESSION_ID = "11111111-1111-7111-8111-111111111111";
export const SUBAGENT_SESSION_ID = "22222222-2222-7222-8222-222222222222";
export const FALLBACK_SESSION_ID = "33333333-3333-7333-8333-333333333333";
export const SMALL_PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function jsonl(items) {
  return `${items.map((item) => JSON.stringify(item)).join("\n")}\n`;
}

const activeEvents = [
  {
    type: "session_meta",
    timestamp: "2026-01-02T10:00:00.000Z",
    payload: {
      id: ACTIVE_SESSION_ID,
      cwd: PROJECT_PATH,
      timestamp: "2026-01-02T10:00:00.000Z",
      source: "vscode",
      thread_source: "user",
    },
  },
  {
    type: "response_item",
    timestamp: "2026-01-02T10:00:00.100Z",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "# AGENTS.md instructions\n<environment_context>fixture runtime context</environment_context>" }],
      internal_chat_message_metadata_passthrough: { turn_id: "active-turn" },
    },
  },
  {
    type: "response_item",
    timestamp: "2026-01-02T10:00:01.000Z",
    payload: {
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "Fixture direct request with image." },
        { type: "input_image", image_url: SMALL_PNG_DATA_URL },
      ],
      internal_chat_message_metadata_passthrough: { turn_id: "active-turn" },
    },
  },
  {
    type: "event_msg",
    timestamp: "2026-01-02T10:00:01.001Z",
    payload: { type: "user_message", message: "Fixture direct request with image.", images: [SMALL_PNG_DATA_URL] },
  },
  {
    type: "response_item",
    timestamp: "2026-01-02T10:00:02.000Z",
    payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Fixture assistant answer." }] },
  },
  {
    type: "response_item",
    timestamp: "2026-01-02T10:00:03.000Z",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Fixture unclassified user-role record." }],
      internal_chat_message_metadata_passthrough: { turn_id: "unpaired-turn" },
    },
  },
  {
    type: "response_item",
    timestamp: "2026-01-02T10:00:04.000Z",
    payload: { type: "function_call", name: "fixture_tool", arguments: "{\"value\":\"fixture\"}" },
  },
];

const subagentEvents = [
  {
    type: "session_meta",
    timestamp: "2026-01-03T11:00:00.000Z",
    payload: {
      id: SUBAGENT_SESSION_ID,
      cwd: PROJECT_PATH,
      timestamp: "2026-01-03T11:00:00.000Z",
      source: { subagent: { name: "fixture" } },
      thread_source: "subagent",
      parent_thread_id: ACTIVE_SESSION_ID,
    },
  },
  {
    type: "response_item",
    timestamp: "2026-01-03T11:00:01.000Z",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Fixture parent-agent handoff." }],
      internal_chat_message_metadata_passthrough: { turn_id: "subagent-turn" },
    },
  },
  {
    type: "event_msg",
    timestamp: "2026-01-03T11:00:01.001Z",
    payload: { type: "user_message", message: "Fixture parent-agent handoff." },
  },
  {
    type: "response_item",
    timestamp: "2026-01-03T11:00:02.000Z",
    payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Fixture subagent answer." }] },
  },
];

const fallbackEvents = [
  {
    type: "turn_context",
    timestamp: "2026-01-04T04:05:07.000Z",
    payload: { cwd: PROJECT_PATH, model: "gpt-fixture" },
  },
  {
    type: "response_item",
    timestamp: "2026-01-04T04:05:08.000Z",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Fixture fallback user-role record." }],
      internal_chat_message_metadata_passthrough: { turn_id: "fallback-turn" },
    },
  },
  {
    type: "response_item",
    timestamp: "2026-01-04T04:05:09.000Z",
    payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Fixture fallback answer." }] },
  },
];

export async function writeReadingOutputFixture(codexHome) {
  const activeDir = path.join(codexHome, "sessions", "2026", "01", "02");
  const archivedDir = path.join(codexHome, "archived_sessions");
  await fs.mkdir(activeDir, { recursive: true });
  await fs.mkdir(archivedDir, { recursive: true });

  const activePath = path.join(activeDir, `rollout-2026-01-02T10-00-00-${ACTIVE_SESSION_ID}.jsonl`);
  const subagentPath = path.join(activeDir, `rollout-2026-01-03T11-00-00-${SUBAGENT_SESSION_ID}.jsonl`);
  const fallbackPath = path.join(archivedDir, `rollout-2025-12-31T23-59-59-${FALLBACK_SESSION_ID}.jsonl`);
  await fs.writeFile(activePath, jsonl(activeEvents), "utf8");
  await fs.writeFile(subagentPath, jsonl(subagentEvents), "utf8");
  await fs.writeFile(fallbackPath, jsonl(fallbackEvents), "utf8");
  const activeTime = new Date("2026-01-02T10:00:05.000Z");
  const subagentTime = new Date("2026-01-03T11:00:03.000Z");
  const fallbackTime = new Date(FALLBACK_STARTED_AT);
  await fs.utimes(activePath, activeTime, activeTime);
  await fs.utimes(subagentPath, subagentTime, subagentTime);
  await fs.utimes(fallbackPath, fallbackTime, fallbackTime);

  return { activePath, archivedDir, fallbackPath, sessionsDir: path.join(codexHome, "sessions"), subagentPath };
}
