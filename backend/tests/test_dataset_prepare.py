from __future__ import annotations

from pathlib import Path
import sys

import numpy as np

# Keep tests runnable from repository root without requiring editable install.
REPO_ROOT = Path(__file__).resolve().parents[3]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from backend.dataset import BOHR_TO_ANGSTROM, prepare_dataset


def _prepare(master_dataset: dict[str, object], drop_zero_frames: bool = True) -> dict[str, object]:
    return prepare_dataset(
        master_dataset=master_dataset,
        time_key="_.0.record.time",
        coord_key="_.0.record.x",
        etot_key="_.0.record.Etot",
        eig_key="_.0.record.eig",
        nac_key="_.0.record.nac",
        drop_zero_frames=drop_zero_frames,
    )


def test_basic_success_path_with_all_fields() -> None:
    master_dataset = {
        "0": {
            "_.0.record.time": np.array([0.0, 0.5, 1.0]),
            "_.0.record.x": np.array(
                [
                    [0, 0, 0, 1, 0, 0],
                    [0, 0, 0, 0, 0, 0],
                    [0, 0, 0, 2, 0, 0],
                ],
                dtype=float,
            ),
            "_.0.record.Etot": np.array([10.0, 10.5, 11.0]),
            "_.0.record.eig": np.array(
                [
                    [0.1, 0.2, 0.3],
                    [0.2, 0.3, 0.4],
                    [0.3, 0.5, 0.7],
                ],
                dtype=float,
            ),
            "_.0.record.nac": np.array(
                [
                    [
                        [[0.0, 1.0], [2.0, 0.0]],
                        [[0.0, 0.5], [0.5, 0.0]],
                        [[0.0, 0.0], [0.0, 0.0]],
                        [[0.0, 0.2], [0.2, 0.0]],
                        [[0.0, 0.0], [0.0, 0.0]],
                        [[0.0, 0.0], [0.0, 0.0]],
                    ],
                    [
                        [[0.0, 2.0], [1.0, 0.0]],
                        [[0.0, 0.0], [0.0, 0.0]],
                        [[0.0, 0.0], [0.0, 0.0]],
                        [[0.0, 1.0], [0.0, 0.0]],
                        [[0.0, 0.0], [0.0, 0.0]],
                        [[0.0, 0.0], [0.0, 0.0]],
                    ],
                    [
                        [[0.0, 3.0], [0.1, 0.0]],
                        [[0.0, 4.0], [0.0, 0.0]],
                        [[0.0, 0.0], [0.0, 0.0]],
                        [[0.0, 0.0], [0.0, 0.0]],
                        [[0.0, 0.0], [0.0, 0.0]],
                        [[0.0, 0.0], [0.0, 0.0]],
                    ],
                ],
                dtype=float,
            ),
            "_.0.record.c": np.array(
                [
                    [1 + 0j, 0 + 0j, 0 + 0j],
                    [0.1 + 0j, 0.9 + 0j, 0 + 0j],
                    [0.1 + 0j, 0.2 + 0j, 0.7 + 0j],
                ],
                dtype=np.complex128,
            ),
            "model.atoms": np.array([1, 8]),
        }
    }

    out = _prepare(master_dataset, drop_zero_frames=True)
    rec = out["trajectories"]["0"]

    expected_keys = {
        "time",
        "coords",
        "n_atoms",
        "atom_numbers",
        "etot_time",
        "etot",
        "eig_time",
        "eig",
        "nac_components",
        "nac_component_count",
        "nac_state_count",
        "nac_time",
        "nac_norm",
        "de_nac_time",
        "de_nac_components",
        "de_nac_component_count",
        "de_nac_state_count",
        "de_nac_norm",
        "c_prob_time",
        "c_prob",
        "state_time",
        "state",
    }
    assert expected_keys.issubset(set(rec.keys()))

    np.testing.assert_allclose(np.asarray(rec["time"], dtype=float), np.array([0.0, 1.0]))
    np.testing.assert_allclose(
        np.asarray(rec["coords"], dtype=float)[:, 1, 0],
        np.array([1.0, 2.0]) * BOHR_TO_ANGSTROM,
    )
    np.testing.assert_allclose(np.asarray(rec["etot"], dtype=float), np.array([0.0, 1.0]))
    np.testing.assert_array_equal(np.asarray(rec["state"], dtype=int), np.array([0, 2]))
    np.testing.assert_allclose(
        np.asarray(rec["nac_norm"], dtype=float),
        np.array([1.1357816691600546, 5.0]),
    )
    np.testing.assert_allclose(
        np.asarray(rec["de_nac_norm"], dtype=float),
        np.array([0.11357816691600547, 1.0]),
    )


