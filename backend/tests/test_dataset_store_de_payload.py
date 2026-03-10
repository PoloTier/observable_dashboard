from __future__ import annotations

from pathlib import Path
import sys

import numpy as np
import pytest

# Keep tests runnable from repository root without requiring editable install.
REPO_ROOT = Path(__file__).resolve().parents[3]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from backend.server.dataset_store import DatasetStore, RawFrameMeta, TrajectoryRecord


def _build_store() -> DatasetStore:
    traj = TrajectoryRecord(
        traj_id="0",
        n_atoms=1,
        atom_numbers=[1],
        time=np.asarray([0.0, 1.0], dtype=float),
        coords=np.asarray(
            [
                [[0.0, 0.0, 0.0]],
                [[1.0, 0.0, 0.0]],
            ],
            dtype=float,
        ),
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

    # Shape: [frame, selector_axis(=1), component(=3), state_i(=2), state_j(=2)]
    de_raw = np.asarray(
        [
            [
                [
                    [1.0, 2.0],
                    [3.0, 4.0],
                ],
                [
                    [10.0, 20.0],
                    [30.0, 40.0],
                ],
                [
                    [100.0, 200.0],
                    [300.0, 400.0],
                ],
            ],
            [
                [
                    [5.0, 6.0],
                    [7.0, 8.0],
                ],
                [
                    [50.0, 60.0],
                    [70.0, 80.0],
                ],
                [
                    [500.0, 600.0],
                    [700.0, 800.0],
                ],
            ],
        ],
        dtype=float,
    )
    de_raw = np.expand_dims(de_raw, axis=1)

    return DatasetStore(
        input_path=Path("/tmp/dummy.pkl"),
        meta={},
        defaults={},
        trajectories={"0": traj},
        raw_records_by_traj={"0": {"_.0.record.dE": de_raw}},
        raw_frame_meta_by_traj={"0": RawFrameMeta(base_len=2, valid_indices=[0, 1])},
    )


def test_build_mol3d_de_payload_allows_diagonal_state_pair() -> None:
    store = _build_store()
    payload = store.build_mol3d_de_payload("0", 0, 0)

    assert payload is not None
    assert payload["state_i"] == 0
    assert payload["state_j"] == 0
    assert payload["n_frames"] == 2
    vectors = np.asarray(payload["vectors"], dtype=float)
    assert vectors.shape == (2, 1, 3)
    np.testing.assert_allclose(vectors[:, 0, :], np.asarray([[1.0, 10.0, 100.0], [5.0, 50.0, 500.0]], dtype=float))


def test_build_mol3d_de_payload_diagonal_out_of_bounds_still_fails() -> None:
    store = _build_store()
    with pytest.raises(ValueError, match="state_i out of bounds"):
        store.build_mol3d_de_payload("0", 2, 2)

def test_build_mol3d_payload_includes_de_global_norm_stats() -> None:
    store = _build_store()
    payload = store.build_mol3d_payload("0")

    assert payload is not None
    assert payload["de_global_norm_scope"] == "traj_global"
    assert payload["de_global_norm_count"] > 0

    de_tensor = store._build_mol3d_de_tensor("0")
    n_frames, n_components, n_states_i, n_states_j = de_tensor.shape
    vectors = de_tensor.reshape(n_frames, 1, 3, n_states_i, n_states_j)
    mags = np.linalg.norm(vectors, axis=2).reshape(-1)
    finite = mags[np.isfinite(mags)]
    expected_p5, expected_p90, expected_p95 = np.quantile(finite, [0.05, 0.90, 0.95]).astype(float).tolist()

    np.testing.assert_allclose(float(payload["de_global_norm_p5"]), expected_p5)
    np.testing.assert_allclose(float(payload["de_global_norm_p90"]), expected_p90)
    np.testing.assert_allclose(float(payload["de_global_norm_p95"]), expected_p95)

