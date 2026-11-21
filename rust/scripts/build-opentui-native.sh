#!/bin/sh
# Builds OpenTUI's native library at the version pinned in rust/Cargo.toml and installs it in
# rust/.opentui-native/lib, where .cargo/config.toml points OPENTUI_LIB_DIR.
#
# Needs git, zig (the version in OpenTUI's .zig-version) and a C toolchain that zig can drive. It does not need bun:
# the vendored Zig dependencies unpack with tar, and the build skips FFmpeg, so the library has no video support.
# It builds for the host platform: Linux or macOS, x86_64 or aarch64. On macOS it also needs the Xcode command line
# tools, because OpenTUI's build reads the macOS SDK (xcrun). Linux libraries link against glibc 2.17 symbols only.
#
# OPENTUI_CACHE_DIR overrides the cache directory (default rust/.opentui-native).
set -eu

RUST_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
CACHE=${OPENTUI_CACHE_DIR:-$RUST_DIR/.opentui-native}
URL=https://github.com/anomalyco/opentui

# Single source of truth: the exact version of the workspace dependency. The crates.io release v<version> and the git
# tag v<version> hold the same source, so the Rust crates and the native library cannot differ.
VERSION=$(sed -n 's|^opentui = {.*version = "=\([0-9][0-9.]*\)".*|\1|p' "$RUST_DIR/Cargo.toml")
[ -n "$VERSION" ] || { echo "error: no pinned opentui version in $RUST_DIR/Cargo.toml" >&2; exit 1; }
REF=v$VERSION

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) ZIG_TARGET=x86_64-linux-gnu.2.17 PLATFORM=x86_64-linux ;;
  Linux-aarch64 | Linux-arm64) ZIG_TARGET=aarch64-linux-gnu.2.17 PLATFORM=aarch64-linux ;;
  # The 13.0 suffix is the macOS deployment target. It matches OpenTUI's own target table and package.sh.
  Darwin-arm64 | Darwin-aarch64) ZIG_TARGET=aarch64-macos.13.0 PLATFORM=aarch64-macos ;;
  Darwin-x86_64) ZIG_TARGET=x86_64-macos.13.0 PLATFORM=x86_64-macos ;;
  *) echo "error: this script supports Linux and macOS on x86_64 and aarch64 only" >&2; exit 1 ;;
esac

LIB_DIR=$CACHE/lib
if [ "$(cat "$LIB_DIR/.rev" 2>/dev/null || true)" = "$VERSION" ] && [ -f "$LIB_DIR/libopentui.a" ]; then
  echo "native library for $VERSION is up to date: $LIB_DIR" >&2
  echo "$LIB_DIR"
  exit 0
fi

SRC=$CACHE/src
if [ "$(git -C "$SRC" describe --tags --exact-match HEAD 2>/dev/null || true)" != "$REF" ]; then
  rm -rf "$SRC"
  mkdir -p "$SRC"
  git -C "$SRC" init -q
  git -C "$SRC" fetch -q --depth 1 "$URL" "refs/tags/$REF:refs/tags/$REF"
  git -C "$SRC" checkout -q --detach "$REF"
fi

WANT_ZIG=$(cat "$SRC/.zig-version")
HAVE_ZIG=$(zig version)
if [ "$WANT_ZIG" != "$HAVE_ZIG" ]; then
  echo "error: OpenTUI $VERSION needs zig $WANT_ZIG, found $HAVE_ZIG" >&2
  exit 1
fi

cd "$SRC/packages/native"
sh scripts/prepare-zig-deps.sh
zig build -Doptimize=ReleaseFast "-Dlibrary-target=$ZIG_TARGET"

rm -rf "$LIB_DIR"
mkdir -p "$LIB_DIR"
cp "lib/$PLATFORM"/* "$LIB_DIR/"
echo "$VERSION" > "$LIB_DIR/.rev"
echo "built native library for $VERSION: $LIB_DIR" >&2
echo "$LIB_DIR"
