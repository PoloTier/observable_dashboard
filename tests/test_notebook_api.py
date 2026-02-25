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
    traj0 = _build_traj("0", [0.0, 1.0, 2.0])
    traj1 = _build_traj("1", [0.0, 1.0, 2.0])
    return DatasetStore(
        input_path=Path("/tmp/notebook_api.pkl"),
        meta={"source_pkl": "/tmp/notebook_api.pkl"},
        defaults={},
        trajectories={"0": traj0, "1": traj1},
        raw_records_by_traj={
            "0": {
                "_.0.record.time": np.asarray([0.0, 1.0, 2.0], dtype=float),
                "_.0.record.A": np.asarray([1.0, 2.0, 3.0], dtype=float),
            },
            "1": {
                "_.0.record.time": np.asarray([0.0, 1.0, 2.0], dtype=float),
                "_.0.record.A": np.asarray([2.0, 4.0, 6.0], dtype=float),
            },
        },
        raw_frame_meta_by_traj={
            "0": RawFrameMeta(base_len=3, valid_indices=[0, 1, 2]),
            "1": RawFrameMeta(base_len=3, valid_indices=[0, 1, 2]),
        },
        time_key="_.0.record.time",
    )


def _make_client() -> TestClient:
    store = _build_store()
    app = create_app(store=store, cache=SeriesLRUCache(max_entries=256))
    return TestClient(app)


def _create_session(client: TestClient) -> str:
    response = client.post("/api/notebook/session")
    assert response.status_code == 200
    payload = response.json()
    session_id = str(payload.get("session_id", ""))
    assert session_id
    return session_id


