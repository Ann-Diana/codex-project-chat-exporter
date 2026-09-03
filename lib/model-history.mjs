export const MODEL_HISTORY_STATUS = Object.freeze({
  CONFIRMED: "CONFIRMED",
  NOT_OBSERVED: "NOT_OBSERVED",
  WITHHELD_FORK_INHERITANCE: "WITHHELD_FORK_INHERITANCE",
});

export function createRuntimeModelHistoryTracker(options = {}) {
  const changes = [];
  const threadSettings = [];
  let forkedFromId = "";

  function observe(item, recordOrdinal = 0) {
    if (item?.type === "session_meta" && item.payload) {
      forkedFromId ||= usableIdentifier(item.payload.forked_from_id);
    }
    if (item?.type === "turn_context") {
      const model = usableModel(item.payload?.model);
      if (model && changes.at(-1)?.model !== model) {
        changes.push(Object.freeze({
          model,
          recordOrdinal: positiveOrdinal(recordOrdinal),
          timestamp: String(item.timestamp || ""),
          turnId: usableIdentifier(item.payload?.turn_id),
        }));
      }
    }
    if (item?.type === "event_msg" && item.payload?.type === "thread_settings") {
      const model = usableModel(item.payload.model);
      if (model) threadSettings.push(Object.freeze({ model, recordOrdinal: positiveOrdinal(recordOrdinal), timestamp: String(item.timestamp || "") }));
    }
  }

  function finish() {
    if (forkedFromId && options.allowForkInheritance !== true) {
      return Object.freeze({
        models: Object.freeze([]),
        changes: Object.freeze([]),
        threadSettings: Object.freeze([...threadSettings]),
        status: MODEL_HISTORY_STATUS.WITHHELD_FORK_INHERITANCE,
      });
    }
    return Object.freeze({
      models: Object.freeze(changes.map((entry) => entry.model)),
      changes: Object.freeze([...changes]),
      threadSettings: Object.freeze([...threadSettings]),
      status: changes.length ? MODEL_HISTORY_STATUS.CONFIRMED : MODEL_HISTORY_STATUS.NOT_OBSERVED,
    });
  }

  return Object.freeze({ observe, finish });
}

export function normalizeModelHistory(value) {
  const result = [];
  for (const candidate of Array.isArray(value) ? value : []) {
    const model = usableModel(candidate);
    if (model && result.at(-1) !== model) result.push(model);
  }
  return Object.freeze(result);
}

export function formatModelHistory(value) {
  const models = normalizeModelHistory(value);
  return Object.freeze({
    label: models.length > 1 ? "Models" : "Model",
    value: models.join(" → "),
  });
}

function usableModel(value) {
  return typeof value === "string" ? value.trim() : "";
}

function usableIdentifier(value) {
  return typeof value === "string" ? value.trim() : "";
}

function positiveOrdinal(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}
