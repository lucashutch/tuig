//! Bundled theme documents: the OpenCode V2 semantic theme and the OpenCode terminal palettes.
//!
//! Both come from `assets/themes/`, the files the TypeScript app reads, so there is one copy of
//! the color data. `palettes.json` holds resolved light and dark colors, and `opencode.json` the
//! semantic token tree. The palettes are adapted to the V2 token tree as `builtins.ts` does:
//! surfaces, text, borders, feedback, diffs, and syntax keep their source colors, and hue scales
//! mix each palette color with the background.

use serde_json::{Map, Value};
use std::sync::OnceLock;

const OPENCODE: &str = include_str!("../../../assets/themes/opencode.json");
const PALETTES: &str = include_str!("../../../assets/themes/palettes.json");

/// The upstream OpenCode V2 theme document.
pub fn opencode_document() -> &'static Value {
    static DOCUMENT: OnceLock<Value> = OnceLock::new();
    DOCUMENT.get_or_init(|| serde_json::from_str(OPENCODE).expect("opencode.json is valid JSON"))
}

/// The bundled palette themes as V2 documents, in `palettes.json` order.
pub fn builtin_theme_documents() -> &'static [(String, Value)] {
    static DOCUMENTS: OnceLock<Vec<(String, Value)>> = OnceLock::new();
    DOCUMENTS.get_or_init(|| {
        let palettes: Map<String, Value> =
            serde_json::from_str(PALETTES).expect("palettes.json is valid JSON");
        let base = opencode_document()["base"].clone();
        palettes
            .iter()
            .map(|(name, palette)| {
                let mut document = Map::new();
                document.insert("base".into(), base.clone());
                document.insert("dark".into(), mode(&palette["dark"]));
                document.insert("light".into(), mode(&palette["light"]));
                (name.clone(), Value::Object(document))
            })
            .collect()
    })
}

fn mix(foreground: &str, background: &str, amount: f64) -> String {
    let channel = |text: &str, offset: usize| {
        f64::from(u8::from_str_radix(&text[offset..offset + 2], 16).unwrap_or(0))
    };
    let channels: Vec<String> = [1, 3, 5]
        .iter()
        .map(|&offset| {
            // `Math.round` rounds halves up.
            let value = (channel(foreground, offset) * amount
                + channel(background, offset) * (1.0 - amount)
                + 0.5)
                .floor();
            format!("{:02x}", value as u8)
        })
        .collect();
    format!("#{}", channels.concat())
}

/// An entry that is skipped when its value is missing. A palette that lacks a key leaves the
/// token to the base theme, like an `undefined` value does in `mergeTheme`.
type Entry = (String, Option<Value>);

fn leaf(key: impl Into<String>, value: Option<&str>) -> Entry {
    (key.into(), value.map(|v| Value::String(v.to_string())))
}

fn group(key: impl Into<String>, entries: impl IntoIterator<Item = Entry>) -> Entry {
    (key.into(), Some(object(entries)))
}

fn object(entries: impl IntoIterator<Item = Entry>) -> Value {
    Value::Object(
        entries
            .into_iter()
            .filter_map(|(key, value)| Some((key, value?)))
            .collect(),
    )
}

