# Repo Map

Purpose: Mouse-first terminal Git client backed by the Git CLI.
Stack: TypeScript, Bun, OpenTUI core
Canonical repository: https://github.com/lucashutch/tuig

## Layout

- `src/git/` — Git process boundary, parsers, repository service, and domain models.
- `src/ui/` — OpenTUI rendering, interaction state, panes, menus, and dialogs.
- `src/ui/runtime-widgets.ts` — typed OpenTUI widget factory, pane wiring, and renderable event bindings for the runtime.
- `src/ui/graph-menu.ts` — pure model, placement, and hit testing for the graph context menu.
- `src/ui/runtime-presentation.ts` — typed, pure runtime sidebar, commit metadata, and text-layout presentation helpers.
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
