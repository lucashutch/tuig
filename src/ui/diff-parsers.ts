import { addDefaultParsers, type FiletypeParserOptions } from "@opentui/core";
import { getQueryPath, getWasmPath } from "tree-sitter-wasm";

// Resolve assets from the pinned dependency, not the repository being viewed.
// Parsers load on demand and never need a runtime download.
export const diffParsers: FiletypeParserOptions[] = [
  ...(
    ["python", "go", "rust", "html", "css", "json", "bash", "c"] as const
  ).map((filetype) => ({
    filetype,
    wasm: getWasmPath(filetype),
    queries: { highlights: [getQueryPath(filetype, "highlights")] },
  })),
  {
    filetype: "cpp",
    wasm: getWasmPath("cpp"),
    // The C++ query only adds C++ constructs; common tokens come from C.
    queries: {
      highlights: [
        getQueryPath("c", "highlights"),
        getQueryPath("cpp", "highlights"),
      ],
    },
  },
  {
    filetype: "javascriptreact",
    wasm: getWasmPath("javascript"),
    queries: {
      highlights: [
        getQueryPath("javascript", "highlights"),
        getQueryPath("javascript", "highlights-jsx"),
      ],
    },
  },
  {
    filetype: "typescriptreact",
    wasm: getWasmPath("tsx"),
    queries: {
      highlights: [
        getQueryPath("javascript", "highlights"),
        getQueryPath("javascript", "highlights-jsx"),
        getQueryPath("tsx", "highlights"),
      ],
    },
  },
];

let registered = false;

/** Call before creating diff renderables and their shared Tree-sitter client. */
export function registerDiffParsers(): void {
  if (registered) return;
  addDefaultParsers(diffParsers);
  registered = true;
}
