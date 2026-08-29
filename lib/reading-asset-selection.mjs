import { createHash } from "node:crypto";

import { attachmentIdentity, isAttachmentDescriptor } from "./session-record-reader.mjs";

export const READING_ASSET_DISPOSITION = Object.freeze({
  VISIBLE: "VISIBLE",
  ADDITIONAL_STORED_CONTEXT: "ADDITIONAL_STORED_CONTEXT",
  MIRRORED: "MIRRORED",
  EXCLUDED: "EXCLUDED",
});

export const READING_ASSET_MIRROR_KIND = Object.freeze({
  NONE: "",
  USER_EVENT: "USER_EVENT",
  TOOL_RESULT: "TOOL_RESULT",
  REPLACEMENT_HISTORY: "REPLACEMENT_HISTORY",
});

const TOOL_RESULT_PAIR_MAX_DELAY_MS = 1000;
const TOOL_PAYLOAD_TYPES = new Set(["function_call", "custom_tool_call", "function_call_output", "custom_tool_call_output"]);

function upperRole(value) {
  const role = String(value || "").toUpperCase();
  return ["USER", "ASSISTANT", "DEVELOPER", "TOOL"].includes(role) ? role : "UNCLASSIFIED";
}

function recordType(item) {
  const outer = String(item?.type || "unknown");
  const inner = String(item?.payload?.type || "");
  return inner ? `${outer}/${inner}` : outer;
}

function summarizeRecord(item) {
  const payload = item?.payload;
  return Object.freeze({
    browser: isBrowserRecord(item),
    callId: typeof payload?.call_id === "string" ? payload.call_id : "",
    payloadRole: String(payload?.role || ""),
    payloadType: String(payload?.type || ""),
    timestamp: String(item?.timestamp || ""),
    type: String(item?.type || ""),
  });
}

function contentTypeFor(parent, key, inherited) {
  if (parent && typeof parent === "object" && typeof parent.type === "string" && !["message", "compaction"].includes(parent.type)) return parent.type;
  return typeof key === "string" ? key : inherited || "attachment";
}

function inferRecordRole(item) {
  if (item?.type === "response_item" && item.payload?.type === "message") return upperRole(item.payload.role);
  if (item?.type === "event_msg" && item.payload?.type === "user_message") return "USER";
  if ((item?.type === "response_item" && TOOL_PAYLOAD_TYPES.has(item.payload?.type)) || (item?.type === "event_msg" && item.payload?.type === "mcp_tool_call_end")) return "TOOL";
  return "UNCLASSIFIED";
}

function collectOccurrences(item, recordNumber) {
  const output = [];
  const base = {
    contentType: "attachment",
    role: inferRecordRole(item),
  };
  const visit = (value, context, parent = null, key = null) => {
    if (isAttachmentDescriptor(value)) {
      output.push({
        attachmentOrdinal: output.length + 1,
        canonicalAttachmentOrdinal: null,
        canonicalRecordOrdinal: null,
        classification: "UNCLASSIFIED_ATTACHMENT_RECORD",
        contentType: contentTypeFor(parent, key, context.contentType),
        descriptor: value,
        disposition: READING_ASSET_DISPOSITION.EXCLUDED,
        mirrorKind: READING_ASSET_MIRROR_KIND.NONE,
        recordNumber,
        recordType: recordType(item),
        role: context.role,
        store: false,
        timestamp: String(item?.timestamp || ""),
        toolOrigin: "NONE",
      });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((child, index) => visit(child, context, value, index));
      return;
    }
    if (!value || typeof value !== "object") return;
    const next = { ...context };
    if (value.type === "message" && value.role) next.role = upperRole(value.role);
    if (typeof value.type === "string" && !["message", "compaction"].includes(value.type)) next.contentType = value.type;
    for (const [childKey, child] of Object.entries(value)) {
      const childContext = ["attachment", "attachments", "image", "image_url", "images", "local_image", "local_images"].includes(childKey.toLowerCase())
        ? { ...next, contentType: ["image", "input_image", "local_image", "output_image"].includes(value.type) ? value.type : childKey }
        : next;
      visit(child, childContext, value, childKey);
    }
  };
  visit(item, base);
  return output;
}

