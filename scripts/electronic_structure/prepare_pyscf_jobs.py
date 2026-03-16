from __future__ import annotations

import argparse
import re
import shutil
from pathlib import Path
from typing import Any

try:
    from .common import (
        DEFAULT_MAX_CYCLE,
        DEFAULT_SCF_CONV_TOL,
        DEFAULT_TD_CONV_TOL,
        build_generated_pyscf_job_script,
        build_run_all_script,
        coords_bohr_to_xyz_text,
        load_geometry_bundle,
        normalize_profile_id,
        write_json,
        write_text,
    )
except ImportError:
    from common import (  # type: ignore[no-redef]
        DEFAULT_MAX_CYCLE,
        DEFAULT_SCF_CONV_TOL,
        DEFAULT_TD_CONV_TOL,
        build_generated_pyscf_job_script,
        build_run_all_script,
        coords_bohr_to_xyz_text,
        load_geometry_bundle,
        normalize_profile_id,
        write_json,
        write_text,
    )


def _slugify_workspace_part(value: str, *, fallback: str) -> str:
    text = re.sub(r"[^A-Za-z0-9._-]+", "_", str(value or "").strip())
    text = re.sub(r"_+", "_", text).strip("._-")
    return text or fallback


def _default_workspace_dir(
    *,
    sampling_dir: Path,
    profile_id: str,
) -> Path:
    return sampling_dir / "electronic_workspaces" / str(profile_id).strip()


def _default_profile_id(
    *,
    reference: str,
    xc: str,
    basis: str,
    n_excited_states: int,
) -> str:
    return "__".join(
        [
            "pyscf_tddft",
            _slugify_workspace_part(reference, fallback="auto"),
            _slugify_workspace_part(xc, fallback="xc"),
            _slugify_workspace_part(basis, fallback="basis"),
            f"n{int(n_excited_states)}",
        ]
    )


def _default_profile_label(
    *,
    reference: str,
    xc: str,
    basis: str,
    n_excited_states: int,
) -> str:
    return f"TDDFT {str(xc).strip()}/{str(basis).strip()} ({str(reference).strip().upper()}, n={int(n_excited_states)})"


def _prepare_workspace_dir(path: Path, *, force: bool) -> None:
    if path.exists():
        if not path.is_dir():
            raise ValueError(f"Workspace path exists but is not a directory: {path}")
        if any(path.iterdir()):
            if not force:
                raise ValueError(f"Workspace directory must be empty unless --force is provided: {path}")
            shutil.rmtree(path)
        else:
            path.rmdir()
    path.mkdir(parents=True, exist_ok=False)


