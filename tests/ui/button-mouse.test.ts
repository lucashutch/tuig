import { expect, test } from "bun:test";
import type { TextBufferRenderable } from "@opentui/core";
import { buttonMouse } from "../../src/ui/runtime-widgets.js";
import { oneDarkTheme } from "../../src/ui/theme.js";

test("buttons highlight, press, release, and cancel on exit", () => {
  let clicks = 0;
  const events = buttonMouse(() => clicks++);
  const widget = {
    bg: oneDarkTheme.panelRaised,
  } as unknown as TextBufferRenderable;
  events.onMouseOver.call(widget);
  expect<unknown>(widget.bg).toBe(oneDarkTheme.selected);
  events.onMouseDown.call(widget, { button: 0 });
  expect<unknown>(widget.bg).toBe(oneDarkTheme.dividerActive);
  expect(clicks).toBe(0);
  events.onMouseUp.call(widget, { button: 0 });
  expect(clicks).toBe(1);
  expect<unknown>(widget.bg).toBe(oneDarkTheme.selected);
  events.onMouseDown.call(widget, { button: 0 });
  events.onMouseOut.call(widget);
  events.onMouseUp.call(widget, { button: 0 });
  expect(clicks).toBe(1);
  expect<unknown>(widget.bg).toBe(oneDarkTheme.panelRaised);
});

test("disabled buttons and secondary clicks do not activate", () => {
  let clicks = 0;
  const widget = {
    bg: oneDarkTheme.panelRaised,
  } as unknown as TextBufferRenderable;
  const disabled = buttonMouse(
    () => clicks++,
    () => false,
  );
  disabled.onMouseOver.call(widget);
  disabled.onMouseDown.call(widget, { button: 0 });
  disabled.onMouseUp.call(widget, { button: 0 });
  expect<unknown>(widget.bg).toBe(oneDarkTheme.panelRaised);
  const events = buttonMouse(() => clicks++);
  events.onMouseDown.call(widget, { button: 2 });
  events.onMouseUp.call(widget, { button: 2 });
  expect(clicks).toBe(0);
});
