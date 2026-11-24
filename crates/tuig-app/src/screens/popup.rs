//! Popups: menus with a submenu, confirmation dialogs and the name prompt. Ports `src/ui/runtime-popup.ts`,
//! `openGraphMenu` in `src/ui/runtime-graph-menu.ts`, and `confirmThen` and `openNamePrompt` in
//! `src/ui/runtime-commands.ts`.
//!
//! Other screens use these entry points:
//!
//! - [`Shell::open_popup`] opens a menu at a terminal position. The [`MenuRequest::on_select`] closure runs with
//!   the chosen item after the popup closes.
//! - [`Shell::confirm_then`] shows a confirmation and runs a closure when the user confirms.
//! - [`Shell::open_name_prompt`] shows a one-line text prompt and runs a closure with the trimmed text.
//! - [`Shell::open_graph_menu`] builds and opens the context menu for a [`GraphMenuTarget`]. The commit, file and
//!   diff right-click handlers call it.
//! - [`Shell::close_popup`] and [`Shell::popup_open`].
//!
//! The popup state lives in [`OverlayState`]. [`Shell::sync_overlay`] pushes it into the [`OverlayWidgets`].

use crate::screens::palette::PaletteState;
use crate::shell::{Dirty, Inbox, Msg, Shell};
use opentui::prelude::*;
use opentui::widget::{AnyWidget, Input};
use std::rc::Rc;
use tuig_ui_model::color::Rgba;
use tuig_ui_model::graph_menu::{
    ConfirmRequest, GraphMenuItem, GraphMenuTarget, MenuPane, build_graph_menu, menu_row_at,
    menu_width, place_menu, place_pane,
};
use tuig_ui_model::theme::{Surface, Theme, ThemeStates, semantic_color};
use tuig_widgets::pointer::PointerTracker;
use tuig_widgets::popup::{MenuView, PopupContent, PopupEvent, PopupLayer};

pub type MenuSelect = Box<dyn FnOnce(&mut Shell, &App, GraphMenuItem)>;
pub type PromptRun = Box<dyn FnOnce(&mut Shell, &App, String)>;

/// What an overlay widget asks the shell to do. One variant of [`Msg`].
pub enum OverlayMsg {
    Popup(PopupEvent),
    PromptSubmit,
    PaletteQuery,
    PaletteSubmit,
    /// A right press on a history row. `on_label` is set when the press landed on the ref label.
    HistoryMenu {
        row: usize,
        on_label: bool,
        x: u16,
        y: u16,
    },
    /// A right press on a row of a file list.
    FileMenu {
        section: tuig_widgets::files::ListKind,
        row: usize,
        x: u16,
        y: u16,
    },
}

/// A menu to open. See [`Shell::open_popup`].
pub struct MenuRequest {
    pub title: String,
    pub items: Vec<GraphMenuItem>,
    pub x: i64,
    pub y: i64,
    /// The row that starts highlighted, for confirmations that default to the confirm item.
    pub selected: Option<usize>,
    pub on_select: MenuSelect,
}

pub struct MenuState {
    pub view: MenuView,
    select: Option<MenuSelect>,
    /// The name prompt. Its input sits over the first row.
    prompt: Option<PromptRun>,
}

#[derive(Default)]
pub struct OverlayState {
    pub menu: Option<MenuState>,
    pub palette: Option<PaletteState>,
    /// The widget that had focus before a text input took it.
    pub(crate) previous_focus: Option<AnyWidget>,
}

/// The overlay layer and the two text inputs above it.
pub struct OverlayWidgets {
    pub layer: Custom<PopupLayer>,
    pub prompt: Input,
    pub palette_input: Input,
}

fn color(color: Rgba) -> Color {
    Color::rgba(color.r, color.g, color.b, color.a)
}

fn surface_color(
    theme: &Theme,
    surface: Surface,
    path: &str,
    fallback: Rgba,
    states: ThemeStates,
) -> Color {
    color(semantic_color(theme, path, fallback, surface, states))
}

