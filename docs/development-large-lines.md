# Large JSONL line diagnostic

Run the isolated 16 MiB developer diagnostic:

```powershell
node scripts/diagnostics/large-jsonl-line.mjs
```

Run an explicit approximately 115 MiB diagnostic:

```powershell
node scripts/diagnostics/large-jsonl-line.mjs --size-mib 115
```

The diagnostic exercises the productive session-record bridge and the active deduplicated asset store in a separate Node.js process. It creates and removes its input and export below the operating-system temporary directory, performs the target-filesystem hard-link probe, publishes exactly one decoded asset only after record commit, verifies decoded, written, and Raw SHA-256 plus unchanged source bytes, checks one complete usage entry and no staging residue, and enforces a 192 MiB Peak RSS ceiling. It is not part of `npm test` or the CI matrix.

`real-session-reader-corpus.mjs` is a local, read-only differential diagnostic. It processes sessions sequentially and emits aggregates only: no titles, prompts, paths, attachment payloads, raw data, or hash lists. The legacy implementation runs in an isolated child with a fixed heap ceiling and remains a test reference, not a product option.

`real-asset-corpus.mjs --selection largest` and `--selection all` run the active asset store against the largest real session or the complete local corpus. The temporary export is removed after the run. Output is aggregate-only: session/record/occurrence counts, unique file and byte counts, saved bytes and ratio, allowlisted extension counts, runtime, memory, and residue count. It emits no paths, content, titles, source or asset hashes, payloads, or lists.

`stream-json` is pinned to 3.5.0 and resolves `stream-chain` 4.2.5 transitively; both packages use BSD-3-Clause. A future VSIX packaging step must include the parser runtime and both dependency license notices. No VSIX packaging is implemented by this diagnostic.

The opt-in DOCX path has separate end-to-end diagnostics:

```powershell
node scripts/diagnostics/docx-large-line.mjs --size-mib 16
node scripts/diagnostics/docx-large-line.mjs --size-mib 115
```

They run the productive exporter in an isolated child, require exactly one session DOCX and one embedded media part, verify unchanged source bytes and zero temporary residue, and enforce Peak RSS below 384 MiB.
