# Observable Dashboard

A web-based interactive dashboard for visualizing molecular dynamics observables and trajectories. This tool provides real-time visualization of molecular properties including bonds, angles, dihedrals, energies, and 3D molecular structures.

## Features

- **Interactive 2D Plots**: Visualize time-series data for various observables (bonds, angles, dihedrals, energies, eigenvalues, NAC, state populations)
- **3D Molecular Viewer**: Real-time 3D visualization with playback controls, geometry measurements, and GIF export
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
  - jinja2

### Install Dependencies

```bash
pip install fastapi uvicorn numpy pyyaml jinja2
```

## Quick Start

### 1. Prepare Your Data

Ensure you have a `dump_all.pkl` file containing your trajectory data with the expected structure (time series, coordinates, energies, etc.).

### 2. Start the Server

```bash
python -m tools.observable_dashboard.serve \
  -i run0/dump_all.pkl \
  --host 127.0.0.1 \
  --port 8000
```

### 3. Open in Browser

- Main dashboard: `http://127.0.0.1:8000/`
- 3D viewer: `http://127.0.0.1:8000/molecule3d.html`

## Usage

### Command Line Options

```bash
python -m tools.observable_dashboard.serve [OPTIONS]

Options:
  -i, --input PATH              Input pickle file (default: run0/dump_all.pkl)
  -c, --config PATH             YAML config file (optional)
  --host HOST                   Bind host (default: 127.0.0.1)
  --port PORT                   Bind port (default: 8000)
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

## Citation

If you use this tool in your research, please cite:

```bibtex
@software{observable_dashboard,
  author = {Haocheng, Lu},
  title = {Observable Dashboard: Interactive Molecular Dynamics Visualization},
  year = {2025},
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