/// The form field colors of `updateWidgetTheme`, from the semantic tokens of `surface`.
pub(crate) fn style_field(input: &Input, theme: &Theme, base: Rgba, surface: Surface) {
    let none = ThemeStates::default();
    let focused = ThemeStates {
        focused: true,
        ..none
    };
    input
        .colors(
            surface_color(theme, surface, "text.formfield", theme.text, none),
            surface_color(theme, surface, "background.formfield", base, none),
        )
        .focused_colors(
            surface_color(theme, surface, "text.formfield", theme.text, focused),
            surface_color(
                theme,
                surface,
                "background.formfield",
                theme.selected,
                focused,
            ),
        )
        .placeholder_color(surface_color(
            theme,
            surface,
            "text.muted",
            theme.muted,
            none,
        ))
        .cursor_color(surface_color(
            theme,
            surface,
            "text.formfield",
            theme.focus_ring,
            focused,
        ));
}

/// Gives a text input the dialog form-field colors. `updateWidgetTheme` for `name-prompt` and the palette search.
fn style_input(input: &Input, theme: &Theme, base: Rgba) {
    style_field(input, theme, base, Surface::Dialog);
    // The arrow, page and emacs keys move the palette selection. The inputs have one line.
    for key in [
        "up", "down", "pageup", "pagedown", "ctrl+p", "ctrl+n", "ctrl+k",
    ] {
        input.unbind(key);
    }
}

impl OverlayWidgets {
    pub fn new(app: &App, theme: &Theme, inbox: &Rc<Inbox>, pointer: &PointerTracker) -> Self {
        let mut layer = PopupLayer::new(theme.clone());
        layer.set_pointer_tracker(pointer.clone());
        {
            let inbox = inbox.clone();
            layer.on_event(move |cx, event| {
                inbox.post(cx.app(), Msg::Overlay(OverlayMsg::Popup(event)));
            });
        }
        let layer = Custom::new(app, layer)
            .absolute()
            .z_index(50)
            .position(Edge::Left, 0)
            .position(Edge::Top, 0)
            .visible(false);
        let prompt = Input::new(app)
            .absolute()
            .z_index(80)
            .height(1)
            .placeholder("Name")
            .visible(false);
        style_input(&prompt, theme, theme.selected);
        {
            let inbox = inbox.clone();
            prompt.on_submit(move |cx, _| {
                inbox.post(cx.app(), Msg::Overlay(OverlayMsg::PromptSubmit));
            });
        }
        let palette_input = Input::new(app)
            .absolute()
            .z_index(102)
            .height(1)
            .placeholder("Search commands")
            .visible(false);
        style_input(&palette_input, theme, theme.panel_raised);
        {
            let inbox = inbox.clone();
            palette_input.on_change(move |cx, _| {
                inbox.post(cx.app(), Msg::Overlay(OverlayMsg::PaletteQuery));
            });
        }
        {
            let inbox = inbox.clone();
            palette_input.on_submit(move |cx, _| {
                inbox.post(cx.app(), Msg::Overlay(OverlayMsg::PaletteSubmit));
            });
        }
        Self {
            layer,
            prompt,
            palette_input,
        }
    }

    pub fn set_theme(&self, theme: &Theme) {
        self.layer.update(|layer| layer.set_theme(theme));
        style_input(&self.prompt, theme, theme.selected);
        style_input(&self.palette_input, theme, theme.panel_raised);
    }

    pub fn attach(&self, root: &opentui::widget::View) {
        root.add(&self.layer)
            .add(&self.prompt)
            .add(&self.palette_input);
    }
}

impl OverlayState {
    pub fn is_open(&self) -> bool {
        self.menu.is_some() || self.palette.is_some()
    }
}

impl Shell {
    /// Opens a menu. Replaces a menu that is open.
    pub fn open_popup(&mut self, request: MenuRequest) {
        self.open_popup_with(request, None);
    }

    fn open_popup_with(&mut self, request: MenuRequest, prompt: Option<PromptRun>) {
        let (width, height) = (i64::from(self.layout.width), i64::from(self.layout.height));
        let mut pane = place_pane(request.items, request.x, request.y, width, height);
        pane.hover = request.selected;
        self.overlay.menu = Some(MenuState {
            view: MenuView {
                title: request.title,
                pane,
                submenu: None,
            },
            select: Some(request.on_select),
            prompt,
        });
        self.dirty |= Dirty::OVERLAY;
    }

    /// Closes the menu or prompt without choosing anything.
    pub fn close_popup(&mut self, app: &App) {
        let Some(menu) = self.overlay.menu.take() else {
            return;
        };
        if menu.prompt.is_some() {
            self.restore_focus(app);
        }
        self.dirty |= Dirty::OVERLAY;
    }

