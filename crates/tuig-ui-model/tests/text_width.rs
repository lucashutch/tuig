use tuig_ui_model::text_width::{fit_columns, fit_tree_label, string_width, take_columns};

#[test]
fn string_width_matches_bun_for_wide_and_joined_text() {
    // Expected values come from `Bun.stringWidth` in Bun 1.4.3.
    let cases = [
        ("abc", 3),
        ("漢字", 4),
        ("Ａ", 2),
        ("ｱ", 1),
        ("😀", 2),
        ("👨‍👩‍👧", 2),
        ("👍🏽", 2),
        ("🇯🇵", 2),
        ("❤", 1),
        ("❤\u{FE0F}", 2),
        ("1\u{FE0F}\u{20E3}", 2),
        ("a\u{FE0F}", 1),
        ("e\u{301}", 1),
        ("a\tb\u{7}", 2),
        ("a\u{200B}\u{AD}b", 2),
    ];
    for (text, expected) in cases {
        assert_eq!(string_width(text), expected, "{text:?}");
    }
}

#[test]
fn take_columns_never_splits_a_wide_character() {
    assert_eq!(take_columns("漢字ab", 3, false), "漢");
    assert_eq!(take_columns("ab漢字", 3, true), "字");
    assert_eq!(take_columns("abc", 10, false), "abc");
}

#[test]
fn fit_columns_pads_and_truncates_to_exact_width() {
    assert_eq!(fit_columns("ab", 5, false), "ab   ");
    assert_eq!(fit_columns("漢字漢", 5, false), "漢字 ");
    assert_eq!(fit_columns("abcdef", 4, true), "abc…");
    assert_eq!(fit_columns("abcdef", 1, true), "a");
    assert_eq!(fit_columns("abc", 0, true), "");
}

#[test]
fn fit_tree_label_keeps_both_ends_of_long_names() {
    assert_eq!(fit_tree_label("short.rs", 20), "short.rs");
    assert_eq!(fit_tree_label("component-name.test.ts", 12), "compone…t.ts");
    assert_eq!(fit_tree_label("abcdef", 3), "ab…");
    assert_eq!(fit_tree_label("abcdef", 1), "…");
    assert_eq!(fit_tree_label("abcdef", 0), "");
    assert_eq!(fit_tree_label("漢字漢字漢字", 7), "漢字…字");
}
