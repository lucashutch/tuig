#!/usr/bin/env python3
"""Check that the TS and Rust apps leave a repository in the same state after the same input.

Each case builds a fresh repo, runs one app on it under a PTY, plays the steps, closes the app and
snapshots the repo (commits, refs, stashes, HEAD, index, status, work tree, remote refs). The two
snapshots must be equal. The commit dates are fixed in `session.py`, but SHAs are still not compared;
commits are compared by message, author, committer, tree and parent subjects. Run from anywhere:

    python3 tools/parity/mutations.py [--ts CMD] [--rust CMD] [--list] [--screen] [case ...]

Exit code is 1 on any mismatch or failed step. See CASES for the step format.
"""

from __future__ import annotations

import argparse
import difflib
import hashlib
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path[:0] = [str(HERE / ".deps"), str(HERE)]

from parity import fixtures  # noqa: E402
from parity.scenario import app_argv  # noqa: E402
from parity.session import Session, key_bytes, sgr_mouse  # noqa: E402

APPS = {
    "ts": f"bun run {ROOT}/src/index.ts --clean {{repo}}",
    "rust": f"{ROOT}/rust/target/release/tuig --clean {{repo}}",
}
COLS, ROWS = 160, 48
QUIET_MS, TIMEOUT, FINAL_QUIET_MS = 300, 15.0, 1000

# Screen coordinates (0-based column, row). They are the same in both apps at 160x48.
FETCH, PULL, PUSH, UNDO, STASH, POP = (53, 1), (62, 1), (70, 1), (78, 1), (86, 1), (95, 1)
DISCARD_ALL, STAGE_ALL, UNSTAGE_ALL = (122, 3), (150, 3), (148, 19)
WORKING_ROW = (60, 4)  # "Working Changes" row in the graph
SERVER_PY = (118, 6)  # first unstaged file (3-hunk edit)
PLUS_LINE = (30, 6)  # the "+ return 'first'" line of the server.py diff
UTIL_PY = (118, 23)  # last staged file
EDIT_MESSAGE = (146, 3)  # on the clean fixture; on demo (working changes) it is row 5
AMEND_BOX, COMMIT_BUTTON, SAVE_MESSAGE = (118, 44), (118, 45), (118, 45)
# Graph rows on the demo fixture, newest first (row 4 is Working Changes).
HEAD_ROW, REFACTOR_ROW, NORMALISE_ROW, GUIDE_ROW = 5, 7, 11, 13
FIX_TYPO_LABEL = (36, 10)


def menu(row: int, item: str) -> list[tuple]:
    """Right-click graph row `row` and pick `item`. Items sit at fixed offsets below the click."""
    offsets = {"checkout": 3, "rebase": 4, "branch": 6, "cherry-pick": 7, "tag": 8}
    return [("rclick", 60, row), ("wait", "Select for comparison"), ("click", 62, row + offsets[item])]


def reset(row: int, mode: str) -> list[tuple]:
    sub = {"soft": 6, "mixed": 7, "hard": 8}[mode]
    steps = [("rclick", 60, row), ("wait", "Select for comparison"), ("click", 62, row + 5),
             ("wait", "Soft"), ("click", 100, row + sub)]  # fmt: skip
    return steps + ([("wait", "Reset --hard"), ("key", "enter")] if mode == "hard" else [])


def name_prompt(name: str) -> list[tuple]:
    return [("wait", "Enter confirm"), ("text", name), ("key", "enter")]


def commit(summary: str, body: str = "") -> list[tuple]:
    steps = [("key", "c"), ("text", summary)]
    if body:
        steps += [("key", "tab"), ("text", body)]
    return steps + [("click", *COMMIT_BUTTON)]


def edit_message(row: int, suffix: str) -> list[tuple]:
    return [("click", 60, row), ("wait", "COMMIT FILES"), ("click", *EDIT_MESSAGE), ("wait", "Save message"),
            ("text", suffix), ("click", *SAVE_MESSAGE)]  # fmt: skip


