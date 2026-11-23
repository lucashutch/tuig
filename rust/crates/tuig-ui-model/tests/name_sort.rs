//! Cross-check of `compare_names` against `String.prototype.localeCompare` in Bun.
//! Regenerate the pairs with `bun rust/scripts/gen-name-sort-fixture.ts`.

use std::cmp::Ordering;
use tuig_ui_model::file_tree::compare_names;

fn sign(ordering: Ordering) -> i64 {
    ordering as i64
}

#[test]
fn compare_names_matches_bun_locale_compare() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/name_sort.json")).unwrap();
    let pairs = fixture["pairs"].as_array().unwrap();
    let mut mismatches = Vec::new();
    for pair in pairs {
        let (a, b) = (pair[0].as_str().unwrap(), pair[1].as_str().unwrap());
        let expected = pair[2].as_i64().unwrap();
        if sign(compare_names(a, b)) != expected {
            mismatches.push(format!("{a:?} vs {b:?}: expected {expected}"));
        }
    }
    eprintln!(
        "name sort mismatches: {} of {}",
        mismatches.len(),
        pairs.len()
    );
    assert!(
        mismatches.is_empty(),
        "first mismatches: {:#?}",
        &mismatches[..mismatches.len().min(15)]
    );
}
