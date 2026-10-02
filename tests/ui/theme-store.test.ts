import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import fixture from "../../src/ui/themes/opencode.json";
import {
  loadThemeCatalog,
  loadThemePreferences,
  saveThemePreferences,
} from "../../src/ui/theme-store";
import {
  activeTheme,
  oneDarkTheme,
  setActiveTheme,
  semanticColor,
} from "../../src/ui/theme";

test("discovers ancestor overrides, reports bad files, and persists only tuig preferences", async () => {
  const root = await mkdtemp(join(tmpdir(), "tuig-theme-test-"));
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = join(root, "config");
  try {
    const global = join(root, "config", "tuig", "themes");
    const parent = join(root, ".tuig", "themes");
    const child = join(root, "repo", ".tuig", "themes");
    for (const directory of [global, parent, child])
      await mkdir(directory, { recursive: true });
    await writeFile(join(global, "custom.json"), JSON.stringify(fixture));
    const override = structuredClone(fixture);
    override.base.border.base = "#123456";
    await writeFile(join(parent, "custom.json"), JSON.stringify(override));
    expect(
      (await loadThemeCatalog(join(root, "repo"))).resolve("custom", "dark")
        .border,
    ).toBe("#123456");
    await writeFile(join(child, "custom.json"), "{bad");
    const catalog = await loadThemeCatalog(join(root, "repo"));
    expect(catalog.errors).toHaveLength(1);
    expect(() => catalog.resolve("custom", "dark")).toThrow("custom.json");
    expect(() => catalog.resolve("../custom", "dark")).toThrow(
      "Invalid theme name",
    );
    expect(catalog.resolve("one-dark", "light").bg).toBe("#282C34");
    const custom = structuredClone(fixture);
    custom.base.background.action.primary.base = "#111111";
    custom.base.background.action.primary.$hovered = "#222222";
    custom.base.background.action.primary.$focused = "#333333";
    custom.base["@dialog"].background.action.primary = {
      ...custom.base["@dialog"].background.action.primary,
      ...{ base: "#444444", $focused: "#666666" },
      $hovered: "#555555",
    };
    await writeFile(join(child, "Mon thème.v2.json"), JSON.stringify(custom));
    const semanticCatalog = await loadThemeCatalog(join(root, "repo"));
    setActiveTheme(semanticCatalog.resolve("Mon thème.v2", "dark"));
    try {
      expect(
        semanticColor(activeTheme, "background.action.primary", "fallback"),
      ).toBe("#111111");
      expect(
        semanticColor(activeTheme, "background.action.primary", "fallback", {
          states: { hovered: true },
        }),
      ).toBe("#222222");
      expect(
        semanticColor(activeTheme, "background.action.primary", "fallback", {
          states: { focused: true },
        }),
      ).toBe("#333333");
      expect(
        semanticColor(activeTheme, "background.action.primary", "fallback", {
          surface: "dialog",
        }),
      ).toBe("#444444");
      expect(
        semanticColor(activeTheme, "background.action.primary", "fallback", {
          surface: "dialog",
          states: { hovered: true },
        }),
      ).toBe("#555555");
      expect(
        semanticColor(activeTheme, "background.action.primary", "fallback", {
          surface: "dialog",
          states: { focused: true },
        }),
      ).toBe("#666666");
    } finally {
      setActiveTheme(oneDarkTheme);
    }
    for (const invalid of ["", ".", "..", "a/b", "a\\b", "a\0b", "a\nb"])
      expect(() => semanticCatalog.resolve(invalid, "dark")).toThrow(
        "Invalid theme name",
      );
    expect(await loadThemePreferences()).toEqual({
      name: "one-dark",
      mode: "system",
    });
    await saveThemePreferences({ name: "Mon thème.v2", mode: "system" });
    expect(await loadThemePreferences()).toEqual({
      name: "Mon thème.v2",
      mode: "system",
    });
    await saveThemePreferences({ name: "opencode", mode: "light" });
    expect(await loadThemePreferences()).toEqual({
      name: "opencode",
      mode: "light",
    });
    await writeFile(
      join(root, "config", "tuig", "theme.json"),
      '{"name":"opencode","mode":"bad"}',
    );
    await expect(loadThemePreferences()).rejects.toThrow("Invalid theme mode");
    await writeFile(
      join(child, "empty-category.json"),
      JSON.stringify({
        ...fixture,
        base: { ...fixture.base, categorical: [] },
      }),
    );
    await writeFile(
      join(child, "missing-semantic.json"),
      JSON.stringify({
        ...fixture,
        dark: { ...fixture.dark, hue: { neutral: fixture.dark.hue.gray } },
      }),
    );
    const invalidCatalog = await loadThemeCatalog(join(root, "repo"));
    expect(() => invalidCatalog.resolve("empty-category", "dark")).toThrow(
      "categorical",
    );
    expect(() => invalidCatalog.resolve("missing-semantic", "dark")).toThrow(
      "semantic hue",
    );
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
    await rm(root, { recursive: true, force: true });
  }
});
