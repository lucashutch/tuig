//! Changed-file tree. Ports `src/ui/file-tree.ts`.
//!
//! Differences from TypeScript:
//! - Name order uses the ICU4X root collator, which matches `localeCompare`.
//!   See [`compare_names`].
//! - Not ported: `cachedFileTree` and `cachedFlattenVisible`, which cache by
//!   JavaScript object identity, and `fitTreeLabel`, which needs terminal
//!   display width.

use icu_collator::options::CollatorOptions;
use icu_collator::{Collator, CollatorBorrowed, CollatorPreferences};
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use tuig_git::types::{ChangedFile, FileState};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileTreeFile {
    pub file: ChangedFile,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct FileTreeDirectory {
    pub name: String,
    /// Repository-relative path. The empty string is the synthetic root.
    pub path: String,
    pub children: Vec<FileTreeNode>,
    pub status: Option<FileState>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FileTreeNode {
    File(FileTreeFile),
    Directory(FileTreeDirectory),
}

impl FileTreeNode {
    pub fn name(&self) -> &str {
        match self {
            Self::File(file) => &file.name,
            Self::Directory(dir) => &dir.name,
        }
    }

    pub fn path(&self) -> &str {
        match self {
            Self::File(file) => &file.file.path,
            Self::Directory(dir) => &dir.path,
        }
    }

    pub fn is_directory(&self) -> bool {
        matches!(self, Self::Directory(_))
    }
}

#[derive(Debug, Clone, Copy)]
pub struct VisibleFileTreeNode<'a> {
    pub node: &'a FileTreeNode,
    pub depth: usize,
}

/// Every changed file below a row, independent of expansion state.
pub fn descendant_files(node: &FileTreeNode) -> Vec<&FileTreeFile> {
    match node {
        FileTreeNode::File(file) => vec![file],
        FileTreeNode::Directory(dir) => dir.children.iter().flat_map(descendant_files).collect(),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileRowAction {
    Stage,
    Discard,
    Unstage,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileSection {
    Staged,
    Unstaged,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileRowActionHit {
    pub action: FileRowAction,
    pub label: &'static str,
    pub start: usize,
    pub end: usize,
}

/// Default width of the tree prefix kept visible beside the row actions.
pub const DEFAULT_PREFIX_WIDTH: usize = 6;

/// Right-aligned action geometry shared by painting and mouse hit testing.
pub fn file_row_action_hits(
    section: FileSection,
    width: usize,
    prefix_width: usize,
) -> Vec<FileRowActionHit> {
    let actions: &[(FileRowAction, &'static str)] = match section {
        FileSection::Staged => &[(FileRowAction::Unstage, " Unstage ")],
        FileSection::Unstaged => &[
            (FileRowAction::Stage, " Stage "),
            (FileRowAction::Discard, " Discard "),
        ],
    };
    let total: usize = actions.iter().map(|(_, label)| label.len()).sum();
    // Keep the full tree prefix and one column of the row name visible. The
    // same condition controls painting and hit testing.
    if width < prefix_width + 1 + total {
        return Vec::new();
    }
    let mut start = width - total;
    actions
        .iter()
        .map(|(action, label)| {
            let hit = FileRowActionHit {
                action: *action,
                label,
                start,
                end: start + label.len(),
            };
            start = hit.end;
            hit
        })
        .collect()
}

// A directory containing a conflict stays visibly important even when it also
// contains ordinary modifications.
fn state_rank(state: FileState) -> u8 {
    match state {
        FileState::Conflicted => 8,
        FileState::Deleted => 7,
        FileState::Renamed => 6,
        FileState::Copied => 5,
        FileState::Modified => 4,
        FileState::Added => 3,
        FileState::Untracked => 2,
    }
}

fn directory_status(children: &[FileTreeNode]) -> Option<FileState> {
    let mut result: Option<FileState> = None;
    for child in children {
        let state = match child {
            FileTreeNode::File(file) => Some(file.file.state),
            FileTreeNode::Directory(dir) => dir.status,
        };
        if let Some(state) = state
            && result.is_none_or(|best| state_rank(state) > state_rank(best))
        {
            result = Some(state);
        }
    }
    result
}

/// Orders names like `String.prototype.localeCompare` with no arguments: the
/// ICU root collation (the default `en-US` locale has no tailoring) at tertiary
/// strength. Punctuation, digits and letters sort in that order, accents and
/// case only break ties, and digits compare one by one, not as numbers.
pub fn compare_names(a: &str, b: &str) -> Ordering {
    static COLLATOR: LazyLock<CollatorBorrowed<'static>> = LazyLock::new(|| {
        Collator::try_new(CollatorPreferences::default(), CollatorOptions::default())
            .expect("the compiled root collation data is always available")
    });
    COLLATOR.compare(a, b)
}

fn sort_nodes(nodes: &mut [FileTreeNode]) {
    nodes.sort_by(|a, b| match (a.is_directory(), b.is_directory()) {
        (true, false) => Ordering::Less,
        (false, true) => Ordering::Greater,
        _ => compare_names(a.name(), b.name()),
    });
    for node in nodes {
        if let FileTreeNode::Directory(dir) = node {
            sort_nodes(&mut dir.children);
            dir.status = directory_status(&dir.children);
        }
    }
}

enum Pending {
    File(FileTreeFile),
    Directory(usize),
}

struct PendingDirectory {
    name: String,
    path: String,
    children: Vec<Pending>,
}

fn materialize(directories: &mut [Option<PendingDirectory>], at: usize) -> FileTreeDirectory {
    let pending = directories[at]
        .take()
        .expect("each directory is built once");
    let children = pending
        .children
        .into_iter()
        .map(|child| match child {
            Pending::File(file) => FileTreeNode::File(file),
            Pending::Directory(index) => FileTreeNode::Directory(materialize(directories, index)),
        })
        .collect();
    FileTreeDirectory {
        name: pending.name,
        path: pending.path,
        children,
        status: None,
    }
}

/// Build a synthetic directory tree. Paths are never shortened or discarded.
pub fn build_file_tree(files: &[ChangedFile]) -> FileTreeDirectory {
    let mut directories = vec![Some(PendingDirectory {
        name: String::new(),
        path: String::new(),
        children: Vec::new(),
    })];
    let mut by_path: HashMap<String, usize> = HashMap::from([(String::new(), 0)]);
    for file in files {
        // Git reports a nested repository as one untracked "dir/" entry, even
        // with --untracked-files=all. Keep it as one row named "dir/".
        let nested = file.path.ends_with('/');
        let trimmed = if nested {
            &file.path[..file.path.len() - 1]
        } else {
            file.path.as_str()
        };
        let mut parts: Vec<&str> = trimmed.split('/').collect();
        let leaf = format!(
            "{}{}",
            parts.pop().unwrap_or(""),
            if nested { "/" } else { "" }
        );
        let mut parent = 0;
        let mut path = String::new();
        for part in parts {
            if !path.is_empty() {
                path.push('/');
            }
            path.push_str(part);
            parent = match by_path.get(&path) {
                Some(&existing) => existing,
                None => {
                    let created = directories.len();
                    directories.push(Some(PendingDirectory {
                        name: part.to_string(),
                        path: path.clone(),
                        children: Vec::new(),
                    }));
                    by_path.insert(path.clone(), created);
                    directories[parent]
                        .as_mut()
                        .expect("directories stay in place until materialized")
                        .children
                        .push(Pending::Directory(created));
                    created
                }
            };
        }
        // A changed file's path is its identity. Duplicate inputs stay.
        directories[parent]
            .as_mut()
            .expect("directories stay in place until materialized")
            .children
            .push(Pending::File(FileTreeFile {
                file: file.clone(),
                name: leaf,
            }));
    }
    let mut root = materialize(&mut directories, 0);
    sort_nodes(&mut root.children);
    root.status = directory_status(&root.children);
    root
}

/// Rows in display order. The synthetic root is not a row.
pub fn flatten_visible<'a>(
    tree: &'a FileTreeDirectory,
    expanded: &HashSet<String>,
) -> Vec<VisibleFileTreeNode<'a>> {
    flatten_nodes(&tree.children, expanded)
}

pub fn flatten_nodes<'a>(
    nodes: &'a [FileTreeNode],
    expanded: &HashSet<String>,
) -> Vec<VisibleFileTreeNode<'a>> {
    fn visit<'a>(
        nodes: &'a [FileTreeNode],
        depth: usize,
        expanded: &HashSet<String>,
        rows: &mut Vec<VisibleFileTreeNode<'a>>,
    ) {
        for node in nodes {
            rows.push(VisibleFileTreeNode { node, depth });
            if let FileTreeNode::Directory(dir) = node
                && expanded.contains(&dir.path)
            {
                visit(&dir.children, depth + 1, expanded, rows);
            }
        }
    }
    let mut rows = Vec::new();
    visit(nodes, 0, expanded, &mut rows);
    rows
}

pub fn toggle_expansion(expanded: &HashSet<String>, path: &str) -> HashSet<String> {
    let mut next = expanded.clone();
    if !next.remove(path) {
        next.insert(path.to_string());
    }
    next
}

/// Expand newly discovered directories once, and keep the user's collapses.
pub fn expand_new_directories(
    tree: &FileTreeDirectory,
    expanded: &mut HashSet<String>,
    seen: &mut HashSet<String>,
) {
    fn visit(nodes: &[FileTreeNode], expanded: &mut HashSet<String>, seen: &mut HashSet<String>) {
        for node in nodes {
            let FileTreeNode::Directory(dir) = node else {
                continue;
            };
            if seen.insert(dir.path.clone()) {
                expanded.insert(dir.path.clone());
            }
            visit(&dir.children, expanded, seen);
        }
    }
    visit(&tree.children, expanded, seen);
}

/// The visible row for a repository-relative file path.
pub fn selected_file_row(rows: &[VisibleFileTreeNode<'_>], path: &str) -> Option<usize> {
    rows.iter()
        .position(|row| matches!(row.node, FileTreeNode::File(file) if file.file.path == path))
}
