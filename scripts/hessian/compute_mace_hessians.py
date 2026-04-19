from __future__ import annotations

import argparse
import hashlib
import os
import sys
from pathlib import Path
from typing import Any, Callable, Sequence

import numpy as np


SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

try:
    from .common import (
        HessianTarget,
        HessianWorkspaceResult,
        default_workspace_dir,
        prepare_workspace_dir,
        resolve_hessian_targets,
        slugify_workspace_part,
    )
except ImportError:
    from common import (  # type: ignore[no-redef]
        HessianTarget,
        HessianWorkspaceResult,
        default_workspace_dir,
        prepare_workspace_dir,
        resolve_hessian_targets,
        slugify_workspace_part,
    )

from scripts.basic.units import ANGSTROM_TO_BOHR, BOHR_TO_ANGSTROM, EV_TO_HARTREE
from scripts.electronic_structure.common import (
    coords_bohr_to_xyz_text,
    normalize_profile_id,
    utc_now_iso,
    write_json,
    write_npy,
    write_text,
)


def _configure_thread_env(*, num_threads: int | None) -> None:
    if num_threads is None:
        return
    if int(num_threads) <= 0:
        raise ValueError("num_threads must be >= 1 when provided.")

    thread_text = str(int(num_threads))
    for env_name in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS"):
        os.environ.setdefault(env_name, thread_text)

    try:
        import torch
    except ImportError:
        return

    torch.set_num_threads(int(num_threads))


def _build_mace_calculator(
    *,
    calculator_factory: Callable[..., Any] | None,
    model_path: str,
    device: str,
    default_dtype: str,
    energy_units_to_ev: float,
    length_units_to_a: float,
    head: str | None,
) -> Any:
    if calculator_factory is None:
        try:
            from mace.calculators import MACECalculator
        except ImportError as exc:
            raise ImportError(
                "MACE Hessian workflow requires optional dependencies 'mace', 'torch', and 'ase'."
            ) from exc
        calculator_factory = MACECalculator

    kwargs: dict[str, Any] = {
        "model_paths": str(model_path),
        "device": str(device),
        "default_dtype": str(default_dtype),
        "energy_units_to_eV": float(energy_units_to_ev),
        "length_units_to_A": float(length_units_to_a),
    }
    if head is not None:
        kwargs["head"] = str(head)

    calculator = calculator_factory(**kwargs)
    num_models = int(getattr(calculator, "num_models", 1) or 1)
    if num_models != 1:
        raise ValueError("Only single-model MACE Hessian evaluation is supported in this v1 script.")
    return calculator


def _build_atoms(
    *,
    atom_numbers: np.ndarray,
    coords_bohr: np.ndarray,
    charge: int,
    multiplicity: int,
) -> Any:
    try:
        from ase import Atoms
    except ImportError as exc:
        raise ImportError("MACE Hessian workflow requires optional dependency 'ase'.") from exc

    atoms = Atoms(
        numbers=np.asarray(atom_numbers, dtype=int).reshape(-1).tolist(),
        positions=np.asarray(coords_bohr, dtype=float) * float(BOHR_TO_ANGSTROM),
    )
    atoms.info["total_charge"] = int(charge)
    atoms.info["total_spin"] = int(max(multiplicity - 1, 0))
    return atoms


def _normalize_hessian_matrix(raw_hessian: Any, *, n_atoms: int) -> np.ndarray:
    matrix = np.asarray(raw_hessian, dtype=float)
    cart_dim = int(n_atoms) * 3
    if matrix.shape == (cart_dim, cart_dim):
        normalized = matrix
    elif matrix.shape == (cart_dim, int(n_atoms), 3):
        normalized = matrix.reshape(cart_dim, cart_dim)
    elif matrix.shape == (int(n_atoms), 3, int(n_atoms), 3):
        normalized = matrix.reshape(cart_dim, cart_dim)
    elif matrix.shape == (int(n_atoms), int(n_atoms), 3, 3):
        normalized = np.transpose(matrix, (0, 2, 1, 3)).reshape(cart_dim, cart_dim)
    else:
        raise ValueError(
            "Unsupported MACE Hessian tensor shape. "
            f"Expected one of {(cart_dim, cart_dim)}, {(cart_dim, int(n_atoms), 3)}, "
            f"{(int(n_atoms), 3, int(n_atoms), 3)}, or {(int(n_atoms), int(n_atoms), 3, 3)}, "
            f"found {matrix.shape}."
        )
    return np.asarray(0.5 * (normalized + normalized.T), dtype=float)


