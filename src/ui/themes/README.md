# Theme sources

`opencode.json` contains OpenCode's V2 semantic theme. `palettes.json` contains resolved light and dark colors from the built-in terminal themes in [anomalyco/opencode](https://github.com/anomalyco/opencode/tree/8b24fc8c2af625c8bffa04150f8d0aa25264bed3/packages/tui/src/theme/assets), commit `8b24fc8c2af625c8bffa04150f8d0aa25264bed3`.

`builtins.ts` adapts these palettes to the V2 token tree. It preserves source colors for surfaces, text, borders, feedback, diffs, and syntax. It builds hue scales by mixing each palette color with its background for semantic controls and graph lanes.

These files use the upstream MIT license in `LICENSE`.
