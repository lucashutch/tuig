//! Context menus: the items for a right-clicked graph row, file, tag, stash, worktree or submodule, and the
//! geometry of a menu on screen. Ports `src/ui/graph-menu.ts` and `src/ui/branch-deletion.ts`.

use crate::text_width::string_width;
use tuig_git::types::{BranchRef, ChangedFile, RepositorySnapshot, Stash, Submodule, Worktree};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GraphMenuAction {
    SelectComparisonStart,
    CompareWithSelected,
    ClearComparisonStart,
    CheckoutBranch,
    CheckoutCommit,
    ResetSoft,
    ResetMixed,
    ResetHard,
    RebaseOnto,
    CreateBranch,
    CreateTag,
    PushTag,
    DeleteTag,
    CherryPick,
    DeleteBranch,
    DeleteBranchLocal,
    DeleteBranchRemote,
    DeleteBranchBoth,
    ApplyStash,
    PopStash,
    DropStash,
    RenameStash,
    CopySha,
    CopyBranch,
    StageFile,
    UnstageFile,
    DiscardFile,
    StageHunk,
    UnstageHunk,
    RevertHunk,
    FileHistory,
    LineHistory,
    BlameLine,
    CopyPath,
    RemoveWorktree,
    LockWorktree,
    UnlockWorktree,
    OpenWorktree,
    OpenSubmodule,
    UpdateSubmodule,
    InitSubmodule,
    SyncSubmodule,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct GraphMenuItem {
    pub label: String,
    pub action: Option<GraphMenuAction>,
    pub submenu: Option<Vec<GraphMenuItem>>,
    pub destructive: bool,
    pub disabled: bool,
    pub separator: bool,
}

impl GraphMenuItem {
    /// A plain item with no action. The popup caller decides what a choice means, by label or index.
    pub fn new(label: impl Into<String>) -> Self {
        Self {
            label: label.into(),
            ..Self::default()
        }
    }

    pub fn action(label: impl Into<String>, action: GraphMenuAction) -> Self {
        Self {
            action: Some(action),
            ..Self::new(label)
        }
    }

    pub fn separator() -> Self {
        Self {
            separator: true,
            ..Self::default()
        }
    }

    /// A line of text that cannot be chosen.
    pub fn info(label: impl Into<String>) -> Self {
        Self {
            disabled: true,
            ..Self::new(label)
        }
    }

    pub fn destructive(mut self) -> Self {
        self.destructive = true;
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    pub fn with_submenu(mut self, submenu: Vec<GraphMenuItem>) -> Self {
        self.submenu = Some(submenu);
        self
    }
}

/// What a graph row click landed on: always a commit, sometimes a branch.
#[derive(Debug, Clone, Default)]
pub struct GraphMenuTarget {
    pub sha: String,
    pub branch: Option<BranchRef>,
    pub stash: Option<Stash>,
    pub tag: Option<String>,
    pub submodule: Option<Submodule>,
    pub worktree: Option<Worktree>,
    pub file: Option<ChangedFile>,
    /// Which changes list the file came from. Drives stage and unstage.
    pub file_staged: bool,
    /// One-based line in the file at `sha`, when a diff line was hit.
    pub line: Option<usize>,
    /// Patch of the working-tree diff hunk that was hit. Adds hunk actions.
    pub hunk_patch: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BuiltMenu {
    pub title: String,
    pub items: Vec<GraphMenuItem>,
}

/// A request for a confirmation popup. `confirmThen` shows it.
#[derive(Debug, Clone)]
pub struct ConfirmRequest {
    pub title: String,
    pub lines: Vec<String>,
    pub confirm_label: String,
    pub destructive: bool,
}

/// A menu pane placed in terminal coordinates.
#[derive(Debug, Clone, Default)]
pub struct MenuPane {
    pub items: Vec<GraphMenuItem>,
    pub left: i64,
    pub top: i64,
    pub width: i64,
    pub hover: Option<usize>,
    /// For a submenu, the row of the main pane that opened it.
    pub parent: Option<usize>,
}

const SUBMENU_MARKER: &str = " ▸";

fn short_sha(sha: &str) -> String {
    sha.chars().take(8).collect()
}

fn display_branch_name(name: &str) -> &str {
    let name = name.strip_prefix("refs/heads/").unwrap_or(name);
    let name = name.strip_prefix("refs/remotes/").unwrap_or(name);
    name.strip_prefix("origin/").unwrap_or(name)
}

fn directory_name(path: &str) -> &str {
    let trimmed = path.trim_end_matches('/');
    trimmed.rsplit('/').next().unwrap_or(trimmed)
}

/// The local and remote copies of a branch, when each is one clear counterpart. Never guesses between several
/// remotes.
pub struct BranchCopies<'a> {
    pub local: Option<&'a BranchRef>,
    pub remote: Option<&'a BranchRef>,
}

pub fn branch_deletion_copies<'a>(
    branch: &'a BranchRef,
    refs: &'a [BranchRef],
) -> BranchCopies<'a> {
    let remote_for = |local: &BranchRef| -> Option<&'a BranchRef> {
        let remotes = || refs.iter().filter(|candidate| candidate.remote);
        if let Some(upstream) = &local.upstream {
            return remotes()
                .find(|candidate| &candidate.name == upstream || &candidate.full_name == upstream);
        }
        let mut matches = remotes().filter(|candidate| {
            let name = &candidate.name;
            name.find('/')
                .map_or(name.as_str(), |slash| &name[slash + 1..])
                == local.name
        });
        match (matches.next(), matches.next()) {
            (Some(only), None) => Some(only),
            _ => None,
        }
    };
    if !branch.remote {
        return BranchCopies {
            local: Some(branch),
            remote: remote_for(branch),
        };
    }
    let mut matches = refs.iter().filter(|candidate| {
        !candidate.remote
            && remote_for(candidate).is_some_and(|remote| remote.full_name == branch.full_name)
    });
    let local = match (matches.next(), matches.next()) {
        (Some(only), None) => Some(only),
        _ => None,
    };
    BranchCopies {
        local,
        remote: Some(branch),
    }
}

