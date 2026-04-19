from __future__ import annotations

import argparse
import pickle
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional


SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

try:
    from .read_ds import filter_hidden_keys, parse_ds_binary
except ImportError:
    from read_ds import filter_hidden_keys, parse_ds_binary  # type: ignore[no-redef]


def discover_run_ids(baseroot: Path) -> List[int]:
    """Find numeric run directories directly under baseroot."""
    run_ids: List[int] = []
    for entry in baseroot.iterdir():
        if entry.is_dir() and entry.name.isdigit():
            run_ids.append(int(entry.name))
    run_ids.sort()
    return run_ids


def aggregate_ds_files(
    baseroot: Path,
    output_filename: str,
    start_index: Optional[int] = None,
    end_index: Optional[int] = None,
) -> int:
    """Aggregate dump-calc*.bin.ds directly into one pkl file."""
    if not baseroot.exists() or not baseroot.is_dir():
        print(f"[ERROR] Base directory does not exist or is not a directory: {baseroot}", file=sys.stderr)
        return 1

    all_run_ids = discover_run_ids(baseroot)
    if not all_run_ids:
        print(f"[ERROR] No numeric run directories found under: {baseroot}", file=sys.stderr)
        return 1

    if start_index is not None:
        if end_index is None:
            end_index = start_index
        if start_index > end_index:
            print(f"[ERROR] Invalid range: start ({start_index}) > end ({end_index})", file=sys.stderr)
            return 1
        run_ids = [run_id for run_id in all_run_ids if start_index <= run_id <= end_index]
    else:
        run_ids = all_run_ids

    print("--- Starting DS Aggregation ---")
    print(f"Base Directory: {baseroot}")
    if start_index is None:
        print(f"Run directories discovered: {len(all_run_ids)}")
    else:
        print(f"Run directories discovered: {len(all_run_ids)} (filtered to {len(run_ids)} by range {start_index}-{end_index})")

    master_dataset: Dict[str, Any] = {}
    scanned_count = len(run_ids)
    success_count = 0
    missing_count = 0
    empty_count = 0
    failed_count = 0

    for run_id in run_ids:
        run_key = str(run_id)
        ds_path = baseroot / run_key / f"dump-calc{run_id}.bin.ds"

        if not ds_path.exists():
            print(f"[WARN] Skipping run {run_id}: file not found ({ds_path})")
            missing_count += 1
            continue

        try:
            file_size = ds_path.stat().st_size
        except OSError as exc:
            print(f"[WARN] Skipping run {run_id}: cannot stat file ({exc})")
            failed_count += 1
            continue

        if file_size == 0:
            print(f"[WARN] Skipping run {run_id}: file is empty ({ds_path})")
            empty_count += 1
            continue

        try:
            dataset = parse_ds_binary(str(ds_path), verbose=False)
            dataset = filter_hidden_keys(dataset)
            master_dataset[run_key] = dataset
            success_count += 1
        except Exception as exc:
            print(f"[WARN] Skipping run {run_id}: parse failed ({exc})")
            failed_count += 1

    print("\n--- Aggregation Summary ---")
    print(f"Scanned runs: {scanned_count}")
    print(f"Successful runs: {success_count}")
    print(f"Missing files: {missing_count}")
    print(f"Empty files: {empty_count}")
    print(f"Parse failures: {failed_count}")

    if success_count == 0:
        print("[ERROR] No datasets aggregated. Output file not created.", file=sys.stderr)
        return 1

    output_path = baseroot / output_filename
    try:
        with open(output_path, 'wb') as f:
            pickle.dump(master_dataset, f)
    except Exception as exc:
        print(f"[ERROR] Failed to save output file {output_path}: {exc}", file=sys.stderr)
        return 1

    print(f"SUCCESS: Saved aggregated dataset to {output_path}")
    print(f"Total keys in master dataset: {len(master_dataset)}")
    return 0


def main() -> None:
    examples = """
Examples:
  # 1) Aggregate all runs under run0 into run0/dump_all.pkl:
  python scripts/dataset_aggregate/aggregate_pkl.py -b run0

  # 2) Aggregate all runs with a custom output filename:
  python scripts/dataset_aggregate/aggregate_pkl.py -b run0 -o my_dump_all.pkl

  # 3) Aggregate only a run range:
  python scripts/dataset_aggregate/aggregate_pkl.py -b run0 -s 0 -e 31

  # 4) Aggregate only one run:
  python scripts/dataset_aggregate/aggregate_pkl.py -b run0 -s 7
"""

    parser = argparse.ArgumentParser(
        description="Aggregate dump-calc*.bin.ds directly into one master pickle.",
        formatter_class=argparse.RawTextHelpFormatter,
        epilog=examples,
    )
    parser.add_argument("-b", "--baseroot", required=True, help="Base directory (e.g., run0)")
    parser.add_argument("-o", "--output_filename", default="dump_all.pkl", help="Output filename (default: dump_all.pkl)")
    parser.add_argument("-s", "--start", type=int, required=False, help="Optional start run index (inclusive)")
    parser.add_argument("-e", "--end", type=int, required=False, help="Optional end run index (inclusive)")

    args = parser.parse_args()

    exit_code = aggregate_ds_files(
        baseroot=Path(args.baseroot),
        output_filename=args.output_filename,
        start_index=args.start,
        end_index=args.end,
    )
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
