# Real-export corrections (2026-08-28)

## Confirmed causes

- DOCX: relationship XML was valid before canonicalization. `xml-js` decoded a query separator and its serializer did not re-escape the attribute's ampersand. The captured invalid part failed independent XML parsing at line 1, column 1078. Relationship ordinal 7 was an ordinary HTTP hyperlink, not a local resource. Its target length was 47, SHA-256 `4db4198b30ff6622131e69e2a2ef1092fbb6112da1ad7e8d80a7f89d704c0299`. The source was record 399, `response_item/message`, assistant, timestamp `2026-04-18T21:19:24.553Z`; text length 2229, SHA-256 `f8ebd50203f4608d454cceeca8cb817af103fcba27e5fe5d1eee3962091a18ce`.
- PDF: `/3D` occurred at byte offset 1,316,832 inside object 327's FlateDecode page stream, not a dictionary. The unchanged captured PDF passes the new structural validator and an independent strict PDF parser. DOCX and PDF therefore had independent failures, not a shared asset/link-normalization defect.
- Lists: separate lists shared a numbering instance. Each logical list now gets a deterministic instance, preserving explicit starts, nested groups and parent continuation.
- Technical image markers are suppressed only in reading views when exact standalone input-text parts immediately surround an input-image part whose stored PNG/JPEG is verified and renderable. Fences, quotes, literal examples, Raw JSONL and source evidence are retained.

The XML investigation ruled out truncation, malformed relationship IDs, forbidden schemes, control characters and large-file streaming as the cause of this captured relationship. Tests nevertheless reject unsafe schemes and XML 1.0 controls, including decoded numeric entities.

## Boundaries and unresolved identification

The failing DOCX record is an ordinary assistant message. Inspection did not establish a reliable browser-annotation event schema or a causal browser-annotation link; absence of a matching literal marker is not proof that annotations were absent. User text and recorded attachments remain intact. No workspace/preview files are collected.

No stable steering/progress relationship was established, so roles are not guessed from timing. Runtime context remains classified and preserved. Runtime-context hiding and individual-session selection remain future product decisions.

Readable DOCX/PDF local-link labels say `[local file not included]`; the model retains the blocked reason and the canonical source remains unchanged. Image-to-external-asset links are not added: Word-relative targets are not reliably portable and would introduce the file/resource relationships deliberately excluded by the document contract. The archive's existing local HTML/assets workflow remains available.

Only exporter-owned separators change to en dashes. Source punctuation, quotes and emphasis are not normalized. Golden changes are limited to Markdown hashes affected by those owned headings; JSON, HTML, Raw, source-snapshot goldens and deduplicated assets retain their existing checks.

## Verification evidence

Small synthetic regressions cover query escaping/literal entities, all DOCX XML parts, independent/nested lists, explicit starts, image boundaries, Raw identity and source punctuation. PDF tests distinguish harmless text/metadata/URL/stream data from actual active dictionaries/actions and forbidden URI/resource targets. Packaged offline tests verify the complete runtime and byte-identical independent VSIX builds.

The synthetic DOCX was opened read-only in Word with link updates disabled and rendered to two pages; both pages and both native PDF pages were inspected with Poppler. PNG/JPEG, list starts/nesting, XML literals, links and the nine mixed-font symbols were visible. This is local Word/Poppler evidence, not a claim about every viewer or an OS-level network capture.

Paired synthetic large-line measurements, Node.js 24.19.0:

| Input | PDF ms | DOCX ms | PDF/DOCX | PDF peak RSS MiB | Residue |
| --- | ---: | ---: | ---: | ---: | ---: |
| 16 MiB | 1575.215 | 1740.830 | 0.905 | 155.133 | 0 |
| 115 MiB | 8321.601 | 8257.323 | 1.008 | 271.277 | 0 |

Source bytes stayed identical. No repeated multi-GiB whole-project export was used. A separate package-test run was interrupted after excessive assertion-diagnostic memory use; a fixed-heap rerun passed. Large binary comparisons now report hashes instead of constructing a structural Buffer diff. This is not counted as a renderer performance result.