    /// Esc or a click outside: closes the palette, else the popup. `dismissOverlay`.
    pub(crate) fn dismiss_overlay(&mut self, app: &App) {
        if self.overlay.palette.is_some() {
            self.close_palette(app, true);
        } else {
            self.close_popup(app);
        }
    }

    pub(crate) fn remember_focus(&mut self, app: &App) {
        self.overlay.previous_focus = app.focused();
    }

    pub(crate) fn restore_focus(&mut self, app: &App) {
        match self.overlay.previous_focus.take() {
            Some(widget) => app.focus(&widget),
            None => app.focus(&self.widgets.history),
        }
    }

    /// Shows `request.lines` and the two buttons. `run` runs when the user picks the confirm button.
    pub fn confirm_then(
        &mut self,
        request: ConfirmRequest,
        run: impl FnOnce(&mut Shell, &App) + 'static,
    ) {
        let lines = request.lines.len();
        let mut items: Vec<GraphMenuItem> =
            request.lines.into_iter().map(GraphMenuItem::info).collect();
        items.push(GraphMenuItem::separator());
        let mut confirm = GraphMenuItem::new(request.confirm_label.clone());
        confirm.destructive = request.destructive;
        items.push(confirm);
        items.push(GraphMenuItem::new("Cancel"));
        let width = menu_width(&items);
        let confirm_label = request.confirm_label;
        let (columns, rows) = (i64::from(self.layout.width), i64::from(self.layout.height));
        self.open_popup(MenuRequest {
            title: request.title,
            x: ((columns - width) / 2).max(0),
            y: ((rows - items.len() as i64) / 2).max(0),
            items,
            selected: Some(lines + 1),
            on_select: Box::new(move |shell, app, item| {
                if item.label == confirm_label {
                    run(shell, app);
                }
            }),
        });
    }

    /// Shows a one-line prompt. `run` gets the trimmed text on Enter. An empty text keeps the prompt open.
    pub fn open_name_prompt(
        &mut self,
        app: &App,
        title: &str,
        placeholder: &str,
        run: impl FnOnce(&mut Shell, &App, String) + 'static,
    ) {
        let items = vec![
            GraphMenuItem::info(" "),
            GraphMenuItem::info("Enter confirm · Esc cancel"),
        ];
        let width = menu_width(&items).max(28);
        let (columns, rows) = (i64::from(self.layout.width), i64::from(self.layout.height));
        self.remember_focus(app);
        self.widgets.overlay.prompt.set_value("");
        self.widgets.overlay.prompt.placeholder(placeholder);
        self.open_popup_with(
            MenuRequest {
                title: title.to_owned(),
                items,
                x: ((columns - width) / 2).max(0),
                y: ((rows - 4) / 2).max(0),
                selected: None,
                on_select: Box::new(|_, _, _| {}),
            },
            Some(Box::new(run)),
        );
        // `open` sizes the pane from the items alone. The prompt pane is at least 28 columns wide.
        if let Some(menu) = &mut self.overlay.menu {
            let pane = &mut menu.view.pane;
            let (left, top) =
                place_menu(pane.left, pane.top, width, pane.items.len(), columns, rows);
            pane.left = left;
            pane.top = top;
            pane.width = width;
        }
        self.sync_overlay(app);
        self.widgets.overlay.prompt.focus();
    }

    pub(crate) fn submit_name_prompt(&mut self, app: &App) {
        let value = self.widgets.overlay.prompt.value();
        let value = value.trim().to_owned();
        if self
            .overlay
            .menu
            .as_ref()
            .is_none_or(|menu| menu.prompt.is_none())
        {
            return;
        }
        if value.is_empty() {
            self.notify("A name is required".to_owned());
            return;
        }
        let Some(menu) = self.overlay.menu.take() else {
            return;
        };
        self.restore_focus(app);
        self.dirty |= Dirty::OVERLAY;
        if let Some(run) = menu.prompt {
            run(self, app, value);
        }
    }

