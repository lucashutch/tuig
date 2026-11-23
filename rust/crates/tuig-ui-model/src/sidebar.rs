//! Sidebar geometry from `src/ui/runtime-presentation-sidebar.ts`: which rows each section gets, which section a
//! row belongs to, and how a divider drag moves the section sizes.
//!
//! Painting, hit testing and scrolling all read the one [`layout_sidebar_sections`] result, so the numbers cannot
//! drift apart. All rows are pane-local: row 0 is the first row under the tab strip and toolbar.

use std::ops::{Index, IndexMut};

/// The sidebar sections, top to bottom. Pull requests sit under local branches, as in TS.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Section {
    Local,
    PullRequests,
    Remote,
    Submodules,
    Stashes,
    Worktrees,
}

impl Section {
    pub const ALL: [Section; 6] = [
        Section::Local,
        Section::PullRequests,
        Section::Remote,
        Section::Submodules,
        Section::Stashes,
        Section::Worktrees,
    ];

    pub fn index(self) -> usize {
        self as usize
    }

    /// The section below this one, if any.
    fn after(self) -> impl Iterator<Item = Section> {
        Section::ALL.into_iter().skip(self.index() + 1)
    }
}

/// One value for each section.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct PerSection<T>(pub [T; 6]);

impl<T: Copy> PerSection<T> {
    pub fn splat(value: T) -> Self {
        Self([value; 6])
    }
}

impl<T> PerSection<T> {
    pub fn from_fn(mut make: impl FnMut(Section) -> T) -> Self {
        Self(Section::ALL.map(&mut make))
    }
}

impl<T> Index<Section> for PerSection<T> {
    type Output = T;

    fn index(&self, section: Section) -> &T {
        &self.0[section.index()]
    }
}

impl<T> IndexMut<Section> for PerSection<T> {
    fn index_mut(&mut self, section: Section) -> &mut T {
        &mut self.0[section.index()]
    }
}

/// Content rows each open section keeps while the pane has room. `SIDEBAR_MIN_CONTENT_HEIGHT`.
pub const SIDEBAR_MIN_CONTENT_HEIGHT: i64 = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct SidebarRect {
    pub header_top: i64,
    pub content_top: i64,
    pub content_height: i64,
    /// The divider row below the section. The last shown section has none.
    pub divider_top: Option<i64>,
    /// A section that takes no rows, header included.
    pub hidden: bool,
}

impl SidebarRect {
    /// Whether pane-local row `y` is one of the section's content rows.
    pub fn holds(&self, y: i64) -> bool {
        !self.hidden && y >= self.content_top && y < self.content_top + self.content_height
    }
}

/// Splits `height` rows between the sections. `layoutSidebarSections`.
///
/// Every shown section keeps a header row, a divider separates neighbours, and the rest goes to the open
/// sections. `preferred` holds remembered content heights. Sections without one share what is left.
pub fn layout_sidebar_sections(
    height: i64,
    preferred: &PerSection<Option<i64>>,
    collapsed: &PerSection<bool>,
    hidden: &PerSection<bool>,
) -> PerSection<SidebarRect> {
    let shown: Vec<Section> = Section::ALL
        .into_iter()
        .filter(|section| !hidden[*section])
        .collect();
    let count = shown.len() as i64;
    let headers = height.max(0).min(count);
    let dividers = (height - headers).max(0).min((count - 1).max(0));
    let mut spare = (height - headers - dividers).max(0);
    let open: Vec<Section> = shown
        .iter()
        .copied()
        .filter(|section| !collapsed[*section])
        .collect();
    let open_count = open.len() as i64;
    let mut sizes = PerSection::<i64>::default();
    let minimum = if spare >= open_count * SIDEBAR_MIN_CONTENT_HEIGHT {
        SIDEBAR_MIN_CONTENT_HEIGHT
    } else {
        0
    };
    for section in &open {
        sizes[*section] = minimum;
    }
    spare -= minimum * open_count;
    // A terminal that cannot fit every minimum degrades evenly instead of overflowing.
    if minimum == 0 && open_count > 0 {
        for section in &open {
            sizes[*section] = spare / open_count;
        }
        let assigned: i64 = open.iter().map(|section| sizes[*section]).sum();
        let leftover = usize::try_from(spare - assigned).unwrap_or(0);
        for section in open.iter().take(leftover) {
            sizes[*section] += 1;
        }
        spare = 0;
    }
    let explicit: Vec<Section> = open
        .iter()
        .copied()
        .filter(|section| preferred[*section].is_some())
        .collect();
    let unspecified: Vec<Section> = open
        .iter()
        .copied()
        .filter(|section| preferred[*section].is_none())
        .collect();
    let extra_for = |section: Section| (preferred[section].unwrap_or(minimum) - minimum).max(0);
    let requested: i64 = explicit.iter().map(|section| extra_for(*section)).sum();
    if requested > spare && requested > 0 {
        // A small terminal cannot honor every remembered size. Keep their relative order and use exactly the
        // rows that exist. `spare` shrinks inside the loop, as in TS.
        for section in &explicit {
            let size = spare * extra_for(*section) / requested;
            sizes[*section] += size;
            spare -= size;
        }
    } else {
        for section in &explicit {
            let extra = extra_for(*section);
            sizes[*section] += extra;
            spare -= extra;
        }
    }
    let recipients = if unspecified.is_empty() {
        &open
    } else {
        &unspecified
    };
    // One share for every recipient. Recomputing it from the shrinking spare left rows unassigned.
    let share = spare / (recipients.len() as i64).max(1);
    for section in recipients {
        sizes[*section] += share;
        spare -= share;
    }
    for section in recipients {
        let before = spare;
        spare -= 1;
        if before <= 0 {
            break;
        }
        sizes[*section] += 1;
    }
    let mut top = 0;
    let mut result = PerSection::<SidebarRect>::default();
    for section in Section::ALL {
        if hidden[section] {
            result[section] = SidebarRect {
                header_top: top,
                content_top: top,
                content_height: 0,
                divider_top: None,
                hidden: true,
            };
        }
    }
    for (position, section) in shown.iter().enumerate() {
        let position = position as i64;
        let header_top = top;
        top += i64::from(position < headers);
        let content_top = top;
        top += sizes[*section];
        let divider_top = (position < dividers).then(|| {
            let row = top;
            top += 1;
            row
        });
        result[*section] = SidebarRect {
            header_top,
            content_top,
            content_height: sizes[*section],
            divider_top,
            hidden: false,
        };
    }
    result
}

