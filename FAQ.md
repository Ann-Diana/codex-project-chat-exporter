# FAQ

## Where does Codex store local sessions?

The default locations currently observed are:

- active sessions: `~/.codex/sessions`
- archived sessions: `~/.codex/archived_sessions`
- thread-name index: `~/.codex/session_index.jsonl`

On Windows, `~` normally means `C:\Users\<you>`.

These paths and file formats are internal Codex implementation details and may change.

## Windows blocks the `.cmd` launcher. Does it need administrator rights?

No. The exporter does not require administrator rights.

A ZIP downloaded from the internet can carry Windows' Mark of the Web. Extracted `.cmd` files may inherit that mark and be blocked by Smart App Control or Attachment Manager before the launcher starts.

Preferred fix:

1. Delete the already extracted folder.
2. Right-click the downloaded ZIP, choose **Properties**, select **Unblock** / **Zulassen**, and apply the change.
3. Extract the ZIP again.

Alternatively, unblock an existing extracted folder from PowerShell:

```powershell
Get-ChildItem .\codex-project-chat-exporter -Recurse -File | Unblock-File
```

Review downloaded code before unblocking it. Do not disable Smart App Control and do not use **Run as administrator** as the normal workaround.

## Why is an archived chat not shown as a separate project under `--list`?

`--list` shows unique project/work folders, grouped by the stored `cwd`. Active and archived sessions with the same `cwd` therefore appear on one line with separate counts. The chat title is not used for this grouping.

For Windows users, double-click `export-codex-project-chats.cmd` and choose:

```text
[4] List every detected session
```

CLI users can run:

```powershell
node .\bin\export-codex-project-chats.mjs --list-sessions
```

Do not paste that command into the `.cmd` file. The numbered launcher menu already invokes it.

If an archived JSONL file exists but is still absent, choose launcher option:

```text
[5] Diagnose active and archived session detection
```

The diagnostic output shows the exact archived-session folder, the number of JSONL files found, and files with incomplete metadata. The exporter also recovers IDs from normal rollout filenames so that an archived file is not silently discarded merely because its `session_meta` record is missing or malformed.

Duplicate active and archived copies with the same session ID are shown once. The active copy takes precedence because both files represent the same Codex session. Different IDs are never deduplicated merely because their titles are identical.

## Does the exporter upload anything?

No built-in uploader, telemetry, or application-level HTTP, web, or API client is used. The exporter reads source files and writes to the configured filesystem destination.

A configured path can still reside on network-backed storage. The VS Code extension rejects UNC and Windows device paths, but mapped network drives cannot be identified reliably in every configuration. Choose a known local destination when locality matters.

## How does this differ from Codex's native `/export`?

