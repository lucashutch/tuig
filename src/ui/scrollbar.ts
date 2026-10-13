/**
 * Scrollbar geometry in half-cell units.
 *
 * Painting and dragging share these numbers. Half cells let the thumb move in
 * steps half a row tall, using upper and lower half-block glyphs.
 */
export function scrollbarThumb(total: number, start: number, viewport: number) {
  const track = Math.max(0, viewport) * 2;
  const maxStart = Math.max(0, total - viewport);
  if (maxStart === 0) return { size: track, top: 0, travel: 0, maxStart };
  const size = Math.min(
    track,
    Math.max(2, Math.floor((track * viewport) / total)),
  );
  const travel = track - size;
  const clamped = Math.max(0, Math.min(maxStart, start));
  return {
    size,
    top: Math.round((clamped * travel) / maxStart),
    travel,
    maxStart,
  };
}

export type ScrollbarCell = "full" | "upper" | "lower" | "none";

/** Which halves of one track row the thumb covers. */
export function scrollbarCell(
  thumb: ReturnType<typeof scrollbarThumb>,
  row: number,
): ScrollbarCell {
  const covers = (half: number) =>
    half >= thumb.top && half < thumb.top + thumb.size;
  const upper = covers(row * 2);
  const lower = covers(row * 2 + 1);
  return upper && lower ? "full" : upper ? "upper" : lower ? "lower" : "none";
}

/**
 * Where the pointer holds the thumb, in half cells from the thumb's exact top.
 * `total`, `viewport`, and `pointer` record the geometry and pointer row the
 * offset was last measured against.
 */
export type ScrollbarGrab = {
  offset: number;
  total: number;
  viewport: number;
  pointer: number;
};

/** A pointer row maps to the middle of its cell. */
const pointerHalf = (pointer: number) => pointer * 2 + 1;

/** The thumb top for `start` without rounding, in half cells. */
function exactTop(thumb: ReturnType<typeof scrollbarThumb>, start: number) {
  return thumb.maxStart === 0
    ? 0
    : (Math.max(0, Math.min(thumb.maxStart, start)) * thumb.travel) /
        thumb.maxStart;
}

/**
 * Grab the thumb at the pressed row. A press on the thumb keeps the offset, so
 * the view does not move until the pointer does. A press elsewhere on the
 * track centres the thumb on the pointer.
 */
export function scrollbarGrab(
  total: number,
  start: number,
  viewport: number,
  pointer: number,
): ScrollbarGrab {
  const thumb = scrollbarThumb(total, start, viewport);
  const half = pointerHalf(pointer);
  // Test the whole row, since a thumb can end halfway down the pressed row.
  const onThumb = scrollbarCell(thumb, pointer) !== "none";
  return {
    offset: onThumb ? half - exactTop(thumb, start) : thumb.size / 2,
    total,
    viewport,
    pointer,
  };
}

/**
 * The first visible row for the pointer during a drag.
 *
 * Each pointer row moves the view by the same number of rows. If the row count
 * or viewport changed since the grab, for example because more history loaded,
 * the grab is measured again so the view stays where it is.
 */
export function scrollbarDrag(
  grab: ScrollbarGrab,
  total: number,
  start: number,
  viewport: number,
  pointer: number,
): { start: number; grab: ScrollbarGrab } {
  const thumb = scrollbarThumb(total, start, viewport);
  // Measure again from the previous pointer row, so the view stays put and
  // this event's movement still applies.
  const offset =
    grab.total === total && grab.viewport === viewport
      ? grab.offset
      : pointerHalf(grab.pointer) - exactTop(thumb, start);
  const next = { offset, total, viewport, pointer };
  if (thumb.travel === 0) return { start: 0, grab: next };
  const top = Math.max(
    0,
    Math.min(thumb.travel, pointerHalf(pointer) - offset),
  );
  return {
    start: Math.round((top * thumb.maxStart) / thumb.travel),
    grab: next,
  };
}
