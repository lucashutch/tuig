#!/usr/bin/env bun
/**
 * Launch guig on a repository with a single command:
 *
 *   bun run guig -- ~/code/my-project
 *
 * Rebuilds the renderer and main process when sources are newer than the
 * last build (pass --rebuild to force), then opens the native Electron
 * window on the resolved repository path.
 */
import { Glob } from "bun";
import { statSync } from "node:fs";
import { join, resolve } from "node:path";

const dir = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const args = Bun.argv.slice(2).filter((arg) => arg !== "--rebuild");
const forceRebuild = Bun.argv.includes("--rebuild");
const repoArg = args.find((arg) => !arg.startsWith("-")) ?? process.cwd();
const repoPath = resolve(process.cwd(), repoArg);

const electronBin = join(dir, "node_modules", ".bin", "electron");
const mainEntry = join(dir, "dist", "electron", "electron", "main.js");
try {
  statSync(electronBin);
} catch {
  console.error(
    "guig: electron is not installed. Run `bun install` in guig/ first.",
  );
  process.exit(1);
}

async function sourceNewerThanOutputs(): Promise<boolean> {
  const outputs = [
    join(dir, "dist", "frontend", "index.html"),
    join(dir, "dist", "electron", "electron", "main.js"),
    join(dir, "dist", "electron", "electron", "preload.cjs"),
  ];
  let oldestOutput = Infinity;
  for (const output of outputs) {
    try {
      oldestOutput = Math.min(oldestOutput, statSync(output).mtimeMs);
    } catch {
      return true;
    }
  }
  const glob = new Glob("**/*.{ts,tsx,css,html}");
  for await (const file of glob.scan({ cwd: dir, onlyFiles: true })) {
    if (
      file.startsWith("node_modules/") ||
      file.startsWith("dist/") ||
      file.startsWith("release/")
    ) {
      continue;
    }
    if (statSync(join(dir, file)).mtimeMs > oldestOutput) return true;
  }
  return false;
}

/** Fresh checkouts lack the root-owned setuid sandbox helper; only then. */
function needsNoSandbox(): boolean {
  try {
    const sandbox = statSync(
      join(dir, "node_modules", "electron", "dist", "chrome-sandbox"),
    );
    return (sandbox.mode & 0o4000) === 0 || sandbox.uid !== 0;
  } catch {
    return true;
  }
}

if (forceRebuild || (await sourceNewerThanOutputs())) {
  console.log("guig: building...");
  const build = Bun.spawn(["bun", "run", "build"], {
    cwd: dir,
    stdio: ["inherit", "inherit", "inherit"],
  });
  const code = await build.exited;
  if (code !== 0) {
    console.error("guig: build failed");
    process.exit(typeof code === "number" ? code : 1);
  }
} else {
  console.log("guig: build is fresh, skipping (pass --rebuild to force)");
}

const child = Bun.spawn([electronBin, mainEntry, repoPath], {
  stdio: ["inherit", "inherit", "inherit"],
  env: {
    ...process.env,
    ...(needsNoSandbox() ? { ELECTRON_DISABLE_SANDBOX: "1" } : {}),
  },
});
const code = await child.exited;
process.exit(typeof code === "number" ? code : 0);
