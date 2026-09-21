import { createHash } from "node:crypto";

import { collectProjectedAttachmentDescriptors, replacementHistoryContentKey } from "./reading-projection.mjs";
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

const TOOL_PAYLOAD_TYPES = new Set(["function_call", "custom_tool_call", "function_call_output", "custom_tool_call_output"]);

function usableCallId(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function retainedString(value) {
  const text = typeof value === "string" ? value : String(value ?? "");
  return text ? Buffer.from(text, "utf16le").toString("utf16le") : "";
}

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
    callId: typeof payload?.call_id === "string" ? retainedString(payload.call_id) : "",
    payloadRole: retainedString(payload?.role || ""),
    payloadType: retainedString(payload?.type || ""),
    timestamp: retainedString(item?.timestamp || ""),
    type: retainedString(item?.type || ""),
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
        canonicalProjectedUnitId: null,
        projectedUnitId: null,
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

export function collectProjectableMessageAttachments(content) {
  return Array.isArray(content) ? content.flatMap(collectProjectedAttachmentDescriptors) : [];
}

function valueIdentity(value) {
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
    if (typeof value === "string") {
      hash.update(`string:${Buffer.byteLength(value)}:`).update(value);
      return;
    }
    const scalar = value === undefined ? "undefined" : JSON.stringify(value);
    hash.update(`scalar:${Buffer.byteLength(scalar)}:`).update(scalar);
  };
  update(value);
  return hash.digest("hex");
}

function messageIdentity(message) {
  return valueIdentity({ content: message?.content || [], role: String(message?.role || ""), type: String(message?.type || "") });
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

function toolResultContent(item) {
  if (item?.type === "event_msg" && item.payload?.type === "mcp_tool_call_end") return item.payload?.result?.Ok?.content;
  if (item?.type === "response_item" && ["function_call_output", "custom_tool_call_output"].includes(item.payload?.type)) return item.payload.output;
  return undefined;
}

function attachmentOnlyContent(value) {
  if (isAttachmentDescriptor(value)) return true;
  if (Array.isArray(value)) return value.length > 0 && value.every(attachmentOnlyContent);
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    return entries.length > 0 && entries.every(([key, child]) => (["type", "mimeType"].includes(key) && typeof child === "string") || attachmentOnlyContent(child));
  }
  return false;
}

function toolResultIdentity(item, occurrences) {
  const content = toolResultContent(item);
  if (content === undefined) return "";
  if (occurrences.length && attachmentOnlyContent(content)) {
    return `attachments:${occurrences.map((occurrence) => decodedAttachmentIdentity(occurrence.descriptor)).join("|")}`;
  }
  return `value:${valueIdentity(content)}`;
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
  occurrence.canonicalProjectedUnitId = canonical.projectedUnitId || null;
}

export class ReadingAssetSelection {
  constructor({ includeReplacementHistory = true, includeTools = false } = {}) {
    this.includeReplacementHistory = Boolean(includeReplacementHistory);
    this.includeTools = Boolean(includeTools);
    this.allOccurrences = [];
    this.byRecord = new Map();
    this.toolNames = new Map();
    this.toolCallIdCounts = new Map();
    this.toolMirrorCandidates = new Map();
    this.toolMirrorPairs = new Map();
    this.browserResponseRecords = new Set();
    this.visibleMessageCounts = new Map();
    this.visibleMessages = new Map();
    this.additionalMessages = new Map();
    this.replacementHistoryDispositions = new Map();
    this.replacementHistoryCanonicalUnits = new Map();
    this.released = false;
  }

