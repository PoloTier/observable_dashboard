from __future__ import annotations

import io
import logging
import pickle
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from backend.config import load_config
from backend.dataset import flatten_time_array, prepare_dataset, reshape_coords

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Restricted unpickler -- only allows safe built-in and numpy types.
# This prevents arbitrary code execution via crafted pickle files.
# ---------------------------------------------------------------------------

_SAFE_BUILTINS = frozenset({
    "range",
    "complex",
    "set",
    "frozenset",
    "slice",
})


class RestrictedUnpickler(pickle.Unpickler):
    """Unpickler that refuses to instantiate arbitrary classes.

    Only allows:
    - Python built-in scalar / container types (dict, list, tuple, int, float,
      str, bytes, bool, None, complex, set, frozenset, range, slice)
    - numpy array reconstruction helpers (numpy.core.multiarray._reconstruct,
      numpy.ndarray, numpy.dtype, numpy.core.multiarray.scalar)
    - collections.OrderedDict (used by some older pickle streams)
    """

    def find_class(self, module: str, name: str) -> Any:
        # numpy reconstruction helpers
        if module in (
            "numpy",
            "numpy.core.multiarray",
            "numpy.core._multiarray_umath",
            "numpy._core.multiarray",
            "numpy._core._multiarray_umath",
        ):
            if name in ("_reconstruct", "scalar", "dtype", "ndarray"):
                return getattr(__import__(module, fromlist=[name]), name)

        # collections.OrderedDict
        if module == "collections" and name == "OrderedDict":
            import collections
            return collections.OrderedDict

        # builtins
        if module == "builtins" and name in _SAFE_BUILTINS:
            import builtins
            return getattr(builtins, name)

        raise pickle.UnpicklingError(
            f"Refused to unpickle disallowed class: {module}.{name}"
        )


def restricted_pickle_load(f: io.BufferedIOBase) -> Any:
    """Load a pickle file using the restricted unpickler."""
    return RestrictedUnpickler(f).load()


@dataclass(slots=True)
class DatasetLoadOptions:
    input_path: Path | None
    config_path: Path | None
    time_key: str = "_.0.record.time"
    coord_key: str = "_.0.record.x"
    etot_key: str = "_.0.record.Etot"
    eig_key: str = "_.0.record.eig"
    nac_key: str = "_.0.record.nac"
    drop_zero_frames: bool = True


@dataclass(slots=True)
class TrajectoryRecord:
    traj_id: str
    n_atoms: int
    atom_numbers: list[int]
    time: np.ndarray
    coords: np.ndarray
    etot_time: np.ndarray
    etot: np.ndarray
    eig_time: np.ndarray
    eig: np.ndarray
    nac_time: np.ndarray
    nac_norm: np.ndarray
    nac_components: np.ndarray
    nac_state_count: int
    nac_component_count: int
    de_nac_time: np.ndarray
    de_nac_norm: np.ndarray
    de_nac_components: np.ndarray
    de_nac_state_count: int
    de_nac_component_count: int
    state_time: np.ndarray
    state: np.ndarray
    c_prob_time: np.ndarray
    c_prob: np.ndarray


@dataclass(slots=True)
class RawFrameMeta:
    base_len: int
    valid_indices: list[int]


HBOND_DONOR_ACCEPTOR_ATOMIC_NUMBERS = (7, 8, 9)
HBOND_NEIGHBOR_SKIN = 1.0
HOPPING_ALGORITHM_MAX_ABS_C = "max_abs_c"
HOPPING_TIME_RULE_ARRIVAL_FRAME = "arrival_frame"


def _normalize_hopping_transitions(
    transitions: list[dict[str, Any]],
    *,
    n_states_limit: int = 0,
) -> list[dict[str, Any]]:
    raw_items = transitions if isinstance(transitions, list) else []
    out: list[dict[str, Any]] = []
    seen: set[tuple[int, int]] = set()
    state_limit = int(n_states_limit)

    for item in raw_items:
        if not isinstance(item, dict):
            raise ValueError("Each hopping transition must be an object with from_state and to_state.")

        try:
            from_state = int(item.get("from_state"))
            to_state = int(item.get("to_state"))
        except (TypeError, ValueError) as exc:
            raise ValueError("Each hopping transition must use integer from_state and to_state.") from exc

        if from_state < 0 or to_state < 0:
            raise ValueError("Hopping transition states must be >= 0.")
        if from_state == to_state:
            raise ValueError("Hopping transition requires from_state != to_state.")
        if state_limit > 0 and (from_state >= state_limit or to_state >= state_limit):
            raise ValueError(
                f"Hopping transition state out of bounds: expected 0 <= state < {state_limit}, "
                f"got {from_state}->{to_state}."
            )

        pair = (from_state, to_state)
        if pair in seen:
            continue
        seen.add(pair)
        out.append(
            {
                "transition_key": f"{from_state}->{to_state}",
                "from_state": from_state,
                "to_state": to_state,
            }
        )

    if not out:
        raise ValueError("At least one hopping transition is required.")
    return out


def _compute_hopping_events_for_trajectory(
    traj: TrajectoryRecord,
    transitions: list[dict[str, Any]],
    *,
    time_rule: str,
) -> tuple[list[dict[str, Any]], dict[str, int]]:
    if str(time_rule) != HOPPING_TIME_RULE_ARRIVAL_FRAME:
        raise ValueError(f"Unsupported hopping time_rule: {time_rule}")

    transition_lookup = {
        (int(item["from_state"]), int(item["to_state"])): item
        for item in transitions
    }
    counts = {str(item["transition_key"]): 0 for item in transitions}

    time_axis = np.asarray(traj.state_time, dtype=float).reshape(-1)
    state_axis = np.asarray(traj.state, dtype=int).reshape(-1)
    frame_count = int(min(time_axis.size, state_axis.size))
    if frame_count < 2:
        return [], counts

    time_axis = time_axis[:frame_count]
    state_axis = state_axis[:frame_count]
    events: list[dict[str, Any]] = []

    for frame_idx in range(frame_count - 1):
        from_state = int(state_axis[frame_idx])
        to_state = int(state_axis[frame_idx + 1])
        transition = transition_lookup.get((from_state, to_state))
        if transition is None:
            continue

        event_time = float(time_axis[frame_idx + 1])
        if not np.isfinite(event_time):
            continue

        events.append(
            {
                "transition_key": str(transition["transition_key"]),
                "from_state": from_state,
                "to_state": to_state,
                "frame_from": int(frame_idx),
                "frame_to": int(frame_idx + 1),
                "time": event_time,
            }
        )
        counts[str(transition["transition_key"])] += 1

    return events, counts


def _build_hbond_candidate_table(distance_matrix: np.ndarray, cutoff: float) -> tuple[np.ndarray, np.ndarray]:
    matrix = np.asarray(distance_matrix, dtype=float)
    if matrix.ndim != 2:
        raise ValueError(f"Hydrogen-bond distance matrix must be rank-2, got shape={matrix.shape}.")

    candidate_mask = np.isfinite(matrix) & (matrix < float(cutoff))
    counts = np.sum(candidate_mask, axis=1, dtype=int)
    n_rows = int(matrix.shape[0])
    max_candidates = int(counts.max()) if counts.size else 0
    if n_rows <= 0 or max_candidates <= 0:
        return np.empty((n_rows, 0), dtype=int), np.zeros((n_rows, 0), dtype=bool)

    padded = np.full((n_rows, max_candidates), -1, dtype=int)
    valid = np.zeros((n_rows, max_candidates), dtype=bool)
    for row_idx in range(n_rows):
        row_candidates = np.flatnonzero(candidate_mask[row_idx])
        if row_candidates.size <= 0:
            continue
        count = int(row_candidates.size)
        padded[row_idx, :count] = row_candidates
        valid[row_idx, :count] = True
    return padded, valid


def _expand_hbond_neighbor_segment(
    coords: np.ndarray,
    relevant_atom_indices: np.ndarray,
    start_frame: int,
    displacement_limit: float,
) -> int:
    frame_count = int(coords.shape[0])
    if start_frame < 0 or start_frame >= frame_count:
        return frame_count
    if relevant_atom_indices.size <= 0:
        return min(frame_count, start_frame + 1)

    ref_coords = np.asarray(coords[start_frame, relevant_atom_indices, :], dtype=float)
    limit = float(displacement_limit)
    if not np.isfinite(limit) or limit <= 0:
        return min(frame_count, start_frame + 1)

    end_frame = start_frame + 1
    while end_frame < frame_count:
        deltas = np.asarray(coords[end_frame, relevant_atom_indices, :], dtype=float) - ref_coords
        displacements = np.linalg.norm(deltas, axis=1)
        if not np.all(np.isfinite(displacements)):
            break
        if float(np.max(displacements)) > limit:
            break
        end_frame += 1
    return end_frame


