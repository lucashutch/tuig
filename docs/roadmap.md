# Roadmap

Tuig already has a compact colored commit graph with merge edges, branch labels, and tags; commit metadata and diffs; a changed-file tree with staging and commits; fetch/pull/push shortcuts; stash create/apply/pop/drop; worktree add, lock, and remove; cherry-pick, reset, and rebase with confirmation dialogs; commit tagging; and author avatars. The work below tracks the remaining path beyond that MVP.

## Finish the core workflow

- Add worktree creation and switching. Lock, unlock, and removal are already available from worktree row menus.
- Add more changed-file actions beyond staging, unstaging, copying the path, and discarding unstaged changes.
- Add a hunk selector with next/previous navigation and selected-line patch construction.
- Add conflict views, improve rename and binary-file handling, and expand integration coverage.

## Graph and repository navigation

- Add repository tabs, recent repositories, filesystem discovery, and per-tab command state.
- Add commit operations such as revert and tag deletion with safety dialogs.

## Presentation

- Move all dimensions and colors into theme definitions and load user themes.
- Add compact and wide responsive layouts, diff virtualization, split diffs, and file-tree grouping.
- Detect Kitty graphics so avatars work across terminals without making graphics a runtime requirement.
