# Security Policy

Codex Project Chat Exporter processes private local session history. Generated archives should be treated as sensitive project data.

## Security model

The exporter is read-only with respect to Codex data:

- it reads local Codex session files
- it writes to a separate export folder
- it does not modify Codex sessions, indexes, profiles, or projects
- it makes no network requests

The exporter is not a security boundary or a data-loss-prevention product.

## Redaction limits

Markdown output applies best-effort patterns for several common token shapes and long base64-like values. The patterns are intentionally limited and can produce both false negatives and false positives.

Redaction does not reliably remove:

- names and email addresses
- file paths and project names
- IP addresses and internal hostnames
- customer or business data
- source code and proprietary text
- every API key, password, credential, or secret format

Raw JSONL copies are unchanged.

## Safe use

- Write exports to a local or encrypted storage location.
- Keep generated archives outside the public repository.
- Use `--no-raw` when unchanged source logs are not required.
- Review `md/`, `index.html`, `index.md`, `manifest.json`, `README.txt`, and `raw/` before sharing.
- Use a new or empty output folder to avoid retaining files from an earlier export.
- Do not attach real session logs to public bug reports.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting feature under the repository's **Security** tab when available.

If private reporting is not enabled, open a public issue containing only a minimal, non-sensitive description and ask the maintainer for a private contact route. Do not include session files, credentials, customer data, or exploitable details in a public issue.
