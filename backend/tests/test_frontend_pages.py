from __future__ import annotations

from pathlib import Path
import sys

import numpy as np

# Keep tests runnable from repository root without requiring editable install.
REPO_ROOT = Path(__file__).resolve().parents[3]
PKG_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from backend.server.app import create_app
from backend.server.cache import SeriesLRUCache
from backend.server.dataset_store import DatasetStore, TrajectoryRecord


def _build_traj(traj_id: str) -> TrajectoryRecord:
    time = np.asarray([0.0, 1.0], dtype=float)
    return TrajectoryRecord(
        traj_id=str(traj_id),
        n_atoms=1,
        atom_numbers=[1],
        time=time,
        coords=np.zeros((2, 1, 3), dtype=float),
        etot_time=time.copy(),
        etot=np.asarray([0.0, 0.1], dtype=float),
        eig_time=np.asarray([], dtype=float),
        eig=np.empty((0, 0), dtype=float),
        nac_time=np.asarray([], dtype=float),
        nac_norm=np.asarray([], dtype=float),
        nac_components=np.empty((0, 0, 0, 0), dtype=float),
        nac_state_count=0,
        nac_component_count=0,
        de_nac_time=np.asarray([], dtype=float),
        de_nac_norm=np.asarray([], dtype=float),
        de_nac_components=np.empty((0, 0, 0, 0), dtype=float),
        de_nac_state_count=0,
        de_nac_component_count=0,
        state_time=np.asarray([], dtype=float),
        state=np.asarray([], dtype=int),
        c_prob_time=np.asarray([], dtype=float),
        c_prob=np.empty((0, 0), dtype=float),
    )


def _build_store() -> DatasetStore:
    return DatasetStore(
        input_path=Path("/tmp/frontend_pages.pkl"),
        meta={"source_pkl": "/tmp/frontend_pages.pkl"},
        defaults={},
        trajectories={"0": _build_traj("0")},
    )


def _make_app():
    return create_app(store=_build_store(), cache=SeriesLRUCache(max_entries=32))


def _make_app_with_api_base(api_base: str):
    return create_app(store=_build_store(), cache=SeriesLRUCache(max_entries=32), api_base=api_base)


def _find_endpoint(app: object, path: str):
    for route in getattr(app, "routes", []):
        if getattr(route, "path", "") == path:
            return route.endpoint
    raise AssertionError(f"Could not find route for path={path!r}.")


def test_index_page_includes_theme_bootstrap_and_control() -> None:
    app = _make_app()
    endpoint = _find_endpoint(app, "/")

    response = endpoint()

    assert response.status_code == 200
    text = response.body.decode("utf-8")
    assert "observable_dashboard_theme_v1" in text
    assert 'data-appearance-control' in text
    assert 'id="dashboard-appearance-panel"' in text
    assert 'id="open-pkl-btn"' in text
    assert 'id="file-browser-modal"' in text
    assert 'id="dashboard-top-tab-summary"' in text
    assert 'id="dashboard-inspector-section"' in text
    assert 'id="dashboard-top-tab-hopping"' in text
    assert 'id="dashboard-hopping-section"' in text
    assert 'id="hopping-apply"' in text
    assert "/assets/dashboard/dashboard.css" in text


def test_molecule3d_page_includes_theme_bootstrap_and_control() -> None:
    app = _make_app()
    endpoint = _find_endpoint(app, "/molecule3d.html")

    response = endpoint()

    assert response.status_code == 200
    text = response.body.decode("utf-8")
    assert "observable_dashboard_theme_v1" in text
    assert 'data-appearance-control' in text
    assert 'id="mol3d-appearance-panel"' in text
    assert 'id="controls-tab-measure"' in text
    assert 'id="gif-range-controls-group"' in text
    assert 'id="dynamic-bonds"' in text
    assert "/assets/dashboard/dashboard_appearance.js" in text
    assert 'src="assets/mol3d/dashboard_mol3d_page.js"' not in text


def test_normal_modes_page_includes_upload_controls_and_assets() -> None:
    app = _make_app()
    endpoint = _find_endpoint(app, "/normal_modes.html")

    response = endpoint()

    assert response.status_code == 200
    text = response.body.decode("utf-8")
    assert "observable_dashboard_theme_v1" in text
    assert 'id="normal-modes-config-json"' in text
    assert 'id="nm-file-input"' in text
    assert 'id="nm-mode-list"' in text
    assert 'id="nm-mode-table-scroll"' in text
    assert 'class="mode-table-header"' in text
    assert '>Mode</div>' in text
    assert '>Frequency</div>' in text
    assert '>Type</div>' in text
    assert '>IR</div>' in text
    assert 'id="nm-viewer"' in text
    assert 'id="nm-spectrum-plot"' in text
    assert 'id="nm-spectrum-width-slider"' in text
    assert 'id="nm-spectrum-status"' in text
    assert 'id="nm-speed-slider"' in text
    assert 'id="nm-speed-label"' in text
    assert 'data-appearance-control' in text
    assert 'assets/vendor/plotly-2.35.2.min.js' in text
    assert 'src="assets/normal_modes/normal_modes_page.js"' in text
    assert 'src="assets/dashboard/dashboard_appearance.js"' in text


def test_normal_modes_page_injects_configured_api_base() -> None:
    app = _make_app_with_api_base("/custom-api")
    endpoint = _find_endpoint(app, "/normal_modes.html")

    response = endpoint()

    assert response.status_code == 200
    text = response.body.decode("utf-8")
    assert 'id="normal-modes-config-json"' in text
    assert '{"api_base":"/custom-api"}' in text


def test_normal_modes_page_script_reads_injected_api_base() -> None:
    text = (
        PKG_ROOT
        / "frontend"
        / "public"
        / "assets"
        / "normal_modes"
        / "normal_modes_page.js"
    ).read_text(encoding="utf-8")
    assert "normal-modes-config-json" in text
    assert "getApiBase()" in text
    assert "fetch(`${getApiBase()}/normal-modes/parse-text`" in text


def test_theme_asset_exists_and_exports_public_api() -> None:
    text = (
        PKG_ROOT
        / "frontend"
        / "public"
        / "assets"
        / "dashboard"
        / "dashboard_appearance.js"
    ).read_text(encoding="utf-8")
    assert "ObservableAppearance" in text
    assert "getPlotlyLayoutPatch" in text
