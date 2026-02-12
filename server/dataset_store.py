from __future__ import annotations

import pickle
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from ..config import load_config
from ..dataset import prepare_dataset


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
    state_time: np.ndarray
    state: np.ndarray
    c_prob_time: np.ndarray
    c_prob: np.ndarray


class DatasetStore:
    def __init__(
        self,
        *,
        input_path: Path,
        meta: dict[str, Any],
        defaults: dict[str, Any],
        trajectories: dict[str, TrajectoryRecord],
    ) -> None:
        self.input_path = Path(input_path)
        self.meta = meta
        self.defaults = defaults
        self.trajectories = trajectories
        self.traj_ids = sorted(
            trajectories.keys(),
            key=lambda x: int(x) if str(x).isdigit() else str(x),
        )

    def get_trajectory(self, traj_id: str) -> TrajectoryRecord | None:
        return self.trajectories.get(str(traj_id))

    def build_mol3d_payload(self, traj_id: str) -> dict[str, Any] | None:
        traj = self.get_trajectory(traj_id)
        if traj is None:
            return None
        return {
            "traj_id": str(traj.traj_id),
            "time": traj.time.astype(float).tolist(),
            "coords": traj.coords.astype(float).tolist(),
            "n_atoms": int(traj.n_atoms),
            "atom_numbers": [int(v) for v in traj.atom_numbers],
            "n_frames": int(traj.coords.shape[0]) if traj.coords.ndim >= 1 else 0,
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


def _to_coords(raw: Any, n_atoms: int) -> np.ndarray:
    arr = np.asarray(raw, dtype=float)
    if arr.size == 0:
        return np.empty((0, n_atoms, 3), dtype=float)
    return arr.reshape(arr.shape[0], n_atoms, 3)


def _build_trajectory(traj_id: str, record: dict[str, Any]) -> TrajectoryRecord:
    n_atoms = int(record.get("n_atoms", 0) or 0)
    atom_numbers = [int(v) for v in record.get("atom_numbers", [])]

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

    return DatasetStore(
        input_path=input_path,
        meta=meta,
        defaults=defaults,
        trajectories=trajectories,
    )