def test_notebook_execute_current_and_fetch_series() -> None:
    client = _make_client()
    session_id = _create_session(client)

    response = client.post(
        f"/api/notebook/session/{session_id}/execute",
        json={
            "mode": "current",
            "traj_id": "0",
            "code": (
                "import numpy as np\n"
                "arr = np.asarray(get_raw('_.0.record.A'), dtype=float)\n"
                "time = np.asarray(get_raw('_.0.record.time'), dtype=float)\n"
                "publish('A_shift', arr + 1.0, time=time)\n"
                "print('done current')\n"
            ),
        },
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["ok"] is True
    assert "A_shift" in payload["published_updates"]
    assert "done current" in payload["stdout"]

    listed = client.get(f"/api/notebook/session/{session_id}/published")
    assert listed.status_code == 200
    variables = listed.json().get("variables", [])
    assert len(variables) == 1
    assert variables[0]["name"] == "A_shift"
    assert variables[0]["traj_count"] == 1

    series = client.post(
        "/api/notebook-series",
        json={
            "session_id": session_id,
            "variable": "A_shift",
            "traj_id": "0",
        },
    )
    assert series.status_code == 200
    out = series.json()
    assert out["series_kind"] == "scalar"
    np.testing.assert_allclose(np.asarray(out["time"], dtype=float), np.asarray([1.0, 2.0], dtype=float))
    np.testing.assert_allclose(np.asarray(out["value"], dtype=float), np.asarray([3.0, 4.0], dtype=float))


def test_notebook_execute_all_and_fetch_ensemble() -> None:
    client = _make_client()
    session_id = _create_session(client)

    response = client.post(
        f"/api/notebook/session/{session_id}/execute",
        json={
            "mode": "all",
            "traj_id": None,
            "code": (
                "import numpy as np\n"
                "arr = np.asarray(get_raw('_.0.record.A'), dtype=float)\n"
                "time = np.asarray(get_raw('_.0.record.time'), dtype=float)\n"
                "publish('A_all', arr, time=time)\n"
            ),
        },
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["ok"] is True
    assert payload["mode"] == "all"

    ensemble = client.post(
        "/api/notebook-ensemble",
        json={
            "session_id": session_id,
            "variable": "A_all",
            "stat_mode": "mean_ci95_bootstrap",
        },
    )
    assert ensemble.status_code == 200
    out = ensemble.json()
    assert out["n_trajectories"] == 2
    comp0 = out["component_series"][0]
    np.testing.assert_allclose(np.asarray(comp0["time"], dtype=float), np.asarray([1.0, 2.0], dtype=float))
    np.testing.assert_allclose(np.asarray(comp0["center"], dtype=float), np.asarray([3.0, 4.5], dtype=float))
    assert comp0["sample_count"] == [2, 2]


def test_notebook_series_all_points_filtered_when_time_is_zero() -> None:
    client = _make_client()
    session_id = _create_session(client)

    response = client.post(
        f"/api/notebook/session/{session_id}/execute",
        json={
            "mode": "current",
            "traj_id": "0",
            "code": (
                "import numpy as np\n"
                "arr = np.asarray(get_raw('_.0.record.A'), dtype=float)\n"
                "time = np.zeros(arr.shape[0], dtype=float)\n"
                "publish('all_zero_time', arr, time=time)\n"
            ),
        },
    )
    assert response.status_code == 200
    assert response.json()["ok"] is True

    series = client.post(
        "/api/notebook-series",
        json={
            "session_id": session_id,
            "variable": "all_zero_time",
            "traj_id": "0",
        },
    )
    assert series.status_code == 200
    out = series.json()
    assert out["series_kind"] == "scalar"
    assert out["n_points"] == 0
    assert out["time"] == []
    assert out["value"] == []


def test_notebook_matrix_publish_filters_time_zero_and_keeps_component_metadata() -> None:
    client = _make_client()
    session_id = _create_session(client)

    response = client.post(
        f"/api/notebook/session/{session_id}/execute",
        json={
            "mode": "current",
            "traj_id": "0",
            "code": (
                "import numpy as np\n"
                "arr = np.asarray(get_raw('_.0.record.A'), dtype=float)\n"
                "time = np.asarray(get_raw('_.0.record.time'), dtype=float)\n"
                "mat = np.stack([arr, arr * 10.0], axis=1)\n"
                "publish('A_matrix', mat, time=time, component_labels=['base', 'scaled'])\n"
            ),
        },
    )
    assert response.status_code == 200
    assert response.json()["ok"] is True

    series = client.post(
        "/api/notebook-series",
        json={
            "session_id": session_id,
            "variable": "A_matrix",
            "traj_id": "0",
        },
    )
    assert series.status_code == 200
    out = series.json()
    assert out["series_kind"] == "matrix"
    assert out["n_points"] == 2
    assert out["n_components"] == 2
    assert out["component_labels"] == ["base", "scaled"]
    np.testing.assert_allclose(np.asarray(out["time"], dtype=float), np.asarray([1.0, 2.0], dtype=float))
    np.testing.assert_allclose(
        np.asarray(out["values"], dtype=float),
        np.asarray([[2.0, 20.0], [3.0, 30.0]], dtype=float),
    )


def test_notebook_execute_reports_traceback_on_failure() -> None:
    client = _make_client()
    session_id = _create_session(client)

    response = client.post(
        f"/api/notebook/session/{session_id}/execute",
        json={
            "mode": "current",
            "traj_id": "0",
            "code": "raise RuntimeError('boom')",
        },
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["ok"] is False
    assert "boom" in str(payload["error_message"])
    assert "RuntimeError" in str(payload["traceback"])


def test_notebook_reset_clears_published_variables() -> None:
    client = _make_client()
    session_id = _create_session(client)

    response = client.post(
        f"/api/notebook/session/{session_id}/execute",
        json={
            "mode": "current",
            "traj_id": "0",
            "code": (
                "import numpy as np\n"
                "arr = np.asarray(get_raw('_.0.record.A'), dtype=float)\n"
                "time = np.asarray(get_raw('_.0.record.time'), dtype=float)\n"
                "publish('tmp_var', arr, time=time)\n"
            ),
        },
    )
    assert response.status_code == 200
    assert response.json()["ok"] is True

    reset = client.post(f"/api/notebook/session/{session_id}/reset")
    assert reset.status_code == 200
    assert reset.json()["status"] == "ok"

    listed = client.get(f"/api/notebook/session/{session_id}/published")
    assert listed.status_code == 200
    assert listed.json()["variables"] == []

    missing = client.post(
        "/api/notebook-series",
        json={
            "session_id": session_id,
            "variable": "tmp_var",
            "traj_id": "0",
        },
    )
    assert missing.status_code == 404
