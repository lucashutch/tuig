//! The repository tab strip: where each tab sits, what a click on a column does, and how a drag reorders the tabs.
//! Ports `src/ui/repository-tabs.ts`.

use crate::graph_menu::clip_columns;
use crate::text_width::string_width;

/// Nerd Font octicon file-submodule. `SUBMODULE_ICON` in `src/ui/history.ts`.
pub const SUBMODULE_ICON: &str = "\u{f414}";
/// `WORKTREE_ICON` in `src/ui/history.ts`.
pub const WORKTREE_ICON: &str = "⎇";

/// A repository in the tab strip.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepositoryTab {
    /// Stable identity used by click handlers.
    pub id: String,
    pub path: String,
    /// Text shown in the strip. The folder name of `path` is used when this is `None`.
    pub label: Option<String>,
}

/// One tab that fits in the strip. Ranges are half open, in columns.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepositoryTabLayout {
    pub id: String,
    /// The label after fitting it to the available columns.
    pub label: String,
    pub active: bool,
    pub start: usize,
    pub end: usize,
    pub close_start: usize,
    pub close_end: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepositoryTabsLayout {
    pub width: usize,
    /// Tabs that fit, in their original order.
    pub tabs: Vec<RepositoryTabLayout>,
    /// The range of the + button. It stays visible when tabs overflow.
    pub open: (usize, usize),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RepositoryTabHit {
    Select(String),
    Close(String),
    Open,
}

const CLOSE_WIDTH: usize = 1;
/// Two leading cells, one cell before the close button, the button, and two trailing cells.
const TAB_OVERHEAD: usize = 6;
const MIN_TAB_WIDTH: usize = TAB_OVERHEAD + 1;
/// Short names are padded to this many label columns while space allows.
const MIN_NATURAL_LABEL_WIDTH: usize = 10;
const OPEN_WIDTH: usize = 3;
const TAB_GAP: usize = 1;

fn folder_name(path: &str) -> &str {
    let trimmed = path.trim_end_matches(['/', '\\']);
    let name = trimmed.rsplit(['/', '\\']).next().unwrap_or(trimmed);
    if name.is_empty() { path } else { name }
}

fn label_for(tab: &RepositoryTab) -> String {
    match &tab.label {
        Some(label) if !label.is_empty() => label.clone(),
        _ if folder_name(&tab.path).is_empty() => tab.id.clone(),
        _ => folder_name(&tab.path).to_owned(),
    }
}

/// Labels a nested repository with its parent. `submoduleTabLabel`.
pub fn submodule_tab_label(root: &str, parent_root: &str) -> String {
    format!(
        "{SUBMODULE_ICON} {} · {}",
        folder_name(root),
        folder_name(parent_root)
    )
}

/// Labels a linked worktree with the repository whose main checkout owns it. `worktreeTabLabel`.
pub fn worktree_tab_label(root: &str, main_root: &str) -> String {
    format!(
        "{WORKTREE_ICON} {} · {}",
        folder_name(root),
        folder_name(main_root)
    )
}

fn natural_tab_width(label: &str) -> usize {
    string_width(label).max(MIN_NATURAL_LABEL_WIDTH) + TAB_OVERHEAD
}

/// A contiguous window of tabs that keeps the active tab on screen. `visibleWindow`.
fn visible_window(count_all: usize, budget: usize, active: Option<usize>) -> (usize, usize) {
    if count_all == 0 || budget < MIN_TAB_WIDTH {
        return (0, 0);
    }
    let count = count_all.min(((budget + TAB_GAP) / (MIN_TAB_WIDTH + TAB_GAP)).max(1));
    if count == count_all {
        return (0, count_all);
    }
    let Some(active) = active else {
        return (0, count);
    };
    let start = active
        .saturating_sub((count - 1) / 2)
        .min(count_all - count);
    (start, start + count)
}

/// Takes columns from the widest tabs until the widths fit `budget`. `fitTabWidths`.
fn fit_tab_widths(natural: &[usize], budget: usize) -> Vec<usize> {
    let mut widths: Vec<usize> = natural.iter().map(|w| (*w).max(MIN_TAB_WIDTH)).collect();
    let mut remaining = widths.iter().sum::<usize>().saturating_sub(budget);
    while remaining > 0 {
        let mut widest: Option<usize> = None;
        for (index, width) in widths.iter().enumerate() {
            if *width > MIN_TAB_WIDTH && widest.is_none_or(|best| *width > widths[best]) {
                widest = Some(index);
            }
        }
        let Some(widest) = widest else { break };
        widths[widest] -= 1;
        remaining -= 1;
    }
    widths
}

/// Lays out the tabs in terminal columns. The + button follows the last visible tab.
pub fn layout_repository_tabs(
    tabs: &[RepositoryTab],
    active: Option<&str>,
    width: usize,
) -> RepositoryTabsLayout {
    let open_width = OPEN_WIDTH.min(width);
    let budget = width.saturating_sub(open_width + if tabs.is_empty() { 0 } else { TAB_GAP });
    let active_index = active.and_then(|id| tabs.iter().position(|tab| tab.id == id));
    let natural: Vec<usize> = tabs
        .iter()
        .map(|tab| natural_tab_width(&label_for(tab)))
        .collect();
    let (start, end) = visible_window(tabs.len(), budget, active_index);
    let selected = &natural[start..end];
    let widths = fit_tab_widths(
        selected,
        budget.saturating_sub(selected.len().saturating_sub(1) * TAB_GAP),
    );
    let mut laid_out = Vec::new();
    let mut column = 0;
    for index in start..end {
        let tab = &tabs[index];
        let tab_width = widths[index - start];
        let close_width = CLOSE_WIDTH.min(tab_width);
        let close_start = (column + tab_width).saturating_sub(close_width + 2);
        let label_width = close_start.saturating_sub(column + 3);
        laid_out.push(RepositoryTabLayout {
            id: tab.id.clone(),
            label: clip_columns(&label_for(tab), label_width as i64),
            active: active == Some(tab.id.as_str()),
            start: column,
            end: column + tab_width,
            close_start,
            close_end: close_start + close_width,
        });
        column += tab_width;
        if index < end - 1 {
            column += TAB_GAP;
        }
    }
    let open_start = width.min(column + if laid_out.is_empty() { 0 } else { TAB_GAP });
    let open_end = width.min(open_start + open_width);
    RepositoryTabsLayout {
        width,
        tabs: laid_out,
        open: (open_start, open_end),
    }
}

/// The action under a terminal column. `repositoryTabHit`.
pub fn repository_tab_hit(layout: &RepositoryTabsLayout, x: usize) -> Option<RepositoryTabHit> {
    if x >= layout.width {
        return None;
    }
    if x >= layout.open.0 && x < layout.open.1 {
        return Some(RepositoryTabHit::Open);
    }
    for tab in &layout.tabs {
        if x >= tab.close_start && x < tab.close_end {
            return Some(RepositoryTabHit::Close(tab.id.clone()));
        }
        if x >= tab.start && x < tab.end {
            return Some(RepositoryTabHit::Select(tab.id.clone()));
        }
    }
    None
}

/// Moves a tab before the tab at `target`. `reorderRepositoryTabs`.
fn reorder(tabs: &[RepositoryTab], moved: &str, target: &str) -> Vec<RepositoryTab> {
    let mut reordered = tabs.to_vec();
    let from = tabs.iter().position(|tab| tab.id == moved);
    let to = tabs.iter().position(|tab| tab.id == target);
    if let (Some(from), Some(to)) = (from, to)
        && from != to
    {
        let tab = reordered.remove(from);
        reordered.insert(to, tab);
    }
    reordered
}

/// The ids in the order after dragging `moved` to `column`, or `None` when the tabs stay.
///
/// Tabs of different widths would swap back and forth: after a short tab swaps with a long one, the pointer is
/// still over the long tab. A swap is accepted only when the pointer rests on the dragged tab afterwards.
pub fn drag_repository_tab(
    tabs: &[RepositoryTab],
    moved: &str,
    column: usize,
    active: Option<&str>,
    width: usize,
) -> Option<Vec<String>> {
    let hit = repository_tab_hit(&layout_repository_tabs(tabs, active, width), column)?;
    let target = match hit {
        RepositoryTabHit::Select(id) | RepositoryTabHit::Close(id) if id != moved => id,
        _ => return None,
    };
    let reordered = reorder(tabs, moved, &target);
    let after = repository_tab_hit(&layout_repository_tabs(&reordered, active, width), column);
    match after {
        Some(RepositoryTabHit::Select(id) | RepositoryTabHit::Close(id)) if id == moved => {
            Some(reordered.into_iter().map(|tab| tab.id).collect())
        }
        _ => None,
    }
}

/// One tab rendered to exactly the columns its layout reserves. `repositoryTabText`.
pub fn repository_tab_text(tab: &RepositoryTabLayout) -> String {
    let width = tab.end - tab.start;
    if width == 0 {
        return String::new();
    }
    let suffix = if width >= 4 { " ×  " } else { "" };
    let prefix = match width {
        0 => "",
        1 => " ",
        _ => "  ",
    };
    let content_width = width.saturating_sub(string_width(prefix) + string_width(suffix));
    let label = clip_columns(&tab.label, content_width as i64);
    // A label shorter than the tab is centred in the space before the close button.
    let padding = content_width.saturating_sub(string_width(&label));
    let left = padding / 2;
    format!(
        "{prefix}{}{label}{}{suffix}",
        " ".repeat(left),
        " ".repeat(padding - left)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tabs(names: &[&str]) -> Vec<RepositoryTab> {
        names
            .iter()
            .map(|name| RepositoryTab {
                id: (*name).to_owned(),
                path: format!("/work/{name}"),
                label: None,
            })
            .collect()
    }

    #[test]
    fn tabs_are_padded_and_followed_by_the_open_button() {
        let layout = layout_repository_tabs(&tabs(&["demo"]), Some("demo"), 160);
        let tab = &layout.tabs[0];
        assert_eq!((tab.start, tab.end), (0, 16));
        assert_eq!(layout.open, (17, 20));
        assert_eq!(repository_tab_text(tab), "     demo    ×  ");
    }

    #[test]
    fn a_click_on_the_cross_closes_and_elsewhere_selects() {
        let layout = layout_repository_tabs(&tabs(&["demo", "other"]), Some("demo"), 160);
        let demo = &layout.tabs[0];
        assert_eq!(
            repository_tab_hit(&layout, demo.close_start),
            Some(RepositoryTabHit::Close("demo".into()))
        );
        assert_eq!(
            repository_tab_hit(&layout, 3),
            Some(RepositoryTabHit::Select("demo".into()))
        );
        assert_eq!(
            repository_tab_hit(&layout, layout.open.0),
            Some(RepositoryTabHit::Open)
        );
        // The gap between tabs and the cells after the open button do nothing.
        assert_eq!(repository_tab_hit(&layout, demo.end), None);
        assert_eq!(repository_tab_hit(&layout, 160), None);
    }

    #[test]
    fn overflowing_tabs_keep_the_active_tab_and_the_open_button_visible() {
        let names: Vec<String> = (0..10).map(|i| format!("repo-{i}")).collect();
        let names: Vec<&str> = names.iter().map(String::as_str).collect();
        let all = tabs(&names);
        let layout = layout_repository_tabs(&all, Some("repo-8"), 40);
        assert!(layout.tabs.iter().any(|tab| tab.id == "repo-8"));
        assert!(layout.tabs.len() < 10);
        assert!(layout.tabs.iter().all(|tab| tab.end <= layout.open.0));
        assert_eq!(layout.open.1 - layout.open.0, 3);
        assert!(layout.open.1 <= 40);
    }

    #[test]
    fn long_labels_are_clipped_to_their_tab() {
        let mut long = tabs(&["a-very-long-repository-name-indeed"]);
        long[0].label = None;
        let layout = layout_repository_tabs(&long, None, 24);
        let tab = &layout.tabs[0];
        assert!(tab.label.ends_with('…'));
        assert_eq!(string_width(&repository_tab_text(tab)), tab.end - tab.start);
    }

    #[test]
    fn linked_checkouts_name_their_owner() {
        assert_eq!(
            worktree_tab_label("/w/feature_wt", "/w/app/"),
            "⎇ feature_wt · app"
        );
        assert_eq!(
            submodule_tab_label("/w/app/lib", "/w/app"),
            "\u{f414} lib · app"
        );
    }

    #[test]
    fn dragging_swaps_only_when_the_pointer_ends_on_the_dragged_tab() {
        let two = tabs(&["a", "b"]);
        let layout = layout_repository_tabs(&two, Some("a"), 160);
        let on_b = layout.tabs[1].start + 2;
        assert_eq!(
            drag_repository_tab(&two, "a", on_b, Some("a"), 160),
            Some(vec!["b".to_owned(), "a".to_owned()])
        );
        // Over its own tab, the order stays.
        assert_eq!(drag_repository_tab(&two, "a", 2, Some("a"), 160), None);
        // A short tab dragged over a much longer one would leave the pointer on the long tab, so nothing moves.
        let mut mixed = tabs(&["a", "b"]);
        mixed[1].label = Some("x".repeat(60));
        let layout = layout_repository_tabs(&mixed, Some("a"), 160);
        let near_start_of_long = layout.tabs[1].start + 1;
        assert_eq!(
            drag_repository_tab(&mixed, "a", near_start_of_long, Some("a"), 160),
            None
        );
    }
}
