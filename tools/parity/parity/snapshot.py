"""Snapshot format, masking, and cell-level diffing."""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from .session import Cell, Session

MASK_CHAR = "▒"
ALPHABET = (
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
    "!#$%&()*+,-./:;<=>?@[]^_{|}~"
)  # fmt: skip
MASK_STYLE = Cell(MASK_CHAR, "default", "default", "")


@dataclass
class Snapshot:
    cols: int
    rows: int
    cursor: str  # "hidden" or "x,y"
    cells: list[list[Cell]]


@dataclass
class Masks:
    rects: list[tuple[int, int, int, int]] = field(default_factory=list)
    patterns: list[re.Pattern] = field(default_factory=list)


def style_key(c: Cell) -> str:
    return f"fg={c.fg} bg={c.bg} attrs={c.attrs or '-'}"


def capture(session: Session, masks: Masks) -> Snapshot:
    cells = session.cells()
    # One codepoint per cell keeps the text grid aligned. Combining marks are
    # dropped, which no current screen uses.
    for row in cells:
        for c in row:
            c.char = c.char[0]
    for x, y, w, h in masks.rects:
        for yy in range(y, min(y + h, session.rows)):
            for xx in range(x, min(x + w, session.cols)):
                cells[yy][xx] = MASK_STYLE
    for y, row in enumerate(cells):
        line = "".join(c.char for c in row)
        for pat in masks.patterns:
            for m in pat.finditer(line):
                for xx in range(m.start(), m.end()):
                    cells[y][xx] = MASK_STYLE
    cur = session.screen.cursor
    cursor = "hidden" if cur.hidden else f"{cur.x},{cur.y}"
    return Snapshot(session.cols, session.rows, cursor, cells)


def dump(snap: Snapshot) -> str:
    ids: dict[str, str] = {}
    grid = []
    for row in snap.cells:
        out = []
        for c in row:
            k = style_key(c)
            if k not in ids:
                if len(ids) >= len(ALPHABET):
                    raise ValueError("snapshot has more distinct styles than the format allows")
                ids[k] = ALPHABET[len(ids)]
            out.append(ids[k])
        grid.append("".join(out))
    lines = [f"parity-snapshot 1 {snap.cols}x{snap.rows} cursor={snap.cursor}", "", "[text]"]
    lines += ["".join(c.char for c in row) + "|" for row in snap.cells]
    lines += ["", "[styles]"] + [f"{i} {k}" for k, i in ids.items()]
    lines += ["", "[grid]"] + [g + "|" for g in grid]
    return "\n".join(lines) + "\n"


def load(text: str) -> Snapshot:
    lines = text.split("\n")
    head = lines[0].split()
    if head[:2] != ["parity-snapshot", "1"]:
        raise ValueError("not a parity snapshot")
    cols, rows = map(int, head[2].split("x"))
    cursor = head[3].split("=", 1)[1]
    sections: dict[str, list[str]] = {}
    cur = None
    for line in lines[1:]:
        if line.startswith("[") and line.endswith("]"):
            cur = sections.setdefault(line[1:-1], [])
        elif cur is not None and line:
            cur.append(line)
    styles = {}
    for line in sections["styles"]:
        i, fg, bg, attrs = line.split(" ")
        attrs = attrs.split("=", 1)[1]
        styles[i] = (fg.split("=", 1)[1], bg.split("=", 1)[1], "" if attrs == "-" else attrs)
    cells = []
    for t, g in zip(sections["text"], sections["grid"]):
        # Rows end with "|"; a row of spaces is never empty, so split is exact.
        cells.append([Cell(ch, *styles[s]) for ch, s in zip(t[:-1], g[:-1])])
    if len(cells) != rows or any(len(r) != cols for r in cells):
        raise ValueError("snapshot grid does not match its header")
    return Snapshot(cols, rows, cursor, cells)


def diff(expected: Snapshot, actual: Snapshot, limit: int = 40) -> list[str]:
    """Readable differences, text first, then style. Empty list means equal."""
    out: list[str] = []
    if (expected.cols, expected.rows) != (actual.cols, actual.rows):
        return [f"size differs: expected {expected.cols}x{expected.rows}, actual {actual.cols}x{actual.rows}"]

    text_rows = []
    for y in range(expected.rows):
        e = "".join(c.char for c in expected.cells[y])
        a = "".join(c.char for c in actual.cells[y])
        if e != a:
            text_rows.append((y, e, a))
    if text_rows:
        out.append(f"TEXT: {len(text_rows)} row(s) differ")
        for y, e, a in text_rows[:limit]:
            marks = "".join("^" if x != z else " " for x, z in zip(e, a)).rstrip()
            out += [f"  row {y:2d} exp |{e.rstrip()}", f"         act |{a.rstrip()}", f"             {marks}"]
        if len(text_rows) > limit:
            out.append(f"  ... {len(text_rows) - limit} more row(s)")

    style_runs = []
    for y in range(expected.rows):
        x = 0
        while x < expected.cols:
            e, a = expected.cells[y][x], actual.cells[y][x]
            if style_key(e) != style_key(a):
                x2 = x
                while (
                    x2 + 1 < expected.cols
                    and style_key(expected.cells[y][x2 + 1]) == style_key(e)
                    and style_key(actual.cells[y][x2 + 1]) == style_key(a)
                ):
                    x2 += 1
                style_runs.append((y, x, x2, e, a))
                x = x2 + 1
            else:
                x += 1
    if style_runs:
        out.append(f"STYLE: {len(style_runs)} run(s) differ")
        for y, x1, x2, e, a in style_runs[:limit]:
            shown = "".join(c.char for c in expected.cells[y][x1 : x2 + 1])[:20]
            out += [f"  row {y:2d} cols {x1}-{x2} {shown!r}", f"    exp {style_key(e)}", f"    act {style_key(a)}"]
        if len(style_runs) > limit:
            out.append(f"  ... {len(style_runs) - limit} more run(s)")

    if expected.cursor != actual.cursor:
        out.append(f"CURSOR: expected {expected.cursor}, actual {actual.cursor}")
    return out
