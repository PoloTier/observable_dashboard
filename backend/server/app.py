from __future__ import annotations

import json
import logging
import math
import secrets
import shutil
from threading import Lock
import time
from typing import Any, Callable

from fastapi import Body, FastAPI, HTTPException, Query, Request
from fastapi.responses import HTMLResponse, FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pathlib import Path
import numpy as np

from backend.config import ALLOWED_OBSERVABLES, required_index_count
from backend.server.cache import SeriesLRUCache
from backend.server.compute import (
    RENORM_MEAN_CI95_BOOTSTRAP_MODE,
    aggregate_matrix_renorm_mean_ci95_bootstrap,
    aggregate_scalar_series_by_mode,
    compute_observable_series,
)
from backend.server.distribution_analysis import (
    build_soap_umap_projection,
    build_windowed_geometry_comparison,
    build_windowed_soap_umap_projection,
)
from backend.server.distribution_bundle import (
    DistributionBundle,
    ElectronicProfile,
    collect_absorption_excitation_energies_ev,
    collect_valid_absorption_transition_pairs,
    compute_absorption_spectrum,
    compute_geometry_distribution,
    is_distribution_bundle_directory,
    load_distribution_bundle,
    load_distribution_bundle_from_directory,
    make_distribution_id,
)
from backend.server.dataset_store import DatasetStore
from backend.server.expression import ExpressionEvaluationError, evaluate_expression_payload
from backend.server.molden import parse_molden_normal_modes
from backend.server.normal_modes_sampling import (
    SAMPLE_CACHE_MAX_ENTRIES,
    build_normal_modes_export_bundle,
    build_normal_modes_geometry_export_entries,
    build_normal_modes_geometry_export_bundle,
    compute_measurement_values_from_batch,
    prepare_sampling_inputs,
    sample_normal_modes,
    utc_now_iso,
)
from backend.server.models import (
    BootstrapResponse,
    DistributionCompareGeometryRequest,
    DistributionCompareGeometryResponse,
    DistributionCompareGeometryWindowRequest,
    DistributionCompareGeometryWindowResponse,
    DistributionCompareSpectrumRequest,
    DistributionCompareSpectrumResponse,
    DistributionDeleteResponse,
    DistributionElectronicProfileItem,
    DistributionListItem,
    DistributionListResponse,
    DistributionSelectionRequestItem,
    DistributionSoapUmapRequest,
    DistributionSoapUmapWindowRequest,
    DistributionSoapUmapWindowResponse,
    DistributionSpectrumPairCurve,
    DistributionSpectrumPairOption,
    DistributionSpectrumSeries,
    DistributionSpectrumSeriesRequestItem,
    DistributionSpectrumSkippedItem,
    ExpressionEnsembleRequest,
    ExpressionEnsembleResponse,
    ExpressionDatasetRequest,
    ExpressionSeriesRequest,
    ExpressionSeriesResponse,
    EnsembleSeriesRequest,
    EnsembleSeriesResponse,
    FileBrowserResponse,
    InspectKeysRequest,
    InspectKeysResponse,
    HoppingEventsRequest,
    HoppingEventsResponse,
    LoadDatasetRequest,
    LoadDatasetResponse,
    LoadTrajectorySourcePathRequest,
    LoadDistributionPathRequest,
    MoleculeDeNacResponse,
    MoleculeDeResponse,
    HealthzResponse,
    MoleculeHydrogenBondResponse,
    MoleculeNacResponse,
    MoleculeTrajectoryResponse,
    NormalModesGeometrySaveRequest,
    NormalModesGeometrySaveResponse,
    NormalModesMeasurementRequest,
    NormalModesMeasurementResponse,
    NormalModesParseTextRequest,
    NormalModesParseTextResponse,
    NormalModesSampleTextRequest,
    NormalModesSampleTextResponse,
    RawKeyAliasListResponse,
    RawKeyAliasUpsertRequest,
    RawKeySeriesRequest,
    RawKeySeriesResponse,
    RefreshDatasetResponse,
    SeriesRequest,
    SeriesResponse,
)
from backend.server.trajectory_sampling import build_trajectory_geometry_export_bundle

logger = logging.getLogger(__name__)
MAX_INSPECT_KEYS = 200
RAW_ALIAS_PREFIX = "raw_alias::"
LOADABLE_DATASET_SUFFIXES = frozenset({".pkl", ".pickle"})
MD_SOURCE_SUFFIXES = frozenset({".xyz"})
PIMD_SOURCE_SUFFIXES = frozenset({".h5", ".hdf5"})


def _normalize_indices(indices: list[int]) -> list[int]:
    out: list[int] = []
    for idx in indices:
        out.append(int(idx))
    return out


def _normalize_inspect_keys(keys: list[str]) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for key in keys:
        text = str(key).strip()
        if not text:
            continue
        if text in seen:
            continue
        seen.add(text)
        out.append(text)
    return out


def _build_raw_key_alias_items(raw_key_aliases: dict[str, str]) -> list[dict[str, str]]:
    items: list[dict[str, str]] = []
    for alias in sorted(raw_key_aliases.keys()):
        alias_text = str(alias).strip()
        raw_key_text = str(raw_key_aliases.get(alias, "")).strip()
        if not alias_text or not raw_key_text:
            continue
        items.append(
            {
                "alias": alias_text,
                "raw_key": raw_key_text,
            }
        )
    return items


def _build_bootstrap_payload(
    *,
    store: DatasetStore,
    api_base: str,
    raw_key_aliases: dict[str, str],
) -> dict[str, Any]:
    payload = dict(store.to_bootstrap(api_base=api_base))
    payload["raw_key_aliases"] = _build_raw_key_alias_items(raw_key_aliases)
    return payload


def _json_script_text(value: Any) -> str:
    return json.dumps(value, separators=(",", ":")).replace("</", "<\\/")


def _build_distribution_list_item_payload(
    *,
    distribution_id: str,
    bundle: DistributionBundle,
) -> dict[str, Any]:
    electronic_profiles = sorted(
        list((bundle.electronic_profiles or {}).values()),
        key=lambda item: item.profile_id,
    )
    return {
        "distribution_id": str(distribution_id),
        "label": str(bundle.label),
        "source_name": str(bundle.source_name),
        "created_at_utc": str(bundle.created_at_utc),
        "n_samples": int(bundle.n_samples),
        "n_atoms": int(bundle.n_atoms),
        "topology_signature": str(bundle.topology_signature),
        "available_channels": [str(value) for value in bundle.available_channels],
        "has_electronics": bool(bundle.has_electronics),
        "default_electronic_profile_id": (
            None if bundle.default_electronic_profile_id is None else str(bundle.default_electronic_profile_id)
        ),
        "electronic_profiles": [
            DistributionElectronicProfileItem(
                profile_id=str(profile.profile_id),
                label=str(profile.label),
                engine=str(profile.engine),
                method=str(profile.method),
                reference=str(profile.reference),
                xc=str(profile.xc),
                basis=str(profile.basis),
                n_excited_states=int(profile.n_excited_states),
                n_states=int(profile.n_states),
                n_transition=int(profile.n_transition),
                success_count=int(profile.success_count),
                failed_count=int(profile.failed_count),
            ).model_dump()
            for profile in electronic_profiles
        ],
    }


def _dataset_is_loaded(store: DatasetStore) -> bool:
    return bool(store.meta.get("dataset_loaded"))


def _relative_path_text(root: Path, target: Path) -> str:
    text = target.relative_to(root).as_posix()
    return "" if text == "." else text


def _path_matches_suffixes(path: Path, suffixes: tuple[str, ...] | frozenset[str]) -> bool:
    lower_name = path.name.lower()
    return any(lower_name.endswith(str(suffix).lower()) for suffix in suffixes)


def _raw_key_exists(store: DatasetStore, raw_key: str) -> bool:
    payload = store.inspect_raw_keys([raw_key])
    rows = payload.get("rows", [])
    if not isinstance(rows, list):
        return False
    for row in rows:
        if not isinstance(row, dict):
            continue
        values = row.get("values", {})
        if not isinstance(values, dict):
            continue
        value = str(values.get(raw_key, "MISSING"))
        if value != "MISSING":
            return True
    return False


def _as_scalar_series_record(record: dict[str, Any]) -> dict[str, list[float]]:
    return {
        "time": list(record.get("time", []) or []),
        "value": list(record.get("value", []) or []),
    }


def _matrix_component_to_scalar_series(record: dict[str, Any], component_index: int) -> dict[str, list[float]]:
    time_raw = list(record.get("time", []) or [])
    values_raw = list(record.get("values", []) or [])
    point_count = min(len(time_raw), len(values_raw))
    out_time: list[float] = []
    out_value: list[float] = []
    for idx in range(point_count):
        row = values_raw[idx]
        if not isinstance(row, list):
            continue
        if component_index < 0 or component_index >= len(row):
            continue
        try:
            t = float(time_raw[idx])
            y = float(row[component_index])
        except (TypeError, ValueError):
            continue
        if not (t == t and y == y):
            continue
        out_time.append(t)
        out_value.append(y)
    return {"time": out_time, "value": out_value}


def _build_ensemble_component_payload(
    *,
    scalar_series_list: list[dict[str, list[float]]],
    stat_mode: str,
    context_key: str,
    component_index: int,
    label: str | None = None,
) -> dict[str, Any]:
    stats = aggregate_scalar_series_by_mode(
        scalar_series_list,
        stat_mode=stat_mode,
        context_key=context_key,
        component_index=component_index,
    )
    return {
        "component": int(component_index),
        "label": label,
        "time": [float(v) for v in stats["time"]],
        "low": [float(v) for v in stats["low"]],
        "center": [float(v) for v in stats["center"]],
        "high": [float(v) for v in stats["high"]],
        "sample_count": [int(v) for v in stats["sample_count"]],
    }


def _matrix_component_count(record: dict[str, Any]) -> int:
    count_raw = record.get("n_components")
    count = int(count_raw) if isinstance(count_raw, int) else 0
    if count > 0:
        return count
    values_raw = list(record.get("values", []) or [])
    for row in values_raw:
        if isinstance(row, (list, tuple)):
            count = max(count, len(row))
    return count


def _effective_scalar_stat_mode(stat_mode: str, *, n_components: int) -> str:
    if str(stat_mode) == RENORM_MEAN_CI95_BOOTSTRAP_MODE and int(n_components) <= 1:
        return "mean_ci95_bootstrap"
    return str(stat_mode)


