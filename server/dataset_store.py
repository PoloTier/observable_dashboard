from __future__ import annotations

import pickle
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from ..config import load_config
from ..dataset import flatten_time_array, prepare_dataset, reshape_coords


@dataclass(slots=True)
class DatasetLoadOptions:
    input_path: Path
    config_path: Path
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
    ) -> None:
        self.input_path = Path(input_path)
        self.meta = meta
        self.defaults = defaults
        self.trajectories = trajectories
        self.raw_key_previews = raw_key_previews or {}
        self.raw_records_by_traj = raw_records_by_traj or {}
        self.raw_frame_meta_by_traj = raw_frame_meta_by_traj or {}
        self.traj_ids = sorted(
            trajectories.keys(),
            key=lambda x: int(x) if str(x).isdigit() else str(x),
        )

    def get_trajectory(self, traj_id: str) -> TrajectoryRecord | None:
        return self.trajectories.get(str(traj_id))

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

    def to_bootstrap(self, api_base: str = "/api") -> dict[str, Any]:
        return {
            "schema_version": 1,
            "data_mode": "api",
            "meta": self.meta,
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
    input_path = Path(options.input_path)
    config_path = Path(options.config_path)

    if not input_path.exists():
        raise FileNotFoundError(f"Input file not found: {input_path}")

    cfg = load_config(config_path)

    with open(input_path, "rb") as f:
        master_dataset = pickle.load(f)

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

    defaults = {
        "panels": cfg["panels"],
        "plot": cfg["plot"],
        "nac": cfg["nac"],
        "ui": cfg["ui"],
    }

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
    )
