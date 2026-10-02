# Changelog

## 0.2.2 – 2026-10-02

- Clarify the Marketplace description and README introductions for local OpenAI Codex exports.
- Add AI and Chat categories and focused search keywords; derive packaged VSIX categories from the extension manifest.
- Use VS Code's native Cancel action when confirming a historical project path, and show the correct singular or plural session count. Only explicit confirmation continues the export.
- Verify packaged categories and keywords and correct the published 0.2.1 changelog date.
- Bundled CLI remains 0.4.0; export behavior and archive, coverage and asset schemas are unchanged.

## 0.2.1 – 2026-09-28

- Explain destination collisions without overwriting existing files; offer “Anderen Ordner wählen…” to retry the same selection in another folder for this run, or “Ordner öffnen” to inspect the destination.
- Add a native Codex Exporter Activity Bar view with Export…, Open Latest Export, Open Export Folder and Extension Settings, using a bundled monochrome icon.
- Update installation instructions for the published Marketplace listing. Bundled CLI remains 0.4.0.

## 0.2.0 – First Marketplace release

- Introduced the Visual Studio Code Marketplace listing under `ann-diana.codex-project-chat-exporter-vscode`.
- Bundled exporter core 0.4.0 for local project-aware Markdown, HTML, DOCX and PDF exports, optional verified Raw snapshots, and auditable reading-view coverage.
- Kept archive format 1, coverage schema 1 and asset schema 2 unchanged.

## 0.1.5 – GitHub VSIX

- Corrected packaged documentation links and clarified local export requirements and document formats.