def _build_matrix_ensemble_component_payloads(
    *,
    matrix_series_records: list[dict[str, Any]],
    stat_mode: str,
    context_key: str,
    component_labels: list[str] | None = None,
) -> tuple[list[dict[str, Any]], int]:
    max_components = 0
    for record in matrix_series_records:
        max_components = max(max_components, _matrix_component_count(record))
    if max_components <= 0:
        return [], 0

    effective_mode = _effective_scalar_stat_mode(stat_mode, n_components=max_components)
    component_series: list[dict[str, Any]] = []
    if effective_mode == RENORM_MEAN_CI95_BOOTSTRAP_MODE:
        matrix_series_list = [
            {
                "time": list(record.get("time", []) or []),
                "values": list(record.get("values", []) or []),
            }
            for record in matrix_series_records
        ]
        stats = aggregate_matrix_renorm_mean_ci95_bootstrap(
            matrix_series_list,
            context_key=context_key,
            n_components=max_components,
        )
        time_values = [float(v) for v in stats.get("time", [])]
        low_rows = list(stats.get("low", []) or [])
        center_rows = list(stats.get("center", []) or [])
        high_rows = list(stats.get("high", []) or [])
        sample_counts = [int(v) for v in stats.get("sample_count", [])]
        n_points = min(len(time_values), len(low_rows), len(center_rows), len(high_rows), len(sample_counts))
        time_values = time_values[:n_points]
        sample_counts = sample_counts[:n_points]

        for component_index in range(max_components):
            label = None
            if component_labels is not None and component_index < len(component_labels):
                label = str(component_labels[component_index])
            low_values = []
            center_values = []
            high_values = []
            for point_index in range(n_points):
                low_row = list(low_rows[point_index]) if isinstance(low_rows[point_index], (list, tuple)) else []
                center_row = list(center_rows[point_index]) if isinstance(center_rows[point_index], (list, tuple)) else []
                high_row = list(high_rows[point_index]) if isinstance(high_rows[point_index], (list, tuple)) else []
                low_values.append(float(low_row[component_index]) if component_index < len(low_row) else float("nan"))
                center_values.append(
                    float(center_row[component_index]) if component_index < len(center_row) else float("nan")
                )
                high_values.append(float(high_row[component_index]) if component_index < len(high_row) else float("nan"))
            component_series.append(
                {
                    "component": int(component_index),
                    "label": label,
                    "time": time_values,
                    "low": low_values,
                    "center": center_values,
                    "high": high_values,
                    "sample_count": sample_counts,
                }
            )
        return component_series, max_components

    for component_index in range(max_components):
        scalar_series = [
            _matrix_component_to_scalar_series(record, component_index)
            for record in matrix_series_records
        ]
        label = None
        if component_labels is not None and component_index < len(component_labels):
            label = str(component_labels[component_index])
        component_series.append(
            _build_ensemble_component_payload(
                scalar_series_list=scalar_series,
                stat_mode=effective_mode,
                context_key=context_key,
                component_index=component_index,
                label=label,
            )
        )
    return component_series, max_components


def _json_safe_float_list(values: list[float] | None) -> list[float | None] | None:
    if values is None:
        return None
    out: list[float | None] = []
    for item in values:
        try:
            number = float(item)
        except (TypeError, ValueError):
            out.append(None)
            continue
        out.append(number if math.isfinite(number) else None)
    return out


def _json_safe_matrix(values: list[list[float]] | None) -> list[list[float | None]] | None:
    if values is None:
        return None
    out: list[list[float | None]] = []
    for row in values:
        out.append(_json_safe_float_list(list(row)) or [])
    return out


def _validate_request(
    *,
    observable: str,
    indices: list[int],
    n_atoms: int,
    de_nac_state_count: int,
) -> None:
    if observable not in ALLOWED_OBSERVABLES:
        raise HTTPException(status_code=400, detail=f"Unsupported observable: {observable}")

    required = required_index_count(observable)
    if len(indices) != required:
        raise HTTPException(
            status_code=400,
            detail=f"Observable '{observable}' requires {required} indices, got {len(indices)}",
        )

    if any(idx < 0 for idx in indices):
        raise HTTPException(status_code=400, detail="Indices must be non-negative integers")

    if observable == "de_nac":
        n_states = int(de_nac_state_count)
        if n_states <= 0:
            raise HTTPException(
                status_code=422,
                detail="Observable 'de_nac' is unavailable: no valid de_nac states.",
            )
        if len(indices) == 2 and int(indices[0]) == int(indices[1]):
            raise HTTPException(status_code=422, detail="Observable 'de_nac' requires different state indices.")
        if max(indices) >= n_states:
            raise HTTPException(
                status_code=422,
                detail=f"Index out of bounds for observable 'de_nac': max valid state index is {n_states - 1}",
            )
        return

    if required > 0 and max(indices) >= n_atoms:
        raise HTTPException(
            status_code=422,
            detail=f"Index out of bounds for observable '{observable}': max valid index is {n_atoms - 1}",
        )


