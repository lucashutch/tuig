"""Scenario files and the runner that plays them against an app.

A scenario is a line-based file. Blank lines and "#" comments are ignored.
Words are split like a shell, so quote text with spaces.
"""

from __future__ import annotations

import re
import shlex
import shutil
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

from . import fixtures
from .session import Session, key_bytes, sgr_mouse
from .snapshot import Masks, Snapshot, capture


@dataclass
class Step:
    op: str
    args: list[str]
    line: int


@dataclass
class Scenario:
    name: str
    fixture: str = "demo"
    extras: list[str] = field(default_factory=list)
    cols: int = 160
    rows: int = 48
    quiet_ms: int = 300
    timeout: float = 20.0
    steps: list[Step] = field(default_factory=list)



def parse(path: Path) -> Scenario:
    sc = Scenario(name=path.stem)
    for n, raw in enumerate(path.read_text().splitlines(), 1):
        words = shlex.split(raw, comments=True)
        if not words:
            continue
        op, args = words[0], words[1:]
        if op == "fixture":
            sc.fixture = args[0]
        elif op == "extra":
            sc.extras.append(args[0])
        elif op == "size":
            sc.cols, sc.rows = int(args[0]), int(args[1])
        elif op == "quiet":
            sc.quiet_ms = int(args[0])
        elif op == "timeout":
            sc.timeout = float(args[0])
        else:
            sc.steps.append(Step(op, args, n))
    names = [s.args[0] for s in sc.steps if s.op == "snapshot"]
    if len(names) != len(set(names)):
        raise ValueError(f"{path}: duplicate snapshot names")
    for name in [sc.fixture, *sc.extras]:
        if name not in fixtures.FIXTURES:
            raise ValueError(f"{path}: unknown fixture {name!r}")
    if sc.fixture in sc.extras:
        raise ValueError(f"{path}: an extra fixture must differ from the main one")
    return sc


def load_all(root: Path, only: list[str] | None = None) -> list[Scenario]:
    found = [parse(p) for p in sorted(root.glob("*.scn"))]
    if only:
        missing = set(only) - {s.name for s in found}
        if missing:
            raise SystemExit(f"unknown scenario: {', '.join(sorted(missing))}")
        found = [s for s in found if s.name in only]
    return found


def app_argv(template: str, repo: Path) -> list[str]:
    parts = shlex.split(template)
    if any("{repo}" in p for p in parts):
        return [p.replace("{repo}", str(repo)) for p in parts]
    return [*parts, str(repo)]


def play(sc: Scenario, template: str, cwd: Path) -> dict[str, Snapshot]:
    """Run one scenario once against one app. Returns snapshots by name."""
    work = Path(tempfile.mkdtemp(prefix="parity-fx-"))
    session = None
    try:
        repo = fixtures.build(sc.fixture, work)
        extras = {name: str(fixtures.build(name, work)) for name in sc.extras}
        session = Session(app_argv(template, repo), sc.cols, sc.rows, cwd)
        return _steps(sc, session, extras)
    finally:
        if session:
            session.close()
        shutil.rmtree(work, ignore_errors=True)


def _button(words: list[str]) -> tuple[int, int]:
    """Button code and modifier bits from words like "right", "ctrl", "alt+shift"."""
    btn, mods = 0, 0
    for word in words:
        for part in word.split("+"):
            if part in ("left", "middle", "right"):
                btn = {"left": 0, "middle": 1, "right": 2}[part]
            else:
                mods |= {"shift": 4, "alt": 8, "ctrl": 16}[part]
    return btn, mods


def _steps(sc: Scenario, s: Session, extras: dict[str, str] | None = None) -> dict[str, Snapshot]:
    extras = extras or {}
    snaps: dict[str, Snapshot] = {}
    masks = Masks()

    def settle() -> None:
        s.wait_quiet(sc.quiet_ms, sc.timeout)

    for st in sc.steps:
        a = st.args
        try:
            if st.op == "wait":
                if a[0] == "stable":
                    settle()
                elif a[0] == "text":
                    s.wait_text(a[1], sc.timeout)
                else:
                    raise ValueError(f"wait {a[0]}")
            elif st.op == "key":
                for k in a:
                    s.send(key_bytes(k))
                settle()
            elif st.op == "text":
                typed = a[0]
                for name, path in extras.items():
                    typed = typed.replace("{" + name + "}", path)
                s.send(typed.encode())
                settle()
            elif st.op == "click":
                x, y = int(a[0]), int(a[1])
                btn, mods = _button(a[2:])
                s.send(sgr_mouse(btn | mods, x, y))
                s.send(sgr_mouse(btn | mods, x, y, release=True))
                settle()
            elif st.op == "move":
                s.send(sgr_mouse(35, int(a[0]), int(a[1])))
                settle()
            elif st.op == "drag":
                x1, y1, x2, y2 = map(int, a[:4])
                mods = _button(a[4:])[1]
                s.send(sgr_mouse(mods, x1, y1))
                steps = max(abs(x2 - x1), abs(y2 - y1), 1)
                for i in range(1, steps + 1):
                    px = x1 + round((x2 - x1) * i / steps)
                    py = y1 + round((y2 - y1) * i / steps)
                    s.send(sgr_mouse(32 | mods, px, py))
                    s.pump(0.01)
                s.send(sgr_mouse(mods, x2, y2, release=True))
                settle()
            elif st.op == "wheel":
                code = {"up": 64, "down": 65}[a[0]]
                x, y = int(a[1]), int(a[2])
                for _ in range(int(a[3]) if len(a) > 3 else 1):
                    s.send(sgr_mouse(code, x, y))
                    s.pump(0.01)
                settle()
            elif st.op == "mask":
                masks.rects.append(tuple(map(int, a[:4])))  # type: ignore[arg-type]
            elif st.op == "ignore":
                # Mask the cells, and stop them from counting as screen activity.
                rect = tuple(map(int, a[:4]))
                masks.rects.append(rect)  # type: ignore[arg-type]
                s.ignore.append(rect)  # type: ignore[arg-type]
            elif st.op == "mask-text":
                masks.patterns.append(re.compile(a[0]))
            elif st.op == "snapshot":
                settle()
                snaps[a[0]] = capture(s, masks)
            else:
                raise ValueError(f"unknown step {st.op!r}")
        except (TimeoutError, ValueError, KeyError, IndexError) as e:
            screen = "\n".join(line.rstrip() for line in s.screen.display)
            raise RuntimeError(f"{sc.name}.scn line {st.line} ({st.op}): {e}\n--- screen ---\n{screen}") from e
    return snaps
