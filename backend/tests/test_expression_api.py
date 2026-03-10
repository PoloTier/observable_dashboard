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
from backend.server.models import (
    ExpressionEnsembleRequest,
    ExpressionEnsembleResponse,
    ExpressionDatasetRequest,
    ExpressionSeriesRequest,
    ExpressionSeriesResponse,
)


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


def _make_endpoints() -> tuple[Callable[..., object], Callable[..., object], Callable[..., object]]:
    store = _build_store()
    app = create_app(store=store, cache=SeriesLRUCache(max_entries=128))
    series_ep = None
    ensemble_ep = None
    dataset_ep = None
    for route in app.routes:
        path = getattr(route, "path", "")
        methods = set(getattr(route, "methods", set()) or set())
        if path == "/api/expression-series" and "POST" in methods:
            series_ep = route.endpoint
        if path == "/api/expression-ensemble" and "POST" in methods:
            ensemble_ep = route.endpoint
        if path == "/api/expression-dataset" and "POST" in methods:
            dataset_ep = route.endpoint
    assert callable(series_ep)
    assert callable(ensemble_ep)
    assert callable(dataset_ep)
    return series_ep, ensemble_ep, dataset_ep


def test_expression_dataset_is_disabled() -> None:
    _, _, dataset_ep = _make_endpoints()
    with pytest.raises(HTTPException) as exc_info:
        dataset_ep(ExpressionDatasetRequest(expression="tadd{_.0.record.A,-5}"))
    assert exc_info.value.status_code == 422
    assert "single-trajectory mode" in str(exc_info.value.detail)


def test_expression_series_rejects_cross_trajectory_ops() -> None:
    series_ep, _, _ = _make_endpoints()
    with pytest.raises(HTTPException) as exc_info:
        series_ep(ExpressionSeriesRequest(traj_id="0", expression="cmean{_.0.record.A}"))
    assert exc_info.value.status_code == 422
    assert "Function 'cmean' is not supported" in str(exc_info.value.detail)


def test_expression_series_supports_literals_and_cache() -> None:
    series_ep, _, _ = _make_endpoints()
    payload = series_ep(ExpressionSeriesRequest(traj_id="0", expression="tadd{_.0.record.A,-5}"))
    assert isinstance(payload, ExpressionSeriesResponse)
    assert payload.scope == "trajectory"
    assert payload.series_kind == "scalar"
    assert payload.cached is False
    np.testing.assert_allclose(
        np.asarray(payload.value, dtype=float),
        np.asarray([-4.0, np.nan, -2.0], dtype=float),
        equal_nan=True,
    )

    payload_cached = series_ep(
        ExpressionSeriesRequest(traj_id="0", expression="tadd{_.0.record.A,-5}")
    )
    assert isinstance(payload_cached, ExpressionSeriesResponse)
    assert payload_cached.cached is True


def test_expression_series_reduce_tabs_complex_matrix() -> None:
    series_ep, _, _ = _make_endpoints()
    payload = series_ep(
        ExpressionSeriesRequest(traj_id="0", expression="reduce{tabs{_.0.record.CM},[-1]}")
    )
    assert isinstance(payload, ExpressionSeriesResponse)
    assert payload.scope == "trajectory"
    assert payload.series_kind == "scalar"
    assert payload.cached is False
    np.testing.assert_allclose(
        np.asarray(payload.value, dtype=float),
        np.asarray([np.sqrt(2.0) + 2.0, np.nan, 23.0], dtype=float),
        equal_nan=True,
    )

    payload_cached = series_ep(
        ExpressionSeriesRequest(traj_id="0", expression="reduce{tabs{_.0.record.CM},[-1]}")
    )
    assert isinstance(payload_cached, ExpressionSeriesResponse)
    assert payload_cached.cached is True


def test_expression_series_reduce_rejects_timed_axis0() -> None:
    series_ep, _, _ = _make_endpoints()
    with pytest.raises(HTTPException) as exc_info:
        series_ep(ExpressionSeriesRequest(traj_id="0", expression="reduce{_.0.record.M,[0]}"))
    assert exc_info.value.status_code == 422
    assert "cannot reduce over time axis 0" in str(exc_info.value.detail)


