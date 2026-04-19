from __future__ import annotations

import io
import json
import math
import re
import secrets
import tarfile
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

import numpy as np

from backend.server.constants import (
    AMU_TO_AU,
    BOHR_TO_ANG,
    BOLTZMANN_AU_PER_K,
    CM1_TO_ANGULAR_FREQUENCY_AU,
    atom_symbol,
    atomic_mass_amu,
)
from backend.server.export_utils import (
    build_topology_signature,
    json_text,
    npy_bytes,
    sanitize_filename_part,
    tar_gz_bytes_from_entries,
    utc_now_iso,
)
from backend.server.geometry import compute_angle, compute_bond, compute_dihedral
SAMPLE_CACHE_MAX_ENTRIES = 4
SAMPLE_CACHE_MAX_BYTES = 96 * 1024 * 1024
MAX_PREVIEW_COUNT = 256
ORTHONORMALITY_TOL = 5e-2
NORMAL_MODES_EXPORT_SCHEMA_VERSION = 1
NORMAL_MODES_GEOMETRY_EXPORT_SCHEMA_VERSION = 4
NORMAL_MODES_GEOMETRY_BUNDLE_KIND = "normal_modes_sampling"
NORMAL_MODES_GEOMETRY_METHOD_HARMONIC = "normal_modes_harmonic"
SAMPLER_WIGNER_FINITE_T = "wigner_finite_t"
SAMPLER_WIGNER_ZERO_T = "wigner_zero_t"
SAMPLER_CLASSICAL_FINITE_T = "classical_finite_t"
SAMPLER_FROZEN = "frozen"


@dataclass(slots=True)
class SamplingPreparation:
    source_name: str
    atom_numbers: list[int]
    coords_ang: list[list[float]]
    n_atoms: int
    n_modes: int
    coords0_bohr: np.ndarray
    frequencies_cm1: np.ndarray
    mode_kinds: list[str]
    modal_matrix_au: np.ndarray
    masses_au_per_atom: np.ndarray
    masses_au_components: np.ndarray


def _normalize_preview_count(sample_count: int, requested_preview_count: int) -> int:
    preview_count = max(1, int(requested_preview_count))
    preview_count = min(preview_count, int(sample_count), int(MAX_PREVIEW_COUNT))
    return preview_count


def _seed_to_int(value: object | None) -> int:
    if value is None:
        return int(secrets.randbits(63))
    seed = int(value)
    if seed < 0:
        raise ValueError("seed must be >= 0")
    return seed


def _normalize_modal_matrix_au(
    mode_vectors_ang: list[list[list[float]]],
    masses_au_components: np.ndarray,
) -> np.ndarray:
    if not isinstance(mode_vectors_ang, list) or not mode_vectors_ang:
        raise ValueError("Molden payload does not contain any mode vectors.")

    try:
        modal_matrix_ang = np.stack(
            [np.asarray(mode, dtype=float).reshape(-1) for mode in mode_vectors_ang],
            axis=1,
        )
    except ValueError as exc:
        raise ValueError(f"Failed to assemble mode vectors into a modal matrix: {exc}") from exc

    if modal_matrix_ang.ndim != 2:
        raise ValueError(
            f"Modal matrix must be rank-2 after assembly, got shape {modal_matrix_ang.shape}."
        )
    if modal_matrix_ang.shape[0] != int(masses_au_components.shape[0]):
        raise ValueError(
            "Modal matrix width is incompatible with atom masses: "
            f"components={modal_matrix_ang.shape[0]}, expected={masses_au_components.shape[0]}."
        )

    modal_matrix_bohr = np.asarray(modal_matrix_ang / float(BOHR_TO_ANG), dtype=float)
    modal_matrix_au = np.asarray(modal_matrix_bohr / math.sqrt(AMU_TO_AU), dtype=float)
    weighted = np.sqrt(np.asarray(masses_au_components, dtype=float))[:, None] * modal_matrix_au
    column_norms = np.linalg.norm(weighted, axis=0)
    if np.any(~np.isfinite(column_norms)) or np.any(column_norms <= 0):
        raise ValueError("Modal matrix contains non-finite or zero-norm columns under the mass metric.")
    modal_matrix_au = modal_matrix_au / column_norms[None, :]
    return modal_matrix_au


def _validate_modal_matrix_orthonormality(
    modal_matrix_au: np.ndarray,
    masses_au_components: np.ndarray,
) -> None:
    gram = np.asarray(modal_matrix_au.T @ (masses_au_components[:, None] * modal_matrix_au), dtype=float)
    if gram.ndim != 2 or gram.shape[0] != gram.shape[1]:
        raise ValueError(f"Modal matrix Gram matrix must be square, got shape {gram.shape}.")
    target = np.eye(int(gram.shape[0]), dtype=float)
    deviation = np.abs(gram - target)
    max_abs_deviation = float(np.max(deviation)) if deviation.size else 0.0
    if not math.isfinite(max_abs_deviation) or max_abs_deviation > ORTHONORMALITY_TOL:
        raise ValueError(
            "Normal-mode vectors do not satisfy A^T M A ≈ I within tolerance: "
            f"max_abs_deviation={max_abs_deviation:.6g}, tolerance={ORTHONORMALITY_TOL:.6g}."
        )


