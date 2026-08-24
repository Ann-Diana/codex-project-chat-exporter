# DOCX production dependency review

Review date: 2026-08-24. Selected package: `docx` 9.7.1, pinned exactly.

## Decision

The package line passed the pre-change gate:

- `docx` 9.7.1 is the current maintained release and declares Node.js `>=10`; its resolved runtime tree also satisfies Node.js 22 and 24 engine ranges. Live import, offline packaging, OOXML loading, and deterministic normalization passed under Node.js 22.23.2 and 24.19.0.
- The package and all resolved production dependencies use permissive licenses. `jszip` offers MIT as one of its dual-license choices; `pako` uses MIT and Zlib; `sax` uses BlueOak-1.0.0.
- No package has `preinstall`, `install`, or `postinstall` scripts. The installed tree contains no `.node`, DLL, executable, shared-library, or `binding.gyp` files.
- Runtime smoke tests blocked `http`, `https`, `net`, `tls`, `dns`, and global `fetch`; DOCX generation completed without a network-module load or fetch.
- Every lock entry has a registry URL and integrity digest. Repeating package-lock resolution left the lockfile byte-identical.
- `npm audit` and `npm audit --omit=dev` both reported zero known vulnerabilities.

The source package includes an inert XML example server below a transitive package's examples directory. It is not reachable from the resolved DOCX runtime import path and the offline runtime guard confirms that no network module is loaded during document generation.

## Resolved production packages

| Package | Version | License |
| --- | ---: | --- |
| `docx` | 9.7.1 | MIT |
| `@types/node` | 25.9.5 | MIT |
| `core-util-is` | 1.0.3 | MIT |
| `hash.js` | 1.1.7 | MIT |
| `immediate` | 3.0.6 | MIT |
| `inherits` | 2.0.4 | ISC |
| `isarray` | 1.0.0 | MIT |
| `jszip` | 3.10.1 | MIT OR GPL-3.0-or-later; used under MIT |
| `lie` | 3.3.0 | MIT |
| `minimalistic-assert` | 1.0.1 | ISC |
| `nanoid` | 5.1.16 | MIT |
| `pako` | 1.0.11 | MIT AND Zlib |
| `process-nextick-args` | 2.0.1 | MIT |
| `readable-stream` | 2.3.8 | MIT |
| `safe-buffer` | 5.1.2 | MIT |
| `sax` | 1.6.1 | BlueOak-1.0.0 |
| `setimmediate` | 1.0.5 | MIT |
| `string_decoder` | 1.1.1 | MIT |
| `stream-chain` | 4.2.5 | BSD-3-Clause |
| `stream-json` | 3.5.0 | BSD-3-Clause |
| `undici-types` | 7.24.6 | MIT |
| `util-deprecate` | 1.0.2 | MIT |
| `xml` | 1.0.1 | MIT |
| `xml-js` | 1.6.11 | MIT |

`jszip` 3.10.1 and `xml-js` 1.6.11 are direct exact dependencies because deterministic ZIP normalization and structural relationship/XML validation are product responsibilities rather than undocumented reliance on `docx` internals.
