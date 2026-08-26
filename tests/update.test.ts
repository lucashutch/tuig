import { describe, expect, test } from "bun:test";
import { installSourceForTag, isCurrentRelease } from "../src/update";

describe("updates", () => {
  test("installs the requested release tag", () => {
    expect(installSourceForTag("v0.1.1")).toBe(
      "git+https://github.com/lucashutch/tuig.git#v0.1.1",
    );
  });

  test("recognises the current release with or without a v prefix", () => {
    expect(isCurrentRelease("0.1.2", "v0.1.2")).toBe(true);
    expect(isCurrentRelease("0.1.1", "v0.1.2")).toBe(false);
  });
});
