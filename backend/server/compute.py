from __future__ import annotations

import hashlib
import math

import numpy as np

from backend.config import required_index_count

from .dataset_store import TrajectoryRecord
from .geometry import compute_angle, compute_bond, compute_dihedral

TIME_BUCKET_DECIMALS = 8
BOOTSTRAP_RESAMPLES = 1000
CI95_Z_VALUE = 1.96
RENORM_DENOM_EPSILON = 1e-12
RENORM_MEAN_CI95_BOOTSTRAP_MODE = "renorm_mean_ci95_bootstrap"


def _as_float_list(arr: np.ndarray) -> list[float]:
    if arr.size == 0:
        return []
    return arr.astype(float).tolist()


def _as_matrix_list(arr: np.ndarray) -> list[list[float]]:
    if arr.size == 0:
        return []
    if arr.ndim == 1:
        return arr.astype(float).reshape(-1, 1).tolist()
    return arr.astype(float).tolist()


def _compute_dihedral_unwrapped(coords: np.ndarray, i: int, j: int, k: int, l: int) -> np.ndarray:
    """Dihedral angle along a trajectory, unwrapped for continuity."""
    angles_deg = compute_dihedral(coords, i, j, k, l)
    return np.degrees(np.unwrap(np.radians(angles_deg)))


def _quantile_from_sorted(sorted_values: np.ndarray, q: float) -> float:
    n_values = int(sorted_values.shape[0])
    if n_values <= 0:
        return float("nan")
    if n_values == 1:
        return float(sorted_values[0])
    position = (n_values - 1) * float(q)
    lo = int(math.floor(position))
    hi = int(math.ceil(position))
    if lo == hi:
        return float(sorted_values[lo])
    weight = float(position - lo)
    return float(sorted_values[lo] * (1.0 - weight) + sorted_values[hi] * weight)


def bucket_scalar_series_by_time(
    series_list: list[dict[str, list[float]]],
    *,
    decimals: int = TIME_BUCKET_DECIMALS,
) -> list[dict[str, object]]:
    # Collect all (time, value) pairs across trajectories in one pass.
    all_time_chunks: list[np.ndarray] = []
    all_value_chunks: list[np.ndarray] = []
    for series in series_list:
        time = np.asarray(series.get("time", []), dtype=float).reshape(-1)
        values = np.asarray(series.get("value", []), dtype=float).reshape(-1)
        point_count = int(min(time.shape[0], values.shape[0]))
        if point_count <= 0:
            continue
        all_time_chunks.append(time[:point_count])
        all_value_chunks.append(values[:point_count])

    if not all_time_chunks:
        return []

    all_time = np.concatenate(all_time_chunks)
    all_values = np.concatenate(all_value_chunks)

    # Drop non-finite entries.
    finite_mask = np.isfinite(all_time) & np.isfinite(all_values)
    all_time = all_time[finite_mask]
    all_values = all_values[finite_mask]
    if all_time.size == 0:
        return []

    # Round time to create bucket keys, then group by unique rounded time.
    rounded_time = np.round(all_time, decimals=int(decimals))
    sort_order = np.argsort(rounded_time, kind="stable")
    rounded_sorted = rounded_time[sort_order]
    values_sorted = all_values[sort_order]

    # Find boundaries where the rounded time changes.
    change_mask = np.empty(rounded_sorted.shape[0], dtype=bool)
    change_mask[0] = True
    change_mask[1:] = rounded_sorted[1:] != rounded_sorted[:-1]
    split_indices = np.nonzero(change_mask)[0]

    unique_times = rounded_sorted[split_indices]
    value_groups = np.split(values_sorted, split_indices[1:])

    out: list[dict[str, object]] = []
    for t, vals in zip(unique_times, value_groups):
        if vals.size <= 0:
            continue
        out.append(
            {
                "time": float(t),
                "time_key": f"{float(t):.{int(decimals)}f}",
                "values": vals,
            }
        )
    return out



