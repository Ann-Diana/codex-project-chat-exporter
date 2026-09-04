# Moved and renamed projects

Codex records the working directory (`cwd`) in each session. A current workspace name is not a durable project identity. The VS Code adapter therefore matches the current workspace by a lexical absolute-path identity and never guesses from similar folder names or silently includes descendants. On Windows this identity normalizes drive-letter case, slash direction, trailing separators and equivalent local `\\?\` drive or UNC forms; it does not use basename, descendant, filesystem search or fuzzy matching.

In **Codex Export: Export…**, choose **Project from Codex history…**, the export profile and one of the four document-format options. The picker displays each distinct canonical first-record `cwd` identity, its stored path variants, retained session count, total source bytes plus first and last session timestamps. Discovery streams only the first physical JSONL record and accepts `session_meta` or `turn_context` metadata there; a later conversation record is never inspected to recover a path. Active-over-archive duplicate-session preference still applies, so duplicate copies are not counted twice.

A workspace export without a match explains that the folder may have moved or been renamed and offers the same picker. Selecting a path different from the current workspace requires **Export recorded sessions** in a modal confirmation: all sessions under that historical cwd will be exported and several logically distinct projects can be mixed there. Dismissing any picker creates no export, changes no remembered completed-export state and selects nothing automatically. The output directory is created only after the export starts.

Recorded paths are selection data, not files to open or search. No alias is saved; no preview/workspace resources are collected. There is no per-session picker yet. Existing local/trusted-desktop restrictions still apply.

## CLI and shared API

`--recorded-project <cwd>` selects one verbatim recorded path, without basename, descendant or fuzzy matching. Use `--list` to inspect recorded paths. This explicit CLI option authorizes that exact selection; it cannot be combined with `--all` or `--project`. The existing `--project <name-or-path>` CLI search remains unchanged.

The shared `exportArchive` contract accepts:

- `scope: "project", workspacePath`: exact workspace matching. `projectFilter` retains existing explicit search semantics when `workspacePath` is omitted.
- `scope: "recorded-project", recordedProjectPath`: exact recorded-path export.
- `scope: "recorded-project", onSelectRecordedProject`: interactive selection from the existing inventory.
- `onSelectRecordedProject` on project scope: optional recovery only after no match. It receives frozen `{ reason: "requested" | "no-match", projects }`; each project has `cwd`, `recordedPaths`, `sessionCount`, `sourceBytes`, `firstSessionAt` and `lastSessionAt`. Return one exact offered cwd after caller-side confirmation or `null`/`undefined` to cancel. Invented values fail with `INVALID_PROJECT_SELECTION`; cancellation throws `EXPORT_CANCELLED`. VS Code handles that as cancellation rather than success or failure.

There is no implicit all-session fallback or complete JSONL pass for the dialog. The normal **Current Workspace** path uses the same bounded metadata-only inventory and does not pay for historical-picker content parsing. A non-metadata type is rejected as soon as its top-level type is known. Confirmed first-record metadata is tokenized with bounded field accumulation rather than retained as one JSON value, so valid long `session_meta` records remain discoverable; the physical first record has a 16 MiB fail-closed byte cap and individual routing fields have smaller explicit limits. VS Code discovery is cancellable, and cancellation stops directory, index, or first-record scanning before any export begins. Source stability checks still apply after interactive selection; complete content is read only for sessions selected for an actual export.
