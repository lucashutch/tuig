import { expect, test } from "bun:test";
import {
  BoxRenderable,
  InputRenderable,
  TextRenderable,
  CliRenderEvents,
  RGBA,
} from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import {
  activeTheme,
  oneDarkTheme,
  setActiveTheme,
} from "../../src/ui/theme.js";
import {
  loadInitialTheme,
  updateWidgetTheme,
} from "../../src/ui/runtime-theme.js";
import { buttonMouse } from "../../src/ui/runtime-widgets.js";
import { createDiffSyntaxStyle } from "../../src/ui/diff-syntax.js";
import { DiffView } from "../../src/ui/diff-view.js";
import { Runtime } from "../../src/ui/runtime.js";
import { loadThemePreferences } from "../../src/ui/theme-store.js";
import type { GitRepository, RepositorySnapshot } from "../../src/git/types.js";
import { graphWindow, type GraphIndex } from "../../src/ui/graph-index.js";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import themeDocument from "../../src/ui/themes/opencode.json";
import { themeFromDocument } from "../../src/ui/theme-resolver.js";

test("V2 syntax aliases and Markdown captures use their own semantic colors", () => {
  const previous = { ...activeTheme };
  const custom = structuredClone(themeDocument);
  custom.base.syntax.function = "#123456";
  custom.base.syntax.number = "#234567";
  custom.base.syntax.string = "#345678";
  custom.base.markdown.heading = "#456789";
  custom.base.markdown.code = "#56789a";
  setActiveTheme(themeFromDocument(custom, "dark"));
  const style = createDiffSyntaxStyle();
  try {
    for (const [capture, color] of [
      ["method", "#123456"],
      ["boolean", "#234567"],
      ["character", "#345678"],
      ["markup.heading", "#456789"],
      ["markup.raw", "#56789a"],
    ] as const)
      expect(style.getStyle(capture)?.fg?.equals(RGBA.fromHex(color))).toBe(
        true,
      );
    expect(style.getStyle("markup.heading")?.bold).toBe(true);
  } finally {
    style.destroy();
    setActiveTheme(previous);
  }
});

test("live theme setters preserve the editor draft, focus, and diff document", async () => {
  const { renderer, renderOnce } = await createTestRenderer({
    width: 60,
    height: 15,
  });
  const previous = { ...activeTheme };
  const box = new BoxRenderable(renderer, {
    id: "sidebar",
    backgroundColor: previous.panel,
    borderColor: previous.border,
  });
  const input = new InputRenderable(renderer, {
    id: "composer-summary",
    value: "unfinished",
    textColor: previous.text,
    backgroundColor: previous.panel,
    focusedBackgroundColor: previous.panelRaised,
  });
  const diff = new DiffView(renderer, { id: "diff", width: 60, height: 8 });
  renderer.root.add(box);
  box.add(input);
  renderer.root.add(diff);
  diff.setDiff("--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new\n");
  const document = diff.getChildren()[0];
  input.focus();
  try {
    setActiveTheme({
      ...oneDarkTheme,
      panel: "#112233",
      panelRaised: "#223344",
      text: "#abcdef",
      diffAddedBg: "#123456",
    });
    updateWidgetTheme(renderer.root);
    diff.updateTheme();
    await renderOnce();
    expect(input.value).toBe("unfinished");
    expect(input.focused).toBe(true);
    expect(box.backgroundColor?.equals(RGBA.fromHex("#112233"))).toBe(true);
    expect(input.backgroundColor.equals(RGBA.fromHex("#223344"))).toBe(true);
    expect(diff.getChildren()[0]).toBe(document);
    expect(diff.diff).toContain("+new");
  } finally {
    renderer.destroy();
    setActiveTheme(previous);
  }
});

