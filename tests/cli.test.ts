import { describe, expect, test } from "bun:test";
import { parseArgs } from "../src/cli";

describe("CLI arguments", () => {
  test("opens the current directory by default", () => {
    expect(parseArgs([], "/tmp/project")).toEqual({
      kind: "run",
      path: "/tmp/project",
      clean: false,
      pathProvided: false,
    });
  });

  test("supports help, version, and update", () => {
    expect(parseArgs(["--help"])).toEqual({ kind: "help" });
    expect(parseArgs(["-v"])).toEqual({ kind: "version" });
    expect(parseArgs(["update"])).toEqual({ kind: "update" });
  });

  test("supports a repository directory option", () => {
    expect(parseArgs(["-C", "/tmp/project"])).toEqual({
      kind: "run",
      path: "/tmp/project",
      clean: false,
      pathProvided: true,
    });
  });

  test("supports a clean session launch", () => {
    expect(parseArgs(["--clean", "/tmp/project"])).toEqual({
      kind: "run",
      path: "/tmp/project",
      clean: true,
      pathProvided: true,
    });
  });

  test("rejects unknown options", () => {
    expect(() => parseArgs(["--wat"])).toThrow("unknown option: --wat");
  });
});