OPEN_SERVER = [("click", *WORKING_ROW), ("click", *SERVER_PY), ("wait", "handler_00")]
OPEN_UTIL = [("click", *WORKING_ROW), ("click", *UTIL_PY), ("wait", "def sign")]

# A case is a fixture name plus steps. Steps:
#   ("wait", text)        block until text is on screen
#   ("key", "a b ctrl+p") send named keys, one after another
#   ("text", "abc")       type text
#   ("click", x, y) / ("rclick", x, y) / ("dclick", x, y)
#   ("palette", "title")  open the command palette, type the title, Enter
# Every step is followed by a wait for a quiet screen.
CASES: dict[str, tuple[str, list[tuple]]] = {
    "stage-line": ("demo", [*OPEN_SERVER, ("click", *PLUS_LINE), ("key", "enter")]),
    "unstage-line": ("demo", [*OPEN_UTIL, ("click", 30, 6), ("key", "enter")]),
    "stage-hunk": ("demo", [*OPEN_SERVER, ("key", "h")]),
    "stage-file": ("demo", [*OPEN_SERVER, ("key", "s")]),
    "unstage-file": ("demo", [*OPEN_UTIL, ("key", "u")]),
    "stage-all": ("demo", [("key", "a")]),
    "stage-all-button": ("demo", [("click", *STAGE_ALL)]),
    "unstage-all-palette": ("demo", [("palette", "Unstage all changes")]),
    "unstage-all-button": ("demo", [("click", *UNSTAGE_ALL)]),
    "discard-all": ("demo", [("key", "d"), ("key", "d")]),
    "discard-all-armed-only": ("demo", [("key", "d")]),
    "commit": ("demo", commit("Fix login redirect", "Explain the change")),
    "commit-summary-only": ("demo", commit("Only a summary")),
    "amend": ("demo", [("key", "c"), ("text", "Amended summary"), ("click", *AMEND_BOX),
                       ("wait", "[x] Amend previous commit"), ("click", *COMMIT_BUTTON)]),  # fmt: skip
    # Rewording needs a clean work tree, so these use the clean fixture (rows one higher than on demo).
    "edit-message-head": ("clean", edit_message(HEAD_ROW - 1, " (reworded)")),
    "edit-message-past": ("clean", edit_message(NORMALISE_ROW - 1, " (reworded)")),
    "stash": ("demo", [("click", *STASH)]),
    "stash-pop": ("demo", [("click", *STASH), ("click", *POP)]),
    "branch-create": ("demo", [*menu(REFACTOR_ROW, "branch"), *name_prompt("feature/menu")]),
    "tag-create": ("demo", [*menu(REFACTOR_ROW, "tag"), *name_prompt("v9.9")]),
    "reset-soft": ("demo", reset(REFACTOR_ROW, "soft")),
    "reset-mixed": ("demo", reset(REFACTOR_ROW, "mixed")),
    "reset-hard": ("demo", reset(REFACTOR_ROW, "hard")),
    # Clean fixtures have no Working Changes row, so every commit row is one higher than on demo.
    "checkout-detached": ("clean", menu(GUIDE_ROW - 1, "checkout")),
    "checkout-label": ("clean", [("dclick", FIX_TYPO_LABEL[0], FIX_TYPO_LABEL[1] - 1)]),
    "rebase": ("side", menu(4, "rebase")),
    "cherry-pick": ("side", menu(4, "cherry-pick")),
    "branch-delete": ("demo", [("rclick", 34, 10), ("wait", "Delete fix/typo"), ("click", 40, 16),
                      ("wait", "Delete local branch"), ("key", "enter")]),  # fmt: skip
    "tag-delete": ("demo", [("rclick", 40, 13), ("wait", "Delete v0.1"), ("click", 45, 15),
                    ("wait", "Delete local tag"), ("key", "enter")]),  # fmt: skip
    "undo": ("clean-staged", [*commit("Undo me"), ("click", *UNDO), ("wait", "Undo local history"), ("key", "enter")]),
    "fetch": ("remote-behind", [("key", "f")]),
    "pull": ("remote-behind", [("key", "l")]),
    "push": ("remote-ahead", [("key", "p")]),
    "fetch-button": ("remote-behind", [("click", *FETCH)]),
    "pull-button": ("remote-behind", [("click", *PULL)]),
    "push-button": ("remote-ahead", [("click", *PUSH)]),
    # Palette entries. The apps use the same titles.
    "fetch-palette": ("remote-behind", [("palette", "Fetch remotes")]),
    "pull-palette": ("remote-behind", [("palette", "Pull current branch")]),
    "push-palette": ("remote-ahead", [("palette", "Push current branch")]),
    "stash-palette": ("demo", [("palette", "Stash working changes")]),
    "stash-pop-palette": ("demo", [("click", *STASH), ("palette", "Pop latest stash")]),
    "stage-all-palette": ("demo", [("palette", "Stage all changes")]),
    # The first run arms the discard and asks for a second one.
    "discard-all-palette": ("demo", [("palette", "Discard all unstaged changes"), ("palette", "Discard all unstaged changes")]),
    "stage-selected-palette": ("demo", [*OPEN_SERVER, ("palette", "Stage selected file")]),
    "unstage-selected-palette": ("demo", [*OPEN_UTIL, ("palette", "Unstage selected file")]),
    # Changed-file context menu. The menu opens at the click, and its first item is one row below.
    "file-menu-stage": ("demo", [("rclick", 124, 6), ("wait", "Stage server.py"), ("click", 126, 7)]),
    "file-menu-discard": ("demo", [("rclick", 124, 6), ("wait", "Discard changes in"), ("click", 126, 8), ("wait", "Discard"), ("key", "enter")]),
    "file-menu-discard-untracked": ("demo", [("rclick", 124, 7), ("wait", "Discard changes in"), ("click", 126, 9), ("wait", "Discard"), ("key", "enter")]),
    "file-menu-unstage": ("demo", [("rclick", 124, 23), ("wait", "Unstage util.py"), ("click", 126, 24)]),
    # Sidebar stash menu: Rename, Apply, Pop, Drop. Worktree menu: Open, Lock, Remove, Copy path.
    # Submodule menu: Open, Update, Update and initialize, Sync URL, Copy path.
    "stash-apply-menu": ("linked", [("rclick", 8, 32), ("wait", "Apply stash"), ("click", 10, 34)]),
    "stash-apply-menu-staged": ("linked", [("rclick", 8, 34), ("wait", "Apply stash"), ("click", 10, 36)]),
    "stash-pop-menu": ("linked", [("rclick", 8, 32), ("wait", "Pop stash"), ("click", 10, 35), ("wait", "Cancel"), ("key", "enter")]),
    "stash-drop-menu": ("linked", [("rclick", 8, 32), ("wait", "Drop stash"), ("click", 10, 36), ("wait", "Drop"), ("key", "enter")]),
    "stash-rename-menu": ("linked", [("rclick", 8, 32), ("wait", "Rename stash"), ("click", 10, 33), *name_prompt(" renamed")]),
    "worktree-lock-menu": ("linked", [("rclick", 8, 43), ("wait", "Lock linked-wt"), ("click", 10, 44)]),
    "worktree-unlock-menu": ("linked-locked", [("rclick", 8, 43), ("wait", "Unlock linked-wt"), ("click", 10, 44)]),
    "worktree-remove-menu": ("linked", [("rclick", 8, 43), ("wait", "Remove linked-wt"), ("click", 10, 45), ("wait", "Remove"), ("key", "enter")]),
    # The submodule is behind the commit the checked-out branch records, so Update moves it.
    "submodule-update-menu": ("linked-behind", [("rclick", 8, 23), ("wait", "Update vendor"), ("click", 10, 25)]),
    "submodule-sync-menu": ("linked-sync", [("rclick", 8, 23), ("wait", "Sync URL"), ("click", 10, 27)]),
    "submodule-update-init-menu": ("linked-uninit", [("rclick", 8, 23), ("wait", "Update and initialize"), ("click", 10, 26)]),
    # Checkout through the sidebar menu moves the submodule to the commit the branch records.
    "checkout-submodule-bump": ("linked-bump", [("rclick", 8, 4), ("wait", "Checkout bump"), ("click", 12, 5)]),
}

