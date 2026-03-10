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
from backend.server.expression import ExpressionEvaluationError, evaluate_expression_payload


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
    # Both trajectories share base_len=3. Frame index 1 is invalid in both trajectories.
    traj0 = _build_traj("0", [0.0, 2.0])
    traj1 = _build_traj("1", [0.0, 2.0])

    raw_records_by_traj = {
        "0": {
            "_.0.record.time": np.asarray([0.0, 1.0, 2.0], dtype=float),
            "_.0.record.Etot": np.asarray([10.0, 20.0, 30.0], dtype=float),
            "_.0.record.A": np.asarray([1.0, 2.0, 3.0], dtype=float),
            "_.0.record.M": np.asarray([[1.0, 10.0], [2.0, 20.0], [3.0, 30.0]], dtype=float),
            "_.0.record.T": np.asarray(
                [
                    [[1.0, 2.0], [3.0, 4.0]],
                    [[5.0, 6.0], [7.0, 8.0]],
                    [[9.0, 10.0], [11.0, 12.0]],
                ],
                dtype=float,
            ),
            "_.0.record.C": np.asarray([1.0 + 1.0j, 2.0 + 0.0j, 3.0 + 4.0j], dtype=np.complex128),
            "_.0.record.CM": np.asarray(
                [
                    [1.0 + 1.0j, 2.0 + 0.0j],
                    [3.0 + 4.0j, 4.0 + 3.0j],
                    [6.0 + 8.0j, 5.0 + 12.0j],
                ],
                dtype=np.complex128,
            ),
            "model.scalar": 2.0,
        },
        "1": {
            "_.0.record.time": np.asarray([0.0, 1.0, 2.0], dtype=float),
            "_.0.record.Etot": np.asarray([40.0, 50.0, 60.0], dtype=float),
            "_.0.record.A": np.asarray([2.0, 4.0, 6.0], dtype=float),
            "_.0.record.M": np.asarray([[2.0, 12.0], [4.0, 24.0], [6.0, 36.0]], dtype=float),
            "_.0.record.T": np.asarray(
                [
                    [[2.0, 4.0], [6.0, 8.0]],
                    [[10.0, 12.0], [14.0, 16.0]],
                    [[18.0, 20.0], [22.0, 24.0]],
                ],
                dtype=float,
            ),
            "_.0.record.C": np.asarray([2.0 + 2.0j, 1.0 + 0.0j, 4.0 + 3.0j], dtype=np.complex128),
            "_.0.record.CM": np.asarray(
                [
                    [2.0 + 2.0j, 1.0 + 0.0j],
                    [1.0 + 1.0j, 2.0 + 2.0j],
                    [8.0 + 6.0j, 7.0 + 24.0j],
                ],
                dtype=np.complex128,
            ),
            "model.scalar": 4.0,
        },
    }

    raw_frame_meta_by_traj = {
        "0": RawFrameMeta(base_len=3, valid_indices=[0, 2]),
        "1": RawFrameMeta(base_len=3, valid_indices=[0, 2]),
    }

    return DatasetStore(
        input_path=Path("/tmp/expression_test.pkl"),
        meta={},
        defaults={},
        trajectories={"0": traj0, "1": traj1},
        raw_records_by_traj=raw_records_by_traj,
        raw_frame_meta_by_traj=raw_frame_meta_by_traj,
        time_key="_.0.record.time",
    )


def _scalar_values(payload: object) -> np.ndarray:
    values = getattr(payload, "value", None)
    assert isinstance(values, list)
    return np.asarray(values, dtype=float)


def test_tadd_supports_signed_and_scientific_literals() -> None:
    store = _build_store()

    out_neg = evaluate_expression_payload(
        store=store,
        expression="tadd{_.0.record.Etot,-5}",
        traj_id="0",
    )
    out_small = evaluate_expression_payload(
        store=store,
        expression="tadd{_.0.record.Etot,1e-3}",
        traj_id="0",
    )
    out_sci = evaluate_expression_payload(
        store=store,
        expression="tadd{_.0.record.Etot,-2.5E+2}",
        traj_id="0",
    )

    assert out_neg.series_kind == "scalar"
    assert out_neg.n_points == 3
    np.testing.assert_allclose(_scalar_values(out_neg), np.asarray([5.0, np.nan, 25.0], dtype=float), equal_nan=True)

    np.testing.assert_allclose(
        _scalar_values(out_small),
        np.asarray([10.001, np.nan, 30.001], dtype=float),
        equal_nan=True,
    )
    np.testing.assert_allclose(
        _scalar_values(out_sci),
        np.asarray([-240.0, np.nan, -220.0], dtype=float),
        equal_nan=True,
    )


def test_dot_key_is_tokenized_as_one_key() -> None:
    store = _build_store()
    out = evaluate_expression_payload(
        store=store,
        expression="tadd{_.0.record.Etot,_.0.record.A}",
        traj_id="0",
    )

    assert out.series_kind == "scalar"
    np.testing.assert_allclose(_scalar_values(out), np.asarray([11.0, np.nan, 33.0], dtype=float), equal_nan=True)


def test_tabs_accepts_complex_input_and_returns_magnitude() -> None:
    store = _build_store()
    out = evaluate_expression_payload(
        store=store,
        expression="tabs{_.0.record.C}",
        traj_id="0",
    )
    assert out.series_kind == "scalar"
    np.testing.assert_allclose(
        _scalar_values(out),
        np.asarray([np.sqrt(2.0), np.nan, 5.0], dtype=float),
        equal_nan=True,
    )


