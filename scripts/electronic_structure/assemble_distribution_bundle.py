from __future__ import annotations

import argparse
import json
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

try:
    from .common import (
        _electronic_channel_entries,
        load_geometry_bundle,
        normalize_profile_id,
        utc_now_iso,
        write_json,
        write_npy,
    )
except ImportError:
    from common import (  # type: ignore[no-redef]
        _electronic_channel_entries,
        load_geometry_bundle,
        normalize_profile_id,
        utc_now_iso,
        write_json,
        write_npy,
    )


@dataclass(frozen=True, slots=True)
class PreparedWorkspaceInfo:
    workspace_dir: Path
    profile_id: str
    profile_label: str


@dataclass(frozen=True, slots=True)
class WorkspaceAssemblySuccess:
    workspace_dir: Path
    profile_id: str
    profile_label: str


@dataclass(frozen=True, slots=True)
class WorkspaceAssemblyFailure:
    workspace_dir: Path
    error: str
    profile_id: str | None = None


@dataclass(frozen=True, slots=True)
class BatchAssemblyResult:
    bundle_path: Path
    successes: tuple[WorkspaceAssemblySuccess, ...]
    failures: tuple[WorkspaceAssemblyFailure, ...]

    @property
    def processed_count(self) -> int:
        return int(len(self.successes) + len(self.failures))

    @property
    def success_count(self) -> int:
        return int(len(self.successes))

    @property
    def failure_count(self) -> int:
        return int(len(self.failures))


def _load_json_file(path: Path, *, label: str) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        raise ValueError(f"Failed to read {label} from {path}: {exc}") from exc
    if not isinstance(payload, dict):
        raise ValueError(f"{label} must decode to a JSON object: {path}")
    return payload


def _coerce_int(value: Any, *, default: int | None = None) -> int:
    if value is None:
        if default is None:
            raise ValueError("Missing required integer value.")
        return int(default)
    return int(value)


def _discover_workspace_dirs(bundle_path: Path) -> list[Path]:
    workspace_root = Path(bundle_path).resolve() / "electronic_workspaces"
    if not workspace_root.is_dir():
        raise ValueError(f"No electronic_workspaces directory was found under {bundle_path}.")

    candidates = sorted(path.resolve() for path in workspace_root.iterdir() if path.is_dir())
    if not candidates:
        raise ValueError(f"No prepared workspaces were found under {workspace_root}.")
    return candidates


def _resolve_workspace_dir(bundle_path: Path, workspace_dir: Path | None) -> Path:
    if workspace_dir is not None:
        resolved = Path(workspace_dir).resolve()
        if not resolved.is_dir():
            raise ValueError(f"Workspace directory does not exist: {resolved}")
        return resolved

    candidates = _discover_workspace_dirs(bundle_path)
    if len(candidates) > 1:
        workspace_root = Path(bundle_path).resolve() / "electronic_workspaces"
        raise ValueError(
            f"Multiple prepared workspaces were found under {workspace_root}; pass --workspace explicitly."
        )
    return candidates[0]


