//! Detects large repositories that lack a commit-graph file.
//!
//! Without `objects/info/commit-graph`, Git reads every commit object to walk history. Paging with `--skip` repeats
//! that walk, so it gets slow in large repositories. This module only looks at the file system. It never runs
//! `git commit-graph` or `git maintenance`.

use std::path::Path;

/// Pack size above which a repository counts as large. Counting commits needs the full walk this check avoids, and
/// pack size tracks history size closely enough: a repository with 10,000 commits is rarely under this.
pub const LARGE_REPOSITORY_PACK_BYTES: u64 = 64 * 1024 * 1024;

/// True when `common_dir` has no commit-graph and its packs total at least [`LARGE_REPOSITORY_PACK_BYTES`].
pub fn lacks_commit_graph_when_large(common_dir: &Path, pack_threshold: u64) -> bool {
    let info = common_dir.join("objects").join("info");
    if info.join("commit-graph").exists() || info.join("commit-graphs").exists() {
        return false;
    }
    pack_bytes(&common_dir.join("objects").join("pack")) >= pack_threshold
}

fn pack_bytes(pack_dir: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(pack_dir) else {
        return 0;
    };
    entries
        .flatten()
        .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "pack"))
        .filter_map(|entry| entry.metadata().ok())
        .map(|meta| meta.len())
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_util::TempDir;

    fn repo_with_pack(bytes: usize) -> TempDir {
        let dir = TempDir::new("tuig-commit-graph");
        let pack = dir.path().join("objects").join("pack");
        std::fs::create_dir_all(&pack).unwrap();
        std::fs::create_dir_all(dir.path().join("objects").join("info")).unwrap();
        std::fs::write(pack.join("pack-a.pack"), vec![0; bytes]).unwrap();
        // An index file is not history data and does not count.
        std::fs::write(pack.join("pack-a.idx"), vec![0; bytes]).unwrap();
        dir
    }

    #[test]
    fn a_large_repository_without_a_commit_graph_is_flagged() {
        let dir = repo_with_pack(2000);
        assert!(lacks_commit_graph_when_large(dir.path(), 2000));
    }

    #[test]
    fn a_small_repository_is_not_flagged() {
        let dir = repo_with_pack(1999);
        assert!(!lacks_commit_graph_when_large(dir.path(), 2000));
    }

    #[test]
    fn a_commit_graph_file_or_chain_clears_the_flag() {
        let file = repo_with_pack(5000);
        std::fs::write(file.path().join("objects/info/commit-graph"), b"graph").unwrap();
        assert!(!lacks_commit_graph_when_large(file.path(), 2000));

        let chain = repo_with_pack(5000);
        std::fs::create_dir(chain.path().join("objects/info/commit-graphs")).unwrap();
        assert!(!lacks_commit_graph_when_large(chain.path(), 2000));
    }
}
