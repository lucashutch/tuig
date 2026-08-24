#!/usr/bin/env bun
import { createGitRepository } from "./git/index.js";
import { runTuig } from "./ui/runtime.js";

const target = process.argv[2] ?? process.cwd();
try {
  const repository = await createGitRepository(target);
  await runTuig(repository);
} catch (error) {
  console.error(
    `tuig: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