    /// Opens the context menu for `target` at a terminal position. Needs a loaded snapshot.
    pub fn open_graph_menu(&mut self, x: i64, y: i64, target: GraphMenuTarget) {
        let Some(snapshot) = &self.snapshot else {
            return;
        };
        let built = build_graph_menu(&target, snapshot, self.commands.comparison_start.as_deref());
        self.open_popup(MenuRequest {
            title: built.title,
            items: built.items,
            x,
            y,
            selected: None,
            on_select: Box::new(move |shell, app, item| {
                if let Some(action) = item.action {
                    shell.run_menu_action(app, action, target);
                }
            }),
        });
    }

    /// Opens a submenu for `row` of the main pane. `openSubmenuFor`.
    fn open_submenu_for(&mut self, row: usize) {
        let (columns, rows) = (i64::from(self.layout.width), i64::from(self.layout.height));
        let Some(menu) = &mut self.overlay.menu else {
            return;
        };
        let view = &mut menu.view;
        let Some(items) = view
            .pane
            .items
            .get(row)
            .and_then(|item| item.submenu.clone())
        else {
            return;
        };
        if view
            .submenu
            .as_ref()
            .is_some_and(|pane| pane.parent == Some(row))
        {
            return;
        }
        let pane = place_pane(
            items,
            view.pane.left + view.pane.width,
            view.pane.top + 1 + row as i64,
            columns,
            rows,
        );
        view.submenu = Some(MenuPane {
            parent: Some(row),
            ..pane
        });
    }

    pub(crate) fn menu_hover(&mut self, x: i64, y: i64, in_submenu: bool) {
        let Some(menu) = &mut self.overlay.menu else {
            return;
        };
        let view = &mut menu.view;
        let Some(pane) = (if in_submenu {
            view.submenu.as_mut()
        } else {
            Some(&mut view.pane)
        }) else {
            return;
        };
        let row = menu_row_at(pane, x, y);
        if pane.hover == row {
            return;
        }
        pane.hover = row;
        if !in_submenu && let Some(row) = row {
            if view.submenu.as_ref().and_then(|pane| pane.parent) != Some(row) {
                view.submenu = None;
            }
            self.open_submenu_for(row);
        }
        self.dirty |= Dirty::OVERLAY;
    }

    pub(crate) fn menu_click(&mut self, app: &App, x: i64, y: i64, in_submenu: bool) {
        let Some(menu) = &self.overlay.menu else {
            return;
        };
        let Some(pane) = (if in_submenu {
            menu.view.submenu.as_ref()
        } else {
            Some(&menu.view.pane)
        }) else {
            return;
        };
        let Some(row) = menu_row_at(pane, x, y) else {
            return;
        };
        let item = pane.items[row].clone();
        if item.disabled {
            return;
        }
        if item.submenu.is_some() {
            self.open_submenu_for(row);
            self.dirty |= Dirty::OVERLAY;
            return;
        }
        self.choose(app, item);
    }

    /// Enter: the hovered item, or the first available one. `activate`.
    pub(crate) fn menu_activate(&mut self, app: &App) {
        let Some(menu) = &self.overlay.menu else {
            return;
        };
        if menu.prompt.is_some() {
            return;
        }
        let in_submenu = menu.view.submenu.is_some();
        let pane = menu.view.submenu.as_ref().unwrap_or(&menu.view.pane);
        let usable = |item: &GraphMenuItem| !item.disabled && !item.separator;
        let hovered = pane
            .hover
            .and_then(|row| pane.items.get(row).map(|item| (row, item)))
            .filter(|(_, item)| usable(item));
        let Some((row, item)) =
            hovered.or_else(|| pane.items.iter().enumerate().find(|(_, item)| usable(item)))
        else {
            return;
        };
        let item = item.clone();
        if item.submenu.is_some() && !in_submenu {
            self.open_submenu_for(row);
            self.dirty |= Dirty::OVERLAY;
            return;
        }
        self.choose(app, item);
    }

    /// Closes the popup, then runs the selection closure. `close(); select(item)`.
    fn choose(&mut self, app: &App, item: GraphMenuItem) {
        let Some(mut menu) = self.overlay.menu.take() else {
            return;
        };
        if menu.prompt.is_some() {
            self.restore_focus(app);
        }
        self.dirty |= Dirty::OVERLAY;
        if let Some(select) = menu.select.take() {
            select(self, app, item);
        }
    }

