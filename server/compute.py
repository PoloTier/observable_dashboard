from __future__ import annotations

import numpy as np

from .dataset_store import TrajectoryRecord


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