def _validate_prepare_manifest(
    *,
    bundle,
    prepare_manifest: dict[str, Any],
) -> None:
    sampling_dir_raw = str(prepare_manifest.get("sampling_dir") or "").strip()
    if not sampling_dir_raw:
        raise ValueError("prepare_manifest.json sampling_dir must be a non-empty string.")
    if Path(sampling_dir_raw).resolve() != bundle.bundle_path:
        raise ValueError("prepare_manifest.json sampling_dir does not match the geometry bundle path.")
    if str(prepare_manifest.get("batch_id") or "").strip() != str(bundle.batch_id):
        raise ValueError("prepare_manifest.json batch_id does not match the geometry bundle.")
    if str(prepare_manifest.get("source_name") or "").strip() != str(bundle.source_name):
        raise ValueError("prepare_manifest.json source_name does not match the geometry bundle.")
    if int(prepare_manifest.get("n_samples") or -1) != int(bundle.n_samples):
        raise ValueError("prepare_manifest.json n_samples does not match the geometry bundle.")
    if int(prepare_manifest.get("n_atoms") or -1) != int(bundle.n_atoms):
        raise ValueError("prepare_manifest.json n_atoms does not match the geometry bundle.")
    if str(prepare_manifest.get("topology_signature") or "").strip() != str(bundle.topology_signature):
        raise ValueError("prepare_manifest.json topology_signature does not match the geometry bundle.")
    if int(prepare_manifest.get("charge") or bundle.charge) != int(bundle.charge):
        raise ValueError("prepare_manifest.json charge does not match the geometry bundle.")
    if int(prepare_manifest.get("multiplicity") or bundle.multiplicity) != int(bundle.multiplicity):
        raise ValueError("prepare_manifest.json multiplicity does not match the geometry bundle.")

    sample_ids = list(prepare_manifest.get("sample_ids") or [])
    if sample_ids != bundle.sample_ids:
        raise ValueError("prepare_manifest.json sample_ids do not match the geometry bundle sample_ids.")

    if str(prepare_manifest.get("engine") or "").strip().lower() != "pyscf":
        raise ValueError("prepare_manifest.json engine must be 'pyscf'.")
    if str(prepare_manifest.get("method") or "").strip().lower() != "tddft":
        raise ValueError("prepare_manifest.json method must be 'tddft'.")
    normalize_profile_id(
        prepare_manifest.get("profile_id"),
        label="prepare_manifest.json profile_id",
    )
    if not str(prepare_manifest.get("profile_label") or "").strip():
        raise ValueError("prepare_manifest.json profile_label must be a non-empty string.")
    if not str(prepare_manifest.get("xc") or "").strip():
        raise ValueError("prepare_manifest.json xc must be a non-empty string.")
    if not str(prepare_manifest.get("basis") or "").strip():
        raise ValueError("prepare_manifest.json basis must be a non-empty string.")
    if int(prepare_manifest.get("n_excited_states") or 0) <= 0:
        raise ValueError("prepare_manifest.json n_excited_states must be >= 1.")


def _failure_item(*, sample, error_message: str) -> dict[str, Any]:
    return {
        "sample_id": str(sample.sample_id),
        "sample_idx": int(sample.sample_idx),
        "error_message": str(error_message).strip() or "Unknown error",
    }


def _upsert_profile_index_entry(
    *,
    manifest: dict[str, Any],
    profile_entry: dict[str, Any],
) -> dict[str, Any]:
    electronics = manifest.get("electronics")
    if not isinstance(electronics, dict):
        raise ValueError("manifest.json field 'electronics' must be an object.")
    profiles = electronics.get("profiles")
    if not isinstance(profiles, list):
        raise ValueError("manifest.json field 'electronics.profiles' must be a JSON list.")

    next_profiles: list[dict[str, Any]] = []
    replaced = False
    profile_id = str(profile_entry["id"])
    for raw_item in profiles:
        if not isinstance(raw_item, dict):
            raise ValueError("manifest.json field 'electronics.profiles' entries must be JSON objects.")
        raw_profile_id = normalize_profile_id(
            raw_item.get("id"),
            label="manifest.json electronics.profiles[].id",
        )
        if raw_profile_id == profile_id:
            next_profiles.append(dict(profile_entry))
            replaced = True
        else:
            next_profiles.append(dict(raw_item))
    if not replaced:
        next_profiles.append(dict(profile_entry))

    if electronics.get("default_profile_id") in (None, ""):
        default_profile_id = profile_id
    else:
        default_profile_id = str(electronics.get("default_profile_id") or "").strip()

    updated_manifest = dict(manifest)
    updated_manifest["electronics"] = {
        "default_profile_id": default_profile_id,
        "profiles": sorted(next_profiles, key=lambda item: str(item.get("id") or "")),
    }
    return updated_manifest


def _prepare_profile_output_dir(path: Path) -> None:
    if path.exists():
        if not path.is_dir():
            raise ValueError(f"Electronic profile output path exists but is not a directory: {path}")
        shutil.rmtree(path)
    path.mkdir(parents=True, exist_ok=False)


def _load_prepared_workspace_info(workspace_dir: Path) -> PreparedWorkspaceInfo:
    resolved_workspace_dir = Path(workspace_dir).resolve()
    if not resolved_workspace_dir.is_dir():
        raise ValueError(f"Workspace directory does not exist: {resolved_workspace_dir}")

    prepare_manifest = _load_json_file(
        resolved_workspace_dir / "prepare_manifest.json",
        label="prepare manifest",
    )
    profile_id = normalize_profile_id(
        prepare_manifest.get("profile_id"),
        label="prepare_manifest.json profile_id",
    )
    profile_label = str(prepare_manifest.get("profile_label") or "").strip()
    if not profile_label:
        raise ValueError("prepare_manifest.json profile_label must be a non-empty string.")
    return PreparedWorkspaceInfo(
        workspace_dir=resolved_workspace_dir,
        profile_id=profile_id,
        profile_label=profile_label,
    )


