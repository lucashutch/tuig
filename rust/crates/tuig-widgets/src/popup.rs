//! The overlay layer: popup menus with an optional submenu, and the command palette box. Ports `makePopup` in
//! `src/ui/runtime-widgets.ts`, `RuntimePopupController.paint` and `content`, and `RuntimePaletteController.paint`.
//!
//! [`PopupLayer`] is one [`Component`] that covers the screen. It paints the open menu or palette and takes every
//! mouse event while it is visible, as the TypeScript catcher box does. A press outside every box sends
//! [`PopupEvent::Dismiss`]. The shell owns the state (items, hover, palette rows) and pushes it in with
//! [`PopupLayer::set_content`]. The text inputs of the palette and the name prompt are separate widgets above this
//! layer.

use crate::pointer::PointerTracker;
use opentui::native::BoxSpec;
use opentui::prelude::*;
use tuig_ui_model::color::Rgba;
use tuig_ui_model::graph_menu::{MenuPane, clip_columns, render_menu_line};
use tuig_ui_model::history_viewport::WHEEL_ROWS;
use tuig_ui_model::theme::{Surface, Theme, ThemeStates, interaction_background, semantic_color};

/// The footer under the palette results.
pub const PALETTE_FOOTER: &str = "↑↓ navigate   enter select   esc close";

/// One palette result row, ready to paint.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PaletteRowView {
    pub title: String,
    /// The shortcut, or the reason the command is unavailable.
    pub detail: String,
    pub selected: bool,
    pub disabled: bool,
}

/// The palette box. `left`, `top`, `width` and `height` are terminal cells.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PaletteView {
    pub left: i64,
    pub top: i64,
    pub width: i64,
    pub height: i64,
    /// Result rows on screen. The box has room for `visible_rows` of them.
    pub rows: Vec<PaletteRowView>,
    pub visible_rows: i64,
}

impl PaletteView {
    /// The result row under a terminal cell, `None` outside the results text.
    pub fn row_at(&self, x: i64, y: i64) -> Option<usize> {
        if x < self.left + 1 || x >= self.left + 1 + (self.width - 4).max(1) {
            return None;
        }
        let row = usize::try_from(y - (self.top + 3)).ok()?;
        (i64::try_from(row).ok()? < self.visible_rows).then_some(row)
    }

    fn contains(&self, x: i64, y: i64) -> bool {
        x >= self.left && x < self.left + self.width && y >= self.top && y < self.top + self.height
    }
}

/// A menu with its optional submenu.
#[derive(Debug, Clone, Default)]
pub struct MenuView {
    pub title: String,
    pub pane: MenuPane,
    pub submenu: Option<MenuPane>,
}

impl MenuView {
    fn box_contains(pane: &MenuPane, x: i64, y: i64) -> bool {
        x >= pane.left
            && x < pane.left + pane.width
            && y >= pane.top
            && y < pane.top + pane.items.len() as i64 + 2
    }

    /// The text area of a pane: inside the border, one row per item.
    fn text_contains(pane: &MenuPane, x: i64, y: i64) -> bool {
        x > pane.left
            && x < pane.left + pane.width - 1
            && y > pane.top
            && y <= pane.top + pane.items.len() as i64
    }
}

