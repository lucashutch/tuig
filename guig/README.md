# Guig

Guig is the Electron desktop companion to tuig: a GitKraken-style GUI for the same repositories. It browses history on a colored lane graph, shows diffs, stages and commits changes, and manages branches, stashes, worktrees, and submodules through the Git executable already installed on your system.

Feature parity with tuig covers history browsing with ref labels, per-commit file lists and diffs, unstaged/staged changes with hunk staging, commit and amend, branch checkout and tracking of remote branches, rebase and reset (soft/mixed/hard), cherry-pick, stash apply/pop/drop, worktree lock/unlock/remove, fetch/pull/push with cancel, and right-click context menus with confirmation gates on destructive operations.

## Requirements

- Linux
- [Node.js](https://nodejs.org/) 20 or newer with npm
- Git 2.43 or newer recommended

## Install

```sh
cd guig
npm install
```

## Develop

Start the Vite dev server (renders with mock data in a plain browser):

```sh
npm run dev
```

To open a real repository, run the Electron shell against the dev server and pass the repo path. The renderer opens the path entered in the repo field of the header, or the path given to the backend at startup:

```sh
VITE_DEV_SERVER_URL=http://localhost:5173 npx electron dist/electron/main.js -- /path/to/repo
```

Build the Electron main and preload bundles first with `npm run build:electron` if `dist/electron` does not exist yet.

## Build

```sh
npm run build
npm run dist
```

`npm run build` emits the renderer to `dist/frontend` and the Electron main and preload entries to `dist/electron/main.js` and `dist/electron/preload.js`. `npm run dist` packages Linux `deb` and `AppImage` artifacts into `release/`.

## Check and test

```sh
npm run typecheck
npm test
```

## Screenshots

Screenshots are not checked in yet. This section will show the history graph, the changes pane, and the commit composer once release captures exist.

## Troubleshooting

- `git` missing: guig shells out to the Git executable for every operation. Install Git and make sure `git --version` works on your `PATH` before starting guig.
- Empty window or "backend not connected": you opened the Vite URL in a plain browser. Run the Electron shell so the preload exposes `window.guig`.
- Wayland blank window or GPU errors: launch Electron with `--disable-gpu-sandbox` or set `ELECTRON_DISABLE_SANDBOX=1` for systems where the Chromium sandbox conflicts with the compositor.
- Stale remote branches: fetch prunes removed remote refs. Auto-fetch runs every minute by default; set `guig.fetchIntervalMinutes` in `localStorage` to change it, or `0` to disable.
