# Roadmap

Tuig already has a compact colored commit graph with merge edges and branch labels, commit metadata and diffs, a changed-file tree, staging and commits, and fetch/pull/push shortcuts. The work below tracks the remaining path beyond that early MVP.

## Finish the core workflow

- Render real right-click menus for commits, branches, files, stashes, and worktrees.
- Add branch checkout/create/delete dialogs and risky-action confirmations.
- Wire stash create/apply/pop/drop and worktree add/lock/remove actions.
- Add a hunk selector with next/previous navigation and selected-line patch construction.
- Serialize mutations, support cancellation, and show credential prompts without freezing the UI.
- Add conflict views, rename/binary-file handling, and larger integration coverage.

## Graph and repository navigation

- Show tags alongside branch labels and add optional author avatars.
- Add repository tabs, recent repositories, filesystem discovery, and per-tab command state.
- Add commit operations such as cherry-pick, revert, reset, rebase, and tag management with safety dialogs.

## Presentation

- Move all dimensions and colors into theme definitions and load user themes.
- Add compact and wide responsive layouts, diff virtualization, split diffs, and file-tree grouping.
- Detect Kitty graphics and add optional author avatars without making graphics a runtime requirement.
