from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

from fastapi import HTTPException

from backend.config import ALLOWED_OBSERVABLES, required_index_count

from backend.server.compute import (
    RENORM_MEAN_CI95_BOOTSTRAP_MODE,
    aggregate_matrix_renorm_mean_ci95_bootstrap,
    aggregate_scalar_series_by_mode,
)
from backend.server.dataset_store import DatasetStore
from backend.server.distribution_bundle import DistributionBundle
from backend.server.models import DistributionElectronicProfileItem


def normalize_indices(indices: list[int]) -> list[int]:
    out: list[int] = []
    for idx in indices:
        out.append(int(idx))
    return out


def normalize_inspect_keys(keys: list[str]) -> list[str]:
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


def build_raw_key_alias_items(raw_key_aliases: dict[str, str]) -> list[dict[str, str]]:
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


def build_bootstrap_payload(
    *,
    store: DatasetStore,
    api_base: str,
    raw_key_aliases: dict[str, str],
) -> dict[str, Any]:
    payload = dict(store.to_bootstrap(api_base=api_base))
    payload["raw_key_aliases"] = build_raw_key_alias_items(raw_key_aliases)
    return payload


def json_script_text(value: Any) -> str:
    return json.dumps(value, separators=(",", ":")).replace("</", "<\\/")


def build_distribution_list_item_payload(
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


def dataset_is_loaded(store: DatasetStore) -> bool:
    return bool(store.meta.get("dataset_loaded"))


def relative_path_text(root: Path, target: Path) -> str:
    text = target.relative_to(root).as_posix()
    return "" if text == "." else text


def path_matches_suffixes(path: Path, suffixes: tuple[str, ...] | frozenset[str]) -> bool:
    lower_name = path.name.lower()
    return any(lower_name.endswith(str(suffix).lower()) for suffix in suffixes)


def raw_key_exists(store: DatasetStore, raw_key: str) -> bool:
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


def as_scalar_series_record(record: dict[str, Any]) -> dict[str, list[float]]:
    return {
        "time": list(record.get("time", []) or []),
        "value": list(record.get("value", []) or []),
    }


def matrix_component_to_scalar_series(record: dict[str, Any], component_index: int) -> dict[str, list[float]]:
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


def build_ensemble_component_payload(
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


def matrix_component_count(record: dict[str, Any]) -> int:
    count_raw = record.get("n_components")
    count = int(count_raw) if isinstance(count_raw, int) else 0
    if count > 0:
        return count
    values_raw = list(record.get("values", []) or [])
    for row in values_raw:
        if isinstance(row, (list, tuple)):
            count = max(count, len(row))
    return count


def effective_scalar_stat_mode(stat_mode: str, *, n_components: int) -> str:
    if str(stat_mode) == RENORM_MEAN_CI95_BOOTSTRAP_MODE and int(n_components) <= 1:
        return "mean_ci95_bootstrap"
    return str(stat_mode)


def build_matrix_ensemble_component_payloads(
    *,
    matrix_series_records: list[dict[str, Any]],
    stat_mode: str,
    context_key: str,
    component_labels: list[str] | None = None,
) -> tuple[list[dict[str, Any]], int]:
    max_components = 0
    for record in matrix_series_records:
        max_components = max(max_components, matrix_component_count(record))
    if max_components <= 0:
        return [], 0

    effective_mode = effective_scalar_stat_mode(stat_mode, n_components=max_components)
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
            matrix_component_to_scalar_series(record, component_index)
            for record in matrix_series_records
        ]
        label = None
        if component_labels is not None and component_index < len(component_labels):
            label = str(component_labels[component_index])
        component_series.append(
            build_ensemble_component_payload(
                scalar_series_list=scalar_series,
                stat_mode=effective_mode,
                context_key=context_key,
                component_index=component_index,
                label=label,
            )
        )
    return component_series, max_components


def json_safe_float_list(values: list[float] | None) -> list[float | None] | None:
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


def json_safe_matrix(values: list[list[float]] | None) -> list[list[float | None]] | None:
    if values is None:
        return None
    out: list[list[float | None]] = []
    for row in values:
        out.append(json_safe_float_list(list(row)) or [])
    return out


def validate_request(
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
