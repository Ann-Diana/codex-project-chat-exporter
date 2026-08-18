# Codex Project Chat Exporter for Visual Studio Code

Experimental Visual Studio Code interface for Codex Project Chat Exporter.

The exporter remains IDE-agnostic. The extension only provides native VS Code commands and calls the same local export core used by the CLI.

## Features

- Export the currently opened local workspace.
- Export all detected local Codex sessions, including archived sessions when present.
- Choose scope and export profile from two native Quick Picks.
- Open the latest generated HTML index.
- Open the configured or last used export folder.
- Show throttled phase and `Processing session X of Y` progress, success messages, warnings, and technical details in the `Codex Project Chat Exporter` output channel.

## Installation

Build or obtain the current `.vsix` candidate, then install it locally in VS Code Desktop:

```powershell
code --install-extension <absolute-vsix-path> --force
```

If `code` is not on PATH, use VS Code's Extensions view and choose `Install from VSIX...`.

## Commands

- `Codex Export: Export…` — choose **Current Workspace** or **All Sessions**, then **Complete export**, **Readable export**, or **Source snapshots**.
- `Codex Export: Open Latest Export`
- `Codex Export: Open Export Folder`

The extension keeps the older direct-command IDs registered for compatibility, but they are not shown in the Command Palette. Use **Export…** for normal exports.

## Settings

- `codexProjectChatExporter.outputDirectory`: absolute local export folder in VS Code User settings. Workspace and Workspace Folder values are rejected. UNC and Windows device paths are rejected; mapped network drives cannot be identified portably and are not claimed to be detected. If empty, the extension asks on first export and remembers the selected folder.
- `codexProjectChatExporter.codexHome`: optional absolute local Codex home folder in VS Code User settings. Workspace and Workspace Folder values are rejected. Empty uses `CODEX_HOME` or the default local `.codex` folder.
- **Export…** asks for one of three profiles on every run:
  - **Complete** creates `raw/` checked at export time, Markdown transcripts, `index.html`, `index.md`, `manifest.json`, and `README.txt`.
  - **Readable** creates Markdown transcripts, both indexes, `manifest.json`, and `README.txt` without new Raw snapshots.
  - **Source snapshots** creates `raw/` checked at export time, a reduced `index.html`, `manifest.json`, and `README.txt` without Markdown transcripts or `index.md`.
- `codexProjectChatExporter.pathStyle`: defaults to `short` (`md/` and compact filenames); `readable` uses `markdown/` and longer timestamp/title-based filenames.
- `codexProjectChatExporter.includeTools`: defaults to `false`; include tool call input/output in Markdown. Tool data can be sensitive.
- `codexProjectChatExporter.diagnosticOutput`: defaults to `false`; enable only for a troubleshooting run that needs message-free, path-redacted phase timing in the output channel. Short IDs, sizes, phases, status, and timing values remain visible. Normal exports show only a concise runtime summary.

The normal output channel records complete output-directory, HTML-index, and manifest paths. Treat it as local operational output, not as a share-safe report.

## Privacy

The extension works only in a trusted local desktop window. **Current Workspace** needs at least one local `file:` workspace folder; **All Sessions** can run without an open folder. Export and open commands are blocked while the current window is untrusted. The extension adds no telemetry or built-in upload and makes no application-level HTTP, web, or API calls. It stores the chosen output folder and latest HTML index path in VS Code global state only after a successful export.

The application-scoped `outputDirectory` and `codexHome` settings reject Workspace and Workspace Folder values at runtime. UNC and Windows device paths are rejected. Avoid mapped network drives because they cannot be identified reliably in every configuration without platform-specific dependencies.

The adapter rejects a second simultaneous export command, and the shared core rejects concurrent exports to the same destination.

Generated exports can contain sensitive chats, absolute local paths, runtime contexts, tool output, and attachment data or references. Raw JSONL and `manifest.json` are not share-safe by default.

The extension delegates classification, masking, snapshot integrity, and manifest generation to the shared exporter core. See the [FAQ](https://github.com/Ann-Diana/codex-project-chat-exporter/blob/main/FAQ.md) and [archive format version 1 specification](https://github.com/Ann-Diana/codex-project-chat-exporter/blob/main/docs/archive-format-v1.md).

For included Raw files, `raw_copy_status`, `raw_verified_at`, and `raw_sha256` record the export-time check. Raw files remain mutable; any later use or future importer must hash the current file again and reject a mismatch.

## Tested configuration

The experimental extension has been tested with:

- Visual Studio Code Desktop
- Windows
- local `file:` workspaces
- local Codex session data on disk

Export and open commands reject vscode.dev, github.dev, Remote SSH, WSL workspaces, Dev Containers, and other remote or web Extension Hosts. Current Workspace also rejects virtual or non-`file:` workspaces. The adapter does not contain a separate operating-system gate, so other local VS Code Desktop platforms are unverified rather than explicitly rejected. JetBrains, Cursor, and Windsurf are outside this extension's host scope.

## Uninstallation

Uninstall the extension from VS Code's Extensions view. Exported folders are not removed automatically.

## Development and Testing

From the repository root:

```powershell
node .\tests\exporter-helpers.test.mjs
node .\tests\event-classification.test.mjs
node .\tests\exporter-integration.test.mjs
node .\integrations\vscode\tests\extension-adapter.test.mjs
node .\integrations\vscode\scripts\build-vsix.mjs
```

The automated tests use synthetic temporary data only. Adapter tests prove delegation to the shared core but do not replace installing and exercising the packaged VSIX in a real Extension Host. Follow [`PACKAGED_TEST_PLAN.md`](PACKAGED_TEST_PLAN.md) for the packaged-candidate check.