/// The section whose content rows hold pane-local row `y`.
pub fn section_at(layout: &PerSection<SidebarRect>, y: i64) -> Option<Section> {
    Section::ALL
        .into_iter()
        .find(|section| layout[*section].holds(y))
}

/// New preferred heights after dragging the divider below `section` to pane-local row `y`. Only the two sections
/// the divider separates change. `resizeSidebarBoundary`.
pub fn resize_sidebar_boundary(
    layout: &PerSection<SidebarRect>,
    preferred: &PerSection<Option<i64>>,
    collapsed: &PerSection<bool>,
    section: Section,
    y: i64,
) -> PerSection<Option<i64>> {
    let next = section
        .after()
        .find(|candidate| !collapsed[*candidate] && !layout[*candidate].hidden);
    let Some(next) = next.filter(|_| !collapsed[section]) else {
        return *preferred;
    };
    let total = layout[section].content_height + layout[next].content_height;
    let minimum = if total >= SIDEBAR_MIN_CONTENT_HEIGHT * 2 {
        SIDEBAR_MIN_CONTENT_HEIGHT
    } else {
        0
    };
    let wanted = minimum.max((total - minimum).min(y - layout[section].content_top));
    // Every rendered height becomes explicit before the pair changes. Leaving others undefined would make the
    // allocator redistribute their rows during the drag, and unrelated dividers would move.
    let mut result = PerSection::from_fn(|candidate| {
        if collapsed[candidate] || layout[candidate].hidden {
            preferred[candidate]
        } else {
            Some(layout[candidate].content_height)
        }
    });
    result[section] = Some(wanted);
    result[next] = Some(total - wanted);
    result
}