def _collect_frame_hbonds(
    *,
    frame_idx: int,
    frame_coords: np.ndarray,
    hydrogen_indices: np.ndarray,
    donor_acceptor_indices: np.ndarray,
    donor_candidate_positions: np.ndarray,
    donor_candidate_valid: np.ndarray,
    acceptor_candidate_positions: np.ndarray,
    acceptor_candidate_valid: np.ndarray,
    dh_bond_length: float,
    hbond_distance_cutoff: float,
    hbond_angle_cutoff: float,
) -> list[dict[str, Any]]:
    h_count = int(hydrogen_indices.size)
    da_count = int(donor_acceptor_indices.size)
    if h_count <= 0 or da_count <= 0:
        return []
    if donor_candidate_positions.shape[1] <= 0 or acceptor_candidate_positions.shape[1] <= 0:
        return []

    frame = np.asarray(frame_coords, dtype=float)
    hydrogen_coords = np.asarray(frame[hydrogen_indices], dtype=float)
    donor_acceptor_coords = np.asarray(frame[donor_acceptor_indices], dtype=float)

    donor_safe_positions = np.where(donor_candidate_valid, donor_candidate_positions, 0)
    donor_candidate_coords = donor_acceptor_coords[donor_safe_positions]
    donor_vectors = donor_candidate_coords - hydrogen_coords[:, None, :]
    donor_distances = np.linalg.norm(donor_vectors, axis=2)
    donor_within_cutoff = donor_candidate_valid & np.isfinite(donor_distances) & (donor_distances < float(dh_bond_length))
    donor_has_match = np.any(donor_within_cutoff, axis=1)
    if not np.any(donor_has_match):
        return []

    donor_first_slots = np.argmax(donor_within_cutoff, axis=1)
    row_indices = np.arange(h_count, dtype=int)
    donor_choice_positions = np.full(h_count, -1, dtype=int)
    donor_choice_positions[donor_has_match] = donor_safe_positions[row_indices[donor_has_match], donor_first_slots[donor_has_match]]

    donor_coords = np.zeros((h_count, 3), dtype=float)
    donor_coords[donor_has_match] = donor_candidate_coords[row_indices[donor_has_match], donor_first_slots[donor_has_match]]
    donor_direction = np.zeros((h_count, 3), dtype=float)
    donor_direction[donor_has_match] = donor_vectors[row_indices[donor_has_match], donor_first_slots[donor_has_match]]
    donor_norms = np.linalg.norm(donor_direction, axis=1)
    donor_ready = donor_has_match & np.isfinite(donor_norms) & (donor_norms > 1e-12)
    if not np.any(donor_ready):
        return []

    acceptor_safe_positions = np.where(acceptor_candidate_valid, acceptor_candidate_positions, 0)
    acceptor_candidate_coords = donor_acceptor_coords[acceptor_safe_positions]
    acceptor_vectors = acceptor_candidate_coords - hydrogen_coords[:, None, :]
    acceptor_distances = np.linalg.norm(acceptor_vectors, axis=2)
    acceptor_norms = acceptor_distances
    donor_acceptor_vectors = acceptor_candidate_coords - donor_coords[:, None, :]
    donor_acceptor_distances = np.linalg.norm(donor_acceptor_vectors, axis=2)

    dot_products = np.einsum("hkc,hc->hk", acceptor_vectors, donor_direction)
    denom = acceptor_norms * donor_norms[:, None]
    cos_theta = np.zeros_like(acceptor_distances, dtype=float)
    np.divide(dot_products, denom, out=cos_theta, where=denom > 1e-12)
    np.clip(cos_theta, -1.0, 1.0, out=cos_theta)
    angles = np.degrees(np.arccos(cos_theta))

    hit_mask = (
        donor_ready[:, None]
        & acceptor_candidate_valid
        & np.isfinite(donor_acceptor_distances)
        & (donor_acceptor_distances < float(hbond_distance_cutoff))
        & np.isfinite(angles)
        & (angles >= float(hbond_angle_cutoff))
        & (acceptor_safe_positions != donor_choice_positions[:, None])
    )
    if not np.any(hit_mask):
        return []

    hit_rows, hit_slots = np.nonzero(hit_mask)
    donor_abs_indices = donor_acceptor_indices[donor_choice_positions[hit_rows]]
    acceptor_abs_indices = donor_acceptor_indices[acceptor_safe_positions[hit_rows, hit_slots]]

    hbonds: list[dict[str, Any]] = []
    for hit_idx in range(int(hit_rows.size)):
        row = int(hit_rows[hit_idx])
        slot = int(hit_slots[hit_idx])
        hbonds.append(
            {
                "frame": int(frame_idx),
                "donor_idx": int(donor_abs_indices[hit_idx]),
                "h_idx": int(hydrogen_indices[row]),
                "acceptor_idx": int(acceptor_abs_indices[hit_idx]),
                "distance": float(donor_acceptor_distances[row, slot]),
                "angle": float(angles[row, slot]),
            }
        )
    return hbonds


