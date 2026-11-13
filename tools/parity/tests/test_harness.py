import re
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
sys.path[:0] = [str(HERE / ".deps"), str(HERE)]

from parity import fixtures, snapshot  # noqa: E402
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
