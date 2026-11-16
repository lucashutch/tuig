# Parity harness

Drives a terminal app under a real PTY, reads the screen through a terminal emulator, and compares what is on screen. It takes any command line, so the TypeScript app and the Rust build use the same scenarios and the same goldens.

## Setup

Needs Python 3.10 or newer and `bun` (for the TypeScript app).

```sh
pip install --target tools/parity/.deps -r tools/parity/requirements.txt
```

The emulator is [pyte](https://github.com/selectel/pyte). It handles 24-bit SGR color, SGR mouse reports (it ignores them), and the alternate screen. The app output was checked against xterm.js and the final screens match.

## Usage

Run from the repository root.

```sh
python3 tools/parity/run.py record                  # run the TS app, write golden files
python3 tools/parity/run.py compare                 # run the TS app, diff against goldens
python3 tools/parity/run.py compare --app "./target/release/tuig --clean {repo}" --cwd rust
python3 tools/parity/run.py ab --b "./target/release/tuig --clean {repo}" --cwd-b rust
python3 tools/parity/run.py stability --runs 3      # same app, N runs, snapshots must be identical
python3 tools/parity/run.py show select-commit      # print snapshots with a column ruler
```

Add scenario names at the end to run a subset. `--app` defaults to `ts`, which is `bun run src/index.ts --clean {repo}` from the repository root. `{repo}` is replaced by the fixture path. If the command has no `{repo}`, the path is appended. Commands run in `--cwd`, or in the current directory.

Goldens are in `golden/<scenario>/<snapshot>.snap`. Commit them. Record from the TypeScript app only, then `compare` the Rust app against them.

Compare output lists text differences first (expected row, actual row, and a caret line), then style runs (foreground, background, attributes), then the cursor. The exit code is 1 on any difference.

Run the harness tests with `python3 -m unittest discover -s tools/parity/tests`.

## What is fixed

Each run starts the app in a new temp HOME with these settings:

- Size 160x48 (a scenario can change it), `TERM=xterm-256color`, `COLORTERM=truecolor`, `LANG=C.UTF-8`, `TZ=UTC`.
- `HOME` and all `XDG_*` directories point to the temp directory. The harness copies no variables from the caller except `PATH`.
- A `gh` stub is first on `PATH`. It reports "no GitHub remote", so the pull request section stays hidden.
- `HTTP_PROXY`, `HTTPS_PROXY` and `ALL_PROXY` point to a closed port, so avatar fetches fail at once. This is not kernel-level network isolation.
- `GIT_CONFIG_GLOBAL` is empty and the system config is off.
- The harness answers terminal queries the same way every run: device attributes, cursor position, and the foreground and background color (white on black).
- Fixture repos use a fixed author, committer, and dates, so SHAs never change. The `demo` fixture has 10 commits, 2 merges, a tag, 4 branches, a committed rename, and a working tree with staged, unstaged, untracked, and renamed files, plus a 3-hunk diff in `src/server.py`.
- The `history` fixture has 307 commits on `main` and 59 `topic/*` branches, built from 29 groups of two overlapping branches that merge back (58 merges, up to 3 graph lanes), tags `v0.5` to `v0.25`, and a clean working tree. The 14 newest commits are a 151-line Python file and one sample file per highlighted language in `showcase/` (md, html, css, cpp, c, sh, json, js, tsx, ts, rs, go, py). The first page loads 250 commits, so scrolling to the end also tests paging. Building it takes about 5 seconds. A harness test pins the HEAD SHA.

Waits use screen quiet time, not sleeps. A wait ends when no cell has changed for `quiet` ms (300 by default). Repaints that do not change a cell do not count.

## Scenarios

| Scenario                                                                          | Fixture | What it covers                                                                         |
| --------------------------------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------- |
| `initial-load`, `select-commit`, `changed-files`, `command-palette`, `diff-click` | demo    | Basic panes, commit and file selection, palette, diff line selection                   |
| `wheel-history`                                                                   | history | Wheel down 10 rows, to the end (loads the second page), up 10, and back to the top     |
| `composer`                                                                        | demo    | Type a summary and description, toggle amend, edit a commit message, cancel            |
| `diff-scroll`                                                                     | history | Wheel through a 151-line diff and back                                                 |
| `syntax-highlight`                                                                | history | One diff per language, 13 snapshots, with a 600 ms quiet time so highlighting finishes |
| `graph-menu`                                                                      | demo    | Right-click a commit: menu, submenu, confirmation, name prompt, branch label menu      |
| `diff-menu`                                                                       | demo    | Right-click in the diff: selected-lines menu and file menu                             |

The whole suite takes about 1.5 minutes to record and about the same to compare.

## Known gesture to avoid

Do not start a `drag` on a sidebar section header, for example `drag 22 13 50 16` on the demo fixture. The goldens do not use it. Before the fix, the header was selectable text. A press on selectable text starts a text selection, and OpenTUI then sends every drag event to the cell under the pointer (`processSingleMouseEvent` in `@opentui/core`) instead of the pressed widget. The drag crossed the sidebar divider (the `makeDivider` drag handler, `src/ui/runtime-widgets.ts:316`, which calls `resizeLeft`). Each resize moves the divider by one cell, and the pointer can pass it before the next frame updates the hit grid, so the sidebar width stopped at 31 to 46 columns depending on timing. The header (`sidebar-<section>-header`, `src/ui/runtime-widgets.ts:377-391`) and the changed-file labels are now `selectable: false`, and `tests/ui/runtime-widgets.test.ts` covers it. The gesture is deterministic now, but scenarios still avoid it.

## Emulator quirk

The app sends `CSI > 4 ; 1 m` (xterm modifyOtherKeys) at startup. pyte ignores the `>` and runs it as SGR bold plus underline. If the first paint came before any `CSI 0 m`, the tab strip got bold and underline attributes. This showed up only when the app started slowly, for example under CPU load. `Session.feed` now drops `CSI > ... m` before pyte sees it, and a harness test covers it. This was a harness bug, not an app bug.

## Timing in the app

The app clears its footer message 6 seconds after it appears (`src/ui/runtime-notifications.ts:114`). A commit click sets "Commit selected ...", so scenarios that run longer than 6 seconds after a click mask the footer row (`mask 0 47 160 1`). Fix any other time-based text the same way, at the scenario level.

## Scenario format

A scenario is `scenarios/<name>.scn`. Each line is one directive. `#` starts a comment. Quote text that contains spaces.

```
fixture demo               # fixture repo name (default demo)
size 160 48                # columns rows
quiet 300                  # quiet time in ms for every wait
timeout 20                 # seconds before a wait fails

wait text "Working Changes"  # block until text is on screen
wait stable                  # block until the screen is quiet
key ctrl+p down enter        # named keys, ctrl+x, alt+x, or single characters
text "branch"                # type literal text
click 60 11 [left|right|middle]
drag 36 9 62 12              # press, move in single-cell steps, release
wheel down 60 20 3           # up or down, x y, optional count
move 60 11                   # hover
mask 100 0 20 1              # x y width height, from here on
mask-text "\d+ minutes ago"  # regex on each row, from here on
snapshot loaded              # save the screen, after a stable wait
```

Coordinates are 0-based cells (column, row). Every input step waits for the screen to go quiet before the next step. Start each scenario with `wait text "..."` for something that shows only after the data loads, because the first paint appears before the history does. Use `run.py show <scenario>` to read cell coordinates.

To add a scenario:

1. Write `scenarios/<name>.scn`.
2. Run `python3 tools/parity/run.py show <name>` and check the screens and coordinates.
3. Run `python3 tools/parity/run.py stability <name>`. It must report identical snapshots.
4. Run `python3 tools/parity/run.py record <name>` and commit the new `golden/<name>/` files.

Fix volatile output at its source (fixture contents, environment) before you reach for a mask. To add a fixture, write a builder in `parity/fixtures.py` and register it in `FIXTURES`.

## Snapshot file

Header with size and cursor, then `[text]` (one row per line, ending in `|`), `[styles]` (id to fg, bg, attrs; attrs are b bold, i italic, u underline, s strike, r reverse, k blink), and `[grid]` (a style id per cell). Cells with a combining mark keep only the first code point.
