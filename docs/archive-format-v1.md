# Codex Project Chat Exporter archive format version 1

This document specifies archive format version 1 independently of the exporter or extension product version. It describes preservation and reading-view semantics; it does not define a working Codex import format.

## Representation model

An export can contain:

- canonical raw JSONL snapshots in `raw/`;
- classified Markdown reading views in `md/` or `markdown/`;
- deduplicated decoded embedded attachments and their usage manifest in `assets/`;
- `index.html` and `index.md` for navigation;
- `manifest.json` for export and source-mapping metadata;
- `README.txt` with a local summary.

When raw export is enabled, each raw JSONL file is a byte-identical snapshot of the source bytes accepted during the export. Raw JSONL is the canonical lossless representation. Markdown and HTML are derived reading views and do not represent every raw event.

When raw export is disabled, the export contains no new canonical session bytes. The manifest still identifies `raw_jsonl` as the canonical representation type but marks each omitted snapshot explicitly.

## Generation completion marker

`EXPORT_INCOMPLETE.txt` invalidates the entire export generation while it exists. In that state, `manifest.json`, `assets/manifest.json`, `index.html`, and `index.md` are not valid descriptions or reading views of the current files, even if they are present and individually well formed.

The exporter creates the marker before changing files from an existing generation. It publishes and verifies the new manifest before removing the run-owned marker. Marker removal is the generation commit point. A failed or interrupted export leaves the marker in place; it does not claim that the previous generation was restored.

A verifier or future importer must check for `EXPORT_INCOMPLETE.txt` before reading `manifest.json` and must reject the export when the marker exists. The marker contains only a fixed status explanation and no session content or local paths.

The manifest describes archive membership and source mapping. It is not an authenticated ownership record and never authorizes destructive filesystem cleanup. Files from older exports or unknown files in a reused output folder can remain; a differing pre-existing file at a required path causes the new generation to fail closed.

## Manifest header

`manifest.json` uses:

```json
{
  "archive_format_version": 1,
  "canonical_representation": "raw_jsonl",
  "canonical_representation_included": true,
  "export_profile": "complete",
  "formats": { "raw": true, "markdown": true, "html": true, "docx": false, "pdf": false, "attachments": true },
  "assets_manifest": "assets/manifest.json",
  "include_tools": false,
  "replacement_history_in_reading_views": false,
  "replacement_history_source_unchanged": true,
  "asset_occurrences": 2,
  "unique_assets": 1,
  "unique_asset_bytes": 68
}
```

Relevant top-level fields include:

- `archive_format_version`: currently `1`.
- `canonical_representation`: currently `raw_jsonl`.
- `canonical_representation_included`: whether this export contains the canonical Raw JSONL snapshots.
- `export_profile`: `complete`, `readable`, or `source-snapshots`.
- `formats`: explicit format flags. Deduplicated embedded attachments are always enabled; `docx` or `pdf` is true only after its explicit format selection.
- `generated_at`: export timestamp.
- `codex_home`, `sessions_dir`, `archived_sessions_dir`, and `session_index`: local diagnostic paths.
- `path_style`: `short` or `readable`.
- `assets_manifest`: the canonical export-relative `assets/manifest.json` path.
- `include_tools`: the effective tool-record selection used by all derived reading views.
- `replacement_history_in_reading_views`: whether `replacement_history` may contribute the labelled `Additional stored context` area. It is `false` for Readable and `true` for Complete and Source snapshots.
- `replacement_history_source_unchanged`: always `true`; profile filtering changes only derived views and selected derived assets, never source or Raw JSONL bytes.
- `asset_occurrences`, `unique_assets`, and `unique_asset_bytes`: aggregate decoded-asset counts and unique-byte volume. `deduplicated_asset_bytes_saved` additionally reports repeated occurrence bytes not stored again.
- `sessions`: ordered exported-session metadata.

Top-level absolute paths are local diagnostics. They are not needed to reconstruct the portable source mapping and are not share-safe.

The version-1 root manifest has an open, forward-compatible content model. A consumer that supports `archive_format_version: 1` must ignore unknown top-level fields while continuing to validate every field it uses for format selection, path authorization, integrity, or source mapping. Producers may add optional root metadata without changing the archive-format version only when it does not alter the meaning or required validation of existing fields. Consumers are not required to preserve unknown fields when writing a new generation. An incompatible semantic or structural change requires a new `archive_format_version`.

This rule applies only to additive fields in the root `manifest.json`. It does not relax the separately versioned and deliberately strict `assets/manifest.json` schema, and an unknown root field never authorizes an additional archive path.

## Asset manifest schema 2

Every profile includes `assets/manifest.json`, even when no embedded attachments occur. Its stable header is:

```json
{
  "schema_version": 2,
  "hash_algorithm": "sha256",
  "assets": []
}
```

Each selected unique decoded byte sequence appears once as `assets/<lowercase-sha256>.<validated-extension>`. The asset entry records the SHA-256, path, canonical MIME type, validated extension, byte count, renderability, and every retained ordered use. Uses include role, record/content type, timestamp, classification, tool origin, reading disposition, and canonical/mirror ordinals in addition to the schema-1 identity and optional MIME fields. Equal bytes in different genuine turns remain separate uses; only structurally proven mirrors share a canonical occurrence.

Schema 2 preserves the schema-1 asset-entry and path contract but is an explicit consumer compatibility boundary. Consumers that require version 1 must add schema-2 handling. Root `archive_format_version` remains 1 because Raw/session layout and canonical restore semantics are unchanged; the exporter accepts prior asset schema 1 during safe replacement validation.

