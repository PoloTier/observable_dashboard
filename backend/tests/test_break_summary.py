from __future__ import annotations

from pathlib import Path
import sys

import numpy as np

# Keep tests runnable from repository root without requiring editable install.
REPO_ROOT = Path(__file__).resolve().parents[3]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from backend.server.app import create_app
from backend.server.cache import SeriesLRUCache
from backend.server.dataset_store import DatasetStore, RawFrameMeta, TrajectoryRecord


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
    return DatasetStore(
        input_path=Path("/tmp/break_summary.pkl"),
        meta={"source_pkl": "/tmp/break_summary.pkl"},
        defaults={},
        trajectories={
            "0": _build_traj("0", [0.0, 1.0]),
            "1": _build_traj("1", [0.0, 1.0, 2.0, 3.0]),
            "2": _build_traj("2", [0.0, 1.0, 2.0, 3.0]),
            "3": _build_traj("3", [0.0, 1.0, 2.0]),
        },
        raw_records_by_traj={
            "0": {
                "_.0.record.time": np.asarray([0.0, 1.0, 2.0, 3.0], dtype=float),
                "_.0.record.Etot": np.asarray([10.0, 11.0, 12.0, 13.0], dtype=float),
            },
            "1": {
                "_.0.record.time": np.asarray([0.0, 1.0, 2.0, 3.0], dtype=float),
                "_.0.record.Etot": np.asarray([20.0, 21.0, np.nan, np.nan], dtype=float),
            },
            "2": {
                "_.0.record.time": np.asarray([0.0, 1.0, 2.0, 3.0], dtype=float),
                "_.0.record.Etot": np.asarray([30.0, np.nan, 32.0, 33.0], dtype=float),
            },
            "3": {
                "_.0.record.time": np.asarray([0.0, 1.0, 2.0, 3.0], dtype=float),
                "_.0.record.Etot": np.asarray([40.0, 41.0, np.nan, np.nan], dtype=float),
            },
        },
        raw_frame_meta_by_traj={
            "0": RawFrameMeta(base_len=4, valid_indices=[0, 1]),
            "1": RawFrameMeta(base_len=4, valid_indices=[0, 1, 2, 3]),
            "2": RawFrameMeta(base_len=4, valid_indices=[0, 1, 2, 3]),
            "3": RawFrameMeta(base_len=4, valid_indices=[0, 1, 2]),
        },
        time_key="_.0.record.time",
    )


def _get_bootstrap_endpoint(app: object):
    for route in getattr(app, "routes", []):
        path = getattr(route, "path", "")
        methods = set(getattr(route, "methods", set()) or set())
        if path == "/api/bootstrap" and "GET" in methods:
            return route.endpoint
    raise AssertionError("Could not find /api/bootstrap endpoint.")


def test_store_break_summary_detects_frame_mask_and_nan_suffix() -> None:
    store = _build_store()
    summary = store.build_trajectory_break_summary()

    assert summary["total_traj"] == 4
    assert summary["broken_traj_count"] == 3
    assert summary["complete_traj_count"] == 1

    broken = summary["broken_trajs"]
    assert [item["traj_id"] for item in broken] == ["0", "1", "3"]

    item0 = broken[0]
    assert item0["reason"] == "frame_mask_suffix"
    assert item0["break_frame_index"] == 2
    assert item0["break_time"] == 2.0
    assert item0["source_key"] is None

    item1 = broken[1]
    assert item1["reason"] == "nan_suffix"
    assert item1["break_frame_index"] == 2
    assert item1["break_time"] == 2.0
    assert item1["source_key"] == "_.0.record.Etot"

    item3 = broken[2]
    # Trajectory 3 has both frame-mask and NaN suffix candidates; the earliest break wins.
    assert item3["reason"] == "nan_suffix"
    assert item3["break_frame_index"] == 2
    assert item3["break_time"] == 2.0
    assert item3["source_key"] == "_.0.record.Etot"


def test_bootstrap_meta_includes_break_summary() -> None:
    store = _build_store()
    app = create_app(store=store, cache=SeriesLRUCache(max_entries=64))
    endpoint = _get_bootstrap_endpoint(app)

    payload = endpoint()
    meta = payload.meta

    assert isinstance(meta, dict)
    assert "trajectory_break_summary" in meta
    summary = meta["trajectory_break_summary"]
    assert isinstance(summary, dict)
    assert summary.get("total_traj") == 4
    assert summary.get("broken_traj_count") == 3
    assert summary.get("complete_traj_count") == 1
