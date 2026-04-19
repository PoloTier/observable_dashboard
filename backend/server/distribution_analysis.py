from __future__ import annotations

import importlib
from typing import Any, MutableMapping, Sequence

import numpy as np

from backend.server.distribution_bundle import (
    DistributionBundle,
    ElectronicProfile,
    HARTREE_TO_EV,
    compute_geometry_measurements,
)
from backend.server.constants import BOHR_TO_ANG


SelectionItem = tuple[str, DistributionBundle, str, ElectronicProfile]
BundleItem = tuple[str, DistributionBundle]
SELECTION_MODE_HARD_WINDOW_STRENGTH = "hard_window_strength"
SELECTION_MODE_NONE = "none"
NO_SELECTION_PROFILE_ID = "all_geometries"
NO_SELECTION_PROFILE_LABEL = "All geometries"


def _window_bounds(*, window_center_ev: float, window_width_ev: float) -> tuple[float, float]:
    width = float(window_width_ev)
    if width <= 0.0:
        raise ValueError("window_width_ev must be larger than 0.")
    center = float(window_center_ev)
    half_width = width / 2.0
    return center - half_width, center + half_width


def _compute_excitation_energy_ev(profile: ElectronicProfile) -> np.ndarray:
    return np.asarray(
        (
            profile.state_energy_hartree[:, profile.transition_pairs[:, 1]]
            - profile.state_energy_hartree[:, profile.transition_pairs[:, 0]]
        )
        * float(HARTREE_TO_EV),
        dtype=float,
    )


def compute_hard_window_selection(
    profile: ElectronicProfile,
    *,
    window_center_ev: float,
    window_width_ev: float,
) -> dict[str, Any]:
    window_min_ev, window_max_ev = _window_bounds(
        window_center_ev=float(window_center_ev),
        window_width_ev=float(window_width_ev),
    )
    excitation_energy_ev = _compute_excitation_energy_ev(profile)
    transition_intensity = np.asarray(profile.transition_intensity, dtype=float)
    valid_transition_mask = (
        np.isfinite(excitation_energy_ev)
        & np.isfinite(transition_intensity)
        & (excitation_energy_ev > 0.0)
        & (transition_intensity >= 0.0)
    )
    hard_candidate_mask = (
        valid_transition_mask
        & (excitation_energy_ev >= float(window_min_ev))
        & (excitation_energy_ev <= float(window_max_ev))
    )
    sample_window_weights = np.asarray(
        np.sum(np.where(hard_candidate_mask, transition_intensity, 0.0), axis=1),
        dtype=float,
    ).reshape(-1)
    hard_sample_mask = np.asarray(np.any(hard_candidate_mask, axis=1), dtype=bool).reshape(-1)
    max_weight = float(np.max(sample_window_weights)) if sample_window_weights.size > 0 else 0.0
    if max_weight > 0.0 and np.isfinite(max_weight):
        normalized_sample_window_weights = np.asarray(sample_window_weights / max_weight, dtype=float)
    else:
        normalized_sample_window_weights = np.zeros_like(sample_window_weights, dtype=float)
    weight_sum = float(np.sum(sample_window_weights))
    weight_sq_sum = float(np.sum(np.square(sample_window_weights)))
    effective_sample_size = (weight_sum * weight_sum / weight_sq_sum) if weight_sq_sum > 0.0 else 0.0
    return {
        "window_min_ev": float(window_min_ev),
        "window_max_ev": float(window_max_ev),
        "hard_sample_mask": hard_sample_mask,
        "sample_window_weights": sample_window_weights,
        "normalized_sample_window_weights": normalized_sample_window_weights,
        "effective_sample_size": float(effective_sample_size),
    }


def _summarize_values(values: np.ndarray) -> dict[str, Any]:
    normalized = np.asarray(values, dtype=float).reshape(-1)
    if normalized.size <= 0:
        return {
            "count": 0,
            "min": None,
            "max": None,
            "mean": None,
            "std": None,
            "p05": None,
            "p50": None,
            "p95": None,
        }
    sorted_values = np.sort(normalized)
    count = int(sorted_values.shape[0])
    std = float(np.std(sorted_values, ddof=1)) if count > 1 else 0.0
    return {
        "count": count,
        "min": float(sorted_values[0]),
        "max": float(sorted_values[-1]),
        "mean": float(np.mean(sorted_values)),
        "std": std,
        "p05": float(np.quantile(sorted_values, 0.05)),
        "p50": float(np.quantile(sorted_values, 0.50)),
        "p95": float(np.quantile(sorted_values, 0.95)),
    }


