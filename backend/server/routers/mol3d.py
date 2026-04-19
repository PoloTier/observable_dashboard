from __future__ import annotations

from fastapi import APIRouter, HTTPException

from backend.server.app_state import AppState
from backend.server.models import (
    MoleculeDeNacResponse,
    MoleculeDeResponse,
    MoleculeHydrogenBondResponse,
    MoleculeNacResponse,
    MoleculeTrajectoryResponse,
)


def build_mol3d_router(state: AppState) -> APIRouter:
    router = APIRouter(prefix=state.api_base)
    mol3d_cache = state.mol3d_cache

    @router.get("/molecule3d/trajectory/{traj_id}", response_model=MoleculeTrajectoryResponse)
    def get_molecule3d_trajectory(traj_id: str) -> MoleculeTrajectoryResponse:
        tid = str(traj_id)
        cache_key = ("mol3d_coords", tid)
        cached_value = mol3d_cache.get(cache_key)
        if cached_value is not None:
            payload = dict(cached_value)
            payload["cached"] = True
            return MoleculeTrajectoryResponse(**payload)

        current_store, _, _ = state.get_runtime_snapshot()
        try:
            payload = current_store.build_mol3d_payload(tid)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"Failed to prepare molecule3d trajectory: {exc}") from exc
        if payload is None:
            raise HTTPException(status_code=404, detail=f"Trajectory not found: {tid}")

        mol3d_cache.put(cache_key, payload)
        out = dict(payload)
        out["cached"] = False
        return MoleculeTrajectoryResponse(**out)

    @router.get("/molecule3d/nac/{traj_id}", response_model=MoleculeNacResponse)
    def get_molecule3d_nac(traj_id: str, state_i: int, state_j: int) -> MoleculeNacResponse:
        tid = str(traj_id)
        si = int(state_i)
        sj = int(state_j)
        cache_key = ("mol3d_nac_pair", tid, si, sj)
        cached_value = mol3d_cache.get(cache_key)
        if cached_value is not None:
            payload = dict(cached_value)
            payload["cached"] = True
            return MoleculeNacResponse(**payload)

        current_store, _, _ = state.get_runtime_snapshot()
        try:
            payload = current_store.build_mol3d_nac_payload(tid, si, sj)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"Failed to prepare molecule3d NAC payload: {exc}") from exc
        if payload is None:
            raise HTTPException(status_code=404, detail=f"Trajectory not found: {tid}")

        mol3d_cache.put(cache_key, payload)
        out = dict(payload)
        out["cached"] = False
        return MoleculeNacResponse(**out)

    @router.get("/molecule3d/de/{traj_id}", response_model=MoleculeDeResponse)
    def get_molecule3d_de(traj_id: str, state_i: int, state_j: int) -> MoleculeDeResponse:
        tid = str(traj_id)
        si = int(state_i)
        sj = int(state_j)
        cache_key = ("mol3d_de_pair", tid, si, sj)
        cached_value = mol3d_cache.get(cache_key)
        if cached_value is not None:
            payload = dict(cached_value)
            payload["cached"] = True
            return MoleculeDeResponse(**payload)

        current_store, _, _ = state.get_runtime_snapshot()
        try:
            payload = current_store.build_mol3d_de_payload(tid, si, sj)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"Failed to prepare molecule3d dE payload: {exc}") from exc
        if payload is None:
            raise HTTPException(status_code=404, detail=f"Trajectory not found: {tid}")

        mol3d_cache.put(cache_key, payload)
        out = dict(payload)
        out["cached"] = False
        return MoleculeDeResponse(**out)

    @router.get("/molecule3d/de_nac/{traj_id}", response_model=MoleculeDeNacResponse)
    def get_molecule3d_de_nac(traj_id: str, state_i: int, state_j: int) -> MoleculeDeNacResponse:
        tid = str(traj_id)
        si = int(state_i)
        sj = int(state_j)
        cache_key = ("mol3d_de_nac_pair", tid, si, sj)
        cached_value = mol3d_cache.get(cache_key)
        if cached_value is not None:
            payload = dict(cached_value)
            payload["cached"] = True
            return MoleculeDeNacResponse(**payload)

        current_store, _, _ = state.get_runtime_snapshot()
        try:
            payload = current_store.build_mol3d_de_nac_payload(tid, si, sj)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"Failed to prepare molecule3d de_nac payload: {exc}") from exc
        if payload is None:
            raise HTTPException(status_code=404, detail=f"Trajectory not found: {tid}")

        mol3d_cache.put(cache_key, payload)
        out = dict(payload)
        out["cached"] = False
        return MoleculeDeNacResponse(**out)

    @router.get("/molecule3d/hbonds/{traj_id}", response_model=MoleculeHydrogenBondResponse)
    def get_molecule3d_hbonds(traj_id: str) -> MoleculeHydrogenBondResponse:
        tid = str(traj_id)
        cache_key = ("mol3d_hbonds", tid)
        cached_value = mol3d_cache.get(cache_key)
        if cached_value is not None:
            payload = dict(cached_value)
            payload["cached"] = True
            return MoleculeHydrogenBondResponse(**payload)

        current_store, _, _ = state.get_runtime_snapshot()
        try:
            payload = current_store.build_mol3d_hbond_payload(tid)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"Failed to prepare molecule3d hbond payload: {exc}") from exc
        if payload is None:
            raise HTTPException(status_code=404, detail=f"Trajectory not found: {tid}")

        mol3d_cache.put(cache_key, payload)
        out = dict(payload)
        out["cached"] = False
        return MoleculeHydrogenBondResponse(**out)

    return router