class DatasetStore:
    def __init__(
        self,
        *,
        input_path: Path,
        meta: dict[str, Any],
        defaults: dict[str, Any],
        trajectories: dict[str, TrajectoryRecord],
        raw_key_previews: dict[str, dict[str, str]] | None = None,
        raw_records_by_traj: dict[str, dict[str, Any]] | None = None,
        raw_frame_meta_by_traj: dict[str, RawFrameMeta] | None = None,
        time_key: str = "_.0.record.time",
    ) -> None:
        self.input_path = Path(input_path)
        meta_payload = dict(meta)
        meta_payload.setdefault("source_pkl", str(self.input_path) if trajectories else "")
        meta_payload.setdefault("dataset_loaded", bool(trajectories))
        self.meta = meta_payload
        self.defaults = defaults
        self.trajectories = trajectories
        self.raw_key_previews = raw_key_previews or {}
        self.raw_records_by_traj = raw_records_by_traj or {}
        self.raw_frame_meta_by_traj = raw_frame_meta_by_traj or {}
        self.time_key = str(time_key or "_.0.record.time")
        self.traj_ids = sorted(
            trajectories.keys(),
            key=lambda x: int(x) if str(x).isdigit() else str(x),
        )

    def get_trajectory(self, traj_id: str) -> TrajectoryRecord | None:
        return self.trajectories.get(str(traj_id))

    def build_mol3d_hbond_payload(
        self,
        traj_id: str,
        *,
        hbond_distance_cutoff: float = 3.5,
        hbond_angle_cutoff: float = 150.0,
        dh_bond_length: float = 1.3,
    ) -> dict[str, Any] | None:
        traj = self.get_trajectory(traj_id)
        if traj is None:
            return None

        if not np.isfinite(hbond_distance_cutoff) or float(hbond_distance_cutoff) <= 0:
            raise ValueError("hbond_distance_cutoff must be a positive finite value.")
        if not np.isfinite(hbond_angle_cutoff) or float(hbond_angle_cutoff) <= 0:
            raise ValueError("hbond_angle_cutoff must be a positive finite value.")
        if not np.isfinite(dh_bond_length) or float(dh_bond_length) <= 0:
            raise ValueError("dh_bond_length must be a positive finite value.")

        coords = np.asarray(traj.coords, dtype=float)
        if coords.ndim != 3 or coords.shape[-1] < 3:
            raise ValueError(
                (
                    "Coordinates are invalid for hydrogen-bond detection: "
                    f"expected shape [frame, atom, 3], got shape={coords.shape}."
                )
            )

        atom_numbers = np.asarray(traj.atom_numbers, dtype=int).reshape(-1)
        if atom_numbers.size <= 0:
            return {
                "traj_id": str(traj.traj_id),
                "n_frames": int(coords.shape[0]),
                "n_atoms": int(coords.shape[1]),
                "donor_acceptor_atomic_numbers": [7, 8, 9],
                "hbond_distance_cutoff": float(hbond_distance_cutoff),
                "hbond_angle_cutoff": float(hbond_angle_cutoff),
                "dh_bond_length": float(dh_bond_length),
                "hbonds": [],
            }

        n_frames = int(coords.shape[0])
        n_atoms = int(min(coords.shape[1], atom_numbers.size))
        if n_atoms <= 0 or n_frames <= 0:
            return {
                "traj_id": str(traj.traj_id),
                "n_frames": max(0, n_frames),
                "n_atoms": max(0, n_atoms),
                "donor_acceptor_atomic_numbers": [7, 8, 9],
                "hbond_distance_cutoff": float(hbond_distance_cutoff),
                "hbond_angle_cutoff": float(hbond_angle_cutoff),
                "dh_bond_length": float(dh_bond_length),
                "hbonds": [],
            }

        coords = np.asarray(coords[:, :n_atoms, :3], dtype=float)
        atom_numbers = np.asarray(atom_numbers[:n_atoms], dtype=int)

        hydrogen_indices = np.flatnonzero(atom_numbers == 1).astype(int)
        donor_acceptor_indices = np.flatnonzero(
            np.isin(atom_numbers, np.asarray(HBOND_DONOR_ACCEPTOR_ATOMIC_NUMBERS, dtype=int))
        ).astype(int)

        hbonds: list[dict[str, Any]] = []
        if hydrogen_indices.size > 0 and donor_acceptor_indices.size > 0:
            relevant_atom_indices = np.unique(np.concatenate([hydrogen_indices, donor_acceptor_indices])).astype(int)
            displacement_limit = float(HBOND_NEIGHBOR_SKIN) * 0.5
            donor_candidate_cutoff = float(dh_bond_length) + float(HBOND_NEIGHBOR_SKIN)
            acceptor_candidate_cutoff = (
                float(hbond_distance_cutoff) + float(dh_bond_length) + float(HBOND_NEIGHBOR_SKIN)
            )

            frame_idx = 0
            while frame_idx < n_frames:
                segment_end = _expand_hbond_neighbor_segment(
                    coords=coords,
                    relevant_atom_indices=relevant_atom_indices,
                    start_frame=frame_idx,
                    displacement_limit=displacement_limit,
                )
                if segment_end <= frame_idx:
                    segment_end = frame_idx + 1

                ref_frame_coords = np.asarray(coords[frame_idx], dtype=float)
                ref_hydrogen_coords = np.asarray(ref_frame_coords[hydrogen_indices], dtype=float)
                ref_donor_acceptor_coords = np.asarray(ref_frame_coords[donor_acceptor_indices], dtype=float)
                ref_deltas = ref_donor_acceptor_coords[None, :, :] - ref_hydrogen_coords[:, None, :]
                ref_distances = np.linalg.norm(ref_deltas, axis=2)

                donor_candidate_positions, donor_candidate_valid = _build_hbond_candidate_table(
                    ref_distances,
                    donor_candidate_cutoff,
                )
                acceptor_candidate_positions, acceptor_candidate_valid = _build_hbond_candidate_table(
                    ref_distances,
                    acceptor_candidate_cutoff,
                )

                for current_frame_idx in range(frame_idx, segment_end):
                    hbonds.extend(
                        _collect_frame_hbonds(
                            frame_idx=current_frame_idx,
                            frame_coords=coords[current_frame_idx],
                            hydrogen_indices=hydrogen_indices,
                            donor_acceptor_indices=donor_acceptor_indices,
                            donor_candidate_positions=donor_candidate_positions,
                            donor_candidate_valid=donor_candidate_valid,
                            acceptor_candidate_positions=acceptor_candidate_positions,
                            acceptor_candidate_valid=acceptor_candidate_valid,
                            dh_bond_length=float(dh_bond_length),
                            hbond_distance_cutoff=float(hbond_distance_cutoff),
                            hbond_angle_cutoff=float(hbond_angle_cutoff),
                        )
                    )
                frame_idx = segment_end

        return {
            "traj_id": str(traj.traj_id),
            "n_frames": int(n_frames),
            "n_atoms": int(n_atoms),
            "donor_acceptor_atomic_numbers": list(HBOND_DONOR_ACCEPTOR_ATOMIC_NUMBERS),
            "hbond_distance_cutoff": float(hbond_distance_cutoff),
            "hbond_angle_cutoff": float(hbond_angle_cutoff),
            "dh_bond_length": float(dh_bond_length),
            "hbonds": hbonds,
        }

    def _build_mol3d_de_tensor(self, traj_id: str) -> np.ndarray:
        tid = str(traj_id)
        raw_record = self.raw_records_by_traj.get(tid)
        if not isinstance(raw_record, dict):
            raise ValueError(f"Raw record not found for trajectory: {tid}")

        raw_key = "_.0.record.dE"
        if raw_key not in raw_record:
            raise ValueError("dE vectors are unavailable for this trajectory.")

        try:
            raw_de = np.asarray(raw_record[raw_key], dtype=float)
        except Exception as exc:  # noqa: BLE001
            raise ValueError(f"dE vectors are not convertible to float values: {exc}") from exc

        if raw_de.size == 0:
            raise ValueError("dE vectors are empty for this trajectory.")
        if raw_de.ndim < 4:
            raise ValueError(
                (
                    "dE tensor has invalid rank for vector visualization: "
                    f"expected ndim >= 4, got ndim={raw_de.ndim} with shape={raw_de.shape}."
                )
            )

        # For dE tensors with an extra leading selector axis, always use axis=1 index 0.
        if raw_de.ndim >= 5:
            if int(raw_de.shape[1]) <= 0:
                raise ValueError(
                    (
                        "dE tensor has invalid shape on axis=1 while applying the fixed selector "
                        f"(shape={raw_de.shape})."
                    )
                )
            raw_de = np.take(raw_de, indices=0, axis=1)

        if raw_de.ndim < 4:
            raise ValueError(
                (
                    "dE tensor rank became invalid after axis selection: "
                    f"expected ndim >= 4, got ndim={raw_de.ndim} with shape={raw_de.shape}."
                )
            )

        tensor = raw_de.reshape(raw_de.shape[0], -1, raw_de.shape[-2], raw_de.shape[-1])
        frame_meta = self.raw_frame_meta_by_traj.get(tid)
        if frame_meta is None:
            raise ValueError(f"Trajectory {tid} has no valid frame metadata for dE vectors.")

        expected_base_len = int(frame_meta.base_len)
        if int(tensor.shape[0]) != expected_base_len:
            raise ValueError(
                (
                    "dE tensor frame axis does not match trajectory base frame length: "
                    f"shape[0]={tensor.shape[0]}, expected={expected_base_len}."
                )
            )

        valid_indices = np.asarray(frame_meta.valid_indices, dtype=int).reshape(-1)
        if valid_indices.size <= 0:
            return np.empty((0, tensor.shape[1], tensor.shape[2], tensor.shape[3]), dtype=float)
        if np.any((valid_indices < 0) | (valid_indices >= tensor.shape[0])):
            raise ValueError(
                (
                    "dE frame metadata contains out-of-range valid indices: "
                    f"tensor_frames={tensor.shape[0]}, min={int(valid_indices.min())}, max={int(valid_indices.max())}."
                )
            )

        return np.asarray(tensor[valid_indices], dtype=float)

    def _get_mol3d_de_meta(self, traj_id: str, n_atoms: int) -> tuple[bool, int, int]:
        try:
            de_tensor = self._build_mol3d_de_tensor(traj_id)
        except Exception:  # noqa: BLE001
            return False, 0, 0

        if de_tensor.ndim != 4:
            return False, 0, 0

        de_component_count = int(de_tensor.shape[1])
        de_state_count = int(min(de_tensor.shape[-2], de_tensor.shape[-1]))
        de_available = (
            de_tensor.size > 0
            and de_state_count >= 2
            and de_component_count == int(n_atoms) * 3
        )
        return bool(de_available), de_state_count, de_component_count

    def _get_mol3d_de_global_norm_stats(
        self,
        traj_id: str,
        n_atoms: int,
    ) -> tuple[str, float | None, float | None, float | None, int]:
        try:
            de_tensor = self._build_mol3d_de_tensor(traj_id)
        except Exception:  # noqa: BLE001
            return "", None, None, None, 0

        if de_tensor.ndim != 4:
            return "", None, None, None, 0

        n_components = int(de_tensor.shape[1])
        expected_components = int(n_atoms) * 3
        if n_components != expected_components or expected_components <= 0:
            return "", None, None, None, 0

        n_frames = int(de_tensor.shape[0])
        n_states_i = int(de_tensor.shape[-2])
        n_states_j = int(de_tensor.shape[-1])
        if n_frames <= 0 or n_states_i <= 0 or n_states_j <= 0:
            return "", None, None, None, 0

        vectors = np.asarray(
            de_tensor.reshape(n_frames, int(n_atoms), 3, n_states_i, n_states_j),
            dtype=float,
        )
        magnitudes = np.linalg.norm(vectors, axis=2)
        finite_values = np.asarray(magnitudes[np.isfinite(magnitudes)], dtype=float).reshape(-1)
        if finite_values.size <= 0:
            return "", None, None, None, 0

        q05, q90, q95 = np.quantile(finite_values, [0.05, 0.90, 0.95]).astype(float).tolist()
        if not np.isfinite(q05) or not np.isfinite(q90) or not np.isfinite(q95):
            return "", None, None, None, int(finite_values.size)

        return "traj_global", float(q05), float(q90), float(q95), int(finite_values.size)

    def build_mol3d_payload(self, traj_id: str) -> dict[str, Any] | None:
        traj = self.get_trajectory(traj_id)
        if traj is None:
            return None
        nac_available = (
            traj.nac_components.size > 0
            and int(traj.nac_state_count) >= 2
            and int(traj.nac_component_count) == int(traj.n_atoms) * 3
        )
        de_nac_available = (
            traj.de_nac_components.size > 0
            and int(traj.de_nac_state_count) >= 2
            and int(traj.de_nac_component_count) == int(traj.n_atoms) * 3
        )
        de_available, de_state_count, de_component_count = self._get_mol3d_de_meta(str(traj.traj_id), int(traj.n_atoms))
        (
            de_global_norm_scope,
            de_global_norm_p5,
            de_global_norm_p90,
            de_global_norm_p95,
            de_global_norm_count,
        ) = self._get_mol3d_de_global_norm_stats(str(traj.traj_id), int(traj.n_atoms))
        return {
            "traj_id": str(traj.traj_id),
            "time": traj.time.astype(float).tolist(),
            "coords": traj.coords.astype(float).tolist(),
            "n_atoms": int(traj.n_atoms),
            "atom_numbers": [int(v) for v in traj.atom_numbers],
            "n_frames": int(traj.coords.shape[0]) if traj.coords.ndim >= 1 else 0,
            "nac_available": bool(nac_available),
            "nac_state_count": int(traj.nac_state_count),
            "nac_component_count": int(traj.nac_component_count),
            "de_available": bool(de_available),
            "de_state_count": int(de_state_count),
            "de_component_count": int(de_component_count),
            "de_global_norm_scope": str(de_global_norm_scope),
            "de_global_norm_p5": (None if de_global_norm_p5 is None else float(de_global_norm_p5)),
            "de_global_norm_p90": (None if de_global_norm_p90 is None else float(de_global_norm_p90)),
            "de_global_norm_p95": (None if de_global_norm_p95 is None else float(de_global_norm_p95)),
            "de_global_norm_count": int(de_global_norm_count),
            "de_nac_available": bool(de_nac_available),
            "de_nac_state_count": int(traj.de_nac_state_count),
            "de_nac_component_count": int(traj.de_nac_component_count),
        }

    def build_mol3d_nac_payload(self, traj_id: str, state_i: int, state_j: int) -> dict[str, Any] | None:
        traj = self.get_trajectory(traj_id)
        if traj is None:
            return None

        n_states = int(traj.nac_state_count)
        if traj.nac_components.size == 0:
            raise ValueError("NAC vectors are unavailable for this trajectory.")
        if n_states <= 0:
            raise ValueError("NAC state count is invalid for this trajectory.")
        if state_i == state_j:
            raise ValueError("state_i and state_j must be different.")
        if state_i < 0 or state_i >= n_states:
            raise ValueError(f"state_i out of bounds: expected 0 <= state_i < {n_states}, got {state_i}.")
        if state_j < 0 or state_j >= n_states:
            raise ValueError(f"state_j out of bounds: expected 0 <= state_j < {n_states}, got {state_j}.")

        expected_components = int(traj.n_atoms) * 3
        n_components = int(traj.nac_component_count)
        if n_components != expected_components:
            raise ValueError(
                (
                    "NAC component count is incompatible with coordinates: "
                    f"nac_component_count={n_components}, expected n_atoms*3={expected_components}."
                )
            )

        pair_components = np.asarray(traj.nac_components[:, :, state_i, state_j], dtype=float)
        if pair_components.ndim != 2:
            raise ValueError(
                f"NAC pair array shape is invalid: expected 2D [frame, component], got {pair_components.shape}."
            )

        if pair_components.shape[1] != expected_components:
            raise ValueError(
                (
                    "NAC pair component width does not match n_atoms*3: "
                    f"width={pair_components.shape[1]}, expected={expected_components}."
                )
            )

        nac_time = np.asarray(traj.nac_time, dtype=float).reshape(-1)
        frame_count = int(min(pair_components.shape[0], nac_time.shape[0]))
        pair_components = pair_components[:frame_count]
        nac_time = nac_time[:frame_count]
        vectors = pair_components.reshape(frame_count, int(traj.n_atoms), 3)

        return {
            "traj_id": str(traj.traj_id),
            "state_i": int(state_i),
            "state_j": int(state_j),
            "n_states": n_states,
            "n_atoms": int(traj.n_atoms),
            "n_frames": int(frame_count),
            "time": nac_time.astype(float).tolist(),
            "vectors": vectors.astype(float).tolist(),
        }

    def build_mol3d_de_nac_payload(self, traj_id: str, state_i: int, state_j: int) -> dict[str, Any] | None:
        traj = self.get_trajectory(traj_id)
        if traj is None:
            return None

        n_states = int(traj.de_nac_state_count)
        if traj.de_nac_components.size == 0:
            raise ValueError("(E_j-E_i)*NAC_ij vectors are unavailable for this trajectory.")
        if n_states <= 0:
            raise ValueError("de_nac state count is invalid for this trajectory.")
        if state_i == state_j:
            raise ValueError("state_i and state_j must be different.")
        if state_i < 0 or state_i >= n_states:
            raise ValueError(f"state_i out of bounds: expected 0 <= state_i < {n_states}, got {state_i}.")
        if state_j < 0 or state_j >= n_states:
            raise ValueError(f"state_j out of bounds: expected 0 <= state_j < {n_states}, got {state_j}.")

        expected_components = int(traj.n_atoms) * 3
        n_components = int(traj.de_nac_component_count)
        if n_components != expected_components:
            raise ValueError(
                (
                    "de_nac component count is incompatible with coordinates: "
                    f"de_nac_component_count={n_components}, expected n_atoms*3={expected_components}."
                )
            )

        pair_components = np.asarray(traj.de_nac_components[:, :, state_i, state_j], dtype=float)
        if pair_components.ndim != 2:
            raise ValueError(
                f"de_nac pair array shape is invalid: expected 2D [frame, component], got {pair_components.shape}."
            )

        if pair_components.shape[1] != expected_components:
            raise ValueError(
                (
                    "de_nac pair component width does not match n_atoms*3: "
                    f"width={pair_components.shape[1]}, expected={expected_components}."
                )
            )

        de_nac_time = np.asarray(traj.de_nac_time, dtype=float).reshape(-1)
        frame_count = int(min(pair_components.shape[0], de_nac_time.shape[0]))
        pair_components = pair_components[:frame_count]
        de_nac_time = de_nac_time[:frame_count]
        vectors = pair_components.reshape(frame_count, int(traj.n_atoms), 3)

        return {
            "traj_id": str(traj.traj_id),
            "state_i": int(state_i),
            "state_j": int(state_j),
            "n_states": n_states,
            "n_atoms": int(traj.n_atoms),
            "n_frames": int(frame_count),
            "time": de_nac_time.astype(float).tolist(),
            "vectors": vectors.astype(float).tolist(),
        }

    def build_mol3d_de_payload(self, traj_id: str, state_i: int, state_j: int) -> dict[str, Any] | None:
        traj = self.get_trajectory(traj_id)
        if traj is None:
            return None

        de_tensor = self._build_mol3d_de_tensor(str(traj.traj_id))
        if de_tensor.size == 0:
            raise ValueError("dE vectors are unavailable for this trajectory.")
        if de_tensor.ndim != 4:
            raise ValueError(f"dE tensor shape is invalid: expected 4D, got {de_tensor.shape}.")

        n_states = int(min(de_tensor.shape[-2], de_tensor.shape[-1]))
        if n_states <= 0:
            raise ValueError("dE state count is invalid for this trajectory.")
        if state_i < 0 or state_i >= n_states:
            raise ValueError(f"state_i out of bounds: expected 0 <= state_i < {n_states}, got {state_i}.")
        if state_j < 0 or state_j >= n_states:
            raise ValueError(f"state_j out of bounds: expected 0 <= state_j < {n_states}, got {state_j}.")

        expected_components = int(traj.n_atoms) * 3
        n_components = int(de_tensor.shape[1])
        if n_components != expected_components:
            raise ValueError(
                (
                    "dE component count is incompatible with coordinates: "
                    f"de_component_count={n_components}, expected n_atoms*3={expected_components}."
                )
            )

        pair_components = np.asarray(de_tensor[:, :, state_i, state_j], dtype=float)
        if pair_components.ndim != 2:
            raise ValueError(
                f"dE pair array shape is invalid: expected 2D [frame, component], got {pair_components.shape}."
            )
        if pair_components.shape[1] != expected_components:
            raise ValueError(
                (
                    "dE pair component width does not match n_atoms*3: "
                    f"width={pair_components.shape[1]}, expected={expected_components}."
                )
            )

        de_time = np.asarray(traj.time, dtype=float).reshape(-1)
        frame_count = int(min(pair_components.shape[0], de_time.shape[0]))
        pair_components = pair_components[:frame_count]
        de_time = de_time[:frame_count]
        vectors = pair_components.reshape(frame_count, int(traj.n_atoms), 3)

        return {
            "traj_id": str(traj.traj_id),
            "state_i": int(state_i),
            "state_j": int(state_j),
            "n_states": n_states,
            "n_atoms": int(traj.n_atoms),
            "n_frames": int(frame_count),
            "time": de_time.astype(float).tolist(),
            "vectors": vectors.astype(float).tolist(),
        }

    @staticmethod
    def _frame_mask_suffix_break_index(frame_meta: RawFrameMeta | None) -> int | None:
        if frame_meta is None:
            return None

        base_len = int(frame_meta.base_len)
        if base_len <= 0:
            return None

        valid_indices = np.asarray(frame_meta.valid_indices, dtype=int).reshape(-1)
        if valid_indices.size <= 0:
            return 0
        if np.any((valid_indices < 0) | (valid_indices >= base_len)):
            return None

        expected_prefix = np.arange(valid_indices.size, dtype=int)
        if not np.array_equal(valid_indices, expected_prefix):
            return None
        if int(valid_indices.size) >= base_len:
            return None
        return int(valid_indices.size)

    @staticmethod
    def _nan_suffix_break_index(values: np.ndarray) -> int | None:
        arr = np.asarray(values)
        if arr.ndim <= 0:
            return None

        n_frames = int(arr.shape[0])
        if n_frames <= 0:
            return None

        if arr.ndim == 1:
            finite_mask = np.isfinite(arr)
        else:
            finite_mask = np.all(np.isfinite(arr.reshape(n_frames, -1)), axis=1)
        invalid_mask = ~np.asarray(finite_mask, dtype=bool)
        if not np.any(invalid_mask):
            return None

        suffix_all_invalid = np.logical_and.accumulate(invalid_mask[::-1])[::-1]
        candidates = np.flatnonzero(suffix_all_invalid)
        if candidates.size <= 0:
            return None
        return int(candidates[0])

    def _safe_raw_time_axis(self, raw_record: dict[str, Any]) -> np.ndarray | None:
        raw_time_value = raw_record.get(self.time_key)
        if raw_time_value is None:
            return None
        try:
            raw_time = np.asarray(flatten_time_array(raw_time_value), dtype=float).reshape(-1)
        except Exception:  # noqa: BLE001
            return None
        if raw_time.size <= 0:
            return None
        return raw_time

    @staticmethod
    def _coerce_numeric_timeseries(raw_value: Any, base_len: int) -> np.ndarray | None:
        if int(base_len) <= 0:
            return None
        try:
            arr = np.asarray(raw_value)
        except Exception:  # noqa: BLE001
            return None

        if arr.ndim <= 0:
            return None
        if int(arr.shape[0]) != int(base_len):
            return None

        try:
            if np.iscomplexobj(arr):
                return np.asarray(arr, dtype=np.complex128)
            return np.asarray(arr, dtype=float)
        except Exception:  # noqa: BLE001
            return None

    def _pick_nan_break_source_key(self, raw_record: dict[str, Any], base_len: int) -> str | None:
        preferred_keys = ["_.0.record.Etot", "_.0.record.eig", "_.0.record.c"]

        for key in preferred_keys:
            if key not in raw_record:
                continue
            values = self._coerce_numeric_timeseries(raw_record.get(key), base_len)
            if values is not None:
                return key

        for key in sorted(raw_record.keys()):
            key_text = str(key)
            if key_text == self.time_key or key_text in preferred_keys:
                continue
            values = self._coerce_numeric_timeseries(raw_record.get(key_text), base_len)
            if values is not None:
                return key_text

        return None

    @staticmethod
    def _infer_base_len_for_break_summary(
        *,
        raw_record: dict[str, Any],
        frame_meta: RawFrameMeta | None,
        raw_time: np.ndarray | None,
    ) -> int:
        if frame_meta is not None and int(frame_meta.base_len) > 0:
            return int(frame_meta.base_len)
        if raw_time is not None and int(raw_time.size) > 0:
            return int(raw_time.size)

        for value in raw_record.values():
            try:
                arr = np.asarray(value)
            except Exception:  # noqa: BLE001
                continue
            if arr.ndim <= 0:
                continue
            n_frames = int(arr.shape[0])
            if n_frames > 0:
                return n_frames
        return 0

    def _build_trajectory_break_item(self, traj_id: str) -> dict[str, Any] | None:
        tid = str(traj_id)
        raw_record = self.raw_records_by_traj.get(tid)
        if not isinstance(raw_record, dict):
            raw_record = {}

        frame_meta = self.raw_frame_meta_by_traj.get(tid)
        raw_time = self._safe_raw_time_axis(raw_record)
        base_len = self._infer_base_len_for_break_summary(
            raw_record=raw_record,
            frame_meta=frame_meta,
            raw_time=raw_time,
        )
        if base_len <= 0:
            return None

        frame_break_index = self._frame_mask_suffix_break_index(frame_meta)
        nan_break_index: int | None = None
        nan_source_key: str | None = None

        source_key = self._pick_nan_break_source_key(raw_record, base_len)
        if source_key:
            values = self._coerce_numeric_timeseries(raw_record.get(source_key), base_len)
            if values is not None:
                nan_break_index = self._nan_suffix_break_index(values)
                if nan_break_index is not None:
                    nan_source_key = source_key

        if frame_break_index is None and nan_break_index is None:
            return None

        if nan_break_index is not None and (frame_break_index is None or nan_break_index <= frame_break_index):
            break_index = int(nan_break_index)
            reason = "nan_suffix"
            source_key_out = nan_source_key
        else:
            break_index = int(frame_break_index)
            reason = "frame_mask_suffix"
            source_key_out = None

        if break_index < 0 or break_index >= base_len:
            return None

        break_time: float | None = None
        if raw_time is not None and break_index < int(raw_time.shape[0]):
            value = float(raw_time[break_index])
            if np.isfinite(value):
                break_time = value

        return {
            "traj_id": tid,
            "break_frame_index": int(break_index),
            "break_time": (None if break_time is None else float(break_time)),
            "reason": reason,
            "source_key": source_key_out,
        }

    def build_trajectory_break_summary(self) -> dict[str, Any]:
        broken_trajs: list[dict[str, Any]] = []
        for traj_id in self.traj_ids:
            item = self._build_trajectory_break_item(str(traj_id))
            if item is not None:
                broken_trajs.append(item)

        total_traj = len(self.traj_ids)
        broken_count = len(broken_trajs)
        return {
            "total_traj": int(total_traj),
            "broken_traj_count": int(broken_count),
            "complete_traj_count": int(total_traj - broken_count),
            "broken_trajs": broken_trajs,
        }

    def build_hopping_events(
        self,
        traj_ids: list[str],
        *,
        algorithm: str,
        time_rule: str,
        transitions: list[dict[str, Any]],
    ) -> dict[str, Any]:
        if str(algorithm) != HOPPING_ALGORITHM_MAX_ABS_C:
            raise ValueError(f"Unsupported hopping algorithm: {algorithm}")
        if str(time_rule) != HOPPING_TIME_RULE_ARRIVAL_FRAME:
            raise ValueError(f"Unsupported hopping time_rule: {time_rule}")

        requested_ids: list[str] = []
        seen_ids: set[str] = set()
        for raw_traj_id in traj_ids:
            traj_id = str(raw_traj_id).strip()
            if not traj_id or traj_id in seen_ids:
                continue
            if self.get_trajectory(traj_id) is None:
                raise KeyError(f"Trajectory not found: {traj_id}")
            requested_ids.append(traj_id)
            seen_ids.add(traj_id)

        if not requested_ids:
            raise ValueError("At least one traj_id is required for hopping detection.")

        n_states_limit = int(self.meta.get("n_states", 0) or 0)
        normalized_transitions = _normalize_hopping_transitions(transitions, n_states_limit=n_states_limit)
        totals_by_key = {str(item["transition_key"]): 0 for item in normalized_transitions}
        events_by_traj: dict[str, list[dict[str, Any]]] = {}
        counts_by_traj: list[dict[str, Any]] = []

        for traj_id in requested_ids:
            traj = self.get_trajectory(traj_id)
            if traj is None:
                raise KeyError(f"Trajectory not found: {traj_id}")

            events, counts = _compute_hopping_events_for_trajectory(
                traj,
                normalized_transitions,
                time_rule=str(time_rule),
            )
            events_by_traj[traj_id] = events

            for transition in normalized_transitions:
                transition_key = str(transition["transition_key"])
                count = int(counts.get(transition_key, 0))
                counts_by_traj.append(
                    {
                        "traj_id": traj_id,
                        "transition_key": transition_key,
                        "from_state": int(transition["from_state"]),
                        "to_state": int(transition["to_state"]),
                        "count": count,
                    }
                )
                totals_by_key[transition_key] += count

        totals_by_transition = [
            {
                "transition_key": str(transition["transition_key"]),
                "from_state": int(transition["from_state"]),
                "to_state": int(transition["to_state"]),
                "count": int(totals_by_key[str(transition["transition_key"])]),
            }
            for transition in normalized_transitions
        ]

        return {
            "traj_ids": requested_ids,
            "algorithm": str(algorithm),
            "time_rule": str(time_rule),
            "transitions": normalized_transitions,
            "events_by_traj": events_by_traj,
            "counts_by_traj": counts_by_traj,
            "totals_by_transition": totals_by_transition,
        }

    def to_bootstrap(self, api_base: str = "/api") -> dict[str, Any]:
        meta_payload = dict(self.meta)
        meta_payload["trajectory_break_summary"] = self.build_trajectory_break_summary()
        return {
            "schema_version": 1,
            "data_mode": "api",
            "meta": meta_payload,
            "defaults": self.defaults,
            "traj_ids": self.traj_ids,
            "api_base": api_base,
        }

    def inspect_raw_keys(self, keys: list[str]) -> dict[str, Any]:
        normalized_keys = [str(key) for key in keys]
        rows: list[dict[str, Any]] = []
        for traj_id in self.traj_ids:
            preview_map = self.raw_key_previews.get(str(traj_id), {})
            values: dict[str, str] = {}
            for key in normalized_keys:
                values[key] = str(preview_map.get(key, "MISSING"))
            rows.append(
                {
                    "traj_id": str(traj_id),
                    "values": values,
                }
            )

        return {
            "keys": normalized_keys,
            "rows": rows,
        }

    def build_raw_key_series(self, traj_id: str, raw_key: str) -> dict[str, Any]:
        tid = str(traj_id)
        key = str(raw_key)

        traj = self.get_trajectory(tid)
        if traj is None:
            raise KeyError(f"Trajectory not found: {tid}")

        raw_record = self.raw_records_by_traj.get(tid)
        if raw_record is None:
            raise KeyError(f"Raw record not found for trajectory: {tid}")
        if key not in raw_record:
            raise KeyError(f"Raw key not found for trajectory {tid}: {key}")

        frame_meta = self.raw_frame_meta_by_traj.get(tid)
        if frame_meta is None:
            raise ValueError(f"Trajectory {tid} has no valid frame metadata for raw-key plotting.")

        raw_value = raw_record[key]
        arr = np.asarray(raw_value)
        if arr.ndim == 0:
            raise ValueError(
                (
                    f"Raw key '{key}' is static (ndim=0) and cannot be plotted. "
                    "Only time-series keys are supported."
                )
            )
        if int(arr.shape[0]) != int(frame_meta.base_len):
            raise ValueError(
                (
                    f"Raw key '{key}' has first dimension {arr.shape[0]}, "
                    f"but expected base frame length {frame_meta.base_len}."
                )
            )

        valid_indices = np.asarray(frame_meta.valid_indices, dtype=int).reshape(-1)
        time_axis = np.asarray(traj.time, dtype=float).reshape(-1)
        if valid_indices.size != time_axis.size:
            raise ValueError(
                (
                    f"Raw key frame metadata mismatch for trajectory {tid}: "
                    f"valid_indices={valid_indices.size}, traj.time={time_axis.size}."
                )
            )

        if np.iscomplexobj(arr):
            try:
                arr_complex = arr.astype(np.complex128)
            except Exception as exc:  # noqa: BLE001
                raise ValueError(f"Raw key '{key}' is not convertible to complex128 values: {exc}") from exc

            split_values, component_labels = _split_complex_series(arr_complex)
            filtered = split_values[valid_indices]
            return {
                "series_kind": "matrix",
                "time": time_axis.astype(float).tolist(),
                "values": filtered.astype(float).tolist(),
                "n_points": int(filtered.shape[0]),
                "n_components": int(filtered.shape[1]),
                "component_labels": component_labels,
            }

        try:
            arr_float = arr.astype(float)
        except Exception as exc:  # noqa: BLE001
            raise ValueError(f"Raw key '{key}' is not convertible to real numeric values: {exc}") from exc

        if arr_float.ndim == 1:
            values = arr_float.reshape(-1)[valid_indices]
            return {
                "series_kind": "scalar",
                "time": time_axis.astype(float).tolist(),
                "value": values.astype(float).tolist(),
                "n_points": int(values.shape[0]),
            }

        matrix = arr_float.reshape(arr_float.shape[0], -1)
        if matrix.shape[1] <= 0:
            raise ValueError(f"Raw key '{key}' has zero components after reshape and cannot be plotted.")

        filtered = matrix[valid_indices]
        return {
            "series_kind": "matrix",
            "time": time_axis.astype(float).tolist(),
            "values": filtered.astype(float).tolist(),
            "n_points": int(filtered.shape[0]),
            "n_components": int(filtered.shape[1]),
        }

    def build_raw_key_expression_value(self, traj_id: str, raw_key: str) -> dict[str, Any]:
        tid = str(traj_id)
        key = str(raw_key)

        traj = self.get_trajectory(tid)
        if traj is None:
            raise KeyError(f"Trajectory not found: {tid}")

        raw_record = self.raw_records_by_traj.get(tid)
        if raw_record is None:
            raise KeyError(f"Raw record not found for trajectory: {tid}")
        if key not in raw_record:
            raise KeyError(f"Raw key not found for trajectory {tid}: {key}")

        raw_value = raw_record[key]
        arr = np.asarray(raw_value)
        is_complex = np.iscomplexobj(arr)
        if is_complex:
            try:
                arr_numeric = np.asarray(arr, dtype=np.complex128)
            except Exception as exc:  # noqa: BLE001
                raise ValueError(f"Raw key '{key}' is not convertible to complex128 values: {exc}") from exc
        else:
            try:
                arr_numeric = np.asarray(arr, dtype=float)
            except Exception as exc:  # noqa: BLE001
                raise ValueError(f"Raw key '{key}' is not convertible to real numeric values: {exc}") from exc

        if not key.startswith("_."):
            return {
                "data": arr_numeric,
                "has_time": False,
                "time": None,
            }

        if arr_numeric.ndim == 0:
            raise ValueError(
                (
                    f"Raw key '{key}' was expected to be time-dependent (prefix '_.') but is scalar (ndim=0). "
                    "This key cannot be used as a timed expression input."
                )
            )

        frame_meta = self.raw_frame_meta_by_traj.get(tid)
        if frame_meta is None:
            raise ValueError(f"Trajectory {tid} has no valid frame metadata for timed expression key '{key}'.")

        base_len = int(frame_meta.base_len)
        if int(arr_numeric.shape[0]) != base_len:
            raise ValueError(
                (
                    f"Raw key '{key}' has first dimension {arr_numeric.shape[0]}, "
                    f"but expected base frame length {base_len}."
                )
            )

        valid_indices = np.asarray(frame_meta.valid_indices, dtype=int).reshape(-1)
        if valid_indices.size > 0:
            if np.any((valid_indices < 0) | (valid_indices >= base_len)):
                raise ValueError(
                    (
                        f"Trajectory {tid} has out-of-range valid indices for timed key '{key}': "
                        f"base_len={base_len}, min={int(valid_indices.min())}, max={int(valid_indices.max())}."
                    )
                )

        # Build full-length time axis for expression semantics. Invalid frames stay visible as NaN.
        time_axis: np.ndarray
        raw_time_value = raw_record.get(self.time_key)
        if raw_time_value is not None:
            try:
                raw_time = np.asarray(flatten_time_array(raw_time_value), dtype=float).reshape(-1)
            except Exception as exc:  # noqa: BLE001
                raise ValueError(
                    f"Timed key '{key}' could not load raw time axis '{self.time_key}' for trajectory {tid}: {exc}"
                ) from exc
            if int(raw_time.shape[0]) < base_len:
                raise ValueError(
                    (
                        f"Raw time axis '{self.time_key}' for trajectory {tid} is shorter than base frame length: "
                        f"time_len={raw_time.shape[0]}, base_len={base_len}."
                    )
                )
            time_axis = np.asarray(raw_time[:base_len], dtype=float)
        else:
            # Fallback path should be rare; map filtered trajectory time back to full-length axis.
            time_axis = np.full((base_len,), np.nan, dtype=float)
            traj_time = np.asarray(traj.time, dtype=float).reshape(-1)
            if int(traj_time.shape[0]) != int(valid_indices.shape[0]):
                raise ValueError(
                    (
                        f"Trajectory {tid} has mismatched filtered time/valid index counts while building key '{key}': "
                        f"traj.time={traj_time.shape[0]}, valid_indices={valid_indices.shape[0]}."
                    )
                )
            if valid_indices.size > 0:
                time_axis[valid_indices] = traj_time

        fill_value: complex | float = (np.nan + 0j) if is_complex else np.nan
        full_dtype: type[np.complex128] | type[float] = np.complex128 if is_complex else float
        full = np.full(arr_numeric.shape, fill_value, dtype=full_dtype)
        if valid_indices.size > 0:
            full[valid_indices] = arr_numeric[valid_indices]

        return {
            "data": full,
            "has_time": True,
            "time": time_axis,
        }


