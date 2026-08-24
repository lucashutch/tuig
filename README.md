# Tuig

**A mouse-first Git client for the terminal.**

Tuig, pronounced like "twig", combines a visual branch graph with a fast terminal workflow. Browse history, inspect commits, review changed files, stage work, and commit without leaving your terminal.

Tuig is built with TypeScript, Bun, OpenTUI, and the Git executable already installed on your system. It does not replace Git or hide it behind a custom repository implementation.

> Tuig is an early MVP. The graph, diff viewer, changed-file tree, staging, commits, and core remote actions work today. The [roadmap](docs/roadmap.md) tracks the remaining branch, stash, worktree, and advanced hunk interactions.

## What it looks like

The interface has three resizable panes:

- **Repository.** Local and remote branches, with markers showing checked-out and local/remote state, plus submodules, stashes, and worktrees.
- **History.** A compact, one-line-per-commit colored graph with branch labels, subjects, authors, and short SHAs. Select a commit to see its changed-file tree, then click a file to open its diff.
- **Changes.** A working-changes row and collapsible Material-icon file tree for staged, unstaged, or commit files, plus the commit composer.

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

For development without linking:

```sh
bun run start -- /path/to/repository
```

## Using Tuig

Tuig is designed for the mouse, with keyboard controls for common actions.

| Action                       | Mouse            | Keyboard              |
| ---------------------------- | ---------------- | --------------------- |
| Move through history         | Wheel over graph | `j` / `k`, arrow keys |
| Inspect a commit             | Click commit     | `Enter`               |
| Return to working changes    |                  | `Esc`                 |
| Select a file                | Click file       | Left / right arrows   |
| Expand or collapse a folder  | Click `▶` / `▼` |                       |
| Switch staged/unstaged files |                  | `Tab`                 |
| Stage selected file          |                  | `s`                   |
| Unstage selected file        |                  | `u`                   |
| Stage or unstage first hunk  |                  | `h`                   |
| Write a commit message       | Click composer   | `c`                   |
| Fetch / pull / push          |                  | `f` / `l` / `p`       |
| Refresh                      |                  | `r` (when not typing) |
| Resize a pane                | Drag divider     |                       |
| Collapse left/right pane     | Click divider    | `[` / `]`             |
| Quit                         |                  | `q`                   |

Clicking a short SHA copies it through OSC 52. Right-clicking the repository pane copies the current branch. Tuig refreshes automatically every 60 seconds; press `r` to refresh when you are not typing.

Branch labels use a laptop for local refs and a globe for remote refs. In the repository pane, `◉` marks the checked-out branch, `◆` marks a branch available locally and remotely, `○` marks a local branch, and `◌` marks a remote-only branch.

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

- Branch, stash, and worktree data are visible, but several context-menu actions still need UI wiring.
- Hunk mode currently applies the first hunk rather than presenting a full hunk picker.
- Long-running Git commands do not yet expose cancellation.
- Linux is the only supported platform for the first release.

See the [roadmap](docs/roadmap.md) for planned work. Bugs and focused contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md).

## Credits

- [OpenTUI](https://github.com/anomalyco/opentui) provides the terminal renderer and diff component.
- The diff workflow adapts ideas from [OpenCode](https://github.com/anomalyco/opencode).
- The virtual file-tree and icon matching approach follows [Druk](https://github.com/letstri/druk).
- Material icon associations derive from [Material Icon Theme](https://github.com/material-extensions/vscode-material-icon-theme). The bundled attribution is in [`licenses/`](licenses/).

## License

Tuig is available under the [MIT License](LICENSE).
