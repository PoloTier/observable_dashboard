from __future__ import annotations

import json
from pathlib import Path
import sys

import numpy as np

# Keep tests runnable from repository root without requiring editable install.
REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from backend.server.distribution_bundle import DISTRIBUTION_BUNDLE_SCHEMA_VERSION, build_topology_signature
from scripts.basic.units import ANGSTROM_TO_BOHR, EV_TO_HARTREE
from scripts.hessian.compute_mace_hessians import compute_mace_hessians


def _write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"{json.dumps(payload, indent=2, sort_keys=True)}\n", encoding="utf-8")


def _write_npy(path: Path, array: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as handle:
        np.save(handle, np.asarray(array), allow_pickle=False)


def _read_json(path: Path) -> dict | list:
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
                [0.0, 0.1, 0.0],
                [1.95, 0.0, 0.0],
            ],
            [
                [0.0, 0.2, 0.0],
                [2.10, 0.0, 0.0],
            ],
        ],
        dtype=float,
    )
    sample_ids = [f"sample_{index:06d}" for index in range(int(coords_bohr.shape[0]))]

    manifest = {
        "kind": "normal_modes_sampling",
        "schema_version": DISTRIBUTION_BUNDLE_SCHEMA_VERSION,
        "label": "Hessian Script Demo",
        "batch_id": "hessian-demo",
        "source_name": "demo_bundle",
        "created_at_utc": "2026-03-25T00:00:00.000Z",
        "sampling_method": "normal_modes_harmonic",
        "n_samples": int(coords_bohr.shape[0]),
        "n_atoms": int(coords_bohr.shape[1]),
        "topology_signature": build_topology_signature(atom_numbers),
        "sampling_channels": [
            {"name": "atom_numbers", "unit": None, "group": "sampling"},
            {"name": "atom_masses_amu", "unit": "amu", "group": "sampling"},
            {"name": "coords_bohr", "unit": "bohr", "group": "sampling"},
        ],
        "electronics": {
            "default_profile_id": None,
            "profiles": [],
        },
        "charge": 0,
        "multiplicity": 1,
    }

    _write_json(bundle_dir / "manifest.json", manifest)
    _write_json(bundle_dir / "meta" / "sample_ids.json", sample_ids)
    _write_npy(bundle_dir / "sampling" / "atom_numbers.npy", atom_numbers)
    _write_npy(bundle_dir / "sampling" / "atom_masses_amu.npy", atom_masses_amu)
    _write_npy(bundle_dir / "sampling" / "coords_bohr.npy", coords_bohr)

    selection_manifest = {
        "selection_id": "sel_demo",
        "profile_id": "td_demo",
        "created_at_utc": "2026-03-25T00:01:00.000Z",
        "selected_count": 3,
        "unique_geometry_count": 2,
    }
    selected_records = [
        {
            "selection_rank": 0,
            "original_sample_id": "sample_000000",
            "original_sample_idx": 0,
            "sampled_state": 1,
            "excitation_energy_ev": 2.1,
            "subset_geometry_index": 0,
        },
        {
            "selection_rank": 1,
            "original_sample_id": "sample_000000",
            "original_sample_idx": 0,
            "sampled_state": 2,
            "excitation_energy_ev": 2.9,
            "subset_geometry_index": 0,
        },
        {
            "selection_rank": 2,
            "original_sample_id": "sample_000002",
            "original_sample_idx": 2,
            "sampled_state": 1,
            "excitation_energy_ev": 3.3,
            "subset_geometry_index": 1,
        },
    ]
    _write_json(bundle_dir / "selection" / "sel_demo" / "selection_manifest.json", selection_manifest)
    _write_json(bundle_dir / "selection" / "sel_demo" / "selected_records.json", selected_records)
    return bundle_dir


class _FakeMACECalculator:
    def __init__(
        self,
        *,
        model_paths: str,
        device: str,
        default_dtype: str,
        energy_units_to_eV: float,
        length_units_to_A: float,
        **kwargs,
    ) -> None:
        self.model_paths = model_paths
        self.device = device
        self.default_dtype = default_dtype
        self.energy_units_to_eV = energy_units_to_eV
        self.length_units_to_A = length_units_to_A
        self.head = kwargs.get("head")
        self.num_models = 1

    def get_hessian(self, atoms) -> np.ndarray:
        atom_count = len(atoms)
        cart_dim = int(atom_count) * 3
        diagonal = np.arange(1, cart_dim + 1, dtype=float)
        matrix = np.diag(diagonal)
        return matrix.reshape(cart_dim, atom_count, 3)