_PREVIEW_TEXT_LIMIT = 200
_PREVIEW_ARRAY_ELEMS = 6
_PREVIEW_DICT_KEYS = 8


def _truncate_text(text: str, max_len: int = _PREVIEW_TEXT_LIMIT) -> str:
    if len(text) <= max_len:
        return text
    if max_len <= 3:
        return text[:max_len]
    return f"{text[: max_len - 3]}..."


def _format_scalar(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, (bool, int, float, np.bool_, np.integer, np.floating)):
        return str(value)
    if isinstance(value, (complex, np.complexfloating)):
        return str(complex(value))
    if isinstance(value, str):
        return _truncate_text(value)
    return ""


def _format_array_preview(value: Any) -> str:
    try:
        arr = np.asarray(value)
    except Exception as exc:  # noqa: BLE001
        return _truncate_text(f"unavailable-array-preview: {exc}")

    dtype_text = str(arr.dtype)
    shape_text = str(tuple(arr.shape))

    if arr.size <= 0:
        return f"dtype={dtype_text} shape={shape_text} preview=[]"

    flat = arr.reshape(-1)
    preview_values: list[str] = []
    limit = min(int(flat.size), _PREVIEW_ARRAY_ELEMS)
    is_complex = np.issubdtype(arr.dtype, np.complexfloating)
    for idx in range(limit):
        item = flat[idx]
        if is_complex:
            preview_values.append(str(complex(item)))
        elif np.issubdtype(arr.dtype, np.floating):
            preview_values.append(str(float(item)))
        elif np.issubdtype(arr.dtype, np.integer):
            preview_values.append(str(int(item)))
        elif np.issubdtype(arr.dtype, np.bool_):
            preview_values.append(str(bool(item)))
        else:
            preview_values.append(_truncate_text(str(item), 48))

    if int(flat.size) > limit:
        preview_values.append("...")
    preview_text = ", ".join(preview_values)
    return f"dtype={dtype_text} shape={shape_text} preview=[{preview_text}]"


