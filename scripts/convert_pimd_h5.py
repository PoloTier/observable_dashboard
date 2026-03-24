from __future__ import annotations

import argparse
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

import h5py
import numpy as np

from scripts.basic.elements import atomic_number_from_symbol
from scripts.basic.units import BOHR_TO_ANGSTROM, KB_HARTREE_PER_K


SCHEMA_NAME = "observable_dashboard_pimd"
SCHEMA_VERSION = 1


@dataclass(frozen=True)
class AlignmentResult:
    start_index: int
    stride: int
    sample_indices: np.ndarray
    aligned_values: np.ndarray
    mean_absolute_error: float


@dataclass(frozen=True)
class ConvertedPimdRecord:
    coords: np.ndarray
    step: np.ndarray
    coord_frame_index: np.ndarray
    atom_numbers: np.ndarray
    potential_energy: np.ndarray
    potential_energy_beads: np.ndarray
    n_frames: int
    n_atoms: int
    n_beads: int
    temperature_k: float
    coord_unit: str
    energy_unit: str
    step_kind: str
    energy_alignment_start_index: int
    energy_alignment_stride: int
    energy_alignment_mae: float


def _normalized_symbol(raw_symbol: str) -> str:
    text = str(raw_symbol or "").strip()
    if not text:
        raise ValueError("Encountered empty element symbol while parsing XYZ.")
    return text[0].upper() + text[1:].lower()


def parse_xyz_atom_numbers(path: Path) -> np.ndarray:
    lines = path.read_text(encoding="utf-8").splitlines()
    if len(lines) < 2:
        raise ValueError(f"XYZ file {path} is too short to contain atom rows.")

    try:
        n_atoms = int(lines[0].strip())
    except ValueError as exc:
        raise ValueError(f"First line of {path} must be the atom count.") from exc

    atom_lines = lines[2 : 2 + n_atoms]
    if len(atom_lines) != n_atoms:
        raise ValueError(f"XYZ file {path} ended before {n_atoms} atom rows were read.")

    atom_numbers: list[int] = []
    for index, line in enumerate(atom_lines, start=3):
        parts = line.split()
        if not parts:
            raise ValueError(f"Atom row {index} in {path} is empty.")
        symbol = _normalized_symbol(parts[0])
        try:
            atom_numbers.append(int(atomic_number_from_symbol(symbol)))
        except ValueError as exc:
            raise ValueError(f"{exc} in {path} line {index}.") from exc
    return np.asarray(atom_numbers, dtype=np.int32)


def _iter_alignment_candidates(series_length: int, frame_count: int, max_stride: int) -> Iterable[tuple[int, int]]:
    upper_stride = max(1, min(max_stride, series_length))
    for stride in range(1, upper_stride + 1):
        max_start = min(series_length - 1, max(stride * 2, 32))
        for start_index in range(0, max_start + 1):
            candidate_length = 1 + (series_length - 1 - start_index) // stride
            if candidate_length < frame_count:
                continue
            yield start_index, stride


def align_series_to_reference(
    reference_values: np.ndarray,
    series_values: np.ndarray,
    *,
    max_stride: int = 64,
) -> AlignmentResult:
    reference = np.asarray(reference_values, dtype=np.float64).reshape(-1)
    series = np.asarray(series_values, dtype=np.float64).reshape(-1)
    if reference.size == 0:
        raise ValueError("Cannot align an empty frame reference.")
    if series.size == 0:
        raise ValueError("Cannot align against an empty scalar series.")

    best_result: AlignmentResult | None = None
    for start_index, stride in _iter_alignment_candidates(int(series.size), int(reference.size), int(max_stride)):
        sample_indices = start_index + stride * np.arange(reference.size, dtype=np.int64)
        if int(sample_indices[-1]) >= int(series.size):
            continue
        aligned = np.asarray(series[sample_indices], dtype=np.float64)
        mae = float(np.mean(np.abs(aligned - reference)))
        result = AlignmentResult(
            start_index=int(start_index),
            stride=int(stride),
            sample_indices=np.asarray(sample_indices, dtype=np.int64),
            aligned_values=aligned,
            mean_absolute_error=mae,
        )
        if best_result is None or result.mean_absolute_error < best_result.mean_absolute_error:
            best_result = result

    if best_result is None:
        raise ValueError("Failed to align scalar energy series to valid trajectory frames.")

    ref_scale = max(1.0, float(np.max(np.abs(reference))))
    allowed_mae = max(1e-10, ref_scale * 1e-8)
    if best_result.mean_absolute_error > allowed_mae:
        raise ValueError(
            "Potential-energy alignment between traj.h5 and ener.h5 is not trustworthy: "
            f"best_mae={best_result.mean_absolute_error:.6e}, allowed={allowed_mae:.6e}."
        )
    return best_result


