# Moved and renamed projects

Codex records the working directory (`cwd`) in each session. A current workspace name is not a durable project identity. The VS Code adapter therefore matches the current workspace path exactly and never guesses from similar folder names or silently includes descendants.

In **Codex Export: Export…**, choose **Choose recorded project path…**, the export profile and optional document format. The picker displays each distinct first-record `cwd`, retained session count, total source bytes and latest first-record session timestamp. Discovery streams only the first physical JSONL record and accepts `session_meta` or `turn_context` metadata there; a later conversation record is never inspected to recover a path. Active-over-archive duplicate-session preference still applies, so duplicate copies are not counted twice.

A workspace export without a match explains that the folder may have moved or been renamed, and offers the same picker. Selecting a path different from the current workspace requires **Export recorded sessions** in a modal confirmation: all sessions under that historical cwd will be exported, and several logically distinct projects can be mixed there. Dismissing any step creates no export, changes no remembered completed-export state and selects nothing automatically. An empty output directory may already have been created for filesystem preflight.

Recorded paths are selection data, not files to open or search. No alias is saved; no preview/workspace resources are collected. There is no per-session picker yet. Existing local/trusted-desktop restrictions still apply.

## CLI and shared API

`--recorded-project <cwd>` selects one verbatim recorded path, without basename, descendant or fuzzy matching. Use `--list` to inspect recorded paths. This explicit CLI option authorizes that exact selection; it cannot be combined with `--all` or `--project`. The existing `--project <name-or-path>` CLI search remains unchanged.

The shared `exportArchive` contract accepts:

- `scope: "project", workspacePath`: exact workspace matching. `projectFilter` retains existing explicit search semantics when `workspacePath` is omitted.
- `scope: "recorded-project", recordedProjectPath`: exact recorded-path export.
- `scope: "recorded-project", onSelectRecordedProject`: interactive selection from the existing inventory.
- `onSelectRecordedProject` on project scope: optional recovery only after no match. It receives frozen `{ reason: "requested" | "no-match", projects }`; each project has `cwd`, `sessionCount`, `sourceBytes`, `lastSessionAt`. Return one exact offered cwd after caller-side confirmation, or `null`/`undefined` to cancel. Invented values fail with `INVALID_PROJECT_SELECTION`; cancellation throws `EXPORT_CANCELLED`. VS Code handles that as cancellation, not success or failure.

There is no implicit all-session fallback or complete JSONL pass for the dialog. The normal **Current Workspace** path uses the same bounded metadata-only inventory and does not pay for historical-picker content parsing. First-record metadata is capped at 1 MiB; a non-metadata type is rejected as soon as its top-level type is known. VS Code discovery is cancellable, and cancellation stops directory, index, or first-record scanning before any export begins. Source stability checks still apply after interactive selection; complete content is read only for sessions selected for an actual export.
