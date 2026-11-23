use tuig_git::types::Commit;
use tuig_ui_model::graph::{GraphRow, layout_graph};

fn commits(list: &[(&str, &[&str])]) -> Vec<Commit> {
    list.iter()
        .map(|(sha, parents)| Commit {
            sha: (*sha).to_string(),
            parents: parents.iter().map(|p| (*p).to_string()).collect(),
            ..Commit::default()
        })
        .collect()
}

fn colors() -> Vec<String> {
    ["#61AFEF", "#C678DD", "#E5C07B"].map(String::from).to_vec()
}

/// One text line per commit row, then one per non-empty connector row.
fn draw(rows: &[GraphRow]) -> String {
    let join = |cells: &[tuig_ui_model::graph::GraphCell]| {
        cells.iter().map(|c| c.symbol.as_str()).collect::<String>()
    };
    let mut out = String::new();
    for row in rows {
        out += &format!("{} {}\n", join(&row.cells).trim_end(), row.sha);
        let connectors = join(&row.connectors);
        if !connectors.trim().is_empty() {
            out += &format!("{}\n", connectors.trim_end());
        }
    }
    out
}

fn layout(list: &[(&str, &[&str])], head: Option<&str>) -> Vec<GraphRow> {
    layout_graph(&commits(list), &colors(), head)
}

#[test]
fn feature_branch_forks_and_merges_back() {
    let rows = layout(
        &[
            ("merge", &["main2", "feat2"]),
            ("main2", &["main1"]),
            ("feat2", &["feat1"]),
            ("feat1", &["main1"]),
            ("main1", &["root"]),
            ("root", &[]),
        ],
        Some("merge"),
    );
    assert_eq!(
        draw(&rows),
        "\
◉ │ merge
├─╮
● │ main2
│ │
│ ● feat2
│ │
│ ● feat1
├─┤
●─╯ main1
│
● root
"
    );
}

#[test]
fn octopus_merge_fans_out_and_branch_tips_end_on_the_shared_base() {
    let rows = layout(
        &[
            ("m", &["a", "b", "c", "d"]),
            ("a", &["r"]),
            ("b", &["r"]),
            ("c", &["r"]),
            ("d", &["r"]),
            ("r", &[]),
        ],
        None,
    );
    assert_eq!(
        draw(&rows),
        "\
● │ │ │ m
├─┬─┬─╮
● │ │ │ a
│ │ │ │
│ ● │ │ b
├─┤ │ │
│ │ ● │ c
├─┼─┤ │
│ │ │ ● d
├─┼─┼─┤
●─┴─┴─╯ r
"
    );
}

#[test]
fn two_branches_that_meet_at_one_commit_join_on_its_dot() {
    // Both tips list `base` as parent, so two lanes wait for it and merge when
    // it is drawn.
    let rows = layout(
        &[
            ("tipA", &["base"]),
            ("tipB", &["base"]),
            ("base", &["root"]),
            ("root", &[]),
        ],
        None,
    );
    assert_eq!(
        draw(&rows),
        "\
● tipA
│
│ ● tipB
├─┤
●─╯ base
│
● root
"
    );
}

#[test]
fn criss_cross_merges_keep_lane_colors_with_their_ancestry() {
    let rows = layout(
        &[
            ("m1", &["a", "b"]),
            ("m2", &["b", "a"]),
            ("a", &["r"]),
            ("b", &["r"]),
            ("r", &[]),
        ],
        None,
    );
    // The first parent continues the child's color. The second parent opens a
    // new color, and the lane keeps it on the next row. A lane that does not
    // exist yet on a row's cell line has the fallback color.
    let lane_colors: Vec<Vec<&str>> = rows.iter().map(GraphRow::lane_colors).collect();
    assert_eq!(lane_colors[0], ["#61AFEF", "#888888"]);
    assert_eq!(lane_colors[1][..2], ["#61AFEF", "#C678DD"]);
    let connector_colors: Vec<&str> = rows[0]
        .connectors
        .iter()
        .map(|c| c.color.as_str())
        .collect();
    assert_eq!(connector_colors, ["#61AFEF", "#C678DD"]);
}

#[test]
fn a_wide_history_keeps_every_open_lane_until_its_commit() {
    // Ten tips that all point at distinct parents open ten lanes at once.
    let mut list: Vec<(String, Vec<String>)> = (0..10)
        .map(|i| (format!("t{i}"), vec![format!("p{i}")]))
        .collect();
    list.extend((0..10).map(|i| (format!("p{i}"), vec![])));
    let owned: Vec<Commit> = list
        .iter()
        .map(|(sha, parents)| Commit {
            sha: sha.clone(),
            parents: parents.clone(),
            ..Commit::default()
        })
        .collect();
    let rows = layout_graph(&owned, &colors(), None);
    assert_eq!(rows[9].cells.len(), 10);
    assert_eq!(rows[9].lane, 9);
    // Three colors cycle in order of lane creation, so lane 3 reuses lane 0's.
    assert_eq!(rows[9].cells[3].color, rows[9].cells[0].color);
    // p0 closes lane 0 and the other lanes keep their columns.
    assert_eq!(rows[10].lane, 0);
    assert!(rows[10].continues_above);
    assert_eq!(rows[10].cells.len(), 10);
}

#[test]
fn duplicate_and_empty_parents_are_ignored() {
    let rows = layout(&[("a", &["b", "b", ""]), ("b", &[])], None);
    assert_eq!(draw(&rows), "● a\n│\n● b\n");
}

#[test]
fn head_gets_its_own_dot() {
    let rows = layout(&[("a", &["b"]), ("b", &[])], Some("b"));
    assert!(!rows[0].head);
    assert!(rows[1].head);
    assert!(draw(&rows).contains("◉ b"));
}
