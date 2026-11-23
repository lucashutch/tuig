import fcntl
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import termios
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
sys.path[:0] = [str(HERE / ".deps"), str(HERE)]

from parity import fixtures, sidebyside, snapshot  # noqa: E402
from parity.session import Session, key_bytes, sgr_mouse  # noqa: E402

FAKE_APP = [sys.executable, str(HERE / "tests" / "fake_app.py")]


class SessionTest(unittest.TestCase):
    """The PTY and emulator boundary, using a stand-in app."""

    def setUp(self):
        self.s = Session(FAKE_APP, 40, 10, HERE)
        self.addCleanup(self.s.close)
        self.s.wait_text("hello", 5)

    def test_cells_carry_truecolor_and_attributes(self):
        cell = self.s.cells()[4][9]  # 1-based cursor 5;10 is cell (x=9, y=4)
        self.assertEqual((cell.char, cell.fg, cell.bg, cell.attrs), ("h", "010203", "090807", "b"))

    def test_sgr_mouse_and_keys_reach_the_app(self):
        self.s.send(sgr_mouse(0, 11, 6))
        self.s.send(key_bytes("ctrl+p"))
        self.s.wait_quiet(100, 5)
        line = self.s.screen.display[0]
        self.assertIn(r"\x1b[<0;12;7M", line)
        self.assertIn(r"\x10", line)


class EmulatorTest(unittest.TestCase):
    def test_key_mode_sequence_does_not_leak_sgr_attributes_even_when_split(self):
        s = Session(FAKE_APP, 40, 10, HERE)
        self.addCleanup(s.close)
        s.wait_text("hello", 5)
        s.feed(b"\x1b[H\x1b[>4")
        s.feed(b";1mX\x1b[Hok")
        cell = s.cells()[0][1]
        self.assertEqual((cell.char, cell.attrs), ("k", ""))


class HunkGapEnvTest(unittest.TestCase):
    """The Rust app gets TUIG_DIFF_HUNK_GAP=0 unless a run asks for the separators."""

    def gap_value(self):
        s = Session(FAKE_APP, 40, 10, HERE)
        self.addCleanup(s.close)
        s.wait_text("gap=", 5)
        return s.screen.display[6].strip()

    def test_the_app_gets_zero_by_default(self):
        self.assertEqual(self.gap_value(), "gap=0")

    def test_the_hunk_gap_flag_leaves_the_variable_unset(self):
        Session.hunk_gap = True
        self.addCleanup(setattr, Session, "hunk_gap", False)
        self.assertEqual(self.gap_value(), "gap=unset")


class FixtureTest(unittest.TestCase):
    def build(self):
        d = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, d, ignore_errors=True)
        repo = fixtures.build("demo", d)
        return repo, fixtures.Repo(repo)

    def test_shas_are_identical_across_builds_and_cover_the_cases(self):
        a, ra = self.build()
        b, rb = self.build()
        self.assertEqual(ra.git("log", "--all", "--format=%H %P %s"), rb.git("log", "--all", "--format=%H %P %s"))
        status = ra.git("status", "--porcelain")
        self.assertEqual(status, rb.git("status", "--porcelain"))
        for code in ("R  src/login.py -> src/auth.py", " M src/server.py", "?? notes.txt", "A  src/staged_new.py", "M  src/util.py"):
            self.assertIn(code, status)
        self.assertEqual(len(ra.git("log", "--all", "--merges", "--format=%H").split()), 2)
        hunks = re.findall(r"^@@", ra.git("diff", "src/server.py"), re.M)
        self.assertEqual(len(hunks), 3)


class HistoryFixtureTest(unittest.TestCase):
    # Pinned: a change here means SHAs moved and every golden for this fixture is stale.
    HEAD = "4afea2ad2629eaa2c8697afe718f6eb932a0cd6a"

    def test_long_history_is_stable_and_has_lanes_and_languages(self):
        d = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, d, ignore_errors=True)
        repo = fixtures.Repo(fixtures.build("history", d))
        self.assertEqual(repo.git("rev-parse", "HEAD").strip(), self.HEAD)
        self.assertGreaterEqual(int(repo.git("rev-list", "--count", "HEAD")), 300)
        self.assertGreaterEqual(len(repo.git("log", "--merges", "--format=%H").split()), 50)
        exts = {Path(f).suffix for f in repo.git("ls-files", "showcase").split()}
        self.assertEqual(exts, {f".{e}" for e in fixtures.EXT_ORDER})


