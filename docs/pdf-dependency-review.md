# PDF and font dependency review

Review date: 2026-08-30. The production choice is exactly `pdfkit@0.20.1` plus direct `fontkit@2.0.4`, with the Noto font files documented in `fonts/README.md`. Emoji coverage adds no npm dependency.

## Gate result

- PDFKit is actively maintained under MIT. Release 0.19.0 raised its minimum Node.js version to 20, and current 0.20.1 therefore covers the tested Node.js 22 and 24 lines. The 0.20.1 release also provides its current Node-specific build.
- The complete resolved PDF production closure contains 20 package locations. All lock entries have exact versions, registry URLs, and SHA-512 integrity values. Two independent lock generations were byte-identical.
- No package in that closure declares `preinstall`, `install`, or `postinstall`; no `.node`, DLL, EXE, SO, or dylib file exists in the installed closure.
- Offline smoke generation patched `fetch`, HTTP, HTTPS, DNS, TCP, and TLS entry points to fail. PDF generation completed without a network attempt on Node.js 22.23.2 and 24.19.0.
- The Node 22 and Node 24 smoke PDFs were byte-identical after fixed metadata dates were supplied.
- `npm audit` and `npm audit --omit=dev` both reported zero vulnerabilities for the reviewed closure.
- The renderer does not use Word, LibreOffice, Chromium, Playwright, browser downloads, native executables, or operating-system fonts.

## Resolved PDF package closure

| Package location | Version | License |
| --- | --- | --- |
| `pdfkit` | 0.20.1 | MIT |
| `fontkit` | 2.0.4 | MIT |
| `@noble/ciphers` | 1.3.0 | MIT |
| `@noble/hashes` | 1.8.0 | MIT |
| `@swc/helpers` | 0.5.23 | Apache-2.0 |
| `base64-js` | 1.5.1 | MIT |
| `linebreak/node_modules/base64-js` | 0.0.8 | MIT |
| `brotli` | 1.3.3 | MIT |
| `clone` | 2.1.2 | MIT |
| `dfa` | 1.2.0 | MIT |
| `fast-deep-equal` | 3.1.3 | MIT |
| `fflate` | 0.8.3 | MIT |
| `linebreak` | 1.1.0 | MIT |
| `pako` | 0.2.9 | MIT |
| `png-js` | 2.0.0 | MIT (`LICENSE`; the package manifest omits the field) |
| `restructure` | 3.0.2 | MIT |
| `tiny-inflate` | 1.0.3 | MIT |
| `tslib` | 2.8.1 | 0BSD |
| `unicode-properties` | 1.4.1 | MIT |
| `unicode-trie` | 2.0.0 | MIT |

## Font decision

Noto Sans 2.015 provides proportional regular, bold, and italic text; Noto Sans Mono 2.014 provides code text and mathematical comparison fallbacks. Noto Sans Symbols 2.003 supplies arrows, while the separately released Noto Sans Symbols 2 2.008 supplies check marks and warning signs absent from the other bundled faces. The pinned official monochrome Noto Emoji face at commit `9a5261d871451f9b5183c93483cbd68ed916b1e9` supplies outline glyphs for common legacy emoji including U+1F604; unlike a bitmap or color-table font, PDFKit embeds it as selectable subset text with ToUnicode mappings.

Every emitted grapheme is checked against the selected primary face followed by the deterministic symbol/emoji/monospace fallback chain; an explicit emoji-presentation selector prefers the emoji face before the symbol faces to keep distinct ToUnicode mappings. Variation selectors and joiners remain attached to their grapheme. A still-uncovered valid grapheme becomes a visible deterministic PDF-only marker; invalid unpaired UTF-16 remains an error without source text. Font-specific ascender, descender, and line-gap metrics are normalized to the primary face for every fallback run, preserving a shared baseline and the primary line-height/wrapping contract.

The Noto Sans and Symbols files are official release assets under SIL OFL-1.1. The historical official monochrome Emoji face is Apache-2.0 licensed at its pinned upstream commit. Exact versions, source archives or commits, and SHA-256 values are recorded in `fonts/README.md`; `fonts/OFL.txt`, `fonts/OFL-SYMBOLS.txt`, and `fonts/APACHE-NOTO-EMOJI.txt` preserve the distinct upstream licenses. All font and license files are included in the VSIX integrity manifest and copied by the regular builder.
