from __future__ import annotations

from pathlib import Path
import sys

import numpy as np
import pytest
from fastapi import HTTPException

# Keep tests runnable from repository root without requiring editable install.
REPO_ROOT = Path(__file__).resolve().parents[3]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from backend.server.app import create_app
from backend.server.cache import SeriesLRUCache
from backend.server.dataset_store import DatasetStore, TrajectoryRecord, build_empty_dataset_store
from backend.server.models import LoadDatasetRequest


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


def _build_loaded_store(input_path: Path, *, traj_id: str = "0") -> DatasetStore:
    return DatasetStore(
        input_path=input_path,
        meta={"source_pkl": str(input_path.resolve()), "dataset_loaded": True},
        defaults={
            "panels": [{"observable": "etot", "indices": []}],
            "plot": {"show_ensemble_by_default": True, "show_all_traces_in_all_mode": False},
            "nac": {"mode": "norm"},
            "ui": {"default_panel_count": 1},
        },
        trajectories={traj_id: _build_traj(traj_id)},
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


def test_empty_store_bootstrap_marks_dataset_unloaded(tmp_path: Path) -> None:
    config_path = tmp_path / "viz_config.yaml"
    config_path.write_text("ui:\n  default_panel_count: 1\n", encoding="utf-8")
    store = build_empty_dataset_store(config_path)
    app = create_app(store=store, cache=SeriesLRUCache(max_entries=8), browse_root=tmp_path)
    endpoint = _find_endpoint(app, "/api/bootstrap", "GET")

    payload = endpoint()

    assert payload.meta["dataset_loaded"] is False
    assert payload.meta["source_pkl"] == ""
    assert payload.traj_ids == []
    assert payload.defaults["ui"]["default_panel_count"] == 1


def test_files_endpoint_lists_root_and_filters_hidden_and_outside_links(tmp_path: Path) -> None:
    config_path = tmp_path / "viz_config.yaml"
    config_path.write_text("ui:\n  default_panel_count: 1\n", encoding="utf-8")
    visible_dir = tmp_path / "runs"
    visible_dir.mkdir()
    visible_file = tmp_path / "alpha.pkl"
    visible_file.write_text("placeholder", encoding="utf-8")
    other_file = tmp_path / "notes.txt"
    other_file.write_text("placeholder", encoding="utf-8")
    hidden_file = tmp_path / ".secret.pkl"
    hidden_file.write_text("placeholder", encoding="utf-8")
    outside_dir = tmp_path.parent / "external_target"
    outside_dir.mkdir(exist_ok=True)
    outside_file = outside_dir / "outside.pkl"
    outside_file.write_text("placeholder", encoding="utf-8")
    outside_link = tmp_path / "outside-link.pkl"
    outside_link.symlink_to(outside_file)

    store = build_empty_dataset_store(config_path)
    app = create_app(store=store, cache=SeriesLRUCache(max_entries=8), browse_root=tmp_path)
    endpoint = _find_endpoint(app, "/api/files", "GET")

    payload = endpoint()

    assert payload.root_label == str(tmp_path.resolve())
    assert payload.current_path == ""
    assert payload.parent_path is None
    assert [(entry.kind, entry.name) for entry in payload.entries] == [
        ("directory", "runs"),
        ("file", "alpha.pkl"),
        ("file", "notes.txt"),
        ("file", "viz_config.yaml"),
    ]
    alpha_entry = next(entry for entry in payload.entries if entry.name == "alpha.pkl")
    assert alpha_entry.relative_path == "alpha.pkl"
    assert alpha_entry.loadable is True
    notes_entry = next(entry for entry in payload.entries if entry.name == "notes.txt")
    assert notes_entry.loadable is False


def test_files_endpoint_rejects_path_escape(tmp_path: Path) -> None:
    config_path = tmp_path / "viz_config.yaml"
    config_path.write_text("ui:\n  default_panel_count: 1\n", encoding="utf-8")
    store = build_empty_dataset_store(config_path)
    app = create_app(store=store, cache=SeriesLRUCache(max_entries=8), browse_root=tmp_path)
    endpoint = _find_endpoint(app, "/api/files", "GET")

    with pytest.raises(HTTPException) as exc_info:
        endpoint("../")
    assert exc_info.value.status_code == 403


def test_load_dataset_activates_store_and_clears_caches(tmp_path: Path) -> None:
    config_path = tmp_path / "viz_config.yaml"
    config_path.write_text("ui:\n  default_panel_count: 1\n", encoding="utf-8")
    target_file = tmp_path / "loaded.pkl"
    target_file.write_text("placeholder", encoding="utf-8")
    initial_store = build_empty_dataset_store(config_path)
    cache = SeriesLRUCache(max_entries=8)
    mol3d_cache = SeriesLRUCache(max_entries=8)
    cache.put(("series",), {"ok": True})
    mol3d_cache.put(("mol3d",), {"ok": True})

    def _loader(input_path: Path) -> DatasetStore:
        return _build_loaded_store(input_path, traj_id="7")

    app = create_app(
        store=initial_store,
        cache=cache,
        mol3d_cache=mol3d_cache,
        load_store_from_path=_loader,
        browse_root=tmp_path,
    )
    load_endpoint = _find_endpoint(app, "/api/load-dataset", "POST")
    bootstrap_endpoint = _find_endpoint(app, "/api/bootstrap", "GET")

    response = load_endpoint(LoadDatasetRequest(path="loaded.pkl"))
    bootstrap = bootstrap_endpoint()

    assert response.status == "ok"
    assert response.traj_count == 1
    assert response.source_pkl == str(target_file.resolve())
    assert response.dataset_revision == 2
    assert response.cleared_series_cache_entries == 1
    assert response.cleared_mol3d_cache_entries == 1
    assert bootstrap.meta["dataset_loaded"] is True
    assert bootstrap.meta["source_pkl"] == str(target_file.resolve())
    assert bootstrap.traj_ids == ["7"]


def test_refresh_dataset_rejects_empty_state(tmp_path: Path) -> None:
    config_path = tmp_path / "viz_config.yaml"
    config_path.write_text("ui:\n  default_panel_count: 1\n", encoding="utf-8")
    store = build_empty_dataset_store(config_path)
    app = create_app(
        store=store,
        cache=SeriesLRUCache(max_entries=8),
        load_store_from_path=lambda input_path: _build_loaded_store(input_path),
        browse_root=tmp_path,
    )
    endpoint = _find_endpoint(app, "/api/refresh-dataset", "POST")

    with pytest.raises(HTTPException) as exc_info:
        endpoint()
    assert exc_info.value.status_code == 409
    assert "load-dataset" in str(exc_info.value.detail)
