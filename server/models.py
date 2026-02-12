from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class HealthzResponse(BaseModel):
    status: str
    dataset_loaded: bool
    traj_count: int


class RefreshDatasetResponse(BaseModel):
    status: str
    traj_count: int
    source_pkl: str
    cleared_series_cache_entries: int
    cleared_mol3d_cache_entries: int
    dataset_revision: int


class BootstrapResponse(BaseModel):
    schema_version: int
    data_mode: str
    meta: dict[str, Any]
    defaults: dict[str, Any]
    traj_ids: list[str]
    api_base: str


class SeriesRequest(BaseModel):
    traj_id: str = Field(..., min_length=1)
    observable: str = Field(..., min_length=1)
    indices: list[int] = Field(default_factory=list)


class SeriesResponse(BaseModel):
    traj_id: str
    observable: str
    indices: list[int]
    series_kind: Literal["scalar", "matrix"]
    time: list[float]
    value: list[float] | None = None
    values: list[list[float]] | None = None
    n_points: int
    n_components: int | None = None
    cached: bool


class MoleculeTrajectoryResponse(BaseModel):
    traj_id: str
    time: list[float]
    coords: list[list[list[float]]]
    n_atoms: int
    atom_numbers: list[int]
    n_frames: int
    cached: bool
