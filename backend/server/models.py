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


NormalModeSampler = Literal["wigner_finite_t", "wigner_zero_t", "classical_finite_t", "frozen"]
NormalModeRuleSelectorType = Literal["freq_range", "mode_indices"]
NormalModeMeasurementKind = Literal["bond", "angle", "dihedral"]


class NormalModesSamplingRuleRequest(BaseModel):
    selector_type: NormalModeRuleSelectorType
    mode_indices: list[int] = Field(default_factory=list)
    freq_min_cm1: float | None = None
    freq_max_cm1: float | None = None
    position_sampler: NormalModeSampler | None = None
    momentum_sampler: NormalModeSampler | None = None


class NormalModesSampleTextRequest(BaseModel):
    filename: str = Field(..., min_length=1)
    content: str = Field(..., min_length=1)
    sample_count: int = Field(..., ge=1)
    preview_count: int = Field(..., ge=1)
    charge: int = 0
    multiplicity: int = Field(default=1, ge=1)
    position_default: NormalModeSampler
    momentum_default: NormalModeSampler
    temperature_k: float | None = None
    seed: int | None = Field(default=None, ge=0)
    freq_min_cm1: float | None = None
    freq_max_cm1: float | None = None
    rules: list[NormalModesSamplingRuleRequest] = Field(default_factory=list)


class FileBrowserEntry(BaseModel):
    name: str
    relative_path: str
    kind: Literal["directory", "file"]
    loadable: bool = False


class NormalModesMeasurementRequest(BaseModel):
    measurement_kind: NormalModeMeasurementKind
    atom_indices: list[int] = Field(default_factory=list)


class NormalModesGeometrySaveRequest(BaseModel):
    directory: str = Field(..., min_length=1)
    filename: str = Field(..., min_length=1)


class NormalModesGeometrySaveResponse(BaseModel):
    status: Literal["ok"]
    saved_relative_path: str
    saved_absolute_path: str


DistributionMeasurementKind = Literal["bond", "angle", "dihedral"]


class FileBrowserResponse(BaseModel):
    root_label: str
    current_path: str
    parent_path: str | None = None
    entries: list[FileBrowserEntry]


class DistributionListItem(BaseModel):
    distribution_id: str
    label: str
    source_name: str
    created_at_utc: str
    n_samples: int
    n_atoms: int
    topology_signature: str
    available_channels: list[str] = Field(default_factory=list)
    has_electronics: bool = False
    default_electronic_profile_id: str | None = None
    electronic_profiles: list["DistributionElectronicProfileItem"] = Field(default_factory=list)


class DistributionElectronicProfileItem(BaseModel):
    profile_id: str
    label: str
    engine: str
    method: str
    reference: str
    xc: str
    basis: str
    n_excited_states: int
    n_states: int
    n_transition: int
    success_count: int = 0
    failed_count: int = 0


class DistributionListResponse(BaseModel):
    distributions: list[DistributionListItem]


class DistributionDeleteResponse(BaseModel):
    status: str
    distribution_id: str


class LoadDistributionPathRequest(BaseModel):
    path: str = Field(..., min_length=1)


class DistributionCompareGeometryRequest(BaseModel):
    distribution_ids: list[str] = Field(default_factory=list)
    measurement_kind: DistributionMeasurementKind
    atom_indices: list[int] = Field(default_factory=list)
    bins: int = Field(default=60, ge=5, le=400)


class DistributionGeometrySeries(BaseModel):
    distribution_id: str
    label: str
    source_name: str
    values: list[float]
    sample_count: int
    min: float
    max: float
    mean: float
    std: float


class DistributionCompareGeometryResponse(BaseModel):
    measurement_kind: DistributionMeasurementKind
    atom_indices: list[int]
    unit: str
    bins: int
    topology_signature: str
    series: list[DistributionGeometrySeries]


class DistributionSelectionRequestItem(BaseModel):
    distribution_id: str = Field(..., min_length=1)
    profile_id: str = Field(..., min_length=1)


class DistributionValueSummary(BaseModel):
    count: int = 0
    min: float | None = None
    max: float | None = None
    mean: float | None = None
    std: float | None = None
    p05: float | None = None
    p50: float | None = None
    p95: float | None = None


class DistributionWindowGeometrySeries(BaseModel):
    distribution_id: str
    profile_id: str
    label: str
    profile_label: str
    source_name: str
    all_values: list[float] = Field(default_factory=list)
    selected_values: list[float] = Field(default_factory=list)
    selected_count: int = 0
    selected_fraction: float = 0.0
    effective_sample_size: float = 0.0
    mean_selection_weight: float = 0.0
    max_selection_weight: float = 0.0
    all_summary: DistributionValueSummary
    selected_summary: DistributionValueSummary


class DistributionCompareGeometryWindowRequest(BaseModel):
    items: list[DistributionSelectionRequestItem] = Field(default_factory=list)
    measurement_kind: DistributionMeasurementKind
    atom_indices: list[int] = Field(default_factory=list)
    bins: int = Field(default=60, ge=5, le=400)
    window_center_ev: float
    window_width_ev: float = Field(..., gt=0.0)


class DistributionCompareGeometryWindowResponse(BaseModel):
    measurement_kind: DistributionMeasurementKind
    atom_indices: list[int]
    unit: str
    bins: int
    topology_signature: str
    window_center_ev: float
    window_width_ev: float
    window_min_ev: float
    window_max_ev: float
    selection_mode: str
    series: list[DistributionWindowGeometrySeries]


class DistributionSpectrumPairOption(BaseModel):
    pair: list[int] = Field(default_factory=list)
    label: str


