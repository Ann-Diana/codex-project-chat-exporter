# Changelog

All notable changes to this project are documented here.

## Unreleased

### Added

- Added Complete, Readable, and Source snapshots export profiles to the shared exporter, available through the CLI and the VS Code extension.
- Added an experimental VS Code extension with three visible commands, scope and profile selection, progress reporting, and actions for opening the latest export or its output folder.

### Changed

- Classified direct user turns, subagent inputs, runtime contexts, and uncertain user-role records in derived reading views without changing canonical Raw events.
- Improved Source snapshots performance while retaining export-time SHA-256 verification.
- Replaced continuing Raw-integrity claims with time-specific verification metadata and documented mandatory rehashing before later use.
- Aligned export, privacy, archive-format, and security documentation with the current unreleased branch.
- Clarified the project's bulk, project-aware, and VS Code scope after Codex 0.148.0 introduced native export of the current TUI conversation.

### Fixed

- Completed escaping of backslashes, pipes, and line breaks in Markdown index table cells.
- Preserved the original source-derived `started_at` fallback when parsing a copied Raw snapshot without `session_meta`.

### Security

- Separated source and output paths, including path and link aliases, and limited cleanup to files owned by the current export run.
- Isolated concurrent export contexts and prevented simultaneous exports to the same destination.
- Scoped sensitive VS Code settings to the application level, required trusted local workspaces, and rejected remote, web, UNC, and Windows device-path export targets.

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
- Optional tool-call and tool-output inclusion.
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