class WheelStepTest(unittest.TestCase):
    def test_wheel_reaches_the_app_as_sgr_reports_at_the_cell(self):
        from parity import scenario

        sc = scenario.Scenario(name="t", quiet_ms=100, timeout=5)
        sc.steps = [scenario.Step("wheel", ["down", "11", "6", "3"], 1), scenario.Step("snapshot", ["down"], 2)]
        sc.steps += [scenario.Step("wheel", ["up", "2", "3"], 3), scenario.Step("snapshot", ["up"], 4)]
        s = Session(FAKE_APP, 60, 10, HERE)
        self.addCleanup(s.close)
        s.wait_text("hello", 5)
        snaps = scenario._steps(sc, s)
        top = "".join(c.char for c in snaps["down"].cells[0])
        self.assertIn(r"\x1b[<65;12;7M", top)
        up = "".join(c.char for c in snaps["up"].cells[0])
        self.assertIn(r"\x1b[<64;3;4M", up)


class ScenarioStepTest(unittest.TestCase):
    """Steps that carry state into the app: modifier keys, typed paths, and cells that are ignored."""

    def play(self, steps, extras=None):
        from parity import scenario

        sc = scenario.Scenario(name="t", quiet_ms=100, timeout=5)
        sc.steps = [scenario.Step(op, args, n) for n, (op, args) in enumerate(steps, 1)]
        s = Session(FAKE_APP, 60, 10, HERE)
        self.addCleanup(s.close)
        s.wait_text("hello", 5)
        return scenario._steps(sc, s, extras)

    def test_click_and_drag_carry_modifier_bits(self):
        snaps = self.play(
            [("click", ["11", "6", "left", "ctrl"]), ("snapshot", ["ctrl"]), ("drag", ["2", "3", "2", "3", "alt"]), ("snapshot", ["alt"])]
        )
        ctrl = "".join(c.char for c in snaps["ctrl"].cells[0])
        self.assertIn(r"\x1b[<16;12;7M", ctrl)  # button 0 plus ctrl bit 16
        alt = "".join(c.char for c in snaps["alt"].cells[0])
        self.assertIn(r"\x1b[<8;3;4m", alt)  # release keeps the alt bit 8

    def test_text_replaces_the_extra_fixture_path(self):
        snaps = self.play([("text", ["{second}"]), ("snapshot", ["typed"])], {"second": "/x/second"})
        self.assertIn("/x/second", "".join(c.char for c in snaps["typed"].cells[0]))

    def test_ignored_cells_do_not_keep_the_screen_busy(self):
        s = Session(FAKE_APP, 40, 10, HERE)
        self.addCleanup(s.close)
        s.wait_text("hello", 5)
        s.ignore.append((0, 0, 40, 1))  # the row the app rewrites on every input
        s.send(b"abc")
        s.wait_quiet(100, 2)  # would time out if the rewrite counted as a change
        self.assertIn("got", s.screen.display[0])


class SideBySideTest(unittest.TestCase):
    def snap(self, rows):
        from parity.session import Cell

        style = ("ffffff", "000000", "")
        return snapshot.Snapshot(len(rows[0]), len(rows), "hidden", [[Cell(ch, *style) for ch in r] for r in rows])

    def screen(self):
        # Tabs, two header rows, a six-row body with dividers at columns 5 and 10, and a footer.
        body = ["side.│hist│rt....."] * 6
        return self.snap([r.ljust(20, ".") for r in ["tabs", "head", "head", *body, "foot"]])

    def test_regions_follow_the_divider_columns(self):
        found = sidebyside.regions(self.screen())
        self.assertEqual(found["sidebar"][0], 0)
        self.assertEqual(found["history"][0], 5)  # first divider
        self.assertEqual(found["details"][0], 10)  # last divider
        self.assertEqual(found["footer"][1], 9)

    def test_a_change_is_reported_in_its_region_only(self):
        a, b = self.screen(), self.screen()
        b.cells[4][6].char = "X"  # a history cell
        b.cells[0][0].fg = "ff0000"  # a style change in the tabs row
        result = sidebyside.compare(a, b)
        self.assertEqual(result["history"][:2], (1, 0))
        self.assertEqual(result["tabs"][:2], (0, 1))
        self.assertEqual(result["details"][:2], (0, 0))


