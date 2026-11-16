//! The vertical bar between two panes. Ports `makeDividerBar` in `src/ui/runtime-widgets.ts`. The glyphs come from
//! `vertical_divider_content`.
//!
//! The bar is one column wide. Every row is a thin line, except a short run in the middle that is a heavy line, so the
//! bar looks like a handle. Dragging and the hover color are not ported.

use opentui::prelude::*;
use tuig_ui_model::color::Rgba;
use tuig_ui_model::runtime_layout::vertical_divider_content;
use tuig_ui_model::theme::Theme;

fn to_color(color: Rgba) -> Color {
    Color::rgba(color.r, color.g, color.b, color.a)
}

pub struct Divider {
    theme: Theme,
}

impl Divider {
    pub fn new(theme: Theme) -> Self {
        Self { theme }
    }
}

impl Component for Divider {
    fn paint(&self, painter: &mut Painter<'_>) {
        let (_, height) = painter.size();
        let style = Style::new().fg(to_color(self.theme.divider));
        for (row, glyph) in vertical_divider_content(i64::from(height))
            .split('\n')
            .enumerate()
        {
            painter.text(0, row as i32, glyph, style);
        }
    }
}

#[cfg(test)]
#[path = "divider_tests.rs"]
mod tests;