def test_drop_zero_frames_on_and_off() -> None:
    master_dataset = {
        "0": {
            "_.0.record.time": np.array([0.0, 1.0, 2.0]),
            "_.0.record.x": np.array(
                [
                    [0, 0, 0, 1, 0, 0],
                    [0, 0, 0, 0, 0, 0],
                    [0, 0, 0, 3, 0, 0],
                ],
                dtype=float,
            ),
        }
    }

    out_drop = _prepare(master_dataset, drop_zero_frames=True)
    out_keep = _prepare(master_dataset, drop_zero_frames=False)

    np.testing.assert_allclose(np.asarray(out_drop["trajectories"]["0"]["time"], dtype=float), np.array([0.0, 2.0]))
    np.testing.assert_allclose(np.asarray(out_keep["trajectories"]["0"]["time"], dtype=float), np.array([0.0, 1.0, 2.0]))


def test_missing_time_or_coords_skips_trajectory() -> None:
    master_dataset = {
        "0": {
            "_.0.record.time": np.array([0.0, 1.0]),
        }
    }

    out = _prepare(master_dataset, drop_zero_frames=True)
    assert out["meta"]["traj_ids"] == []
    assert out["trajectories"] == {}


def test_etot_empty_and_etot_reference_zero() -> None:
    master_dataset = {
        "0": {
            "_.0.record.time": np.array([0.0, 1.0, 2.0]),
            "_.0.record.x": np.array(
                [
                    [0, 0, 0, 1, 0, 0],
                    [0, 0, 0, 2, 0, 0],
                    [0, 0, 0, 3, 0, 0],
                ],
                dtype=float,
            ),
            "_.0.record.Etot": np.array([]),
        },
        "1": {
            "_.0.record.time": np.array([0.0, 1.0]),
            "_.0.record.x": np.array(
                [
                    [0, 0, 0, 1, 0, 0],
                    [0, 0, 0, 2, 0, 0],
                ],
                dtype=float,
            ),
            "_.0.record.Etot": np.array([5.0, 7.0]),
        },
    }

    out = _prepare(master_dataset, drop_zero_frames=True)
    rec0 = out["trajectories"]["0"]
    rec1 = out["trajectories"]["1"]

    assert "etot" not in rec0
    assert "etot_time" not in rec0
    np.testing.assert_allclose(np.asarray(rec1["etot"], dtype=float), np.array([0.0, 2.0]))
    assert float(rec1["etot"][0]) == 0.0


def test_state_and_c_prob_semantics() -> None:
    coeff = np.array(
        [
            [1 + 0j, 0 + 0j],
            [1 + 0j, 1 + 0j],
            [0.1 + 0j, 0.9 + 0j],
        ],
        dtype=np.complex128,
    )
    master_dataset = {
        "0": {
            "_.0.record.time": np.array([0.0, 1.0, 2.0]),
            "_.0.record.x": np.array(
                [
                    [0, 0, 0, 1, 0, 0],
                    [0, 0, 0, 2, 0, 0],
                    [0, 0, 0, 3, 0, 0],
                ],
                dtype=float,
            ),
            "_.0.record.c": coeff,
        }
    }

    out = _prepare(master_dataset, drop_zero_frames=True)
    rec = out["trajectories"]["0"]
    prob_expected = np.abs(coeff) ** 2
    state_expected = np.argmax(prob_expected, axis=1)

    np.testing.assert_allclose(np.asarray(rec["c_prob"], dtype=float), prob_expected)
    np.testing.assert_array_equal(np.asarray(rec["state"], dtype=int), state_expected)


