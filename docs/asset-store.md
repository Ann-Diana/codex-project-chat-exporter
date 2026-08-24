# Deduplicated asset store

Exporter 0.3.0 stores every unique decoded embedded attachment once per export:

```text
assets/
├── <lowercase-sha256>.<validated-extension>
└── manifest.json
```

The SHA-256 covers decoded bytes only. The filename contains no user, title, session, source-path, declared-filename, or declared-MIME data. Assets are local to one export; the exporter does not use a global or cross-user cache and never downloads remote references.

## Type validation

The store retains at most 64 decoded header bytes and recognizes a narrow raster allowlist: PNG with a structurally valid signature and IHDR fields, JPEG with a known first segment whose declared extent fits the file, GIF87a/GIF89a with a non-zero logical screen, and WebP with consistent RIFF and VP8, VP8L, or VP8X chunk lengths. Recognized files use `.png`, `.jpg`, `.gif`, or `.webp`, their canonical image MIME type, and `renderable: true`.

Everything else—including truncated or manipulated signatures, SVG, HTML, declared-image MIME spoofing, and unknown binary data—is retained as `.bin`, `application/octet-stream`, and `renderable: false`. A declaration can be recorded as metadata, but it never controls the path, extension, or renderability. Invalid or unusually long declared MIME strings are omitted instead of being copied into the manifest.

## Manifest schema 1

`assets/manifest.json` is reproducible JSON with a final newline:

```json
{
  "schema_version": 1,
  "hash_algorithm": "sha256",
  "assets": []
}
```

Assets are sorted by SHA-256. Each entry records `sha256`, export-relative `path`, canonical `mime_type`, validated `extension`, `bytes`, `renderable`, and every `uses` occurrence. Uses remain in export order and contain only `session_id`, `record_ordinal`, `attachment_ordinal`, and, when valid and applicable, `declared_mime` plus `mime_mismatch`. Duplicate occurrences are deliberately not collapsed. The manifest contains no paths to source files, titles, prompts, content, Base64 fragments, or hashes other than the required asset SHA-256 values.

The root `manifest.json` points to `assets/manifest.json` and records `asset_occurrences`, `unique_assets`, `unique_asset_bytes`, and `deduplicated_asset_bytes_saved`. Raw JSONL remains the canonical import source; assets and reading views are derived outputs.

## Publication and failure behavior

Before session streams are opened, the exporter creates two random probe files inside the selected output filesystem, publishes one exclusive hard link, verifies file identity and bytes, and removes both. Unsupported or unsafe targets fail before session processing. There is no copy, rename-overwrite, or filesystem-specific fallback.

Decoded blocks are awaited and written to exclusive files inside `assets/.staging-*`. A record publishes an asset only after `record_end`. Publication uses an exclusive hard link. A pre-existing authorized target is reopened and checked for regular-file identity, exact size, SHA-256, and validated type; a mismatch or concurrent target fails closed. Run cleanup removes only files whose filesystem identity proves current-run ownership.

For profiles that read a session more than once, the asset, metadata, and Markdown passes independently hash their complete input. A cross-pass content mismatch aborts the generation before either manifest can describe it as complete.

`assets/manifest.json` is generated only after all records, files, usages, and final asset revalidation succeed. `EXPORT_INCOMPLETE.txt` still governs the whole archive generation: while it exists, neither root nor asset manifests make the export complete.

Markdown uses document-relative POSIX paths. HTML uses export-root-relative POSIX paths. Renderable assets use image markup; non-renderable files use ordinary local links. Neither format embeds Base64, emits absolute or `file:` asset paths, or substitutes remote content.

The complete use list necessarily grows linearly with the number of attachment occurrences, but each use is a fixed, payload-free record. Decode, header, and write blocks remain bounded independently of attachment size.
