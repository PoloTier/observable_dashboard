#!/usr/bin/env python3
"""
Smoke checks for observable_dashboard server-mode layout and wiring.

Usage:
  python tools/observable_dashboard/scripts/check_static_layout.py
"""

from __future__ import annotations

import re
import sys
from pathlib import Path
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

from tools.observable_dashboard.renderer import STATIC_DIR  # noqa: E402
from tools.observable_dashboard.server.app import create_app  # noqa: E402
from tools.observable_dashboard.server.cache import SeriesLRUCache  # noqa: E402


PKG_DIR = REPO_ROOT / "tools" / "observable_dashboard"
INDEX_TEMPLATE = PKG_DIR / "templates" / "index.html.j2"
MOL_TEMPLATE = PKG_DIR / "templates" / "molecule3d.html.j2"


EXPECTED_STATIC_RELFILES = {
    "vendor/plotly-2.35.2.min.js",
    "vendor/3Dmol-min.js",
    "dashboard/dashboard.css",
    "dashboard/dashboard_state.js",
    "dashboard/dashboard_data_loader.js",
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


def check_template_paths_and_order() -> None:
    index = _read_text(INDEX_TEMPLATE)
    mol = _read_text(MOL_TEMPLATE)

    _assert_subsequence(
        index,
        [
            'src="assets/vendor/plotly-2.35.2.min.js"',
            'href="assets/dashboard/dashboard.css"',
            'src="assets/dashboard/dashboard_state.js"',
            'src="assets/dashboard/dashboard_data_loader.js"',
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


def check_templates_api_only() -> None:
    index = _read_text(INDEX_TEMPLATE)
    mol = _read_text(MOL_TEMPLATE)
    _assert('id="bootstrap-json"' in index, "index template missing bootstrap-json")
    _assert('id="bootstrap-json"' in mol, "molecule3d template missing bootstrap-json")
    _assert('id="payload-json"' not in index, "index template should not include payload-json")
    _assert('id="payload-json"' not in mol, "molecule3d template should not include payload-json")
    _assert('id="refresh-all"' not in index, "index template should not include refresh-all button")


def check_molecule3d_speed_controls() -> None:
    mol = _read_text(MOL_TEMPLATE)
    _assert('id="playback-rate-slider"' in mol, "molecule3d template missing playback-rate-slider")
    _assert('id="playback-rate-label"' in mol, "molecule3d template missing playback-rate-label")


def check_molecule3d_stride_controls() -> None:
    mol = _read_text(MOL_TEMPLATE)
    _assert('id="playback-stride-slider"' in mol, "molecule3d template missing playback-stride-slider")
    _assert('id="playback-stride-label"' in mol, "molecule3d template missing playback-stride-label")


def check_no_cdn_refs() -> None:
    patterns = [re.compile(p) for p in FORBIDDEN_CDN_PATTERNS]
    offenders: list[str] = []

    for path in (INDEX_TEMPLATE, MOL_TEMPLATE):
        text = _read_text(path)
        for pattern in patterns:
            if pattern.search(text):
                offenders.append(f"{path.relative_to(REPO_ROOT)} -> {pattern.pattern}")

    _assert(not offenders, "Found forbidden CDN references:\n" + "\n".join(offenders))


def check_renderer_api_surface() -> None:
    import tools.observable_dashboard.renderer as renderer

    _assert(hasattr(renderer, "STATIC_DIR"), "renderer missing STATIC_DIR")
    _assert(hasattr(renderer, "_json_html_safe"), "renderer missing _json_html_safe")
    _assert(hasattr(renderer, "_render_html"), "renderer missing _render_html")
    _assert(not hasattr(renderer, "write_single_page"), "write_single_page should be removed")
    _assert(not hasattr(renderer, "write_chunked_page"), "write_chunked_page should be removed")


def check_app_routes() -> None:
    from fastapi.testclient import TestClient

    class _FakeTraj:
        n_atoms = 1

    class _FakeStore:
        traj_ids = ["0", "1"]

        def to_bootstrap(self, api_base: str = "/api") -> dict[str, object]:
            return {
                "schema_version": 1,
                "data_mode": "api",
                "meta": {"traj_ids": self.traj_ids, "source_pkl": "/tmp/example.pkl"},
                "defaults": {"panels": [], "plot": {}, "nac": {}, "ui": {}},
                "traj_ids": list(self.traj_ids),
                "api_base": api_base,
            }

        def get_trajectory(self, traj_id: str) -> _FakeTraj | None:
            if str(traj_id) not in self.traj_ids:
                return None
            return _FakeTraj()

        def build_mol3d_payload(self, traj_id: str) -> dict[str, object] | None:
            tid = str(traj_id)
            if tid not in self.traj_ids:
                return None
            return {
                "traj_id": tid,
                "time": [0.0],
                "coords": [[[0.0, 0.0, 0.0]]],
                "n_atoms": 1,
                "atom_numbers": [1],
                "n_frames": 1,
            }

    app = create_app(
        _FakeStore(),
        SeriesLRUCache(max_entries=16),
        mol3d_cache=SeriesLRUCache(max_entries=8),
    )
    client = TestClient(app)

    index = client.get("/")
    _assert(index.status_code == 200, "GET / should return 200")
    _assert('id="bootstrap-json"' in index.text, "GET / missing bootstrap-json")
    _assert('id="payload-json"' not in index.text, "GET / should not include payload-json")

    mol = client.get("/molecule3d.html")
    _assert(mol.status_code == 200, "GET /molecule3d.html should return 200")
    _assert('id="bootstrap-json"' in mol.text, "GET /molecule3d.html missing bootstrap-json")
    _assert('id="payload-json"' not in mol.text, "GET /molecule3d.html should not include payload-json")

    bootstrap = client.get("/api/bootstrap")
    _assert(bootstrap.status_code == 200, "GET /api/bootstrap should return 200")
    _assert(bootstrap.json().get("data_mode") == "api", "/api/bootstrap data_mode should be api")
    _assert("all_mode_manual_refresh" not in bootstrap.json(), "/api/bootstrap should not include all_mode_manual_refresh")

    traj_1 = client.get("/api/molecule3d/trajectory/0")
    _assert(traj_1.status_code == 200, "first /api/molecule3d/trajectory/0 should return 200")
    _assert(traj_1.json().get("cached") is False, "first trajectory response should have cached=false")

    traj_2 = client.get("/api/molecule3d/trajectory/0")
    _assert(traj_2.status_code == 200, "second /api/molecule3d/trajectory/0 should return 200")
    _assert(traj_2.json().get("cached") is True, "second trajectory response should have cached=true")

    missing = client.get("/api/molecule3d/trajectory/not-found")
    _assert(missing.status_code == 404, "missing trajectory should return 404")


def run_checks() -> int:
    checks = [
        ("static tree", check_static_tree),
        ("template paths + order", check_template_paths_and_order),
        ("templates api only", check_templates_api_only),
        ("molecule3d speed controls", check_molecule3d_speed_controls),
        ("molecule3d stride controls", check_molecule3d_stride_controls),
        ("no CDN refs", check_no_cdn_refs),
        ("renderer API surface", check_renderer_api_surface),
        ("server app routes", check_app_routes),
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
