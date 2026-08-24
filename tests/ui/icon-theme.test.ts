import { describe, expect, test } from "bun:test";
import { resolveMaterialIcon } from "../../src/ui/icon-theme.js";

describe("material icon theme", () => {
  test("uses filename associations before extensions", () => {
    expect(resolveMaterialIcon("package.json", false)).not.toEqual(
      resolveMaterialIcon("unknown.json", false),
    );
  });

  test("distinguishes open and closed generic folders", () => {
    expect(resolveMaterialIcon("unknown-folder", true, false).glyph).not.toBe(
      resolveMaterialIcon("unknown-folder", true, true).glyph,
    );
  });
});