def build_windowed_geometry_comparison(
    items: Sequence[SelectionItem],
    *,
    measurement_kind: str,
    atom_indices: Sequence[int],
    bins: int,
    window_center_ev: float,
    window_width_ev: float,
) -> dict[str, Any]:
    if not items:
        raise ValueError("items must contain at least one distribution/profile selection.")

    first_bundle = items[0][1]
    window_min_ev, window_max_ev = _window_bounds(
        window_center_ev=float(window_center_ev),
        window_width_ev=float(window_width_ev),
    )
    series_payloads: list[dict[str, Any]] = []
    for distribution_id, bundle, profile_id, profile in items:
        values, unit = compute_geometry_measurements(
            bundle,
            measurement_kind=str(measurement_kind),
            atom_indices=[int(value) for value in atom_indices],
        )
        selection_payload = compute_hard_window_selection(
            profile,
            window_center_ev=float(window_center_ev),
            window_width_ev=float(window_width_ev),
        )
        hard_sample_mask = np.asarray(selection_payload["hard_sample_mask"], dtype=bool).reshape(-1)
        if hard_sample_mask.shape[0] != values.shape[0]:
            raise ValueError(
                "Geometry measurement values and hard window mask must align: "
                f"values={values.shape}, hard_sample_mask={hard_sample_mask.shape}."
            )
        selected_values = np.asarray(values[hard_sample_mask], dtype=float)
        sample_window_weights = np.asarray(selection_payload["sample_window_weights"], dtype=float)
        positive_weight_mask = sample_window_weights > 0.0
        positive_weights = sample_window_weights[positive_weight_mask]
        mean_selection_weight = float(np.mean(positive_weights)) if positive_weights.size > 0 else 0.0
        max_selection_weight = float(np.max(positive_weights)) if positive_weights.size > 0 else 0.0
        series_payloads.append(
            {
                "distribution_id": str(distribution_id),
                "profile_id": str(profile_id),
                "label": str(bundle.label),
                "profile_label": str(profile.label),
                "source_name": str(bundle.source_name),
                "all_values": values.astype(float).tolist(),
                "selected_values": selected_values.astype(float).tolist(),
                "selected_count": int(selected_values.shape[0]),
                "selected_fraction": (
                    float(selected_values.shape[0]) / float(values.shape[0]) if values.shape[0] > 0 else 0.0
                ),
                "effective_sample_size": float(selection_payload["effective_sample_size"]),
                "mean_selection_weight": float(mean_selection_weight),
                "max_selection_weight": float(max_selection_weight),
                "all_summary": _summarize_values(values),
                "selected_summary": _summarize_values(selected_values),
                # Keep a legacy alias so existing clients can still treat the all-values
                # payload as the canonical geometry series.
                "values": values.astype(float).tolist(),
                "sample_count": int(values.shape[0]),
                "min": float(np.min(values)),
                "max": float(np.max(values)),
                "mean": float(np.mean(values)),
                "std": float(np.std(values)),
                "unit": str(unit),
            }
        )

    return {
        "measurement_kind": str(measurement_kind).strip().lower(),
        "atom_indices": [int(value) for value in atom_indices],
        "unit": str(series_payloads[0]["unit"]),
        "bins": int(bins),
        "topology_signature": str(first_bundle.topology_signature),
        "window_center_ev": float(window_center_ev),
        "window_width_ev": float(window_width_ev),
        "window_min_ev": float(window_min_ev),
        "window_max_ev": float(window_max_ev),
        "selection_mode": SELECTION_MODE_HARD_WINDOW_STRENGTH,
        "series": series_payloads,
    }


