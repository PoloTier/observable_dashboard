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

# Keep tests runnable from repository root without requiring editable install.
REPO_ROOT = Path(__file__).resolve().parents[3]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from backend.server.app import create_app
from backend.server.cache import SeriesLRUCache
from backend.server.dataset_store import DatasetStore, TrajectoryRecord
from backend.server.distribution_bundle import (
    DISTRIBUTION_BUNDLE_KIND,
    DISTRIBUTION_BUNDLE_SCHEMA_VERSION,
    build_topology_signature,
)
from backend.server.models import (
    DistributionCompareGeometryRequest,
    DistributionCompareSpectrumRequest,
    DistributionSpectrumSeriesRequestItem,
    LoadDistributionPathRequest,
)


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
        input_path=Path("/tmp/distribution_compare_api.pkl"),
        meta={"source_pkl": "/tmp/distribution_compare_api.pkl"},
        defaults={},
        trajectories={"0": _build_traj("0")},
    )


def _make_app():
    return create_app(store=_build_store(), cache=SeriesLRUCache(max_entries=32))


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


def _json_bytes(value: object) -> bytes:
    return f"{json.dumps(value, indent=2, sort_keys=True)}\n".encode("utf-8")


def _npy_bytes(array: np.ndarray) -> bytes:
    buffer = io.BytesIO()
    np.save(buffer, np.asarray(array), allow_pickle=False)
    return buffer.getvalue()


def _default_atom_masses_amu(atom_numbers: np.ndarray) -> np.ndarray:
    mass_by_atomic_number = {
        1: 1.008,
        6: 12.011,
        7: 14.007,
        8: 15.999,
    }
    return np.asarray(
        [float(mass_by_atomic_number.get(int(value), max(float(value), 1.0))) for value in atom_numbers.tolist()],
        dtype=float,
    )


def _sampling_channel_entries(*, include_velocities: bool) -> list[dict[str, object]]:
    channels: list[dict[str, object]] = [
        {"name": "atom_numbers", "unit": None, "group": "sampling"},
        {"name": "atom_masses_amu", "unit": "amu", "group": "sampling"},
        {"name": "coords_bohr", "unit": "bohr", "group": "sampling"},
    ]
    if include_velocities:
        channels.append({"name": "velocities_bohr_per_au_time", "unit": "bohr/au_time", "group": "sampling"})
    return channels


def _electronic_channel_entries() -> list[dict[str, object]]:
    return [
        {"name": "state_energy_hartree", "unit": "Hartree", "group": "electronic"},
        {"name": "transition_pairs", "unit": None, "group": "electronic"},
        {"name": "transition_dipole_au", "unit": "a.u.", "group": "electronic"},
        {"name": "transition_intensity", "unit": "dimensionless", "group": "electronic"},
    ]


