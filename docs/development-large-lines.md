# Large JSONL line diagnostic

Run the isolated 16 MiB developer diagnostic:

```powershell
node scripts/diagnostics/large-jsonl-line.mjs
```

Run an explicit approximately 115 MiB diagnostic:

```powershell
node scripts/diagnostics/large-jsonl-line.mjs --size-mib 115
```

The diagnostic exercises the bounded JSONL tokenizer and incremental Base64 file sink in a separate Node.js process. It creates and removes its input and decoded output below the operating-system temporary directory, verifies decoded SHA-256 and unchanged source bytes, and enforces a 192 MiB Peak RSS ceiling. It is not part of `npm test` or the CI matrix.

`stream-json` is pinned to 3.5.0 and resolves `stream-chain` 4.2.5 transitively; both packages use BSD-3-Clause. A future VSIX packaging step must include the parser runtime and both dependency license notices. No VSIX packaging is implemented by this diagnostic.