def _format_dict_preview(value: dict[Any, Any]) -> str:
    keys = list(value.keys())
    preview = [_truncate_text(str(key), 40) for key in keys[:_PREVIEW_DICT_KEYS]]
    if len(keys) > _PREVIEW_DICT_KEYS:
        preview.append("...")
    return f"dict(keys=[{', '.join(preview)}])"


def _safe_preview(value: Any) -> str:
    scalar = _format_scalar(value)
    if scalar:
        return scalar

    if isinstance(value, dict):
        return _format_dict_preview(value)

    if isinstance(value, (list, tuple, np.ndarray)):
        return _format_array_preview(value)

    return _truncate_text(str(value))


def _split_complex_series(arr_complex: np.ndarray) -> tuple[np.ndarray, list[str]]:
    if arr_complex.ndim == 1:
        values = np.stack([arr_complex.real, arr_complex.imag], axis=1).astype(float)
        return values, ["re", "im"]

    flat = arr_complex.reshape(arr_complex.shape[0], -1)
    n_components = int(flat.shape[1])
    if n_components <= 0:
        raise ValueError("Complex series has zero components after reshape and cannot be plotted.")

    out = np.empty((flat.shape[0], n_components * 2), dtype=float)
    out[:, 0::2] = flat.real.astype(float)
    out[:, 1::2] = flat.imag.astype(float)

    labels: list[str] = []
    for component in range(n_components):
        labels.append(f"comp{component}.re")
        labels.append(f"comp{component}.im")
    return out, labels