def _build_profile_entries(
    *,
    profile_id: str,
    bundle_label: str,
    topology_signature: str,
    sample_ids: list[str],
    n_samples: int,
    label: str | None = None,
    engine: str = "pyscf",
    method: str = "tddft",
    reference: str = "uks",
    xc: str = "b3lyp",
    basis: str = "6-31g*",
    n_excited_states: int = 2,
    state_energy_hartree: np.ndarray | None = None,
    transition_pairs: np.ndarray | None = None,
    transition_dipole_au: np.ndarray | None = None,
    transition_intensity: np.ndarray | None = None,
    success_count: int | None = None,
    failed_count: int | None = None,
    failed_samples: list[dict[str, object]] | None = None,
) -> tuple[dict[str, object], list[tuple[str, bytes]]]:
    transition_pairs = np.asarray(
        transition_pairs if transition_pairs is not None else [[0, 1], [0, 2]],
        dtype=int,
    )
    n_transition = int(transition_pairs.shape[0])
    n_states = max((int(np.max(transition_pairs)) + 1) if transition_pairs.size > 0 else 0, 3)
    if state_energy_hartree is None:
        state_energy_hartree = (
            np.tile((-76.1 + 0.25 * np.arange(n_states, dtype=float)).reshape(1, n_states), (n_samples, 1))
            + 0.03 * np.arange(n_samples, dtype=float).reshape(n_samples, 1)
        )
    else:
        state_energy_hartree = np.asarray(state_energy_hartree, dtype=float)
        n_states = int(state_energy_hartree.shape[1])
    if transition_dipole_au is None:
        transition_dipole_au = np.zeros((n_samples, n_transition, 3), dtype=float)
        for sample_idx in range(n_samples):
            for transition_idx in range(n_transition):
                transition_dipole_au[sample_idx, transition_idx] = np.asarray(
                    [
                        0.1 * float(sample_idx + 1),
                        0.05 * float(transition_idx + 1),
                        0.2 + 0.1 * float(transition_idx),
                    ],
                    dtype=float,
                )
    else:
        transition_dipole_au = np.asarray(transition_dipole_au, dtype=float)
    if transition_intensity is None:
        transition_intensity = (
            0.02
            + 0.01 * np.arange(n_samples, dtype=float).reshape(n_samples, 1)
            + 0.05 * np.arange(n_transition, dtype=float).reshape(1, n_transition)
        )
    else:
        transition_intensity = np.asarray(transition_intensity, dtype=float)

    success_count_value = int(success_count if success_count is not None else n_samples)
    failed_count_value = int(failed_count if failed_count is not None else 0)
    failed_samples_value = [dict(item) for item in list(failed_samples or [])]
    profile_label = str(label or profile_id)
    profile_manifest = {
        "profile_id": str(profile_id),
        "label": profile_label,
        "engine": str(engine),
        "method": str(method),
        "reference": str(reference),
        "xc": str(xc),
        "basis": str(basis),
        "n_excited_states": int(n_excited_states),
        "bundle_label": str(bundle_label),
        "topology_signature": str(topology_signature),
        "n_samples": int(n_samples),
        "sample_ids": list(sample_ids),
        "channels": _electronic_channel_entries(),
        "n_states": int(n_states),
        "n_transition": int(n_transition),
        "success_count": success_count_value,
        "failed_count": failed_count_value,
        "failed_samples": failed_samples_value,
        "assembled_at_utc": "2026-03-16T00:00:10.000Z",
    }
    root_index_item = {
        "id": str(profile_id),
        "label": profile_label,
        "path": f"electronics/{profile_id}",
        "engine": str(engine),
        "method": str(method),
        "reference": str(reference),
        "xc": str(xc),
        "basis": str(basis),
        "n_excited_states": int(n_excited_states),
        "success_count": success_count_value,
        "failed_count": failed_count_value,
    }
    entries = [
        (f"electronics/{profile_id}/manifest.json", _json_bytes(profile_manifest)),
        (f"electronics/{profile_id}/state_energy_hartree.npy", _npy_bytes(state_energy_hartree)),
        (f"electronics/{profile_id}/transition_pairs.npy", _npy_bytes(transition_pairs)),
        (f"electronics/{profile_id}/transition_dipole_au.npy", _npy_bytes(transition_dipole_au)),
        (f"electronics/{profile_id}/transition_intensity.npy", _npy_bytes(transition_intensity)),
    ]
    return root_index_item, entries


