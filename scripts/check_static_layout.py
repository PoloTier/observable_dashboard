#!/usr/bin/env python3
"""
Smoke checks for observable_dashboard static layout and asset wiring.

Usage:
  python tools/observable_dashboard/scripts/check_static_layout.py
"""

from __future__ import annotations

import re
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Iterable


def _find_repo_root() -> Path:
    this_file = Path(__file__).resolve()
    for parent in this_file.parents:
        marker = parent / "tools" / "observable_dashboard" / "renderer.py"
        if marker.exists():
            return parent
    raise RuntimeError("Failed to locate repository root from script location.")


REPO_ROOT = _find_repo_root()
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from tools.observable_dashboard.renderer import _write_assets, write_single_page  # noqa: E402


PKG_DIR = REPO_ROOT / "tools" / "observable_dashboard"
STATIC_DIR = PKG_DIR / "static"
INDEX_TEMPLATE = PKG_DIR / "templates" / "index.html.j2"
MOL_TEMPLATE = PKG_DIR / "templates" / "molecule3d.html.j2"


EXPECTED_STATIC_RELFILES = {
    "vendor/plotly-2.35.2.min.js",
    "vendor/3Dmol-min.js",
    "dashboard/dashboard.css",
    "dashboard/dashboard_state.js",
    "dashboard/dashboard_plot.js",
    "dashboard/dashboard_ui.js",
    "math/dashboard_math3d.js",
    "mol3d/dashboard_mol3d_shared.js",
    "mol3d/dashboard_mol3d_geometry.js",
    "mol3d/dashboard_mol3d_measurement.js",
    "mol3d/dashboard_mol3d_viewer.js",
    "mol3d/dashboard_mol3d_io.js",
    "mol3d/dashboard_mol3d_page.js",
}

LEGACY_ASSET_PATTERNS = (
    r"assets/dashboard_state\.js",
    r"assets/dashboard_plot\.js",
    r"assets/dashboard_ui\.js",
    r"assets/dashboard_mol3d_[^\"'\s]+\.js",
    r"assets/dashboard_math3d\.js",
    r"assets/dashboard\.css",
)

FORBIDDEN_CDN_PATTERNS = (
    r"https://cdn\.plot\.ly/",
    r"https://3Dmol\.org/",
)


class CheckFailure(RuntimeError):
    pass


def _assert(condition: bool, message: str) -> None:
    if not condition:
        raise CheckFailure(message)


def _read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _find_all_files(base: Path) -> set[str]:
    out = set()
    for path in base.rglob("*"):
        if path.is_file():
            out.add(str(path.relative_to(base)).replace("\\", "/"))
    return out


def _assert_subsequence(content: str, ordered_markers: Iterable[str], *, name: str) -> None:
    pos = -1
    for marker in ordered_markers:
        idx = content.find(marker)
        _assert(idx >= 0, f"{name} missing required marker: {marker}")
        _assert(idx > pos, f"{name} has wrong marker order around: {marker}")
        pos = idx


def check_static_tree() -> None:
    found = _find_all_files(STATIC_DIR)
    missing = sorted(EXPECTED_STATIC_RELFILES - found)
    _assert(not missing, f"Missing static files: {missing}")

    flat_files = sorted(p.name for p in STATIC_DIR.glob("*") if p.is_file())
    _assert(not flat_files, f"Unexpected flat files in static/: {flat_files}")


