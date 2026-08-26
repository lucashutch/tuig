# Repo Map

Purpose: Mouse-first terminal Git client backed by the Git CLI.
Stack: TypeScript, Bun, OpenTUI core
Canonical repository: https://github.com/lucashutch/tuig

## Layout

- `src/git/` — Git process boundary, parsers, repository service, and domain models.
- `src/git/parsers.ts` — pure parsers for Git's machine-readable output.
- `src/ui/` — OpenTUI rendering, interaction state, panes, menus, and dialogs.
- `src/ui/runtime.ts` — runtime orchestration, state transitions, and repository actions.
- `src/ui/runtime-commands.ts` — Git-backed commands, confirmations, prompts, and commit mutations.
- `src/ui/runtime-data.ts` — snapshot, diff, and commit-detail loading with request guards.
- `src/ui/runtime-files.ts` — changed-file selection, expansion, scrolling, and diff targets.
- `src/ui/runtime-history.ts` — history navigation, scrolling, graph hit testing, and double-click handling.
- `src/ui/runtime-layout.ts` — pane sizing and layout calculations.
- `src/ui/runtime-paint.ts` — sidebar, history, file, and composer painting.
- `src/ui/runtime-sidebar.ts` — sidebar interaction, resizing, and branch filtering.
- `src/ui/runtime-popup.ts` — popup placement, rendering, submenu interaction, and prompt visibility.
- `src/ui/runtime-widgets.ts` — typed OpenTUI widget factory, pane wiring, and renderable event bindings for the runtime.
- `src/ui/graph-menu.ts` — pure model, placement, and hit testing for the graph context menu.
- `src/ui/runtime-presentation.ts` — compatibility barrel for the focused presentation modules.
- `src/ui/runtime-presentation-*.ts` — focused sidebar, text, changes, commit, and chrome presentation helpers.
- `src/index.ts` — CLI path resolution and app startup.
- `tests/` — parser, service integration, and state tests.

## Entry points

- `src/index.ts` — launches `tuig [repository]`.

## Commands

- Run: `bun run start -- [repository]`
- Typecheck: `bun run typecheck`
- Test: `bun test`
- Full check: `bun run check`

## Conventions & gotchas

- Git subprocesses belong in `src/git/`; UI code depends on typed service methods.
- Prefer NUL-delimited porcelain output and explicit Git formats.
- OpenTUI is pre-1.0, so its dependency is pinned exactly.
