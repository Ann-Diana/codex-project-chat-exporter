# Bundled PDF fonts

The PDF renderer uses repository-local fonts only. It does not inspect or use operating-system fonts.

| File | Upstream release | SHA-256 |
| --- | --- | --- |
| `NotoSans-Regular.ttf` | NotoSans-v2.015, hinted TTF | `478c558ea716033cd60c03438f628dfa75694dcf6b5f6d505a2f05fd2b4f3823` |
| `NotoSans-Bold.ttf` | NotoSans-v2.015, hinted TTF | `1df075a380fc7cb898acf64c1f7b3b4dd780de3caa860178bf929de35817a913` |
| `NotoSans-Italic.ttf` | NotoSans-v2.015, hinted TTF | `467e3f89eeca4108bb8710a2b9e0cf2281ac56d5b0609211a83776d0505eecb5` |
| `NotoSansMono-Regular.ttf` | NotoSansMono-v2.014, hinted TTF | `65b5e2b2c4a1fba9ae8be1f026cb35b03dcb8886d9b2a4147054fde12f7e767d` |
| `NotoSansSymbols-Regular.ttf` | NotoSansSymbols-v2.003, hinted TTF | `d0e98e9a2c046594c5021437273943be7e79e0fd980fde125279e22302212595` |
| `NotoSansSymbols2-Regular.ttf` | NotoSansSymbols2-v2.008, hinted TTF | `c4a0a80f0041ce4be81e2478faad22776d23edb98ae3f0d19bd37044820ecf9d` |
| `NotoEmoji-Regular.ttf` | official monochrome Noto Emoji at immutable commit `9a5261d871451f9b5183c93483cbd68ed916b1e9` | `415dc6290378574135b64c808dc640c1df7531973290c4970c51fdeb849cb0c5` |

Sources are the official [Noto Latin/Greek/Cyrillic releases](https://github.com/notofonts/latin-greek-cyrillic/releases) and [Noto Symbols releases](https://github.com/notofonts/symbols/releases). The original release ZIP SHA-256 values were respectively `0c34df072a3fa7efbb7cbf34950e1f971a4447cffe365d3a359e2d4089b958f5`, `090cf6c5e03f337a755630ca888b1fef463e64ae7b33ee134e9309c05f978732`, `0c113cdcf6c31d050b80dac39fba2d804a6985281012e76e9220c0a00da007f3`, and `346c930bbe8eb946701a05c54e9c11a2094dee1d93c387bf1771c0a3e335688f`.

The Latin/Greek/Cyrillic and symbol files are licensed under the SIL Open Font License 1.1. `OFL.txt` preserves the Latin/Greek/Cyrillic font project's copyright notice, while `OFL-SYMBOLS.txt` preserves the separate Noto Symbols project's copyright notice for both symbol faces. The historical official monochrome Noto Emoji file is licensed under Apache License 2.0; `APACHE-NOTO-EMOJI.txt` is the unmodified license from the pinned upstream commit. Its source is `https://github.com/googlefonts/noto-emoji/blob/9a5261d871451f9b5183c93483cbd68ed916b1e9/fonts/NotoEmoji-Regular.ttf`.

The renderer verifies every font hash before use. Regular, bold, italic, monospace, two complementary symbol faces, and the monochrome emoji face are embedded as subsets only when needed. The emoji face intentionally covers common legacy Unicode emoji rather than every later Unicode release. A grapheme that remains unsupported by the entire bundled chain receives a deterministic visible PDF-only marker; source data and the shared document model are unchanged.