  observe(item, recordNumber, projectedRecord) {
    if (this.released) throw new TypeError("Asset selection was released");
    if (!projectedRecord || projectedRecord.logical_record_ordinal !== recordNumber) throw new TypeError("Asset selection requires the common reading projection");
    const occurrences = collectOccurrences(item, recordNumber);
    const record = { info: summarizeRecord(item), occurrences, recordNumber };
    if (occurrences.length) this.byRecord.set(recordNumber, record);
    this.allOccurrences.push(...occurrences);
    const projectedEvent = projectedRecord.units.find((unit) => unit.eventType);
    if (projectedEvent) for (const occurrence of occurrences) occurrence.projectedUnitId = projectedEvent.unit_id;

    const payload = item?.payload;
    if (item?.type === "response_item" && ["function_call", "custom_tool_call"].includes(payload?.type) && usableCallId(payload.call_id)) {
      const callId = retainedString(payload.call_id);
      this.toolNames.set(callId, retainedString(payload.name || ""));
      this.toolCallIdCounts.set(callId, (this.toolCallIdCounts.get(callId) || 0) + 1);
    }

    if (usableCallId(record.info.callId) && ((record.info.type === "event_msg" && record.info.payloadType === "mcp_tool_call_end")
      || (record.info.type === "response_item" && ["function_call_output", "custom_tool_call_output"].includes(record.info.payloadType)))) {
      const candidates = this.toolMirrorCandidates.get(record.info.callId) || [];
      candidates.push({
        identity: toolResultIdentity(item, occurrences),
        kind: record.info.type === "event_msg" ? "EVENT" : "RESPONSE",
        record,
      });
      this.toolMirrorCandidates.set(record.info.callId, candidates);
    }

    if (projectedRecord.render_kind === "MESSAGE") {
      const messageUnit = projectedRecord.units.find((unit) => unit.kind === "MESSAGE");
      const contentUnits = projectedRecord.units.filter((unit) => unit.parent_unit_id === messageUnit?.unit_id);
      const attachmentUnits = contentUnits.filter((unit) => unit.kind === "ATTACHMENT");
      const projectableOccurrences = [];
      const unitIdsByContentIndex = new Map(contentUnits.map((unit) => [unit.contentIndex, unit.unit_id]));
      for (const unit of attachmentUnits) {
        const descriptors = new Set(collectProjectedAttachmentDescriptors(payload.content[unit.contentIndex]));
        for (const occurrence of occurrences) {
          if (!descriptors.has(occurrence.descriptor)) continue;
          occurrence.projectedUnitId = unit.unit_id;
          canonicalize(occurrence, READING_ASSET_DISPOSITION.VISIBLE);
          projectableOccurrences.push(occurrence);
        }
      }
      if (projectableOccurrences.length) {
        const identity = messageIdentity(payload);
        const count = (this.visibleMessageCounts.get(identity) || 0) + 1;
        this.visibleMessageCounts.set(identity, count);
        this.visibleMessages.set(`${identity}:${count}`, { occurrences: [...projectableOccurrences], unitIdsByContentIndex });
      }
    } else if (projectedRecord.render_kind === "TOOL") {
      const toolUnit = projectedRecord.units.find((unit) => unit.kind === "TOOL_EVENT");
      for (const occurrence of occurrences) occurrence.projectedUnitId = toolUnit?.unit_id || null;
      const toolName = usableCallId(record.info.callId) ? this.toolNames.get(record.info.callId) : "";
      for (const occurrence of occurrences) occurrence.toolOrigin = toolName === "view_image" ? "VIEW_IMAGE" : "TOOL";
      if (this.includeTools) for (const occurrence of occurrences) canonicalize(occurrence, READING_ASSET_DISPOSITION.VISIBLE);
      if (["function_call_output", "custom_tool_call_output"].includes(payload?.type) && usableCallId(record.info.callId)) this.toolNames.delete(record.info.callId);
    } else if (projectedRecord.render_kind === "HISTORY") {
      this.observeReplacementHistory(record, payload.replacement_history, projectedRecord);
    }

    return Object.freeze({ storedAttachmentOrdinals: Object.freeze(occurrences.filter(occurrence => occurrence.store).map(occurrence => occurrence.attachmentOrdinal)) });
  }

