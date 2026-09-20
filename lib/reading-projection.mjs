import { classifyMessageContentPart, MESSAGE_CONTENT_KIND } from "./reading-content.mjs";
import { attachmentIdentity, isAttachmentDescriptor } from "./session-record-reader.mjs";

export const OUTER_CLASSIFICATIONS = Object.freeze([
  "KNOWN_CONTENT_RECORD",
  "KNOWN_CONTROL_RECORD",
  "UNKNOWN_RECORD_TYPE",
  "SCHEMA_INVALID_RECORD",
]);

export const INNER_DISPOSITIONS = Object.freeze([
  "RENDERED",
  "SUPPRESSED_BY_PROFILE",
  "MIRRORED_OR_DEDUPLICATED",
  "KNOWN_CONTENT_RAW_ONLY",
  "UNKNOWN_RAW_ONLY",
  "SCHEMA_INVALID_RAW_ONLY",
]);

export const VALID_MESSAGE_ROLES = Object.freeze(["user", "assistant", "developer", "tool"]);
const VALID_MESSAGE_ROLE_SET = new Set(VALID_MESSAGE_ROLES);
const VISIBLE_MESSAGE_ROLES = new Set(["user", "assistant"]);
const TOOL_TYPES = new Set(["function_call", "custom_tool_call", "function_call_output", "custom_tool_call_output"]);
const TOOL_CALL_TYPES = new Set(["function_call", "custom_tool_call"]);
const TOOL_OUTPUT_TYPES = new Set(["function_call_output", "custom_tool_call_output"]);
const KNOWN_OUTER_CONTROL_TYPES = new Set(["session_meta", "turn_context"]);
const MIRRORABLE_EVENT_TYPES = new Set(["user_message", "mcp_tool_call_end"]);
const KNOWN_RESPONSE_TYPES = new Set([
  "message",
  "reasoning",
  "function_call",
  "custom_tool_call",
  "function_call_output",
  "custom_tool_call_output",
  "local_shell_call",
  "web_search_call",
  "computer_call",
  "computer_call_output",
  "mcp_call",
  "mcp_list_tools",
  "item_reference",
  "ghost_snapshot",
]);
const KNOWN_CONTROL_EVENT_TYPES = new Set([
  "task_started",
  "task_complete",
  "thread_settings",
  "turn_started",
  "turn_complete",
  "turn_aborted",
  "token_count",
  "context_compacted",
  "shutdown_complete",
]);
const KNOWN_CONTENT_EVENT_TYPES = new Set([
  "user_message",
  "agent_message",
  "agent_reasoning",
  "mcp_tool_call_begin",
  "mcp_tool_call_end",
  "exec_command_begin",
  "exec_command_end",
]);

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value, key) {
  return safeObject(value) && Object.hasOwn(value, key);
}

function semanticTypeLabel(value) {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  if (typeof value !== "string") return typeof value;
  if (!value) return "empty_string";
  if (value.length > 128) return "overlong_string";
  for (const character of value) {
    const code = character.charCodeAt(0);
    const alphaNumeric = (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
    if (!alphaNumeric && character !== "_" && character !== "-" && character !== "." && character !== ":") return "non_identifier_string";
  }
  return value;
}

function evidence(reasonCode, structurePath, recordType, innerType = "") {
  return Object.freeze({
    reason_code: reasonCode,
    structure_path: structurePath,
    record_type: semanticTypeLabel(recordType),
    inner_type: semanticTypeLabel(innerType),
  });
}

function callIdState(payload) {
  if (!hasOwn(payload, "call_id")) return { id: "", status: "NO_CALL_ID_PRESENT" };
  if (typeof payload.call_id !== "string") return { id: "", status: "SCHEMA_INVALID_CALL_ID" };
  if (!payload.call_id.trim()) return { id: "", status: "EMPTY_CALL_ID" };
  return { id: retainedString(payload.call_id), status: "PENDING" };
}

function collectAttachmentDescriptors(value, output = []) {
  if (isAttachmentDescriptor(value)) {
    output.push(value);
    return output;
  }
  if (Array.isArray(value)) {
    for (const child of value) collectAttachmentDescriptors(child, output);
  } else if (value && typeof value === "object") {
    for (const child of Object.values(value)) collectAttachmentDescriptors(child, output);
  }
  return output;
}

export function collectProjectedAttachmentDescriptors(part) {
  if (classifyMessageContentPart(part).kind !== MESSAGE_CONTENT_KIND.ATTACHMENT) return [];
  return collectAttachmentDescriptors(part);
}

export function isValidMessageRole(value) {
  return typeof value === "string" && VALID_MESSAGE_ROLE_SET.has(value);
}

function textValue(part, textField) {
  if (textField === "SELF") return typeof part === "string" ? part : "";
  return safeObject(part) && typeof part[textField] === "string" ? part[textField] : "";
}

// `\S` matches the complement of ECMAScript whitespace without allocating a
// second potentially very large string as `trim()` can do.
function hasNonWhitespaceText(value) {
  return /\S/u.test(value);
}

function retainedString(value) {
  const text = typeof value === "string" ? value : String(value ?? "");
  return text ? Buffer.from(text, "utf16le").toString("utf16le") : "";
}

function inspectContent(content) {
  return content.map((part, contentIndex) => {
    const classified = classifyMessageContentPart(part);
    const descriptors = classified.kind === MESSAGE_CONTENT_KIND.ATTACHMENT
      ? collectAttachmentDescriptors(part)
      : [];
    if (classified.contentType === "input_image" && descriptors.length === 0 && typeof part?.image_url === "string") {
      descriptors.push(part.image_url);
    }
    return {
      classified,
      contentIndex,
      descriptors,
      text: classified.kind === MESSAGE_CONTENT_KIND.TEXT ? classified.text : "",
    };
  });
}

export function inspectProjectedMessage(item) {
  if (item?.type !== "response_item" || item.payload?.type !== "message") return null;
  const payload = item.payload;
  if (!isValidMessageRole(payload.role) || !Array.isArray(payload.content)) return null;
  const parts = inspectContent(payload.content);
  return Object.freeze({
    role: payload.role,
    contentCount: payload.content.length,
    parts: Object.freeze(parts.map(({ classified, contentIndex, descriptors, text }) => Object.freeze({
      contentIndex,
      contentType: classified.contentType || "",
      descriptors: Object.freeze([...descriptors]),
      kind: classified.kind,
      text,
      textField: classified.textField || "",
    }))),
    text: parts.filter((part) => part.classified.kind === MESSAGE_CONTENT_KIND.TEXT).map((part) => part.text).filter(Boolean).join("\n\n"),
  });
}

function stableJsonValue(value) {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableJsonValue(value[key])]));
}

