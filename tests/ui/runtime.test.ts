import { expect, test } from "bun:test";
import {
  BRAILLE_SPINNER_FRAMES,
  BRAILLE_SPINNER_INTERVAL_MS,
  createBrailleSpinner,
} from "../../src/ui/runtime.js";

test("braille spinner starts, advances, and stops without duplicate timers", () => {
  const frames: string[] = [];
  let tick: (() => void) | undefined;
  let cancelled = 0;
  const spinner = createBrailleSpinner((frame) => frames.push(frame), {
    schedule(callback, intervalMs) {
      expect(intervalMs).toBe(BRAILLE_SPINNER_INTERVAL_MS);
      tick = callback;
      return callback;
    },
    cancel(handle) {
      expect(handle).toBe(tick);
      cancelled += 1;
    },
  });

  spinner.start();
  expect(frames).toEqual([BRAILLE_SPINNER_FRAMES[0]]);
  tick?.();
  expect(frames).toEqual([
    BRAILLE_SPINNER_FRAMES[0],
    BRAILLE_SPINNER_FRAMES[1],
  ]);
  spinner.start();
  expect(cancelled).toBe(0);
  spinner.stop();
  expect(cancelled).toBe(1);
  spinner.start();
  expect(frames.at(-1)).toBe(BRAILLE_SPINNER_FRAMES[0]);
  spinner.stop();
  expect(cancelled).toBe(2);
});