function messageIdentity(message) {
  const hash = createHash("sha256");
  const update = (value) => {
    if (isAttachmentDescriptor(value)) {
      const identity = attachmentIdentity(value);
      hash.update(`attachment:${Buffer.byteLength(identity)}:`).update(identity);
      return;
    }
    if (Array.isArray(value)) {
      hash.update(`array:${value.length}:`);
      value.forEach(update);
      return;
    }
    if (value && typeof value === "object") {
      const keys = Object.keys(value).sort();
      hash.update(`object:${keys.length}:`);
      for (const key of keys) {
        hash.update(`key:${Buffer.byteLength(key)}:`).update(key);
        update(value[key]);
      }
      return;
    }
    const scalar = value === undefined ? "undefined" : JSON.stringify(value);
    hash.update(`scalar:${Buffer.byteLength(scalar)}:`).update(scalar);
  };
  update({ content: message?.content || [], role: String(message?.role || ""), type: String(message?.type || "") });
  return hash.digest("hex");
}

function decodedAttachmentIdentity(descriptor) {
  return `${descriptor?.sha256 || ""}:${descriptor?.decodedBytes ?? ""}:${String(descriptor?.mediaType || "").toLowerCase()}`;
}

function sameDecodedAttachments(left, right) {
  return left.length > 0
    && left.length === right.length
    && left.every((occurrence, index) => decodedAttachmentIdentity(occurrence.descriptor) === decodedAttachmentIdentity(right[index].descriptor));
}

function exactSourceAttachments(left, right) {
  return left.length === right.length
    && left.every((occurrence, index) => attachmentIdentity(occurrence.descriptor) === attachmentIdentity(right[index].descriptor));
}

function toolResultPair(eventRecord, responseRecord) {
  if (eventRecord?.info?.type !== "event_msg" || eventRecord.info.payloadType !== "mcp_tool_call_end") return false;
  if (responseRecord?.info?.type !== "response_item" || responseRecord.info.payloadType !== "function_call_output") return false;
  const eventCallId = eventRecord.info.callId;
  const responseCallId = responseRecord.info.callId;
  if (typeof eventCallId !== "string" || !eventCallId || eventCallId !== responseCallId) return false;
  const delay = Date.parse(responseRecord.info.timestamp) - Date.parse(eventRecord.info.timestamp);
  return Number.isFinite(delay)
    && delay >= 0
    && delay <= TOOL_RESULT_PAIR_MAX_DELAY_MS
    && sameDecodedAttachments(eventRecord.occurrences, responseRecord.occurrences);
}

function isBrowserRecord(item) {
  return item?.type === "event_msg"
    && item.payload?.type === "mcp_tool_call_end"
    && item.payload?.result?.Ok?._meta?.["codex/browserUse"] === true;
}

function canonicalize(occurrence, disposition) {
  occurrence.disposition = disposition;
  occurrence.store = true;
  occurrence.canonicalRecordOrdinal = occurrence.recordNumber;
  occurrence.canonicalAttachmentOrdinal = occurrence.attachmentOrdinal;
}

function mirrorTo(occurrence, canonical, kind) {
  occurrence.disposition = READING_ASSET_DISPOSITION.MIRRORED;
  occurrence.store = false;
  occurrence.mirrorKind = kind;
  occurrence.canonicalRecordOrdinal = canonical.recordNumber;
  occurrence.canonicalAttachmentOrdinal = canonical.attachmentOrdinal;
}

export class ReadingAssetSelection {
  constructor({ includeReplacementHistory = true, includeTools = false } = {}) {
    this.includeReplacementHistory = Boolean(includeReplacementHistory);
    this.includeTools = Boolean(includeTools);
    this.allOccurrences = [];
    this.byRecord = new Map();
    this.previousRecord = null;
    this.toolNames = new Map();
    this.browserResponseRecords = new Set();
    this.visibleMessageCounts = new Map();
    this.visibleMessages = new Map();
    this.additionalMessages = new Map();
  }

