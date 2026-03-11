from __future__ import annotations

import argparse
import sys
from pathlib import Path

from backend.server.cache import SeriesLRUCache
from backend.server.dataset_store import DatasetLoadOptions, build_empty_dataset_store, load_dataset_store


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run the Observable Dashboard API server (backend-compute mode)."
    )
    parser.add_argument("-i", "--input", default=None, help="Input aggregated pickle file")
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

    parser.add_argument("--host", default="127.0.0.1", help="Bind host")
    parser.add_argument("--port", type=int, default=8000, help="Bind port")
    parser.add_argument("--log-level", default="info", help="uvicorn log level")
    parser.add_argument("--cache-size", type=int, default=512, help="LRU cache entry count")
    parser.add_argument("--mol3d-cache-size", type=int, default=64, help="Molecule3D coordinate cache entry count")

    return parser.parse_args()


def main() -> None:
    args = parse_args()

    try:
        from backend.server.app import create_app
        import uvicorn
    except ImportError as exc:
        print("[ERROR] Missing runtime dependency: fastapi/uvicorn", file=sys.stderr)
        print("Install with: pip install fastapi uvicorn", file=sys.stderr)
        print(f"Detail: {exc}", file=sys.stderr)
        raise SystemExit(1)

    config_path = Path(args.config)
    browse_root = Path.cwd().resolve()

    def _make_options(input_path: Path) -> DatasetLoadOptions:
        return DatasetLoadOptions(
            input_path=input_path,
            config_path=config_path,
            time_key=args.time_key,
            coord_key=args.coord_key,
            etot_key=args.etot_key,
            eig_key=args.eig_key,
            nac_key=args.nac_key,
            drop_zero_frames=args.drop_zero_frames,
        )

    def _load_store_from_path(input_path: Path):
        return load_dataset_store(_make_options(input_path))

    try:
        if args.input:
            store = _load_store_from_path(Path(args.input).resolve())
        else:
            store = build_empty_dataset_store(config_path)
    except (FileNotFoundError, ValueError, RuntimeError) as exc:
        print(f"[ERROR] Failed to initialize dataset store: {exc}", file=sys.stderr)
        raise SystemExit(1)

    app = create_app(
        store,
        SeriesLRUCache(max_entries=args.cache_size),
        mol3d_cache=SeriesLRUCache(max_entries=args.mol3d_cache_size),
        load_store_from_path=_load_store_from_path,
        browse_root=browse_root,
    )

    print("--- Observable Dashboard API ---")
    source_pkl = str(store.meta.get("source_pkl") or "")
    print(f"Browse root: {browse_root}")
    print(f"Input: {source_pkl or '(none loaded)'}")
    print(f"Trajectories: {len(store.traj_ids)}")
    print(f"Series cache entries: {args.cache_size}")
    print(f"Molecule3D cache entries: {args.mol3d_cache_size}")
    print(f"URL: http://{args.host}:{args.port}/")

    uvicorn.run(app, host=args.host, port=args.port, log_level=args.log_level)


if __name__ == "__main__":
    main()