function readableToolPayload(payload) {
  const field = ["arguments", "input", "output"].find((name) => Object.hasOwn(payload, name));
  const value = field ? payload[field] : payload;
  if (typeof value === "string") return value;
  if (value === undefined) return "undefined";
  return JSON.stringify(stableJsonValue(value), null, 2);
}

function replacementHistoryContentKey(historyIndex, contentIndex) {
  return `${historyIndex}:${contentIndex}`;
}

function makeContext(item, source, readingViewEnabled) {
  const logicalRecordNumber = source.logicalRecordNumber;
  if (logicalRecordNumber !== null && (!Number.isSafeInteger(logicalRecordNumber) || logicalRecordNumber <= 0)) throw new TypeError("Reading projection requires a positive logical record ordinal or an explicit physical-only occurrence");
  const recordPrefix = logicalRecordNumber === null
    ? `physical:${String(source.sourceKey || "")}:${String(source.sourceRecordNumber ?? "")}`
    : `record:${logicalRecordNumber}`;
  return {
    item,
    logicalRecordNumber,
    recordPrefix,
    physicalOccurrence: Object.freeze({
      logical_record_ordinal: logicalRecordNumber,
      physical_record_ordinal: Number.isSafeInteger(item?.ordinal) ? item.ordinal : null,
      source_key: String(source.sourceKey || ""),
    }),
    timestamp: readingViewEnabled && typeof item?.timestamp === "string" ? item.timestamp : "",
  };
}

function createUnit(context, suffix, disposition, {
  canonicalUnitId = null,
  contentIndex = null,
  contentType = "",
  countInCoverage = true,
  evidenceValue = null,
  eventType = "",
  historyIndex = null,
  kind = "CONTROL",
  linkage = null,
  messageRole = "",
  parentUnitId = null,
  replacementHistory = false,
  replacementHistoryKind = "",
  structurePath = "$",
  textField = "",
  toolType = "",
  callId = "",
  validity = "VALID",
} = {}) {
  return {
    unit_id: `${context.recordPrefix}:${suffix}`,
    physical_occurrence: context.physicalOccurrence,
    structure_path: structurePath,
    kind,
    validity,
    disposition,
    canonical_unit_id: canonicalUnitId,
    parent_unit_id: parentUnitId,
    contentIndex,
    contentType,
    countInCoverage,
    evidence: evidenceValue,
    eventType,
    historyIndex,
    linkage,
    logicalRecordNumber: context.logicalRecordNumber,
    messageRole,
    replacementHistory,
    replacementHistoryKind,
    textField,
    toolType,
    callId,
  };
}

function createRecord(context, outer, units = [], extra = {}) {
  return {
    record_id: context.recordPrefix,
    logical_record_ordinal: context.logicalRecordNumber,
    physical_occurrence: context.physicalOccurrence,
    timestamp: context.timestamp,
    outer,
    units,
    containers: [],
    render_kind: "NONE",
    unknownOuter: false,
    unknownInner: false,
    ...extra,
  };
}

