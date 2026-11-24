# Contributing to Tuig

Tuig is an early project. Small, complete changes are easier to review than broad rewrites. If a change affects interaction design or Git safety, open an issue or discussion before investing in a large implementation.

## Development setup

You need Linux or macOS, Git, Rust, and zig 0.17.1. [docs/building.md](docs/building.md) lists every prerequisite.

```sh
git clone https://github.com/lucashutch/tuig.git
cd tuig
scripts/build-opentui-native.sh
cargo run -p tuig-app -- /path/to/a/test/repository
```

Use a disposable repository when testing destructive Git operations.

## Project structure

- `crates/tuig-git/` contains the Git process boundary, parsers, domain types, and repository operations.
- `crates/tuig-ui-model/` contains UI state, layout, themes, and preferences, with no rendering.
- `crates/tuig-widgets/` contains the OpenTUI widgets that paint `tuig-ui-model` state.
- `crates/tuig-app/` contains the app shell, message loop, and screens. It builds the `tuig` binary.
- `crates/tuig-cli/` contains command line handling and `tuig update`.
- `assets/` contains the Material icon data and the bundled themes.

The short [`repo-map.md`](repo-map.md) is the quickest orientation reference.

## Design rules

### Keep Git isolated

UI code should depend on typed methods in `tuig-git`, not spawn processes. Add Git commands and their result types to `crates/tuig-git/`.

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

Run these before submitting:

```sh
cargo fmt
cargo clippy --all-targets --locked -- -D warnings
cargo test --locked
```

The same checks run in GitHub Actions for every push and pull request.

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

## Releases

1. Set `version` in `[workspace.package]` in `Cargo.toml`, run `cargo update --workspace`, and merge the change to `main`.
2. Tag the merge commit and push the tag:

   ```sh
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

The release workflow checks that the tag matches the workspace version, creates a draft release, and builds a package for each platform. It publishes the release when every package is uploaded. If a platform fails, the release stays a draft.

## Pull requests

Include:

- The user-visible problem and the chosen behavior.
- Tests and commands run.
- Manual terminal checks for visual changes.
- Screenshots or a short recording when layout or graph rendering changes.
- Known limitations or follow-up work.

Do not include generated output, local logs, `target/`, or `.opentui-native/`.

## Licensing

Contributions are accepted under Tuig's [MIT License](LICENSE). Do not add icon packs, themes, or copied source without preserving their license and attribution.
