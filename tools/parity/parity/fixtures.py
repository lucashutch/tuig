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


# One small source file per language the app highlights. `n` makes each
# commit's text differ, so every commit has a diff.
SAMPLES = {
    "py": 'import json\n\n\nclass Task{n}:\n    """Task number {n}."""\n\n    def run(self, items: list[int]) -> dict:\n        total = sum(x * {n} for x in items if x > 0)\n        return {{"total": total, "name": "task-{n}"}}\n',
    "go": 'package main\n\nimport "fmt"\n\n// Task{n} prints its own number.\nfunc Task{n}(items []int) int {{\n\ttotal := 0\n\tfor _, x := range items {{\n\t\ttotal += x * {n}\n\t}}\n\tfmt.Println("task", {n})\n\treturn total\n}}\n',
    "rs": 'use std::collections::HashMap;\n\n/// Task {n}.\npub fn task_{n}(items: &[i32]) -> HashMap<String, i32> {{\n    let total: i32 = items.iter().filter(|x| **x > 0).map(|x| x * {n}).sum();\n    let mut out = HashMap::new();\n    out.insert("total".to_string(), total);\n    out\n}}\n',
    "ts": 'export interface Task{n} {{\n  id: number;\n  name: string;\n}}\n\nexport function makeTask{n}(name: string): Task{n} {{\n  const id: number = {n} * 2;\n  return {{ id, name }};\n}}\n',
    "tsx": 'import React from "react";\n\nexport const Task{n} = ({{ label }}: {{ label: string }}) => {{\n  const count = {n};\n  return <div className="task">{{label}} {{count}}</div>;\n}};\n',
    "js": '// Task {n}\nconst items = [1, 2, 3];\n\nfunction task{n}(list = items) {{\n  return list.map((x) => x * {n}).filter(Boolean);\n}}\n\nmodule.exports = {{ task{n} }};\n',
    "json": '{{\n  "name": "task-{n}",\n  "version": "1.{n}.0",\n  "private": true,\n  "tags": ["a", "b"],\n  "limits": {{ "max": {n}, "enabled": true }}\n}}\n',
    "sh": '#!/usr/bin/env bash\nset -euo pipefail\n\n# Task {n}\nrun_task_{n}() {{\n  local name="$1"\n  if [ -n "$name" ]; then\n    echo "task {n}: $name"\n  fi\n}}\n\nrun_task_{n} "$@"\n',
    "c": '#include <stdio.h>\n\n/* Task {n} */\nstatic int task_{n}(const int *items, int len) {{\n    int total = 0;\n    for (int i = 0; i < len; i++) {{\n        total += items[i] * {n};\n    }}\n    return total;\n}}\n',
    "cpp": '#include <vector>\n#include <string>\n\nnamespace tasks {{\n// Task {n}\nclass Task{n} {{\npublic:\n    int run(const std::vector<int>& items) const {{\n        int total = 0;\n        for (auto x : items) total += x * {n};\n        return total;\n    }}\n}};\n}}\n',
    "css": '/* Task {n} */\n.task-{n} {{\n  color: #3366{n:02d};\n  margin: {n}px auto;\n  display: flex;\n}}\n\n.task-{n}:hover {{\n  background: rgba(0, 0, 0, 0.1);\n}}\n',
    "html": '<!doctype html>\n<html lang="en">\n  <head>\n    <title>Task {n}</title>\n  </head>\n  <body class="task-{n}">\n    <h1 id="title">Task {n}</h1>\n    <a href="/tasks/{n}">Open</a>\n  </body>\n</html>\n',
    "md": '# Task {n}\n\nThis is **task {n}** with a [link](https://example.invalid/{n}).\n\n- first item\n- second item\n\n```sh\nmake task-{n}\n```\n',
}
EXT_ORDER = list(SAMPLES)


def sample(ext: str, n: int) -> str:
    return SAMPLES[ext].format(n=n)


def long_python(n: int) -> str:
    """A 150-line module, to give one commit a diff taller than the pane."""
    out = ["import json\n", "\n"]
    for i in range(n):
        out.append(f"def step_{i:03d}(value):\n")
        out.append(f'    """Step {i}."""\n')
        out.append(f"    return json.dumps({{'step': {i}, 'value': value}})\n")
    return "".join(out)