test("semantic controls retain their roles across coincident palettes and hovered switches", async () => {
  const previous = { ...activeTheme };
  const { renderer, renderOnce, captureSpans } = await createTestRenderer({
    width: 50,
    height: 10,
  });
  const button = new TextRenderable(renderer, {
    id: "stage-all",
    top: 0,
    content: "Stage",
  });
  const field = new InputRenderable(renderer, {
    id: "composer-summary",
    top: 2,
    width: 20,
    value: "draft",
  });
  const dialog = new BoxRenderable(renderer, {
    id: "command-palette",
    top: 4,
    width: 30,
    height: 5,
    border: true,
  });
  const dialogInput = new InputRenderable(renderer, {
    id: "command-palette-search",
    width: 20,
    value: "search",
  });
  dialog.add(dialogInput);
  for (const widget of [button, field, dialog]) renderer.root.add(widget);
  const mouse = buttonMouse(() => {});
  const semantic = (base: string, hover: string) => ({
    tokens: {
      text: {
        action: { primary: { base, hovered: hover } },
        formfield: { base: "#345678", focused: "#456789" },
      },
      background: {
        action: { primary: { base, hovered: hover } },
        formfield: { base: "#56789a", focused: "#6789ab" },
      },
    },
    dialog: {
      text: { formfield: { base: "#789abc", focused: "#89abcd" } },
      background: {
        base: "#9abcde",
        formfield: { base: "#abcdef", focused: "#bcdef0" },
      },
      border: { base: "#cdef01" },
    },
  });
  try {
    setActiveTheme({
      ...oneDarkTheme,
      semantic: semantic("#112233", "#112233"),
    });
    updateWidgetTheme(renderer.root);
    mouse.onMouseOver.call(button);
    field.focus();
    setActiveTheme({
      ...oneDarkTheme,
      syntax: undefined,
      semantic: semantic("#223344", "#334455"),
    });
    updateWidgetTheme(renderer.root);
    await renderOnce();
    const spans = captureSpans().lines.flatMap((line) => line.spans);
    expect(
      spans
        .find((span) => span.text.includes("Stage"))
        ?.bg.equals(RGBA.fromHex("#334455")),
    ).toBe(true);
    expect(
      spans
        .find((span) => span.text.includes("draft"))
        ?.fg.equals(RGBA.fromHex("#456789")),
    ).toBe(true);
    expect(dialog.backgroundColor?.equals(RGBA.fromHex("#9abcde"))).toBe(true);
    expect(dialogInput.backgroundColor.equals(RGBA.fromHex("#abcdef"))).toBe(
      true,
    );
    mouse.onMouseOut.call(button);
    expect(button.bg?.equals(RGBA.fromHex("#223344"))).toBe(true);
    expect(field.value).toBe("draft");
    expect(field.focused).toBe(true);
    const style = createDiffSyntaxStyle();
    expect(
      style.getStyle("comment")?.fg?.equals(RGBA.fromHex(activeTheme.muted)),
    ).toBe(true);
    expect(
      style.getStyle("number")?.fg?.equals(RGBA.fromHex(activeTheme.warning)),
    ).toBe(true);
    style.destroy();
  } finally {
    renderer.destroy();
    setActiveTheme(previous);
  }
});

