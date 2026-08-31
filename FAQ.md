# FAQ

## Where does Codex store local sessions?

The default locations currently observed are:

- active sessions: `~/.codex/sessions`
- archived sessions: `~/.codex/archived_sessions`
- thread-name index: `~/.codex/session_index.jsonl`

On Windows, `~` normally means `C:\Users\<you>`. These locations and formats are internal Codex implementation details and may change.

## Does the exporter upload anything or read my workspace files?

The exporter has no uploader, telemetry or application-level remote fetch for export content. It reads the configured local Codex session stores and session index. Selecting a workspace or a historical project does not authorize it to enumerate or copy arbitrary project files.

Embedded image data stored in session records can be decoded. Local-path and remote attachment references are not copied or downloaded. Controlled HTTP and HTTPS hyperlinks can remain clickable in derived documents without being opened during export.

A configured output path can still reside on network-backed storage. The VS Code extension rejects UNC and Windows device paths, but mapped drives cannot be identified reliably in every configuration. Choose a known local destination when locality matters.

## What are Complete, Readable and Source snapshots?

- **Complete** (`complete`) creates Markdown transcripts, full indexes, both manifests, deduplicated assets and byte-identical Raw snapshots verified at export time. Unmatched `replacement_history` content can appear under `Additional stored context`.
- **Readable** (`readable`) creates Markdown transcripts, full indexes, both manifests and deduplicated assets without new Raw snapshots. It suppresses `replacement_history` from every derived reading view without changing source data.
- **Source snapshots** (`source-snapshots`) creates a reduced responsive HTML index, both manifests, deduplicated assets and verified Raw snapshots without Markdown transcripts or `index.md`. Explicit DOCX or PDF additions use the forensic labelled stored-context policy.

Use Readable for ordinary browsing. Use Complete when readable views and source snapshots belong in one generation. Use Source snapshots when source preservation with minimal indexing is the goal.

CLI `--no-raw` is a legacy shorthand for Readable only when no explicit `--profile` is supplied. It is not an independent Raw switch. Every profile keeps archive format version 1.

## Is `pathStyle` another profile?

No. Path style controls directory and filename presentation only. Short paths such as `md/p001-project/s0001.md` are the default for Windows portability. `--readable-paths` and the VS Code **Path Style** setting choose longer timestamp and title-based names without changing content selection.

## How do I create Word and PDF files?

Use `--format docx`, `--format pdf` or `--format docx,pdf`. The reverse list `pdf,docx` normalizes to the same canonical order. In VS Code choose **Add DOCX**, **Add PDF** or **Add DOCX and PDF**.

Each selected session receives its own document. DOCX is editable. PDF is rendered directly from the shared document model and does not use Word, LibreOffice or DOCX conversion. A combined all-session document is not produced.

PNG and JPEG images can be embedded. GIF, WebP and `.bin` remain labelled attachment references in DOCX and PDF. Existing destination files are not silently replaced.

See [Shared document model and DOCX](docs/document-model-and-docx.md) and [Shared document model and PDF](docs/document-model-and-pdf.md).

## Why can DOCX and PDF have different page counts?

They use different layout engines and page-breaking rules. Equal page counts are not expected. Both renderers receive the same ordered shared document model with the same roles, headings, lists, code blocks, text hashes and selected images. A true content omission is a failure even when layout-only page and line breaks differ.

## What happens to images and duplicate assets?

The shared reading selection decides both visible text and visible assets. Valid embedded PNG, JPEG, GIF and WebP bytes are stored by SHA-256 in the export-local `assets/` directory. One physical asset file can support several legitimate visible uses.

Verified technical mirror pairs render once. The exporter does not merge uses merely because their hashes match, so the same image can appear again in a different genuine turn. `assets/manifest.json` records provenance, classification, role, record type, content type, timestamp, tool origin and mirror relationships.

Unknown, truncated, active or MIME-spoofed payloads are retained as non-renderable `.bin` files when selected. No workspace or preview file is read after the fact.

## What does Include Tools change?

With tools disabled, Tool, Browser and `view_image`-only records plus their assets are excluded from Markdown, responsive HTML, DOCX and PDF reading views. A normal user or assistant message is not excluded merely because it also contains an image.

With tools enabled, those technical records can appear once after structural mirror canonicalisation. Raw JSONL is unchanged by the tool filter.

## What happens to `replacement_history`?

`replacement_history` is stored compaction context rather than an ordinary visible turn. Readable suppresses it from every derived reading view. Complete retains unmatched content once under the explicit heading `Additional stored context`. Source snapshots preserve it in Raw and use the same labelled forensic policy if DOCX or PDF is explicitly requested. Nothing is silently deleted from source JSONL.

## Can steering or unclassified records appear?

Yes. Stored inputs or intermediate states can exist in JSONL even when the Codex interface does not show them as ordinary messages. The exporter classifies only what the record structure supports. It can label direct user turns, subagent inputs, automatic runtime contexts and unclassified user-role records without guessing from timing.

This is not a universal statement about how every Codex UI version displays steering. Review derived views and Raw separately when provenance matters.

## How are sessions assigned to projects?

The exporter uses the `cwd` stored in first-record session metadata. The original project folder does not need to exist.

