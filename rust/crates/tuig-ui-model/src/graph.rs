//! Graph lane layout and glyph selection.
//!
//! Ports `src/ui/graph.ts`. Layout is a forward fold over commits listed
//! newest first, so the lane state after one page of commits is enough to lay
//! out the next page.
//!
//! Differences from TypeScript: rows hold plain cell vectors, not packed
//! strings, and a row holds the commit sha, not the commit. A row at offset `i`
//! of a layout call belongs to `commits[i]` of that call.

use std::collections::HashSet;

/// Color for any cell without a palette entry.
pub const FALLBACK_COLOR: &str = "#888888";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GraphCell {
    /// Two characters: a glyph and a trailing `─` or space.
    pub symbol: String,
    pub color: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GraphRow {
    pub sha: String,
    pub lane: usize,
    /// True for the commit HEAD points at.
    pub head: bool,
    /// Whether this ancestry enters the commit from the row above.
    pub continues_above: bool,
    pub cells: Vec<GraphCell>,
    pub connectors: Vec<GraphCell>,
}

impl GraphRow {
    pub fn cell_count(&self) -> usize {
        self.cells.len()
    }

    pub fn connector_count(&self) -> usize {
        self.connectors.len()
    }

    /// One lane's color, or `None` past the last lane.
    pub fn color_at(&self, lane: usize) -> Option<&str> {
        self.cells.get(lane).map(|cell| cell.color.as_str())
    }

    pub fn lane_colors(&self) -> Vec<&str> {
        self.cells.iter().map(|cell| cell.color.as_str()).collect()
    }
}

const NORTH: u8 = 1;
const EAST: u8 = 2;
const SOUTH: u8 = 4;
const WEST: u8 = 8;

#[derive(Clone, Copy, Default)]
struct Topology {
    mask: u8,
    commit: bool,
    head: bool,
}

fn add(topology: &mut Vec<Topology>, lane: usize, direction: u8) {
    if topology.len() <= lane {
        topology.resize(lane + 1, Topology::default());
    }
    topology[lane].mask |= direction;
}

/// Removes a stroke a lane only inherited, such as a column created on this row.
fn clear(topology: &mut Vec<Topology>, lane: usize, direction: u8) {
    if topology.len() <= lane {
        topology.resize(lane + 1, Topology::default());
    }
    topology[lane].mask &= !direction;
}

/// Every glyph comes from the strokes that reach the cell, so a lane that both
/// continues vertically and receives a horizontal run joins it.
fn glyph(mask: u8) -> char {
    match mask {
        m if m == NORTH | SOUTH | EAST | WEST => '┼',
        m if m == NORTH | EAST | WEST => '┴',
        m if m == SOUTH | EAST | WEST => '┬',
        m if m == NORTH | SOUTH | EAST => '├',
        m if m == NORTH | SOUTH | WEST => '┤',
        m if m == NORTH | EAST => '╰',
        m if m == NORTH | WEST => '╯',
        m if m == SOUTH | EAST => '╭',
        m if m == SOUTH | WEST => '╮',
        m if m == NORTH | SOUTH || m == NORTH || m == SOUTH => '│',
        m if m == EAST || m == WEST || m == EAST | WEST => '─',
        _ => ' ',
    }
}

fn symbol(node: &Topology) -> String {
    let trailing = if node.mask & EAST != 0 { '─' } else { ' ' };
    let first = if node.commit {
        // HEAD gets its own dot so the checked-out commit is findable.
        if node.head { '◉' } else { '●' }
    } else {
        glyph(node.mask)
    };
    let mut out = String::with_capacity(6);
    out.push(first);
    out.push(trailing);
    out
}

/// The fold state carried between [`layout_graph_from`] calls.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct GraphLayoutState {
    /// Lane occupancy: the sha each column is waiting for.
    pub active: Vec<String>,
    /// Colors belong to an ancestry, not a column.
    pub active_colors: Vec<String>,
    pub next_color: usize,
}

/// Assigns persistent lanes in newest-first log order.
pub fn layout_graph(
    commits: &[tuig_git::types::Commit],
    colors: &[String],
    head_sha: Option<&str>,
) -> Vec<GraphRow> {
    layout_graph_from(commits, colors, head_sha, &GraphLayoutState::default()).rows
}

pub struct GraphLayout {
    pub rows: Vec<GraphRow>,
    pub state: GraphLayoutState,
}

/// JavaScript `Array.prototype.splice`: the start and count clamp to the length.
fn splice<T>(items: &mut Vec<T>, start: usize, delete: usize, insert: impl IntoIterator<Item = T>) {
    let start = start.min(items.len());
    let end = (start + delete).min(items.len());
    items.splice(start..end, insert);
}

