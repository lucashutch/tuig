#!/usr/bin/env bun
import { createGitRepository } from "./git/index.js";
import { runTuig } from "./ui/runtime.js";
import { HELP, VERSION, parseArgs } from "./cli.js";
import { updateTuig } from "./update.js";

try {
  const action = parseArgs(process.argv.slice(2));
  if (action.kind === "help") {
    console.log(HELP);
  } else if (action.kind === "version") {
    console.log(`tuig ${VERSION}`);
  } else if (action.kind === "update") {
    await updateTuig(VERSION);
  } else {
    const repository = await createGitRepository(action.path);
    await runTuig(repository);
  }
} catch (error) {
  console.error(
    `tuig: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