    pub(crate) fn popup_event(&mut self, app: &App, event: PopupEvent) {
        match event {
            PopupEvent::Dismiss => self.dismiss_overlay(app),
            PopupEvent::MenuHover { x, y, submenu } => {
                self.menu_hover(i64::from(x), i64::from(y), submenu)
            }
            PopupEvent::MenuClick { x, y, submenu } => {
                self.menu_click(app, i64::from(x), i64::from(y), submenu)
            }
            PopupEvent::PaletteHover { row } => self.palette_hover(row),
            PopupEvent::PaletteClick { row, button } => self.palette_click(app, row, button),
            PopupEvent::PaletteScroll(delta) => self.palette_move(delta as isize),
        }
    }

    /// Keys while an overlay is open. Returns true when the key is used up.
    pub(crate) fn overlay_key(&mut self, app: &App, key: &KeyEvent) -> bool {
        use opentui::input::KeyEventKind;
        if key.kind == KeyEventKind::Release {
            return self.overlay.is_open();
        }
        if self.overlay.palette.is_some() {
            if key.matches("ctrl+p") || key.matches("esc") || key.matches("escape") {
                self.close_palette(app, true);
            } else if key.matches("up") || key.matches("ctrl+k") {
                self.palette_move(-1);
            } else if key.matches("down") || key.matches("ctrl+n") {
                self.palette_move(1);
            } else if key.matches("pageup") {
                self.palette_page(-1);
            } else if key.matches("pagedown") {
                self.palette_page(1);
            }
            return true;
        }
        let Some(menu) = &self.overlay.menu else {
            return false;
        };
        // A menu or prompt owns Ctrl+P: opening the palette would drop the pending action.
        if key.matches("ctrl+p") {
            return true;
        }
        if key.matches("esc") || key.matches("escape") {
            self.close_popup(app);
            return true;
        }
        if menu.prompt.is_none() && (key.matches("enter") || key.matches("return")) {
            self.menu_activate(app);
            return true;
        }
        false
    }

    pub(crate) fn overlay_msg(&mut self, app: &App, msg: OverlayMsg) {
        match msg {
            OverlayMsg::Popup(event) => self.popup_event(app, event),
            OverlayMsg::PromptSubmit => self.submit_name_prompt(app),
            OverlayMsg::PaletteQuery => self.palette_query_changed(),
            OverlayMsg::PaletteSubmit => self.palette_activate(app),
            OverlayMsg::HistoryMenu {
                row,
                on_label,
                x,
                y,
            } => self.history_menu(app, row, on_label, i64::from(x), i64::from(y)),
            OverlayMsg::FileMenu { section, row, x, y } => {
                self.file_menu(app, section, row, i64::from(x), i64::from(y))
            }
        }
    }

    /// Pushes the overlay state into the widgets.
    pub(crate) fn sync_overlay(&mut self, _app: &App) {
        let (width, height) = (self.layout.width, self.layout.height);
        let overlay = &self.widgets.overlay;
        let _ = overlay
            .layer
            .width(u32::from(width))
            .height(u32::from(height));
        let mut prompt_at = None;
        let content = if let Some(menu) = &self.overlay.menu {
            if menu.prompt.is_some() {
                let pane = &menu.view.pane;
                prompt_at = Some((pane.left + 2, pane.top + 1, (pane.width - 4).max(8)));
            }
            PopupContent::Menu(menu.view.clone())
        } else if let Some(palette) = &self.overlay.palette {
            PopupContent::Palette(palette.view())
        } else {
            PopupContent::Hidden
        };
        let hidden = matches!(content, PopupContent::Hidden);
        let _ = overlay.layer.visible(!hidden);
        overlay.layer.update(|layer| layer.set_content(content));
        let _ = overlay.prompt.visible(prompt_at.is_some());
        if let Some((left, top, width)) = prompt_at {
            crate::sync::place(&overlay.prompt, left, top, width, 1);
        }
        let palette_at = self.overlay.palette.as_ref().map(|palette| {
            let view = palette.view();
            (view.left + 2, view.top + 1, (view.width - 4).max(1))
        });
        if let Some(palette) = &self.overlay.palette {
            overlay
                .palette_input
                .placeholder(palette.page.placeholder());
        }
        let _ = overlay.palette_input.visible(palette_at.is_some());
        if let Some((left, top, width)) = palette_at {
            crate::sync::place(&overlay.palette_input, left, top, width, 1);
        }
    }
}

#[cfg(test)]
#[path = "popup_tests.rs"]
mod tests;
