# Building tuig

## Prerequisites

- Rust, installed with rustup. The toolchain must support edition 2024.
- zig 0.17.1, on `PATH`. The script checks it against OpenTUI's `.zig-version` and stops on a mismatch.
- git, tar, and a network connection for the first build.
- Linux or macOS, on x86_64 or aarch64. Windows is not supported.
- On macOS, the Xcode command line tools. OpenTUI's build reads the macOS SDK.
- For release packages on Linux, `cargo-zigbuild` (`cargo install --locked cargo-zigbuild`).

The script builds with `-Dvideo=false`, so the native library has no FFmpeg and no video support. tuig does not use video. The script fails if `libopentui.a` holds `avcodec_` or `avformat_` symbols.

The `opentui-sys` crate declares the license `MIT AND LGPL-2.1-or-later`. The LGPL part covers FFmpeg. Our static build has no FFmpeg, so only the MIT part and the non-FFmpeg notices apply (Yoga, zlib, gdtoa, and the Zig compiler-rt and LLVM runtime). The notices are in `licenses/`.

## Build

Run both commands in the repository root:

```sh
scripts/build-opentui-native.sh
cargo build
```

The script fetches the OpenTUI tag of the pinned version into `.opentui-native/src`, builds the native library, and
installs it in `.opentui-native/lib`. The first run takes about 3 minutes. Later runs exit at once while the pinned
version is unchanged.
The `opentui-sys` crate from crates.io does not ship the native library, so this step stays.
`.cargo/config.toml` sets `OPENTUI_LIB_DIR` to that directory, so Cargo needs no other setup when you run it in
the repository root. To link another library build, set `OPENTUI_LIB_DIR` to an absolute path. The environment wins over the config.

Set `OPENTUI_CACHE_DIR` to put the cache somewhere else. Then also set `OPENTUI_LIB_DIR` to `$OPENTUI_CACHE_DIR/lib`
when you run Cargo.

## How the pin works

The `version` of the `opentui` entry in `[workspace.dependencies]` in `Cargo.toml` is the only place that names the
OpenTUI version. It is an exact pin (`=x.y.z`) of the crates.io release. The script reads it from there and builds the
native library from the git tag `vx.y.z`, so the Rust crates and the native library cannot differ. As a second check,
`opentui-sys` hashes `opentui.h` from the native library and fails the build if it differs from the header its bindings
were generated from.

## Bump OpenTUI

1. Replace the `version` in `[workspace.dependencies]` in `Cargo.toml` with the new release, for example `=0.9.8`.
2. Run `cargo update -p opentui`.
3. Run `scripts/build-opentui-native.sh`. It rebuilds the library and checks the zig version the new release needs.
4. Run `cargo clippy --all-targets -- -D warnings` and `cargo test`.

## ICU4X data

`tuig-ui-model` sorts file names with the ICU4X root collator. `.cargo/config.toml` sets `ICU4X_DATA_DIR` to
`icu4x_data`, a baked data module for the root collation only. The `icu_*_data` crates include it in place of their
bundled data for every locale, which makes the release binary about 0.65 MB smaller (the directory is 1.8 MB of source).

To regenerate it after an `icu_collator` update, run `cargo install icu4x-datagen --version <version in Cargo.lock>`
and then `scripts/gen-icu4x-data.sh`. The script lists the data markers by name, because `--markers-for-bin` misses
the normalizer and fallback markers. If a build fails with "cannot find macro `impl_..._v1`", add that marker to the
script. `cargo test -p tuig-ui-model --test name_sort` fails when the root data is missing.

## Release package

```sh
scripts/package.sh
```

The script builds the native library, builds `tuig` with `cargo build --release --locked`, and writes
`dist/tuig-<version>-<platform>.tar.gz` and a `.sha256` file. The platform is the host: `x86_64-linux`,
`aarch64-linux`, `aarch64-macos` or `x86_64-macos`. The version comes from `[workspace.package]` in `Cargo.toml`, the value that also gives
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

| Platform        | Built on           | Minimum system |
| --------------- | ------------------ | -------------- |
| `x86_64-linux`  | `ubuntu-24.04`     | glibc 2.17     |
| `aarch64-linux` | `ubuntu-24.04-arm` | glibc 2.17     |
| `aarch64-macos` | `macos-15`         | macOS 13       |
| `x86_64-macos`  | `macos-15-intel`   | macOS 13       |

Linux binaries link through `cargo-zigbuild` with the target `<triple>.2.17`, and the native library is built for
`<arch>-linux-gnu.2.17`. The runner image does not set the glibc floor. After the build, `package.sh` reads the highest
`GLIBC_` symbol version with `objdump -T` and fails if it is above 2.17. Set `TUIG_PLAIN_CARGO=1` for a plain `cargo
build` that needs no `cargo-zigbuild` and skips the check. That binary needs the glibc of the build host.

macOS builds use `MACOSX_DEPLOYMENT_TARGET=13.0`, equal to the zig target of the native library. Windows is not packaged:
`opentui-sys` links `opentui.dll` there, so the package would need to ship the DLL.

### Release job

`.github/workflows/release.yml` runs a `rust-package` job for each platform after it creates the GitHub release. Each job
runs `scripts/package.sh` and uploads the archive and its `.sha256` file with `gh release upload`. The zig version
(`ZIG_VERSION`) is set once at the top of `release.yml` and of `ci.yml`. It must equal `.zig-version` of the pinned
OpenTUI version. `ci.yml` builds the same Linux package as a CI artifact.

`tuig update` downloads the archive of the latest GitHub release (`package_url` in `tuig-cli/src/update.rs`), checks the
SHA-256 sum, runs the new binary with `--version` and requires the output `tuig <version>` of that release, and replaces
the running executable. `current_platform` picks the asset for the host. The sum finds a damaged download. It does not
prove who published the archive.