def assemble_distribution_workspaces(
    *,
    bundle_path: Path,
) -> BatchAssemblyResult:
    resolved_bundle_path = Path(bundle_path).resolve()
    workspace_dirs = _discover_workspace_dirs(resolved_bundle_path)

    inspected_workspaces: list[PreparedWorkspaceInfo] = []
    failures_by_workspace: dict[Path, WorkspaceAssemblyFailure] = {}
    profile_to_workspaces: dict[str, list[PreparedWorkspaceInfo]] = {}

    for workspace_dir in workspace_dirs:
        try:
            info = _load_prepared_workspace_info(workspace_dir)
        except ValueError as exc:
            failures_by_workspace[workspace_dir] = WorkspaceAssemblyFailure(
                workspace_dir=workspace_dir,
                error=str(exc),
            )
            continue

        inspected_workspaces.append(info)
        profile_to_workspaces.setdefault(info.profile_id, []).append(info)

    for profile_id, infos in profile_to_workspaces.items():
        if len(infos) <= 1:
            continue
        duplicate_workspace_labels = ", ".join(
            str(info.workspace_dir)
            for info in sorted(infos, key=lambda item: str(item.workspace_dir))
        )
        error = f"Duplicate profile_id {profile_id!r} appears in multiple workspaces: {duplicate_workspace_labels}"
        for info in infos:
            failures_by_workspace[info.workspace_dir] = WorkspaceAssemblyFailure(
                workspace_dir=info.workspace_dir,
                profile_id=info.profile_id,
                error=error,
            )

    successes: list[WorkspaceAssemblySuccess] = []
    for info in inspected_workspaces:
        if info.workspace_dir in failures_by_workspace:
            continue
        try:
            assemble_distribution_bundle(
                bundle_path=resolved_bundle_path,
                workspace_dir=info.workspace_dir,
            )
        except ValueError as exc:
            failures_by_workspace[info.workspace_dir] = WorkspaceAssemblyFailure(
                workspace_dir=info.workspace_dir,
                profile_id=info.profile_id,
                error=str(exc),
            )
            continue

        successes.append(
            WorkspaceAssemblySuccess(
                workspace_dir=info.workspace_dir,
                profile_id=info.profile_id,
                profile_label=info.profile_label,
            )
        )

    ordered_failures = tuple(
        failures_by_workspace[path]
        for path in sorted(failures_by_workspace.keys(), key=lambda item: str(item))
    )
    return BatchAssemblyResult(
        bundle_path=resolved_bundle_path,
        successes=tuple(successes),
        failures=ordered_failures,
    )