  observeReplacementHistory(record, history, projectedRecord) {
    const occurrenceByDescriptor = new Map(record.occurrences.map(occurrence => [occurrence.descriptor, occurrence]));
    const messages = [];
    const historyTotals = new Map();
    const dispositions = new Map();
    const canonicalUnits = new Map();
    this.replacementHistoryDispositions.set(record.recordNumber, dispositions);
    this.replacementHistoryCanonicalUnits.set(record.recordNumber, canonicalUnits);
    const validContainers = projectedRecord.containers.filter((container) => container.validity === "VALID");
    for (const container of validContainers) {
      const historyIndex = Number(container.container_id.split(":").at(-1));
      const message = history[historyIndex];
      const content = message.content;
      const contentUnits = projectedRecord.units.filter((unit) => unit.historyIndex === historyIndex && unit.parent_unit_id === container.container_id);
      const messageOccurrences = [];
      const contentOccurrences = [];
      for (const unit of contentUnits) {
        const contentIndex = unit.contentIndex;
        const occurrences = (unit.kind === "ATTACHMENT" ? collectProjectedAttachmentDescriptors(content[contentIndex]) : [])
          .map((descriptor) => occurrenceByDescriptor.get(descriptor))
          .filter(Boolean);
        for (const occurrence of occurrences) occurrence.projectedUnitId = unit.unit_id;
        messageOccurrences.push(...occurrences);
        contentOccurrences.push({ contentIndex, occurrences, unitId: unit.unit_id });
      }
      if (!messageOccurrences.length) continue;
      for (let contentIndex = 0; contentIndex < content.length; contentIndex += 1) {
        dispositions.set(replacementHistoryContentKey(historyIndex, contentIndex), this.includeReplacementHistory ? "RAW_ONLY" : "SUPPRESSED");
      }
      const identity = messageIdentity(message);
      messages.push({ contentOccurrences, historyIndex, identity, messageOccurrences });
      historyTotals.set(identity, (historyTotals.get(identity) || 0) + 1);
    }

    const historyCounts = new Map();
    for (const { contentOccurrences, historyIndex, identity, messageOccurrences } of messages) {
      const count = (historyCounts.get(identity) || 0) + 1;
      historyCounts.set(identity, count);
      const logicalKey = `${identity}:${count}`;
      const visibleOriginal = this.visibleMessageCounts.get(identity) === historyTotals.get(identity)
        ? this.visibleMessages.get(logicalKey)
        : null;
      if (visibleOriginal && exactSourceAttachments(messageOccurrences, visibleOriginal.occurrences)) {
        messageOccurrences.forEach((occurrence, index) => mirrorTo(occurrence, visibleOriginal.occurrences[index], READING_ASSET_MIRROR_KIND.REPLACEMENT_HISTORY));
        for (const { contentIndex } of contentOccurrences) {
          dispositions.set(replacementHistoryContentKey(historyIndex, contentIndex), "MIRRORED");
          const canonicalUnitId = visibleOriginal.unitIdsByContentIndex.get(contentIndex) || visibleOriginal.occurrences[0]?.projectedUnitId || null;
          if (canonicalUnitId) canonicalUnits.set(replacementHistoryContentKey(historyIndex, contentIndex), canonicalUnitId);
        }
        continue;
      }
      if (!this.includeReplacementHistory) continue;
      const storedOriginal = this.additionalMessages.get(logicalKey);
      if (storedOriginal && exactSourceAttachments(messageOccurrences, storedOriginal.occurrences)) {
        messageOccurrences.forEach((occurrence, index) => mirrorTo(occurrence, storedOriginal.occurrences[index], READING_ASSET_MIRROR_KIND.REPLACEMENT_HISTORY));
        for (const { contentIndex } of contentOccurrences) {
          dispositions.set(replacementHistoryContentKey(historyIndex, contentIndex), "MIRRORED");
          const canonicalUnitId = storedOriginal.unitIdsByContentIndex.get(contentIndex) || storedOriginal.occurrences[0]?.projectedUnitId || null;
          if (canonicalUnitId) canonicalUnits.set(replacementHistoryContentKey(historyIndex, contentIndex), canonicalUnitId);
        }
        continue;
      }
      for (const occurrence of messageOccurrences) canonicalize(occurrence, READING_ASSET_DISPOSITION.ADDITIONAL_STORED_CONTEXT);
      this.additionalMessages.set(logicalKey, { occurrences: [...messageOccurrences], unitIdsByContentIndex: new Map(contentOccurrences.map((entry) => [entry.contentIndex, entry.unitId])) });
      for (const { contentIndex, occurrences } of contentOccurrences) {
        if (occurrences.length) dispositions.set(replacementHistoryContentKey(historyIndex, contentIndex), "ADDITIONAL_STORED_CONTEXT");
      }
    }
  }

