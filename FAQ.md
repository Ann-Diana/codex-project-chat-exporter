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

The diagnostic output shows the exact archive folder, the number of JSONL files found, and files with incomplete metadata. The exporter also recovers IDs from normal rollout filenames so that an archived file is not silently discarded merely because its `session_meta` record is missing or malformed.

Duplicate active and archived copies with the same session ID are shown once. The active copy takes precedence because both files represent the same Codex session. Different IDs are never deduplicated merely because their titles are identical.

## Does the exporter upload anything?

No. It reads local files and writes a local output folder. It does not call OpenAI APIs or send telemetry.

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

The exporter first checks `session_index.jsonl`. When no title is available there, it derives a short fallback from the first user message.

Derived titles are only archive labels. They do not modify Codex.

## What is the difference between `md/` and `raw/`?

`md/` contains readable transcripts with user and assistant messages. Tool details are omitted unless `--include-tools` is used.

`raw/` contains unchanged copies of the original JSONL session files. They preserve more information but may contain sensitive data.

## Does Markdown redaction make the files safe to share?

No. The redaction patterns catch only some common token-shaped secrets and long base64-like values.

They do not reliably remove paths, names, email addresses, IP addresses, customer data, source code, proprietary information, or every credential format.

## Why is `raw/` still present after using `--no-raw`?

The exporter does not clean an existing output folder. A `raw/` directory from an earlier run remains untouched.

Use a new folder or remove the previous output first:

```powershell
Remove-Item C:\cx\codex-export-md -Recurse -Force
node .\bin\export-codex-project-chats.mjs --all --no-raw --out C:\cx\codex-export-md
```

## Why does the exporter refuse an output folder?

It refuses to write into its own tool/repository directory by default. This reduces the risk of committing private exports to GitHub.

Choose another folder, for example:

```powershell
node .\bin\export-codex-project-chats.mjs --all --out C:\cx\codex-export
```

For deliberate local testing only, use `--allow-output-in-tool-dir`.

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

Short paths are more reliable when archives are copied, nested, zipped, and unzipped on Windows. `manifest.json` maps the short names back to the original sessions.

Use `--readable-paths` when longer names are preferable.

## Is `index.html` a full-text search engine?

No. It filters the exported session list by metadata such as project, title, date, model, and active/archived status.

Search transcript content in the exported Markdown files with your editor, operating-system search, `rg`, or another dedicated session-search tool.

## Are image attachments exported?

No. Version 0.1.0 exports textual user and assistant message content. It does not extract embedded images or copy attachment files.

## Can this restore sessions into Codex on another computer?

Not automatically. The raw files are useful for preservation and future tooling, but Codex does not provide a documented public import interface for rebuilding its complete UI state, indexes, and project associations.

Treat this as archive and migration preparation, not as a guaranteed one-click restore mechanism.

## Does it export normal ChatGPT chats or cloud-only Codex tasks?

No. It exports only Codex session files available locally on disk.

## Why did the FAQ open automatically?

The Windows launcher opens this file when Node.js cannot be found or when the export command fails.