def bucket_matrix_series_by_time(
    series_list: list[dict[str, object]],
    *,
    n_components: int,
    decimals: int = TIME_BUCKET_DECIMALS,
) -> list[dict[str, object]]:
    n_comp = int(n_components)
    if n_comp <= 0:
        return []

    # Collect all (time, vector) pairs across trajectories.
    all_time_chunks: list[np.ndarray] = []
    all_vector_chunks: list[np.ndarray] = []
    for series in series_list:
        time = np.asarray(series.get("time", []), dtype=float).reshape(-1)
        values_raw = series.get("values", [])
        if isinstance(values_raw, np.ndarray):
            matrix = np.asarray(values_raw, dtype=float)
        elif isinstance(values_raw, list):
            matrix = np.asarray(values_raw, dtype=float)
        else:
            continue

        if matrix.ndim == 1:
            matrix = matrix.reshape(-1, 1)
        if matrix.ndim != 2 or matrix.shape[1] < n_comp:
            continue

        matrix = matrix[:, :n_comp]
        point_count = int(min(time.shape[0], matrix.shape[0]))
        if point_count <= 0:
            continue

        t_slice = time[:point_count]
        m_slice = matrix[:point_count]

        # Filter: time must be finite, all components must be finite.
        finite_mask = np.isfinite(t_slice) & np.all(np.isfinite(m_slice), axis=1)
        if not np.any(finite_mask):
            continue
        all_time_chunks.append(t_slice[finite_mask])
        all_vector_chunks.append(m_slice[finite_mask])

    if not all_time_chunks:
        return []

    all_time = np.concatenate(all_time_chunks)
    all_vectors = np.concatenate(all_vector_chunks, axis=0)

    if all_time.size == 0:
        return []

    # Round time to create bucket keys, then group by unique rounded time.
    rounded_time = np.round(all_time, decimals=int(decimals))
    sort_order = np.argsort(rounded_time, kind="stable")
    rounded_sorted = rounded_time[sort_order]
    vectors_sorted = all_vectors[sort_order]

    # Find boundaries where the rounded time changes.
    change_mask = np.empty(rounded_sorted.shape[0], dtype=bool)
    change_mask[0] = True
    change_mask[1:] = rounded_sorted[1:] != rounded_sorted[:-1]
    split_indices = np.nonzero(change_mask)[0]

    unique_times = rounded_sorted[split_indices]
    vector_groups = np.split(vectors_sorted, split_indices[1:], axis=0)

    out: list[dict[str, object]] = []
    for t, vecs in zip(unique_times, vector_groups):
        if vecs.shape[0] <= 0 or vecs.shape[1] != n_comp:
            continue
        out.append(
            {
                "time": float(t),
                "time_key": f"{float(t):.{int(decimals)}f}",
                "vectors": vecs,
            }
        )
    return out


def aggregate_median_iqr(
    buckets: list[dict[str, object]],
) -> dict[str, list[float] | list[int]]:
    out = {
        "time": [],
        "low": [],
        "center": [],
        "high": [],
        "sample_count": [],
    }
    for bucket in buckets:
        values = np.asarray(bucket.get("values", []), dtype=float).reshape(-1)
        if values.size <= 0:
            continue
        sorted_values = np.sort(values)
        out["time"].append(float(bucket["time"]))
        out["low"].append(_quantile_from_sorted(sorted_values, 0.25))
        out["center"].append(_quantile_from_sorted(sorted_values, 0.50))
        out["high"].append(_quantile_from_sorted(sorted_values, 0.75))
        out["sample_count"].append(int(sorted_values.shape[0]))
    return out


def _bootstrap_seed(
    *,
    context_key: str,
    component_index: int,
    time_key: str,
    sample_count: int,
    n_resamples: int,
) -> int:
    payload = (
        f"{context_key}|component={component_index}|time={time_key}|n={sample_count}|"
        f"bootstrap_resamples={n_resamples}"
    ).encode("utf-8")
    digest = hashlib.sha256(payload).digest()
    return int.from_bytes(digest[:8], byteorder="big", signed=False)


def bootstrap_mean_std(values: np.ndarray, n_resamples: int, seed: int) -> float:
    arr = np.asarray(values, dtype=float).reshape(-1)
    sample_count = int(arr.shape[0])
    if sample_count <= 1:
        return 0.0
    if int(n_resamples) <= 1:
        return 0.0

    rng = np.random.default_rng(np.uint64(seed))
    sample_indices = rng.integers(0, sample_count, size=(int(n_resamples), sample_count))
    sampled_values = arr[sample_indices]
    means = sampled_values.mean(axis=1)
    std_boot = float(np.std(means, ddof=1))
    if not np.isfinite(std_boot):
        return 0.0
    return max(0.0, std_boot)


def aggregate_mean_ci95_bootstrap(
    buckets: list[dict[str, object]],
    *,
    context_key: str,
    component_index: int,
    n_resamples: int = BOOTSTRAP_RESAMPLES,
) -> dict[str, list[float] | list[int]]:
    out = {
        "time": [],
        "low": [],
        "center": [],
        "high": [],
        "sample_count": [],
    }
    for bucket in buckets:
        values = np.asarray(bucket.get("values", []), dtype=float).reshape(-1)
        sample_count = int(values.shape[0])
        if sample_count <= 0:
            continue
        mean = float(np.mean(values))
        if sample_count <= 1:
            low = mean
            high = mean
        else:
            seed = _bootstrap_seed(
                context_key=context_key,
                component_index=int(component_index),
                time_key=str(bucket.get("time_key", "")),
                sample_count=sample_count,
                n_resamples=int(n_resamples),
            )
            std_boot = bootstrap_mean_std(values, int(n_resamples), seed)
            margin = float(CI95_Z_VALUE * std_boot)
            low = float(mean - margin)
            high = float(mean + margin)

        out["time"].append(float(bucket["time"]))
        out["low"].append(low)
        out["center"].append(mean)
        out["high"].append(high)
        out["sample_count"].append(sample_count)
    return out


