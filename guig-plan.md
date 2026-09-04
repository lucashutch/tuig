# Guig Implementation Plan

Objective: Add `guig/` Electron GUI with GitKraken-style UI and full tuig feature parity (browse history, diffs, stage, commit, branches, stash, worktree, submodules, fetch/pull/push).

Stack: Electron + React + Vite + TypeScript. Backend uses Node `child_process` git (port of `src/git/`, Bun.spawn replaced). Frontend dark One Dark GitKraken-style theme.

## Phases

### Phase 1: Scaffold + backend IPC (standalone)

- Files: `guig/**` scaffold only: `guig/package.json`, `guig/tsconfig*.json`, `guig/vite.config.*`, `guig/electron/main.ts`, `guig/electron/preload.ts`, `guig/electron/git.ts`, `guig/shared/types.ts`, `guig/shared/ipc.ts`
- Reuse pure parsers from `src/git/parsers.ts` by porting to Node (no Bun APIs in backend). Mirror `src/git/types.ts` DTOs in `guig/shared/types.ts`.
- IPC commands: openRepo, snapshot(limit), commitPage, workingStatus, diff, commitFiles, stage/unstage/discard/discardAll/applyPatch, commit/amend/reword, switchBranch/checkoutCommit/checkoutRemoteBranch, resetTo/rebaseOnto/cherryPick, createBranch/createTag/deleteBranch, fetch/pull/push (cancellable), stash/apply/pop/drop, worktree add/remove/lock.
- Testing: `cd guig && npm install && npm run typecheck` passes; `npx tsc --noEmit` clean.

### Phase 2A: Shell + sidebar + toolbar + theme (parallel with 2B,2C, depends: Phase 1)

- Files: `guig/frontend/src/{App.tsx,theme.css,components/Toolbar.tsx,components/Sidebar.tsx,components/StatusBar.tsx,api.ts}`
- GitKraken-style: top toolbar (Fetch/Pull/Push/Stash/Pop/Refresh + repo name/branch/ahead-behind/dirty/fetch-age), left sidebar (local/remote branches, stashes, worktrees, submodules with filter), bottom status bar (focus hints + messages).
- Testing: `npm run typecheck`, manual `npm run dev` shows shell with mocked API.

### Phase 2B: History graph + commit detail + diff (parallel with 2A,2C, depends: Phase 1)

- Files: `guig/frontend/src/{components/HistoryPane.tsx,components/GraphCanvas.tsx,components/CommitDetail.tsx,components/DiffViewer.tsx,lib/graph.ts}`
- Colored lane graph (port lane routing ideas from `src/ui/graph.ts`), one row per commit with ref labels + `+N`, author + SHA, click select, double-click checkout, right-click context menu events, file list per commit + syntax-tinted diff.
- Testing: `npm run typecheck`, graph unit check via mocked commits.

### Phase 2C: Changes + composer + stash actions (parallel with 2A,2B, depends: Phase 1)

- Files: `guig/frontend/src/{components/ChangesPane.tsx,components/Composer.tsx,components/FileTree.tsx}`
- Unstaged/Staged collapsible sections, stage-all/discard-all, per-file stage/unstage/discard, hunk stage first-hunk (`h`), summary/description composer + commit/amend, stash push with message.
- Testing: `npm run typecheck`, mocked stage/commit flow.

### Phase 3: Menus + dialogs + parity + docs (depends: Phase 2A,2B,2C)

- Files: `guig/frontend/src/{components/ContextMenu.tsx,components/Dialogs.tsx}`, `guig/README.md`, `guig/package.json` scripts, root `README.md` link (small edit)
- Context menus (branch checkout/rebase/reset submenu/copy/delete, commit checkout/rebase/reset/copy SHA, stash apply/pop/drop, worktree lock/remove, file actions), confirm dialogs for hard reset/delete/overwrite, auto-refresh 10s + fetch-prune interval pref, OSC-free SHA copy via clipboard.
- Final validation: `cd guig && npm run typecheck && npm test` (if tests added), root `bun run check` still passes for TUI (guig excluded via ignore or passes lint).
- Docs: `guig/README.md` with install/run/test instructions.

## Status

- Phase 1: done — Electron scaffold + Node git backend + IPC contract under guig/
- Phase 2A: done — shell + sidebar + toolbar + theme + api
- Phase 2B: done — history graph + commit detail + diff viewer
- Phase 2C: done — changes pane + file tree + composer
- Phase 3: done — menus + dialogs + integration + docs + review fixes
