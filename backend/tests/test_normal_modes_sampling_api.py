from __future__ import annotations

import asyncio
import io
import json
from pathlib import Path
import sys
import tarfile

import numpy as np
import pytest
from fastapi import HTTPException
from pydantic import ValidationError

# Keep tests runnable from repository root without requiring editable install.
REPO_ROOT = Path(__file__).resolve().parents[3]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from backend.server.app import create_app
from backend.server.cache import SeriesLRUCache
from backend.server.dataset_store import DatasetStore, TrajectoryRecord
from backend.server.models import (
    DistributionCompareGeometryRequest,
    NormalModesGeometrySaveRequest,
    NormalModesMeasurementRequest,
    NormalModesSampleTextRequest,
)
from backend.server.normal_modes_sampling import build_mode_sampling_plan


FIXTURE_PATH = Path(__file__).resolve().parent / "fixtures" / "freq.molden"


def _build_traj(traj_id: str) -> TrajectoryRecord:
    time = np.asarray([0.0, 1.0], dtype=float)
    return TrajectoryRecord(
        traj_id=str(traj_id),
        n_atoms=1,
        atom_numbers=[1],
        time=time,
        coords=np.zeros((2, 1, 3), dtype=float),
        etot_time=time.copy(),
        etot=np.asarray([0.0, 0.1], dtype=float),
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
        input_path=Path("/tmp/normal_modes_sampling_api.pkl"),
        meta={"source_pkl": "/tmp/normal_modes_sampling_api.pkl"},
        defaults={},
        trajectories={"0": _build_traj("0")},
    )


def _find_endpoint(app: object, path: str, method: str):
    method_text = method.upper()
    for route in getattr(app, "routes", []):
        if getattr(route, "path", "") != path:
            continue
        methods = set(getattr(route, "methods", set()) or set())
        if method_text in methods:
            return route.endpoint
    raise AssertionError(f"Could not find route for path={path!r}, method={method_text!r}.")


def _invoke_endpoint(endpoint, *args, **kwargs):
    result = endpoint(*args, **kwargs)
    if asyncio.iscoroutine(result):
        return asyncio.run(result)
    return result


def _fixture_text() -> str:
    return FIXTURE_PATH.read_text(encoding="utf-8")


def _sampling_request(*, seed: int = 123) -> NormalModesSampleTextRequest:
    return NormalModesSampleTextRequest(
        filename=FIXTURE_PATH.name,
        content=_fixture_text(),
        sample_count=64,
        preview_count=12,
        charge=0,
        multiplicity=1,
        position_default="wigner_zero_t",
        momentum_default="frozen",
        freq_min_cm1=20.0,
        seed=seed,
    )


def test_build_mode_sampling_plan_rejects_imaginary_non_frozen_sampler() -> None:
    with pytest.raises(ValueError) as exc_info:
        build_mode_sampling_plan(
            frequencies_cm1=np.asarray([-50.0], dtype=float),
            mode_kinds=["imaginary"],
            position_default="wigner_zero_t",
            momentum_default="frozen",
        )

    assert "imaginary frequency" in str(exc_info.value)


def test_sample_normal_modes_api_returns_preview_subset_and_reproducible_seed() -> None:
    app = create_app(store=_build_store(), cache=SeriesLRUCache(max_entries=32))
    endpoint = _find_endpoint(app, "/api/normal-modes/sample-text", "POST")

    response_a = endpoint(_sampling_request(seed=777))
    response_b = endpoint(_sampling_request(seed=777))

    assert response_a.batch_id != response_b.batch_id
    assert response_a.source_name == FIXTURE_PATH.name
    assert response_a.n_atoms == 26
    assert response_a.charge == 0
    assert response_a.multiplicity == 1
    assert response_a.sample_count == 64
    assert response_a.preview_count == 12
    assert len(response_a.preview_indices) == 12
    assert len(response_a.preview_coords_ang) == 12
    assert response_a.preview_indices == response_b.preview_indices
    assert response_a.seed == response_b.seed == 777
    assert response_a.sampling_completed_at_utc.endswith("Z")
    assert response_a.mode_sampling_plan == response_b.mode_sampling_plan
    assert np.allclose(
        np.asarray(response_a.preview_coords_ang, dtype=float),
        np.asarray(response_b.preview_coords_ang, dtype=float),
    )
    assert response_a.mode_sampling_plan[0].included is False
    assert response_a.mode_sampling_plan[6].position_sampler == "wigner_zero_t"