def _build_raw_records_by_traj(master_dataset: Any, traj_ids: list[str]) -> dict[str, dict[str, Any]]:
    if not isinstance(master_dataset, dict):
        return {str(traj_id): {} for traj_id in traj_ids}

    raw_by_traj_id = {str(key): value for key, value in master_dataset.items()}
    out: dict[str, dict[str, Any]] = {}
    for traj_id in traj_ids:
        raw_record = raw_by_traj_id.get(str(traj_id))
        if not isinstance(raw_record, dict):
            out[str(traj_id)] = {}
            continue

        keyed_record: dict[str, Any] = {}
        for raw_key, raw_value in raw_record.items():
            key_text = str(raw_key)
            keyed_record[key_text] = raw_value
        out[str(traj_id)] = keyed_record

    return out


def _build_raw_key_previews(raw_records_by_traj: dict[str, dict[str, Any]]) -> dict[str, dict[str, str]]:
    out: dict[str, dict[str, str]] = {}
    for traj_id, raw_record in raw_records_by_traj.items():
        preview_map: dict[str, str] = {}
        for raw_key, raw_value in raw_record.items():
            preview_map[str(raw_key)] = _safe_preview(raw_value)
        out[str(traj_id)] = preview_map
    return out


def _build_raw_frame_meta(
    raw_record: dict[str, Any],
    *,
    time_key: str,
    coord_key: str,
    drop_zero_frames: bool,
) -> RawFrameMeta | None:
    if time_key not in raw_record or coord_key not in raw_record:
        return None

    try:
        raw_time = flatten_time_array(raw_record[time_key])
        raw_coords = reshape_coords(raw_record[coord_key])
    except Exception:  # noqa: BLE001
        return None

    base_len = int(min(len(raw_time), len(raw_coords)))
    if base_len <= 0:
        return None

    raw_coords = raw_coords[:base_len]
    if drop_zero_frames:
        valid_mask = ~np.all(np.isclose(raw_coords, 0.0, atol=1e-12), axis=(1, 2))
    else:
        valid_mask = np.ones(base_len, dtype=bool)

    if not np.any(valid_mask):
        return None

    valid_indices = np.flatnonzero(valid_mask).astype(int).tolist()
    return RawFrameMeta(base_len=base_len, valid_indices=valid_indices)


