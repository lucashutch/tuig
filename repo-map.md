# Repo Map

Purpose: Mouse-first terminal Git client backed by the Git CLI.
Stack: TypeScript, Bun, OpenTUI core
Canonical repository: https://github.com/lucashutch/tuig

## Layout

- `src/git/` — Git process boundary, parsers, repository service, and domain models.
- `src/git/process.ts` — Git process runner, own-process tracking, and Git error types.
- `src/git/parsers.ts` — pure parsers for Git's machine-readable output.
- `src/git/commit-walk.ts` — long-lived `git log` walk for paging history, and the commands that invalidate it.
- `src/git/undo.ts` — reflog-based undo preview and reset of the latest commit-like operation.
- `src/git/pull-requests.ts` — open pull requests from one `gh api graphql` request, availability detection, and check rollup from check counts.
- `src/git/hunks.ts` — splits a file diff into hunks and builds patches for selected lines.
- `src/git/repository-browser.ts` — directory suggestions for opening repository tabs.
- `src/git/repository-watcher.ts` — debounced filesystem watch of a repository's HEAD, index, refs, and work tree.
- `src/git/pull-request-types.ts` — shared pull request types and the `PullRequestService` contract.
- `src/open-url.ts` — opens a web URL in the browser with a detached `xdg-open`.
- `src/ui/` — OpenTUI rendering, interaction state, panes, menus, and dialogs.
- `src/ui/command-palette.ts` — command model, filtering, and ranking for the command palette.
- `src/ui/diff-view.ts` — diff widget, inline or side-by-side view choice, and line hit testing.
- `src/ui/diff-lines.ts` — maps diff rows to file lines for line selection, blame, and history.
- `src/ui/diff-policy.ts`, `src/ui/diff-parsers.ts`, `src/ui/diff-syntax.ts` — diff size limits, bundled syntax parsers, and syntax colors.
- `src/ui/avatars.ts` — author avatar lookup, caching, and terminal graphics support checks.
- `src/ui/search.ts` — result paging and graph rows for commit search. The runtime does not use it yet.
- `src/ui/runtime.ts` — runtime orchestration, state transitions, and repository actions.
- `src/ui/runtime-commands.ts` — Git-backed commands, confirmations, prompts, and commit mutations.
- `src/ui/runtime-data.ts` — snapshot, diff, and commit-detail loading with request guards.
- `src/ui/auto-refresh.ts` — active-tab watch with a polling fallback and safety-net poll.
- `src/ui/runtime-diff-selection.ts` — diff line selection, drag selection, and selected-line staging.
- `src/ui/runtime-files.ts` — changed-file selection, expansion, scrolling, and diff targets.
- `src/ui/runtime-file-history.ts` — file and line history in the details pane, and line blame.
- `src/ui/runtime-graph-menu.ts` — graph context menu opening and view actions.
- `src/ui/runtime-history.ts` — history navigation, wheel and scrollbar scrolling, graph hit testing, and double-click handling.
- `src/ui/runtime-events.ts` — widget mouse and key actions, and overlay input handlers.
- `src/ui/runtime-history-columns.ts` — history header dividers, columns menu, and row hover.
- `src/ui/runtime-keys.ts` — keyboard dispatch by mode: overlays, composer, branch filter, and pane shortcuts.
- `src/ui/runtime-layout.ts` — pane sizing and layout calculations.
- `src/ui/runtime-notifications.ts` — transient messages and the busy spinner.
- `src/ui/pull-requests.ts` — pull request icons and colors, sidebar grouping, and branch-to-pull-request matching.
- `src/ui/runtime-pull-requests.ts` — pull request loading per tab, refresh timing, the checks spinner, and row actions.
- `src/ui/runtime-preferences.ts` — debounced saves and startup restore of layout and session preferences.
- `src/ui/runtime-paint.ts` — sidebar, history, file, and composer painting.
- `src/ui/runtime-sidebar.ts` — sidebar interaction, wheel and scrollbar scrolling, resizing, and branch filtering.
- `src/ui/runtime-toolbar.ts` — toolbar and header painting, hover, press, and dispatch.
- `src/ui/runtime-popup.ts` — popup placement, rendering, submenu interaction, and prompt visibility.
- `src/ui/runtime-palette.ts` — command palette command list, painting, theme preview, and activation.
- `src/ui/runtime-tabs.ts` — repository tab strip painting, drag, switching, and the repository picker.
- `src/ui/runtime-widgets.ts` — typed OpenTUI widget factories, pane wiring, and renderable event bindings for the runtime.
- `src/ui/repository-tabs.ts` — repository tab layout and hit testing.
- `src/ui/session-preferences.ts` — persisted open repository tabs and active tab.
- `src/ui/theme.ts` — Tuig semantic colors and the active theme.
- `src/ui/theme-resolver.ts` — OpenCode V2 token, mode, reference, and dialog resolution.
- `src/ui/theme-store.ts` — built-in and custom theme discovery and saved selection.
- `src/ui/runtime-theme.ts` — live widget color updates without replacing editors, and the theme catalog, selection, and repaint.
- `src/ui/themes/` — bundled OpenCode V2 theme definitions and attribution.
- `src/ui/scrollbar.ts` — scrollbar thumb geometry and the pointer-to-row mapping for thumb drags.
- `src/ui/graph-viewport.ts` — horizontal graph window sizing, clamping, and edge markers for wide graphs.
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
