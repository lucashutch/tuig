import { describe, expect, test } from "bun:test";
import {
  RuntimePopupController,
  type RuntimePopupContext,
} from "../../src/ui/runtime-popup.js";

function controller() {
  const widget = () => ({ visible: false });
  const context = {
    terminalSize: () => ({ width: 80, height: 24 }),
    overlayCatcher: widget(),
    menuBox: widget(),
    menuText: widget(),
    submenuBox: widget(),
    submenuText: widget(),
    promptInput: { ...widget(), blur() {} },
    closed() {},
  } as unknown as RuntimePopupContext;
  return new RuntimePopupController(context);
}

describe("popup keyboard activation", () => {
  test("Enter-style activation chooses the first enabled action", () => {
    const popup = controller();
    let selected = "";
    popup.open(
      "Delete branch",
      [
        { label: "Delete local branch?", disabled: true },
        { label: "", separator: true },
        { label: "Delete topic", destructive: true },
        { label: "Cancel" },
      ],
      10,
      5,
      (item) => {
        selected = item.label;
      },
    );

    popup.activate();

    expect(selected).toBe("Delete topic");
    expect(popup.isOpen).toBeFalse();
  });

  test("activates an initially selected action", () => {
    const popup = controller();
    let selected = "";
    popup.open(
      "Confirm",
      [{ label: "Delete" }, { label: "Cancel" }],
      10,
      5,
      (item) => {
        selected = item.label;
      },
      false,
      1,
    );

    popup.activate();

    expect(selected).toBe("Cancel");
  });
});
