import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import {
  createRuntimeWidgets,
  type RuntimeWidgetActions,
} from "../../src/ui/runtime-widgets.js";

test("a drag that starts on a sidebar section header does not resize the pane", async () => {
  const { renderer, renderOnce, mockMouse } = await createTestRenderer({
    width: 80,
    height: 24,
  });
  const calls: string[] = [];
  const actions = new Proxy({} as RuntimeWidgetActions, {
    get:
      (_target, name: string) =>
      (...args: unknown[]) => {
        if (name === "resizeLeft" || name === "sidebarToggle")
          calls.push(`${name}(${args.join(",")})`);
      },
  });
  try {
    const widgets = createRuntimeWidgets(renderer, actions);
    widgets.sidebar.left = 0;
    widgets.sidebar.width = 30;
    widgets.sidebar.height = 20;
    widgets.leftDivider.left = 30;
    widgets.leftDivider.height = 20;
    const { box, header } = widgets.sidebarSections.remote;
    box.top = 5;
    header.content = "REMOTES";
    await renderOnce();

    const row = Number(box.y);
    await mockMouse.drag(5, row, 50, row + 3);
    await renderOnce();

    expect(calls).toEqual(["sidebarToggle(remote)"]);
  } finally {
    renderer.destroy();
  }
});