function invalidContainerUnit(context, suffix, structurePath, recordType, reasonCode, innerType = "") {
  return createUnit(context, suffix, "SCHEMA_INVALID_RAW_ONLY", {
    evidenceValue: evidence(reasonCode, structurePath, recordType, innerType),
    kind: "MESSAGE_CONTAINER",
    structurePath,
    validity: "SCHEMA_INVALID",
  });
}

function projectedContentUnit(context, parentUnitId, part, contentIndex, disposition, options) {
  const classified = classifyMessageContentPart(part);
  const path = options.structurePath.replace("[*]", `[${contentIndex}]`);
  const base = {
    contentIndex,
    contentType: classified.contentType || "",
    countInCoverage: options.countSupportedInCoverage,
    historyIndex: options.historyIndex,
    messageRole: options.messageRole,
    parentUnitId,
    replacementHistory: options.replacementHistory,
    structurePath: path,
  };
  const suffix = options.replacementHistory ? `history:${options.historyIndex}:content:${contentIndex}` : `message:content:${contentIndex}`;
  if (classified.kind === MESSAGE_CONTENT_KIND.TEXT) {
    return createUnit(context, suffix, hasNonWhitespaceText(classified.text) ? disposition : "KNOWN_CONTENT_RAW_ONLY", {
      ...base,
      kind: "TEXT",
      replacementHistoryKind: options.replacementHistory ? "TEXT" : "",
      textField: classified.textField || "",
    });
  }
  if (classified.kind === MESSAGE_CONTENT_KIND.ATTACHMENT) {
    return createUnit(context, suffix, disposition, {
      ...base,
      kind: "ATTACHMENT",
      replacementHistoryKind: options.replacementHistory ? "ATTACHMENT" : "",
    });
  }
  if (classified.kind === MESSAGE_CONTENT_KIND.KNOWN_CONTENT_RAW_ONLY) {
    return createUnit(context, suffix, "KNOWN_CONTENT_RAW_ONLY", {
      ...base,
      countInCoverage: true,
      evidenceValue: evidence(`KNOWN_UNSUPPORTED_${options.reasonPrefix}_CONTENT`, options.structurePath, options.recordType, classified.contentType),
      kind: "KNOWN_CONTENT",
    });
  }
  if (classified.kind === MESSAGE_CONTENT_KIND.UNKNOWN_RAW_ONLY) {
    return createUnit(context, suffix, "UNKNOWN_RAW_ONLY", {
      ...base,
      countInCoverage: true,
      evidenceValue: evidence(classified.contentType ? `UNKNOWN_${options.reasonPrefix}_CONTENT_TYPE` : `UNKNOWN_${options.reasonPrefix}_CONTENT_STRUCTURE`, options.structurePath, options.recordType, classified.contentType || part),
      kind: "UNKNOWN_CONTENT",
    });
  }
  const reasonCode = classified.knownText
    ? `SCHEMA_INVALID_KNOWN_TEXT_EXPECTED_STRING_ACTUAL_${classified.actualType}`
    : `SCHEMA_INVALID_${options.reasonPrefix}_CONTENT`;
  return createUnit(context, suffix, "SCHEMA_INVALID_RAW_ONLY", {
    ...base,
    countInCoverage: true,
    evidenceValue: evidence(reasonCode, options.structurePath, options.recordType, classified.knownText ? classified.contentType : part),
    kind: classified.knownText ? "TEXT" : "INVALID_CONTENT",
    validity: "SCHEMA_INVALID",
  });
}

