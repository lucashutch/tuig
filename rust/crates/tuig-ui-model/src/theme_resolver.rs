//! Resolve an OpenCode V2 semantic theme document into colors.
//!
//! OpenCode V2 semantics: anomalyco/opencode 8b24fc8c2af625c8bffa04150f8d0aa25264bed3.
//! See `src/ui/themes/LICENSE` for the upstream MIT notice.
//!
//! The document is dynamic JSON, so this port works on `serde_json::Value` with the same steps
//! and error messages as the TypeScript resolver.

use crate::color::Rgba;
use crate::theme::{ColorNode, SemanticTokens, Theme};
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::fmt;

type Node = Map<String, Value>;

const STATES: [&str; 5] = ["hovered", "focused", "pressed", "selected", "disabled"];
const SYNTAX_TOKENS: [&str; 9] = [
    "comment",
    "keyword",
    "function",
    "variable",
    "string",
    "number",
    "type",
    "operator",
    "punctuation",
];
const MARKDOWN_TOKENS: [&str; 14] = [
    "text",
    "heading",
    "link",
    "linkText",
    "code",
    "blockQuote",
    "emphasis",
    "strong",
    "horizontalRule",
    "listItem",
    "listEnumeration",
    "image",
    "imageText",
    "codeBlock",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThemeMode {
    Dark,
    Light,
}

impl ThemeMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Dark => "dark",
            Self::Light => "light",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThemeError(pub String);

impl fmt::Display for ThemeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ThemeError {}

type Result<T> = std::result::Result<T, ThemeError>;

fn fail<T>(message: impl Into<String>) -> Result<T> {
    Err(ThemeError(message.into()))
}

fn is_hex(value: &str) -> bool {
    value.strip_prefix('#').is_some_and(|digits| {
        matches!(digits.len(), 3 | 4 | 6 | 8) && digits.bytes().all(|b| b.is_ascii_hexdigit())
    })
}

/// JavaScript's `.` does not match line terminators.
fn no_line_terminator(value: &str) -> bool {
    !value
        .chars()
        .any(|c| matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}'))
}

/// `/^\$.+/`
fn dollar_reference(value: &str) -> bool {
    value
        .strip_prefix('$')
        .and_then(|rest| rest.chars().next())
        .is_some_and(|c| no_line_terminator(&c.to_string()))
}

/// `/^\$hue\..+$/`
fn hue_alias(value: &str) -> bool {
    value
        .strip_prefix("$hue.")
        .is_some_and(|rest| !rest.is_empty() && no_line_terminator(rest))
}

/// `^hue\.(.+)\.(100|200|...|900)$` on a reference without its leading `$`. Returns the hue
/// name and the step.
fn hue_step_reference(target: &str) -> Option<(&str, &str)> {
    let rest = target.strip_prefix("hue.")?;
    let (name, step) = rest.rsplit_once('.')?;
    let valid_step = matches!(
        step,
        "100" | "200" | "300" | "400" | "500" | "600" | "700" | "800" | "900"
    );
    (valid_step && !name.is_empty() && no_line_terminator(name)).then_some((name, step))
}

fn hue_or_hex(value: &str) -> bool {
    is_hex(value)
        || value
            .strip_prefix('$')
            .and_then(hue_step_reference)
            .is_some()
}

fn read<'a>(source: &'a Node, path: &str) -> Option<&'a Value> {
    let mut parts = path.split('.');
    let mut node = source.get(parts.next()?)?;
    for key in parts {
        node = node.as_object()?.get(key)?;
    }
    Some(node)
}

