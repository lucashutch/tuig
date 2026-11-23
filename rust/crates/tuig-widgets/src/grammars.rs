//! Registers the grammars the TypeScript app loads from `tree-sitter-wasm` (`src/ui/diff-parsers.ts`) that the
//! Rust crate does not bundle. Bundled: javascript, typescript, tsx, markdown, zig, rust.
//!
//! The TS app highlights TypeScript and Markdown with OpenTUI Core's own queries, which come from nvim-treesitter.
//! The Rust crate bundles the grammar crates' queries instead, which name captures differently. So this file
//! replaces those three grammars with Core's queries, copied into `queries/core/` from `@opentui/core` 0.8.4
//! (`assets/<filetype>/highlights.scm`). Their `#lua-match?` predicates are rewritten as `#match?`, with `%d` as
//! `\\d`, because tree-sitter does not know Lua patterns. All grammars here use Core's capture cascade.

use opentui::syntax::{Grammar, register_lazy};

fn lazy(filetype: &str, build: impl Fn() -> Grammar + Send + Sync + 'static) {
    register_lazy(filetype, move || build().core_captures().compile().ok());
}

/// Registers the grammars once. Later calls do nothing.
pub fn register_all() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(register);
}

fn register() {
    lazy("python", || {
        Grammar::new(
            tree_sitter_python::LANGUAGE,
            tree_sitter_python::HIGHLIGHTS_QUERY,
        )
    });
    lazy("go", || {
        Grammar::new(tree_sitter_go::LANGUAGE, tree_sitter_go::HIGHLIGHTS_QUERY)
    });
    lazy("html", || {
        Grammar::new(
            tree_sitter_html::LANGUAGE,
            tree_sitter_html::HIGHLIGHTS_QUERY,
        )
    });
    lazy("css", || {
        Grammar::new(tree_sitter_css::LANGUAGE, tree_sitter_css::HIGHLIGHTS_QUERY)
    });
    lazy("json", || {
        Grammar::new(
            tree_sitter_json::LANGUAGE,
            tree_sitter_json::HIGHLIGHTS_QUERY,
        )
    });
    lazy("bash", || {
        Grammar::new(
            tree_sitter_bash::LANGUAGE,
            tree_sitter_bash::HIGHLIGHT_QUERY,
        )
    });
    lazy("c", || {
        Grammar::new(tree_sitter_c::LANGUAGE, tree_sitter_c::HIGHLIGHT_QUERY)
    });
    // The TypeScript app concatenates the C and C++ queries; the C++ one only adds C++ constructs.
    lazy("cpp", || {
        let query = format!(
            "{}\n{}",
            tree_sitter_c::HIGHLIGHT_QUERY,
            tree_sitter_cpp::HIGHLIGHT_QUERY
        );
        Grammar::new(tree_sitter_cpp::LANGUAGE, query)
    });
    lazy("typescript", || {
        Grammar::new(
            tree_sitter_typescript::LANGUAGE_TYPESCRIPT,
            include_str!("../queries/core/typescript-highlights.scm"),
        )
    });
    lazy("markdown", || {
        Grammar::new(
            tree_sitter_md::LANGUAGE,
            include_str!("../queries/core/markdown-highlights.scm"),
        )
        .injections(MARKDOWN_INJECTIONS)
    });
    lazy("markdown_inline", || {
        Grammar::new(
            tree_sitter_md::INLINE_LANGUAGE,
            include_str!("../queries/core/markdown_inline-highlights.scm"),
        )
    });
    // No `sh` alias, and the injections skip `sh` fences: Core has no `sh` filetype, so the TS app leaves a fenced
    // `sh` block in Markdown plain.
}

/// The bundled Markdown injections of the Rust crate, which keep the unnamed children of inline text and fenced code
/// so that emphasis and code parse.
const MARKDOWN_INJECTIONS: &str = r#"
(fenced_code_block
  (info_string (language) @injection.language)
  (code_fence_content) @injection.content
  (#not-eq? @injection.language "sh")
  (#set! injection.include-unnamed-children))
((html_block) @injection.content (#set! injection.language "html"))
([(inline) (pipe_table_cell)] @injection.content
  (#set! injection.language "markdown_inline")
  (#set! injection.include-unnamed-children))
"#;
