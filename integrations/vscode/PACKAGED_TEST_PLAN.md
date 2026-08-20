# Packaged VSIX test plan

Use this checklist for the uniquely named final candidate prepared during the later versioning step. It tests the installed package, not only the source-level adapter, and uses a small synthetic fixture rather than a multi-gigabyte real export.

## Install or update

1. Close any earlier test export folder and note the currently installed extension version.
2. In Visual Studio Code Desktop, run **Extensions: Install from VSIX...** and select the new candidate. Alternatively run `code --install-extension "<absolute-vsix-path>" --force`.
3. Reload Visual Studio Code when prompted.
4. Confirm that **Codex Project Chat Exporter** is installed and still marked experimental in its documentation.

## Create a controlled synthetic export

1. Prepare a small synthetic Codex home with direct-user, assistant, subagent, runtime-context, and unclassified samples; do not use private sessions.
2. Open a local `file:` workspace matching one synthetic session.
3. Create or select a new empty absolute output folder. Do not reuse an earlier export folder.
4. Use the desired `short` or `readable` path style and leave `includeTools` disabled unless tool content is intentionally under review. The export command asks for the profile on every run.
5. Run **Codex Export: Export…**, choose **Current Workspace**, and then choose **Complete export**.
6. Confirm that the success message uses the correct singular or plural session/project wording and that **Open HTML Index** and **Open Export Folder** open the newly created output.
7. Confirm that progress advances through phases and shows at least one `Processing session X of Y` message.
8. Confirm that the output channel records complete output-folder, HTML-index, and manifest paths.
9. With `codexProjectChatExporter.diagnosticOutput` disabled, confirm one concise runtime summary and no `[DIAG]` stream. If enabled for one troubleshooting run, confirm message-free, path-redacted events may include short IDs, sizes, phases, status, and timing values.
10. Confirm that `outputDirectory` and `codexHome` are application-scoped settings, Workspace values are rejected, and UNC/device output paths are rejected. Mapped network drives remain a documented detection limit.

## Check all profiles and cancellation

Expected files by profile:

- **Complete**: `raw/` checked at export time, Markdown transcripts, `index.html`, `index.md`, `manifest.json`, and `README.txt`.
- **Readable**: Markdown transcripts and both indexes plus `manifest.json` and `README.txt`, without new Raw snapshots.
- **Source snapshots**: `raw/` checked at export time, a reduced `index.html`, `manifest.json`, and `README.txt`, without Markdown transcripts or `index.md`.

1. Run **Codex Export: Export…** and cancel the scope Quick Pick. Confirm that no output folder is requested or changed.
2. Run it again, choose a scope, then cancel the profile Quick Pick. Confirm the same no-side-effect behavior.
3. Export a small known scope with **Readable**. Confirm that Markdown and both indexes exist, no new `raw/` is created, and the HTML index has no Raw column even if an old `raw/` folder exists.
4. Export to a new empty folder with **Source snapshots**. Confirm that Raw files checked at export time, `manifest.json`, `README.txt`, and `index.html` exist, while no Markdown transcript directory or `index.md` exists and the HTML index has no Markdown column or transcript links.
5. For a dedicated troubleshooting run only, enable `codexProjectChatExporter.diagnosticOutput`. Confirm that the first diagnostic line includes the candidate build identifier, one `run_id`, and `command_start`; then disable the setting again.
6. In a trusted local desktop window without an open folder, confirm **All Sessions** remains available while **Current Workspace** explains that a local `file:` workspace is required.
7. In an untrusted window, confirm all three visible export/open commands refuse to continue. Confirm remote, WSL, SSH, Dev Container, web, and virtual workspace hosts are rejected as documented.
8. Start a synthetic export and immediately invoke Export again; confirm the adapter rejects the second command. Automated tests separately cover the core lock for simultaneous writes to one destination.
9. Confirm the remembered output folder and latest HTML index change only after a successful completed export.

## Inspect classified reading views

In `md/` for short paths or `markdown/` for readable paths, verify at least one known example of each available category:

- a normal direct chat appears under `## User` and `## Assistant`;
- a subagent session uses **Subagent input / parent-agent handoff**, not a direct human User label;
- an automatically supplied AGENTS, plugin, or environment record is preserved under **Automatic runtime context**;
- if such a sample is available, the text of a same-text local-image record whose attachment identity cannot be proven remains visible under **Unclassified user-role record**, while the original attachment data or reference remains in canonical raw JSONL.

Do not treat Markdown or HTML as a lossless import source. Confirm that no inspected record disappeared from the corresponding raw JSONL snapshot.

These manual checks are representative spot checks only. Synthetic parity is covered by the automated integration tests.

## Inspect manifest and raw integrity

1. Open `manifest.json` and confirm top-level `archive_format_version` is `1` and `canonical_representation` is `raw_jsonl`.
2. For a session with a Raw snapshot, confirm `snapshot_status` is `STABLE`, `raw_copy_status` is `VERIFIED_AT_EXPORT`, `raw_verified_at` is an ISO-8601 timestamp, and `raw_sha256` contains 64 lowercase hexadecimal characters.
3. Hash the current Raw file and compare it with `raw_sha256`. A mismatch means the mutable file changed after its export-time check:

   ```powershell
   (Get-FileHash -Algorithm SHA256 -LiteralPath '<exported-raw-file>').Hash.ToLowerInvariant()
   ```

4. Before comparing against the live source, confirm its current size and modification time still equal `source_snapshot_after_size_bytes` and `source_snapshot_after_mtime_ms`. If they differ, the active source changed after export and a current source hash comparison is not authoritative.
5. If the source metadata is still unchanged, compare its SHA-256 with the exported raw file:

   ```powershell
   Get-FileHash -Algorithm SHA256 -LiteralPath '<exported-raw-file>'
   Get-FileHash -Algorithm SHA256 -LiteralPath '<source_jsonl>'
   ```

6. Treat `source_jsonl`, the manifest, and raw JSONL as private local data. Do not publish them without a separate privacy review.

## Record the result

Record the VSIX filename and SHA-256, VS Code version, extension-host type, output path style, tested command, sample classification categories, manifest checks, raw hash result, and any active source that changed after its snapshot.