function classifyResponseRecord(context, options) {
  const { item } = context;
  const payload = item.payload;
  if (!safeObject(payload) || typeof payload.type !== "string" || !payload.type) {
    const units = hasOwn(item, "payload") ? [createUnit(context, "invalid-payload", "SCHEMA_INVALID_RAW_ONLY", { kind: "CONTENT", validity: "SCHEMA_INVALID" })] : [];
    return createRecord(context, "SCHEMA_INVALID_RECORD", units);
  }
  if (!KNOWN_RESPONSE_TYPES.has(payload.type)) {
    return createRecord(context, "KNOWN_CONTENT_RECORD", [createUnit(context, "unknown-response", "UNKNOWN_RAW_ONLY", {
      evidenceValue: evidence("UNKNOWN_RESPONSE_ITEM_TYPE", "payload", item.type, payload.type),
      kind: "UNKNOWN_CONTENT",
      structurePath: "payload",
    })], { unknownInner: true });
  }
  if (payload.type === "message") {
    const containerId = `${context.recordPrefix}:message`;
    if (!isValidMessageRole(payload.role) || !Array.isArray(payload.content)) {
      const unit = invalidContainerUnit(context, "message", "payload", item.type, "SCHEMA_INVALID_MESSAGE_CONTAINER", payload.type);
      return createRecord(context, "SCHEMA_INVALID_RECORD", [unit], {
        containers: [{ container_id: containerId, validity: "SCHEMA_INVALID", content_count: null, child_unit_ids: [] }],
      });
    }
    const visibleRole = VISIBLE_MESSAGE_ROLES.has(payload.role);
    let hasRenderableText = false;
    let hasAttachment = false;
    if (options.readingViewEnabled) {
      const inspected = inspectContent(payload.content);
      const projectedText = inspected.filter((entry) => entry.classified.kind === MESSAGE_CONTENT_KIND.TEXT).map((entry) => entry.text).filter(Boolean).join("\n\n");
      const normalizedText = options.normalizeMessageText(projectedText, payload.role);
      hasRenderableText = Boolean(normalizedText.trim());
      hasAttachment = inspected.some((entry) => entry.classified.kind === MESSAGE_CONTENT_KIND.ATTACHMENT);
    }
    const aggregateDisposition = visibleRole && options.readingViewEnabled && (hasRenderableText || hasAttachment)
      ? "RENDERED"
      : visibleRole && !options.readingViewEnabled
        ? "SUPPRESSED_BY_PROFILE"
        : "KNOWN_CONTENT_RAW_ONLY";
    const supportedDisposition = aggregateDisposition === "RENDERED" ? "RENDERED" : aggregateDisposition;
    const childUnits = payload.content.map((part, contentIndex) => projectedContentUnit(context, containerId, part, contentIndex, supportedDisposition, {
      countSupportedInCoverage: false,
      historyIndex: null,
      messageRole: payload.role,
      reasonPrefix: "MESSAGE",
      recordType: item.type,
      replacementHistory: false,
      structurePath: "payload.content[*]",
    }));
    if (!hasRenderableText) {
      for (const unit of childUnits) if (unit.kind === "TEXT" && unit.disposition === "RENDERED") unit.disposition = "KNOWN_CONTENT_RAW_ONLY";
    }
    const supportedCount = childUnits.filter((unit) => unit.validity === "VALID" && (unit.kind === "TEXT" || unit.kind === "ATTACHMENT")).length;
    const extraUnits = childUnits.filter((unit) => unit.countInCoverage);
    const units = [];
    if (supportedCount > 0 || payload.content.length === 0) {
      units.push(createUnit(context, "message", aggregateDisposition, {
        kind: "MESSAGE",
        messageRole: payload.role,
        structurePath: "payload",
      }));
    }
    units.push(...childUnits);
    return createRecord(context, "KNOWN_CONTENT_RECORD", units, {
      containers: [{ container_id: containerId, validity: "VALID", content_count: payload.content.length, child_unit_ids: childUnits.map((unit) => unit.unit_id) }],
      render_kind: visibleRole ? "MESSAGE" : "NONE",
      unknownInner: extraUnits.some((unit) => unit.disposition === "UNKNOWN_RAW_ONLY"),
    });
  }
  if (TOOL_TYPES.has(payload.type)) {
    const disposition = options.readingViewEnabled && options.includeTools ? "RENDERED" : "SUPPRESSED_BY_PROFILE";
    const linkage = TOOL_OUTPUT_TYPES.has(payload.type) ? callIdState(payload) : null;
    return createRecord(context, "KNOWN_CONTENT_RECORD", [createUnit(context, "tool", disposition, {
      callId: typeof payload.call_id === "string" ? retainedString(payload.call_id) : "",
      kind: "TOOL_EVENT",
      linkage,
      messageRole: "tool",
      structurePath: "payload",
      toolType: payload.type,
    })], { render_kind: "TOOL" });
  }
  return createRecord(context, "KNOWN_CONTENT_RECORD", [createUnit(context, "known-content", "KNOWN_CONTENT_RAW_ONLY", { kind: "KNOWN_CONTENT", structurePath: "payload" })]);
}

function classifyEventRecord(context) {
  const { item } = context;
  const payload = item.payload;
  if (!safeObject(payload) || typeof payload.type !== "string" || !payload.type) {
    return createRecord(context, "SCHEMA_INVALID_RECORD", [createUnit(context, "invalid-event", "SCHEMA_INVALID_RAW_ONLY", { kind: "CONTENT", validity: "SCHEMA_INVALID" })]);
  }
  if (KNOWN_CONTROL_EVENT_TYPES.has(payload.type)) return createRecord(context, "KNOWN_CONTROL_RECORD");
  if (!KNOWN_CONTENT_EVENT_TYPES.has(payload.type)) {
    return createRecord(context, "KNOWN_CONTENT_RECORD", [createUnit(context, "unknown-event", "UNKNOWN_RAW_ONLY", {
      evidenceValue: evidence("UNKNOWN_EVENT_PAYLOAD_TYPE", "payload", item.type, payload.type),
      kind: "UNKNOWN_CONTENT",
      structurePath: "payload",
    })], { unknownInner: true });
  }
  if (!MIRRORABLE_EVENT_TYPES.has(payload.type)) {
    return createRecord(context, "KNOWN_CONTENT_RECORD", [createUnit(context, "known-event", "KNOWN_CONTENT_RAW_ONLY", { kind: "KNOWN_CONTENT", structurePath: "payload" })]);
  }
  return createRecord(context, "KNOWN_CONTENT_RECORD", [createUnit(context, "event", "KNOWN_CONTENT_RAW_ONLY", {
    eventType: payload.type,
    kind: payload.type === "user_message" ? "MESSAGE_EVENT" : "TOOL_EVENT",
    structurePath: "payload",
  })]);
}