def test_expression_series_rejects_complex_without_tabs() -> None:
    series_ep, _, _ = _make_endpoints()
    with pytest.raises(HTTPException) as exc_info:
        series_ep(ExpressionSeriesRequest(traj_id="0", expression="tadd{_.0.record.CM,1}"))
    assert exc_info.value.status_code == 422
    assert "wrap with tabs" in str(exc_info.value.detail)


def test_expression_ensemble_scalar_supports_cache() -> None:
    _, ensemble_ep, _ = _make_endpoints()
    payload = ensemble_ep(
        ExpressionEnsembleRequest(
            expression="tadd{_.0.record.A,-5}",
            stat_mode="mean_ci95_bootstrap",
        )
    )
    assert isinstance(payload, ExpressionEnsembleResponse)
    assert payload.expression == "tadd{_.0.record.A,-5}"
    assert payload.series_kind == "scalar"
    assert payload.n_components is None
    assert payload.cached is False
    assert payload.n_trajectories == 2
    assert len(payload.component_series) == 1
    component = payload.component_series[0]
    np.testing.assert_allclose(
        np.asarray(component.time, dtype=float),
        np.asarray([0.0, 2.0], dtype=float),
        atol=1e-12,
    )
    np.testing.assert_allclose(
        np.asarray(component.center, dtype=float),
        np.asarray([-3.5, -0.5], dtype=float),
        atol=1e-12,
    )
    assert component.sample_count == [2, 2]
    assert len(component.low) == len(component.center) == len(component.high) == 2
    for low, center, high in zip(component.low, component.center, component.high):
        assert float(low) <= float(center) <= float(high)

    payload_cached = ensemble_ep(
        ExpressionEnsembleRequest(
            expression="tadd{_.0.record.A,-5}",
            stat_mode="mean_ci95_bootstrap",
        )
    )
    assert isinstance(payload_cached, ExpressionEnsembleResponse)
    assert payload_cached.cached is True


def test_expression_ensemble_matrix_supports_median_iqr() -> None:
    _, ensemble_ep, _ = _make_endpoints()
    payload = ensemble_ep(
        ExpressionEnsembleRequest(
            expression="tabs{_.0.record.CM}",
            stat_mode="median_iqr",
        )
    )
    assert isinstance(payload, ExpressionEnsembleResponse)
    assert payload.expression == "tabs{_.0.record.CM}"
    assert payload.series_kind == "matrix"
    assert payload.n_components == 2
    assert payload.n_trajectories == 2
    assert payload.cached is False
    assert len(payload.component_series) == 2

    comp0 = payload.component_series[0]
    comp1 = payload.component_series[1]
    np.testing.assert_allclose(
        np.asarray(comp0.time, dtype=float),
        np.asarray([0.0, 2.0], dtype=float),
        atol=1e-12,
    )
    np.testing.assert_allclose(
        np.asarray(comp0.center, dtype=float),
        np.asarray([2.1213203435596424, 10.0], dtype=float),
        atol=1e-12,
    )
    np.testing.assert_allclose(
        np.asarray(comp1.center, dtype=float),
        np.asarray([1.5, 19.0], dtype=float),
        atol=1e-12,
    )
    assert comp0.sample_count == [2, 2]
    assert comp1.sample_count == [2, 2]

    payload_cached = ensemble_ep(
        ExpressionEnsembleRequest(
            expression="tabs{_.0.record.CM}",
            stat_mode="median_iqr",
        )
    )
    assert isinstance(payload_cached, ExpressionEnsembleResponse)
    assert payload_cached.cached is True