# Rust has no binding for these keys (see rust/crates/tuig-app/src/keys.rs). The Rust run uses the
# palette or a toolbar button instead. --native-keys sends the real key to Rust.
RUST_FALLBACK = {
    "s": [("palette", "Stage selected file")],
    "u": [("palette", "Unstage selected file")],
    "a": [("click", *STAGE_ALL)],
    "d": [("click", *DISCARD_ALL)],
    "f": [("click", *FETCH)],
    "l": [("click", *PULL)],
    "p": [("click", *PUSH)],
}


# -- fixtures -------------------------------------------------------------------------------------
def build_demo(work: Path) -> Path:
    repo = fixtures.build("demo", work)
    r = fixtures.Repo(repo)
    r.git("config", "user.name", "Ada Tester")  # the app runs git with no global config
    r.git("config", "user.email", "ada@example.invalid")
    return repo


def build_remote(work: Path, ahead: bool) -> Path:
    """Clean demo repo whose main tracks a local bare origin. `ahead`: the repo has one extra commit.
    Otherwise a second clone pushed one commit that the repo has not fetched yet."""
    repo = build_clean(work)
    r = fixtures.Repo(repo)
    bare = work / "origin.git"
    r.git("init", "-q", "--bare", "-b", "main", str(bare))
    r.git("remote", "add", "origin", str(bare))
    r.git("push", "-q", "-u", "origin", "main", "--tags")
    if ahead:
        r.write("local.txt", "local\n")
        r.commit("feat: local commit ahead of origin", "local.txt")
    else:
        r.git("clone", "-q", str(bare), str(work / "other"))
        other = fixtures.Repo(work / "other")
        other.git("config", "user.name", "Bob Remote")
        other.git("config", "user.email", "bob@example.invalid")
        other.write("remote.txt", "remote\n")
        other.commit("feat: remote commit from another clone", "remote.txt")
        other.git("push", "-q", "origin", "main")
    return repo


