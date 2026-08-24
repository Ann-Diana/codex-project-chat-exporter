# Changelog

All notable changes to this project are documented here.

## 0.3.0 – Unreleased

### Changed

- Raised the exporter minimum runtime to Node.js 22 and the experimental extension minimum to Visual Studio Code 1.101. Exporter 0.2.x remains the final line for older Node.js versions; Node.js 18 and 20 are no longer tested.
- Added the bounded streaming JSONL foundation for processing large string values without materializing complete records.
- Integrated the bounded reader into the shared CLI and VS Code export core, with committed-record projections, incremental attachment hashing, differential legacy-reference tests, and fail-closed invalid-input handling.
- Added an export-local, SHA-256-addressed asset store with deterministic schema-1 usage manifests, bounded type validation, Markdown and HTML links, and aggregate root-manifest fields.
- Added an opt-in, deterministic per-session DOCX export backed by an exporter-independent document model shared by the CLI and VS Code adapter.
- Added structural OOXML, cross-runtime reproducibility, failure-cleanup, and 16/115 MiB memory diagnostics for DOCX.
- Added an opt-in, directly rendered deterministic per-session PDF export with A4 pagination, safe URI links, bounded PNG/JPEG images, conservative attachment fallbacks, and byte-identical Node.js 22/24 output.
- Bundled hash-verified OFL-1.1 Noto proportional, monospace, and symbol fonts; unsupported Unicode now fails closed with session/code-point-only diagnostics.
- Extended the regular deterministic VSIX builder and packaged offline end-to-end test to cover the complete PDF runtime and font integrity tree.
- Added controlled HTTP/HTTPS OOXML hyperlinks with deterministic relationship IDs and repaired regular VSIX packaging so the complete production runtime, integrity inventory, and third-party license material are included automatically.

### Security

- Added a target-filesystem hard-link capability probe before session reads; asset publication has no overwrite or copy fallback.
- Unknown, active, truncated, or MIME-spoofed attachments are preserved as non-renderable `.bin` files, and existing targets are rehashed and type-checked before reuse.
- DOCX packaging allows only controlled HTTP/HTTPS hyperlink relationships; it blocks external resource relationships, macros, embedded active content, local/active/unsupported link schemes, rehashes local assets before embedding, and never downloads remote resources.

## 0.2.0 – 2026-08-20

### Added

- Added Complete, Readable, and Source snapshots export profiles to the shared exporter, available through the CLI and the VS Code extension.
- Added an experimental VS Code extension with three visible commands, scope and profile selection, progress reporting, and actions for opening the latest export or its output folder.

### Changed

- Markdown reading views now distinguish direct user turns, assistant responses, subagent inputs, automatic runtime contexts, and unclassified user-role records without changing canonical Raw events.
- Improved Source snapshots performance while retaining export-time SHA-256 verification.
- Replaced continuing Raw-integrity claims with time-specific verification metadata and documented mandatory rehashing before later use.
- Aligned export, privacy, archive-format, and security documentation with the current unreleased branch.
- Clarified the project's bulk, project-aware, and VS Code scope after Codex 0.148.0 introduced native export of the current TUI conversation.

### Fixed

- Completed escaping of backslashes, pipes, and line breaks in Markdown index table cells.
- Preserved the original source-derived `started_at` fallback when parsing a copied Raw snapshot without `session_meta`.

### Security

- Separated source and output paths, including path and link aliases, and limited cleanup to files owned by the current export run.
- Bound Raw snapshot publication to the exclusively created temporary-file identity and rejected identity changes before, during, or after publication.
- Isolated concurrent export contexts and prevented simultaneous exports to the same destination.
- Used machine-scoped local paths for `codexProjectChatExporter.outputDirectory` and `codexProjectChatExporter.codexHome` so their absolute values are not transferred to other computers through VS Code Settings Sync; required trusted local workspaces, and rejected remote, web, UNC, and Windows device-path export targets.
- Limited VSIX replacement to the exact current candidate, blocked unexpected `dist/` artifacts, and cleaned only uniquely named run-owned staging paths.
- Pinned installed extensions to their bundled exporter core with a packaged SHA-256 integrity record.
- Revalidated the last successful export folder and HTML index immediately before open actions; changed or unverifiable targets are refused.

### Removed

- Removed the obsolete `open-project.cmd` helper. The numbered Windows launcher now covers all supported workflows.

## 0.1.0 – 2026-07-22

Initial public release.

### Added

- Bulk export of local Codex sessions grouped by stored project/work folder.
- Scanning of active and archived session directories.
- Numbered Windows launcher menu for exporting, project/session listing, and diagnostics.
- Project-level counts plus an individual `--list-sessions` view that distinguishes active and archived chats.
- `--diagnose` output with active/archived scan paths, JSONL counts, incomplete metadata, invalid JSON lines, and ID mismatch warnings.
- Readable Markdown transcripts.
- Added optional inclusion of recorded tool-call inputs and outputs in Markdown transcripts.
- Optional unchanged raw JSONL copies.
- Filterable local HTML index, Markdown index, manifest, and summary file.
- Fallback titles derived from the first user message when no indexed title exists.
- Recovery of session IDs from standard rollout filenames when `session_meta` is missing or malformed.
- Recovery of working-directory metadata from `turn_context` and embedded `<cwd>` environment blocks.
- Short-path output mode for Windows portability.
- Windows double-click launcher with documented Mark-of-the-Web / Smart App Control handling.
- Synthetic screenshots for the HTML index, Windows launcher, and generated archive structure.
- Best-effort Markdown secret redaction.
- Guard against writing private exports into the repository folder.
- Helper and end-to-end tests using synthetic session data.