def test_eig_nac_mismatch_uses_common_frames_and_states_for_de_nac() -> None:
    master_dataset = {
        "2": {
            "_.0.record.time": np.array([0.0, 1.0, 2.0, 3.0]),
            "_.0.record.x": np.array(
                [
                    [0, 0, 0, 1, 0, 0],
                    [0, 0, 0, 1, 1, 0],
                    [0, 0, 0, 1, 2, 0],
                    [0, 0, 0, 1, 3, 0],
                ],
                dtype=float,
            ),
            "_.0.record.eig": np.array(
                [
                    [0.0, 1.0],
                    [0.0, 2.0],
                ],
                dtype=float,
            ),
            "_.0.record.nac": np.array(
                [
                    [[[0, 1], [1, 0]], [[0, 0], [0, 0]], [[0, 0], [0, 0]], [[0, 0], [0, 0]], [[0, 0], [0, 0]], [[0, 0], [0, 0]]],
                    [[[0, 2], [2, 0]], [[0, 0], [0, 0]], [[0, 0], [0, 0]], [[0, 0], [0, 0]], [[0, 0], [0, 0]], [[0, 0], [0, 0]]],
                    [[[0, 3], [3, 0]], [[0, 0], [0, 0]], [[0, 0], [0, 0]], [[0, 0], [0, 0]], [[0, 0], [0, 0]], [[0, 0], [0, 0]]],
                ],
                dtype=float,
            ),
        }
    }

    out = _prepare(master_dataset, drop_zero_frames=True)
    rec = out["trajectories"]["2"]

    np.testing.assert_allclose(np.asarray(rec["de_nac_time"], dtype=float), np.array([0.0, 1.0]))
    assert int(rec["de_nac_state_count"]) == 2
    assert int(rec["de_nac_component_count"]) == 6
    np.testing.assert_allclose(np.asarray(rec["de_nac_norm"], dtype=float), np.array([1.0, 4.0]))


def test_model_atoms_fallback_and_replacement() -> None:
    master_dataset = {
        "0": {
            "_.0.record.time": np.array([0.0]),
            "_.0.record.x": np.array([[0, 0, 0, 1, 0, 0]], dtype=float),
        },
        "1": {
            "_.0.record.time": np.array([0.0]),
            "_.0.record.x": np.array([[0, 0, 0, 1, 0, 0]], dtype=float),
            "model.atoms": np.array([1], dtype=int),
        },
        "2": {
            "_.0.record.time": np.array([0.0]),
            "_.0.record.x": np.array([[0, 0, 0, 1, 0, 0]], dtype=float),
            "model.atoms": np.array([8, -1, 6], dtype=int),
        },
    }

    out = _prepare(master_dataset, drop_zero_frames=True)
    np.testing.assert_array_equal(np.asarray(out["trajectories"]["0"]["atom_numbers"], dtype=int), np.array([6, 6]))
    np.testing.assert_array_equal(np.asarray(out["trajectories"]["1"]["atom_numbers"], dtype=int), np.array([6, 6]))
    np.testing.assert_array_equal(np.asarray(out["trajectories"]["2"]["atom_numbers"], dtype=int), np.array([8, 6]))


def test_meta_aggregation_tracks_maxima() -> None:
    master_dataset = {
        "0": {
            "_.0.record.time": np.array([0.0, 1.0]),
            "_.0.record.x": np.array(
                [
                    [0, 0, 0, 1, 0, 0],
                    [0, 0, 0, 2, 0, 0],
                ],
                dtype=float,
            ),
            "_.0.record.eig": np.array([[0.1, 0.2], [0.2, 0.3]], dtype=float),
            "_.0.record.c": np.array([[1 + 0j, 0 + 0j], [0 + 0j, 1 + 0j]], dtype=np.complex128),
        },
        "1": {
            "_.0.record.time": np.array([0.0]),
            "_.0.record.x": np.array([[0, 0, 0, 1, 0, 0, 0, 1, 0]], dtype=float),
            "_.0.record.eig": np.array([[0.0, 0.1, 0.2, 0.3]], dtype=float),
            "_.0.record.c": np.array([[0.2 + 0j, 0.3 + 0j, 0.5 + 0j]], dtype=np.complex128),
        },
    }

    out = _prepare(master_dataset, drop_zero_frames=True)
    meta = out["meta"]

    assert int(meta["n_atoms"]) == 3
    assert int(meta["n_states"]) == 4
    assert int(meta["state_component_count"]) == 3