def prepare_sampling_inputs(parsed_payload: dict[str, Any]) -> SamplingPreparation:
    atom_numbers = [int(v) for v in list(parsed_payload.get("atom_numbers", []) or [])]
    coords_ang = [list(row) for row in list(parsed_payload.get("coords_ang", []) or [])]
    mode_summaries = list(parsed_payload.get("mode_summaries", []) or [])
    mode_vectors_ang = list(parsed_payload.get("mode_vectors_ang", []) or [])
    source_name = str(parsed_payload.get("source_name") or "uploaded.molden")
    n_atoms = int(parsed_payload.get("n_atoms") or len(atom_numbers))
    if n_atoms <= 0:
        raise ValueError("Molden payload does not contain any atoms.")
    if len(atom_numbers) != n_atoms:
        raise ValueError(f"Atom-number count mismatch: expected {n_atoms}, found {len(atom_numbers)}.")
    if len(coords_ang) != n_atoms:
        raise ValueError(f"Coordinate count mismatch: expected {n_atoms}, found {len(coords_ang)}.")
    if len(mode_vectors_ang) != len(mode_summaries):
        raise ValueError(
            "Mode-vector count does not match mode summaries: "
            f"{len(mode_vectors_ang)} vs {len(mode_summaries)}."
        )

    masses_amu_per_atom = np.asarray([atomic_mass_amu(value) for value in atom_numbers], dtype=float)
    masses_au_per_atom = np.asarray(masses_amu_per_atom * float(AMU_TO_AU), dtype=float)
    masses_au_components = np.repeat(masses_au_per_atom, 3).astype(float)
    modal_matrix_au = _normalize_modal_matrix_au(mode_vectors_ang, masses_au_components)
    _validate_modal_matrix_orthonormality(modal_matrix_au, masses_au_components)

    frequencies_cm1: list[float] = []
    mode_kinds: list[str] = []
    for item in mode_summaries:
        if not isinstance(item, dict):
            raise ValueError("Each mode summary must be a dictionary.")
        frequency = float(item.get("frequency_cm1"))
        kind = str(item.get("kind") or "").strip().lower() or "positive"
        frequencies_cm1.append(frequency)
        mode_kinds.append(kind)

    coords0_bohr = np.asarray(coords_ang, dtype=float).reshape(-1) / float(BOHR_TO_ANG)
    return SamplingPreparation(
        source_name=source_name,
        atom_numbers=atom_numbers,
        coords_ang=coords_ang,
        n_atoms=n_atoms,
        n_modes=len(mode_summaries),
        coords0_bohr=coords0_bohr,
        frequencies_cm1=np.asarray(frequencies_cm1, dtype=float),
        mode_kinds=mode_kinds,
        modal_matrix_au=modal_matrix_au,
        masses_au_per_atom=masses_au_per_atom,
        masses_au_components=masses_au_components,
    )


def _mode_matches_rule(mode_index: int, frequency_cm1: float, rule: dict[str, Any]) -> bool:
    selector_type = str(rule.get("selector_type") or "").strip().lower()
    if selector_type == "freq_range":
        freq_min = rule.get("freq_min_cm1")
        freq_max = rule.get("freq_max_cm1")
        if freq_min is not None and frequency_cm1 < float(freq_min):
            return False
        if freq_max is not None and frequency_cm1 > float(freq_max):
            return False
        return True
    if selector_type == "mode_indices":
        indices = {int(value) for value in list(rule.get("mode_indices", []) or [])}
        return int(mode_index) in indices
    raise ValueError(f"Unsupported normal-mode rule selector_type: {selector_type}")


