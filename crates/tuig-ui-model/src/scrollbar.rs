//! Scrollbar geometry in half-cell units.
//!
//! Painting and dragging share these numbers. Half cells let the thumb move in steps half a row
//! tall, using upper and lower half-block glyphs. The arithmetic runs in `f64` and rounds like
//! JavaScript, so results match the TypeScript app.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScrollbarThumb {
    pub size: i64,
    pub top: i64,
    pub travel: i64,
    pub max_start: i64,
}

/// `Math.round` for the non-negative values used here.
fn round_half_up(value: f64) -> i64 {
    (value + 0.5).floor() as i64
}

pub fn scrollbar_thumb(total: i64, start: i64, viewport: i64) -> ScrollbarThumb {
    let track = viewport.max(0) * 2;
    let max_start = (total - viewport).max(0);
    if max_start == 0 {
        return ScrollbarThumb {
            size: track,
            top: 0,
            travel: 0,
            max_start,
        };
    }
    let size = track.min(2.max(((track * viewport) as f64 / total as f64).floor() as i64));
    let travel = track - size;
    let clamped = start.max(0).min(max_start);
    ScrollbarThumb {
        size,
        top: round_half_up((clamped * travel) as f64 / max_start as f64),
        travel,
        max_start,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScrollbarCell {
    Full,
    Upper,
    Lower,
    None,
}

/// Which halves of one track row the thumb covers.
pub fn scrollbar_cell(thumb: &ScrollbarThumb, row: i64) -> ScrollbarCell {
    let covers = |half: i64| half >= thumb.top && half < thumb.top + thumb.size;
    match (covers(row * 2), covers(row * 2 + 1)) {
        (true, true) => ScrollbarCell::Full,
        (true, false) => ScrollbarCell::Upper,
        (false, true) => ScrollbarCell::Lower,
        (false, false) => ScrollbarCell::None,
    }
}

/// Where the pointer holds the thumb, in half cells from the thumb's exact top. `total`,
/// `viewport`, and `pointer` record the geometry and pointer row the offset was last measured
/// against.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ScrollbarGrab {
    pub offset: f64,
    pub total: i64,
    pub viewport: i64,
    pub pointer: i64,
}

/// A pointer row maps to the middle of its cell.
fn pointer_half(pointer: i64) -> f64 {
    (pointer * 2 + 1) as f64
}

/// The thumb top for `start` without rounding, in half cells.
fn exact_top(thumb: &ScrollbarThumb, start: i64) -> f64 {
    if thumb.max_start == 0 {
        0.0
    } else {
        (start.max(0).min(thumb.max_start) * thumb.travel) as f64 / thumb.max_start as f64
    }
}

/// Grab the thumb at the pressed row. A press on the thumb keeps the offset, so the view does
/// not move until the pointer does. A press elsewhere on the track centres the thumb on the
/// pointer.
pub fn scrollbar_grab(total: i64, start: i64, viewport: i64, pointer: i64) -> ScrollbarGrab {
    let thumb = scrollbar_thumb(total, start, viewport);
    let half = pointer_half(pointer);
    // Test the whole row, since a thumb can end halfway down the pressed row.
    let on_thumb = scrollbar_cell(&thumb, pointer) != ScrollbarCell::None;
    ScrollbarGrab {
        offset: if on_thumb {
            half - exact_top(&thumb, start)
        } else {
            thumb.size as f64 / 2.0
        },
        total,
        viewport,
        pointer,
    }
}

/// The first visible row for the pointer during a drag.
///
/// Each pointer row moves the view by the same number of rows. If the row count or viewport
/// changed since the grab, for example because more history loaded, the grab is measured again
/// so the view stays where it is.
pub fn scrollbar_drag(
    grab: &ScrollbarGrab,
    total: i64,
    start: i64,
    viewport: i64,
    pointer: i64,
) -> (i64, ScrollbarGrab) {
    let thumb = scrollbar_thumb(total, start, viewport);
    // Measure again from the previous pointer row, so the view stays put and this event's
    // movement still applies.
    let offset = if grab.total == total && grab.viewport == viewport {
        grab.offset
    } else {
        pointer_half(grab.pointer) - exact_top(&thumb, start)
    };
    let next = ScrollbarGrab {
        offset,
        total,
        viewport,
        pointer,
    };
    if thumb.travel == 0 {
        return (0, next);
    }
    let top = (pointer_half(pointer) - offset)
        .min(thumb.travel as f64)
        .max(0.0);
    (
        round_half_up(top * thumb.max_start as f64 / thumb.travel as f64),
        next,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use ScrollbarCell::*;

    const SIZES: [(i64, i64); 4] = [(11, 10), (15, 10), (100, 10), (5000, 37)];

    fn thumb_rows(total: i64, start: i64, viewport: i64) -> Vec<ScrollbarCell> {
        let thumb = scrollbar_thumb(total, start, viewport);
        (0..viewport)
            .map(|row| scrollbar_cell(&thumb, row))
            .collect()
    }

    #[test]
    fn a_press_without_movement_keeps_every_start() {
        for (total, viewport) in SIZES {
            for start in 0..=(total - viewport) {
                let thumb = scrollbar_thumb(total, start, viewport);
                for pointer in 0..viewport {
                    if scrollbar_cell(&thumb, pointer) == None {
                        continue;
                    }
                    let grab = scrollbar_grab(total, start, viewport, pointer);
                    assert_eq!(
                        scrollbar_drag(&grab, total, start, viewport, pointer).0,
                        start
                    );
                }
            }
        }
    }

    #[test]
    fn each_pointer_row_moves_the_view_by_an_even_step() {
        for (total, viewport) in SIZES {
            let grab = scrollbar_grab(total, 0, viewport, 0);
            let starts: Vec<i64> = (0..viewport)
                .map(|p| scrollbar_drag(&grab, total, 0, viewport, p).0)
                .collect();
            let steps: Vec<i64> = starts.windows(2).map(|w| w[1] - w[0]).collect();
            let moving: Vec<i64> = steps.iter().copied().filter(|s| *s > 0).collect();
            assert!(steps.iter().all(|s| *s >= 0));
            assert!(moving.iter().max().unwrap() - moving.iter().min().unwrap() <= 1);
        }
    }

    #[test]
    fn reaches_the_first_and_last_rows_at_the_track_ends() {
        let grab = scrollbar_grab(100, 45, 10, 4);
        assert_eq!(scrollbar_drag(&grab, 100, 45, 10, -5).0, 0);
        assert_eq!(scrollbar_drag(&grab, 100, 45, 10, 50).0, 90);
    }

    #[test]
    fn centres_the_thumb_on_a_track_press_away_from_it() {
        let grab = scrollbar_grab(100, 0, 20, 15);
        let (start, _) = scrollbar_drag(&grab, 100, 0, 20, 15);
        let mut expected = vec![None; 13];
        expected.extend([Lower, Full, Full, Full, Upper, None, None]);
        assert_eq!(thumb_rows(100, start, 20), expected);
    }

    #[test]
    fn keeps_the_view_still_when_rows_load_mid_drag() {
        let grab = scrollbar_grab(250, 0, 20, 0);
        let (before, grab) = scrollbar_drag(&grab, 250, 0, 20, 10);
        let (after, _) = scrollbar_drag(&grab, 500, before, 20, 10);
        assert_eq!(after, before);
        // The first move after the load still scrolls, by the new step size.
        let (moved, _) = scrollbar_drag(&grab, 500, before, 20, 9);
        assert!(moved < before);
        assert!(before - moved < 40);
    }

    #[test]
    fn moves_the_thumb_in_half_row_steps() {
        assert_eq!(thumb_rows(100, 0, 4), [Full, None, None, None]);
        assert_eq!(thumb_rows(100, 16, 4), [Lower, Upper, None, None]);
        assert_eq!(thumb_rows(100, 32, 4), [None, Full, None, None]);
    }

    #[test]
    fn does_not_scroll_content_that_fits() {
        let grab = scrollbar_grab(10, 0, 10, 5);
        assert_eq!(scrollbar_drag(&grab, 10, 0, 10, 9).0, 0);
    }
}