/// Builds the menu for a right-clicked graph row.
///
/// Branch entries come first when a branch label was hit, because that is what the click was aimed at. The commit
/// entries below apply either way.
pub fn build_graph_menu(
    target: &GraphMenuTarget,
    snapshot: &RepositorySnapshot,
    comparison_start: Option<&str>,
) -> BuiltMenu {
    use GraphMenuAction as A;
    let current = snapshot.branch.as_deref().unwrap_or("HEAD");
    if let Some(worktree) = &target.worktree {
        return worktree_menu(worktree, &snapshot.root);
    }
    if let Some(submodule) = &target.submodule {
        return submodule_menu(submodule);
    }
    if let Some(file) = &target.file {
        return file_menu(
            file,
            target.file_staged,
            target.line,
            !target.sha.is_empty(),
            target.hunk_patch.is_some(),
        );
    }
    if let Some(tag) = &target.tag {
        return BuiltMenu {
            title: format!("tag · {tag}"),
            items: vec![
                GraphMenuItem::action(format!("Push {tag}"), A::PushTag),
                GraphMenuItem::action(format!("Delete {tag}"), A::DeleteTag).destructive(),
            ],
        };
    }
    if let Some(stash) = &target.stash {
        let reference = &stash.reference;
        return BuiltMenu {
            title: format!("stash · {}", short_sha(&target.sha)),
            items: vec![
                GraphMenuItem::action(format!("Rename {reference}"), A::RenameStash),
                GraphMenuItem::action(format!("Apply {reference}"), A::ApplyStash),
                GraphMenuItem::action(format!("Pop {reference}"), A::PopStash).destructive(),
                GraphMenuItem::action(format!("Drop {reference}"), A::DropStash).destructive(),
            ],
        };
    }
    let mut items = Vec::new();
    if let Some(branch) = &target.branch {
        let name = display_branch_name(&branch.name);
        let copies = branch_deletion_copies(branch, &snapshot.branches);
        items.push(
            GraphMenuItem::action(
                if branch.current {
                    format!("Already on {name}")
                } else {
                    format!("Checkout {name}")
                },
                A::CheckoutBranch,
            )
            .disabled(branch.current),
        );
        items.push(
            GraphMenuItem::action(format!("Rebase {current} onto {name}"), A::RebaseOnto)
                .disabled(branch.current),
        );
        items.push(reset_submenu(current, name));
        items.push(GraphMenuItem::action("Copy branch name", A::CopyBranch));
        items.push(GraphMenuItem::action("Create branch here", A::CreateBranch));
        let mut delete = GraphMenuItem::new(format!("Delete {name}")).destructive();
        if let (Some(local), Some(remote)) = (copies.local, copies.remote) {
            delete = delete.with_submenu(vec![
                GraphMenuItem::action("Delete local only", A::DeleteBranchLocal)
                    .destructive()
                    .disabled(local.current),
                GraphMenuItem::action(
                    format!("Delete remote only ({})", remote.name),
                    A::DeleteBranchRemote,
                )
                .destructive(),
                GraphMenuItem::action("Delete both", A::DeleteBranchBoth)
                    .destructive()
                    .disabled(local.current),
            ]);
        } else {
            delete.action = Some(A::DeleteBranch);
            delete.disabled = branch.current;
        }
        items.push(delete);
        items.push(GraphMenuItem::separator());
    }
    match comparison_start {
        Some(start) if target.sha == start => items.push(GraphMenuItem::action(
            "Clear comparison start",
            A::ClearComparisonStart,
        )),
        Some(start) => {
            items.push(GraphMenuItem::action(
                format!("Compare {} → {}", short_sha(start), short_sha(&target.sha)),
                A::CompareWithSelected,
            ));
            items.push(GraphMenuItem::action(
                "Replace comparison start",
                A::SelectComparisonStart,
            ));
            items.push(GraphMenuItem::action(
                "Clear comparison start",
                A::ClearComparisonStart,
            ));
        }
        None => items.push(GraphMenuItem::action(
            "Select for comparison",
            A::SelectComparisonStart,
        )),
    }
    items.extend([
        GraphMenuItem::separator(),
        GraphMenuItem::action("Checkout this commit (detached)", A::CheckoutCommit),
        GraphMenuItem::action(format!("Rebase {current} onto this commit"), A::RebaseOnto),
        reset_submenu(current, "this commit"),
        GraphMenuItem::action("Create branch here", A::CreateBranch),
        GraphMenuItem::action("Cherry-pick this commit", A::CherryPick),
        GraphMenuItem::action("Create tag here", A::CreateTag),
        GraphMenuItem::action("Copy commit SHA", A::CopySha),
    ]);
    BuiltMenu {
        title: match &target.branch {
            Some(branch) => format!(
                "{} · {}",
                display_branch_name(&branch.name),
                short_sha(&target.sha)
            ),
            None => short_sha(&target.sha),
        },
        items,
    }
}

