# Repo Map

Purpose: Mouse-first terminal Git client backed by the Git CLI.
Stack: Rust, OpenTUI (Rust crate and a statically linked native library)
Canonical repository: https://github.com/lucashutch/tuig

## Layout

- `crates/tuig-git/` — Git process boundary, parsers, patch building, and domain types.
- `crates/tuig-ui-model/` — pure UI state, layout, theme, icon, and preference logic. No rendering.
- `crates/tuig-widgets/` — OpenTUI widgets that paint `tuig-ui-model` state.
- `crates/tuig-app/` — app shell, message loop, and screens. Builds the `tuig` binary.
- `crates/tuig-cli/` — command line parsing, `tuig update`, the URL opener, and start-up repositories.
- `crates/tuig-spike/` — the original OpenTUI feasibility spike. Not shipped.
- `assets/icons/`, `assets/themes/` — Material icon data and bundled themes, read with `include_str!`.
- `icu4x_data/` — generated ICU4X root collation data. Regenerate with `scripts/gen-icu4x-data.sh`.
- `scripts/` — native library build, release packaging, and data generators.
- `docs/building.md` — prerequisites, the OpenTUI pin, and release packaging.
- `docs/app-shell.md` — how the app shell owns state and runs Git work.

## Commands

- Native library (once per OpenTUI version): `scripts/build-opentui-native.sh`
- Run: `cargo run -p tuig-app -- [repository]`
- Check: `cargo fmt --check && cargo clippy --all-targets --locked -- -D warnings && cargo test --locked`
- Release package: `scripts/package.sh`

## Conventions & gotchas

- Git subprocesses belong in `tuig-git`; UI code depends on typed methods.
- Prefer NUL-delimited porcelain output and explicit Git formats.
- The version lives in `[workspace.package]` in `Cargo.toml`. The release tag must match it.
- OpenTUI is pre-1.0, so its dependency is pinned exactly. See `docs/building.md` to bump it.