function classifyCompactedRecord(context, options) {
  const { item } = context;
  const history = item.payload?.replacement_history;
  if (!safeObject(item.payload) || !Array.isArray(history)) {
    return createRecord(context, "SCHEMA_INVALID_RECORD", [createUnit(context, "replacement-history", "SCHEMA_INVALID_RAW_ONLY", {
      kind: "HISTORY_CONTAINER",
      structurePath: "payload.replacement_history",
      validity: "SCHEMA_INVALID",
    })]);
  }
  const units = [];
  const containers = [];
  for (let historyIndex = 0; historyIndex < history.length; historyIndex += 1) {
    const entry = history[historyIndex];
    const containerId = `${context.recordPrefix}:history:${historyIndex}`;
    const containerPath = `payload.replacement_history[${historyIndex}]`;
    if (!safeObject(entry) || typeof entry.type !== "string") {
      const unit = invalidContainerUnit(context, `history:${historyIndex}`, "payload.replacement_history[*]", item.type, "SCHEMA_INVALID_REPLACEMENT_HISTORY_ENTRY", entry);
      unit.historyIndex = historyIndex;
      units.push(unit);
      containers.push({ container_id: containerId, validity: "SCHEMA_INVALID", content_count: null, child_unit_ids: [] });
      continue;
    }
    if (entry.type !== "message") {
      units.push(createUnit(context, `history:${historyIndex}`, "UNKNOWN_RAW_ONLY", {
        evidenceValue: evidence("UNKNOWN_REPLACEMENT_HISTORY_ENTRY_TYPE", "payload.replacement_history[*]", item.type, entry.type),
        historyIndex,
        kind: "UNKNOWN_CONTENT",
        structurePath: containerPath,
      }));
      containers.push({ container_id: containerId, validity: "UNKNOWN", content_count: null, child_unit_ids: [] });
      continue;
    }
    if (!isValidMessageRole(entry.role) || !Array.isArray(entry.content)) {
      const unit = invalidContainerUnit(context, `history:${historyIndex}`, "payload.replacement_history[*]", item.type, "SCHEMA_INVALID_REPLACEMENT_HISTORY_MESSAGE", entry.type);
      unit.historyIndex = historyIndex;
      units.push(unit);
      containers.push({ container_id: containerId, validity: "SCHEMA_INVALID", content_count: null, child_unit_ids: [] });
      continue;
    }
    const defaultDisposition = options.includeReplacementHistory ? "KNOWN_CONTENT_RAW_ONLY" : "SUPPRESSED_BY_PROFILE";
    const children = entry.content.map((part, contentIndex) => projectedContentUnit(context, containerId, part, contentIndex, defaultDisposition, {
      countSupportedInCoverage: true,
      historyIndex,
      messageRole: entry.role,
      reasonPrefix: "REPLACEMENT_HISTORY",
      recordType: item.type,
      replacementHistory: true,
      structurePath: "payload.replacement_history[*].content[*]",
    }));
    for (const unit of children) {
      if (unit.kind === "TEXT" && unit.disposition === "KNOWN_CONTENT_RAW_ONLY" && !textValue(entry.content[unit.contentIndex], unit.textField).trim()) unit.countInCoverage = false;
    }
    units.push(...children);
    containers.push({ container_id: containerId, validity: "VALID", content_count: entry.content.length, child_unit_ids: children.map((unit) => unit.unit_id) });
  }
  return createRecord(context, "KNOWN_CONTENT_RECORD", units, {
    containers,
    render_kind: "HISTORY",
    unknownInner: units.some((unit) => unit.disposition === "UNKNOWN_RAW_ONLY"),
  });
}

function classifyRecord(context, options) {
  const { item } = context;
  if (!safeObject(item) || typeof item.type !== "string" || !item.type) {
    const units = hasOwn(item, "payload") ? [createUnit(context, "invalid-record", "SCHEMA_INVALID_RAW_ONLY", { kind: "CONTENT", validity: "SCHEMA_INVALID" })] : [];
    return createRecord(context, "SCHEMA_INVALID_RECORD", units);
  }
  if (KNOWN_OUTER_CONTROL_TYPES.has(item.type)) {
    if (safeObject(item.payload)) return createRecord(context, "KNOWN_CONTROL_RECORD");
    return createRecord(context, "SCHEMA_INVALID_RECORD", [createUnit(context, "invalid-control", "SCHEMA_INVALID_RAW_ONLY", { kind: "CONTENT", validity: "SCHEMA_INVALID" })]);
  }
  if (item.type === "event_msg") return classifyEventRecord(context, options);
  if (item.type === "response_item") return classifyResponseRecord(context, options);
  if (item.type === "compacted") return classifyCompactedRecord(context, options);
  return createRecord(context, "UNKNOWN_RECORD_TYPE", [createUnit(context, "unknown-record", "UNKNOWN_RAW_ONLY", {
    evidenceValue: evidence("UNKNOWN_OUTER_RECORD_BODY", "$", item.type),
    kind: "UNKNOWN_CONTENT",
  })], { unknownOuter: true });
}

