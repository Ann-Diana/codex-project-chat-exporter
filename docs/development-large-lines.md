# Large JSONL line diagnostic

Run the isolated 16 MiB developer diagnostic:

```powershell
node scripts/diagnostics/large-jsonl-line.mjs
```

Run an explicit approximately 115 MiB diagnostic:

```powershell
node scripts/diagnostics/large-jsonl-line.mjs --size-mib 115
```

The diagnostic exercises the productive session-record bridge and its bounded attachment stream in a separate Node.js process. It creates and removes its input and decoded output below the operating-system temporary directory, publishes the decoded diagnostic file only after record commit, verifies both decoded and written SHA-256 plus unchanged source bytes, and enforces a 192 MiB Peak RSS ceiling. It is not part of `npm test` or the CI matrix.

`real-session-reader-corpus.mjs` is a local, read-only differential diagnostic. It processes sessions sequentially and emits aggregates only: no titles, prompts, paths, attachment payloads, raw data, or hash lists. The legacy implementation runs in an isolated child with a fixed heap ceiling and remains a test reference, not a product option.

`stream-json` is pinned to 3.5.0 and resolves `stream-chain` 4.2.5 transitively; both packages use BSD-3-Clause. A future VSIX packaging step must include the parser runtime and both dependency license notices. No VSIX packaging is implemented by this diagnostic.