#[derive(Debug, Clone, Default)]
pub enum PopupContent {
    #[default]
    Hidden,
    Menu(MenuView),
    Palette(PaletteView),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PopupEvent {
    /// A press outside every box.
    Dismiss,
    /// The pointer moved over a menu pane. Coordinates are terminal cells.
    MenuHover {
        x: u16,
        y: u16,
        submenu: bool,
    },
    MenuClick {
        x: u16,
        y: u16,
        submenu: bool,
    },
    /// The pointer moved over palette result `row`, counted from the first visible row.
    PaletteHover {
        row: usize,
    },
    PaletteClick {
        row: usize,
        button: MouseButton,
    },
    PaletteScroll(i32),
}

type EventHandler = Box<dyn FnMut(&mut Cx<'_>, PopupEvent)>;

pub struct PopupLayer {
    theme: Theme,
    content: PopupContent,
    /// The layer covers the screen and takes every pointer event while it shows. Widgets under it read the last
    /// position back when the layer closes, to hover what is under the still pointer.
    pointer: PointerTracker,
    on_event: Option<EventHandler>,
}

fn to_color(color: Rgba) -> Color {
    Color::rgba(color.r, color.g, color.b, color.a)
}

impl PopupLayer {
    pub fn new(theme: Theme) -> Self {
        Self {
            theme,
            content: PopupContent::Hidden,
            pointer: PointerTracker::default(),
            on_event: None,
        }
    }

    /// Shares the pointer position with the widgets under the layer.
    pub fn set_pointer_tracker(&mut self, pointer: PointerTracker) {
        self.pointer = pointer;
    }

    pub fn set_theme(&mut self, theme: &Theme) {
        self.theme = theme.clone();
    }

    pub fn set_content(&mut self, content: PopupContent) {
        self.content = content;
    }

    pub fn content(&self) -> &PopupContent {
        &self.content
    }

    /// The handler must not call `Custom::update` or `Custom::with` on this widget. Queue a message instead.
    pub fn on_event(&mut self, handler: impl FnMut(&mut Cx<'_>, PopupEvent) + 'static) {
        self.on_event = Some(Box::new(handler));
    }

    fn emit(&mut self, cx: &mut Cx<'_>, event: PopupEvent) {
        if let Some(handler) = self.on_event.as_mut() {
            handler(cx, event);
        }
    }

    /// `dialogColor(path, fallback, states)`.
    fn dialog(&self, path: &str, fallback: Rgba, states: ThemeStates) -> Color {
        to_color(semantic_color(
            &self.theme,
            path,
            fallback,
            Surface::Dialog,
            states,
        ))
    }

    fn paint_pane(&self, painter: &mut Painter<'_>, pane: &MenuPane, title: &str) {
        let theme = &self.theme;
        let border = self.dialog("border.base", theme.border, ThemeStates::default());
        let background = self.dialog(
            "background.base",
            theme.panel_raised,
            ThemeStates::default(),
        );
        let height = pane.items.len() as u32 + 2;
        let title = if title.is_empty() {
            String::new()
        } else {
            format!(" {} ", clip_columns(title, pane.width - 4))
        };
        painter.draw_box(
            pane.left as i32,
            pane.top as i32,
            pane.width as u32,
            height,
            &BoxSpec {
                border_color: border,
                background,
                fill: true,
                title: &title,
                ..BoxSpec::default()
            },
        );
        let inner = pane.width - 2;
        for (index, item) in pane.items.iter().enumerate() {
            let line = render_menu_line(item, inner);
            let x = (pane.left + 1) as i32;
            let y = (pane.top + 1 + index as i64) as i32;
            if item.separator {
                painter.text(x, y, &line, Style::new().fg(border));
                continue;
            }
            let states = ThemeStates {
                hovered: pane.hover == Some(index),
                disabled: item.disabled,
                ..ThemeStates::default()
            };
            let variant = if item.destructive {
                "destructive"
            } else {
                "primary"
            };
            let row_bg = interaction_background(
                theme,
                theme.panel_raised,
                false,
                false,
                states.hovered && !states.disabled,
            );
            let color = if item.disabled {
                theme.muted
            } else if item.destructive {
                theme.deleted
            } else {
                theme.text
            };
            let style = Style::new()
                .bg(self.dialog(&format!("background.action.{variant}"), row_bg, states))
                .fg(self.dialog(&format!("text.action.{variant}"), color, states));
            painter.text(x, y, &line, style);
        }
    }

    fn paint_palette(&self, painter: &mut Painter<'_>, view: &PaletteView) {
        let theme = &self.theme;
        let none = ThemeStates::default();
        painter.fill(
            view.left as i32,
            view.top as i32,
            view.width.max(0) as u32,
            view.height.max(0) as u32,
            self.dialog("background.base", theme.panel_raised, none),
        );
        let muted = self.dialog("text.muted", theme.muted, none);
        let inner = (view.width - 4).max(1);
        let x = (view.left + 1) as i32;
        let top = (view.top + 3) as i32;
        if view.rows.is_empty() {
            painter.text(x, top, " No matching commands", Style::new().fg(muted));
        }
        for (row, entry) in view.rows.iter().enumerate() {
            let y = top + row as i32;
            let content = (inner - 2).max(1);
            let detail_chars = entry.detail.chars().count() as i64;
            let detail_width = detail_chars.min(24).min((content - 24).max(0));
            let title_width = (content - detail_width).max(1);
            let mut title = clip_columns(&entry.title, title_width);
            let pad = (title_width as usize).saturating_sub(title.chars().count());
            title.push_str(&" ".repeat(pad));
            let mut detail = clip_columns(&entry.detail, detail_width);
            let pad = (detail_width as usize).saturating_sub(detail.chars().count());
            detail.insert_str(0, &" ".repeat(pad));
            let states = ThemeStates {
                selected: entry.selected,
                focused: entry.selected,
                disabled: entry.disabled,
                ..ThemeStates::default()
            };
            let base = if entry.selected {
                theme.selected
            } else {
                theme.panel_raised
            };
            let row_bg = self.dialog("background.action.primary", base, states);
            let color = if entry.disabled {
                theme.muted
            } else {
                theme.text
            };
            let title_text = format!(" {title}");
            let title_cells = painter.text_width(&title_text) as i32;
            painter.text(
                x,
                y,
                &title_text,
                Style::new()
                    .bg(row_bg)
                    .fg(self.dialog("text.action.primary", color, states)),
            );
            painter.text(
                x + title_cells,
                y,
                &format!("{detail} "),
                Style::new()
                    .bg(row_bg)
                    .fg(self.dialog("text.muted", theme.muted, states)),
            );
        }
        painter.text(
            (view.left + 2) as i32,
            (view.top + view.visible_rows + 4) as i32,
            &clip_columns(PALETTE_FOOTER, inner),
            Style::new().fg(muted),
        );
    }
}

impl Component for PopupLayer {
    fn paint(&self, painter: &mut Painter<'_>) {
        match &self.content {
            PopupContent::Hidden => {}
            PopupContent::Menu(menu) => {
                self.paint_pane(painter, &menu.pane, &menu.title);
                if let Some(submenu) = &menu.submenu {
                    self.paint_pane(painter, submenu, "");
                }
            }
            PopupContent::Palette(view) => self.paint_palette(painter, view),
        }
    }

    fn mouse(&mut self, cx: &mut Cx<'_>, event: &MouseEvent, local: (i32, i32)) -> bool {
        self.pointer.record(event);
        let (x, y) = (i64::from(local.0), i64::from(local.1));
        let cell = |value: i32| u16::try_from(value.max(0)).unwrap_or(u16::MAX);
        let (cell_x, cell_y) = (cell(local.0), cell(local.1));
        let emitted = match (&self.content, event.kind) {
            (PopupContent::Hidden, _) => return false,
            (PopupContent::Menu(menu), MouseEventKind::Moved) => {
                let hit = pane_hit(menu, x, y);
                hit.map(|submenu| PopupEvent::MenuHover {
                    x: cell_x,
                    y: cell_y,
                    submenu,
                })
            }
            (PopupContent::Menu(menu), MouseEventKind::Down(_)) => match pane_hit(menu, x, y) {
                Some(submenu) => Some(PopupEvent::MenuClick {
                    x: cell_x,
                    y: cell_y,
                    submenu,
                }),
                None => {
                    let inside = MenuView::box_contains(&menu.pane, x, y)
                        || menu
                            .submenu
                            .as_ref()
                            .is_some_and(|pane| MenuView::box_contains(pane, x, y));
                    (!inside).then_some(PopupEvent::Dismiss)
                }
            },
            (PopupContent::Palette(view), MouseEventKind::Moved) => view
                .row_at(x, y)
                .map(|row| PopupEvent::PaletteHover { row }),
            (PopupContent::Palette(view), MouseEventKind::Down(button)) => {
                match view.row_at(x, y) {
                    Some(row) => Some(PopupEvent::PaletteClick { row, button }),
                    None => (!view.contains(x, y)).then_some(PopupEvent::Dismiss),
                }
            }
            (PopupContent::Palette(view), MouseEventKind::ScrollUp) => view
                .row_at(x, y)
                .map(|_| PopupEvent::PaletteScroll(-WHEEL_ROWS)),
            (PopupContent::Palette(view), MouseEventKind::ScrollDown) => view
                .row_at(x, y)
                .map(|_| PopupEvent::PaletteScroll(WHEEL_ROWS)),
            _ => None,
        };
        if let Some(event) = emitted {
            self.emit(cx, event);
        }
        true
    }
}

/// Which pane's text area holds the cell: `Some(true)` for the submenu, which sits on top.
fn pane_hit(menu: &MenuView, x: i64, y: i64) -> Option<bool> {
    if menu
        .submenu
        .as_ref()
        .is_some_and(|pane| MenuView::text_contains(pane, x, y))
    {
        return Some(true);
    }
    MenuView::text_contains(&menu.pane, x, y).then_some(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tuig_ui_model::graph_menu::{GraphMenuItem, place_pane};

    #[test]
    fn the_submenu_wins_where_the_panes_overlap() {
        let pane = place_pane(vec![GraphMenuItem::new("One")], 10, 5, 160, 48);
        let mut submenu = place_pane(vec![GraphMenuItem::new("Two")], 12, 5, 160, 48);
        submenu.left = 12;
        let menu = MenuView {
            title: String::new(),
            pane,
            submenu: Some(submenu),
        };
        assert_eq!(pane_hit(&menu, 13, 6), Some(true));
        assert_eq!(pane_hit(&menu, 11, 6), Some(false));
        // The border columns belong to the box, not the text.
        assert_eq!(pane_hit(&menu, 10, 6), None);
    }

    #[test]
    fn palette_rows_map_from_the_results_text_only() {
        let view = PaletteView {
            left: 42,
            top: 9,
            width: 76,
            height: 19,
            rows: Vec::new(),
            visible_rows: 12,
        };
        assert_eq!(view.row_at(50, 12), Some(0));
        assert_eq!(view.row_at(50, 23), Some(11));
        assert_eq!(view.row_at(50, 24), None);
        // The input row and the box padding are not results.
        assert_eq!(view.row_at(50, 10), None);
        assert_eq!(view.row_at(42, 12), None);
    }
}
