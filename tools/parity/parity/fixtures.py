"""Deterministic fixture repositories.

Every commit uses a fixed identity and a fixed date, so SHAs are identical on
every run and on every machine with the same Git object format.
"""

from __future__ import annotations

import os
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path

IDENTITY = {
    "GIT_AUTHOR_NAME": "Ada Tester",
    "GIT_AUTHOR_EMAIL": "ada@example.invalid",
    "GIT_COMMITTER_NAME": "Ada Tester",
    "GIT_COMMITTER_EMAIL": "ada@example.invalid",
}
BASE_ENV = {
    "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
    "GIT_CONFIG_GLOBAL": os.devnull,
    "GIT_CONFIG_NOSYSTEM": "1",
    "LC_ALL": "C",
    "TZ": "UTC",
}


class Repo:
    def __init__(self, path: Path):
        self.path = path
        self.tick = 0

    def git(self, *args: str, date: bool = False) -> str:
        env = {**BASE_ENV, **IDENTITY}
        if date:
            self.tick += 1
            # One commit per hour from 2024-03-01 10:00 UTC.
            when = datetime(2024, 3, 1, 10, tzinfo=timezone.utc) + timedelta(hours=self.tick)
            stamp = when.strftime("%Y-%m-%dT%H:%M:%S+0000")
            env["GIT_AUTHOR_DATE"] = env["GIT_COMMITTER_DATE"] = stamp
        out = subprocess.run(
            ["git", *args], cwd=self.path, env=env, check=True,
            capture_output=True, text=True,
        )  # fmt: skip
        return out.stdout

    def write(self, rel: str, text: str) -> None:
        p = self.path / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)

    def commit(self, message: str, *paths: str) -> None:
        self.git("add", "-A", *(paths or (".",)))
        self.git("commit", "-q", "-m", message, date=True)

    def merge(self, branch: str, message: str) -> None:
        self.git("merge", "-q", "--no-ff", "-m", message, branch, date=True)


def server_source(variant: int = 0) -> str:
    """A 60-line file. Variant 1 edits lines far enough apart to give 3 hunks."""
    lines = [f"def handler_{i:02d}(request):\n    return {i}\n" for i in range(30)]
    text = "".join(lines)
    if variant:
        rows = text.splitlines(keepends=True)
        rows[1] = "    return 'first'\n"
        rows[31] = "    return 'middle'\n"
        rows[57] = "    return 'last'\n"
        text = "".join(rows)
    return text


def build_demo(dest: Path) -> Path:
    """Branches, merges, a tag, a rename, and every kind of working change."""
    repo = Repo(dest)
    dest.mkdir(parents=True)
    repo.git("init", "-q", "-b", "main")
    repo.git("config", "core.autocrlf", "false")
    repo.git("config", "commit.gpgsign", "false")

    repo.write("README.md", "# Demo\n\nA fixture project for parity tests.\n")
    repo.write("src/server.py", server_source())
    repo.write("src/old_name.py", "VALUE = 1\nOTHER = 2\nLAST = 3\n")
    repo.commit("chore: initial commit")

    repo.write("docs/guide.md", "# Guide\n\nStart here.\n")
    repo.commit("docs: add guide")
    repo.git("tag", "v0.1")

    repo.git("switch", "-q", "-c", "feature/login")
    repo.write("src/login.py", "def login(user):\n    return user.strip()\n")
    repo.commit("feat: add login")
    repo.write("src/login.py", "def login(user):\n    return user.strip().lower()\n")
    repo.commit("feat: normalise user names")

    repo.git("switch", "-q", "main")
    repo.git("switch", "-q", "-c", "fix/typo")
    repo.write("README.md", "# Demo\n\nA fixture project for parity tests.\n\nSee docs/guide.md.\n")
    repo.commit("docs: link the guide from the readme")

    repo.git("switch", "-q", "main")
    repo.write("src/util.py", "def clamp(x, lo, hi):\n    return max(lo, min(hi, x))\n")
    repo.commit("feat: add clamp helper")
    repo.merge("feature/login", "merge: feature/login into main")
    repo.git("mv", "src/old_name.py", "src/new_name.py")
    repo.commit("refactor: rename old_name to new_name")
    repo.merge("fix/typo", "merge: fix/typo into main")
    repo.git("tag", "v1.0")
    repo.git("branch", "release/1.0")
    repo.write("docs/guide.md", "# Guide\n\nStart here.\n\n## Install\n\nRun make.\n")
    repo.commit("docs: describe installation")

    # Working tree: staged modify, staged add, staged rename, unstaged
    # multi-hunk edit, untracked file.
    repo.write("src/util.py", "def clamp(x, lo, hi):\n    return max(lo, min(hi, x))\n\n\ndef sign(x):\n    return (x > 0) - (x < 0)\n")
    repo.git("add", "src/util.py")
    repo.write("src/staged_new.py", "NEW = True\n")
    repo.git("add", "src/staged_new.py")
    repo.git("mv", "src/login.py", "src/auth.py")
    repo.write("src/server.py", server_source(1))
    repo.write("notes.txt", "scratch notes\n")
    return dest


FIXTURES = {"demo": build_demo}


def build(name: str, parent: Path) -> Path:
    """Build fixture `name` at parent/<name>. The basename shows in the UI."""
    return FIXTURES[name](parent / name)