def test_compute_mace_hessians_writes_workspace_for_full_bundle(tmp_path: Path) -> None:
    bundle_dir = _write_bundle_dir(tmp_path)

    result = compute_mace_hessians(
        bundle_path=bundle_dir,
        model_path="fake.model",
        profile_id="mace_demo",
        device="cpu",
        default_dtype="float64",
        energy_units_to_ev=2.0,
        length_units_to_a=0.5,
        calculator_factory=_FakeMACECalculator,
    )

    workspace_dir = bundle_dir / "hessian_workspaces" / "mace_demo"
    manifest = _read_json(workspace_dir / "manifest.json")
    target_index = _read_json(workspace_dir / "target_index.json")
    sample_dir = workspace_dir / "samples" / "sample_000000__sample_000000"
    sample_meta = _read_json(sample_dir / "target_meta.json")
    hessian_native = np.load(sample_dir / "hessian_cartesian_model_units.npy")
    hessian_ev_per_ang2 = np.load(sample_dir / "hessian_cartesian_ev_per_ang2.npy")
    hessian_hartree_per_bohr2 = np.load(sample_dir / "hessian_cartesian_hartree_per_bohr2.npy")

    assert result.workspace_dir == workspace_dir.resolve()
    assert result.target_count == 3
    assert result.success_count == 3
    assert result.failed_count == 0
    assert manifest["profile_id"] == "mace_demo"
    assert manifest["selection_id"] is None
    assert manifest["success_count"] == 3
    assert len(target_index) == 3
    assert target_index[0]["status"] == "ok"
    assert target_index[0]["source_kind"] == "bundle_sample"
    assert sample_meta["status"] == "ok"
    assert sample_meta["sample_idx"] == 0
    assert hessian_native.shape == (6, 6)
    assert np.allclose(hessian_native, np.diag(np.arange(1, 7, dtype=float)))
    assert np.allclose(hessian_native, hessian_native.T)
    assert np.allclose(hessian_ev_per_ang2, hessian_native * 8.0)
    expected_factor = 8.0 * EV_TO_HARTREE / (ANGSTROM_TO_BOHR**2)
    assert np.allclose(hessian_hartree_per_bohr2, hessian_native * expected_factor)
    assert "output_id=sample_000000__sample_000000" in (workspace_dir / "all_structures.xyz").read_text(
        encoding="utf-8"
    )


def test_compute_mace_hessians_uses_unique_selection_geometries_and_subset_filter(tmp_path: Path) -> None:
    bundle_dir = _write_bundle_dir(tmp_path)

    result = compute_mace_hessians(
        bundle_path=bundle_dir,
        model_path="fake.model",
        selection_id="sel_demo",
        subset_geometry_indices=[1],
        profile_id="mace_sel_demo",
        calculator_factory=_FakeMACECalculator,
    )

    workspace_dir = bundle_dir / "hessian_workspaces" / "mace_sel_demo"
    manifest = _read_json(workspace_dir / "manifest.json")
    target_index = _read_json(workspace_dir / "target_index.json")
    sample_dirs = sorted((workspace_dir / "samples").iterdir())

    assert result.target_count == 1
    assert result.success_count == 1
    assert result.failed_count == 0
    assert manifest["selection_id"] == "sel_demo"
    assert manifest["success_count"] == 1
    assert len(target_index) == 1
    assert target_index[0]["selection_id"] == "sel_demo"
    assert target_index[0]["subset_geometry_index"] == 1
    assert target_index[0]["sample_idx"] == 2
    assert len(sample_dirs) == 1
    assert sample_dirs[0].name == "geom_000001__sample_000002__sample_000002"
    sample_meta = _read_json(sample_dirs[0] / "target_meta.json")
    assert sample_meta["selection_id"] == "sel_demo"
    assert sample_meta["subset_geometry_index"] == 1
