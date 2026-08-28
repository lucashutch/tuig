import { describe, expect, test } from "bun:test";
import { commitRowAtLine } from "../../src/ui/runtime-history.js";

describe("graph row hit testing", () => {
  test("maps each graph line to one commit", () => {
    // No working changes: body line 0 is the first commit.
    expect(commitRowAtLine(0, 0, false)).toBe(0);
    expect(commitRowAtLine(1, 0, false)).toBe(1);
    expect(commitRowAtLine(2, 0, false)).toBe(2);
    expect(commitRowAtLine(3, 0, false)).toBe(3);
  });

  test("skips the working row when it is on screen", () => {
    expect(commitRowAtLine(0, 0, true)).toBe(-1);
    expect(commitRowAtLine(1, 0, true)).toBe(0);
    expect(commitRowAtLine(2, 0, true)).toBe(1);
    expect(commitRowAtLine(3, 0, true)).toBe(2);
  });

  test("keeps scrolled viewports aligned with their first commit", () => {
    // With working changes, scroll offset 1 shows commit 0 at body line 0.
    expect(commitRowAtLine(0, 1, true)).toBe(0);
    expect(commitRowAtLine(1, 1, true)).toBe(1);
    expect(commitRowAtLine(2, 1, true)).toBe(2);
    expect(commitRowAtLine(0, 5, false)).toBe(5);
    expect(commitRowAtLine(3, 5, false)).toBe(8);
  });

  test("rejects clicks above the body", () => {
    expect(commitRowAtLine(-1, 0, false)).toBe(-1);
    expect(commitRowAtLine(-2, 0, true)).toBe(-1);
  });
});