class SnapshotTest(unittest.TestCase):
    def grid(self, rows, style=("ffffff", "000000", "")):
        from parity.session import Cell

        return snapshot.Snapshot(len(rows[0]), len(rows), "hidden", [[Cell(ch, *style) for ch in r] for r in rows])

    def test_roundtrip_and_diff_separates_text_from_style(self):
        base = self.grid(["abc", "def"])
        loaded = snapshot.load(snapshot.dump(base))
        self.assertEqual(snapshot.diff(base, loaded), [])

        changed = self.grid(["abc", "dXf"])
        changed.cells[0][0].fg = "ff0000"  # style-only change at row 0
        out = snapshot.diff(base, changed)
        self.assertTrue(out[0].startswith("TEXT: 1 row"))
        self.assertTrue(any(line.startswith("STYLE: 1 run") for line in out))
        self.assertTrue(any("row  0 cols 0-0" in line for line in out))

    def test_masks_hide_volatile_text_and_style(self):
        s = Session(FAKE_APP, 40, 10, HERE)
        self.addCleanup(s.close)
        s.wait_text("hello", 5)
        masks = snapshot.Masks(rects=[(0, 0, 3, 1)], patterns=[re.compile("hel+o")])
        snap = snapshot.capture(s, masks)
        self.assertEqual("".join(c.char for c in snap.cells[4][9:14]), snapshot.MASK_CHAR * 5)
        self.assertEqual("".join(c.char for c in snap.cells[0][:3]), snapshot.MASK_CHAR * 3)


class NewDirectiveTest(unittest.TestCase):
    """Directives that act outside the screen: git, clipboard, resize, seeds, stubs and start options."""

    def steps(self, steps, repo=None, extras=None, cols=60, rows=10):
        from parity import scenario

        sc = scenario.Scenario(name="t", quiet_ms=100, timeout=5)
        sc.steps = [scenario.Step(op, args, n) for n, (op, args) in enumerate(steps, 1)]
        s = Session(FAKE_APP, cols, rows, HERE)
        self.addCleanup(s.close)
        s.wait_text("hello", 5)
        return s, scenario._steps(sc, s, extras, repo)

    def test_git_step_commits_in_the_main_fixture_and_in_an_extra_one(self):
        d = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, d, ignore_errors=True)
        main = fixtures.Repo(fixtures.build("demo", d))
        second = fixtures.Repo(fixtures.build("second", d))
        self.steps(
            [("git", ["commit", "-q", "--allow-empty", "-m", "outside"]), ("git", ["@second", "commit", "-q", "--allow-empty", "-m", "other"])],
            repo=main.path,
            extras={"second": str(second.path)},
        )
        self.assertEqual(main.git("log", "-1", "--format=%s").strip(), "outside")
        self.assertEqual(second.git("log", "-1", "--format=%s").strip(), "other")

    def test_expect_clipboard_reads_the_last_osc52_text_and_fails_on_a_mismatch(self):
        from parity import scenario

        s = Session(FAKE_APP, 60, 10, HERE)
        self.addCleanup(s.close)
        s.wait_text("hello", 5)
        s.raw += b"\x1b]52;c;b25l\x07" + b"\x1b]52;c;dHdvCmxpbmU=\x1b\\"  # "one", then "two\nline" with ST
        ok = scenario.Scenario(name="t", quiet_ms=100, timeout=5, steps=[scenario.Step("expect-clipboard", ["two\\nline"], 1)])
        scenario._steps(ok, s)
        bad = scenario.Scenario(name="t", quiet_ms=100, timeout=5, steps=[scenario.Step("expect-clipboard", ["one"], 1)])
        with self.assertRaises(RuntimeError):
            scenario._steps(bad, s)

    def test_resize_changes_the_pty_size_and_the_emulator(self):
        s, snaps = self.steps([("resize", ["80", "12"]), ("snapshot", ["big"])])
        rows, cols, _, _ = struct.unpack("HHHH", fcntl.ioctl(s.fd, termios.TIOCGWINSZ, b"\0" * 8))
        self.assertEqual((cols, rows), (80, 12))
        self.assertEqual((snaps["big"].cols, snaps["big"].rows), (80, 12))

    def test_wheel_left_and_right_send_buttons_66_and_67_with_shift(self):
        _, snaps = self.steps(
            [("wheel", ["right", "4", "2", "1", "shift"]), ("snapshot", ["r"]), ("wheel", ["left", "4", "2"]), ("snapshot", ["l"])]
        )
        self.assertIn(r"\x1b[<71;5;3M", "".join(c.char for c in snaps["r"].cells[0]))  # 67 plus shift 4
        self.assertIn(r"\x1b[<66;5;3M", "".join(c.char for c in snaps["l"].cells[0]))

    def test_seeds_and_stubs_are_in_place_before_the_app_starts(self):
        s = Session(FAKE_APP, 40, 10, HERE, stubs=("ssh-denied",), seeds={"config/tuig/layout.json": "home={home}"})
        self.addCleanup(s.close)
        self.assertEqual((s.home / "config/tuig/layout.json").read_text(), f"home={s.home}")
        ssh = s.home / "bin" / "ssh"
        env = {"HOME": str(s.home)}
        with_batch = subprocess.run([str(ssh), "-o", "BatchMode=yes", "host"], env=env, capture_output=True, text=True)
        without = subprocess.run([str(ssh), "host"], env=env, capture_output=True, text=True)
        self.assertIn("Permission denied (publickey)", with_batch.stderr)
        self.assertIn("BatchMode=yes was not set", without.stderr)  # a prompt could hang the app

    def test_scenario_files_accept_the_new_start_options_and_reject_unknown_stubs(self):
        from parity import scenario

        d = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, d, ignore_errors=True)
        (d / "ok.scn").write_text("restore\nnopath\nstub xdg-open-log\nseed config/a.json '{\"k\": 1}'\n")
        sc = scenario.parse(d / "ok.scn")
        self.assertEqual((sc.restore, sc.nopath, sc.stubs, sc.seeds), (True, True, ["xdg-open-log"], {"config/a.json": '{"k": 1}'}))
        (d / "bad.scn").write_text("stub no-such-stub\n")
        with self.assertRaises(ValueError):
            scenario.parse(d / "bad.scn")

    def test_app_argv_drops_clean_and_the_path_on_request(self):
        from parity.scenario import app_argv

        template = "tuig --clean {repo}"
        self.assertEqual(app_argv(template, Path("/r")), ["tuig", "--clean", "/r"])
        self.assertEqual(app_argv(template, Path("/r"), restore=True), ["tuig", "/r"])
        self.assertEqual(app_argv(template, Path("/r"), restore=True, nopath=True), ["tuig"])
        self.assertEqual(app_argv("tuig --clean", Path("/r"), nopath=True), ["tuig", "--clean"])