test("invalid saved preferences recover without overwriting settings or trusting a poisoned one-dark", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tuig-theme-startup-"));
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = directory;
  const path = `${directory}/tuig/theme.json`;
  try {
    await mkdir(`${directory}/tuig/themes`, { recursive: true });
    await writeFile(`${directory}/tuig/themes/one-dark.json`, "broken");
    for (const value of [
      "broken",
      JSON.stringify({ name: "missing", mode: "light" }),
      JSON.stringify({ name: "one-dark", mode: "system" }),
    ]) {
      await writeFile(path, value);
      const result = await loadInitialTheme();
      expect(result.warning).toBeDefined();
      expect(result.theme.bg).toBe(oneDarkTheme.bg);
      expect(await readFile(path, "utf8")).toBe(value);
    }
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("system appearance events resolve themes without reading Git or losing drafts", async () => {
  const previous = { ...activeTheme };
  const { renderer } = await createTestRenderer({ width: 100, height: 30 });
  const repository = new Proxy(
    { root: "/tmp/opencode" },
    {
      get(target, key) {
        if (key === "root") return target.root;
        throw new Error(`Unexpected Git access: ${String(key)}`);
      },
    },
  ) as GitRepository;
  const runtime = new Runtime(renderer, [repository], repository.root);
  const editor = (runtime as unknown as { composerSummary: InputRenderable })
    .composerSummary;
  editor.value = "unfinished";
  editor.focus();
  try {
    runtime.configureThemes(
      {
        entries: [{ name: "test", source: "test" }],
        errors: [],
        resolve: (_name, mode) => ({
          ...oneDarkTheme,
          bg: mode === "light" ? "#fefefe" : "#010101",
        }),
      },
      { name: "test", mode: "system" },
    );
    renderer.emit(CliRenderEvents.THEME_MODE, "light");
    expect(activeTheme.bg).toBe("#fefefe");
    renderer.emit(CliRenderEvents.THEME_MODE, "dark");
    expect(activeTheme.bg).toBe("#010101");
    expect(editor.value).toBe("unfinished");
    expect(editor.focused).toBe(true);
  } finally {
    renderer.destroy();
    setActiveTheme(previous);
  }
});

for (const dirty of [false, true]) {
  test(`theme changes preserve ${dirty ? "dirty" : "clean"} graph ancestry without Git access or moving selection`, async () => {
    const previous = { ...activeTheme };
    const { renderer } = await createTestRenderer({ width: 100, height: 30 });
    const repository = new Proxy(
      { root: "/tmp/opencode" },
      {
        get(target, key) {
          if (key === "root") return target.root;
          throw new Error(`Unexpected Git access: ${String(key)}`);
        },
      },
    ) as GitRepository;
    const runtime = new Runtime(renderer, [repository], repository.root);
    const state = runtime as unknown as {
      snapshot: RepositorySnapshot;
      graphIndex: GraphIndex;
      commitIndex: number;
      historyStart: number;
      historySelection: "working" | "commit";
      activateTheme(
        selection: { name: string; mode: "dark" },
        persist: boolean,
      ): Promise<void>;
    };
    const commits = Array.from({ length: 50 }, (_, index) => String(index)).map(
      (sha, index) => ({
        sha,
        parents: index < 49 ? [String(index + 1)] : [],
        author: "A",
        authorEmail: "a@b",
        authoredAt: "2026-01-01",
        committer: "A",
        committerEmail: "a@b",
        committedAt: "2026-01-01",
        subject: sha,
        body: "",
        decorations: [],
      }),
    );
    state.snapshot = {
      root: repository.root,
      ahead: 0,
      behind: 0,
      branches: [
        {
          name: "main",
          fullName: "refs/heads/main",
          sha: "1",
          current: true,
          remote: false,
        },
      ],
      files: dirty
        ? [
            {
              path: "file.ts",
              state: "modified",
              staged: false,
              unstaged: true,
            },
          ]
        : [],
      stashes: [],
      worktrees: [],
      submodules: [],
      commits,
      commitsComplete: true,
    };
    state.commitIndex = 1;
    state.historyStart = 1;
    state.historySelection = "commit";
    runtime.configureThemes(
      {
        entries: [
          { name: "first", source: "test" },
          { name: "second", source: "test" },
        ],
        errors: [],
        resolve: (name) => ({
          ...oneDarkTheme,
          graph: [name === "first" ? "#123456" : "#abcdef"],
        }),
      },
      { name: "first", mode: "dark" },
    );
    try {
      await state.activateTheme({ name: "first", mode: "dark" }, false);
      const before = graphWindow(
        state.graphIndex,
        commits,
        activeTheme.graph,
        0,
        3,
      );
      if (dirty) expect(before.find((row) => row.head)?.lane).toBe(0);
      await state.activateTheme({ name: "second", mode: "dark" }, false);
      const after = graphWindow(
        state.graphIndex,
        commits,
        activeTheme.graph,
        0,
        3,
      );
      expect(after.map((row) => row.cells.map((cell) => cell.symbol))).toEqual(
        before.map((row) => row.cells.map((cell) => cell.symbol)),
      );
      if (dirty) expect(after.find((row) => row.head)?.lane).toBe(0);
      expect(after[0]?.cells[0]?.color).toBe("#abcdef");
      expect(state.commitIndex).toBe(1);
      expect(state.historyStart).toBe(1);
    } finally {
      renderer.destroy();
      setActiveTheme(previous);
    }
  });
}

for (const mode of ["unified", "split"] as const) {
  test(`live ${mode} diff colors preserve selected rows and the scrolled document`, async () => {
    const previous = { ...activeTheme };
    const { renderer, renderOnce, captureSpans } = await createTestRenderer({
      width: mode === "split" ? 140 : 70,
      height: 10,
    });
    const view = new DiffView(renderer, {
      id: "commit-diff",
      width: mode === "split" ? 140 : 70,
      height: 10,
      view: mode,
    });
    renderer.root.add(view);
    const lines = Array.from(
      { length: 50 },
      (_, index) => `+added-${index}`,
    ).join("\n");
    view.setDiff(
      `--- /dev/null\n+++ b/file\n@@ -0,0 +1,50 @@\n${lines}\n`,
      undefined,
      "none",
    );
    view.setSelectedRows(new Set([3]));
    const document = view.getChildren()[0]!;
    const descendants = (root: {
      getChildren(): import("@opentui/core").Renderable[];
    }): import("@opentui/core").Renderable[] =>
      root.getChildren().flatMap((child) => [child, ...descendants(child)]);
    const code = descendants(document).find((child) =>
      child.id.endsWith(mode === "split" ? "-right-code" : "-left-code"),
    ) as unknown as { scrollY: number };
    try {
      await renderOnce();
      setActiveTheme({
        ...oneDarkTheme,
        diff: {
          text: { context: "#112233", added: "#223344", removed: "#334455" },
          background: {
            context: "#445566",
            added: "#556677",
            removed: "#667788",
          },
          highlight: { added: "#778899", removed: "#8899aa" },
          lineNumber: {
            text: "#99aabb",
            background: { added: "#aabbcc", removed: "#bbccdd" },
          },
        },
      });
      view.updateTheme();
      await renderOnce();
      expect(
        captureSpans()
          .lines.flatMap((line) => line.spans)
          .some(
            (span) =>
              span.text.includes("added-0") &&
              span.bg.equals(RGBA.fromHex("#778899")),
          ),
      ).toBe(true);
      code.scrollY = 15;
      await renderOnce();
      const scroll = code.scrollY;
      view.updateTheme();
      await renderOnce();
      expect(view.getChildren()[0]).toBe(document);
      expect(view.view).toBe(mode);
      expect(code.scrollY).toBe(scroll);
    } finally {
      renderer.destroy();
      setActiveTheme(previous);
    }
  });
}

test("command palette searches themes, marks the current choice, and persists selection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tuig-theme-runtime-"));
  const config = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = directory;
  const previous = { ...activeTheme };
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
    width: 100,
    height: 30,
  });
  const repository = { root: directory } as GitRepository;
  const runtime = new Runtime(renderer, [repository], directory);
  runtime.configureThemes(
    {
      entries: [
        { name: "one-dark", source: "builtin" },
        { name: "alternate", source: "test" },
      ],
      errors: [],
      resolve: (name) => ({
        ...oneDarkTheme,
        bg: name === "alternate" ? "#123456" : oneDarkTheme.bg,
      }),
    },
    { name: "one-dark", mode: "dark" },
  );
  const palette = runtime as unknown as {
    showCommandPalette(): void;
    paintCommandPalette(): void;
    activatePaletteCommand(): void;
    commandPaletteInput: InputRenderable;
    commandPaletteIndex: number;
    commandPaletteMatches: { command: { id: string } }[];
  };
  try {
    palette.showCommandPalette();
    palette.commandPaletteInput.value = "Change theme";
    palette.paintCommandPalette();
    palette.commandPaletteIndex = palette.commandPaletteMatches.findIndex(
      ({ command }) => command.id === "theme.change",
    );
    palette.activatePaletteCommand();
    await Bun.sleep(30);
    await renderOnce();
    expect(captureCharFrame()).toContain("one-dark (current)");
    palette.commandPaletteInput.value = "opencode";
    palette.paintCommandPalette();
    expect(palette.commandPaletteMatches).toHaveLength(1);
    palette.activatePaletteCommand();
    for (let attempt = 0; attempt < 50; attempt++) {
      if ((await loadThemePreferences()).name === "opencode") break;
      await Bun.sleep(5);
    }
    expect(await loadThemePreferences()).toEqual({
      name: "opencode",
      mode: "dark",
    });
    expect(activeTheme.bg).not.toBe(oneDarkTheme.bg);
    await Bun.sleep(5);
  } finally {
    renderer.destroy();
    setActiveTheme(previous);
    if (config === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = config;
    await rm(directory, { recursive: true, force: true });
  }
});
