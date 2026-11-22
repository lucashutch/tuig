"""Run a command under a PTY and expose its screen as a cell grid."""

from __future__ import annotations

import base64
import fcntl
import os
import re
import pty
import select
import shutil
import signal
import struct
import subprocess
import tempfile
import termios
import time
from dataclasses import dataclass
from pathlib import Path

import pyte

# Fixed environment. Nothing from the caller's environment is copied except
# PATH, so user preferences, locale and credentials cannot leak into a run.
# The app classifies this message as "not a GitHub repository" and hides the
# pull request section, the same as a machine without gh credentials.
GH_STUB = (
    "#!/bin/sh\n"
    "echo 'none of the git remotes configured for this repository point to a "
    "known GitHub host' >&2\n"
    "exit 1\n"
)
GH_PRS_JSON = (
    '{"data":{"viewer":{"login":"ada"},"repository":{"pullRequests":{"nodes":['
    '{"number":3,"title":"Tidy the main branch","url":"https://github.com/ada/demo/pull/3","isDraft":false,'
    '"updatedAt":"2024-04-01T00:00:00Z","author":{"login":"ada"},"headRefName":"main","headRefOid":"{sha:main}",'
    '"isCrossRepository":false,"commits":{"nodes":[{"commit":{"statusCheckRollup":{"contexts":{'
    '"checkRunCountsByState":[{"state":"SUCCESS","count":3}],"statusContextCountsByState":[]}}}}]}},'
    '{"number":12,"title":"Add login flow","url":"https://github.com/ada/demo/pull/12","isDraft":false,'
    '"updatedAt":"2024-03-30T00:00:00Z","author":{"login":"bob"},"headRefName":"feature/login","headRefOid":"{sha:feature/login}",'
    '"isCrossRepository":false,"commits":{"nodes":[{"commit":{"statusCheckRollup":{"contexts":{'
    '"checkRunCountsByState":[{"state":"SUCCESS","count":2},{"state":"FAILURE","count":1}],"statusContextCountsByState":[]}}}}]}},'
    '{"number":7,"title":"Fix typo in the readme","url":"https://github.com/ada/demo/pull/7","isDraft":true,'
    '"updatedAt":"2024-03-28T00:00:00Z","author":{"login":"carol"},"headRefName":"fix/typo","headRefOid":"{sha:fix/typo}",'
    '"isCrossRepository":false,"commits":{"nodes":[]}},'
    '{"number":20,"title":"Work that was never fetched","url":"https://github.com/ada/demo/pull/20","isDraft":false,'
    '"updatedAt":"2024-03-01T00:00:00Z","author":{"login":"ada"},"headRefName":"feature/unknown",'
    '"headRefOid":"ffffffffffffffffffffffffffffffffffffffff","isCrossRepository":true,"commits":{"nodes":[]}}'
    ']}},"review":{"nodes":[{"number":12}]}}}'
)
GH_PRS_STUB = (
    "#!/bin/sh\n"
    'case "$1 $2" in\n'
    '"api graphql") cat <<\'EOF\'\n' + GH_PRS_JSON + "\nEOF\n;;\n"
    '*) echo "$@" >> "$HOME/gh.log" ;;\n'
    "esac\n"
)
DEAD_PROXY = "http://127.0.0.1:9"  # nothing listens on the discard port

# Optional stubs a scenario can ask for with `stub <name>`. Each is (binary name, script). Scripts
# log to $HOME so a harness test can read them. They replace nothing unless the scenario names them.
STUBS = {
    # An ssh that fails like a server that rejects the key. It reports a missing BatchMode option,
    # because git must not let ssh prompt for a password under the app.
    "ssh-denied": (
        "ssh",
        "#!/bin/sh\n"
        'echo "$@" >> "$HOME/ssh.log"\n'
        'case "$*" in *BatchMode=yes*) echo "git@example.invalid: Permission denied (publickey)." >&2 ;;\n'
        '*) echo "ssh stub: BatchMode=yes was not set" >&2 ;; esac\n'
        "exit 255\n",
    ),
    # A gh that answers the pull request query with four pull requests, and records any other call.
    # `{sha:REF}` is replaced with the commit REF points to in the fixture, when the scenario starts.
    "gh-prs": ("gh", GH_PRS_STUB),
    # An xdg-open that only records the URL it gets.
    "xdg-open-log": ("xdg-open", '#!/bin/sh\necho "$@" >> "$HOME/xdg-open.log"\n'),
}

KEYS = {
    "enter": "\r", "tab": "\t", "esc": "\x1b", "backspace": "\x7f",
    "up": "\x1b[A", "down": "\x1b[B", "right": "\x1b[C", "left": "\x1b[D",
    "home": "\x1b[H", "end": "\x1b[F", "pageup": "\x1b[5~",
    "pagedown": "\x1b[6~", "delete": "\x1b[3~", "space": " ",
    # xterm modifyOtherKeys, which the apps enable at startup. A terminal has no plain byte for these.
    "ctrl+tab": "\x1b[27;5;9~", "ctrl+shift+tab": "\x1b[27;6;9~",
}  # fmt: skip