def build_clean(work: Path) -> Path:
    repo = build_demo(work)
    r = fixtures.Repo(repo)
    r.git("reset", "-q", "--hard")
    r.git("clean", "-fdq")
    return repo


def build_clean_staged(work: Path) -> Path:
    """Demo history with a clean tree except one staged change, so a commit leaves the tree clean (Undo needs that)."""
    repo = build_clean(work)
    r = fixtures.Repo(repo)
    r.write("README.md", "# Demo\n\nA fixture project for parity tests.\n\nStaged edit.\n")
    r.git("add", "README.md")
    return repo


def build_side(work: Path) -> Path:
    """Clean demo plus branch `side` with one commit (side.txt) that main does not have. It is the newest commit."""
    repo = build_clean(work)
    r = fixtures.Repo(repo)
    base = r.git("rev-parse", "v0.1^{tree}").strip()
    index = work / "side.index"
    env = {**fixtures.BASE_ENV, **fixtures.IDENTITY, "GIT_INDEX_FILE": str(index),
           "GIT_AUTHOR_DATE": "2024-03-02T10:00:00+0000", "GIT_COMMITTER_DATE": "2024-03-02T10:00:00+0000"}  # fmt: skip

    def run(*args: str, stdin: str = "") -> str:
        return subprocess.run(["git", *args], cwd=repo, env=env, input=stdin, check=True, capture_output=True, text=True).stdout.strip()

    run("read-tree", base)
    blob = run("hash-object", "-w", "--stdin", stdin="side\n")
    run("update-index", "--add", "--cacheinfo", f"100644,{blob},side.txt")
    commit_id = run("commit-tree", run("write-tree"), "-p", r.git("rev-parse", "v0.1").strip(), "-m", "feat: side branch commit")
    r.git("branch", "side", commit_id)
    return repo


def build_linked(work: Path) -> Path:
    """Demo history, clean tree, a remote, two stashes, a second worktree and a submodule (`fixtures.build_linked`)."""
    return fixtures.build("linked", work)


