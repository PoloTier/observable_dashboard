from __future__ import annotations

from pathlib import Path
import sys
from typing import Callable

import numpy as np
import pytest
from fastapi import HTTPException

# Keep tests runnable from repository root without requiring editable install.
REPO_ROOT = Path(__file__).resolve().parents[3]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from backend.server.app import create_app
from backend.server.cache import SeriesLRUCache
from backend.server.dataset_store import DatasetStore, RawFrameMeta, TrajectoryRecord
from backend.server.models import MoleculeHydrogenBondResponse


def _slow_reference_hbonds(
    coords: np.ndarray,
    atom_numbers: np.ndarray,
    *,
    hbond_distance_cutoff: float = 3.5,
    hbond_angle_cutoff: float = 120.0,
    dh_bond_length: float = 1.3,
) -> list[dict[str, float | int]]:
    hydrogen_indices = [int(idx) for idx, atom_number in enumerate(atom_numbers.tolist()) if int(atom_number) == 1]
    donor_acceptor_indices = [
        int(idx) for idx, atom_number in enumerate(atom_numbers.tolist()) if int(atom_number) in {7, 8, 9}
    ]

    hbonds: list[dict[str, float | int]] = []
    for frame_idx in range(int(coords.shape[0])):
        frame_coords = np.asarray(coords[frame_idx], dtype=float)
        for h_idx in hydrogen_indices:
            h_coord = frame_coords[h_idx]
            donor_idx: int | None = None
            donor_coord: np.ndarray | None = None

            for candidate_donor_idx in donor_acceptor_indices:
                d_coord = frame_coords[candidate_donor_idx]
                dh_dist = float(np.linalg.norm(h_coord - d_coord))
                if not np.isfinite(dh_dist):
                    continue
                if dh_dist < float(dh_bond_length):
                    donor_idx = int(candidate_donor_idx)
                    donor_coord = d_coord
                    break

            if donor_idx is None or donor_coord is None:
                continue

            vec_dh = np.asarray(donor_coord - h_coord, dtype=float)
            vec_dh_norm = float(np.linalg.norm(vec_dh))
            if not np.isfinite(vec_dh_norm) or vec_dh_norm <= 1e-12:
                continue

            for acceptor_idx in donor_acceptor_indices:
                if int(acceptor_idx) == donor_idx:
                    continue

                acceptor_coord = frame_coords[acceptor_idx]
                vec_ha = np.asarray(acceptor_coord - h_coord, dtype=float)
                ha_dist = float(np.linalg.norm(vec_ha))
                if not np.isfinite(ha_dist):
                    continue
                if ha_dist >= float(hbond_distance_cutoff):
                    continue

                vec_ha_norm = float(np.linalg.norm(vec_ha))
                if not np.isfinite(vec_ha_norm) or vec_ha_norm <= 1e-12:
                    continue

                cos_theta = float(np.dot(vec_dh, vec_ha) / (vec_dh_norm * vec_ha_norm))
                cos_theta = max(-1.0, min(1.0, cos_theta))
                angle = float(np.degrees(np.arccos(cos_theta)))
                if not np.isfinite(angle):
                    continue
                if angle < float(hbond_angle_cutoff):
                    continue

                hbonds.append(
                    {
                        "frame": int(frame_idx),
                        "donor_idx": int(donor_idx),
                        "h_idx": int(h_idx),
                        "acceptor_idx": int(acceptor_idx),
                        "distance": float(ha_dist),
                        "angle": float(angle),
                    }
                )
    return hbonds


