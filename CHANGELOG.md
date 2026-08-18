# Changelog

All notable changes to this project are documented here.

## Unreleased

### Changed

- Classified direct user turns, subagent inputs, runtime contexts, and uncertain user-role records without changing canonical Raw events.
- Added Complete, Readable, and Source snapshots profiles with progress reporting and targeted snapshot performance improvements.
- Replaced continuing Raw-integrity claims with export-time verification metadata and documented mandatory rehashing for later use.
- Added source/output and link-alias separation, run-owned cleanup, isolated export contexts, and same-destination locking.
- Prepared the experimental VS Code integration with three visible commands, scope/profile Quick Picks, application-scoped sensitive paths, and local-host trust checks.
- Aligned export, privacy, archive-format, and security documentation with the current unreleased branch.

### Fixed

- Completed escaping of backslashes, pipes, and line breaks in Markdown index table cells.
- Preserved the original source-derived `started_at` fallback when parsing a copied Raw snapshot without `session_meta`.

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
