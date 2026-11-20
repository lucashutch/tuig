import re
import shutil
import sys
import tempfile
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


if __name__ == "__main__":
    unittest.main()
