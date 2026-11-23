"""Compare two snapshots region by region: tabs, header, sidebar, history, details, footer."""

from __future__ import annotations

from .session import Cell
from .snapshot import Snapshot, diff, style_key

TABS, HEADER, FOOTER_ROWS = 1, 2, 1
DIVIDERS = "│┃"


def regions(snap: Snapshot) -> dict[str, tuple[int, int, int, int]]:
    """Named rectangles (x, y, width, height). Pane borders come from the vertical divider glyphs."""
    top, bottom = TABS + HEADER, snap.rows - FOOTER_ROWS
    body = range(top, bottom)
    cols = [
        x
        for x in range(snap.cols)
        if sum(snap.cells[y][x].char in DIVIDERS for y in body) * 10 >= len(body) * 7
    ]
    out = {"tabs": (0, 0, snap.cols, TABS), "header": (0, TABS, snap.cols, HEADER)}
    if len(cols) >= 2:
        left, right = cols[0], cols[-1]
        out["sidebar"] = (0, top, left, bottom - top)
        out["history"] = (left, top, right - left, bottom - top)
        out["details"] = (right, top, snap.cols - right, bottom - top)
    elif len(cols) == 1:
        out["left"] = (0, top, cols[0], bottom - top)
        out["right"] = (cols[0], top, snap.cols - cols[0], bottom - top)
    else:
        out["body"] = (0, top, snap.cols, bottom - top)
    out["footer"] = (0, bottom, snap.cols, FOOTER_ROWS)
    return out


def crop(snap: Snapshot, rect: tuple[int, int, int, int]) -> Snapshot:
    x, y, w, h = rect
    cells: list[list[Cell]] = [row[x : x + w] for row in snap.cells[y : y + h]]
    return Snapshot(w, h, snap.cursor, cells)


def compare(reference: Snapshot, other: Snapshot) -> dict[str, tuple[int, int, list[str]]]:
    """Per region: cells whose text differs, cells whose style differs, and the readable diff.

    Rectangles come from `reference`. A size difference is reported on a region named "size".
    """
    if (reference.cols, reference.rows) != (other.cols, other.rows):
        return {"size": (1, 0, diff(reference, other))}
    result = {}
    for name, rect in regions(reference).items():
        a, b = crop(reference, rect), crop(other, rect)
        text = style = 0
        for row_a, row_b in zip(a.cells, b.cells):
            for ca, cb in zip(row_a, row_b):
                if ca.char != cb.char:
                    text += 1
                elif style_key(ca) != style_key(cb):
                    style += 1
        result[name] = (text, style, diff(a, b) if text or style else [])
    if reference.cursor != other.cursor:
        result["cursor"] = (0, 1, [f"CURSOR: reference {reference.cursor}, other {other.cursor}"])
    return result
