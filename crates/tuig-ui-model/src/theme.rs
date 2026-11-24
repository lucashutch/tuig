//! The theme type and semantic color lookup.
//!
//! The TypeScript `activeTheme` singleton, which mutates one shared object, is not ported. It is
//! rendering state, so the UI layer owns the current `Theme` value.

use crate::color::Rgba;
use serde_json::Value;
use std::collections::BTreeMap;

/// A node of the resolved semantic token tree: a color, or a group of named nodes. State
/// variants of a token sit in its group under `base`, `hovered`, `focused`, and so on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ColorNode {
    Color(Rgba),
    Group(BTreeMap<String, ColorNode>),
}

impl ColorNode {
    /// Convert a resolved JSON tree. Returns `None` if any leaf is not a color string.
    pub fn from_value(value: &Value) -> Option<ColorNode> {
        match value {
            Value::String(text) => Rgba::parse(text).map(ColorNode::Color),
            Value::Object(map) => map
                .iter()
                .map(|(key, item)| Some((key.clone(), ColorNode::from_value(item)?)))
                .collect::<Option<BTreeMap<_, _>>>()
                .map(ColorNode::Group),
            _ => None,
        }
    }

    pub fn get(&self, key: &str) -> Option<&ColorNode> {
        match self {
            ColorNode::Group(map) => map.get(key),
            ColorNode::Color(_) => None,
        }
    }

    pub fn color(&self) -> Option<Rgba> {
        match self {
            ColorNode::Color(color) => Some(*color),
            ColorNode::Group(_) => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SemanticTokens {
    pub tokens: ColorNode,
    pub dialog: ColorNode,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Theme {
    pub semantic: Option<SemanticTokens>,
    pub bg: Rgba,
    pub panel: Rgba,
    pub panel_raised: Rgba,
    pub border: Rgba,
    pub text: Rgba,
    pub muted: Rgba,
    pub accent: Rgba,
    pub accent_soft: Rgba,
    pub selected: Rgba,
    pub added: Rgba,
    pub deleted: Rgba,
    pub warning: Rgba,
    pub author: Rgba,
    pub divider: Rgba,
    /// Shared interaction colors: hover and pressed backgrounds, focus accent.
    pub hover: Rgba,
    pub pressed: Rgba,
    pub focus_ring: Rgba,
    pub folder: Rgba,
    pub folder_bg: Rgba,
    pub diff_added_bg: Rgba,
    pub diff_removed_bg: Rgba,
    pub graph: Vec<Rgba>,
    pub syntax: Option<BTreeMap<String, Rgba>>,
    pub diff: Option<BTreeMap<String, ColorNode>>,
}

const fn hex(value: u32) -> Rgba {
    Rgba::rgb((value >> 16) as u8, (value >> 8) as u8, value as u8)
}

/// The built-in default theme, "one-dark".
pub fn one_dark_theme() -> Theme {
    let syntax = [
        ("comment", 0x7F848E),
        ("keyword", 0xC678DD),
        ("function", 0x61AFEF),
        ("variable", 0xABB2BF),
        ("string", 0x98C379),
        ("number", 0xD19A66),
        ("type", 0xE5C07B),
        ("operator", 0x56B6C2),
        ("punctuation", 0xABB2BF),
    ];
    Theme {
        semantic: None,
        bg: hex(0x282C34),
        panel: hex(0x21252B),
        panel_raised: hex(0x2C313A),
        border: hex(0x5C6370),
        text: hex(0xABB2BF),
        muted: hex(0x5C6370),
        accent: hex(0x61AFEF),
        accent_soft: hex(0x56B6C2),
        selected: hex(0x3E4451),
        added: hex(0x98C379),
        deleted: hex(0xE06C75),
        warning: hex(0xE5C07B),
        author: hex(0xC678DD),
        divider: hex(0x2B5B61),
        hover: hex(0x353B45),
        pressed: hex(0x315878),
        focus_ring: hex(0x61AFEF),
        folder: hex(0x61AFEF),
        folder_bg: hex(0x2C313A),
        diff_added_bg: hex(0x30402F),
        diff_removed_bg: hex(0x462C31),
        graph: [0x61AFEF, 0xC678DD, 0xE5C07B, 0x98C379, 0xE06C75, 0x56B6C2]
            .map(hex)
            .to_vec(),
        syntax: Some(
            syntax
                .into_iter()
                .map(|(k, v)| (k.to_string(), hex(v)))
                .collect(),
        ),
        diff: None,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Surface {
    Default,
    Dialog,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ThemeStates {
    pub disabled: bool,
    pub pressed: bool,
    pub focused: bool,
    pub selected: bool,
    pub hovered: bool,
}

impl ThemeStates {
    /// The first set state, in the order disabled, pressed, focused, selected, hovered.
    fn first(self) -> &'static str {
        if self.disabled {
            "disabled"
        } else if self.pressed {
            "pressed"
        } else if self.focused {
            "focused"
        } else if self.selected {
            "selected"
        } else if self.hovered {
            "hovered"
        } else {
            "base"
        }
    }
}

/// Look up a semantic token such as `text.action.primary`. A token that is a group yields its
/// `base` color, or the variant for the first set state. Anything missing yields `fallback`.
pub fn semantic_color(
    theme: &Theme,
    path: &str,
    fallback: Rgba,
    surface: Surface,
    states: ThemeStates,
) -> Rgba {
    let Some(semantic) = &theme.semantic else {
        return fallback;
    };
    let source = match surface {
        Surface::Dialog => &semantic.dialog,
        Surface::Default => &semantic.tokens,
    };
    let mut node = source;
    for key in path.split('.') {
        match node.get(key) {
            Some(next) => node = next,
            None => return fallback,
        }
    }
    match node {
        ColorNode::Color(color) => *color,
        ColorNode::Group(_) => node
            .get(states.first())
            .and_then(ColorNode::color)
            .unwrap_or(fallback),
    }
}

/// Background for any interactive element. Pressed beats selected, and selected beats hovered
/// so a selected row keeps its color under the pointer.
pub fn interaction_background(
    theme: &Theme,
    base: Rgba,
    pressed: bool,
    selected: bool,
    hovered: bool,
) -> Rgba {
    if pressed {
        theme.pressed
    } else if selected {
        theme.selected
    } else if hovered {
        theme.hover
    } else {
        base
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pressed_beats_selected_and_selected_beats_hovered() {
        let theme = one_dark_theme();
        let base = Rgba::rgb(1, 2, 3);
        assert_eq!(
            interaction_background(&theme, base, true, true, true),
            theme.pressed
        );
        assert_eq!(
            interaction_background(&theme, base, false, true, true),
            theme.selected
        );
        assert_eq!(
            interaction_background(&theme, base, false, false, true),
            theme.hover
        );
        assert_eq!(
            interaction_background(&theme, base, false, false, false),
            base
        );
    }

    #[test]
    fn a_theme_without_semantic_tokens_uses_the_fallback() {
        let fallback = Rgba::rgb(9, 9, 9);
        let theme = one_dark_theme();
        assert_eq!(
            semantic_color(
                &theme,
                "text.base",
                fallback,
                Surface::Default,
                Default::default()
            ),
            fallback
        );
    }
}