def build_mode_sampling_plan(
    *,
    frequencies_cm1: np.ndarray,
    mode_kinds: list[str],
    position_default: str,
    momentum_default: str,
    freq_min_cm1: float | None = None,
    freq_max_cm1: float | None = None,
    rules: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    normalized_rules = list(rules or [])

    for mode_index in range(int(frequencies_cm1.shape[0])):
        frequency_cm1 = float(frequencies_cm1[mode_index])
        kind = str(mode_kinds[mode_index] if mode_index < len(mode_kinds) else "positive").strip().lower()
        included = True
        exclusion_reason = ""
        if freq_min_cm1 is not None and frequency_cm1 < float(freq_min_cm1):
            included = False
            exclusion_reason = "excluded_by_freq_min"
        if freq_max_cm1 is not None and frequency_cm1 > float(freq_max_cm1):
            included = False
            exclusion_reason = "excluded_by_freq_max"

        position_sampler = str(position_default)
        momentum_sampler = str(momentum_default)
        if included:
            for rule in normalized_rules:
                if not _mode_matches_rule(mode_index, frequency_cm1, rule):
                    continue
                position_override = rule.get("position_sampler")
                momentum_override = rule.get("momentum_sampler")
                if position_override is not None:
                    position_sampler = str(position_override)
                if momentum_override is not None:
                    momentum_sampler = str(momentum_override)
        else:
            position_sampler = SAMPLER_FROZEN
            momentum_sampler = SAMPLER_FROZEN

        reason = "included"
        if not included:
            reason = exclusion_reason or "excluded"
        elif kind in {"zero", "imaginary"}:
            if position_sampler != SAMPLER_FROZEN or momentum_sampler != SAMPLER_FROZEN:
                raise ValueError(
                    f"Mode {mode_index + 1} has {kind} frequency and only supports frozen sampling."
                )
            reason = f"{kind}_frequency_frozen"

        out.append(
            {
                "mode_index": int(mode_index),
                "frequency_cm1": float(frequency_cm1),
                "kind": kind,
                "included": bool(included),
                "position_sampler": str(position_sampler),
                "momentum_sampler": str(momentum_sampler),
                "reason": reason,
            }
        )

    return out


def _requires_temperature(mode_plan: list[dict[str, Any]]) -> bool:
    finite_temperature_samplers = {SAMPLER_WIGNER_FINITE_T, SAMPLER_CLASSICAL_FINITE_T}
    for item in mode_plan:
        if str(item.get("position_sampler")) in finite_temperature_samplers:
            return True
        if str(item.get("momentum_sampler")) in finite_temperature_samplers:
            return True
    return False


def _estimate_batch_bytes(sample_count: int, n_modes: int, preview_count: int, n_atoms: int) -> int:
    scalar_bytes = int(sample_count) * int(n_modes) * 8
    preview_bytes = int(preview_count) * int(n_atoms) * 3 * 8
    base_bytes = int(n_modes) * 8 * 4 + int(n_atoms) * 3 * 8 * 2
    return int(scalar_bytes * 2 + preview_bytes + base_bytes)


def _sigma_squared(
    sampler: str,
    *,
    omega_au: float,
    beta_au: float | None,
) -> float:
    sampler_text = str(sampler)
    if sampler_text == SAMPLER_FROZEN:
        return 0.0
    if not math.isfinite(omega_au) or omega_au <= 0:
        raise ValueError("Only positive frequencies can use non-frozen sampling.")

    if sampler_text == SAMPLER_WIGNER_ZERO_T:
        return 0.5 / float(omega_au)
    if sampler_text == SAMPLER_CLASSICAL_FINITE_T:
        if beta_au is None or not math.isfinite(beta_au) or beta_au <= 0:
            raise ValueError("A positive temperature is required for classical finite-temperature sampling.")
        return 1.0 / (float(beta_au) * float(omega_au) * float(omega_au))
    if sampler_text == SAMPLER_WIGNER_FINITE_T:
        if beta_au is None or not math.isfinite(beta_au) or beta_au <= 0:
            raise ValueError("A positive temperature is required for finite-temperature Wigner sampling.")
        alpha = math.tanh(float(beta_au) * float(omega_au) * 0.5)
        if not math.isfinite(alpha) or alpha <= 0:
            raise ValueError("Failed to compute a valid finite-temperature Wigner alpha factor.")
        return 1.0 / (2.0 * alpha * float(omega_au))
    raise ValueError(f"Unsupported sampler: {sampler}")


def _momentum_sigma_squared(
    sampler: str,
    *,
    omega_au: float,
    beta_au: float | None,
) -> float:
    sampler_text = str(sampler)
    if sampler_text == SAMPLER_FROZEN:
        return 0.0
    if not math.isfinite(omega_au) or omega_au <= 0:
        raise ValueError("Only positive frequencies can use non-frozen sampling.")

    if sampler_text == SAMPLER_WIGNER_ZERO_T:
        return float(omega_au) * 0.5
    if sampler_text == SAMPLER_CLASSICAL_FINITE_T:
        if beta_au is None or not math.isfinite(beta_au) or beta_au <= 0:
            raise ValueError("A positive temperature is required for classical finite-temperature sampling.")
        return 1.0 / float(beta_au)
    if sampler_text == SAMPLER_WIGNER_FINITE_T:
        if beta_au is None or not math.isfinite(beta_au) or beta_au <= 0:
            raise ValueError("A positive temperature is required for finite-temperature Wigner sampling.")
        alpha = math.tanh(float(beta_au) * float(omega_au) * 0.5)
        if not math.isfinite(alpha) or alpha <= 0:
            raise ValueError("Failed to compute a valid finite-temperature Wigner alpha factor.")
        return float(omega_au) / (2.0 * alpha)
    raise ValueError(f"Unsupported sampler: {sampler}")


def _preview_indices(sample_count: int, preview_count: int, seed: int) -> np.ndarray:
    preview_count = _normalize_preview_count(sample_count, preview_count)
    if preview_count >= int(sample_count):
        return np.arange(int(sample_count), dtype=int)
    preview_seed = int((int(seed) + 0x9E3779B97F4A7C15) % ((1 << 63) - 1))
    rng = np.random.default_rng(preview_seed)
    indices = np.asarray(rng.choice(int(sample_count), size=int(preview_count), replace=False), dtype=int)
    indices.sort()
    return indices


def _coords_from_q_samples(
    q_samples: np.ndarray,
    coords0_bohr: np.ndarray,
    modal_matrix_au: np.ndarray,
    n_atoms: int,
) -> np.ndarray:
    coords_bohr = _coords_bohr_from_q_samples(q_samples, coords0_bohr, modal_matrix_au, n_atoms)
    return np.asarray(coords_bohr * float(BOHR_TO_ANG), dtype=float)


def _coords_bohr_from_q_samples(
    q_samples: np.ndarray,
    coords0_bohr: np.ndarray,
    modal_matrix_au: np.ndarray,
    n_atoms: int,
) -> np.ndarray:
    coords_flat_bohr = np.asarray(coords0_bohr[None, :] + q_samples @ modal_matrix_au.T, dtype=float)
    return coords_flat_bohr.reshape(int(q_samples.shape[0]), int(n_atoms), 3)


def _velocities_bohr_per_au_time_from_p_samples(
    p_samples: np.ndarray,
    modal_matrix_au: np.ndarray,
    n_atoms: int,
) -> np.ndarray:
    velocities_flat = np.asarray(p_samples @ modal_matrix_au.T, dtype=float)
    return velocities_flat.reshape(int(p_samples.shape[0]), int(n_atoms), 3)


def sample_normal_modes(
    preparation: SamplingPreparation,
    *,
    sample_count: int,
    preview_count: int,
    charge: int = 0,
    multiplicity: int = 1,
    position_default: str,
    momentum_default: str,
    temperature_k: float | None = None,
    seed: int | None = None,
    freq_min_cm1: float | None = None,
    freq_max_cm1: float | None = None,
    rules: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    n_samples = int(sample_count)
    if n_samples <= 0:
        raise ValueError("sample_count must be >= 1")
    normalized_seed = _seed_to_int(seed)
    mode_plan = build_mode_sampling_plan(
        frequencies_cm1=preparation.frequencies_cm1,
        mode_kinds=preparation.mode_kinds,
        position_default=str(position_default),
        momentum_default=str(momentum_default),
        freq_min_cm1=freq_min_cm1,
        freq_max_cm1=freq_max_cm1,
        rules=rules,
    )
    preview_count_effective = _normalize_preview_count(n_samples, int(preview_count))
    estimated_bytes = _estimate_batch_bytes(n_samples, preparation.n_modes, preview_count_effective, preparation.n_atoms)
    if estimated_bytes > int(SAMPLE_CACHE_MAX_BYTES):
        raise ValueError(
            "Requested normal-mode batch is too large for the in-memory cache budget: "
            f"estimated_bytes={estimated_bytes}, limit={SAMPLE_CACHE_MAX_BYTES}."
        )

    beta_au: float | None = None
    if _requires_temperature(mode_plan):
        if temperature_k is None:
            raise ValueError("temperature_k is required when any finite-temperature sampler is selected.")
        temperature_value = float(temperature_k)
        if not math.isfinite(temperature_value) or temperature_value <= 0:
            raise ValueError("temperature_k must be a positive finite value.")
        beta_au = 1.0 / (float(BOLTZMANN_AU_PER_K) * temperature_value)
    elif temperature_k is not None:
        temperature_value = float(temperature_k)
        if not math.isfinite(temperature_value) or temperature_value <= 0:
            raise ValueError("temperature_k must be a positive finite value when provided.")

    omega_au = np.asarray(preparation.frequencies_cm1 * float(CM1_TO_ANGULAR_FREQUENCY_AU), dtype=float)
    q_stds = np.zeros(int(preparation.n_modes), dtype=float)
    p_stds = np.zeros(int(preparation.n_modes), dtype=float)
    for item in mode_plan:
        mode_index = int(item["mode_index"])
        q_var = _sigma_squared(str(item["position_sampler"]), omega_au=float(omega_au[mode_index]), beta_au=beta_au)
        p_var = _momentum_sigma_squared(
            str(item["momentum_sampler"]),
            omega_au=float(omega_au[mode_index]),
            beta_au=beta_au,
        )
        q_stds[mode_index] = math.sqrt(max(0.0, q_var))
        p_stds[mode_index] = math.sqrt(max(0.0, p_var))

    rng = np.random.default_rng(normalized_seed)
    q_samples = np.asarray(rng.normal(loc=0.0, scale=q_stds, size=(n_samples, int(preparation.n_modes))), dtype=float)
    p_samples = np.asarray(rng.normal(loc=0.0, scale=p_stds, size=(n_samples, int(preparation.n_modes))), dtype=float)
    preview_indices = _preview_indices(n_samples, preview_count_effective, normalized_seed)
    preview_q_samples = np.asarray(q_samples[preview_indices], dtype=float)
    preview_coords_ang = _coords_from_q_samples(
        preview_q_samples,
        preparation.coords0_bohr,
        preparation.modal_matrix_au,
        preparation.n_atoms,
    )
    preview_coords_list = preview_coords_ang.astype(float).tolist()
    return {
        "batch_payload": {
            "source_name": str(preparation.source_name),
            "sampling_method": NORMAL_MODES_GEOMETRY_METHOD_HARMONIC,
            "atom_numbers": [int(v) for v in preparation.atom_numbers],
            "charge": int(charge),
            "multiplicity": int(multiplicity),
            "coords0_bohr": np.asarray(preparation.coords0_bohr, dtype=float),
            "modal_matrix_au": np.asarray(preparation.modal_matrix_au, dtype=float),
            "masses_au_per_atom": np.asarray(preparation.masses_au_per_atom, dtype=float),
            "masses_au_components": np.asarray(preparation.masses_au_components, dtype=float),
            "frequencies_cm1": np.asarray(preparation.frequencies_cm1, dtype=float),
            "mode_kinds": [str(v) for v in preparation.mode_kinds],
            "q_samples": np.asarray(q_samples, dtype=float),
            "p_samples": np.asarray(p_samples, dtype=float),
            "mode_sampling_plan": [dict(item) for item in mode_plan],
            "seed": int(normalized_seed),
            "sample_count": int(n_samples),
            "preview_count": int(preview_indices.shape[0]),
            "preview_indices": [int(v) for v in preview_indices.tolist()],
            "equilibrium_coords_ang": [[float(x), float(y), float(z)] for x, y, z in preparation.coords_ang],
            "n_atoms": int(preparation.n_atoms),
            "n_modes": int(preparation.n_modes),
        },
        "response_payload": {
            "source_name": str(preparation.source_name),
            "n_atoms": int(preparation.n_atoms),
            "atom_numbers": [int(v) for v in preparation.atom_numbers],
            "charge": int(charge),
            "multiplicity": int(multiplicity),
            "equilibrium_coords_ang": [[float(x), float(y), float(z)] for x, y, z in preparation.coords_ang],
            "preview_coords_ang": preview_coords_list,
            "preview_indices": [int(v) for v in preview_indices.tolist()],
            "sample_count": int(n_samples),
            "preview_count": int(preview_indices.shape[0]),
            "seed": int(normalized_seed),
            "mode_sampling_plan": [dict(item) for item in mode_plan],
        },
    }


def _selected_atom_coords_from_q_samples(
    *,
    q_samples: np.ndarray,
    coords0_bohr: np.ndarray,
    modal_matrix_au: np.ndarray,
    atom_indices: list[int],
) -> np.ndarray:
    component_indices: list[int] = []
    for atom_index in atom_indices:
        base = int(atom_index) * 3
        component_indices.extend([base, base + 1, base + 2])
    component_array = np.asarray(component_indices, dtype=int)
    coords0_selected = np.asarray(coords0_bohr[component_array], dtype=float)
    modal_selected = np.asarray(modal_matrix_au[component_array, :], dtype=float)
    selected_flat_bohr = np.asarray(coords0_selected[None, :] + q_samples @ modal_selected.T, dtype=float)
    return selected_flat_bohr.reshape(int(q_samples.shape[0]), len(atom_indices), 3)


def compute_measurement_values_from_batch(
    batch_payload: dict[str, Any],
    *,
    measurement_kind: str,
    atom_indices: list[int],
) -> dict[str, Any]:
    q_samples = np.asarray(batch_payload.get("q_samples"), dtype=float)
    coords0_bohr = np.asarray(batch_payload.get("coords0_bohr"), dtype=float).reshape(-1)
    modal_matrix_au = np.asarray(batch_payload.get("modal_matrix_au"), dtype=float)
    n_atoms = int(batch_payload.get("n_atoms") or 0)
    measurement_kind_text = str(measurement_kind).strip().lower()
    atom_indices_int = [int(v) for v in atom_indices]
    if n_atoms <= 0:
        raise ValueError("Sample batch does not contain a valid atom count.")
    if measurement_kind_text == "bond":
        if len(atom_indices_int) != 2:
            raise ValueError("Bond measurement requires exactly 2 atom indices.")
        unit = "Angstrom"
    elif measurement_kind_text == "angle":
        if len(atom_indices_int) != 3:
            raise ValueError("Angle measurement requires exactly 3 atom indices.")
        unit = "deg"
    elif measurement_kind_text == "dihedral":
        if len(atom_indices_int) != 4:
            raise ValueError("Dihedral measurement requires exactly 4 atom indices.")
        unit = "deg"
    else:
        raise ValueError(f"Unsupported measurement_kind: {measurement_kind}")

    for atom_index in atom_indices_int:
        if atom_index < 0 or atom_index >= n_atoms:
            raise ValueError(f"Atom index out of bounds: {atom_index} (valid range 0..{n_atoms - 1}).")

    selected_coords_bohr = _selected_atom_coords_from_q_samples(
        q_samples=q_samples,
        coords0_bohr=coords0_bohr,
        modal_matrix_au=modal_matrix_au,
        atom_indices=atom_indices_int,
    )
    selected_coords_ang = np.asarray(selected_coords_bohr * float(BOHR_TO_ANG), dtype=float)

    # selected_coords_ang has shape (N, len(atom_indices), 3) with atoms
    # re-indexed as 0, 1, 2, ... in the order of atom_indices_int.
    if measurement_kind_text == "bond":
        values = compute_bond(selected_coords_ang, 0, 1)
    elif measurement_kind_text == "angle":
        values = compute_angle(selected_coords_ang, 0, 1, 2)
    else:
        values = compute_dihedral(selected_coords_ang, 0, 1, 2, 3)

    values = np.asarray(values, dtype=float).reshape(-1)
    finite_values = values[np.isfinite(values)]
    if finite_values.size <= 0:
        raise ValueError("Measurement values are empty or non-finite for this sample batch.")

    return {
        "measurement_kind": measurement_kind_text,
        "atom_indices": atom_indices_int,
        "unit": unit,
        "values": finite_values.astype(float).tolist(),
        "sample_count": int(finite_values.shape[0]),
        "min": float(np.min(finite_values)),
        "max": float(np.max(finite_values)),
        "mean": float(np.mean(finite_values)),
        "std": float(np.std(finite_values)),
    }


def _xyz_trajectory_text(
    coords_all_ang: np.ndarray,
    atom_numbers: list[int],
    *,
    batch_id: str,
    sample_ids: list[str] | None = None,
) -> str:
    coords = np.asarray(coords_all_ang, dtype=float)
    if coords.ndim != 3 or coords.shape[2] != 3:
        raise ValueError(f"Expected coords_all_ang with shape (n_samples, n_atoms, 3), got {coords.shape}.")
    atom_count = int(coords.shape[1])
    if atom_count != len(atom_numbers):
        raise ValueError(
            f"XYZ export atom count mismatch: coords have {atom_count}, atom_numbers have {len(atom_numbers)}."
        )
    if sample_ids is not None and len(sample_ids) != int(coords.shape[0]):
        raise ValueError(
            f"XYZ export sample-id count mismatch: coords have {coords.shape[0]}, sample_ids have {len(sample_ids)}."
        )

    lines: list[str] = []
    for sample_index in range(int(coords.shape[0])):
        lines.append(str(atom_count))
        comment = f"batch_id={batch_id} sample_idx={sample_index}"
        if sample_ids is not None:
            comment = f"{comment} sample_id={sample_ids[sample_index]}"
        lines.append(comment)
        frame = coords[sample_index]
        for atom_index, atomic_number in enumerate(atom_numbers):
            x, y, z = frame[atom_index]
            lines.append(
                f"{atom_symbol(int(atomic_number))} "
                f"{float(x):.8f} {float(y):.8f} {float(z):.8f}"
            )
    return "\n".join(lines) + "\n"


def _xyz_frame_text(
    coords_ang: np.ndarray,
    atom_numbers: list[int],
    *,
    comment_line: str,
) -> str:
    frame = np.asarray(coords_ang, dtype=float)
    if frame.ndim != 2 or frame.shape[1] != 3:
        raise ValueError(f"Expected coords_ang with shape (n_atoms, 3), got {frame.shape}.")
    atom_count = int(frame.shape[0])
    if atom_count != len(atom_numbers):
        raise ValueError(
            f"XYZ export atom count mismatch: coords have {atom_count}, atom_numbers have {len(atom_numbers)}."
        )
    lines = [str(atom_count), str(comment_line)]
    for atom_index, atomic_number in enumerate(atom_numbers):
        x, y, z = frame[atom_index]
        lines.append(
            f"{atom_symbol(int(atomic_number))} "
            f"{float(x):.8f} {float(y):.8f} {float(z):.8f}"
        )
    return "\n".join(lines) + "\n"


def _sample_id(batch_id: str, sample_index: int) -> str:
    return f"{str(batch_id)}_sample_{int(sample_index):06d}"


def _geometry_channel_entries(*, include_velocities: bool) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = [
        {"name": "atom_numbers", "unit": None, "group": "sampling"},
        {"name": "atom_masses_amu", "unit": "amu", "group": "sampling"},
        {"name": "coords_bohr", "unit": "bohr", "group": "sampling"},
    ]
    if include_velocities:
        entries.append({"name": "velocities_bohr_per_au_time", "unit": "bohr/au_time", "group": "sampling"})
    return entries


def reconstruct_cartesian_hessian_au(batch_payload: dict[str, Any]) -> np.ndarray:
    modal_matrix_au = np.asarray(batch_payload.get("modal_matrix_au"), dtype=float)
    masses_au_components = np.asarray(batch_payload.get("masses_au_components"), dtype=float).reshape(-1)
    frequencies_cm1 = np.asarray(batch_payload.get("frequencies_cm1"), dtype=float).reshape(-1)
    mode_kinds = [str(value) for value in list(batch_payload.get("mode_kinds", []) or [])]
    if modal_matrix_au.ndim != 2:
        raise ValueError(f"modal_matrix_au must be rank-2, got shape {modal_matrix_au.shape}.")
    if masses_au_components.ndim != 1 or masses_au_components.shape[0] != modal_matrix_au.shape[0]:
        raise ValueError(
            "masses_au_components must align with modal_matrix_au rows: "
            f"masses={masses_au_components.shape}, modal={modal_matrix_au.shape}."
        )
    if frequencies_cm1.shape[0] != modal_matrix_au.shape[1]:
        raise ValueError(
            "frequencies_cm1 must align with modal_matrix_au columns: "
            f"frequencies={frequencies_cm1.shape}, modal={modal_matrix_au.shape}."
        )
    if len(mode_kinds) != int(frequencies_cm1.shape[0]):
        raise ValueError(
            f"mode_kinds count mismatch: expected {frequencies_cm1.shape[0]}, found {len(mode_kinds)}."
        )

    omega_abs_sq = np.square(np.abs(frequencies_cm1) * float(CM1_TO_ANGULAR_FREQUENCY_AU))
    lambda_diag = np.zeros(int(frequencies_cm1.shape[0]), dtype=float)
    for mode_index, kind in enumerate(mode_kinds):
        if kind == "imaginary":
            lambda_diag[mode_index] = -float(omega_abs_sq[mode_index])
        elif kind == "zero":
            lambda_diag[mode_index] = 0.0
        else:
            lambda_diag[mode_index] = float(omega_abs_sq[mode_index])

    weighted_modes = np.asarray(masses_au_components[:, None] * modal_matrix_au, dtype=float)
    hessian = np.asarray((weighted_modes * lambda_diag[None, :]) @ weighted_modes.T, dtype=float)
    return 0.5 * (hessian + hessian.T)


def _coords_all_ang_from_batch(batch_payload: dict[str, Any]) -> np.ndarray:
    return np.asarray(_coords_all_bohr_from_batch(batch_payload) * float(BOHR_TO_ANG), dtype=float)


def _coords_all_bohr_from_batch(batch_payload: dict[str, Any]) -> np.ndarray:
    q_samples = np.asarray(batch_payload.get("q_samples"), dtype=float)
    coords0_bohr = np.asarray(batch_payload.get("coords0_bohr"), dtype=float).reshape(-1)
    modal_matrix_au = np.asarray(batch_payload.get("modal_matrix_au"), dtype=float)
    n_atoms = int(batch_payload.get("n_atoms") or 0)
    if n_atoms <= 0:
        raise ValueError("Sample batch does not contain a valid atom count.")
    if q_samples.ndim != 2:
        raise ValueError(f"q_samples must be rank-2, got shape {q_samples.shape}.")
    return _coords_bohr_from_q_samples(q_samples, coords0_bohr, modal_matrix_au, n_atoms)


def _velocities_all_bohr_per_au_time_from_batch(batch_payload: dict[str, Any]) -> np.ndarray:
    p_samples = np.asarray(batch_payload.get("p_samples"), dtype=float)
    modal_matrix_au = np.asarray(batch_payload.get("modal_matrix_au"), dtype=float)
    n_atoms = int(batch_payload.get("n_atoms") or 0)
    if n_atoms <= 0:
        raise ValueError("Sample batch does not contain a valid atom count.")
    if p_samples.ndim != 2:
        raise ValueError(f"p_samples must be rank-2, got shape {p_samples.shape}.")
    if modal_matrix_au.ndim != 2:
        raise ValueError(f"modal_matrix_au must be rank-2, got shape {modal_matrix_au.shape}.")
    if p_samples.shape[1] != modal_matrix_au.shape[1]:
        raise ValueError(
            "p_samples must align with modal_matrix_au columns: "
            f"p_samples={p_samples.shape}, modal_matrix_au={modal_matrix_au.shape}."
        )
    return _velocities_bohr_per_au_time_from_p_samples(p_samples, modal_matrix_au, n_atoms)


def build_normal_modes_export_bundle(
    *,
    batch_id: str,
    batch_payload: dict[str, Any],
) -> tuple[str, bytes]:
    source_name = str(batch_payload.get("source_name") or "uploaded.molden")
    source_content = str(batch_payload.get("source_content") or "")
    if not source_content.strip():
        raise ValueError("Sample batch does not contain the original molden content.")

    atom_numbers = [int(value) for value in list(batch_payload.get("atom_numbers", []) or [])]
    q_samples = np.asarray(batch_payload.get("q_samples"), dtype=float)
    p_samples = np.asarray(batch_payload.get("p_samples"), dtype=float)
    modal_matrix_au = np.asarray(batch_payload.get("modal_matrix_au"), dtype=float)
    frequencies_cm1 = np.asarray(batch_payload.get("frequencies_cm1"), dtype=float)
    masses_au_per_atom = np.asarray(batch_payload.get("masses_au_per_atom"), dtype=float)
    masses_au_components = np.asarray(batch_payload.get("masses_au_components"), dtype=float)
    equilibrium_coords_ang = np.asarray(batch_payload.get("equilibrium_coords_ang"), dtype=float)
    mode_sampling_plan = [dict(item) for item in list(batch_payload.get("mode_sampling_plan", []) or [])]
    preview_indices = [int(value) for value in list(batch_payload.get("preview_indices", []) or [])]
    request_snapshot = dict(batch_payload.get("request_snapshot") or {})
    request_received_at_utc = str(batch_payload.get("request_received_at_utc") or "")
    sampling_completed_at_utc = str(batch_payload.get("sampling_completed_at_utc") or "")
    sampling_duration_ms = int(batch_payload.get("sampling_duration_ms") or 0)
    seed = int(batch_payload.get("seed") or 0)
    sample_count = int(batch_payload.get("sample_count") or q_samples.shape[0])
    preview_count = int(batch_payload.get("preview_count") or len(preview_indices))
    mode_kinds = [str(value) for value in list(batch_payload.get("mode_kinds", []) or [])]

    coords_all_ang = _coords_all_ang_from_batch(batch_payload)
    reconstructed_hessian_cartesian_au = reconstruct_cartesian_hessian_au(batch_payload)
    all_structures_xyz = _xyz_trajectory_text(coords_all_ang, atom_numbers, batch_id=str(batch_id))
    exported_at_utc = utc_now_iso()

    log_text = "\n".join(
        [
            f"batch_id={batch_id}",
            f"source_name={source_name}",
            f"seed={seed}",
            f"sample_count={sample_count}",
            f"preview_count={preview_count}",
            f"request_received_at_utc={request_received_at_utc}",
            f"sampling_completed_at_utc={sampling_completed_at_utc}",
            f"sampling_duration_ms={sampling_duration_ms}",
            f"exported_at_utc={exported_at_utc}",
        ]
    ) + "\n"

    result_summary = {
        "batch_id": str(batch_id),
        "source_name": source_name,
        "sample_count": sample_count,
        "preview_count": preview_count,
        "seed": seed,
        "request_received_at_utc": request_received_at_utc,
        "sampling_completed_at_utc": sampling_completed_at_utc,
        "sampling_duration_ms": sampling_duration_ms,
        "preview_indices": preview_indices,
        "mode_sampling_plan": mode_sampling_plan,
    }
    reconstruction_metadata = {
        "hessian_source": "reconstructed_from_modes",
        "units": {
            "frequencies_cm1": "cm^-1",
            "modal_matrix_au": "bohr / sqrt(electron_mass)",
            "masses_au_per_atom": "electron_mass",
            "masses_au_components": "electron_mass",
            "reconstructed_hessian_cartesian_au": "Hartree / bohr^2",
        },
        "component_order": "[x1, y1, z1, x2, y2, z2, ...]",
        "modal_orthonormality": "A^T M A ~= I",
        "cartesian_hessian_formula": "H = M A Lambda A^T M",
        "lambda_definition": {
            "positive": "+|omega|^2",
            "zero": "0",
            "imaginary": "-|omega|^2",
        },
        "mode_kinds": mode_kinds,
    }

    file_entries = [
        {
            "path": "manifest.json",
            "description": "Bundle manifest and file inventory.",
        },
        {
            "path": "README.txt",
            "description": "Human-readable overview of bundle contents and units.",
        },
        {
            "path": "log/sampling.log",
            "description": "Sampling and export timestamps, seed, and counts.",
        },
        {
            "path": "input/original.molden",
            "description": "Original molden file content used for parsing and sampling.",
        },
        {
            "path": "input/request.json",
            "description": "Normalized sampling request snapshot for reproducibility.",
        },
        {
            "path": "sampling/result_summary.json",
            "description": "Sampling summary including mode plan and preview indices.",
        },
        {
            "path": "sampling/coords_all_ang.npy",
            "description": "All sampled structures in Angstrom.",
            "shape": list(coords_all_ang.shape),
        },
        {
            "path": "sampling/all_structures.xyz",
            "description": "All sampled structures as concatenated XYZ frames.",
        },
        {
            "path": "sampling/equilibrium_coords_ang.npy",
            "description": "Equilibrium structure in Angstrom.",
            "shape": list(equilibrium_coords_ang.shape),
        },
        {
            "path": "sampling/q_samples_au.npy",
            "description": "All sampled normal coordinates q in atomic units.",
            "shape": list(q_samples.shape),
        },
        {
            "path": "sampling/p_samples_au.npy",
            "description": "All sampled normal momenta p in atomic units.",
            "shape": list(p_samples.shape),
        },
        {
            "path": "sampling/preview_indices.json",
            "description": "Indices of sampled structures sent to the frontend preview.",
        },
        {
            "path": "modes/mode_sampling_plan.json",
            "description": "Per-mode effective sampling plan after filters and rules.",
        },
        {
            "path": "modes/modal_matrix_au.npy",
            "description": "Mass-orthonormal modal matrix A in atomic units.",
            "shape": list(modal_matrix_au.shape),
        },
        {
            "path": "modes/frequencies_cm1.npy",
            "description": "Normal-mode frequencies in cm^-1.",
            "shape": list(frequencies_cm1.shape),
        },
        {
            "path": "modes/masses_au_per_atom.npy",
            "description": "Atomic masses in electron-mass atomic units.",
            "shape": list(masses_au_per_atom.shape),
        },
        {
            "path": "modes/masses_au_components.npy",
            "description": "Cartesian-component masses in electron-mass atomic units.",
            "shape": list(masses_au_components.shape),
        },
        {
            "path": "modes/reconstructed_hessian_cartesian_au.npy",
            "description": "Cartesian Hessian reconstructed from frequencies and modal matrix.",
            "shape": list(reconstructed_hessian_cartesian_au.shape),
        },
        {
            "path": "modes/reconstruction_metadata.json",
            "description": "Definitions, units, and formulas for Hessian reconstruction.",
        },
    ]
    manifest = {
        "kind": "normal_modes_sampling_bundle",
        "schema_version": NORMAL_MODES_EXPORT_SCHEMA_VERSION,
        "archive_format": "tar.gz",
        "batch_id": str(batch_id),
        "source_name": source_name,
        "sample_count": sample_count,
        "preview_count": preview_count,
        "seed": seed,
        "exported_at_utc": exported_at_utc,
        "sampling_completed_at_utc": sampling_completed_at_utc,
        "request_received_at_utc": request_received_at_utc,
        "sampling_duration_ms": sampling_duration_ms,
        "n_atoms": int(batch_payload.get("n_atoms") or 0),
        "n_modes": int(batch_payload.get("n_modes") or modal_matrix_au.shape[1]),
        "atom_numbers": atom_numbers,
        "hessian_source": "reconstructed_from_modes",
        "files": file_entries,
    }
    readme_text = "\n".join(
        [
            "Normal Modes Sampling Reproducibility Bundle",
            "",
            "Key files:",
            "- input/original.molden: original molden content used for parsing.",
            "- input/request.json: normalized sampling request with actual seed.",
            "- sampling/coords_all_ang.npy: all sampled structures in Angstrom.",
            "- sampling/all_structures.xyz: all sampled structures as XYZ frames.",
            "- sampling/q_samples_au.npy and sampling/p_samples_au.npy: sampled q/p arrays in atomic units.",
            "- modes/modal_matrix_au.npy: mass-orthonormal modal matrix A.",
            "- modes/reconstructed_hessian_cartesian_au.npy: Hessian reconstructed from frequencies and A.",
            "",
            "Conventions:",
            "- Cartesian component order is [x1, y1, z1, x2, y2, z2, ...].",
            "- Hessian reconstruction uses H = M A Lambda A^T M.",
            "- Lambda uses +|omega|^2 for positive modes, 0 for zero modes, and -|omega|^2 for imaginary modes.",
        ]
    ) + "\n"

    tar_buffer = io.BytesIO()
    with tarfile.open(fileobj=tar_buffer, mode="w:gz") as tar:
        entries: list[tuple[str, bytes]] = [
            ("manifest.json", json_text(manifest).encode("utf-8")),
            ("README.txt", readme_text.encode("utf-8")),
            ("log/sampling.log", log_text.encode("utf-8")),
            ("input/original.molden", source_content.encode("utf-8")),
            ("input/request.json", json_text(request_snapshot).encode("utf-8")),
            ("sampling/result_summary.json", json_text(result_summary).encode("utf-8")),
            ("sampling/coords_all_ang.npy", npy_bytes(coords_all_ang)),
            ("sampling/all_structures.xyz", all_structures_xyz.encode("utf-8")),
            ("sampling/equilibrium_coords_ang.npy", npy_bytes(equilibrium_coords_ang)),
            ("sampling/q_samples_au.npy", npy_bytes(q_samples)),
            ("sampling/p_samples_au.npy", npy_bytes(p_samples)),
            ("sampling/preview_indices.json", json_text(preview_indices).encode("utf-8")),
            ("modes/mode_sampling_plan.json", json_text(mode_sampling_plan).encode("utf-8")),
            ("modes/modal_matrix_au.npy", npy_bytes(modal_matrix_au)),
            ("modes/frequencies_cm1.npy", npy_bytes(frequencies_cm1)),
            ("modes/masses_au_per_atom.npy", npy_bytes(masses_au_per_atom)),
            ("modes/masses_au_components.npy", npy_bytes(masses_au_components)),
            ("modes/reconstructed_hessian_cartesian_au.npy", npy_bytes(reconstructed_hessian_cartesian_au)),
            ("modes/reconstruction_metadata.json", json_text(reconstruction_metadata).encode("utf-8")),
        ]
        modified_at = datetime.now(timezone.utc)
        for archive_path, content_bytes in entries:
            info = tarfile.TarInfo(name=archive_path)
            info.size = len(content_bytes)
            info.mtime = modified_at.timestamp()
            tar.addfile(info, io.BytesIO(content_bytes))

    source_base = sanitize_filename_part(source_name.rsplit(".", 1)[0])
    file_name = f"normal_modes_sampling_{source_base}_{sanitize_filename_part(batch_id)}.tar.gz"
    return file_name, tar_buffer.getvalue()


def build_normal_modes_geometry_export_entries(
    *,
    batch_id: str,
    batch_payload: dict[str, Any],
) -> tuple[str, list[tuple[str, bytes]]]:
    sampling_method = str(batch_payload.get("sampling_method") or NORMAL_MODES_GEOMETRY_METHOD_HARMONIC).strip()
    source_name = str(batch_payload.get("source_name") or "uploaded.molden")
    atom_numbers = [int(value) for value in list(batch_payload.get("atom_numbers", []) or [])]
    seed = int(batch_payload.get("seed") or 0)
    charge = int(batch_payload.get("charge") or 0)
    multiplicity = int(batch_payload.get("multiplicity") or 1)

    coords_bohr = np.asarray(_coords_all_bohr_from_batch(batch_payload), dtype=float)
    velocities_bohr_per_au_time = np.asarray(_velocities_all_bohr_per_au_time_from_batch(batch_payload), dtype=float)
    coords_ang = np.asarray(coords_bohr * float(BOHR_TO_ANG), dtype=float)
    atom_masses_amu = np.asarray([atomic_mass_amu(value) for value in atom_numbers], dtype=float)

    sample_count = int(coords_bohr.shape[0])
    n_atoms = int(coords_bohr.shape[1])
    if len(atom_numbers) != n_atoms:
        raise ValueError(
            f"Sample batch atom-number count mismatch: expected {n_atoms}, found {len(atom_numbers)}."
        )

    sample_ids = [_sample_id(batch_id, sample_index) for sample_index in range(sample_count)]
    created_at_utc = utc_now_iso()
    topology_signature = build_topology_signature(atom_numbers)
    all_structures_xyz = _xyz_trajectory_text(
        coords_ang,
        atom_numbers,
        batch_id=str(batch_id),
        sample_ids=sample_ids,
    )
    label_source = str(source_name or "").strip()
    if label_source:
        label = f"{label_source} normal modes samples"
    else:
        label = f"normal_modes_samples_{sanitize_filename_part(batch_id)}"

    manifest = {
        "kind": NORMAL_MODES_GEOMETRY_BUNDLE_KIND,
        "schema_version": NORMAL_MODES_GEOMETRY_EXPORT_SCHEMA_VERSION,
        "label": label,
        "source_name": source_name,
        "created_at_utc": created_at_utc,
        "n_samples": sample_count,
        "n_atoms": n_atoms,
        "topology_signature": topology_signature,
        "sampling_channels": _geometry_channel_entries(include_velocities=velocities_bohr_per_au_time.size > 0),
        "electronics": {
            "default_profile_id": None,
            "profiles": [],
        },
        "batch_id": str(batch_id),
        "sampling_method": sampling_method,
        "charge": charge,
        "multiplicity": multiplicity,
        "seed": seed,
    }

    entries: list[tuple[str, bytes]] = [
        ("manifest.json", json_text(manifest).encode("utf-8")),
        ("meta/sample_ids.json", json_text(sample_ids).encode("utf-8")),
        ("sampling/atom_numbers.npy", npy_bytes(np.asarray(atom_numbers, dtype=int))),
        ("sampling/atom_masses_amu.npy", npy_bytes(atom_masses_amu)),
        ("sampling/coords_bohr.npy", npy_bytes(coords_bohr)),
        ("sampling/all_structures.xyz", all_structures_xyz.encode("utf-8")),
    ]
    if velocities_bohr_per_au_time.size > 0:
        entries.append(("sampling/velocities_bohr_per_au_time.npy", npy_bytes(velocities_bohr_per_au_time)))

    source_base = sanitize_filename_part(source_name.rsplit(".", 1)[0])
    file_name = f"normal_modes_geometry_{source_base}_{sanitize_filename_part(batch_id)}.tar.gz"
    return file_name, entries


def build_normal_modes_geometry_export_bundle(
    *,
    batch_id: str,
    batch_payload: dict[str, Any],
) -> tuple[str, bytes]:
    file_name, entries = build_normal_modes_geometry_export_entries(
        batch_id=batch_id,
        batch_payload=batch_payload,
    )
    return file_name, tar_gz_bytes_from_entries(entries)