function firstCanonicalUnit(record, preferredKind = "") {
  if (!record) return null;
  return record.units.find((unit) => preferredKind && unit.kind === preferredKind && unit.disposition === "RENDERED")
    || record.units.find((unit) => unit.disposition === "RENDERED")
    || record.units.find((unit) => unit.countInCoverage)
    || null;
}

export class ReadingProjection {
  constructor({ includeReplacementHistory = true, includeTools = false, normalizeMessageText = (value) => value, readingViewEnabled = true } = {}) {
    this.options = {
      includeReplacementHistory: Boolean(includeReplacementHistory),
      includeTools: Boolean(includeTools),
      normalizeMessageText,
      readingViewEnabled: Boolean(readingViewEnabled),
    };
    this.records = new Map();
    this.physicalOnlyRecords = [];
    this.compactedCanonicalUnits = new Map();
    this.compactedUnitIds = new Set();
    this.finalized = false;
    this.released = false;
  }

  observePhysicalRecord(item, source) {
    if (this.released) throw new TypeError("Reading projection was released");
    if (this.finalized) throw new TypeError("Reading projection is already finalized");
    const context = makeContext(item, source, this.options.readingViewEnabled);
    const projected = classifyRecord(context, this.options);
    if (context.logicalRecordNumber === null) this.physicalOnlyRecords.push(projected);
    else {
      if (this.records.has(context.logicalRecordNumber)) throw new TypeError(`Duplicate reading projection record ordinal: ${context.logicalRecordNumber}`);
      this.records.set(context.logicalRecordNumber, projected);
    }
    return projected;
  }

  record(recordNumber) {
    if (this.released) throw new TypeError("Reading projection was released");
    return this.records.get(recordNumber) || null;
  }

  compactStableRecord(recordNumber) {
    if (this.released) throw new TypeError("Reading projection was released");
    if (this.finalized) throw new TypeError("Reading projection is already finalized");
    if (this.options.readingViewEnabled) return false;
    const record = this.records.get(recordNumber);
    if (!record || record.units.some((unit) => unit.eventType || unit.replacementHistory)) return false;
    if (["MESSAGE", "TOOL"].includes(record.render_kind)) {
      const byKind = new Map();
      for (const unit of record.units) if (!byKind.has(unit.kind)) byKind.set(unit.kind, unit.unit_id);
      const defaultUnit = firstCanonicalUnit(record);
      if (defaultUnit) {
        // A later replacement_history record may mirror any individual content
        // child, not only the first child of each kind. Keep every compacted
        // identity while releasing the substantially larger record/unit trees.
        for (const unit of record.units) this.compactedUnitIds.add(unit.unit_id);
        this.compactedCanonicalUnits.set(recordNumber, Object.freeze({ byKind, defaultUnitId: defaultUnit.unit_id }));
      }
    }
    this.records.delete(recordNumber);
    return true;
  }

  canonicalUnit(recordNumber, preferredKind = "") {
    const record = this.records.get(recordNumber);
    if (record) return firstCanonicalUnit(record, preferredKind);
    const compacted = this.compactedCanonicalUnits.get(recordNumber);
    const unitId = compacted?.byKind.get(preferredKind) || compacted?.defaultUnitId || "";
    return unitId ? Object.freeze({ unit_id: unitId }) : null;
  }