def create_app(
    store: DatasetStore,
    cache: SeriesLRUCache,
    mol3d_cache: SeriesLRUCache | None = None,
    *,
    api_base: str = "/api",
    load_store_from_path: Callable[[Path], DatasetStore] | None = None,
    browse_root: Path | None = None,
) -> FastAPI:
    api_base = api_base.rstrip("/") or "/api"
    if mol3d_cache is None:
        mol3d_cache = cache
    normal_modes_sample_cache = SeriesLRUCache(max_entries=SAMPLE_CACHE_MAX_ENTRIES)
    distribution_lock = Lock()
    loaded_distributions: dict[str, DistributionBundle] = {}
    distribution_analysis_cache = SeriesLRUCache(max_entries=64)
    distribution_projection_cache = SeriesLRUCache(max_entries=32)
    soap_feature_cache_lock = Lock()
    soap_feature_cache: dict[tuple[Any, ...], dict[str, Any]] = {}
    browse_root_resolved = Path(browse_root).resolve() if browse_root is not None else None

    runtime_lock = Lock()
    runtime_state: dict[str, Any] = {
        "store": store,
        "raw_key_aliases": {},
        "bootstrap": _build_bootstrap_payload(
            store=store,
            api_base=api_base,
            raw_key_aliases={},
        ),
        "dataset_revision": 1,
    }

    def _update_bootstrap_locked() -> None:
        runtime_state["bootstrap"] = _build_bootstrap_payload(
            store=runtime_state["store"],
            api_base=api_base,
            raw_key_aliases=runtime_state["raw_key_aliases"],
        )

    def _get_runtime_snapshot() -> tuple[DatasetStore, dict[str, Any], int]:
        with runtime_lock:
            return (
                runtime_state["store"],
                runtime_state["bootstrap"],
                int(runtime_state["dataset_revision"]),
            )

    def _resolve_browse_path(relative_path: str | None) -> Path:
        if browse_root_resolved is None:
            raise HTTPException(status_code=501, detail="Dataset browsing is not enabled on this server.")

        raw_path = str(relative_path or "").strip()
        if raw_path and Path(raw_path).is_absolute():
            raise HTTPException(status_code=400, detail="Absolute paths are not allowed.")

        candidate = browse_root_resolved if not raw_path else browse_root_resolved / raw_path
        try:
            resolved = candidate.resolve(strict=True)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=f"Path not found: {raw_path or '.'}") from exc
        except OSError as exc:
            raise HTTPException(status_code=400, detail=f"Failed to resolve path: {exc}") from exc

        try:
            resolved.relative_to(browse_root_resolved)
        except ValueError as exc:
            raise HTTPException(status_code=403, detail="Requested path is outside the browse root.") from exc
        return resolved

    def _resolve_browse_output_directory(relative_path: str | None) -> Path:
        if browse_root_resolved is None:
            raise HTTPException(status_code=501, detail="Dataset browsing is not enabled on this server.")

        raw_path = str(relative_path or "").strip()
        if raw_path and Path(raw_path).is_absolute():
            raise HTTPException(status_code=400, detail="Absolute paths are not allowed.")

        candidate = browse_root_resolved if not raw_path else browse_root_resolved / raw_path
        try:
            resolved = candidate.resolve(strict=False)
        except OSError as exc:
            raise HTTPException(status_code=400, detail=f"Failed to resolve path: {exc}") from exc

        try:
            resolved.relative_to(browse_root_resolved)
        except ValueError as exc:
            raise HTTPException(status_code=403, detail="Requested path is outside the browse root.") from exc
        return resolved

    def _resolve_manual_source_path(raw_path: str) -> Path:
        path_text = str(raw_path or "").strip()
        if not path_text:
            raise HTTPException(status_code=422, detail="path must not be empty.")

        candidate = Path(path_text)
        if not candidate.is_absolute():
            base_root = browse_root_resolved if browse_root_resolved is not None else Path.cwd().resolve()
            candidate = base_root / candidate

        try:
            resolved = candidate.resolve(strict=True)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=f"Path not found: {path_text}") from exc
        except OSError as exc:
            raise HTTPException(status_code=400, detail=f"Failed to resolve path: {exc}") from exc

        if not resolved.is_file():
            raise HTTPException(status_code=422, detail=f"Path is not a file: {path_text}")
        return resolved

    def _build_file_browser_response(
        current_dir: Path,
        *,
        is_loadable: Callable[[Path, str], bool],
    ) -> FileBrowserResponse:
        entries: list[dict[str, Any]] = []
        for child in current_dir.iterdir():
            if child.name.startswith("."):
                continue
            try:
                resolved_child = child.resolve(strict=True)
                resolved_child.relative_to(browse_root_resolved)
            except (FileNotFoundError, OSError, ValueError):
                continue

            kind = "directory" if resolved_child.is_dir() else "file" if resolved_child.is_file() else ""
            if not kind:
                continue

            entries.append(
                {
                    "name": child.name,
                    "relative_path": _relative_path_text(browse_root_resolved, child),
                    "kind": kind,
                    "loadable": bool(is_loadable(child, kind)),
                }
            )

        entries.sort(key=lambda item: (item["kind"] != "directory", str(item["name"]).lower()))
        parent_path = None if current_dir == browse_root_resolved else _relative_path_text(browse_root_resolved, current_dir.parent)
        return FileBrowserResponse(
            root_label=str(browse_root_resolved),
            current_path=_relative_path_text(browse_root_resolved, current_dir),
            parent_path=parent_path,
            entries=entries,
        )

    def _normalize_export_directory_name(raw_filename: str, *, fallback: str) -> str:
        directory_name = str(raw_filename or "").strip() or str(fallback or "").strip()
        if not directory_name:
            raise HTTPException(status_code=422, detail="filename must not be empty.")
        if Path(directory_name).name != directory_name or "/" in directory_name or "\\" in directory_name:
            raise HTTPException(status_code=422, detail="filename must be a directory name, not a path.")
        if directory_name in {".", ".."}:
            raise HTTPException(status_code=422, detail="filename must be a valid directory name.")

        directory_name_lower = directory_name.lower()
        if directory_name_lower.endswith(".tar.gz"):
            directory_name = directory_name[:-7]
        elif directory_name_lower.endswith(".tgz"):
            directory_name = directory_name[:-4]
        elif directory_name_lower.endswith(".tar"):
            directory_name = directory_name[:-4]
        elif directory_name_lower.endswith(".gz"):
            directory_name = directory_name[:-3]

        directory_name = directory_name.strip()
        if not directory_name or directory_name in {".", ".."}:
            raise HTTPException(status_code=422, detail="filename must resolve to a valid directory name.")
        return directory_name

    def _write_bundle_entries_to_directory(
        parent_dir: Path,
        *,
        directory_name: str,
        entries: list[tuple[str, bytes]],
    ) -> Path:
        target_path = parent_dir / directory_name
        if target_path.exists():
            raise HTTPException(status_code=409, detail=f"Target path already exists: {target_path.name}")

        temp_path = parent_dir / f".{directory_name}.tmp-{secrets.token_urlsafe(6)}"
        while temp_path.exists():
            temp_path = parent_dir / f".{directory_name}.tmp-{secrets.token_urlsafe(6)}"

        try:
            temp_path.mkdir(parents=False, exist_ok=False)
            for relative_path, content_bytes in entries:
                entry_relative_path = Path(relative_path)
                if entry_relative_path.is_absolute() or any(part in {"", ".", ".."} for part in entry_relative_path.parts):
                    raise HTTPException(status_code=500, detail=f"Invalid bundle entry path: {relative_path}")
                entry_path = temp_path / entry_relative_path
                entry_path.parent.mkdir(parents=True, exist_ok=True)
                entry_path.write_bytes(content_bytes)

            temp_path.rename(target_path)
            return target_path
        except HTTPException:
            if temp_path.exists():
                shutil.rmtree(temp_path, ignore_errors=True)
            raise
        except OSError as exc:
            if temp_path.exists():
                shutil.rmtree(temp_path, ignore_errors=True)
            if target_path.exists():
                raise HTTPException(status_code=409, detail=f"Target path already exists: {target_path.name}") from exc
            raise HTTPException(status_code=500, detail=f"Failed to write geometry bundle directory: {exc}") from exc

    def _activate_store(new_store: DatasetStore, *, action_label: str, reset_aliases: bool) -> dict[str, Any]:
        try:
            with runtime_lock:
                prev_store = runtime_state["store"]
                prev_bootstrap = runtime_state["bootstrap"]
                prev_aliases = dict(runtime_state["raw_key_aliases"])
                prev_revision = int(runtime_state["dataset_revision"])

                runtime_state["store"] = new_store
                if reset_aliases:
                    runtime_state["raw_key_aliases"] = {}
                _update_bootstrap_locked()
                runtime_state["dataset_revision"] = prev_revision + 1

                try:
                    if mol3d_cache is cache:
                        cleared_series_cache_entries = cache.clear()
                        cleared_mol3d_cache_entries = cleared_series_cache_entries
                    else:
                        cleared_series_cache_entries = cache.clear()
                        cleared_mol3d_cache_entries = mol3d_cache.clear()
                except Exception:  # noqa: BLE001
                    runtime_state["store"] = prev_store
                    runtime_state["bootstrap"] = prev_bootstrap
                    runtime_state["raw_key_aliases"] = prev_aliases
                    runtime_state["dataset_revision"] = prev_revision
                    logger.exception(
                        "%s failed during cache clear; rolled back to revision=%d.",
                        action_label,
                        prev_revision,
                    )
                    raise

                dataset_revision = int(runtime_state["dataset_revision"])
        except Exception as exc:  # noqa: BLE001
            logger.exception("%s activation failed.", action_label)
            raise HTTPException(status_code=500, detail=f"Failed to activate refreshed dataset: {exc}") from exc

        source_pkl = str(new_store.meta.get("source_pkl") or "")
        logger.info(
            (
                "%s succeeded. revision=%d traj_count=%d source_pkl=%s "
                "cleared_series_cache_entries=%d cleared_mol3d_cache_entries=%d"
            ),
            action_label,
            dataset_revision,
            len(new_store.traj_ids),
            source_pkl or "(none)",
            cleared_series_cache_entries,
            cleared_mol3d_cache_entries,
        )
        return {
            "status": "ok",
            "traj_count": len(new_store.traj_ids),
            "source_pkl": source_pkl,
            "cleared_series_cache_entries": cleared_series_cache_entries,
            "cleared_mol3d_cache_entries": cleared_mol3d_cache_entries,
            "dataset_revision": dataset_revision,
        }

    def _list_loaded_distribution_payloads() -> list[dict[str, Any]]:
        with distribution_lock:
            items = [
                _build_distribution_list_item_payload(distribution_id=distribution_id, bundle=bundle)
                for distribution_id, bundle in loaded_distributions.items()
            ]
        items.sort(key=lambda item: str(item.get("created_at_utc") or ""), reverse=True)
        return items

    def _get_distribution_or_404(distribution_id: str) -> DistributionBundle:
        with distribution_lock:
            bundle = loaded_distributions.get(str(distribution_id))
        if bundle is None:
            raise HTTPException(status_code=404, detail=f"Distribution not found: {distribution_id}")
        return bundle

    def _store_distribution(bundle: DistributionBundle) -> dict[str, Any]:
        distribution_id = make_distribution_id()
        with distribution_lock:
            loaded_distributions[distribution_id] = bundle
        return _build_distribution_list_item_payload(distribution_id=distribution_id, bundle=bundle)

    def _delete_distribution(distribution_id: str) -> bool:
        with distribution_lock:
            return loaded_distributions.pop(str(distribution_id), None) is not None

    def _normalize_distribution_ids(raw_distribution_ids: list[str]) -> list[str]:
        distribution_ids: list[str] = []
        seen_ids: set[str] = set()
        for raw_id in raw_distribution_ids:
            distribution_id = str(raw_id).strip()
            if not distribution_id or distribution_id in seen_ids:
                continue
            seen_ids.add(distribution_id)
            distribution_ids.append(distribution_id)
        return distribution_ids

    def _normalize_spectrum_series_request_items(
        raw_items: list[DistributionSpectrumSeriesRequestItem],
    ) -> list[tuple[str, str]]:
        series_items: list[tuple[str, str]] = []
        seen_items: set[tuple[str, str]] = set()
        for raw_item in raw_items:
            distribution_id = str(raw_item.distribution_id).strip()
            profile_id = str(raw_item.profile_id).strip()
            if not distribution_id or not profile_id:
                continue
            key = (distribution_id, profile_id)
            if key in seen_items:
                continue
            seen_items.add(key)
            series_items.append(key)
        return series_items

    def _normalize_distribution_selection_items(
        raw_items: list[DistributionSelectionRequestItem],
    ) -> list[tuple[str, str]]:
        items: list[tuple[str, str]] = []
        seen_distribution_ids: set[str] = set()
        for raw_item in raw_items:
            distribution_id = str(raw_item.distribution_id).strip()
            profile_id = str(raw_item.profile_id).strip()
            if not distribution_id or not profile_id:
                continue
            if distribution_id in seen_distribution_ids:
                raise HTTPException(
                    status_code=422,
                    detail=(
                        "Each distribution may appear at most once in window selection requests. "
                        f"Received duplicate distribution_id={distribution_id!r}."
                    ),
                )
            seen_distribution_ids.add(distribution_id)
            items.append((distribution_id, profile_id))
        return items

    def _collect_distribution_selection_items(
        selection_items: list[tuple[str, str]],
    ) -> list[tuple[str, DistributionBundle, str, ElectronicProfile]]:
        if not selection_items:
            return []
        resolved_items: list[tuple[str, DistributionBundle, str, ElectronicProfile]] = []
        topology_signature: str | None = None
        for distribution_id, profile_id in selection_items:
            bundle, profile = _get_distribution_profile_or_422(distribution_id, profile_id)
            if topology_signature is None:
                topology_signature = str(bundle.topology_signature)
            elif str(bundle.topology_signature) != topology_signature:
                raise HTTPException(
                    status_code=422,
                    detail=(
                        "Windowed geometry comparison and SOAP projection require identical "
                        "topology_signature across all selected distributions."
                    ),
                )
            resolved_items.append((distribution_id, bundle, profile_id, profile))
        return resolved_items

    def _collect_distribution_bundles(
        distribution_ids: list[str],
    ) -> list[tuple[str, DistributionBundle]]:
        if not distribution_ids:
            return []
        bundles: list[tuple[str, DistributionBundle]] = []
        topology_signature: str | None = None
        for distribution_id in distribution_ids:
            bundle = _get_distribution_or_404(distribution_id)
            if topology_signature is None:
                topology_signature = str(bundle.topology_signature)
            elif str(bundle.topology_signature) != topology_signature:
                raise HTTPException(
                    status_code=422,
                    detail=(
                        "Geometry comparison and SOAP projection require identical "
                        "topology_signature across all active distributions."
                    ),
                )
            bundles.append((distribution_id, bundle))
        return bundles

    def _format_transition_pair(pair: tuple[int, int]) -> str:
        return f"{int(pair[0])}->{int(pair[1])}"

    def _build_series_label(*, bundle: DistributionBundle, profile: ElectronicProfile) -> str:
        return f"{bundle.label} | {profile.label}"

    def _build_transition_pair_options(pairs: list[tuple[int, int]]) -> list[DistributionSpectrumPairOption]:
        return [
            DistributionSpectrumPairOption(
                pair=[int(pair[0]), int(pair[1])],
                label=_format_transition_pair(pair),
            )
            for pair in pairs
        ]

    def _get_distribution_profile_or_422(
        distribution_id: str,
        profile_id: str,
    ) -> tuple[DistributionBundle, ElectronicProfile]:
        bundle = _get_distribution_or_404(distribution_id)
        profile = (bundle.electronic_profiles or {}).get(str(profile_id))
        if profile is None:
            raise HTTPException(
                status_code=422,
                detail=f"Distribution {distribution_id} does not contain electronic profile {profile_id}.",
            )
        return bundle, profile

    def _collect_comparable_spectrum_series(
        series_items: list[tuple[str, str]],
    ) -> tuple[list[tuple[str, DistributionBundle, str, ElectronicProfile]], list[dict[str, str | None]], list[np.ndarray]]:
        comparable_series: list[tuple[str, DistributionBundle, str, ElectronicProfile]] = []
        skipped_payloads: list[dict[str, str | None]] = []
        excitation_energy_sets_ev: list[np.ndarray] = []
        for distribution_id, profile_id in series_items:
            bundle, profile = _get_distribution_profile_or_422(distribution_id, profile_id)
            excitation_energies_ev = collect_absorption_excitation_energies_ev(profile)
            if excitation_energies_ev.size <= 0:
                skipped_payloads.append(
                    {
                        "distribution_id": str(distribution_id),
                        "distribution_label": str(bundle.label),
                        "profile_id": str(profile_id),
                        "profile_label": str(profile.label),
                        "reason": "no valid electronic transitions",
                    }
                )
                continue

            comparable_series.append((distribution_id, bundle, profile_id, profile))
            excitation_energy_sets_ev.append(np.asarray(excitation_energies_ev, dtype=float))
        return comparable_series, skipped_payloads, excitation_energy_sets_ev

    def _collect_common_spectrum_pairs(
        comparable_series: list[tuple[str, DistributionBundle, str, ElectronicProfile]]
    ) -> list[tuple[int, int]]:
        if not comparable_series:
            return []
        common_pairs: set[tuple[int, int]] | None = None
        for _, _, _, profile in comparable_series:
            bundle_pairs = set(collect_valid_absorption_transition_pairs(profile))
            if common_pairs is None:
                common_pairs = bundle_pairs
            else:
                common_pairs &= bundle_pairs
        return sorted(common_pairs or set())

    def _build_absorption_energy_grid(
        *,
        excitation_energy_sets_ev: list[np.ndarray],
        delta_ev: float,
    ) -> np.ndarray:
        non_empty_sets = [np.asarray(values, dtype=float).reshape(-1) for values in excitation_energy_sets_ev if values.size > 0]
        if not non_empty_sets:
            raise HTTPException(
                status_code=422,
                detail="No valid electronic transitions remain after filtering the selected spectrum series.",
            )
        all_excitation_energies_ev = np.concatenate(non_empty_sets)
        min_energy_ev = float(np.min(all_excitation_energies_ev))
        max_energy_ev = float(np.max(all_excitation_energies_ev))
        margin_ev = max(0.25, 8.0 * float(delta_ev))
        x_min_energy_ev = max(0.01, min_energy_ev - margin_ev)
        x_max_energy_ev = max(x_min_energy_ev + 0.2, max_energy_ev + margin_ev)
        return np.linspace(x_min_energy_ev, x_max_energy_ev, 800, dtype=float)

    app = FastAPI(title="Observable Dashboard API", version="1.0.0")

    # Determine frontend location
    project_root = Path(__file__).parent.parent.parent
    frontend_dir = project_root / "frontend"
    frontend_public = frontend_dir / "public"

    # Mount static assets
    if frontend_public.exists():
        app.mount("/assets", StaticFiles(directory=str(frontend_public / "assets")), name="assets")

    # Serve frontend HTML pages
    @app.get("/", response_class=HTMLResponse)
    def index_page() -> HTMLResponse:
        index_file = frontend_dir / "index.html"
        if index_file.exists():
            return HTMLResponse(index_file.read_text())
        return HTMLResponse("<h1>Frontend not found</h1><p>Please build frontend or check installation.</p>", status_code=404)

    @app.get("/index.html", response_class=HTMLResponse)
    def index_page_alias() -> HTMLResponse:
        return index_page()

    @app.get("/workflow.html", response_class=HTMLResponse)
    def workflow_page() -> HTMLResponse:
        workflow_file = frontend_dir / "workflow.html"
        if workflow_file.exists():
            html = workflow_file.read_text()
            config_json = _json_script_text(
                {
                    "pages": {
                        "normal_modes": "/normal_modes.html",
                        "distribution_compare": "/distribution_compare.html",
                        "dashboard": "/index.html",
                        "molecule3d": "/molecule3d.html",
                        "md": "/md.html",
                    },
                    "features": {
                        "pimd_placeholder": False,
                    },
                }
            )
            html = html.replace(
                '<script id="workflow-config-json" type="application/json">{}</script>',
                f'<script id="workflow-config-json" type="application/json">{config_json}</script>',
                1,
            )
            return HTMLResponse(html)
        return HTMLResponse("<h1>Workflow page not found</h1>", status_code=404)

    @app.get("/molecule3d.html", response_class=HTMLResponse)
    def molecule3d_page() -> HTMLResponse:
        mol3d_file = frontend_dir / "molecule3d.html"
        if mol3d_file.exists():
            return HTMLResponse(mol3d_file.read_text())
        return HTMLResponse("<h1>Molecule3D page not found</h1>", status_code=404)

    @app.get("/md.html", response_class=HTMLResponse)
    def md_page() -> HTMLResponse:
        md_file = frontend_dir / "md.html"
        if md_file.exists():
            html = md_file.read_text()
            config_json = _json_script_text(
                {
                    "data_mode": "local_xyz",
                    "pimd_mode": "local_h5",
                    "api_base": api_base,
                    "pages": {
                        "workflow": "/workflow.html",
                        "molecule3d": "/molecule3d.html",
                    },
                    "meta": {
                        "source_label": "Local XYZ",
                    },
                }
            )
            html = html.replace(
                '<script id="md-config-json" type="application/json">{}</script>',
                f'<script id="md-config-json" type="application/json">{config_json}</script>',
                1,
            )
            return HTMLResponse(html)
        return HTMLResponse("<h1>MD page not found</h1>", status_code=404)

    @app.get("/normal_modes.html", response_class=HTMLResponse)
    def normal_modes_page() -> HTMLResponse:
        normal_modes_file = frontend_dir / "normal_modes.html"
        if normal_modes_file.exists():
            html = normal_modes_file.read_text()
            config_json = _json_script_text({"api_base": api_base})
            html = html.replace(
                '<script id="normal-modes-config-json" type="application/json">{}</script>',
                f'<script id="normal-modes-config-json" type="application/json">{config_json}</script>',
                1,
            )
            return HTMLResponse(html)
        return HTMLResponse("<h1>Normal Modes page not found</h1>", status_code=404)

    @app.get("/distribution_compare.html", response_class=HTMLResponse)
    def distribution_compare_page() -> HTMLResponse:
        compare_file = frontend_dir / "distribution_compare.html"
        if compare_file.exists():
            html = compare_file.read_text()
            config_json = _json_script_text({"api_base": api_base})
            html = html.replace(
                '<script id="distribution-compare-config-json" type="application/json">{}</script>',
                f'<script id="distribution-compare-config-json" type="application/json">{config_json}</script>',
                1,
            )
            return HTMLResponse(html)
        return HTMLResponse("<h1>Distribution Compare page not found</h1>", status_code=404)

    # Serve frontend source files (for development)
    @app.get("/src/{file_path:path}")
    def serve_src(file_path: str) -> FileResponse:
        src_file = frontend_dir / "src" / file_path
        if src_file.exists() and src_file.is_file():
            return FileResponse(src_file)
        raise HTTPException(status_code=404, detail="File not found")

    @app.get(f"{api_base}/healthz", response_model=HealthzResponse)
    def healthz() -> HealthzResponse:
        current_store, _, _ = _get_runtime_snapshot()
        return HealthzResponse(
            status="ok",
            dataset_loaded=_dataset_is_loaded(current_store),
            traj_count=len(current_store.traj_ids),
        )

    @app.get(f"{api_base}/bootstrap", response_model=BootstrapResponse)
    def get_bootstrap() -> BootstrapResponse:
        _, bootstrap, _ = _get_runtime_snapshot()
        return BootstrapResponse(**bootstrap)

    @app.post(f"{api_base}/normal-modes/parse-text", response_model=NormalModesParseTextResponse)
    def parse_normal_modes_text(req: NormalModesParseTextRequest) -> NormalModesParseTextResponse:
        try:
            payload = parse_molden_normal_modes(req.content, source_name=req.filename)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"Failed to parse molden content: {exc}") from exc
        return NormalModesParseTextResponse(**payload)

    @app.post(f"{api_base}/normal-modes/sample-text", response_model=NormalModesSampleTextResponse)
    def sample_normal_modes_text(req: NormalModesSampleTextRequest) -> NormalModesSampleTextResponse:
        request_received_at_utc = utc_now_iso()
        started_at = time.perf_counter()
        try:
            parsed_payload = parse_molden_normal_modes(req.content, source_name=req.filename)
            preparation = prepare_sampling_inputs(parsed_payload)
            sample_payload = sample_normal_modes(
                preparation,
                sample_count=int(req.sample_count),
                preview_count=int(req.preview_count),
                charge=int(req.charge),
                multiplicity=int(req.multiplicity),
                position_default=str(req.position_default),
                momentum_default=str(req.momentum_default),
                temperature_k=(None if req.temperature_k is None else float(req.temperature_k)),
                seed=req.seed,
                freq_min_cm1=(None if req.freq_min_cm1 is None else float(req.freq_min_cm1)),
                freq_max_cm1=(None if req.freq_max_cm1 is None else float(req.freq_max_cm1)),
                rules=[item.model_dump() for item in req.rules],
            )
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"Failed to sample normal modes: {exc}") from exc

        sampling_completed_at_utc = utc_now_iso()
        sampling_duration_ms = int(round((time.perf_counter() - started_at) * 1000.0))
        batch_id = f"nm-sample-{secrets.token_urlsafe(12)}"
        response_payload = dict(sample_payload["response_payload"])
        normalized_request = req.model_dump(exclude={"content"})
        normalized_request["filename"] = str(parsed_payload.get("source_name") or req.filename)
        normalized_request["seed"] = int(response_payload["seed"])
        normalized_request["preview_count_requested"] = int(req.preview_count)
        normalized_request["preview_count_effective"] = int(response_payload["preview_count"])
        batch_payload = dict(sample_payload["batch_payload"])
        batch_payload["batch_id"] = str(batch_id)
        batch_payload["source_content"] = str(req.content)
        batch_payload["request_snapshot"] = normalized_request
        batch_payload["request_received_at_utc"] = str(request_received_at_utc)
        batch_payload["sampling_completed_at_utc"] = str(sampling_completed_at_utc)
        batch_payload["sampling_duration_ms"] = int(sampling_duration_ms)
        batch_payload["source_name"] = str(parsed_payload.get("source_name") or req.filename)
        normal_modes_sample_cache.put(("normal_modes_sample_batch", batch_id), batch_payload)
        response_payload["batch_id"] = str(batch_id)
        response_payload["sampling_completed_at_utc"] = str(sampling_completed_at_utc)
        return NormalModesSampleTextResponse(**response_payload)

    @app.post(
        f"{api_base}/normal-modes/sample-batches/{{batch_id}}/measurements",
        response_model=NormalModesMeasurementResponse,
    )
    def measure_normal_modes_batch(
        batch_id: str,
        req: NormalModesMeasurementRequest,
    ) -> NormalModesMeasurementResponse:
        cache_key = ("normal_modes_sample_batch", str(batch_id))
        batch_payload = normal_modes_sample_cache.get(cache_key)
        if batch_payload is None:
            raise HTTPException(status_code=404, detail=f"Normal-modes sample batch not found: {batch_id}")

        try:
            measurement_payload = compute_measurement_values_from_batch(
                batch_payload,
                measurement_kind=str(req.measurement_kind),
                atom_indices=[int(v) for v in req.atom_indices],
            )
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"Failed to compute sample measurement: {exc}") from exc

        measurement_payload["batch_id"] = str(batch_id)
        return NormalModesMeasurementResponse(**measurement_payload)

    @app.get(f"{api_base}/normal-modes/sample-batches/{{batch_id}}/export")
    def export_normal_modes_batch(batch_id: str) -> Response:
        cache_key = ("normal_modes_sample_batch", str(batch_id))
        batch_payload = normal_modes_sample_cache.get(cache_key)
        if batch_payload is None:
            raise HTTPException(status_code=404, detail=f"Normal-modes sample batch not found: {batch_id}")

        try:
            file_name, archive_bytes = build_normal_modes_export_bundle(
                batch_id=str(batch_id),
                batch_payload=batch_payload,
            )
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"Failed to export sample batch: {exc}") from exc

        return Response(
            content=archive_bytes,
            media_type="application/gzip",
            headers={
                "Content-Disposition": f'attachment; filename="{file_name}"',
            },
        )

    @app.get(f"{api_base}/normal-modes/sample-batches/{{batch_id}}/export-geometry")
    def export_normal_modes_geometry_batch(batch_id: str) -> Response:
        cache_key = ("normal_modes_sample_batch", str(batch_id))
        batch_payload = normal_modes_sample_cache.get(cache_key)
        if batch_payload is None:
            raise HTTPException(status_code=404, detail=f"Normal-modes sample batch not found: {batch_id}")

        try:
            file_name, archive_bytes = build_normal_modes_geometry_export_bundle(
                batch_id=str(batch_id),
                batch_payload=batch_payload,
            )
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"Failed to export geometry sample bundle: {exc}") from exc

        return Response(
            content=archive_bytes,
            media_type="application/gzip",
            headers={
                "Content-Disposition": f'attachment; filename="{file_name}"',
            },
        )

    @app.post(
        f"{api_base}/normal-modes/sample-batches/{{batch_id}}/export-geometry/save",
        response_model=NormalModesGeometrySaveResponse,
    )
    def save_normal_modes_geometry_batch(
        batch_id: str,
        req: NormalModesGeometrySaveRequest,
    ) -> NormalModesGeometrySaveResponse:
        cache_key = ("normal_modes_sample_batch", str(batch_id))
        batch_payload = normal_modes_sample_cache.get(cache_key)
        if batch_payload is None:
            raise HTTPException(status_code=404, detail=f"Normal-modes sample batch not found: {batch_id}")

        try:
            default_file_name, bundle_entries = build_normal_modes_geometry_export_entries(
                batch_id=str(batch_id),
                batch_payload=batch_payload,
            )
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"Failed to export geometry sample bundle: {exc}") from exc

        target_dir = _resolve_browse_output_directory(req.directory)
        directory_name = _normalize_export_directory_name(req.filename, fallback=default_file_name)
        if target_dir.exists() and not target_dir.is_dir():
            raise HTTPException(status_code=422, detail=f"Target directory is not a directory: {req.directory}")

        try:
            target_dir.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise HTTPException(status_code=500, detail=f"Failed to create target directory: {exc}") from exc

        try:
            target_dir.relative_to(browse_root_resolved)
        except ValueError as exc:
            raise HTTPException(status_code=403, detail="Requested path is outside the browse root.") from exc

        target_path = _write_bundle_entries_to_directory(
            target_dir,
            directory_name=directory_name,
            entries=bundle_entries,
        )

        return NormalModesGeometrySaveResponse(
            status="ok",
            saved_relative_path=_relative_path_text(browse_root_resolved, target_path),
            saved_absolute_path=str(target_path),
        )

    @app.post(f"{api_base}/md/export-geometry-bundle")
    async def export_md_geometry_bundle(
        source_kind: str = Query(..., min_length=1),
        source_name: str = Query(..., min_length=1),
        start_frame: int = Query(..., ge=0),
        end_frame: int | None = Query(default=None, ge=0),
        frame_stride: int = Query(default=1, ge=1),
        charge: int = Query(default=0),
        multiplicity: int = Query(default=1, ge=1),
        bead_start: int | None = Query(default=None, ge=0),
        bead_end: int | None = Query(default=None, ge=0),
        bead_stride: int = Query(default=1, ge=1),
        source_bytes: bytes = Body(...),
    ) -> Response:
        try:
            file_name, archive_bytes = build_trajectory_geometry_export_bundle(
                source_kind=str(source_kind),
                source_name=str(source_name),
                source_bytes=bytes(source_bytes),
                start_frame=int(start_frame),
                end_frame=(None if end_frame is None else int(end_frame)),
                frame_stride=int(frame_stride),
                charge=int(charge),
                multiplicity=int(multiplicity),
                bead_start=(None if bead_start is None else int(bead_start)),
                bead_end=(None if bead_end is None else int(bead_end)),
                bead_stride=int(bead_stride),
            )
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"Failed to export trajectory geometry bundle: {exc}") from exc

        return Response(
            content=archive_bytes,
            media_type="application/gzip",
            headers={
                "Content-Disposition": f'attachment; filename="{file_name}"',
            },
        )

    @app.post(f"{api_base}/md/load-xyz-path")
    def load_md_xyz_source_path(req: LoadTrajectorySourcePathRequest) -> Response:
        target_path = _resolve_manual_source_path(req.path)
        if not _path_matches_suffixes(target_path, MD_SOURCE_SUFFIXES):
            raise HTTPException(status_code=422, detail="Only .xyz files can be loaded.")

        try:
            source_bytes = target_path.read_bytes()
        except OSError as exc:
            raise HTTPException(status_code=500, detail=f"Failed to read XYZ source: {exc}") from exc

        return Response(content=source_bytes, media_type="text/plain")

    @app.post(f"{api_base}/md/load-pimd-path")
    def load_pimd_source_path(req: LoadTrajectorySourcePathRequest) -> Response:
        target_path = _resolve_manual_source_path(req.path)
        if not _path_matches_suffixes(target_path, PIMD_SOURCE_SUFFIXES):
            raise HTTPException(status_code=422, detail="Only .h5 and .hdf5 files can be loaded.")

        try:
            source_bytes = target_path.read_bytes()
        except OSError as exc:
            raise HTTPException(status_code=500, detail=f"Failed to read PIMD source: {exc}") from exc

        return Response(content=source_bytes, media_type="application/octet-stream")

    @app.post(f"{api_base}/distributions/load", response_model=DistributionListItem)
    async def load_distribution_via_upload(
        bundle_bytes: bytes = Body(...),
        filename: str = "distribution_bundle.tar.gz",
    ) -> DistributionListItem:
        try:
            bundle = load_distribution_bundle(bundle_bytes, filename=str(filename))
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"Failed to load distribution bundle: {exc}") from exc
        return DistributionListItem(**_store_distribution(bundle))

    @app.get(f"{api_base}/distributions/files", response_model=FileBrowserResponse)
    def list_distribution_files(path: str | None = None) -> FileBrowserResponse:
        current_dir = _resolve_browse_path(path)
        if not current_dir.is_dir():
            raise HTTPException(status_code=422, detail=f"Path is not a directory: {path or '.'}")
        return _build_file_browser_response(
            current_dir,
            is_loadable=lambda child, kind: kind == "directory" and is_distribution_bundle_directory(child),
        )

    @app.post(f"{api_base}/distributions/load-path", response_model=DistributionListItem)
    def load_distribution_from_path(req: LoadDistributionPathRequest) -> DistributionListItem:
        target_path = _resolve_browse_path(req.path)
        if not target_path.is_dir():
            raise HTTPException(status_code=422, detail=f"Path is not a directory: {req.path}")

        try:
            bundle = load_distribution_bundle_from_directory(target_path)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"Failed to load distribution bundle: {exc}") from exc
        return DistributionListItem(**_store_distribution(bundle))

    @app.get(f"{api_base}/distributions", response_model=DistributionListResponse)
    def list_loaded_distributions() -> DistributionListResponse:
        return DistributionListResponse(distributions=_list_loaded_distribution_payloads())

    @app.delete(f"{api_base}/distributions/{{distribution_id}}", response_model=DistributionDeleteResponse)
    def delete_loaded_distribution(distribution_id: str) -> DistributionDeleteResponse:
        deleted = _delete_distribution(str(distribution_id))
        if not deleted:
            raise HTTPException(status_code=404, detail=f"Distribution not found: {distribution_id}")
        return DistributionDeleteResponse(status="ok", distribution_id=str(distribution_id))

    @app.post(f"{api_base}/distributions/compare-geometry", response_model=DistributionCompareGeometryResponse)
    def compare_distribution_geometry(req: DistributionCompareGeometryRequest) -> DistributionCompareGeometryResponse:
        distribution_ids = _normalize_distribution_ids(req.distribution_ids)
        if not distribution_ids:
            raise HTTPException(status_code=422, detail="distribution_ids must contain at least one valid item.")

        bundles: list[tuple[str, DistributionBundle]] = []
        topology_signature: str | None = None
        for distribution_id in distribution_ids:
            bundle = _get_distribution_or_404(distribution_id)
            if topology_signature is None:
                topology_signature = str(bundle.topology_signature)
            elif str(bundle.topology_signature) != topology_signature:
                raise HTTPException(
                    status_code=422,
                    detail=(
                        "Geometry comparison requires identical topology_signature across all active distributions."
                    ),
                )
            bundles.append((distribution_id, bundle))

        series_payloads: list[dict[str, Any]] = []
        response_unit = ""
        for distribution_id, bundle in bundles:
            try:
                measurement_payload = compute_geometry_distribution(
                    bundle,
                    measurement_kind=str(req.measurement_kind),
                    atom_indices=[int(value) for value in req.atom_indices],
                )
            except ValueError as exc:
                raise HTTPException(status_code=422, detail=str(exc)) from exc
            response_unit = str(measurement_payload["unit"])
            series_payloads.append(
                {
                    "distribution_id": str(distribution_id),
                    "label": str(bundle.label),
                    "source_name": str(bundle.source_name),
                    "values": list(measurement_payload["values"]),
                    "sample_count": int(measurement_payload["sample_count"]),
                    "min": float(measurement_payload["min"]),
                    "max": float(measurement_payload["max"]),
                    "mean": float(measurement_payload["mean"]),
                    "std": float(measurement_payload["std"]),
                }
            )

        return DistributionCompareGeometryResponse(
            measurement_kind=str(req.measurement_kind),
            atom_indices=[int(value) for value in req.atom_indices],
            unit=response_unit,
            bins=int(req.bins),
            topology_signature=str(topology_signature or ""),
            series=series_payloads,
        )

    @app.post(
        f"{api_base}/distributions/compare-geometry-window",
        response_model=DistributionCompareGeometryWindowResponse,
    )
    def compare_distribution_geometry_window(
        req: DistributionCompareGeometryWindowRequest,
    ) -> DistributionCompareGeometryWindowResponse:
        selection_items = _normalize_distribution_selection_items(req.items)
        if not selection_items:
            raise HTTPException(status_code=422, detail="items must contain at least one valid distribution/profile pair.")

        cache_key = (
            "distribution_geometry_window",
            tuple(selection_items),
            str(req.measurement_kind),
            tuple(int(value) for value in req.atom_indices),
            int(req.bins),
            round(float(req.window_center_ev), 8),
            round(float(req.window_width_ev), 8),
        )
        cached_value = distribution_analysis_cache.get(cache_key)
        if cached_value is not None:
            return DistributionCompareGeometryWindowResponse(**cached_value)

        resolved_items = _collect_distribution_selection_items(selection_items)
        try:
            payload = build_windowed_geometry_comparison(
                resolved_items,
                measurement_kind=str(req.measurement_kind),
                atom_indices=[int(value) for value in req.atom_indices],
                bins=int(req.bins),
                window_center_ev=float(req.window_center_ev),
                window_width_ev=float(req.window_width_ev),
            )
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"Failed to compute windowed geometry comparison: {exc}") from exc

        distribution_analysis_cache.put(cache_key, payload)
        return DistributionCompareGeometryWindowResponse(**payload)

    @app.post(
        f"{api_base}/distributions/project-soap-umap",
        response_model=DistributionSoapUmapWindowResponse,
    )
    def project_distribution_soap_umap(
        req: DistributionSoapUmapRequest,
    ) -> DistributionSoapUmapWindowResponse:
        distribution_ids = _normalize_distribution_ids(req.distribution_ids)
        if not distribution_ids:
            raise HTTPException(status_code=422, detail="distribution_ids must contain at least one valid item.")

        soap_atom_indices = [int(value) for value in req.soap_atom_indices]
        cache_key = (
            "distribution_soap_umap",
            tuple(distribution_ids),
            tuple(soap_atom_indices),
            round(float(req.soap_r_cut), 8),
            int(req.soap_n_max),
            int(req.soap_l_max),
            round(float(req.soap_sigma), 8),
            int(req.umap_n_neighbors),
            round(float(req.umap_min_dist), 8),
            str(req.umap_metric).strip().lower(),
            int(req.umap_random_state),
        )
        cached_value = distribution_projection_cache.get(cache_key)
        if cached_value is not None:
            return DistributionSoapUmapWindowResponse(**cached_value)

        bundles = _collect_distribution_bundles(distribution_ids)
        try:
            with soap_feature_cache_lock:
                payload = build_soap_umap_projection(
                    bundles,
                    soap_atom_indices=(soap_atom_indices or None),
                    soap_r_cut=float(req.soap_r_cut),
                    soap_n_max=int(req.soap_n_max),
                    soap_l_max=int(req.soap_l_max),
                    soap_sigma=float(req.soap_sigma),
                    umap_n_neighbors=int(req.umap_n_neighbors),
                    umap_min_dist=float(req.umap_min_dist),
                    umap_metric=str(req.umap_metric),
                    umap_random_state=int(req.umap_random_state),
                    feature_cache=soap_feature_cache,
                )
        except ModuleNotFoundError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"Failed to compute SOAP UMAP projection: {exc}") from exc

        distribution_projection_cache.put(cache_key, payload)
        return DistributionSoapUmapWindowResponse(**payload)

    @app.post(
        f"{api_base}/distributions/project-soap-umap-window",
        response_model=DistributionSoapUmapWindowResponse,
    )
    def project_distribution_soap_umap_window(
        req: DistributionSoapUmapWindowRequest,
    ) -> DistributionSoapUmapWindowResponse:
        selection_items = _normalize_distribution_selection_items(req.items)
        if not selection_items:
            raise HTTPException(status_code=422, detail="items must contain at least one valid distribution/profile pair.")

        soap_atom_indices = [int(value) for value in req.soap_atom_indices]
        cache_key = (
            "distribution_soap_umap_window",
            tuple(selection_items),
            round(float(req.window_center_ev), 8),
            round(float(req.window_width_ev), 8),
            tuple(soap_atom_indices),
            round(float(req.soap_r_cut), 8),
            int(req.soap_n_max),
            int(req.soap_l_max),
            round(float(req.soap_sigma), 8),
            int(req.umap_n_neighbors),
            round(float(req.umap_min_dist), 8),
            str(req.umap_metric).strip().lower(),
            int(req.umap_random_state),
        )
        cached_value = distribution_projection_cache.get(cache_key)
        if cached_value is not None:
            return DistributionSoapUmapWindowResponse(**cached_value)

        resolved_items = _collect_distribution_selection_items(selection_items)
        try:
            with soap_feature_cache_lock:
                payload = build_windowed_soap_umap_projection(
                    resolved_items,
                    window_center_ev=float(req.window_center_ev),
                    window_width_ev=float(req.window_width_ev),
                    soap_atom_indices=(soap_atom_indices or None),
                    soap_r_cut=float(req.soap_r_cut),
                    soap_n_max=int(req.soap_n_max),
                    soap_l_max=int(req.soap_l_max),
                    soap_sigma=float(req.soap_sigma),
                    umap_n_neighbors=int(req.umap_n_neighbors),
                    umap_min_dist=float(req.umap_min_dist),
                    umap_metric=str(req.umap_metric),
                    umap_random_state=int(req.umap_random_state),
                    feature_cache=soap_feature_cache,
                )
        except ModuleNotFoundError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"Failed to compute SOAP UMAP projection: {exc}") from exc

        distribution_projection_cache.put(cache_key, payload)
        return DistributionSoapUmapWindowResponse(**payload)

    @app.post(f"{api_base}/distributions/compare-spectrum", response_model=DistributionCompareSpectrumResponse)
    def compare_distribution_spectrum(req: DistributionCompareSpectrumRequest) -> DistributionCompareSpectrumResponse:
        series_items = _normalize_spectrum_series_request_items(req.series)
        if not series_items:
            raise HTTPException(status_code=422, detail="series must contain at least one valid item.")

        comparable_series, skipped_payloads, excitation_energy_sets_ev = _collect_comparable_spectrum_series(
            series_items
        )

        if not comparable_series:
            raise HTTPException(
                status_code=422,
                detail="No selected spectrum series with valid electronic transitions are available for spectrum comparison.",
            )

        available_pairs = _collect_common_spectrum_pairs(comparable_series)

        x_energy_ev = _build_absorption_energy_grid(
            excitation_energy_sets_ev=excitation_energy_sets_ev,
            delta_ev=float(req.delta_ev),
        )

        series_payloads: list[DistributionSpectrumSeries] = []
        for distribution_id, bundle, profile_id, profile in comparable_series:
            try:
                spectrum_payload = compute_absorption_spectrum(
                    profile,
                    x_energy_ev=x_energy_ev,
                    delta_ev=float(req.delta_ev),
                    pair_overlays=available_pairs,
                )
            except ValueError as exc:
                skipped_payloads.append(
                    {
                        "distribution_id": str(distribution_id),
                        "distribution_label": str(bundle.label),
                        "profile_id": str(profile_id),
                        "profile_label": str(profile.label),
                        "reason": str(exc),
                    }
                )
                continue

            series_payloads.append(
                DistributionSpectrumSeries(
                    distribution_id=str(distribution_id),
                    distribution_label=str(bundle.label),
                    source_name=str(bundle.source_name),
                    profile_id=str(profile_id),
                    profile_label=str(profile.label),
                    series_label=_build_series_label(bundle=bundle, profile=profile),
                    total_y_normalized=[float(value) for value in spectrum_payload["total_y_normalized"]],
                    pair_curves=[
                        DistributionSpectrumPairCurve(
                            pair=[int(value) for value in pair_payload["pair"]],
                            y_normalized=[float(value) for value in pair_payload["y_normalized"]],
                        )
                        for pair_payload in spectrum_payload["pair_curves"]
                    ],
                )
            )

        if not series_payloads:
            raise HTTPException(
                status_code=422,
                detail="No selected spectrum series could be rendered into an absorption spectrum.",
            )

        return DistributionCompareSpectrumResponse(
            delta_ev=float(req.delta_ev),
            x_energy_ev=[float(value) for value in x_energy_ev.tolist()],
            available_pairs=_build_transition_pair_options(available_pairs),
            series=series_payloads,
            skipped=[DistributionSpectrumSkippedItem(**item) for item in skipped_payloads],
        )

    @app.get(f"{api_base}/files", response_model=FileBrowserResponse)
    def list_files(path: str | None = None) -> FileBrowserResponse:
        current_dir = _resolve_browse_path(path)
        if not current_dir.is_dir():
            raise HTTPException(status_code=422, detail=f"Path is not a directory: {path or '.'}")
        return _build_file_browser_response(
            current_dir,
            is_loadable=lambda child, kind: kind == "file" and _path_matches_suffixes(child, LOADABLE_DATASET_SUFFIXES),
        )

    @app.post(f"{api_base}/load-dataset", response_model=LoadDatasetResponse)
    def load_dataset(req: LoadDatasetRequest) -> LoadDatasetResponse:
        if load_store_from_path is None:
            raise HTTPException(status_code=501, detail="Dataset loading is not enabled on this server.")

        target_path = _resolve_browse_path(req.path)
        if not target_path.is_file():
            raise HTTPException(status_code=422, detail=f"Path is not a file: {req.path}")
        if not _path_matches_suffixes(target_path, LOADABLE_DATASET_SUFFIXES):
            raise HTTPException(status_code=422, detail="Only .pkl and .pickle files can be loaded.")

        try:
            new_store = load_store_from_path(target_path)
        except Exception as exc:  # noqa: BLE001
            logger.exception("Dataset load failed before activation. path=%s", target_path)
            raise HTTPException(status_code=500, detail=f"Failed to load dataset: {exc}") from exc

        payload = _activate_store(new_store, action_label="Dataset load", reset_aliases=True)
        return LoadDatasetResponse(**payload)

    @app.post(f"{api_base}/inspect-keys", response_model=InspectKeysResponse)
    def inspect_keys(req: InspectKeysRequest) -> InspectKeysResponse:
        keys = _normalize_inspect_keys(req.keys)
        if len(keys) > MAX_INSPECT_KEYS:
            raise HTTPException(status_code=422, detail=f"Too many keys (max {MAX_INSPECT_KEYS}).")

        current_store, _, _ = _get_runtime_snapshot()
        try:
            payload = current_store.inspect_raw_keys(keys)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"Failed to inspect keys: {exc}") from exc
        return InspectKeysResponse(**payload)

    @app.get(f"{api_base}/raw-key-aliases", response_model=RawKeyAliasListResponse)
    def list_raw_key_aliases() -> RawKeyAliasListResponse:
        with runtime_lock:
            payload = {"aliases": _build_raw_key_alias_items(runtime_state["raw_key_aliases"])}
        return RawKeyAliasListResponse(**payload)

    @app.post(f"{api_base}/raw-key-aliases", response_model=RawKeyAliasListResponse)
    def upsert_raw_key_alias(req: RawKeyAliasUpsertRequest) -> RawKeyAliasListResponse:
        alias = str(req.alias).strip()
        raw_key = str(req.raw_key).strip()
        if not alias:
            raise HTTPException(status_code=422, detail="alias must be a non-empty string.")
        if not raw_key:
            raise HTTPException(status_code=422, detail="raw_key must be a non-empty string.")
        if alias in ALLOWED_OBSERVABLES or alias == "raw_key":
            raise HTTPException(
                status_code=422,
                detail=f"alias '{alias}' conflicts with a built-in observable name.",
            )
        if alias.startswith(RAW_ALIAS_PREFIX):
            raise HTTPException(
                status_code=422,
                detail=f"alias must not start with reserved prefix '{RAW_ALIAS_PREFIX}'.",
            )

        current_store, _, _ = _get_runtime_snapshot()
        try:
            exists = _raw_key_exists(current_store, raw_key)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"Failed to validate raw key: {exc}") from exc
        if not exists:
            raise HTTPException(status_code=422, detail=f"raw_key '{raw_key}' was not found in current dataset.")

        with runtime_lock:
            alias_map = runtime_state["raw_key_aliases"]
            alias_map[alias] = raw_key
            _update_bootstrap_locked()
            payload = {"aliases": _build_raw_key_alias_items(alias_map)}
        return RawKeyAliasListResponse(**payload)

    @app.post(f"{api_base}/raw-key-series", response_model=RawKeySeriesResponse)
    def get_raw_key_series(req: RawKeySeriesRequest) -> RawKeySeriesResponse:
        traj_id = str(req.traj_id)
        raw_key = str(req.raw_key).strip()
        if not raw_key:
            raise HTTPException(status_code=422, detail="raw_key must be a non-empty string.")

        cache_key = ("raw_key_series", traj_id, raw_key)
        cached_value = cache.get(cache_key)
        if cached_value is not None:
            payload = dict(cached_value)
            payload["cached"] = True
            return RawKeySeriesResponse(**payload)

        current_store, _, _ = _get_runtime_snapshot()
        try:
            series = current_store.build_raw_key_series(traj_id, raw_key)
        except KeyError as exc:
            detail = str(exc.args[0]) if exc.args else str(exc)
            raise HTTPException(status_code=404, detail=detail) from exc
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"Failed to compute raw-key series: {exc}") from exc

        response_payload: dict[str, Any] = {
            "traj_id": traj_id,
            "raw_key": raw_key,
            **series,
        }
        cache.put(cache_key, response_payload)
        out = dict(response_payload)
        out["cached"] = False
        return RawKeySeriesResponse(**out)

    @app.post(f"{api_base}/expression-series", response_model=ExpressionSeriesResponse)
    def get_expression_series(req: ExpressionSeriesRequest) -> ExpressionSeriesResponse:
        traj_id = str(req.traj_id)
        expression = str(req.expression).strip()
        if not expression:
            raise HTTPException(status_code=422, detail="expression must be a non-empty string.")

        cache_key = ("expression_series", traj_id, expression)
        cached_value = cache.get(cache_key)
        if cached_value is not None:
            payload = dict(cached_value)
            payload["cached"] = True
            return ExpressionSeriesResponse(**payload)

        current_store, _, _ = _get_runtime_snapshot()
        try:
            payload = evaluate_expression_payload(
                store=current_store,
                expression=expression,
                traj_id=traj_id,
            )
        except KeyError as exc:
            detail = str(exc.args[0]) if exc.args else str(exc)
            raise HTTPException(status_code=404, detail=detail) from exc
        except (ExpressionEvaluationError, ValueError) as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"Failed to evaluate expression series: {exc}") from exc

        response_payload: dict[str, Any] = {
            "traj_id": traj_id,
            "expression": expression,
            "scope": str(payload.scope),
            "series_kind": str(payload.series_kind),
            "time": [float(v) for v in payload.time],
            "value": _json_safe_float_list(payload.value),
            "values": _json_safe_matrix(payload.values),
            "n_points": int(payload.n_points),
            "n_components": (None if payload.n_components is None else int(payload.n_components)),
            "n_trajectories": int(payload.n_trajectories),
            "sample_count": (None if payload.sample_count is None else [int(v) for v in payload.sample_count]),
        }
        cache.put(cache_key, response_payload)

        out = dict(response_payload)
        out["cached"] = False
        return ExpressionSeriesResponse(**out)

    @app.post(f"{api_base}/expression-ensemble", response_model=ExpressionEnsembleResponse)
    def get_expression_ensemble(req: ExpressionEnsembleRequest) -> ExpressionEnsembleResponse:
        expression = str(req.expression).strip()
        stat_mode = str(req.stat_mode)
        if not expression:
            raise HTTPException(status_code=422, detail="expression must be a non-empty string.")

        cache_key = ("expression_ensemble", expression, stat_mode)
        cached_value = cache.get(cache_key)
        if cached_value is not None:
            payload = dict(cached_value)
            payload["cached"] = True
            return ExpressionEnsembleResponse(**payload)

        current_store, _, _ = _get_runtime_snapshot()
        traj_ids = list(current_store.traj_ids)

        try:
            series_records: list[dict[str, Any]] = []
            series_kind: str | None = None
            for traj_id in traj_ids:
                payload = evaluate_expression_payload(
                    store=current_store,
                    expression=expression,
                    traj_id=traj_id,
                )
                record_kind = str(payload.series_kind)
                if series_kind is None:
                    series_kind = record_kind
                elif record_kind != series_kind:
                    raise HTTPException(
                        status_code=422,
                        detail=(
                            f"Expression '{expression}' has mixed series kinds across trajectories "
                            "(scalar and matrix), which is unsupported for ensemble statistics."
                        ),
                    )
                series_records.append(
                    {
                        "series_kind": record_kind,
                        "time": [float(v) for v in payload.time],
                        "value": _json_safe_float_list(payload.value),
                        "values": _json_safe_matrix(payload.values),
                        "n_components": (None if payload.n_components is None else int(payload.n_components)),
                    }
                )

            if not series_records or series_kind is None:
                raise HTTPException(
                    status_code=422,
                    detail=f"No ensemble data is available for expression '{expression}'.",
                )

            component_series: list[dict[str, Any]] = []
            n_components: int | None = None
            if series_kind == "scalar":
                effective_stat_mode = _effective_scalar_stat_mode(stat_mode, n_components=1)
                scalar_series = [_as_scalar_series_record(record) for record in series_records]
                component_series.append(
                    _build_ensemble_component_payload(
                        scalar_series_list=scalar_series,
                        stat_mode=effective_stat_mode,
                        context_key=f"expression:{expression}",
                        component_index=0,
                    )
                )
            else:
                component_series, max_components = _build_matrix_ensemble_component_payloads(
                    matrix_series_records=series_records,
                    stat_mode=stat_mode,
                    context_key=f"expression:{expression}",
                )
                n_components = int(max_components)
        except HTTPException:
            raise
        except KeyError as exc:
            detail = str(exc.args[0]) if exc.args else str(exc)
            raise HTTPException(status_code=404, detail=detail) from exc
        except (ExpressionEvaluationError, ValueError) as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"Failed to evaluate expression ensemble: {exc}") from exc

        response_payload: dict[str, Any] = {
            "expression": expression,
            "series_kind": series_kind,
            "n_components": n_components,
            "stat_mode": stat_mode,
            "component_series": component_series,
            "n_trajectories": len(traj_ids),
        }
        cache.put(cache_key, response_payload)

        out = dict(response_payload)
        out["cached"] = False
        return ExpressionEnsembleResponse(**out)

    @app.post(f"{api_base}/expression-dataset")
    def get_expression_dataset(req: ExpressionDatasetRequest) -> None:
        expression = str(req.expression).strip()
        if not expression:
            raise HTTPException(status_code=422, detail="expression must be a non-empty string.")
        raise HTTPException(
            status_code=422,
            detail=(
                "Dataset-scoped expression evaluation is disabled. "
                "Expression only supports single-trajectory mode; use /expression-series with a traj_id."
            ),
        )

    @app.post(f"{api_base}/hopping-events", response_model=HoppingEventsResponse)
    def get_hopping_events(req: HoppingEventsRequest) -> HoppingEventsResponse:
        traj_ids = []
        seen_ids: set[str] = set()
        for raw_traj_id in req.traj_ids:
            traj_id = str(raw_traj_id).strip()
            if not traj_id or traj_id in seen_ids:
                continue
            traj_ids.append(traj_id)
            seen_ids.add(traj_id)
        if not traj_ids:
            raise HTTPException(status_code=422, detail="At least one traj_id is required for hopping detection.")

        algorithm = str(req.algorithm)
        time_rule = str(req.time_rule)
        transitions = [
            {
                "from_state": int(item.from_state),
                "to_state": int(item.to_state),
            }
            for item in req.transitions
        ]
        cache_key = (
            "hopping_events",
            tuple(traj_ids),
            algorithm,
            time_rule,
            tuple((int(item["from_state"]), int(item["to_state"])) for item in transitions),
        )
        cached_value = cache.get(cache_key)
        if cached_value is not None:
            payload = dict(cached_value)
            payload["cached"] = True
            return HoppingEventsResponse(**payload)

        current_store, _, _ = _get_runtime_snapshot()
        try:
            payload = current_store.build_hopping_events(
                traj_ids,
                algorithm=algorithm,
                time_rule=time_rule,
                transitions=transitions,
            )
        except KeyError as exc:
            detail = str(exc.args[0]) if exc.args else str(exc)
            raise HTTPException(status_code=404, detail=detail) from exc
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"Failed to compute hopping events: {exc}") from exc

        cache.put(cache_key, payload)
        out = dict(payload)
        out["cached"] = False
        return HoppingEventsResponse(**out)

    @app.post(f"{api_base}/ensemble-series", response_model=EnsembleSeriesResponse)
    def get_ensemble_series(req: EnsembleSeriesRequest) -> EnsembleSeriesResponse:
        observable = str(req.observable)
        indices = _normalize_indices(req.indices)
        raw_key = str(req.raw_key or "").strip()
        stat_mode = str(req.stat_mode)

        if observable == "raw_key":
            if indices:
                raise HTTPException(status_code=422, detail="Observable 'raw_key' does not accept indices.")
            if not raw_key:
                raise HTTPException(status_code=422, detail="Observable 'raw_key' requires a non-empty raw_key.")
        else:
            if observable not in ALLOWED_OBSERVABLES:
                raise HTTPException(status_code=400, detail=f"Unsupported observable: {observable}")
            if raw_key:
                raise HTTPException(
                    status_code=422,
                    detail="raw_key must be empty unless observable is 'raw_key'.",
                )

        cache_key = ("ensemble", observable, tuple(indices), raw_key, stat_mode)
        cached_value = cache.get(cache_key)
        if cached_value is not None:
            payload = dict(cached_value)
            payload["cached"] = True
            return EnsembleSeriesResponse(**payload)

        current_store, _, _ = _get_runtime_snapshot()
        traj_ids = list(current_store.traj_ids)
        component_series: list[dict[str, Any]] = []

        try:
            if observable == "raw_key":
                raw_series_records: list[dict[str, Any]] = []
                series_kind: str | None = None
                component_labels: list[str] | None = None
                labels_mismatch = False

                for traj_id in traj_ids:
                    series = current_store.build_raw_key_series(traj_id, raw_key)
                    record_kind = str(series.get("series_kind", "scalar"))
                    if series_kind is None:
                        series_kind = record_kind
                    elif record_kind != series_kind:
                        raise HTTPException(
                            status_code=422,
                            detail=(
                                f"Raw key '{raw_key}' has mixed series kinds across trajectories "
                                "(scalar and matrix), which is unsupported for ensemble statistics."
                            ),
                        )
                    if record_kind == "matrix":
                        labels = series.get("component_labels")
                        if isinstance(labels, list):
                            labels_text = [str(v) for v in labels]
                            if component_labels is None:
                                component_labels = labels_text
                            elif labels_text != component_labels:
                                labels_mismatch = True
                        elif component_labels is not None:
                            labels_mismatch = True
                    raw_series_records.append(series)

                if not raw_series_records or series_kind is None:
                    raise HTTPException(
                        status_code=422,
                        detail=f"No ensemble data is available for raw key '{raw_key}'.",
                    )

                if series_kind == "scalar":
                    effective_stat_mode = _effective_scalar_stat_mode(stat_mode, n_components=1)
                    scalar_series = [_as_scalar_series_record(record) for record in raw_series_records]
                    component_series.append(
                        _build_ensemble_component_payload(
                            scalar_series_list=scalar_series,
                            stat_mode=effective_stat_mode,
                            context_key=f"raw_key:{raw_key}",
                            component_index=0,
                        )
                    )
                else:
                    if labels_mismatch:
                        component_labels = None
                    matrix_component_series, _ = _build_matrix_ensemble_component_payloads(
                        matrix_series_records=raw_series_records,
                        stat_mode=stat_mode,
                        context_key=f"raw_key:{raw_key}",
                        component_labels=component_labels,
                    )
                    component_series.extend(matrix_component_series)
            else:
                series_records: list[dict[str, Any]] = []
                series_kind: str | None = None
                for traj_id in traj_ids:
                    traj = current_store.get_trajectory(traj_id)
                    if traj is None:
                        raise HTTPException(status_code=404, detail=f"Trajectory not found: {traj_id}")
                    _validate_request(
                        observable=observable,
                        indices=indices,
                        n_atoms=int(traj.n_atoms),
                        de_nac_state_count=int(traj.de_nac_state_count),
                    )
                    series = compute_observable_series(traj, observable, indices)
                    record_kind = str(series.get("series_kind", "scalar"))
                    if series_kind is None:
                        series_kind = record_kind
                    elif record_kind != series_kind:
                        raise HTTPException(
                            status_code=422,
                            detail=f"Observable '{observable}' has mixed series kinds across trajectories.",
                        )
                    series_records.append(series)

                if not series_records or series_kind is None:
                    raise HTTPException(
                        status_code=422,
                        detail=f"No ensemble data is available for observable '{observable}'.",
                    )

                if series_kind == "scalar":
                    effective_stat_mode = _effective_scalar_stat_mode(stat_mode, n_components=1)
                    scalar_series = [_as_scalar_series_record(record) for record in series_records]
                    component_series.append(
                        _build_ensemble_component_payload(
                            scalar_series_list=scalar_series,
                            stat_mode=effective_stat_mode,
                            context_key=observable,
                            component_index=0,
                        )
                    )
                else:
                    matrix_component_series, _ = _build_matrix_ensemble_component_payloads(
                        matrix_series_records=series_records,
                        stat_mode=stat_mode,
                        context_key=observable,
                    )
                    component_series.extend(matrix_component_series)
        except HTTPException:
            raise
        except KeyError as exc:
            detail = str(exc.args[0]) if exc.args else str(exc)
            raise HTTPException(status_code=404, detail=detail) from exc
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"Failed to compute ensemble series: {exc}") from exc

        response_payload: dict[str, Any] = {
            "observable": observable,
            "indices": indices,
            "raw_key": (raw_key if observable == "raw_key" else None),
            "stat_mode": stat_mode,
            "component_series": component_series,
            "n_trajectories": len(traj_ids),
        }
        cache.put(cache_key, response_payload)

        out = dict(response_payload)
        out["cached"] = False
        return EnsembleSeriesResponse(**out)

    @app.post(f"{api_base}/refresh-dataset", response_model=RefreshDatasetResponse)
    def refresh_dataset() -> RefreshDatasetResponse:
        if load_store_from_path is None:
            logger.warning("Dataset refresh requested but load_store_from_path is not configured.")
            raise HTTPException(status_code=501, detail="Dataset refresh is not enabled on this server.")

        current_store, _, current_revision = _get_runtime_snapshot()
        if not _dataset_is_loaded(current_store):
            raise HTTPException(status_code=409, detail="No dataset is currently loaded; use load-dataset first.")

        logger.info("Dataset refresh requested. current_revision=%d", current_revision)

        try:
            new_store = load_store_from_path(Path(current_store.input_path).resolve())
        except Exception as exc:  # noqa: BLE001
            logger.exception("Dataset reload failed before activation.")
            raise HTTPException(status_code=500, detail=f"Failed to reload dataset: {exc}") from exc

        payload = _activate_store(new_store, action_label="Dataset refresh", reset_aliases=False)
        return RefreshDatasetResponse(**payload)

    @app.get(f"{api_base}/molecule3d/trajectory/{{traj_id}}", response_model=MoleculeTrajectoryResponse)
    def get_molecule3d_trajectory(traj_id: str) -> MoleculeTrajectoryResponse:
        tid = str(traj_id)
        cache_key = ("mol3d_coords", tid)
        cached_value = mol3d_cache.get(cache_key)
        if cached_value is not None:
            payload = dict(cached_value)
            payload["cached"] = True
            return MoleculeTrajectoryResponse(**payload)

        current_store, _, _ = _get_runtime_snapshot()
        try:
            payload = current_store.build_mol3d_payload(tid)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"Failed to prepare molecule3d trajectory: {exc}") from exc
        if payload is None:
            raise HTTPException(status_code=404, detail=f"Trajectory not found: {tid}")

        mol3d_cache.put(cache_key, payload)
        out = dict(payload)
        out["cached"] = False
        return MoleculeTrajectoryResponse(**out)

    @app.get(f"{api_base}/molecule3d/nac/{{traj_id}}", response_model=MoleculeNacResponse)
    def get_molecule3d_nac(traj_id: str, state_i: int, state_j: int) -> MoleculeNacResponse:
        tid = str(traj_id)
        si = int(state_i)
        sj = int(state_j)
        cache_key = ("mol3d_nac_pair", tid, si, sj)
        cached_value = mol3d_cache.get(cache_key)
        if cached_value is not None:
            payload = dict(cached_value)
            payload["cached"] = True
            return MoleculeNacResponse(**payload)

        current_store, _, _ = _get_runtime_snapshot()
        try:
            payload = current_store.build_mol3d_nac_payload(tid, si, sj)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"Failed to prepare molecule3d NAC payload: {exc}") from exc
        if payload is None:
            raise HTTPException(status_code=404, detail=f"Trajectory not found: {tid}")

        mol3d_cache.put(cache_key, payload)
        out = dict(payload)
        out["cached"] = False
        return MoleculeNacResponse(**out)

    @app.get(f"{api_base}/molecule3d/de/{{traj_id}}", response_model=MoleculeDeResponse)
    def get_molecule3d_de(traj_id: str, state_i: int, state_j: int) -> MoleculeDeResponse:
        tid = str(traj_id)
        si = int(state_i)
        sj = int(state_j)
        cache_key = ("mol3d_de_pair", tid, si, sj)
        cached_value = mol3d_cache.get(cache_key)
        if cached_value is not None:
            payload = dict(cached_value)
            payload["cached"] = True
            return MoleculeDeResponse(**payload)

        current_store, _, _ = _get_runtime_snapshot()
        try:
            payload = current_store.build_mol3d_de_payload(tid, si, sj)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"Failed to prepare molecule3d dE payload: {exc}") from exc
        if payload is None:
            raise HTTPException(status_code=404, detail=f"Trajectory not found: {tid}")

        mol3d_cache.put(cache_key, payload)
        out = dict(payload)
        out["cached"] = False
        return MoleculeDeResponse(**out)

    @app.get(f"{api_base}/molecule3d/de_nac/{{traj_id}}", response_model=MoleculeDeNacResponse)
    def get_molecule3d_de_nac(traj_id: str, state_i: int, state_j: int) -> MoleculeDeNacResponse:
        tid = str(traj_id)
        si = int(state_i)
        sj = int(state_j)
        cache_key = ("mol3d_de_nac_pair", tid, si, sj)
        cached_value = mol3d_cache.get(cache_key)
        if cached_value is not None:
            payload = dict(cached_value)
            payload["cached"] = True
            return MoleculeDeNacResponse(**payload)

        current_store, _, _ = _get_runtime_snapshot()
        try:
            payload = current_store.build_mol3d_de_nac_payload(tid, si, sj)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"Failed to prepare molecule3d de_nac payload: {exc}") from exc
        if payload is None:
            raise HTTPException(status_code=404, detail=f"Trajectory not found: {tid}")

        mol3d_cache.put(cache_key, payload)
        out = dict(payload)
        out["cached"] = False
        return MoleculeDeNacResponse(**out)

    @app.get(f"{api_base}/molecule3d/hbonds/{{traj_id}}", response_model=MoleculeHydrogenBondResponse)
    def get_molecule3d_hbonds(traj_id: str) -> MoleculeHydrogenBondResponse:
        tid = str(traj_id)
        cache_key = ("mol3d_hbonds", tid)
        cached_value = mol3d_cache.get(cache_key)
        if cached_value is not None:
            payload = dict(cached_value)
            payload["cached"] = True
            return MoleculeHydrogenBondResponse(**payload)

        current_store, _, _ = _get_runtime_snapshot()
        try:
            payload = current_store.build_mol3d_hbond_payload(tid)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"Failed to prepare molecule3d hbond payload: {exc}") from exc
        if payload is None:
            raise HTTPException(status_code=404, detail=f"Trajectory not found: {tid}")

        mol3d_cache.put(cache_key, payload)
        out = dict(payload)
        out["cached"] = False
        return MoleculeHydrogenBondResponse(**out)

    @app.post(f"{api_base}/series", response_model=SeriesResponse)
    def get_series(req: SeriesRequest) -> SeriesResponse:
        traj_id = str(req.traj_id)
        observable = str(req.observable)
        indices = _normalize_indices(req.indices)

        current_store, _, _ = _get_runtime_snapshot()
        traj = current_store.get_trajectory(traj_id)
        if traj is None:
            raise HTTPException(status_code=404, detail=f"Trajectory not found: {traj_id}")

        _validate_request(
            observable=observable,
            indices=indices,
            n_atoms=traj.n_atoms,
            de_nac_state_count=int(traj.de_nac_state_count),
        )

        cache_key = (traj_id, observable, tuple(indices))
        cached_value = cache.get(cache_key)
        if cached_value is not None:
            payload = dict(cached_value)
            payload["cached"] = True
            return SeriesResponse(**payload)

        try:
            series = compute_observable_series(traj, observable, indices)
        except HTTPException:
            raise
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"Failed to compute series: {exc}") from exc

        response_payload: dict[str, Any] = {
            "traj_id": traj_id,
            "observable": observable,
            "indices": indices,
            **series,
        }
        cache.put(cache_key, response_payload)

        out = dict(response_payload)
        out["cached"] = False
        return SeriesResponse(**out)

    return app