/// The header text. `sidebarHeader`.
pub fn sidebar_header(section: Section, count: usize, collapsed: bool) -> String {
    let label = match section {
        Section::Local => "LOCAL BRANCHES",
        Section::Remote => "REMOTES",
        Section::PullRequests => "PULL REQUESTS",
        Section::Submodules => "SUBMODULES",
        Section::Stashes => "STASHES",
        Section::Worktrees => "WORKTREES",
    };
    format!("{} {label} {count}", if collapsed { "▶" } else { "▼" })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn none() -> PerSection<Option<i64>> {
        PerSection::splat(None)
    }

    fn all_open() -> PerSection<bool> {
        PerSection::splat(false)
    }

    fn no_hidden() -> PerSection<bool> {
        PerSection::splat(false)
    }

    fn hide_pull_requests() -> PerSection<bool> {
        let mut hidden = no_hidden();
        hidden[Section::PullRequests] = true;
        hidden
    }

    #[test]
    fn the_default_pane_matches_the_typescript_golden() {
        // The demo repository: 45 rows, pull requests hidden. `initial-load` puts the dividers at rows 9, 18, 27
        // and 36 (terminal rows 12, 21, 30, 39).
        let layout = layout_sidebar_sections(45, &none(), &all_open(), &hide_pull_requests());
        let header_tops: Vec<i64> = [
            Section::Local,
            Section::Remote,
            Section::Submodules,
            Section::Stashes,
            Section::Worktrees,
        ]
        .map(|section| layout[section].header_top)
        .to_vec();
        assert_eq!(header_tops, [0, 10, 19, 28, 37]);
        assert_eq!(layout[Section::Local].divider_top, Some(9));
        assert_eq!(layout[Section::Worktrees].divider_top, None);
        assert_eq!(layout[Section::Worktrees].content_top, 38);
        assert_eq!(layout[Section::Worktrees].content_height, 7);
        assert!(layout[Section::PullRequests].hidden);
    }

    #[test]
    fn sections_use_every_row_and_keep_their_headers() {
        let mut collapsed = all_open();
        collapsed[Section::Submodules] = true;
        let preferred = PerSection([Some(10), Some(1), Some(1), Some(9), Some(1), Some(1)]);
        let layout = layout_sidebar_sections(20, &preferred, &collapsed, &hide_pull_requests());
        assert_eq!(layout[Section::Local].header_top, 0);
        assert!(layout[Section::Worktrees].header_top < 20);
        let content: i64 = [
            Section::Local,
            Section::Remote,
            Section::Stashes,
            Section::Worktrees,
        ]
        .iter()
        .map(|section| layout[*section].content_height)
        .sum();
        assert_eq!(content, 11);
        assert_eq!(layout[Section::Submodules].content_height, 0);
    }

    #[test]
    fn a_tiny_pane_drops_the_headers_that_do_not_fit() {
        let mut collapsed = all_open();
        collapsed[Section::Submodules] = true;
        let layout = layout_sidebar_sections(
            3,
            &PerSection::splat(Some(1)),
            &collapsed,
            &hide_pull_requests(),
        );
        assert_eq!(layout[Section::Submodules].header_top, 2);
    }

    #[test]
    fn a_roomy_pane_gives_each_open_section_three_rows() {
        let layout =
            layout_sidebar_sections(34, &PerSection::splat(Some(1)), &all_open(), &no_hidden());
        assert!(
            Section::ALL
                .iter()
                .all(|section| layout[*section].content_height >= 3)
        );
    }

    #[test]
    fn a_divider_resizes_only_its_two_sections() {
        let layout = layout_sidebar_sections(30, &none(), &all_open(), &no_hidden());
        let remote = layout[Section::Remote];
        let resized = resize_sidebar_boundary(
            &layout,
            &none(),
            &all_open(),
            Section::Remote,
            remote.content_top + 1,
        );
        assert_eq!(resized[Section::Remote], Some(3));
        assert_eq!(
            resized[Section::Submodules],
            Some(remote.content_height + layout[Section::Submodules].content_height - 3)
        );
        // The sections that did not move keep their rendered height, so their dividers stay put.
        assert_eq!(
            resized[Section::Local],
            Some(layout[Section::Local].content_height)
        );
    }

    #[test]
    fn a_divider_skips_collapsed_neighbours() {
        let mut collapsed = all_open();
        collapsed[Section::Submodules] = true;
        let layout = layout_sidebar_sections(40, &none(), &collapsed, &hide_pull_requests());
        let remote = layout[Section::Remote];
        let resized = resize_sidebar_boundary(
            &layout,
            &none(),
            &collapsed,
            Section::Remote,
            remote.content_top + 4,
        );
        assert_eq!(resized[Section::Remote], Some(4));
        assert_eq!(
            resized[Section::Stashes],
            Some(remote.content_height + layout[Section::Stashes].content_height - 4)
        );
        assert_eq!(resized[Section::Submodules], None);
    }

    #[test]
    fn rows_belong_to_the_section_that_paints_them() {
        let layout = layout_sidebar_sections(45, &none(), &all_open(), &hide_pull_requests());
        assert_eq!(section_at(&layout, 1), Some(Section::Local));
        // Row 0 is a header and row 9 is a divider.
        assert_eq!(section_at(&layout, 0), None);
        assert_eq!(section_at(&layout, 9), None);
        assert_eq!(section_at(&layout, 11), Some(Section::Remote));
    }

    #[test]
    fn headers_show_the_count_and_the_fold_state() {
        assert_eq!(sidebar_header(Section::Remote, 136, false), "▼ REMOTES 136");
        assert_eq!(
            sidebar_header(Section::PullRequests, 2, true),
            "▶ PULL REQUESTS 2"
        );
    }
}
