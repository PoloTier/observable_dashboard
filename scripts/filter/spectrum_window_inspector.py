from __future__ import annotations

from dataclasses import dataclass
import importlib
import inspect
from pathlib import Path
from typing import Any, Sequence

import numpy as np
from sklearn.manifold import Isomap, TSNE

from backend.server.distribution_bundle import (
    DistributionBundle,
    ElectronicProfile,
    HARTREE_TO_EV,
    build_topology_signature,
    collect_absorption_excitation_energies_ev,
    load_distribution_bundle_from_directory,
)
from backend.server.molden import BOHR_TO_ANG


@dataclass(slots=True)
class SpectrumWindowInspection:
    window_min_ev: float
    window_max_ev: float
    delta_ev: float
    selection_mode: str
    selection_score_label: str
    state_filter: list[int] | None
    x_energy_ev: np.ndarray
    total_curve: np.ndarray
    total_curve_normalized: np.ndarray
    excitation_energy_ev: np.ndarray
    transition_intensity: np.ndarray
    transition_pairs: np.ndarray
    valid_transition_mask: np.ndarray
    hard_candidate_mask: np.ndarray
    hard_sample_mask: np.ndarray
    transition_window_weights: np.ndarray
    sample_window_weights: np.ndarray
    normalized_sample_window_weights: np.ndarray
    effective_sample_size: float


@dataclass(slots=True)
class StructureFeatureSet:
    feature_matrix: np.ndarray
    feature_labels: list[str]
    feature_kind: str
    atom_pairs: list[tuple[int, int]] | None


@dataclass(slots=True)
class AtomwiseSoapFeatureSet:
    feature_tensor: np.ndarray
    feature_labels: list[str]
    feature_kind: str
    atom_indices: list[int]


@dataclass(slots=True)
class StructureProjection:
    feature_matrix: np.ndarray
    feature_labels: list[str]
    feature_kind: str
    atom_pairs: list[tuple[int, int]] | None
    coords_2d: np.ndarray
    method: str
    axis_labels: tuple[str, str]
    explained_variance_ratio: np.ndarray | None
    source_feature_shape: tuple[int, ...] | None = None
    atom_indices: list[int] | None = None


@dataclass(slots=True)
class DescriptorShift:
    label: str
    values: np.ndarray
    atom_pair: tuple[int, int] | None
    overall_mean: float
    overall_std: float
    weighted_mean: float
    effect_size: float


