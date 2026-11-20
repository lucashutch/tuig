from __future__ import annotations

import argparse
import shutil
import sys
import time
from pathlib import Path

from . import scenario as sc_mod
from . import sidebyside
from . import snapshot as snap_mod

HERE = Path(__file__).resolve().parent.parent
REPO_ROOT = HERE.parent.parent
SCENARIOS = HERE / "scenarios"
GOLDEN = HERE / "golden"
TS_APP = f"bun run {REPO_ROOT}/src/index.ts --clean {{repo}}"
RUST_APP = f"{REPO_ROOT}/rust/target/release/tuig --clean {{repo}}"


def resolve(app: str | None, cwd: str | None) -> tuple[str, Path]:
    if app in (None, "ts"):
        return TS_APP, Path(cwd) if cwd else REPO_ROOT
    return app, Path(cwd) if cwd else Path.cwd()


def run_all(scenarios, app: str, cwd: Path, label: str):
    results = {}
    for sc in scenarios:
        t = time.monotonic()
        results[sc.name] = sc_mod.play(sc, app, cwd)
        print(f"  {label} {sc.name}: {len(results[sc.name])} snapshot(s), {time.monotonic() - t:.1f}s", file=sys.stderr)
    return results


def golden_path(scenario: str, name: str) -> Path:
    return GOLDEN / scenario / f"{name}.snap"


def report(title: str, expected, actual) -> bool:
    lines = snap_mod.diff(expected, actual)
    if lines:
        print(f"FAIL {title}")
        print("\n".join(lines))
    else:
        print(f"ok   {title}")
    return not lines


def cmd_record(args) -> int:
    app, cwd = resolve(args.app, args.cwd)
    scenarios = sc_mod.load_all(SCENARIOS, args.scenarios)
    for sc in scenarios:
        shutil.rmtree(GOLDEN / sc.name, ignore_errors=True)
    for name, snaps in run_all(scenarios, app, cwd, "record").items():
        for snap_name, snap in snaps.items():
            p = golden_path(name, snap_name)
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(snap_mod.dump(snap))
            print(f"wrote {p.relative_to(REPO_ROOT)}")
    return 0


