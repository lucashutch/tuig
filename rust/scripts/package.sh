#!/bin/sh
# Builds the release binary and packs it as rust/dist/tuig-<version>-<platform>.tar.gz with a .sha256 file beside it.
#
# The version comes from ../package.json, the same file that gives `tuig --version`. The archive holds one directory,
# tuig-<version>-<platform>/, with the tuig binary, LICENSE, README.md and licenses/. `tuig update` in tuig-cli
# (package_stem and package_url) depends on this name and layout.
#
# Needs what build-opentui-native.sh needs, plus cargo and GNU tar. DIST_DIR overrides the output directory.
set -eu

RUST_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
ROOT_DIR=$(dirname -- "$RUST_DIR")
DIST=${DIST_DIR:-$RUST_DIR/dist}

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) PLATFORM=x86_64-linux ;;
  *) echo "error: this script packages Linux x86_64 only (see README.md)" >&2; exit 1 ;;
esac

VERSION=$(sed -n 's|^  "version": "\([0-9][^"]*\)",$|\1|p' "$ROOT_DIR/package.json")
[ -n "$VERSION" ] || { echo "error: no version in $ROOT_DIR/package.json" >&2; exit 1; }
STEM=tuig-$VERSION-$PLATFORM

cd "$RUST_DIR"
OPENTUI_LIB_DIR=$(sh scripts/build-opentui-native.sh)
export OPENTUI_LIB_DIR
cargo build --release --locked -p tuig-app
BINARY=$RUST_DIR/target/release/tuig

# The binary must carry OpenTUI inside. Only the system libraries may be loaded at run time.
if ldd "$BINARY" | grep -q opentui; then
  echo "error: $BINARY links a shared OpenTUI library" >&2
  exit 1
fi
[ "$("$BINARY" --version)" = "tuig $VERSION" ] || { echo "error: $BINARY does not report version $VERSION" >&2; exit 1; }

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
mkdir "$STAGE/$STEM"
cp "$BINARY" "$STAGE/$STEM/tuig"
cp "$ROOT_DIR/LICENSE" "$ROOT_DIR/README.md" "$STAGE/$STEM/"
cp -R "$ROOT_DIR/licenses" "$STAGE/$STEM/licenses"

mkdir -p "$DIST"
# Fixed owner, order and time keep the archive the same for the same inputs. gzip -n leaves out the time stamp.
tar --sort=name --owner=0 --group=0 --numeric-owner --mtime=@0 -cf - -C "$STAGE" "$STEM" | gzip -9n > "$DIST/$STEM.tar.gz"
(cd "$DIST" && sha256sum "$STEM.tar.gz" > "$STEM.tar.gz.sha256")
echo "packed $DIST/$STEM.tar.gz" >&2
echo "$DIST/$STEM.tar.gz"
