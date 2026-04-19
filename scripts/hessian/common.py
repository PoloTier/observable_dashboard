from __future__ import annotations

import json
import re
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Sequence


SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from scripts.electronic_structure.common import (  # noqa: E402
    GeometryBundle,
    load_geometry_bundle,
    normalize_profile_id,
)


@dataclass(frozen=True, slots=True)
class HessianTarget:
    output_id: str
    source_kind: str
    sample_idx: int
    sample_id: str
    selection_id: str | None = None
    subset_geometry_index: int | None = None


@dataclass(frozen=True, slots=True)
class HessianWorkspaceResult:
    workspace_dir: Path
    profile_id: str
    target_count: int
    success_count: int
    failed_count: int


def slugify_workspace_part(value: Any, *, fallback: str) -> str:
    text = re.sub(r"[^A-Za-z0-9._-]+", "_", str(value or "").strip())
    text = re.sub(r"_+", "_", text).strip("._-")
    return text or fallback


def default_workspace_dir(*, sampling_dir: Path, profile_id: str) -> Path:
    return Path(sampling_dir) / "hessian_workspaces" / str(profile_id).strip()


def prepare_workspace_dir(path: Path, *, force: bool) -> None:
    if path.exists():
        if not path.is_dir():
            raise ValueError(f"Workspace path exists but is not a directory: {path}")
        if any(path.iterdir()):
            if not force:
                raise ValueError(f"Workspace directory must be empty unless --force is provided: {path}")
            shutil.rmtree(path)
        else:
            path.rmdir()
    path.mkdir(parents=True, exist_ok=False)


