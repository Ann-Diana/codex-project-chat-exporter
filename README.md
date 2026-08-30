# Codex Project Chat Exporter

![Stacked Codex chat windows being exported to Markdown, HTML, and JSON formats](docs/assets/codex-project-chat-exporter-hero.png)

Export local active and archived Codex sessions into a portable, project-aware export folder for review, preservation, migration preparation, or privacy-reviewed project handoff.

[Codex 0.148.0](https://github.com/openai/codex/releases/tag/rust-v0.148.0) added [`/export`](https://github.com/openai/codex/pull/37358) for exporting the current TUI conversation to the clipboard or a Markdown file. Codex Project Chat Exporter serves a different workflow: it bulk-exports detected local sessions, including archived sessions, for one project or workspace or across all projects. It creates a static index and manifest, with optional Raw snapshots verified at export time. Use `/export` for the current TUI conversation; use this project to build a project-aware local collection through the CLI or the optional VS Code extension.

Core behavior:

- Sessions are grouped by their stored project/work directory.
- Moved or renamed workspaces can be recovered with **Choose recorded project path…**, an exact stored-path selection with confirmation; see [recorded project selection](docs/recorded-project-selection.md).
- Session content is processed on the machine running the exporter. The exporter includes no telemetry or built-in upload.
- Exports are one-way: sessions cannot be imported back into Codex.

> Unofficial project. Not affiliated with, endorsed by, or supported by OpenAI.

## What it exports

- Active sessions from `~/.codex/sessions`.
- Archived sessions from `~/.codex/archived_sessions`.
- All detected sessions or only one matching project/work folder.
- Markdown reading views distinguish direct user turns, assistant responses, subagent inputs, automatic runtime contexts, and unclassified user-role records. Canonical Raw events remain unchanged.
- A filterable local HTML index and a machine-readable manifest.
- A per-export content-addressed `assets/` store for reading-view-selected embedded attachments, with one file per unique SHA-256 and a provenance-aware usage manifest.
- Optional deterministic DOCX or PDF reading views, with exactly one document per exported session.
- Optional byte-preserving raw JSONL snapshots with an export-time SHA-256 verification.
- Recorded tool-call inputs and outputs can optionally be included in Markdown and selected DOCX or PDF reading views.
- Stored user steering inputs and assistant progress messages can be preserved even when the UI does not show them as ordinary chat messages. Roles and runtime context remain evidence-based; the exporter does not guess steering/progress labels from timing or hide `AGENTS.md`/environment records.
- Short Windows-friendly paths by default, with a readable-path option.

Codex Project Chat Exporter reads the project association stored in each session's `cwd`; the original project folder does not need to remain present.

## Why it is useful

Codex's locally stored JSONL event stream is detailed but inconvenient to browse directly. This exporter creates a static local folder that is easier to inspect, retain, move to another computer, or hand over with a project after a privacy review.

It is migration preparation, not a tested restore system. Raw snapshots and portable manifest metadata preserve material for possible future tooling, but no Codex import or roundtrip restore is implemented.

## What it looks like

<p>
  <img src="docs/screenshots/launcher-demo.png" alt="Interactive Windows launcher" width="49%">
  <img src="docs/screenshots/folder-structure-demo.png" alt="Generated export folder structure" width="49%">
</p>

![Synthetic Codex Project Chat Export Index with project grouping, session metadata, Markdown links and optional Raw links](docs/screenshots/index-html-demo.png)

All screenshots contain synthetic demo data only.

## Windows quick start

1. Download and extract the project ZIP.
2. Start `export-codex-project-chats.cmd`.
3. Choose what to export and select a new empty destination folder.

If Windows blocks the launcher, see the [FAQ](FAQ.md#windows-blocks-the-cmd-launcher-does-it-need-administrator-rights).

The launcher and CLI do not require administrator rights. Exporter 0.3.0 requires Node.js 22 or newer; the Windows launcher can also use one known bundled Codex Desktop Node runtime when that runtime meets the same requirement. Exporter 0.2.x is the final line for older Node.js versions, and Node.js 18 and 20 are no longer in the supported test matrix.

Exporter 0.3.0 uses a bounded streaming JSONL reader for CLI and Visual Studio Code exports. Embedded Base64 images are decoded, hashed, and written incrementally instead of being rebuilt as complete strings or buffers. Safe raster headers are linked from Markdown and HTML; unknown, active, or spoofed content is retained as a non-renderable `.bin` link. Invalid or truncated session records fail the export before a completed manifest is published; remote image references are never downloaded.

## CLI quick start

Export all detected local sessions:

```powershell
node .\bin\export-codex-project-chats.mjs --all --out C:\cx\codex-export
```

Export one project/work folder:

```powershell
node .\bin\export-codex-project-chats.mjs --project my-project --out C:\cx\my-project-export
```

Choose one profile:

- **Complete** (`--profile complete`, default): `raw/` checked at export time, deduplicated `assets/`, Markdown transcripts in `md/`, `index.html`, `index.md`, `manifest.json`, and `README.txt`.
- **Readable** (`--profile readable`): deduplicated `assets/`, Markdown transcripts and both indexes plus `manifest.json` and `README.txt`, without new Raw snapshots.
- **Source snapshots** (`--profile source-snapshots`): `raw/` checked at export time, deduplicated `assets/`, a reduced `index.html`, `manifest.json`, and `README.txt`, without Markdown transcripts or `index.md`.

All reading formats use one record-selection policy. Tool-only images follow `--include-tools`; structurally paired user/tool mirrors render once; equal images in separate genuine turns remain separate uses. **Readable** suppresses every `replacement_history` record from its derived views without changing the source. **Complete** retains unmatched compaction images under `Additional stored context` alongside the unchanged Raw snapshot.

Use **Readable** for browsing and searching exported transcripts. **Complete** and **Source snapshots** can be substantially larger and slower because they copy Raw JSONL and verify it with SHA-256.

Readable is also a typographically normalized reading view. In natural direct-user and assistant prose it changes EM DASH (`U+2014`) to EN DASH (`U+2013`), while preserving code, inline code, URLs, paths, filenames, identifiers, hashes, and conservatively recognized technical examples. It removes only structurally complete internal `<oai-mem-citation>` blocks emitted as standalone assistant metadata; incomplete, ambiguous, quoted, inline-code, fenced-code, and user-supplied literal forms remain visible. Unicode and Markdown list markers stay distinct, announced lists receive a modest block indent, and structural path trees retain their source lines in monospace. Complete, Source snapshots, and Raw JSONL retain source punctuation and internal metadata.

Show all CLI options:

```powershell
node .\bin\export-codex-project-chats.mjs --help
```

Add one DOCX per exported session to any profile:

```powershell
node .\bin\export-codex-project-chats.mjs --all --profile readable --format docx --out C:\cx\codex-export
```

Add one directly rendered PDF per exported session:

```powershell
node .\bin\export-codex-project-chats.mjs --all --profile readable --format pdf --out C:\cx\codex-export
```

For local performance diagnosis without message text or full paths, add `--performance-profile C:\cx\export-profile.json`. This diagnostic performs additional analysis, can substantially slow the export, and is not intended for normal exports.

The Node.js script runs on Windows, macOS, and Linux. The included `.cmd` launcher is Windows-only.

## Output structure

The default `complete` profile creates:

```text
cx-YYYYMMDD-HHMMSS\
├─ index.html
├─ index.md
├─ manifest.json
├─ README.txt
├─ assets\
│  ├─ <sha256>.<validated-extension>
│  └─ manifest.json
├─ md\
│  ├─ p001-project-a\s0001.md
│  └─ p002-project-b\s0002.md
├─ docx\                         # only with --format docx
│  ├─ p001-project-a\s0001.docx
│  └─ p002-project-b\s0002.docx
├─ pdf\                          # only with --format pdf
│  ├─ p001-project-a\s0001.pdf
│  └─ p002-project-b\s0002.pdf
└─ raw\
   ├─ p001-project-a\s0001.jsonl
   └─ p002-project-b\s0002.jsonl
```

`raw/` is omitted when raw export is disabled and the destination is new and empty. Reusing an output folder does not delete older files, so use a new empty destination for a clean result.

DOCX and PDF are each omitted unless their corresponding explicit `--format` selection is used. Only one optional document format is selected per run.

Readable-path exports use `markdown/` and longer timestamp/title-based filenames. Short paths remain the safer default for copying and unzipping on Windows.

When included, raw JSONL is the canonical byte-preserving representation. `raw_copy_status: VERIFIED_AT_EXPORT` and `raw_verified_at` record a completed export-time hash check, not continuing integrity; Raw files remain mutable, and `raw_sha256` supports later revalidation. Markdown and HTML are classified, derived reading views. See the [archive format version 1 specification](docs/archive-format-v1.md) for manifest fields, snapshot verification, event classification, and import limits.

## Privacy

> **Paranoid by design.** A small exporter with an unusually serious threat model.

- The application sends no telemetry, performs no built-in upload, and makes no application-level HTTP, web, or API calls.
- Configured filesystem paths can still point to network-backed storage. Mapped network drives cannot be identified reliably in every configuration.
- Markdown masking covers only some common token-shaped secrets and long base64-like values; it is best effort, not complete redaction.
- Markdown, DOCX, PDF, raw JSONL, HTML, both manifests, and files below `assets/` can contain confidential chats, local paths, names, runtime contexts, tool output, source code, and attachment data or references.
- Raw JSONL and the manifest are not share-safe by default.
- Review every generated file manually before sharing it.

See [SECURITY.md](SECURITY.md) for the security boundary.

## Limits

The exporter does not:

- export cloud-only Codex tasks without a local session file;
- export ordinary ChatGPT web conversations;
- import sessions or rebuild Codex UI state, indexes, project registration, or sidebar history;
- provide transcript full-text search inside `index.html`;
- fetch or copy remote and local-path attachment references (only embedded payloads are decoded into `assets/`);
- guarantee complete secret or personal-data removal;
- guarantee compatibility with future changes to Codex's internal JSONL format.

Complete and Readable HTML indexes filter metadata such as project, title, date, confirmed model history, and active/archived status. Consecutive duplicate runtime model values are collapsed; a multi-model session is shown chronologically as `gpt-5.5 → gpt-5.6-sol`. Models from separate subagent sessions are not merged into the parent. Source snapshots instead uses a reduced index with project, storage, start time, session ID, and Raw links; it has no title, model, or Markdown columns. Search transcript content from Complete or Readable in the Markdown files with an editor or a dedicated search tool.

## Experimental VS Code extension

The optional Visual Studio Code extension calls the same export core as the CLI. Its primary command first chooses **Current Workspace** or **All Sessions**, then **Complete export**, **Readable export**, or **Source snapshots**:

- `Codex Export: Export…`
- `Codex Export: Open Latest Export`
- `Codex Export: Open Export Folder`

The experimental extension is tested on Windows in local VS Code Desktop `file:` workspaces. Export and open commands reject untrusted windows, web, Remote SSH, WSL, Dev Container, and other non-local extension hosts. Other local desktop platforms are not explicitly blocked but remain unverified.

The extension requires Visual Studio Code 1.101 or newer.

Installation, settings, limitations, and packaged-candidate checks are documented in the [VS Code extension README](integrations/vscode/README.md) and [packaged VSIX test plan](integrations/vscode/PACKAGED_TEST_PLAN.md).

## More information

- [FAQ](FAQ.md) – launcher troubleshooting, session discovery, privacy, and operational details.
- [Archive format v1](docs/archive-format-v1.md) – canonical data, manifest, snapshots, classification, and import limits.
- [Deduplicated asset store](docs/asset-store.md) – type allowlist, manifest schema, publication, links, and failure behavior.
- [Shared document model and DOCX](docs/document-model-and-docx.md) – opt-in selection, OOXML safety, assets, reproducibility, and performance diagnostics.
- [DOCX dependency review](docs/docx-dependency-review.md) – exact package tree, licenses, runtime compatibility, scripts, network guard, and audit result.
- [Shared document model and PDF](docs/document-model-and-pdf.md) – direct rendering, fonts, links, assets, reproducibility, and cleanup.
- [PDF dependency review](docs/pdf-dependency-review.md) – complete production tree, licenses, Node support, offline gate, fonts, and audit result.
- [Packaged VSIX test plan](integrations/vscode/PACKAGED_TEST_PLAN.md) – installation and manual Extension Host checks.
- [Tests](tests) – synthetic helper, classification, integration, and adapter coverage.
- [Changelog](CHANGELOG.md) – release history.

Run the complete automated suite with `npm test`. Source-level adapter tests do not replace installing and exercising the built VSIX in a real Extension Host.

## License

MIT – see [LICENSE](LICENSE).
