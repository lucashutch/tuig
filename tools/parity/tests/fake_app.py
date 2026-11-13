"""A tiny terminal app for harness tests: truecolor text, SGR mouse, raw keys."""

import os
import sys
import tty

tty.setraw(0)
out = sys.stdout
out.write("\x1b[?1049h\x1b[?1006h\x1b[2J\x1b[5;10H\x1b[1;38;2;1;2;3;48;2;9;8;7mhello\x1b[0m")
out.flush()
while True:
    data = os.read(0, 64)
    if not data:
        break
    out.write(f"\x1b[1;1H\x1b[2Kgot {data!r}")
    out.flush()
