import { describe, expect, test } from "bun:test";
import {
  clampPaletteViewport,
  commandMatches,
  nextEnabledCommand,
  type PaletteCommand,
} from "../../src/ui/command-palette.js";

const command = (
  id: string,
  title: string,
  category: PaletteCommand["category"] = "Repository",
  extra: Partial<PaletteCommand> = {},
): PaletteCommand => ({ id, title, category, run() {}, ...extra });

describe("command palette search", () => {
  test("ranks exact and prefix title matches ahead of keyword matches", () => {
    const matches = commandMatches(
      [
        command("push", "Push"),
        command("force", "Publish branch", "Repository", {
          keywords: ["push"],
        }),
        command("pull", "Pull"),
      ],
      "push",
    );
    expect(matches.map(({ command }) => command.id)).toEqual(["push", "force"]);
  });

  test("supports multi-token and ordered fuzzy matching", () => {
    const commands = [
      command("filter", "Filter branches", "Navigation"),
      command("fetch", "Fetch from remotes"),
    ];
    expect(commandMatches(commands, "fil bra")[0]?.command.id).toBe("filter");
    expect(commandMatches(commands, "ftch")[0]?.command.id).toBe("fetch");
  });

  test("keeps disabled matches visible", () => {
    const disabled = command("pull", "Pull", "Repository", {
      enabled: false,
      disabledReason: "No upstream",
    });
    expect(commandMatches([disabled], "pull")[0]?.command).toBe(disabled);
  });
});

describe("command palette selection", () => {
  test("navigation skips disabled commands without wrapping", () => {
    const matches = commandMatches(
      [
        command("one", "One"),
        command("two", "Two", "Repository", { enabled: false }),
        command("three", "Three"),
      ],
      "",
    );
    expect(nextEnabledCommand(matches, 0, 1)).toBe(2);
    expect(nextEnabledCommand(matches, 2, 1)).toBe(2);
    expect(nextEnabledCommand(matches, 0, -1)).toBe(0);
  });

  test("viewport follows the selected command", () => {
    expect(clampPaletteViewport(5, 0, 4, 10)).toBe(2);
    expect(clampPaletteViewport(1, 4, 4, 10)).toBe(1);
    expect(clampPaletteViewport(8, 8, 4, 10)).toBe(6);
  });
});
