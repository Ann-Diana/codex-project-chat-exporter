# Changelog

All notable changes to this project are documented here.

The last published state proven by local repository tags is `v0.2.0`. Package metadata identifies the current development line as `0.3.0`, but no `v0.3.0` tag exists.

## Unreleased

### Added

- Added bounded streaming JSONL processing for large records, incremental attachment hashing and sequential per-session work.
- Added a deterministic SHA-256-addressed asset store with provenance, mirror relationships, validated raster types and one physical file per unique asset.
- Added opt-in deterministic DOCX and directly rendered PDF reading views, with one document per session and a shared exporter-independent document model.
- Added bundled hash-verified Noto text, monospace, symbol and Noto Emoji 3.002 outline fonts for offline PDF rendering.
- Added confirmed chronological model history and session-origin metadata without merging subagent models into a parent session.
- Added exact historical recorded-path inventory and selection for moved or renamed projects.
- Added direct CLI text or JSON reports, exact recorded-project selection, DOCX and PDF in one run plus controlled SIGINT cleanup.

### Changed

- Raised the minimum exporter runtime to Node.js 22 and the experimental extension minimum to Visual Studio Code 1.101. The current CI line covers Node.js 22 and 24.
- Aligned Complete, Readable and Source snapshots with one record and asset selection policy. Readable suppresses `replacement_history`; Complete keeps unmatched stored context in a labelled area.
- Made Tool, Browser and `view_image` filtering apply consistently to Markdown, responsive HTML, DOCX, PDF and selected assets.
- Added controlled HTTP and HTTPS hyperlinks without remote retrieval. Local file links, launch actions and active schemes remain blocked in DOCX and PDF.
- Extended the deterministic VSIX builder, integrity inventory and packaged offline end-to-end tests for the complete production runtime and bundled fonts.
- Upgraded the monochrome emoji fallback and made unsupported PDF graphemes visible through deterministic ordered code-point markers.

### Fixed

- Fixed metadata-only workspace discovery for large first records and Windows path representation variants without fuzzy matching or workspace-file reads.
- Fixed mirrored image duplication, tool-only image leakage, replacement-history visibility and asset-manifest provenance.
- Fixed invalid XML 1.0 text and ANSI SGR handling in DOCX while preserving valid Unicode and Raw JSONL.
- Fixed safe deterministic DOCX hyperlink relationships and complete VSIX dependency packaging.
- Fixed PDF symbol baselines, multiline fallback layout, nested list and page-break overlap plus readable document structure.
- Fixed preservation of model transitions, subagent origin and multi-model labels across manifests and reading formats.
- Fixed cancellation and multi-format publication so interrupted generations are clearly marked incomplete and run-owned temporary files are cleaned.

### Security

- Added target-filesystem hard-link capability checks, source/output separation and fail-closed publication without overwrite or copy fallback.
- Rehashes existing asset targets and local files immediately before document embedding; invalid or changed content aborts publication.
- Keeps external images, active OOXML relationships, PDF launch or JavaScript actions, macros, forms and embedded files out of generated documents.

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