def _target_comment_line(target: HessianTarget) -> str:
    parts = [
        f"output_id={target.output_id}",
        f"source_kind={target.source_kind}",
        f"sample_id={target.sample_id}",
        f"sample_idx={target.sample_idx}",
    ]
    if target.selection_id is not None:
        parts.append(f"selection_id={target.selection_id}")
    if target.subset_geometry_index is not None:
        parts.append(f"subset_geometry_index={target.subset_geometry_index}")
    return " ".join(parts)


def _target_index_payload(target: HessianTarget, *, status: str, error_message: str | None = None) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "output_id": str(target.output_id),
        "path": f"samples/{target.output_id}",
        "status": str(status),
        "source_kind": str(target.source_kind),
        "sample_id": str(target.sample_id),
        "sample_idx": int(target.sample_idx),
        "selection_id": (None if target.selection_id is None else str(target.selection_id)),
        "subset_geometry_index": (
            None if target.subset_geometry_index is None else int(target.subset_geometry_index)
        ),
    }
    if error_message is not None:
        payload["error_message"] = str(error_message)
    return payload


def _default_profile_id(*, bundle: Any, model_path: str, selection_id: str | None, targets: Sequence[HessianTarget]) -> str:
    model_slug = slugify_workspace_part(Path(str(model_path)).name, fallback="model")
    if selection_id is not None:
        scope_slug = f"selection_{slugify_workspace_part(selection_id, fallback='selection')}"
    else:
        is_full_bundle = len(targets) == int(bundle.n_samples) and all(
            int(target.sample_idx) == index for index, target in enumerate(targets)
        )
        if is_full_bundle:
            scope_slug = "all"
        elif len(targets) == 1:
            scope_slug = slugify_workspace_part(targets[0].output_id, fallback="sample")
        else:
            digest = hashlib.sha1(
                "|".join(str(target.output_id) for target in targets).encode("utf-8")
            ).hexdigest()[:8]
            scope_slug = f"subset_{digest}"
    return normalize_profile_id(
        "__".join(["mace_hessian", model_slug, scope_slug]),
        label="profile_id",
    )


def _default_profile_label(*, model_path: str, selection_id: str | None, target_count: int) -> str:
    source_label = (
        f"selection {selection_id}"
        if selection_id is not None
        else ("1 sampled geometry" if int(target_count) == 1 else f"{int(target_count)} sampled geometries")
    )
    return f"MACE Hessian ({Path(str(model_path)).name}; {source_label})"