fn submodule_menu(submodule: &Submodule) -> BuiltMenu {
    use GraphMenuAction as A;
    let name = submodule.name.as_deref().unwrap_or(&submodule.path);
    BuiltMenu {
        title: name.to_owned(),
        items: vec![
            GraphMenuItem::action(format!("Open {name} repository"), A::OpenSubmodule),
            GraphMenuItem::action(format!("Update {name}"), A::UpdateSubmodule),
            GraphMenuItem::action(format!("Update and initialize {name}"), A::InitSubmodule),
            GraphMenuItem::action(format!("Sync URL for {name}"), A::SyncSubmodule),
            GraphMenuItem::action("Copy path", A::CopyPath),
        ],
    }
}

/// Menu for a right-clicked worktree row. The main checkout cannot be removed.
fn worktree_menu(worktree: &Worktree, root: &str) -> BuiltMenu {
    use GraphMenuAction as A;
    let name = directory_name(&worktree.path);
    let main = worktree.path.trim_end_matches('/') == root.trim_end_matches('/');
    let mut items = Vec::new();
    if !main {
        items.push(GraphMenuItem::action(
            format!("Open {name}"),
            A::OpenWorktree,
        ));
        items.push(if worktree.locked.is_none() {
            GraphMenuItem::action(format!("Lock {name}"), A::LockWorktree)
        } else {
            GraphMenuItem::action(format!("Unlock {name}"), A::UnlockWorktree)
        });
        items
            .push(GraphMenuItem::action(format!("Remove {name}"), A::RemoveWorktree).destructive());
    }
    items.push(GraphMenuItem::action("Copy path", A::CopyPath));
    BuiltMenu {
        title: name.to_owned(),
        items,
    }
}

