# Deduplicated asset store

Exporter 0.3.0 stores every unique decoded embedded attachment selected by the shared reading-view record policy once per export:

```text
assets/
├── <lowercase-sha256>.<validated-extension>
└── manifest.json
```

The SHA-256 covers decoded bytes only. The filename contains no user, title, session, source-path, declared-filename, or declared-MIME data. Assets are local to one export; the exporter does not use a global or cross-user cache and never downloads remote references.

## Type validation

The store retains at most 64 decoded header bytes and recognizes a narrow raster allowlist: PNG with a structurally valid signature and IHDR fields, JPEG with a known first segment whose declared extent fits the file, GIF87a/GIF89a with a non-zero logical screen, and WebP with consistent RIFF and VP8, VP8L, or VP8X chunk lengths. Recognized files use `.png`, `.jpg`, `.gif`, or `.webp`, their canonical image MIME type, and `renderable: true`.

Everything else—including truncated or manipulated signatures, SVG, HTML, declared-image MIME spoofing, and unknown binary data—is retained as `.bin`, `application/octet-stream`, and `renderable: false`. A declaration can be recorded as metadata, but it never controls the path, extension, or renderability. Invalid or unusually long declared MIME strings are omitted instead of being copied into the manifest.

## Manifest schema 2

`assets/manifest.json` is reproducible JSON with a final newline:

```json
{
  "schema_version": 2,
  "hash_algorithm": "sha256",
  "assets": []
}
```

Assets are sorted by SHA-256. Each entry records `sha256`, export-relative `path`, canonical `mime_type`, validated `extension`, `bytes`, `renderable`, and every retained `uses` occurrence. A use records `session_id`, record and attachment ordinals, role, record/content type, timestamp, classification, tool origin, reading disposition, mirror kind, and the canonical record/attachment ordinals. A bounded declared MIME plus mismatch flag remains optional.

`VISIBLE` uses are rendered. `ADDITIONAL_STORED_CONTEXT` uses are rendered only by profiles whose policy includes replacement history. `MIRRORED` uses point to one canonical occurrence and are not rendered again. `EXCLUDED` uses are recorded only when the same asset is retained through another visible provenance; an attachment whose only provenance is excluded is neither published nor listed. Uses remain in source order. They are never collapsed merely because decoded SHA-256 values match.

Schema 2 is an additive but explicitly versioned change from schema 1. Existing consumers that require `schema_version: 1` must be updated. Asset entry fields, content-addressed paths, hash meaning, type validation, and root archive format version 1 remain unchanged. The exporter accepts both schemas when safely validating a previous generation.

The root `manifest.json` points to `assets/manifest.json`, records the effective `include_tools`, `replacement_history_in_reading_views`, and `replacement_history_source_unchanged` values, and retains `asset_occurrences`, `unique_assets`, `unique_asset_bytes`, and `deduplicated_asset_bytes_saved`. Raw JSONL remains the canonical import source; assets and reading views are derived outputs.

## Reading-view selection and mirrors

One streamed projection policy drives asset publication, Markdown, responsive HTML, DOCX, and PDF. Coverage counts the same projected units; renderers do not inspect raw message or history subtrees as an alternative content source. With `include_tools: false`, tool-, browser-, and `view_image`-only attachments are excluded. With tools enabled, a browser/MCP event and function output render once through the canonical response record only when one unique nonempty call ID and deterministic content identity prove the mirror; timing, adjacency, position, or empty IDs are never sufficient. Direct user `response_item.message` plus its structurally verified `event_msg.user_message` mirror also render once. Equal bytes in independent turns remain independent visible uses.

The message container is the first attachment boundary. Only object messages with `type: "message"`, one of the exact roles `user`, `assistant`, `developer`, or `tool`, and array-valued `content` authorize immediate-child classification. An invalid container is opaque even when nested fields resemble otherwise valid attachments. Within a valid content array, the immediate semantic classification is the next boundary: known attachment parts may contribute descriptors; text parts, schema-invalid known parts, known Raw-only parts, unknown parts, and profile-suppressed parts are not recursively searched for reading-view assets. Their complete bytes remain available only through canonical Raw JSONL. If an excluded occurrence has the same decoded hash as an independently selected asset, schema 2 may retain its payload-free `EXCLUDED` provenance as described above, but that occurrence never authorizes publication by itself and is never referenced by a reading view.

`replacement_history` is a stored context snapshot, not an ordinary chat turn. Readable classifies unmatched occurrences as `REPLACEMENT_HISTORY_SUPPRESSED` and does not publish history-only assets. Complete retains them once in a labelled `Additional stored context` section; Source snapshots keep the same forensic behavior. Exact semantic copies are paired by role, ordered content identity, attachment source identity, and unambiguous occurrence order—not by asset hash alone. Multiple identical visible messages are paired only when the snapshot contains the complete ordered occurrence set. Source and Raw bytes remain unchanged for every profile.

## Publication and failure behavior

Before session streams are opened, the exporter creates two random probe files inside the selected output filesystem, publishes one exclusive hard link, verifies file identity and bytes, and removes both. Unsupported or unsafe targets fail before session processing. There is no copy, rename-overwrite, or filesystem-specific fallback.

Decoded blocks are awaited and written to exclusive files inside `assets/.staging-*`. A record publishes an asset only after `record_end`. For reconstructed history chains, staging and commit use the canonical logical record ordinal while retaining the physical source record identity separately; repeated records are not skipped merely because their outer type is metadata. Descriptor count, size, SHA-256, media type, source kind, and selected attachment ordinals remain strict. Publication uses an exclusive hard link. A pre-existing authorized target is reopened and checked for regular-file identity, exact size, SHA-256, and validated type; a mismatch or concurrent target fails closed. Run cleanup removes only files whose filesystem identity proves current-run ownership.

For profiles that read a session more than once, the asset, metadata, and Markdown passes independently hash their complete input. A cross-pass content mismatch aborts the generation before either manifest can describe it as complete.

`assets/manifest.json` is generated only after all records, files, usages, and final asset revalidation succeed. `EXPORT_INCOMPLETE.txt` still governs the whole archive generation: while it exists, neither root nor asset manifests make the export complete.

Markdown uses document-relative POSIX paths. HTML uses export-root-relative POSIX paths. Renderable selected assets use image markup; non-renderable files use ordinary local links. Neither format embeds Base64, emits absolute or `file:` asset paths, or substitutes remote content.

The complete use list necessarily grows linearly with the number of attachment occurrences, but each use is a fixed, payload-free record. Decode, header, and write blocks remain bounded independently of attachment size.
