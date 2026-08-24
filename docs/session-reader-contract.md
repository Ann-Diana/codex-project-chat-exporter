# Productive session reader contract

`streamSessionRecords()` is the single internal contract used by session routing, metadata and classification, Markdown rendering, the CLI, and the VS Code adapter. It yields records sequentially as `{ recordNumber, item, attachments }` only after the parser has emitted `record_end`.

The `item` projection preserves the ordinary JSON fields consumed by the exporter. These include event type and timestamp; session identity, working directory, source, thread source and parent thread; turn model and working directory; message role, text content and turn identity; mirrored user-message text and attachment order; and tool type, name, arguments, input, and output. Unknown record types and their ordinary fields remain present; unknown user-role records retain the existing `UNCLASSIFIED` behavior.

Embedded Base64 values are the exception. They are never rebuilt as complete strings, buffers, or object properties. Their projected value is an immutable descriptor containing encoding, MIME type, decoded byte count, decoded SHA-256, source-string SHA-256, source form, and maximum decoded block size. Equality checks use the source identity so mirrored-attachment semantics remain exact. Local and remote references remain literal strings; the reader performs no downloads.

The source file is opened read-only. Optional Raw hashing observes the same byte stream, while Raw export remains a separate byte-identical snapshot operation. Derived Markdown, HTML, JSON manifest and indexes never become import sources.

JSON, UTF-8, Base64, source, hashing, projection, and pre-commit failures are explicit. No current record is visible before `record_end`. The optional decoded-block consumer is backpressure-aware and may write only to run-owned temporary storage; publication belongs after record commit. Existing targets are never overwritten. Filesystems without safe hard-link publication fail closed, with no copy-and-replace fallback.

The former line reader remains as `legacy-reference` solely for differential tests through an undocumented internal dependency-injection option. No CLI flag or VS Code setting exposes it; both product entry points use `streaming` by default.
