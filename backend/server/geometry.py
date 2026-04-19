"""Shared geometry measurement functions (bond, angle, dihedral).

All functions expect a coordinate array of shape (N, n_atoms, 3) and
atom indices. They return a 1-D array of length N with the measured
values (Angstrom for bonds, degrees for angles and dihedrals).
"""

from __future__ import annotations

import numpy as np


def compute_bond(coords: np.ndarray, i: int, j: int) -> np.ndarray:
    """Inter-atomic distance between atoms *i* and *j* for each frame."""
    vec = coords[:, i, :] - coords[:, j, :]
    return np.linalg.norm(vec, axis=1)


def compute_angle(coords: np.ndarray, i: int, j: int, k: int) -> np.ndarray:
    """Angle i-j-k (in degrees) for each frame, with *j* as the vertex."""
    v1 = coords[:, i, :] - coords[:, j, :]
    v2 = coords[:, k, :] - coords[:, j, :]

    n1 = np.linalg.norm(v1, axis=1)
    n2 = np.linalg.norm(v2, axis=1)
    n1[n1 == 0] = 1.0
    n2[n2 == 0] = 1.0

    cosang = np.sum(v1 * v2, axis=1) / (n1 * n2)
    cosang = np.clip(cosang, -1.0, 1.0)
    return np.degrees(np.arccos(cosang))


def compute_dihedral(coords: np.ndarray, i: int, j: int, k: int, l: int) -> np.ndarray:
    """Dihedral angle i-j-k-l (in degrees) for each frame.

    Returns values in (-180, 180].  For time-series use, callers should
    apply ``np.unwrap`` to make the curve continuous across the ±180°
    boundary.
    """
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

    return np.degrees(np.arctan2(y, x))