def _build_bundle_bytes(
    *,
    label: str = "Example Dist",
    manifest_kind: str = DISTRIBUTION_BUNDLE_KIND,
    atom_numbers: np.ndarray | None = None,
    atom_masses_amu: np.ndarray | None = None,
    coords_bohr: np.ndarray | None = None,
    include_velocities: bool = False,
    electronic_profiles: list[dict[str, object]] | None = None,
    extra_manifest: dict[str, object] | None = None,
    extra_entries: list[tuple[str, bytes]] | None = None,
    omit_member_paths: set[str] | None = None,
) -> bytes:
    atom_numbers = np.asarray(atom_numbers if atom_numbers is not None else [1, 6, 8, 1], dtype=int)
    atom_masses_amu = np.asarray(
        atom_masses_amu if atom_masses_amu is not None else _default_atom_masses_amu(atom_numbers),
        dtype=float,
    )
    coords_bohr = np.asarray(
        coords_bohr
        if coords_bohr is not None
        else np.asarray(
            [
                [
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [1.0, 1.0, 0.0],
                    [1.0, 1.0, 1.0],
                ],
                [
                    [0.0, 0.0, 0.0],
                    [2.0, 0.0, 0.0],
                    [2.0, 1.0, 0.0],
                    [2.0, 1.0, 1.0],
                ],
            ],
            dtype=float,
        ),
        dtype=float,
    )
    topology_signature = build_topology_signature(atom_numbers)
    sample_ids = [f"sample_{index:06d}" for index in range(int(coords_bohr.shape[0]))]

    profile_index_items: list[dict[str, object]] = []
    profile_entries: list[tuple[str, bytes]] = []
    for raw_profile in list(electronic_profiles or []):
        profile_index_item, current_entries = _build_profile_entries(
            profile_id=str(raw_profile.get("profile_id") or raw_profile.get("id") or "default"),
            bundle_label=str(label),
            topology_signature=topology_signature,
            sample_ids=sample_ids,
            n_samples=int(coords_bohr.shape[0]),
            label=(None if raw_profile.get("label") is None else str(raw_profile.get("label"))),
            engine=str(raw_profile.get("engine") or "pyscf"),
            method=str(raw_profile.get("method") or "tddft"),
            reference=str(raw_profile.get("reference") or "uks"),
            xc=str(raw_profile.get("xc") or "b3lyp"),
            basis=str(raw_profile.get("basis") or "6-31g*"),
            n_excited_states=int(raw_profile.get("n_excited_states") or 2),
            state_energy_hartree=raw_profile.get("state_energy_hartree"),  # type: ignore[arg-type]
            transition_pairs=raw_profile.get("transition_pairs"),  # type: ignore[arg-type]
            transition_dipole_au=raw_profile.get("transition_dipole_au"),  # type: ignore[arg-type]
            transition_intensity=raw_profile.get("transition_intensity"),  # type: ignore[arg-type]
            success_count=(None if raw_profile.get("success_count") is None else int(raw_profile["success_count"])),
            failed_count=(None if raw_profile.get("failed_count") is None else int(raw_profile["failed_count"])),
            failed_samples=(None if raw_profile.get("failed_samples") is None else list(raw_profile["failed_samples"])),
        )
        profile_index_items.append(profile_index_item)
        profile_entries.extend(current_entries)

    manifest: dict[str, object] = {
        "kind": manifest_kind,
        "schema_version": DISTRIBUTION_BUNDLE_SCHEMA_VERSION,
        "label": label,
        "source_name": f"{label}.tar.gz",
        "created_at_utc": "2026-03-16T00:00:00.000Z",
        "n_samples": int(coords_bohr.shape[0]),
        "n_atoms": int(coords_bohr.shape[1]),
        "topology_signature": topology_signature,
        "sampling_channels": _sampling_channel_entries(include_velocities=include_velocities),
        "electronics": {
            "default_profile_id": (None if not profile_index_items else str(profile_index_items[0]["id"])),
            "profiles": profile_index_items,
        },
        "batch_id": "bundle-demo",
        "sampling_method": "normal_modes_harmonic",
        "charge": 0,
        "multiplicity": 1,
        "seed": 11,
    }
    if extra_manifest:
        manifest.update(extra_manifest)

    entries: list[tuple[str, bytes]] = [
        ("manifest.json", _json_bytes(manifest)),
        ("meta/sample_ids.json", _json_bytes(sample_ids)),
        ("sampling/atom_numbers.npy", _npy_bytes(atom_numbers)),
        ("sampling/atom_masses_amu.npy", _npy_bytes(atom_masses_amu)),
        ("sampling/coords_bohr.npy", _npy_bytes(coords_bohr)),
    ]
    if include_velocities:
        entries.append(("sampling/velocities_bohr_per_au_time.npy", _npy_bytes(coords_bohr * 0.05)))
    entries.extend(profile_entries)
    if extra_entries:
        entries.extend(extra_entries)
    if omit_member_paths:
        entries = [entry for entry in entries if entry[0] not in set(omit_member_paths)]

    tar_buffer = io.BytesIO()
    with tarfile.open(fileobj=tar_buffer, mode="w:gz") as archive:
        for path, payload in entries:
            info = tarfile.TarInfo(name=path)
            info.size = len(payload)
            archive.addfile(info, io.BytesIO(payload))
    return tar_buffer.getvalue()


def _write_bundle_directory(bundle_dir: Path, **kwargs) -> Path:
    bundle_dir.mkdir(parents=True, exist_ok=False)
    bundle_bytes = _build_bundle_bytes(**kwargs)
    with tarfile.open(fileobj=io.BytesIO(bundle_bytes), mode="r:gz") as archive:
        for member in archive.getmembers():
            if not member.isfile():
                continue
            extracted = archive.extractfile(member)
            if extracted is None:
                continue
            target_path = bundle_dir / member.name
            target_path.parent.mkdir(parents=True, exist_ok=True)
            target_path.write_bytes(extracted.read())
    return bundle_dir


