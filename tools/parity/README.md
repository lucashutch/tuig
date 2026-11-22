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
python3 tools/parity/run.py side-by-side            # TS and Rust live, cell differences per region
python3 tools/parity/run.py stability --runs 3      # same app, N runs, snapshots must be identical
python3 tools/parity/run.py show select-commit      # print snapshots with a column ruler
```

Add scenario names at the end to run a subset. `--app` defaults to `ts`, which is `bun run src/index.ts --clean {repo}` from the repository root. `{repo}` is replaced by the fixture path. If the command has no `{repo}`, the path is appended. Commands run in `--cwd`, or in the current directory.

Goldens are in `golden/<scenario>/<snapshot>.snap`. Commit them. Record from the TypeScript app only, then `compare` the Rust app against them.

Compare output lists text differences first (expected row, actual row, and a caret line), then style runs (foreground, background, attributes), then the cursor. The exit code is 1 on any difference.

Run the harness tests with `python3 -m unittest discover -s tools/parity/tests`.

## Side-by-side driver

`side-by-side` plays the same scenarios on the TS app and on the Rust binary (`rust/target/release/tuig`, run in `rust/`), then compares each snapshot and prints the cell differences per region: `tabs`, `header`, `sidebar`, `history`, `details`, `footer`. It finds the pane borders from the vertical divider glyphs on the TS screen. Each region shows how many cells differ in text and how many differ only in style. A scenario that stops in one app (a wait times out) is reported as one failure with the step. The exit code is 1 on any difference.

```sh
python3 tools/parity/run.py side-by-side toolbar         # one scenario, both apps live
python3 tools/parity/run.py side-by-side --golden -v     # Rust against the goldens, with the differing rows
python3 tools/parity/run.py side-by-side --rust "./target/debug/tuig --clean {repo}" sidebar-layout
```

`--golden` skips the TS run and reads the recorded snapshots. `-v` prints the rows and style runs of each differing region, and the screen of an app that stopped. Build the Rust binary first with `cargo build --release` in `rust/`.

## Git state checks

Screens do not show every effect of a Git action. `mutations.py` plays the same input on both apps against disposable repositories (the fixtures, plus a local bare remote for fetch, pull and push). It then compares the resulting repository state: commit subjects, parents and trees (not SHAs), `git status`, refs, stashes, the index, and the remote refs. It prints `same` or `MISMATCH` with a diff for each case, and exits 1 on a mismatch or a failed step.

```sh
python3 tools/parity/mutations.py --list
python3 tools/parity/mutations.py                    # all cases, about 6 minutes
python3 tools/parity/mutations.py commit stash push  # some cases
python3 tools/parity/mutations.py --native-keys      # send keys the Rust app does not bind
```

Cases for the palette entries, the changed-file menu and the sidebar menus (stash, worktree, submodule) use the fixtures `linked`, `linked-sync`, `linked-uninit`, `linked-bump`, `linked-behind` and `linked-locked`. The state also lists the worktrees (without SHAs) and the submodule status. `--list` shows all cases.

Where the Rust app has no key binding, the script uses the palette or a toolbar button for Rust, and prints a note. `--native-keys` sends the real key instead. `--screen` prints the last screen of each run.

## What is fixed

Each run starts the app in a new temp HOME with these settings:

- Size 160x48 (a scenario can change it), `TERM=xterm-256color`, `COLORTERM=truecolor`, `LANG=C.UTF-8`, `TZ=UTC`.
- `HOME` and all `XDG_*` directories point to the temp directory. The harness copies no variables from the caller except `PATH`.
- A `gh` stub is first on `PATH`. It reports "no GitHub remote", so the pull request section stays hidden.
- `HTTP_PROXY`, `HTTPS_PROXY` and `ALL_PROXY` point to a closed port, so avatar fetches fail at once. This is not kernel-level network isolation.
- `GIT_CONFIG_GLOBAL` is empty and the system config is off.
- The harness answers terminal queries the same way every run: device attributes, cursor position, and the foreground and background color (white on black).
- Commits and stashes made by the app use a fixed identity and the date 2024-04-01 (`GIT_AUTHOR_*`, `GIT_COMMITTER_*`), so their SHAs are the same on every run and in both apps.
- Fixture repos use a fixed author, committer, and dates, so SHAs never change. The `demo` fixture has 10 commits, 2 merges, a tag, 4 branches, a committed rename, and a working tree with staged, unstaged, untracked, and renamed files, plus a 3-hunk diff in `src/server.py`.
- The `second` fixture, used as an extra tab, has 2 commits, a `dev` branch, and a clean working tree. The `history` fixture has 307 commits on `main` and 59 `topic/*` branches, built from 29 groups of two overlapping branches that merge back (58 merges, up to 3 graph lanes), tags `v0.5` to `v0.25`, and a clean working tree. The 14 newest commits are a 151-line Python file and one sample file per highlighted language in `showcase/` (md, html, css, cpp, c, sh, json, js, tsx, ts, rs, go, py). The first page loads 250 commits, so scrolling to the end also tests paging. Building it takes about 5 seconds. A harness test pins the HEAD SHA.

More fixtures for the later scenarios (all built by `parity/fixtures.py`, all with fixed dates, so SHAs are stable):

- `linked`: the demo history with a clean tree, a bare `origin` with three branches, two stashes, a second worktree `linked-wt` and a submodule `vendor/libsub` (a relative URL, so the SHAs do not depend on the temp path). The stash age depends on today's date, so scenarios mask it with `mask-text "on main • [^│┃]*"`.
- `lanes`: 16 branches open at the same time and merged into main. The graph is wider than its column.
- `behind`: clean, with one commit on `origin` that the repository has not fetched. `slow-remote`: an untracked file, and an `origin` that needs 30 s to answer a fetch. `ssh-remote`: an `origin` with an ssh URL, for the `ssh-denied` stub.
- `bigdiff`: three unstaged edits: a 24,000-row diff (no highlight), a 6 MiB diff (needs `Shift+L`) and a 60-line file that is replaced whole (120 rows).

Waits use screen quiet time, not sleeps. A wait ends when no cell has changed for `quiet` ms (300 by default). Repaints that do not change a cell do not count.

## Scenarios

| Scenario                                                                          | Fixture                         | What it covers                                                                          |
| --------------------------------------------------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------- |
| `initial-load`, `select-commit`, `changed-files`, `command-palette`, `diff-click` | demo                            | Basic panes, commit and file selection, palette, diff line selection                    |
| `wheel-history`                                                                   | history                         | Wheel down 10 rows, to the end (loads the second page), up 10, and back to the top      |
| `composer`                                                                        | demo                            | Type a summary and description, toggle amend, edit a commit message, cancel             |
| `diff-scroll`                                                                     | history                         | Wheel through a 151-line diff and back                                                  |
| `syntax-highlight`                                                                | history                         | One diff per language, 13 snapshots, with a 600 ms quiet time so highlighting finishes  |
| `graph-menu`                                                                      | demo                            | Right-click a commit: menu, submenu, confirmation, name prompt, branch label menu       |
| `diff-menu`                                                                       | demo                            | Right-click in the diff: selected-lines menu and file menu                              |
| `sidebar-layout`                                                                  | demo                            | Fold a section, drag a section divider and the sidebar divider, collapse panes          |
| `branch-filter`                                                                   | demo                            | `/` filter, match navigation, cancel, filter and check out                              |
| `repo-tabs`                                                                       | demo + second                   | Picker, typed path, second tab, switch, reorder, close, Ctrl+Tab                        |
| `toolbar`                                                                         | demo                            | Hover, undo on a dirty tree, stash, pop, refresh, avatars toggle                        |
| `undo`                                                                            | demo                            | Commit, undo preview, cancel, confirmed undo                                            |
| `commit-flow`, `commit-amend`                                                     | demo                            | Stage all, write and commit with Enter, amend with the pre-filled message               |
| `theme`                                                                           | demo                            | Theme and theme mode pickers from the palette, preview, select                          |
| `history-header`                                                                  | demo                            | Columns menu, hide Committer and SHA, column divider drag                               |
| `keyboard-staging`                                                                | demo                            | `s`, `a`, `t`, `u`, `d d` in the changes pane                                           |
| `compare`                                                                         | demo                            | Select for comparison, compare, comparison view                                         |
| `file-history`                                                                    | demo                            | File menu, file history, Esc                                                            |
| `line-staging`, `line-selection`                                                  | demo                            | Gutter click, Ctrl+click, Enter to stage, Alt+drag range, Esc                           |
| `sidebar-menus`, `sidebar-open-tab`, `worktree-lock-menu`                         | linked                          | Right-click menus of every sidebar item, double-click a worktree or submodule, lock     |
| `sidebar-scroll`                                                                  | history                         | Sidebar scrollbar drag and wheel on 60 branches                                         |
| `palette-actions`                                                                 | demo + second                   | One palette entry at a time: focus, tabs, panels, avatars, remote commands, compose     |
| `diff-view-modes`, `copy-sha`, `diff-text-copy`, `diff-line-actions`              | demo, history                   | Diff toggle and a resize, SHA copy, text drag copy (OSC 52), Blame line, line history   |
| `changes-tree`                                                                    | demo                            | Fold a folder or a section, the file menus, Copy path                                   |
| `pane-dividers`, `history-scroll`, `history-scrollbar`                            | demo, lanes                     | Details and changes dividers, graph pan with the wheel, history scrollbar drag          |
| `saved-layout`, `window-resize`                                                   | demo                            | A seeded `layout.json`, kept unknown keys, resize to four sizes                         |
| `diff-limits`                                                                     | bigdiff                         | No highlight above 20,000 rows, the 5 MiB notice, `Shift+L`, gutter of a rewritten file |
| `external-changes`                                                                | linked                          | Watcher, `r`, and a background tab, with `git` run outside the app                      |
| `restore-session`, `restore-session-no-path`                                      | demo + second                   | A seeded `session.json`, with and without a path argument                               |
| `remote-cancel`, `remote-credentials`, `auto-fetch`                               | slow-remote, ssh-remote, behind | Esc cancels a fetch, busy refusal, credential failure text, the minute fetch            |
| `pull-requests`                                                                   | demo                            | A `gh` stub with four pull requests: section, PR column, open, palette, not fetched     |

The first 26 scenarios take about 1.5 minutes to record and about the same to compare. All 49 take about 8 minutes, because `auto-fetch` waits 63 s for the first automatic fetch.

## Hunk separators (deliberate Rust-only difference)

The Rust app shows one blank row between consecutive hunks of a diff. The TS app does not, and the TS goldens are not re-recorded. A Rust diff screen with two or more hunks therefore differs from its golden. The blank row is not a diff line: it has no line number, no sign, and no target for clicks.

Snapshots that differ for this reason, all in the diff pane of the `demo` fixture's `src/server.py` (3 hunks, 2 gaps): `changed-files/server-diff`, `diff-click/*` (2), `diff-menu/*` (3), `line-selection/*` (3), `line-staging/*` (3). The single-hunk diffs of `diff-scroll` and `syntax-highlight` are unchanged.

- The harness sets `TUIG_DIFF_HUNK_GAP=0` in the environment of every app it starts, so `compare` and `side-by-side --golden` match the goldens without extra setup. The TS app ignores the variable. The harness passes no other caller environment to the app.
- `--hunk-gap` (on `record`, `show`, `compare`, `ab`, `side-by-side` and `stability`) keeps the blank row on, to look at the separators: `python3 tools/parity/run.py show --hunk-gap --app ./target/release/tuig --cwd rust diff-click`.
- `python3 tools/parity/hunk_gap_check.py [scenario...]` plays each scenario with and without the row (it sets `Session.hunk_gap` itself). Outside the diff pane the screens must be equal. Inside it, the screen with the row, minus the blank rows, must equal the screen without it, cell by cell and style by style. `line-selection` and `line-staging` click and drag on fixed screen rows below the first gap, so the check moves those gestures down one row in the run with the row.

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
key ctrl+p down enter        # named keys, ctrl+x, alt+x, ctrl+tab, ctrl+shift+tab, or single characters
text "branch"                # type literal text
click 60 11 [left|right|middle] [ctrl|alt|shift]
drag 36 9 62 12 [ctrl|alt|shift]
                             # drag: press, move in single-cell steps, release
wheel down 60 20 3           # up or down, x y, optional count
move 60 11                   # hover
mask 100 0 20 1              # x y width height, from here on
ignore 130 1 30 1            # mask, and do not count changes there as activity (a spinner that never stops)
extra second                 # build a second fixture. Type its path with text "{second}"
mask-text "\d+ minutes ago"  # regex on each row, from here on (only the matched cells)
snapshot loaded              # save the screen, after a stable wait
dclick 8 43 [right|ctrl|alt]   # two clicks, 80 ms apart
wheel right 60 20 4 shift    # up, down, left or right, with modifiers after the count
resize 100 30                # change the terminal size
git commit -q --allow-empty -m x   # run git in the fixture. `git @second ...` runs it in an extra fixture
expect-clipboard "text"      # the last OSC 52 text must match (write a line break as \n)
expect-file config/tuig/layout.json "futureKey"   # a file under the temp HOME must contain the text soon
```

Directives that set up the run, before the app starts:

```
stub gh-prs                  # ssh-denied (an ssh that rejects the key, and objects without BatchMode=yes),
                             # xdg-open-log (records the URL in $HOME/xdg-open.log), gh-prs (four pull requests)
seed config/tuig/layout.json '{"leftWidth":34}'   # write a file under the temp HOME ({repo}, {second}, {home} work)
restore                      # keep the saved session: drop --clean from the command line
nopath                       # start with no path argument
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
