use std::collections::HashSet;

use tuig_git::types::{ChangedFile, FileState};
use tuig_ui_model::file_tree::{
    FileRowAction, FileSection, FileTreeNode, build_file_tree, compare_names, descendant_files,
    expand_new_directories, file_row_action_hits, flatten_visible, selected_file_row,
    toggle_expansion,
};

fn changed(path: &str, state: FileState) -> ChangedFile {
    ChangedFile {
        path: path.to_string(),
        original_path: None,
        state,
        staged: false,
        unstaged: true,
        submodule: None,
    }
}

fn modified(path: &str) -> ChangedFile {
    changed(path, FileState::Modified)
}

fn set(items: &[&str]) -> HashSet<String> {
    items.iter().map(|s| (*s).to_string()).collect()
}

#[test]
fn expands_new_folders_once_and_preserves_user_collapses() {
    let tree = build_file_tree(&[modified("src/deep/a.ts"), modified("test/unit/a.test.ts")]);
    let mut expanded = HashSet::new();
    let mut seen = HashSet::new();
    expand_new_directories(&tree, &mut expanded, &mut seen);
    assert_eq!(expanded, set(&["src", "src/deep", "test", "test/unit"]));

    expanded.remove("src");
    expand_new_directories(&tree, &mut expanded, &mut seen);
    assert!(!expanded.contains("src"));
}

#[test]
fn folder_actions_include_collapsed_descendants() {
    let tree = build_file_tree(&[modified("src/a.ts"), modified("src/deep/b.ts")]);
    let paths: Vec<&str> = descendant_files(&tree.children[0])
        .iter()
        .map(|f| f.file.path.as_str())
        .collect();
    // Directories sort before files, so the nested file comes first.
    assert_eq!(paths, ["src/deep/b.ts", "src/a.ts"]);
}

#[test]
fn row_actions_are_right_aligned_and_vanish_when_they_would_hide_the_name() {
    let hits = file_row_action_hits(FileSection::Unstaged, 30, 6);
    let spans: Vec<_> = hits.iter().map(|h| (h.action, h.start, h.end)).collect();
    assert_eq!(
        spans,
        [
            (FileRowAction::Stage, 14, 21),
            (FileRowAction::Discard, 21, 30)
        ]
    );
    assert!(file_row_action_hits(FileSection::Unstaged, 20, 6).is_empty());
    assert!(file_row_action_hits(FileSection::Unstaged, 26, 10).is_empty());
    let starts: Vec<_> = file_row_action_hits(FileSection::Unstaged, 27, 10)
        .iter()
        .map(|h| h.start)
        .collect();
    assert_eq!(starts, [11, 18]);
    assert_eq!(
        file_row_action_hits(FileSection::Staged, 30, 6)[0].action,
        FileRowAction::Unstage
    );
}

#[test]
fn builds_shared_directories_and_sorts_directories_before_files() {
    let tree = build_file_tree(&[
        modified("src/z.ts"),
        modified("README.md"),
        changed("src/a.ts", FileState::Added),
    ]);
    let names: Vec<&str> = tree.children.iter().map(FileTreeNode::name).collect();
    assert_eq!(names, ["src", "README.md"]);
    let FileTreeNode::Directory(src) = &tree.children[0] else {
        panic!("src is a directory")
    };
    let inner: Vec<&str> = src.children.iter().map(FileTreeNode::name).collect();
    assert_eq!(inner, ["a.ts", "z.ts"]);
}

#[test]
fn name_order_matches_locale_compare_for_ascii_names() {
    // Orders taken from `localeCompare` in Bun.
    let mut names = [
        "z", "Z", "x", "a.ts", "a1", "a10", "a2", "ab", "Ab", "A", "a", "a b", "a_b", "a-b", "_x",
        "-x", ".x", "B", "b",
    ];
    names.sort_by(|a, b| compare_names(a, b));
    assert_eq!(
        names,
        [
            "_x", "-x", ".x", "a", "A", "a b", "a_b", "a-b", "a.ts", "a1", "a10", "a2", "ab", "Ab",
            "b", "B", "x", "z", "Z"
        ]
    );
}

#[test]
fn expands_and_collapses_by_repository_relative_path() {
    let tree = build_file_tree(&[modified("src/lib/file with spaces.ts")]);
    let paths = |expanded: &HashSet<String>| -> Vec<String> {
        flatten_visible(&tree, expanded)
            .iter()
            .map(|row| row.node.path().to_string())
            .collect()
    };
    let mut expanded = toggle_expansion(&HashSet::new(), "src");
    assert_eq!(paths(&expanded), ["src", "src/lib"]);
    expanded = toggle_expansion(&expanded, "src/lib");
    assert_eq!(
        paths(&expanded),
        ["src", "src/lib", "src/lib/file with spaces.ts"]
    );
    let rows = flatten_visible(&tree, &expanded);
    assert_eq!(rows.iter().map(|r| r.depth).collect::<Vec<_>>(), [0, 1, 2]);
    assert_eq!(
        selected_file_row(&rows, "src/lib/file with spaces.ts"),
        Some(2)
    );
    assert_eq!(selected_file_row(&rows, "src"), None);
}

#[test]
fn shows_a_nested_repository_as_one_named_row() {
    let tree = build_file_tree(&[changed(".claude/worktrees/feature/", FileState::Untracked)]);
    let rows = flatten_visible(&tree, &set(&[".claude", ".claude/worktrees"]));
    let shown: Vec<_> = rows
        .iter()
        .map(|r| (r.node.is_directory(), r.node.name(), r.node.path()))
        .collect();
    assert_eq!(
        shown,
        [
            (true, ".claude", ".claude"),
            (true, "worktrees", ".claude/worktrees"),
            (false, "feature/", ".claude/worktrees/feature/"),
        ]
    );
}

#[test]
fn directories_take_the_most_important_status_below_them() {
    let tree = build_file_tree(&[
        changed("src/a.ts", FileState::Modified),
        changed("src/deep/b.ts", FileState::Conflicted),
        changed("docs/c.md", FileState::Added),
        changed("docs/d.md", FileState::Untracked),
    ]);
    let status = |name: &str| {
        tree.children.iter().find_map(|node| match node {
            FileTreeNode::Directory(dir) if dir.name == name => Some(dir.status),
            _ => None,
        })
    };
    assert_eq!(status("src"), Some(Some(FileState::Conflicted)));
    assert_eq!(status("docs"), Some(Some(FileState::Added)));
    assert_eq!(tree.status, Some(FileState::Conflicted));
}