**Current Workspace** and CLI `--recorded-project` use exact lexical path identity. Windows drive-letter case, slash direction, trailing separators and equivalent local `\\?\` drive or UNC forms are normalized. Basenames, substrings, descendants, filesystem existence and `realpath` are not used.

CLI `--project` remains a fuzzy legacy name or path search. It is not automatic moved-project recovery.

## Why can one recorded path contain mixed logical projects?

Codex can store several sessions under the same broad `cwd` even when the work later represents different logical projects. Exact path identity cannot split those sessions by meaning. The historical picker therefore shows the recorded path, counts, bytes, date range and stored spelling variants, then requires confirmation when it differs from the current workspace.

The exporter does not inspect conversation text to invent project boundaries and has no per-session historical picker.

## Why can the export contain more sessions than the Codex UI shows?

The exporter scans local session files directly. A valid rollout can remain active or archived even if the current UI filters, groups, hides or no longer lists it. Duplicate active and archived copies with the same session ID are retained once, with the active copy preferred. Different IDs are not merged merely because their titles match.

## Where do titles and model histories come from?

The exporter checks `session_index.jsonl` and validates title provenance against session records. Otherwise it uses the first confirmed direct user turn or a neutral deterministic fallback. Display titles do not modify Codex.

Confirmed turn-level runtime model fields form the chronological model history. Repeated adjacent values are collapsed. Models from separate subagent sessions are not merged into the parent session.

## Is Raw JSONL safe to share?

No. When included, Raw is a byte-identical snapshot checked against source hashes at export time. It can contain private messages, usernames, absolute paths, runtime context, steering data, unclassified records, code and attachments. It is canonical source material, not a share-safe derivative.

`raw_verified_at` and `VERIFIED_AT_EXPORT` describe one completed check. Raw files remain mutable afterward, so later integrity-sensitive use must hash them again and compare with `raw_sha256`.

Markdown secret masking is also best effort. It does not reliably remove names, paths, addresses, customer data, proprietary text or every credential shape. Review every generated file before sharing.

## What happens when I cancel an export?

The direct MJS CLI turns the first SIGINT into a shared abort request and exits with code 130 after cleanup. The VS Code progress notification uses the same core abort path. Discovery, session streaming, document-model building, asset work, renderer loops and publication contain cancellation checks.

One synchronous third-party packaging call cannot be interrupted from inside JavaScript. Cancellation is checked immediately before and after that call. If publication already began, the output folder can retain `EXPORT_INCOMPLETE.txt`. That marker invalidates the whole generation: do not use its manifests or indexes as a regular archive. Run-owned temporary files are removed and unrelated existing files are not deleted.

Closing a picker before export starts is silent and does not create the selected output folder.

## How does the PDF renderer handle missing glyphs?

PDF uses bundled hash-verified Noto text, monospace, symbol and monochrome emoji fonts. Supported graphemes remain searchable and copyable through ToUnicode mappings.

A valid grapheme outside the bundled chain receives a visible deterministic marker such as `[unsupported glyph U+10FFFF]`. A multi-codepoint marker lists every code point in order, including variation selectors or joiners when present. The exporter does not claim a true glyph for all Unicode. An unpaired UTF-16 surrogate fails closed.

## How does the exporter handle large sessions?

Sessions are processed sequentially. The bounded JSONL reader streams large strings and incrementally decodes embedded Base64 data. The exporter does not retain the whole source collection in memory.

One unusually large ordinary text field, the visible document model for the current session, renderer page state and font/image subsetting can still affect peak memory. Performance depends on source size, visible content, page count and selected formats. Use `--performance-profile <absolute-json-file>` only for local diagnosis; it adds work and can slow the export.

## Why does the exporter refuse an output folder?

The exporter refuses source/output overlap, unsupported aliases and its own repository by default. It also uses `.codex-export.lock` to prevent concurrent writes to one destination. Choose a new empty local directory such as:

```powershell
node .\bin\export-codex-project-chats.mjs --all --out C:\cx\codex-export
```

If a lock remains after a crash, first prove no export is running. Inspect its PID and start time, then remove only that confirmed stale lock file. Do not perform broad recursive cleanup.

## Windows blocks the `.cmd` launcher. Does it need administrator rights?

No. The exporter does not require administrator rights. A downloaded ZIP can carry Mark of the Web. Prefer unblocking the ZIP in **Properties** before extracting it again. Do not disable Smart App Control or use **Run as administrator** as the normal workaround.

Alternatively, after reviewing the code, unblock an existing extracted folder:

```powershell
Get-ChildItem .\codex-project-chat-exporter -Recurse -File | Unblock-File
```

## PowerShell says `node` was not found. What now?

Install a supported Node.js 22 or 24 runtime or use the Windows wrapper. The wrapper can also use one known bundled Codex Desktop Node runtime when it meets the same requirement.

## Does it restore sessions or export cloud-only chats?

No. There is no import or validated Codex roundtrip. The exporter handles only locally stored Codex session files and does not export ordinary ChatGPT web conversations or cloud-only tasks without a local session.

See [archive format version 1](docs/archive-format-v1.md) for the exact import boundary.
