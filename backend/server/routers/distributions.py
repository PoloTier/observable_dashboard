from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body, HTTPException

from backend.server.app_state import AppState
from backend.server.distribution_analysis import (
    build_soap_umap_projection,
    build_windowed_geometry_comparison,
    build_windowed_soap_umap_projection,
)
from backend.server.distribution_bundle import (
    DistributionBundle,
    compute_absorption_spectrum,
    compute_geometry_distribution,
    is_distribution_bundle_directory,
    load_distribution_bundle,
    load_distribution_bundle_from_directory,
)
from backend.server.models import (
    DistributionCompareGeometryRequest,
    DistributionCompareGeometryResponse,
    DistributionCompareGeometryWindowRequest,
    DistributionCompareGeometryWindowResponse,
    DistributionCompareSpectrumRequest,
    DistributionCompareSpectrumResponse,
    DistributionDeleteResponse,
    DistributionListItem,
    DistributionListResponse,
    DistributionSoapUmapRequest,
    DistributionSoapUmapWindowRequest,
    DistributionSoapUmapWindowResponse,
    DistributionSpectrumPairCurve,
    DistributionSpectrumSeries,
    DistributionSpectrumSkippedItem,
    FileBrowserResponse,
    LoadDistributionPathRequest,
)


def build_distributions_router(state: AppState) -> APIRouter:
    router = APIRouter(prefix=state.api_base)

    @router.post("/distributions/load", response_model=DistributionListItem)
    def load_distribution_via_upload(
        bundle_bytes: bytes = Body(...),
        filename: str = "distribution_bundle.tar.gz",
    ) -> DistributionListItem:
        try:
            bundle = load_distribution_bundle(bundle_bytes, filename=str(filename))
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"Failed to load distribution bundle: {exc}") from exc
        return DistributionListItem(**state.store_distribution(bundle))

    @router.get("/distributions/files", response_model=FileBrowserResponse)
    def list_distribution_files(path: str | None = None) -> FileBrowserResponse:
        current_dir = state.resolve_browse_path(path)
        if not current_dir.is_dir():
            raise HTTPException(status_code=422, detail=f"Path is not a directory: {path or '.'}")
        return state.build_file_browser_response(
            current_dir,
            is_loadable=lambda child, kind: kind == "directory" and is_distribution_bundle_directory(child),
        )

    @router.post("/distributions/load-path", response_model=DistributionListItem)
    def load_distribution_from_path(req: LoadDistributionPathRequest) -> DistributionListItem:
        target_path = state.resolve_browse_path(req.path)
        if not target_path.is_dir():
            raise HTTPException(status_code=422, detail=f"Path is not a directory: {req.path}")

        try:
            bundle = load_distribution_bundle_from_directory(target_path)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"Failed to load distribution bundle: {exc}") from exc
        return DistributionListItem(**state.store_distribution(bundle))

    @router.get("/distributions", response_model=DistributionListResponse)
    def list_loaded_distributions() -> DistributionListResponse:
        return DistributionListResponse(distributions=state.list_loaded_distribution_payloads())

    @router.delete("/distributions/{distribution_id}", response_model=DistributionDeleteResponse)
    def delete_loaded_distribution(distribution_id: str) -> DistributionDeleteResponse:
        deleted = state.delete_distribution(str(distribution_id))
        if not deleted:
            raise HTTPException(status_code=404, detail=f"Distribution not found: {distribution_id}")
        return DistributionDeleteResponse(status="ok", distribution_id=str(distribution_id))

    @router.post("/distributions/compare-geometry", response_model=DistributionCompareGeometryResponse)
    def compare_distribution_geometry(
        req: DistributionCompareGeometryRequest,
    ) -> DistributionCompareGeometryResponse:
        distribution_ids = state.normalize_distribution_ids(req.distribution_ids)
        if not distribution_ids:
            raise HTTPException(status_code=422, detail="distribution_ids must contain at least one valid item.")

        bundles: list[tuple[str, DistributionBundle]] = []
        topology_signature: str | None = None
        for distribution_id in distribution_ids:
            bundle = state.get_distribution_or_404(distribution_id)
            if topology_signature is None:
                topology_signature = str(bundle.topology_signature)
            elif str(bundle.topology_signature) != topology_signature:
                raise HTTPException(
                    status_code=422,
                    detail=(
                        "Geometry comparison requires identical topology_signature across all active distributions."
                    ),
                )
            bundles.append((distribution_id, bundle))

        series_payloads: list[dict[str, Any]] = []
        response_unit = ""
        for distribution_id, bundle in bundles:
            try:
                measurement_payload = compute_geometry_distribution(
                    bundle,
                    measurement_kind=str(req.measurement_kind),
                    atom_indices=[int(value) for value in req.atom_indices],
                )
            except ValueError as exc:
                raise HTTPException(status_code=422, detail=str(exc)) from exc
            response_unit = str(measurement_payload["unit"])
            series_payloads.append(
                {
                    "distribution_id": str(distribution_id),
                    "label": str(bundle.label),
                    "source_name": str(bundle.source_name),
                    "values": list(measurement_payload["values"]),
                    "sample_count": int(measurement_payload["sample_count"]),
                    "min": float(measurement_payload["min"]),
                    "max": float(measurement_payload["max"]),
                    "mean": float(measurement_payload["mean"]),
                    "std": float(measurement_payload["std"]),
                }
            )

        return DistributionCompareGeometryResponse(
            measurement_kind=str(req.measurement_kind),
            atom_indices=[int(value) for value in req.atom_indices],
            unit=response_unit,
            bins=int(req.bins),
            topology_signature=str(topology_signature or ""),
            series=series_payloads,
        )

    @router.post(
        "/distributions/compare-geometry-window",
        response_model=DistributionCompareGeometryWindowResponse,
    )
    def compare_distribution_geometry_window(
        req: DistributionCompareGeometryWindowRequest,
    ) -> DistributionCompareGeometryWindowResponse:
        selection_items = state.normalize_distribution_selection_items(req.items)
        if not selection_items:
            raise HTTPException(status_code=422, detail="items must contain at least one valid distribution/profile pair.")

        cache_key = (
            "distribution_geometry_window",
            tuple(selection_items),
            str(req.measurement_kind),
            tuple(int(value) for value in req.atom_indices),
            int(req.bins),
            round(float(req.window_center_ev), 8),
            round(float(req.window_width_ev), 8),
        )
        cached_value = state.distribution_analysis_cache.get(cache_key)
        if cached_value is not None:
            return DistributionCompareGeometryWindowResponse(**cached_value)

        resolved_items = state.collect_distribution_selection_items(selection_items)
        try:
            payload = build_windowed_geometry_comparison(
                resolved_items,
                measurement_kind=str(req.measurement_kind),
                atom_indices=[int(value) for value in req.atom_indices],
                bins=int(req.bins),
                window_center_ev=float(req.window_center_ev),
                window_width_ev=float(req.window_width_ev),
            )
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"Failed to compute windowed geometry comparison: {exc}") from exc

        state.distribution_analysis_cache.put(cache_key, payload)
        return DistributionCompareGeometryWindowResponse(**payload)

    @router.post(
        "/distributions/project-soap-umap",
        response_model=DistributionSoapUmapWindowResponse,
    )
    def project_distribution_soap_umap(
        req: DistributionSoapUmapRequest,
    ) -> DistributionSoapUmapWindowResponse:
        distribution_ids = state.normalize_distribution_ids(req.distribution_ids)
        if not distribution_ids:
            raise HTTPException(status_code=422, detail="distribution_ids must contain at least one valid item.")

        soap_atom_indices = [int(value) for value in req.soap_atom_indices]
        cache_key = (
            "distribution_soap_umap",
            tuple(distribution_ids),
            tuple(soap_atom_indices),
            round(float(req.soap_r_cut), 8),
            int(req.soap_n_max),
            int(req.soap_l_max),
            round(float(req.soap_sigma), 8),
            int(req.umap_n_neighbors),
            round(float(req.umap_min_dist), 8),
            str(req.umap_metric).strip().lower(),
            int(req.umap_random_state),
        )
        cached_value = state.distribution_projection_cache.get(cache_key)
        if cached_value is not None:
            return DistributionSoapUmapWindowResponse(**cached_value)

        bundles = state.collect_distribution_bundles(distribution_ids)
        try:
            with state.soap_feature_cache_lock:
                payload = build_soap_umap_projection(
                    bundles,
                    soap_atom_indices=(soap_atom_indices or None),
                    soap_r_cut=float(req.soap_r_cut),
                    soap_n_max=int(req.soap_n_max),
                    soap_l_max=int(req.soap_l_max),
                    soap_sigma=float(req.soap_sigma),
                    umap_n_neighbors=int(req.umap_n_neighbors),
                    umap_min_dist=float(req.umap_min_dist),
                    umap_metric=str(req.umap_metric),
                    umap_random_state=int(req.umap_random_state),
                    feature_cache=state.soap_feature_cache,
                )
        except ModuleNotFoundError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"Failed to compute SOAP UMAP projection: {exc}") from exc

        state.distribution_projection_cache.put(cache_key, payload)
        return DistributionSoapUmapWindowResponse(**payload)

    @router.post(
        "/distributions/project-soap-umap-window",
        response_model=DistributionSoapUmapWindowResponse,
    )
    def project_distribution_soap_umap_window(
        req: DistributionSoapUmapWindowRequest,
    ) -> DistributionSoapUmapWindowResponse:
        selection_items = state.normalize_distribution_selection_items(req.items)
        if not selection_items:
            raise HTTPException(status_code=422, detail="items must contain at least one valid distribution/profile pair.")

        soap_atom_indices = [int(value) for value in req.soap_atom_indices]
        cache_key = (
            "distribution_soap_umap_window",
            tuple(selection_items),
            round(float(req.window_center_ev), 8),
            round(float(req.window_width_ev), 8),
            tuple(soap_atom_indices),
            round(float(req.soap_r_cut), 8),
            int(req.soap_n_max),
            int(req.soap_l_max),
            round(float(req.soap_sigma), 8),
            int(req.umap_n_neighbors),
            round(float(req.umap_min_dist), 8),
            str(req.umap_metric).strip().lower(),
            int(req.umap_random_state),
        )
        cached_value = state.distribution_projection_cache.get(cache_key)
        if cached_value is not None:
            return DistributionSoapUmapWindowResponse(**cached_value)

        resolved_items = state.collect_distribution_selection_items(selection_items)
        try:
            with state.soap_feature_cache_lock:
                payload = build_windowed_soap_umap_projection(
                    resolved_items,
                    window_center_ev=float(req.window_center_ev),
                    window_width_ev=float(req.window_width_ev),
                    soap_atom_indices=(soap_atom_indices or None),
                    soap_r_cut=float(req.soap_r_cut),
                    soap_n_max=int(req.soap_n_max),
                    soap_l_max=int(req.soap_l_max),
                    soap_sigma=float(req.soap_sigma),
                    umap_n_neighbors=int(req.umap_n_neighbors),
                    umap_min_dist=float(req.umap_min_dist),
                    umap_metric=str(req.umap_metric),
                    umap_random_state=int(req.umap_random_state),
                    feature_cache=state.soap_feature_cache,
                )
        except ModuleNotFoundError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"Failed to compute SOAP UMAP projection: {exc}") from exc

        state.distribution_projection_cache.put(cache_key, payload)
        return DistributionSoapUmapWindowResponse(**payload)

    @router.post("/distributions/compare-spectrum", response_model=DistributionCompareSpectrumResponse)
    def compare_distribution_spectrum(
        req: DistributionCompareSpectrumRequest,
    ) -> DistributionCompareSpectrumResponse:
        series_items = state.normalize_spectrum_series_request_items(req.series)
        if not series_items:
            raise HTTPException(status_code=422, detail="series must contain at least one valid item.")

        comparable_series, skipped_payloads, excitation_energy_sets_ev = state.collect_comparable_spectrum_series(
            series_items
        )

        if not comparable_series:
            raise HTTPException(
                status_code=422,
                detail="No selected spectrum series with valid electronic transitions are available for spectrum comparison.",
            )

        available_pairs = state.collect_common_spectrum_pairs(comparable_series)

        x_energy_ev = state.build_absorption_energy_grid(
            excitation_energy_sets_ev=excitation_energy_sets_ev,
            delta_ev=float(req.delta_ev),
        )

        series_payloads: list[DistributionSpectrumSeries] = []
        for distribution_id, bundle, profile_id, profile in comparable_series:
            try:
                spectrum_payload = compute_absorption_spectrum(
                    profile,
                    x_energy_ev=x_energy_ev,
                    delta_ev=float(req.delta_ev),
                    pair_overlays=available_pairs,
                )
            except ValueError as exc:
                skipped_payloads.append(
                    {
                        "distribution_id": str(distribution_id),
                        "distribution_label": str(bundle.label),
                        "profile_id": str(profile_id),
                        "profile_label": str(profile.label),
                        "reason": str(exc),
                    }
                )
                continue

            series_payloads.append(
                DistributionSpectrumSeries(
                    distribution_id=str(distribution_id),
                    distribution_label=str(bundle.label),
                    source_name=str(bundle.source_name),
                    profile_id=str(profile_id),
                    profile_label=str(profile.label),
                    series_label=state.build_series_label(bundle=bundle, profile=profile),
                    total_y_normalized=[float(value) for value in spectrum_payload["total_y_normalized"]],
                    pair_curves=[
                        DistributionSpectrumPairCurve(
                            pair=[int(value) for value in pair_payload["pair"]],
                            y_normalized=[float(value) for value in pair_payload["y_normalized"]],
                        )
                        for pair_payload in spectrum_payload["pair_curves"]
                    ],
                )
            )

        if not series_payloads:
            raise HTTPException(
                status_code=422,
                detail="No selected spectrum series could be rendered into an absorption spectrum.",
            )

        return DistributionCompareSpectrumResponse(
            delta_ev=float(req.delta_ev),
            x_energy_ev=[float(value) for value in x_energy_ev.tolist()],
            available_pairs=state.build_transition_pair_options(available_pairs),
            series=series_payloads,
            skipped=[DistributionSpectrumSkippedItem(**item) for item in skipped_payloads],
        )

    return router