def aggregate_matrix_renorm_mean_ci95_bootstrap(
    matrix_series_list: list[dict[str, object]],
    *,
    context_key: str,
    n_components: int,
    n_resamples: int = BOOTSTRAP_RESAMPLES,
    denom_epsilon: float = RENORM_DENOM_EPSILON,
) -> dict[str, list[float] | list[int] | list[list[float]]]:
    buckets = bucket_matrix_series_by_time(
        matrix_series_list,
        n_components=int(n_components),
        decimals=TIME_BUCKET_DECIMALS,
    )
    out = {
        "time": [],
        "low": [],
        "center": [],
        "high": [],
        "sample_count": [],
    }
    n_components_int = int(n_components)
    for bucket in buckets:
        vectors = np.asarray(bucket.get("vectors", []), dtype=float)
        if vectors.ndim != 2 or vectors.shape[1] != n_components_int:
            continue

        sample_count = int(vectors.shape[0])
        if sample_count <= 0:
            continue
        mean_vector = np.mean(vectors, axis=0)
        center = np.full((n_components_int,), np.nan, dtype=float)
        low = np.full((n_components_int,), np.nan, dtype=float)
        high = np.full((n_components_int,), np.nan, dtype=float)

        denom = float(np.sum(mean_vector))
        if np.isfinite(denom) and abs(denom) > float(denom_epsilon):
            center = mean_vector / denom

        if sample_count <= 1:
            low = center.copy()
            high = center.copy()
        elif int(n_resamples) > 1:
            seed = _bootstrap_seed(
                context_key=context_key,
                component_index=-1,
                time_key=str(bucket.get("time_key", "")),
                sample_count=sample_count,
                n_resamples=int(n_resamples),
            )
            rng = np.random.default_rng(np.uint64(seed))
            sample_indices = rng.integers(0, sample_count, size=(int(n_resamples), sample_count))
            sampled_values = vectors[sample_indices]  # [B, N, K]
            sampled_means = sampled_values.mean(axis=1)  # [B, K]
            sampled_denoms = np.sum(sampled_means, axis=1)  # [B]
            valid = (
                np.isfinite(sampled_denoms)
                & (np.abs(sampled_denoms) > float(denom_epsilon))
                & np.all(np.isfinite(sampled_means), axis=1)
            )
            if np.any(valid):
                ratios = sampled_means[valid] / sampled_denoms[valid, None]
                for component_idx in range(n_components_int):
                    values = np.asarray(ratios[:, component_idx], dtype=float).reshape(-1)
                    if values.size <= 0:
                        continue
                    sorted_values = np.sort(values)
                    low[component_idx] = _quantile_from_sorted(sorted_values, 0.025)
                    high[component_idx] = _quantile_from_sorted(sorted_values, 0.975)

        out["time"].append(float(bucket["time"]))
        out["low"].append(low.astype(float).tolist())
        out["center"].append(center.astype(float).tolist())
        out["high"].append(high.astype(float).tolist())
        out["sample_count"].append(sample_count)
    return out


def aggregate_scalar_series_by_mode(
    series_list: list[dict[str, list[float]]],
    *,
    stat_mode: str,
    context_key: str,
    component_index: int,
) -> dict[str, list[float] | list[int]]:
    buckets = bucket_scalar_series_by_time(series_list, decimals=TIME_BUCKET_DECIMALS)
    if stat_mode == "median_iqr":
        return aggregate_median_iqr(buckets)
    if stat_mode in {"mean_ci95_bootstrap", RENORM_MEAN_CI95_BOOTSTRAP_MODE}:
        return aggregate_mean_ci95_bootstrap(
            buckets,
            context_key=context_key,
            component_index=int(component_index),
            n_resamples=BOOTSTRAP_RESAMPLES,
        )
    raise ValueError(f"Unsupported ensemble stat mode: {stat_mode}")


# Observables whose indices refer to atoms (validated against n_atoms).
_ATOM_INDEX_OBSERVABLES = frozenset({"bond", "angle", "dihedral"})