def build_demo_bundle(*, sample_count: int = 240) -> tuple[DistributionBundle, str]:
    rng = np.random.default_rng(7)
    n_samples = int(sample_count)
    atom_numbers = np.asarray([6, 6, 1, 1], dtype=int)
    atom_masses_amu = np.asarray([12.011, 12.011, 1.008, 1.008], dtype=float)

    base_coords_ang = np.asarray(
        [
            [-1.40, 0.00, 0.00],
            [-0.20, 0.00, 0.00],
            [0.90, 0.35, 0.00],
            [1.55, -0.25, 0.20],
        ],
        dtype=float,
    )
    mode_open_ang = np.asarray(
        [
            [-0.20, 0.10, 0.00],
            [0.00, -0.08, 0.00],
            [0.15, 0.25, 0.10],
            [0.35, 0.45, -0.20],
        ],
        dtype=float,
    )
    mode_twist_ang = np.asarray(
        [
            [0.00, -0.05, 0.12],
            [0.05, 0.04, -0.10],
            [-0.08, 0.18, 0.28],
            [0.10, -0.30, -0.35],
        ],
        dtype=float,
    )

    latent_open = np.concatenate(
        [
            rng.normal(loc=-1.05, scale=0.32, size=n_samples // 2),
            rng.normal(loc=0.95, scale=0.34, size=n_samples - (n_samples // 2)),
        ]
    )
    latent_twist = rng.normal(loc=0.0, scale=0.65, size=n_samples)
    rng.shuffle(latent_open)

    coords_ang = (
        base_coords_ang[None, :, :]
        + latent_open[:, None, None] * mode_open_ang[None, :, :]
        + latent_twist[:, None, None] * mode_twist_ang[None, :, :]
        + rng.normal(scale=0.015, size=(n_samples, 4, 3))
    )
    coords_bohr = np.asarray(coords_ang / float(BOHR_TO_ANG), dtype=float)

    excitation_state_1 = (
        2.05
        + 0.38 * latent_open
        - 0.10 * latent_twist
        + rng.normal(scale=0.035, size=n_samples)
    )
    excitation_state_2 = (
        3.10
        - 0.22 * latent_open
        + 0.28 * latent_twist
        + rng.normal(scale=0.045, size=n_samples)
    )

    transition_pairs = np.asarray([[0, 1], [0, 2]], dtype=int)
    transition_intensity = np.column_stack(
        [
            0.10 + 0.95 / (1.0 + np.exp(-(2.3 * latent_open - 0.4 * latent_twist))),
            0.08 + 0.90 / (1.0 + np.exp(-(-1.4 * latent_open + 1.7 * latent_twist))),
        ]
    )
    transition_intensity = np.asarray(np.clip(transition_intensity, 0.0, None), dtype=float)

    ground_state_energy = -75.0 + 0.01 * rng.normal(size=n_samples)
    state_energy_hartree = np.column_stack(
        [
            ground_state_energy,
            ground_state_energy + (excitation_state_1 / float(HARTREE_TO_EV)),
            ground_state_energy + (excitation_state_2 / float(HARTREE_TO_EV)),
        ]
    )
    transition_dipole_au = np.zeros((n_samples, 2, 3), dtype=float)
    transition_dipole_au[:, 0, 0] = np.sqrt(np.maximum(transition_intensity[:, 0], 0.0))
    transition_dipole_au[:, 1, 1] = np.sqrt(np.maximum(transition_intensity[:, 1], 0.0))

    sample_ids = [f"demo_sample_{index:06d}" for index in range(n_samples)]
    topology_signature = build_topology_signature(atom_numbers)
    profile_id = "demo_td"
    profile = ElectronicProfile(
        profile_id=profile_id,
        label="Synthetic TDDFT Demo",
        engine="synthetic",
        method="demo",
        reference="synthetic",
        xc="demo",
        basis="demo",
        n_excited_states=2,
        state_energy_hartree=np.asarray(state_energy_hartree, dtype=float),
        transition_pairs=np.asarray(transition_pairs, dtype=int),
        transition_dipole_au=np.asarray(transition_dipole_au, dtype=float),
        transition_intensity=np.asarray(transition_intensity, dtype=float),
        success_count=n_samples,
        failed_count=0,
        failed_samples=[],
        manifest={},
    )
    bundle = DistributionBundle(
        label="Synthetic Spectrum Window Demo",
        source_name="synthetic_demo",
        created_at_utc="2026-03-20T00:00:00.000Z",
        atom_numbers=np.asarray(atom_numbers, dtype=int),
        atom_masses_amu=np.asarray(atom_masses_amu, dtype=float),
        coords_bohr=np.asarray(coords_bohr, dtype=float),
        topology_signature=topology_signature,
        manifest={"kind": "synthetic_demo"},
        sample_ids=sample_ids,
        electronic_profiles={profile_id: profile},
        default_profile_id=profile_id,
        velocities_bohr_per_au_time=None,
    )
    return bundle, profile_id


def load_bundle_or_demo(
    *,
    bundle_dir: str | Path | None = None,
    use_demo: bool = False,
    demo_sample_count: int = 240,
) -> tuple[DistributionBundle, str]:
    if use_demo:
        return build_demo_bundle(sample_count=int(demo_sample_count))
    if bundle_dir is None or not str(bundle_dir).strip():
        raise ValueError("bundle_dir must be provided unless use_demo=True.")
    bundle = load_distribution_bundle_from_directory(Path(bundle_dir).expanduser().resolve())
    if not bundle.electronic_profiles:
        raise ValueError("The selected bundle does not contain electronic profiles.")
    profile_id = bundle.default_electronic_profile_id or sorted(bundle.electronic_profiles.keys())[0]
    return bundle, str(profile_id)


def resolve_profile(bundle: DistributionBundle, profile_id: str | None = None) -> ElectronicProfile:
    if not bundle.electronic_profiles:
        raise ValueError("Distribution bundle does not contain electronic profiles.")
    if profile_id is None or not str(profile_id).strip():
        profile = bundle.default_electronic_profile
        if profile is not None:
            return profile
        return bundle.electronic_profiles[sorted(bundle.electronic_profiles.keys())[0]]
    normalized_profile_id = str(profile_id).strip()
    profile = bundle.electronic_profiles.get(normalized_profile_id)
    if profile is None:
        available = ", ".join(sorted(bundle.electronic_profiles.keys()))
        raise ValueError(
            f"Electronic profile {normalized_profile_id!r} was not found. Available profiles: {available}."
        )
    return profile


def normalize_state_filter(
    profile: ElectronicProfile,
    states: Sequence[int | str] | None,
) -> list[int] | None:
    if states is None:
        return None
    normalized: list[int] = []
    seen: set[int] = set()
    for raw_value in states:
        value = int(raw_value)
        if value in seen:
            continue
        seen.add(value)
        normalized.append(value)
    available_states = sorted({int(pair[1]) for pair in np.asarray(profile.transition_pairs, dtype=int).tolist()})
    missing_states = [state for state in normalized if state not in set(available_states)]
    if missing_states:
        raise ValueError(
            f"Requested states {missing_states} are not present in profile {profile.profile_id!r}. "
            f"Available recorded states: {available_states}."
        )
    return normalized


def build_absorption_energy_grid_for_profile(
    profile: ElectronicProfile,
    *,
    delta_ev: float,
    point_count: int = 800,
) -> np.ndarray:
    excitation_energies_ev = collect_absorption_excitation_energies_ev(profile)
    if excitation_energies_ev.size <= 0:
        raise ValueError("No valid excitation energies are available for this profile.")
    min_energy_ev = float(np.min(excitation_energies_ev))
    max_energy_ev = float(np.max(excitation_energies_ev))
    margin_ev = max(0.25, 8.0 * float(delta_ev))
    x_min_energy_ev = max(0.01, min_energy_ev - margin_ev)
    x_max_energy_ev = max(x_min_energy_ev + 0.2, max_energy_ev + margin_ev)
    return np.linspace(x_min_energy_ev, x_max_energy_ev, int(point_count), dtype=float)


def _lorentzian_lineshape(diff_ev: np.ndarray, *, delta_ev: float) -> np.ndarray:
    delta = float(delta_ev)
    return (delta / np.pi) / (np.square(diff_ev) + (delta * delta))


def inspect_spectrum_window(
    profile: ElectronicProfile,
    *,
    window_min_ev: float,
    window_max_ev: float,
    delta_ev: float,
    x_energy_ev: np.ndarray | None = None,
    state_filter: Sequence[int | str] | None = None,
    selection_mode: str = "hard_window_strength",
) -> SpectrumWindowInspection:
    if float(window_max_ev) <= float(window_min_ev):
        raise ValueError("window_max_ev must be larger than window_min_ev.")

    normalized_state_filter = normalize_state_filter(profile, state_filter)
    x_grid = (
        np.asarray(x_energy_ev, dtype=float).reshape(-1)
        if x_energy_ev is not None
        else build_absorption_energy_grid_for_profile(profile, delta_ev=float(delta_ev))
    )
    if x_grid.size <= 1:
        raise ValueError("The absorption energy grid must contain at least two points.")

    excitation_energy_ev = (
        profile.state_energy_hartree[:, profile.transition_pairs[:, 1]]
        - profile.state_energy_hartree[:, profile.transition_pairs[:, 0]]
    ) * float(HARTREE_TO_EV)
    transition_pairs = np.asarray(profile.transition_pairs, dtype=int)
    transition_intensity = np.asarray(profile.transition_intensity, dtype=float)

    selected_transition_mask = np.ones(int(transition_pairs.shape[0]), dtype=bool)
    if normalized_state_filter is not None:
        selected_transition_mask = np.isin(transition_pairs[:, 1], np.asarray(normalized_state_filter, dtype=int))

    valid_transition_mask = (
        np.isfinite(excitation_energy_ev)
        & np.isfinite(transition_intensity)
        & (excitation_energy_ev > 0.0)
        & (transition_intensity >= 0.0)
        & selected_transition_mask[None, :]
    )
    if not np.any(valid_transition_mask):
        raise ValueError("No valid transitions remain after applying the requested state filter.")

    hard_candidate_mask = (
        valid_transition_mask
        & (excitation_energy_ev >= float(window_min_ev))
        & (excitation_energy_ev <= float(window_max_ev))
    )
    hard_sample_mask = np.any(hard_candidate_mask, axis=1)

    total_curve = np.zeros_like(x_grid, dtype=float)
    transition_window_weights = np.zeros_like(excitation_energy_ev, dtype=float)
    window_mask = (x_grid >= float(window_min_ev)) & (x_grid <= float(window_max_ev))
    if not np.any(window_mask):
        raise ValueError("The selected window does not overlap the absorption energy grid.")

    safe_x_grid = np.maximum(np.asarray(x_grid, dtype=float), 1.0e-12)
    for transition_index in np.where(selected_transition_mask)[0].tolist():
        transition_valid = valid_transition_mask[:, transition_index]
        valid_count = int(np.count_nonzero(transition_valid))
        if valid_count <= 0:
            continue

        transition_excitation = np.asarray(excitation_energy_ev[:, transition_index], dtype=float)
        transition_strength = np.asarray(transition_intensity[:, transition_index], dtype=float)
        diff_ev = safe_x_grid.reshape(1, -1) - transition_excitation.reshape(-1, 1)
        lineshape = _lorentzian_lineshape(diff_ev, delta_ev=float(delta_ev))
        contribution = (
            transition_excitation.reshape(-1, 1)
            * transition_strength.reshape(-1, 1)
            * lineshape
        ) / safe_x_grid.reshape(1, -1)
        contribution = np.where(transition_valid.reshape(-1, 1), contribution, 0.0)
        contribution = contribution / float(valid_count)
        total_curve += np.sum(contribution, axis=0)
        if selection_mode == "lorentzian_window":
            transition_window_weights[:, transition_index] = np.trapz(
                contribution[:, window_mask],
                x_grid[window_mask],
                axis=1,
            )
        elif selection_mode == "hard_window_strength":
            transition_window_weights[:, transition_index] = np.where(
                hard_candidate_mask[:, transition_index],
                transition_strength,
                0.0,
            )
        elif selection_mode == "hard_window_binary":
            transition_window_weights[:, transition_index] = np.where(
                hard_candidate_mask[:, transition_index],
                1.0,
                0.0,
            )
        else:
            raise ValueError(
                "selection_mode must be one of "
                "'hard_window_strength', 'hard_window_binary', or 'lorentzian_window'."
            )

    peak_value = float(np.max(total_curve)) if total_curve.size > 0 else 0.0
    if peak_value > 0.0 and np.isfinite(peak_value):
        total_curve_normalized = np.asarray(total_curve / peak_value, dtype=float)
    else:
        total_curve_normalized = np.zeros_like(total_curve, dtype=float)

    sample_window_weights = np.asarray(np.sum(transition_window_weights, axis=1), dtype=float)
    max_sample_weight = float(np.max(sample_window_weights)) if sample_window_weights.size > 0 else 0.0
    if max_sample_weight > 0.0 and np.isfinite(max_sample_weight):
        normalized_sample_window_weights = np.asarray(sample_window_weights / max_sample_weight, dtype=float)
    else:
        normalized_sample_window_weights = np.zeros_like(sample_window_weights, dtype=float)

    weight_sum = float(np.sum(sample_window_weights))
    weight_sq_sum = float(np.sum(np.square(sample_window_weights)))
    effective_sample_size = 0.0
    if weight_sum > 0.0 and weight_sq_sum > 0.0:
        effective_sample_size = (weight_sum * weight_sum) / weight_sq_sum

    selection_score_label = {
        "hard_window_strength": "sum oscillator strengths inside the hard energy window",
        "hard_window_binary": "number of valid transitions inside the hard energy window",
        "lorentzian_window": "integrated Lorentzian-broadened contribution inside the window",
    }[selection_mode]

    return SpectrumWindowInspection(
        window_min_ev=float(window_min_ev),
        window_max_ev=float(window_max_ev),
        delta_ev=float(delta_ev),
        selection_mode=str(selection_mode),
        selection_score_label=str(selection_score_label),
        state_filter=normalized_state_filter,
        x_energy_ev=np.asarray(x_grid, dtype=float),
        total_curve=np.asarray(total_curve, dtype=float),
        total_curve_normalized=np.asarray(total_curve_normalized, dtype=float),
        excitation_energy_ev=np.asarray(excitation_energy_ev, dtype=float),
        transition_intensity=np.asarray(transition_intensity, dtype=float),
        transition_pairs=np.asarray(transition_pairs, dtype=int),
        valid_transition_mask=np.asarray(valid_transition_mask, dtype=bool),
        hard_candidate_mask=np.asarray(hard_candidate_mask, dtype=bool),
        hard_sample_mask=np.asarray(hard_sample_mask, dtype=bool),
        transition_window_weights=np.asarray(transition_window_weights, dtype=float),
        sample_window_weights=np.asarray(sample_window_weights, dtype=float),
        normalized_sample_window_weights=np.asarray(normalized_sample_window_weights, dtype=float),
        effective_sample_size=float(effective_sample_size),
    )


def _project_feature_set(
    feature_set: StructureFeatureSet,
    *,
    method: str = "tsne",
    tsne_perplexity: float = 30.0,
    tsne_random_state: int = 42,
    tsne_learning_rate: str | float = "auto",
    tsne_n_iter: int = 1000,
    tsne_init: str = "pca",
    umap_n_neighbors: int = 15,
    umap_min_dist: float = 0.1,
    umap_random_state: int = 42,
    umap_metric: str = "euclidean",
    isomap_n_neighbors: int = 15,
    isomap_metric: str = "euclidean",
) -> StructureProjection:
    feature_matrix = np.asarray(feature_set.feature_matrix, dtype=float)
    if feature_matrix.ndim != 2:
        raise ValueError(f"feature_matrix must be 2D, got {feature_matrix.shape}.")
    if feature_matrix.shape[0] < 1:
        raise ValueError("feature_matrix must contain at least one geometry.")

    column_mean = np.mean(feature_matrix, axis=0)
    column_std = np.std(feature_matrix, axis=0)
    safe_column_std = np.where(column_std > 1.0e-12, column_std, 1.0)
    standardized = (feature_matrix - column_mean) / safe_column_std

    normalized_method = str(method).strip().lower()
    if normalized_method == "pca":
        u_matrix, singular_values, _ = np.linalg.svd(standardized, full_matrices=False)
        coords_2d = u_matrix[:, :2] * singular_values[:2]
        explained_variance = np.square(singular_values) / max(int(standardized.shape[0]) - 1, 1)
        total_variance = float(np.sum(explained_variance))
        if total_variance > 0.0 and np.isfinite(total_variance):
            explained_variance_ratio = np.asarray(explained_variance[:2] / total_variance, dtype=float)
        else:
            explained_variance_ratio = np.zeros(2, dtype=float)
        axis_labels = ("PC1", "PC2")
    elif normalized_method == "tsne":
        if standardized.shape[0] < 2:
            raise ValueError("t-SNE projection requires at least two geometries.")
        max_perplexity = max(float(standardized.shape[0] - 1), 1.0)
        safe_perplexity = float(np.clip(float(tsne_perplexity), 1.0, max_perplexity))
        tsne_kwargs: dict[str, Any] = {
            "n_components": 2,
            "perplexity": safe_perplexity,
            "learning_rate": tsne_learning_rate,
            "init": str(tsne_init),
            "random_state": int(tsne_random_state),
            "method": "barnes_hut",
        }
        tsne_iter_param = "max_iter" if "max_iter" in inspect.signature(TSNE.__init__).parameters else "n_iter"
        tsne_kwargs[tsne_iter_param] = int(tsne_n_iter)
        coords_2d = TSNE(
            **tsne_kwargs,
        ).fit_transform(standardized)
        explained_variance_ratio = None
        axis_labels = ("t-SNE 1", "t-SNE 2")
    elif normalized_method == "umap":
        if standardized.shape[0] < 3:
            raise ValueError("UMAP projection requires at least three geometries.")
        try:
            umap_module = importlib.import_module("umap")
        except ModuleNotFoundError as exc:
            raise ModuleNotFoundError(
                "UMAP projection requires optional dependency 'umap-learn'. "
                "Install it with 'pip install umap-learn'."
            ) from exc
        safe_n_neighbors = int(
            np.clip(
                int(umap_n_neighbors),
                2,
                max(int(standardized.shape[0]) - 1, 2),
            )
        )
        coords_2d = umap_module.UMAP(
            n_components=2,
            n_neighbors=safe_n_neighbors,
            min_dist=max(float(umap_min_dist), 0.0),
            metric=str(umap_metric),
            random_state=int(umap_random_state),
        ).fit_transform(standardized)
        explained_variance_ratio = None
        axis_labels = ("UMAP 1", "UMAP 2")
    elif normalized_method == "isomap":
        if standardized.shape[0] < 3:
            raise ValueError("Isomap projection requires at least three geometries.")
        safe_n_neighbors = int(
            np.clip(
                int(isomap_n_neighbors),
                2,
                max(int(standardized.shape[0]) - 1, 2),
            )
        )
        coords_2d = Isomap(
            n_components=2,
            n_neighbors=safe_n_neighbors,
            metric=str(isomap_metric),
        ).fit_transform(standardized)
        explained_variance_ratio = None
        axis_labels = ("Isomap 1", "Isomap 2")
    else:
        raise ValueError("method must be one of 'tsne', 'pca', 'umap', or 'isomap'.")

    return StructureProjection(
        feature_matrix=feature_matrix,
        feature_labels=list(feature_set.feature_labels),
        feature_kind=str(feature_set.feature_kind),
        atom_pairs=(
            list(feature_set.atom_pairs)
            if feature_set.atom_pairs is not None
            else None
        ),
        coords_2d=np.asarray(coords_2d, dtype=float),
        method=normalized_method,
        axis_labels=axis_labels,
        explained_variance_ratio=explained_variance_ratio,
    )


def build_pair_distance_feature_set(
    bundle: DistributionBundle,
    *,
    max_pair_count: int = 240,
) -> StructureFeatureSet:
    coords_ang = np.asarray(bundle.coords_bohr, dtype=float) * float(BOHR_TO_ANG)
    if coords_ang.ndim != 3 or coords_ang.shape[2] != 3:
        raise ValueError(f"coords_bohr must have shape [n_samples, n_atoms, 3], got {coords_ang.shape}.")

    n_atoms = int(coords_ang.shape[1])
    atom_pairs = [(i, j) for i in range(n_atoms) for j in range(i + 1, n_atoms)]
    if not atom_pairs:
        raise ValueError("At least two atoms are required to build distance features.")

    if len(atom_pairs) <= int(max_pair_count):
        chosen_pairs = atom_pairs
    else:
        pair_variance: list[tuple[float, tuple[int, int]]] = []
        for atom_i, atom_j in atom_pairs:
            values = np.linalg.norm(coords_ang[:, atom_i, :] - coords_ang[:, atom_j, :], axis=1)
            pair_variance.append((float(np.var(values)), (atom_i, atom_j)))
        pair_variance.sort(key=lambda item: item[0], reverse=True)
        chosen_pairs = [pair for _, pair in pair_variance[: int(max_pair_count)]]

    feature_columns: list[np.ndarray] = []
    feature_labels: list[str] = []
    for atom_i, atom_j in chosen_pairs:
        values = np.linalg.norm(coords_ang[:, atom_i, :] - coords_ang[:, atom_j, :], axis=1)
        feature_columns.append(np.asarray(values, dtype=float))
        feature_labels.append(f"d({atom_i},{atom_j})")

    feature_matrix = np.column_stack(feature_columns).astype(float, copy=False)
    return StructureFeatureSet(
        feature_matrix=np.asarray(feature_matrix, dtype=float),
        feature_labels=feature_labels,
        feature_kind="pair_distance",
        atom_pairs=chosen_pairs,
    )


def build_selected_pair_distance_feature_set(
    bundle: DistributionBundle,
    *,
    atom_pairs: Sequence[Sequence[int | str] | tuple[int | str, int | str]],
) -> StructureFeatureSet:
    coords_ang = np.asarray(bundle.coords_bohr, dtype=float) * float(BOHR_TO_ANG)
    if coords_ang.ndim != 3 or coords_ang.shape[2] != 3:
        raise ValueError(f"coords_bohr must have shape [n_samples, n_atoms, 3], got {coords_ang.shape}.")

    n_atoms = int(coords_ang.shape[1])
    normalized_pairs: list[tuple[int, int]] = []
    seen_pairs: set[tuple[int, int]] = set()
    for raw_pair in atom_pairs:
        if len(raw_pair) != 2:
            raise ValueError(f"Each atom pair must contain exactly two atom indices, got {raw_pair!r}.")
        atom_i = int(raw_pair[0])
        atom_j = int(raw_pair[1])
        if atom_i == atom_j:
            raise ValueError(f"Atom pairs must reference two different atoms, got {(atom_i, atom_j)!r}.")
        if atom_i < 0 or atom_j < 0 or atom_i >= n_atoms or atom_j >= n_atoms:
            raise ValueError(
                f"Atom pair {(atom_i, atom_j)!r} is out of range for bundle with {n_atoms} atoms."
            )
        normalized_pair = (min(atom_i, atom_j), max(atom_i, atom_j))
        if normalized_pair in seen_pairs:
            continue
        seen_pairs.add(normalized_pair)
        normalized_pairs.append(normalized_pair)

    if not normalized_pairs:
        raise ValueError("atom_pairs must contain at least one valid pair.")

    feature_columns: list[np.ndarray] = []
    feature_labels: list[str] = []
    for atom_i, atom_j in normalized_pairs:
        values = np.linalg.norm(coords_ang[:, atom_i, :] - coords_ang[:, atom_j, :], axis=1)
        feature_columns.append(np.asarray(values, dtype=float))
        feature_labels.append(f"d({atom_i},{atom_j})")

    feature_matrix = np.column_stack(feature_columns).astype(float, copy=False)
    return StructureFeatureSet(
        feature_matrix=np.asarray(feature_matrix, dtype=float),
        feature_labels=feature_labels,
        feature_kind="pair_distance_selected",
        atom_pairs=normalized_pairs,
    )


def build_pair_distance_projection(
    bundle: DistributionBundle,
    *,
    max_pair_count: int = 240,
    method: str = "tsne",
    tsne_perplexity: float = 30.0,
    tsne_random_state: int = 42,
    tsne_learning_rate: str | float = "auto",
    tsne_n_iter: int = 1000,
    tsne_init: str = "pca",
    umap_n_neighbors: int = 15,
    umap_min_dist: float = 0.1,
    umap_random_state: int = 42,
    umap_metric: str = "euclidean",
    isomap_n_neighbors: int = 15,
    isomap_metric: str = "euclidean",
) -> StructureProjection:
    feature_set = build_pair_distance_feature_set(bundle, max_pair_count=max_pair_count)
    return _project_feature_set(
        feature_set,
        method=method,
        tsne_perplexity=tsne_perplexity,
        tsne_random_state=tsne_random_state,
        tsne_learning_rate=tsne_learning_rate,
        tsne_n_iter=tsne_n_iter,
        tsne_init=tsne_init,
        umap_n_neighbors=umap_n_neighbors,
        umap_min_dist=umap_min_dist,
        umap_random_state=umap_random_state,
        umap_metric=umap_metric,
        isomap_n_neighbors=isomap_n_neighbors,
        isomap_metric=isomap_metric,
    )


def build_soap_feature_set(
    bundle: DistributionBundle,
    *,
    atom_indices: Sequence[int | str] | None = None,
    r_cut: float = 4.5,
    n_max: int = 6,
    l_max: int = 4,
    sigma: float = 0.3,
    n_jobs: int = 1,
) -> AtomwiseSoapFeatureSet:
    try:
        from ase import Atoms
        from dscribe.descriptors import SOAP
    except ModuleNotFoundError as exc:
        raise ModuleNotFoundError(
            "SOAP descriptors require optional dependencies 'ase' and 'dscribe'. "
            "Install them with 'pip install dscribe'."
        ) from exc

    coords_ang = np.asarray(bundle.coords_bohr, dtype=float) * float(BOHR_TO_ANG)
    atom_numbers = np.asarray(bundle.atom_numbers, dtype=int).reshape(-1)
    if coords_ang.ndim != 3 or coords_ang.shape[1] != atom_numbers.shape[0]:
        raise ValueError(
            "coords_bohr and atom_numbers must align for SOAP features: "
            f"coords={coords_ang.shape}, atom_numbers={atom_numbers.shape}."
        )

    selected_indices = np.arange(int(atom_numbers.shape[0]), dtype=int)
    if atom_indices is not None:
        selected_indices = np.asarray([int(value) for value in atom_indices], dtype=int).reshape(-1)
        if selected_indices.size <= 0:
            raise ValueError("atom_indices must contain at least one atom when provided.")
        if np.any(selected_indices < 0) or np.any(selected_indices >= atom_numbers.shape[0]):
            raise ValueError(
                f"atom_indices must be within [0, {atom_numbers.shape[0] - 1}], "
                f"got {selected_indices.tolist()}."
            )
        atom_numbers = atom_numbers[selected_indices]
        coords_ang = coords_ang[:, selected_indices, :]

    systems = [
        Atoms(numbers=atom_numbers.tolist(), positions=np.asarray(coords_ang[sample_index], dtype=float))
        for sample_index in range(int(coords_ang.shape[0]))
    ]
    soap = SOAP(
        species=sorted({int(value) for value in atom_numbers.tolist()}),
        r_cut=float(r_cut),
        n_max=int(n_max),
        l_max=int(l_max),
        sigma=float(sigma),
        periodic=False,
        average="off",
        sparse=False,
    )
    feature_tensor = np.asarray(
        soap.create(
            systems,
            n_jobs=max(int(n_jobs), 1),
            only_physical_cores=False,
        ),
        dtype=float,
    )
    if feature_tensor.ndim == 1:
        feature_tensor = feature_tensor.reshape(1, 1, -1)
    elif feature_tensor.ndim == 2:
        feature_tensor = feature_tensor[:, None, :]
    if feature_tensor.ndim != 3:
        raise ValueError(f"SOAP tensor must be 3D, got {feature_tensor.shape}.")

    feature_labels = [f"soap_{feature_index:04d}" for feature_index in range(int(feature_tensor.shape[2]))]
    return AtomwiseSoapFeatureSet(
        feature_tensor=np.asarray(feature_tensor, dtype=float),
        feature_labels=feature_labels,
        feature_kind="soap_atomwise",
        atom_indices=selected_indices.tolist(),
    )


def _pool_atomwise_soap_feature_set(
    feature_set: AtomwiseSoapFeatureSet,
    *,
    average: str = "mean",
) -> StructureFeatureSet:
    feature_tensor = np.asarray(feature_set.feature_tensor, dtype=float)
    if feature_tensor.ndim != 3:
        raise ValueError(f"feature_tensor must be 3D, got {feature_tensor.shape}.")
    if feature_tensor.shape[0] < 1 or feature_tensor.shape[1] < 1:
        raise ValueError(f"feature_tensor must contain at least one sample and atom, got {feature_tensor.shape}.")

    normalized_average = str(average).strip().lower()
    if normalized_average in {"mean", "inner"}:
        feature_matrix = np.mean(feature_tensor, axis=1)
    else:
        raise ValueError(
            "SOAP projection pooling average must be 'mean' or legacy-compatible 'inner', "
            f"got {average!r}."
        )

    return StructureFeatureSet(
        feature_matrix=np.asarray(feature_matrix, dtype=float),
        feature_labels=list(feature_set.feature_labels),
        feature_kind="soap_atomwise_pooled",
        atom_pairs=None,
    )


def build_soap_projection(
    bundle: DistributionBundle,
    *,
    atom_indices: Sequence[int | str] | None = None,
    r_cut: float = 4.5,
    n_max: int = 6,
    l_max: int = 4,
    sigma: float = 0.3,
    average: str = "inner",
    n_jobs: int = 1,
    method: str = "tsne",
    tsne_perplexity: float = 30.0,
    tsne_random_state: int = 42,
    tsne_learning_rate: str | float = "auto",
    tsne_n_iter: int = 1000,
    tsne_init: str = "pca",
    umap_n_neighbors: int = 15,
    umap_min_dist: float = 0.1,
    umap_random_state: int = 42,
    umap_metric: str = "euclidean",
    isomap_n_neighbors: int = 15,
    isomap_metric: str = "euclidean",
) -> StructureProjection:
    atomwise_feature_set = build_soap_feature_set(
        bundle,
        atom_indices=atom_indices,
        r_cut=r_cut,
        n_max=n_max,
        l_max=l_max,
        sigma=sigma,
        n_jobs=n_jobs,
    )
    pooled_feature_set = _pool_atomwise_soap_feature_set(
        atomwise_feature_set,
        average=average,
    )
    projection = _project_feature_set(
        pooled_feature_set,
        method=method,
        tsne_perplexity=tsne_perplexity,
        tsne_random_state=tsne_random_state,
        tsne_learning_rate=tsne_learning_rate,
        tsne_n_iter=tsne_n_iter,
        tsne_init=tsne_init,
        umap_n_neighbors=umap_n_neighbors,
        umap_min_dist=umap_min_dist,
        umap_random_state=umap_random_state,
        umap_metric=umap_metric,
        isomap_n_neighbors=isomap_n_neighbors,
        isomap_metric=isomap_metric,
    )
    return StructureProjection(
        feature_matrix=np.asarray(projection.feature_matrix, dtype=float),
        feature_labels=list(projection.feature_labels),
        feature_kind=str(projection.feature_kind),
        atom_pairs=(
            list(projection.atom_pairs)
            if projection.atom_pairs is not None
            else None
        ),
        coords_2d=np.asarray(projection.coords_2d, dtype=float),
        method=str(projection.method),
        axis_labels=projection.axis_labels,
        explained_variance_ratio=(
            np.asarray(projection.explained_variance_ratio, dtype=float)
            if projection.explained_variance_ratio is not None
            else None
        ),
        source_feature_shape=tuple(int(value) for value in atomwise_feature_set.feature_tensor.shape),
        atom_indices=list(atomwise_feature_set.atom_indices),
    )


def rank_descriptor_shifts(
    feature_set: StructureFeatureSet,
    inspection: SpectrumWindowInspection,
    *,
    top_k: int = 6,
) -> list[DescriptorShift]:
    feature_matrix = np.asarray(feature_set.feature_matrix, dtype=float)
    sample_weights = np.asarray(inspection.sample_window_weights, dtype=float)
    if feature_matrix.ndim != 2:
        raise ValueError(f"feature_matrix must be 2D, got {feature_matrix.shape}.")
    if feature_matrix.shape[0] != sample_weights.shape[0]:
        raise ValueError(
            "feature_matrix row count must match sample weight count: "
            f"{feature_matrix.shape[0]} vs {sample_weights.shape[0]}."
        )

    weight_sum = float(np.sum(sample_weights))
    if weight_sum <= 0.0 or not np.isfinite(weight_sum):
        raise ValueError("Window sample weights are all zero; descriptor ranking is undefined.")
    normalized_weights = np.asarray(sample_weights / weight_sum, dtype=float)

    shifts: list[DescriptorShift] = []
    for feature_index, label in enumerate(feature_set.feature_labels):
        values = np.asarray(feature_matrix[:, feature_index], dtype=float)
        overall_mean = float(np.mean(values))
        overall_std = float(np.std(values))
        weighted_mean = float(np.sum(normalized_weights * values))
        safe_std = overall_std if overall_std > 1.0e-12 else 1.0
        effect_size = float(abs(weighted_mean - overall_mean) / safe_std)
        atom_pair = None
        if feature_set.atom_pairs is not None:
            atom_pair = feature_set.atom_pairs[feature_index]
        shifts.append(
            DescriptorShift(
                label=label,
                values=np.asarray(values, dtype=float),
                atom_pair=atom_pair,
                overall_mean=overall_mean,
                overall_std=overall_std,
                weighted_mean=weighted_mean,
                effect_size=effect_size,
            )
        )
    shifts.sort(key=lambda item: item.effect_size, reverse=True)
    return shifts[: max(int(top_k), 1)]


def representative_sample_rows(
    bundle: DistributionBundle,
    inspection: SpectrumWindowInspection,
    projection: StructureProjection,
    *,
    count: int = 8,
) -> list[dict[str, Any]]:
    weights = np.asarray(inspection.sample_window_weights, dtype=float)
    if weights.size <= 0:
        return []
    ranked_indices = np.argsort(weights)[::-1]
    rows: list[dict[str, Any]] = []
    for rank, sample_index in enumerate(ranked_indices[: max(int(count), 1)].tolist(), start=1):
        dominant_transition_index = int(np.argmax(inspection.transition_window_weights[sample_index]))
        dominant_pair = inspection.transition_pairs[dominant_transition_index].tolist()
        rows.append(
            {
                "rank": int(rank),
                "sample_idx": int(sample_index),
                "sample_id": str(bundle.sample_ids[sample_index]),
                "weight": float(weights[sample_index]),
                "weight_norm": float(inspection.normalized_sample_window_weights[sample_index]),
                "projection_method": str(projection.method),
                "projection_feature_kind": str(projection.feature_kind),
                "projection_axis_1": str(projection.axis_labels[0]),
                "projection_axis_2": str(projection.axis_labels[1]),
                "coord_1": float(projection.coords_2d[sample_index, 0]),
                "coord_2": float(projection.coords_2d[sample_index, 1]),
                "dominant_pair": f"{dominant_pair[0]}->{dominant_pair[1]}",
                "dominant_excitation_ev": float(
                    inspection.excitation_energy_ev[sample_index, dominant_transition_index]
                ),
            }
        )
    return rows
