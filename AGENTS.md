# Document export development guardrails

- Keep each assignment narrowly scoped; do not add side work.
- Keep documentation concise, concrete, and understandable to first-time users.
- Prefer conventional, clear, maintainable code.
- Change existing export semantics only when an explicit requirement calls for it.
- Keep Raw JSONL byte-identical and treat it as the canonical archive source.
- Treat Markdown, HTML, Word, and PDF only as derived reading views, never as import sources.
- Process large sessions sequentially with bounded memory use.
- Do not introduce silent size limits, truncation, or content loss.
- Do not download remote images.
- Do not commit generated exports, temporary files, test output, or build artifacts.
- Add dependencies only after a documented need and review; pin exact versions.
- Check CI implications early.
- Run Codex Security after security-relevant changes and once comprehensively before a release, not after every small step.
- Do not push, tag, release, publish to npm, or publish to a marketplace without an explicit request.
- Do not use subagents for this assignment.
