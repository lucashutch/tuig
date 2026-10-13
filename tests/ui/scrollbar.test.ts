import { describe, expect, test } from "bun:test";
import {
  scrollbarCell,
  scrollbarDrag,
  scrollbarGrab,
  scrollbarThumb,
  type ScrollbarCell,
} from "../../src/ui/scrollbar.js";

const sizes = [
  [11, 10],
  [15, 10],
  [100, 10],
  [5000, 37],
] as const;

/** Rows of the track the thumb covers at least half of. */
function thumbRows(total: number, start: number, viewport: number) {
  const thumb = scrollbarThumb(total, start, viewport);
  return Array.from({ length: viewport }, (_, row) =>
    scrollbarCell(thumb, row),
  );
}

describe("scrollbar dragging", () => {
  test("a press without movement keeps every start", () => {
    for (const [total, viewport] of sizes) {
      for (let start = 0; start <= total - viewport; start++) {
        const thumb = scrollbarThumb(total, start, viewport);
        for (let pointer = 0; pointer < viewport; pointer++) {
          if (scrollbarCell(thumb, pointer) === "none") continue;
          const grab = scrollbarGrab(total, start, viewport, pointer);
          expect(
            scrollbarDrag(grab, total, start, viewport, pointer).start,
          ).toBe(start);
        }
      }
    }
  });

  test("each pointer row moves the view by an even step", () => {
    for (const [total, viewport] of sizes) {
      const grab = scrollbarGrab(total, 0, viewport, 0);
      const starts = Array.from(
        { length: viewport },
        (_, pointer) => scrollbarDrag(grab, total, 0, viewport, pointer).start,
      );
      const steps = starts.slice(1).map((start, i) => start - starts[i]!);
      const moving = steps.filter((step) => step > 0);
      expect(steps.every((step) => step >= 0)).toBe(true);
      expect(Math.max(...moving) - Math.min(...moving)).toBeLessThanOrEqual(1);
    }
  });

  test("reaches the first and last rows at the track ends", () => {
    const grab = scrollbarGrab(100, 45, 10, 4);
    expect(scrollbarDrag(grab, 100, 45, 10, -5).start).toBe(0);
    expect(scrollbarDrag(grab, 100, 45, 10, 50).start).toBe(90);
  });

  test("centres the thumb on a track press away from it", () => {
    const grab = scrollbarGrab(100, 0, 20, 15);
    const { start } = scrollbarDrag(grab, 100, 0, 20, 15);
    expect(thumbRows(100, start, 20)).toEqual([
      ...Array<ScrollbarCell>(13).fill("none"),
      "lower",
      "full",
      "full",
      "full",
      "upper",
      "none",
      "none",
    ]);
  });

  test("keeps the view still when rows load mid-drag", () => {
    const grab = scrollbarGrab(250, 0, 20, 0);
    const before = scrollbarDrag(grab, 250, 0, 20, 10);
    const after = scrollbarDrag(before.grab, 500, before.start, 20, 10);
    expect(after.start).toBe(before.start);
    // The first move after the load still scrolls, by the new step size.
    const moved = scrollbarDrag(before.grab, 500, before.start, 20, 9);
    expect(moved.start).toBeLessThan(before.start);
    expect(before.start - moved.start).toBeLessThan(40);
  });

  test("moves the thumb in half-row steps", () => {
    expect(thumbRows(100, 0, 4)).toEqual(["full", "none", "none", "none"]);
    // 96 rows over 6 half rows of travel: each half row is 16 rows.
    expect(thumbRows(100, 16, 4)).toEqual(["lower", "upper", "none", "none"]);
    expect(thumbRows(100, 32, 4)).toEqual(["none", "full", "none", "none"]);
  });

  test("does not scroll content that fits", () => {
    const grab = scrollbarGrab(10, 0, 10, 5);
    expect(scrollbarDrag(grab, 10, 0, 10, 9).start).toBe(0);
  });
});
