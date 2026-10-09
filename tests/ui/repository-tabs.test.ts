import { describe, expect, test } from "bun:test";
import {
  hitTestRepositoryTabs,
  layoutRepositoryTabs,
  repositoryTabHit,
  repositoryTabText,
  reorderRepositoryTabs,
  dragRepositoryTab,
  submoduleTabLabel,
  worktreeTabLabel,
} from "../../src/ui/repository-tabs.js";

describe("repository tab layout", () => {
  test("pads short names to ten label columns and centres them", () => {
    const layout = layoutRepositoryTabs(
      [{ id: "short", label: "tuig" }],
      "short",
      80,
    );
    expect(repositoryTabText(layout.tabs[0]!)).toBe("     tuig    ×  ");
  });

  test("drags a short tab past a long one without swapping back", () => {
    const tabs = [
      { id: "short", label: "tuig" },
      { id: "long", label: "⎇ a-long-worktree-name · lib_cellx" },
    ];
    const layout = layoutRepositoryTabs(tabs, "short", 120);
    const long = layout.tabs[1];
    const drag = (column: number) =>
      dragRepositoryTab(tabs, "short", column, "short", 120)?.map(
        (tab) => tab.id,
      );
    // Entering the long tab is not enough: after a swap the pointer would
    // still be over the long tab, and the next move would swap them back.
    expect(drag(long!.start)).toBeUndefined();
    // Near the long tab's end, the short tab would sit under the pointer.
    expect(drag(long!.end - 1)).toEqual(["long", "short"]);
  });

  test("labels a submodule with its parent repository", () => {
    expect(submoduleTabLabel("/work/app/vendor/library", "/work/app")).toBe(
      "\uf414 library · app",
    );
  });

  test("labels a linked worktree with its main repository", () => {
    expect(
      worktreeTabLabel("/work/app/.claude/worktrees/feature", "/work/app"),
    ).toBe("⎇ feature · app");
  });

  test("marks the active tab and separates select, close, and open hits", () => {
    const layout = layoutRepositoryTabs(
      [
        { id: "one", label: "one", path: "/work/one" },
        { id: "two", label: "two", path: "/work/two" },
      ],
      "two",
      40,
    );
    const active = layout.tabs[1]!;
    expect(active).toMatchObject({ active: true, style: "active" });
    expect(layout.tabs[0]).toMatchObject({ active: false, style: "inactive" });
    expect(repositoryTabHit(layout, active.start)).toEqual({
      action: "select",
      tabId: "two",
    });
    expect(repositoryTabHit(layout, active.closeStart)).toEqual({
      action: "close",
      tabId: "two",
    });
    expect(hitTestRepositoryTabs(layout, layout.open.start)).toEqual({
      action: "open",
    });
    expect(active.closeEnd - active.closeStart).toBe(1);
    expect(active.end - active.closeEnd).toBe(2);
    expect(layout.tabs[1]!.start - layout.tabs[0]!.end).toBe(1);
    expect(layout.open.start).toBe(layout.tabs.at(-1)!.end + 1);
    expect(layout.open.end).toBeLessThan(layout.width);
  });

  test("clips long labels and keeps the active tab visible when tabs overflow", () => {
    const layout = layoutRepositoryTabs(
      [
        { id: "first", label: "a-very-long-first-repository-name" },
        { id: "active", label: "a-very-long-active-repository-name" },
        { id: "last", label: "a-very-long-last-repository-name" },
      ],
      "active",
      12,
    );
    expect(layout.hiddenBefore + layout.hiddenAfter).toBeGreaterThan(0);
    expect(layout.tabs.some((tab) => tab.id === "active")).toBe(true);
    expect(layout.tabs.every((tab) => tab.end <= layout.width)).toBe(true);
    expect(layout.tabs.at(-1)?.end).toBeLessThanOrEqual(layout.open.start);
    expect(
      layout.tabs.every(
        (tab) => Bun.stringWidth(tab.label) <= tab.end - tab.start,
      ),
    ).toBe(true);
    expect(repositoryTabHit(layout, layout.width + 1)).toBeUndefined();
  });

  test("renders every tab to its hit-test width, including wide labels", () => {
    const layout = layoutRepositoryTabs(
      [
        { id: "one", label: "one" },
        { id: "wide", label: "資料" },
      ],
      "one",
      40,
    );
    expect(
      layout.tabs.map((tab) => Bun.stringWidth(repositoryTabText(tab))),
    ).toEqual(layout.tabs.map((tab) => tab.end - tab.start));
    expect(repositoryTabText(layout.tabs[0]!)).toBe("     one     ×  ");
  });

  test("reorders a dragged tab without losing tab identity", () => {
    const tabs = [{ id: "one" }, { id: "two" }, { id: "three" }];
    expect(
      reorderRepositoryTabs(tabs, "three", "one").map((tab) => tab.id),
    ).toEqual(["three", "one", "two"]);
    expect(
      reorderRepositoryTabs(tabs, "one", "three").map((tab) => tab.id),
    ).toEqual(["two", "three", "one"]);
    expect(tabs.map((tab) => tab.id)).toEqual(["one", "two", "three"]);
  });
});
