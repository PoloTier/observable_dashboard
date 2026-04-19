from __future__ import annotations

import logging
from pathlib import Path

from fastapi import APIRouter, HTTPException

from backend.config import ALLOWED_OBSERVABLES
from backend.server.app_helpers import (
    build_raw_key_alias_items,
    dataset_is_loaded,
    normalize_inspect_keys,
    path_matches_suffixes,
    raw_key_exists,
)
from backend.server.app_state import AppState
from backend.server.models import (
    FileBrowserResponse,
    InspectKeysRequest,
    InspectKeysResponse,
    LoadDatasetRequest,
    LoadDatasetResponse,
    RawKeyAliasListResponse,
    RawKeyAliasUpsertRequest,
    RefreshDatasetResponse,
)

logger = logging.getLogger(__name__)

MAX_INSPECT_KEYS = 200
RAW_ALIAS_PREFIX = "raw_alias::"
LOADABLE_DATASET_SUFFIXES = frozenset({".pkl", ".pickle"})


def build_dataset_router(state: AppState) -> APIRouter:
    router = APIRouter(prefix=state.api_base)

    @router.get("/files", response_model=FileBrowserResponse)
    def list_files(path: str | None = None) -> FileBrowserResponse:
        current_dir = state.resolve_browse_path(path)
        if not current_dir.is_dir():
            raise HTTPException(status_code=422, detail=f"Path is not a directory: {path or '.'}")
        return state.build_file_browser_response(
            current_dir,
            is_loadable=lambda child, kind: kind == "file"
            and path_matches_suffixes(child, LOADABLE_DATASET_SUFFIXES),
        )

    @router.post("/load-dataset", response_model=LoadDatasetResponse)
    def load_dataset(req: LoadDatasetRequest) -> LoadDatasetResponse:
        if state.load_store_from_path is None:
            raise HTTPException(status_code=501, detail="Dataset loading is not enabled on this server.")

        target_path = state.resolve_browse_path(req.path)
        if not target_path.is_file():
            raise HTTPException(status_code=422, detail=f"Path is not a file: {req.path}")
        if not path_matches_suffixes(target_path, LOADABLE_DATASET_SUFFIXES):
            raise HTTPException(status_code=422, detail="Only .pkl and .pickle files can be loaded.")

        try:
            new_store = state.load_store_from_path(target_path)
        except Exception as exc:  # noqa: BLE001
            logger.exception("Dataset load failed before activation. path=%s", target_path)
            raise HTTPException(status_code=500, detail=f"Failed to load dataset: {exc}") from exc

        payload = state.activate_store(new_store, action_label="Dataset load", reset_aliases=True)
        return LoadDatasetResponse(**payload)

    @router.post("/inspect-keys", response_model=InspectKeysResponse)
    def inspect_keys(req: InspectKeysRequest) -> InspectKeysResponse:
        keys = normalize_inspect_keys(req.keys)
        if len(keys) > MAX_INSPECT_KEYS:
            raise HTTPException(status_code=422, detail=f"Too many keys (max {MAX_INSPECT_KEYS}).")

        current_store, _, _ = state.get_runtime_snapshot()
        try:
            payload = current_store.inspect_raw_keys(keys)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"Failed to inspect keys: {exc}") from exc
        return InspectKeysResponse(**payload)

    @router.get("/raw-key-aliases", response_model=RawKeyAliasListResponse)
    def list_raw_key_aliases() -> RawKeyAliasListResponse:
        with state.runtime_lock:
            payload = {"aliases": build_raw_key_alias_items(state.runtime_state["raw_key_aliases"])}
        return RawKeyAliasListResponse(**payload)

    @router.post("/raw-key-aliases", response_model=RawKeyAliasListResponse)
    def upsert_raw_key_alias(req: RawKeyAliasUpsertRequest) -> RawKeyAliasListResponse:
        alias = str(req.alias).strip()
        raw_key = str(req.raw_key).strip()
        if not alias:
            raise HTTPException(status_code=422, detail="alias must be a non-empty string.")
        if not raw_key:
            raise HTTPException(status_code=422, detail="raw_key must be a non-empty string.")
        if alias in ALLOWED_OBSERVABLES or alias == "raw_key":
            raise HTTPException(
                status_code=422,
                detail=f"alias '{alias}' conflicts with a built-in observable name.",
            )
        if alias.startswith(RAW_ALIAS_PREFIX):
            raise HTTPException(
                status_code=422,
                detail=f"alias must not start with reserved prefix '{RAW_ALIAS_PREFIX}'.",
            )

        current_store, _, _ = state.get_runtime_snapshot()
        try:
            exists = raw_key_exists(current_store, raw_key)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"Failed to validate raw key: {exc}") from exc
        if not exists:
            raise HTTPException(status_code=422, detail=f"raw_key '{raw_key}' was not found in current dataset.")

        with state.runtime_lock:
            alias_map = state.runtime_state["raw_key_aliases"]
            alias_map[alias] = raw_key
            state.update_bootstrap_locked()
            payload = {"aliases": build_raw_key_alias_items(alias_map)}
        return RawKeyAliasListResponse(**payload)

    @router.post("/refresh-dataset", response_model=RefreshDatasetResponse)
    def refresh_dataset() -> RefreshDatasetResponse:
        if state.load_store_from_path is None:
            logger.warning("Dataset refresh requested but load_store_from_path is not configured.")
            raise HTTPException(status_code=501, detail="Dataset refresh is not enabled on this server.")

        current_store, _, current_revision = state.get_runtime_snapshot()
        if not dataset_is_loaded(current_store):
            raise HTTPException(status_code=409, detail="No dataset is currently loaded; use load-dataset first.")

        logger.info("Dataset refresh requested. current_revision=%d", current_revision)

        try:
            new_store = state.load_store_from_path(Path(current_store.input_path).resolve())
        except Exception as exc:  # noqa: BLE001
            logger.exception("Dataset reload failed before activation.")
            raise HTTPException(status_code=500, detail=f"Failed to reload dataset: {exc}") from exc

        payload = state.activate_store(new_store, action_label="Dataset refresh", reset_aliases=False)
        return RefreshDatasetResponse(**payload)

    return router
