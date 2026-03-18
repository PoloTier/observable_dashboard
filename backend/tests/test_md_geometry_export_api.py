from __future__ import annotations

import asyncio
import io
import json
from pathlib import Path
import sys
import tarfile

import h5py
import numpy as np
import pytest
from fastapi import HTTPException

# Keep tests runnable from repository root without requiring editable install.
REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from backend.server.app import create_app
from backend.server.cache import SeriesLRUCache
from backend.server.dataset_store import DatasetStore, TrajectoryRecord
from backend.server.models import DistributionCompareGeometryRequest


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
        input_path=Path("/tmp/md_geometry_export_api.pkl"),
        meta={"source_pkl": "/tmp/md_geometry_export_api.pkl"},
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


def _xyz_fixture_text() -> str:
    return (
        "2\n"
        "frame=0\n"
        "H 0.0 0.0 0.0\n"
        "O 1.0 0.0 0.0\n"
        "2\n"
        "frame=1\n"
        "H 0.0 0.0 0.1\n"
        "O 1.1 0.0 0.0\n"
        "2\n"
        "frame=2\n"
        "H 0.0 0.0 0.2\n"
        "O 1.2 0.0 0.0\n"
    )


def _write_standard_pimd_h5(path: Path) -> bytes:
    coords = np.asarray(
        [
            [
                [[0.0, 0.0, 0.0], [2.0, 0.0, 0.0]],
                [[0.2, 0.0, 0.0], [2.2, 0.0, 0.0]],
            ],
            [
                [[0.0, 0.1, 0.0], [2.0, 0.1, 0.0]],
                [[0.2, 0.1, 0.0], [2.2, 0.1, 0.0]],
            ],
            [
                [[0.0, 0.2, 0.0], [2.0, 0.2, 0.0]],
                [[0.2, 0.2, 0.0], [2.2, 0.2, 0.0]],
            ],
        ],
        dtype=float,
    )
    with h5py.File(path, "w") as handle:
        handle.attrs["schema_name"] = "observable_dashboard_pimd"
        handle.attrs["schema_version"] = 1
        handle.attrs["coord_unit"] = "bohr"
        handle.create_dataset("coords", data=coords)
        handle.create_dataset("step", data=np.asarray([4, 8, 12], dtype=np.int64))
        handle.create_dataset("coord_frame_index", data=np.asarray([1, 2, 3], dtype=np.int64))
        handle.create_dataset("atom_numbers", data=np.asarray([1, 8], dtype=np.int32))
    return path.read_bytes()


def test_export_md_xyz_geometry_bundle_contains_geometry_exchange_payloads() -> None:
    app = create_app(store=_build_store(), cache=SeriesLRUCache(max_entries=32))
    export_endpoint = _find_endpoint(app, "/api/md/export-geometry-bundle", "POST")

    export_response = _invoke_endpoint(
        export_endpoint,
        source_kind="md_xyz",
        source_name="sample.xyz",
        start_frame=1,
        end_frame=2,
        frame_stride=1,
        charge=-1,
        multiplicity=2,
        bead_start=None,
        bead_end=None,
        bead_stride=1,
        source_bytes=_xyz_fixture_text().encode("utf-8"),
    )

    assert export_response.status_code == 200
    assert export_response.media_type == "application/gzip"
    assert "attachment;" in export_response.headers["content-disposition"].lower()

    with tarfile.open(fileobj=io.BytesIO(export_response.body), mode="r:gz") as archive:
        names = set(archive.getnames())
        assert "manifest.json" in names
        assert "meta/sample_ids.json" in names
        assert "meta/sample_metadata.json" in names
        assert "sampling/atom_numbers.npy" in names
        assert "sampling/atom_masses_amu.npy" in names
        assert "sampling/coords_bohr.npy" in names
        assert "sampling/all_structures.xyz" in names

        manifest = json.load(archive.extractfile("manifest.json"))
        sample_ids = json.load(archive.extractfile("meta/sample_ids.json"))
        sample_metadata = json.load(archive.extractfile("meta/sample_metadata.json"))
        coords_bohr = np.load(io.BytesIO(archive.extractfile("sampling/coords_bohr.npy").read()))
        atom_numbers = np.load(io.BytesIO(archive.extractfile("sampling/atom_numbers.npy").read()))
        xyz_text = archive.extractfile("sampling/all_structures.xyz").read().decode("utf-8")

    assert manifest["kind"] == "trajectory_sampling"
    assert manifest["schema_version"] == 4
    assert manifest["source_name"] == "sample.xyz"
    assert manifest["source_kind"] == "md_xyz"
    assert manifest["sampling_method"] == "trajectory_strided_sampling"
    assert manifest["charge"] == -1
    assert manifest["multiplicity"] == 2
    assert manifest["n_samples"] == 2
    assert manifest["n_atoms"] == 2
    assert manifest["sampling_channels"] == [
        {"name": "atom_numbers", "unit": None, "group": "sampling"},
        {"name": "atom_masses_amu", "unit": "amu", "group": "sampling"},
        {"name": "coords_bohr", "unit": "bohr", "group": "sampling"},
    ]
    assert manifest["electronics"] == {"default_profile_id": None, "profiles": []}
    assert len(sample_ids) == 2
    assert coords_bohr.shape == (2, 2, 3)
    assert atom_numbers.tolist() == [1, 8]
    assert sample_metadata[0]["frame_index"] == 1
    assert sample_metadata[0]["frame_ordinal"] == 1
    assert sample_metadata[0]["bead_index"] is None
    assert sample_metadata[0]["source_step"] is None
    assert sample_metadata[1]["frame_index"] == 2
    xyz_lines = xyz_text.strip().splitlines()
    assert xyz_lines[0] == "2"
    assert "sample_idx=0" in xyz_lines[1]
    assert "frame_index=1" in xyz_lines[1]