def build_history(dest: Path, commits: int = 300) -> Path:
    """About `commits` commits on main with side branches that merge back.

    Two branches run at once for every group, so the graph has 3 lanes. Branch
    commits touch only files owned by that branch, so merges never conflict.
    The last 14 commits each add one file in a different language.
    """
    repo = Repo(dest)
    dest.mkdir(parents=True)
    repo.git("init", "-q", "-b", "main")
    repo.git("config", "core.autocrlf", "false")
    repo.git("config", "commit.gpgsign", "false")

    repo.write("README.md", "# History\n\nA long fixture history.\n")
    repo.commit("chore: initial commit")
    count = 1
    group = 0
    tail = 14  # language commits at the tip, and the merge-free finish
    while count < commits - tail:
        group += 1
        names = [f"topic/g{group:02d}-a", f"topic/g{group:02d}-b"]
        for name in names:
            repo.git("switch", "-q", "-c", name, "main")
            for j in range(2 + group % 3):
                ext = EXT_ORDER[(group + j) % len(EXT_ORDER)]
                repo.write(f"topics/g{group:02d}{name[-1]}.{ext}", sample(ext, group * 10 + j))
                repo.commit(f"feat: {name} step {j + 1}")
                count += 1
            repo.git("switch", "-q", "main")
            # Interleave a mainline commit so lanes overlap.
            repo.write(f"src/main_{group:02d}{name[-1]}.py", sample("py", group))
            repo.commit(f"chore: mainline work {group:02d}{name[-1]}")
            count += 1
        for name in names:
            repo.merge(name, f"merge: {name}")
            count += 1
        if group % 5 == 0:
            repo.git("tag", f"v0.{group}")
    while count < commits - tail:
        repo.write(f"src/filler_{count}.py", sample("py", count))
        repo.commit(f"chore: filler {count}")
        count += 1

    repo.write("src/steps.py", long_python(50))
    repo.commit("feat: add a long steps module")
    for n, ext in enumerate(EXT_ORDER, start=1):
        repo.write(f"showcase/sample.{ext}", sample(ext, n))
        repo.commit(f"feat({ext}): add {ext} sample")
    return dest


def build_long(dest: Path) -> Path:
    return build_history(dest, 300)


def build_second(dest: Path) -> Path:
    """A small clean repository, to open as a second tab."""
    repo = Repo(dest)
    dest.mkdir(parents=True)
    repo.git("init", "-q", "-b", "main")
    repo.git("config", "commit.gpgsign", "false")
    repo.write("notes.md", "# Second\n")
    repo.commit("chore: start second")
    repo.git("switch", "-q", "-c", "dev")
    repo.write("notes.md", "# Second\n\nMore.\n")
    repo.commit("docs: extend notes")
    repo.git("switch", "-q", "main")
    return dest


def _clean(dest: Path) -> Repo:
    """The demo history with no working changes."""
    repo = Repo(build_demo(dest))
    repo.git("reset", "-q", "--hard")
    repo.git("clean", "-fdq")
    return repo


def _bare_origin(repo: Repo, *branches: str) -> Path:
    bare = repo.path.parent / "origin.git"
    repo.git("init", "-q", "--bare", "-b", "main", str(bare))
    repo.git("remote", "add", "origin", str(bare))
    repo.git("push", "-q", "origin", *branches, "--tags")
    repo.git("fetch", "-q", "origin")
    return bare


def build_linked(dest: Path) -> Path:
    """Demo history, clean tree, with one of everything the sidebar lists: a remote with branches,
    two stashes, a second worktree and a submodule."""
    repo = Repo(dest)
    build_demo(dest)
    repo.git("stash", "push", "-q", "-u", "-m", "wip: sidebar spike", date=True)
    repo.write("scratch.txt", "scratch\n")
    repo.git("stash", "push", "-q", "-u", "-m", "wip: scratch", date=True)
    _bare_origin(repo, "main", "feature/login", "fix/typo")
    repo.git("worktree", "add", "-q", str(dest.parent / "linked-wt"), "feature/login")
    lib = Repo(dest.parent / "libsub")
    lib.path.mkdir()
    lib.git("init", "-q", "-b", "main")
    lib.write("lib.txt", "lib\n")
    lib.commit("chore: library start")
    repo.git("config", "protocol.file.allow", "always")
    repo.git("-c", "protocol.file.allow=always", "submodule", "add", "-q", "../libsub", "vendor/libsub")
    repo.git("commit", "-q", "-m", "chore: add libsub submodule", date=True)
    return dest


