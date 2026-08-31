# Codex Project Chat Exporter for Visual Studio Code

Turn local Codex project history into independent, portable archives – including editable Word documents and searchable PDFs.

> **To our knowledge, the only Codex session exporter with built-in DOCX and PDF output.**
>
> Based on publicly documented exporter features reviewed on 31 August 2026.

- Export the current workspace, another recorded project or all local sessions.
- Get Markdown, responsive HTML, manifests and optional verified source snapshots.
- Add DOCX, PDF or both from the same readable document model.
- Local and read-only toward original Codex data. No telemetry, import or repair.

The extension is a local VS Code interface for the direct CLI's core. It requires VS Code 1.101 or newer and packages the production runtime.

## Installation

The extension is distributed as a VSIX, not through the Visual Studio Code Marketplace.

1. Obtain the VSIX from a published release or an explicitly supplied acceptance build.
2. Open local VS Code Desktop.
3. Open Extensions with `Ctrl+Shift+X`.
4. Select `…`, then **Install from VSIX…**.
5. Select the VSIX and reload if prompted.

Terminal installation uses:

```powershell
code --install-extension "C:\path\to\codex-project-chat-exporter-vscode-0.1.3.vsix" --force
```

## Exact export flow

Run `Codex Export: Export…`. The extension performs these stages in order:

1. **Scope** – choose one of the three options below.
2. **Metadata association** – bounded first-record discovery maps local sessions to stored `cwd` values.
3. **Historical confirmation when required** – a different recorded path is selected and confirmed.
4. **Profile** – choose Complete, Readable or Source snapshots.
5. **Document formats** – choose one of the four options below.
6. **Output folder** – use the configured local folder or choose one.
7. **Export** – the shared core creates and verifies the generation.

- **Current Workspace** – export sessions whose stored absolute path identity equals the open local workspace.
- **Project from Codex history…** – choose one exact path identity from stored Codex metadata.
- **All Sessions** – export all detected active and archived local sessions.

- **Standard formats only**
- **Add DOCX**
- **Add PDF**
- **Add DOCX and PDF**

Each optional document is per session. PDF is rendered directly from the shared document model and never through DOCX.

**Scope and discovery:** **Current Workspace** uses the VS Code folder path and compares it with the first-record `cwd` by exact lexical identity. Windows drive-letter case, slash direction, trailing separators and equivalent local `\\?\` drive or UNC forms are normalized. There is no basename, substring, descendant, `realpath`, filesystem-existence or fuzzy fallback.

Bounded discovery reads first-record metadata, not later conversation records or arbitrary workspace files. **Project from Codex history…** shows counts, source bytes, dates and stored spelling variants for each identity. The old path need not exist, while selecting a different recorded path requires confirmation.

If Current Workspace has no exact match, the extension says:

> No sessions were recorded for the current workspace folder. The project may have been moved, renamed or opened from another folder.

The user can then open the historical picker. There is no automatic fuzzy or all-session fallback. Cancelling a picker does not call the core or update the last completed export. The folder is created only when an export actually starts.

See [Moved and renamed projects](../../docs/recorded-project-selection.md) for the bounded identity contract.

## Export profiles

- **Complete export** creates Markdown reading views, full indexes, both manifests, deduplicated assets and verified Raw JSONL. Unmatched `replacement_history` can appear under `Additional stored context`.
- **Readable export** creates Markdown reading views, full indexes, both manifests and deduplicated assets without new Raw JSONL. It suppresses `replacement_history` from derived views.
- **Source snapshots** creates verified Raw JSONL, a reduced responsive HTML index, both manifests and deduplicated assets without Markdown transcripts. Explicit DOCX or PDF uses the labelled forensic stored-context policy.

The profile controls standard output. The format picker only adds DOCX, PDF or both.

## Settings

- **Output Directory** (`codexProjectChatExporter.outputDirectory`) – absolute local destination. If empty, the extension asks before export.
- **Codex Home** (`codexProjectChatExporter.codexHome`) – optional absolute local Codex data directory. If empty, the extension uses `CODEX_HOME` or the default local `.codex` folder.
- **Path Style** (`codexProjectChatExporter.pathStyle`) – `short` or `readable` path and filename presentation. It is not an export profile.
- **Include Tools** (`codexProjectChatExporter.includeTools`) – include Tool, Browser and `view_image` records plus their selected assets in Markdown, responsive HTML, DOCX and PDF reading views. Verified mirror pairs still render once. Raw JSONL is unchanged.
- **Diagnostic Output** (`codexProjectChatExporter.diagnosticOutput`) – write message-free and path-redacted timing diagnostics to the output channel for one troubleshooting run.

Output Directory and Codex Home are machine-local settings. The adapter requires absolute local paths and rejects web, remote, UNC and Windows device locations. Workspace and Workspace Folder values for those settings are not accepted.

## Links, images and active content

Validated embedded PNG and JPEG images can be included in DOCX and PDF. GIF, WebP and `.bin` use labelled attachment references there. The extension does not fetch remote resources or collect workspace preview files.

Bounded canonical HTTP and HTTPS links can remain clickable. DOCX blocks external image or media relationships, local schemes, macros and active content. PDF blocks external images, file or launch actions, JavaScript, forms and embedded files.

The PDF renderer uses repository-local hash-verified Noto text, monospace, symbol and monochrome emoji fonts. A valid unsupported grapheme receives one visible marker listing its code points rather than disappearing silently.

## Cancellation and incomplete output

The progress notification is cancellable and forwards one abort signal to the shared core. Discovery, streaming, asset processing, document loops and publication check it. A synchronous third-party packaging call cannot be interrupted inside the call, so the core checks immediately before and after it.

Cancellation before publication leaves no regular result. Cancellation or failure after a multi-session or multi-format generation starts can leave `EXPORT_INCOMPLETE.txt`. That marker invalidates the whole folder as a completed archive. Run-owned temporary files are cleaned and unrelated existing files are not deleted.

## Commands

- `Codex Export: Export…`
- `Codex Export: Open Latest Export`
- `Codex Export: Open Export Folder`

Open commands use only the last successfully completed export state and revalidate the local target before opening it.

## Privacy

The extension adds no telemetry, uploader or application-level remote content fetch. It works only in trusted local VS Code Desktop windows.

Exports can contain private messages, usernames, absolute paths, runtime context, steering input, unclassified source records, source code, tool output and attachments. Raw JSONL, both manifests and `assets/` are not automatically safe to share. The normal output channel also shows local export paths. Review every generated file before sharing.

A configured path can still point to network-backed storage through operating-system mapping that the application cannot identify reliably. No claim is made that the operating system blocks every network filesystem case.

## Tested configuration and limits

Manual extension acceptance covers local VS Code Desktop on Windows with local `file:` workspaces and local Codex session data. Remote or web Extension Hosts are not supported. Other local desktop platforms are not explicitly blocked, but Linux and macOS manual acceptance is not claimed.

There is no session import, cloud-only task export, per-session JSON document or independent Raw setting. Complete Raw snapshots are source-faithful and still require privacy review.

## Development and packaged checks

From the repository root:

```powershell
npm test
node --test
node .\integrations\vscode\scripts\build-vsix.mjs
```

Automated tests use synthetic data. Before release, install a regular VSIX and follow the [packaged VSIX test plan](PACKAGED_TEST_PLAN.md).

Also see the root [README](../../README.md), [FAQ](../../FAQ.md), [security policy](../../SECURITY.md) and [archive format specification](../../docs/archive-format-v1.md).