def test_exported_md_xyz_geometry_bundle_loads_into_distribution_compare() -> None:
    app = create_app(store=_build_store(), cache=SeriesLRUCache(max_entries=32))
    export_endpoint = _find_endpoint(app, "/api/md/export-geometry-bundle", "POST")
    load_endpoint = _find_endpoint(app, "/api/distributions/load", "POST")
    compare_endpoint = _find_endpoint(app, "/api/distributions/compare-geometry", "POST")

    export_response = _invoke_endpoint(
        export_endpoint,
        source_kind="md_xyz",
        source_name="sample.xyz",
        start_frame=0,
        end_frame=2,
        frame_stride=1,
        charge=0,
        multiplicity=1,
        bead_start=None,
        bead_end=None,
        bead_stride=1,
        source_bytes=_xyz_fixture_text().encode("utf-8"),
    )
    loaded = _invoke_endpoint(load_endpoint, bundle_bytes=export_response.body, filename="trajectory_geometry.tar.gz")

    assert loaded.available_channels == ["atom_numbers", "atom_masses_amu", "coords_bohr"]
    assert loaded.has_electronics is False
    compare_response = _invoke_endpoint(
        compare_endpoint,
        DistributionCompareGeometryRequest(
            distribution_ids=[loaded.distribution_id],
            measurement_kind="bond",
            atom_indices=[0, 1],
        ),
    )

    assert compare_response.measurement_kind == "bond"
    assert compare_response.unit == "Angstrom"
    assert compare_response.series[0].sample_count == 3


def test_export_pimd_geometry_bundle_contains_frame_bead_samples(tmp_path: Path) -> None:
    app = create_app(store=_build_store(), cache=SeriesLRUCache(max_entries=32))
    export_endpoint = _find_endpoint(app, "/api/md/export-geometry-bundle", "POST")
    source_bytes = _write_standard_pimd_h5(tmp_path / "sample_pimd.h5")

    export_response = _invoke_endpoint(
        export_endpoint,
        source_kind="pimd_h5",
        source_name="sample_pimd.h5",
        start_frame=0,
        end_frame=2,
        frame_stride=2,
        charge=0,
        multiplicity=1,
        bead_start=0,
        bead_end=1,
        bead_stride=1,
        source_bytes=source_bytes,
    )

    assert export_response.status_code == 200
    with tarfile.open(fileobj=io.BytesIO(export_response.body), mode="r:gz") as archive:
        manifest = json.load(archive.extractfile("manifest.json"))
        sample_metadata = json.load(archive.extractfile("meta/sample_metadata.json"))
        coords_bohr = np.load(io.BytesIO(archive.extractfile("sampling/coords_bohr.npy").read()))

    assert manifest["kind"] == "trajectory_sampling"
    assert manifest["source_kind"] == "pimd_h5"
    assert manifest["sampling_method"] == "trajectory_strided_sampling"
    assert manifest["n_samples"] == 4
    assert coords_bohr.shape == (4, 2, 3)
    assert sample_metadata[0]["frame_index"] == 0
    assert sample_metadata[0]["bead_index"] == 0
    assert sample_metadata[0]["source_step"] == 4
    assert sample_metadata[0]["coord_frame_index"] == 1
    assert sample_metadata[1]["frame_index"] == 0
    assert sample_metadata[1]["bead_index"] == 1
    assert sample_metadata[2]["frame_index"] == 2
    assert sample_metadata[2]["bead_index"] == 0
    assert sample_metadata[2]["source_step"] == 12
    assert sample_metadata[2]["coord_frame_index"] == 3


def test_export_md_geometry_bundle_rejects_invalid_frame_range() -> None:
    app = create_app(store=_build_store(), cache=SeriesLRUCache(max_entries=32))
    export_endpoint = _find_endpoint(app, "/api/md/export-geometry-bundle", "POST")

    with pytest.raises(HTTPException) as exc_info:
        _invoke_endpoint(
            export_endpoint,
            source_kind="md_xyz",
            source_name="sample.xyz",
            start_frame=1,
            end_frame=9,
            frame_stride=1,
            charge=0,
            multiplicity=1,
            bead_start=None,
            bead_end=None,
            bead_stride=1,
            source_bytes=_xyz_fixture_text().encode("utf-8"),
        )

    assert exc_info.value.status_code == 422
    assert "frame end index out of range" in str(exc_info.value.detail)