def test_reduce_single_axis_on_matrix_returns_scalar_timed() -> None:
    store = _build_store()
    out = evaluate_expression_payload(
        store=store,
        expression="reduce{_.0.record.M,[-1]}",
        traj_id="0",
    )
    assert out.series_kind == "scalar"
    np.testing.assert_allclose(_scalar_values(out), np.asarray([11.0, np.nan, 33.0], dtype=float), equal_nan=True)


def test_reduce_multi_axes_on_tensor_returns_scalar_timed() -> None:
    store = _build_store()
    out = evaluate_expression_payload(
        store=store,
        expression="reduce{_.0.record.T,[-1,-2]}",
        traj_id="0",
    )
    assert out.series_kind == "scalar"
    np.testing.assert_allclose(_scalar_values(out), np.asarray([10.0, np.nan, 42.0], dtype=float), equal_nan=True)


def test_reduce_negative_and_positive_axes_are_equivalent() -> None:
    store = _build_store()
    out_neg = evaluate_expression_payload(
        store=store,
        expression="reduce{_.0.record.M,[-1]}",
        traj_id="0",
    )
    out_pos = evaluate_expression_payload(
        store=store,
        expression="reduce{_.0.record.M,[1]}",
        traj_id="0",
    )
    np.testing.assert_allclose(_scalar_values(out_neg), _scalar_values(out_pos), equal_nan=True)


def test_reduce_rejects_duplicate_axis() -> None:
    store = _build_store()
    with pytest.raises(ExpressionEvaluationError, match="duplicate axis"):
        evaluate_expression_payload(
            store=store,
            expression="reduce{_.0.record.M,[-1,-1]}",
            traj_id="0",
        )


def test_reduce_rejects_out_of_bounds_axis() -> None:
    store = _build_store()
    with pytest.raises(ExpressionEvaluationError, match="out of bounds"):
        evaluate_expression_payload(
            store=store,
            expression="reduce{_.0.record.M,[99]}",
            traj_id="0",
        )


def test_reduce_rejects_time_axis_for_timed_input() -> None:
    store = _build_store()
    with pytest.raises(ExpressionEvaluationError, match="cannot reduce over time axis 0"):
        evaluate_expression_payload(
            store=store,
            expression="reduce{_.0.record.M,[0]}",
            traj_id="0",
        )


def test_reduce_requires_axes_arg() -> None:
    store = _build_store()
    with pytest.raises(ExpressionEvaluationError, match="Function 'reduce' expects 2 args"):
        evaluate_expression_payload(
            store=store,
            expression="reduce{_.0.record.M}",
            traj_id="0",
        )


def test_reduce_with_tabs_accepts_complex_matrix() -> None:
    store = _build_store()
    out = evaluate_expression_payload(
        store=store,
        expression="reduce{tabs{_.0.record.CM},[-1]}",
        traj_id="0",
    )
    assert out.series_kind == "scalar"
    np.testing.assert_allclose(
        _scalar_values(out),
        np.asarray([np.sqrt(2.0) + 2.0, np.nan, 23.0], dtype=float),
        equal_nan=True,
    )


@pytest.mark.parametrize(
    ("expression", "err_match"),
    [
        ("tadd{_.0.record.C,1}", "does not support complex-valued input"),
        ("reduce{_.0.record.C,[-1]}", "does not support complex-valued input"),
    ],
)
def test_non_tabs_ops_reject_complex_input(expression: str, err_match: str) -> None:
    store = _build_store()
    with pytest.raises(ExpressionEvaluationError, match=err_match):
        evaluate_expression_payload(
            store=store,
            expression=expression,
            traj_id="0",
        )


def test_axis_list_literal_is_only_allowed_for_reduce() -> None:
    store = _build_store()
    with pytest.raises(ExpressionEvaluationError, match="Axis list literal can only be used"):
        evaluate_expression_payload(
            store=store,
            expression="tadd{_.0.record.A,[-1]}",
            traj_id="0",
        )


@pytest.mark.parametrize(
    ("expression", "traj_id"),
    [
        ("tadd{_.0.record.A,1}", "0"),
        ("tminus{_.0.record.A,1}", "0"),
        ("tprod{_.0.record.A,2}", "0"),
        ("tdiv{_.0.record.A,2}", "0"),
        ("tneg{_.0.record.A}", "0"),
        ("tinv{_.0.record.A}", "0"),
        ("tabs{_.0.record.A}", "0"),
        ("reduce{_.0.record.M,[-1]}", "0"),
    ],
)
def test_operator_registry_dispatch_covers_supported_ops(expression: str, traj_id: str) -> None:
    store = _build_store()
    out = evaluate_expression_payload(
        store=store,
        expression=expression,
        traj_id=traj_id,
    )
    assert out.series_kind in ("scalar", "matrix")
    assert out.n_points >= 1


def test_removed_cross_trajectory_functions_are_rejected_with_hint() -> None:
    store = _build_store()
    with pytest.raises(ExpressionEvaluationError, match="Function 'cmean' is not supported"):
        evaluate_expression_payload(
            store=store,
            expression="cmean{_.0.record.A}",
            traj_id="0",
        )
    with pytest.raises(ExpressionEvaluationError, match="Function 'csum' is not supported"):
        evaluate_expression_payload(
            store=store,
            expression="csum{_.0.record.A}",
            traj_id="0",
        )
    with pytest.raises(ExpressionEvaluationError, match="Function 'mean' is not supported"):
        evaluate_expression_payload(
            store=store,
            expression="mean{_.0.record.A}",
            traj_id="0",
        )
    with pytest.raises(ExpressionEvaluationError, match="Function 'sum' is not supported"):
        evaluate_expression_payload(
            store=store,
            expression="sum{_.0.record.A}",
            traj_id="0",
        )