def test_sample_normal_modes_request_rejects_invalid_multiplicity() -> None:
    with pytest.raises(ValidationError):
        NormalModesSampleTextRequest(
            filename=FIXTURE_PATH.name,
            content=_fixture_text(),
            sample_count=8,
            preview_count=4,
            charge=0,
            multiplicity=0,
            position_default="wigner_zero_t",
            momentum_default="frozen",
        )


def test_sample_normal_modes_api_rejects_non_frozen_zero_frequency_sampler() -> None:
    app = create_app(store=_build_store(), cache=SeriesLRUCache(max_entries=32))
    endpoint = _find_endpoint(app, "/api/normal-modes/sample-text", "POST")

    with pytest.raises(HTTPException) as exc_info:
        endpoint(
            NormalModesSampleTextRequest(
                filename=FIXTURE_PATH.name,
                content=_fixture_text(),
                sample_count=8,
                preview_count=4,
                position_default="wigner_zero_t",
                momentum_default="frozen",
                seed=13,
            )
        )

    assert exc_info.value.status_code == 422
    assert "zero frequency" in str(exc_info.value.detail)


def test_sample_batch_measurement_endpoint_returns_bond_angle_and_dihedral_values() -> None:
    app = create_app(store=_build_store(), cache=SeriesLRUCache(max_entries=32))
    sample_endpoint = _find_endpoint(app, "/api/normal-modes/sample-text", "POST")
    measurement_endpoint = _find_endpoint(
        app,
        "/api/normal-modes/sample-batches/{batch_id}/measurements",
        "POST",
    )

    sample_response = sample_endpoint(_sampling_request(seed=9))

    bond_response = measurement_endpoint(
        sample_response.batch_id,
        NormalModesMeasurementRequest(measurement_kind="bond", atom_indices=[0, 1]),
    )
    angle_response = measurement_endpoint(
        sample_response.batch_id,
        NormalModesMeasurementRequest(measurement_kind="angle", atom_indices=[0, 1, 2]),
    )
    dihedral_response = measurement_endpoint(
        sample_response.batch_id,
        NormalModesMeasurementRequest(measurement_kind="dihedral", atom_indices=[0, 1, 2, 3]),
    )

    assert bond_response.batch_id == sample_response.batch_id
    assert bond_response.measurement_kind == "bond"
    assert bond_response.sample_count == 64
    assert len(bond_response.values) == 64
    assert bond_response.mean == pytest.approx(np.mean(bond_response.values), rel=1e-12)
    assert bond_response.std == pytest.approx(np.std(bond_response.values), rel=1e-12)
    assert bond_response.unit == "Angstrom"

    assert angle_response.batch_id == sample_response.batch_id
    assert angle_response.measurement_kind == "angle"
    assert angle_response.sample_count == 64
    assert len(angle_response.values) == 64
    assert 0.0 < angle_response.min < 180.0
    assert 0.0 < angle_response.max < 180.0
    assert angle_response.unit == "deg"

    dihedral_values = np.asarray(dihedral_response.values, dtype=float)
    assert dihedral_response.batch_id == sample_response.batch_id
    assert dihedral_response.measurement_kind == "dihedral"
    assert dihedral_response.sample_count == 64
    assert len(dihedral_response.values) == 64
    assert dihedral_response.unit == "deg"
    assert np.all(np.isfinite(dihedral_values))
    assert np.all(dihedral_values >= -180.0)
    assert np.all(dihedral_values <= 180.0)


def test_sample_batch_measurement_endpoint_rejects_missing_batch() -> None:
    app = create_app(store=_build_store(), cache=SeriesLRUCache(max_entries=32))
    measurement_endpoint = _find_endpoint(
        app,
        "/api/normal-modes/sample-batches/{batch_id}/measurements",
        "POST",
    )

    with pytest.raises(HTTPException) as exc_info:
        measurement_endpoint(
            "missing-batch",
            NormalModesMeasurementRequest(measurement_kind="bond", atom_indices=[0, 1]),
        )

    assert exc_info.value.status_code == 404
    assert "sample batch not found" in str(exc_info.value.detail)


