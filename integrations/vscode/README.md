# Codex Project Chat Exporter for Visual Studio Code

Experimental Visual Studio Code interface for Codex Project Chat Exporter.

The exporter remains IDE-agnostic. The extension only provides native VS Code commands and calls the same local export core used by the CLI.

Exporter 0.3.0 requires Node.js 22 or newer. The extension requires Visual Studio Code 1.101 or newer. Exporter 0.2.x remains the final line for older Node.js versions; Node.js 18 and 20 are no longer part of the supported test matrix.

The extension and CLI use the same productive bounded JSONL reader and deduplicated asset store. Embedded Base64 images are streamed, hashed, and written with bounded blocks; validated raster assets use relative reading-view links, unsafe or unknown types remain non-renderable files, invalid records fail closed, and remote references are not fetched.

Unlike Codex's native TUI `/export`, the extension can export the current VS Code workspace or all detected local sessions through a native VS Code workflow.

## Features

- **Current Workspace** exports detected active and archived sessions associated with the currently opened local workspace.
- **All Sessions** exports all detected active and archived sessions from the configured Codex home.
- Choose scope and export profile from two native Quick Picks.
- Open the latest generated HTML index.
- Open the folder from the last successfully completed and recorded export.
- Show throttled phase and `Processing session X of Y` progress, success messages, warnings, and technical details in the `Codex Project Chat Exporter` output channel.

The VS Code extension scans both active and archived Codex session stores. Export profiles change the generated output, not which session stores are scanned.

## Installation

The extension is currently distributed as a `.vsix` file and is not yet available in the VS Code Marketplace.

1. Download [`codex-project-chat-exporter-vscode-0.1.3.vsix`](https://github.com/Ann-Diana/codex-project-chat-exporter/releases/download/v0.2.0/codex-project-chat-exporter-vscode-0.1.3.vsix) from the GitHub release.
2. Open VS Code Desktop.
3. Open the Extensions view with `Ctrl+Shift+X`.
4. Select `…` in the upper-right corner.
5. Choose **Install from VSIX…**.
6. Select the downloaded file and reload VS Code if prompted.

Alternatively, install it from a terminal:

```powershell
code --install-extension "C:\path\to\codex-project-chat-exporter-vscode-0.1.3.vsix"
```

## Commands

- `Codex Export: Export…` – choose **Current Workspace** or **All Sessions**, then select an export profile.
- `Codex Export: Open Latest Export`
- `Codex Export: Open Export Folder`

## Export profiles

- **Complete export** creates deduplicated assets, Markdown reading views, indexes, manifests, and Raw snapshots verified at export time.
- **Readable export** creates deduplicated assets, Markdown reading views, indexes, and manifests without new Raw snapshots.
- **Source snapshots** creates deduplicated assets, Raw snapshots verified at export time, a reduced HTML index, and manifests without Markdown transcripts.

## Settings

- **Output Directory** – local folder for generated exports. If empty, the extension asks on the first export.
- **Codex Home** – optional location of the local Codex data. If empty, the extension uses `CODEX_HOME` or the default `.codex` folder.
- **Path Style** – choose compact or longer readable filenames.
- **Include Tools** – include recorded tool-call inputs and outputs in Markdown. This data can be sensitive.
- **Diagnostic Output** – add redacted timing details to the output channel for troubleshooting.

Output Directory and Codex Home must be local absolute paths and must be configured as User settings. Network, device, Workspace, and Workspace Folder paths are not supported.

## Privacy

All processing stays on the machine running the extension. The extension adds no telemetry or built-in upload and works only in trusted local VS Code Desktop windows.

Exports can contain sensitive chats, local paths, runtime contexts, tool output, decoded asset files, and attachment data or references. Raw JSONL, both manifests, and `assets/` are not share-safe by default. The output channel also shows local export paths.

Raw hashes verify snapshots at export time only. Raw files remain mutable and must be hashed again before any later integrity-sensitive use. See the [FAQ](https://github.com/Ann-Diana/codex-project-chat-exporter/blob/main/FAQ.md), [security policy](https://github.com/Ann-Diana/codex-project-chat-exporter/blob/main/SECURITY.md), and [archive format specification](https://github.com/Ann-Diana/codex-project-chat-exporter/blob/main/docs/archive-format-v1.md) for details.

## Tested configuration

Tested with Visual Studio Code Desktop on Windows, local `file:` workspaces, and local Codex session data. Remote and web Extension Hosts are not supported. Other local desktop platforms have not been verified.

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

The automated tests use synthetic data. Before release, install the built VSIX in VS Code and follow [`PACKAGED_TEST_PLAN.md`](PACKAGED_TEST_PLAN.md).