  finalize({ eventAnalysis = {}, readingSelection = null } = {}) {
    if (this.released) throw new TypeError("Reading projection was released");
    if (this.finalized) return this;
    const userMirrors = eventAnalysis?.mirrorPairs instanceof Map ? eventAnalysis.mirrorPairs : new Map();
    const toolMirrors = readingSelection?.toolMirrorPairs instanceof Map ? readingSelection.toolMirrorPairs : new Map();
    for (const record of this.records.values()) {
      for (const unit of record.units) {
        if (unit.eventType === "user_message" && userMirrors.has(unit.logicalRecordNumber)) {
          const canonical = this.canonicalUnit(userMirrors.get(unit.logicalRecordNumber), "MESSAGE");
          unit.disposition = "MIRRORED_OR_DEDUPLICATED";
          unit.canonical_unit_id = canonical?.unit_id || null;
        } else if (unit.eventType === "mcp_tool_call_end" && toolMirrors.has(unit.logicalRecordNumber)) {
          const canonical = this.canonicalUnit(toolMirrors.get(unit.logicalRecordNumber), "TOOL_EVENT");
          unit.disposition = "MIRRORED_OR_DEDUPLICATED";
          unit.canonical_unit_id = canonical?.unit_id || null;
        }
        if (!unit.replacementHistory || unit.validity !== "VALID" || !["TEXT", "ATTACHMENT"].includes(unit.kind)) continue;
        const disposition = readingSelection?.replacementHistoryDisposition(unit.logicalRecordNumber, unit.historyIndex, unit.contentIndex) || "";
        if (disposition === "ADDITIONAL_STORED_CONTEXT" && unit.replacementHistoryKind === "ATTACHMENT") {
          unit.disposition = this.options.readingViewEnabled ? "RENDERED" : "SUPPRESSED_BY_PROFILE";
        } else if (disposition === "MIRRORED") {
          unit.disposition = "MIRRORED_OR_DEDUPLICATED";
          unit.canonical_unit_id = readingSelection?.replacementHistoryCanonicalUnitId(unit.logicalRecordNumber, unit.historyIndex, unit.contentIndex) || null;
        } else if (disposition === "SUPPRESSED") {
          unit.disposition = "SUPPRESSED_BY_PROFILE";
        }
      }
    }
    this.finalized = true;
    assertReadingProjectionInvariants(this);
    return this;
  }

  materializeRecord(item, recordNumber, readingSelection) {
    if (this.released) throw new TypeError("Reading projection was released");
    if (!this.finalized) throw new TypeError("Reading projection must be finalized before rendering");
    const record = this.records.get(recordNumber);
    if (!record) throw new TypeError(`Reading projection record is missing: ${recordNumber}`);
    if (record.render_kind === "MESSAGE") {
      const message = record.units.find((unit) => unit.kind === "MESSAGE" && unit.countInCoverage);
      if (!message || message.disposition !== "RENDERED") return Object.freeze({ kind: "NONE", recordNumber, timestamp: record.timestamp, unitIds: Object.freeze([]) });
      if (item?.type !== "response_item" || item.payload?.type !== "message" || item.payload.role !== message.messageRole || !Array.isArray(item.payload.content)) throw new TypeError("Reading projection source shape changed for a message");
      const parts = [];
      for (const unit of record.units) {
        if (unit.parent_unit_id !== message.unit_id || unit.disposition !== "RENDERED") continue;
        if (unit.kind === "TEXT") {
          const part = item.payload.content[unit.contentIndex];
          parts.push(Object.freeze({ unitId: unit.unit_id, contentIndex: unit.contentIndex, contentType: unit.contentType, kind: "TEXT", text: textValue(part, unit.textField), attachments: Object.freeze([]) }));
        } else if (unit.kind === "ATTACHMENT") {
          parts.push(Object.freeze({ unitId: unit.unit_id, contentIndex: unit.contentIndex, contentType: unit.contentType, kind: "ATTACHMENT", text: "", attachments: Object.freeze(readingSelection?.attachmentsForUnit(unit.unit_id, "VISIBLE") || []) }));
        }
      }
      return Object.freeze({
        kind: "MESSAGE",
        recordNumber,
        role: message.messageRole,
        timestamp: record.timestamp,
        contentCount: item.payload.content.length,
        parts: Object.freeze(parts),
        attachments: Object.freeze(parts.flatMap((part) => part.attachments)),
        unitIds: Object.freeze([message.unit_id, ...parts.map((part) => part.unitId)]),
      });
    }
    if (record.render_kind === "HISTORY") {
      const rendered = record.units.filter((unit) => unit.replacementHistory && unit.kind === "ATTACHMENT" && unit.disposition === "RENDERED");
      if (!rendered.length) return Object.freeze({ kind: "NONE", recordNumber, timestamp: record.timestamp, unitIds: Object.freeze([]) });
      return Object.freeze({
        kind: "HISTORY",
        recordNumber,
        timestamp: record.timestamp,
        attachments: Object.freeze(rendered.flatMap((unit) => readingSelection?.attachmentsForUnit(unit.unit_id, "ADDITIONAL_STORED_CONTEXT") || [])),
        unitIds: Object.freeze(rendered.map((unit) => unit.unit_id)),
      });
    }
    if (record.render_kind === "TOOL") {
      const tool = record.units.find((unit) => unit.kind === "TOOL_EVENT");
      if (!tool) return Object.freeze({ kind: "NONE", recordNumber, timestamp: record.timestamp, unitIds: Object.freeze([]) });
      if (item?.type !== "response_item" || item.payload?.type !== tool.toolType) throw new TypeError("Reading projection source shape changed for a tool event");
      if (tool.disposition !== "RENDERED") {
        return Object.freeze({
          kind: "TOOL",
          recordNumber,
          rendered: false,
          timestamp: record.timestamp,
          toolType: tool.toolType,
          unitIds: Object.freeze([tool.unit_id]),
        });
      }
      return Object.freeze({
        kind: "TOOL",
        recordNumber,
        rendered: true,
        timestamp: record.timestamp,
        toolType: tool.toolType,
        toolName: typeof item.payload.name === "string" ? item.payload.name : "",
        text: readableToolPayload(item.payload),
        attachments: Object.freeze(readingSelection?.attachmentsForUnit(tool.unit_id, "VISIBLE") || []),
        unitIds: Object.freeze([tool.unit_id]),
      });
    }
    return Object.freeze({ kind: "NONE", recordNumber, timestamp: record.timestamp, unitIds: Object.freeze([]) });
  }

