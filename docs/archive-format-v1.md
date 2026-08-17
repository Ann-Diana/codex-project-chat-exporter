# Codex Project Chat Exporter archive format version 1

This document specifies the current local export representation produced by Codex Project Chat Exporter 0.1.0. It describes preservation and reading-view semantics; it does not define a working Codex import format.

## Representation model

An export can contain:

- canonical raw JSONL snapshots in `raw/`;
- classified Markdown reading views in `md/` or `markdown/`;
- `index.html` and `index.md` for navigation;
- `manifest.json` for export and source-mapping metadata;
- `README.txt` with a local summary.

When raw export is enabled, each raw JSONL file is a byte-identical snapshot of the source bytes accepted during the export. Raw JSONL is the canonical lossless representation. Markdown and HTML are derived reading views and do not represent every raw event.

When raw export is disabled, the export contains no new canonical session bytes. The manifest still identifies `raw_jsonl` as the canonical representation type but marks each omitted snapshot explicitly.

## Manifest header

`manifest.json` uses:

```json
{
  "archive_format_version": 1,
  "canonical_representation": "raw_jsonl",
  "canonical_representation_included": true,
  "export_profile": "complete",
  "formats": { "raw": true, "markdown": true, "html": true, "docx": false, "pdf": false, "attachments": false }
}
```

Relevant top-level fields include:

- `archive_format_version`: currently `1`.
- `canonical_representation`: currently `raw_jsonl`.
- `canonical_representation_included`: whether this export contains the canonical Raw JSONL snapshots.
- `export_profile`: `complete`, `readable`, or `source-snapshots`.
- `formats`: explicit current and reserved format flags. Word, PDF, and extracted attachments remain false and are not selectable.
- `generated_at`: export timestamp.
- `codex_home`, `sessions_dir`, `archived_sessions_dir`, and `session_index`: local diagnostic paths.
- `path_style`: `short` or `readable`.
- `sessions`: ordered exported-session metadata.

Top-level absolute paths are local diagnostics. They are not needed to reconstruct the portable source mapping and are not share-safe.

## Portable source mapping

Each session entry records:

- `session_id` and `storage` (`active` or `archived`);
- `source_root` (`sessions` or `archived_sessions`);
- a validated forward-slash `source_relative_path` beneath that root;
- `source_original_filename`;
- a collision-safe `raw_export_file` and `raw_export_name` when raw data is included;
- the local absolute `source_jsonl` path for diagnostics.

Portable tooling should use `source_root` plus `source_relative_path`. It must not require the original absolute path. The relative path is rejected if it is absolute, escapes its declared root, or does not end with the recorded original filename.

Export filenames may differ from source basenames. Short-path output uses compact session codes; readable output keeps the original basename behind a collision-safe session prefix.

## Snapshot integrity

Before finalizing a raw snapshot, the exporter:

1. records source size and modification time;
2. copies the source to a temporary file;
3. records source size and modification time again;
4. hashes the temporary exported bytes with SHA-256;
5. hashes the source bytes;
6. checks source size and modification time once more after hashing;
7. publishes the temporary file only when metadata stayed stable and both hashes match.

The exporter retries an unstable source up to three times. A persistent change produces `SOURCE_CHANGED_DURING_EXPORT`; a locked or inaccessible source produces `SOURCE_SNAPSHOT_LOCKED`; other copy failures produce `SOURCE_SNAPSHOT_FAILED`. The affected export run fails rather than publishing an unverified raw snapshot as stable.

For an included and verified raw snapshot:

- `snapshot_status` is `STABLE`;
- `raw_integrity_verified` is `true`;
- `raw_sha256` is the SHA-256 of the exported bytes;
- `raw_size_bytes` is the exported size;
- the before/after source size and modification-time fields are populated.

For raw-disabled output:

- `snapshot_status` is `NOT_INCLUDED`;
- `raw_integrity_verified` is `false`;
- `raw_sha256` is empty;
- raw size and source-copy fields are `null`.

`STABLE` describes only the accepted snapshot at copy time. An active source can be appended to after export. A later hash mismatch against the live source does not invalidate the exported snapshot if the source metadata changed after the recorded copy.

## JSONL counts and order

Event order is the physical line order inside the canonical raw JSONL file. The manifest does not duplicate that sequence.

Per-session counts are:

- `jsonl_line_count`: non-empty JSONL lines observed by the parser;
- `parsed_event_count`: non-empty lines successfully parsed as JSON;
- `invalid_jsonl_line_count`: non-empty lines that failed JSON parsing.

