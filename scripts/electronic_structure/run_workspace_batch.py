#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any, Sequence


def _load_json_file(path: Path, *, label: str) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        raise ValueError(f"Failed to read {label} from {path}: {exc}") from exc
    if not isinstance(payload, dict):
        raise ValueError(f"{label} must decode to a JSON object: {path}")
    return payload


def _load_prepare_manifest(workspace_dir: Path) -> dict[str, Any]:
    manifest_path = workspace_dir / "prepare_manifest.json"
    return _load_json_file(manifest_path, label="prepare manifest")


def _load_sample_ids(workspace_dir: Path, *, prepare_manifest: dict[str, Any]) -> list[str]:
    manifest_path = workspace_dir / "prepare_manifest.json"
    sample_ids_raw = prepare_manifest.get("sample_ids")
    if not isinstance(sample_ids_raw, list) or not sample_ids_raw:
        raise ValueError(f"{manifest_path} sample_ids must be a non-empty JSON list.")

    sample_ids: list[str] = []
    seen_ids: set[str] = set()
    jobs_dir = workspace_dir / "jobs"
    if not jobs_dir.is_dir():
        raise ValueError(f"Workspace is missing jobs directory: {jobs_dir}")
    for raw_item in sample_ids_raw:
        sample_id = str(raw_item or "").strip()
        if not sample_id:
            raise ValueError(f"{manifest_path} sample_ids entries must be non-empty strings.")
        if sample_id in seen_ids:
            raise ValueError(f"{manifest_path} sample_ids contains duplicates: {sample_id}")
        job_dir = jobs_dir / sample_id
        if not job_dir.is_dir():
            raise ValueError(f"Workspace job directory is missing for sample_id={sample_id}: {job_dir}")
        seen_ids.add(sample_id)
        sample_ids.append(sample_id)
    return sample_ids


def _configure_thread_env(*, prepare_manifest: dict[str, Any]) -> str | None:
    explicit_env_names = ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS")
    if any(str(os.environ.get(name) or "").strip() for name in explicit_env_names):
        return None

    configured_raw = prepare_manifest.get("num_threads")
    thread_count: int | None = None if configured_raw is None else int(configured_raw)
    if thread_count is None or int(thread_count) <= 0:
        return None

    thread_text = str(int(thread_count))
    for env_name in explicit_env_names:
        os.environ.setdefault(env_name, thread_text)
    return "prepare_manifest.num_threads"


def _resolve_batch_index(args_batch_index: int | None, parser: argparse.ArgumentParser) -> int:
    if args_batch_index is not None:
        return int(args_batch_index)

    raw_value = os.environ.get("SLURM_ARRAY_TASK_ID")
    if raw_value is None or not str(raw_value).strip():
        parser.error("Provide --batch-index or set SLURM_ARRAY_TASK_ID.")
    try:
        return int(raw_value)
    except ValueError as exc:
        parser.error(f"SLURM_ARRAY_TASK_ID must be an integer, got {raw_value!r}.")
        raise AssertionError("argparse.error() should exit") from exc


def _slice_bounds(*, total_count: int, batch_count: int, batch_index: int) -> tuple[int, int]:
    if int(batch_count) <= 0:
        raise ValueError("batch_count must be >= 1.")
    if int(batch_index) < 0 or int(batch_index) >= int(batch_count):
        raise ValueError(f"batch_index must be in [0, {int(batch_count) - 1}], got {batch_index}.")
    base_size = int(total_count // batch_count)
    remainder = int(total_count % batch_count)
    start = int(batch_index * base_size + min(batch_index, remainder))
    end = int(start + base_size + (1 if batch_index < remainder else 0))
    return start, end


def _load_result_status(result_path: Path) -> str | None:
    if not result_path.is_file():
        return None
    try:
        payload = _load_json_file(result_path, label="result payload")
    except ValueError:
        return None
    status = str(payload.get("status") or "").strip().lower()
    return status or None


def _run_single_job(*, job_dir: Path) -> int:
    runner_path = job_dir / "run_pyscf_tddft.py"
    stdout_path = job_dir / "stdout.log"
    if not runner_path.is_file():
        stdout_path.write_text(
            f"Missing PySCF job runner: {runner_path}\n",
            encoding="utf-8",
        )
        return 1

    with stdout_path.open("w", encoding="utf-8") as handle:
        completed = subprocess.run(  # noqa: S603
            [sys.executable, str(runner_path)],
            cwd=str(job_dir),
            stdout=handle,
            stderr=subprocess.STDOUT,
            check=False,
        )
    return int(completed.returncode)


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run one contiguous PySCF workspace batch, typically under a Slurm job array.",
    )
    parser.add_argument(
        "--workspace",
        required=True,
        help="Path to a prepared electronic workspace directory.",
    )
    parser.add_argument(
        "--batch-count",
        required=True,
        type=int,
        help="Total number of batches to partition the prepared samples into.",
    )
    parser.add_argument(
        "--batch-index",
        default=None,
        type=int,
        help="Zero-based batch index. Defaults to $SLURM_ARRAY_TASK_ID when omitted.",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_arg_parser()
    args = parser.parse_args(argv)

    workspace_dir = Path(args.workspace).resolve()
    if not workspace_dir.is_dir():
        raise SystemExit(f"Workspace directory does not exist: {workspace_dir}")
    if int(args.batch_count) <= 0:
        raise SystemExit("--batch-count must be >= 1")

    batch_index = _resolve_batch_index(args.batch_index, parser)
    try:
        prepare_manifest = _load_prepare_manifest(workspace_dir)
        sample_ids = _load_sample_ids(workspace_dir, prepare_manifest=prepare_manifest)
        start, end = _slice_bounds(
            total_count=len(sample_ids),
            batch_count=int(args.batch_count),
            batch_index=int(batch_index),
        )
    except ValueError as exc:
        raise SystemExit(str(exc)) from exc

    thread_source = _configure_thread_env(prepare_manifest=prepare_manifest)
    selected_sample_ids = sample_ids[start:end]
    print(
        f"[batch] workspace={workspace_dir} batch={batch_index}/{int(args.batch_count) - 1} "
        f"samples={len(selected_sample_ids)} slice=[{start}:{end})"
    )
    if thread_source is not None:
        print(
            f"[threads] source={thread_source} OMP_NUM_THREADS={os.environ.get('OMP_NUM_THREADS')} "
            f"MKL_NUM_THREADS={os.environ.get('MKL_NUM_THREADS')} "
            f"OPENBLAS_NUM_THREADS={os.environ.get('OPENBLAS_NUM_THREADS')}"
        )

    executed_count = 0
    skipped_count = 0
    failed_count = 0
    for sample_id in selected_sample_ids:
        job_dir = workspace_dir / "jobs" / sample_id
        result_path = job_dir / "result.json"
        if _load_result_status(result_path) == "ok":
            skipped_count += 1
            print(f"[skip] {sample_id}")
            continue

        executed_count += 1
        return_code = _run_single_job(job_dir=job_dir)
        if return_code != 0:
            failed_count += 1
            print(f"[failed] {sample_id} (exit={return_code})")
        else:
            print(f"[ok] {sample_id}")

    print(
        f"[done] batch={batch_index} executed={executed_count} skipped={skipped_count} "
        f"failed={failed_count} total={len(selected_sample_ids)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
