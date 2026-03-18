from __future__ import annotations

import io
import json
import re
import secrets
import tarfile
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import h5py
import numpy as np

from backend.server.distribution_bundle import build_topology_signature
from backend.server.molden import BOHR_TO_ANG, PERIODIC_SYMBOLS
from backend.server.normal_modes_sampling import (
    NORMAL_MODES_GEOMETRY_EXPORT_SCHEMA_VERSION,
    atomic_mass_amu,
    utc_now_iso,
)


TRAJECTORY_GEOMETRY_BUNDLE_KIND = "trajectory_sampling"
TRAJECTORY_GEOMETRY_METHOD_STRIDED = "trajectory_strided_sampling"
PIMD_SCHEMA_NAME = "observable_dashboard_pimd"

_SYMBOL_TO_ATOMIC_NUMBER = {
    str(symbol).upper(): int(atomic_number)
    for atomic_number, symbol in enumerate(PERIODIC_SYMBOLS)
    if atomic_number > 0 and str(symbol).strip()
}


@dataclass(slots=True)
class TrajectorySamplingSource:
    source_kind: str
    source_name: str
    atom_numbers: np.ndarray
    coords_bohr: np.ndarray
    step: np.ndarray | None = None
    coord_frame_index: np.ndarray | None = None

    @property
    def n_frames(self) -> int:
        return int(self.coords_bohr.shape[0])

    @property
    def n_beads(self) -> int:
        return int(self.coords_bohr.shape[1])

    @property
    def n_atoms(self) -> int:
        return int(self.coords_bohr.shape[2])


def _json_text(payload: Any) -> str:
    return f"{json.dumps(payload, indent=2, sort_keys=True)}\n"


def _npy_bytes(array: np.ndarray) -> bytes:
    buffer = io.BytesIO()
    np.save(buffer, np.asarray(array), allow_pickle=False)
    return buffer.getvalue()


def _tar_gz_bytes_from_entries(entries: list[tuple[str, bytes]]) -> bytes:
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        modified_at = 0
        for relative_path, content_bytes in entries:
            info = tarfile.TarInfo(name=str(relative_path))
            info.size = int(len(content_bytes))
            info.mtime = modified_at
            archive.addfile(info, io.BytesIO(content_bytes))
    return buffer.getvalue()


def _sanitize_filename_part(text: object) -> str:
    raw = str(text or "").strip()
    sanitized = re.sub(r"[^A-Za-z0-9._-]+", "_", raw)
    sanitized = sanitized.strip("._-")
    return sanitized or "trajectory"


def _geometry_channel_entries() -> list[dict[str, str | None]]:
    return [
        {"name": "atom_numbers", "unit": None, "group": "sampling"},
        {"name": "atom_masses_amu", "unit": "amu", "group": "sampling"},
        {"name": "coords_bohr", "unit": "bohr", "group": "sampling"},
    ]


def _atom_symbol(atomic_number: int) -> str:
    index = int(atomic_number)
    if 0 < index < len(PERIODIC_SYMBOLS) and PERIODIC_SYMBOLS[index]:
        return str(PERIODIC_SYMBOLS[index])
    return "X"


def _xyz_text_from_samples(
    coords_bohr: np.ndarray,
    atom_numbers: list[int],
    *,
    sample_comments: list[str],
) -> str:
    coords_ang = np.asarray(coords_bohr, dtype=float) * float(BOHR_TO_ANG)
    if coords_ang.ndim != 3 or coords_ang.shape[2] != 3:
        raise ValueError(f"Sampled coords_bohr must have shape [n_samples, n_atoms, 3], got {coords_ang.shape}.")

    lines: list[str] = []
    n_atoms = int(coords_ang.shape[1])
    for sample_index in range(int(coords_ang.shape[0])):
        lines.append(str(n_atoms))
        comment = str(sample_comments[sample_index] if sample_index < len(sample_comments) else "").strip()
        lines.append(comment)
        for atom_index in range(n_atoms):
            x, y, z = coords_ang[sample_index, atom_index]
            lines.append(
                f"{_atom_symbol(int(atom_numbers[atom_index]))} {float(x):.10f} {float(y):.10f} {float(z):.10f}"
            )
    return "\n".join(lines) + "\n"