def _build_store() -> DatasetStore:
    # Frame 0 has one O-H...O hydrogen bond:
    # donor O(0) -- H(1) distance = 1.0
    # H(1) ... acceptor O(2) distance = 1.8
    # angle O(0)-H(1)-O(2) = 180 degrees
    # Frame 1 breaks angle criterion (90 degrees).
    coords = np.asarray(
        [
            [
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [2.8, 0.0, 0.0],
            ],
            [
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [1.0, 1.0, 0.0],
            ],
        ],
        dtype=float,
    )
    traj = TrajectoryRecord(
        traj_id="0",
        n_atoms=3,
        atom_numbers=[8, 1, 8],
        time=np.asarray([0.0, 1.0], dtype=float),
        coords=coords,
        etot_time=np.asarray([], dtype=float),
        etot=np.asarray([], dtype=float),
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

    return DatasetStore(
        input_path=Path("/tmp/mol3d_hbond_test.pkl"),
        meta={},
        defaults={},
        trajectories={"0": traj},
        raw_records_by_traj={},
        raw_frame_meta_by_traj={"0": RawFrameMeta(base_len=2, valid_indices=[0, 1])},
    )


def _make_hbond_endpoint() -> Callable[[str], MoleculeHydrogenBondResponse]:
    store = _build_store()
    app = create_app(store=store, cache=SeriesLRUCache(max_entries=128))
    endpoint = None
    for route in app.routes:
        path = getattr(route, "path", "")
        methods = set(getattr(route, "methods", set()) or set())
        if path == "/api/molecule3d/hbonds/{traj_id}" and "GET" in methods:
            endpoint = route.endpoint
    assert callable(endpoint)
    return endpoint


def test_build_mol3d_hbond_payload_detects_expected_pair() -> None:
    store = _build_store()
    payload = store.build_mol3d_hbond_payload("0")

    assert payload is not None
    assert payload["traj_id"] == "0"
    assert payload["n_frames"] == 2
    assert payload["n_atoms"] == 3
    assert payload["donor_acceptor_atomic_numbers"] == [7, 8, 9]
    assert payload["hbond_distance_cutoff"] == 3.5
    assert payload["hbond_angle_cutoff"] == 120.0
    assert payload["dh_bond_length"] == 1.3

    hbonds = payload["hbonds"]
    assert isinstance(hbonds, list)
    assert len(hbonds) == 1
    hb = hbonds[0]
    assert hb["frame"] == 0
    assert hb["donor_idx"] == 0
    assert hb["h_idx"] == 1
    assert hb["acceptor_idx"] == 2
    assert hb["distance"] == pytest.approx(1.8, abs=1e-12)
    assert hb["angle"] == pytest.approx(180.0, abs=1e-12)


def test_build_mol3d_hbond_payload_matches_reference_with_large_motion() -> None:
    coords = np.asarray(
        [
            [
                [0.0, 0.0, 0.0],   # O donor
                [1.0, 0.0, 0.0],   # H bonded to donor
                [5.2, 0.0, 0.0],   # O acceptor starts far away
                [0.0, 3.0, 0.0],   # N donor
                [0.9, 3.0, 0.0],   # H bonded to N
                [2.8, 3.0, 0.0],   # O acceptor near N-H
                [6.0, 6.0, 6.0],   # carbon
            ],
            [
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [2.8, 0.0, 0.0],   # O acceptor moves in to form H-bond
                [0.0, 3.0, 0.0],
                [0.9, 3.0, 0.0],
                [2.8, 3.0, 0.0],
                [6.0, 6.0, 6.0],
            ],
            [
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [3.0, 0.6, 0.0],   # angle changes but still above cutoff
                [0.0, 3.0, 0.0],
                [0.9, 3.0, 0.0],
                [2.8, 4.1, 0.0],   # break the second H-bond
                [6.0, 6.0, 6.0],
            ],
        ],
        dtype=float,
    )
    atom_numbers = np.asarray([8, 1, 8, 7, 1, 8, 6], dtype=int)
    traj = TrajectoryRecord(
        traj_id="0",
        n_atoms=int(coords.shape[1]),
        atom_numbers=atom_numbers.tolist(),
        time=np.asarray([0.0, 1.0, 2.0], dtype=float),
        coords=coords,
        etot_time=np.asarray([], dtype=float),
        etot=np.asarray([], dtype=float),
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
    store = DatasetStore(
        input_path=Path("/tmp/mol3d_hbond_motion_test.pkl"),
        meta={},
        defaults={},
        trajectories={"0": traj},
        raw_records_by_traj={},
        raw_frame_meta_by_traj={"0": RawFrameMeta(base_len=3, valid_indices=[0, 1, 2])},
    )

    payload = store.build_mol3d_hbond_payload("0")
    assert payload is not None

    expected = _slow_reference_hbonds(coords, atom_numbers)
    observed = payload["hbonds"]
    assert len(observed) == len(expected)
    for observed_item, expected_item in zip(observed, expected, strict=True):
        assert observed_item["frame"] == expected_item["frame"]
        assert observed_item["donor_idx"] == expected_item["donor_idx"]
        assert observed_item["h_idx"] == expected_item["h_idx"]
        assert observed_item["acceptor_idx"] == expected_item["acceptor_idx"]
        assert observed_item["distance"] == pytest.approx(expected_item["distance"], abs=1e-12)
        assert observed_item["angle"] == pytest.approx(expected_item["angle"], abs=1e-12)


def test_molecule3d_hbond_endpoint_supports_cache() -> None:
    endpoint = _make_hbond_endpoint()

    first = endpoint("0")
    assert isinstance(first, MoleculeHydrogenBondResponse)
    assert first.traj_id == "0"
    assert first.cached is False
    assert len(first.hbonds) == 1

    second = endpoint("0")
    assert isinstance(second, MoleculeHydrogenBondResponse)
    assert second.cached is True
    assert len(second.hbonds) == 1
    assert second.hbonds[0].frame == 0
    assert second.hbonds[0].donor_idx == 0
    assert second.hbonds[0].h_idx == 1
    assert second.hbonds[0].acceptor_idx == 2


def test_molecule3d_hbond_endpoint_missing_trajectory() -> None:
    endpoint = _make_hbond_endpoint()
    with pytest.raises(HTTPException) as exc_info:
        endpoint("missing")
    assert exc_info.value.status_code == 404
