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


class LoadDatasetRequest(BaseModel):
    path: str = Field(..., min_length=1)


class LoadDatasetResponse(BaseModel):
    status: str
    traj_count: int
    source_pkl: str
    cleared_series_cache_entries: int
    cleared_mol3d_cache_entries: int
    dataset_revision: int


class NormalModesParseTextRequest(BaseModel):
    filename: str = Field(..., min_length=1)
    content: str = Field(..., min_length=1)


class FileBrowserEntry(BaseModel):
    name: str
    relative_path: str
    kind: Literal["directory", "file"]
    loadable: bool = False


class FileBrowserResponse(BaseModel):
    root_label: str
    current_path: str
    parent_path: str | None = None
    entries: list[FileBrowserEntry]


class RawKeyAliasItem(BaseModel):
    alias: str = Field(..., min_length=1)
    raw_key: str = Field(..., min_length=1)


class RawKeyAliasUpsertRequest(BaseModel):
    alias: str = Field(..., min_length=1)
    raw_key: str = Field(..., min_length=1)


class RawKeyAliasListResponse(BaseModel):
    aliases: list[RawKeyAliasItem]


class BootstrapResponse(BaseModel):
    schema_version: int
    data_mode: str
    meta: dict[str, Any]
    defaults: dict[str, Any]
    traj_ids: list[str]
    api_base: str
    raw_key_aliases: list[RawKeyAliasItem] = Field(default_factory=list)


class InspectKeysRequest(BaseModel):
    keys: list[str] = Field(default_factory=list)


class InspectKeysRow(BaseModel):
    traj_id: str
    values: dict[str, str]


class InspectKeysResponse(BaseModel):
    keys: list[str]
    rows: list[InspectKeysRow]


class RawKeySeriesRequest(BaseModel):
    traj_id: str = Field(..., min_length=1)
    raw_key: str = Field(..., min_length=1)


class RawKeySeriesResponse(BaseModel):
    traj_id: str
    raw_key: str
    series_kind: Literal["scalar", "matrix"]
    time: list[float]
    value: list[float] | None = None
    values: list[list[float]] | None = None
    n_points: int
    n_components: int | None = None
    component_labels: list[str] | None = None
    cached: bool


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


EnsembleStatMode = Literal["mean_ci95_bootstrap", "median_iqr", "renorm_mean_ci95_bootstrap"]


class EnsembleSeriesRequest(BaseModel):
    observable: str = Field(..., min_length=1)
    indices: list[int] = Field(default_factory=list)
    raw_key: str | None = None
    stat_mode: EnsembleStatMode


class EnsembleComponentSeries(BaseModel):
    component: int
    label: str | None = None
    time: list[float]
    low: list[float]
    center: list[float]
    high: list[float]
    sample_count: list[int]


class EnsembleSeriesResponse(BaseModel):
    observable: str
    indices: list[int]
    raw_key: str | None = None
    stat_mode: EnsembleStatMode
    component_series: list[EnsembleComponentSeries]
    n_trajectories: int
    cached: bool


HoppingAlgorithm = Literal["max_abs_c"]
HoppingTimeRule = Literal["arrival_frame"]


class HoppingTransitionRequest(BaseModel):
    from_state: int
    to_state: int


class HoppingTransitionItem(BaseModel):
    transition_key: str
    from_state: int
    to_state: int


class HoppingEventItem(BaseModel):
    transition_key: str
    from_state: int
    to_state: int
    frame_from: int
    frame_to: int
    time: float


class HoppingTrajCountItem(BaseModel):
    traj_id: str
    transition_key: str
    from_state: int
    to_state: int
    count: int


class HoppingTransitionTotalItem(BaseModel):
    transition_key: str
    from_state: int
    to_state: int
    count: int


class HoppingEventsRequest(BaseModel):
    traj_ids: list[str] = Field(default_factory=list)
    algorithm: HoppingAlgorithm
    time_rule: HoppingTimeRule
    transitions: list[HoppingTransitionRequest] = Field(default_factory=list)


