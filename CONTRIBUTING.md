# Contributing to Tuig

Tuig is an early project. Small, complete changes are easier to review than broad rewrites. If a change affects interaction design or Git safety, open an issue or discussion before investing in a large implementation.

## Development setup

You need Linux, Git, and Bun.

```sh
git clone https://github.com/lucashutch/tuig.git
cd tuig
bun install
bun run check
bun run start -- /path/to/a/test/repository
```

Use a disposable repository when testing destructive Git operations.

## Project structure

- `src/git/` contains the Git process boundary, parsers, domain types, and repository operations.
- `src/ui/` contains OpenTUI rendering, graph routing, file-tree models, themes, icons, and interaction state.
- `src/index.ts` resolves the repository path and starts the application.
- `tests/git/` uses temporary repositories for parser and operation coverage.
- `tests/ui/` covers pure graph, tree, icon, and state models.
- `assets/icons/` contains the Material icon association data.

The short [`repo-map.md`](repo-map.md) is the quickest orientation reference.

## Design rules

### Keep Git isolated

UI code should depend on `GitRepository`, not spawn processes. Add commands to `src/git/repository.ts` and expose typed results through `src/git/types.ts`.

- Pass arguments as arrays. Never build shell command strings from repository data.
- Prefer porcelain, `-z`, and explicit `--format` output.
- Treat filenames, refs, and commit text as untrusted data.
- Preserve useful stderr and exit codes in errors.
- Add temporary-repository tests for new mutations.

### Keep scrolling cheap

The graph and file tree run in the terminal's input loop. Do not execute Git commands or rebuild the full history during each scroll event.

- Compute graph topology when the snapshot changes.
- Render only the visible history window.
- Keep tree models pure and flatten only visible nodes.
- Guard asynchronous diff requests so stale results cannot replace current content.

### Keep operations safe

Confirm actions that can discard work. A branch switch must retain the submodule synchronization behavior unless the product adds an explicit setting. Show partial failures when Git changes repository state before a later step fails.

## Code style and checks

Format the repository before submitting:

```sh
bun run format
bun run check
```

`bun run check` verifies Prettier formatting, TypeScript types, and the Bun test suite.

Add tests for behavior, not implementation details. Parser fixtures should include spaces, unusual paths, empty repositories, and relevant failure output.

## Manual testing

For UI changes, check at least:

1. A clean repository with several branches and merges.
2. Staged, modified, deleted, renamed, and untracked files.
3. Long filenames and nested directories.
4. A narrow terminal and resized or collapsed panes.
5. Rapid graph scrolling followed by commit and file selection.
6. A repository with submodules when changing checkout behavior.

Material icons require a patched Nerd Font. Make sure missing glyphs are not mistaken for layout bugs.

## Pull requests

Include:

- The user-visible problem and the chosen behavior.
- Tests and commands run.
- Manual terminal checks for visual changes.
- Screenshots or a short recording when layout or graph rendering changes.
- Known limitations or follow-up work.

Do not include generated output, local logs, or `node_modules`.

## Licensing

Contributions are accepted under Tuig's [MIT License](LICENSE). Do not add icon packs, themes, or copied source without preserving their license and attribution.