def _extract_temperature_k(beta_series: np.ndarray) -> float:
    beta = np.asarray(beta_series, dtype=np.float64).reshape(-1)
    finite_positive = beta[np.isfinite(beta) & (beta > 0)]
    if finite_positive.size == 0:
        raise ValueError("ener.h5/beta does not contain any finite positive entries.")
    beta_value = float(np.median(finite_positive))
    return float(1.0 / (KB_HARTREE_PER_K * beta_value))


def load_source_pimd_record(
    *,
    traj_path: Path,
    ener_path: Path,
    xyz_path: Path,
) -> ConvertedPimdRecord:
    atom_numbers = parse_xyz_atom_numbers(xyz_path)

    with h5py.File(traj_path, "r") as traj_h5, h5py.File(ener_path, "r") as ener_h5:
        if "position" not in traj_h5 or "energy" not in traj_h5:
            raise ValueError(f"{traj_path} must contain datasets 'position' and 'energy'.")
        if "esti_Ep" not in ener_h5 or "P" not in ener_h5 or "beta" not in ener_h5:
            raise ValueError(f"{ener_path} must contain datasets 'esti_Ep', 'P', and 'beta'.")

        position = np.asarray(traj_h5["position"], dtype=np.float64)
        bead_energy = np.asarray(traj_h5["energy"], dtype=np.float64)
        beta = np.asarray(ener_h5["beta"], dtype=np.float64).reshape(-1)
        estimator_ep = np.asarray(ener_h5["esti_Ep"], dtype=np.float64).reshape(-1)
        p_values = np.asarray(ener_h5["P"], dtype=np.int64).reshape(-1)

    if position.ndim != 3:
        raise ValueError(f"traj.h5 position must have shape [n_traj, n_frames, n_values], got {position.shape}.")
    if bead_energy.ndim != 3:
        raise ValueError(f"traj.h5 energy must have shape [n_traj, n_frames, n_beads], got {bead_energy.shape}.")
    if position.shape[0] != 1 or bead_energy.shape[0] != 1:
        raise ValueError("Only single-trajectory PIMD outputs are supported in v1.")
    if position.shape[1] != bead_energy.shape[1]:
        raise ValueError("traj.h5 position and energy must align on frame count.")

    n_beads = int(bead_energy.shape[2])
    if p_values.size:
        expected_beads = int(np.median(p_values[np.isfinite(p_values)]))
        if expected_beads > 0 and expected_beads != n_beads:
            raise ValueError(
                f"Bead count mismatch between traj.h5 energy ({n_beads}) and ener.h5/P ({expected_beads})."
            )

    total_values = int(position.shape[2])
    values_per_atom = 3 * n_beads
    if total_values % values_per_atom != 0:
        raise ValueError(
            "traj.h5 position width is incompatible with [n_beads, n_atoms, 3]: "
            f"width={total_values}, n_beads={n_beads}."
        )
    n_atoms = total_values // values_per_atom
    if atom_numbers.shape[0] != n_atoms:
        raise ValueError(
            f"Reference XYZ atom count {atom_numbers.shape[0]} does not match trajectory atom count {n_atoms}."
        )

    valid_mask = ~np.all(position[0] == 0.0, axis=1)
    if not np.any(valid_mask):
        raise ValueError("traj.h5 does not contain any non-zero coordinate frames.")

    valid_frame_indices = np.flatnonzero(valid_mask).astype(np.int64, copy=False)
    coords = np.asarray(position[0][valid_mask], dtype=np.float64).reshape(-1, n_beads, n_atoms, 3)
    potential_energy_beads = np.asarray(bead_energy[0][valid_mask], dtype=np.float64)
    bead_energy_mean = np.asarray(np.mean(potential_energy_beads, axis=1), dtype=np.float64)

    alignment = align_series_to_reference(bead_energy_mean, estimator_ep)
    step = np.asarray(alignment.sample_indices, dtype=np.int64)
    potential_energy = np.asarray(alignment.aligned_values, dtype=np.float64)

    if coords.shape[0] != potential_energy.shape[0]:
        raise ValueError("Aligned potential-energy series does not match coordinate frame count.")

    temperature_k = _extract_temperature_k(beta)

    return ConvertedPimdRecord(
        coords=coords,
        step=step,
        coord_frame_index=np.asarray(valid_frame_indices, dtype=np.int64),
        atom_numbers=np.asarray(atom_numbers, dtype=np.int32),
        potential_energy=potential_energy,
        potential_energy_beads=potential_energy_beads,
        n_frames=int(coords.shape[0]),
        n_atoms=int(n_atoms),
        n_beads=int(n_beads),
        temperature_k=float(temperature_k),
        coord_unit="bohr",
        energy_unit="hartree",
        step_kind="source_step_index",
        energy_alignment_start_index=int(alignment.start_index),
        energy_alignment_stride=int(alignment.stride),
        energy_alignment_mae=float(alignment.mean_absolute_error),
    )