fn mode(palette: &Value) -> Value {
    let get = |key: &str| palette.get(key).and_then(Value::as_str);
    let required = |key: &str| get(key).expect("palette color is present");
    let text = required("text");
    let background = required("background");
    let scale = |key: &str, color: &str| {
        group(
            key,
            (0..9).map(|index| {
                let amount = f64::from(9 - index) / 9.0;
                leaf(
                    ((index + 1) * 100).to_string(),
                    Some(&mix(color, background, amount)),
                )
            }),
        )
    };
    let mixed = mix(text, background, 0.8);
    let hue = object([group(
        "hue",
        [
            group(
                "neutral",
                [
                    leaf("100", Some(text)),
                    leaf("200", Some(text)),
                    leaf("300", Some(&mixed)),
                    leaf("400", get("textMuted")),
                    leaf("500", get("border")),
                    leaf("600", get("backgroundElement")),
                    leaf("700", get("backgroundPanel")),
                    leaf("800", Some(background)),
                    leaf("900", Some(background)),
                ],
            ),
            scale("gray", text),
            scale("cyan", required("syntaxType")),
            scale("interactive", required("primary")),
            scale("accent", required("accent")),
            scale("blue", required("primary")),
            scale("purple", required("secondary")),
            scale("green", required("success")),
            scale("orange", required("warning")),
            scale("red", required("error")),
        ],
    )]);
    let feedback = group(
        "feedback",
        ["error", "warning", "success", "info"].map(|kind| group(kind, [leaf("base", get(kind))])),
    );
    let markdown = group(
        "markdown",
        [
            ("text", "Text"),
            ("heading", "Heading"),
            ("link", "Link"),
            ("linkText", "LinkText"),
            ("code", "Code"),
            ("blockQuote", "BlockQuote"),
            ("emphasis", "Emph"),
            ("strong", "Strong"),
            ("horizontalRule", "HorizontalRule"),
            ("listItem", "ListItem"),
            ("listEnumeration", "ListEnumeration"),
            ("image", "Image"),
            ("imageText", "ImageText"),
            ("codeBlock", "CodeBlock"),
        ]
        .map(|(token, source)| leaf(token, get(&format!("markdown{source}")))),
    );
    let syntax = group(
        "syntax",
        [
            "comment",
            "keyword",
            "function",
            "string",
            "number",
            "type",
            "operator",
            "variable",
            "punctuation",
        ]
        .map(|token| {
            let mut capitalized = token.to_string();
            capitalized[..1].make_ascii_uppercase();
            leaf(token, get(&format!("syntax{capitalized}")))
        }),
    );
    let diff = group(
        "diff",
        [
            group(
                "text",
                [
                    leaf("added", get("diffAdded")),
                    leaf("removed", get("diffRemoved")),
                    leaf("context", get("diffContext")),
                    leaf("hunkHeader", get("diffHunkHeader")),
                ],
            ),
            group(
                "background",
                [
                    leaf("added", get("diffAddedBg")),
                    leaf("removed", get("diffRemovedBg")),
                    leaf("context", get("diffContextBg")),
                ],
            ),
            group(
                "highlight",
                [
                    leaf("added", get("diffHighlightAdded")),
                    leaf("removed", get("diffHighlightRemoved")),
                ],
            ),
            group(
                "lineNumber",
                [
                    leaf("text", get("diffLineNumber")),
                    group(
                        "background",
                        [
                            leaf("added", get("diffAddedLineNumberBg")),
                            leaf("removed", get("diffRemovedLineNumberBg")),
                        ],
                    ),
                ],
            ),
        ],
    );
    let background_group = group(
        "background",
        [
            leaf("base", Some(background)),
            group(
                "raised",
                [
                    leaf("base", get("backgroundPanel")),
                    leaf("high", get("backgroundElement")),
                    leaf("max", get("backgroundElement")),
                ],
            ),
        ],
    );
    let tokens: Vec<Entry> = vec![
        group(
            "text",
            [
                leaf("base", Some(text)),
                leaf("muted", get("textMuted")),
                feedback,
            ],
        ),
        background_group,
        group("border", [leaf("base", get("border"))]),
        markdown,
        syntax,
        diff,
    ];
    // The dialog surface repeats the tokens, with the base background raised to the panel color.
    let mut dialog_tokens = tokens.clone();
    dialog_tokens[1] = group(
        "background",
        [
            leaf("base", Some("$background.raised.base")),
            group(
                "raised",
                [
                    leaf("base", get("backgroundPanel")),
                    leaf("high", get("backgroundElement")),
                    leaf("max", get("backgroundElement")),
                ],
            ),
        ],
    );
    let mut entries: Vec<Entry> = hue
        .as_object()
        .into_iter()
        .flatten()
        .map(|(k, v)| (k.clone(), Some(v.clone())))
        .collect();
    entries.extend(tokens);
    entries.push(("@dialog".to_string(), Some(object(dialog_tokens))));
    object(entries)
}