def build_linked_sync(work: Path) -> Path:
    """`linked`, with a committed `.gitmodules` URL that differs from the URL in `.git/config`."""
    repo = build_linked(work)
    r = fixtures.Repo(repo)
    r.git("config", "-f", ".gitmodules", "submodule.vendor/libsub.url", "../libsub-moved")
    r.git("add", ".gitmodules")
    r.git("commit", "-q", "-m", "chore: move the submodule", date=True)
    return repo


def build_linked_uninit(work: Path) -> Path:
    """`linked`, with the submodule listed but not initialized."""
    repo = build_linked(work)
    fixtures.Repo(repo).git("submodule", "deinit", "-f", "vendor/libsub")
    return repo


def build_linked_bump(work: Path) -> Path:
    """`linked`, plus branch `bump` whose commit moves the submodule to a newer commit. main is checked out
    and the submodule is at the older commit."""
    repo = build_linked(work)
    r = fixtures.Repo(repo)
    lib = fixtures.Repo(work / "libsub")
    lib.write("lib.txt", "lib, newer\n")
    lib.commit("feat: newer library")
    newer = lib.git("rev-parse", "HEAD").strip()
    older = r.git("rev-parse", "HEAD:vendor/libsub").strip()
    r.git("switch", "-q", "-c", "bump")
    sub = fixtures.Repo(repo / "vendor" / "libsub")
    sub.git("fetch", "-q", "origin")
    sub.git("checkout", "-q", newer)
    r.git("add", "vendor/libsub")
    r.git("commit", "-q", "-m", "chore: bump the library", date=True)
    r.git("switch", "-q", "main")
    sub.git("checkout", "-q", older)
    return repo


def build_linked_locked(work: Path) -> Path:
    """`linked`, with the second worktree locked."""
    repo = build_linked(work)
    fixtures.Repo(repo).git("worktree", "lock", str(work / "linked-wt"))
    return repo


def build_linked_behind(work: Path) -> Path:
    """`linked-bump` with `bump` checked out and the submodule left at the older commit."""
    repo = build_linked_bump(work)
    fixtures.Repo(repo).git("switch", "-q", "bump")
    return repo


FIXTURE_BUILDERS = {
    "linked-locked": build_linked_locked,
    "linked-behind": build_linked_behind,
    "linked": build_linked,
    "linked-sync": build_linked_sync,
    "linked-uninit": build_linked_uninit,
    "linked-bump": build_linked_bump,
    "demo": build_demo,
    "clean": build_clean,
    "clean-staged": build_clean_staged,
    "side": build_side,
    "remote-ahead": lambda w: build_remote(w, True),
    "remote-behind": lambda w: build_remote(w, False),
}


# -- state snapshot -------------------------------------------------------------------------------
def git(path: Path, *args: str) -> str:
    return fixtures.Repo(path).git(*args)


def subject_map(path: Path) -> dict[str, str]:
    out = git(path, "log", "--all", "--format=%H\x1f%s")
    return dict(line.split("\x1f", 1) for line in out.splitlines())


def refs_state(path: Path) -> list[str]:
    subj = subject_map(path)
    fmt = "%(refname)\x1f%(objecttype)\x1f%(objectname)\x1f%(*objectname)\x1f%(contents:subject)"
    lines = []
    for line in git(path, "for-each-ref", f"--format={fmt}").splitlines():
        ref, kind, oid, peeled, msg = line.split("\x1f")
        target = peeled or oid
        tree = git(path, "rev-parse", f"{target}^{{tree}}").strip()[:10]
        lines.append(f"{ref} {kind} -> {subj.get(target, '?')!r} tree={tree}" + (f" tag-msg={msg!r}" if kind == "tag" else ""))
    return sorted(lines)