  finish(eventAnalysis = {}) {
    if (this.released) throw new TypeError("Asset selection was released");
    for (const [callId, candidates] of this.toolMirrorCandidates) {
      const events = candidates.filter(candidate => candidate.kind === "EVENT");
      const responses = candidates.filter(candidate => candidate.kind === "RESPONSE");
      if ((this.toolCallIdCounts.get(callId) || 0) > 1 || events.length !== 1 || responses.length !== 1 || !events[0].identity || events[0].identity !== responses[0].identity) continue;
      const eventRecord = events[0].record;
      const responseRecord = responses[0].record;
      if (!sameDecodedAttachments(eventRecord.occurrences, responseRecord.occurrences) && eventRecord.occurrences.length + responseRecord.occurrences.length > 0) continue;
      this.browserResponseRecords.add(responseRecord.recordNumber);
      this.toolMirrorPairs.set(eventRecord.recordNumber, responseRecord.recordNumber);
      for (let index = 0; index < eventRecord.occurrences.length; index += 1) {
        mirrorTo(eventRecord.occurrences[index], responseRecord.occurrences[index], READING_ASSET_MIRROR_KIND.TOOL_RESULT);
        eventRecord.occurrences[index].toolOrigin = eventRecord.info.browser ? "BROWSER" : "TOOL";
      }
    }
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

  replacementHistoryDisposition(recordNumber, historyIndex, contentIndex) {
    return this.replacementHistoryDispositions.get(recordNumber)?.get(replacementHistoryContentKey(historyIndex, contentIndex)) || "";
  }

  replacementHistoryCanonicalUnitId(recordNumber, historyIndex, contentIndex) {
    return this.replacementHistoryCanonicalUnits.get(recordNumber)?.get(replacementHistoryContentKey(historyIndex, contentIndex)) || "";
  }

  attachmentsForUnit(unitId, disposition) {
    if (this.released) throw new TypeError("Asset selection was released");
    return this.allOccurrences
      .filter((occurrence) => occurrence.projectedUnitId === unitId && occurrence.disposition === disposition)
      .map((occurrence) => occurrence.descriptor);
  }

  manifestAnnotations() {
    if (this.released) throw new TypeError("Asset selection was released");
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

  retainedCounts() {
    return Object.freeze({
      occurrences: this.allOccurrences.length,
      records: this.byRecord.size,
    });
  }

  release() {
    this.allOccurrences.length = 0;
    for (const value of [
      this.byRecord,
      this.toolNames,
      this.toolCallIdCounts,
      this.toolMirrorCandidates,
      this.toolMirrorPairs,
      this.browserResponseRecords,
      this.visibleMessageCounts,
      this.visibleMessages,
      this.additionalMessages,
      this.replacementHistoryDispositions,
      this.replacementHistoryCanonicalUnits,
    ]) value.clear();
    this.released = true;
    return this;
  }

}
