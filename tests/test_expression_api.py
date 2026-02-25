from __future__ import annotations

from pathlib import Path
import sys

import numpy as np
from fastapi.testclient import TestClient

# Keep tests runnable from repository root without requiring editable install.
REPO_ROOT = Path(__file__).resolve().parents[3]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from tools.observable_dashboard.server.app import create_app
from tools.observable_dashboard.server.cache import SeriesLRUCache
from tools.observable_dashboard.server.dataset_store import DatasetStore, RawFrameMeta, TrajectoryRecord


def _build_traj(traj_id: str, time_values: list[float]) -> TrajectoryRecord:
    n_points = len(time_values)
    return TrajectoryRecord(
        traj_id=str(traj_id),
        n_atoms=1,
        atom_numbers=[1],
        time=np.asarray(time_values, dtype=float),
        coords=np.zeros((n_points, 1, 3), dtype=float),
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


def _build_store() -> DatasetStore:
    traj0 = _build_traj("0", [0.0, 2.0])
    traj1 = _build_traj("1", [0.0, 2.0])
    return DatasetStore(
        input_path=Path("/tmp/expression_api.pkl"),
        meta={},
        defaults={},
        trajectories={"0": traj0, "1": traj1},
        raw_records_by_traj={
            "0": {
                "_.0.record.time": np.asarray([0.0, 1.0, 2.0], dtype=float),
                "_.0.record.A": np.asarray([1.0, 2.0, 3.0], dtype=float),
                "_.0.record.M": np.asarray([[1.0, 10.0], [2.0, 20.0], [3.0, 30.0]], dtype=float),
                "_.0.record.CM": np.asarray(
                    [
                        [1.0 + 1.0j, 2.0 + 0.0j],
                        [3.0 + 4.0j, 4.0 + 3.0j],
                        [6.0 + 8.0j, 5.0 + 12.0j],
                    ],
                    dtype=np.complex128,
                ),
            },
            "1": {
                "_.0.record.time": np.asarray([0.0, 1.0, 2.0], dtype=float),
                "_.0.record.A": np.asarray([2.0, 4.0, 6.0], dtype=float),
                "_.0.record.M": np.asarray([[2.0, 12.0], [4.0, 24.0], [6.0, 36.0]], dtype=float),
                "_.0.record.CM": np.asarray(
                    [
                        [2.0 + 2.0j, 1.0 + 0.0j],
                        [1.0 + 1.0j, 2.0 + 2.0j],
                        [8.0 + 6.0j, 7.0 + 24.0j],
                    ],
                    dtype=np.complex128,
                ),
            },
        },
        raw_frame_meta_by_traj={
            "0": RawFrameMeta(base_len=3, valid_indices=[0, 2]),
            "1": RawFrameMeta(base_len=3, valid_indices=[0, 2]),
        },
        time_key="_.0.record.time",
    )


def _make_client() -> TestClient:
    store = _build_store()
    app = create_app(store=store, cache=SeriesLRUCache(max_entries=128))
    return TestClient(app)


def test_expression_dataset_returns_sample_count_and_n_trajectories() -> None:
    client = _make_client()
    response = client.post(
        "/api/expression-dataset",
        json={"expression": "cmean{_.0.record.A}"},
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["scope"] == "dataset"
    assert payload["series_kind"] == "scalar"
    assert payload["n_trajectories"] == 2
    assert payload["sample_count"] == [2, 0, 2]
    assert payload["cached"] is False
    values = np.asarray(payload["value"], dtype=float)
    np.testing.assert_allclose(values, np.asarray([1.5, np.nan, 4.5], dtype=float), equal_nan=True)

    # Cache should be hit on repeated request.
    response_cached = client.post(
        "/api/expression-dataset",
        json={"expression": "cmean{_.0.record.A}"},
    )
    assert response_cached.status_code == 200
    assert response_cached.json()["cached"] is True


def test_expression_dataset_rejects_nested_cross_reduction() -> None:
    client = _make_client()
    response = client.post(
        "/api/expression-dataset",
        json={"expression": "cmean{cmean{_.0.record.A}}"},
    )
    assert response.status_code == 422
    detail = str(response.json().get("detail", ""))
    assert "expects trajectory scope" in detail


def test_expression_series_supports_literals_and_cache() -> None:
    client = _make_client()
    response = client.post(
        "/api/expression-series",
        json={"traj_id": "0", "expression": "tadd{_.0.record.A,-5}"},
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["scope"] == "trajectory"
    assert payload["series_kind"] == "scalar"
    assert payload["cached"] is False
    np.testing.assert_allclose(
        np.asarray(payload["value"], dtype=float),
        np.asarray([-4.0, np.nan, -2.0], dtype=float),
        equal_nan=True,
    )

    response_cached = client.post(
        "/api/expression-series",
        json={"traj_id": "0", "expression": "tadd{_.0.record.A,-5}"},
    )
    assert response_cached.status_code == 200
    assert response_cached.json()["cached"] is True


def test_expression_series_reduce_tabs_complex_matrix() -> None:
    client = _make_client()
    response = client.post(
        "/api/expression-series",
        json={"traj_id": "0", "expression": "reduce{tabs{_.0.record.CM},[-1]}"},
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["scope"] == "trajectory"
    assert payload["series_kind"] == "scalar"
    assert payload["cached"] is False
    np.testing.assert_allclose(
        np.asarray(payload["value"], dtype=float),
        np.asarray([np.sqrt(2.0) + 2.0, np.nan, 23.0], dtype=float),
        equal_nan=True,
    )

    response_cached = client.post(
        "/api/expression-series",
        json={"traj_id": "0", "expression": "reduce{tabs{_.0.record.CM},[-1]}"},
    )
    assert response_cached.status_code == 200
    assert response_cached.json()["cached"] is True


def test_expression_series_reduce_rejects_timed_axis0() -> None:
    client = _make_client()
    response = client.post(
        "/api/expression-series",
        json={"traj_id": "0", "expression": "reduce{_.0.record.M,[0]}"},
    )
    assert response.status_code == 422
    detail = str(response.json().get("detail", ""))
    assert "cannot reduce over time axis 0" in detail


def test_expression_series_rejects_complex_without_tabs() -> None:
    client = _make_client()
    response = client.post(
        "/api/expression-series",
        json={"traj_id": "0", "expression": "tadd{_.0.record.CM,1}"},
    )
    assert response.status_code == 422
    detail = str(response.json().get("detail", ""))
    assert "wrap with tabs" in detail