def commits_state(path: Path) -> list[str]:
    subj = subject_map(path)
    out = git(path, "log", "--all", "--format=%H\x1f%P\x1f%T\x1f%an <%ae>\x1f%cn <%ce>\x1f%B\x1e")
    lines = []
    for rec in out.split("\x1e"):
        if not rec.strip():
            continue
        sha, parents, tree, author, committer, body = rec.strip("\n").split("\x1f", 5)
        par = [subj.get(p, "?") for p in parents.split()]
        lines.append(f"{subj[sha]!r} tree={tree[:10]} parents={par} author={author} committer={committer} msg={body!r}")
    return sorted(lines)


def worktree_state(path: Path) -> list[str]:
    out = []
    for p in sorted(path.rglob("*")):
        rel = p.relative_to(path)
        if rel.parts[0] == ".git" or not p.is_file():
            continue
        out.append(f"{rel} {'x' if p.stat().st_mode & 0o100 else '-'} {hashlib.sha1(p.read_bytes()).hexdigest()[:10]}")
    return out


def head_state(path: Path) -> str:
    try:
        return git(path, "symbolic-ref", "-q", "HEAD").strip()
    except subprocess.CalledProcessError:
        return "(detached) " + subject_map(path).get(git(path, "rev-parse", "HEAD").strip(), "?")