def check_template_paths_and_order() -> None:
    index = _read_text(INDEX_TEMPLATE)
    mol = _read_text(MOL_TEMPLATE)

    _assert_subsequence(
        index,
        [
            'src="assets/vendor/plotly-2.35.2.min.js"',
            'href="assets/dashboard/dashboard.css"',
            'src="assets/dashboard/dashboard_state.js"',
            'src="assets/math/dashboard_math3d.js"',
            'src="assets/dashboard/dashboard_plot.js"',
            'src="assets/dashboard/dashboard_ui.js"',
        ],
        name="index.html.j2",
    )
    _assert_subsequence(
        mol,
        [
            'src="assets/vendor/3Dmol-min.js"',
            'src="assets/vendor/plotly-2.35.2.min.js"',
            'src="assets/mol3d/dashboard_mol3d_shared.js"',
            'src="assets/math/dashboard_math3d.js"',
            'src="assets/mol3d/dashboard_mol3d_geometry.js"',
            'src="assets/mol3d/dashboard_mol3d_measurement.js"',
            'src="assets/mol3d/dashboard_mol3d_viewer.js"',
            'src="assets/mol3d/dashboard_mol3d_io.js"',
            'src="assets/mol3d/dashboard_mol3d_page.js"',
        ],
        name="molecule3d.html.j2",
    )


def check_no_legacy_asset_refs() -> None:
    patterns = [re.compile(p) for p in LEGACY_ASSET_PATTERNS]
    offenders: list[str] = []

    for path in PKG_DIR.rglob("*"):
        if not path.is_file():
            continue
        if ".git" in path.parts or "__pycache__" in path.parts:
            continue
        if path.suffix not in {".py", ".j2", ".md", ".js", ".css"}:
            continue

        text = _read_text(path)
        for pattern in patterns:
            if pattern.search(text):
                offenders.append(f"{path.relative_to(REPO_ROOT)} -> {pattern.pattern}")

    _assert(not offenders, "Found legacy flat asset references:\n" + "\n".join(offenders))


def check_no_cdn_refs() -> None:
    patterns = [re.compile(p) for p in FORBIDDEN_CDN_PATTERNS]
    offenders: list[str] = []

    for path in (INDEX_TEMPLATE, MOL_TEMPLATE):
        text = _read_text(path)
        for pattern in patterns:
            if pattern.search(text):
                offenders.append(f"{path.relative_to(REPO_ROOT)} -> {pattern.pattern}")

    _assert(not offenders, "Found forbidden CDN references:\n" + "\n".join(offenders))


def check_write_assets_output() -> None:
    with TemporaryDirectory() as temp_dir:
        out_dir = Path(temp_dir)
        _write_assets(out_dir)
        found = _find_all_files(out_dir / "assets")
        missing = sorted(EXPECTED_STATIC_RELFILES - found)
        _assert(not missing, f"_write_assets missing files: {missing}")


def check_write_single_page_output() -> None:
    payload = {
        "meta": {"traj_ids": [], "source_pkl": ""},
        "trajectories": {},
        "defaults": {
            "ui": {"max_panels": 2, "default_panel_count": 1},
            "plot": {
                "show_ensemble_by_default": False,
                "show_all_traces_in_all_mode": False,
            },
            "panels": [],
        },
    }

    with TemporaryDirectory() as temp_dir:
        out_dir = Path(temp_dir)
        write_single_page(out_dir, payload)

        _assert((out_dir / "index.html").exists(), "write_single_page missing index.html")
        _assert((out_dir / "molecule3d.html").exists(), "write_single_page missing molecule3d.html")

        found = _find_all_files(out_dir / "assets")
        missing = sorted(EXPECTED_STATIC_RELFILES - found)
        _assert(not missing, f"write_single_page missing assets: {missing}")


def run_checks() -> int:
    checks = [
        ("static tree", check_static_tree),
        ("template paths + order", check_template_paths_and_order),
        ("no legacy asset refs", check_no_legacy_asset_refs),
        ("no CDN refs", check_no_cdn_refs),
        ("_write_assets output", check_write_assets_output),
        ("write_single_page output", check_write_single_page_output),
    ]

    failed = False
    for name, fn in checks:
        try:
            fn()
        except Exception as exc:  # noqa: BLE001
            failed = True
            print(f"[FAIL] {name}: {exc}")
        else:
            print(f"[OK]   {name}")

    if failed:
        print("\nResult: FAILED")
        return 1
    print("\nResult: PASSED")
    return 0


def main() -> None:
    raise SystemExit(run_checks())


if __name__ == "__main__":
    main()