/// Menu for a right-clicked file row or diff line.
fn file_menu(
    file: &ChangedFile,
    staged: bool,
    line: Option<usize>,
    historical: bool,
    hunk: bool,
) -> BuiltMenu {
    use GraphMenuAction as A;
    let name = file.path.rsplit('/').next().unwrap_or(&file.path);
    let mut items = if historical {
        Vec::new()
    } else if staged {
        vec![GraphMenuItem::action(
            format!("Unstage {name}"),
            A::UnstageFile,
        )]
    } else {
        vec![
            GraphMenuItem::action(format!("Stage {name}"), A::StageFile),
            GraphMenuItem::action(format!("Discard changes in {name}"), A::DiscardFile)
                .destructive(),
        ]
    };
    if hunk {
        let mut head = hunk_menu_items(staged);
        head.push(GraphMenuItem::separator());
        items.splice(0..0, head);
    }
    if !items.is_empty() {
        items.push(GraphMenuItem::separator());
    }
    items.push(GraphMenuItem::action("Show file history", A::FileHistory));
    if let Some(line) = line {
        items.push(GraphMenuItem::action(
            format!("Blame line {line}"),
            A::BlameLine,
        ));
        items.push(GraphMenuItem::action(
            format!("Show history for line {line}"),
            A::LineHistory,
        ));
    }
    items.push(GraphMenuItem::action("Copy path", A::CopyPath));
    BuiltMenu {
        title: file.path.clone(),
        items,
    }
}

/// Actions for one diff hunk of a working-tree file.
pub fn hunk_menu_items(staged: bool) -> Vec<GraphMenuItem> {
    use GraphMenuAction as A;
    if staged {
        vec![GraphMenuItem::action("Unstage hunk", A::UnstageHunk)]
    } else {
        vec![
            GraphMenuItem::action("Stage hunk", A::StageHunk),
            GraphMenuItem::action("Revert hunk", A::RevertHunk).destructive(),
        ]
    }
}

fn reset_submenu(current: &str, destination: &str) -> GraphMenuItem {
    use GraphMenuAction as A;
    GraphMenuItem::new(format!("Reset {current} to {destination}")).with_submenu(vec![
        GraphMenuItem::action("Soft · keep index and working tree", A::ResetSoft),
        GraphMenuItem::action("Mixed · keep working tree", A::ResetMixed),
        GraphMenuItem::action("Hard · discard all local changes", A::ResetHard).destructive(),
    ])
}

/// The width of a menu with these items, including its border.
pub fn menu_width(items: &[GraphMenuItem]) -> i64 {
    let widest = items
        .iter()
        .map(|item| {
            string_width(&item.label)
                + if item.submenu.is_some() {
                    SUBMENU_MARKER.chars().count()
                } else {
                    0
                }
        })
        .max()
        .unwrap_or(0)
        .max(16);
    // One space of padding on each side, inside the two border columns.
    widest as i64 + 4
}

/// Fits a menu of `rows` rows inside the terminal, moving it back when it would run off the edge.
pub fn place_menu(
    x: i64,
    y: i64,
    width: i64,
    rows: usize,
    terminal_width: i64,
    terminal_height: i64,
) -> (i64, i64) {
    let height = rows as i64 + 2;
    let left = if x + width > terminal_width {
        (terminal_width - width).max(0)
    } else {
        x
    };
    let top = if y + height > terminal_height {
        (terminal_height - height).max(0)
    } else {
        y
    };
    (left, top)
}

/// Builds a placed pane for `items` opened at `(x, y)`.
pub fn place_pane(
    items: Vec<GraphMenuItem>,
    x: i64,
    y: i64,
    terminal_width: i64,
    terminal_height: i64,
) -> MenuPane {
    let width = menu_width(&items);
    let (left, top) = place_menu(x, y, width, items.len(), terminal_width, terminal_height);
    MenuPane {
        items,
        left,
        top,
        width,
        hover: None,
        parent: None,
    }
}

