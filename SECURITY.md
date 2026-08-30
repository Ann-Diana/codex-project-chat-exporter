# Security Policy

This policy covers the export core, CLI, Windows launcher, experimental VS Code extension, and generated export files. Codex Project Chat Exporter processes private active and archived local Codex sessions and is not a data-loss-prevention product.

## Security boundary

Sensitive inputs and outputs include configured source, output, and performance-profile paths; existing destination contents; Raw JSONL, manifests, Markdown, HTML, tool data, attachments, and local paths. No import command or validated restore roundtrip exists.

Treat JSONL content, stored project paths, user-configured paths, existing destination files, symlinks, junctions, hardlinks, path aliases, and concurrent export runs as potentially untrusted.

The required invariants are:

- source sessions are never overwritten, changed, moved, or deleted;
- source and output remain separate across canonical paths and supported link/alias checks;
- temporary files are unique to and verifiably owned by the current run;
- cleanup removes only files proven to belong to that run;
- the target filesystem passes an in-place exclusive hard-link identity/content probe before session streams are opened;
- decoded asset filenames and types come only from decoded SHA-256 and a bounded internal raster allowlist; unknown or active content is never rendered automatically;
- DOCX permits only bounded canonical HTTP/HTTPS hyperlink relationships; external image/media/resource relationships, local or active link schemes, macros, and other active content are rejected, and remote targets are never fetched;
- PDF permits only bounded canonical HTTP/HTTPS URI actions; external images, file/launch/JavaScript actions, forms, embedded files, and other active content are not produced, and remote targets are never fetched;
- PDF validation parses the classic cross-reference table, object dictionaries, escaped names and strings, references, and exact stream lengths. Binary stream bytes and literal text are not action names. Unsupported incremental updates, encryption, object streams, and xref streams fail closed; this is validation of generated PDFKit output, not a general PDF import API;
- PDF fonts are repository-local, hash-verified Noto assets; no operating-system font lookup is performed. Valid graphemes use the deterministic bundled symbol/emoji/monospace fallback chain and receive a visible PDF-only `[unsupported glyph …]` marker only when that complete chain lacks coverage. Invalid unpaired UTF-16 surrogates still fail closed with session ID and code unit only;
- existing asset targets are rehashed, size/type checked, and never overwritten;
- invocation contexts never mix, and concurrent exports to one destination are rejected;
- project discovery tokenizes only bounded first-record `session_meta` or `turn_context` metadata and never scans later JSONL conversation records to infer a path; Windows workspace identity normalizes only lexical absolute-path representation differences and never performs basename, descendant, fuzzy or filesystem matching; recorded-project recovery uses only an explicitly selected exact cwd from that inventory, with adapter confirmation for a different workspace identity; stored cwd values never authorize filesystem collection or automatic fallback;
- source changes cause a retry or fail-closed error;
- `raw_sha256` and `raw_verified_at` describe verification only at export time;
- published Raw files remain mutable, so later use or a future importer must hash them again and reject a mismatch.

Reportable security issues include source overwrite/deletion, path traversal, source/output separation bypasses, symlink/junction/hardlink/alias attacks, race conditions or cross-run mixing, unauthorized network or workspace-trust bypasses, data exfiltration, telemetry or unexpected uploads, false integrity claims, command injection, and cleanup of foreign files. No accepted-risk exception applies without the repository owner's explicit approval.

### Opening exported files and folders

The VS Code extension stores the latest export paths for convenience. Immediately before opening a file or folder, it revalidates the local path, expected file type, canonical target, containment within the recorded export location, and filesystem identity. This reduces path-replacement and link-alias risks, but cannot eliminate changes made after the final check and before VS Code or the operating system processes the target.

### Local filesystem trust boundary

The exporter checks for accidental source/output overlap and for link or alias structures that are already present when a path is inspected. It should not be run with elevated or administrator privileges. Output folders must be private, local, and not writable by other users.

Active filesystem races by another process running under the same user account are outside the guaranteed protection boundary. Additional before/after path checks reduce accidental misuse but cannot remove that operating-system timing boundary.

## Redaction limits

Markdown applies best-effort masking for some token shapes and long base64-like values. It can miss names, paths, addresses, customer data, source code, proprietary text, and credentials. Raw JSONL is byte-preserving and unredacted. Decoded assets preserve their original bytes. Raw files, both manifests, and `assets/` are not share-safe.

## Safe use

- Prefer a new empty destination on known local or encrypted storage; mapped network drives are not reliably identifiable in every configuration.
- Use the `readable` profile when Markdown and HTML reading views are sufficient and Raw JSONL snapshots are not required. This reduces copied data but does not make the export share-safe.
- Keep Raw and manifest files private and review every generated file before sharing.
- Keep exports outside public repositories and never attach real session logs to public reports.
- Treat an output folder containing `EXPORT_INCOMPLETE.txt` as an incomplete generation. Do not use its manifest or indexes; choose a new empty destination, or inspect and remove the incomplete export manually.
- If `.codex-export.lock` remains after a crash, first prove no export is running, inspect its PID and start time, and remove only that confirmed stale lock file.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting under the repository's **Security** tab when available. Otherwise open only a minimal non-sensitive public issue requesting a private contact route; never include session files, credentials, customer data, or exploit details.