  observe(item, recordNumber) {
    const occurrences = collectOccurrences(item, recordNumber);
    const record = { info: summarizeRecord(item), occurrences, recordNumber };
    if (occurrences.length) this.byRecord.set(recordNumber, record);
    this.allOccurrences.push(...occurrences);

    const payload = item?.payload;
    if (item?.type === "response_item" && ["function_call", "custom_tool_call"].includes(payload?.type) && typeof payload.call_id === "string" && payload.call_id) {
      this.toolNames.set(payload.call_id, String(payload.name || ""));
    }

    if (toolResultPair(this.previousRecord, record)) {
      this.browserResponseRecords.add(recordNumber);
      for (let index = 0; index < occurrences.length; index += 1) {
        mirrorTo(this.previousRecord.occurrences[index], occurrences[index], READING_ASSET_MIRROR_KIND.TOOL_RESULT);
        this.previousRecord.occurrences[index].toolOrigin = this.previousRecord.info.browser ? "BROWSER" : "TOOL";
      }
    }

    if (item?.type === "response_item" && payload?.type === "message") {
      const visible = payload.role === "user" || payload.role === "assistant";
      if (visible) {
        for (const occurrence of occurrences) canonicalize(occurrence, READING_ASSET_DISPOSITION.VISIBLE);
        if (occurrences.length) {
          const identity = messageIdentity(payload);
          const count = (this.visibleMessageCounts.get(identity) || 0) + 1;
          this.visibleMessageCounts.set(identity, count);
          this.visibleMessages.set(`${identity}:${count}`, [...occurrences]);
        }
      }
    } else if (item?.type === "response_item" && TOOL_PAYLOAD_TYPES.has(payload?.type)) {
      const toolName = record.info.callId ? this.toolNames.get(record.info.callId) : "";
      for (const occurrence of occurrences) occurrence.toolOrigin = toolName === "view_image" ? "VIEW_IMAGE" : "TOOL";
      if (this.includeTools) for (const occurrence of occurrences) canonicalize(occurrence, READING_ASSET_DISPOSITION.VISIBLE);
      if (["function_call_output", "custom_tool_call_output"].includes(payload?.type) && record.info.callId) this.toolNames.delete(record.info.callId);
    } else if (item?.type === "compacted" && Array.isArray(payload?.replacement_history)) {
      this.observeReplacementHistory(record, payload.replacement_history);
    }

    this.previousRecord = record;
    return Object.freeze({ storedAttachmentOrdinals: Object.freeze(occurrences.filter(occurrence => occurrence.store).map(occurrence => occurrence.attachmentOrdinal)) });
  }

  observeReplacementHistory(record, history) {
    const occurrenceByDescriptor = new Map(record.occurrences.map(occurrence => [occurrence.descriptor, occurrence]));
    const messages = [];
    const historyTotals = new Map();
    for (const message of history) {
      if (message?.type !== "message") continue;
      const messageOccurrences = [];
      const visit = (value) => {
        if (isAttachmentDescriptor(value)) {
          const occurrence = occurrenceByDescriptor.get(value);
          if (occurrence) messageOccurrences.push(occurrence);
          return;
        }
        if (Array.isArray(value)) value.forEach(visit);
        else if (value && typeof value === "object") Object.values(value).forEach(visit);
      };
      visit(message.content);
      if (!messageOccurrences.length) continue;
      const identity = messageIdentity(message);
      messages.push({ identity, messageOccurrences });
      historyTotals.set(identity, (historyTotals.get(identity) || 0) + 1);
    }

    const historyCounts = new Map();
    for (const { identity, messageOccurrences } of messages) {
      const count = (historyCounts.get(identity) || 0) + 1;
      historyCounts.set(identity, count);
      const logicalKey = `${identity}:${count}`;
      const visibleOriginal = this.visibleMessageCounts.get(identity) === historyTotals.get(identity)
        ? this.visibleMessages.get(logicalKey)
        : null;
      if (visibleOriginal && exactSourceAttachments(messageOccurrences, visibleOriginal)) {
        messageOccurrences.forEach((occurrence, index) => mirrorTo(occurrence, visibleOriginal[index], READING_ASSET_MIRROR_KIND.REPLACEMENT_HISTORY));
        continue;
      }
      if (!this.includeReplacementHistory) continue;
      const storedOriginal = this.additionalMessages.get(logicalKey);
      if (storedOriginal && exactSourceAttachments(messageOccurrences, storedOriginal)) {
        messageOccurrences.forEach((occurrence, index) => mirrorTo(occurrence, storedOriginal[index], READING_ASSET_MIRROR_KIND.REPLACEMENT_HISTORY));
        continue;
      }
      for (const occurrence of messageOccurrences) canonicalize(occurrence, READING_ASSET_DISPOSITION.ADDITIONAL_STORED_CONTEXT);
      this.additionalMessages.set(logicalKey, [...messageOccurrences]);
    }
  }