/// The row under a pointer, or `None` when it is outside the list or on a separator.
pub fn menu_row_at(pane: &MenuPane, x: i64, y: i64) -> Option<usize> {
    if x < pane.left || x >= pane.left + pane.width {
        return None;
    }
    let row = usize::try_from(y - pane.top - 1).ok()?;
    let item = pane.items.get(row)?;
    (!item.separator).then_some(row)
}

/// One menu row as text, `width` columns wide.
pub fn render_menu_line(item: &GraphMenuItem, width: i64) -> String {
    let width = width.max(0) as usize;
    if item.separator {
        return "─".repeat(width);
    }
    let marker = if item.submenu.is_some() {
        SUBMENU_MARKER
    } else {
        ""
    };
    let room = width.saturating_sub(2 + marker.chars().count()).max(1);
    let mut label: String = item.label.chars().take(room).collect();
    let used = label.chars().count();
    label.push_str(&" ".repeat(room - used));
    format!(" {label}{marker} ")
}

/// Cuts `value` to `width` columns, ending in an ellipsis when it was cut. `clipColumns`.
pub fn clip_columns(value: &str, width: i64) -> String {
    if width <= 0 {
        return String::new();
    }
    let width = width as usize;
    if string_width(value) <= width {
        return value.to_owned();
    }
    let target = width.saturating_sub(1);
    let mut result = String::new();
    for character in value.chars() {
        let mut next = result.clone();
        next.push(character);
        if string_width(&next) > target {
            break;
        }
        result = next;
    }
    result.push('…');
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn branch(name: &str, remote: bool, current: bool) -> BranchRef {
        BranchRef {
            name: name.to_owned(),
            full_name: if remote {
                format!("refs/remotes/{name}")
            } else {
                format!("refs/heads/{name}")
            },
            sha: "abc".to_owned(),
            current,
            remote,
            ..BranchRef::default()
        }
    }

    fn snapshot(branches: Vec<BranchRef>) -> RepositorySnapshot {
        RepositorySnapshot {
            root: "/repo".to_owned(),
            branch: Some("main".to_owned()),
            branches,
            ..RepositorySnapshot::default()
        }
    }

    fn actions(menu: &BuiltMenu) -> Vec<Option<GraphMenuAction>> {
        menu.items.iter().map(|item| item.action).collect()
    }

    #[test]
    fn a_branch_with_both_copies_offers_a_delete_submenu() {
        let local = branch("feature", false, false);
        let remote = branch("origin/feature", true, false);
        let snapshot = snapshot(vec![branch("main", false, true), local.clone(), remote]);
        let menu = build_graph_menu(
            &GraphMenuTarget {
                sha: "abc".into(),
                branch: Some(local),
                ..GraphMenuTarget::default()
            },
            &snapshot,
            None,
        );
        let delete = menu
            .items
            .iter()
            .find(|item| item.label == "Delete feature")
            .unwrap();
        let submenu = delete.submenu.as_ref().unwrap();
        assert_eq!(delete.action, None);
        assert_eq!(submenu[1].label, "Delete remote only (origin/feature)");
        assert_eq!(menu.title, "feature · abc");
    }

    #[test]
    fn the_checked_out_branch_cannot_be_deleted_or_rebased_onto_itself() {
        let current = branch("main", false, true);
        let snapshot = snapshot(vec![current.clone()]);
        let menu = build_graph_menu(
            &GraphMenuTarget {
                sha: "abc".into(),
                branch: Some(current),
                ..GraphMenuTarget::default()
            },
            &snapshot,
            None,
        );
        assert_eq!(menu.items[0].label, "Already on main");
        assert!(menu.items[0].disabled);
        assert!(menu.items[1].disabled);
        assert!(menu.items[5].disabled);
    }

    #[test]
    fn a_remote_branch_with_two_matching_locals_has_no_local_copy() {
        let remote = branch("origin/dev", true, false);
        let mut first = branch("dev", false, false);
        first.upstream = Some("origin/dev".into());
        let mut second = branch("dev2", false, false);
        second.upstream = Some("origin/dev".into());
        let refs = vec![first, second, remote.clone()];
        let copies = branch_deletion_copies(&remote, &refs);
        assert!(copies.local.is_none());
        assert!(copies.remote.is_some());
    }

    #[test]
    fn comparison_entries_follow_the_comparison_start() {
        let snapshot = snapshot(Vec::new());
        let target = |sha: &str| GraphMenuTarget {
            sha: sha.into(),
            ..GraphMenuTarget::default()
        };
        let labels = |start: Option<&str>, sha: &str| {
            build_graph_menu(&target(sha), &snapshot, start)
                .items
                .iter()
                .take(3)
                .map(|item| item.label.clone())
                .collect::<Vec<_>>()
        };
        assert_eq!(labels(None, "1111111122")[0], "Select for comparison");
        assert_eq!(
            labels(Some("1111111122"), "2222222233")[0],
            "Compare 11111111 → 22222222"
        );
        assert_eq!(
            labels(Some("1111111122"), "1111111122")[0],
            "Clear comparison start"
        );
    }

    #[test]
    fn a_committed_file_offers_no_working_tree_changes() {
        let file = ChangedFile {
            path: "src/app.ts".into(),
            original_path: None,
            state: tuig_git::types::FileState::Modified,
            staged: false,
            unstaged: true,
            submodule: None,
        };
        let snapshot = snapshot(Vec::new());
        let menu_for = |sha: &str, staged: bool, line, hunk: Option<&str>| {
            build_graph_menu(
                &GraphMenuTarget {
                    sha: sha.into(),
                    file: Some(file.clone()),
                    file_staged: staged,
                    line,
                    hunk_patch: hunk.map(str::to_owned),
                    ..GraphMenuTarget::default()
                },
                &snapshot,
                None,
            )
        };
        let committed = menu_for("abc", false, Some(3), None);
        assert_eq!(
            actions(&committed),
            vec![
                Some(GraphMenuAction::FileHistory),
                Some(GraphMenuAction::BlameLine),
                Some(GraphMenuAction::LineHistory),
                Some(GraphMenuAction::CopyPath)
            ]
        );
        let working = menu_for("", false, None, Some("@@"));
        assert_eq!(
            &actions(&working)[..2],
            &[
                Some(GraphMenuAction::StageHunk),
                Some(GraphMenuAction::RevertHunk)
            ]
        );
        assert_eq!(
            menu_for("", true, None, Some("@@")).items[0].action,
            Some(GraphMenuAction::UnstageHunk)
        );
        assert!(
            !actions(&menu_for("", false, None, None)).contains(&Some(GraphMenuAction::StageHunk))
        );
    }

    #[test]
    fn a_menu_moves_back_from_the_screen_edge() {
        assert_eq!(place_menu(150, 45, 30, 5, 160, 48), (130, 41));
        assert_eq!(place_menu(10, 10, 30, 5, 160, 48), (10, 10));
        assert_eq!(place_menu(5, 5, 200, 100, 160, 48), (0, 0));
    }

    #[test]
    fn a_pointer_on_a_separator_or_outside_hits_no_row() {
        let pane = place_pane(
            vec![
                GraphMenuItem::new("One"),
                GraphMenuItem::separator(),
                GraphMenuItem::new("Two"),
            ],
            10,
            5,
            160,
            48,
        );
        assert_eq!(menu_row_at(&pane, 12, 6), Some(0));
        assert_eq!(menu_row_at(&pane, 12, 7), None);
        assert_eq!(menu_row_at(&pane, 12, 8), Some(2));
        assert_eq!(menu_row_at(&pane, 12, 5), None);
        assert_eq!(menu_row_at(&pane, 9, 6), None);
        assert_eq!(menu_row_at(&pane, 10 + pane.width, 6), None);
    }

    #[test]
    fn menu_lines_pad_clip_and_mark_submenus() {
        let item = GraphMenuItem::new("Reset").with_submenu(Vec::new());
        assert_eq!(render_menu_line(&item, 14), " Reset      ▸ ");
        let long = GraphMenuItem::new("A very long label");
        assert_eq!(render_menu_line(&long, 10), " A very l ");
        assert_eq!(render_menu_line(&GraphMenuItem::separator(), 4), "────");
        assert_eq!(menu_width(&[GraphMenuItem::new("short")]), 20);
        assert_eq!(clip_columns("abcdef", 4), "abc…");
    }
}
