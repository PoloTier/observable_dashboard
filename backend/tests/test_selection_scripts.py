from __future__ import annotations

import json
from pathlib import Path
import sys

import numpy as np
import pytest

# Keep tests runnable from repository root without requiring editable install.
REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from backend.server.distribution_bundle import (  # noqa: E402
    DISTRIBUTION_BUNDLE_SCHEMA_VERSION,
    HARTREE_TO_EV,
    build_topology_signature,
)
from scripts.filter.select_electronic_window import (  # noqa: E402
    main as select_electronic_window_main,
    run_selection,
)


def _write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"{json.dumps(payload, indent=2, sort_keys=True)}\n", encoding="utf-8")


def _write_npy(path: Path, array: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as handle:
        np.save(handle, np.asarray(array), allow_pickle=False)


def _read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def _write_bundle_dir(tmp_path: Path) -> Path:
    bundle_dir = tmp_path / "bundle"
    atom_numbers = np.asarray([8, 1], dtype=int)
    atom_masses_amu = np.asarray([15.999, 1.008], dtype=float)
    coords_bohr = np.asarray(
        [
            [
                [0.0, 0.0, 0.0],
                [1.80, 0.0, 0.0],
            ],
            [
                [0.0, 0.0, 0.1],
                [1.95, 0.0, 0.0],
            ],
            [
                [0.0, 0.0, 0.2],
                [2.10, 0.0, 0.0],
            ],
        ],
        dtype=float,
    )
    sample_ids = [f"sample_{index:06d}" for index in range(int(coords_bohr.shape[0]))]
    topology_signature = build_topology_signature(atom_numbers)
    transition_pairs = np.asarray([[0, 1], [0, 2]], dtype=int)
    excitation_energy_ev = np.asarray(
        [
            [1.90, 2.10],
            [2.18, 3.30],
            [4.20, 5.10],
        ],
        dtype=float,
    )
    ground_energy = np.asarray([-76.000, -75.985, -75.970], dtype=float)
    state_energy_hartree = np.column_stack(
        [
            ground_energy,
            ground_energy + excitation_energy_ev[:, 0] / float(HARTREE_TO_EV),
            ground_energy + excitation_energy_ev[:, 1] / float(HARTREE_TO_EV),
        ]
    )
    transition_intensity = np.asarray(
        [
            [0.20, 0.60],
            [0.30, 0.10],
            [0.40, 0.50],
        ],
        dtype=float,
    )
    transition_dipole_au = np.zeros((int(coords_bohr.shape[0]), int(transition_pairs.shape[0]), 3), dtype=float)

    manifest = {
        "kind": "normal_modes_sampling",
        "schema_version": DISTRIBUTION_BUNDLE_SCHEMA_VERSION,
        "label": "Selection Script Demo",
        "source_name": "selection_demo.tar.gz",
        "created_at_utc": "2026-03-19T00:00:00.000Z",
        "n_samples": int(coords_bohr.shape[0]),
        "n_atoms": int(coords_bohr.shape[1]),
        "topology_signature": topology_signature,
        "sampling_channels": [
            {"name": "atom_numbers", "unit": None, "group": "sampling"},
            {"name": "atom_masses_amu", "unit": "amu", "group": "sampling"},
            {"name": "coords_bohr", "unit": "bohr", "group": "sampling"},
        ],
        "electronics": {
            "default_profile_id": "td_b3lyp",
            "profiles": [
                {
                    "id": "td_b3lyp",
                    "label": "TDDFT B3LYP/6-31G*",
                    "path": "electronics/td_b3lyp",
                    "engine": "pyscf",
                    "method": "tddft",
                    "reference": "uks",
                    "xc": "b3lyp",
                    "basis": "6-31g*",
                    "n_excited_states": 2,
                    "success_count": int(coords_bohr.shape[0]),
                    "failed_count": 0,
                }
            ],
        },
    }
    profile_manifest = {
        "profile_id": "td_b3lyp",
        "label": "TDDFT B3LYP/6-31G*",
        "engine": "pyscf",
        "method": "tddft",
        "reference": "uks",
        "xc": "b3lyp",
        "basis": "6-31g*",
        "n_excited_states": 2,
        "bundle_label": "Selection Script Demo",
        "topology_signature": topology_signature,
        "n_samples": int(coords_bohr.shape[0]),
        "sample_ids": sample_ids,
        "channels": [
            {"name": "state_energy_hartree", "unit": "Hartree", "group": "electronic"},
            {"name": "transition_pairs", "unit": None, "group": "electronic"},
            {"name": "transition_dipole_au", "unit": "a.u.", "group": "electronic"},
            {"name": "transition_intensity", "unit": "dimensionless", "group": "electronic"},
        ],
        "n_states": int(state_energy_hartree.shape[1]),
        "n_transition": int(transition_pairs.shape[0]),
        "success_count": int(coords_bohr.shape[0]),
        "failed_count": 0,
        "failed_samples": [],
        "assembled_at_utc": "2026-03-19T00:00:10.000Z",
    }

    _write_json(bundle_dir / "manifest.json", manifest)
    _write_json(bundle_dir / "meta" / "sample_ids.json", sample_ids)
    _write_npy(bundle_dir / "sampling" / "atom_numbers.npy", atom_numbers)
    _write_npy(bundle_dir / "sampling" / "atom_masses_amu.npy", atom_masses_amu)
    _write_npy(bundle_dir / "sampling" / "coords_bohr.npy", coords_bohr)
    _write_json(bundle_dir / "electronics" / "td_b3lyp" / "manifest.json", profile_manifest)
    _write_npy(bundle_dir / "electronics" / "td_b3lyp" / "state_energy_hartree.npy", state_energy_hartree)
    _write_npy(bundle_dir / "electronics" / "td_b3lyp" / "transition_pairs.npy", transition_pairs)
    _write_npy(bundle_dir / "electronics" / "td_b3lyp" / "transition_dipole_au.npy", transition_dipole_au)
    _write_npy(bundle_dir / "electronics" / "td_b3lyp" / "transition_intensity.npy", transition_intensity)
    return bundle_dir


def test_select_electronic_window_cli_writes_minimal_selection_sidecar(tmp_path: Path) -> None:
    bundle_dir = _write_bundle_dir(tmp_path)

    exit_code = select_electronic_window_main(
        [
            "--bundle",
            str(bundle_dir),
            "--profile-id",
            "td_b3lyp",
            "--pump-energy-ev",
            "2.0",
            "--bandwidth-ev",
            "0.4",
            "--target-count",
            "3",
            "--selection-id",
            "window_all",
            "--seed",
            "7",
        ]
    )

    manifest = _read_json(bundle_dir / "selection" / "window_all" / "selection_manifest.json")
    records = _read_json(bundle_dir / "selection" / "window_all" / "selected_records.json")
    index = _read_json(bundle_dir / "selection" / "selection_index.json")
    xyz_text = (bundle_dir / "selection" / "window_all" / "selected_geometries.xyz").read_text(encoding="utf-8")

    assert exit_code == 0
    assert manifest["profile_id"] == "td_b3lyp"
    assert manifest["state_filter"] == "all_recorded_states"
    assert manifest["candidate_count"] == 3
    assert manifest["selected_count"] == 3
    assert manifest["unique_geometry_count"] == 2
    assert {(item["original_sample_idx"], item["sampled_state"]) for item in records} == {(0, 1), (0, 2), (1, 1)}
    assert len({item["subset_geometry_index"] for item in records if item["original_sample_idx"] == 0}) == 1
    assert xyz_text.count("subset_geometry_index=") == 2
    assert "created_at_utc=" in xyz_text
    assert "selected_count=3" in xyz_text
    assert "unique_geometry_count=2" in xyz_text
    assert len(index) == 1
    assert index[0]["selection_id"] == "window_all"
    assert index[0]["profile_id"] == "td_b3lyp"


def test_select_electronic_window_requires_profile_id_argument(tmp_path: Path) -> None:
    bundle_dir = _write_bundle_dir(tmp_path)

    with pytest.raises(SystemExit) as exc_info:
        select_electronic_window_main(
            [
                "--bundle",
                str(bundle_dir),
                "--pump-energy-ev",
                "2.0",
                "--bandwidth-ev",
                "0.4",
                "--target-count",
                "1",
            ]
        )

    assert exc_info.value.code == 2


def test_select_electronic_window_rejects_unknown_profile_id(tmp_path: Path) -> None:
    bundle_dir = _write_bundle_dir(tmp_path)

    with pytest.raises(ValueError, match="was not found"):
        run_selection(
            bundle_dir=bundle_dir,
            profile_id="missing_profile",
            pump_energy_ev=2.0,
            bandwidth_ev=0.4,
            target_count=1,
        )


def test_select_electronic_window_filters_explicit_states(tmp_path: Path) -> None:
    bundle_dir = _write_bundle_dir(tmp_path)

    run_selection(
        bundle_dir=bundle_dir,
        profile_id="td_b3lyp",
        pump_energy_ev=2.0,
        bandwidth_ev=0.4,
        target_count=1,
        states=["2"],
        selection_id="state2_only",
        seed=5,
    )

    manifest = _read_json(bundle_dir / "selection" / "state2_only" / "selection_manifest.json")
    records = _read_json(bundle_dir / "selection" / "state2_only" / "selected_records.json")

    assert manifest["state_filter"] == [2]
    assert manifest["candidate_count"] == 1
    assert [item["sampled_state"] for item in records] == [2]
    assert [item["original_sample_idx"] for item in records] == [0]


def test_select_electronic_window_is_deterministic_for_fixed_seed(tmp_path: Path) -> None:
    bundle_dir = _write_bundle_dir(tmp_path)

    run_selection(
        bundle_dir=bundle_dir,
        profile_id="td_b3lyp",
        pump_energy_ev=2.6,
        bandwidth_ev=2.2,
        target_count=2,
        selection_id="seed_a",
        seed=11,
    )
    run_selection(
        bundle_dir=bundle_dir,
        profile_id="td_b3lyp",
        pump_energy_ev=2.6,
        bandwidth_ev=2.2,
        target_count=2,
        selection_id="seed_b",
        seed=11,
    )

    records_a = _read_json(bundle_dir / "selection" / "seed_a" / "selected_records.json")
    records_b = _read_json(bundle_dir / "selection" / "seed_b" / "selected_records.json")

    assert records_a == records_b


def test_select_electronic_window_rejects_empty_candidate_window(tmp_path: Path) -> None:
    bundle_dir = _write_bundle_dir(tmp_path)

    with pytest.raises(ValueError, match="No geometry-state candidates remain"):
        run_selection(
            bundle_dir=bundle_dir,
            profile_id="td_b3lyp",
            pump_energy_ev=8.0,
            bandwidth_ev=0.2,
            target_count=1,
        )


def test_select_electronic_window_rejects_target_count_above_candidate_count(tmp_path: Path) -> None:
    bundle_dir = _write_bundle_dir(tmp_path)

    with pytest.raises(ValueError, match="exceeds the filtered candidate count 3"):
        run_selection(
            bundle_dir=bundle_dir,
            profile_id="td_b3lyp",
            pump_energy_ev=2.0,
            bandwidth_ev=0.4,
            target_count=4,
        )


def test_select_electronic_window_updates_selection_index_and_force_replaces(tmp_path: Path) -> None:
    bundle_dir = _write_bundle_dir(tmp_path)

    run_selection(
        bundle_dir=bundle_dir,
        profile_id="td_b3lyp",
        pump_energy_ev=2.0,
        bandwidth_ev=0.4,
        target_count=1,
        selection_id="sel_a",
        seed=3,
    )
    run_selection(
        bundle_dir=bundle_dir,
        profile_id="td_b3lyp",
        pump_energy_ev=2.6,
        bandwidth_ev=2.2,
        target_count=1,
        selection_id="sel_b",
        seed=3,
    )

    index_before = _read_json(bundle_dir / "selection" / "selection_index.json")
    assert [item["selection_id"] for item in index_before] == ["sel_a", "sel_b"]

    run_selection(
        bundle_dir=bundle_dir,
        profile_id="td_b3lyp",
        pump_energy_ev=2.0,
        bandwidth_ev=0.4,
        target_count=1,
        states=["2"],
        selection_id="sel_a",
        seed=3,
        force=True,
    )

    index_after = _read_json(bundle_dir / "selection" / "selection_index.json")
    manifest_after = _read_json(bundle_dir / "selection" / "sel_a" / "selection_manifest.json")

    assert len(index_after) == 2
    assert [item["selection_id"] for item in index_after] == ["sel_a", "sel_b"]
    assert manifest_after["state_filter"] == [2]
