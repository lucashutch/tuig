use tuig_git::types::Commit;
use tuig_ui_model::graph::layout_graph;
use tuig_ui_model::graph_index::{CHECKPOINT_STRIDE, GraphIndex};

fn commit(sha: &str, parents: &[&str]) -> Commit {
    Commit {
        sha: sha.to_string(),
        parents: parents.iter().map(|p| (*p).to_string()).collect(),
        ..Commit::default()
    }
}

/// A history with merges and forks, so lanes open, cross and close.
fn history(size: usize) -> Vec<Commit> {
    (0..size)
        .map(|i| {
            let mut parents = vec![format!("c{}", i + 1)];
            // Every seventh commit is a merge, which opens a lane that closes later.
            if i % 7 == 0 && i + 4 < size {
                parents.push(format!("c{}", i + 4));
            }
            if i + 1 >= size {
                parents.clear();
            }
            Commit {
                sha: format!("c{i}"),
                parents,
                ..Commit::default()
            }
        })
        .collect()
}

fn colors() -> Vec<String> {
    [
        "#61AFEF", "#C678DD", "#E5C07B", "#98C379", "#E06C75", "#56B6C2",
    ]
    .map(String::from)
    .to_vec()
}

#[test]
fn replayed_windows_match_a_layout_of_the_whole_history() {
    let commits = history(CHECKPOINT_STRIDE * 3 + 137);
    let whole = layout_graph(&commits, &colors(), None);
    let mut index = GraphIndex::new(None, &[]);
    index.extend(&commits, &colors(), None).unwrap();
    assert_eq!(index.length, commits.len());
    // Windows on and either side of a checkpoint, and one that spans two.
    for from in [
        0,
        1,
        CHECKPOINT_STRIDE - 1,
        CHECKPOINT_STRIDE,
        CHECKPOINT_STRIDE + 1,
        CHECKPOINT_STRIDE * 2 - 30,
        commits.len() - 60,
    ] {
        let window = index.window(&commits, &colors(), from, 60);
        assert_eq!(&window[..60], &whole[from..from + 60], "from {from}");
    }
}

#[test]
fn reaches_the_same_layout_however_the_pages_were_sized() {
    let commits = history(CHECKPOINT_STRIDE * 2 + 40);
    let whole = layout_graph(&commits, &colors(), None);
    for page in [1, 17, 250, CHECKPOINT_STRIDE, 999] {
        let mut index = GraphIndex::new(None, &[]);
        let mut at = 0;
        while at < commits.len() {
            let upto = (at + page).min(commits.len());
            index.extend(&commits[..upto], &colors(), None).unwrap();
            at += page;
        }
        assert_eq!(index.length, commits.len());
        assert_eq!(
            index.checkpoints.len(),
            commits.len() / CHECKPOINT_STRIDE + 1
        );
        let all = index.window(&commits, &colors(), 0, commits.len());
        assert_eq!(all, &whole[..], "page size {page}");
    }
}

#[test]
fn reports_the_widest_row_across_the_whole_history() {
    let commits = history(CHECKPOINT_STRIDE * 2);
    let widest = layout_graph(&commits, &colors(), None)
        .iter()
        .map(|row| row.cell_count().max(row.connector_count()))
        .fold(1, usize::max);
    let mut index = GraphIndex::new(None, &[]);
    index.extend(&commits, &colors(), None).unwrap();
    assert_eq!(index.columns, widest);
    assert!(widest > 1);
}

#[test]
fn marks_the_head_row_after_a_replay_from_a_checkpoint() {
    let commits = history(CHECKPOINT_STRIDE + 10);
    let mut index = GraphIndex::new(None, &[]);
    index.extend(&commits, &colors(), Some("c505")).unwrap();
    let rows = index.window(&commits, &colors(), 500, 10);
    assert_eq!(rows[5].sha, "c505");
    assert!(rows[5].head);
    assert!(!rows[4].head);
}

#[test]
fn working_changes_ancestry_connects_to_head_across_unrelated_tips() {
    let commits = [
        commit("other", &["other-parent"]),
        commit("head", &["parent"]),
        commit("other-parent", &[]),
        commit("parent", &[]),
    ];
    let mut index = GraphIndex::new(Some("head"), &colors());
    index.extend(&commits, &colors(), Some("head")).unwrap();
    let rows = index.window(&commits, &colors(), 0, commits.len());
    let shas: Vec<&str> = rows.iter().map(|r| r.sha.as_str()).collect();
    assert_eq!(shas, ["other", "head", "other-parent", "parent"]);
    assert_eq!(rows[0].cells[0].symbol, "│ ");
    assert_eq!(rows[1].cells[0].symbol, "◉ ");
    assert!(rows[1].continues_above);
}

#[test]
fn windows_stop_at_the_laid_out_range() {
    let commits = history(50);
    let mut index = GraphIndex::new(None, &[]);
    index.extend(&commits, &colors(), None).unwrap();
    assert!(index.window(&commits, &colors(), 50, 10).is_empty());
    assert!(index.window(&commits, &colors(), 0, 0).is_empty());
    assert_eq!(index.window(&commits, &colors(), 45, 60).len(), 5);
}

#[test]
fn a_shorter_history_is_an_error() {
    let commits = history(20);
    let mut index = GraphIndex::new(None, &[]);
    index.extend(&commits, &colors(), None).unwrap();
    let error = index.extend(&commits[..10], &colors(), None).unwrap_err();
    assert_eq!(
        error.to_string(),
        "graph index holds 20 rows, cannot extend with 10 commits"
    );
}
