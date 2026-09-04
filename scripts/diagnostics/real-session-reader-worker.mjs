#!/usr/bin/env node
import { createHash, createHmac } from "node:crypto";
import { performance } from "node:perf_hooks";

import { readSessionMeta } from "../../bin/export-codex-project-chats.mjs";
import { SESSION_READER_IMPLEMENTATION } from "../../lib/session-record-reader.mjs";

const implementation = process.argv[2];
const sourcePath = process.argv[3];
const privacyKey = process.argv[4];
if (!Object.values(SESSION_READER_IMPLEMENTATION).includes(implementation) || !sourcePath || !privacyKey) throw new Error("Expected a reader implementation, source path, and ephemeral privacy key");

let peakRss = 0;
let peakHeap = 0;
function sampleMemory() {
  const memory = process.memoryUsage();
  peakRss = Math.max(peakRss, memory.rss);
  peakHeap = Math.max(peakHeap, memory.heapUsed);
}

function digestJson(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function privacyToken(value) {
  return createHmac("sha256", privacyKey).update(String(value)).digest("hex");
}

function classificationEntries(value) {
  return [...(value?.classifications || new Map()).entries()].map(([recordNumber, classification]) => [recordNumber, classification]);
}

const started = performance.now();
sampleMemory();
const sampler = setInterval(sampleMemory, 10);
try {
  const meta = await readSessionMeta(sourcePath, {
    calculateSha256: true,
    collectAttachmentMetrics: true,
    readerImplementation: implementation,
  });
  sampleMemory();
  const analysis = meta.eventAnalysis || {};
  const attachmentHashes = [...(meta.attachmentMetrics?.embeddedHashes || new Set())].sort();
  const semanticFingerprint = digestJson({
    id: meta.id,
    session_id: meta.session_id,
    idSource: meta.idSource,
    metadataId: meta.metadataId,
    metadataIdMismatch: meta.metadataIdMismatch,
    cwd: meta.cwd,
    timestamp: meta.timestamp,
    source: meta.source,
    threadSource: meta.threadSource,
    parentThreadId: meta.parentThreadId,
    model: meta.model,
    firstUserText: meta.firstUserText,
    firstCwdText: meta.firstCwdText,
    latestTimestamp: meta.latestTimestamp,
    sessionKind: meta.sessionKind,
    eventAnalysis: {
      classifications: classificationEntries(analysis),
      directUserMessages: analysis.directUserMessages,
      firstDirectUserText: analysis.firstDirectUserText,
      nonDirectTitleCandidates: analysis.nonDirectTitleCandidates,
      runtimeContexts: analysis.runtimeContexts,
      sessionKind: analysis.sessionKind,
      subagentInputs: analysis.subagentInputs,
      unclassifiedUserRoleRecords: analysis.unclassifiedUserRoleRecords,
    },
    attachmentMetrics: {
      embeddedCount: meta.attachmentMetrics?.embeddedCount || 0,
      embeddedBytes: meta.attachmentMetrics?.embeddedBytes || 0,
      dataUrlCount: meta.attachmentMetrics?.dataUrlCount || 0,
      dataUrlBytes: meta.attachmentMetrics?.dataUrlBytes || 0,
      unprefixedEmbeddedCount: meta.attachmentMetrics?.unprefixedEmbeddedCount || 0,
      unprefixedEmbeddedBytes: meta.attachmentMetrics?.unprefixedEmbeddedBytes || 0,
      localReferenceCount: meta.attachmentMetrics?.localReferenceCount || 0,
      remoteReferenceCount: meta.attachmentMetrics?.remoteReferenceCount || 0,
      unknownCount: meta.attachmentMetrics?.unknownCount || 0,
      referencedCount: meta.attachmentMetrics?.referencedCount || 0,
      referencedKnownBytes: meta.attachmentMetrics?.referencedKnownBytes || 0,
      referencedUnknownSizeCount: meta.attachmentMetrics?.referencedUnknownSizeCount || 0,
      attachmentHashes,
    },
  });
  console.log(JSON.stringify({
    status: "COMPLETED",
    implementation,
    records: meta.parsedEventCount,
    non_empty_lines: meta.jsonlLineCount,
    invalid_records: meta.invalidJsonLines,
    attachments: meta.attachmentMetrics?.embeddedCount || 0,
    attachment_bytes: meta.attachmentMetrics?.embeddedBytes || 0,
    attachment_tokens: attachmentHashes.map(privacyToken),
    attachment_sequence_token: privacyToken(meta.attachmentMetrics?.embeddedSequenceSha256 || ""),
    raw_bytes: meta.fileReadAfterSizeBytes,
    raw_token: privacyToken(meta.fileSha256),
    semantic_token: privacyToken(semanticFingerprint),
    runtime_ms: Math.round((performance.now() - started) * 1000) / 1000,
    peak_rss_bytes: Math.max(peakRss, process.resourceUsage().maxRSS * 1024),
    peak_heap_bytes: peakHeap,
  }));
} catch (error) {
  sampleMemory();
  console.log(JSON.stringify({
    status: "FAILED",
    implementation,
    error_code: error?.code || "UNKNOWN",
    error_record: Number.isSafeInteger(error?.recordNumber) ? error.recordNumber : null,
    runtime_ms: Math.round((performance.now() - started) * 1000) / 1000,
    peak_rss_bytes: Math.max(peakRss, process.resourceUsage().maxRSS * 1024),
    peak_heap_bytes: peakHeap,
  }));
} finally {
  clearInterval(sampler);
}
