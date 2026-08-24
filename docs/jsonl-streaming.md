# Bounded JSONL streaming foundation

Exporter 0.3.0 requires Node.js 22 or newer. `streamJsonlTokens()` in `lib/jsonl-token-adapter.mjs` accepts a file path or an `AsyncIterable<Uint8Array>` and returns parser-independent tokens through an async iterator. Only this adapter imports `stream-json`.

Every token contains a one-based non-empty record index, a structural path, and a normalized type. Supported types are record, object, array, key, string boundary/chunk, number, Boolean, and null tokens. Physical LF and CRLF records are parsed separately; blank lines retain the existing skip behavior, and a final record needs no trailing newline. Tokens can be emitted before a later syntax error in the same record is discovered, so consumers must treat `record_end` as the commit boundary and retain derived output in a run-owned temporary file until then.

Default protection limits are 64 KiB input chunks, 256-character emitted string chunks, 256 nesting levels, 64 KiB object keys, and 4 KiB numeric lexemes. Large value strings are never packed. Key and number limits fail explicitly with stable error codes rather than truncating content.

`decodeBase64Chunks()` incrementally decodes strict Base64 and awaits every sink call for backpressure. Input, validation, writing, publication, and cleanup failures have separate stable error codes. `writeBase64ChunksToFile()` writes bounded blocks to a unique temporary file, synchronizes it, and publishes it with an exclusive hard link; an existing destination is never overwritten or removed. Remote references are not resolved or downloaded.

`streamSessionRecords()` in `lib/session-record-reader.mjs` is the shared productive bridge. CLI and the VS Code extension both reach it through the same export core. Small ordinary fields retain the existing object projection, while embedded Base64 values become bounded descriptors containing media type, decoded byte count, source identity, content SHA-256, and the largest decode block. A private dependency-injection hook keeps the former line reader available only as a differential test reference.

Invalid JSON, truncated records, invalid UTF-8, invalid embedded Base64, source failures, and projection failures abort the productive reader. A record is invisible until `record_end`; callers that consume decoded attachment blocks must write only to run-owned temporary storage and publish after record commit. Raw JSONL remains canonical and byte-identical; Markdown and HTML remain derived views. DOCX, PDF, attachment extraction, and VSIX packaging are separate follow-up work.