def repo_state(path: Path) -> list[str]:
    stash = re.sub(r"\b[0-9a-f]{7,40}\b", "<sha>", git(path, "stash", "list", "--format=%s"))
    in_progress = ("MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "index.lock")
    sections = {
        "HEAD": [head_state(path)],
        "refs": refs_state(path),
        "commits": commits_state(path),
        "stash": stash.splitlines(),
        "status": git(path, "status", "--porcelain=v2", "-uall").splitlines(),
        "index": git(path, "ls-files", "-s").splitlines(),
        "worktree": worktree_state(path),
        "config": sorted(git(path, "config", "--local", "--list").splitlines()),
        "in-progress": [n for n in in_progress if (path / ".git" / n).exists()],
        "worktrees": [line for line in git(path, "worktree", "list", "--porcelain").splitlines() if not line.startswith("HEAD ")],
        "submodules": git(path, "submodule", "status").replace(" ", "\n").splitlines() if (path / ".gitmodules").exists() else [],
    }  # fmt: skip
    return [line for key, rows in sections.items() for line in (f"[{key}]", *rows)]


def full_state(repo: Path, work: Path) -> str:
    lines = repo_state(repo)
    bare = work / "origin.git"
    if bare.exists():
        lines += ["[remote refs]", *refs_state(bare), "[remote HEAD]", git(bare, "symbolic-ref", "HEAD").strip()]
    return "\n".join(lines).replace(str(work), "<work>") + "\n"


# -- running --------------------------------------------------------------------------------------
@dataclass
class Result:
    state: str = ""
    error: str = ""
    notes: tuple = ()
    unchanged: bool = False


def screen_text(s: Session) -> str:
    return "\n".join(line.rstrip() for line in s.screen.display)


def settle(s: Session, notes: list[str]) -> None:
    try:
        s.wait_quiet(QUIET_MS, 5)
    except TimeoutError:  # the header spinner runs while Undo checks the history
        notes.append("screen kept changing after a step (spinner?); went on after 5 s")


def run_step(s: Session, step: tuple, notes: list[str], app: str, native_keys: bool) -> None:
    op, a = step[0], step[1:]

    def click(x: int, y: int, btn: str = "left") -> None:
        code = {"left": 0, "right": 2}[btn]
        s.send(sgr_mouse(code, x, y))
        s.send(sgr_mouse(code, x, y, release=True))

    if op == "wait":
        s.wait_text(a[0], TIMEOUT)
        settle(s, notes)
        return
    elif op == "key":
        for k in a[0].split():
            if app == "rust" and not native_keys and k in RUST_FALLBACK:
                first = RUST_FALLBACK[k][0]
                notes.append(f"rust has no key binding for '{k}'; used {first[0]} {first[1:]} instead")
                for sub in RUST_FALLBACK[k]:
                    run_step(s, sub, notes, app, native_keys)
            else:
                s.send(key_bytes(k))
                settle(s, notes)
    elif op == "text":
        s.send(a[0].encode())
    elif op in ("click", "rclick"):
        click(a[0], a[1], "right" if op == "rclick" else (a[2] if len(a) > 2 else "left"))
    elif op == "dclick":
        click(a[0], a[1])
        s.pump(0.08)  # a real double click has a gap of tens of milliseconds
        click(a[0], a[1])
    elif op == "palette":
        s.send(key_bytes("ctrl+p"))
        s.wait_quiet(QUIET_MS, TIMEOUT)
        s.send(a[0].encode())
        s.wait_quiet(QUIET_MS, TIMEOUT)
        s.send(key_bytes("enter"))
    else:
        raise ValueError(f"unknown step {step!r}")
    settle(s, notes)


def run_case(fixture: str, steps: list[tuple], app: str, template: str, native_keys: bool, show_screen: bool) -> Result:
    work = Path(tempfile.mkdtemp(prefix="parity-mut-"))
    session = None
    error, notes = "", []
    try:
        repo = FIXTURE_BUILDERS[fixture](work)
        before = full_state(repo, work)
        session = Session(app_argv(template, repo), COLS, ROWS, ROOT)
        try:
            session.wait_text("initial com", TIMEOUT)
            session.wait_quiet(500, TIMEOUT)
            for n, step in enumerate(steps, 1):
                try:
                    run_step(session, step, notes, app, native_keys)
                except (TimeoutError, ValueError) as e:
                    error = f"step {n} {step!r} could not be performed in {app}: {e}"
                    break
            if not error:
                session.wait_quiet(FINAL_QUIET_MS, TIMEOUT)
        except TimeoutError as e:
            error = f"{app} never became ready: {e}"
        if session.proc.poll() is not None:
            error = error or f"{app} exited early with code {session.proc.returncode}"
        if error or show_screen:
            print(f"  --- {app} screen ---\n{screen_text(session)}\n  ---")
        session.close()
        session = None
        state = full_state(repo, work)
        return Result(state, error, tuple(dict.fromkeys(notes)), state == before)
    finally:
        if session:
            session.close()
        shutil.rmtree(work, ignore_errors=True)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("cases", nargs="*", help="case names (default: all)")
    ap.add_argument("--ts", default=APPS["ts"], help="TS command; {repo} is the repo path")
    ap.add_argument("--rust", default=APPS["rust"], help="Rust command; {repo} is the repo path")
    ap.add_argument("--list", action="store_true", help="list cases and exit")
    ap.add_argument("--screen", action="store_true", help="print the final screen of every run")
    ap.add_argument("--native-keys", action="store_true", help="send keys to Rust even where it has no binding")
    args = ap.parse_args()
    if args.list:
        for name, (fx, steps) in CASES.items():
            print(f"{name:24} {fx:14} {len(steps)} steps")
        return 0
    unknown = set(args.cases) - set(CASES)
    if unknown:
        ap.error(f"unknown case: {', '.join(sorted(unknown))}")
    apps = {"ts": args.ts, "rust": args.rust}
    names = args.cases or list(CASES)
    failed = 0
    for name in names:
        fixture, steps = CASES[name]
        res = {app: run_case(fixture, steps, app, cmd, args.native_keys, args.screen) for app, cmd in apps.items()}
        bad = [app for app, r in res.items() if r.error]
        if bad:
            failed += 1
            print(f"STEP FAILED {name}")
            for app in bad:
                print(f"  {res[app].error}")
        elif res["ts"].state == res["rust"].state:
            print(f"same        {name}" + ("  (state unchanged by the input in both apps)" if res["ts"].unchanged else ""))
        else:
            failed += 1
            print(f"MISMATCH    {name}")
            diff = difflib.unified_diff(res["ts"].state.splitlines(), res["rust"].state.splitlines(), "ts", "rust", lineterm="", n=1)
            print("\n".join("  " + d for d in diff))
        for note in dict.fromkeys(n for r in res.values() for n in r.notes):
            print(f"  note: {note}")
        sys.stdout.flush()
    print(f"{failed} of {len(names)} case(s) failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
