import argparse
import pickle
import sys
from pathlib import Path

from .config import load_config
from .dataset import prepare_dataset
from .renderer import write_single_page


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate a single-page interactive dashboard for trajectory observables."
    )
    parser.add_argument("-i", "--input", default="run0/dump_all.pkl", help="Input aggregated pickle file")
    parser.add_argument("-o", "--out-dir", default="analysis_viz", help="Output directory")
    parser.add_argument("-c", "--config", default="tools/viz_config.yaml", help="YAML config path")

    parser.add_argument("--time-key", default="_.0.record.time", help="Time key")
    parser.add_argument("--coord-key", default="_.0.record.x", help="Coordinate key")
    parser.add_argument("--etot-key", default="_.0.record.Etot", help="Etot key")
    parser.add_argument("--eig-key", default="_.0.record.eig", help="eig key")
    parser.add_argument("--nac-key", default="_.0.record.nac", help="nac key")

    parser.add_argument(
        "--drop-zero-frames",
        dest="drop_zero_frames",
        action="store_true",
        default=True,
        help="Drop frames where all coordinates are zero (default: on)",
    )
    parser.add_argument(
        "--keep-zero-frames",
        dest="drop_zero_frames",
        action="store_false",
        help="Disable zero-frame filtering",
    )

    return parser.parse_args()


def main() -> None:
    args = parse_args()

    input_path = Path(args.input)
    config_path = Path(args.config)
    out_dir = Path(args.out_dir)

    if not input_path.exists():
        print(f"[ERROR] Input file not found: {input_path}", file=sys.stderr)
        sys.exit(1)

    try:
        cfg = load_config(config_path)
    except Exception as exc:
        print(f"[ERROR] Failed to load config: {exc}", file=sys.stderr)
        sys.exit(1)

    try:
        with open(input_path, "rb") as f:
            master_dataset = pickle.load(f)
    except Exception as exc:
        print(f"[ERROR] Failed to load pickle: {exc}", file=sys.stderr)
        sys.exit(1)

    prepared = prepare_dataset(
        master_dataset=master_dataset,
        time_key=args.time_key,
        coord_key=args.coord_key,
        etot_key=args.etot_key,
        eig_key=args.eig_key,
        nac_key=args.nac_key,
        drop_zero_frames=args.drop_zero_frames,
    )

    if not prepared["meta"]["traj_ids"]:
        print("[ERROR] No valid trajectories found after filtering", file=sys.stderr)
        sys.exit(1)

    prepared["meta"]["source_pkl"] = str(input_path.resolve())

    payload = {
        "meta": prepared["meta"],
        "defaults": {
            "panels": cfg["panels"],
            "plot": cfg["plot"],
            "nac": cfg["nac"],
            "ui": cfg["ui"],
        },
        "trajectories": prepared["trajectories"],
    }

    write_single_page(out_dir, payload)

    print("--- Done ---")
    print(f"Input: {input_path}")
    print(f"Trajectories: {len(prepared['meta']['traj_ids'])}")
    print(f"Drop Zero Frames: {args.drop_zero_frames}")
    print(f"Default Panels: {cfg['ui']['default_panel_count']}")
    print(f"Max Panels: {cfg['ui']['max_panels']}")
    print(f"Output: {out_dir / 'index.html'}")


if __name__ == "__main__":
    main()