def _validate_atom_indices(
    indices: list[int],
    observable: str,
    n_atoms: int,
) -> None:
    """Validate that indices has the correct length and all values are in [0, n_atoms).

    Only applies to observables whose indices are atom indices (bond, angle,
    dihedral).  Observables like de_nac use state indices and have their own
    validation inside compute_observable_series.
    """
    needed = required_index_count(observable)
    if needed > 0 and len(indices) < needed:
        raise ValueError(
            f"{observable} requires {needed} indices, got {len(indices)}"
        )
    if observable not in _ATOM_INDEX_OBSERVABLES:
        return
    for idx_pos, idx_val in enumerate(indices[:needed]):
        if idx_val < 0 or idx_val >= n_atoms:
            raise ValueError(
                f"{observable} index[{idx_pos}] out of range: "
                f"expected 0 <= index < {n_atoms}, got {idx_val}"
            )


def compute_observable_series(
    traj: TrajectoryRecord,
    observable: str,
    indices: list[int],
) -> dict[str, object]:
    _validate_atom_indices(indices, observable, traj.n_atoms)

    if observable == "bond":
        values = compute_bond(traj.coords, indices[0], indices[1])
        return {
            "series_kind": "scalar",
            "time": _as_float_list(traj.time),
            "value": _as_float_list(values),
            "n_points": int(values.shape[0]),
        }

    if observable == "angle":
        values = compute_angle(traj.coords, indices[0], indices[1], indices[2])
        return {
            "series_kind": "scalar",
            "time": _as_float_list(traj.time),
            "value": _as_float_list(values),
            "n_points": int(values.shape[0]),
        }

    if observable == "dihedral":
        values = _compute_dihedral_unwrapped(traj.coords, indices[0], indices[1], indices[2], indices[3])
        return {
            "series_kind": "scalar",
            "time": _as_float_list(traj.time),
            "value": _as_float_list(values),
            "n_points": int(values.shape[0]),
        }

    if observable == "etot":
        return {
            "series_kind": "scalar",
            "time": _as_float_list(traj.etot_time),
            "value": _as_float_list(traj.etot),
            "n_points": int(traj.etot.shape[0]),
        }

    if observable == "nac":
        return {
            "series_kind": "scalar",
            "time": _as_float_list(traj.nac_time),
            "value": _as_float_list(traj.nac_norm),
            "n_points": int(traj.nac_norm.shape[0]),
        }

    if observable == "de_nac":
        if len(indices) != 2:
            raise ValueError(f"de_nac requires two state indices, got {len(indices)}")
        if traj.de_nac_components.size == 0:
            return {
                "series_kind": "scalar",
                "time": [],
                "value": [],
                "n_points": 0,
            }

        si = int(indices[0])
        sj = int(indices[1])
        n_states = int(traj.de_nac_state_count)
        if n_states <= 0:
            raise ValueError("de_nac state count is invalid for this trajectory")
        if si == sj:
            raise ValueError("de_nac requires state_i != state_j")
        if si < 0 or si >= n_states:
            raise ValueError(f"de_nac state_i out of bounds: expected 0 <= i < {n_states}, got {si}")
        if sj < 0 or sj >= n_states:
            raise ValueError(f"de_nac state_j out of bounds: expected 0 <= j < {n_states}, got {sj}")

        pair_components = np.asarray(traj.de_nac_components[:, :, si, sj], dtype=float)
        if pair_components.ndim != 2:
            raise ValueError(f"de_nac pair array shape is invalid: expected 2D, got {pair_components.shape}")
        values = np.linalg.norm(pair_components, axis=1)
        time = np.asarray(traj.de_nac_time, dtype=float).reshape(-1)
        frame_count = int(min(values.shape[0], time.shape[0]))
        values = values[:frame_count]
        time = time[:frame_count]
        return {
            "series_kind": "scalar",
            "time": _as_float_list(time),
            "value": _as_float_list(values),
            "n_points": int(values.shape[0]),
        }

    if observable == "state":
        return {
            "series_kind": "scalar",
            "time": _as_float_list(traj.state_time),
            "value": _as_float_list(traj.state.astype(float)),
            "n_points": int(traj.state.shape[0]),
        }

    if observable == "eig":
        n_components = int(traj.eig.shape[1]) if traj.eig.ndim == 2 and traj.eig.size else 0
        return {
            "series_kind": "matrix",
            "time": _as_float_list(traj.eig_time),
            "values": _as_matrix_list(traj.eig),
            "n_points": int(traj.eig.shape[0]) if traj.eig.ndim >= 1 else 0,
            "n_components": n_components,
        }

    if observable == "|c|^2":
        n_components = int(traj.c_prob.shape[1]) if traj.c_prob.ndim == 2 and traj.c_prob.size else 0
        return {
            "series_kind": "matrix",
            "time": _as_float_list(traj.c_prob_time),
            "values": _as_matrix_list(traj.c_prob),
            "n_points": int(traj.c_prob.shape[0]) if traj.c_prob.ndim >= 1 else 0,
            "n_components": n_components,
        }

    raise ValueError(f"Unsupported observable: {observable}")
