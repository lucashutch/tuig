# Roadmap

Tuig already has a compact colored commit graph with merge edges, branch labels, and tags; commit metadata and diffs; a changed-file tree with staging and commits; fetch/pull/push shortcuts; stash create/apply/pop/drop; worktree open, lock, and remove; cherry-pick, reset, and rebase with confirmation dialogs; tag creation, push, and deletion; repository tabs with recent repositories and folder discovery; side-by-side diffs; line staging; file history and line blame; commit comparison; a command palette; OpenCode V2 themes; author avatars; and GitHub pull requests with check status in the repository pane and the history graph. The work below tracks the remaining path beyond that MVP.

## Finish the core workflow

- Add worktree creation. Open, lock, unlock, and removal are already available from worktree row menus.
- Add more changed-file actions beyond staging, unstaging, copying the path, and discarding unstaged changes.
- Add a hunk selector with next/previous navigation. Selected-line staging already works from the diff, and `h` still applies only the first hunk.
- Add conflict views, improve rename and binary-file handling, and expand integration coverage.

## Graph and repository navigation

- Add per-tab command state.
- Add commit search to the history pane. The paging helpers exist in `src/ui/search.ts`, but nothing in the interface uses them yet.
- Add commit revert with a safety dialog.

## Presentation

- Make UI dimensions configurable. Color themes use the OpenCode V2 format and can be selected from the command palette.
- Add compact and wide responsive layouts, diff virtualization, and file-tree grouping. Side-by-side diffs already switch to inline below 120 columns.
- Improve avatars on terminals without Kitty or Sixel graphics. Tuig already checks for terminal graphics support and shows text fallbacks when it is missing.