def build_behind(dest: Path) -> Path:
    """Clean demo whose origin has one commit that the repository has not fetched."""
    repo = _clean(dest)
    bare = _bare_origin(repo, "main")
    repo.git("branch", "-u", "origin/main", "main")
    repo.git("clone", "-q", str(bare), str(dest.parent / "other"))
    other = Repo(dest.parent / "other")
    other.write("remote.txt", "remote\n")
    other.commit("feat: remote commit from another clone", "remote.txt")
    other.git("push", "-q", "origin", "main")
    return dest


def build_slow_remote(dest: Path) -> Path:
    """Demo history with one untracked file, whose origin takes 30 s to answer a fetch, so Esc and busy
    states can be tested."""
    repo = _clean(dest)
    _bare_origin(repo, "main")
    repo.git("branch", "-u", "origin/main", "main")
    script = dest.parent / "slow-upload-pack"
    script.write_text('#!/bin/sh\nexec sleep 30\n')
    script.chmod(0o755)
    repo.git("config", "remote.origin.uploadpack", str(script))
    repo.write("scratch.txt", "scratch\n")  # something for Stash to take, so a refused Stash shows
    return dest


def build_ssh_remote(dest: Path) -> Path:
    """Clean demo whose origin is an ssh URL. Use it with the `ssh-denied` stub: no network is used."""
    repo = _clean(dest)
    repo.git("remote", "add", "origin", "ssh://git@example.invalid/team/repo.git")
    repo.git("config", "branch.main.remote", "origin")
    repo.git("config", "branch.main.merge", "refs/heads/main")
    return dest


def build_bigdiff(dest: Path) -> Path:
    """Clean tree except three edits. `data/lines.py` gives a diff of about 24k lines, which is
    shown without highlight. `data/huge.py` gives one of about 6 MiB, which needs Shift+L. `data/small.py` replaces all of 60
    lines, so the diff has 120 rows but line numbers up to 60."""
    repo = Repo(dest)
    dest.mkdir(parents=True)
    repo.git("init", "-q", "-b", "main")
    repo.git("config", "commit.gpgsign", "false")
    repo.write("README.md", "# Big diff\n")
    repo.write("data/lines.py", "".join(f"v{i} = {i}\n" for i in range(12000)))
    pad = "x" * 40
    repo.write("data/huge.py", "".join(f"value_{i:06d} = '{pad}'\n" for i in range(70000)))
    repo.write("data/small.py", "".join(f"s{i} = {i}\n" for i in range(60)))
    repo.commit("chore: add data")
    repo.write("data/lines.py", "".join(f"v{i} = {i + 1}\n" for i in range(12000)))
    repo.write("data/huge.py", "".join(f"value_{i:06d} = '{pad.upper()}'\n" for i in range(70000)))
    repo.write("data/small.py", "".join(f"s{i} = {i + 1}\n" for i in range(60)))  # 60 lines, 120 diff rows
    return dest


def build_lanes(dest: Path) -> Path:
    """Sixteen branches that stay open at the same time and merge into main, so the graph is wider than
    its column and can be panned."""
    repo = Repo(dest)
    dest.mkdir(parents=True)
    repo.git("init", "-q", "-b", "main")
    repo.git("config", "commit.gpgsign", "false")
    repo.write("README.md", "# Lanes\n")
    repo.commit("chore: initial commit")
    names = [f"lane/l{i}" for i in range(1, 17)]
    for name in names:
        repo.git("branch", name, "main")
    for step in range(1, 4):
        for name in names:
            repo.git("switch", "-q", name)
            repo.write(f"{name.split('/')[1]}.txt", f"{name} step {step}\n")
            repo.commit(f"feat: {name} step {step}")
    repo.git("switch", "-q", "main")
    for name in names:
        repo.merge(name, f"merge: {name}")
    return dest


FIXTURES = {
    "demo": build_demo, "history": build_long, "second": build_second,
    "lanes": build_lanes, "linked": build_linked, "behind": build_behind, "slow-remote": build_slow_remote, "ssh-remote": build_ssh_remote, "bigdiff": build_bigdiff,
}  # fmt: skip


def build(name: str, parent: Path) -> Path:
    """Build fixture `name` at parent/<name>. The basename shows in the UI."""
    return FIXTURES[name](parent / name)
