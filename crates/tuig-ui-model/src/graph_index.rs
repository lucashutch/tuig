//! Lane layout for a loaded history, kept as checkpoints instead of rows.
//!
//! Ports `src/ui/graph-index.ts`. Layout is a forward fold, so the lane state
//! at row N is enough to produce every row after it. The index keeps one state
//! per [`CHECKPOINT_STRIDE`] rows and replays the visible window on demand.

use tuig_git::types::Commit;

use crate::graph::{GraphLayoutState, GraphRow, layout_graph_from};

/// Rows between saved lane states.
pub const CHECKPOINT_STRIDE: usize = 500;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GraphIndexError {
    pub held: usize,
    pub given: usize,
}

impl std::fmt::Display for GraphIndexError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "graph index holds {} rows, cannot extend with {} commits",
            self.held, self.given
        )
    }
}

impl std::error::Error for GraphIndexError {}

#[derive(Debug, Clone)]
pub struct GraphIndex {
    /// Rows laid out so far, which tracks the loaded commit count.
    pub length: usize,
    /// Widest row seen, so every painted row pads to one column count.
    pub columns: usize,
    /// Lane state before row `i * CHECKPOINT_STRIDE`.
    pub checkpoints: Vec<GraphLayoutState>,
    /// Lane state after row `length`, which the next page continues from.
    pub state: GraphLayoutState,
    /// HEAD when the index was built.
    pub head_sha: Option<String>,
    /// HEAD ancestry seeded by the working-changes pseudo-node, when present.
    pub working_parent_sha: Option<String>,
    /// The last window replayed: its first row and the rows.
    pub window: Option<(usize, Vec<GraphRow>)>,
}

impl GraphIndex {
    pub fn new(working_parent_sha: Option<&str>, colors: &[String]) -> Self {
        let initial = match working_parent_sha {
            Some(sha) if !sha.is_empty() => GraphLayoutState {
                active: vec![sha.to_string()],
                active_colors: vec![
                    colors
                        .first()
                        .cloned()
                        .unwrap_or_else(|| crate::graph::FALLBACK_COLOR.to_string()),
                ],
                next_color: 1,
            },
            _ => GraphLayoutState::default(),
        };
        Self {
            length: 0,
            columns: 1,
            checkpoints: vec![initial.clone()],
            state: initial,
            head_sha: None,
            working_parent_sha: working_parent_sha.map(str::to_string),
            window: None,
        }
    }

    /// Lays out every commit past the end of the index. The rows are dropped.
    /// Only the lane state at each stride boundary and the widest row stay.
    pub fn extend(
        &mut self,
        commits: &[Commit],
        colors: &[String],
        head_sha: Option<&str>,
    ) -> Result<(), GraphIndexError> {
        // The fold only runs forwards. A shorter list is a different history.
        if commits.len() < self.length {
            return Err(GraphIndexError {
                held: self.length,
                given: commits.len(),
            });
        }
        self.head_sha = head_sha.map(str::to_string);
        self.window = None;
        let mut at = self.length;
        while at < commits.len() {
            // Laid out a stride at a time so a checkpoint lands on each
            // boundary, whatever page size the commits arrived in.
            let boundary = (at / CHECKPOINT_STRIDE + 1) * CHECKPOINT_STRIDE;
            let upto = commits.len().min(boundary);
            let laid_out = layout_graph_from(&commits[at..upto], colors, head_sha, &self.state);
            for row in &laid_out.rows {
                self.columns = self
                    .columns
                    .max(row.cell_count())
                    .max(row.connector_count());
            }
            self.state = laid_out.state;
            at = upto;
            if at.is_multiple_of(CHECKPOINT_STRIDE) {
                let slot = at / CHECKPOINT_STRIDE;
                if slot < self.checkpoints.len() {
                    self.checkpoints[slot] = self.state.clone();
                } else {
                    self.checkpoints.push(self.state.clone());
                }
            }
        }
        self.length = at;
        Ok(())
    }

    /// Rows `from` through `from + count`, replayed from the nearest checkpoint.
    ///
    /// The slice can be longer than `count`.
    pub fn window(
        &mut self,
        commits: &[Commit],
        colors: &[String],
        from: usize,
        count: usize,
    ) -> &[GraphRow] {
        if count == 0 || from >= self.length {
            return &[];
        }
        let reusable = matches!(
            &self.window,
            Some((held_from, rows))
                if *held_from == from && rows.len() >= count.min(self.length - from)
        );
        if !reusable {
            let mark = from / CHECKPOINT_STRIDE;
            let base = mark * CHECKPOINT_STRIDE;
            let upto = self.length.min(from + count);
            // A caller with fewer commits than the index holds gets fewer rows,
            // as `slice` does in TypeScript.
            let laid_out = layout_graph_from(
                &commits[base.min(commits.len())..upto.min(commits.len())],
                colors,
                self.head_sha.as_deref(),
                &self.checkpoints[mark],
            );
            let rows = laid_out.rows.into_iter().skip(from - base).collect();
            self.window = Some((from, rows));
        }
        &self.window.as_ref().expect("window was just set").1
    }
}