def _build_soap_feature_cache_key(
    *,
    distribution_id: str,
    atom_indices: Sequence[int] | None,
    soap_r_cut: float,
    soap_n_max: int,
    soap_l_max: int,
    soap_sigma: float,
) -> tuple[Any, ...]:
    normalized_atom_indices = tuple(int(value) for value in list(atom_indices or []))
    return (
        "soap_feature",
        str(distribution_id),
        normalized_atom_indices,
        round(float(soap_r_cut), 8),
        int(soap_n_max),
        int(soap_l_max),
        round(float(soap_sigma), 8),
    )


def _build_atomwise_soap_feature_set(
    bundle: DistributionBundle,
    *,
    atom_indices: Sequence[int] | None,
    soap_r_cut: float,
    soap_n_max: int,
    soap_l_max: int,
    soap_sigma: float,
) -> dict[str, Any]:
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
            raise ValueError("soap_atom_indices must contain at least one atom when provided.")
        if np.any(selected_indices < 0) or np.any(selected_indices >= atom_numbers.shape[0]):
            raise ValueError(
                f"soap_atom_indices must be within [0, {atom_numbers.shape[0] - 1}], "
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
        r_cut=float(soap_r_cut),
        n_max=int(soap_n_max),
        l_max=int(soap_l_max),
        sigma=float(soap_sigma),
        periodic=False,
        average="off",
        sparse=False,
    )
    feature_tensor = np.asarray(
        soap.create(
            systems,
            n_jobs=1,
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
    return {
        "feature_tensor": feature_tensor,
        "atom_indices": selected_indices.tolist(),
    }


def _get_or_build_pooled_soap_feature_payload(
    *,
    distribution_id: str,
    bundle: DistributionBundle,
    atom_indices: Sequence[int] | None,
    soap_r_cut: float,
    soap_n_max: int,
    soap_l_max: int,
    soap_sigma: float,
    feature_cache: MutableMapping[tuple[Any, ...], dict[str, Any]] | None,
) -> dict[str, Any]:
    cache_key = _build_soap_feature_cache_key(
        distribution_id=str(distribution_id),
        atom_indices=atom_indices,
        soap_r_cut=float(soap_r_cut),
        soap_n_max=int(soap_n_max),
        soap_l_max=int(soap_l_max),
        soap_sigma=float(soap_sigma),
    )
    if feature_cache is not None:
        cached_payload = feature_cache.get(cache_key)
        if cached_payload is not None:
            return cached_payload

    atomwise_feature_set = _build_atomwise_soap_feature_set(
        bundle,
        atom_indices=atom_indices,
        soap_r_cut=float(soap_r_cut),
        soap_n_max=int(soap_n_max),
        soap_l_max=int(soap_l_max),
        soap_sigma=float(soap_sigma),
    )
    feature_tensor = np.asarray(atomwise_feature_set["feature_tensor"], dtype=float)
    if feature_tensor.ndim != 3:
        raise ValueError(f"SOAP tensor must be 3D, got {feature_tensor.shape}.")
    feature_matrix = np.asarray(np.mean(feature_tensor, axis=1), dtype=float)
    payload = {
        "feature_matrix": feature_matrix,
        "feature_dimension": int(feature_matrix.shape[1]),
        "feature_kind": "soap_atomwise_pooled",
        "source_feature_shape": tuple(int(value) for value in feature_tensor.shape),
        "atom_indices": list(atomwise_feature_set["atom_indices"]),
    }
    if feature_cache is not None:
        feature_cache[cache_key] = payload
    return payload


def _project_umap_feature_matrix(
    feature_matrix: np.ndarray,
    *,
    umap_n_neighbors: int,
    umap_min_dist: float,
    umap_metric: str,
    umap_random_state: int,
) -> np.ndarray:
    normalized = np.asarray(feature_matrix, dtype=float)
    if normalized.ndim != 2:
        raise ValueError(f"feature_matrix must be 2D, got {normalized.shape}.")
    if normalized.shape[0] < 3:
        raise ValueError("UMAP projection requires at least three geometries.")
    column_mean = np.mean(normalized, axis=0)
    column_std = np.std(normalized, axis=0)
    safe_column_std = np.where(column_std > 1.0e-12, column_std, 1.0)
    standardized = (normalized - column_mean) / safe_column_std
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
    coords = np.asarray(coords_2d, dtype=float)
    if coords.shape != (int(standardized.shape[0]), 2):
        raise ValueError(f"Projected UMAP coordinates must have shape [n_samples, 2], got {coords.shape}.")
    return coords


def build_windowed_soap_umap_projection(
    items: Sequence[SelectionItem],
    *,
    window_center_ev: float,
    window_width_ev: float,
    soap_atom_indices: Sequence[int] | None,
    soap_r_cut: float,
    soap_n_max: int,
    soap_l_max: int,
    soap_sigma: float,
    umap_n_neighbors: int,
    umap_min_dist: float,
    umap_metric: str,
    umap_random_state: int,
    feature_cache: MutableMapping[tuple[Any, ...], dict[str, Any]] | None = None,
) -> dict[str, Any]:
    if not items:
        raise ValueError("items must contain at least one distribution/profile selection.")

    window_min_ev, window_max_ev = _window_bounds(
        window_center_ev=float(window_center_ev),
        window_width_ev=float(window_width_ev),
    )
    feature_blocks: list[np.ndarray] = []
    selection_payloads: list[dict[str, Any]] = []
    distribution_payloads: list[dict[str, Any]] = []
    common_feature_dimension: int | None = None
    common_feature_kind = "soap_atomwise_pooled"
    common_atom_indices: list[int] | None = None

    for distribution_id, bundle, profile_id, profile in items:
        feature_payload = _get_or_build_pooled_soap_feature_payload(
            distribution_id=str(distribution_id),
            bundle=bundle,
            atom_indices=soap_atom_indices,
            soap_r_cut=float(soap_r_cut),
            soap_n_max=int(soap_n_max),
            soap_l_max=int(soap_l_max),
            soap_sigma=float(soap_sigma),
            feature_cache=feature_cache,
        )
        feature_matrix = np.asarray(feature_payload["feature_matrix"], dtype=float)
        if feature_matrix.ndim != 2 or feature_matrix.shape[0] != int(bundle.n_samples):
            raise ValueError(
                "SOAP feature matrix must align with the bundle sample count: "
                f"feature_matrix={feature_matrix.shape}, n_samples={bundle.n_samples}."
            )
        if common_feature_dimension is None:
            common_feature_dimension = int(feature_matrix.shape[1])
        elif int(feature_matrix.shape[1]) != int(common_feature_dimension):
            raise ValueError(
                "All pooled SOAP feature matrices must have the same width before joint projection: "
                f"expected={common_feature_dimension}, found={feature_matrix.shape[1]}."
            )
        common_atom_indices = list(feature_payload["atom_indices"])
        common_feature_kind = str(feature_payload["feature_kind"])
        feature_blocks.append(feature_matrix)

        selection_payload = compute_hard_window_selection(
            profile,
            window_center_ev=float(window_center_ev),
            window_width_ev=float(window_width_ev),
        )
        selection_payloads.append(selection_payload)
        hard_sample_mask = np.asarray(selection_payload["hard_sample_mask"], dtype=bool).reshape(-1)
        distribution_payloads.append(
            {
                "distribution_id": str(distribution_id),
                "distribution_label": str(bundle.label),
                "profile_id": str(profile_id),
                "profile_label": str(profile.label),
                "total_count": int(bundle.n_samples),
                "selected_count": int(np.count_nonzero(hard_sample_mask)),
                "selected_fraction": (
                    float(np.count_nonzero(hard_sample_mask)) / float(bundle.n_samples) if bundle.n_samples > 0 else 0.0
                ),
                "effective_sample_size": float(selection_payload["effective_sample_size"]),
                "dropped_count": 0,
            }
        )

    joint_feature_matrix = np.concatenate(feature_blocks, axis=0)
    coords_2d = _project_umap_feature_matrix(
        joint_feature_matrix,
        umap_n_neighbors=int(umap_n_neighbors),
        umap_min_dist=float(umap_min_dist),
        umap_metric=str(umap_metric),
        umap_random_state=int(umap_random_state),
    )

    points: list[dict[str, Any]] = []
    cursor = 0
    for (distribution_id, bundle, profile_id, profile), selection_payload in zip(items, selection_payloads, strict=True):
        next_cursor = cursor + int(bundle.n_samples)
        bundle_coords = np.asarray(coords_2d[cursor:next_cursor], dtype=float)
        if bundle_coords.shape != (int(bundle.n_samples), 2):
            raise ValueError(
                "Projected UMAP coordinates and bundle sample count must align: "
                f"coords={bundle_coords.shape}, n_samples={bundle.n_samples}."
            )
        sample_window_weights = np.asarray(selection_payload["sample_window_weights"], dtype=float).reshape(-1)
        normalized_weights = np.asarray(selection_payload["normalized_sample_window_weights"], dtype=float).reshape(-1)
        hard_sample_mask = np.asarray(selection_payload["hard_sample_mask"], dtype=bool).reshape(-1)
        for sample_index in range(int(bundle.n_samples)):
            sample_id = (
                str(bundle.sample_ids[sample_index])
                if sample_index < len(bundle.sample_ids)
                else f"sample_{sample_index:06d}"
            )
            points.append(
                {
                    "distribution_id": str(distribution_id),
                    "distribution_label": str(bundle.label),
                    "profile_id": str(profile_id),
                    "profile_label": str(profile.label),
                    "sample_index": int(sample_index),
                    "sample_id": sample_id,
                    "x": float(bundle_coords[sample_index, 0]),
                    "y": float(bundle_coords[sample_index, 1]),
                    "selection_weight": float(sample_window_weights[sample_index]),
                    "normalized_selection_weight": float(normalized_weights[sample_index]),
                    "hard_selected": bool(hard_sample_mask[sample_index]),
                }
            )
        cursor = next_cursor

    return {
        "points": points,
        "projection_meta": {
            "method": "umap",
            "feature_kind": common_feature_kind,
            "axis_labels": ["UMAP 1", "UMAP 2"],
            "feature_dimension": int(common_feature_dimension or 0),
            "soap_atom_indices": list(common_atom_indices or []),
            "soap_r_cut": float(soap_r_cut),
            "soap_n_max": int(soap_n_max),
            "soap_l_max": int(soap_l_max),
            "soap_sigma": float(soap_sigma),
            "umap_n_neighbors": int(umap_n_neighbors),
            "umap_min_dist": float(umap_min_dist),
            "umap_metric": str(umap_metric),
            "umap_random_state": int(umap_random_state),
        },
        "selection_meta": {
            "window_center_ev": float(window_center_ev),
            "window_width_ev": float(window_width_ev),
            "window_min_ev": float(window_min_ev),
            "window_max_ev": float(window_max_ev),
            "selection_mode": SELECTION_MODE_HARD_WINDOW_STRENGTH,
            "topology_signature": str(items[0][1].topology_signature),
        },
        "distributions": distribution_payloads,
    }


def build_soap_umap_projection(
    bundles: Sequence[BundleItem],
    *,
    soap_atom_indices: Sequence[int] | None,
    soap_r_cut: float,
    soap_n_max: int,
    soap_l_max: int,
    soap_sigma: float,
    umap_n_neighbors: int,
    umap_min_dist: float,
    umap_metric: str,
    umap_random_state: int,
    feature_cache: MutableMapping[tuple[Any, ...], dict[str, Any]] | None = None,
) -> dict[str, Any]:
    if not bundles:
        raise ValueError("bundles must contain at least one distribution.")

    feature_blocks: list[np.ndarray] = []
    distribution_payloads: list[dict[str, Any]] = []
    common_feature_dimension: int | None = None
    common_feature_kind = "soap_atomwise_pooled"
    common_atom_indices: list[int] | None = None

    for distribution_id, bundle in bundles:
        feature_payload = _get_or_build_pooled_soap_feature_payload(
            distribution_id=str(distribution_id),
            bundle=bundle,
            atom_indices=soap_atom_indices,
            soap_r_cut=float(soap_r_cut),
            soap_n_max=int(soap_n_max),
            soap_l_max=int(soap_l_max),
            soap_sigma=float(soap_sigma),
            feature_cache=feature_cache,
        )
        feature_matrix = np.asarray(feature_payload["feature_matrix"], dtype=float)
        if feature_matrix.ndim != 2 or feature_matrix.shape[0] != int(bundle.n_samples):
            raise ValueError(
                "SOAP feature matrix must align with the bundle sample count: "
                f"feature_matrix={feature_matrix.shape}, n_samples={bundle.n_samples}."
            )
        if common_feature_dimension is None:
            common_feature_dimension = int(feature_matrix.shape[1])
        elif int(feature_matrix.shape[1]) != int(common_feature_dimension):
            raise ValueError(
                "All pooled SOAP feature matrices must have the same width before joint projection: "
                f"expected={common_feature_dimension}, found={feature_matrix.shape[1]}."
            )
        common_atom_indices = list(feature_payload["atom_indices"])
        common_feature_kind = str(feature_payload["feature_kind"])
        feature_blocks.append(feature_matrix)
        distribution_payloads.append(
            {
                "distribution_id": str(distribution_id),
                "distribution_label": str(bundle.label),
                "profile_id": NO_SELECTION_PROFILE_ID,
                "profile_label": NO_SELECTION_PROFILE_LABEL,
                "total_count": int(bundle.n_samples),
                "selected_count": 0,
                "selected_fraction": 0.0,
                "effective_sample_size": 0.0,
                "dropped_count": 0,
            }
        )

    joint_feature_matrix = np.concatenate(feature_blocks, axis=0)
    coords_2d = _project_umap_feature_matrix(
        joint_feature_matrix,
        umap_n_neighbors=int(umap_n_neighbors),
        umap_min_dist=float(umap_min_dist),
        umap_metric=str(umap_metric),
        umap_random_state=int(umap_random_state),
    )

    points: list[dict[str, Any]] = []
    cursor = 0
    for distribution_id, bundle in bundles:
        next_cursor = cursor + int(bundle.n_samples)
        bundle_coords = np.asarray(coords_2d[cursor:next_cursor], dtype=float)
        if bundle_coords.shape != (int(bundle.n_samples), 2):
            raise ValueError(
                "Projected UMAP coordinates and bundle sample count must align: "
                f"coords={bundle_coords.shape}, n_samples={bundle.n_samples}."
            )
        for sample_index in range(int(bundle.n_samples)):
            sample_id = (
                str(bundle.sample_ids[sample_index])
                if sample_index < len(bundle.sample_ids)
                else f"sample_{sample_index:06d}"
            )
            points.append(
                {
                    "distribution_id": str(distribution_id),
                    "distribution_label": str(bundle.label),
                    "profile_id": NO_SELECTION_PROFILE_ID,
                    "profile_label": NO_SELECTION_PROFILE_LABEL,
                    "sample_index": int(sample_index),
                    "sample_id": sample_id,
                    "x": float(bundle_coords[sample_index, 0]),
                    "y": float(bundle_coords[sample_index, 1]),
                    "selection_weight": 0.0,
                    "normalized_selection_weight": 0.0,
                    "hard_selected": False,
                }
            )
        cursor = next_cursor

    return {
        "points": points,
        "projection_meta": {
            "method": "umap",
            "feature_kind": common_feature_kind,
            "axis_labels": ["UMAP 1", "UMAP 2"],
            "feature_dimension": int(common_feature_dimension or 0),
            "soap_atom_indices": list(common_atom_indices or []),
            "soap_r_cut": float(soap_r_cut),
            "soap_n_max": int(soap_n_max),
            "soap_l_max": int(soap_l_max),
            "soap_sigma": float(soap_sigma),
            "umap_n_neighbors": int(umap_n_neighbors),
            "umap_min_dist": float(umap_min_dist),
            "umap_metric": str(umap_metric),
            "umap_random_state": int(umap_random_state),
        },
        "selection_meta": {
            "window_center_ev": None,
            "window_width_ev": None,
            "window_min_ev": None,
            "window_max_ev": None,
            "selection_mode": SELECTION_MODE_NONE,
            "topology_signature": str(bundles[0][1].topology_signature),
        },
        "distributions": distribution_payloads,
    }
