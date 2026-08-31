#!/usr/bin/env bun
/**
 * Headless performance/memory probe for the data layer tuig sits on.
 *
 * Usage: bun run scripts/profile.ts <repo> [repo...] [--pages N] [--page-size N]
 */
import {
  GitRepositoryService,
  DEFAULT_HISTORY_PAGE,
} from "../src/git/repository";
import { layoutGraphFrom, emptyGraphLayoutState } from "../src/ui/graph";
import { oneDarkTheme } from "../src/ui/theme";

const args = process.argv.slice(2);
const repos: string[] = [];
let pages = 8;
let pageSize = DEFAULT_HISTORY_PAGE;
for (let i = 0; i < args.length; i++) {
  const a = args[i]!;
  if (a === "--pages") pages = Number(args[++i]);
  else if (a === "--page-size") pageSize = Number(args[++i]);
  else repos.push(a);
}

const mb = (n: number) => (n / 1024 / 1024).toFixed(1);
const ms = (n: number) => n.toFixed(1);
async function timed<T>(label: string, fn: () => Promise<T> | T) {
  const t = performance.now();
  const value = await fn();
  const took = performance.now() - t;
  console.log(`  ${label.padEnd(28)} ${ms(took).padStart(9)} ms`);
  return { value, took };
}

for (const path of repos) {
  console.log(`\n=== ${path}`);
  const baseline = process.memoryUsage();
  const repo = await GitRepositoryService.open(path);

  const snap = await timed("snapshot()", () => repo.snapshot(pageSize));
  const base = snap.value;
  console.log(
    `  commits=${base.commits.length} branches=${base.branches.length} ` +
      `changed=${base.files.length} stashes=${base.stashes.length}`,
  );

  let state = emptyGraphLayoutState;
  let rows = 0;
  await timed("layoutGraph(first page)", () => {
    const out = layoutGraphFrom(
      base.commits,
      oneDarkTheme.graph,
      undefined,
      state,
    );
    state = out.state;
    rows += out.rows.length;
  });

  let skip = base.commits.length;
  let pageTotal = 0;
  let layoutTotal = 0;
  for (let p = 1; p < pages; p++) {
    const t = performance.now();
    const page = await repo.commitPage(pageSize, skip);
    pageTotal += performance.now() - t;
    if (page.commits.length === 0) break;
    const g = performance.now();
    const out = layoutGraphFrom(
      page.commits,
      oneDarkTheme.graph,
      undefined,
      state,
    );
    layoutTotal += performance.now() - g;
    state = out.state;
    rows += out.rows.length;
    skip += page.commits.length;
    if (page.complete) break;
  }
  console.log(
    `  ${"commitPage() total".padEnd(28)} ${ms(pageTotal).padStart(9)} ms  (${skip} commits)`,
  );
  console.log(
    `  ${"layoutGraph() total".padEnd(28)} ${ms(layoutTotal).padStart(9)} ms  (${rows} rows)`,
  );

  const head = base.commits[0];
  if (head) {
    await timed("commitFiles(HEAD)", () => repo.commitFiles(head.sha));
    await timed("commitDiff(HEAD)", () => repo.diff({ commit: head.sha }));
  }
  await timed("workingStatus()", () => repo.workingStatus());

  const after = process.memoryUsage();
  console.log(
    `  heap +${mb(after.heapUsed - baseline.heapUsed)} MB` +
      `  rss ${mb(after.rss)} MB (peak-ish)`,
  );
  if (global.gc) global.gc();
}