PNG, JPEG, GIF, and WebP require bounded decoded-header validation. Other bytes, SVG, HTML, truncated signatures, and MIME spoofing are retained as non-renderable `.bin` with `application/octet-stream`. Declared MIME never determines a filename or renderability. Local and remote references are not copied or downloaded.

The exporter probes exclusive hard-link publication inside the target filesystem before opening session streams. Asset files are never overwritten. An authorized existing target is reused only after regular-file, identity, size, SHA-256, and validated-type checks. `assets/manifest.json` is published only after all records, assets, uses, and final validations succeed. See [the asset-store contract](asset-store.md) for the complete publication and cleanup rules.

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
4. atomically publishes the temporary file at its final Raw path;
5. hashes that published Raw path once with SHA-256, or calculates the same hash during the required snapshot parse;
6. compares that hash with the stable source hash collected during routing or a conservative source-hash fallback;
7. checks size and modification time before and after verification as additional change indicators.

The exporter retries an unstable source up to three times. A persistent change produces `SOURCE_CHANGED_DURING_EXPORT`; a locked or inaccessible source produces `SOURCE_SNAPSHOT_LOCKED`; other copy failures produce `SOURCE_SNAPSHOT_FAILED`. The affected export run fails rather than recording an unverified Raw copy as verified at export.

For an included Raw snapshot checked at export time:

- `snapshot_status` is `STABLE`;
- `raw_copy_status` is `VERIFIED_AT_EXPORT`;
- `raw_verified_at` is the ISO-8601 time of that successful export-time check;
- `raw_sha256` is the expected SHA-256 of the bytes checked at that time;
- `raw_size_bytes` is the exported size;
- the before/after source size and modification-time fields are populated.

For raw-disabled output:

- `snapshot_status` is `NOT_INCLUDED`;
- `raw_copy_status` is `NOT_INCLUDED`;
- `raw_verified_at` is `null`;
- `raw_sha256` is empty;
- raw size and source-copy fields are `null`.

In concrete manifest form, omitted Raw data uses `snapshot_status: "NOT_INCLUDED"`, `raw_copy_status: "NOT_INCLUDED"`, `raw_verified_at: null`, and `raw_sha256: ""`.

`STABLE` describes only the source observed during the snapshot operation. `raw_verified_at` records when the export-time hash check completed; `VERIFIED_AT_EXPORT` states that the bytes read from the published Raw path matched `raw_sha256` during that check, not that integrity continues afterward. Raw files remain mutable; size and modification time are change indicators, not cryptographic proof. `raw_sha256` allows a later consumer to hash the current Raw file again and detect a mismatch.

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

Attachments follow the same record selection. Verified user-event and browser/tool-result mirrors render once. Readable suppresses every `replacement_history` occurrence from Markdown, HTML, DOCX, and PDF, including history-only assets. Complete retains unmatched history images once in a labelled `Additional stored context` section rather than as ordinary turns. Source snapshots preserve their existing forensic stored-context behavior. Source and Raw JSONL bytes are never changed by this policy.

Reasoning, internal events, invalid JSON lines, and other event types remain available only in raw JSONL unless separately rendered. Markdown masking is best effort and does not make the view safe to share.

`index.html` and, where present, `index.md` provide metadata navigation. Complete and Readable HTML indexes filter project, title, date, model, and storage status; they are not transcript full-text search engines.

When DOCX is selected, each session manifest entry includes one `docx_file` export-relative path and the indexes link to that per-session document. DOCX is a classified derived view based on the shared document contract; it is never canonical and never combines sessions. PNG/JPEG media may be embedded, while conservative attachment references represent GIF, WebP, `.bin`, missing rendering support, or blocked local links. Controlled HTTP/HTTPS hyperlink relationships are allowed; external image/media/resource relationships and active content are forbidden, and no remote target is fetched.

When PDF is selected, each session entry similarly includes one `pdf_file` path. PDF is rendered directly from the same common document contract, not through DOCX. It embeds repository-local hash-verified fonts and PNG/JPEG assets, uses attachment references for GIF/WebP/`.bin`, and permits only controlled HTTP/HTTPS URI actions. File, launch, JavaScript, forms, embedded files, external images, and remote retrieval are forbidden.

Without DOCX or PDF selection, the `source-snapshots` profile intentionally omits Markdown transcripts and `index.md`. Its reduced HTML metadata index links to Raw snapshots checked at export time and to assets selected by the same streamed reading policy; classification-derived session counters remain `null`. Selecting DOCX or PDF explicitly adds the per-session document pass, populated counters, document links, and the corresponding full metadata index while still omitting Markdown.

## Import boundary

Version 1 prepares portable preservation metadata but implements no import command and has no validated Codex roundtrip. It does not promise reconstruction of Codex UI state, indexes, project registration, sidebar history, Codex-native attachment registration, or future compatibility with Codex's internal format.

A future importer must reject any generation containing `EXPORT_INCOMPLETE.txt` before reading its manifest. For a completed generation, it must use canonical raw JSONL and validated manifest mapping, hash every current Raw file again, compare that digest with `raw_sha256`, and reject any mismatch before consuming the file. It must also avoid overwriting an existing local session unless a separately designed, explicit conflict policy proves that action safe. Markdown or HTML alone is insufficient. Neither the format version, a stored hash, nor portable source mapping establishes import capability, permanent tamper resistance, sealing, or restore readiness.

## Privacy boundary

Raw JSONL, Markdown, HTML, DOCX, PDF, both manifests, and decoded files below `assets/` can contain confidential chats, local paths, runtime contexts, tool data, source code, identifiers, and attachment data or references. Absolute diagnostic paths must be removed from any separately designed share-safe derivative. No current export format should be published without manual privacy review.
