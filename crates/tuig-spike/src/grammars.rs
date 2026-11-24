//! Registers the grammars the TypeScript app loads from `tree-sitter-wasm` (`src/ui/diff-parsers.ts`) that the
//! Rust crate does not bundle. Bundled: javascript, typescript, tsx, markdown, zig, rust.

use opentui::syntax::{Grammar, register_alias, register_lazy};

fn lazy(filetype: &str, build: impl Fn() -> Grammar + Send + Sync + 'static) {
    register_lazy(filetype, move || build().compile().ok());
}

pub fn register_all() {
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
    register_alias("sh", "bash");
}