def load_selection_records(selection_dir: Path) -> list[dict[str, Any]]:
    records_path = Path(selection_dir) / "selected_records.json"
    if not records_path.is_file():
        raise ValueError(f"Selection directory is missing required file: {records_path}")
    try:
        payload = json.loads(records_path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        raise ValueError(f"Failed to decode selection records {records_path}: {exc}") from exc
    if not isinstance(payload, list):
        raise ValueError(f"Selection records {records_path} must decode to a JSON list.")
    records: list[dict[str, Any]] = []
    for index, item in enumerate(payload):
        if not isinstance(item, dict):
            raise ValueError(f"Selection record {index} in {records_path} must be a JSON object.")
        records.append(dict(item))
    return records


def _normalize_int_filter(values: Sequence[int | str] | None, *, label: str) -> list[int]:
    normalized: list[int] = []
    seen: set[int] = set()
    for raw_value in list(values or []):
        for token in str(raw_value).replace(",", " ").split():
            try:
                value = int(token)
            except ValueError as exc:
                raise ValueError(f"{label} entries must be integers, found {token!r}.") from exc
            if value < 0:
                raise ValueError(f"{label} entries must be >= 0, found {value}.")
            if value in seen:
                continue
            seen.add(value)
            normalized.append(value)
    return normalized


def _normalize_text_filter(values: Sequence[str] | None) -> list[str]:
    normalized: list[str] = []
    seen: set[str] = set()
    for raw_value in list(values or []):
        for token in str(raw_value).replace(",", " ").split():
            value = str(token).strip()
            if not value:
                continue
            if value in seen:
                continue
            seen.add(value)
            normalized.append(value)
    return normalized


def _bundle_target_output_id(*, sample_idx: int, sample_id: str) -> str:
    return normalize_profile_id(
        f"sample_{int(sample_idx):06d}__{slugify_workspace_part(sample_id, fallback='sample')}",
        label="target_output_id",
    )


def _selection_target_output_id(
    *,
    subset_geometry_index: int,
    sample_idx: int,
    sample_id: str,
) -> str:
    return normalize_profile_id(
        "__".join(
            [
                f"geom_{int(subset_geometry_index):06d}",
                f"sample_{int(sample_idx):06d}",
                slugify_workspace_part(sample_id, fallback="sample"),
            ]
        ),
        label="target_output_id",
    )


def resolve_hessian_targets(
    *,
    bundle_path: Path,
    selection_id: str | None = None,
    sample_indices: Sequence[int | str] | None = None,
    sample_ids: Sequence[str] | None = None,
    subset_geometry_indices: Sequence[int | str] | None = None,
) -> tuple[GeometryBundle, list[HessianTarget]]:
    bundle = load_geometry_bundle(bundle_path)

    normalized_sample_indices = set(_normalize_int_filter(sample_indices, label="sample_indices"))
    normalized_sample_ids = set(_normalize_text_filter(sample_ids))
    normalized_subset_indices = set(
        _normalize_int_filter(subset_geometry_indices, label="subset_geometry_indices")
    )

    if normalized_subset_indices and selection_id is None:
        raise ValueError("--subset-geometry-index requires --selection-id.")

    if selection_id is None:
        targets = [
            HessianTarget(
                output_id=_bundle_target_output_id(sample_idx=sample.sample_idx, sample_id=sample.sample_id),
                source_kind="bundle_sample",
                sample_idx=int(sample.sample_idx),
                sample_id=str(sample.sample_id),
            )
            for sample in bundle.samples
        ]
    else:
        normalized_selection_id = normalize_profile_id(selection_id, label="selection_id")
        selection_dir = bundle.bundle_path / "selection" / normalized_selection_id
        if not selection_dir.is_dir():
            raise ValueError(f"Selection directory does not exist: {selection_dir}")

        records = load_selection_records(selection_dir)
        unique_targets_by_subset: dict[int, HessianTarget] = {}
        for record in records:
            subset_geometry_index = int(record.get("subset_geometry_index"))
            sample_idx = int(record.get("original_sample_idx"))
            sample_id = str(record.get("original_sample_id") or "").strip()
            if not sample_id:
                raise ValueError(
                    f"Selection {normalized_selection_id!r} contains a record with an empty original_sample_id."
                )
            if sample_idx < 0 or sample_idx >= bundle.n_samples:
                raise ValueError(
                    f"Selection {normalized_selection_id!r} references an out-of-range sample index: {sample_idx}."
                )
            expected_sample_id = str(bundle.sample_ids[sample_idx])
            if expected_sample_id != sample_id:
                raise ValueError(
                    "Selection record does not match the sampling bundle sample_ids ordering: "
                    f"selection={sample_id!r} bundle={expected_sample_id!r} at sample_idx={sample_idx}."
                )

            target = HessianTarget(
                output_id=_selection_target_output_id(
                    subset_geometry_index=subset_geometry_index,
                    sample_idx=sample_idx,
                    sample_id=sample_id,
                ),
                source_kind="selection_geometry",
                sample_idx=sample_idx,
                sample_id=sample_id,
                selection_id=normalized_selection_id,
                subset_geometry_index=subset_geometry_index,
            )
            previous = unique_targets_by_subset.get(subset_geometry_index)
            if previous is not None and (
                previous.sample_idx != target.sample_idx or previous.sample_id != target.sample_id
            ):
                raise ValueError(
                    "Selection unique geometry mapping is inconsistent for subset_geometry_index="
                    f"{subset_geometry_index}: {previous.sample_id}/{previous.sample_idx} vs "
                    f"{target.sample_id}/{target.sample_idx}."
                )
            unique_targets_by_subset.setdefault(subset_geometry_index, target)

        targets = [unique_targets_by_subset[index] for index in sorted(unique_targets_by_subset)]

    if normalized_sample_indices:
        targets = [target for target in targets if int(target.sample_idx) in normalized_sample_indices]
    if normalized_sample_ids:
        targets = [target for target in targets if str(target.sample_id) in normalized_sample_ids]
    if normalized_subset_indices:
        targets = [
            target
            for target in targets
            if target.subset_geometry_index is not None and int(target.subset_geometry_index) in normalized_subset_indices
        ]

    if not targets:
        raise ValueError("No target geometries matched the requested filters.")

    return bundle, targets

