# UI review: current tuig interface

Reviewed against `src/ui/runtime.ts`, `runtime-widgets.ts`, `runtime-presentation.ts`, `menu.ts`, `theme.ts`.

Mockups: `docs/mockups/ui-pass.html` (open in a browser).

## Status

Fixed in this pass: 1 (header), 2 (status split), 3 (focus, for the two panes that have a
selection), 6 (flexed diff
height), 10 (decoration count and tags), 11 (theme constants), 12 (empty and loading
states).

Bugs found while testing the above, and fixed with it:

- `c` leaked a literal `c` into the commit composer, so `c` then Enter committed the
  message "c". The composer is now focused after the keypress has been dispatched.
- `Enter` never opened a commit. OpenTUI reports the key as `return`, and only `enter`
  was handled, so the binding the README documented had never worked.
- Reading `content` back off a renderable returns a `StyledText`, so the bottom row
  measured its own message as `[object Object]` and mispositioned it. The message text is
  now tracked alongside the widget.
- The right pane held a `DiffRenderable` that was only ever shown and hidden, never given
  any content. It was laid out on every resize and removed here.

Deferred, with reasons in each section: 4 (sidebar tree and filter), 5 (single diff
surface), 7 (command palette and context menus), 8 (hunk selection), 9 (confirm strip).
Items 5, 7, and 8 are features rather than fixes and each needs its own change.

## What already works

Three resizable panes with click-to-toggle dividers, a one-line graph with lane colours,
a Material-icon file tree, inline diff rendering, and a commit composer. The information
density is good and the graph reads well.

## Problems worth fixing

### 1. No repository header

Repo name, current branch, ahead/behind, and dirty count are rendered as two plain lines
at the top of the sidebar text (`renderSidebar`, ` TUIG\n <branch>`). Collapse the left
pane with `[` and the only remaining indication of which branch you are on disappears.
Ahead/behind is never shown at all, so `f`/`l`/`p` are fired blind.

**Fix:** a one-line header bar spanning the full width: repo · branch · ↑/↓ · dirty count ·
last fetch, with clickable fetch/pull/push chips.

### 2. The status bar destroys its own help text

`createStatusSetter` overwrites the status line in place, so the first transient message
(`Copied 8ab2f1c`) permanently replaces the keybinding hints for the rest of the session.
There is also no progress indication for `fetch`/`pull`/`push`.

**Fix:** split the bottom row. Left = context-sensitive hints for the focused pane, right =
transient message zone with a spinner and auto-expiry, colour-coded for errors.

### 3. No focus model

Keys are handled globally in one `keypress` switch; panes are only mouse targets. Nothing
on screen says where input goes, `Tab` means staged/unstaged rather than "next pane", and
the same key can mean different things depending on invisible state (`view`, `mode`,
`commitDiff.visible`).

**Fix:** an explicit focused pane, shown by an accent heading and accent divider, with the
hints following focus. Implemented for the history and changes panes, which are the two
panes with a selection; `Tab` cycles between them. The repository pane stays mouse-driven
until it has a row model (item 4), and `Shift-Tab` and numbered pane jumps are still open.

### 4. The sidebar is one text blob with magic-number hit testing

`renderSidebar` builds a single `StyledText`, caps each branch list at 10 rows, and clicks
are resolved by arithmetic on absolute Y (`sidebarToggleTarget`, now derived from
`SIDEBAR_LOCAL_HEADER_ROW` rather than a literal, but still arithmetic over rendered text).
Stashes are truncated to 6, submodules and worktrees cannot scroll or collapse, and there
is no way to find a branch in a repo with 200 of them.

**Fix:** one scrollable tree with collapsible sections for every group, real per-row hit
regions, a `/` filter that fuzzy-matches across sections, and counts on each header.

### 5. Diff appears in two different places

Working diffs render in the right pane (`diff`, fixed `height: "57%"`), commit diffs replace
the history pane (`commitDiff`, and `historyText.visible = false`). Selecting a file in a
commit therefore hides the graph, and `moveCommit`/`scrollHistoryViewport` silently no-op
while `commitDiff.visible`. Two mental models for one task.

**Fix:** one diff surface, always in the same place, with the graph never hidden. Tabs above
it (Diff / Message / Files) and a unified/split toggle.

### 6. Fixed pane geometry starves the diff

Right-pane heights are hard-coded: info box 4, message box up to 18, file list clamped to
7 rows in history view (`fileViewportSize`), diff 57%. On a tall terminal the diff still
gets 57%; on a short one everything fights. `commitFilesTop` then has to be recomputed by
hand across three methods.

**Fix:** flex rows — header auto, file tree flexes to content up to half, diff takes the
rest — plus a draggable horizontal splitter inside the right pane.

### 7. Actions are undiscoverable and incomplete

`contextMenu()` exists with five actions and is never rendered anywhere. Branch checkout,
create, delete, stash apply/drop, and worktree switching have no UI. Hunk staging is bound
to `h` ("first hunk") with nothing on screen to suggest it exists.

**Fix:** a command palette on `Ctrl-P`/`:` listing every action with its key and current
target, plus working right-click menus on commit, branch, file, stash, and hunk rows.

### 8. Hunk staging has no affordance

`h` stages the first hunk of the selected file — not the hunk under the cursor, and there is
no cursor. Nothing marks hunk boundaries in the diff.

**Fix:** hunk headers as selectable rows with `[stage]` / `[discard]` chips, `[`/`]` to move
between hunks, and line-level selection.

### 9. Destructive actions have no confirmation

`MenuItem.destructive` exists but nothing consumes it. Branch delete, discard, and force
push need a confirm step and, where Git allows, an undo hint (`git reset`, reflog SHA).

**Fix:** an inline confirm strip in the status row — no modal, `y`/`Enter` to confirm,
`Esc` to cancel — and a post-action "undo: `git reset --hard <sha>`" hint.

### 10. Graph hides information

Only the first decoration is drawn (`labels[0] ?? ""`) and tags are filtered out entirely.
A commit that is `main`, `origin/main`, and `v1.2.0` shows one label.

**Fix:** show the primary ref plus a `+2` chip that expands on click, and a distinct tag glyph.

### 11. Theme and glyph assumptions are hard-coded

`oneDarkTheme` is the only theme, `dividerColor`/`activeDividerColor` and the author colour
`#C678DD` are inlined outside it, and Nerd Font glyphs have no ASCII fallback despite the
README listing a patched font as a requirement.

**Fix:** move stray colours into `Theme`, add a light theme and `--theme` flag, and an
ASCII glyph set selected by capability probe or `--ascii`.

### 12. Empty and loading states are bare

`"Loading repository…"`, `"Loading history…"`, `"Working tree clean"`. First run in a clean
repo shows almost nothing and teaches nothing.

**Fix:** skeleton rows while loading and empty states that carry the next action
("Working tree clean — `f` fetch, `Ctrl-P` for all commands").

## Remaining order

1. Sidebar tree with filter (4), which also removes the last Y-arithmetic hit testing.
2. Single diff surface (5), the largest remaining structural change.
3. Command palette and context menus (7), then hunk selection and confirms (8, 9).
4. Repository pane focus and keyboard navigation, once the sidebar has a row model.
