from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import textwrap

import numpy as np
import pytest

# Keep tests runnable from repository root without requiring editable install.
REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from backend.server.distribution_bundle import build_topology_signature
from scripts.electronic_structure.assemble_distribution_bundle import (
    assemble_distribution_bundle,
    assemble_distribution_workspaces,
    main as assemble_distribution_bundle_main,
)
from scripts.electronic_structure.common import load_geometry_bundle
from scripts.electronic_structure.prepare_pyscf_jobs import prepare_workspace
from scripts.electronic_structure.run_workspace_batch import main as run_workspace_batch_main


def _write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"{json.dumps(payload, indent=2, sort_keys=True)}\n", encoding="utf-8")


def _write_npy(path: Path, array: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as handle:
        np.save(handle, np.asarray(array), allow_pickle=False)


def _geometry_sha1(atom_numbers: np.ndarray, coords_bohr_sample: np.ndarray) -> str:
    atom_bytes = np.asarray(atom_numbers, dtype=np.int32).reshape(-1).tobytes(order="C")
    coords_bytes = np.asarray(coords_bohr_sample, dtype=np.float64).reshape(-1).tobytes(order="C")
    import hashlib

    return hashlib.sha1(atom_bytes + coords_bytes).hexdigest()  # noqa: S324


def _write_geometry_bundle_dir(tmp_path: Path) -> Path:
    bundle_path = tmp_path / "normal_modes_geometry_dir"
    atom_numbers = np.asarray([8, 1, 1], dtype=int)
    atom_masses_amu = np.asarray([15.999, 1.008, 1.008], dtype=float)
    coords_bohr = np.asarray(
        [
            [
                [0.0, 0.0, 0.0],
                [1.8, 0.0, 0.0],
                [-0.5, 1.7, 0.0],
            ],
            [
                [0.0, 0.0, 0.1],
                [1.75, 0.0, 0.0],
                [-0.45, 1.68, 0.0],
            ],
        ],
        dtype=float,
    )
    velocities = np.asarray(
        [
            [
                [0.00, 0.01, 0.02],
                [0.03, 0.04, 0.05],
                [0.06, 0.07, 0.08],
            ],
            [
                [0.09, 0.10, 0.11],
                [0.12, 0.13, 0.14],
                [0.15, 0.16, 0.17],
            ],
        ],
        dtype=float,
    )
    sample_ids = ["nm-sample-demo_sample_000000", "nm-sample-demo_sample_000001"]
    all_structures_xyz = "\n".join(
        [
            "3",
            f"batch_id=nm-sample-demo sample_idx=0 sample_id={sample_ids[0]}",
            "O 0.00000000 0.00000000 0.00000000",
            "H 0.95251673 0.00000000 0.00000000",
            "H -0.26458800 0.89959802 0.00000000",
            "3",
            f"batch_id=nm-sample-demo sample_idx=1 sample_id={sample_ids[1]}",
            "O 0.00000000 0.00000000 0.05291772",
            "H 0.92605815 0.00000000 0.00000000",
            "H -0.23812942 0.88901448 0.00000000",
        ]
    ) + "\n"

    manifest = {
        "kind": "normal_modes_sampling",
        "schema_version": 4,
        "label": "toy.molden normal modes samples",
        "batch_id": "nm-sample-demo",
        "source_name": "toy.molden",
        "created_at_utc": "2026-03-14T00:00:02.000Z",
        "sampling_method": "normal_modes_harmonic",
        "n_samples": 2,
        "n_atoms": 3,
        "topology_signature": build_topology_signature(atom_numbers),
        "sampling_channels": [
            {"name": "atom_numbers", "unit": None, "group": "sampling"},
            {"name": "atom_masses_amu", "unit": "amu", "group": "sampling"},
            {"name": "coords_bohr", "unit": "bohr", "group": "sampling"},
            {"name": "velocities_bohr_per_au_time", "unit": "bohr/au_time", "group": "sampling"},
        ],
        "electronics": {
            "default_profile_id": None,
            "profiles": [],
        },
        "charge": -1,
        "multiplicity": 2,
        "seed": 29,
    }

    _write_json(bundle_path / "manifest.json", manifest)
    _write_json(bundle_path / "meta" / "sample_ids.json", sample_ids)
    _write_npy(bundle_path / "sampling" / "atom_numbers.npy", atom_numbers)
    _write_npy(bundle_path / "sampling" / "atom_masses_amu.npy", atom_masses_amu)
    _write_npy(bundle_path / "sampling" / "coords_bohr.npy", coords_bohr)
    _write_npy(bundle_path / "sampling" / "velocities_bohr_per_au_time.npy", velocities)
    (bundle_path / "sampling").mkdir(parents=True, exist_ok=True)
    (bundle_path / "sampling" / "all_structures.xyz").write_text(all_structures_xyz, encoding="utf-8")
    return bundle_path


def _write_result_json(
    workspace_dir: Path,
    *,
    sample_id: str,
    sample_idx: int,
    geom_sha1: str,
    shift: float = 0.0,
    transition_pairs: list[list[int]] | None = None,
    status: str = "ok",
    error_message: str | None = None,
    scf_converged: bool = True,
    td_converged: bool = True,
    reference: str = "uks",
    xc: str = "b3lyp",
    basis: str = "6-31g*",
    n_excited_states: int = 2,
) -> None:
    payload = {
        "sample_id": sample_id,
        "sample_idx": sample_idx,
        "geom_sha1": geom_sha1,
        "engine": "pyscf",
        "method": "tddft",
        "reference": reference,
        "xc": xc,
        "basis": basis,
        "n_excited_states": n_excited_states,
        "status": status,
        "started_at_utc": "2026-03-15T00:00:00.000Z",
        "finished_at_utc": "2026-03-15T00:00:01.000Z",
        "scf_converged": bool(scf_converged),
        "td_converged": bool(td_converged),
    }
    if status == "ok":
        payload.update(
            {
                "state_energy_hartree": [-76.1 + shift, -75.9 + shift, -75.6 + shift],
                "transition_pairs": transition_pairs if transition_pairs is not None else [[0, 1], [0, 2]],
                "transition_dipole_au": [[0.1 + shift, 0.0, 0.2], [0.3, 0.1 + shift, 0.0]],
                "transition_intensity": [0.02 + shift, 0.15 + shift],
            }
        )
    else:
        payload["error_message"] = error_message or "TDDFT did not converge"
        payload["traceback"] = "Traceback placeholder"
    result_path = workspace_dir / "jobs" / sample_id / "result.json"
    result_path.write_text(f"{json.dumps(payload, indent=2, sort_keys=True)}\n", encoding="utf-8")


def _install_fake_job_script(
    job_dir: Path,
    *,
    status: str | None,
    exit_code: int,
    capture_env_names: tuple[str, ...] = (),
) -> None:
    payload_text: str | None = None
    if status is not None:
        payload = {"status": str(status)}
        if str(status).strip().lower() != "ok":
            payload["error_message"] = "mock failure"
        payload_text = json.dumps(payload, indent=2, sort_keys=True)

    script_lines = [
        "#!/usr/bin/env python3",
        "from __future__ import annotations",
        "",
        "from pathlib import Path",
        "import json",
        "import os",
        "",
        "job_dir = Path(__file__).resolve().parent",
        '(job_dir / "executed.txt").write_text("ran\\n", encoding="utf-8")',
    ]
    if capture_env_names:
        capture_expr = "{" + ", ".join(f"{name!r}: os.environ.get({name!r})" for name in capture_env_names) + "}"
        script_lines.append(
            f'(job_dir / "thread_env.json").write_text(json.dumps({capture_expr}, sort_keys=True) + "\\n", encoding="utf-8")'
        )
    if payload_text is not None:
        script_lines.append(
            f'(job_dir / "result.json").write_text({payload_text!r} + "\\n", encoding="utf-8")'
        )
    script_lines.append(f"raise SystemExit({int(exit_code)})")
    script_path = job_dir / "run_pyscf_tddft.py"
    script_path.write_text("\n".join(script_lines) + "\n", encoding="utf-8")
    script_path.chmod(0o755)


def test_prepare_pyscf_jobs_creates_default_workspace_and_job_inputs(tmp_path: Path) -> None:
    bundle_path = _write_geometry_bundle_dir(tmp_path)

    workspace_dir = prepare_workspace(
        bundle_path=bundle_path,
        workspace_dir=None,
        xc="b3lyp",
        basis="6-31g*",
        n_excited_states=2,
        reference="auto",
    )

    expected_workspace = bundle_path / "electronic_workspaces" / "pyscf_tddft__auto__b3lyp__6-31g__n2"
    assert workspace_dir == expected_workspace.resolve()

    prepare_manifest = json.loads((workspace_dir / "prepare_manifest.json").read_text(encoding="utf-8"))
    sample_meta = json.loads(
        (workspace_dir / "jobs" / "nm-sample-demo_sample_000000" / "sample_meta.json").read_text(encoding="utf-8")
    )
    geometry_xyz = (workspace_dir / "jobs" / "nm-sample-demo_sample_000000" / "geometry.xyz").read_text(
        encoding="utf-8"
    )
    run_all = (workspace_dir / "run_all.sh").read_text(encoding="utf-8")
    loaded = load_geometry_bundle(bundle_path)

    assert loaded.n_samples == 2
    assert prepare_manifest["batch_id"] == "nm-sample-demo"
    assert prepare_manifest["n_samples"] == 2
    assert prepare_manifest["charge"] == -1
    assert prepare_manifest["multiplicity"] == 2
    assert prepare_manifest["sample_ids"] == [
        "nm-sample-demo_sample_000000",
        "nm-sample-demo_sample_000001",
    ]
    assert prepare_manifest["profile_id"] == "pyscf_tddft__auto__b3lyp__6-31g__n2"
    assert prepare_manifest["profile_label"] == "TDDFT b3lyp/6-31g* (AUTO, n=2)"
    assert prepare_manifest["xc"] == "b3lyp"
    assert prepare_manifest["basis"] == "6-31g*"
    assert prepare_manifest["n_excited_states"] == 2
    assert sample_meta == {
        "charge": -1,
        "geom_sha1": sample_meta["geom_sha1"],
        "multiplicity": 2,
        "sample_id": "nm-sample-demo_sample_000000",
        "sample_idx": 0,
    }
    assert geometry_xyz.startswith("3\n")
    assert "geom_sha1=" in geometry_xyz
    assert "run_pyscf_tddft.py > stdout.log 2>&1" in run_all


def test_prepare_pyscf_jobs_rejects_archive_input(tmp_path: Path) -> None:
    bundle_path = tmp_path / "normal_modes_geometry.tar.gz"
    bundle_path.write_bytes(b"not-a-directory")

    with pytest.raises(ValueError) as exc_info:
        prepare_workspace(
            bundle_path=bundle_path,
            workspace_dir=None,
            xc="b3lyp",
            basis="6-31g*",
            n_excited_states=2,
        )

    assert "directory root" in str(exc_info.value)


def test_prepare_pyscf_jobs_force_rebuilds_existing_workspace(tmp_path: Path) -> None:
    bundle_path = _write_geometry_bundle_dir(tmp_path)
    workspace_dir = prepare_workspace(
        bundle_path=bundle_path,
        workspace_dir=None,
        xc="b3lyp",
        basis="6-31g*",
        n_excited_states=2,
    )
    marker = workspace_dir / "marker.txt"
    marker.write_text("stale", encoding="utf-8")

    with pytest.raises(ValueError) as exc_info:
        prepare_workspace(
            bundle_path=bundle_path,
            workspace_dir=workspace_dir,
            xc="b3lyp",
            basis="6-31g*",
            n_excited_states=2,
        )

    assert "--force" in str(exc_info.value)

    rebuilt_dir = prepare_workspace(
        bundle_path=bundle_path,
        workspace_dir=workspace_dir,
        xc="b3lyp",
        basis="6-31g*",
        n_excited_states=2,
        force=True,
    )
    assert rebuilt_dir == workspace_dir
    assert not marker.exists()
    assert (workspace_dir / "prepare_manifest.json").is_file()


def test_assemble_distribution_bundle_writes_back_electronic_payloads(tmp_path: Path) -> None:
    bundle_path = _write_geometry_bundle_dir(tmp_path)
    workspace_dir = prepare_workspace(
        bundle_path=bundle_path,
        workspace_dir=None,
        xc="b3lyp",
        basis="6-31g*",
        n_excited_states=2,
        reference="auto",
    )

    sample_meta_a = json.loads(
        (workspace_dir / "jobs" / "nm-sample-demo_sample_000000" / "sample_meta.json").read_text(encoding="utf-8")
    )
    sample_meta_b = json.loads(
        (workspace_dir / "jobs" / "nm-sample-demo_sample_000001" / "sample_meta.json").read_text(encoding="utf-8")
    )
    _write_result_json(
        workspace_dir,
        sample_id=sample_meta_a["sample_id"],
        sample_idx=sample_meta_a["sample_idx"],
        geom_sha1=sample_meta_a["geom_sha1"],
        shift=0.0,
    )
    _write_result_json(
        workspace_dir,
        sample_id=sample_meta_b["sample_id"],
        sample_idx=sample_meta_b["sample_idx"],
        geom_sha1=sample_meta_b["geom_sha1"],
        shift=0.01,
    )

    written_path = assemble_distribution_bundle(bundle_path=bundle_path)

    assert written_path == bundle_path.resolve()
    manifest = json.loads((bundle_path / "manifest.json").read_text(encoding="utf-8"))
    profile_manifest = json.loads(
        (bundle_path / "electronics" / "pyscf_tddft__auto__b3lyp__6-31g__n2" / "manifest.json").read_text(
            encoding="utf-8"
        )
    )
    state_energy = np.load(bundle_path / "electronics" / "pyscf_tddft__auto__b3lyp__6-31g__n2" / "state_energy_hartree.npy")
    transition_pairs = np.load(bundle_path / "electronics" / "pyscf_tddft__auto__b3lyp__6-31g__n2" / "transition_pairs.npy")
    transition_dipole = np.load(bundle_path / "electronics" / "pyscf_tddft__auto__b3lyp__6-31g__n2" / "transition_dipole_au.npy")
    transition_intensity = np.load(bundle_path / "electronics" / "pyscf_tddft__auto__b3lyp__6-31g__n2" / "transition_intensity.npy")
    loaded = load_geometry_bundle(bundle_path)

    assert loaded.n_samples == 2
    assert manifest["electronics"] == {
        "default_profile_id": "pyscf_tddft__auto__b3lyp__6-31g__n2",
        "profiles": [
            {
                "id": "pyscf_tddft__auto__b3lyp__6-31g__n2",
                "label": "TDDFT b3lyp/6-31g* (AUTO, n=2)",
                "path": "electronics/pyscf_tddft__auto__b3lyp__6-31g__n2",
                "engine": "pyscf",
                "method": "tddft",
                "reference": "uks",
                "xc": "b3lyp",
                "basis": "6-31g*",
                "n_excited_states": 2,
                "success_count": 2,
                "failed_count": 0,
            }
        ],
    }
    assert profile_manifest["success_count"] == 2
    assert profile_manifest["failed_count"] == 0
    assert profile_manifest["failed_samples"] == []
    assert profile_manifest["reference"] == "uks"
    assert [item["name"] for item in profile_manifest["channels"]] == [
        "state_energy_hartree",
        "transition_pairs",
        "transition_dipole_au",
        "transition_intensity",
    ]
    assert state_energy.shape == (2, 3)
    assert transition_pairs.shape == (2, 2)
    assert transition_dipole.shape == (2, 2, 3)
    assert transition_intensity.shape == (2, 2)
    assert np.all(np.isfinite(state_energy))


def test_assemble_distribution_bundle_records_failed_samples_with_nan_placeholders(tmp_path: Path) -> None:
    bundle_path = _write_geometry_bundle_dir(tmp_path)
    workspace_dir = prepare_workspace(
        bundle_path=bundle_path,
        workspace_dir=None,
        xc="b3lyp",
        basis="6-31g*",
        n_excited_states=2,
        reference="auto",
    )

    sample_meta_a = json.loads(
        (workspace_dir / "jobs" / "nm-sample-demo_sample_000000" / "sample_meta.json").read_text(encoding="utf-8")
    )
    sample_meta_b = json.loads(
        (workspace_dir / "jobs" / "nm-sample-demo_sample_000001" / "sample_meta.json").read_text(encoding="utf-8")
    )
    _write_result_json(
        workspace_dir,
        sample_id=sample_meta_a["sample_id"],
        sample_idx=sample_meta_a["sample_idx"],
        geom_sha1=sample_meta_a["geom_sha1"],
        shift=0.0,
    )
    _write_result_json(
        workspace_dir,
        sample_id=sample_meta_b["sample_id"],
        sample_idx=sample_meta_b["sample_idx"],
        geom_sha1=sample_meta_b["geom_sha1"],
        status="error",
        error_message="TDDFT did not converge",
    )

    assemble_distribution_bundle(bundle_path=bundle_path, workspace_dir=workspace_dir)

    profile_manifest = json.loads(
        (bundle_path / "electronics" / "pyscf_tddft__auto__b3lyp__6-31g__n2" / "manifest.json").read_text(
            encoding="utf-8"
        )
    )
    state_energy = np.load(bundle_path / "electronics" / "pyscf_tddft__auto__b3lyp__6-31g__n2" / "state_energy_hartree.npy")
    transition_dipole = np.load(bundle_path / "electronics" / "pyscf_tddft__auto__b3lyp__6-31g__n2" / "transition_dipole_au.npy")
    transition_intensity = np.load(bundle_path / "electronics" / "pyscf_tddft__auto__b3lyp__6-31g__n2" / "transition_intensity.npy")

    assert profile_manifest["success_count"] == 1
    assert profile_manifest["failed_count"] == 1
    assert profile_manifest["failed_samples"] == [
        {
            "error_message": "TDDFT did not converge",
            "sample_id": "nm-sample-demo_sample_000001",
            "sample_idx": 1,
        }
    ]
    assert np.all(np.isfinite(state_energy[0]))
    assert np.all(np.isnan(state_energy[1]))
    assert np.all(np.isfinite(transition_dipole[0]))
    assert np.all(np.isnan(transition_dipole[1]))
    assert np.all(np.isfinite(transition_intensity[0]))
    assert np.all(np.isnan(transition_intensity[1]))


def test_assemble_distribution_bundle_rejects_geom_sha1_mismatch(tmp_path: Path) -> None:
    bundle_path = _write_geometry_bundle_dir(tmp_path)
    workspace_dir = prepare_workspace(
        bundle_path=bundle_path,
        workspace_dir=None,
        xc="b3lyp",
        basis="6-31g*",
        n_excited_states=2,
        reference="auto",
    )

    sample_meta_a = json.loads(
        (workspace_dir / "jobs" / "nm-sample-demo_sample_000000" / "sample_meta.json").read_text(encoding="utf-8")
    )
    sample_meta_b = json.loads(
        (workspace_dir / "jobs" / "nm-sample-demo_sample_000001" / "sample_meta.json").read_text(encoding="utf-8")
    )
    _write_result_json(
        workspace_dir,
        sample_id=sample_meta_a["sample_id"],
        sample_idx=sample_meta_a["sample_idx"],
        geom_sha1=sample_meta_a["geom_sha1"],
        shift=0.0,
    )
    _write_result_json(
        workspace_dir,
        sample_id=sample_meta_b["sample_id"],
        sample_idx=sample_meta_b["sample_idx"],
        geom_sha1="bad-geom-sha1",
        shift=0.01,
    )

    with pytest.raises(ValueError) as exc_info:
        assemble_distribution_bundle(bundle_path=bundle_path, workspace_dir=workspace_dir)

    assert "geom_sha1" in str(exc_info.value)


def test_assemble_distribution_bundle_rejects_transition_pair_mismatch(tmp_path: Path) -> None:
    bundle_path = _write_geometry_bundle_dir(tmp_path)
    workspace_dir = prepare_workspace(
        bundle_path=bundle_path,
        workspace_dir=None,
        xc="b3lyp",
        basis="6-31g*",
        n_excited_states=2,
        reference="auto",
    )

    sample_meta_a = json.loads(
        (workspace_dir / "jobs" / "nm-sample-demo_sample_000000" / "sample_meta.json").read_text(encoding="utf-8")
    )
    sample_meta_b = json.loads(
        (workspace_dir / "jobs" / "nm-sample-demo_sample_000001" / "sample_meta.json").read_text(encoding="utf-8")
    )
    _write_result_json(
        workspace_dir,
        sample_id=sample_meta_a["sample_id"],
        sample_idx=sample_meta_a["sample_idx"],
        geom_sha1=sample_meta_a["geom_sha1"],
        shift=0.0,
    )
    _write_result_json(
        workspace_dir,
        sample_id=sample_meta_b["sample_id"],
        sample_idx=sample_meta_b["sample_idx"],
        geom_sha1=sample_meta_b["geom_sha1"],
        shift=0.01,
        transition_pairs=[[0, 1], [1, 2]],
    )

    with pytest.raises(ValueError) as exc_info:
        assemble_distribution_bundle(bundle_path=bundle_path, workspace_dir=workspace_dir)

    assert "transition_pairs" in str(exc_info.value)


def test_assemble_distribution_bundle_preserves_multiple_profiles(tmp_path: Path) -> None:
    bundle_path = _write_geometry_bundle_dir(tmp_path)
    workspace_a = prepare_workspace(
        bundle_path=bundle_path,
        workspace_dir=None,
        xc="b3lyp",
        basis="6-31g*",
        n_excited_states=2,
        reference="auto",
    )
    workspace_b = prepare_workspace(
        bundle_path=bundle_path,
        workspace_dir=None,
        xc="pbe0",
        basis="def2-svp",
        n_excited_states=3,
        reference="uks",
    )

    for workspace_dir, shift in ((workspace_a, 0.0), (workspace_b, 0.03)):
        for sample_dir in sorted((workspace_dir / "jobs").iterdir()):
            sample_meta = json.loads((sample_dir / "sample_meta.json").read_text(encoding="utf-8"))
            if workspace_dir == workspace_a:
                reference = "uks"
                xc = "b3lyp"
                basis = "6-31g*"
                n_excited_states = 2
            else:
                reference = "uks"
                xc = "pbe0"
                basis = "def2-svp"
                n_excited_states = 3
            _write_result_json(
                workspace_dir,
                sample_id=sample_meta["sample_id"],
                sample_idx=sample_meta["sample_idx"],
                geom_sha1=sample_meta["geom_sha1"],
                shift=shift,
                reference=reference,
                xc=xc,
                basis=basis,
                n_excited_states=n_excited_states,
            )

    assemble_distribution_bundle(bundle_path=bundle_path, workspace_dir=workspace_a)
    assemble_distribution_bundle(bundle_path=bundle_path, workspace_dir=workspace_b)

    manifest = json.loads((bundle_path / "manifest.json").read_text(encoding="utf-8"))

    assert manifest["electronics"]["default_profile_id"] == "pyscf_tddft__auto__b3lyp__6-31g__n2"
    assert [item["id"] for item in manifest["electronics"]["profiles"]] == [
        "pyscf_tddft__auto__b3lyp__6-31g__n2",
        "pyscf_tddft__uks__pbe0__def2-svp__n3",
    ]
    assert (bundle_path / "electronics" / "pyscf_tddft__auto__b3lyp__6-31g__n2" / "manifest.json").is_file()
    assert (bundle_path / "electronics" / "pyscf_tddft__uks__pbe0__def2-svp__n3" / "manifest.json").is_file()


def test_assemble_distribution_workspaces_auto_batches_multiple_workspaces(tmp_path: Path) -> None:
    bundle_path = _write_geometry_bundle_dir(tmp_path)
    workspace_a = prepare_workspace(
        bundle_path=bundle_path,
        workspace_dir=None,
        xc="b3lyp",
        basis="6-31g*",
        n_excited_states=2,
        reference="auto",
    )
    workspace_b = prepare_workspace(
        bundle_path=bundle_path,
        workspace_dir=None,
        xc="pbe0",
        basis="def2-svp",
        n_excited_states=3,
        reference="uks",
    )

    for workspace_dir, shift, xc, basis, n_excited_states in (
        (workspace_a, 0.0, "b3lyp", "6-31g*", 2),
        (workspace_b, 0.03, "pbe0", "def2-svp", 3),
    ):
        for sample_dir in sorted((workspace_dir / "jobs").iterdir()):
            sample_meta = json.loads((sample_dir / "sample_meta.json").read_text(encoding="utf-8"))
            _write_result_json(
                workspace_dir,
                sample_id=sample_meta["sample_id"],
                sample_idx=sample_meta["sample_idx"],
                geom_sha1=sample_meta["geom_sha1"],
                shift=shift,
                reference="uks",
                xc=xc,
                basis=basis,
                n_excited_states=n_excited_states,
            )

    batch_result = assemble_distribution_workspaces(bundle_path=bundle_path)
    manifest = json.loads((bundle_path / "manifest.json").read_text(encoding="utf-8"))

    assert batch_result.success_count == 2
    assert batch_result.failure_count == 0
    assert [item.profile_id for item in batch_result.successes] == [
        "pyscf_tddft__auto__b3lyp__6-31g__n2",
        "pyscf_tddft__uks__pbe0__def2-svp__n3",
    ]
    assert manifest["electronics"]["default_profile_id"] == "pyscf_tddft__auto__b3lyp__6-31g__n2"
    assert [item["id"] for item in manifest["electronics"]["profiles"]] == [
        "pyscf_tddft__auto__b3lyp__6-31g__n2",
        "pyscf_tddft__uks__pbe0__def2-svp__n3",
    ]


def test_assemble_distribution_workspaces_overwrites_existing_profile_id(tmp_path: Path) -> None:
    bundle_path = _write_geometry_bundle_dir(tmp_path)
    workspace_dir = prepare_workspace(
        bundle_path=bundle_path,
        workspace_dir=None,
        xc="b3lyp",
        basis="6-31g*",
        n_excited_states=2,
        reference="auto",
    )

    sample_dirs = sorted((workspace_dir / "jobs").iterdir())
    for sample_dir in sample_dirs:
        sample_meta = json.loads((sample_dir / "sample_meta.json").read_text(encoding="utf-8"))
        _write_result_json(
            workspace_dir,
            sample_id=sample_meta["sample_id"],
            sample_idx=sample_meta["sample_idx"],
            geom_sha1=sample_meta["geom_sha1"],
            shift=0.0,
            reference="uks",
        )
    assemble_distribution_bundle(bundle_path=bundle_path, workspace_dir=workspace_dir)

    original_state_energy = np.load(
        bundle_path / "electronics" / "pyscf_tddft__auto__b3lyp__6-31g__n2" / "state_energy_hartree.npy"
    ).copy()

    for sample_dir in sample_dirs:
        sample_meta = json.loads((sample_dir / "sample_meta.json").read_text(encoding="utf-8"))
        _write_result_json(
            workspace_dir,
            sample_id=sample_meta["sample_id"],
            sample_idx=sample_meta["sample_idx"],
            geom_sha1=sample_meta["geom_sha1"],
            shift=0.2,
            reference="uks",
        )

    batch_result = assemble_distribution_workspaces(bundle_path=bundle_path)
    overwritten_state_energy = np.load(
        bundle_path / "electronics" / "pyscf_tddft__auto__b3lyp__6-31g__n2" / "state_energy_hartree.npy"
    )

    assert batch_result.success_count == 1
    assert batch_result.failure_count == 0
    assert not np.allclose(original_state_energy, overwritten_state_energy)


def test_assemble_distribution_workspaces_continues_after_partial_failure_and_cli_returns_nonzero(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    bundle_path = _write_geometry_bundle_dir(tmp_path)
    workspace_a = prepare_workspace(
        bundle_path=bundle_path,
        workspace_dir=None,
        xc="b3lyp",
        basis="6-31g*",
        n_excited_states=2,
        reference="auto",
    )
    workspace_b = prepare_workspace(
        bundle_path=bundle_path,
        workspace_dir=None,
        xc="pbe0",
        basis="def2-svp",
        n_excited_states=3,
        reference="uks",
    )

    for sample_dir in sorted((workspace_a / "jobs").iterdir()):
        sample_meta = json.loads((sample_dir / "sample_meta.json").read_text(encoding="utf-8"))
        _write_result_json(
            workspace_a,
            sample_id=sample_meta["sample_id"],
            sample_idx=sample_meta["sample_idx"],
            geom_sha1=sample_meta["geom_sha1"],
            shift=0.0,
            reference="uks",
            xc="b3lyp",
            basis="6-31g*",
            n_excited_states=2,
        )

    sample_dirs_b = sorted((workspace_b / "jobs").iterdir())
    sample_meta_b0 = json.loads((sample_dirs_b[0] / "sample_meta.json").read_text(encoding="utf-8"))
    sample_meta_b1 = json.loads((sample_dirs_b[1] / "sample_meta.json").read_text(encoding="utf-8"))
    _write_result_json(
        workspace_b,
        sample_id=sample_meta_b0["sample_id"],
        sample_idx=sample_meta_b0["sample_idx"],
        geom_sha1=sample_meta_b0["geom_sha1"],
        shift=0.03,
        reference="uks",
        xc="pbe0",
        basis="def2-svp",
        n_excited_states=3,
    )
    _write_result_json(
        workspace_b,
        sample_id=sample_meta_b1["sample_id"],
        sample_idx=sample_meta_b1["sample_idx"],
        geom_sha1=sample_meta_b1["geom_sha1"],
        shift=0.06,
        transition_pairs=[[0, 1], [1, 2]],
        reference="uks",
        xc="pbe0",
        basis="def2-svp",
        n_excited_states=3,
    )

    exit_code = assemble_distribution_bundle_main(["--sampling-dir", str(bundle_path)])
    stdout = capsys.readouterr().out

    assert exit_code == 1
    assert "[ok]" in stdout
    assert "[failed]" in stdout
    assert (bundle_path / "electronics" / "pyscf_tddft__auto__b3lyp__6-31g__n2" / "manifest.json").is_file()
    assert not (bundle_path / "electronics" / "pyscf_tddft__uks__pbe0__def2-svp__n3" / "manifest.json").exists()


def test_assemble_distribution_workspaces_rejects_duplicate_profile_ids_in_batch(tmp_path: Path) -> None:
    bundle_path = _write_geometry_bundle_dir(tmp_path)
    workspace_a = prepare_workspace(
        bundle_path=bundle_path,
        workspace_dir=bundle_path / "electronic_workspaces" / "duplicate_a",
        xc="b3lyp",
        basis="6-31g*",
        n_excited_states=2,
        reference="auto",
        profile_id="duplicate_profile",
        profile_label="Duplicate Profile A",
    )
    workspace_b = prepare_workspace(
        bundle_path=bundle_path,
        workspace_dir=bundle_path / "electronic_workspaces" / "duplicate_b",
        xc="pbe0",
        basis="def2-svp",
        n_excited_states=3,
        reference="uks",
        profile_id="duplicate_profile",
        profile_label="Duplicate Profile B",
    )
    workspace_c = prepare_workspace(
        bundle_path=bundle_path,
        workspace_dir=bundle_path / "electronic_workspaces" / "unique_c",
        xc="cam-b3lyp",
        basis="3-21g",
        n_excited_states=4,
        reference="auto",
    )

    for workspace_dir, shift, xc, basis, n_excited_states in (
        (workspace_a, 0.0, "b3lyp", "6-31g*", 2),
        (workspace_b, 0.03, "pbe0", "def2-svp", 3),
        (workspace_c, 0.05, "cam-b3lyp", "3-21g", 4),
    ):
        for sample_dir in sorted((workspace_dir / "jobs").iterdir()):
            sample_meta = json.loads((sample_dir / "sample_meta.json").read_text(encoding="utf-8"))
            _write_result_json(
                workspace_dir,
                sample_id=sample_meta["sample_id"],
                sample_idx=sample_meta["sample_idx"],
                geom_sha1=sample_meta["geom_sha1"],
                shift=shift,
                reference="uks",
                xc=xc,
                basis=basis,
                n_excited_states=n_excited_states,
            )

    batch_result = assemble_distribution_workspaces(bundle_path=bundle_path)

    assert batch_result.success_count == 1
    assert batch_result.failure_count == 2
    assert [item.profile_id for item in batch_result.successes] == [
        "pyscf_tddft__auto__cam-b3lyp__3-21g__n4"
    ]
    assert all("Duplicate profile_id" in item.error for item in batch_result.failures)
    assert not (bundle_path / "electronics" / "duplicate_profile").exists()
    assert (bundle_path / "electronics" / "pyscf_tddft__auto__cam-b3lyp__3-21g__n4" / "manifest.json").is_file()


def test_run_workspace_batch_uses_slurm_array_id_and_skips_existing_ok(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    bundle_path = _write_geometry_bundle_dir(tmp_path)
    workspace_dir = prepare_workspace(
        bundle_path=bundle_path,
        workspace_dir=None,
        xc="b3lyp",
        basis="6-31g*",
        n_excited_states=2,
        reference="auto",
    )

    job_dirs = sorted((workspace_dir / "jobs").iterdir())
    _install_fake_job_script(job_dirs[0], status="ok", exit_code=0)
    _install_fake_job_script(job_dirs[1], status="ok", exit_code=0)
    (job_dirs[0] / "result.json").write_text('{\n  "status": "ok"\n}\n', encoding="utf-8")

    monkeypatch.setenv("SLURM_ARRAY_TASK_ID", "0")
    exit_code = run_workspace_batch_main(
        [
            "--workspace",
            str(workspace_dir),
            "--batch-count",
            "1",
        ]
    )
    stdout = capsys.readouterr().out

    assert exit_code == 0
    assert "[skip] nm-sample-demo_sample_000000" in stdout
    assert "[ok] nm-sample-demo_sample_000001" in stdout
    assert not (job_dirs[0] / "executed.txt").exists()
    assert (job_dirs[1] / "executed.txt").read_text(encoding="utf-8") == "ran\n"


def test_run_workspace_batch_reruns_error_results_and_continues_after_failures(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    bundle_path = _write_geometry_bundle_dir(tmp_path)
    workspace_dir = prepare_workspace(
        bundle_path=bundle_path,
        workspace_dir=None,
        xc="b3lyp",
        basis="6-31g*",
        n_excited_states=2,
        reference="auto",
    )

    job_dirs = sorted((workspace_dir / "jobs").iterdir())
    _install_fake_job_script(job_dirs[0], status=None, exit_code=3)
    _install_fake_job_script(job_dirs[1], status="ok", exit_code=0)
    (job_dirs[0] / "result.json").write_text('{\n  "status": "error"\n}\n', encoding="utf-8")

    exit_code = run_workspace_batch_main(
        [
            "--workspace",
            str(workspace_dir),
            "--batch-count",
            "1",
            "--batch-index",
            "0",
        ]
    )
    stdout = capsys.readouterr().out

    assert exit_code == 0
    assert "[failed] nm-sample-demo_sample_000000 (exit=3)" in stdout
    assert "[ok] nm-sample-demo_sample_000001" in stdout
    assert (job_dirs[0] / "executed.txt").read_text(encoding="utf-8") == "ran\n"
    assert (job_dirs[1] / "executed.txt").read_text(encoding="utf-8") == "ran\n"
    assert json.loads((job_dirs[1] / "result.json").read_text(encoding="utf-8"))["status"] == "ok"


def test_run_workspace_batch_allows_empty_batches(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    bundle_path = _write_geometry_bundle_dir(tmp_path)
    workspace_dir = prepare_workspace(
        bundle_path=bundle_path,
        workspace_dir=None,
        xc="b3lyp",
        basis="6-31g*",
        n_excited_states=2,
        reference="auto",
    )

    job_dirs = sorted((workspace_dir / "jobs").iterdir())
    _install_fake_job_script(job_dirs[0], status="ok", exit_code=0)
    _install_fake_job_script(job_dirs[1], status="ok", exit_code=0)

    exit_code = run_workspace_batch_main(
        [
            "--workspace",
            str(workspace_dir),
            "--batch-count",
            "3",
            "--batch-index",
            "2",
        ]
    )
    stdout = capsys.readouterr().out

    assert exit_code == 0
    assert "samples=0" in stdout
    assert not (job_dirs[0] / "executed.txt").exists()
    assert not (job_dirs[1] / "executed.txt").exists()


def test_run_workspace_batch_does_not_infer_threads_from_slurm_without_prepare_setting(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    bundle_path = _write_geometry_bundle_dir(tmp_path)
    workspace_dir = prepare_workspace(
        bundle_path=bundle_path,
        workspace_dir=None,
        xc="b3lyp",
        basis="6-31g*",
        n_excited_states=2,
        reference="auto",
    )

    job_dir = sorted((workspace_dir / "jobs").iterdir())[0]
    _install_fake_job_script(
        job_dir,
        status="ok",
        exit_code=0,
        capture_env_names=("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS"),
    )
    monkeypatch.delenv("OMP_NUM_THREADS", raising=False)
    monkeypatch.delenv("MKL_NUM_THREADS", raising=False)
    monkeypatch.delenv("OPENBLAS_NUM_THREADS", raising=False)
    monkeypatch.setenv("SLURM_CPUS_PER_TASK", "6")

    exit_code = run_workspace_batch_main(
        [
            "--workspace",
            str(workspace_dir),
            "--batch-count",
            "2",
            "--batch-index",
            "0",
        ]
    )
    stdout = capsys.readouterr().out
    thread_env = json.loads((job_dir / "thread_env.json").read_text(encoding="utf-8"))

    assert exit_code == 0
    assert "[threads]" not in stdout
    assert thread_env == {
        "MKL_NUM_THREADS": None,
        "OMP_NUM_THREADS": None,
        "OPENBLAS_NUM_THREADS": None,
    }


def test_run_workspace_batch_prefers_prepare_num_threads_over_slurm(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    bundle_path = _write_geometry_bundle_dir(tmp_path)
    workspace_dir = prepare_workspace(
        bundle_path=bundle_path,
        workspace_dir=None,
        xc="b3lyp",
        basis="6-31g*",
        n_excited_states=2,
        reference="auto",
        num_threads=3,
    )

    job_dir = sorted((workspace_dir / "jobs").iterdir())[0]
    _install_fake_job_script(
        job_dir,
        status="ok",
        exit_code=0,
        capture_env_names=("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS"),
    )
    monkeypatch.delenv("OMP_NUM_THREADS", raising=False)
    monkeypatch.delenv("MKL_NUM_THREADS", raising=False)
    monkeypatch.delenv("OPENBLAS_NUM_THREADS", raising=False)
    monkeypatch.setenv("SLURM_CPUS_PER_TASK", "6")

    exit_code = run_workspace_batch_main(
        [
            "--workspace",
            str(workspace_dir),
            "--batch-count",
            "2",
            "--batch-index",
            "0",
        ]
    )
    stdout = capsys.readouterr().out
    thread_env = json.loads((job_dir / "thread_env.json").read_text(encoding="utf-8"))

    assert exit_code == 0
    assert "[threads] source=prepare_manifest.num_threads" in stdout
    assert thread_env == {
        "MKL_NUM_THREADS": "3",
        "OMP_NUM_THREADS": "3",
        "OPENBLAS_NUM_THREADS": "3",
    }


def test_submit_workspace_array_wrapper_builds_sbatch_command(tmp_path: Path) -> None:
    bundle_path = _write_geometry_bundle_dir(tmp_path)
    workspace_dir = prepare_workspace(
        bundle_path=bundle_path,
        workspace_dir=None,
        xc="b3lyp",
        basis="6-31g*",
        n_excited_states=2,
        reference="auto",
    )

    fake_bin_dir = tmp_path / "fake_bin"
    fake_bin_dir.mkdir(parents=True, exist_ok=True)
    capture_path = tmp_path / "sbatch_args.txt"
    fake_sbatch_path = fake_bin_dir / "sbatch"
    fake_sbatch_path.write_text(
        textwrap.dedent(
            """\
            #!/usr/bin/env bash
            set -euo pipefail
            printf '%s\n' "$@" > "$CAPTURE_PATH"
            printf 'Submitted batch job 12345\n'
            """
        ),
        encoding="utf-8",
    )
    fake_sbatch_path.chmod(0o755)

    wrapper_path = REPO_ROOT / "scripts" / "electronic_structure" / "submit_workspace_array.sh"
    env = dict(os.environ)
    env["CAPTURE_PATH"] = str(capture_path)
    env["PATH"] = f"{fake_bin_dir}{os.pathsep}{env.get('PATH', '')}"

    completed = subprocess.run(  # noqa: S603
        [
            "bash",
            str(wrapper_path),
            "--workspace",
            str(workspace_dir),
            "--batch-count",
            "3",
            "--cpus-per-task",
            "4",
            "--mem",
            "8G",
            "--time",
            "01:30:00",
            "--job-name",
            "pyscf-demo",
            "--python-exe",
            sys.executable,
        ],
        cwd=str(REPO_ROOT),
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )

    assert completed.returncode == 0
    assert "Submitting Slurm array with 3 batch(es)" in completed.stdout

    captured_args = capture_path.read_text(encoding="utf-8").splitlines()
    wrap_index = captured_args.index("--wrap")
    wrap_cmd = captured_args[wrap_index + 1]
    assert "--array=0-2" in captured_args
    assert "--cpus-per-task=4" in captured_args
    assert "--mem=8G" in captured_args
    assert "--time=01:30:00" in captured_args
    assert "--job-name=pyscf-demo" in captured_args
    assert "--export=ALL,OMP_NUM_THREADS=4,MKL_NUM_THREADS=4,OPENBLAS_NUM_THREADS=4" in captured_args
    assert str(REPO_ROOT / "scripts" / "electronic_structure" / "run_workspace_batch.py") in wrap_cmd
    assert f"--workspace {workspace_dir.resolve()}" in wrap_cmd
    assert "--batch-count 3" in wrap_cmd


def test_submit_workspace_array_wrapper_uses_prepare_manifest_num_threads_by_default(tmp_path: Path) -> None:
    bundle_path = _write_geometry_bundle_dir(tmp_path)
    workspace_dir = prepare_workspace(
        bundle_path=bundle_path,
        workspace_dir=None,
        xc="b3lyp",
        basis="6-31g*",
        n_excited_states=2,
        reference="auto",
        num_threads=5,
    )

    fake_bin_dir = tmp_path / "fake_bin"
    fake_bin_dir.mkdir(parents=True, exist_ok=True)
    capture_path = tmp_path / "sbatch_args.txt"
    fake_sbatch_path = fake_bin_dir / "sbatch"
    fake_sbatch_path.write_text(
        textwrap.dedent(
            """\
            #!/usr/bin/env bash
            set -euo pipefail
            printf '%s\n' "$@" > "$CAPTURE_PATH"
            printf 'Submitted batch job 12345\n'
            """
        ),
        encoding="utf-8",
    )
    fake_sbatch_path.chmod(0o755)

    wrapper_path = REPO_ROOT / "scripts" / "electronic_structure" / "submit_workspace_array.sh"
    env = dict(os.environ)
    env["CAPTURE_PATH"] = str(capture_path)
    env["PATH"] = f"{fake_bin_dir}{os.pathsep}{env.get('PATH', '')}"

    completed = subprocess.run(  # noqa: S603
        [
            "bash",
            str(wrapper_path),
            "--workspace",
            str(workspace_dir),
            "--batch-count",
            "2",
            "--python-exe",
            sys.executable,
        ],
        cwd=str(REPO_ROOT),
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )

    assert completed.returncode == 0
    captured_args = capture_path.read_text(encoding="utf-8").splitlines()
    assert "--cpus-per-task=5" in captured_args
    assert "--export=ALL,OMP_NUM_THREADS=5,MKL_NUM_THREADS=5,OPENBLAS_NUM_THREADS=5" in captured_args


def test_submit_workspace_array_wrapper_rejects_cpus_conflicting_with_prepare_manifest(tmp_path: Path) -> None:
    bundle_path = _write_geometry_bundle_dir(tmp_path)
    workspace_dir = prepare_workspace(
        bundle_path=bundle_path,
        workspace_dir=None,
        xc="b3lyp",
        basis="6-31g*",
        n_excited_states=2,
        reference="auto",
        num_threads=5,
    )

    wrapper_path = REPO_ROOT / "scripts" / "electronic_structure" / "submit_workspace_array.sh"
    completed = subprocess.run(  # noqa: S603
        [
            "bash",
            str(wrapper_path),
            "--workspace",
            str(workspace_dir),
            "--batch-count",
            "2",
            "--cpus-per-task",
            "4",
            "--python-exe",
            sys.executable,
        ],
        cwd=str(REPO_ROOT),
        capture_output=True,
        text=True,
        check=False,
    )

    assert completed.returncode != 0
    assert "does not match prepare_manifest.json num_threads (5)" in completed.stderr
