# Shared document model and DOCX export

Exporter 0.3.0 can add one DOCX reading view per exported session. DOCX is opt-in and never combines multiple sessions into one document.

## Selection

Add DOCX to any CLI profile with:

```powershell
node .\bin\export-codex-project-chats.mjs --all --profile readable --format docx --out C:\cx\codex-export
```

The shared JavaScript API uses `documentFormats: ["docx"]`. The VS Code adapter exposes the same selection as **Add DOCX** after scope and profile selection. Omitting the selection leaves every existing profile unchanged. PDF is a separate direct renderer described in `document-model-and-pdf.md`; DOCX is never used as its intermediate format.

## Document contract

`lib/document-model.mjs` defines the exporter-independent session-document contract. A header contains a title, a stable session origin, and limited project, storage, timestamp, confirmed model history, and optional Raw-reference metadata. One confirmed model is labelled `Model`; multiple chronological values are labelled `Models` and joined with ` → `. The history comes only from turn runtime metadata and never merges a coupled subagent into its parent. Each message contains:

- a stable session ID and physical JSONL record ordinal;
- an explicit role: `USER`, `ASSISTANT`, `SUBAGENT`, `RUNTIME_CONTEXT`, `UNCLASSIFIED`, or `TOOL`;
- ordered paragraphs, headings, lists, links, and code blocks;
- local attachment references with stable attachment ordinals and hashes.

The contract does not contain complete Raw events. The exporter processes sessions sequentially and builds at most one derived session document at a time. Markdown and DOCX are fed from the same session-record pass, so enabling DOCX does not add another complete JSONL scan.

Lists retain their source marker family and logical restart. A standalone top-level marker begins at the normal paragraph margin with only a small hanging gap. A list receives a moderate block indent only when the immediately preceding ordinary paragraph ends with a colon; a colon inside a sentence or code does not announce a list. Further indentation represents actual nesting. Source line boundaries inside an ordinary paragraph become explicit line breaks instead of being flattened. Consecutive path-tree lines containing branch structure are conservatively promoted to a preformatted monospace block; a lone tree glyph or an arbitrary multiline path is not.

Before the shared model is built, Readable alone applies a bounded message-text normalization. Natural direct-user and assistant prose changes EM DASH (`U+2014`) to EN DASH (`U+2013`); inline/fenced code, URLs, paths, filenames, structured examples, identifiers, and hashes remain unchanged. A standalone, structurally complete internal `<oai-mem-citation>` assistant block is omitted without removing adjacent prose. The stateful parser preserves user literals, block quotes, inline/fenced examples, nested/unknown markup, and incomplete blocks. Complete, Source snapshots, and Raw JSONL are not normalized.

## DOCX behavior

DOCX files follow the session-relative naming used by the other reading views:

```text
docx/<project-directory>/<session-name>.docx
```

PNG and JPEG assets are embedded. Repeated uses of identical content share one OOXML media part. GIF, WebP, and `.bin` assets remain clearly labelled attachment references because the exporter does not convert images and does not claim reliable native Word rendering for those formats. Images preserve validated dimensions, fit within a 600 by 700 pixel layout box, and include alternative text tied to the source record.

Attachment occurrences come from the same classified record selection as message text. Tool-only images require `includeTools`; verified source mirrors are not repeated. Readable omits every `replacement_history` occurrence. Complete renders unmatched history images in a labelled `Additional stored context` section. Equal bytes used in independent genuine turns remain independent document occurrences.

Valid, bounded `http:` and `https:` targets become real OOXML hyperlinks whose visible text contains the label and canonical target. Surrounding text and punctuation remain ordinary runs. Invalid, overlong, local, UNC/device, `file:`, `javascript:`, `data:`, and other unsupported targets remain labelled, non-clickable text. Creating or opening a DOCX never downloads the target.

All dynamic text written to OOXML is checked against the XML 1.0 character set before the DOCX library performs XML escaping. Valid Unicode—including tabs, line breaks, symbols, emoji, and supplementary-plane characters—remains unchanged. A syntactically complete ANSI SGR formatting sequence (`ESC`, `[`, digits/semicolons/colons, `m`) is removed as one non-content formatting instruction while surrounding printable text is retained. Isolated `ESC`, incomplete or unsupported CSI sequences, and every other forbidden code unit are represented visibly and deterministically as `[invalid XML character U+NNNN]`; this preserves occurrence boundaries and the original code-unit identity without guessing at unsupported terminal commands. The normalization applies only to the derived DOCX reading view. Raw JSONL and the shared document model remain unchanged. Hyperlink targets and relationship paths are not repaired this way: they continue to pass their stricter protocol and path contracts or remain non-clickable text.

The package validator permits only explicit external HTTP/HTTPS hyperlink relationships from `word/document.xml`, verifies every `w:hyperlink` relationship-ID mapping, and rejects external image/media/resource relationships, active content, embedded objects, macros, path traversal, missing media targets, malformed XML, and unexpected package paths. Local assets are rehashed immediately before packaging; missing or changed assets fail the document instead of being silently omitted.

## Reproducibility and publication

Decoded XML attributes are escaped again during relationship-ID normalization; query separators and literal entity text are preserved. Every XML and relationship part is checked before and after normalization. Each logical list has a separate numbering instance, with explicit starts and nested parent continuation retained. Exporter-owned separators use en dashes; source punctuation is rewritten only by the explicitly documented Readable prose normalization above.

Standalone technical image-marker parts are omitted only when directly paired with a verified PNG/JPEG image part with valid dimensions. Markers in code, quoted/literal examples, unsupported attachments, and forensic source data remain. Local-file links are labelled `[local file not included]` in document reading views; the model retains the blocked reason. No workspace/preview files are collected. Images are not linked to external relative files from DOCX/PDF: resolving them reliably would require local-resource relationships/actions that these formats deliberately prohibit. Use the portable `assets/` references in the HTML index instead.

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