[Codex 0.148.0](https://github.com/openai/codex/releases/tag/rust-v0.148.0) added [`/export`](https://github.com/openai/codex/pull/37358) for exporting the current TUI conversation to the clipboard or a Markdown file. It is the better fit when one current TUI conversation is the intended result.

Codex Project Chat Exporter instead bulk-exports detected local sessions for one project/work folder or across all projects, including archived sessions. It creates a static index, manifest, and optional Raw snapshots verified at export time. Its optional VS Code extension provides the corresponding **Current Workspace** and **All Sessions** workflows. It does not try to improve upon the native export's transcript fidelity.

## Does it export both active and archived sessions?

Yes, by default. Use `--no-archived` to scan only the active sessions directory.

Custom locations can be supplied with:

```text
--sessions-dir <dir>
--archived-dir <dir>
```

## Why can the export contain more sessions than the Codex UI shows?

The exporter scans local session files directly. A valid local rollout file can exist even when the current UI filters, groups, hides, or no longer lists the corresponding thread.

## How are sessions assigned to projects?

The exporter uses the working directory (`cwd`) stored in the session metadata. The original project folder does not need to exist during export.

## Where do titles come from?

The exporter checks `session_index.jsonl`, but does not automatically trust an indexed title that appears to have been derived from a technical context record. It validates the title against classified session events, otherwise derives a display title from the first confirmed direct user turn or uses a neutral deterministic fallback.

Derived titles are only export labels. They do not modify Codex.

## What is the difference between the Markdown view and `raw/`?

`md/` in short-path exports, or `markdown/` in readable-path exports, contains classified reading views. Confirmed direct user turns, subagent inputs, assistant messages, runtime contexts, and uncertain user-role records are labelled separately. Tool details are omitted unless `--include-tools` is used.

When enabled, `raw/` contains byte-identical JSONL snapshots checked against stable source hashes during export and is the canonical lossless representation. Markdown and HTML are derived views, and classification never changes raw events. Raw filenames may be collision-safe export names; `manifest.json` preserves the portable source mapping and verification metadata.

`raw_verified_at` records when the `VERIFIED_AT_EXPORT` hash check completed. It does not assert continuing integrity: Raw files remain mutable afterward, so compare their current hash with `raw_sha256` to detect changes. Any future importer must repeat that check and reject mismatches. This is not permanent tamper resistance, sealing, or import readiness.

Both raw files and the manifest can contain sensitive local data. See the [archive format version 1 specification](docs/archive-format-v1.md) for snapshot fields, event pairing, attachment identity, fail-safe classification, and import limits.

## Does Markdown secret masking make the files safe to share?

No. The redaction patterns catch only some common token-shaped secrets and long base64-like values.

They do not reliably remove paths, names, email addresses, IP addresses, customer data, source code, proprietary information, or every credential format.

## Why is an empty `raw/` folder still present after using `--no-raw`?

A previous manifest describes archive membership but is not trusted as proof that files may be deleted or replaced. An unchanged repetition can reuse byte-identical verified files; differing pre-existing files cause the new generation to fail closed, and files no longer needed by the new export remain untouched. If a run fails after generation changes begin, `EXPORT_INCOMPLETE.txt` remains and invalidates the manifest and indexes until the folder is manually reviewed or replaced with a new empty destination.

## Which export profile should I use?

- **Complete** (`complete`) is the default and creates `raw/` checked at export time, Markdown transcripts, `index.html`, `index.md`, `manifest.json`, and `README.txt`.
- **Readable** (`readable`) creates Markdown transcripts, both indexes, `manifest.json`, and `README.txt` without new Raw snapshots.
- **Source snapshots** (`source-snapshots`) creates `raw/` checked at export time, a reduced `index.html`, `manifest.json`, and `README.txt` without Markdown transcripts or `index.md`. The reduced index uses project, storage, start time, session ID, and Raw links rather than unavailable title or model metadata.

Use **Readable** when the goal is reading or searching transcripts without creating new Raw snapshots. **Complete** and **Source snapshots** can be substantially larger and slower because they copy Raw JSONL and verify it with SHA-256.

An explicit CLI `--profile` wins over the legacy switch. Without an explicit profile, CLI `--no-raw` is only a compatibility shorthand for `readable`. The VS Code extension asks for the profile and optional document format on every central-menu export.

## How do I create DOCX files?

Add `--format docx` to a CLI export, or choose **Add DOCX** after the VS Code scope and profile selections. DOCX is opt-in and adds exactly one document per session; it never creates one combined document. PNG and JPEG assets are embedded, while GIF, WebP, and `.bin` files are shown as attachment references. PDF is not implemented or selectable.

DOCX is a derived reading view, not a canonical snapshot. Valid bounded HTTP/HTTPS links use controlled external hyperlink relationships, but external image/media/resource relationships and active content are forbidden. The exporter does not download remote resources; `file:`, UNC/device, `javascript:`, `data:`, unsupported, invalid, and overlong targets remain non-clickable text. See [Shared document model and DOCX](docs/document-model-and-docx.md).

## How can I diagnose a slow export without logging chat content?

Add `--performance-profile <absolute-json-file>` to a CLI export only when diagnosing performance. It performs additional analysis, can substantially slow the export, and is not intended for normal exports. The privacy-reduced JSON profile records phase times, byte counts, shortened session IDs, sampled RSS, attachment counts/volumes, and snapshot retries, but no message text, full source/output/attachment paths, URLs, or attachment payloads. It distinguishes data URLs, signature-confirmed unprefixed PNG/JPEG Base64, local references, remote references, and unknown forms. Shortened IDs and operational metadata can still be sensitive, so review the file before sharing it.

The optional VS Code diagnostic output follows the same message-free, path-redacted model and is disabled by default. The normal VS Code output channel is different: it records complete output, HTML-index, and manifest paths for usability and can therefore contain sensitive local paths.

Processing is scoped one session at a time. The bounded streaming reader incrementally decodes embedded attachments instead of materializing a complete Base64 value. Ordinary message text remains a complete string for the current record, so a single unusually large non-attachment text value can still determine peak memory.

## Why does the exporter refuse an output folder?

It refuses to write into its own tool/repository directory by default. This reduces the risk of committing private exports to GitHub.

Choose another folder, for example:

```powershell
node .\bin\export-codex-project-chats.mjs --all --out C:\cx\codex-export
```

For deliberate local testing only, use `--allow-output-in-tool-dir`.

The exporter also rejects a destination that overlaps a source directly or through a supported alias/link check. A per-folder `.codex-export.lock` prevents two exports from writing to the same destination concurrently.

If a lock remains after a crash, do not delete the output folder or perform recursive cleanup. First ensure no export process is running, inspect the PID and start time stored in `.codex-export.lock`, and remove only that confirmed stale lock file.

## PowerShell says `node` was not found. What now?

Install Node.js 18 or newer, or use the Windows launcher. The launcher also checks one known Codex Desktop bundled-runtime location as a fallback.

## Can the tool folder be moved?

Yes. Keep the launcher and `bin/` folder together:

```text
codex-project-chat-exporter\
├─ export-codex-project-chats.cmd
└─ bin\
   └─ export-codex-project-chats.mjs
```

## Why are output filenames short?

Short paths are more reliable when exports are copied, nested, zipped, and unzipped on Windows. `manifest.json` maps the short names back to the original sessions.

Use `--readable-paths` when longer names are preferable.

## Is `index.html` a full-text search engine?

No. Complete and Readable filter the exported session list by metadata such as project, title, date, model, and active/archived status. Source snapshots intentionally omits title, model, and Markdown columns and filters only its reduced metadata.

Search transcript content in the exported Markdown files with your editor, operating-system search, `rg`, or another dedicated session-search tool.

## Are image attachments exported?

Embedded Base64 attachments selected by the shared reading-view policy are decoded into the export-local deduplicated `assets/` store. PNG, JPEG, GIF, and WebP content that passes bounded header validation is rendered through relative reading-view links. Tool-only images require **Include Tools**; verified mirrored records render once, while identical images in independent turns remain independent uses. Unmatched `replacement_history` images appear under `Additional stored context`. Unknown, truncated, SVG, HTML, or MIME-spoofed selected content is retained as a non-renderable `.bin` link. Local-path and remote references are not copied or downloaded. When Raw export is enabled, canonical JSONL still preserves the original attachment representation.

## Can this restore sessions into Codex on another computer?

No import is implemented. Raw snapshots verified at export time and their portable manifest metadata prepare source material for possible future tooling, but no Codex roundtrip has been validated and Codex does not provide a documented public import interface for rebuilding its complete UI state, indexes, and project associations. A future importer must first compare each current Raw hash with `raw_sha256`.

Treat this as local preservation and migration preparation, not as a guaranteed one-click restore mechanism. See the [format specification](docs/archive-format-v1.md#import-boundary) for the exact boundary.

## Does it export normal ChatGPT chats or cloud-only Codex tasks?

No. It exports only Codex session files available locally on disk.

## Why did the FAQ open automatically?

The Windows launcher opens this file when Node.js cannot be found or when the export command fails.
