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

import numpy as np


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
    "vendor/gif.min.js",
    "vendor/gif.worker.js",
    "dashboard/dashboard.css",
    "dashboard/dashboard_state.js",
    "dashboard/dashboard_data_loader.js",
    "dashboard/dashboard_plot.js",
    "dashboard/dashboard_ui.js",
    "math/dashboard_math3d.js",
    "mol3d/dashboard_mol3d_shared.js",
    "mol3d/dashboard_mol3d_geometry.js",
    "mol3d/dashboard_mol3d_measurement.js",
    "mol3d/dashboard_mol3d_vector_overlay.js",
    "mol3d/dashboard_mol3d_viewer.js",
    "mol3d/dashboard_mol3d_io_transformers.js",
    "mol3d/dashboard_mol3d_io_network.js",
    "mol3d/dashboard_mol3d_io_vector_ops.js",
    "mol3d/dashboard_mol3d_io_app.js",
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
            'src="assets/vendor/plotly-2.35.2.min.js?v={{ static_version }}"',
            'href="assets/dashboard/dashboard.css?v={{ static_version }}"',
            'src="assets/dashboard/dashboard_state.js?v={{ static_version }}"',
            'src="assets/dashboard/dashboard_data_loader.js?v={{ static_version }}"',
            'src="assets/math/dashboard_math3d.js?v={{ static_version }}"',
            'src="assets/dashboard/dashboard_plot.js?v={{ static_version }}"',
            'src="assets/dashboard/dashboard_ui.js?v={{ static_version }}"',
        ],
        name="index.html.j2",
    )
    _assert_subsequence(
        mol,
        [
            'src="assets/vendor/3Dmol-min.js?v={{ static_version }}"',
            'src="assets/vendor/plotly-2.35.2.min.js?v={{ static_version }}"',
            'src="assets/vendor/gif.min.js?v={{ static_version }}"',
            'src="assets/mol3d/dashboard_mol3d_shared.js?v={{ static_version }}"',
            'src="assets/math/dashboard_math3d.js?v={{ static_version }}"',
            'src="assets/mol3d/dashboard_mol3d_geometry.js?v={{ static_version }}"',
            'src="assets/mol3d/dashboard_mol3d_measurement.js?v={{ static_version }}"',
            'src="assets/mol3d/dashboard_mol3d_vector_overlay.js?v={{ static_version }}"',
            'src="assets/mol3d/dashboard_mol3d_viewer.js?v={{ static_version }}"',
            'src="assets/mol3d/dashboard_mol3d_io_transformers.js?v={{ static_version }}"',
            'src="assets/mol3d/dashboard_mol3d_io_network.js?v={{ static_version }}"',
            'src="assets/mol3d/dashboard_mol3d_io_vector_ops.js?v={{ static_version }}"',
            'src="assets/mol3d/dashboard_mol3d_io_app.js?v={{ static_version }}"',
            'src="assets/mol3d/dashboard_mol3d_io.js?v={{ static_version }}"',
            'src="assets/mol3d/dashboard_mol3d_page.js?v={{ static_version }}"',
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
    _assert('id="refresh-pkl-btn"' in index, "index template missing refresh-pkl-btn")
    _assert('id="key-inspector-input"' in index, "index template missing key-inspector-input")
    _assert('id="key-inspector-run"' in index, "index template missing key-inspector-run")
    _assert('id="refresh-all"' not in index, "index template should not include refresh-all button")


def check_molecule3d_speed_controls() -> None:
    mol = _read_text(MOL_TEMPLATE)
    _assert('id="playback-rate-slider"' in mol, "molecule3d template missing playback-rate-slider")
    _assert('id="playback-rate-label"' in mol, "molecule3d template missing playback-rate-label")


def check_molecule3d_stride_controls() -> None:
    mol = _read_text(MOL_TEMPLATE)
    _assert('id="playback-stride-slider"' in mol, "molecule3d template missing playback-stride-slider")
    _assert('id="playback-stride-label"' in mol, "molecule3d template missing playback-stride-label")


def check_molecule3d_gif_controls() -> None:
    mol = _read_text(MOL_TEMPLATE)
    _assert('id="gif-export-start"' in mol, "molecule3d template missing gif-export-start")
    _assert('id="gif-export-end"' in mol, "molecule3d template missing gif-export-end")
    _assert('id="export-gif-btn"' in mol, "molecule3d template missing export-gif-btn")
    _assert('id="export-video-btn"' in mol, "molecule3d template missing export-video-btn")
    _assert('id="cancel-gif-export-btn"' in mol, "molecule3d template missing cancel-gif-export-btn")
    _assert('id="gif-export-progress"' in mol, "molecule3d template missing gif-export-progress")


def check_molecule3d_controls_groups() -> None:
    mol = _read_text(MOL_TEMPLATE)
    _assert('id="controls-primary"' in mol, "molecule3d template missing controls-primary")
    _assert('id="measure-controls-group"' in mol, "molecule3d template missing measure-controls-group")
    _assert('id="playback-controls-group"' in mol, "molecule3d template missing playback-controls-group")
    _assert('id="render-controls-group"' in mol, "molecule3d template missing render-controls-group")
    _assert('id="atom-size-slider"' in mol, "molecule3d template missing atom-size-slider")
    _assert('id="atom-size-label"' in mol, "molecule3d template missing atom-size-label")
    _assert('id="bond-radius-slider"' in mol, "molecule3d template missing bond-radius-slider")
    _assert('id="bond-radius-label"' in mol, "molecule3d template missing bond-radius-label")
    _assert('id="nac-controls-group"' in mol, "molecule3d template missing nac-controls-group")
    _assert('id="gif-range-controls-group"' in mol, "molecule3d template missing gif-range-controls-group")
    _assert('id="show-de-vectors"' in mol, "molecule3d template missing show-de-vectors")
    _assert('id="add-de-pair-btn"' in mol, "molecule3d template missing add-de-pair-btn")
    _assert('id="de-pair-rows"' in mol, "molecule3d template missing de-pair-rows")
    _assert('id="de-pair-row-template"' in mol, "molecule3d template missing de-pair-row-template")
    _assert('class="de-row-swatch"' in mol, "molecule3d template missing de-row-swatch")
    _assert('id="de-scale-slider"' in mol, "molecule3d template missing de-scale-slider")
    _assert('id="de-scale-label"' in mol, "molecule3d template missing de-scale-label")
    _assert('id="de-range-label"' in mol, "molecule3d template missing de-range-label")
    _assert('id="de-visual-hint"' in mol, "molecule3d template missing de-visual-hint")
    _assert('id="show-de-nac-vectors"' in mol, "molecule3d template missing show-de-nac-vectors")
    _assert('id="de-nac-scale-slider"' in mol, "molecule3d template missing de-nac-scale-slider")
    _assert('id="de-nac-range-label"' in mol, "molecule3d template missing de-nac-range-label")


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
        def __init__(self) -> None:
            self.n_atoms = 1
            self.time = np.asarray([0.0, 1.0], dtype=float)
            self.coords = np.asarray(
                [
                    [[0.0, 0.0, 0.0]],
                    [[1.0, 0.0, 0.0]],
                ],
                dtype=float,
            )
            self.etot_time = self.time.copy()
            self.etot = np.asarray([0.0, 0.1], dtype=float)
            self.eig_time = self.time.copy()
            self.eig = np.asarray([[0.0, 0.5], [0.1, 0.7]], dtype=float)
            self.nac_time = self.time.copy()
            self.nac_norm = np.asarray([0.0, 0.2], dtype=float)
            self.nac_components = np.asarray(
                [
                    [
                        [[0.0, 0.10], [-0.10, 0.0]],
                        [[0.0, 0.20], [-0.20, 0.0]],
                        [[0.0, 0.30], [-0.30, 0.0]],
                    ],
                    [
                        [[0.0, 0.11], [-0.11, 0.0]],
                        [[0.0, 0.21], [-0.21, 0.0]],
                        [[0.0, 0.31], [-0.31, 0.0]],
                    ],
                ],
                dtype=float,
            )
            self.nac_state_count = 2
            self.nac_component_count = 3
            self.de_time = self.time.copy()
            self.de_components = np.asarray(
                [
                    [
                        [[0.0, 0.05], [-0.05, 0.0]],
                        [[0.0, 0.15], [-0.15, 0.0]],
                        [[0.0, 0.25], [-0.25, 0.0]],
                    ],
                    [
                        [[0.0, 0.06], [-0.06, 0.0]],
                        [[0.0, 0.16], [-0.16, 0.0]],
                        [[0.0, 0.26], [-0.26, 0.0]],
                    ],
                ],
                dtype=float,
            )
            self.de_state_count = 2
            self.de_component_count = 3
            delta_e = self.eig[:, None, :] - self.eig[:, :, None]
            self.de_nac_time = self.time.copy()
            self.de_nac_components = self.nac_components * delta_e[:, None, :, :]
            self.de_nac_norm = np.sqrt(np.sum(self.de_nac_components[:, :, 0, 1] ** 2, axis=1))
            self.de_nac_state_count = 2
            self.de_nac_component_count = 3
            self.state_time = self.time.copy()
            self.state = np.asarray([0, 1], dtype=int)
            self.c_prob_time = self.time.copy()
            self.c_prob = np.asarray([[1.0, 0.0], [0.7, 0.3]], dtype=float)

    class _FakeStore:
        def __init__(self, version: int = 0) -> None:
            self.version = int(version)
            self.traj_ids = ["0", "1"]
            self._traj = _FakeTraj()
            self.input_path = Path(f"/tmp/example_v{self.version}.pkl")
            self.meta = {"source_pkl": str(self.input_path)}
            self.raw_key_previews = {
                "0": {
                    "_.0.record.time": "dtype=float64 shape=(2,) preview=[0.0, 1.0]",
                    "model.atoms": "dtype=int64 shape=(1,) preview=[1]",
                    "_.0.record.eig": "dtype=float64 shape=(2, 2) preview=[0.0, 0.5, 0.1, 0.7]",
                    "_.0.record.dE": "dtype=float64 shape=(2, 1, 3, 2, 2) preview=[0.0, 0.05, -0.05, 0.0, ...]",
                    "_.0.record.TWFpop": "dtype=complex128 shape=(2,) preview=[(1+0.1j), (0.5-0.2j)]",
                    "complex.matrix": "dtype=complex128 shape=(2, 2) preview=[(1+0j), (0.2+0.1j), ...]",
                    "bad.len": "dtype=float64 shape=(3,) preview=[1.0, 2.0, 3.0]",
                    "static.scalar": "1.234",
                },
                "1": {
                    "_.0.record.time": "dtype=float64 shape=(2,) preview=[0.0, 1.0]",
                    "_.0.record.eig": "dtype=float64 shape=(2, 2) preview=[0.0, 0.5, 0.1, 0.7]",
                    "_.0.record.dE": "dtype=float64 shape=(2, 1, 3, 2, 2) preview=[0.0, 0.05, -0.05, 0.0, ...]",
                    "_.0.record.TWFpop": "dtype=complex128 shape=(2,) preview=[(1+0.1j), (0.5-0.2j)]",
                    "complex.matrix": "dtype=complex128 shape=(2, 2) preview=[(1+0j), (0.2+0.1j), ...]",
                },
            }
            self.raw_series_data = {
                "0": {
                    "_.0.record.time": np.asarray([0.0, 1.0], dtype=float),
                    "_.0.record.eig": np.asarray([[0.0, 0.5], [0.1, 0.7]], dtype=float),
                    "_.0.record.dE": np.expand_dims(self._traj.de_components, axis=1),
                    "_.0.record.TWFpop": np.asarray([1.0 + 0.1j, 0.5 - 0.2j], dtype=np.complex128),
                    "complex.matrix": np.asarray(
                        [[1.0 + 0.0j, 0.2 + 0.1j], [0.9 - 0.3j, 0.1 + 0.6j]],
                        dtype=np.complex128,
                    ),
                    "bad.len": np.asarray([1.0, 2.0, 3.0], dtype=float),
                    "static.scalar": 1.234,
                },
                "1": {
                    "_.0.record.time": np.asarray([0.0, 1.0], dtype=float),
                    "_.0.record.eig": np.asarray([[0.2, 0.8], [0.3, 0.9]], dtype=float),
                    "_.0.record.dE": np.expand_dims(self._traj.de_components * 0.8, axis=1),
                    "_.0.record.TWFpop": np.asarray([0.2 + 0.4j, 0.7 - 0.1j], dtype=np.complex128),
                    "complex.matrix": np.asarray(
                        [[0.4 + 0.2j, 0.6 + 0.5j], [0.5 - 0.4j, 0.8 + 0.2j]],
                        dtype=np.complex128,
                    ),
                },
            }

        def to_bootstrap(self, api_base: str = "/api") -> dict[str, object]:
            return {
                "schema_version": 1,
                "data_mode": "api",
                "meta": {"traj_ids": self.traj_ids, "source_pkl": f"/tmp/example_v{self.version}.pkl"},
                "defaults": {"panels": [], "plot": {}, "nac": {}, "ui": {}},
                "traj_ids": list(self.traj_ids),
                "api_base": api_base,
            }

        def get_trajectory(self, traj_id: str) -> _FakeTraj | None:
            if str(traj_id) not in self.traj_ids:
                return None
            return self._traj

        def build_mol3d_payload(self, traj_id: str) -> dict[str, object] | None:
            tid = str(traj_id)
            if tid not in self.traj_ids:
                return None
            de_mags = np.sqrt(np.sum(self._traj.de_components * self._traj.de_components, axis=1)).reshape(-1)
            de_finite = de_mags[np.isfinite(de_mags)]
            if de_finite.size > 0:
                de_p5, de_p90, de_p95 = np.quantile(de_finite, [0.05, 0.90, 0.95]).astype(float).tolist()
                de_count = int(de_finite.size)
                de_scope = "traj_global"
            else:
                de_p5 = None
                de_p90 = None
                de_p95 = None
                de_count = 0
                de_scope = ""
            return {
                "traj_id": tid,
                "time": self._traj.time.astype(float).tolist(),
                "coords": self._traj.coords.astype(float).tolist(),
                "n_atoms": 1,
                "atom_numbers": [1],
                "n_frames": int(self._traj.coords.shape[0]),
                "nac_available": True,
                "nac_state_count": int(self._traj.nac_state_count),
                "nac_component_count": int(self._traj.nac_component_count),
                "de_available": True,
                "de_state_count": int(self._traj.de_state_count),
                "de_component_count": int(self._traj.de_component_count),
                "de_global_norm_scope": de_scope,
                "de_global_norm_p5": de_p5,
                "de_global_norm_p90": de_p90,
                "de_global_norm_p95": de_p95,
                "de_global_norm_count": de_count,
                "de_nac_available": True,
                "de_nac_state_count": int(self._traj.de_nac_state_count),
                "de_nac_component_count": int(self._traj.de_nac_component_count),
            }

        def build_mol3d_nac_payload(self, traj_id: str, state_i: int, state_j: int) -> dict[str, object] | None:
            tid = str(traj_id)
            if tid not in self.traj_ids:
                return None
            if int(state_i) == int(state_j):
                raise ValueError("state_i and state_j must be different.")
            n_states = int(self._traj.nac_state_count)
            if int(state_i) < 0 or int(state_i) >= n_states:
                raise ValueError("state_i out of bounds")
            if int(state_j) < 0 or int(state_j) >= n_states:
                raise ValueError("state_j out of bounds")
            pair = self._traj.nac_components[:, :, int(state_i), int(state_j)]
            vectors = pair.reshape(pair.shape[0], 1, 3)
            return {
                "traj_id": tid,
                "state_i": int(state_i),
                "state_j": int(state_j),
                "n_states": n_states,
                "n_atoms": 1,
                "n_frames": int(vectors.shape[0]),
                "time": self._traj.nac_time.astype(float).tolist(),
                "vectors": vectors.astype(float).tolist(),
            }

        def build_mol3d_de_payload(self, traj_id: str, state_i: int, state_j: int) -> dict[str, object] | None:
            tid = str(traj_id)
            if tid not in self.traj_ids:
                return None
            n_states = int(self._traj.de_state_count)
            if int(state_i) < 0 or int(state_i) >= n_states:
                raise ValueError("state_i out of bounds")
            if int(state_j) < 0 or int(state_j) >= n_states:
                raise ValueError("state_j out of bounds")
            pair = self._traj.de_components[:, :, int(state_i), int(state_j)]
            vectors = pair.reshape(pair.shape[0], 1, 3)
            return {
                "traj_id": tid,
                "state_i": int(state_i),
                "state_j": int(state_j),
                "n_states": n_states,
                "n_atoms": 1,
                "n_frames": int(vectors.shape[0]),
                "time": self._traj.de_time.astype(float).tolist(),
                "vectors": vectors.astype(float).tolist(),
            }

        def build_mol3d_de_nac_payload(self, traj_id: str, state_i: int, state_j: int) -> dict[str, object] | None:
            tid = str(traj_id)
            if tid not in self.traj_ids:
                return None
            if int(state_i) == int(state_j):
                raise ValueError("state_i and state_j must be different.")
            n_states = int(self._traj.de_nac_state_count)
            if int(state_i) < 0 or int(state_i) >= n_states:
                raise ValueError("state_i out of bounds")
            if int(state_j) < 0 or int(state_j) >= n_states:
                raise ValueError("state_j out of bounds")
            pair = self._traj.de_nac_components[:, :, int(state_i), int(state_j)]
            vectors = pair.reshape(pair.shape[0], 1, 3)
            return {
                "traj_id": tid,
                "state_i": int(state_i),
                "state_j": int(state_j),
                "n_states": n_states,
                "n_atoms": 1,
                "n_frames": int(vectors.shape[0]),
                "time": self._traj.de_nac_time.astype(float).tolist(),
                "vectors": vectors.astype(float).tolist(),
            }

        def inspect_raw_keys(self, keys: list[str]) -> dict[str, object]:
            out_rows: list[dict[str, object]] = []
            for traj_id in self.traj_ids:
                preview_map = self.raw_key_previews.get(str(traj_id), {})
                values = {}
                for key in keys:
                    values[str(key)] = str(preview_map.get(str(key), "MISSING"))
                out_rows.append({"traj_id": str(traj_id), "values": values})
            return {
                "keys": [str(key) for key in keys],
                "rows": out_rows,
            }

        def build_raw_key_series(self, traj_id: str, raw_key: str) -> dict[str, object]:
            tid = str(traj_id)
            key = str(raw_key)
            if tid not in self.traj_ids:
                raise KeyError(f"Trajectory not found: {tid}")
            raw_by_key = self.raw_series_data.get(tid, {})
            if key not in raw_by_key:
                raise KeyError(f"Raw key not found for trajectory {tid}: {key}")

            arr = np.asarray(raw_by_key[key])
            if arr.ndim == 0:
                raise ValueError(f"Raw key '{key}' is static (ndim=0) and cannot be plotted.")
            if int(arr.shape[0]) != int(self._traj.time.shape[0]):
                raise ValueError(
                    (
                        f"Raw key '{key}' has first dimension {arr.shape[0]}, but expected base frame "
                        f"length {self._traj.time.shape[0]}."
                    )
                )

            if np.iscomplexobj(arr):
                complex_arr = arr.astype(np.complex128)
                if complex_arr.ndim == 1:
                    values = np.stack([complex_arr.real, complex_arr.imag], axis=1).astype(float)
                    return {
                        "series_kind": "matrix",
                        "time": self._traj.time.astype(float).tolist(),
                        "values": values.tolist(),
                        "n_points": int(values.shape[0]),
                        "n_components": int(values.shape[1]),
                        "component_labels": ["re", "im"],
                    }
                flat = complex_arr.reshape(complex_arr.shape[0], -1)
                out = np.empty((flat.shape[0], flat.shape[1] * 2), dtype=float)
                out[:, 0::2] = flat.real.astype(float)
                out[:, 1::2] = flat.imag.astype(float)
                labels = []
                for component in range(flat.shape[1]):
                    labels.append(f"comp{component}.re")
                    labels.append(f"comp{component}.im")
                return {
                    "series_kind": "matrix",
                    "time": self._traj.time.astype(float).tolist(),
                    "values": out.tolist(),
                    "n_points": int(out.shape[0]),
                    "n_components": int(out.shape[1]),
                    "component_labels": labels,
                }

            values = arr.astype(float)
            time = self._traj.time.astype(float)
            if values.ndim == 1:
                return {
                    "series_kind": "scalar",
                    "time": time.tolist(),
                    "value": values.tolist(),
                    "n_points": int(values.shape[0]),
                }
            matrix = values.reshape(values.shape[0], -1)
            return {
                "series_kind": "matrix",
                "time": time.tolist(),
                "values": matrix.tolist(),
                "n_points": int(matrix.shape[0]),
                "n_components": int(matrix.shape[1]),
            }

    reload_state = {"version": 0, "fail": False}

    def _reload_store() -> _FakeStore:
        if reload_state["fail"]:
            raise RuntimeError("reload failed")
        reload_state["version"] += 1
        return _FakeStore(version=reload_state["version"])

    app = create_app(
        _FakeStore(version=0),
        SeriesLRUCache(max_entries=16),
        mol3d_cache=SeriesLRUCache(max_entries=8),
        reload_store=_reload_store,
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
    _assert(isinstance(bootstrap.json().get("raw_key_aliases"), list), "/api/bootstrap should include raw_key_aliases")

    raw_key_aliases_empty = client.get("/api/raw-key-aliases")
    _assert(raw_key_aliases_empty.status_code == 200, "GET /api/raw-key-aliases should return 200")
    _assert(raw_key_aliases_empty.json().get("aliases") == [], "raw-key aliases should be empty initially")

    raw_key_aliases_create = client.post(
        "/api/raw-key-aliases",
        json={"alias": "TWFpop", "raw_key": "_.0.record.TWFpop"},
    )
    _assert(raw_key_aliases_create.status_code == 200, "POST /api/raw-key-aliases should return 200")
    alias_map = {
        str(item.get("alias")): str(item.get("raw_key"))
        for item in (raw_key_aliases_create.json().get("aliases") or [])
        if isinstance(item, dict)
    }
    _assert(alias_map.get("TWFpop") == "_.0.record.TWFpop", "new raw-key alias should be persisted in memory")

    raw_key_aliases_override = client.post(
        "/api/raw-key-aliases",
        json={"alias": "TWFpop", "raw_key": "complex.matrix"},
    )
    _assert(raw_key_aliases_override.status_code == 200, "raw-key alias override should return 200")
    alias_map = {
        str(item.get("alias")): str(item.get("raw_key"))
        for item in (raw_key_aliases_override.json().get("aliases") or [])
        if isinstance(item, dict)
    }
    _assert(alias_map.get("TWFpop") == "complex.matrix", "raw-key alias override should update mapping")

    bootstrap_after_alias_update = client.get("/api/bootstrap")
    _assert(bootstrap_after_alias_update.status_code == 200, "GET /api/bootstrap after alias update should return 200")
    alias_map_from_bootstrap = {
        str(item.get("alias")): str(item.get("raw_key"))
        for item in (bootstrap_after_alias_update.json().get("raw_key_aliases") or [])
        if isinstance(item, dict)
    }
    _assert(
        alias_map_from_bootstrap.get("TWFpop") == "complex.matrix",
        "/api/bootstrap should include latest raw-key alias mapping",
    )

    raw_key_alias_conflict = client.post(
        "/api/raw-key-aliases",
        json={"alias": "etot", "raw_key": "_.0.record.TWFpop"},
    )
    _assert(raw_key_alias_conflict.status_code == 422, "alias conflicting with built-in observable should return 422")

    raw_key_alias_missing_key = client.post(
        "/api/raw-key-aliases",
        json={"alias": "missingAlias", "raw_key": "missing.key"},
    )
    _assert(raw_key_alias_missing_key.status_code == 422, "alias with missing raw key should return 422")

    inspect_keys = client.post("/api/inspect-keys", json={"keys": ["_.0.record.time", "model.atoms", "missing.key"]})
    _assert(inspect_keys.status_code == 200, "POST /api/inspect-keys should return 200")
    inspect_payload = inspect_keys.json()
    _assert("keys" in inspect_payload and "rows" in inspect_payload, "inspect-keys response should include keys/rows")
    _assert(len(inspect_payload.get("rows") or []) == 2, "inspect-keys rows should match trajectory count")
    row0 = inspect_payload["rows"][0]
    row1 = inspect_payload["rows"][1]
    _assert(row0["values"]["missing.key"] == "MISSING", "missing key should return MISSING for traj 0")
    _assert(row1["values"]["model.atoms"] == "MISSING", "missing key should return MISSING for traj 1")

    inspect_too_many = client.post("/api/inspect-keys", json={"keys": [f"k{i}" for i in range(201)]})
    _assert(inspect_too_many.status_code == 422, "inspect-keys should return 422 for too many keys")

    raw_scalar = client.post("/api/raw-key-series", json={"traj_id": "0", "raw_key": "_.0.record.time"})
    _assert(raw_scalar.status_code == 200, "POST /api/raw-key-series scalar should return 200")
    _assert(raw_scalar.json().get("series_kind") == "scalar", "raw-key scalar response should have series_kind=scalar")

    raw_matrix = client.post("/api/raw-key-series", json={"traj_id": "0", "raw_key": "_.0.record.eig"})
    _assert(raw_matrix.status_code == 200, "POST /api/raw-key-series matrix should return 200")
    _assert(raw_matrix.json().get("series_kind") == "matrix", "raw-key matrix response should have series_kind=matrix")

    raw_complex_scalar = client.post("/api/raw-key-series", json={"traj_id": "0", "raw_key": "_.0.record.TWFpop"})
    _assert(raw_complex_scalar.status_code == 200, "POST /api/raw-key-series complex scalar should return 200")
    raw_complex_scalar_payload = raw_complex_scalar.json()
    _assert(raw_complex_scalar_payload.get("series_kind") == "matrix", "complex scalar should be returned as matrix")
    _assert(raw_complex_scalar_payload.get("n_components") == 2, "complex scalar should have 2 components (re/im)")
    _assert(
        raw_complex_scalar_payload.get("component_labels") == ["re", "im"],
        "complex scalar should return component labels ['re', 'im']",
    )

    raw_complex_matrix = client.post("/api/raw-key-series", json={"traj_id": "0", "raw_key": "complex.matrix"})
    _assert(raw_complex_matrix.status_code == 200, "POST /api/raw-key-series complex matrix should return 200")
    raw_complex_matrix_payload = raw_complex_matrix.json()
    _assert(raw_complex_matrix_payload.get("series_kind") == "matrix", "complex matrix should be returned as matrix")
    _assert(raw_complex_matrix_payload.get("n_components") == 4, "complex matrix with 2 columns should map to 4 components")
    _assert(
        raw_complex_matrix_payload.get("component_labels") == ["comp0.re", "comp0.im", "comp1.re", "comp1.im"],
        "complex matrix component labels should follow compK.re/compK.im order",
    )

    raw_bad_len = client.post("/api/raw-key-series", json={"traj_id": "0", "raw_key": "bad.len"})
    _assert(raw_bad_len.status_code == 422, "raw-key series with mismatched first dimension should return 422")

    raw_missing = client.post("/api/raw-key-series", json={"traj_id": "0", "raw_key": "missing.key"})
    _assert(raw_missing.status_code == 404, "raw-key series with missing key should return 404")

    series_req = {"traj_id": "0", "observable": "etot", "indices": []}
    series_1 = client.post("/api/series", json=series_req)
    _assert(series_1.status_code == 200, "first /api/series should return 200")
    _assert(series_1.json().get("cached") is False, "first /api/series should have cached=false")

    series_2 = client.post("/api/series", json=series_req)
    _assert(series_2.status_code == 200, "second /api/series should return 200")
    _assert(series_2.json().get("cached") is True, "second /api/series should have cached=true")

    de_nac_series_req = {"traj_id": "0", "observable": "de_nac", "indices": [0, 1]}
    de_nac_series_1 = client.post("/api/series", json=de_nac_series_req)
    _assert(de_nac_series_1.status_code == 200, "first /api/series de_nac should return 200")
    _assert(de_nac_series_1.json().get("cached") is False, "first /api/series de_nac should have cached=false")

    de_nac_series_2 = client.post("/api/series", json=de_nac_series_req)
    _assert(de_nac_series_2.status_code == 200, "second /api/series de_nac should return 200")
    _assert(de_nac_series_2.json().get("cached") is True, "second /api/series de_nac should have cached=true")

    de_nac_series_invalid_pair = client.post(
        "/api/series",
        json={"traj_id": "0", "observable": "de_nac", "indices": [1, 1]},
    )
    _assert(de_nac_series_invalid_pair.status_code == 422, "de_nac series with identical state pair should return 422")

    ensemble_scalar_req = {
        "observable": "etot",
        "indices": [],
        "raw_key": None,
        "stat_mode": "mean_ci95_bootstrap",
    }
    ensemble_scalar_1 = client.post("/api/ensemble-series", json=ensemble_scalar_req)
    _assert(ensemble_scalar_1.status_code == 200, "first /api/ensemble-series scalar should return 200")
    ensemble_scalar_payload = ensemble_scalar_1.json()
    _assert(ensemble_scalar_payload.get("cached") is False, "first /api/ensemble-series scalar should have cached=false")
    _assert(
        isinstance(ensemble_scalar_payload.get("component_series"), list)
        and len(ensemble_scalar_payload.get("component_series")) == 1,
        "scalar ensemble should return exactly one component series",
    )

    ensemble_scalar_2 = client.post("/api/ensemble-series", json=ensemble_scalar_req)
    _assert(ensemble_scalar_2.status_code == 200, "second /api/ensemble-series scalar should return 200")
    _assert(ensemble_scalar_2.json().get("cached") is True, "second /api/ensemble-series scalar should have cached=true")

    ensemble_median_req = {
        "observable": "etot",
        "indices": [],
        "raw_key": None,
        "stat_mode": "median_iqr",
    }
    ensemble_median = client.post("/api/ensemble-series", json=ensemble_median_req)
    _assert(ensemble_median.status_code == 200, "/api/ensemble-series median mode should return 200")
    _assert(ensemble_median.json().get("cached") is False, "new stat_mode should miss cache on first request")

    ensemble_matrix_req = {
        "observable": "|c|^2",
        "indices": [],
        "raw_key": None,
        "stat_mode": "mean_ci95_bootstrap",
    }
    ensemble_matrix = client.post("/api/ensemble-series", json=ensemble_matrix_req)
    _assert(ensemble_matrix.status_code == 200, "/api/ensemble-series matrix observable should return 200")
    _assert(
        isinstance(ensemble_matrix.json().get("component_series"), list)
        and len(ensemble_matrix.json().get("component_series")) >= 2,
        "matrix ensemble should return multiple component series",
    )

    ensemble_raw_key_req = {
        "observable": "raw_key",
        "indices": [],
        "raw_key": "complex.matrix",
        "stat_mode": "mean_ci95_bootstrap",
    }
    ensemble_raw_key = client.post("/api/ensemble-series", json=ensemble_raw_key_req)
    _assert(ensemble_raw_key.status_code == 200, "/api/ensemble-series raw_key matrix should return 200")
    _assert(
        isinstance(ensemble_raw_key.json().get("component_series"), list)
        and len(ensemble_raw_key.json().get("component_series")) >= 2,
        "raw_key matrix ensemble should return multiple component series",
    )

    ensemble_raw_key_empty = client.post(
        "/api/ensemble-series",
        json={"observable": "raw_key", "indices": [], "raw_key": "", "stat_mode": "mean_ci95_bootstrap"},
    )
    _assert(ensemble_raw_key_empty.status_code == 422, "raw_key ensemble with empty raw_key should return 422")

    ensemble_raw_key_with_indices = client.post(
        "/api/ensemble-series",
        json={"observable": "raw_key", "indices": [0], "raw_key": "complex.matrix", "stat_mode": "mean_ci95_bootstrap"},
    )
    _assert(ensemble_raw_key_with_indices.status_code == 422, "raw_key ensemble with indices should return 422")

    ensemble_invalid_mode = client.post(
        "/api/ensemble-series",
        json={"observable": "etot", "indices": [], "raw_key": None, "stat_mode": "not_a_mode"},
    )
    _assert(ensemble_invalid_mode.status_code == 422, "ensemble request with invalid stat_mode should return 422")

    traj_1 = client.get("/api/molecule3d/trajectory/0")
    _assert(traj_1.status_code == 200, "first /api/molecule3d/trajectory/0 should return 200")
    traj_1_payload = traj_1.json()
    _assert(traj_1_payload.get("cached") is False, "first trajectory response should have cached=false")
    _assert(str(traj_1_payload.get("de_global_norm_scope") or "") == "traj_global", "trajectory payload should include de_global_norm_scope")
    _assert(isinstance(traj_1_payload.get("de_global_norm_count"), int), "trajectory payload should include integer de_global_norm_count")
    _assert(float(traj_1_payload.get("de_global_norm_p95") or 0.0) > 0.0, "trajectory payload should include positive de_global_norm_p95")

    traj_2 = client.get("/api/molecule3d/trajectory/0")
    _assert(traj_2.status_code == 200, "second /api/molecule3d/trajectory/0 should return 200")
    _assert(traj_2.json().get("cached") is True, "second trajectory response should have cached=true")

    nac_1 = client.get("/api/molecule3d/nac/0?state_i=0&state_j=1")
    _assert(nac_1.status_code == 200, "first /api/molecule3d/nac/0 should return 200")
    _assert(nac_1.json().get("cached") is False, "first NAC response should have cached=false")

    nac_2 = client.get("/api/molecule3d/nac/0?state_i=0&state_j=1")
    _assert(nac_2.status_code == 200, "second /api/molecule3d/nac/0 should return 200")
    _assert(nac_2.json().get("cached") is True, "second NAC response should have cached=true")

    nac_invalid_pair = client.get("/api/molecule3d/nac/0?state_i=1&state_j=1")
    _assert(nac_invalid_pair.status_code == 422, "NAC with identical state pair should return 422")

    de_1 = client.get("/api/molecule3d/de/0?state_i=0&state_j=0")
    _assert(de_1.status_code == 200, "first /api/molecule3d/de/0 should return 200")
    _assert(de_1.json().get("cached") is False, "first dE response should have cached=false")

    de_2 = client.get("/api/molecule3d/de/0?state_i=0&state_j=0")
    _assert(de_2.status_code == 200, "second /api/molecule3d/de/0 should return 200")
    _assert(de_2.json().get("cached") is True, "second dE response should have cached=true")

    de_diag_pair = client.get("/api/molecule3d/de/0?state_i=1&state_j=1")
    _assert(de_diag_pair.status_code == 200, "dE with identical state pair should return 200")

    de_nac_1 = client.get("/api/molecule3d/de_nac/0?state_i=0&state_j=1")
    _assert(de_nac_1.status_code == 200, "first /api/molecule3d/de_nac/0 should return 200")
    _assert(de_nac_1.json().get("cached") is False, "first de_nac response should have cached=false")

    de_nac_2 = client.get("/api/molecule3d/de_nac/0?state_i=0&state_j=1")
    _assert(de_nac_2.status_code == 200, "second /api/molecule3d/de_nac/0 should return 200")
    _assert(de_nac_2.json().get("cached") is True, "second de_nac response should have cached=true")

    de_nac_invalid_pair = client.get("/api/molecule3d/de_nac/0?state_i=1&state_j=1")
    _assert(de_nac_invalid_pair.status_code == 422, "de_nac with identical state pair should return 422")

    refresh_ok = client.post("/api/refresh-dataset")
    _assert(refresh_ok.status_code == 200, "POST /api/refresh-dataset should return 200")
    _assert(refresh_ok.json().get("status") == "ok", "/api/refresh-dataset status should be ok")
    _assert(refresh_ok.json().get("dataset_revision") == 2, "dataset revision should be incremented after refresh")

    raw_key_aliases_after_refresh = client.get("/api/raw-key-aliases")
    _assert(raw_key_aliases_after_refresh.status_code == 200, "GET /api/raw-key-aliases after refresh should return 200")
    alias_map_after_refresh = {
        str(item.get("alias")): str(item.get("raw_key"))
        for item in (raw_key_aliases_after_refresh.json().get("aliases") or [])
        if isinstance(item, dict)
    }
    _assert(
        alias_map_after_refresh.get("TWFpop") == "complex.matrix",
        "raw-key alias mapping should persist after refresh",
    )

    series_3 = client.post("/api/series", json=series_req)
    _assert(series_3.status_code == 200, "post-refresh /api/series should return 200")
    _assert(series_3.json().get("cached") is False, "post-refresh first /api/series should have cached=false")

    traj_3 = client.get("/api/molecule3d/trajectory/0")
    _assert(traj_3.status_code == 200, "post-refresh /api/molecule3d/trajectory/0 should return 200")
    _assert(traj_3.json().get("cached") is False, "post-refresh first trajectory response should have cached=false")

    nac_3 = client.get("/api/molecule3d/nac/0?state_i=0&state_j=1")
    _assert(nac_3.status_code == 200, "post-refresh /api/molecule3d/nac/0 should return 200")
    _assert(nac_3.json().get("cached") is False, "post-refresh first NAC response should have cached=false")

    de_3 = client.get("/api/molecule3d/de/0?state_i=0&state_j=0")
    _assert(de_3.status_code == 200, "post-refresh /api/molecule3d/de/0 should return 200")
    _assert(de_3.json().get("cached") is False, "post-refresh first dE response should have cached=false")

    de_nac_3 = client.get("/api/molecule3d/de_nac/0?state_i=0&state_j=1")
    _assert(de_nac_3.status_code == 200, "post-refresh /api/molecule3d/de_nac/0 should return 200")
    _assert(de_nac_3.json().get("cached") is False, "post-refresh first de_nac response should have cached=false")

    reload_state["fail"] = True
    refresh_fail = client.post("/api/refresh-dataset")
    _assert(refresh_fail.status_code == 500, "failed refresh should return 500")
    reload_state["fail"] = False

    series_after_failed_refresh = client.post("/api/series", json=series_req)
    _assert(series_after_failed_refresh.status_code == 200, "series should remain available after failed refresh")
    _assert(
        series_after_failed_refresh.json().get("cached") is True,
        "series cache should remain valid after failed refresh",
    )

    app_without_refresh = create_app(
        _FakeStore(version=0),
        SeriesLRUCache(max_entries=4),
        mol3d_cache=SeriesLRUCache(max_entries=4),
    )
    client_without_refresh = TestClient(app_without_refresh)
    refresh_not_enabled = client_without_refresh.post("/api/refresh-dataset")
    _assert(refresh_not_enabled.status_code == 501, "refresh endpoint should return 501 when disabled")

    missing = client.get("/api/molecule3d/trajectory/not-found")
    _assert(missing.status_code == 404, "missing trajectory should return 404")

    missing_nac = client.get("/api/molecule3d/nac/not-found?state_i=0&state_j=1")
    _assert(missing_nac.status_code == 404, "missing NAC trajectory should return 404")

    missing_de = client.get("/api/molecule3d/de/not-found?state_i=0&state_j=1")
    _assert(missing_de.status_code == 404, "missing dE trajectory should return 404")

    missing_de_nac = client.get("/api/molecule3d/de_nac/not-found?state_i=0&state_j=1")
    _assert(missing_de_nac.status_code == 404, "missing de_nac trajectory should return 404")


def run_checks() -> int:
    checks = [
        ("static tree", check_static_tree),
        ("template paths + order", check_template_paths_and_order),
        ("templates api only", check_templates_api_only),
        ("molecule3d speed controls", check_molecule3d_speed_controls),
        ("molecule3d stride controls", check_molecule3d_stride_controls),
        ("molecule3d gif controls", check_molecule3d_gif_controls),
        ("molecule3d controls groups", check_molecule3d_controls_groups),
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