def _normalize_xyz_atomic_token(token: str) -> int:
    raw = str(token or "").strip()
    if not raw:
        raise ValueError("Encountered an empty atom token while parsing XYZ.")
    if raw.isdigit():
        atomic_number = int(raw)
        if atomic_number > 0:
            return atomic_number
    normalized = raw[0].upper() + raw[1:].lower()
    atomic_number = _SYMBOL_TO_ATOMIC_NUMBER.get(normalized.upper())
    if atomic_number is None:
        raise ValueError(f"Unsupported atom token in XYZ: {raw!r}")
    return int(atomic_number)


def parse_multiframe_xyz_source(source_bytes: bytes, *, source_name: str) -> TrajectorySamplingSource:
    if not isinstance(source_bytes, (bytes, bytearray)) or len(source_bytes) <= 0:
        raise ValueError("XYZ source upload is empty.")
    try:
        text = bytes(source_bytes).decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ValueError(f"Failed to decode XYZ source {source_name}: {exc}") from exc

    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    coords_ang: list[list[list[float]]] = []
    atom_numbers: list[int] | None = None
    index = 0
    while True:
        while index < len(lines) and not str(lines[index] or "").strip():
            index += 1
        if index >= len(lines):
            break

        atom_count_line = str(lines[index] or "").strip()
        try:
            atom_count = int(atom_count_line)
        except ValueError as exc:
            raise ValueError(
                f"Expected atom count at line {index + 1} in {source_name}, received {atom_count_line!r}."
            ) from exc
        if atom_count <= 0:
            raise ValueError(f"Atom count must be positive at line {index + 1} in {source_name}.")

        comment_index = index + 1
        if comment_index >= len(lines):
            raise ValueError(f"Missing comment line after atom count at line {index + 1} in {source_name}.")

        frame_atom_numbers: list[int] = []
        frame_coords_ang: list[list[float]] = []
        for atom_index in range(atom_count):
            line_index = comment_index + 1 + atom_index
            if line_index >= len(lines):
                raise ValueError(f"Unexpected end of file while reading frame {len(coords_ang) + 1} from {source_name}.")
            raw_line = str(lines[line_index] or "").strip()
            if not raw_line:
                raise ValueError(f"Unexpected blank atom row on line {line_index + 1} in {source_name}.")
            parts = raw_line.split()
            if len(parts) < 4:
                raise ValueError(
                    f"Atom row on line {line_index + 1} in {source_name} must contain element and x y z coordinates."
                )
            try:
                xyz = [float(parts[1]), float(parts[2]), float(parts[3])]
            except ValueError as exc:
                raise ValueError(f"Invalid coordinate row on line {line_index + 1} in {source_name}.") from exc
            frame_atom_numbers.append(_normalize_xyz_atomic_token(parts[0]))
            frame_coords_ang.append(xyz)

        if atom_numbers is None:
            atom_numbers = frame_atom_numbers
        elif frame_atom_numbers != atom_numbers:
            raise ValueError("All XYZ frames must preserve the same atom ordering and atom types.")

        coords_ang.append(frame_coords_ang)
        index = comment_index + 1 + atom_count

    if atom_numbers is None or not coords_ang:
        raise ValueError(f"No XYZ frames were parsed from {source_name}.")

    coords_bohr = np.asarray(coords_ang, dtype=float) / float(BOHR_TO_ANG)
    return TrajectorySamplingSource(
        source_kind="md_xyz",
        source_name=str(source_name or "uploaded.xyz"),
        atom_numbers=np.asarray(atom_numbers, dtype=np.int32),
        coords_bohr=np.asarray(coords_bohr[:, None, :, :], dtype=float),
    )