def test_export_normal_modes_bundle_contains_reproducibility_payloads() -> None:
    app = create_app(store=_build_store(), cache=SeriesLRUCache(max_entries=32))
    sample_endpoint = _find_endpoint(app, "/api/normal-modes/sample-text", "POST")
    export_endpoint = _find_endpoint(
        app,
        "/api/normal-modes/sample-batches/{batch_id}/export",
        "GET",
    )

    sample_response = sample_endpoint(_sampling_request(seed=41))
    export_response = export_endpoint(sample_response.batch_id)

    assert export_response.status_code == 200
    assert export_response.media_type == "application/gzip"
    assert "attachment;" in export_response.headers["content-disposition"].lower()
    assert sample_response.batch_id in export_response.headers["content-disposition"]

    with tarfile.open(fileobj=io.BytesIO(export_response.body), mode="r:gz") as archive:
        names = set(archive.getnames())
        assert "manifest.json" in names
        assert "README.txt" in names
        assert "log/sampling.log" in names
        assert "input/original.molden" in names
        assert "input/request.json" in names
        assert "sampling/result_summary.json" in names
        assert "sampling/coords_all_ang.npy" in names
        assert "sampling/all_structures.xyz" in names
        assert "sampling/q_samples_au.npy" in names
        assert "sampling/p_samples_au.npy" in names
        assert "modes/modal_matrix_au.npy" in names
        assert "modes/reconstructed_hessian_cartesian_au.npy" in names

        request_payload = json.load(archive.extractfile("input/request.json"))
        summary_payload = json.load(archive.extractfile("sampling/result_summary.json"))
        preview_indices = json.load(archive.extractfile("sampling/preview_indices.json"))
        coords_all_ang = np.load(io.BytesIO(archive.extractfile("sampling/coords_all_ang.npy").read()))
        q_samples = np.load(io.BytesIO(archive.extractfile("sampling/q_samples_au.npy").read()))
        p_samples = np.load(io.BytesIO(archive.extractfile("sampling/p_samples_au.npy").read()))
        modal_matrix_au = np.load(io.BytesIO(archive.extractfile("modes/modal_matrix_au.npy").read()))
        hessian_au = np.load(io.BytesIO(archive.extractfile("modes/reconstructed_hessian_cartesian_au.npy").read()))

    assert request_payload["seed"] == sample_response.seed == 41
    assert request_payload["preview_count_effective"] == sample_response.preview_count
    assert summary_payload["batch_id"] == sample_response.batch_id
    assert summary_payload["sampling_completed_at_utc"] == sample_response.sampling_completed_at_utc
    assert preview_indices == sample_response.preview_indices
    assert q_samples.shape[0] == sample_response.sample_count
    assert p_samples.shape == q_samples.shape
    assert coords_all_ang.shape == (sample_response.sample_count, sample_response.n_atoms, 3)
    assert modal_matrix_au.shape[1] == q_samples.shape[1]
    assert hessian_au.shape == (sample_response.n_atoms * 3, sample_response.n_atoms * 3)
    assert np.allclose(hessian_au, hessian_au.T, atol=1e-12)
    assert np.allclose(
        coords_all_ang[np.asarray(sample_response.preview_indices, dtype=int)],
        np.asarray(sample_response.preview_coords_ang, dtype=float),
    )


