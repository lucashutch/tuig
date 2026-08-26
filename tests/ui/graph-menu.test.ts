import { describe, expect, test } from "bun:test";
import {
  buildGraphMenu,
  menuRowAt,
  menuWidth,
  placeMenu,
  renderMenuLine,
} from "../../src/ui/graph-menu.js";
import { primaryDecorationRef } from "../../src/ui/history.js";

const refs = [
  {
    name: "main",
    fullName: "refs/heads/main",
    sha: "a",
    current: true,
    remote: false,
  },
  {
    name: "origin/main",
    fullName: "refs/remotes/origin/main",
    sha: "b",
    current: false,
    remote: true,
  },
  {
    name: "topic",
    fullName: "refs/heads/topic",
    sha: "c",
    current: false,
    remote: false,
  },
];
const snapshot = { branch: "main", branches: refs };

describe("graph context menu", () => {
  test("offers commit actions when no branch was hit", () => {
    const menu = buildGraphMenu({ sha: "abcdef1234" }, snapshot);
    expect(menu.title).toBe("abcdef12");
    expect(menu.items.map((item) => item.action)).toEqual([
      "checkout-commit",
      "rebase-onto",
      undefined,
      "copy-sha",
    ]);
    expect(
      menu.items.find((item) => item.submenu)?.submenu?.map((x) => x.action),
    ).toEqual(["reset-soft", "reset-mixed", "reset-hard"]);
  });

  test("leads with branch actions and guards the checked-out branch", () => {
    const menu = buildGraphMenu({ sha: "a", branch: refs[0]! }, snapshot);
    expect(menu.items[0]?.action).toBe("checkout-branch");
    expect(menu.items[0]?.disabled).toBe(true);
    const remove = menu.items.find((item) => item.action === "delete-branch");
    expect(remove?.destructive).toBe(true);
    expect(remove?.disabled).toBe(true);
  });

  test("allows deleting remote-tracking branches", () => {
    const remote = refs[1]!;
    const menu = buildGraphMenu({ sha: remote.sha, branch: remote }, snapshot);
    expect(
      menu.items.find((item) => item.action === "delete-branch")?.disabled,
    ).toBe(false);
  });

  test("offers stash deletion", () => {
    const stash = {
      ref: "stash@{0}",
      sha: "d",
      createdAt: "now",
      subject: "work in progress",
    };
    const menu = buildGraphMenu({ sha: stash.sha, stash }, snapshot);
    expect(menu.items).toMatchObject([
      { action: "delete-stash", destructive: true },
    ]);
  });

  test("allows deleting a branch that is not checked out", () => {
    const menu = buildGraphMenu({ sha: "c", branch: refs[2]! }, snapshot);
    expect(
      menu.items.find((item) => item.action === "delete-branch")?.disabled,
    ).toBe(false);
    expect(
      menu.items.find((item) => item.action === "rebase-onto")?.label,
    ).toBe("Rebase main onto topic");
  });

  test("marks a hard reset as the destructive choice", () => {
    const reset = buildGraphMenu({ sha: "a" }, snapshot).items.find(
      (item) => item.submenu,
    );
    expect(reset?.submenu?.at(-1)?.destructive).toBe(true);
  });

  test("keeps a menu on screen by flipping it at the edges", () => {
    expect(placeMenu(70, 20, 40, 6, 80, 24)).toEqual({ left: 40, top: 16 });
    expect(placeMenu(2, 2, 40, 6, 80, 24)).toEqual({ left: 2, top: 2 });
  });

  test("maps a pointer to a row, ignoring the border and separators", () => {
    const menu = {
      left: 10,
      top: 4,
      width: 20,
      items: [{ label: "one" }, { label: "", separator: true }],
    };
    expect(menuRowAt(menu, 12, 5)).toBe(0);
    expect(menuRowAt(menu, 12, 6)).toBeUndefined();
    expect(menuRowAt(menu, 12, 4)).toBeUndefined();
    expect(menuRowAt(menu, 40, 5)).toBeUndefined();
  });

  test("pads rows and flags submenus", () => {
    expect(renderMenuLine({ label: "Reset", submenu: [] }, 12)).toBe(
      " Reset    ▸ ",
    );
    // A menu is wide enough to print its longest label in full.
    const item = { label: "Checkout this commit (detached)" };
    expect(renderMenuLine(item, menuWidth([item]) - 2)).toBe(` ${item.label} `);
    expect(renderMenuLine({ label: "", separator: true }, 4)).toBe("────");
    expect(menuWidth([{ label: "x" }])).toBe(20);
  });

  test("resolves the ref behind a row label, keeping a remote ref remote", () => {
    expect(
      primaryDecorationRef(["HEAD -> main", "origin/main"], refs)?.name,
    ).toBe("main");
    expect(primaryDecorationRef(["origin/main"], refs)?.name).toBe(
      "origin/main",
    );
    expect(primaryDecorationRef(["tag: v1"], refs)).toBeUndefined();
    expect(primaryDecorationRef(["origin/gone"], refs)).toBeUndefined();
  });
});