def _build_raw_frame_meta_by_traj(
    raw_records_by_traj: dict[str, dict[str, Any]],
    *,
    traj_ids: list[str],
    time_key: str,
    coord_key: str,
    drop_zero_frames: bool,
) -> dict[str, RawFrameMeta]:
    out: dict[str, RawFrameMeta] = {}
    for traj_id in traj_ids:
        raw_record = raw_records_by_traj.get(str(traj_id), {})
        if not isinstance(raw_record, dict):
            continue
        frame_meta = _build_raw_frame_meta(
            raw_record,
            time_key=time_key,
            coord_key=coord_key,
            drop_zero_frames=drop_zero_frames,
        )
        if frame_meta is None:
            continue
        out[str(traj_id)] = frame_meta
    return out


def _to_1d_float(raw: Any) -> np.ndarray:
    arr = np.asarray(raw, dtype=float)
    if arr.size == 0:
        return np.empty((0,), dtype=float)
    if arr.ndim == 0:
        return arr.reshape(1)
    return arr.reshape(-1)


def _to_1d_int(raw: Any) -> np.ndarray:
    arr = np.asarray(raw, dtype=int)
    if arr.size == 0:
        return np.empty((0,), dtype=int)
    if arr.ndim == 0:
        return arr.reshape(1)
    return arr.reshape(-1)


