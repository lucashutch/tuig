//! The toolbar buttons and where they sit on the two toolbar rows. Ports `toolbarButtons`, the geometry of
//! `renderToolbar` and `toolbarHit` in `src/ui/runtime-presentation-chrome.ts`.

use crate::text_width::string_width;
use tuig_git::types::RepositorySnapshot;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolbarAction {
    Fetch,
    Pull,
    Push,
    Undo,
    Stash,
    Pop,
    Refresh,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolbarButton {
    pub id: ToolbarAction,
    pub label: &'static str,
    pub glyph: &'static str,
    pub enabled: bool,
}

/// A button's column range and the cells its label and glyph are centred in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolbarCell {
    pub button: ToolbarButton,
    pub start: usize,
    pub width: usize,
}

impl ToolbarCell {
    pub fn end(&self) -> usize {
        self.start + self.width
    }
}

/// Columns of padding on each side of a button.
const GAP: usize = 2;

/// The toolbar's actions. The ones the repository cannot do are disabled. `toolbarButtons`.
pub fn toolbar_buttons(snapshot: Option<&RepositorySnapshot>) -> Vec<ToolbarButton> {
    let loaded = snapshot.is_some();
    let tracked = snapshot.is_some_and(|snapshot| snapshot.upstream.is_some());
    let button = |id, label, glyph, enabled| ToolbarButton {
        id,
        label,
        glyph,
        enabled,
    };
    vec![
        button(ToolbarAction::Fetch, "Fetch", "󰇚", loaded),
        button(ToolbarAction::Pull, "Pull", "↓", tracked),
        button(ToolbarAction::Push, "Push", "↑", tracked),
        button(ToolbarAction::Undo, "Undo", "↶", loaded),
        button(
            ToolbarAction::Stash,
            "Stash",
            "󰆓",
            snapshot.is_some_and(|snapshot| !snapshot.files.is_empty()),
        ),
        button(
            ToolbarAction::Pop,
            "Pop",
            "󰄼",
            snapshot.is_some_and(|snapshot| !snapshot.stashes.is_empty()),
        ),
        button(ToolbarAction::Refresh, "Refresh", "󰑓", loaded),
    ]
}

/// The buttons centred in `width` columns, in order. Gaps of `GAP` columns surround each label.
pub fn layout_toolbar(buttons: Vec<ToolbarButton>, width: usize) -> Vec<ToolbarCell> {
    let widths: Vec<usize> = buttons
        .iter()
        .map(|button| string_width(button.label).max(string_width(button.glyph)) + GAP * 2)
        .collect();
    let lead = width.saturating_sub(widths.iter().sum()) / 2;
    let mut column = lead;
    buttons
        .into_iter()
        .zip(widths)
        .map(|(button, width)| {
            let cell = ToolbarCell {
                button,
                start: column,
                width,
            };
            column += width;
            cell
        })
        .collect()
}

/// The enabled button under a column. `toolbarHit`.
pub fn toolbar_hit(cells: &[ToolbarCell], x: usize) -> Option<ToolbarAction> {
    cells
        .iter()
        .find(|cell| cell.button.enabled && x >= cell.start && x < cell.end())
        .map(|cell| cell.button.id)
}

/// Centres `value` in `width` columns, the odd column going to the right. The TS `centre`.
pub fn centre(value: &str, width: usize) -> String {
    let padding = width.saturating_sub(string_width(value));
    let before = padding / 2;
    format!(
        "{}{value}{}",
        " ".repeat(before),
        " ".repeat(padding - before)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot() -> RepositorySnapshot {
        RepositorySnapshot::default()
    }

    #[test]
    fn buttons_follow_what_the_repository_can_do() {
        let enabled = |snapshot: Option<&RepositorySnapshot>| -> Vec<&'static str> {
            toolbar_buttons(snapshot)
                .into_iter()
                .filter(|button| button.enabled)
                .map(|button| button.label)
                .collect()
        };
        assert!(enabled(None).is_empty());
        assert_eq!(enabled(Some(&snapshot())), ["Fetch", "Undo", "Refresh"]);
        let mut tracked = snapshot();
        tracked.upstream = Some("origin/main".into());
        assert_eq!(
            enabled(Some(&tracked)),
            ["Fetch", "Pull", "Push", "Undo", "Refresh"]
        );
    }

    #[test]
    fn the_strip_is_centred_and_only_enabled_buttons_answer_clicks() {
        let cells = layout_toolbar(toolbar_buttons(Some(&snapshot())), 160);
        // 9 + 8 + 8 + 8 + 9 + 7 + 11 columns, centred in 160.
        assert_eq!(cells[0].start, (160 - 60) / 2);
        assert_eq!(cells[1].start, cells[0].end());
        assert_eq!(
            toolbar_hit(&cells, cells[0].start),
            Some(ToolbarAction::Fetch)
        );
        assert_eq!(
            toolbar_hit(&cells, cells[0].end() - 1),
            Some(ToolbarAction::Fetch)
        );
        // Pull is disabled without an upstream.
        assert_eq!(toolbar_hit(&cells, cells[1].start + 2), None);
        assert_eq!(toolbar_hit(&cells, 0), None);
    }

    #[test]
    fn centring_puts_the_spare_column_on_the_right() {
        assert_eq!(centre("ab", 5), " ab  ");
        assert_eq!(centre("↓", 8), "   ↓    ");
    }
}