def test_compatibility_regression_snapshot_for_reference_fixture() -> None:
    master_dataset = {
        "0": {
            "_.0.record.time": np.array([0.0, 0.5, 1.0]),
            "_.0.record.x": np.array(
                [
                    [0, 0, 0, 1, 0, 0],
                    [0, 0, 0, 0, 0, 0],
                    [0, 0, 0, 2, 0, 0],
                ],
                dtype=float,
            ),
            "_.0.record.Etot": np.array([10.0, 10.5, 11.0]),
            "_.0.record.eig": np.array(
                [
                    [0.1, 0.2, 0.3],
                    [0.2, 0.3, 0.4],
                    [0.3, 0.5, 0.7],
                ],
                dtype=float,
            ),
            "_.0.record.nac": np.array(
                [
                    [
                        [[0.0, 1.0], [2.0, 0.0]],
                        [[0.0, 0.5], [0.5, 0.0]],
                        [[0.0, 0.0], [0.0, 0.0]],
                        [[0.0, 0.2], [0.2, 0.0]],
                        [[0.0, 0.0], [0.0, 0.0]],
                        [[0.0, 0.0], [0.0, 0.0]],
                    ],
                    [
                        [[0.0, 2.0], [1.0, 0.0]],
                        [[0.0, 0.0], [0.0, 0.0]],
                        [[0.0, 0.0], [0.0, 0.0]],
                        [[0.0, 1.0], [0.0, 0.0]],
                        [[0.0, 0.0], [0.0, 0.0]],
                        [[0.0, 0.0], [0.0, 0.0]],
                    ],
                    [
                        [[0.0, 3.0], [0.1, 0.0]],
                        [[0.0, 4.0], [0.0, 0.0]],
                        [[0.0, 0.0], [0.0, 0.0]],
                        [[0.0, 0.0], [0.0, 0.0]],
                        [[0.0, 0.0], [0.0, 0.0]],
                        [[0.0, 0.0], [0.0, 0.0]],
                    ],
                ],
                dtype=float,
            ),
            "_.0.record.c": np.array(
                [
                    [1 + 0j, 0 + 0j, 0 + 0j],
                    [0.1 + 0j, 0.9 + 0j, 0 + 0j],
                    [0.1 + 0j, 0.2 + 0j, 0.7 + 0j],
                ],
                dtype=np.complex128,
            ),
            "model.atoms": np.array([1, 8]),
        },
        "1": {
            "_.0.record.time": np.array([0.0]),
            "_.0.record.x": np.array([[0, 0, 0, 0, 0, 0]], dtype=float),
        },
    }

    out = _prepare(master_dataset, drop_zero_frames=True)
    meta = out["meta"]
    rec = out["trajectories"]["0"]

    assert meta["traj_ids"] == ["0"]
    assert int(meta["n_atoms"]) == 2
    assert int(meta["n_states"]) == 3
    assert int(meta["state_component_count"]) == 3
    assert meta["etot_reference"] == "raw_frame0"
    assert meta["state_definition"] == "argmax(|c|^2)"
    assert meta["state_source_key"] == "_.0.record.c"
    assert int(meta["state_index_base"]) == 0

    np.testing.assert_allclose(np.asarray(rec["time"], dtype=float), np.array([0.0, 1.0]))
    np.testing.assert_allclose(np.asarray(rec["etot"], dtype=float), np.array([0.0, 1.0]))
    np.testing.assert_allclose(np.asarray(rec["eig_time"], dtype=float), np.array([0.0, 1.0]))
    np.testing.assert_array_equal(np.asarray(rec["state"], dtype=int), np.array([0, 2]))
    np.testing.assert_allclose(np.asarray(rec["nac_norm"], dtype=float), np.array([1.1357816691600546, 5.0]))
    np.testing.assert_allclose(np.asarray(rec["de_nac_norm"], dtype=float), np.array([0.11357816691600547, 1.0]))
    assert int(rec["nac_state_count"]) == 2
    assert int(rec["nac_component_count"]) == 6
    assert int(rec["de_nac_state_count"]) == 2
    assert int(rec["de_nac_component_count"]) == 6