def cmd_show(args) -> int:
    """Print snapshots with a column ruler, to find cell coordinates."""
    app, cwd = resolve(args.app, args.cwd)
    for name, snaps in run_all(sc_mod.load_all(SCENARIOS, args.scenarios), app, cwd, "run").items():
        for snap_name, snap in snaps.items():
            print(f"=== {name}/{snap_name} cursor={snap.cursor}")
            print("    " + "".join(str(x // 10 % 10) if x % 10 == 0 else " " for x in range(snap.cols)))
            print("    " + "".join(str(x % 10) for x in range(snap.cols)))
            for y, row in enumerate(snap.cells):
                print(f"{y:3d} " + "".join(c.char for c in row).rstrip())
    return 0


def cmd_compare(args) -> int:
    app, cwd = resolve(args.app, args.cwd)
    scenarios = sc_mod.load_all(SCENARIOS, args.scenarios)
    ok = True
    for name, snaps in run_all(scenarios, app, cwd, "run").items():
        for snap_name, snap in snaps.items():
            p = golden_path(name, snap_name)
            if not p.exists():
                print(f"FAIL {name}/{snap_name}: no golden file, run record")
                ok = False
                continue
            ok &= report(f"{name}/{snap_name}", snap_mod.load(p.read_text()), snap)
    return 0 if ok else 1


def cmd_ab(args) -> int:
    a_app, a_cwd = resolve(args.a, args.cwd_a)
    b_app, b_cwd = resolve(args.b, args.cwd_b)
    scenarios = sc_mod.load_all(SCENARIOS, args.scenarios)
    ra = run_all(scenarios, a_app, a_cwd, "A")
    rb = run_all(scenarios, b_app, b_cwd, "B")
    ok = True
    for name in ra:
        for snap_name in ra[name]:
            ok &= report(f"{name}/{snap_name}  (exp=A, act=B)", ra[name][snap_name], rb[name][snap_name])
    return 0 if ok else 1


def cmd_side_by_side(args) -> int:
    """Run scenarios against the TS app and the Rust app and report differences per region."""
    ts_app, ts_cwd = resolve(args.ts, args.cwd_ts)
    rust_app, rust_cwd = resolve(args.rust or RUST_APP, args.cwd_rust or str(REPO_ROOT / "rust"))
    scenarios = sc_mod.load_all(SCENARIOS, args.scenarios)
    ok = True
    for sc in scenarios:
        errors = {}

        def play(app, cwd, label):
            t = time.monotonic()
            try:
                snaps = sc_mod.play(sc, app, cwd)
            except RuntimeError as e:
                errors[label] = str(e)
                return None
            print(f"  {label} {sc.name}: {len(snaps)} snapshot(s), {time.monotonic() - t:.1f}s", file=sys.stderr)
            return snaps

        ref = None if args.golden else play(ts_app, ts_cwd, "TS  ")
        other = play(rust_app, rust_cwd, "Rust")
        if errors:
            ok = False
            for label, message in errors.items():
                head, _, screen = message.partition("\n--- screen ---\n")
                print(f"FAIL {sc.name}: the {label.strip()} app stopped at {head}")
                if args.verbose:
                    print("\n".join("  | " + line for line in screen.splitlines()))
            continue
        for snap_name, snap in other.items():
            if ref is not None:
                expected = ref[snap_name]
            else:
                p = golden_path(sc.name, snap_name)
                if not p.exists():
                    print(f"FAIL {sc.name}/{snap_name}: no golden file, run record")
                    ok = False
                    continue
                expected = snap_mod.load(p.read_text())
            found = sidebyside.compare(expected, snap)
            bad = {k: v for k, v in found.items() if v[0] or v[1]}
            ok &= not bad
            if not bad:
                print(f"ok   {sc.name}/{snap_name}")
                continue
            summary = "  ".join(f"{k}: {t} text, {st} style" for k, (t, st, _) in bad.items())
            print(f"FAIL {sc.name}/{snap_name}  {summary}")
            if args.verbose:
                for k, (_, _, lines) in bad.items():
                    print(f"  [{k}]")
                    print("\n".join("  " + line for line in lines))
    return 0 if ok else 1


def cmd_stability(args) -> int:
    app, cwd = resolve(args.app, args.cwd)
    scenarios = sc_mod.load_all(SCENARIOS, args.scenarios)
    runs = [run_all(scenarios, app, cwd, f"run{i + 1}") for i in range(args.runs)]
    ok = True
    for name in runs[0]:
        for snap_name in runs[0][name]:
            first = snap_mod.dump(runs[0][name][snap_name])
            same = all(snap_mod.dump(r[name][snap_name]) == first for r in runs[1:])
            if not same:
                ok = False
                for i, r in enumerate(runs[1:], 2):
                    if snap_mod.dump(r[name][snap_name]) != first:
                        report(f"{name}/{snap_name} run1 vs run{i}", runs[0][name][snap_name], r[name][snap_name])
            else:
                print(f"ok   {name}/{snap_name}: identical across {args.runs} runs")
    return 0 if ok else 1


def main() -> int:
    p = argparse.ArgumentParser(prog="run.py", description=__doc__)
    sub = p.add_subparsers(dest="cmd", required=True)

    def common(sp, ab=False):
        if ab:
            sp.add_argument("--a", help="app A command (default: ts)")
            sp.add_argument("--b", required=True, help="app B command")
            sp.add_argument("--cwd-a")
            sp.add_argument("--cwd-b")
        else:
            sp.add_argument("--app", help="command line, or 'ts' (default). {repo} is replaced by the fixture path; if absent the path is appended")
            sp.add_argument("--cwd", help="working directory for the app")
        sp.add_argument("scenarios", nargs="*", help="scenario names (default: all)")

    common(sub.add_parser("record", help="run an app and save golden snapshots"))
    common(sub.add_parser("show", help="print snapshots with a coordinate ruler"))
    common(sub.add_parser("compare", help="run an app and diff against goldens"))
    common(sub.add_parser("ab", help="run two apps live and diff"), ab=True)
    sb = sub.add_parser(
        "side-by-side",
        help="run scenarios on the TS and Rust apps, report cell differences per region",
    )
    sb.add_argument("--ts", help="TS app command (default: ts)")
    sb.add_argument("--cwd-ts")
    sb.add_argument("--rust", help=f"Rust app command (default: {RUST_APP})")
    sb.add_argument("--cwd-rust", help="working directory for the Rust app (default: rust)")
    sb.add_argument("--golden", action="store_true", help="use the recorded goldens instead of running the TS app")
    sb.add_argument("-v", "--verbose", action="store_true", help="print the differing rows of each region")
    sb.add_argument("scenarios", nargs="*", help="scenario names (default: all)")
    st = sub.add_parser("stability", help="run one app repeatedly and require identical snapshots")
    common(st)
    st.add_argument("--runs", type=int, default=3)

    args = p.parse_args()
    return {"record": cmd_record, "compare": cmd_compare, "show": cmd_show, "ab": cmd_ab, "side-by-side": cmd_side_by_side, "stability": cmd_stability}[args.cmd](args)
