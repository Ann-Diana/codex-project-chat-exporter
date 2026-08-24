# Bundled PDF fonts

The PDF renderer uses repository-local fonts only. It does not inspect or use operating-system fonts.

| File | Upstream release | SHA-256 |
| --- | --- | --- |
| `NotoSans-Regular.ttf` | NotoSans-v2.015, hinted TTF | `478c558ea716033cd60c03438f628dfa75694dcf6b5f6d505a2f05fd2b4f3823` |
| `NotoSans-Bold.ttf` | NotoSans-v2.015, hinted TTF | `1df075a380fc7cb898acf64c1f7b3b4dd780de3caa860178bf929de35817a913` |
| `NotoSans-Italic.ttf` | NotoSans-v2.015, hinted TTF | `467e3f89eeca4108bb8710a2b9e0cf2281ac56d5b0609211a83776d0505eecb5` |
| `NotoSansMono-Regular.ttf` | NotoSansMono-v2.014, hinted TTF | `65b5e2b2c4a1fba9ae8be1f026cb35b03dcb8886d9b2a4147054fde12f7e767d` |
| `NotoSansSymbols-Regular.ttf` | NotoSansSymbols-v2.003, hinted TTF | `d0e98e9a2c046594c5021437273943be7e79e0fd980fde125279e22302212595` |

Sources are the official [Noto Latin/Greek/Cyrillic releases](https://github.com/notofonts/latin-greek-cyrillic/releases) and [Noto Symbols releases](https://github.com/notofonts/symbols/releases). The original release ZIP SHA-256 values were respectively `0c34df072a3fa7efbb7cbf34950e1f971a4447cffe365d3a359e2d4089b958f5`, `090cf6c5e03f337a755630ca888b1fef463e64ae7b33ee134e9309c05f978732`, and `0c113cdcf6c31d050b80dac39fba2d804a6985281012e76e9220c0a00da007f3`.

All files are licensed under the SIL Open Font License 1.1 reproduced in `OFL.txt`. The renderer verifies every font hash before use. The regular, bold, italic, monospace, and symbol faces are embedded as subsets in each PDF as needed.
