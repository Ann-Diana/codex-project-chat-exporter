# Codex Project Chat Exporter

![Stacked Codex chat windows being exported to Markdown, HTML, and JSON formats](docs/assets/codex-project-chat-exporter-hero.png)

Export local active and archived Codex sessions into a portable, project-aware export folder for review, preservation, migration preparation, or privacy-reviewed project handoff.

Codex's currently observed experimental `/export` exports one conversation. Codex Project Chat Exporter instead creates a project-aware local bulk export of detected active and archived sessions with an index, manifest, and optional verified raw snapshots. The two functions are complementary, and the native experiment may evolve.

- Sessions are grouped by their stored project/work directory.
- Three profiles cover complete exports, reading views without Raw, and verified source snapshots without transcripts.
- Processing stays local. The application sends no telemetry and makes no network requests.
- It does not import sessions back into Codex.

> Unofficial project. Not affiliated with, endorsed by, or supported by OpenAI.

## What it exports

- Active sessions from `~/.codex/sessions`.
- Archived sessions from `~/.codex/archived_sessions`.
- All detected sessions or only one matching project/work folder.
- Classified Markdown reading views for direct user turns, assistant responses, subagent inputs, runtime contexts, and uncertain user-role records.
- A filterable local HTML index and a machine-readable manifest.
- Optional verified raw JSONL snapshots that preserve the exported source bytes unchanged.
- Optional tool-call input and output in Markdown.
- Short Windows-friendly paths by default, with a readable-path option.

Codex Project Chat Exporter reads the project association stored in each session's `cwd`; the original project folder does not need to remain present.

## Why it is useful

Codex's local JSONL event logs are complete source material but inconvenient to browse directly. This exporter creates a static local folder that is easier to inspect, retain, move to another computer, or hand over with a project after a privacy review.

It is migration preparation, not a tested restore system. Raw snapshots and portable manifest metadata preserve material for possible future tooling, but no Codex import or roundtrip restore is implemented.

## What it looks like

![Filterable HTML export index](docs/screenshots/index-html-demo.png)

<p>
  <img src="docs/screenshots/launcher-demo.png" alt="Interactive Windows launcher" width="49%">
  <img src="docs/screenshots/folder-structure-demo.png" alt="Generated export folder structure" width="49%">
</p>

All screenshots contain synthetic demo data only.

## Windows quick start

1. Download and extract the project ZIP.
2. Start `export-codex-project-chats.cmd`.
3. Choose what to export and select a new empty destination folder.

If Windows blocks the launcher, see the [FAQ](FAQ.md#windows-blocks-the-cmd-launcher-does-it-need-administrator-rights).

The launcher and CLI do not require administrator rights. The CLI requires Node.js 18 or newer; the Windows launcher can also use one known bundled Codex Desktop Node runtime when available.

## CLI quick start

Export all detected local sessions:

```powershell
node .\bin\export-codex-project-chats.mjs --all --out C:\cx\codex-export
```

Export one project/work folder:

```powershell
node .\bin\export-codex-project-chats.mjs --project my-project --out C:\cx\my-project-export
```

Choose one profile. The legacy `--no-raw` switch remains shorthand for `readable` when no explicit profile is supplied:

- **Complete** (`--profile complete`, default): verified `raw/`, Markdown transcripts in `md/`, `index.html`, `index.md`, `manifest.json`, and `README.txt`.
- **Readable** (`--profile readable`): Markdown transcripts and both indexes plus `manifest.json` and `README.txt`, without new Raw snapshots.
- **Source snapshots** (`--profile source-snapshots`): verified `raw/`, a reduced `index.html`, `manifest.json`, and `README.txt`, without Markdown transcripts or `index.md`.

Show all list, diagnosis, profile, tool, path, and raw-output options:

```powershell
node .\bin\export-codex-project-chats.mjs --help
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
├─ md\
│  ├─ p001-project-a\s0001.md
│  └─ p002-project-b\s0002.md
└─ raw\
   ├─ p001-project-a\s0001.jsonl
   └─ p002-project-b\s0002.jsonl
```

`raw/` is omitted when raw export is disabled and the destination is new and empty. Reusing an output folder does not delete older files, so use a new empty destination for a clean result.

Future Word, PDF, and extracted-attachment formats are not implemented or selectable.

Readable-path exports use `markdown/` and longer timestamp/title-based filenames. Short paths remain the safer default for copying and unzipping on Windows.

When included, raw JSONL is the canonical byte-preserving representation. Markdown and HTML are classified, derived reading views. See the [archive format version 1 specification](docs/archive-format-v1.md) for manifest fields, snapshot integrity, event classification, and import limits.

## Privacy

- All processing is local.
- The application itself sends no telemetry and makes no network requests.
- Markdown masking covers only some common token-shaped secrets and long base64-like values; it is best effort, not complete redaction.
- Markdown, raw JSONL, HTML, and `manifest.json` can contain confidential chats, local paths, names, runtime contexts, tool output, source code, and attachment data or references.
- Raw JSONL and the manifest are not share-safe by default.
- Review every generated file manually before sharing it.

See [SECURITY.md](SECURITY.md) for the security boundary.

## Limits

The exporter does not:

- export cloud-only Codex tasks without a local session file;
- export ordinary ChatGPT web conversations;
- import sessions or rebuild Codex UI state, indexes, project registration, or sidebar history;
- provide transcript full-text search inside `index.html`;
- extract image attachments into separate files;
- guarantee complete secret or personal-data removal;
- guarantee compatibility with future changes to Codex's internal JSONL format.

The HTML index filters metadata such as project, title, date, model, and active/archived status. Search transcript content in the Markdown files with an editor or a dedicated search tool.

## Experimental VS Code extension

The optional Visual Studio Code extension calls the same export core as the CLI. Its primary command first chooses **Current Workspace** or **All Sessions**, then **Complete export**, **Readable export**, or **Verified source snapshots**:

- `Codex Export: Export…`
- `Codex Export: Open Latest Export`
- `Codex Export: Open Export Folder`

The candidate is tested on Windows in local VS Code Desktop `file:` workspaces. Export commands reject web, Remote SSH, WSL, Dev Container, and other non-local extension hosts or non-`file:` workspaces. Other local desktop platforms are not explicitly blocked but remain unverified.

Installation, settings, limitations, and packaged-candidate checks are documented in the [VS Code extension README](integrations/vscode/README.md) and [packaged VSIX test plan](integrations/vscode/PACKAGED_TEST_PLAN.md).

## More information

- [FAQ](FAQ.md) — launcher troubleshooting, session discovery, privacy, and operational details.
- [Archive format v1](docs/archive-format-v1.md) — canonical data, manifest, snapshots, classification, and import limits.
- [Packaged VSIX test plan](integrations/vscode/PACKAGED_TEST_PLAN.md) — installation and manual Extension Host checks.
- [Tests](tests) — synthetic helper, classification, integration, and adapter coverage.
- [Changelog](CHANGELOG.md) — release history.

Run the complete automated suite with `npm test`. Source-level adapter tests do not replace installing and exercising the built VSIX in a real Extension Host.

## Version and license

Current version: `0.1.0`

MIT — see [LICENSE](LICENSE).