/// Lays out `commits` as if they directly followed the commits that produced
/// `state`. The incoming state is copied.
pub fn layout_graph_from(
    commits: &[tuig_git::types::Commit],
    colors: &[String],
    head_sha: Option<&str>,
    state: &GraphLayoutState,
) -> GraphLayout {
    let mut active = state.active.clone();
    let mut active_colors = state.active_colors.clone();
    let mut next_color = state.next_color;
    let mut color = || {
        let picked = colors
            .get(next_color % colors.len().max(1))
            .map_or(FALLBACK_COLOR, String::as_str)
            .to_string();
        next_color += 1;
        picked
    };

    let mut rows = Vec::with_capacity(commits.len());
    for commit in commits {
        let mut incoming: Vec<usize> = active
            .iter()
            .enumerate()
            .filter(|(_, sha)| **sha == commit.sha)
            .map(|(index, _)| index)
            .collect();
        let first = incoming.first().copied();
        let continues_above = first.is_some();
        let lane = match first {
            Some(lane) => lane,
            None => {
                // An exhausted lane is removed at once, so this append also
                // reuses its column.
                let lane = active.len();
                active.push(commit.sha.clone());
                let picked = color();
                active_colors.push(picked);
                incoming = vec![lane];
                lane
            }
        };

        let before = active.clone();
        let before_colors = active_colors.clone();
        let mut seen = HashSet::new();
        let parents: Vec<String> = commit
            .parents
            .iter()
            .filter(|parent| !parent.is_empty() && seen.insert(parent.as_str()))
            .cloned()
            .collect();

        // Replace the first (first-parent) occurrence in place. A later
        // duplicate stays until its commit is drawn, as an explicit fan-in.
        splice(&mut active, lane, 1, parents.iter().cloned());
        let mut new_colors = Vec::with_capacity(parents.len());
        for index in 0..parents.len() {
            if index == 0 {
                new_colors.push(match before_colors.get(lane) {
                    Some(existing) => existing.clone(),
                    None => color(),
                });
            } else {
                new_colors.push(color());
            }
        }
        splice(&mut active_colors, lane, 1, new_colors);
        for index in (lane + 1..before.len()).rev() {
            if before[index] == commit.sha {
                let at = (index + parents.len()).saturating_sub(1);
                splice(&mut active, at, 1, []);
                splice(&mut active_colors, at, 1, []);
            }
        }

        let width = before.len().max(active.len()).max(lane + 1);
        let mut cell_topology: Vec<Topology> = (0..width)
            .map(|column| Topology {
                mask: if column < before.len() || column < active.len() {
                    NORTH | SOUTH
                } else {
                    0
                },
                ..Topology::default()
            })
            .collect();
        let is_head = head_sha == Some(commit.sha.as_str());
        cell_topology[lane] = Topology {
            mask: SOUTH,
            commit: true,
            head: is_head,
        };

        // Several incoming copies of a commit meet on its dot. Existing
        // vertical lanes keep their N/S mask, which gives a stable crossing.
        if incoming.len() > 1 {
            let last = *incoming.last().unwrap();
            add(&mut cell_topology, lane, EAST);
            for column in lane + 1..=last {
                // These copies arrive from above and end here, so they drop
                // the south half of their inherited vertical stroke.
                if incoming.contains(&column) {
                    cell_topology[column].mask = NORTH;
                }
                add(&mut cell_topology, column, WEST);
                if column < last {
                    add(&mut cell_topology, column, EAST);
                }
            }
        }

        let mut connector_topology: Vec<Topology> = (0..width.max(active.len()))
            .map(|column| Topology {
                mask: if column < active.len() {
                    NORTH | SOUTH
                } else {
                    0
                },
                ..Topology::default()
            })
            .collect();
        if parents.len() > 1 {
            add(&mut connector_topology, lane, EAST);
            for column in lane + 1..lane + parents.len() {
                // These lanes start at the horizontal run and descend from
                // it, so they carry no north stroke.
                clear(&mut connector_topology, column, NORTH);
                add(&mut connector_topology, column, WEST);
                if column < lane + parents.len() - 1 {
                    add(&mut connector_topology, column, EAST);
                }
            }
        } else if let Some(parent) = parents.first()
            && let Some(parent_lane) = active.iter().position(|sha| sha == parent)
            && parent_lane < lane
        {
            add(&mut connector_topology, parent_lane, EAST);
            for column in parent_lane + 1..=lane {
                add(&mut connector_topology, column, WEST);
                if column < lane {
                    add(&mut connector_topology, column, EAST);
                }
            }
        }

        let pack = |topology: &[Topology], colors_by_column: &[String]| -> Vec<GraphCell> {
            topology
                .iter()
                .enumerate()
                .map(|(column, node)| GraphCell {
                    symbol: symbol(node),
                    color: colors_by_column
                        .get(column)
                        .map_or(FALLBACK_COLOR, String::as_str)
                        .to_string(),
                })
                .collect()
        };
        rows.push(GraphRow {
            sha: commit.sha.clone(),
            lane,
            head: is_head,
            continues_above,
            cells: pack(&cell_topology, &before_colors),
            connectors: pack(&connector_topology, &active_colors),
        });
    }

    GraphLayout {
        rows,
        state: GraphLayoutState {
            active,
            active_colors,
            next_color,
        },
    }
}
