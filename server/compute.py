from __future__ import annotations

import hashlib
import math

import numpy as np

from .dataset_store import TrajectoryRecord

TIME_BUCKET_DECIMALS = 8
BOOTSTRAP_RESAMPLES = 1000
CI95_Z_VALUE = 1.96


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


def _compute_bond(coords: np.ndarray, i: int, j: int) -> np.ndarray:
    vec = coords[:, i, :] - coords[:, j, :]
    return np.linalg.norm(vec, axis=1)


def _compute_angle(coords: np.ndarray, i: int, j: int, k: int) -> np.ndarray:
    v1 = coords[:, i, :] - coords[:, j, :]
    v2 = coords[:, k, :] - coords[:, j, :]

    n1 = np.linalg.norm(v1, axis=1)
    n2 = np.linalg.norm(v2, axis=1)
    n1[n1 == 0] = 1.0
    n2[n2 == 0] = 1.0

    cosang = np.sum(v1 * v2, axis=1) / (n1 * n2)
    cosang = np.clip(cosang, -1.0, 1.0)
    return np.degrees(np.arccos(cosang))


def _compute_dihedral(coords: np.ndarray, i: int, j: int, k: int, l: int) -> np.ndarray:
    p1 = coords[:, i, :]
    p2 = coords[:, j, :]
    p3 = coords[:, k, :]
    p4 = coords[:, l, :]

    b1 = p2 - p1
    b2 = p3 - p2
    b3 = p4 - p3

    n1 = np.cross(b1, b2)
    n2 = np.cross(b2, b3)

    b2_norm = np.linalg.norm(b2, axis=1, keepdims=True)
    b2_norm[b2_norm == 0] = 1.0
    b2u = b2 / b2_norm

    m1 = np.cross(n1, b2u)
    x = np.sum(n1 * n2, axis=1)
    y = np.sum(m1 * n2, axis=1)

    angles_deg = np.degrees(np.arctan2(y, x))
    # Keep continuous with previous frontend behavior.
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
    time_buckets: dict[str, dict[str, object]] = {}
    for series in series_list:
        time = np.asarray(series.get("time", []), dtype=float).reshape(-1)
        values = np.asarray(series.get("value", []), dtype=float).reshape(-1)
        point_count = int(min(time.shape[0], values.shape[0]))
        if point_count <= 0:
            continue
        for idx in range(point_count):
            t = float(time[idx])
            y = float(values[idx])
            if not np.isfinite(t) or not np.isfinite(y):
                continue
            time_key = f"{t:.{int(decimals)}f}"
            bucket = time_buckets.get(time_key)
            if bucket is None:
                bucket = {
                    "time": float(time_key),
                    "time_key": time_key,
                    "values": [],
                }
                time_buckets[time_key] = bucket
            bucket_values = bucket["values"]
            if isinstance(bucket_values, list):
                bucket_values.append(y)

    ordered = sorted(time_buckets.values(), key=lambda item: float(item["time"]))
    out: list[dict[str, object]] = []
    for item in ordered:
        values = np.asarray(item.get("values", []), dtype=float).reshape(-1)
        if values.size <= 0:
            continue
        out.append(
            {
                "time": float(item["time"]),
                "time_key": str(item["time_key"]),
                "values": values,
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
    if stat_mode == "mean_ci95_bootstrap":
        return aggregate_mean_ci95_bootstrap(
            buckets,
            context_key=context_key,
            component_index=int(component_index),
            n_resamples=BOOTSTRAP_RESAMPLES,
        )
    raise ValueError(f"Unsupported ensemble stat mode: {stat_mode}")


def compute_observable_series(
    traj: TrajectoryRecord,
    observable: str,
    indices: list[int],
) -> dict[str, object]:
    if observable == "bond":
        values = _compute_bond(traj.coords, indices[0], indices[1])
        return {
            "series_kind": "scalar",
            "time": _as_float_list(traj.time),
            "value": _as_float_list(values),
            "n_points": int(values.shape[0]),
        }

    if observable == "angle":
        values = _compute_angle(traj.coords, indices[0], indices[1], indices[2])
        return {
            "series_kind": "scalar",
            "time": _as_float_list(traj.time),
            "value": _as_float_list(values),
            "n_points": int(values.shape[0]),
        }

    if observable == "dihedral":
        values = _compute_dihedral(traj.coords, indices[0], indices[1], indices[2], indices[3])
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
