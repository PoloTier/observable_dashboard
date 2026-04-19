from __future__ import annotations

import logging
import secrets
import shutil
from pathlib import Path
from threading import Lock
from typing import Any, Callable

import numpy as np
from fastapi import HTTPException

from backend.server.cache import SeriesLRUCache
from backend.server.dataset_store import DatasetStore
from backend.server.distribution_bundle import (
    DistributionBundle,
    ElectronicProfile,
    collect_absorption_excitation_energies_ev,
    collect_valid_absorption_transition_pairs,
    make_distribution_id,
)
from backend.server.models import (
    DistributionSelectionRequestItem,
    DistributionSpectrumPairOption,
    DistributionSpectrumSeriesRequestItem,
    FileBrowserResponse,
)
from backend.server.normal_modes_sampling import SAMPLE_CACHE_MAX_ENTRIES
from backend.server.app_helpers import (
    build_bootstrap_payload,
    build_distribution_list_item_payload,
    relative_path_text,
)

logger = logging.getLogger(__name__)


class AppState:
    """Mutable server state shared across routers.

    All closure state previously captured by create_app() lives here. Router
    modules receive an instance and read/mutate through methods that respect
    the original locking discipline.
    """

    def __init__(
        self,
        *,
        store: DatasetStore,
        cache: SeriesLRUCache,
        mol3d_cache: SeriesLRUCache,
        api_base: str,
        load_store_from_path: Callable[[Path], DatasetStore] | None,
        browse_root: Path | None,
        frontend_dir: Path,
        frontend_public: Path,
    ) -> None:
        self.cache = cache
        self.mol3d_cache = mol3d_cache
        self.normal_modes_sample_cache = SeriesLRUCache(max_entries=SAMPLE_CACHE_MAX_ENTRIES)
        self.distribution_lock = Lock()
        self.loaded_distributions: dict[str, DistributionBundle] = {}
        self.distribution_analysis_cache = SeriesLRUCache(max_entries=64)
        self.distribution_projection_cache = SeriesLRUCache(max_entries=32)
        self.soap_feature_cache_lock = Lock()
        self.soap_feature_cache: dict[tuple[Any, ...], dict[str, Any]] = {}
        self.browse_root_resolved: Path | None = (
            Path(browse_root).resolve() if browse_root is not None else None
        )
        self.load_store_from_path = load_store_from_path
        self.api_base = api_base
        self.frontend_dir = frontend_dir
        self.frontend_public = frontend_public

        self.runtime_lock = Lock()
        self.runtime_state: dict[str, Any] = {
            "store": store,
            "raw_key_aliases": {},
            "bootstrap": build_bootstrap_payload(
                store=store,
                api_base=api_base,
                raw_key_aliases={},
            ),
            "dataset_revision": 1,
        }

    # ------------------------------------------------------------------
    # Runtime snapshot / bootstrap
    # ------------------------------------------------------------------

    def update_bootstrap_locked(self) -> None:
        """Rebuild the cached bootstrap payload. Caller must hold runtime_lock."""
        self.runtime_state["bootstrap"] = build_bootstrap_payload(
            store=self.runtime_state["store"],
            api_base=self.api_base,
            raw_key_aliases=self.runtime_state["raw_key_aliases"],
        )

    def get_runtime_snapshot(self) -> tuple[DatasetStore, dict[str, Any], int]:
        with self.runtime_lock:
            return (
                self.runtime_state["store"],
                self.runtime_state["bootstrap"],
                int(self.runtime_state["dataset_revision"]),
            )

    # ------------------------------------------------------------------
    # Dataset load / refresh activation
    # ------------------------------------------------------------------

    def activate_store(
        self,
        new_store: DatasetStore,
        *,
        action_label: str,
        reset_aliases: bool,
    ) -> dict[str, Any]:
        try:
            with self.runtime_lock:
                prev_store = self.runtime_state["store"]
                prev_bootstrap = self.runtime_state["bootstrap"]
                prev_aliases = dict(self.runtime_state["raw_key_aliases"])
                prev_revision = int(self.runtime_state["dataset_revision"])

                self.runtime_state["store"] = new_store
                if reset_aliases:
                    self.runtime_state["raw_key_aliases"] = {}
                self.update_bootstrap_locked()
                self.runtime_state["dataset_revision"] = prev_revision + 1

                try:
                    if self.mol3d_cache is self.cache:
                        cleared_series_cache_entries = self.cache.clear()
                        cleared_mol3d_cache_entries = cleared_series_cache_entries
                    else:
                        cleared_series_cache_entries = self.cache.clear()
                        cleared_mol3d_cache_entries = self.mol3d_cache.clear()
                except Exception:  # noqa: BLE001
                    self.runtime_state["store"] = prev_store
                    self.runtime_state["bootstrap"] = prev_bootstrap
                    self.runtime_state["raw_key_aliases"] = prev_aliases
                    self.runtime_state["dataset_revision"] = prev_revision
                    logger.exception(
                        "%s failed during cache clear; rolled back to revision=%d.",
                        action_label,
                        prev_revision,
                    )
                    raise

                dataset_revision = int(self.runtime_state["dataset_revision"])
        except Exception as exc:  # noqa: BLE001
            logger.exception("%s activation failed.", action_label)
            raise HTTPException(status_code=500, detail=f"Failed to activate refreshed dataset: {exc}") from exc

        source_pkl = str(new_store.meta.get("source_pkl") or "")
        logger.info(
            (
                "%s succeeded. revision=%d traj_count=%d source_pkl=%s "
                "cleared_series_cache_entries=%d cleared_mol3d_cache_entries=%d"
            ),
            action_label,
            dataset_revision,
            len(new_store.traj_ids),
            source_pkl or "(none)",
            cleared_series_cache_entries,
            cleared_mol3d_cache_entries,
        )
        return {
            "status": "ok",
            "traj_count": len(new_store.traj_ids),
            "source_pkl": source_pkl,
            "cleared_series_cache_entries": cleared_series_cache_entries,
            "cleared_mol3d_cache_entries": cleared_mol3d_cache_entries,
            "dataset_revision": dataset_revision,
        }

    # ------------------------------------------------------------------
    # Path resolution / file browser
    # ------------------------------------------------------------------

    def resolve_browse_path(self, relative_path: str | None) -> Path:
        if self.browse_root_resolved is None:
            raise HTTPException(status_code=501, detail="Dataset browsing is not enabled on this server.")

        raw_path = str(relative_path or "").strip()
        if raw_path and Path(raw_path).is_absolute():
            raise HTTPException(status_code=400, detail="Absolute paths are not allowed.")

        candidate = self.browse_root_resolved if not raw_path else self.browse_root_resolved / raw_path
        try:
            resolved = candidate.resolve(strict=True)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=f"Path not found: {raw_path or '.'}") from exc
        except OSError as exc:
            raise HTTPException(status_code=400, detail=f"Failed to resolve path: {exc}") from exc

        try:
            resolved.relative_to(self.browse_root_resolved)
        except ValueError as exc:
            raise HTTPException(status_code=403, detail="Requested path is outside the browse root.") from exc
        return resolved

    def resolve_browse_output_directory(self, relative_path: str | None) -> Path:
        if self.browse_root_resolved is None:
            raise HTTPException(status_code=501, detail="Dataset browsing is not enabled on this server.")

        raw_path = str(relative_path or "").strip()
        if raw_path and Path(raw_path).is_absolute():
            raise HTTPException(status_code=400, detail="Absolute paths are not allowed.")

        candidate = self.browse_root_resolved if not raw_path else self.browse_root_resolved / raw_path
        try:
            resolved = candidate.resolve(strict=False)
        except OSError as exc:
            raise HTTPException(status_code=400, detail=f"Failed to resolve path: {exc}") from exc

        try:
            resolved.relative_to(self.browse_root_resolved)
        except ValueError as exc:
            raise HTTPException(status_code=403, detail="Requested path is outside the browse root.") from exc
        return resolved

    def resolve_manual_source_path(self, raw_path: str) -> Path:
        path_text = str(raw_path or "").strip()
        if not path_text:
            raise HTTPException(status_code=422, detail="path must not be empty.")

        base_root = self.browse_root_resolved if self.browse_root_resolved is not None else Path.cwd().resolve()

        candidate = Path(path_text)
        if not candidate.is_absolute():
            candidate = base_root / candidate

        try:
            resolved = candidate.resolve(strict=True)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=f"Path not found: {path_text}") from exc
        except OSError as exc:
            raise HTTPException(status_code=400, detail=f"Failed to resolve path: {exc}") from exc

        # Ensure resolved path stays within the allowed root
        try:
            resolved.relative_to(base_root)
        except ValueError as exc:
            raise HTTPException(status_code=403, detail="Requested path is outside the allowed root.") from exc

        if not resolved.is_file():
            raise HTTPException(status_code=422, detail=f"Path is not a file: {path_text}")
        return resolved

    def build_file_browser_response(
        self,
        current_dir: Path,
        *,
        is_loadable: Callable[[Path, str], bool],
    ) -> FileBrowserResponse:
        root = self.browse_root_resolved
        assert root is not None, "build_file_browser_response requires browse_root_resolved"

        entries: list[dict[str, Any]] = []
        for child in current_dir.iterdir():
            if child.name.startswith("."):
                continue
            try:
                resolved_child = child.resolve(strict=True)
                resolved_child.relative_to(root)
            except (FileNotFoundError, OSError, ValueError):
                continue

            kind = "directory" if resolved_child.is_dir() else "file" if resolved_child.is_file() else ""
            if not kind:
                continue

            entries.append(
                {
                    "name": child.name,
                    "relative_path": relative_path_text(root, child),
                    "kind": kind,
                    "loadable": bool(is_loadable(child, kind)),
                }
            )

        entries.sort(key=lambda item: (item["kind"] != "directory", str(item["name"]).lower()))
        parent_path = None if current_dir == root else relative_path_text(root, current_dir.parent)
        return FileBrowserResponse(
            root_label=str(root),
            current_path=relative_path_text(root, current_dir),
            parent_path=parent_path,
            entries=entries,
        )

    # ------------------------------------------------------------------
    # Geometry bundle output helpers
    # ------------------------------------------------------------------

    @staticmethod
    def normalize_export_directory_name(raw_filename: str, *, fallback: str) -> str:
        directory_name = str(raw_filename or "").strip() or str(fallback or "").strip()
        if not directory_name:
            raise HTTPException(status_code=422, detail="filename must not be empty.")
        if Path(directory_name).name != directory_name or "/" in directory_name or "\\" in directory_name:
            raise HTTPException(status_code=422, detail="filename must be a directory name, not a path.")
        if directory_name in {".", ".."}:
            raise HTTPException(status_code=422, detail="filename must be a valid directory name.")

        directory_name_lower = directory_name.lower()
        if directory_name_lower.endswith(".tar.gz"):
            directory_name = directory_name[:-7]
        elif directory_name_lower.endswith(".tgz"):
            directory_name = directory_name[:-4]
        elif directory_name_lower.endswith(".tar"):
            directory_name = directory_name[:-4]
        elif directory_name_lower.endswith(".gz"):
            directory_name = directory_name[:-3]

        directory_name = directory_name.strip()
        if not directory_name or directory_name in {".", ".."}:
            raise HTTPException(status_code=422, detail="filename must resolve to a valid directory name.")
        return directory_name

    @staticmethod
    def write_bundle_entries_to_directory(
        parent_dir: Path,
        *,
        directory_name: str,
        entries: list[tuple[str, bytes]],
    ) -> Path:
        target_path = parent_dir / directory_name
        if target_path.exists():
            raise HTTPException(status_code=409, detail=f"Target path already exists: {target_path.name}")

        temp_path = parent_dir / f".{directory_name}.tmp-{secrets.token_urlsafe(6)}"
        while temp_path.exists():
            temp_path = parent_dir / f".{directory_name}.tmp-{secrets.token_urlsafe(6)}"

        try:
            temp_path.mkdir(parents=False, exist_ok=False)
            for relative_path, content_bytes in entries:
                entry_relative_path = Path(relative_path)
                if entry_relative_path.is_absolute() or any(part in {"", ".", ".."} for part in entry_relative_path.parts):
                    raise HTTPException(status_code=500, detail=f"Invalid bundle entry path: {relative_path}")
                entry_path = temp_path / entry_relative_path
                entry_path.parent.mkdir(parents=True, exist_ok=True)
                entry_path.write_bytes(content_bytes)

            temp_path.rename(target_path)
            return target_path
        except HTTPException:
            if temp_path.exists():
                shutil.rmtree(temp_path, ignore_errors=True)
            raise
        except OSError as exc:
            if temp_path.exists():
                shutil.rmtree(temp_path, ignore_errors=True)
            if target_path.exists():
                raise HTTPException(status_code=409, detail=f"Target path already exists: {target_path.name}") from exc
            raise HTTPException(status_code=500, detail=f"Failed to write geometry bundle directory: {exc}") from exc

    # ------------------------------------------------------------------
    # Distribution registry
    # ------------------------------------------------------------------

    def list_loaded_distribution_payloads(self) -> list[dict[str, Any]]:
        with self.distribution_lock:
            items = [
                build_distribution_list_item_payload(distribution_id=distribution_id, bundle=bundle)
                for distribution_id, bundle in self.loaded_distributions.items()
            ]
        items.sort(key=lambda item: str(item.get("created_at_utc") or ""), reverse=True)
        return items

    def get_distribution_or_404(self, distribution_id: str) -> DistributionBundle:
        with self.distribution_lock:
            bundle = self.loaded_distributions.get(str(distribution_id))
        if bundle is None:
            raise HTTPException(status_code=404, detail=f"Distribution not found: {distribution_id}")
        return bundle

    def store_distribution(self, bundle: DistributionBundle) -> dict[str, Any]:
        distribution_id = make_distribution_id()
        with self.distribution_lock:
            self.loaded_distributions[distribution_id] = bundle
        return build_distribution_list_item_payload(distribution_id=distribution_id, bundle=bundle)

    def delete_distribution(self, distribution_id: str) -> bool:
        with self.distribution_lock:
            return self.loaded_distributions.pop(str(distribution_id), None) is not None

    @staticmethod
    def normalize_distribution_ids(raw_distribution_ids: list[str]) -> list[str]:
        distribution_ids: list[str] = []
        seen_ids: set[str] = set()
        for raw_id in raw_distribution_ids:
            distribution_id = str(raw_id).strip()
            if not distribution_id or distribution_id in seen_ids:
                continue
            seen_ids.add(distribution_id)
            distribution_ids.append(distribution_id)
        return distribution_ids

    @staticmethod
    def normalize_spectrum_series_request_items(
        raw_items: list[DistributionSpectrumSeriesRequestItem],
    ) -> list[tuple[str, str]]:
        series_items: list[tuple[str, str]] = []
        seen_items: set[tuple[str, str]] = set()
        for raw_item in raw_items:
            distribution_id = str(raw_item.distribution_id).strip()
            profile_id = str(raw_item.profile_id).strip()
            if not distribution_id or not profile_id:
                continue
            key = (distribution_id, profile_id)
            if key in seen_items:
                continue
            seen_items.add(key)
            series_items.append(key)
        return series_items

    @staticmethod
    def normalize_distribution_selection_items(
        raw_items: list[DistributionSelectionRequestItem],
    ) -> list[tuple[str, str]]:
        items: list[tuple[str, str]] = []
        seen_distribution_ids: set[str] = set()
        for raw_item in raw_items:
            distribution_id = str(raw_item.distribution_id).strip()
            profile_id = str(raw_item.profile_id).strip()
            if not distribution_id or not profile_id:
                continue
            if distribution_id in seen_distribution_ids:
                raise HTTPException(
                    status_code=422,
                    detail=(
                        "Each distribution may appear at most once in window selection requests. "
                        f"Received duplicate distribution_id={distribution_id!r}."
                    ),
                )
            seen_distribution_ids.add(distribution_id)
            items.append((distribution_id, profile_id))
        return items

    def collect_distribution_selection_items(
        self,
        selection_items: list[tuple[str, str]],
    ) -> list[tuple[str, DistributionBundle, str, ElectronicProfile]]:
        if not selection_items:
            return []
        resolved_items: list[tuple[str, DistributionBundle, str, ElectronicProfile]] = []
        topology_signature: str | None = None
        for distribution_id, profile_id in selection_items:
            bundle, profile = self.get_distribution_profile_or_422(distribution_id, profile_id)
            if topology_signature is None:
                topology_signature = str(bundle.topology_signature)
            elif str(bundle.topology_signature) != topology_signature:
                raise HTTPException(
                    status_code=422,
                    detail=(
                        "Windowed geometry comparison and SOAP projection require identical "
                        "topology_signature across all selected distributions."
                    ),
                )
            resolved_items.append((distribution_id, bundle, profile_id, profile))
        return resolved_items

    def collect_distribution_bundles(
        self,
        distribution_ids: list[str],
    ) -> list[tuple[str, DistributionBundle]]:
        if not distribution_ids:
            return []
        bundles: list[tuple[str, DistributionBundle]] = []
        topology_signature: str | None = None
        for distribution_id in distribution_ids:
            bundle = self.get_distribution_or_404(distribution_id)
            if topology_signature is None:
                topology_signature = str(bundle.topology_signature)
            elif str(bundle.topology_signature) != topology_signature:
                raise HTTPException(
                    status_code=422,
                    detail=(
                        "Geometry comparison and SOAP projection require identical "
                        "topology_signature across all active distributions."
                    ),
                )
            bundles.append((distribution_id, bundle))
        return bundles

    @staticmethod
    def format_transition_pair(pair: tuple[int, int]) -> str:
        return f"{int(pair[0])}->{int(pair[1])}"

    @staticmethod
    def build_series_label(*, bundle: DistributionBundle, profile: ElectronicProfile) -> str:
        return f"{bundle.label} | {profile.label}"

    @classmethod
    def build_transition_pair_options(
        cls, pairs: list[tuple[int, int]]
    ) -> list[DistributionSpectrumPairOption]:
        return [
            DistributionSpectrumPairOption(
                pair=[int(pair[0]), int(pair[1])],
                label=cls.format_transition_pair(pair),
            )
            for pair in pairs
        ]

    def get_distribution_profile_or_422(
        self,
        distribution_id: str,
        profile_id: str,
    ) -> tuple[DistributionBundle, ElectronicProfile]:
        bundle = self.get_distribution_or_404(distribution_id)
        profile = (bundle.electronic_profiles or {}).get(str(profile_id))
        if profile is None:
            raise HTTPException(
                status_code=422,
                detail=f"Distribution {distribution_id} does not contain electronic profile {profile_id}.",
            )
        return bundle, profile

    def collect_comparable_spectrum_series(
        self,
        series_items: list[tuple[str, str]],
    ) -> tuple[
        list[tuple[str, DistributionBundle, str, ElectronicProfile]],
        list[dict[str, str | None]],
        list[np.ndarray],
    ]:
        comparable_series: list[tuple[str, DistributionBundle, str, ElectronicProfile]] = []
        skipped_payloads: list[dict[str, str | None]] = []
        excitation_energy_sets_ev: list[np.ndarray] = []
        for distribution_id, profile_id in series_items:
            bundle, profile = self.get_distribution_profile_or_422(distribution_id, profile_id)
            excitation_energies_ev = collect_absorption_excitation_energies_ev(profile)
            if excitation_energies_ev.size <= 0:
                skipped_payloads.append(
                    {
                        "distribution_id": str(distribution_id),
                        "distribution_label": str(bundle.label),
                        "profile_id": str(profile_id),
                        "profile_label": str(profile.label),
                        "reason": "no valid electronic transitions",
                    }
                )
                continue

            comparable_series.append((distribution_id, bundle, profile_id, profile))
            excitation_energy_sets_ev.append(np.asarray(excitation_energies_ev, dtype=float))
        return comparable_series, skipped_payloads, excitation_energy_sets_ev

    @staticmethod
    def collect_common_spectrum_pairs(
        comparable_series: list[tuple[str, DistributionBundle, str, ElectronicProfile]]
    ) -> list[tuple[int, int]]:
        if not comparable_series:
            return []
        common_pairs: set[tuple[int, int]] | None = None
        for _, _, _, profile in comparable_series:
            bundle_pairs = set(collect_valid_absorption_transition_pairs(profile))
            if common_pairs is None:
                common_pairs = bundle_pairs
            else:
                common_pairs &= bundle_pairs
        return sorted(common_pairs or set())

    @staticmethod
    def build_absorption_energy_grid(
        *,
        excitation_energy_sets_ev: list[np.ndarray],
        delta_ev: float,
    ) -> np.ndarray:
        non_empty_sets = [
            np.asarray(values, dtype=float).reshape(-1)
            for values in excitation_energy_sets_ev
            if values.size > 0
        ]
        if not non_empty_sets:
            raise HTTPException(
                status_code=422,
                detail="No valid electronic transitions remain after filtering the selected spectrum series.",
            )
        all_excitation_energies_ev = np.concatenate(non_empty_sets)
        min_energy_ev = float(np.min(all_excitation_energies_ev))
        max_energy_ev = float(np.max(all_excitation_energies_ev))
        margin_ev = max(0.25, 8.0 * float(delta_ev))
        x_min_energy_ev = max(0.01, min_energy_ev - margin_ev)
        x_max_energy_ev = max(x_min_energy_ev + 0.2, max_energy_ev + margin_ev)
        return np.linspace(x_min_energy_ev, x_max_energy_ev, 800, dtype=float)