def parse_standard_pimd_source(source_bytes: bytes, *, source_name: str) -> TrajectorySamplingSource:
    if not isinstance(source_bytes, (bytes, bytearray)) or len(source_bytes) <= 0:
        raise ValueError("PIMD source upload is empty.")

    with tempfile.NamedTemporaryFile(suffix=".h5") as temp_handle:
        temp_handle.write(bytes(source_bytes))
        temp_handle.flush()
        with h5py.File(temp_handle.name, "r") as handle:
            schema_name = str(handle.attrs.get("schema_name", "") or "").strip()
            if schema_name and schema_name != PIMD_SCHEMA_NAME:
                raise ValueError(f"Unsupported PIMD schema {schema_name!r} in {source_name}.")
            if "coords" not in handle or "step" not in handle or "atom_numbers" not in handle:
                raise ValueError(f"{source_name} must contain datasets 'coords', 'step', and 'atom_numbers'.")

            coords = np.asarray(handle["coords"], dtype=float)
            step = np.asarray(handle["step"]).reshape(-1)
            atom_numbers = np.asarray(handle["atom_numbers"], dtype=np.int32).reshape(-1)
            coord_frame_index = None
            if "coord_frame_index" in handle:
                coord_frame_index = np.asarray(handle["coord_frame_index"]).reshape(-1)
            coord_unit = str(handle.attrs.get("coord_unit", "bohr") or "bohr").strip().lower()

    if coords.ndim != 4 or coords.shape[3] != 3:
        raise ValueError(f"PIMD coords must have shape [n_frames, n_beads, n_atoms, 3], got {coords.shape}.")
    if atom_numbers.shape[0] != int(coords.shape[2]):
        raise ValueError(
            f"PIMD atom_numbers length {atom_numbers.shape[0]} does not match coords atom axis {coords.shape[2]}."
        )
    if step.shape[0] != int(coords.shape[0]):
        raise ValueError(f"PIMD step length {step.shape[0]} does not match coords frame axis {coords.shape[0]}.")
    if coord_frame_index is not None and coord_frame_index.shape[0] != int(coords.shape[0]):
        raise ValueError(
            "PIMD coord_frame_index length does not match coords frame axis: "
            f"{coord_frame_index.shape[0]} vs {coords.shape[0]}."
        )

    if coord_unit == "bohr":
        coords_bohr = np.asarray(coords, dtype=float)
    elif coord_unit == "angstrom":
        coords_bohr = np.asarray(coords, dtype=float) / float(BOHR_TO_ANG)
    else:
        raise ValueError(f"Unsupported PIMD coord_unit {coord_unit!r} in {source_name}.")

    return TrajectorySamplingSource(
        source_kind="pimd_h5",
        source_name=str(source_name or "uploaded.h5"),
        atom_numbers=np.asarray(atom_numbers, dtype=np.int32),
        coords_bohr=np.asarray(coords_bohr, dtype=float),
        step=np.asarray(step),
        coord_frame_index=(None if coord_frame_index is None else np.asarray(coord_frame_index)),
    )


def _normalize_selection_indices(
    *,
    count: int,
    start: int,
    end: int | None,
    stride: int,
    label: str,
) -> np.ndarray:
    total = int(count)
    if total <= 0:
        raise ValueError(f"{label} count must be positive.")
    start_index = int(start)
    if start_index < 0 or start_index >= total:
        raise ValueError(f"{label} start index out of range: {start_index} (valid 0..{total - 1}).")

    end_index = total - 1 if end is None else int(end)
    if end_index < start_index or end_index >= total:
        raise ValueError(
            f"{label} end index out of range: {end_index} (valid {start_index}..{total - 1})."
        )

    stride_value = int(stride)
    if stride_value <= 0:
        raise ValueError(f"{label} stride must be >= 1.")
    return np.arange(start_index, end_index + 1, stride_value, dtype=np.int64)


def _json_number(value: Any) -> int | float | None:
    if value is None:
        return None
    numeric = float(value)
    if not np.isfinite(numeric):
        return None
    rounded = round(numeric)
    if abs(numeric - rounded) <= 1e-9:
        return int(rounded)
    return numeric


