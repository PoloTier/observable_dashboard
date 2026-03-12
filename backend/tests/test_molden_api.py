from __future__ import annotations

from pathlib import Path
import sys

import numpy as np
import pytest
from fastapi import HTTPException

# Keep tests runnable from repository root without requiring editable install.
REPO_ROOT = Path(__file__).resolve().parents[3]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from backend.server.app import create_app
from backend.server.cache import SeriesLRUCache
from backend.server.dataset_store import DatasetStore, TrajectoryRecord
from backend.server.molden import BOHR_TO_ANG, parse_molden_normal_modes
from backend.server.models import NormalModesParseTextRequest


MOLDEN_TEXT = """[Molden Format]
[Atoms] Angs
 C   1   6   0.000000   0.000000   0.000000
 H   2   1   0.000000   0.000000   1.000000
[FR-COORD]
 C   0.000000   0.000000   0.000000
 H   0.000000   0.000000   1.889726125
[FREQ]
  0.0000
  1200.5000
[INT]
  0.0000
  5.5000
[FR-NORM-COORD]
 vibration 1
  0.000000   0.000000   0.000000
  0.000000   0.100000   0.000000
 vibration 2
  0.010000   0.000000   0.000000
  0.000000  -0.020000   0.030000
"""

MOLDEN_NO_FR_COORD = """[Molden Format]
[Atoms] Angs
 O   1   8   0.100000   0.200000   0.300000
 H   2   1   0.100000   0.200000   1.100000
[FREQ]
 -55.0000
[FR-NORM-COORD]
 vibration 1
  0.010000   0.000000   0.000000
  0.000000   0.010000   0.000000
"""

MOLDEN_BAD_MODE_COUNT = """[Molden Format]
[Atoms] Angs
 C   1   6   0.000000   0.000000   0.000000
 H   2   1   0.000000   0.000000   1.000000
[FREQ]
  100.0
  200.0
[FR-NORM-COORD]
 vibration 1
  0.000000   0.000000   0.000000
  0.000000   0.010000   0.000000
"""


def _build_traj(traj_id: str) -> TrajectoryRecord:
    time = np.asarray([0.0, 1.0], dtype=float)
    return TrajectoryRecord(
        traj_id=str(traj_id),
        n_atoms=1,
        atom_numbers=[1],
        time=time,
        coords=np.zeros((2, 1, 3), dtype=float),
        etot_time=time.copy(),
        etot=np.asarray([0.0, 0.1], dtype=float),
        eig_time=np.asarray([], dtype=float),
        eig=np.empty((0, 0), dtype=float),
        nac_time=np.asarray([], dtype=float),
        nac_norm=np.asarray([], dtype=float),
        nac_components=np.empty((0, 0, 0, 0), dtype=float),
        nac_state_count=0,
        nac_component_count=0,
        de_nac_time=np.asarray([], dtype=float),
        de_nac_norm=np.asarray([], dtype=float),
        de_nac_components=np.empty((0, 0, 0, 0), dtype=float),
        de_nac_state_count=0,
        de_nac_component_count=0,
        state_time=np.asarray([], dtype=float),
        state=np.asarray([], dtype=int),
        c_prob_time=np.asarray([], dtype=float),
        c_prob=np.empty((0, 0), dtype=float),
    )


def _build_store() -> DatasetStore:
    return DatasetStore(
        input_path=Path("/tmp/molden_api.pkl"),
        meta={"source_pkl": "/tmp/molden_api.pkl"},
        defaults={},
        trajectories={"0": _build_traj("0")},
    )


def _find_endpoint(app: object, path: str, method: str):
    method_text = method.upper()
    for route in getattr(app, "routes", []):
        if getattr(route, "path", "") != path:
            continue
        methods = set(getattr(route, "methods", set()) or set())
        if method_text in methods:
            return route.endpoint
    raise AssertionError(f"Could not find route for path={path!r}, method={method_text!r}.")


def test_parse_molden_normal_modes_converts_coords_and_vectors() -> None:
    payload = parse_molden_normal_modes(MOLDEN_TEXT, source_name="sample/freq.molden")

    assert payload["source_name"] == "freq.molden"
    assert payload["n_atoms"] == 2
    assert payload["atom_numbers"] == [6, 1]
    assert payload["coords_ang"][1][2] == pytest.approx(1.0, abs=1e-8)
    assert payload["mode_vectors_ang"][1][0][0] == pytest.approx(0.01 * BOHR_TO_ANG, rel=1e-12)
    assert payload["mode_summaries"][0]["kind"] == "zero"
    assert payload["mode_summaries"][1]["kind"] == "positive"
    assert payload["mode_summaries"][1]["intensity"] == pytest.approx(5.5)
    assert payload["default_mode_index"] == 1


def test_parse_molden_normal_modes_falls_back_to_atoms_when_fr_coord_missing() -> None:
    payload = parse_molden_normal_modes(MOLDEN_NO_FR_COORD, source_name="mode.dat")

    assert np.allclose(
        np.asarray(payload["coords_ang"], dtype=float),
        np.asarray(
            [
                [0.1, 0.2, 0.3],
                [0.1, 0.2, 1.1],
            ],
            dtype=float,
        ),
    )
    assert payload["mode_summaries"][0]["kind"] == "imaginary"
    assert payload["default_mode_index"] == 0


def test_parse_normal_modes_api_returns_payload() -> None:
    app = create_app(store=_build_store(), cache=SeriesLRUCache(max_entries=16))
    endpoint = _find_endpoint(app, "/api/normal-modes/parse-text", "POST")

    response = endpoint(
        NormalModesParseTextRequest(
            filename="/tmp/example/freq.molden",
            content=MOLDEN_TEXT,
        )
    )

    assert response.source_name == "freq.molden"
    assert response.n_atoms == 2
    assert response.default_mode_index == 1
    assert response.mode_summaries[1].frequency_cm1 == pytest.approx(1200.5)


def test_parse_normal_modes_api_rejects_frequency_mode_mismatch() -> None:
    app = create_app(store=_build_store(), cache=SeriesLRUCache(max_entries=16))
    endpoint = _find_endpoint(app, "/api/normal-modes/parse-text", "POST")

    with pytest.raises(HTTPException) as exc_info:
        endpoint(
            NormalModesParseTextRequest(
                filename="broken.molden",
                content=MOLDEN_BAD_MODE_COUNT,
            )
        )

    assert exc_info.value.status_code == 422
    assert "Frequency count does not match" in str(exc_info.value.detail)