def _upload_bundle(app: object, bundle_bytes: bytes, *, filename: str = "bundle.tar.gz") -> dict[str, object]:
    endpoint = _find_endpoint(app, "/api/distributions/load", "POST")
    response = _invoke_endpoint(endpoint, bundle_bytes=bundle_bytes, filename=filename)
    return response.model_dump()


def test_load_distribution_bundle_api_accepts_minimal_geometry_bundle() -> None:
    app = _make_app()

    payload = _upload_bundle(app, _build_bundle_bytes())

    assert payload["label"] == "Example Dist"
    assert payload["n_samples"] == 2
    assert payload["n_atoms"] == 4
    assert payload["has_electronics"] is False
    assert payload["default_electronic_profile_id"] is None
    assert payload["electronic_profiles"] == []
    assert payload["available_channels"] == ["atom_numbers", "atom_masses_amu", "coords_bohr"]


def test_load_distribution_bundle_api_rejects_legacy_channels_field() -> None:
    app = _make_app()
    endpoint = _find_endpoint(app, "/api/distributions/load", "POST")

    with pytest.raises(HTTPException) as exc_info:
        _invoke_endpoint(
            endpoint,
            bundle_bytes=_build_bundle_bytes(extra_manifest={"channels": ["coords_bohr"]}),
            filename="legacy_channels.tar.gz",
        )

    assert exc_info.value.status_code == 422
    assert "channels" in str(exc_info.value.detail)


def test_load_distribution_bundle_api_accepts_multiple_electronic_profiles() -> None:
    app = _make_app()

    payload = _upload_bundle(
        app,
        _build_bundle_bytes(
            label="Electronic Dist",
            electronic_profiles=[
                {
                    "profile_id": "td_b3lyp",
                    "label": "TDDFT B3LYP/6-31G*",
                },
                {
                    "profile_id": "td_pbe0",
                    "label": "TDDFT PBE0/def2-SVP",
                    "xc": "pbe0",
                    "basis": "def2-svp",
                    "transition_pairs": np.asarray([[0, 1], [1, 2]], dtype=int),
                },
            ],
        ),
        filename="electronic_profiles.tar.gz",
    )

    assert payload["has_electronics"] is True
    assert payload["default_electronic_profile_id"] == "td_b3lyp"
    assert [item["profile_id"] for item in payload["electronic_profiles"]] == ["td_b3lyp", "td_pbe0"]
    assert payload["electronic_profiles"][0]["n_states"] == 3
    assert payload["electronic_profiles"][0]["n_transition"] == 2
    assert payload["electronic_profiles"][1]["failed_count"] == 0


def test_compare_geometry_api_accepts_bundle_with_profiles() -> None:
    app = _make_app()
    compare_endpoint = _find_endpoint(app, "/api/distributions/compare-geometry", "POST")

    dist_payload = _upload_bundle(
        app,
        _build_bundle_bytes(
            label="Geometry Dist",
            electronic_profiles=[{"profile_id": "td_b3lyp", "label": "TDDFT B3LYP/6-31G*"}],
        ),
        filename="geometry_with_profiles.tar.gz",
    )

    compare_payload = _invoke_endpoint(
        compare_endpoint,
        DistributionCompareGeometryRequest(
            distribution_ids=[dist_payload["distribution_id"]],
            measurement_kind="bond",
            atom_indices=[0, 1],
        ),
    ).model_dump()

    assert compare_payload["measurement_kind"] == "bond"
    assert compare_payload["unit"] == "Angstrom"
    assert compare_payload["series"][0]["sample_count"] == 2


