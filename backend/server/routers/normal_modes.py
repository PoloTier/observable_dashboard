from __future__ import annotations

import secrets
import time

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response

from backend.server.app_helpers import relative_path_text
from backend.server.app_state import AppState
from backend.server.models import (
    NormalModesGeometrySaveRequest,
    NormalModesGeometrySaveResponse,
    NormalModesMeasurementRequest,
    NormalModesMeasurementResponse,
    NormalModesParseTextRequest,
    NormalModesParseTextResponse,
    NormalModesSampleTextRequest,
    NormalModesSampleTextResponse,
)
from backend.server.molden import parse_molden_normal_modes
from backend.server.normal_modes_sampling import (
    build_normal_modes_export_bundle,
    build_normal_modes_geometry_export_bundle,
    build_normal_modes_geometry_export_entries,
    compute_measurement_values_from_batch,
    prepare_sampling_inputs,
    sample_normal_modes,
    utc_now_iso,
)


def build_normal_modes_router(state: AppState) -> APIRouter:
    router = APIRouter(prefix=state.api_base)
    sample_cache = state.normal_modes_sample_cache

    @router.post("/normal-modes/parse-text", response_model=NormalModesParseTextResponse)
    def parse_normal_modes_text(req: NormalModesParseTextRequest) -> NormalModesParseTextResponse:
        try:
            payload = parse_molden_normal_modes(req.content, source_name=req.filename)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"Failed to parse molden content: {exc}") from exc
        return NormalModesParseTextResponse(**payload)

    @router.post("/normal-modes/sample-text", response_model=NormalModesSampleTextResponse)
    def sample_normal_modes_text(req: NormalModesSampleTextRequest) -> NormalModesSampleTextResponse:
        request_received_at_utc = utc_now_iso()
        started_at = time.perf_counter()
        try:
            parsed_payload = parse_molden_normal_modes(req.content, source_name=req.filename)
            preparation = prepare_sampling_inputs(parsed_payload)
            sample_payload = sample_normal_modes(
                preparation,
                sample_count=int(req.sample_count),
                preview_count=int(req.preview_count),
                charge=int(req.charge),
                multiplicity=int(req.multiplicity),
                position_default=str(req.position_default),
                momentum_default=str(req.momentum_default),
                temperature_k=(None if req.temperature_k is None else float(req.temperature_k)),
                seed=req.seed,
                freq_min_cm1=(None if req.freq_min_cm1 is None else float(req.freq_min_cm1)),
                freq_max_cm1=(None if req.freq_max_cm1 is None else float(req.freq_max_cm1)),
                rules=[item.model_dump() for item in req.rules],
            )
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"Failed to sample normal modes: {exc}") from exc

        sampling_completed_at_utc = utc_now_iso()
        sampling_duration_ms = int(round((time.perf_counter() - started_at) * 1000.0))
        batch_id = f"nm-sample-{secrets.token_urlsafe(12)}"
        response_payload = dict(sample_payload["response_payload"])
        normalized_request = req.model_dump(exclude={"content"})
        normalized_request["filename"] = str(parsed_payload.get("source_name") or req.filename)
        normalized_request["seed"] = int(response_payload["seed"])
        normalized_request["preview_count_requested"] = int(req.preview_count)
        normalized_request["preview_count_effective"] = int(response_payload["preview_count"])
        batch_payload = dict(sample_payload["batch_payload"])
        batch_payload["batch_id"] = str(batch_id)
        batch_payload["source_content"] = str(req.content)
        batch_payload["request_snapshot"] = normalized_request
        batch_payload["request_received_at_utc"] = str(request_received_at_utc)
        batch_payload["sampling_completed_at_utc"] = str(sampling_completed_at_utc)
        batch_payload["sampling_duration_ms"] = int(sampling_duration_ms)
        batch_payload["source_name"] = str(parsed_payload.get("source_name") or req.filename)
        sample_cache.put(("normal_modes_sample_batch", batch_id), batch_payload)
        response_payload["batch_id"] = str(batch_id)
        response_payload["sampling_completed_at_utc"] = str(sampling_completed_at_utc)
        return NormalModesSampleTextResponse(**response_payload)

    @router.post(
        "/normal-modes/sample-batches/{batch_id}/measurements",
        response_model=NormalModesMeasurementResponse,
    )
    def measure_normal_modes_batch(
        batch_id: str,
        req: NormalModesMeasurementRequest,
    ) -> NormalModesMeasurementResponse:
        cache_key = ("normal_modes_sample_batch", str(batch_id))
        batch_payload = sample_cache.get(cache_key)
        if batch_payload is None:
            raise HTTPException(status_code=404, detail=f"Normal-modes sample batch not found: {batch_id}")

        try:
            measurement_payload = compute_measurement_values_from_batch(
                batch_payload,
                measurement_kind=str(req.measurement_kind),
                atom_indices=[int(v) for v in req.atom_indices],
            )
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"Failed to compute sample measurement: {exc}") from exc

        measurement_payload["batch_id"] = str(batch_id)
        return NormalModesMeasurementResponse(**measurement_payload)

    @router.get("/normal-modes/sample-batches/{batch_id}/export")
    def export_normal_modes_batch(batch_id: str) -> Response:
        cache_key = ("normal_modes_sample_batch", str(batch_id))
        batch_payload = sample_cache.get(cache_key)
        if batch_payload is None:
            raise HTTPException(status_code=404, detail=f"Normal-modes sample batch not found: {batch_id}")

        try:
            file_name, archive_bytes = build_normal_modes_export_bundle(
                batch_id=str(batch_id),
                batch_payload=batch_payload,
            )
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"Failed to export sample batch: {exc}") from exc

        return Response(
            content=archive_bytes,
            media_type="application/gzip",
            headers={
                "Content-Disposition": f'attachment; filename="{file_name}"',
            },
        )

    @router.get("/normal-modes/sample-batches/{batch_id}/export-geometry")
    def export_normal_modes_geometry_batch(batch_id: str) -> Response:
        cache_key = ("normal_modes_sample_batch", str(batch_id))
        batch_payload = sample_cache.get(cache_key)
        if batch_payload is None:
            raise HTTPException(status_code=404, detail=f"Normal-modes sample batch not found: {batch_id}")

        try:
            file_name, archive_bytes = build_normal_modes_geometry_export_bundle(
                batch_id=str(batch_id),
                batch_payload=batch_payload,
            )
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"Failed to export geometry sample bundle: {exc}") from exc

        return Response(
            content=archive_bytes,
            media_type="application/gzip",
            headers={
                "Content-Disposition": f'attachment; filename="{file_name}"',
            },
        )

    @router.post(
        "/normal-modes/sample-batches/{batch_id}/export-geometry/save",
        response_model=NormalModesGeometrySaveResponse,
    )
    def save_normal_modes_geometry_batch(
        batch_id: str,
        req: NormalModesGeometrySaveRequest,
    ) -> NormalModesGeometrySaveResponse:
        cache_key = ("normal_modes_sample_batch", str(batch_id))
        batch_payload = sample_cache.get(cache_key)
        if batch_payload is None:
            raise HTTPException(status_code=404, detail=f"Normal-modes sample batch not found: {batch_id}")

        try:
            default_file_name, bundle_entries = build_normal_modes_geometry_export_entries(
                batch_id=str(batch_id),
                batch_payload=batch_payload,
            )
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"Failed to export geometry sample bundle: {exc}") from exc

        target_dir = state.resolve_browse_output_directory(req.directory)
        directory_name = state.normalize_export_directory_name(req.filename, fallback=default_file_name)
        if target_dir.exists() and not target_dir.is_dir():
            raise HTTPException(status_code=422, detail=f"Target directory is not a directory: {req.directory}")

        try:
            target_dir.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise HTTPException(status_code=500, detail=f"Failed to create target directory: {exc}") from exc

        try:
            target_dir.relative_to(state.browse_root_resolved)
        except ValueError as exc:
            raise HTTPException(status_code=403, detail="Requested path is outside the browse root.") from exc

        target_path = state.write_bundle_entries_to_directory(
            target_dir,
            directory_name=directory_name,
            entries=bundle_entries,
        )

        return NormalModesGeometrySaveResponse(
            status="ok",
            saved_relative_path=relative_path_text(state.browse_root_resolved, target_path),
            saved_absolute_path=str(target_path),
        )

    return router
