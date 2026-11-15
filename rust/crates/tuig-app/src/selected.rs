//! The file the user has selected in the changed-files pane. The diff pane reads it from `Shell::files.selected` and
//! learns about changes through `Msg::FileSelected`.

/// Where a selected file's content comes from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FileSource {
    /// The working tree changes of the unstaged section: index against work tree.
    WorkingUnstaged,
    /// The staged section: HEAD against index.
    WorkingStaged,
    /// A file of the commit with this SHA, against its first parent.
    Commit(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SelectedFile {
    /// Repository-relative path, as `ChangedFile::path`.
    pub path: String,
    pub source: FileSource,
}
