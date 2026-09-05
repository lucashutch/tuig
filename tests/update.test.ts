import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installSourceForTag, isCurrentRelease } from "../src/update";

// Run the real updater with a fake installer, without network requests or
// touching the user's global packages. Each test has its own process and PATH.
async function runUpdate(installer: string, version = "0.1.8") {
  const directory = await mkdtemp(join(tmpdir(), "tuig-update-test-"));
  try {
    await writeFile(join(directory, "bun"), `#!/bin/sh\n${installer}\n`, {
      mode: 0o755,
    });
    const moduleUrl = new URL("../src/update.ts", import.meta.url).href;
    const script = `
      import { updateTuig } from ${JSON.stringify(moduleUrl)};
      globalThis.fetch = async () => Response.json({ tag_name: "v0.1.9" });
      try { await updateTuig(${JSON.stringify(version)}); }
      catch (error) { console.error(error.message); process.exitCode = 1; }
    `;
    const child = Bun.spawn([process.execPath, "-e", script], {
      env: { ...process.env, PATH: `${directory}:${process.env.PATH ?? ""}` },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("updates", () => {
  test("installs the requested release tag", () => {
    expect(installSourceForTag("v0.1.1")).toBe(
      "tuig@git+https://github.com/lucashutch/tuig.git#v0.1.1",
    );
  });

  test("recognises the current release with or without a v prefix", () => {
    expect(isCurrentRelease("0.1.2", "v0.1.2")).toBe(true);
    expect(isCurrentRelease("0.1.1", "v0.1.2")).toBe(false);
  });

  test("passes the named Git dependency to Bun and reports success", async () => {
    const result = await runUpdate(`
      test "$#" -eq 3 &&
      test "$1" = install &&
      test "$2" = -g &&
      test "$3" = 'tuig@git+https://github.com/lucashutch/tuig.git#v0.1.9'
    `);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Tuig v0.1.9 is ready.");
    expect(result.stderr).toBe("");
  });

  test("reports Bun's stderr and exit code on failure", async () => {
    const result = await runUpdate(
      "echo 'installer banner'; echo 'DependencyLoop' >&2; exit 42",
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      "Bun could not install tuig v0.1.9 (exit 42):\nDependencyLoop\n",
    );
    expect(result.stdout).not.toContain("is ready");
  });

  test("falls back to stdout when Bun leaves stderr empty", async () => {
    const result = await runUpdate("echo 'Installation failed'; exit 1");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("(exit 1):\nInstallation failed");
  });

  test("reports silent installer failures", async () => {
    const result = await runUpdate("exit 2");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("Bun could not install tuig v0.1.9 (exit 2).\n");
  });

  test("does not invoke Bun when already up to date", async () => {
    const result = await runUpdate("exit 99", "0.1.9");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Tuig is up to date.");
    expect(result.stdout).not.toContain("Upgrading");
  });
});
