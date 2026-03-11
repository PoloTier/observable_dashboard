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
from backend.server.dataset_store import DatasetStore, TrajectoryRecord
from backend.server.models import HoppingEventsRequest, HoppingEventsResponse


def _build_traj(traj_id: str, time_values: list[float], state_values: list[int]) -> TrajectoryRecord:
    time = np.asarray(time_values, dtype=float)
    state = np.asarray(state_values, dtype=int)
    n_points = int(min(time.size, state.size))
    return TrajectoryRecord(
        traj_id=str(traj_id),
        n_atoms=1,
        atom_numbers=[1],
        time=time[:n_points].copy(),
        coords=np.zeros((n_points, 1, 3), dtype=float),
        etot_time=time[:n_points].copy(),
        etot=np.linspace(0.0, float(max(n_points - 1, 0)), num=n_points, dtype=float),
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
        state_time=time[:n_points].copy(),
        state=state[:n_points].copy(),
        c_prob_time=np.asarray([], dtype=float),
        c_prob=np.empty((0, 0), dtype=float),
    )


def _build_store() -> DatasetStore:
    traj0 = _build_traj("0", [0.0, 1.0, 2.0, 3.0, 4.0], [1, 1, 0, 0, 1])
    traj1 = _build_traj("1", [0.0, 1.0, 2.0, 3.0], [1, 0, 1, 0])
    return DatasetStore(
        input_path=Path("/tmp/hopping_api.pkl"),
        meta={"n_states": 3},
        defaults={},
        trajectories={"0": traj0, "1": traj1},
    )


def _make_endpoint() -> Callable[..., object]:
    store = _build_store()
    app = create_app(store=store, cache=SeriesLRUCache(max_entries=128))
    endpoint = None
    for route in app.routes:
        path = getattr(route, "path", "")
        methods = set(getattr(route, "methods", set()) or set())
        if path == "/api/hopping-events" and "POST" in methods:
            endpoint = route.endpoint
            break
    assert callable(endpoint)
    return endpoint


def test_hopping_events_single_traj_returns_arrival_frame_times() -> None:
    endpoint = _make_endpoint()
    payload = endpoint(
        HoppingEventsRequest(
            traj_ids=["0"],
            algorithm="max_abs_c",
            time_rule="arrival_frame",
            transitions=[{"from_state": 1, "to_state": 0}, {"from_state": 0, "to_state": 1}],
        )
    )
    assert isinstance(payload, HoppingEventsResponse)
    assert payload.cached is False
    assert payload.traj_ids == ["0"]
    assert [item.transition_key for item in payload.transitions] == ["1->0", "0->1"]
    assert len(payload.events_by_traj["0"]) == 2

    first_event = payload.events_by_traj["0"][0]
    assert first_event.transition_key == "1->0"
    assert first_event.frame_from == 1
    assert first_event.frame_to == 2
    assert first_event.time == 2.0

    second_event = payload.events_by_traj["0"][1]
    assert second_event.transition_key == "0->1"
    assert second_event.frame_from == 3
    assert second_event.frame_to == 4
    assert second_event.time == 4.0

    totals = {item.transition_key: item.count for item in payload.totals_by_transition}
    assert totals == {"1->0": 1, "0->1": 1}


def test_hopping_events_all_traj_returns_counts_and_cache() -> None:
    endpoint = _make_endpoint()
    request = HoppingEventsRequest(
        traj_ids=["0", "1"],
        algorithm="max_abs_c",
        time_rule="arrival_frame",
        transitions=[{"from_state": 1, "to_state": 0}, {"from_state": 0, "to_state": 1}],
    )
    payload = endpoint(request)
    assert isinstance(payload, HoppingEventsResponse)
    assert payload.cached is False
    assert set(payload.events_by_traj.keys()) == {"0", "1"}
    assert len(payload.events_by_traj["1"]) == 3

    counts = {
        (item.traj_id, item.transition_key): item.count
        for item in payload.counts_by_traj
    }
    assert counts[("0", "1->0")] == 1
    assert counts[("0", "0->1")] == 1
    assert counts[("1", "1->0")] == 2
    assert counts[("1", "0->1")] == 1

    totals = {item.transition_key: item.count for item in payload.totals_by_transition}
    assert totals == {"1->0": 3, "0->1": 2}

    payload_cached = endpoint(request)
    assert isinstance(payload_cached, HoppingEventsResponse)
    assert payload_cached.cached is True


def test_hopping_events_reject_invalid_transition() -> None:
    endpoint = _make_endpoint()
    with pytest.raises(HTTPException) as exc_info:
        endpoint(
            HoppingEventsRequest(
                traj_ids=["0"],
                algorithm="max_abs_c",
                time_rule="arrival_frame",
                transitions=[{"from_state": 1, "to_state": 1}],
            )
        )
    assert exc_info.value.status_code == 422
    assert "from_state != to_state" in str(exc_info.value.detail)


def test_hopping_events_reject_transition_out_of_dataset_bounds() -> None:
    endpoint = _make_endpoint()
    with pytest.raises(HTTPException) as exc_info:
        endpoint(
            HoppingEventsRequest(
                traj_ids=["0"],
                algorithm="max_abs_c",
                time_rule="arrival_frame",
                transitions=[{"from_state": 3, "to_state": 1}],
            )
        )
    assert exc_info.value.status_code == 422
    assert "out of bounds" in str(exc_info.value.detail)