def assemble_distribution_bundle(
    *,
    bundle_path: Path,
    workspace_dir: Path | None = None,
) -> Path:
    bundle = load_geometry_bundle(bundle_path)
    resolved_workspace_dir = _resolve_workspace_dir(bundle.bundle_path, workspace_dir)

    prepare_manifest = _load_json_file(
        resolved_workspace_dir / "prepare_manifest.json",
        label="prepare manifest",
    )
    _validate_prepare_manifest(bundle=bundle, prepare_manifest=prepare_manifest)

    canonical_transition_pairs: np.ndarray | None = None
    canonical_reference: str | None = None
    n_states_total: int | None = None
    successful_results: dict[int, dict[str, np.ndarray | str]] = {}
    failed_samples: list[dict[str, Any]] = []

    for sample in bundle.samples:
        result_path = resolved_workspace_dir / "jobs" / sample.sample_id / "result.json"
        if not result_path.is_file():
            failed_samples.append(
                _failure_item(sample=sample, error_message=f"Missing result.json: {result_path.name}")
            )
            continue

        try:
            payload = _load_json_file(result_path, label=f"result payload for {sample.sample_id}")
        except ValueError as exc:
            failed_samples.append(_failure_item(sample=sample, error_message=str(exc)))
            continue

        status = str(payload.get("status") or "").strip().lower()
        if status != "ok":
            failed_samples.append(
                _failure_item(
                    sample=sample,
                    error_message=str(payload.get("error_message") or status or "Unknown error"),
                )
            )
            continue

        if str(payload.get("sample_id") or "").strip() != sample.sample_id:
            raise ValueError(f"{result_path} sample_id does not match workspace ordering.")
        if _coerce_int(payload.get("sample_idx"), default=-1) != int(sample.sample_idx):
            raise ValueError(f"{result_path} sample_idx does not match workspace ordering.")
        if str(payload.get("geom_sha1") or "").strip() != sample.geom_sha1:
            raise ValueError(f"{result_path} geom_sha1 does not match the geometry bundle.")

        if str(payload.get("engine") or "").strip().lower() != "pyscf":
            raise ValueError(f"{result_path} engine must be 'pyscf'.")
        if str(payload.get("method") or "").strip().lower() != "tddft":
            raise ValueError(f"{result_path} method must be 'tddft'.")
        if str(payload.get("xc") or "").strip() != str(prepare_manifest.get("xc") or "").strip():
            raise ValueError(f"{result_path} xc does not match prepare_manifest.json.")
        if str(payload.get("basis") or "").strip() != str(prepare_manifest.get("basis") or "").strip():
            raise ValueError(f"{result_path} basis does not match prepare_manifest.json.")
        if _coerce_int(payload.get("n_excited_states"), default=0) != _coerce_int(
            prepare_manifest.get("n_excited_states"),
            default=0,
        ):
            raise ValueError(f"{result_path} n_excited_states does not match prepare_manifest.json.")

        if not bool(payload.get("scf_converged", False)):
            failed_samples.append(
                _failure_item(
                    sample=sample,
                    error_message=str(payload.get("error_message") or "SCF did not converge."),
                )
            )
            continue
        if not bool(payload.get("td_converged", False)):
            failed_samples.append(
                _failure_item(
                    sample=sample,
                    error_message=str(payload.get("error_message") or "TDDFT did not converge."),
                )
            )
            continue

        reference = str(payload.get("reference") or "").strip().lower()
        if not reference:
            raise ValueError(f"{result_path} reference must be a non-empty string.")
        if canonical_reference is None:
            canonical_reference = reference
        elif canonical_reference != reference:
            raise ValueError(f"{result_path} reference does not match the canonical reference {canonical_reference}.")

        state_energy_hartree = np.asarray(payload.get("state_energy_hartree"), dtype=float).reshape(-1)
        if state_energy_hartree.ndim != 1 or state_energy_hartree.shape[0] <= 1:
            raise ValueError(f"{result_path} state_energy_hartree must have shape [n_states_total] with >= 2 states.")
        n_states_here = int(state_energy_hartree.shape[0])

        transition_pairs = np.asarray(payload.get("transition_pairs"), dtype=int)
        if transition_pairs.ndim != 2 or transition_pairs.shape[1] != 2 or transition_pairs.shape[0] <= 0:
            raise ValueError(f"{result_path} transition_pairs must have shape [n_transition, 2].")
        for pair in transition_pairs.tolist():
            state_i = int(pair[0])
            state_j = int(pair[1])
            if state_i < 0 or state_i >= n_states_here or state_j < 0 or state_j >= n_states_here:
                raise ValueError(
                    f"{result_path} transition pair {pair} is outside the valid state range 0..{n_states_here - 1}."
                )
        if canonical_transition_pairs is None:
            canonical_transition_pairs = transition_pairs.astype(int)
            n_states_total = n_states_here
        elif not np.array_equal(canonical_transition_pairs, transition_pairs):
            raise ValueError(f"{result_path} transition_pairs do not match the canonical pair ordering.")
        elif int(n_states_total or 0) != n_states_here:
            raise ValueError(f"{result_path} state_energy_hartree shape does not match prior successful samples.")

        n_transition = int(canonical_transition_pairs.shape[0])
        transition_dipole_au = np.asarray(payload.get("transition_dipole_au"), dtype=float)
        if transition_dipole_au.shape != (n_transition, 3):
            raise ValueError(
                f"{result_path} transition_dipole_au must have shape [{n_transition}, 3], got {transition_dipole_au.shape}."
            )
        transition_intensity = np.asarray(payload.get("transition_intensity"), dtype=float).reshape(-1)
        if transition_intensity.shape != (n_transition,):
            raise ValueError(
                f"{result_path} transition_intensity must have shape [{n_transition}], got {transition_intensity.shape}."
            )

        successful_results[int(sample.sample_idx)] = {
            "state_energy_hartree": state_energy_hartree.astype(float),
            "transition_dipole_au": transition_dipole_au.astype(float),
            "transition_intensity": transition_intensity.astype(float),
        }

    if canonical_transition_pairs is None or n_states_total is None:
        raise ValueError("No successful PySCF results were found in the workspace.")

    n_transition = int(canonical_transition_pairs.shape[0])
    state_energy_array = np.full((bundle.n_samples, int(n_states_total)), np.nan, dtype=float)
    transition_dipole_array = np.full((bundle.n_samples, n_transition, 3), np.nan, dtype=float)
    transition_intensity_array = np.full((bundle.n_samples, n_transition), np.nan, dtype=float)

    for sample_idx, payload in successful_results.items():
        state_energy_array[sample_idx] = np.asarray(payload["state_energy_hartree"], dtype=float)
        transition_dipole_array[sample_idx] = np.asarray(payload["transition_dipole_au"], dtype=float)
        transition_intensity_array[sample_idx] = np.asarray(payload["transition_intensity"], dtype=float)

    profile_id = normalize_profile_id(
        prepare_manifest.get("profile_id"),
        label="prepare_manifest.json profile_id",
    )
    profile_label = str(prepare_manifest.get("profile_label") or "").strip()
    electronic_dir = bundle.bundle_path / "electronics" / profile_id
    _prepare_profile_output_dir(electronic_dir)
    write_npy(electronic_dir / "state_energy_hartree.npy", state_energy_array)
    write_npy(electronic_dir / "transition_pairs.npy", canonical_transition_pairs.astype(int))
    write_npy(electronic_dir / "transition_dipole_au.npy", transition_dipole_array)
    write_npy(electronic_dir / "transition_intensity.npy", transition_intensity_array)

    profile_manifest: dict[str, Any] = {
        "profile_id": profile_id,
        "label": profile_label,
        "engine": "pyscf",
        "method": "tddft",
        "reference": str(canonical_reference or ""),
        "xc": str(prepare_manifest.get("xc") or ""),
        "basis": str(prepare_manifest.get("basis") or ""),
        "n_excited_states": int(prepare_manifest.get("n_excited_states") or 0),
        "bundle_label": str(bundle.manifest.get("label") or ""),
        "batch_id": str(bundle.batch_id),
        "topology_signature": str(bundle.topology_signature),
        "n_samples": int(bundle.n_samples),
        "n_atoms": int(bundle.n_atoms),
        "sample_ids": list(bundle.sample_ids),
        "channels": _electronic_channel_entries(),
        "n_states": int(n_states_total),
        "n_transition": int(n_transition),
        "workspace_dir": str(resolved_workspace_dir),
        "success_count": int(len(successful_results)),
        "failed_count": int(len(failed_samples)),
        "failed_samples": failed_samples,
        "assembled_at_utc": utc_now_iso(),
    }
    write_json(electronic_dir / "manifest.json", profile_manifest)

    profile_index_entry = {
        "id": profile_id,
        "label": profile_label,
        "path": f"electronics/{profile_id}",
        "engine": "pyscf",
        "method": "tddft",
        "reference": str(canonical_reference or ""),
        "xc": str(prepare_manifest.get("xc") or ""),
        "basis": str(prepare_manifest.get("basis") or ""),
        "n_excited_states": int(prepare_manifest.get("n_excited_states") or 0),
        "success_count": int(len(successful_results)),
        "failed_count": int(len(failed_samples)),
    }
    updated_manifest = _upsert_profile_index_entry(
        manifest=dict(bundle.manifest),
        profile_entry=profile_index_entry,
    )
    write_json(bundle.bundle_path / "manifest.json", updated_manifest)

    return bundle.bundle_path


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Assemble completed PySCF result directories back into a geometry sampling directory.",
    )
    parser.add_argument(
        "--bundle",
        "--sampling-dir",
        dest="bundle",
        required=True,
        help="Path to the original geometry sampling directory",
    )
    parser.add_argument(
        "--workspace",
        default=None,
        help="Optional prepared workspace directory. Defaults to auto-discovery under <sampling_dir>/electronic_workspaces.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_arg_parser()
    args = parser.parse_args(argv)
    if args.workspace is not None:
        bundle_path = assemble_distribution_bundle(
            bundle_path=Path(args.bundle),
            workspace_dir=Path(args.workspace),
        )
        print(f"Updated electronic profiles under {bundle_path / 'electronics'}")
        return 0

    batch_result = assemble_distribution_workspaces(bundle_path=Path(args.bundle))
    for success in batch_result.successes:
        print(f"[ok] {success.workspace_dir} -> {success.profile_id} ({success.profile_label})")
    for failure in batch_result.failures:
        print(f"[failed] {failure.workspace_dir}: {failure.error}")
    print(
        "Processed "
        f"{batch_result.processed_count} workspace(s): "
        f"{batch_result.success_count} succeeded, "
        f"{batch_result.failure_count} failed."
    )
    if batch_result.success_count > 0:
        print(f"Updated electronic profiles under {batch_result.bundle_path / 'electronics'}")
    return 0 if batch_result.failure_count <= 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