def test_compare_spectrum_api_supports_same_distribution_different_profiles() -> None:
    app = _make_app()
    compare_endpoint = _find_endpoint(app, "/api/distributions/compare-spectrum", "POST")

    dist_payload = _upload_bundle(
        app,
        _build_bundle_bytes(
            label="Bundle A",
            electronic_profiles=[
                {
                    "profile_id": "td_b3lyp",
                    "label": "TDDFT B3LYP/6-31G*",
                },
                {
                    "profile_id": "td_cam",
                    "label": "TDDFT CAM-B3LYP/def2-SVP",
                    "xc": "cam-b3lyp",
                    "basis": "def2-svp",
                    "state_energy_hartree": np.asarray(
                        [
                            [-76.2, -75.98, -75.73],
                            [-76.17, -75.93, -75.70],
                        ],
                        dtype=float,
                    ),
                },
            ],
        ),
        filename="bundle_a.tar.gz",
    )

    payload = _invoke_endpoint(
        compare_endpoint,
        DistributionCompareSpectrumRequest(
            series=[
                DistributionSpectrumSeriesRequestItem(
                    distribution_id=str(dist_payload["distribution_id"]),
                    profile_id="td_b3lyp",
                ),
                DistributionSpectrumSeriesRequestItem(
                    distribution_id=str(dist_payload["distribution_id"]),
                    profile_id="td_cam",
                ),
            ],
            delta_ev=0.05,
        ),
    ).model_dump()

    assert len(payload["series"]) == 2
    assert payload["skipped"] == []
    assert payload["available_pairs"] == [
        {"pair": [0, 1], "label": "0->1"},
        {"pair": [0, 2], "label": "0->2"},
    ]
    assert {item["profile_id"] for item in payload["series"]} == {"td_b3lyp", "td_cam"}
    assert payload["series"][0]["series_label"].startswith("Bundle A | ")


def test_compare_spectrum_api_supports_different_distribution_profile_combinations() -> None:
    app = _make_app()
    compare_endpoint = _find_endpoint(app, "/api/distributions/compare-spectrum", "POST")

    dist_a = _upload_bundle(
        app,
        _build_bundle_bytes(
            label="Distribution A",
            electronic_profiles=[
                {"profile_id": "b3lyp", "label": "B3LYP"},
                {"profile_id": "pbe0", "label": "PBE0", "xc": "pbe0", "basis": "def2-svp"},
            ],
        ),
        filename="dist_a.tar.gz",
    )
    dist_b = _upload_bundle(
        app,
        _build_bundle_bytes(
            label="Distribution B",
            electronic_profiles=[
                {
                    "profile_id": "cam",
                    "label": "CAM-B3LYP",
                    "xc": "cam-b3lyp",
                    "basis": "def2-tzvp",
                },
            ],
        ),
        filename="dist_b.tar.gz",
    )

    payload = _invoke_endpoint(
        compare_endpoint,
        DistributionCompareSpectrumRequest(
            series=[
                DistributionSpectrumSeriesRequestItem(
                    distribution_id=str(dist_a["distribution_id"]),
                    profile_id="pbe0",
                ),
                DistributionSpectrumSeriesRequestItem(
                    distribution_id=str(dist_b["distribution_id"]),
                    profile_id="cam",
                ),
            ],
            delta_ev=0.05,
        ),
    ).model_dump()

    assert len(payload["series"]) == 2
    assert {item["distribution_label"] for item in payload["series"]} == {"Distribution A", "Distribution B"}
    assert {item["profile_label"] for item in payload["series"]} == {"PBE0", "CAM-B3LYP"}
    for series in payload["series"]:
        total_y_values = np.asarray(series["total_y_normalized"], dtype=float)
        assert total_y_values.shape == (800,)
        assert np.all(np.isfinite(total_y_values))
        assert np.max(total_y_values) == pytest.approx(1.0, rel=1.0e-10)


def test_compare_spectrum_api_returns_total_spectra_when_no_common_pairs_exist() -> None:
    app = _make_app()
    compare_endpoint = _find_endpoint(app, "/api/distributions/compare-spectrum", "POST")

    dist_a = _upload_bundle(
        app,
        _build_bundle_bytes(
            label="Pair A",
            electronic_profiles=[{"profile_id": "profile_a", "label": "Profile A"}],
        ),
    )
    dist_b = _upload_bundle(
        app,
        _build_bundle_bytes(
            label="Pair B",
            electronic_profiles=[
                {
                    "profile_id": "profile_b",
                    "label": "Profile B",
                    "transition_pairs": np.asarray([[1, 2], [0, 3]], dtype=int),
                    "state_energy_hartree": np.asarray(
                        [
                            [-76.3, -76.1, -75.9, -75.6],
                            [-76.2, -76.0, -75.8, -75.5],
                        ],
                        dtype=float,
                    ),
                }
            ],
        ),
    )

    payload = _invoke_endpoint(
        compare_endpoint,
        DistributionCompareSpectrumRequest(
            series=[
                DistributionSpectrumSeriesRequestItem(
                    distribution_id=str(dist_a["distribution_id"]),
                    profile_id="profile_a",
                ),
                DistributionSpectrumSeriesRequestItem(
                    distribution_id=str(dist_b["distribution_id"]),
                    profile_id="profile_b",
                ),
            ],
            delta_ev=0.05,
        ),
    ).model_dump()

    assert payload["available_pairs"] == []
    assert len(payload["series"]) == 2
    for series in payload["series"]:
        assert series["pair_curves"] == []


