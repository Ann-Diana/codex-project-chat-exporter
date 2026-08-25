# Shared document model and PDF export

Exporter 0.3.0 can add one PDF reading view per exported session. PDF is opt-in, never combines sessions, and is rendered directly from `lib/document-model.mjs`; DOCX is not an intermediate format.

## Selection

```powershell
node .\bin\export-codex-project-chats.mjs --all --profile readable --format pdf --out C:\cx\codex-export
```

The shared JavaScript API uses `documentFormats: ["pdf"]`. In VS Code, run **Codex Export: Export…**, choose scope and profile, then choose **Add PDF**. Omitting the format selection preserves the existing profile exactly.

## Rendering contract

PDFs follow the existing session-relative naming under `pdf/<project>/<session>.pdf`. They use A4 portrait pages, fixed 54-point side/top margins, a 60-point bottom margin, deterministic page numbers, and stable wrapping. Titles, limited metadata, roles including unclassified records, headings, paragraphs, lists, code blocks, and message order come from the common model. The visible project field is reduced to its final display-name segment so an absolute source path does not enter the PDF.

PNG and JPEG assets are embedded proportionally within the printable page. Repeated content reuses one PDF image object. GIF, WebP, and `.bin` remain labelled attachment references and are never converted. Missing, changed, or corrupt assets abort that session document.

Canonical bounded HTTP/HTTPS links become URI annotations. Invalid, overlong, local, UNC/device, `file:`, `javascript:`, `data:`, and other targets remain non-clickable labelled text. The renderer never downloads a target. It creates no external images, file actions, launch actions, JavaScript, forms, embedded files, or other active content.

## Fonts and missing glyphs

The renderer uses only the bundled Noto Sans, Noto Sans Mono, Noto Sans Symbols, and Noto Sans Symbols 2 faces described in `fonts/README.md`. Font bytes are hashed before parsing. Text is checked code point by code point; missing primary glyphs use the two symbol faces and then the monospace face in a fixed order. Arrows, check marks, warning signs, plus/minus, and comparison signs remain selectable as their original Unicode characters. Each mixed-font run derives its baseline, pagination, and line height from the primary face's ascender/descender metrics instead of applying character-specific offsets. An unsupported code point aborts with the session ID and Unicode code point but without message content.

## Reproducibility and publication

Creation/modification dates are fixed at 2000-01-01T00:00:00Z before PDFKit derives the document ID. Metadata insertion order, object order, font subsets, image reuse, compression, and page numbering are deterministic. Repeated exports are byte-identical on Node.js 22 and 24.

Publication uses the exporter's exclusive run-owned temporary file. A differing existing destination is rejected, and failed writes remove only the verified run-owned partial file. `EXPORT_INCOMPLETE.txt` remains the archive-level failure marker until the whole export is verified.

The exporter still performs one asset-collection pass and one shared reading-view pass per selected session; PDF does not add a third complete JSONL pass and does not retain other sessions in memory.

Run the paired PDF/DOCX large-line diagnostics with:

```powershell
node scripts/diagnostics/pdf-large-line.mjs --size-mib 16
node scripts/diagnostics/pdf-large-line.mjs --size-mib 115
```

The diagnostic uses one large non-renderable `.bin` attachment so it exercises JSONL parsing, base64 decoding, deduplicated asset publication, integrity hashing, attachment fallback, and document publication without conflating the result with a single image decoder's unavoidable buffer. Separate renderer and integration tests embed real PNG and JPEG fixtures. Each run checks source-byte identity, one document per format, no unexpected media embedding, zero temporary residue, PDF Peak RSS below 384 MiB, and flags PDF runtime above 1.5 times the corresponding DOCX run for investigation.

Measurements on 2026-08-25 with Node.js 24.19.0:

| JSONL input | PDF | DOCX | PDF / DOCX | PDF Peak RSS | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| 16 MiB | 1,245.190 ms | 1,184.063 ms | 1.052 | 155.613 MiB | pass |
| 115 MiB | 7,471.683 ms | 7,415.534 ms | 1.008 | 253.344 MiB | pass |

Both runs left no temporary residue and preserved the JSONL source byte-for-byte. Neither ratio crossed the 1.5 investigation threshold.

Create an offline manual-review archive from synthetic records only with:

```powershell
node scripts/diagnostics/create-pdf-review-fixture.mjs --out C:\cx\pdf-review
```

The command refuses to reuse an existing export generation and prints the path of its single PDF.