def prepare_workspace(
    *,
    bundle_path: Path,
    workspace_dir: Path | None,
    xc: str,
    basis: str,
    n_excited_states: int,
    reference: str = "auto",
    profile_id: str | None = None,
    profile_label: str | None = None,
    scf_conv_tol: float = DEFAULT_SCF_CONV_TOL,
    td_conv_tol: float = DEFAULT_TD_CONV_TOL,
    max_cycle: int = DEFAULT_MAX_CYCLE,
    num_threads: int | None = None,
    memory_mb: int | None = None,
    force: bool = False,
) -> Path:
    if not str(xc).strip():
        raise ValueError("xc must be a non-empty string.")
    if not str(basis).strip():
        raise ValueError("basis must be a non-empty string.")
    if int(n_excited_states) <= 0:
        raise ValueError("n_excited_states must be >= 1.")
    if float(scf_conv_tol) <= 0 or float(td_conv_tol) <= 0:
        raise ValueError("SCF and TD convergence tolerances must be positive.")
    if int(max_cycle) <= 0:
        raise ValueError("max_cycle must be >= 1.")
    if num_threads is not None and int(num_threads) <= 0:
        raise ValueError("num_threads must be >= 1 when provided.")
    if memory_mb is not None and int(memory_mb) <= 0:
        raise ValueError("memory_mb must be >= 1 when provided.")

    bundle = load_geometry_bundle(bundle_path)
    normalized_reference = str(reference).strip().lower() or "auto"
    normalized_profile_id = normalize_profile_id(
        profile_id
        or _default_profile_id(
            reference=normalized_reference,
            xc=str(xc).strip(),
            basis=str(basis).strip(),
            n_excited_states=int(n_excited_states),
        ),
        label="profile_id",
    )
    normalized_profile_label = str(
        profile_label
        or _default_profile_label(
            reference=normalized_reference,
            xc=str(xc).strip(),
            basis=str(basis).strip(),
            n_excited_states=int(n_excited_states),
        )
    ).strip()
    if not normalized_profile_label:
        raise ValueError("profile_label must be a non-empty string.")
    if workspace_dir is None:
        workspace_dir = _default_workspace_dir(
            sampling_dir=bundle.bundle_path,
            profile_id=normalized_profile_id,
        )
    workspace_dir = Path(workspace_dir).resolve()
    _prepare_workspace_dir(workspace_dir, force=force)
    jobs_dir = workspace_dir / "jobs"
    jobs_dir.mkdir(parents=True, exist_ok=False)

    prepare_manifest: dict[str, Any] = {
        "sampling_dir": str(bundle.bundle_path),
        "batch_id": str(bundle.batch_id),
        "source_name": str(bundle.source_name),
        "n_samples": int(bundle.n_samples),
        "n_atoms": int(bundle.n_atoms),
        "topology_signature": str(bundle.topology_signature),
        "sample_ids": list(bundle.sample_ids),
        "charge": int(bundle.charge),
        "multiplicity": int(bundle.multiplicity),
        "engine": "pyscf",
        "method": "tddft",
        "reference": normalized_reference,
        "profile_id": normalized_profile_id,
        "profile_label": normalized_profile_label,
        "xc": str(xc).strip(),
        "basis": str(basis).strip(),
        "n_excited_states": int(n_excited_states),
        "scf_conv_tol": float(scf_conv_tol),
        "td_conv_tol": float(td_conv_tol),
        "max_cycle": int(max_cycle),
        "num_threads": (None if num_threads is None else int(num_threads)),
        "memory_mb": (None if memory_mb is None else int(memory_mb)),
    }
    write_json(workspace_dir / "prepare_manifest.json", prepare_manifest)
    write_text(workspace_dir / "run_all.sh", build_run_all_script(), executable=True)

    generated_job_script = build_generated_pyscf_job_script()
    for sample in bundle.samples:
        job_dir = jobs_dir / sample.sample_id
        job_dir.mkdir(parents=True, exist_ok=False)
        xyz_text = coords_bohr_to_xyz_text(
            bundle.atom_numbers,
            bundle.coords_bohr[sample.sample_idx],
            comment_line=(
                f"sample_id={sample.sample_id} sample_idx={sample.sample_idx} "
                f"geom_sha1={sample.geom_sha1}"
            ),
        )
        sample_meta = {
            "sample_idx": int(sample.sample_idx),
            "sample_id": str(sample.sample_id),
            "geom_sha1": str(sample.geom_sha1),
            "charge": int(sample.charge),
            "multiplicity": int(sample.multiplicity),
        }
        write_text(job_dir / "geometry.xyz", xyz_text)
        write_json(job_dir / "sample_meta.json", sample_meta)
        write_text(job_dir / "run_pyscf_tddft.py", generated_job_script, executable=True)

    return workspace_dir


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Prepare one PySCF TDDFT job directory per sample from a geometry sampling directory.",
    )
    parser.add_argument(
        "--bundle",
        "--sampling-dir",
        dest="bundle",
        required=True,
        help="Path to the input geometry sampling directory",
    )
    parser.add_argument(
        "--workspace",
        "--outdir",
        dest="workspace",
        default=None,
        help="Optional workspace directory override. Defaults to <sampling_dir>/electronic_workspaces/...",
    )
    parser.add_argument("--xc", required=True, help="PySCF XC functional, e.g. b3lyp")
    parser.add_argument("--basis", required=True, help="PySCF basis set, e.g. 6-31g*")
    parser.add_argument(
        "--nstates",
        required=True,
        type=int,
        help="Number of excited states to request from TDDFT",
    )
    parser.add_argument(
        "--reference",
        default="auto",
        choices=("auto", "rks", "uks"),
        help="Reference determinant family. auto picks RKS for singlets and UKS otherwise.",
    )
    parser.add_argument(
        "--profile-id",
        default=None,
        help="Optional electronic profile id. Defaults to a stable slug derived from the method settings.",
    )
    parser.add_argument(
        "--profile-label",
        default=None,
        help="Optional human-readable electronic profile label.",
    )
    parser.add_argument("--scf-conv-tol", type=float, default=DEFAULT_SCF_CONV_TOL)
    parser.add_argument("--td-conv-tol", type=float, default=DEFAULT_TD_CONV_TOL)
    parser.add_argument("--max-cycle", type=int, default=DEFAULT_MAX_CYCLE)
    parser.add_argument("--num-threads", type=int, default=None)
    parser.add_argument("--memory-mb", type=int, default=None)
    parser.add_argument("--force", action="store_true", help="Delete and rebuild an existing non-empty workspace.")
    return parser


def main() -> None:
    parser = build_arg_parser()
    args = parser.parse_args()
    if int(args.nstates) <= 0:
        raise SystemExit("--nstates must be >= 1")
    if float(args.scf_conv_tol) <= 0 or float(args.td_conv_tol) <= 0:
        raise SystemExit("SCF and TD convergence tolerances must be positive.")
    if int(args.max_cycle) <= 0:
        raise SystemExit("--max-cycle must be >= 1")
    if args.num_threads is not None and int(args.num_threads) <= 0:
        raise SystemExit("--num-threads must be >= 1 when provided.")
    if args.memory_mb is not None and int(args.memory_mb) <= 0:
        raise SystemExit("--memory-mb must be >= 1 when provided.")

    workspace_dir = prepare_workspace(
        bundle_path=Path(args.bundle),
        workspace_dir=(None if args.workspace is None else Path(args.workspace)),
        xc=str(args.xc),
        basis=str(args.basis),
        n_excited_states=int(args.nstates),
        reference=str(args.reference),
        profile_id=args.profile_id,
        profile_label=args.profile_label,
        scf_conv_tol=float(args.scf_conv_tol),
        td_conv_tol=float(args.td_conv_tol),
        max_cycle=int(args.max_cycle),
        num_threads=(None if args.num_threads is None else int(args.num_threads)),
        memory_mb=(None if args.memory_mb is None else int(args.memory_mb)),
        force=bool(args.force),
    )
    print(f"Prepared PySCF workspace at {workspace_dir}")


if __name__ == "__main__":
    main()
