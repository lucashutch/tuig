import { expect, test } from "bun:test";
import { interactionBackground, oneDarkTheme } from "../../src/ui/theme.js";

test("pressed beats selected, and selected beats hovered", () => {
  const base = oneDarkTheme.panel;
  const color = (states: Parameters<typeof interactionBackground>[2]) =>
    interactionBackground(oneDarkTheme, base, states);
  expect(color({})).toBe(base);
  expect(color({ hovered: true })).toBe(oneDarkTheme.hover);
  expect(color({ hovered: true, selected: true })).toBe(oneDarkTheme.selected);
  expect(color({ hovered: true, selected: true, pressed: true })).toBe(
    oneDarkTheme.pressed,
  );
});

test("hover differs from selected so menus can show both", () => {
  expect(oneDarkTheme.hover).not.toBe(oneDarkTheme.selected);
  expect(oneDarkTheme.hover).not.toBe(oneDarkTheme.panelRaised);
});
