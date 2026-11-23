#!/usr/bin/env python3
"""Checks that the Rust hunk separators are the only change in the diff pane. See README.md, "Hunk separators".

For every scenario it plays the Rust app twice: with the blank row between hunks (`Session.hunk_gap`) and without it
(`TUIG_DIFF_HUNK_GAP=0`). Then, for each snapshot:

- Outside the diff pane, both screens must be equal, cell by cell.
- Inside the pane, the separator rows are removed from the screen with the gap. What is left must be equal, cell by
  cell and style by style, to a run of rows of the screen without the gap.
- A separator row is a row of blank cells with the pane background. It must have no text and one style.

Two scenarios click and drag on fixed screen rows below the first hunk gap: `line-selection` (`drag ... 20`) and
`line-staging` (`click ... 20`). With the gap, row 20 is one row lower in the file, so those gestures would pick other
lines. The check moves those gestures down one row in the run with the gap (`SHIFTED_GESTURES`), so both runs select
the same lines.

It also reports whether each screen equals the TS golden, so a difference that the separators did not cause shows
up as a golden failure in both columns.
"""

import argparse
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE / ".deps"), str(HERE)]

from parity import scenario as sc_mod  # noqa: E402
from parity import sidebyside  # noqa: E402
from parity import snapshot as snap_mod  # noqa: E402
from parity.snapshot import Snapshot, style_key  # noqa: E402
from parity.session import Session  # noqa: E402

ROOT = HERE.parent.parent
GOLDEN = HERE / "golden"


# Gestures that target a screen row below the first gap: scenario -> (op, argument index of the row, old, new).
SHIFTED_GESTURES = {
    "line-selection": ("drag", 3, "20", "21"),
    "line-staging": ("click", 1, "20", "21"),
}


def shift_gestures(sc):
    op, index, old, new = SHIFTED_GESTURES.get(sc.name, (None, 0, None, None))
    for step in sc.steps:
        if step.op == op and step.args[index] == old:
            step.args[index] = new


def pane_rect(snap: Snapshot):
    """The history pane without its borders and without the top blank row: where the diff rows are."""
    rect = sidebyside.regions(snap).get("history")
    if rect is None:
        return None
    x, y, w, h = rect
    return x + 1, y + 1, w - 1, h - 1


def rows_of(snap: Snapshot, rect):
    x, y, w, h = rect
    return [[(c.char, style_key(c)) for c in snap.cells[yy][x : x + w]] for yy in range(y, y + h)]


def blank(row) -> bool:
    return all(char == " " for char, _ in row)


def strip_trailing(rows):
    rows = list(rows)
    while rows and blank(rows[-1]):
        rows.pop()
    return rows


def fits(kept, plain):
    """The offset where `kept` matches `plain`, with the longest overlap, or None."""
    best = None
    for k in range(-len(kept) + 1, len(plain)):
        overlap = [(kept[i], plain[i + k]) for i in range(len(kept)) if 0 <= i + k < len(plain)]
        if overlap and all(a == b for a, b in overlap):
            if best is None or len(overlap) > best[1]:
                best = (k, len(overlap))
    return best


def check(on: Snapshot, off: Snapshot):
    """Returns (verdict, detail). Verdict is `identical`, `separators` or `UNEXPLAINED`."""
    if snap_mod.dump(on) == snap_mod.dump(off):
        return "identical", ""
    rect = pane_rect(off)
    if rect is None:
        return "UNEXPLAINED", "no pane found"
    x, y, w, h = rect
    outside = []
    for yy in range(on.rows):
        for xx in range(on.cols):
            if x <= xx < x + w and y <= yy < y + h:
                continue
            a, b = on.cells[yy][xx], off.cells[yy][xx]
            if (a.char, style_key(a)) != (b.char, style_key(b)):
                outside.append((xx, yy))
    if outside:
        return "UNEXPLAINED", f"{len(outside)} cell(s) differ outside the pane, first at {outside[0]}"
    if on.cursor != off.cursor:
        return "UNEXPLAINED", f"cursor {off.cursor} -> {on.cursor}"
    on_rows, off_rows = strip_trailing(rows_of(on, rect)), strip_trailing(rows_of(off, rect))
    if not off_rows:
        return "UNEXPLAINED", "the screen without the gap shows no diff rows"
    top_style = style_key(off.cells[y - 1][x])  # the blank top row of the pane has the plain background
    kept, separators = [], 0
    for row in on_rows:
        if not blank(row):
            kept.append(row)
            continue
        if len({style for _, style in row}) != 1 or row[0][1] != top_style:
            return "UNEXPLAINED", "a blank row does not have the plain pane background"
        separators += 1
    found = fits(kept, off_rows)
    if found is None:
        return "UNEXPLAINED", f"after removing {separators} blank row(s) the pane rows do not match"
    if separators == 0:
        return "UNEXPLAINED", "the pane differs and no blank row was inserted"
    k, overlap = found
    return "separators", f"{separators} separator row(s), {overlap} of {len(kept)} rows matched at offset {k}"


def golden_state(name, snap_name, snap):
    path = GOLDEN / name / f"{snap_name}.snap"
    if not path.exists():
        return "no golden"
    return "= golden" if snap_mod.dump(snap_mod.load(path.read_text())) == snap_mod.dump(snap) else "!= golden"


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("scenarios", nargs="*", help="scenario names (default: all)")
    p.add_argument("--binary", default=str(ROOT / "rust/target/release/tuig"))
    args = p.parse_args()
    cwd = ROOT / "rust"
    app = f"{args.binary} --clean {{repo}}"
    ok = True
    for sc in sc_mod.load_all(HERE / "scenarios", args.scenarios):
        Session.hunk_gap = False
        off = sc_mod.play(sc, app, cwd)
        shift_gestures(sc)
        Session.hunk_gap = True
        on = sc_mod.play(sc, app, cwd)
        for snap_name in on:
            verdict, detail = check(on[snap_name], off[snap_name])
            ok &= verdict != "UNEXPLAINED"
            g_on = golden_state(sc.name, snap_name, on[snap_name])
            g_off = golden_state(sc.name, snap_name, off[snap_name])
            print(f"{verdict:12} {sc.name}/{snap_name}  [gap: {g_on}, no gap: {g_off}]  {detail}", flush=True)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
