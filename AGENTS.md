# Agent guide

Read [`repo-map.md`](repo-map.md) before making broad changes. Keep Git process handling in `crates/tuig-git/` and UI behavior in the `tuig-ui-model`, `tuig-widgets`, and `tuig-app` crates.

Before finishing a change, run:

```sh
cargo fmt --check
cargo clippy --all-targets --locked -- -D warnings
cargo test --locked
```

Build the OpenTUI native library once with `scripts/build-opentui-native.sh`. It needs zig 0.17.1.

Do not commit generated output, logs, `target/`, `.opentui-native/`, or local planning files. Use disposable repositories when testing destructive Git operations.

This repository uses rebase merges.
