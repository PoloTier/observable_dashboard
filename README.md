# Observable Dashboard

A web-based dashboard for visualizing molecular dynamics observables and trajectories. It serves both 2D time-series plots and a 3D `3Dmol.js` / WebGL viewer for trajectory playback, measurements, hydrogen-bond overlays, and vector fields.

## Features

- **Interactive 2D Plots**: Visualize time-series data for bonds, angles, dihedrals, energies, eigenvalues, NAC, state populations, and raw keys
- **3D Molecular Viewer**: WebGL-based playback with geometry measurements, hydrogen-bond overlays, NAC/dE/dE-NAC vectors, per-atom render rules, and GIF/WebM export
- **Normal Modes Viewer**: Upload a single `molden` file, parse `frequency` / `FR-NORM-COORD`, and animate one normal mode at a time
- **Ensemble Statistics**: Automatic calculation of mean/median with confidence intervals across multiple trajectories
- **Custom Data Support**: Inspect and plot arbitrary keys from your pickle files
- **Expression Engine**: Evaluate custom mathematical expressions on your data

## Installation

### Requirements

- Python 3.8+
- Dependencies:
  - fastapi
  - uvicorn
  - numpy
  - pyyaml

### Install Dependencies

```bash
pip install fastapi uvicorn numpy pyyaml
```

## Quick Start

### 1. Prepare Your Data

Ensure you have a `dump_all.pkl` file containing your trajectory data with the expected structure (time series, coordinates, energies, etc.).

### 2. Start the Server

```bash
# 方式 1：使用 main.py（推荐）
python main.py -i run0/dump_all.pkl -c ../viz_config.yaml --host 127.0.0.1 --port 8000

# 方式 2：使用模块方式
python -m backend.serve -i run0/dump_all.pkl -c ../viz_config.yaml --host 127.0.0.1 --port 8000

# 方式 3：安装后使用命令行工具
pip install -e .
observable-dashboard -i run0/dump_all.pkl -c ../viz_config.yaml --host 127.0.0.1 --port 8000
```

If you are not using the example config next to this repository, replace `../viz_config.yaml` with your own YAML config path.

### 3. Open in Browser

- Main dashboard: `http://127.0.0.1:8000/`
- 3D viewer: `http://127.0.0.1:8000/molecule3d.html`
- Normal modes viewer: `http://127.0.0.1:8000/normal_modes.html`

## Usage

### Command Line Options

```bash
python main.py [OPTIONS]

Options:
  -i, --input PATH              Input pickle file (default: run0/dump_all.pkl)
  -c, --config PATH             YAML config file (optional)
  --host HOST                   Bind host (default: 127.0.0.1)
  --port PORT                   Bind port (default: 8000)
  --log-level LEVEL             Log level (default: info)
  --cache-size N                LRU cache size (default: 512)
  --mol3d-cache-size N          3D coordinate cache size (default: 64)
  --time-key KEY                Time data key (default: _.0.record.time)
  --coord-key KEY               Coordinate key (default: _.0.record.x)
  --etot-key KEY                Total energy key (default: _.0.record.Etot)
  --eig-key KEY                 Eigenvalue key (default: _.0.record.eig)
  --nac-key KEY                 NAC key (default: _.0.record.nac)
  --drop-zero-frames            Drop zero-coordinate frames (default: on)
  --keep-zero-frames            Keep zero-coordinate frames
```

## API Endpoints

The server provides a REST API:

- `GET /api/healthz` - Health check
- `GET /api/bootstrap` - Initial configuration and metadata
- `POST /api/series` - Get time series for a single trajectory
- `POST /api/ensemble-series` - Get ensemble statistics
- `POST /api/inspect-keys` - Inspect custom data keys
- `POST /api/raw-key-series` - Get raw key time series
- `GET /api/molecule3d/trajectory/{traj_id}` - Get 3D coordinates
- `GET /api/molecule3d/nac/{traj_id}` - Get NAC vectors for a state pair
- `GET /api/molecule3d/de/{traj_id}` - Get dE vectors for a state pair
- `GET /api/molecule3d/de_nac/{traj_id}` - Get dE*NAC vectors for a state pair
- `GET /api/molecule3d/hbonds/{traj_id}` - Get cached hydrogen-bond detections
- `POST /api/normal-modes/parse-text` - Parse uploaded molden text into equilibrium coords, frequencies, and mode vectors

## Molecule3D Notes

- Trajectory playback is optimized around a single reusable 3Dmol model instead of rebuilding the scene on every frame.
- Hydrogen bonds are defined with `donor-acceptor distance < 3.5 Å` and `D-H-A angle > 150°`.
- The returned hydrogen-bond `distance` field is the donor-acceptor distance.

## Normal Modes Notes

- The normal-modes page currently accepts one uploaded `molden` file at a time.
- v1 parses `[Atoms]`, `[FR-COORD]`, `[FREQ]`, `[FR-NORM-COORD]`, and optional `[INT]`; other sections are ignored.
- The vibration animation amplitude is a visualization scale, not a physical oscillation amplitude.

## Citation

If you use this tool in your research, please cite:

```bibtex
@software{observable_dashboard,
  author = {Haocheng, Lu},
  title = {Observable Dashboard: Interactive Molecular Dynamics Visualization},
  year = {2026},
  url = {https://github.com/PoloTier/observable_dashboard}
}
```

## License

This project is licensed under the GNU General Public License v3.0 (GPL-3.0).

## Author

Haocheng Lu

Email: 2201110435@pku.edu.cn

## Acknowledgments

This tool uses:
- [Plotly.js](https://plotly.com/javascript/) for 2D plotting
- [3Dmol.js](https://3dmol.csb.pitt.edu/) for 3D molecular visualization
- [FastAPI](https://fastapi.tiangolo.com/) for the backend API
- [gif.js](https://jnordberg.github.io/gif.js/) for GIF generation
