use tuig_git::types::Commit;
use tuig_ui_model::search::search_graph_rows;

fn commit(sha: &str) -> Commit {
    Commit {
        sha: sha.to_string(),
        ..Commit::default()
    }
}

#[test]
fn each_match_is_one_unconnected_dot_and_head_is_marked() {
    let rows = search_graph_rows(&[commit("aaa"), commit("bbb")], Some("bbb"), "#61AFEF");
    assert!(rows.iter().all(|row| row.lane == 0));
    // Matches are scattered through history, so nothing connects the rows.
    assert!(
        rows.iter()
            .all(|row| row.connectors.is_empty() && !row.continues_above)
    );
    assert_eq!(rows[0].cells[0].symbol, "● ");
    assert_eq!(rows[1].cells[0].symbol, "◉ ");
    assert!(rows[1].head && !rows[0].head);
    assert_eq!(rows[0].color_at(0), Some("#61AFEF"));
    assert_eq!(rows[0].color_at(1), None);
    assert!(search_graph_rows(&[], None, "#61AFEF").is_empty());
}
