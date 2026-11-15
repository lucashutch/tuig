//! The file whose diff the diff pane shows. The files pane sets it (`files.selected`) and posts
//! `Msg::FileSelected`. Kept in its own module so the files pane and the diff pane can depend on it without
//! depending on each other.

/// Where the file's changes come from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FileSource {
    /// Unstaged changes in the working tree.
    WorkingUnstaged,
    /// Staged changes in the index.
    WorkingStaged,
    /// The changes a commit made, by SHA.
    Commit(String),
}

impl FileSource {
    /// Working-tree changes, which line staging can stage, unstage or discard.
    pub fn is_working(&self) -> bool {
        !matches!(self, Self::Commit(_))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SelectedFile {
    pub path: String,
    /// The previous path of a rename or copy.
    pub original_path: Option<String>,
    pub source: FileSource,
}
