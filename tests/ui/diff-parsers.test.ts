import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { TreeSitterClient, pathToFiletype } from "@opentui/core";
import { diffParsers, registerDiffParsers } from "../../src/ui/diff-parsers.js";

describe("installed diff parsers", () => {
  let client: TreeSitterClient;
  let dataPath: string;

  beforeAll(async () => {
    dataPath = await mkdtemp(join(tmpdir(), "tuig-diff-parsers-"));
    registerDiffParsers();
    registerDiffParsers(); // Repeated UI creation must be safe.
    client = new TreeSitterClient({ dataPath });
    await client.initialize();
  });

  afterAll(async () => {
    await client?.destroy();
    if (dataPath) await rm(dataPath, { recursive: true, force: true });
  });

  test("all extra assets are local files", async () => {
    for (const parser of diffParsers) {
      for (const path of [parser.wasm, ...parser.queries.highlights]) {
        expect(isAbsolute(path)).toBe(true);
        expect(await Bun.file(path).exists()).toBe(true);
      }
    }
  });

  const fixtures = [
    ["example.py", 'def greet():\n    return "hello"\n', "return", "keyword"],
    [
      "example.go",
      'package main\nfunc greet() string { return "hello" }',
      "return",
      "keyword",
    ],
    [
      "example.rs",
      'fn greet() -> &\'static str { return "hello"; }',
      "return",
      "keyword",
    ],
    ["example.html", '<div class="greeting">Hello</div>', "div", "tag"],
    ["example.css", ".greeting { color: red; }", "color", "property"],
    ["example.json", '{"greeting": "hello", "count": 42}', "42", "number"],
    ["example.sh", 'if true; then echo "hello"; fi', "if", "keyword"],
    [".bashrc", 'if true; then echo "hello"; fi', "if", "keyword"],
    [
      "example.c",
      'const char *greet(void) { return "hello"; }',
      "return",
      "keyword",
    ],
    ["example.h", "const char *greet(void);", "char", "type"],
    [
      "example.cpp",
      'class Greeter { public: const char *greet() { return "hello"; } };',
      "class",
      "keyword",
    ],
    [
      "example.hpp",
      'class Greeter { public: const char *greet() { return "hello"; } };',
      "return",
      "keyword",
    ],
    ["example.js", 'function greet() { return "hello"; }', "return", "keyword"],
    ["example.jsx", 'const greet = () => <div title="hello" />;', "div", "tag"],
    [
      "example.ts",
      'function greet(): string { return "hello"; }',
      "return",
      "keyword",
    ],
    [
      "example.tsx",
      'const greet = (name: string) => <div title="hello">{name}</div>;',
      "div",
      "tag",
    ],
    [
      "example.md",
      "# Hello\n\nSome **bold** text.\n",
      "# Hello\n",
      "markup.heading",
    ],
    ["example.zig", 'const greeting = "hello";', "const", "keyword"],
  ] as const;

  for (const [path, source, token, scope] of fixtures) {
    test(`highlights actual tokens in ${path}`, async () => {
      const filetype = pathToFiletype(path);
      expect(filetype).toBeDefined();
      const result = await client.highlightOnce(source, filetype!);
      expect(result.error).toBeUndefined();
      expect(result.warning).toBeUndefined();
      expect(
        result.highlights?.some(
          ([start, end, group]) =>
            source.slice(start, end) === token &&
            (group === scope || group.startsWith(`${scope}.`)),
        ),
      ).toBe(true);
    });
  }

  test("unsupported languages fall back without throwing", async () => {
    const result = await client.highlightOnce("plain text", "unknown-filetype");
    expect(result.error).toBeUndefined();
    expect(result.highlights ?? []).toHaveLength(0);
  });
});