fn validate_base(base: &Node) -> Result<()> {
    let mut paths: Vec<String> = [
        "text.base",
        "text.muted",
        "background.base",
        "background.raised.base",
        "background.raised.high",
        "background.raised.max",
        "border.base",
        "scrollbar.base",
        "diff.text.added",
        "diff.text.removed",
        "diff.text.context",
        "diff.text.hunkHeader",
        "diff.background.added",
        "diff.background.removed",
        "diff.background.context",
        "diff.highlight.added",
        "diff.highlight.removed",
        "diff.lineNumber.text",
        "diff.lineNumber.background.added",
        "diff.lineNumber.background.removed",
    ]
    .map(String::from)
    .to_vec();
    for group in ["text", "background"] {
        paths.push(format!("{group}.formfield.base"));
        for variant in ["primary", "secondary", "destructive"] {
            paths.push(format!("{group}.action.{variant}.base"));
        }
        for kind in ["error", "warning", "success", "info"] {
            paths.push(format!("{group}.feedback.{kind}.base"));
        }
    }
    for path in paths {
        let valid = read(base, &path)
            .and_then(Value::as_str)
            .is_some_and(|value| {
                is_hex(value) || value == "transparent" || dollar_reference(value)
            });
        if !valid {
            return fail(format!("Invalid theme: missing or invalid base.{path}"));
        }
    }
    for (group, tokens) in [
        ("syntax", &SYNTAX_TOKENS[..]),
        ("markdown", &MARKDOWN_TOKENS[..]),
    ] {
        for token in tokens {
            let valid = read(base, &format!("{group}.{token}"))
                .and_then(Value::as_str)
                .is_some_and(hue_or_hex);
            if !valid {
                return fail(format!(
                    "Invalid theme: missing or invalid base.{group}.{token}"
                ));
            }
        }
    }
    validate_categorical(base.get("categorical"))
}

fn validate_categorical(value: Option<&Value>) -> Result<()> {
    let valid = value.and_then(Value::as_array).is_some_and(|names| {
        !names.is_empty()
            && names
                .iter()
                .all(|name| name.as_str().is_some_and(|n| !n.is_empty()))
    });
    if valid {
        Ok(())
    } else {
        fail("Invalid categorical hues: expected a nonempty list of hue names")
    }
}

fn scale_steps() -> impl Iterator<Item = String> {
    (1..=9).map(|n| (n * 100).to_string())
}

fn validate_mode(mode: &Value, name: &str) -> Result<()> {
    let Some(hues) = mode.get("hue").and_then(Value::as_object) else {
        return fail(format!("Invalid theme: {name} must provide hue scales"));
    };
    let mode = mode
        .as_object()
        .expect("mode has a hue member, so it is an object");
    for semantic in ["accent", "interactive", "neutral"] {
        if !hues.contains_key(semantic) {
            return fail(format!("Missing required semantic hue: {name}.{semantic}"));
        }
    }
    for (hue_name, value) in hues {
        if hue_name.is_empty() {
            return fail("Invalid empty hue name");
        }
        if value.as_str().is_some_and(hue_alias) {
            continue;
        }
        let Some(scale) = value.as_object().filter(|scale| scale.len() == 9) else {
            return fail(format!("Invalid hue scale: {name}.{hue_name}"));
        };
        for step in scale_steps() {
            if !scale.get(&step).and_then(Value::as_str).is_some_and(is_hex) {
                return fail(format!("Invalid hue color: {name}.{hue_name}.{step}"));
            }
        }
    }
    if mode.contains_key("categorical") {
        validate_categorical(mode.get("categorical"))?;
    }
    for group in ["syntax", "markdown"] {
        if let Some(tokens) = mode.get(group).and_then(Value::as_object) {
            for (token, value) in tokens {
                if !value.as_str().is_some_and(hue_or_hex) {
                    return fail(format!("Invalid {name}.{group}.{token}"));
                }
            }
        }
    }
    Ok(())
}

/// Deep merge. Later values win, and nested objects merge key by key.
pub fn merge_theme(values: &[Option<&Value>]) -> Result<Node> {
    let mut result = Node::new();
    for value in values.iter().flatten() {
        let Some(object) = value.as_object() else {
            continue;
        };
        for (key, item) in object {
            if matches!(key.as_str(), "__proto__" | "prototype" | "constructor") {
                return fail(format!("Unsafe theme key: {key}"));
            }
            let merged = if item.is_object() {
                Value::Object(merge_theme(&[result.get(key), Some(item)])?)
            } else {
                item.clone()
            };
            result.insert(key.clone(), merged);
        }
    }
    Ok(result)
}