class DistributionSpectrumSeriesRequestItem(BaseModel):
    distribution_id: str = Field(..., min_length=1)
    profile_id: str = Field(..., min_length=1)


class DistributionCompareSpectrumRequest(BaseModel):
    series: list[DistributionSpectrumSeriesRequestItem] = Field(default_factory=list)
    delta_ev: float = Field(default=0.05, gt=0.0, le=1.0)


class DistributionSpectrumPairCurve(BaseModel):
    pair: list[int] = Field(default_factory=list)
    y_normalized: list[float]


class DistributionSpectrumSeries(BaseModel):
    distribution_id: str
    distribution_label: str
    source_name: str
    profile_id: str
    profile_label: str
    series_label: str
    total_y_normalized: list[float]
    pair_curves: list[DistributionSpectrumPairCurve] = Field(default_factory=list)


class DistributionSpectrumSkippedItem(BaseModel):
    distribution_id: str
    distribution_label: str
    profile_id: str | None = None
    profile_label: str | None = None
    reason: str


class DistributionCompareSpectrumResponse(BaseModel):
    delta_ev: float
    x_energy_ev: list[float]
    available_pairs: list[DistributionSpectrumPairOption] = Field(default_factory=list)
    series: list[DistributionSpectrumSeries]
    skipped: list[DistributionSpectrumSkippedItem] = Field(default_factory=list)


class DistributionSoapUmapWindowRequest(BaseModel):
    items: list[DistributionSelectionRequestItem] = Field(default_factory=list)
    window_center_ev: float
    window_width_ev: float = Field(..., gt=0.0)
    soap_atom_indices: list[int] = Field(default_factory=list)
    soap_r_cut: float = Field(default=5.0, gt=0.0)
    soap_n_max: int = Field(default=6, ge=1)
    soap_l_max: int = Field(default=4, ge=0)
    soap_sigma: float = Field(default=0.3, gt=0.0)
    umap_n_neighbors: int = Field(default=50, ge=2)
    umap_min_dist: float = Field(default=0.1, ge=0.0)
    umap_metric: str = Field(default="euclidean", min_length=1)
    umap_random_state: int = Field(default=42, ge=0)


class DistributionSoapUmapRequest(BaseModel):
    distribution_ids: list[str] = Field(default_factory=list)
    soap_atom_indices: list[int] = Field(default_factory=list)
    soap_r_cut: float = Field(default=5.0, gt=0.0)
    soap_n_max: int = Field(default=6, ge=1)
    soap_l_max: int = Field(default=4, ge=0)
    soap_sigma: float = Field(default=0.3, gt=0.0)
    umap_n_neighbors: int = Field(default=50, ge=2)
    umap_min_dist: float = Field(default=0.1, ge=0.0)
    umap_metric: str = Field(default="euclidean", min_length=1)
    umap_random_state: int = Field(default=42, ge=0)


class DistributionSoapUmapPoint(BaseModel):
    distribution_id: str
    distribution_label: str
    profile_id: str
    profile_label: str
    sample_index: int
    sample_id: str
    x: float
    y: float
    selection_weight: float = 0.0
    normalized_selection_weight: float = 0.0
    hard_selected: bool = False


class DistributionSoapUmapProjectionMeta(BaseModel):
    method: str
    feature_kind: str
    axis_labels: list[str] = Field(default_factory=list)
    feature_dimension: int
    soap_atom_indices: list[int] = Field(default_factory=list)
    soap_r_cut: float
    soap_n_max: int
    soap_l_max: int
    soap_sigma: float
    umap_n_neighbors: int
    umap_min_dist: float
    umap_metric: str
    umap_random_state: int


class DistributionSoapUmapSelectionMeta(BaseModel):
    window_center_ev: float | None = None
    window_width_ev: float | None = None
    window_min_ev: float | None = None
    window_max_ev: float | None = None
    selection_mode: str
    topology_signature: str | None = None


class DistributionSoapUmapDistributionSummary(BaseModel):
    distribution_id: str
    distribution_label: str
    profile_id: str
    profile_label: str
    total_count: int
    selected_count: int = 0
    selected_fraction: float = 0.0
    effective_sample_size: float = 0.0
    dropped_count: int = 0


class DistributionSoapUmapWindowResponse(BaseModel):
    points: list[DistributionSoapUmapPoint] = Field(default_factory=list)
    projection_meta: DistributionSoapUmapProjectionMeta
    selection_meta: DistributionSoapUmapSelectionMeta
    distributions: list[DistributionSoapUmapDistributionSummary] = Field(default_factory=list)


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


class NormalModesSamplingModePlanItem(BaseModel):
    mode_index: int
    frequency_cm1: float
    kind: Literal["positive", "zero", "imaginary"]
    included: bool
    position_sampler: NormalModeSampler
    momentum_sampler: NormalModeSampler
    reason: str


class NormalModesSampleTextResponse(BaseModel):
    batch_id: str
    source_name: str
    n_atoms: int
    atom_numbers: list[int]
    charge: int
    multiplicity: int
    equilibrium_coords_ang: list[list[float]]
    preview_coords_ang: list[list[list[float]]]
    preview_indices: list[int]
    sample_count: int
    preview_count: int
    seed: int
    sampling_completed_at_utc: str
    mode_sampling_plan: list[NormalModesSamplingModePlanItem]


class NormalModesMeasurementResponse(BaseModel):
    batch_id: str
    measurement_kind: NormalModeMeasurementKind
    atom_indices: list[int]
    unit: str
    values: list[float]
    sample_count: int
    min: float
    max: float
    mean: float
    std: float


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