def write_standard_pimd_h5(record: ConvertedPimdRecord, output_path: Path, *, overwrite: bool = False) -> Path:
    if output_path.exists() and not overwrite:
        raise FileExistsError(f"Refusing to overwrite existing file: {output_path}")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with h5py.File(output_path, "w") as handle:
        handle.attrs["schema_name"] = SCHEMA_NAME
        handle.attrs["schema_version"] = np.int32(SCHEMA_VERSION)
        handle.attrs["n_atoms"] = np.int32(record.n_atoms)
        handle.attrs["n_beads"] = np.int32(record.n_beads)
        handle.attrs["temperature_K"] = np.float64(record.temperature_k)
        handle.attrs["coord_unit"] = record.coord_unit
        handle.attrs["energy_unit"] = record.energy_unit
        handle.attrs["step_kind"] = record.step_kind
        handle.attrs["step_origin"] = (
            "Aligned index into ener.h5 scalar arrays for each exported coordinate frame."
        )
        handle.attrs["coord_frame_index_kind"] = "traj_saved_frame_index"
        handle.attrs["energy_alignment_start_index"] = np.int64(record.energy_alignment_start_index)
        handle.attrs["energy_alignment_stride"] = np.int64(record.energy_alignment_stride)
        handle.attrs["energy_alignment_mae"] = np.float64(record.energy_alignment_mae)
        handle.attrs["length_unit_for_rendering"] = "angstrom"
        handle.attrs["bohr_to_angstrom"] = np.float64(BOHR_TO_ANGSTROM)

        dataset_options = {"compression": "gzip", "shuffle": True}
        handle.create_dataset("coords", data=np.asarray(record.coords, dtype=np.float64), **dataset_options)
        handle.create_dataset("step", data=np.asarray(record.step, dtype=np.int64), **dataset_options)
        handle.create_dataset(
            "coord_frame_index",
            data=np.asarray(record.coord_frame_index, dtype=np.int64),
            **dataset_options,
        )
        handle.create_dataset(
            "atom_numbers",
            data=np.asarray(record.atom_numbers, dtype=np.int32),
            **dataset_options,
        )
        handle.create_dataset(
            "potential_energy",
            data=np.asarray(record.potential_energy, dtype=np.float64),
            **dataset_options,
        )
        handle.create_dataset(
            "potential_energy_beads",
            data=np.asarray(record.potential_energy_beads, dtype=np.float64),
            **dataset_options,
        )
    return output_path


def convert_pimd_files(
    *,
    traj_path: Path,
    ener_path: Path,
    xyz_path: Path,
    output_path: Path,
    overwrite: bool = False,
) -> Path:
    record = load_source_pimd_record(traj_path=traj_path, ener_path=ener_path, xyz_path=xyz_path)
    return write_standard_pimd_h5(record, output_path, overwrite=overwrite)


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Convert solver-native PIMD traj.h5 + ener.h5 outputs into the dashboard PIMD H5 schema.",
    )
    parser.add_argument("--traj", required=True, help="Path to source traj.h5 file.")
    parser.add_argument("--ener", required=True, help="Path to source ener.h5 file.")
    parser.add_argument("--xyz", required=True, help="Reference XYZ file used only to recover atom types.")
    parser.add_argument("--output", required=True, help="Path to output standardized PIMD H5 file.")
    parser.add_argument("--overwrite", action="store_true", help="Overwrite the output file if it already exists.")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_arg_parser()
    args = parser.parse_args(argv)

    output_path = convert_pimd_files(
        traj_path=Path(args.traj).expanduser().resolve(),
        ener_path=Path(args.ener).expanduser().resolve(),
        xyz_path=Path(args.xyz).expanduser().resolve(),
        output_path=Path(args.output).expanduser().resolve(),
        overwrite=bool(args.overwrite),
    )
    print(output_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