class NewFixtureTest(unittest.TestCase):
    """The goldens of the new scenarios hold SHAs, so each new fixture must build the same history every time."""

    def log(self, name):
        d = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, d, ignore_errors=True)
        repo = fixtures.Repo(fixtures.build(name, d))
        return repo, repo.git("log", "--all", "--format=%H %P %s"), repo.git("stash", "list")

    def test_linked_lanes_and_behind_are_deterministic(self):
        for name in ("linked", "lanes", "behind"):
            a, b = self.log(name), self.log(name)
            self.assertEqual(a[1:], b[1:], name)

    def test_linked_has_a_remote_two_stashes_a_worktree_and_a_submodule_on_a_clean_tree(self):
        repo, _, stashes = self.log("linked")
        self.assertEqual(len(stashes.splitlines()), 2)
        self.assertEqual(repo.git("status", "--porcelain").strip(), "")
        self.assertIn("linked-wt", repo.git("worktree", "list"))
        self.assertIn("vendor/libsub", repo.git("submodule", "status"))
        self.assertIn("origin/feature/login", repo.git("branch", "-r"))

    def test_bigdiff_crosses_the_display_limits_and_small_has_fewer_line_numbers_than_rows(self):
        repo, _, _ = self.log("bigdiff")
        self.assertGreater(len(repo.git("diff", "--", "data/huge.py")), 5 * 1024 * 1024)
        self.assertGreater(repo.git("diff", "--", "data/lines.py").count("\n"), 20000)
        small = repo.git("diff", "--", "data/small.py").splitlines()
        self.assertEqual(sum(1 for line in small if line[:1] in "+-" and line[:3] not in ("+++", "---")), 120)

    def test_middiff_is_between_the_highlight_limit_and_the_display_limit(self):
        repo, _, _ = self.log("middiff")
        patch = repo.git("diff", "--", "data/mid.py")
        self.assertGreater(len(patch), 1024 * 1024)
        self.assertLess(len(patch), 5 * 1024 * 1024)
        self.assertLess(patch.count("\n"), 20000)


if __name__ == "__main__":
    unittest.main()