def test_expression_ensemble_scalar_renorm_mode_falls_back_to_mean() -> None:
    _, ensemble_ep, _ = _make_endpoints()
    payload_mean = ensemble_ep(
        ExpressionEnsembleRequest(
            expression="tadd{_.0.record.A,-5}",
            stat_mode="mean_ci95_bootstrap",
        )
    )
    payload_renorm = ensemble_ep(
        ExpressionEnsembleRequest(
            expression="tadd{_.0.record.A,-5}",
            stat_mode="renorm_mean_ci95_bootstrap",
        )
    )
    assert isinstance(payload_mean, ExpressionEnsembleResponse)
    assert isinstance(payload_renorm, ExpressionEnsembleResponse)
    assert payload_renorm.series_kind == "scalar"
    assert payload_renorm.stat_mode == "renorm_mean_ci95_bootstrap"
    comp_mean = payload_mean.component_series[0]
    comp_renorm = payload_renorm.component_series[0]
    np.testing.assert_allclose(np.asarray(comp_renorm.time, dtype=float), np.asarray(comp_mean.time, dtype=float))
    np.testing.assert_allclose(np.asarray(comp_renorm.center, dtype=float), np.asarray(comp_mean.center, dtype=float))
    np.testing.assert_allclose(np.asarray(comp_renorm.low, dtype=float), np.asarray(comp_mean.low, dtype=float))
    np.testing.assert_allclose(np.asarray(comp_renorm.high, dtype=float), np.asarray(comp_mean.high, dtype=float))
    assert comp_renorm.sample_count == comp_mean.sample_count


def test_expression_ensemble_matrix_supports_renorm_mean_ci95_bootstrap() -> None:
    _, ensemble_ep, _ = _make_endpoints()
    payload = ensemble_ep(
        ExpressionEnsembleRequest(
            expression="tabs{_.0.record.CM}",
            stat_mode="renorm_mean_ci95_bootstrap",
        )
    )
    assert isinstance(payload, ExpressionEnsembleResponse)
    assert payload.expression == "tabs{_.0.record.CM}"
    assert payload.series_kind == "matrix"
    assert payload.n_components == 2
    assert payload.n_trajectories == 2
    assert payload.cached is False
    assert len(payload.component_series) == 2

    comp0 = payload.component_series[0]
    comp1 = payload.component_series[1]
    np.testing.assert_allclose(
        np.asarray(comp0.time, dtype=float),
        np.asarray([0.0, 2.0], dtype=float),
        atol=1e-12,
    )
    np.testing.assert_allclose(
        np.asarray(comp1.time, dtype=float),
        np.asarray([0.0, 2.0], dtype=float),
        atol=1e-12,
    )
    np.testing.assert_allclose(
        np.asarray(comp0.center, dtype=float),
        np.asarray([0.585786437626905, 10.0 / 29.0], dtype=float),
        atol=1e-12,
    )
    np.testing.assert_allclose(
        np.asarray(comp1.center, dtype=float),
        np.asarray([0.41421356237309503, 19.0 / 29.0], dtype=float),
        atol=1e-12,
    )
    assert comp0.sample_count == [2, 2]
    assert comp1.sample_count == [2, 2]
    for idx in range(len(comp0.center)):
        total = float(comp0.center[idx]) + float(comp1.center[idx])
        assert np.isfinite(total)
        assert abs(total - 1.0) < 1e-12
    for low, high in zip(comp0.low, comp0.high):
        assert float(low) <= float(high)
    for low, high in zip(comp1.low, comp1.high):
        assert float(low) <= float(high)

    payload_cached = ensemble_ep(
        ExpressionEnsembleRequest(
            expression="tabs{_.0.record.CM}",
            stat_mode="renorm_mean_ci95_bootstrap",
        )
    )
    assert isinstance(payload_cached, ExpressionEnsembleResponse)
    assert payload_cached.cached is True


def test_expression_ensemble_rejects_cross_trajectory_ops() -> None:
    _, ensemble_ep, _ = _make_endpoints()
    with pytest.raises(HTTPException) as exc_info:
        ensemble_ep(
            ExpressionEnsembleRequest(
                expression="cmean{_.0.record.A}",
                stat_mode="mean_ci95_bootstrap",
            )
        )
    assert exc_info.value.status_code == 422
    assert "Function 'cmean' is not supported" in str(exc_info.value.detail)
