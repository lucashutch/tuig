//! Disposable directories and repositories for tests. Avoids a `tempfile` dependency.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use crate::process::run_git;

pub struct TempDir(PathBuf);
static COUNTER: AtomicUsize = AtomicUsize::new(0);

impl TempDir {
    pub fn new(prefix: &str) -> Self {
        Self::new_in(&std::env::temp_dir(), prefix)
    }

    /// A directory below `parent`, for tests that must not share the system temp directory with other processes.
    pub fn new_in(parent: &Path, prefix: &str) -> Self {
        let path = parent.join(format!(
            "{prefix}-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    pub fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// An empty repository on branch `main`.
pub async fn temp_repo() -> TempDir {
    let dir = TempDir::new("tuig-git-test");
    run_git(&["init", "-b", "main"], Some(dir.path()))
        .await
        .unwrap();
    dir
}

/// Commit all staged changes with a fixed identity.
pub async fn commit(dir: &Path, message: &str) {
    run_git(
        &[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "commit",
            "-m",
            message,
        ],
        Some(dir),
    )
    .await
    .unwrap();
}