class HoppingEventsResponse(BaseModel):
    traj_ids: list[str]
    algorithm: HoppingAlgorithm
    time_rule: HoppingTimeRule
    transitions: list[HoppingTransitionItem]
    events_by_traj: dict[str, list[HoppingEventItem]]
    counts_by_traj: list[HoppingTrajCountItem]
    totals_by_transition: list[HoppingTransitionTotalItem]
    cached: bool


ExpressionScope = Literal["trajectory", "dataset"]


class ExpressionSeriesRequest(BaseModel):
    traj_id: str = Field(..., min_length=1)
    expression: str = Field(..., min_length=1)


class ExpressionSeriesResponse(BaseModel):
    traj_id: str
    expression: str
    scope: ExpressionScope
    series_kind: Literal["scalar", "matrix"]
    time: list[float]
    value: list[float | None] | None = None
    values: list[list[float | None]] | None = None
    n_points: int
    n_components: int | None = None
    n_trajectories: int
    sample_count: list[int] | None = None
    cached: bool


class ExpressionEnsembleRequest(BaseModel):
    expression: str = Field(..., min_length=1)
    stat_mode: EnsembleStatMode


class ExpressionEnsembleResponse(BaseModel):
    expression: str
    series_kind: Literal["scalar", "matrix"]
    n_components: int | None = None
    stat_mode: EnsembleStatMode
    component_series: list[EnsembleComponentSeries]
    n_trajectories: int
    cached: bool


class ExpressionDatasetRequest(BaseModel):
    expression: str = Field(..., min_length=1)


class ExpressionDatasetResponse(BaseModel):
    expression: str
    scope: Literal["dataset"]
    series_kind: Literal["scalar", "matrix"]
    time: list[float]
    value: list[float | None] | None = None
    values: list[list[float | None]] | None = None
    n_points: int
    n_components: int | None = None
    n_trajectories: int
    sample_count: list[int] | None = None
    cached: bool


class NormalModeSummary(BaseModel):
    mode_index: int
    frequency_cm1: float
    intensity: float | None = None
    kind: Literal["positive", "zero", "imaginary"]


class NormalModesParseTextResponse(BaseModel):
    source_name: str
    n_atoms: int
    atom_numbers: list[int]
    coords_ang: list[list[float]]
    mode_summaries: list[NormalModeSummary]
    mode_vectors_ang: list[list[list[float]]]
    default_mode_index: int


class MoleculeTrajectoryResponse(BaseModel):
    traj_id: str
    time: list[float]
    coords: list[list[list[float]]]
    n_atoms: int
    atom_numbers: list[int]
    n_frames: int
    nac_available: bool = False
    nac_state_count: int = 0
    nac_component_count: int = 0
    de_available: bool = False
    de_state_count: int = 0
    de_component_count: int = 0
    de_global_norm_scope: str = ""
    de_global_norm_p5: float | None = None
    de_global_norm_p90: float | None = None
    de_global_norm_p95: float | None = None
    de_global_norm_count: int = 0
    de_nac_available: bool = False
    de_nac_state_count: int = 0
    de_nac_component_count: int = 0
    cached: bool


class MoleculeNacResponse(BaseModel):
    traj_id: str
    state_i: int
    state_j: int
    n_states: int
    n_atoms: int
    n_frames: int
    time: list[float]
    vectors: list[list[list[float]]]
    cached: bool


class MoleculeDeResponse(BaseModel):
    traj_id: str
    state_i: int
    state_j: int
    n_states: int
    n_atoms: int
    n_frames: int
    time: list[float]
    vectors: list[list[list[float]]]
    cached: bool


class MoleculeDeNacResponse(BaseModel):
    traj_id: str
    state_i: int
    state_j: int
    n_states: int
    n_atoms: int
    n_frames: int
    time: list[float]
    vectors: list[list[list[float]]]
    cached: bool


class MoleculeHydrogenBondItem(BaseModel):
    frame: int
    donor_idx: int
    h_idx: int
    acceptor_idx: int
    distance: float
    angle: float


class MoleculeHydrogenBondResponse(BaseModel):
    traj_id: str
    n_frames: int
    n_atoms: int
    donor_acceptor_atomic_numbers: list[int]
    hbond_distance_cutoff: float
    hbond_angle_cutoff: float
    dh_bond_length: float
    hbonds: list[MoleculeHydrogenBondItem]
    cached: bool
