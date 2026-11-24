#!/bin/sh
# Builds the release binary and packs it as dist/tuig-<version>-<platform>.tar.gz with a .sha256 file beside it.
#
# The version comes from [workspace.package] in Cargo.toml, the same value that gives `tuig --version`. The archive holds one directory,
# tuig-<version>-<platform>/, with the tuig binary, LICENSE, README.md and licenses/. `tuig update` in tuig-cli
# (package_stem and package_url) depends on this name and layout.
#
# The platform is the host: x86_64-linux, aarch64-linux, aarch64-macos or x86_64-macos.
#
# Linux builds go through cargo-zigbuild (cargo install cargo-zigbuild) and link against glibc 2.17, so the binary runs
# on any distribution with that glibc or a newer one. The script checks the highest GLIBC_ symbol version in the
# result. TUIG_PLAIN_CARGO=1 builds with plain cargo instead and skips that check, for a local build that does not need
# to run elsewhere. macOS builds use plain cargo with the deployment target 13.0.
#
# Needs what build-opentui-native.sh needs, plus cargo, tar and gzip. DIST_DIR overrides the output directory.
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
DIST=${DIST_DIR:-$ROOT_DIR/dist}

# The highest glibc version that a Linux release binary may need. Keep equal to the suffix in build-opentui-native.sh.
GLIBC_FLOOR=2.17
# The macOS version that a release binary may need. Keep equal to the zig target in build-opentui-native.sh.
MACOS_FLOOR=13.0

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) PLATFORM=x86_64-linux TRIPLE=x86_64-unknown-linux-gnu ;;
  Linux-aarch64 | Linux-arm64) PLATFORM=aarch64-linux TRIPLE=aarch64-unknown-linux-gnu ;;
  Darwin-arm64 | Darwin-aarch64) PLATFORM=aarch64-macos TRIPLE=aarch64-apple-darwin ;;
  Darwin-x86_64) PLATFORM=x86_64-macos TRIPLE=x86_64-apple-darwin ;;
  *) echo "error: this script packages Linux and macOS on x86_64 and aarch64 only (see README.md)" >&2; exit 1 ;;
esac

VERSION=$(sed -n '/^\[workspace.package\]$/,/^\[/s|^version = "\([0-9][^"]*\)"$|\1|p' "$ROOT_DIR/Cargo.toml")
[ -n "$VERSION" ] || { echo "error: no workspace version in $ROOT_DIR/Cargo.toml" >&2; exit 1; }
STEM=tuig-$VERSION-$PLATFORM

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi
}

cd "$ROOT_DIR"
OPENTUI_LIB_DIR=$(sh scripts/build-opentui-native.sh)
export OPENTUI_LIB_DIR

case "$PLATFORM" in
  *-linux)
    if [ "${TUIG_PLAIN_CARGO:-}" = 1 ]; then
      cargo build --release --locked -p tuig-app --target "$TRIPLE"
    else
      command -v cargo-zigbuild >/dev/null 2>&1 || {
        echo "error: cargo-zigbuild is missing. Run: cargo install --locked cargo-zigbuild" >&2
        echo "       For a build that only runs on this host, set TUIG_PLAIN_CARGO=1." >&2
        exit 1
      }
      cargo zigbuild --release --locked -p tuig-app --target "$TRIPLE.$GLIBC_FLOOR"
    fi
    ;;
  *-macos)
    MACOSX_DEPLOYMENT_TARGET=$MACOS_FLOOR
    export MACOSX_DEPLOYMENT_TARGET
    cargo build --release --locked -p tuig-app --target "$TRIPLE"
    ;;
esac
# An explicit --target puts the binary under target/<triple>/, with or without the glibc suffix.
BINARY=${CARGO_TARGET_DIR:-$ROOT_DIR/target}/$TRIPLE/release/tuig

# The binary must carry OpenTUI inside. Only the system libraries may be loaded at run time.
case "$PLATFORM" in
  *-linux) NEEDED=$(ldd "$BINARY" 2>&1 || true) ;;
  *-macos) NEEDED=$(otool -L "$BINARY" | tail -n +2) ;;
esac
if printf '%s\n' "$NEEDED" | grep -qi opentui; then
  echo "error: $BINARY links a shared OpenTUI library" >&2
  exit 1
fi
if [ "$PLATFORM" = x86_64-linux ] || [ "$PLATFORM" = aarch64-linux ]; then
  if [ "${TUIG_PLAIN_CARGO:-}" != 1 ]; then
    HIGHEST=$(objdump -T "$BINARY" | grep -o 'GLIBC_[0-9][0-9.]*' | sed 's/^GLIBC_//' | sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1)
    echo "highest glibc symbol version: ${HIGHEST:-none}" >&2
    if [ -n "$HIGHEST" ] && [ "$(printf '%s\n%s\n' "$GLIBC_FLOOR" "$HIGHEST" | sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1)" != "$GLIBC_FLOOR" ]; then
      echo "error: $BINARY needs glibc $HIGHEST, more than the floor $GLIBC_FLOOR" >&2
      exit 1
    fi
  fi
fi
[ "$("$BINARY" --version)" = "tuig $VERSION" ] || { echo "error: $BINARY does not report version $VERSION" >&2; exit 1; }

umask 022
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
mkdir "$STAGE/$STEM"
cp "$BINARY" "$STAGE/$STEM/tuig"
cp "$ROOT_DIR/LICENSE" "$ROOT_DIR/README.md" "$STAGE/$STEM/"
cp -R "$ROOT_DIR/licenses" "$STAGE/$STEM/licenses"

mkdir -p "$DIST"
# Fixed owner, order and time keep the archive the same for the same inputs. gzip -n leaves out the time stamp.
if tar --version 2>/dev/null | grep -q 'GNU tar'; then
  tar --sort=name --owner=0 --group=0 --numeric-owner --mtime=@0 -cf - -C "$STAGE" "$STEM" | gzip -9n > "$DIST/$STEM.tar.gz"
else
  # BSD tar (macOS) has no --sort and no --mtime. Set the time on the files, and list them in byte order.
  # COPYFILE_DISABLE and the --no-* options keep extended attributes, ACLs, file flags and AppleDouble files out of the archive.
  # --format ustar leaves out the pax headers, which can carry times and other per-run data.
  COPYFILE_DISABLE=1
  export COPYFILE_DISABLE
  (cd "$STAGE" && find "$STEM" -exec env TZ=UTC touch -h -t 197001010000 {} +)
  (cd "$STAGE" && find "$STEM" | LC_ALL=C sort > "$STAGE/.list")
  tar --format ustar --no-xattrs --no-acls --no-fflags --no-mac-metadata --no-recursion --uid 0 --gid 0 --uname '' --gname '' --numeric-owner -cf - -C "$STAGE" -T "$STAGE/.list" | gzip -9n > "$DIST/$STEM.tar.gz"
fi
(cd "$DIST" && sha256_file "$STEM.tar.gz" > "$STEM.tar.gz.sha256")
echo "packed $DIST/$STEM.tar.gz" >&2
echo "$DIST/$STEM.tar.gz"
