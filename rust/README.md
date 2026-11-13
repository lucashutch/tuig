# tuig Rust workspace

## Prerequisites

- Rust, installed with rustup. The toolchain must support edition 2024.
- zig 0.17.0, on `PATH`. The script checks it against OpenTUI's `.zig-version` and stops on a mismatch.
- git, tar, and a network connection for the first build.
- Linux on x86_64 or aarch64. The script does not support macOS or Windows yet.

bun is not needed. The script skips FFmpeg, so the native library has no video support. tuig does not use video.

## Build

Run both commands in this directory:

```sh
scripts/build-opentui-native.sh
cargo build
```

The script fetches OpenTUI at the pinned rev into `.opentui-native/src`, builds the native library, and installs it in
`.opentui-native/lib`. The first run takes about 3 minutes. Later runs exit at once while the pinned rev is unchanged.
`.cargo/config.toml` sets `OPENTUI_LIB_DIR` to that directory, so Cargo needs no other setup when you run it in
`rust/`. To link another library build, set `OPENTUI_LIB_DIR` to an absolute path. The environment wins over the config.

Set `OPENTUI_CACHE_DIR` to put the cache somewhere else. Then also set `OPENTUI_LIB_DIR` to `$OPENTUI_CACHE_DIR/lib`
when you run Cargo.

## How the pin works

The `rev` of the `opentui` entry in `[workspace.dependencies]` in `Cargo.toml` is the only place that names the OpenTUI
version. The script reads it from there, so the Rust crates and the native library cannot differ. As a second check,
`opentui-sys` hashes `opentui.h` from the native library and fails the build if it differs from the header its bindings
were generated from.

## Bump OpenTUI

1. Replace `rev` in `[workspace.dependencies]` in `Cargo.toml` with the new 40-character commit hash.
2. Run `cargo update -p opentui`.
3. Run `scripts/build-opentui-native.sh`. It rebuilds the library and checks the zig version the new rev needs.
4. Run `cargo clippy --all-targets -- -D warnings` and `cargo test`.