def test_export_normal_modes_geometry_bundle_contains_geometry_exchange_payloads() -> None:
    app = create_app(store=_build_store(), cache=SeriesLRUCache(max_entries=32))
    sample_endpoint = _find_endpoint(app, "/api/normal-modes/sample-text", "POST")
    export_endpoint = _find_endpoint(
        app,
        "/api/normal-modes/sample-batches/{batch_id}/export-geometry",
        "GET",
    )

    sample_response = sample_endpoint(
        NormalModesSampleTextRequest(
            filename=FIXTURE_PATH.name,
            content=_fixture_text(),
            sample_count=16,
            preview_count=6,
            charge=-1,
            multiplicity=2,
            position_default="wigner_zero_t",
            momentum_default="frozen",
            freq_min_cm1=20.0,
            seed=29,
        )
    )
    export_response = export_endpoint(sample_response.batch_id)

    assert export_response.status_code == 200
    assert export_response.media_type == "application/gzip"
    assert "attachment;" in export_response.headers["content-disposition"].lower()
    assert sample_response.batch_id in export_response.headers["content-disposition"]

    with tarfile.open(fileobj=io.BytesIO(export_response.body), mode="r:gz") as archive:
        names = set(archive.getnames())
        assert "manifest.json" in names
        assert "meta/sample_ids.json" in names
        assert "sampling/atom_numbers.npy" in names
        assert "sampling/atom_masses_amu.npy" in names
        assert "sampling/coords_bohr.npy" in names
        assert "sampling/velocities_bohr_per_au_time.npy" in names
        assert "sampling/all_structures.xyz" in names
        assert "sampling/q_samples_au.npy" not in names
        assert "sampling/p_samples_au.npy" not in names
        assert "modes/reconstructed_hessian_cartesian_au.npy" not in names
        assert "meta/sample_table.csv" not in names
        assert "meta/sampling_info.json" not in names
        assert "method_inputs/original.molden" not in names
        assert "xyz/sample_000000.xyz" not in names

        manifest = json.load(archive.extractfile("manifest.json"))
        sample_ids = json.load(archive.extractfile("meta/sample_ids.json"))
        coords_bohr = np.load(io.BytesIO(archive.extractfile("sampling/coords_bohr.npy").read()))
        velocities = np.load(io.BytesIO(archive.extractfile("sampling/velocities_bohr_per_au_time.npy").read()))
        atom_numbers = np.load(io.BytesIO(archive.extractfile("sampling/atom_numbers.npy").read()))
        atom_masses_amu = np.load(io.BytesIO(archive.extractfile("sampling/atom_masses_amu.npy").read()))
        all_structures_xyz = archive.extractfile("sampling/all_structures.xyz").read().decode("utf-8")

    assert manifest["kind"] == "normal_modes_sampling"
    assert manifest["schema_version"] == 4
    assert manifest["label"] == f"{FIXTURE_PATH.name} normal modes samples"
    assert manifest["source_name"] == FIXTURE_PATH.name
    assert manifest["created_at_utc"].endswith("Z")
    assert manifest["n_samples"] == sample_response.sample_count
    assert manifest["n_atoms"] == sample_response.n_atoms
    assert "units" not in manifest
    assert "files" not in manifest
    assert "atom_index_base" not in manifest
    assert "provenance" not in manifest
    assert manifest["sampling_channels"] == [
        {"name": "atom_numbers", "unit": None, "group": "sampling"},
        {"name": "atom_masses_amu", "unit": "amu", "group": "sampling"},
        {"name": "coords_bohr", "unit": "bohr", "group": "sampling"},
        {"name": "velocities_bohr_per_au_time", "unit": "bohr/au_time", "group": "sampling"},
    ]
    assert manifest["electronics"] == {
        "default_profile_id": None,
        "profiles": [],
    }
    assert manifest["batch_id"] == sample_response.batch_id
    assert manifest["sampling_method"] == "normal_modes_harmonic"
    assert manifest["charge"] == -1
    assert manifest["multiplicity"] == 2
    assert manifest["seed"] == 29
    assert sample_ids[0] == f"{sample_response.batch_id}_sample_000000"
    assert len(sample_ids) == sample_response.sample_count == 16
    assert coords_bohr.shape == (sample_response.sample_count, sample_response.n_atoms, 3)
    assert velocities.shape == coords_bohr.shape
    assert atom_numbers.shape == (sample_response.n_atoms,)
    assert atom_masses_amu.shape == (sample_response.n_atoms,)
    xyz_lines = all_structures_xyz.strip().splitlines()
    frame_line_count = sample_response.n_atoms + 2
    assert len(xyz_lines) == sample_response.sample_count * frame_line_count
    assert xyz_lines[0] == str(sample_response.n_atoms)
    assert "sample_idx=0" in xyz_lines[1]
    assert f"sample_id={sample_ids[0]}" in xyz_lines[1]
    assert xyz_lines[frame_line_count] == str(sample_response.n_atoms)
    assert "sample_idx=1" in xyz_lines[frame_line_count + 1]
    assert f"sample_id={sample_ids[1]}" in xyz_lines[frame_line_count + 1]


