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

## Release package

```sh
scripts/package.sh
```

The script builds the native library, builds `tuig` with `cargo build --release --locked`, and writes
`dist/tuig-<version>-x86_64-linux.tar.gz` and a `.sha256` file. The version comes from `../package.json`, the file that
also gives `tuig --version`. The archive holds one directory with `tuig`, `LICENSE`, `README.md` and `licenses/`.

OpenTUI is linked statically from `libopentui.a`. The binary needs no `OPENTUI_LIB_DIR` and no shared OpenTUI library.
`ldd` lists only `libc`, `libm`, `libgcc_s` and the loader, so build releases on the oldest glibc you want to support.
The release profile in `Cargo.toml` uses fat LTO, one codegen unit and `strip = "symbols"`. It keeps `panic = "unwind"`
so the terminal restores on a panic.

`tuig update` downloads the archive of the latest GitHub release (`package_url` in `tuig-cli/src/update.rs`), checks the
SHA-256 sum, runs the new binary with `--version` and requires the output `tuig <version>` of that release, and replaces
the running executable. The sum finds a damaged download. It does not prove who published the archive.

**Releases do not publish the Rust package yet.** `.github/workflows/release.yml` creates the GitHub release but builds
and attaches no archive, so `tuig update` in the Rust binary fails with an HTTP 404 until a release job uploads
`tuig-<version>-x86_64-linux.tar.gz` and its `.sha256` file. `package_url` carries a `TODO(hosting)` for this. The CI
artifact from `rust.yml` is not a release: it builds on `ubuntu-latest`, which has a newer glibc than a release host
should have.

Other platforms:

- aarch64 Linux: `build-opentui-native.sh` already builds it. Build on an aarch64 host or add a cross target, and add the
  platform to `package.sh` and `current_platform`.
- macOS: the native-library script must learn the macOS zig targets and the framework list that `opentui-sys` links.
- Windows: `opentui-sys` links `opentui.dll` there, so the package would need to ship the DLL.
