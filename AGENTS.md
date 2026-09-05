# Agent guide

Read [`repo-map.md`](repo-map.md) before making broad changes. Keep Git process handling in `src/git/` and UI behavior in `src/ui/`.

Before finishing a change, run:

```sh
bun run check
```

Do not commit generated output, logs, `node_modules`, or local planning files. Use disposable repositories when testing destructive Git operations.

This repository uses rebase merges.
