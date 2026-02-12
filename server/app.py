from __future__ import annotations

from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles

from ..config import ALLOWED_OBSERVABLES, required_index_count
from ..renderer import STATIC_DIR, _json_html_safe, _render_html
from .cache import SeriesLRUCache
from .compute import compute_observable_series
from .dataset_store import DatasetStore
from .models import (
    BootstrapResponse,
    HealthzResponse,
    MoleculeTrajectoryResponse,
    SeriesRequest,
    SeriesResponse,
)


def _normalize_indices(indices: list[int]) -> list[int]:
    out: list[int] = []
    for idx in indices:
        out.append(int(idx))
    return out


def _validate_request(
    *,
    observable: str,
    indices: list[int],
    n_atoms: int,
) -> None:
    if observable not in ALLOWED_OBSERVABLES:
        raise HTTPException(status_code=400, detail=f"Unsupported observable: {observable}")

    required = required_index_count(observable)
    if len(indices) != required:
        raise HTTPException(
            status_code=400,
            detail=f"Observable '{observable}' requires {required} indices, got {len(indices)}",
        )

    if any(idx < 0 for idx in indices):
        raise HTTPException(status_code=400, detail="Indices must be non-negative integers")

    if required > 0 and max(indices) >= n_atoms:
        raise HTTPException(
            status_code=422,
            detail=f"Index out of bounds for observable '{observable}': max valid index is {n_atoms - 1}",
        )


def create_app(
    store: DatasetStore,
    cache: SeriesLRUCache,
    mol3d_cache: SeriesLRUCache | None = None,
    *,
    api_base: str = "/api",
) -> FastAPI:
    api_base = api_base.rstrip("/") or "/api"
    bootstrap = store.to_bootstrap(api_base=api_base)
    if mol3d_cache is None:
        mol3d_cache = cache

    app = FastAPI(title="Observable Dashboard API", version="1.0.0")
    app.mount("/assets", StaticFiles(directory=str(STATIC_DIR)), name="assets")

    @app.get("/", response_class=HTMLResponse)
    def index_page() -> HTMLResponse:
        html = _render_html(
            "index.html.j2",
            bootstrap_json=_json_html_safe(bootstrap),
        )
        return HTMLResponse(html)

    @app.get("/index.html", response_class=HTMLResponse)
    def index_page_alias() -> HTMLResponse:
        return index_page()

    @app.get("/molecule3d.html", response_class=HTMLResponse)
    def molecule3d_page() -> HTMLResponse:
        html = _render_html(
            "molecule3d.html.j2",
            bootstrap_json=_json_html_safe(bootstrap),
        )
        return HTMLResponse(html)

    @app.get(f"{api_base}/healthz", response_model=HealthzResponse)
    def healthz() -> HealthzResponse:
        return HealthzResponse(
            status="ok",
            dataset_loaded=True,
            traj_count=len(store.traj_ids),
        )

    @app.get(f"{api_base}/bootstrap", response_model=BootstrapResponse)
    def get_bootstrap() -> BootstrapResponse:
        return BootstrapResponse(**bootstrap)

    @app.get(f"{api_base}/molecule3d/trajectory/{{traj_id}}", response_model=MoleculeTrajectoryResponse)
    def get_molecule3d_trajectory(traj_id: str) -> MoleculeTrajectoryResponse:
        tid = str(traj_id)
        cache_key = ("mol3d_coords", tid)
        cached_value = mol3d_cache.get(cache_key)
        if cached_value is not None:
            payload = dict(cached_value)
            payload["cached"] = True
            return MoleculeTrajectoryResponse(**payload)

        try:
            payload = store.build_mol3d_payload(tid)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"Failed to prepare molecule3d trajectory: {exc}") from exc
        if payload is None:
            raise HTTPException(status_code=404, detail=f"Trajectory not found: {tid}")

        mol3d_cache.put(cache_key, payload)
        out = dict(payload)
        out["cached"] = False
        return MoleculeTrajectoryResponse(**out)

    @app.post(f"{api_base}/series", response_model=SeriesResponse)
    def get_series(req: SeriesRequest) -> SeriesResponse:
        traj_id = str(req.traj_id)
        observable = str(req.observable)
        indices = _normalize_indices(req.indices)

        traj = store.get_trajectory(traj_id)
        if traj is None:
            raise HTTPException(status_code=404, detail=f"Trajectory not found: {traj_id}")

        _validate_request(
            observable=observable,
            indices=indices,
            n_atoms=traj.n_atoms,
        )

        cache_key = (traj_id, observable, tuple(indices))
        cached_value = cache.get(cache_key)
        if cached_value is not None:
            payload = dict(cached_value)
            payload["cached"] = True
            return SeriesResponse(**payload)

        try:
            series = compute_observable_series(traj, observable, indices)
        except HTTPException:
            raise
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"Failed to compute series: {exc}") from exc

        response_payload: dict[str, Any] = {
            "traj_id": traj_id,
            "observable": observable,
            "indices": indices,
            **series,
        }
        cache.put(cache_key, response_payload)

        out = dict(response_payload)
        out["cached"] = False
        return SeriesResponse(**out)

    return app