/// JavaScript truthiness of a JSON value.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `^(text|background)\.(action\.[^.]+|formfield)$`
fn is_state_token_path(path: &str) -> bool {
    let Some(rest) = path
        .strip_prefix("text.")
        .or_else(|| path.strip_prefix("background."))
    else {
        return false;
    };
    rest == "formfield"
        || rest
            .strip_prefix("action.")
            .is_some_and(|name| !name.is_empty() && !name.contains('.'))
}

/// `^text\.feedback\.[^.]+$`
fn is_feedback_path(path: &str) -> bool {
    path.strip_prefix("text.feedback.")
        .is_some_and(|name| !name.is_empty() && !name.contains('.'))
}

/// Give each action and formfield token a default for every state, and `text` groups a
/// default `muted`.
fn expand(value: &Node, path: &str) -> Result<Node> {
    let mut result = merge_theme(&[Some(&Value::Object(value.clone()))])?;
    let keys: Vec<String> = result.keys().cloned().collect();
    for key in keys {
        if let Some(Value::Object(child)) = result.get(&key) {
            let child_path = if path.is_empty() {
                key.clone()
            } else {
                format!("{path}.{key}")
            };
            let expanded = expand(&child.clone(), &child_path)?;
            result.insert(key, Value::Object(expanded));
        }
    }
    if result.get("base").is_some_and(Value::is_string) && is_state_token_path(path) {
        for state in STATES {
            let key = format!("${state}");
            if result.get(&key).is_none_or(Value::is_null) {
                result.insert(key, Value::String(format!("${path}.base")));
            }
        }
    }
    let wants_muted = (path == "text" || is_feedback_path(path))
        && result.get("muted").is_none_or(Value::is_null);
    if wants_muted {
        if result.get("base").is_some_and(truthy) {
            result.insert("muted".into(), Value::String(format!("${path}.base")));
        } else {
            result.shift_remove("muted");
        }
    }
    Ok(result)
}

#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedThemeDocument {
    pub categorical: Vec<String>,
    pub tokens: Node,
    pub dialog: Node,
    pub mode: ThemeMode,
}

fn resolve_hue(hues: &Node, name: &str, stack: &[String]) -> Result<Node> {
    if stack.iter().any(|seen| seen == name) {
        let chain: Vec<&str> = stack.iter().map(String::as_str).chain([name]).collect();
        return fail(format!("Circular hue reference: {}", chain.join(" -> ")));
    }
    match hues.get(name) {
        Some(Value::String(alias)) => {
            let Some(target) = alias.strip_prefix("$hue.") else {
                return fail(format!("Invalid hue alias: {alias}"));
            };
            let mut next = stack.to_vec();
            next.push(name.to_string());
            resolve_hue(hues, target, &next)
        }
        Some(Value::Object(scale)) => {
            if scale.len() != 9 {
                return fail(format!("Invalid hue scale: {name}"));
            }
            for step in scale_steps() {
                if !scale.get(&step).and_then(Value::as_str).is_some_and(is_hex) {
                    return fail(format!("Invalid hue color: {name}.{step}"));
                }
            }
            Ok(scale.clone())
        }
        _ => fail(format!("Missing hue: {name}")),
    }
}

