from __future__ import annotations

from pathlib import Path
from typing import Callable

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from backend.server.app_state import AppState
from backend.server.cache import SeriesLRUCache
from backend.server.dataset_store import DatasetStore
from backend.server.routers import (
    build_dataset_router,
    build_distributions_router,
    build_health_router,
    build_md_router,
    build_mol3d_router,
    build_normal_modes_router,
    build_pages_router,
    build_series_router,
)


def create_app(
    store: DatasetStore,
    cache: SeriesLRUCache,
    mol3d_cache: SeriesLRUCache | None = None,
    *,
    api_base: str = "/api",
    load_store_from_path: Callable[[Path], DatasetStore] | None = None,
    browse_root: Path | None = None,
) -> FastAPI:
    api_base = api_base.rstrip("/") or "/api"
    if mol3d_cache is None:
        mol3d_cache = cache

    project_root = Path(__file__).parent.parent.parent
    frontend_dir = project_root / "frontend"
    frontend_public = frontend_dir / "public"

    state = AppState(
        store=store,
        cache=cache,
        mol3d_cache=mol3d_cache,
        api_base=api_base,
        load_store_from_path=load_store_from_path,
        browse_root=browse_root,
        frontend_dir=frontend_dir,
        frontend_public=frontend_public,
    )

    app = FastAPI(title="Observable Dashboard API", version="1.0.0")

    if frontend_public.exists():
        app.mount("/assets", StaticFiles(directory=str(frontend_public / "assets")), name="assets")

    app.include_router(build_pages_router(state))
    app.include_router(build_health_router(state))
    app.include_router(build_normal_modes_router(state))
    app.include_router(build_md_router(state))
    app.include_router(build_distributions_router(state))
    app.include_router(build_dataset_router(state))
    app.include_router(build_series_router(state))
    app.include_router(build_mol3d_router(state))

    return app