def build_trajectory_geometry_export_bundle(
    *,
    source_kind: str,
    source_name: str,
    source_bytes: bytes,
    start_frame: int,
    end_frame: int | None,
    frame_stride: int,
    charge: int,
    multiplicity: int,
    bead_start: int | None,
    bead_end: int | None,
    bead_stride: int,
) -> tuple[str, bytes]:
    source_kind_text = str(source_kind or "").strip().lower()
    if source_kind_text == "md_xyz":
        source = parse_multiframe_xyz_source(source_bytes, source_name=source_name)
    elif source_kind_text == "pimd_h5":
        source = parse_standard_pimd_source(source_bytes, source_name=source_name)
    else:
        raise ValueError(f"Unsupported trajectory source_kind: {source_kind!r}")

    frame_indices = _normalize_selection_indices(
        count=source.n_frames,
        start=int(start_frame),
        end=end_frame,
        stride=int(frame_stride),
        label="frame",
    )
    if source.source_kind == "pimd_h5":
        bead_indices = _normalize_selection_indices(
            count=source.n_beads,
            start=0 if bead_start is None else int(bead_start),
            end=bead_end,
            stride=int(bead_stride),
            label="bead",
        )
    else:
        bead_indices = np.asarray([0], dtype=np.int64)

    batch_id = f"traj-sample-{secrets.token_urlsafe(9)}"
    sample_count = int(frame_indices.shape[0] * bead_indices.shape[0])
    if sample_count <= 0:
        raise ValueError("Sampling request produced zero output geometries.")

    coords_samples = np.empty((sample_count, source.n_atoms, 3), dtype=float)
    sample_ids: list[str] = []
    sample_metadata: list[dict[str, Any]] = []
    sample_comments: list[str] = []
    sample_index = 0
    for frame_ordinal, frame_index in enumerate(frame_indices.tolist(), start=1):
        source_step = _json_number(source.step[frame_index]) if source.step is not None else None
        coord_frame_index = (
            _json_number(source.coord_frame_index[frame_index])
            if source.coord_frame_index is not None
            else None
        )
        for bead_ordinal, bead_index in enumerate(bead_indices.tolist(), start=1):
            coords_samples[sample_index] = np.asarray(source.coords_bohr[frame_index, bead_index], dtype=float)
            sample_id = f"{batch_id}_sample_{sample_index:06d}"
            metadata = {
                "sample_id": sample_id,
                "sample_index": int(sample_index),
                "source_kind": source.source_kind,
                "source_name": source.source_name,
                "frame_index": int(frame_index),
                "frame_ordinal": int(frame_ordinal),
                "source_step": source_step,
                "coord_frame_index": coord_frame_index,
                "bead_index": (None if source.source_kind != "pimd_h5" else int(bead_index)),
                "bead_ordinal": (None if source.source_kind != "pimd_h5" else int(bead_ordinal)),
            }
            comment_parts = [
                f"sample_idx={sample_index}",
                f"sample_id={sample_id}",
                f"frame_index={int(frame_index)}",
            ]
            if source_step is not None:
                comment_parts.append(f"source_step={source_step}")
            if coord_frame_index is not None:
                comment_parts.append(f"coord_frame_index={coord_frame_index}")
            if source.source_kind == "pimd_h5":
                comment_parts.append(f"bead_index={int(bead_index)}")

            sample_ids.append(sample_id)
            sample_metadata.append(metadata)
            sample_comments.append(" ".join(comment_parts))
            sample_index += 1

    atom_numbers = np.asarray(source.atom_numbers, dtype=np.int32).reshape(-1)
    atom_masses_amu = np.asarray([atomic_mass_amu(int(value)) for value in atom_numbers.tolist()], dtype=float)
    label = (
        f"{source.source_name} PIMD trajectory samples"
        if source.source_kind == "pimd_h5"
        else f"{source.source_name} trajectory samples"
    )
    manifest = {
        "kind": TRAJECTORY_GEOMETRY_BUNDLE_KIND,
        "schema_version": NORMAL_MODES_GEOMETRY_EXPORT_SCHEMA_VERSION,
        "label": label,
        "source_name": str(source.source_name),
        "created_at_utc": utc_now_iso(),
        "n_samples": int(sample_count),
        "n_atoms": int(source.n_atoms),
        "topology_signature": build_topology_signature(atom_numbers),
        "sampling_channels": _geometry_channel_entries(),
        "electronics": {
            "default_profile_id": None,
            "profiles": [],
        },
        "batch_id": str(batch_id),
        "sampling_method": TRAJECTORY_GEOMETRY_METHOD_STRIDED,
        "charge": int(charge),
        "multiplicity": int(multiplicity),
        "source_kind": str(source.source_kind),
    }

    xyz_text = _xyz_text_from_samples(
        coords_samples,
        atom_numbers.tolist(),
        sample_comments=sample_comments,
    )
    entries: list[tuple[str, bytes]] = [
        ("manifest.json", _json_text(manifest).encode("utf-8")),
        ("meta/sample_ids.json", _json_text(sample_ids).encode("utf-8")),
        ("meta/sample_metadata.json", _json_text(sample_metadata).encode("utf-8")),
        ("sampling/atom_numbers.npy", _npy_bytes(atom_numbers.astype(np.int32))),
        ("sampling/atom_masses_amu.npy", _npy_bytes(atom_masses_amu)),
        ("sampling/coords_bohr.npy", _npy_bytes(coords_samples.astype(float))),
        ("sampling/all_structures.xyz", xyz_text.encode("utf-8")),
    ]

    source_base = _sanitize_filename_part(Path(str(source.source_name)).stem)
    file_name = f"trajectory_geometry_{source_base}_{_sanitize_filename_part(batch_id)}.tar.gz"
    return file_name, _tar_gz_bytes_from_entries(entries)