/// Replace each `$reference` with the color it points to. `$hue.<name>.<step>` reads a hue scale.
fn resolve_tokens(source: &Node) -> Result<Node> {
    fn walk(source: &Node, value: &Value, stack: &[String]) -> Result<Value> {
        if let Value::Object(object) = value {
            let mut out = Node::new();
            for (key, item) in object {
                let renamed = match key.strip_prefix('$') {
                    Some(state) if STATES.contains(&state) => state,
                    _ => key,
                };
                out.insert(renamed.to_string(), walk(source, item, stack)?);
            }
            return Ok(Value::Object(out));
        }
        let Value::String(text) = value else {
            return fail("Invalid theme color");
        };
        if text == "transparent" || is_hex(text) {
            return Ok(value.clone());
        }
        let Some(target) = text.strip_prefix('$') else {
            return fail(format!("Invalid theme color: {text}"));
        };
        if stack.iter().any(|seen| seen == target) {
            let chain: Vec<&str> = stack.iter().map(String::as_str).chain([target]).collect();
            return fail(format!("Circular theme reference: {}", chain.join(" -> ")));
        }
        let found = match hue_step_reference(target) {
            Some((name, step)) => source
                .get("hue")
                .and_then(Value::as_object)
                .and_then(|scales| scales.get(name))
                .and_then(Value::as_object)
                .and_then(|scale| scale.get(step)),
            None => read(source, target),
        };
        let Some(found) = found else {
            return fail(format!("Theme reference {text} was not found"));
        };
        let mut next = stack.to_vec();
        next.push(target.to_string());
        match walk(source, found, &next)? {
            resolved @ Value::String(_) => Ok(resolved),
            _ => fail(format!("Theme reference {text} is not a color")),
        }
    }
    match walk(source, &Value::Object(source.clone()), &[])? {
        Value::Object(node) => Ok(node),
        _ => unreachable!("walking an object gives an object"),
    }
}

pub fn resolve_theme_document(input: &Value, mode: ThemeMode) -> Result<ResolvedThemeDocument> {
    let Some(base) = input.get("base").and_then(Value::as_object) else {
        return fail("Invalid theme: expected base and at least one mode");
    };
    validate_base(base)?;
    for name in ["light", "dark"] {
        if let Some(mode_value) = input.get(name) {
            validate_mode(mode_value, name)?;
        }
    }
    let is_record = |name: &str| input.get(name).is_some_and(Value::is_object);
    let selected = if is_record(mode.as_str()) {
        mode
    } else if is_record("light") {
        ThemeMode::Light
    } else {
        ThemeMode::Dark
    };
    let Some(selected_mode) = input.get(selected.as_str()).filter(|v| v.is_object()) else {
        return fail("Theme must provide at least one mode");
    };
    let mut merged = merge_theme(&[input.get("base"), Some(selected_mode)])?;
    let Some(Value::Object(hues)) = merged.get("hue").cloned() else {
        return fail("Invalid theme: mode must provide hue scales");
    };
    let mut resolved_hues = Node::new();
    for name in hues.keys() {
        resolved_hues.insert(name.clone(), Value::Object(resolve_hue(&hues, name, &[])?));
    }
    let categorical_names: Vec<String> = match merged.get("categorical").and_then(Value::as_array) {
        Some(names)
            if !names.is_empty()
                && names.iter().all(|name| {
                    name.as_str()
                        .is_some_and(|n| resolved_hues.get(n).is_some_and(Value::is_object))
                }) =>
        {
            names
                .iter()
                .filter_map(|n| n.as_str().map(String::from))
                .collect()
        }
        _ => return fail("Invalid categorical hues"),
    };
    let categorical: Vec<String> = categorical_names
        .iter()
        .map(|name| {
            resolved_hues[name]["200"]
                .as_str()
                .unwrap_or_default()
                .to_string()
        })
        .collect();
    merged.insert("hue".into(), Value::Object(resolved_hues));
    for group in [
        "text",
        "background",
        "border",
        "scrollbar",
        "diff",
        "syntax",
        "markdown",
    ] {
        if !merged.get(group).is_some_and(Value::is_object) {
            return fail(format!("Invalid theme: missing {group}"));
        }
    }
    let overrides = merged.shift_remove("@dialog");
    merged.shift_remove("categorical");
    let base = expand(&merged, "")?;
    let surface = match &overrides {
        Some(Value::Object(object)) => expand(object, "")?,
        _ => Node::new(),
    };
    let mut dialog = merge_theme(&[
        Some(&Value::Object(base.clone())),
        Some(&Value::Object(surface.clone())),
    ])?;
    for group in ["text", "background"] {
        let actions_of = |node: &Node| {
            node.get(group)?
                .as_object()?
                .get("action")?
                .as_object()
                .cloned()
        };
        let (Some(base_actions), Some(surface_actions)) = (actions_of(&base), actions_of(&surface))
        else {
            continue;
        };
        let Some(Value::Object(actions)) = dialog
            .get_mut(group)
            .and_then(Value::as_object_mut)
            .and_then(|group| group.get_mut("action"))
        else {
            continue;
        };
        for (variant, over) in &surface_actions {
            let (Some(over), Some(original)) = (
                over.as_object(),
                base_actions.get(variant).and_then(Value::as_object),
            ) else {
                continue;
            };
            let mut replacement = Node::new();
            let keys =
                std::iter::once("base".to_string()).chain(STATES.iter().map(|s| format!("${s}")));
            for key in keys {
                let value = [
                    over.get(&key),
                    over.get("base"),
                    original.get(&key),
                    original.get("base"),
                ]
                .into_iter()
                .flatten()
                .find(|v| !v.is_null());
                if let Some(value) = value {
                    replacement.insert(key, value.clone());
                }
            }
            actions.insert(variant.clone(), Value::Object(replacement));
        }
    }
    Ok(ResolvedThemeDocument {
        tokens: resolve_tokens(&base)?,
        dialog: resolve_tokens(&dialog)?,
        mode: selected,
        categorical,
    })
}

