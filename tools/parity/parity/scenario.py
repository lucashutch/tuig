"""Scenario files and the runner that plays them against an app.

A scenario is a line-based file. Blank lines and "#" comments are ignored.
Words are split like a shell, so quote text with spaces.
"""

from __future__ import annotations

import re
import shlex
import shutil
import subprocess
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path

from . import fixtures
from .session import STUBS, Session, key_bytes, sgr_mouse
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
    stubs: list[str] = field(default_factory=list)
    seeds: dict[str, str] = field(default_factory=dict)
    restore: bool = False  # keep the saved session: drop --clean
    nopath: bool = False  # start without a path argument
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
        elif op == "stub":
            sc.stubs.append(args[0])
        elif op == "seed":
            sc.seeds[args[0]] = args[1]
        elif op == "restore":
            sc.restore = True
        elif op == "nopath":
            sc.nopath = True
        else:
            sc.steps.append(Step(op, args, n))
    names = [s.args[0] for s in sc.steps if s.op == "snapshot"]
    if len(names) != len(set(names)):
        raise ValueError(f"{path}: duplicate snapshot names")
    for name in sc.stubs:
        if name not in STUBS:
            raise ValueError(f"{path}: unknown stub {name!r}")
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


def app_argv(template: str, repo: Path, restore: bool = False, nopath: bool = False) -> list[str]:
    parts = shlex.split(template)
    if restore:
        parts = [p for p in parts if p != "--clean"]
    if nopath:
        return [p for p in parts if "{repo}" not in p]
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
        paths = {"repo": str(repo), **extras}
        seeds = {}
        for rel, text in sc.seeds.items():
            for name, path in paths.items():
                text = text.replace("{" + name + "}", path)
            seeds[rel] = text
        argv = app_argv(template, repo, sc.restore, sc.nopath)
        stubs = {}
        for name in sc.stubs:
            binary, script = STUBS[name]
            stubs[binary] = re.sub(r"\{sha:([^}]+)\}", lambda m: fixtures.Repo(repo).git("rev-parse", m.group(1)).strip(), script)
        session = Session(argv, sc.cols, sc.rows, cwd, stubs, seeds)
        return _steps(sc, session, extras, repo)
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


def _git(cwd: str, words: list[str]) -> None:
    env = {**fixtures.BASE_ENV, **fixtures.IDENTITY, "GIT_AUTHOR_DATE": "2024-05-01T00:00:00+0000", "GIT_COMMITTER_DATE": "2024-05-01T00:00:00+0000"}
    subprocess.run(["git", *words], cwd=cwd, env=env, check=True, capture_output=True)


def _steps(sc: Scenario, s: Session, extras: dict[str, str] | None = None, repo: Path | None = None) -> dict[str, Snapshot]:
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
            elif st.op == "dclick":
                x, y = int(a[0]), int(a[1])
                btn, mods = _button(a[2:])
                for _ in range(2):
                    s.send(sgr_mouse(btn | mods, x, y))
                    s.send(sgr_mouse(btn | mods, x, y, release=True))
                    s.pump(0.08)  # a real double click has a gap of tens of milliseconds
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
                code = {"up": 64, "down": 65, "left": 66, "right": 67}[a[0]]
                x, y = int(a[1]), int(a[2])
                mods = _button(a[4:])[1]
                for _ in range(int(a[3]) if len(a) > 3 else 1):
                    s.send(sgr_mouse(code | mods, x, y))
                    s.pump(0.01)
                settle()
            elif st.op == "git":
                # Run git outside the app, in the main fixture or in an extra one (`git @second ...`).
                where = repo
                words = a
                if words and words[0].startswith("@"):
                    where, words = Path(extras[words[0][1:]]), words[1:]
                _git(str(where), words)
                settle()
            elif st.op == "resize":
                s.resize(int(a[0]), int(a[1]))
                settle()
            elif st.op == "expect-file":
                # `expect-file <path under HOME> <text>`: the file must contain the text soon.
                target = s.home / a[0]
                deadline = time.monotonic() + sc.timeout
                while not (target.exists() and a[1] in target.read_text()):
                    if time.monotonic() > deadline:
                        have = target.read_text() if target.exists() else "(missing)"
                        raise ValueError(f"{a[0]} does not contain {a[1]!r}: {have}")
                    s.pump(0.1)
            elif st.op == "expect-clipboard":
                want = a[0].replace("\\n", "\n")  # a scenario writes a line break as \n
                got = s.clipboard()
                if not got or got[-1] != want:
                    raise ValueError(f"clipboard is {got[-1:]!r}, expected {want!r}")
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