  finish(eventAnalysis = {}) {
    const mirrorPairs = eventAnalysis.mirrorPairs instanceof Map ? eventAnalysis.mirrorPairs : new Map();
    for (const [mirrorRecordNumber, canonicalRecordNumber] of mirrorPairs) {
      const mirror = this.byRecord.get(mirrorRecordNumber)?.occurrences || [];
      const canonical = this.byRecord.get(canonicalRecordNumber)?.occurrences || [];
      if (!exactSourceAttachments(mirror, canonical)) continue;
      mirror.forEach((occurrence, index) => mirrorTo(occurrence, canonical[index], READING_ASSET_MIRROR_KIND.USER_EVENT));
    }

    for (const occurrence of this.allOccurrences) {
      const record = this.byRecord.get(occurrence.recordNumber);
      const info = record?.info || {};
      if (info.type === "response_item" && info.payloadType === "message" && info.payloadRole === "user") {
        occurrence.classification = eventAnalysis.classifications?.get(occurrence.recordNumber)?.kind || "UNCLASSIFIED_USER_ROLE_RECORD";
      } else if (info.type === "response_item" && info.payloadType === "message" && info.payloadRole === "assistant") {
        occurrence.classification = "ASSISTANT_MESSAGE";
      } else if (info.type === "event_msg" && info.payloadType === "user_message") {
        occurrence.classification = occurrence.mirrorKind === READING_ASSET_MIRROR_KIND.USER_EVENT ? "MIRRORED_USER_EVENT" : "UNSELECTED_USER_EVENT";
      } else if (info.type === "compacted") {
        occurrence.classification = occurrence.disposition === READING_ASSET_DISPOSITION.ADDITIONAL_STORED_CONTEXT
          ? "ADDITIONAL_STORED_CONTEXT"
          : occurrence.disposition === READING_ASSET_DISPOSITION.MIRRORED
            ? "REPLACEMENT_HISTORY_MIRROR"
            : "REPLACEMENT_HISTORY_SUPPRESSED";
      } else if ((info.type === "response_item" && TOOL_PAYLOAD_TYPES.has(info.payloadType)) || (info.type === "event_msg" && info.payloadType === "mcp_tool_call_end")) {
        occurrence.classification = this.browserResponseRecords.has(occurrence.recordNumber) || info.browser ? "TOOL_BROWSER_SCREENSHOT" : "TOOL_RECORD";
      }

      if (occurrence.role === "TOOL") {
        occurrence.toolOrigin = this.browserResponseRecords.has(occurrence.recordNumber) || info.browser
          ? "BROWSER"
          : occurrence.toolOrigin === "VIEW_IMAGE" ? "VIEW_IMAGE" : "TOOL";
      }
      if (occurrence.disposition === READING_ASSET_DISPOSITION.EXCLUDED) {
        occurrence.canonicalRecordOrdinal = null;
        occurrence.canonicalAttachmentOrdinal = null;
      }
    }
    return this;
  }

  storedAttachmentOrdinals(recordNumber) {
    return (this.byRecord.get(recordNumber)?.occurrences || []).filter(occurrence => occurrence.store).map(occurrence => occurrence.attachmentOrdinal);
  }

  visibleAttachmentOrdinals(recordNumber) {
    return (this.byRecord.get(recordNumber)?.occurrences || [])
      .filter(occurrence => occurrence.disposition === READING_ASSET_DISPOSITION.VISIBLE)
      .map(occurrence => occurrence.attachmentOrdinal);
  }

  additionalAttachmentOrdinals(recordNumber) {
    return (this.byRecord.get(recordNumber)?.occurrences || [])
      .filter(occurrence => occurrence.disposition === READING_ASSET_DISPOSITION.ADDITIONAL_STORED_CONTEXT)
      .map(occurrence => occurrence.attachmentOrdinal);
  }

  manifestAnnotations() {
    return this.allOccurrences.map((occurrence) => Object.freeze({
      attachment_ordinal: occurrence.attachmentOrdinal,
      canonical_attachment_ordinal: occurrence.canonicalAttachmentOrdinal,
      canonical_record_ordinal: occurrence.canonicalRecordOrdinal,
      classification: occurrence.classification,
      content_type: occurrence.contentType,
      descriptor: occurrence.descriptor,
      mirror_kind: occurrence.mirrorKind,
      reading_disposition: occurrence.disposition,
      record_ordinal: occurrence.recordNumber,
      record_type: occurrence.recordType,
      role: occurrence.role,
      timestamp: occurrence.timestamp,
      tool_origin: occurrence.toolOrigin,
    }));
  }

}