def test_exported_normal_modes_geometry_bundle_loads_into_distribution_compare() -> None:
    app = create_app(store=_build_store(), cache=SeriesLRUCache(max_entries=32))
    sample_endpoint = _find_endpoint(app, "/api/normal-modes/sample-text", "POST")
    export_endpoint = _find_endpoint(
        app,
        "/api/normal-modes/sample-batches/{batch_id}/export-geometry",
        "GET",
    )
    load_endpoint = _find_endpoint(app, "/api/distributions/load", "POST")
    compare_endpoint = _find_endpoint(app, "/api/distributions/compare-geometry", "POST")

    sample_response = sample_endpoint(_sampling_request(seed=73))
    export_response = export_endpoint(sample_response.batch_id)
    loaded = _invoke_endpoint(load_endpoint, bundle_bytes=export_response.body, filename="normal_modes_geometry.tar.gz")

    assert loaded.available_channels == ["atom_numbers", "atom_masses_amu", "coords_bohr", "velocities_bohr_per_au_time"]
    assert loaded.has_electronics is False
    assert loaded.n_states is None
    assert loaded.n_transition is None

    compare_response = _invoke_endpoint(
        compare_endpoint,
        DistributionCompareGeometryRequest(
            distribution_ids=[loaded.distribution_id],
            measurement_kind="bond",
            atom_indices=[0, 1],
        )
    )

    assert compare_response.measurement_kind == "bond"
    assert compare_response.unit == "Angstrom"
    assert compare_response.series[0].sample_count == sample_response.sample_count


