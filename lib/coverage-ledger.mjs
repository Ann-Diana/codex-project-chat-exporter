import {
  INNER_DISPOSITIONS,
  OUTER_CLASSIFICATIONS,
  TOOL_CALL_TYPES,
  TOOL_OUTPUT_TYPES,
} from "./reading-projection.mjs";

function emptyCounts(names) {
  return Object.fromEntries(names.map((name) => [name, 0]));
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function ordinalAnomaly(previous, item) {
  if (!safeObject(item) || !Object.hasOwn(item, "ordinal")) return "";
  const current = item.ordinal;
  if (!Number.isSafeInteger(current) || current < 0) return "invalid_ordinal";
  if (previous === null) return "";
  if (current === previous) return "duplicate_ordinal";
  if (current < previous) return "regressive_ordinal";
  if (current > previous + 1) return "skipped_ordinal";
  return "";
}

export class CoverageLedger {
  constructor({ readingViewEnabled = true } = {}) {
    this.readingViewEnabled = Boolean(readingViewEnabled);
    this.outerCounts = emptyCounts(OUTER_CLASSIFICATIONS);
    this.anomalies = {
      duplicate_ordinal: 0,
      regressive_ordinal: 0,
      skipped_ordinal: 0,
      invalid_ordinal: 0,
      unknown_outer_record_type: 0,
      unknown_inner_type: 0,
      tool_output_no_call_id_present: 0,
      tool_output_empty_call_id: 0,
      tool_output_invalid_call_id: 0,
      tool_output_unmatched_call_id: 0,
      tool_output_ambiguous_call_id: 0,
      present_but_unlinked_segment: 0,
      ambiguous_segment_order: 0,
    };
    this.sources = new Map();
    this.coverageUnits = [];
    this.innerCounts = emptyCounts(INNER_DISPOSITIONS);
    this.callCounts = new Map();
    this.outputCounts = new Map();
    this.semanticGaps = new Map();
    this.toolOutputLinkages = [];
    this.finished = false;
  }

  observeCoverageUnit(unit) {
    this.innerCounts[unit.disposition] += 1;
    if (unit.evidence) {
      const value = { disposition: unit.disposition, ...unit.evidence };
      const key = JSON.stringify(value);
      const existing = this.semanticGaps.get(key);
      if (existing) existing.count += 1;
      else this.semanticGaps.set(key, { ...value, count: 1 });
    }
    if (TOOL_CALL_TYPES.has(unit.toolType) && typeof unit.callId === "string" && unit.callId.trim()) this.callCounts.set(unit.callId, (this.callCounts.get(unit.callId) || 0) + 1);
    if (unit.linkage?.status === "PENDING") this.outputCounts.set(unit.linkage.id, (this.outputCounts.get(unit.linkage.id) || 0) + 1);
    if (TOOL_OUTPUT_TYPES.has(unit.toolType) && unit.linkage) this.toolOutputLinkages.push(unit.linkage);
  }

  observePhysicalRecord(record, source, projectedRecord) {
    if (this.finished) throw new TypeError("Coverage ledger is already finalized");
    if (!projectedRecord || projectedRecord.logical_record_ordinal !== source.logicalRecordNumber) throw new TypeError("Coverage requires the common reading projection for every physical record");
    const item = record.item;
    const sourceKey = source.sourceKey;
    let observed = this.sources.get(sourceKey);
    if (!observed) {
      observed = {
        boundary: source.boundary || null,
        file: source.file,
        fileSize: source.fileSize,
        physicalSourceGroup: source.physicalSourceGroup || null,
        prefixAliases: source.prefixAliases || [],
        prefixSha256: source.prefixSha256 || "",
        rolloutId: source.rolloutId || "",
        sourceKey,
        sourceRootPath: source.sourceRootPath,
        sourceVersion: source.sourceVersion || null,
        storage: source.storage || "active",
        threadId: source.id || source.session_id || "",
        firstOrdinal: null,
        lastOrdinal: null,
        outerClassifications: emptyCounts(OUTER_CLASSIFICATIONS),
        recordCount: 0,
      };
      this.sources.set(sourceKey, observed);
    }
    observed.recordCount += 1;
    const anomaly = ordinalAnomaly(observed.lastOrdinal, item);
    if (anomaly) this.anomalies[anomaly] += 1;
    if (Number.isSafeInteger(item?.ordinal) && item.ordinal >= 0) {
      if (observed.firstOrdinal === null) observed.firstOrdinal = item.ordinal;
      observed.lastOrdinal = item.ordinal;
    }
    this.outerCounts[projectedRecord.outer] += 1;
    observed.outerClassifications[projectedRecord.outer] += 1;
    if (projectedRecord.unknownOuter) this.anomalies.unknown_outer_record_type += 1;
    if (projectedRecord.unknownInner) this.anomalies.unknown_inner_type += 1;
    for (const unit of projectedRecord.units) {
      if (!unit.countInCoverage) continue;
      if (unit.eventType || unit.replacementHistory) this.coverageUnits.push(unit);
      else this.observeCoverageUnit(unit);
    }
  }

  finish() {
    if (this.finished) throw new TypeError("Coverage ledger was finalized more than once");
    this.finished = true;
    for (const unit of this.coverageUnits) this.observeCoverageUnit(unit);
    const innerCounts = this.innerCounts;
    const callCounts = this.callCounts;
    const outputCounts = this.outputCounts;

    const toolLinkage = {
      MATCHED: 0,
      NO_CALL_ID_PRESENT: 0,
      EMPTY_CALL_ID: 0,
      UNMATCHED: 0,
      AMBIGUOUS_CALL_ID: 0,
      SCHEMA_INVALID_CALL_ID: 0,
    };
    for (const linkage of this.toolOutputLinkages) {
      let status = linkage.status;
      if (status === "PENDING") {
        const calls = callCounts.get(linkage.id) || 0;
        const outputs = outputCounts.get(linkage.id) || 0;
        status = calls === 1 && outputs === 1 ? "MATCHED" : calls === 0 ? "UNMATCHED" : "AMBIGUOUS_CALL_ID";
      }
      toolLinkage[status] += 1;
      if (status === "NO_CALL_ID_PRESENT") this.anomalies.tool_output_no_call_id_present += 1;
      else if (status === "EMPTY_CALL_ID") this.anomalies.tool_output_empty_call_id += 1;
      else if (status === "SCHEMA_INVALID_CALL_ID") this.anomalies.tool_output_invalid_call_id += 1;
      else if (status === "UNMATCHED") this.anomalies.tool_output_unmatched_call_id += 1;
      else if (status === "AMBIGUOUS_CALL_ID") this.anomalies.tool_output_ambiguous_call_id += 1;
    }

    const outerTotal = Object.values(this.outerCounts).reduce((sum, value) => sum + value, 0);
    const innerTotal = Object.values(innerCounts).reduce((sum, value) => sum + value, 0);
    const readingStatus = !this.readingViewEnabled
      ? "NOT_GENERATED"
      : (innerCounts.UNKNOWN_RAW_ONLY || innerCounts.SCHEMA_INVALID_RAW_ONLY || this.outerCounts.SCHEMA_INVALID_RECORD)
        ? "INDETERMINATE"
        : innerCounts.KNOWN_CONTENT_RAW_ONLY
          ? "PARTIAL"
          : "ACCOUNTED_FOR";
    const gaps = [...this.semanticGaps.values()].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    const physicalReadRanges = Object.freeze([...this.sources.values()].map((source) => Object.freeze({ ...source })));
    this.coverageUnits.length = 0;
    this.toolOutputLinkages.length = 0;
    this.callCounts.clear();
    this.outputCounts.clear();
    this.semanticGaps.clear();
    this.sources.clear();
    return Object.freeze({
      outer_records: Object.freeze({ total: outerTotal, classifications: Object.freeze({ ...this.outerCounts }) }),
      inner_units: Object.freeze({ total: innerTotal, dispositions: Object.freeze({ ...innerCounts }) }),
      anomalies: Object.freeze({ ...this.anomalies }),
      tool_output_linkage: Object.freeze(toolLinkage),
      reading_view_status: readingStatus,
      physical_read_ranges: physicalReadRanges,
      ...(gaps.length ? { semantic_gaps: Object.freeze(gaps.map((entry) => Object.freeze({ ...entry }))) } : {}),
    });
  }
}

export function assertCoverageInvariants(coverage) {
  if (!coverage || typeof coverage !== "object" || !Array.isArray(coverage.logical_threads) || !Array.isArray(coverage.physical_sources)) throw new TypeError("Coverage root is invalid");
  const exactKeys = (value, names) => safeObject(value)
    && Object.keys(value).length === names.length
    && names.every((name) => Object.hasOwn(value, name));
  const sourceIds = new Set();
  for (const source of coverage.physical_sources) {
    if (typeof source?.source_id !== "string" || !source.source_id || sourceIds.has(source.source_id) || !Array.isArray(source.usages)) throw new TypeError("Coverage physical-source inventory is invalid");
    sourceIds.add(source.source_id);
    for (const usage of source.usages) {
      if (!Array.isArray(usage.read_ranges)) throw new TypeError("Coverage physical read ranges are invalid");
      for (const range of usage.read_ranges) {
        const outer = range?.outer_records;
        if (!outer || !exactKeys(outer.classifications, OUTER_CLASSIFICATIONS)) throw new TypeError("Coverage physical outer-record classifications are invalid");
        if (!Number.isSafeInteger(outer.total) || outer.total < 0 || !Number.isSafeInteger(range.record_count) || Object.values(outer.classifications).some((value) => !Number.isSafeInteger(value) || value < 0) || Object.values(outer.classifications).reduce((sum, value) => sum + value, 0) !== outer.total || range.record_count !== outer.total) throw new TypeError("Coverage physical outer-record invariant failed");
      }
    }
  }
  for (const thread of coverage.logical_threads) {
    const outer = thread?.outer_records;
    const inner = thread?.inner_units;
    if (!outer || !exactKeys(outer.classifications, OUTER_CLASSIFICATIONS)) throw new TypeError("Coverage outer-record classifications are invalid");
    if (!inner || !exactKeys(inner.dispositions, INNER_DISPOSITIONS)) throw new TypeError("Coverage inner-unit dispositions are invalid");
    if (!Number.isSafeInteger(outer.total) || outer.total < 0 || Object.values(outer.classifications).some((value) => !Number.isSafeInteger(value) || value < 0) || Object.values(outer.classifications).reduce((sum, value) => sum + value, 0) !== outer.total) throw new TypeError("Coverage outer-record invariant failed");
    if (!Number.isSafeInteger(inner.total) || inner.total < 0 || Object.values(inner.dispositions).some((value) => !Number.isSafeInteger(value) || value < 0) || Object.values(inner.dispositions).reduce((sum, value) => sum + value, 0) !== inner.total) throw new TypeError("Coverage inner-unit invariant failed");
    if (!Array.isArray(thread.physical_source_ids) || thread.physical_source_ids.some((id) => !sourceIds.has(id))) throw new TypeError("Coverage logical-thread source references are invalid");
    if (thread.semantic_gaps !== undefined) {
      if (!Array.isArray(thread.semantic_gaps)) throw new TypeError("Coverage semantic-gap evidence is invalid");
      let evidencedUnknown = 0;
      for (const entry of thread.semantic_gaps) {
        if (!safeObject(entry)
          || !INNER_DISPOSITIONS.includes(entry.disposition)
          || typeof entry.reason_code !== "string" || !entry.reason_code
          || typeof entry.structure_path !== "string" || !entry.structure_path
          || typeof entry.record_type !== "string" || !entry.record_type
          || typeof entry.inner_type !== "string"
          || !Number.isSafeInteger(entry.count) || entry.count <= 0) throw new TypeError("Coverage semantic-gap evidence is invalid");
        if (entry.disposition === "UNKNOWN_RAW_ONLY") evidencedUnknown += entry.count;
      }
      if (evidencedUnknown !== inner.dispositions.UNKNOWN_RAW_ONLY) throw new TypeError("Coverage unknown-unit evidence invariant failed");
    } else if (inner.dispositions.UNKNOWN_RAW_ONLY !== 0) {
      throw new TypeError("Coverage unknown-unit evidence is missing");
    }
  }
  return true;
}

export { INNER_DISPOSITIONS, OUTER_CLASSIFICATIONS };
