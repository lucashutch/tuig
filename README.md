# Tuig

**A mouse-first Git client for the terminal.**

Tuig, pronounced like "twig", combines a visual branch graph with a fast terminal workflow. Browse history, inspect commits, review changed files, stage work, and commit without leaving your terminal.

Tuig is built with TypeScript, Bun, OpenTUI, and the Git executable already installed on your system. It does not replace Git or hide it behind a custom repository implementation.

> Tuig is an early MVP. The graph, diff viewer, changed-file tree, staging, commits, and core remote actions work today. The [roadmap](docs/roadmap.md) tracks the remaining branch, stash, worktree, and advanced hunk interactions.

## What it looks like

A header row spans the top of the screen with the repository name, current branch, ahead/behind counts, dirty file count, and how long ago you last fetched. Under it, a centred toolbar carries Fetch, Pull, Push, Stash, Pop, and Refresh, each greyed out when the repository cannot take that action. Below those sit three resizable panes:

- **Repository.** Local and remote branches, with markers showing checked-out and local/remote state, plus submodules, stashes, and worktrees. The worktree you have open carries the same `◉` marker as the checked-out branch, and a prunable worktree is flagged with `⚠`.
- **History.** A compact, one-line-per-commit colored graph with branch labels, subjects, authors, and short SHAs. Select a commit to see its changed-file tree, then click a file to open its diff.
- **Changes.** Separate collapsible Unstaged and Staged sections, each showing its file count over a Material-icon file tree, with pane actions to discard or stage everything and a commit composer with a summary, a description, and a commit button. Selecting a commit replaces both sections with that commit's changed files.

The bottom row is split. Keybinding hints for the focused pane stay on the left, and transient messages, progress, and errors appear on the right without overwriting them. `Tab` moves focus between the history and changes panes; the highlighted divider and pane heading show where input is going.

The One Dark theme keeps Git status colors meaningful. Added lines stay green, removed lines stay red, and graph lanes remain easy to follow.

## Requirements

- Linux
- [Bun](https://bun.sh/)
- Git 2.43 or newer recommended
- A patched [Nerd Font](https://www.nerdfonts.com/) for Material file icons
- A terminal with mouse reporting and true-color support

## Install and run

Clone the repository, install dependencies, and link the command:

```sh
git clone https://github.com/lucashutch/tuig.git
cd tuig
bun install
bun link
```

Open a repository by path:

```sh
tuig ~/code/my-project
```

The path is optional. Running `tuig` without one opens the current directory. Tuig is currently installed from source; it is not yet published to a package registry.

To install a tagged release globally with Bun:

```sh
bun install -g git+https://github.com/lucashutch/tuig.git#v0.1.0
```

Run `tuig` from any directory after installation.

For development without linking:

```sh
bun run start -- /path/to/repository
```

## Releases

Release versions are managed from Git tags with Bun. From an up-to-date `main` checkout, run:

```sh
bun pm version patch
git push origin main --follow-tags
```

Use `minor` or `major` instead of `patch` when appropriate. This updates `package.json`, creates the matching `vX.Y.Z` tag, and the GitHub Actions release workflow runs the full checks before creating the GitHub release.

To synchronize `package.json` with an existing latest tag without creating another tag:

```sh
bun pm version from-git --no-git-tag-version
```

## Using Tuig

Tuig is designed for the mouse, with keyboard controls for common actions.

| Action                         | Mouse                        | Keyboard                  |
| ------------------------------ | ---------------------------- | ------------------------- |
| Move focus between panes       | Click history or changes     | `Tab`                     |
| Move through history           | Wheel over graph             | `j` / `k`, arrow keys     |
| Check out a branch             | Double-click its graph label |                           |
| Open graph actions             | Right-click a row or label   |                           |
| Inspect a commit               | Click commit                 | `Enter`                   |
| Return to working changes      |                              | `Esc`                     |
| Select a file                  | Click file                   | Left / right arrows       |
| Open the selected file diff    | Click file                   | `Enter` (changes pane)    |
| Expand or collapse a folder    | Click `▶` / `▼`             |                           |
| Switch staged/unstaged section | Click a section's file       | `t`                       |
| Collapse a section             | Click section heading        |                           |
| Stage all changes              | Click `✚ Stage all`          | `a`                       |
| Discard all unstaged changes   | Click `✖ Discard all`       | `d` (twice to confirm)    |
| Stage selected file            |                              | `s`                       |
| Unstage selected file          |                              | `u`                       |
| Stage or unstage first hunk    |                              | `h`                       |
| Write a commit message         | Click summary or description | `c`, `Tab` between fields |
| Commit staged changes          | Click the commit button      | `Enter` in the summary    |
| Fetch / pull / push            | Toolbar                      | `f` / `l` / `p`           |
| Stash or pop changes           | Toolbar                      |                           |
| Refresh                        | Toolbar                      | `r` (when not typing)     |
| Resize a pane                  | Drag divider                 |                           |
| Collapse left/right pane       | Click divider                | `[` / `]`                 |
| Quit                           |                              | `q`                       |

Clicking a short SHA copies it through OSC 52. Right-clicking the repository pane copies the current branch.

Double-clicking a branch label in the graph switches to that branch. Double-clicking a remote-only label creates the matching local branch and tracks it; if a local branch of that name already exists and has diverged, Tuig asks before moving it onto the remote tip, because local-only commits are abandoned.

Right-clicking a graph row opens a menu. On a branch label it offers checkout, rebase, reset (with a soft/mixed/hard submenu), copy branch name, and delete. On any row it offers a detached checkout of the commit, rebase onto it, reset to it, and copy commit SHA. Hard resets, branch deletion, and overwriting a local branch ask for confirmation first; `Esc` or a click outside closes the menu. Tuig refreshes automatically every 60 seconds; press `r` to refresh when you are not typing.

History rows show one ref label. When a commit carries more refs than fit, the extra count appears as `+N`, and tags are included rather than hidden. Branch labels use a laptop for local refs and a globe for remote refs. In the repository pane, `◉` marks the checked-out branch, `◆` marks a branch available locally and remotely, `○` marks a local branch, and `◌` marks a remote-only branch.

## Git and submodules

Tuig runs Git with argument arrays through a typed service layer. Repository state uses porcelain, NUL-delimited paths, and explicit formats instead of localized display output.

After a branch switch, Tuig runs:

```sh
git submodule sync --recursive
git submodule update --init --recursive
```

This keeps submodule URLs and recorded commits aligned with the selected branch.

## Project status

Tuig is useful, but not finished. Current limitations include:

- Stash creation, apply/pop/drop, branch creation, cherry-pick, and tag creation are available from the UI; worktree actions still need UI wiring.
- Hunk mode currently applies the first hunk rather than presenting a full hunk picker.
- Long-running Git commands do not yet expose cancellation.
- Linux is the only supported platform for the first release.

See the [roadmap](docs/roadmap.md) for planned work. Bugs and focused contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md).

## Credits

- [OpenTUI](https://github.com/anomalyco/opentui) provides the terminal renderer and diff component.
- The diff workflow adapts ideas from [OpenCode](https://github.com/anomalyco/opencode).
- The virtual file-tree and icon matching approach follows [Druk](https://github.com/letstri/druk).
- Graph-routing design is independently inspired by [Serie](https://github.com/lusingander/serie) (MIT); no Serie code is copied.
- Material icon associations derive from [Material Icon Theme](https://github.com/material-extensions/vscode-material-icon-theme). The bundled attribution is in [`licenses/`](licenses/).

## License

Tuig is available under the [MIT License](LICENSE).
