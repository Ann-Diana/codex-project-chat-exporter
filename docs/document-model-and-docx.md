# Shared document model and DOCX export

Exporter 0.3.0 can add one DOCX reading view per exported session. DOCX is opt-in and never combines multiple sessions into one document.

## Selection

Add DOCX to any CLI profile with:

```powershell
node .\bin\export-codex-project-chats.mjs --all --profile readable --format docx --out C:\cx\codex-export
```

The shared JavaScript API uses `documentFormats: ["docx"]`. The VS Code adapter exposes the same selection as **Add DOCX** after scope and profile selection. Omitting the selection leaves every existing profile unchanged. PDF is a separate direct renderer described in `document-model-and-pdf.md`; DOCX is never used as its intermediate format.

## Document contract

`lib/document-model.mjs` defines the exporter-independent session-document contract. A header contains a title, a stable session origin, and limited project, storage, timestamp, model, and optional Raw-reference metadata. Each message contains:

- a stable session ID and physical JSONL record ordinal;
- an explicit role: `USER`, `ASSISTANT`, `SUBAGENT`, `RUNTIME_CONTEXT`, `UNCLASSIFIED`, or `TOOL`;
- ordered paragraphs, headings, lists, links, and code blocks;
- local attachment references with stable attachment ordinals and hashes.

The contract does not contain complete Raw events. The exporter processes sessions sequentially and builds at most one derived session document at a time. Markdown and DOCX are fed from the same session-record pass, so enabling DOCX does not add another complete JSONL scan.

## DOCX behavior

DOCX files follow the session-relative naming used by the other reading views:

```text
docx/<project-directory>/<session-name>.docx
```

PNG and JPEG assets are embedded. Repeated uses of identical content share one OOXML media part. GIF, WebP, and `.bin` assets remain clearly labelled attachment references because the exporter does not convert images and does not claim reliable native Word rendering for those formats. Images preserve validated dimensions, fit within a 600 by 700 pixel layout box, and include alternative text tied to the source record.

Valid, bounded `http:` and `https:` targets become real OOXML hyperlinks whose visible text contains the label and canonical target. Surrounding text and punctuation remain ordinary runs. Invalid, overlong, local, UNC/device, `file:`, `javascript:`, `data:`, and other unsupported targets remain labelled, non-clickable text. Creating or opening a DOCX never downloads the target.

The package validator permits only explicit external HTTP/HTTPS hyperlink relationships from `word/document.xml`, verifies every `w:hyperlink` relationship-ID mapping, and rejects external image/media/resource relationships, active content, embedded objects, macros, path traversal, missing media targets, malformed XML, and unexpected package paths. Local assets are rehashed immediately before packaging; missing or changed assets fail the document instead of being silently omitted.

## Reproducibility and publication

`docx` 9.7.1 creates the OOXML structure. `jszip` 3.10.1 normalizes every ZIP timestamp, deterministic entry order, compression settings, hyperlink relationship IDs, and the generated core-property timestamps. Large images are inserted through deterministic small media placeholders and replaced during final ZIP construction, avoiding the library's high-memory byte-to-text conversion while preserving the original image bytes.

Publication uses the exporter's exclusive temporary-file and hard-link path. A differing existing target causes a collision error; it is not overwritten. Failed packaging or publication removes the run-owned document temporary file. A failed export generation keeps `EXPORT_INCOMPLETE.txt` as the existing archive-level safety marker.

## Dependency review

The production dependency set is exactly locked. The DOCX dependency review covered the full resolved tree, licenses, package engines, lifecycle scripts, native binaries, runtime network-module loading, lockfile repeatability, npm advisories, and live smoke generation on Node.js 22 and 24. The repository uses no install scripts and no native DOCX binaries.

Re-run the large-session diagnostics with:

```powershell
node scripts/diagnostics/docx-large-line.mjs --size-mib 16
node scripts/diagnostics/docx-large-line.mjs --size-mib 115
```

Both runs enforce a Peak RSS limit below 384 MiB, verify unchanged source bytes, exactly one session DOCX and media part, and complete temporary-file cleanup.

The final 2026-08-24 Windows/Node.js 24 hyperlink-correction validation measured 16 MiB at 1,510.810 ms and 125.953 MiB Peak RSS, and 115 MiB at 8,544.730 ms and 287.773 MiB Peak RSS. Both runs left zero temporary residue and stayed below the 384 MiB ceiling. A nine-run synthetic Readable-profile comparison used the seven warm runs: the pre-change median was 82.459 ms and the post-change median was 83.889 ms, a 1.734% increase. These figures are machine-specific regression evidence, not universal performance guarantees.
