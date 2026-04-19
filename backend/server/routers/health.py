from __future__ import annotations

from fastapi import APIRouter

from backend.server.app_helpers import dataset_is_loaded
from backend.server.app_state import AppState
from backend.server.models import BootstrapResponse, HealthzResponse


def build_health_router(state: AppState) -> APIRouter:
    router = APIRouter(prefix=state.api_base)

    @router.get("/healthz", response_model=HealthzResponse)
    def healthz() -> HealthzResponse:
        current_store, _, _ = state.get_runtime_snapshot()
        return HealthzResponse(
            status="ok",
            dataset_loaded=dataset_is_loaded(current_store),
            traj_count=len(current_store.traj_ids),
        )

    @router.get("/bootstrap", response_model=BootstrapResponse)
    def get_bootstrap() -> BootstrapResponse:
        _, bootstrap, _ = state.get_runtime_snapshot()
        return BootstrapResponse(**bootstrap)

    return router