Invalid lines remain present in raw JSONL even though derived views cannot render them as parsed events.

## Session identity and deduplication

The exporter uses `session_meta.payload.id` when available and can recover a standard session ID from a `rollout-...-<id>.jsonl` filename when metadata is incomplete.

If active and archived files have the same session ID, one logical session is exported and the active file takes precedence. Different IDs are not merged merely because titles or contents match.

The manifest preserves the session ID, active/archived source classification, source mapping, original filename, raw hash, and physical raw line order required for later tooling.

## User-role classification

The parser separates:

- `DIRECT_USER_TURN`: a confirmed direct user turn in a direct-user session;
- `SUBAGENT_INPUT`: a confirmed subagent input / parent-agent handoff;
- `AUTOMATIC_RUNTIME_CONTEXT`: an unpaired user-role record structurally associated with a turn that also contains a confirmed input;
- `UNCLASSIFIED_USER_ROLE_RECORD`: a user-role record whose role cannot be established safely.

Subagent inputs are not counted as direct human user turns. Runtime-context labels can identify bounded AGENTS, plugin, or environment markers, but text keywords alone do not promote an arbitrary record to a trusted classification.

Classification affects only derived metadata and reading-view labels. It never deletes or rewrites raw JSONL events.

## Mirrored user-event pairing

Observed direct inputs can appear twice in the source event stream: once as `response_item.message` with role `user`, followed by `event_msg.user_message`. The classifier pairs them only when all required structural checks pass:

1. the records are directly adjacent parsed events;
2. the `event_msg.user_message` follows within 0 to 100 milliseconds;
3. its message exactly equals the canonical `input_text` representation;
4. image-bound wrapper text immediately surrounding an `input_image` is excluded structurally, not by broad text removal;
5. attachment references match exactly, in order, and in count.

A turn ID is not required because the observed `event_msg.user_message` representation does not carry one. Adjacency and timing alone are insufficient: text and attachment identity must also match.

For local images, an embedded data URL and a local path are different representations and do not prove the same attachment identity. Equal attachment counts alone never establish a pair. If identity cannot be proven, the user-role record remains fully preserved in raw JSONL and appears as `UNCLASSIFIED_USER_ROLE_RECORD` in the reading view.

Repeated confirmed messages are not deduplicated by content. Each independently confirmed adjacent pair remains a separate turn.

## Fail-safe behavior

The classifier fails closed:

- different adjacent text is not paired;
- events outside the 100-millisecond window are not paired;
- different or structurally incomparable attachments are not paired;
- unknown session kinds do not become direct-user sessions merely because a user-role event exists;
- a rejected mirror candidate cannot fall back to automatic runtime context solely because another confirmed record shares its turn ID;
- uncertain records remain visible as unclassified rather than being silently removed.

The classification model is best effort for currently observed Codex event structures. Future source-format changes can produce additional unclassified records without causing raw data loss.

## Display titles

`display_title` is an export label, not session identity. The exporter checks a `session_index.jsonl` title but rejects it when it matches a classified technical context or a known technical-context title. It otherwise uses the first confirmed direct user turn or a neutral deterministic fallback.

Title changes do not modify the session ID, source mapping, raw filename mapping, or raw bytes.

## Derived reading views

Markdown includes:

- non-empty confirmed direct-user text;
- non-empty assistant message text;
- labelled subagent inputs, runtime contexts, and unclassified user-role records;
- tool calls and tool outputs only when explicitly enabled.

Reasoning, internal events, invalid JSON lines, and other event types remain available only in raw JSONL unless separately rendered. Markdown masking is best effort and does not make the view safe to share.

`index.html` and `index.md` provide metadata navigation. The HTML index filters project, title, date, model, and storage status; it is not a transcript full-text search engine.

The `source-snapshots` profile intentionally omits Markdown transcripts and `index.md`. Its HTML metadata index links only to verified Raw snapshots and does not imply that event classification was performed; classification-derived counters are `null` in that profile.

## Import boundary

Version 1 prepares portable preservation metadata but implements no import command and has no validated Codex roundtrip. It does not promise reconstruction of Codex UI state, indexes, project registration, sidebar history, attachment files, or future compatibility with Codex's internal format.

A future importer must use canonical raw JSONL and validated manifest mapping. Markdown or HTML alone is insufficient.

## Privacy boundary

Raw JSONL, Markdown, HTML, and `manifest.json` can contain confidential chats, local paths, runtime contexts, tool data, source code, identifiers, and attachment data or references. Absolute diagnostic paths must be removed from any separately designed share-safe derivative. No current export format should be published without manual privacy review.