def key_bytes(spec: str) -> bytes:
    """Translate "ctrl+k", "up", "a" into the bytes a terminal sends."""
    if spec in KEYS:
        return KEYS[spec].encode()
    if spec.startswith("alt+"):
        return b"\x1b" + key_bytes(spec[4:])
    if spec.startswith("ctrl+") and len(spec) == 6:
        return bytes([ord(spec[5].upper()) & 0x1F])
    if len(spec) == 1:
        return spec.encode()
    raise ValueError(f"unknown key: {spec!r}")


def sgr_mouse(button: int, x: int, y: int, release: bool = False) -> bytes:
    """SGR (1006) mouse report. x and y are 0-based cells."""
    return f"\x1b[<{button};{x + 1};{y + 1}{'m' if release else 'M'}".encode()


@dataclass
class Cell:
    char: str
    fg: str
    bg: str
    attrs: str  # letters: b bold, i italic, u underline, s strike, r reverse, k blink


class Session:
    # The Rust app draws a blank row between hunks. The TS goldens have none, so the app gets TUIG_DIFF_HUNK_GAP=0
    # unless this is True. The TS app ignores the variable. `run.py --hunk-gap` sets this.
    hunk_gap = False

    def __init__(self, argv: list[str], cols: int, rows: int, cwd: Path, stubs: tuple | dict = (), seeds: dict | None = None):
        """`stubs` are names from STUBS, or a dict from binary name to script text. `seeds` maps a path under HOME to its text, written before the app starts."""
        self.cols, self.rows = cols, rows
        self.home = Path(tempfile.mkdtemp(prefix="parity-home-"))
        for d in ("config", "cache", "data", "state", "bin"):
            (self.home / d).mkdir()
        gh = self.home / "bin" / "gh"
        gh.write_text(GH_STUB)
        gh.chmod(0o755)
        for binary, script in (stubs.items() if isinstance(stubs, dict) else (STUBS[name] for name in stubs)):
            (self.home / "bin" / binary).write_text(script)
            (self.home / "bin" / binary).chmod(0o755)
        for rel, text in (seeds or {}).items():
            target = self.home / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(text.replace("{home}", str(self.home)))
        path = f"{self.home / 'bin'}:{os.environ.get('PATH', '/usr/bin:/bin')}"
        env = {
            "PATH": path,
            "HOME": str(self.home),
            "XDG_CONFIG_HOME": str(self.home / "config"),
            "XDG_CACHE_HOME": str(self.home / "cache"),
            "XDG_DATA_HOME": str(self.home / "data"),
            "XDG_STATE_HOME": str(self.home / "state"),
            "TERM": "xterm-256color",
            "COLORTERM": "truecolor",
            "LANG": "C.UTF-8",
            "LC_ALL": "C.UTF-8",
            "TZ": "UTC",
            "COLUMNS": str(cols),
            "LINES": str(rows),
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_TERMINAL_PROMPT": "0",
            # Commits and stashes the app makes get the same identity and date on every run, so
            # their SHAs are stable. The fixtures use dates in March 2024, before this one.
            "GIT_AUTHOR_NAME": "Ada Tester", "GIT_AUTHOR_EMAIL": "ada@example.invalid",
            "GIT_COMMITTER_NAME": "Ada Tester", "GIT_COMMITTER_EMAIL": "ada@example.invalid",
            "GIT_AUTHOR_DATE": "2024-04-01T00:00:00+0000", "GIT_COMMITTER_DATE": "2024-04-01T00:00:00+0000",
            # Not kernel-enforced isolation, but avatar and update fetches fail fast.
            "HTTP_PROXY": DEAD_PROXY, "HTTPS_PROXY": DEAD_PROXY,
            "ALL_PROXY": DEAD_PROXY, "NO_PROXY": "",
        }
        if not Session.hunk_gap:
            env["TUIG_DIFF_HUNK_GAP"] = "0"
        self.screen = pyte.Screen(cols, rows)
        self.stream = pyte.ByteStream(self.screen)
        self.raw = bytearray()
        self._held = b""
        self.last_output = time.monotonic()
        self.last_change = time.monotonic()
        self.last_send = self.last_change
        self._rows: dict[int, tuple] = {}
        # Cells that never count as a change, such as a spinner that does not stop.
        self.ignore: list[tuple[int, int, int, int]] = []
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

        def child_setup() -> None:
            os.setsid()
            fcntl.ioctl(0, termios.TIOCSCTTY, 0)

        self.proc = subprocess.Popen(
            argv, stdin=slave, stdout=slave, stderr=slave, cwd=cwd, env=env,
            preexec_fn=child_setup, close_fds=True,
        )  # fmt: skip
        os.close(slave)
        self.fd = master

    # -- output -----------------------------------------------------------

    # pyte skips the ">" in "CSI > Pm m" (xterm modifyOtherKeys) and runs it as
    # SGR. The app sends "CSI > 4 ; 1 m" at startup, which would set bold and
    # underline on whatever the app draws before its first "CSI 0 m".
    _KEY_MODE = re.compile(rb"\x1b\[>[0-9;]*m")
    _PARTIAL = re.compile(rb"\x1b(?:\[(?:>[0-9;]*)?)?$")

    def feed(self, data: bytes) -> None:
        buf = self._held + data
        buf = self._KEY_MODE.sub(b"", buf)
        tail = self._PARTIAL.search(buf)
        self._held = b""
        if tail:
            self._held, buf = buf[tail.start():], buf[: tail.start()]
        self.stream.feed(buf)

    def pump(self, timeout: float = 0.02) -> bool:
        """Read pending output into the emulator. True if bytes arrived."""
        got = False
        while True:
            ready, _, _ = select.select([self.fd], [], [], timeout)
            if not ready:
                return got
            try:
                data = os.read(self.fd, 65536)
            except OSError:
                return got
            if not data:
                return got
            got = True
            self.raw += data
            self.last_output = time.monotonic()
            self._answer_queries(data)
            self.feed(data)
            self._track_changes()
            timeout = 0

    def _track_changes(self) -> None:
        """Record when a row last changed. Redundant repaints do not count."""
        for y in self.screen.dirty:
            line = self.screen.buffer[y]
            skip = [(x, w) for x, y0, w, h in self.ignore if y0 <= y < y0 + h]
            sig = tuple(
                (c.data, c.fg, c.bg, c.bold, c.italics, c.underscore, c.reverse)
                for c in (line[x] for x in range(self.cols) if not any(x0 <= x < x0 + w for x0, w in skip))
            )
            if self._rows.get(y) != sig:
                self._rows[y] = sig
                self.last_change = time.monotonic()
        self.screen.dirty.clear()

    def _answer_queries(self, data: bytes) -> None:
        # Reply to the terminal queries a real terminal would answer, so the
        # app does not stall waiting for a capability probe.
        if b"\x1b[c" in data or b"\x1b[0c" in data:
            os.write(self.fd, b"\x1b[?62;c")
        if b"\x1b[6n" in data:
            row, col = self.screen.cursor.y + 1, self.screen.cursor.x + 1
            os.write(self.fd, f"\x1b[{row};{col}R".encode())
        # Fixed theme colors: white on black, so a theme probe is repeatable.
        if b"\x1b]10;?" in data:
            os.write(self.fd, b"\x1b]10;rgb:ffff/ffff/ffff\x1b\\")
        if b"\x1b]11;?" in data:
            os.write(self.fd, b"\x1b]11;rgb:0000/0000/0000\x1b\\")

    def wait_quiet(self, quiet_ms: int, timeout: float) -> None:
        """Block until the screen content has not changed for quiet_ms."""
        deadline = time.monotonic() + timeout
        self.pump()
        while time.monotonic() < deadline:
            if (time.monotonic() - max(self.last_change, self.last_send)) * 1000 >= quiet_ms:
                return
            self.pump(0.01)
        raise TimeoutError(f"screen not quiet for {quiet_ms} ms within {timeout}s")

    def wait_text(self, text: str, timeout: float) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.pump(0.02)
            if text in "\n".join(self.screen.display):
                return
        raise TimeoutError(f"text not on screen within {timeout}s: {text!r}")

    _OSC52 = re.compile(rb"\x1b\]52;[a-z]*;([A-Za-z0-9+/=]*)(?:\x07|\x1b\\)")

    def clipboard(self) -> list[str]:
        """Text the app copied with OSC 52, oldest first."""
        out = []
        for m in self._OSC52.finditer(bytes(self.raw)):
            try:
                out.append(base64.b64decode(m.group(1)).decode("utf-8", "replace"))
            except ValueError:
                pass
        return out

    def resize(self, cols: int, rows: int) -> None:
        """Change the terminal size. The kernel sends SIGWINCH to the app."""
        self.cols, self.rows = cols, rows
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        self.screen.resize(rows, cols)
        self._rows.clear()
        self.last_send = time.monotonic()

    # -- input ------------------------------------------------------------

    def send(self, data: bytes) -> None:
        self.last_send = time.monotonic()
        os.write(self.fd, data)

    # -- grid -------------------------------------------------------------

    def cells(self) -> list[list[Cell]]:
        rows = []
        for y in range(self.rows):
            line = self.screen.buffer[y]
            row = []
            for x in range(self.cols):
                c = line[x]
                attrs = "".join(
                    k
                    for k, on in (
                        ("b", c.bold), ("i", c.italics), ("u", c.underscore),
                        ("s", c.strikethrough), ("r", c.reverse), ("k", c.blink),
                    )  # fmt: skip
                    if on
                )
                row.append(Cell(c.data or " ", c.fg, c.bg, attrs))
            rows.append(row)
        return rows

    # -- teardown ---------------------------------------------------------

    def close(self) -> None:
        if self.proc.poll() is None:
            self.proc.send_signal(signal.SIGTERM)
            try:
                self.proc.wait(2)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait()
        os.close(self.fd)
        shutil.rmtree(self.home, ignore_errors=True)