def compute_mace_hessians(
    *,
    bundle_path: Path,
    model_path: str,
    workspace_dir: Path | None = None,
    selection_id: str | None = None,
    sample_indices: Sequence[int | str] | None = None,
    sample_ids: Sequence[str] | None = None,
    subset_geometry_indices: Sequence[int | str] | None = None,
    device: str = "cpu",
    default_dtype: str = "float64",
    energy_units_to_ev: float = 1.0,
    length_units_to_a: float = 1.0,
    head: str | None = None,
    profile_id: str | None = None,
    profile_label: str | None = None,
    num_threads: int | None = None,
    force: bool = False,
    calculator_factory: Callable[..., Any] | None = None,
) -> HessianWorkspaceResult:
    if not str(model_path).strip():
        raise ValueError("model_path must be a non-empty string.")
    if str(default_dtype).strip() not in {"float32", "float64"}:
        raise ValueError("default_dtype must be either 'float32' or 'float64'.")
    if float(energy_units_to_ev) <= 0:
        raise ValueError("energy_units_to_ev must be positive.")
    if float(length_units_to_a) <= 0:
        raise ValueError("length_units_to_a must be positive.")

    bundle, targets = resolve_hessian_targets(
        bundle_path=Path(bundle_path),
        selection_id=selection_id,
        sample_indices=sample_indices,
        sample_ids=sample_ids,
        subset_geometry_indices=subset_geometry_indices,
    )
    normalized_selection_id = None if selection_id is None else normalize_profile_id(selection_id, label="selection_id")
    normalized_profile_id = normalize_profile_id(
        profile_id
        or _default_profile_id(
            bundle=bundle,
            model_path=str(model_path),
            selection_id=normalized_selection_id,
            targets=targets,
        ),
        label="profile_id",
    )
    normalized_profile_label = str(
        profile_label
        or _default_profile_label(
            model_path=str(model_path),
            selection_id=normalized_selection_id,
            target_count=len(targets),
        )
    ).strip()
    if not normalized_profile_label:
        raise ValueError("profile_label must be a non-empty string.")

    if workspace_dir is None:
        workspace_dir = default_workspace_dir(sampling_dir=bundle.bundle_path, profile_id=normalized_profile_id)
    workspace_dir = Path(workspace_dir).resolve()
    prepare_workspace_dir(workspace_dir, force=force)
    samples_dir = workspace_dir / "samples"
    samples_dir.mkdir(parents=True, exist_ok=False)

    _configure_thread_env(num_threads=num_threads)
    calculator = _build_mace_calculator(
        calculator_factory=calculator_factory,
        model_path=str(model_path),
        device=str(device),
        default_dtype=str(default_dtype),
        energy_units_to_ev=float(energy_units_to_ev),
        length_units_to_a=float(length_units_to_a),
        head=(None if head is None else str(head)),
    )
    native_to_ev_per_ang2 = float(energy_units_to_ev) / float(length_units_to_a) ** 2
    ev_per_ang2_to_hartree_per_bohr2 = float(EV_TO_HARTREE) / float(ANGSTROM_TO_BOHR) ** 2

    target_index_payload: list[dict[str, Any]] = []
    failed_targets: list[dict[str, Any]] = []
    success_count = 0
    all_structures_xyz_frames: list[str] = []

    started_at_utc = utc_now_iso()
    for target in targets:
        sample_dir = samples_dir / target.output_id
        sample_dir.mkdir(parents=False, exist_ok=False)
        coords_bohr = np.asarray(bundle.coords_bohr[target.sample_idx], dtype=float)
        coords_ang = np.asarray(coords_bohr * float(BOHR_TO_ANGSTROM), dtype=float)
        geometry_xyz = coords_bohr_to_xyz_text(
            bundle.atom_numbers,
            coords_bohr,
            comment_line=_target_comment_line(target),
        )
        write_npy(sample_dir / "coords_bohr.npy", coords_bohr)
        write_npy(sample_dir / "coords_ang.npy", coords_ang)
        write_text(sample_dir / "geometry.xyz", geometry_xyz)
        all_structures_xyz_frames.append(geometry_xyz)

        target_meta: dict[str, Any] = {
            "output_id": str(target.output_id),
            "source_kind": str(target.source_kind),
            "sample_id": str(target.sample_id),
            "sample_idx": int(target.sample_idx),
            "selection_id": (None if target.selection_id is None else str(target.selection_id)),
            "subset_geometry_index": (
                None if target.subset_geometry_index is None else int(target.subset_geometry_index)
            ),
            "model_path": str(model_path),
            "device": str(device),
            "default_dtype": str(default_dtype),
            "energy_units_to_ev": float(energy_units_to_ev),
            "length_units_to_a": float(length_units_to_a),
            "hessian_units": {
                "native": "model_energy_units / model_length_units^2",
                "ev_per_ang2": "eV / angstrom^2",
                "hartree_per_bohr2": "Hartree / bohr^2",
            },
        }

        try:
            atoms = _build_atoms(
                atom_numbers=bundle.atom_numbers,
                coords_bohr=coords_bohr,
                charge=int(bundle.charge),
                multiplicity=int(bundle.multiplicity),
            )
            raw_hessian = calculator.get_hessian(atoms)
            hessian_native = _normalize_hessian_matrix(raw_hessian, n_atoms=bundle.n_atoms)
            hessian_ev_per_ang2 = np.asarray(hessian_native * native_to_ev_per_ang2, dtype=float)
            hessian_hartree_per_bohr2 = np.asarray(
                hessian_ev_per_ang2 * ev_per_ang2_to_hartree_per_bohr2,
                dtype=float,
            )

            write_npy(sample_dir / "hessian_cartesian_model_units.npy", hessian_native)
            write_npy(sample_dir / "hessian_cartesian_ev_per_ang2.npy", hessian_ev_per_ang2)
            write_npy(sample_dir / "hessian_cartesian_hartree_per_bohr2.npy", hessian_hartree_per_bohr2)

            target_meta["status"] = "ok"
            target_meta["cartesian_dimension"] = int(hessian_native.shape[0])
            write_json(sample_dir / "target_meta.json", target_meta)
            target_index_payload.append(_target_index_payload(target, status="ok"))
            success_count += 1
        except Exception as exc:  # noqa: BLE001
            target_meta["status"] = "error"
            target_meta["error_message"] = str(exc)
            write_json(sample_dir / "target_meta.json", target_meta)
            target_index_payload.append(_target_index_payload(target, status="error", error_message=str(exc)))
            failed_targets.append(
                {
                    "output_id": str(target.output_id),
                    "sample_id": str(target.sample_id),
                    "sample_idx": int(target.sample_idx),
                    "error_message": str(exc),
                }
            )

    completed_at_utc = utc_now_iso()
    write_json(workspace_dir / "target_index.json", target_index_payload)
    write_text(workspace_dir / "all_structures.xyz", "".join(all_structures_xyz_frames))
    write_json(
        workspace_dir / "manifest.json",
        {
            "profile_id": normalized_profile_id,
            "profile_label": normalized_profile_label,
            "created_at_utc": started_at_utc,
            "completed_at_utc": completed_at_utc,
            "sampling_dir": str(bundle.bundle_path),
            "selection_id": normalized_selection_id,
            "engine": "mace",
            "method": "cartesian_hessian",
            "model_path": str(model_path),
            "device": str(device),
            "default_dtype": str(default_dtype),
            "head": (None if head is None else str(head)),
            "energy_units_to_ev": float(energy_units_to_ev),
            "length_units_to_a": float(length_units_to_a),
            "source_name": str(bundle.source_name),
            "batch_id": str(bundle.batch_id),
            "topology_signature": str(bundle.topology_signature),
            "charge": int(bundle.charge),
            "multiplicity": int(bundle.multiplicity),
            "n_atoms": int(bundle.n_atoms),
            "n_targets": int(len(targets)),
            "success_count": int(success_count),
            "failed_count": int(len(failed_targets)),
            "failed_targets": failed_targets,
            "units": {
                "coords_bohr": "bohr",
                "coords_ang": "angstrom",
                "hessian_cartesian_model_units": "model_energy_units / model_length_units^2",
                "hessian_cartesian_ev_per_ang2": "eV / angstrom^2",
                "hessian_cartesian_hartree_per_bohr2": "Hartree / bohr^2",
            },
            "paths": {
                "target_index": "target_index.json",
                "all_structures": "all_structures.xyz",
                "samples_dir": "samples",
            },
        },
    )

    return HessianWorkspaceResult(
        workspace_dir=workspace_dir,
        profile_id=normalized_profile_id,
        target_count=len(targets),
        success_count=success_count,
        failed_count=len(failed_targets),
    )


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Compute Cartesian Hessians for one or more sampling geometries with a MACE model.",
    )
    parser.add_argument(
        "--bundle",
        "--sampling-dir",
        dest="bundle",
        required=True,
        help="Path to the input geometry sampling directory.",
    )
    parser.add_argument(
        "--model",
        "--model-path",
        dest="model_path",
        required=True,
        help="Path to a MACE model file.",
    )
    parser.add_argument(
        "--workspace",
        "--outdir",
        dest="workspace",
        default=None,
        help="Optional workspace directory override. Defaults to <sampling_dir>/hessian_workspaces/<profile_id>.",
    )
    parser.add_argument(
        "--selection-id",
        default=None,
        help="Optional selection/<id> source. When omitted, targets come from the full sampling bundle.",
    )
    parser.add_argument(
        "--sample-idx",
        dest="sample_indices",
        action="append",
        default=None,
        help="Restrict to one original sample index. Repeat the flag to keep multiple samples.",
    )
    parser.add_argument(
        "--sample-id",
        dest="sample_ids",
        action="append",
        default=None,
        help="Restrict to one original sample id. Repeat the flag to keep multiple samples.",
    )
    parser.add_argument(
        "--subset-geometry-index",
        dest="subset_geometry_indices",
        action="append",
        default=None,
        help="Restrict selection mode to one subset geometry index. Repeat the flag to keep multiple indices.",
    )
    parser.add_argument("--device", default="cpu", help="Torch device passed to the MACE calculator.")
    parser.add_argument(
        "--default-dtype",
        default="float64",
        choices=("float32", "float64"),
        help="Torch default dtype used by the MACE calculator. float64 is safer for second derivatives.",
    )
    parser.add_argument(
        "--energy-units-to-ev",
        type=float,
        default=1.0,
        help="Energy conversion factor from native model units to eV.",
    )
    parser.add_argument(
        "--length-units-to-a",
        type=float,
        default=1.0,
        help="Length conversion factor from native model units to angstrom.",
    )
    parser.add_argument(
        "--head",
        default=None,
        help="Optional MACE head name for multi-head models.",
    )
    parser.add_argument(
        "--profile-id",
        default=None,
        help="Optional workspace profile id. Defaults to a stable slug derived from the model path and target scope.",
    )
    parser.add_argument(
        "--profile-label",
        default=None,
        help="Optional human-readable workspace label.",
    )
    parser.add_argument(
        "--num-threads",
        type=int,
        default=None,
        help="Optional thread count used for PyTorch and BLAS environment defaults.",
    )
    parser.add_argument("--force", action="store_true", help="Delete and rebuild an existing non-empty workspace.")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_arg_parser()
    args = parser.parse_args(argv)

    try:
        result = compute_mace_hessians(
            bundle_path=Path(args.bundle),
            model_path=str(args.model_path),
            workspace_dir=(None if args.workspace is None else Path(args.workspace)),
            selection_id=args.selection_id,
            sample_indices=args.sample_indices,
            sample_ids=args.sample_ids,
            subset_geometry_indices=args.subset_geometry_indices,
            device=str(args.device),
            default_dtype=str(args.default_dtype),
            energy_units_to_ev=float(args.energy_units_to_ev),
            length_units_to_a=float(args.length_units_to_a),
            head=args.head,
            profile_id=args.profile_id,
            profile_label=args.profile_label,
            num_threads=(None if args.num_threads is None else int(args.num_threads)),
            force=bool(args.force),
        )
    except (ImportError, ValueError) as exc:
        raise SystemExit(str(exc)) from exc

    print(
        f"Computed MACE Hessians at {result.workspace_dir} "
        f"(targets={result.target_count}, success={result.success_count}, failed={result.failed_count})"
    )
    return 0 if int(result.failed_count) == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())