/// Build the app `Theme` from a theme document.
pub fn theme_from_document(input: &Value, mode: ThemeMode) -> Result<Theme> {
    let ResolvedThemeDocument {
        tokens,
        dialog,
        categorical,
        ..
    } = resolve_theme_document(input, mode)?;
    let color = |path: &str| -> Result<Rgba> {
        let mut parts = path.split('.');
        let mut node = parts.next().and_then(|key| tokens.get(key));
        for key in parts {
            node = node.and_then(|n| n.as_object()).and_then(|n| n.get(key));
        }
        match node.and_then(Value::as_str) {
            Some(text) => {
                Rgba::parse(text).map_or_else(|| fail(format!("Invalid theme color: {text}")), Ok)
            }
            None => fail(format!("Invalid theme: missing {path}")),
        }
    };
    for group in ["text", "background"] {
        color(&format!("{group}.base"))?;
        for variant in ["primary", "secondary", "destructive"] {
            color(&format!("{group}.action.{variant}.base"))?;
        }
        color(&format!("{group}.formfield.base"))?;
        for kind in ["error", "warning", "success", "info"] {
            color(&format!("{group}.feedback.{kind}.base"))?;
        }
    }
    for path in [
        "scrollbar.base",
        "background.raised.max",
        "diff.text.context",
        "diff.text.hunkHeader",
        "diff.background.context",
        "diff.highlight.added",
        "diff.highlight.removed",
        "diff.lineNumber.text",
        "diff.lineNumber.background.added",
        "diff.lineNumber.background.removed",
    ] {
        color(path)?;
    }
    for token in SYNTAX_TOKENS {
        color(&format!("syntax.{token}"))?;
    }
    let graph = categorical
        .iter()
        .map(|text| {
            Rgba::parse(text).map_or_else(|| fail(format!("Invalid theme color: {text}")), Ok)
        })
        .collect::<Result<Vec<_>>>()?;
    let tree = |node: Node| {
        ColorNode::from_value(&Value::Object(node)).map_or_else(|| fail("Invalid theme color"), Ok)
    };
    let syntax: BTreeMap<String, Rgba> = tokens["syntax"]
        .as_object()
        .into_iter()
        .flatten()
        .filter_map(|(key, value)| Some((key.clone(), Rgba::parse(value.as_str()?)?)))
        .collect();
    let diff = match ColorNode::from_value(&tokens["diff"]) {
        Some(ColorNode::Group(map)) => map,
        _ => return fail("Invalid theme color"),
    };
    Ok(Theme {
        graph,
        bg: color("background.base")?,
        panel: color("background.raised.base")?,
        panel_raised: color("background.raised.high")?,
        border: color("border.base")?,
        text: color("text.base")?,
        muted: color("text.muted")?,
        accent: color("text.action.primary.base")?,
        accent_soft: color("text.feedback.info.base")?,
        selected: color("background.raised.high")?,
        added: color("text.feedback.success.base")?,
        deleted: color("text.feedback.error.base")?,
        warning: color("text.feedback.warning.base")?,
        author: color("syntax.keyword")?,
        divider: color("border.base")?,
        // The bundled action tokens are transparent or equal to the panel, so hover and
        // pressed use surfaces that stay visible on every pane.
        hover: color("background.raised.high")?,
        pressed: color("border.base")?,
        focus_ring: color("text.action.primary.base")?,
        folder: color("text.action.primary.base")?,
        folder_bg: color("background.raised.base")?,
        diff_added_bg: color("diff.background.added")?,
        diff_removed_bg: color("diff.background.removed")?,
        syntax: Some(syntax),
        diff: Some(diff),
        semantic: Some(SemanticTokens {
            tokens: tree(tokens.clone())?,
            dialog: tree(dialog)?,
        }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::theme::{Surface, ThemeStates, one_dark_theme, semantic_color};
    use crate::themes::opencode_document;
    use serde_json::json;

    fn rgb(hex: &str) -> Rgba {
        Rgba::parse(hex).unwrap()
    }

    fn document() -> Value {
        opencode_document().clone()
    }

    /// Set or add the member at `pointer`.
    fn set(doc: &mut Value, pointer: &str, value: Value) {
        let (parent, key) = pointer.rsplit_once('/').unwrap();
        let parent = doc
            .pointer_mut(parent)
            .unwrap_or_else(|| panic!("no {parent}"));
        parent
            .as_object_mut()
            .unwrap()
            .insert(key.to_string(), value);
    }

    fn remove(doc: &mut Value, parent: &str, key: &str) {
        doc.pointer_mut(parent)
            .unwrap()
            .as_object_mut()
            .unwrap()
            .shift_remove(key);
    }

    fn color(theme: &Theme, path: &str, surface: Surface, states: ThemeStates) -> Rgba {
        semantic_color(theme, path, rgb("#010203"), surface, states)
    }

    fn state(name: &str) -> ThemeStates {
        let mut states = ThemeStates::default();
        match name {
            "hovered" => states.hovered = true,
            "focused" => states.focused = true,
            _ => unreachable!(),
        }
        states
    }

    fn error(doc: &Value, mode: ThemeMode) -> String {
        resolve_theme_document(doc, mode)
            .expect_err("document should be rejected")
            .0
    }

    #[test]
    fn resolves_the_complete_upstream_fixture_in_both_modes() {
        let doc = document();
        assert_eq!(
            theme_from_document(&doc, ThemeMode::Dark).unwrap().bg,
            rgb("#0a0a0a")
        );
        let light = theme_from_document(&doc, ThemeMode::Light).unwrap();
        assert_eq!(light.bg, rgb("#ffffff"));
        assert_eq!(light.syntax.unwrap()["function"], rgb("#3b7dd8"));
    }

    #[test]
    fn falls_back_to_the_available_mode_without_changing_the_input() {
        let mut doc = document();
        doc.as_object_mut().unwrap().shift_remove("dark");
        let before = doc.clone();
        assert_eq!(
            resolve_theme_document(&doc, ThemeMode::Dark).unwrap().mode,
            ThemeMode::Light
        );
        assert_eq!(doc, before);
    }

    #[test]
    fn defaults_states_and_resolves_dialog_references_in_the_dialog_context() {
        let result = resolve_theme_document(&document(), ThemeMode::Dark).unwrap();
        assert_eq!(
            result.tokens["text"]["action"]["secondary"]["pressed"],
            "#808080"
        );
        assert_eq!(result.dialog["background"]["base"], "#141414");
        assert_eq!(result.dialog["background"]["formfield"]["base"], "#141414");
        assert_eq!(
            result.dialog["background"]["action"]["primary"]["hovered"],
            "#1e1e1e"
        );
    }

    #[test]
    fn reports_missing_references_and_token_and_hue_cycles() {
        let mut doc = document();
        set(&mut doc, "/base/text/base", json!("$text.missing"));
        assert!(error(&doc, ThemeMode::Light).contains("was not found"));
        set(&mut doc, "/base/text/base", json!("$text.muted"));
        set(&mut doc, "/base/text/muted", json!("$text.base"));
        assert!(error(&doc, ThemeMode::Light).contains("Circular theme reference"));
        let mut cycle = document();
        set(&mut cycle, "/dark/hue/accent", json!("$hue.interactive"));
        set(&mut cycle, "/dark/hue/interactive", json!("$hue.accent"));
        assert!(error(&cycle, ThemeMode::Dark).contains("Circular hue reference"));
    }

    #[test]
    fn keeps_action_colors_independent_from_syntax_and_uses_state_priority() {
        let mut doc = document();
        set(&mut doc, "/base/text/action/primary/base", json!("#123456"));
        set(&mut doc, "/base/text/feedback/info/base", json!("#234567"));
        set(
            &mut doc,
            "/base/text/feedback/success/base",
            json!("#456789"),
        );
        set(&mut doc, "/base/text/feedback/error/base", json!("#56789a"));
        set(
            &mut doc,
            "/base/background/action/primary/$focused",
            json!("#345678"),
        );
        let theme = theme_from_document(&doc, ThemeMode::Dark).unwrap();
        assert_eq!(theme.accent, rgb("#123456"));
        assert_eq!(theme.accent_soft, rgb("#234567"));
        assert_eq!(theme.selected, rgb("#1e1e1e"));
        assert_eq!(
            color(
                &theme,
                "background.action.primary",
                Surface::Default,
                state("focused")
            ),
            rgb("#345678")
        );
        assert_eq!(theme.syntax.as_ref().unwrap()["function"], rgb("#fab283"));
        assert_eq!(
            (theme.added, theme.deleted),
            (rgb("#456789"), rgb("#56789a"))
        );
        assert_eq!(
            (theme.hover, theme.pressed),
            (theme.panel_raised, theme.border)
        );
        assert_eq!(
            (theme.folder, theme.focus_ring),
            (rgb("#123456"), rgb("#123456"))
        );
        let all = ThemeStates {
            disabled: true,
            pressed: true,
            focused: true,
            selected: true,
            hovered: true,
        };
        assert_eq!(
            color(&theme, "text.action.primary", Surface::Default, all),
            rgb("#808080")
        );
        assert_eq!(
            color(
                &theme,
                "text.base",
                Surface::Default,
                ThemeStates::default()
            ),
            rgb("#eeeeee")
        );
        assert_eq!(
            color(&theme, "missing", Surface::Default, ThemeStates::default()),
            rgb("#010203")
        );
        let one_dark = one_dark_theme();
        assert_eq!(
            color(
                &one_dark,
                "text.base",
                Surface::Default,
                ThemeStates::default()
            ),
            rgb("#010203")
        );
    }

    #[test]
    fn validates_base_categorical_hues_and_every_mode_semantic_hue() {
        let mut doc = document();
        set(&mut doc, "/base/categorical", json!([]));
        assert!(error(&doc, ThemeMode::Dark).contains("categorical"));

        let mut doc = document();
        remove(&mut doc, "/light/hue", "accent");
        assert!(error(&doc, ThemeMode::Dark).contains("semantic hue"));

        let mut doc = document();
        remove(&mut doc, "/base/markdown", "codeBlock");
        assert!(error(&doc, ThemeMode::Dark).contains("base.markdown.codeBlock"));

        // A mode cannot supply a color the base theme lacks.
        let mut doc = document();
        remove(&mut doc, "/base/text/action/primary", "base");
        set(
            &mut doc,
            "/dark/text",
            json!({ "action": { "primary": { "base": "#abcdef" } } }),
        );
        assert!(error(&doc, ThemeMode::Dark).contains("base.text.action.primary.base"));
    }

    #[test]
    fn accepts_three_semantic_scales_and_dotted_hue_aliases() {
        let doc = document();
        // Point every base hue reference at the neutral scale, so a mode needs only three hues.
        let text = doc["base"].to_string();
        let mut base: Value = serde_json::from_str(&regex_free_neutral(&text)).unwrap();
        base["categorical"] = json!(["neutral"]);
        let dark = &doc["dark"]["hue"];
        let minimum = json!({ "base": base, "dark": { "hue": {
            "accent": dark["purple"], "interactive": dark["orange"], "neutral": dark["gray"],
        } } });
        assert_eq!(
            theme_from_document(&minimum, ThemeMode::Dark).unwrap().bg,
            rgb("#0a0a0a")
        );

        let mut dotted = minimum.clone();
        dotted["dark"]["hue"] = json!({
            "brand.primary": dark["blue"], "brand.alias": "$hue.brand.primary",
            "accent": "$hue.brand.alias", "interactive": "$hue.brand.primary", "neutral": dark["gray"],
        });
        set(
            &mut dotted,
            "/base/syntax/function",
            json!("$hue.brand.alias.200"),
        );
        let theme = theme_from_document(&dotted, ThemeMode::Dark).unwrap();
        assert_eq!(theme.syntax.unwrap()["function"], rgb("#5c9cf5"));
    }

    /// Replace every `$hue.<name>.<step>` with `$hue.neutral.<step>`.
    fn regex_free_neutral(text: &str) -> String {
        let mut out = String::new();
        let mut rest = text;
        while let Some(at) = rest.find("$hue.") {
            out.push_str(&rest[..at]);
            let after = &rest[at + 5..];
            let dot = after.find('.').unwrap();
            out.push_str("$hue.neutral");
            rest = &after[dot..];
        }
        out.push_str(rest);
        out
    }

    #[test]
    fn reads_source_state_references_with_dollar_keys() {
        let mut doc = document();
        set(
            &mut doc,
            "/base/text/action/primary/base",
            json!("$text.action.secondary.$hovered"),
        );
        let theme = theme_from_document(&doc, ThemeMode::Dark).unwrap();
        assert_eq!(
            color(
                &theme,
                "text.action.primary",
                Surface::Default,
                ThemeStates::default()
            ),
            rgb("#eeeeee")
        );
    }

    #[test]
    fn dialog_action_base_replaces_inherited_states_and_re_resolves_references() {
        let mut doc = document();
        set(
            &mut doc,
            "/base/background/action/primary/$hovered",
            json!("#111111"),
        );
        set(
            &mut doc,
            "/base/@dialog/background/action",
            json!({ "primary": { "base": "#222222" } }),
        );
        set(
            &mut doc,
            "/base/@dialog/background/raised",
            json!({ "base": "#333333" }),
        );
        let theme = theme_from_document(&doc, ThemeMode::Dark).unwrap();
        let dialog = |path: &str, states| color(&theme, path, Surface::Dialog, states);
        assert_eq!(
            dialog("background.action.primary", state("hovered")),
            rgb("#222222")
        );
        assert_eq!(
            dialog("background.base", ThemeStates::default()),
            rgb("#333333")
        );
        assert_eq!(
            dialog("background.formfield", ThemeStates::default()),
            rgb("#333333")
        );
        // The default surface keeps its own override.
        assert_eq!(
            color(
                &theme,
                "background.action.primary",
                Surface::Default,
                state("hovered")
            ),
            rgb("#111111")
        );
    }

    #[test]
    fn rejects_unsafe_keys() {
        let mut doc = document();
        doc["dark"]["constructor"] = json!({});
        assert!(error(&doc, ThemeMode::Dark).contains("Unsafe theme key"));
    }
}