def test_save_normal_modes_geometry_bundle_writes_bundle_under_browse_root(tmp_path: Path) -> None:
    app = create_app(store=_build_store(), cache=SeriesLRUCache(max_entries=32), browse_root=tmp_path)
    sample_endpoint = _find_endpoint(app, "/api/normal-modes/sample-text", "POST")
    save_endpoint = _find_endpoint(
        app,
        "/api/normal-modes/sample-batches/{batch_id}/export-geometry/save",
        "POST",
    )

    sample_response = sample_endpoint(_sampling_request(seed=55))
    save_response = save_endpoint(
        sample_response.batch_id,
        NormalModesGeometrySaveRequest(
            directory="exports/normal_modes",
            filename="custom geometry bundle",
        ),
    )

    assert save_response.status == "ok"
    assert save_response.saved_relative_path == "exports/normal_modes/custom geometry bundle"
    saved_path = Path(save_response.saved_absolute_path)
    assert saved_path == tmp_path / "exports" / "normal_modes" / "custom geometry bundle"
    assert saved_path.is_dir()
    assert (saved_path / "manifest.json").is_file()
    assert (saved_path / "meta" / "sample_ids.json").is_file()
    assert (saved_path / "sampling" / "atom_numbers.npy").is_file()
    assert (saved_path / "sampling" / "atom_masses_amu.npy").is_file()
    assert (saved_path / "sampling" / "coords_bohr.npy").is_file()
    assert (saved_path / "sampling" / "all_structures.xyz").is_file()

    manifest = json.loads((saved_path / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["n_samples"] == sample_response.sample_count
    assert manifest["n_atoms"] == sample_response.n_atoms
    assert np.load(saved_path / "sampling" / "atom_masses_amu.npy").shape == (sample_response.n_atoms,)


def test_save_normal_modes_geometry_bundle_strips_archive_suffix_for_directory_name(tmp_path: Path) -> None:
    app = create_app(store=_build_store(), cache=SeriesLRUCache(max_entries=32), browse_root=tmp_path)
    sample_endpoint = _find_endpoint(app, "/api/normal-modes/sample-text", "POST")
    save_endpoint = _find_endpoint(
        app,
        "/api/normal-modes/sample-batches/{batch_id}/export-geometry/save",
        "POST",
    )

    sample_response = sample_endpoint(_sampling_request(seed=551))
    save_response = save_endpoint(
        sample_response.batch_id,
        NormalModesGeometrySaveRequest(
            directory="exports/normal_modes",
            filename="custom geometry bundle.tar.gz",
        ),
    )

    assert save_response.saved_relative_path == "exports/normal_modes/custom geometry bundle"
    assert Path(save_response.saved_absolute_path).is_dir()


def test_save_normal_modes_geometry_bundle_rejects_absolute_directory(tmp_path: Path) -> None:
    app = create_app(store=_build_store(), cache=SeriesLRUCache(max_entries=32), browse_root=tmp_path)
    sample_endpoint = _find_endpoint(app, "/api/normal-modes/sample-text", "POST")
    save_endpoint = _find_endpoint(
        app,
        "/api/normal-modes/sample-batches/{batch_id}/export-geometry/save",
        "POST",
    )

    sample_response = sample_endpoint(_sampling_request(seed=56))

    with pytest.raises(HTTPException) as exc_info:
        save_endpoint(
            sample_response.batch_id,
            NormalModesGeometrySaveRequest(directory=str(tmp_path), filename="absolute-path.tar.gz"),
        )

    assert exc_info.value.status_code == 400
    assert "Absolute paths are not allowed" in str(exc_info.value.detail)


def test_save_normal_modes_geometry_bundle_rejects_path_outside_browse_root(tmp_path: Path) -> None:
    app = create_app(store=_build_store(), cache=SeriesLRUCache(max_entries=32), browse_root=tmp_path)
    sample_endpoint = _find_endpoint(app, "/api/normal-modes/sample-text", "POST")
    save_endpoint = _find_endpoint(
        app,
        "/api/normal-modes/sample-batches/{batch_id}/export-geometry/save",
        "POST",
    )

    sample_response = sample_endpoint(_sampling_request(seed=57))

    with pytest.raises(HTTPException) as exc_info:
        save_endpoint(
            sample_response.batch_id,
            NormalModesGeometrySaveRequest(directory="../outside", filename="outside.tar.gz"),
        )

    assert exc_info.value.status_code == 403
    assert "outside the browse root" in str(exc_info.value.detail)


def test_save_normal_modes_geometry_bundle_rejects_existing_path(tmp_path: Path) -> None:
    app = create_app(store=_build_store(), cache=SeriesLRUCache(max_entries=32), browse_root=tmp_path)
    sample_endpoint = _find_endpoint(app, "/api/normal-modes/sample-text", "POST")
    save_endpoint = _find_endpoint(
        app,
        "/api/normal-modes/sample-batches/{batch_id}/export-geometry/save",
        "POST",
    )

    sample_response = sample_endpoint(_sampling_request(seed=58))
    target_dir = tmp_path / "exports" / "normal_modes"
    target_dir.mkdir(parents=True, exist_ok=True)
    target_path = target_dir / "existing"
    target_path.mkdir()

    with pytest.raises(HTTPException) as exc_info:
        save_endpoint(
            sample_response.batch_id,
            NormalModesGeometrySaveRequest(directory="exports/normal_modes", filename="existing.tar.gz"),
        )

    assert exc_info.value.status_code == 409
    assert "already exists" in str(exc_info.value.detail)


def test_export_normal_modes_bundle_rejects_missing_batch() -> None:
    app = create_app(store=_build_store(), cache=SeriesLRUCache(max_entries=32))
    export_endpoint = _find_endpoint(
        app,
        "/api/normal-modes/sample-batches/{batch_id}/export",
        "GET",
    )

    with pytest.raises(HTTPException) as exc_info:
        export_endpoint("missing-batch")

    assert exc_info.value.status_code == 404
    assert "sample batch not found" in str(exc_info.value.detail)


def test_export_normal_modes_geometry_bundle_rejects_missing_batch() -> None:
    app = create_app(store=_build_store(), cache=SeriesLRUCache(max_entries=32))
    export_endpoint = _find_endpoint(
        app,
        "/api/normal-modes/sample-batches/{batch_id}/export-geometry",
        "GET",
    )

    with pytest.raises(HTTPException) as exc_info:
        export_endpoint("missing-batch")

    assert exc_info.value.status_code == 404
    assert "sample batch not found" in str(exc_info.value.detail)


def test_save_normal_modes_geometry_bundle_rejects_missing_batch(tmp_path: Path) -> None:
    app = create_app(store=_build_store(), cache=SeriesLRUCache(max_entries=32), browse_root=tmp_path)
    save_endpoint = _find_endpoint(
        app,
        "/api/normal-modes/sample-batches/{batch_id}/export-geometry/save",
        "POST",
    )

    with pytest.raises(HTTPException) as exc_info:
        save_endpoint(
            "missing-batch",
            NormalModesGeometrySaveRequest(directory="exports/normal_modes", filename="missing.tar.gz"),
        )

    assert exc_info.value.status_code == 404
    assert "sample batch not found" in str(exc_info.value.detail)
