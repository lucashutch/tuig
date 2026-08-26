import { describe, expect, test } from "bun:test";
import { installSourceForTag } from "../src/update";

describe("updates", () => {
  test("installs the requested release tag", () => {
    expect(installSourceForTag("v0.1.1")).toBe(
      "git+https://github.com/lucashutch/tuig.git#v0.1.1",
    );
  });
});