def _to_2d_float(raw: Any) -> np.ndarray:
    arr = np.asarray(raw, dtype=float)
    if arr.size == 0:
        return np.empty((0, 0), dtype=float)
    if arr.ndim == 1:
        return arr.reshape(-1, 1)
    return arr.reshape(arr.shape[0], -1)


def _to_4d_float(raw: Any) -> np.ndarray:
    arr = np.asarray(raw, dtype=float)
    if arr.size == 0:
        return np.empty((0, 0, 0, 0), dtype=float)
    if arr.ndim < 4:
        return np.empty((0, 0, 0, 0), dtype=float)
    return arr.reshape(arr.shape[0], -1, arr.shape[-2], arr.shape[-1])


def _to_coords(raw: Any, n_atoms: int) -> np.ndarray:
    arr = np.asarray(raw, dtype=float)
    if arr.size == 0:
        return np.empty((0, n_atoms, 3), dtype=float)
    return arr.reshape(arr.shape[0], n_atoms, 3)


def _build_trajectory(traj_id: str, record: dict[str, Any]) -> TrajectoryRecord:
    n_atoms = int(record.get("n_atoms", 0) or 0)
    atom_numbers = [int(v) for v in record.get("atom_numbers", [])]
    nac_components = _to_4d_float(record.get("nac_components", []))
    nac_component_count = int(record.get("nac_component_count", 0) or 0)
    if nac_component_count <= 0 and nac_components.size > 0:
        nac_component_count = int(nac_components.shape[1])
    nac_state_count = int(record.get("nac_state_count", 0) or 0)
    if nac_state_count <= 0 and nac_components.size > 0:
        nac_state_count = int(min(nac_components.shape[-2], nac_components.shape[-1]))
    de_nac_components = _to_4d_float(record.get("de_nac_components", []))
    de_nac_component_count = int(record.get("de_nac_component_count", 0) or 0)
    if de_nac_component_count <= 0 and de_nac_components.size > 0:
        de_nac_component_count = int(de_nac_components.shape[1])
    de_nac_state_count = int(record.get("de_nac_state_count", 0) or 0)
    if de_nac_state_count <= 0 and de_nac_components.size > 0:
        de_nac_state_count = int(min(de_nac_components.shape[-2], de_nac_components.shape[-1]))

    return TrajectoryRecord(
        traj_id=str(traj_id),
        n_atoms=n_atoms,
        atom_numbers=atom_numbers,
        time=_to_1d_float(record.get("time", [])),
        coords=_to_coords(record.get("coords", []), n_atoms),
        etot_time=_to_1d_float(record.get("etot_time", [])),
        etot=_to_1d_float(record.get("etot", [])),
        eig_time=_to_1d_float(record.get("eig_time", [])),
        eig=_to_2d_float(record.get("eig", [])),
        nac_time=_to_1d_float(record.get("nac_time", [])),
        nac_norm=_to_1d_float(record.get("nac_norm", [])),
        nac_components=nac_components,
        nac_state_count=nac_state_count,
        nac_component_count=nac_component_count,
        de_nac_time=_to_1d_float(record.get("de_nac_time", [])),
        de_nac_norm=_to_1d_float(record.get("de_nac_norm", [])),
        de_nac_components=de_nac_components,
        de_nac_state_count=de_nac_state_count,
        de_nac_component_count=de_nac_component_count,
        state_time=_to_1d_float(record.get("state_time", [])),
        state=_to_1d_int(record.get("state", [])),
        c_prob_time=_to_1d_float(record.get("c_prob_time", [])),
        c_prob=_to_2d_float(record.get("c_prob", [])),
    )


def load_dataset_store(options: DatasetLoadOptions) -> DatasetStore:
    if options.input_path is None:
        raise ValueError("input_path is required to load a dataset store.")

    input_path = Path(options.input_path)
    config_path = Path(options.config_path) if options.config_path is not None else None

    if not input_path.exists():
        raise FileNotFoundError(f"Input file not found: {input_path}")

    defaults = _load_defaults(config_path)

    with open(input_path, "rb") as f:
        master_dataset = restricted_pickle_load(f)

    prepared = prepare_dataset(
        master_dataset=master_dataset,
        time_key=options.time_key,
        coord_key=options.coord_key,
        etot_key=options.etot_key,
        eig_key=options.eig_key,
        nac_key=options.nac_key,
        drop_zero_frames=options.drop_zero_frames,
    )

    traj_ids = prepared.get("meta", {}).get("traj_ids", [])
    if not traj_ids:
        raise ValueError("No valid trajectories found after filtering")

    meta = dict(prepared["meta"])
    meta["source_pkl"] = str(input_path.resolve())
    meta["dataset_loaded"] = True

    trajectories_raw = prepared.get("trajectories", {})
    trajectories = {
        str(traj_id): _build_trajectory(str(traj_id), trajectories_raw.get(str(traj_id), {}))
        for traj_id in traj_ids
    }
    traj_ids_text = [str(traj_id) for traj_id in traj_ids]
    raw_records_by_traj = _build_raw_records_by_traj(master_dataset, traj_ids_text)
    raw_key_previews = _build_raw_key_previews(raw_records_by_traj)
    raw_frame_meta_by_traj = _build_raw_frame_meta_by_traj(
        raw_records_by_traj,
        traj_ids=traj_ids_text,
        time_key=options.time_key,
        coord_key=options.coord_key,
        drop_zero_frames=options.drop_zero_frames,
    )

    return DatasetStore(
        input_path=input_path,
        meta=meta,
        defaults=defaults,
        trajectories=trajectories,
        raw_key_previews=raw_key_previews,
        raw_records_by_traj=raw_records_by_traj,
        raw_frame_meta_by_traj=raw_frame_meta_by_traj,
        time_key=options.time_key,
    )


def _load_defaults(config_path: Path | None) -> dict[str, Any]:
    cfg = load_config(config_path)
    return {
        "panels": cfg["panels"],
        "plot": cfg["plot"],
        "nac": cfg["nac"],
        "ui": cfg["ui"],
    }


def build_empty_dataset_store(config_path: Path | None) -> DatasetStore:
    config_path_obj = Path(config_path) if config_path is not None else Path.cwd()
    defaults = _load_defaults(config_path)
    meta = {
        "traj_ids": [],
        "n_atoms": 0,
        "n_states": 0,
        "time_unit": "fs",
        "length_unit": "angstrom",
        "coord_unit": "angstrom",
        "etot_unit": "hartree",
        "etot_reference": "raw_frame0",
        "state_definition": "argmax(|c|^2)",
        "state_source_key": "_.0.record.c",
        "state_index_base": 0,
        "state_component_count": 0,
        "source_pkl": "",
        "dataset_loaded": False,
    }
    return DatasetStore(
        input_path=config_path_obj,
        meta=meta,
        defaults=defaults,
        trajectories={},
    )
