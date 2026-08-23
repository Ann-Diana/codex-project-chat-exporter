# Large JSONL line diagnostic

Run the isolated 16 MiB developer diagnostic:

```powershell
node scripts/diagnostics/large-jsonl-line.mjs
```

Run an explicit approximately 115 MiB diagnostic:

```powershell
node scripts/diagnostics/large-jsonl-line.mjs --size-mib 115
```

The diagnostic creates and removes its input below the operating-system temporary directory. It is not part of `npm test` or the CI matrix.