  units({ coverageOnly = false } = {}) {
    if (this.released) throw new TypeError("Reading projection was released");
    return [...this.records.values(), ...this.physicalOnlyRecords].flatMap((record) => coverageOnly ? record.units.filter((unit) => unit.countInCoverage) : record.units);
  }

  snapshot() {
    if (this.released) throw new TypeError("Reading projection was released");
    return Object.freeze([...this.records.values(), ...this.physicalOnlyRecords].map((record) => Object.freeze({
      record_id: record.record_id,
      outer: record.outer,
      render_kind: record.render_kind,
      containers: Object.freeze(record.containers.map((container) => Object.freeze({ ...container, child_unit_ids: Object.freeze([...container.child_unit_ids]) }))),
      units: Object.freeze(record.units.map((unit) => Object.freeze({
        unit_id: unit.unit_id,
        physical_occurrence: unit.physical_occurrence,
        structure_path: unit.structure_path,
        kind: unit.kind,
        validity: unit.validity,
        disposition: unit.disposition,
        canonical_unit_id: unit.canonical_unit_id,
        parent_unit_id: unit.parent_unit_id,
        count_in_coverage: unit.countInCoverage,
      }))),
    })));
  }

  retainedCounts() {
    const records = [...this.records.values(), ...this.physicalOnlyRecords];
    return Object.freeze({
      records: records.length,
      units: records.reduce((sum, record) => sum + record.units.length, 0),
    });
  }

  release() {
    if (!this.finalized) throw new TypeError("Reading projection must be finalized before release");
    this.records.clear();
    this.physicalOnlyRecords.length = 0;
    this.compactedCanonicalUnits.clear();
    this.compactedUnitIds.clear();
    this.released = true;
    return this;
  }
}

export function assertReadingProjectionInvariants(projection) {
  if (!(projection instanceof ReadingProjection)) throw new TypeError("Reading projection is invalid");
  if (projection.released) throw new TypeError("Reading projection was released");
  const records = [...projection.records.values(), ...projection.physicalOnlyRecords];
  const units = records.flatMap((record) => record.units);
  const byId = new Map([...projection.compactedUnitIds].map((unitId) => [unitId, Object.freeze({ unit_id: unitId })]));
  for (const unit of units) {
    if (typeof unit.unit_id !== "string" || !unit.unit_id || byId.has(unit.unit_id)) throw new TypeError("Reading projection unit identity invariant failed");
    if (!INNER_DISPOSITIONS.includes(unit.disposition)) throw new TypeError("Reading projection disposition invariant failed");
    if (!unit.physical_occurrence || typeof unit.structure_path !== "string" || !unit.structure_path || typeof unit.kind !== "string" || !unit.kind) throw new TypeError("Reading projection provenance invariant failed");
    if (unit.render_data !== undefined) throw new TypeError("Reading projection must not retain render data");
    byId.set(unit.unit_id, unit);
  }
  for (const record of records) {
    for (const container of record.containers) {
      const children = record.units.filter((unit) => unit.parent_unit_id === container.container_id);
      if (container.validity === "VALID") {
        if (children.length !== container.content_count || children.length !== container.child_unit_ids.length) throw new TypeError("Reading projection content-unit invariant failed");
        if (children.some((unit) => !container.child_unit_ids.includes(unit.unit_id))) throw new TypeError("Reading projection child identity invariant failed");
      } else if (children.length || container.child_unit_ids.length) {
        throw new TypeError("Invalid reading projection container authorized children");
      }
    }
  }
  for (const unit of units) {
    if (unit.disposition === "MIRRORED_OR_DEDUPLICATED") {
      if (!unit.canonical_unit_id || unit.canonical_unit_id === unit.unit_id || !byId.has(unit.canonical_unit_id)) throw new TypeError("Reading projection mirror invariant failed");
    }
  }
  return true;
}

export function messageAttachmentIdentity(message) {
  const inspected = inspectProjectedMessage({ type: "response_item", payload: message });
  if (!inspected) return "";
  return inspected.parts.flatMap((part) => part.descriptors).map(attachmentIdentity).join("|");
}

export { TOOL_CALL_TYPES, TOOL_OUTPUT_TYPES, replacementHistoryContentKey };
