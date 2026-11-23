#!/usr/bin/env python3
"""Parity harness entry point. See README.md."""

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE / ".deps"), str(HERE)]

from parity.cli import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())
