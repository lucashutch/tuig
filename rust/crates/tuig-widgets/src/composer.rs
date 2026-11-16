//! The composer's one-row buttons: the commit button and the amend toggle. Ports the `commit-button` and
//! `amend-toggle` text widgets of `src/ui/runtime-widgets.ts`, `buttonMouse`, and the colors of `applyActionTheme`
//! in `src/ui/runtime-theme.ts`.
//!
//! The press runs on release inside the button, as in TS. A hover handler on the widget sets the shared flag from
//! [`ComposerButton::hover_flag`], because a custom widget gets no pointer-leave event of its own.

use opentui::prelude::*;
use std::cell::Cell;
use std::rc::Rc;
use tuig_ui_model::color::Rgba;
use tuig_ui_model::text_width::string_width;
use tuig_ui_model::theme::{Surface, Theme, ThemeStates, interaction_background, semantic_color};

fn to_color(color: Rgba) -> Color {
    Color::rgba(color.r, color.g, color.b, color.a)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ButtonVariant {
    Primary,
    Secondary,
}

type PressHandler = Box<dyn FnMut(&mut Cx<'_>)>;

pub struct ComposerButton {
    theme: Theme,
    variant: ButtonVariant,
    /// The text color without a semantic token: `fallback` in `applyActionTheme`.
    fallback_fg: Rgba,
    /// The color behind the text at rest. Transparent keeps the composer's background.
    base_bg: Rgba,
    text: String,
    selected: bool,
    disabled: bool,
    hovered: Rc<Cell<bool>>,
    pressed: bool,
    /// The width of the last paint, for the release hit test.
    width: Cell<u32>,
    on_press: Option<PressHandler>,
}

impl ComposerButton {
    pub fn new(theme: Theme, variant: ButtonVariant, fallback_fg: Rgba, base_bg: Rgba) -> Self {
        Self {
            theme,
            variant,
            fallback_fg,
            base_bg,
            text: String::new(),
            selected: false,
            disabled: false,
            hovered: Rc::new(Cell::new(false)),
            pressed: false,
            width: Cell::new(0),
            on_press: None,
        }
    }

    /// The handler must not call `Custom::update` or `Custom::with` on this widget. Queue a message instead.
    pub fn on_press(&mut self, handler: impl FnMut(&mut Cx<'_>) + 'static) {
        self.on_press = Some(Box::new(handler));
    }

    /// Set from the widget's hover handler: `button.on_hover(move |cx, hovered| { flag.set(hovered); ... })`.
    pub fn hover_flag(&self) -> Rc<Cell<bool>> {
        self.hovered.clone()
    }

    /// Replaces the label and state. A disabled button ignores the pointer.
    pub fn set(&mut self, text: &str, selected: bool, disabled: bool) {
        self.text = text.to_owned();
        self.selected = selected;
        self.disabled = disabled;
    }

    pub fn text(&self) -> &str {
        &self.text
    }

    /// The text and background colors, as `applyActionTheme` computes them.
    fn colors(&self) -> (Rgba, Rgba) {
        let hovered = self.hovered.get() && !self.disabled;
        let pressed = self.pressed && !self.disabled;
        let states = ThemeStates {
            disabled: self.disabled,
            pressed,
            selected: self.selected,
            hovered,
            ..ThemeStates::default()
        };
        let (text, background) = match self.variant {
            ButtonVariant::Primary => ("text.action.primary", "background.action.primary"),
            ButtonVariant::Secondary => ("text.action.secondary", "background.action.secondary"),
        };
        let theme = &self.theme;
        let fg = semantic_color(
            theme,
            text,
            if self.disabled {
                theme.muted
            } else {
                self.fallback_fg
            },
            Surface::Default,
            states,
        );
        // `buttonMouse` passes only pressed and hovered to the interaction background.
        let resting = if self.disabled {
            self.base_bg
        } else {
            interaction_background(theme, self.base_bg, pressed, false, hovered)
        };
        let bg = semantic_color(theme, background, resting, Surface::Default, states);
        (fg, bg)
    }
}

impl Component for ComposerButton {
    fn paint(&self, painter: &mut Painter<'_>) {
        let (width, _) = painter.size();
        self.width.set(width);
        let (fg, bg) = self.colors();
        let mut style = Style::new().fg(to_color(fg));
        // A TS text widget paints its background under the text only.
        let covered = u32::try_from(string_width(&self.text))
            .unwrap_or(u32::MAX)
            .min(width);
        if bg.a > 0 {
            painter.fill(0, 0, covered, 1, to_color(bg));
            style = style.bg(to_color(bg));
        }
        painter.text(0, 0, &self.text, style);
    }

    fn mouse(&mut self, cx: &mut Cx<'_>, event: &MouseEvent, local: (i32, i32)) -> bool {
        match event.kind {
            MouseEventKind::Down(MouseButton::Left) if !self.disabled => {
                self.pressed = true;
                true
            }
            MouseEventKind::Up(MouseButton::Left) if self.pressed => {
                self.pressed = false;
                let inside = local.1 == 0 && local.0 >= 0 && (local.0 as u32) < self.width.get();
                if inside && let Some(handler) = self.on_press.as_mut() {
                    handler(cx);
                }
                true
            }
            _ => false,
        }
    }
}
