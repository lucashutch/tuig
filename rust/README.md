# tuig Rust workspace

## Prerequisites

- Rust, installed with rustup. The toolchain must support edition 2024.
- zig 0.17.0, on `PATH`. The script checks it against OpenTUI's `.zig-version` and stops on a mismatch.
- git, tar, and a network connection for the first build.
- Linux or macOS, on x86_64 or aarch64. Windows is not supported.
- On macOS, the Xcode command line tools. OpenTUI's build reads the macOS SDK.
- For release packages on Linux, `cargo-zigbuild` (`cargo install --locked cargo-zigbuild`).

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
`dist/tuig-<version>-<platform>.tar.gz` and a `.sha256` file. The platform is the host: `x86_64-linux`,
`aarch64-linux`, `aarch64-macos` or `x86_64-macos`. The version comes from `../package.json`, the file that also gives
`tuig --version`. The archive holds one directory with `tuig`, `LICENSE`, `README.md` and `licenses/`. The script
fixes the owner, file order and time stamps, so the same inputs give the same archive. It needs `sha256sum` or
`shasum`, and GNU or BSD tar.

OpenTUI is linked statically from `libopentui.a`. The binary needs no `OPENTUI_LIB_DIR` and no shared OpenTUI library.
The script checks this with `ldd` on Linux and `otool -L` on macOS. On macOS the `opentui-sys` build script links the
system frameworks and libraries that the archive needs (AppKit, Foundation, ImageIO, CoreFoundation, CoreAudio,
AudioToolbox, VideoToolbox, CoreMedia, CoreVideo, CoreServices, QuartzCore, libc++ and libobjc).
The release profile in `Cargo.toml` uses fat LTO, one codegen unit and `strip = "symbols"`. It keeps `panic = "unwind"`
so the terminal restores on a panic.

### Supported platforms

| Platform | Built on | Minimum system |
| --- | --- | --- |
| `x86_64-linux` | `ubuntu-24.04` | glibc 2.17 |
| `aarch64-linux` | `ubuntu-24.04-arm` | glibc 2.17 |
| `aarch64-macos` | `macos-15` | macOS 13 |
| `x86_64-macos` | `macos-15-intel` | macOS 13 |

Linux binaries link through `cargo-zigbuild` with the target `<triple>.2.17`, and the native library is built for
`<arch>-linux-gnu.2.17`. The runner image does not set the glibc floor. After the build, `package.sh` reads the highest
`GLIBC_` symbol version with `objdump -T` and fails if it is above 2.17. Set `TUIG_PLAIN_CARGO=1` for a plain `cargo
build` that needs no `cargo-zigbuild` and skips the check. That binary needs the glibc of the build host.

macOS builds use `MACOSX_DEPLOYMENT_TARGET=13.0`, equal to the zig target of the native library. Windows is not packaged:
`opentui-sys` links `opentui.dll` there, so the package would need to ship the DLL.

### Release job

`.github/workflows/release.yml` runs a `rust-package` job for each platform after it creates the GitHub release. Each job
runs `scripts/package.sh` and uploads the archive and its `.sha256` file with `gh release upload`. The zig version
(`ZIG_VERSION`) is set once at the top of `release.yml` and of `rust.yml`. It must equal `.zig-version` of the pinned
OpenTUI rev. `rust.yml` builds the same Linux package as a CI artifact.

`tuig update` downloads the archive of the latest GitHub release (`package_url` in `tuig-cli/src/update.rs`), checks the
SHA-256 sum, runs the new binary with `--version` and requires the output `tuig <version>` of that release, and replaces
the running executable. `current_platform` picks the asset for the host. The sum finds a damaged download. It does not
prove who published the archive.
