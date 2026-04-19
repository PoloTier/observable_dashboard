from __future__ import annotations

from fastapi import APIRouter, Body, HTTPException, Query
from fastapi.responses import Response

from backend.server.app_helpers import path_matches_suffixes
from backend.server.app_state import AppState
from backend.server.models import LoadTrajectorySourcePathRequest
from backend.server.trajectory_sampling import build_trajectory_geometry_export_bundle

MD_SOURCE_SUFFIXES = frozenset({".xyz"})
PIMD_SOURCE_SUFFIXES = frozenset({".h5", ".hdf5"})


def build_md_router(state: AppState) -> APIRouter:
    router = APIRouter(prefix=state.api_base)

    @router.post("/md/export-geometry-bundle")
    def export_md_geometry_bundle(
        source_kind: str = Query(..., min_length=1),
        source_name: str = Query(..., min_length=1),
        start_frame: int = Query(..., ge=0),
        end_frame: int | None = Query(default=None, ge=0),
        frame_stride: int = Query(default=1, ge=1),
        charge: int = Query(default=0),
        multiplicity: int = Query(default=1, ge=1),
        bead_start: int | None = Query(default=None, ge=0),
        bead_end: int | None = Query(default=None, ge=0),
        bead_stride: int = Query(default=1, ge=1),
        source_bytes: bytes = Body(...),
    ) -> Response:
        try:
            file_name, archive_bytes = build_trajectory_geometry_export_bundle(
                source_kind=str(source_kind),
                source_name=str(source_name),
                source_bytes=bytes(source_bytes),
                start_frame=int(start_frame),
                end_frame=(None if end_frame is None else int(end_frame)),
                frame_stride=int(frame_stride),
                charge=int(charge),
                multiplicity=int(multiplicity),
                bead_start=(None if bead_start is None else int(bead_start)),
                bead_end=(None if bead_end is None else int(bead_end)),
                bead_stride=int(bead_stride),
            )
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"Failed to export trajectory geometry bundle: {exc}") from exc

        return Response(
            content=archive_bytes,
            media_type="application/gzip",
            headers={
                "Content-Disposition": f'attachment; filename="{file_name}"',
            },
        )

    @router.post("/md/load-xyz-path")
    def load_md_xyz_source_path(req: LoadTrajectorySourcePathRequest) -> Response:
        target_path = state.resolve_manual_source_path(req.path)
        if not path_matches_suffixes(target_path, MD_SOURCE_SUFFIXES):
            raise HTTPException(status_code=422, detail="Only .xyz files can be loaded.")

        try:
            source_bytes = target_path.read_bytes()
        except OSError as exc:
            raise HTTPException(status_code=500, detail=f"Failed to read XYZ source: {exc}") from exc

        return Response(content=source_bytes, media_type="text/plain")

    @router.post("/md/load-pimd-path")
    def load_pimd_source_path(req: LoadTrajectorySourcePathRequest) -> Response:
        target_path = state.resolve_manual_source_path(req.path)
        if not path_matches_suffixes(target_path, PIMD_SOURCE_SUFFIXES):
            raise HTTPException(status_code=422, detail="Only .h5 and .hdf5 files can be loaded.")

        try:
            source_bytes = target_path.read_bytes()
        except OSError as exc:
            raise HTTPException(status_code=500, detail=f"Failed to read PIMD source: {exc}") from exc

        return Response(content=source_bytes, media_type="application/octet-stream")

    return router
