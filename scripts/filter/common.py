from __future__ import annotations

import json
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Sequence


SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from backend.server.distribution_bundle import DistributionBundle  # noqa: E402
from scripts.electronic_structure.common import (  # noqa: E402
    coords_bohr_to_xyz_text,
    normalize_profile_id,
    write_json,
    write_text,
)


@dataclass(frozen=True, slots=True)
class SelectedRecord:
    selection_rank: int
    original_sample_id: str
    original_sample_idx: int
    sampled_state: int
    excitation_energy_ev: float
    subset_geometry_index: int


@dataclass(frozen=True, slots=True)
class SelectionWriteResult:
    selection_root: Path
    selection_dir: Path
    manifest_path: Path
    records_path: Path
    xyz_path: Path
    index_path: Path


def normalize_selection_id(value: Any) -> str:
    return normalize_profile_id(value, label="selection_id")


def parse_state_filter(values: Sequence[str] | None) -> list[int] | None:
    if not values:
        return None
    parsed_states: list[int] = []
    for raw_value in values:
        for token in str(raw_value).replace(",", " ").split():
            try:
                state = int(token)
            except ValueError as exc:
                raise ValueError(f"State filter entries must be integers, found {token!r}.") from exc
            if state <= 0:
                raise ValueError(f"State filter entries must be positive excited-state indices, found {state}.")
            parsed_states.append(int(state))
    if not parsed_states:
        return None
    return sorted(set(parsed_states))


def load_selection_index(selection_root: Path) -> list[dict[str, Any]]:
    index_path = Path(selection_root) / "selection_index.json"
    if not index_path.exists():
        return []
    if not index_path.is_file():
        raise ValueError(f"Selection index path exists but is not a file: {index_path}")
    try:
        payload = json.loads(index_path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        raise ValueError(f"Failed to decode selection index {index_path}: {exc}") from exc
    if not isinstance(payload, list):
        raise ValueError(f"Selection index {index_path} must be a JSON list.")
    normalized: list[dict[str, Any]] = []
    for index, item in enumerate(payload):
        if not isinstance(item, dict):
            raise ValueError(f"Selection index {index_path} entry {index} must be a JSON object.")
        normalized.append(dict(item))
    return normalized


def _selected_records_payload(selected_records: list[SelectedRecord]) -> list[dict[str, Any]]:
    return [
        {
            "selection_rank": int(record.selection_rank),
            "original_sample_id": str(record.original_sample_id),
            "original_sample_idx": int(record.original_sample_idx),
            "sampled_state": int(record.sampled_state),
            "excitation_energy_ev": float(record.excitation_energy_ev),
            "subset_geometry_index": int(record.subset_geometry_index),
        }
        for record in selected_records
    ]


def build_selected_geometries_xyz(
    bundle: DistributionBundle,
    *,
    created_at_utc: str,
    selected_count: int,
    unique_geometry_count: int,
    selected_records: list[SelectedRecord],
) -> str:
    unique_geometries: dict[int, tuple[str, int]] = {}
    for record in selected_records:
        subset_geometry_index = int(record.subset_geometry_index)
        unique_geometries.setdefault(
            subset_geometry_index,
            (str(record.original_sample_id), int(record.original_sample_idx)),
        )

    frames: list[str] = []
    for subset_geometry_index in sorted(unique_geometries):
        original_sample_id, original_sample_idx = unique_geometries[subset_geometry_index]
        frames.append(
            coords_bohr_to_xyz_text(
                bundle.atom_numbers,
                bundle.coords_bohr[original_sample_idx],
                comment_line=(
                    f"subset_geometry_index={subset_geometry_index} "
                    f"original_sample_id={original_sample_id} "
                    f"original_sample_idx={original_sample_idx} "
                    f"created_at_utc={created_at_utc} "
                    f"selected_count={int(selected_count)} "
                    f"unique_geometry_count={int(unique_geometry_count)}"
                ),
            )
        )
    return "".join(frames)


def write_selection_outputs(
    *,
    bundle_root: Path,
    bundle: DistributionBundle,
    selection_id: str,
    manifest_payload: dict[str, Any],
    selected_records: list[SelectedRecord],
    force: bool,
) -> SelectionWriteResult:
    bundle_root = Path(bundle_root).resolve()
    selection_root = bundle_root / "selection"
    if selection_root.exists() and not selection_root.is_dir():
        raise ValueError(f"Selection root exists but is not a directory: {selection_root}")
    selection_root.mkdir(parents=True, exist_ok=True)

    selection_dir = selection_root / str(selection_id)
    if selection_dir.exists():
        if not selection_dir.is_dir():
            raise ValueError(f"Selection output path exists but is not a directory: {selection_dir}")
        if not force:
            raise ValueError(
                f"Selection {selection_id!r} already exists at {selection_dir}. "
                "Use --force to replace it."
            )
        shutil.rmtree(selection_dir)
    selection_dir.mkdir(parents=False, exist_ok=False)

    manifest_path = selection_dir / "selection_manifest.json"
    records_path = selection_dir / "selected_records.json"
    xyz_path = selection_dir / "selected_geometries.xyz"
    index_path = selection_root / "selection_index.json"

    write_json(manifest_path, manifest_payload)
    write_json(records_path, _selected_records_payload(selected_records))
    write_text(
        xyz_path,
        build_selected_geometries_xyz(
            bundle,
            created_at_utc=str(manifest_payload["created_at_utc"]),
            selected_count=int(manifest_payload["selected_count"]),
            unique_geometry_count=int(manifest_payload["unique_geometry_count"]),
            selected_records=selected_records,
        ),
    )

    index_payload = load_selection_index(selection_root)
    index_entry = {
        "selection_id": str(selection_id),
        "created_at_utc": str(manifest_payload["created_at_utc"]),
        "profile_id": str(manifest_payload["profile_id"]),
        "selected_count": int(manifest_payload["selected_count"]),
        "unique_geometry_count": int(manifest_payload["unique_geometry_count"]),
    }
    replacement_index = next(
        (
            index
            for index, item in enumerate(index_payload)
            if str(item.get("selection_id") or "") == str(selection_id)
        ),
        None,
    )
    if replacement_index is None:
        index_payload.append(index_entry)
    else:
        index_payload[replacement_index] = index_entry
    write_json(index_path, index_payload)

    return SelectionWriteResult(
        selection_root=selection_root,
        selection_dir=selection_dir,
        manifest_path=manifest_path,
        records_path=records_path,
        xyz_path=xyz_path,
        index_path=index_path,
    )