def test_compare_spectrum_api_skips_selected_profiles_without_valid_transitions() -> None:
    app = _make_app()
    compare_endpoint = _find_endpoint(app, "/api/distributions/compare-spectrum", "POST")

    dist_ok = _upload_bundle(
        app,
        _build_bundle_bytes(
            label="Valid Bundle",
            electronic_profiles=[{"profile_id": "valid", "label": "Valid"}],
        ),
    )
    dist_bad = _upload_bundle(
        app,
        _build_bundle_bytes(
            label="Invalid Bundle",
            electronic_profiles=[
                {
                    "profile_id": "invalid",
                    "label": "Invalid",
                    "transition_intensity": np.asarray(
                        [
                            [np.nan, np.nan],
                            [np.nan, np.nan],
                        ],
                        dtype=float,
                    ),
                }
            ],
        ),
    )

    payload = _invoke_endpoint(
        compare_endpoint,
        DistributionCompareSpectrumRequest(
            series=[
                DistributionSpectrumSeriesRequestItem(
                    distribution_id=str(dist_ok["distribution_id"]),
                    profile_id="valid",
                ),
                DistributionSpectrumSeriesRequestItem(
                    distribution_id=str(dist_bad["distribution_id"]),
                    profile_id="invalid",
                ),
            ],
        ),
    ).model_dump()

    assert len(payload["series"]) == 1
    assert payload["series"][0]["profile_id"] == "valid"
    assert len(payload["skipped"]) == 1
    assert payload["skipped"][0]["profile_id"] == "invalid"
    assert "no valid electronic transitions" in payload["skipped"][0]["reason"]


def test_load_distribution_bundle_from_browse_root_path_accepts_directory(tmp_path: Path) -> None:
    _write_bundle_directory(
        tmp_path / "server_bundle",
        label="Server Bundle Directory",
        electronic_profiles=[{"profile_id": "b3lyp", "label": "B3LYP"}],
    )

    app = create_app(store=_build_store(), cache=SeriesLRUCache(max_entries=32), browse_root=tmp_path)
    files_endpoint = _find_endpoint(app, "/api/distributions/files", "GET")
    load_path_endpoint = _find_endpoint(app, "/api/distributions/load-path", "POST")

    files_payload = _invoke_endpoint(files_endpoint).model_dump()
    entry = next(item for item in files_payload["entries"] if item["name"] == "server_bundle")
    assert entry["loadable"] is True
    assert entry["kind"] == "directory"

    payload = _invoke_endpoint(
        load_path_endpoint,
        LoadDistributionPathRequest(path="server_bundle"),
    ).model_dump()

    assert payload["label"] == "Server Bundle Directory"
    assert payload["has_electronics"] is True
    assert payload["default_electronic_profile_id"] == "b3lyp"
    assert payload["electronic_profiles"][0]["profile_id"] == "b3lyp"


def test_load_distribution_bundle_from_browse_root_path_rejects_non_bundle_directory(tmp_path: Path) -> None:
    plain_dir = tmp_path / "plain_directory"
    plain_dir.mkdir()
    (plain_dir / "notes.txt").write_text("not a bundle\n", encoding="utf-8")

    app = create_app(store=_build_store(), cache=SeriesLRUCache(max_entries=32), browse_root=tmp_path)
    files_endpoint = _find_endpoint(app, "/api/distributions/files", "GET")
    load_path_endpoint = _find_endpoint(app, "/api/distributions/load-path", "POST")

    files_payload = _invoke_endpoint(files_endpoint).model_dump()
    entry = next(item for item in files_payload["entries"] if item["name"] == "plain_directory")
    assert entry["loadable"] is False
    assert entry["kind"] == "directory"

    with pytest.raises(HTTPException) as exc_info:
        _invoke_endpoint(
            load_path_endpoint,
            LoadDistributionPathRequest(path="plain_directory"),
        )

    assert exc_info.value.status_code == 422
    assert "manifest.json" in str(exc_info.value.detail)
