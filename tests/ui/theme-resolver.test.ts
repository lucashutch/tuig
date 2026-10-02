import { describe, expect, test } from "bun:test";
import document from "../../src/ui/themes/opencode.json";
import {
  resolveThemeDocument,
  themeFromDocument,
} from "../../src/ui/theme-resolver";
import {
  activeTheme,
  oneDarkTheme,
  setActiveTheme,
  semanticColor,
} from "../../src/ui/theme";

describe("OpenCode V2 themes", () => {
  test("resolves the complete upstream fixture in both modes", () => {
    expect(themeFromDocument(document, "dark").bg).toBe("#0a0a0a");
    expect(themeFromDocument(document, "light").bg).toBe("#ffffff");
    expect(themeFromDocument(document, "light").syntax?.function).toBe(
      "#3b7dd8",
    );
  });
  test("falls back to the available mode without changing the input", () => {
    const single = { ...document, dark: undefined };
    expect(resolveThemeDocument(single, "dark").mode).toBe("light");
    expect(single.base.text.base).toBe("$hue.neutral.200");
  });
  test("defaults states and resolves dialog references in the dialog context", () => {
    const result = resolveThemeDocument(document, "dark");
    expect(result.tokens.text).toMatchObject({
      action: { secondary: { pressed: "#808080" } },
    });
    expect(result.dialog.background).toMatchObject({
      base: "#141414",
      formfield: { base: "#141414" },
      action: { primary: { hovered: "#1e1e1e" } },
    });
  });
  test("reports missing references and token and hue cycles", () => {
    const missing = structuredClone(document);
    missing.base.text.base = "$text.missing";
    expect(() => resolveThemeDocument(missing)).toThrow("was not found");
    missing.base.text.base = "$text.muted";
    missing.base.text.muted = "$text.base";
    expect(() => resolveThemeDocument(missing)).toThrow(
      "Circular theme reference",
    );
    const cycle = structuredClone(document);
    cycle.dark.hue.accent = "$hue.interactive";
    cycle.dark.hue.interactive = "$hue.accent";
    expect(() => resolveThemeDocument(cycle, "dark")).toThrow(
      "Circular hue reference",
    );
  });
  test("updates the stable active object without changing the default fixture", () => {
    const stable = activeTheme;
    setActiveTheme(themeFromDocument(document, "light"));
    expect(activeTheme).toBe(stable);
    expect(oneDarkTheme.bg).toBe("#282C34");
    setActiveTheme(oneDarkTheme);
  });
  test("keeps action colors independent from syntax and uses state priority", () => {
    const custom = structuredClone(document);
    custom.base.text.action.primary.base = "#123456";
    custom.base.text.feedback.info.base = "#234567";
    custom.base.text.feedback.success.base = "#456789";
    custom.base.text.feedback.error.base = "#56789a";
    custom.base.background.action.primary.$focused = "#345678";
    const theme = themeFromDocument(custom, "dark");
    expect(theme.accent).toBe("#123456");
    expect(theme.accentSoft).toBe("#234567");
    expect(theme.selected).toBe("#1e1e1e");
    expect(
      semanticColor(theme, "background.action.primary", "fallback", {
        states: { focused: true },
      }),
    ).toBe("#345678");
    expect(theme.syntax?.function).toBe("#fab283");
    expect(theme.added).toBe("#456789");
    expect(theme.deleted).toBe("#56789a");
    expect(theme.diff?.text).toMatchObject({
      added: "#4fd6be",
      removed: "#c53b53",
    });
    expect(theme.folder).toBe("#123456");
    expect(theme.hover).toBe(theme.panelRaised);
    expect(theme.pressed).toBe(theme.border);
    expect(theme.focusRing).toBe("#123456");
    expect(
      semanticColor(theme, "text.action.primary", "fallback", {
        states: {
          disabled: true,
          pressed: true,
          focused: true,
          selected: true,
          hovered: true,
        },
      }),
    ).toBe("#808080");
    expect(semanticColor(theme, "text.base", "fallback")).toBe("#eeeeee");
    expect(semanticColor(oneDarkTheme, "text.base", "fallback")).toBe(
      "fallback",
    );
    expect(semanticColor(theme, "missing", "fallback")).toBe("fallback");
  });
  test("validates complete base, categorical, and every mode semantic hue", () => {
    expect(() =>
      resolveThemeDocument(
        { ...document, base: { ...document.base, categorical: [] } },
        "dark",
      ),
    ).toThrow("categorical");
    expect(() =>
      resolveThemeDocument(
        {
          ...document,
          light: {
            ...document.light,
            hue: { ...document.light.hue, accent: undefined },
          },
        },
        "dark",
      ),
    ).toThrow("hue");
    expect(() =>
      resolveThemeDocument(
        {
          ...document,
          base: {
            ...document.base,
            markdown: { ...document.base.markdown, codeBlock: undefined },
          },
        },
        "dark",
      ),
    ).toThrow("base.markdown.codeBlock");
    const bad = structuredClone(document);
    const primary: Record<string, unknown> = bad.base.text.action.primary;
    delete primary.base;
    expect(() =>
      resolveThemeDocument(
        {
          ...bad,
          dark: {
            ...bad.dark,
            text: { action: { primary: { base: "#abcdef" } } },
          },
        },
        "dark",
      ),
    ).toThrow("base.text.action.primary.base");
  });
  test("accepts only three semantic scales and dotted hue aliases", () => {
    const base = JSON.parse(
      JSON.stringify(document.base).replace(
        /\$hue\.[^.]+\.(\d+)/g,
        "$hue.neutral.$1",
      ),
    );
    base.categorical = ["neutral"];
    const minimum = {
      base,
      dark: {
        hue: {
          accent: document.dark.hue.purple,
          interactive: document.dark.hue.orange,
          neutral: document.dark.hue.gray,
        },
      },
    };
    expect(themeFromDocument(minimum, "dark").bg).toBe("#0a0a0a");
    const dotted = {
      base,
      dark: {
        hue: {
          "brand.primary": document.dark.hue.blue,
          "brand.alias": "$hue.brand.primary",
          accent: "$hue.brand.alias",
          interactive: "$hue.brand.primary",
          neutral: document.dark.hue.gray,
        },
      },
    };
    dotted.base.syntax.function = "$hue.brand.alias.200";
    expect(themeFromDocument(dotted, "dark").syntax?.function).toBe("#5c9cf5");
  });
  test("reads source state references with dollar keys", () => {
    const custom = structuredClone(document);
    custom.base.text.action.primary.base = "$text.action.secondary.$hovered";
    expect(
      semanticColor(
        themeFromDocument(custom, "dark"),
        "text.action.primary",
        "fallback",
      ),
    ).toBe("#eeeeee");
  });
  test("dialog action base replaces inherited states and re-resolves references", () => {
    const custom = structuredClone(document);
    custom.base.background.action.primary.$hovered = "#111111";
    const dialog = custom.base["@dialog"].background as Record<string, unknown>;
    dialog.action = { primary: { base: "#222222" } };
    dialog.raised = { base: "#333333" };
    const theme = themeFromDocument(custom, "dark");
    expect(
      semanticColor(theme, "background.action.primary", "fallback", {
        surface: "dialog",
        states: { hovered: true },
      }),
    ).toBe("#222222");
    expect(
      semanticColor(theme, "background.base", "fallback", {
        surface: "dialog",
      }),
    ).toBe("#333333");
    expect(
      semanticColor(theme, "background.formfield", "fallback", {
        surface: "dialog",
      }),
    ).toBe("#333333");
  });
});
