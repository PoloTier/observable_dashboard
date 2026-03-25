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
    assert 'href="workflow.html"' in text
    assert "/assets/dashboard/dashboard.css" in text


def test_workflow_page_includes_flowchart_mount_and_assets() -> None:
    app = _make_app()
    endpoint = _find_endpoint(app, "/workflow.html")

    response = endpoint()

    assert response.status_code == 200
    text = response.body.decode("utf-8")
    assert "observable_dashboard_theme_v1" in text
    assert 'id="workflow-config-json"' in text
    assert 'id="wf-flowchart"' in text
    assert 'id="wf-quick-links"' in text
    assert "Ensemble to Dynamics Navigation" in text
    assert 'src="/assets/workflow/workflow_page.js"' in text


def test_workflow_page_injects_navigation_config() -> None:
    app = _make_app()
    endpoint = _find_endpoint(app, "/workflow.html")

    response = endpoint()

    assert response.status_code == 200
    text = response.body.decode("utf-8")
    assert 'id="workflow-config-json"' in text
    assert '"normal_modes":"/normal_modes.html"' in text
    assert '"distribution_compare":"/distribution_compare.html"' in text
    assert '"dashboard":"/index.html"' in text
    assert '"molecule3d":"/molecule3d.html"' in text
    assert '"md":"/md.html"' in text
    assert '"pimd_placeholder":false' in text


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
    assert 'id="internal-render-scale-slider"' in text
    assert "/assets/dashboard/dashboard_appearance.js" in text
    assert 'src="assets/mol3d/dashboard_mol3d_page.js"' not in text


def test_md_page_includes_upload_controls_and_assets() -> None:
    app = _make_app()
    endpoint = _find_endpoint(app, "/md.html")

    response = endpoint()

    assert response.status_code == 200
    text = response.body.decode("utf-8")
    assert "observable_dashboard_theme_v1" in text
    assert 'id="md-config-json"' in text
    assert 'id="bootstrap-json"' in text
    assert 'id="md-mode-tab-md"' in text
    assert 'id="md-mode-tab-pimd"' in text
    assert 'id="md-upload-input"' in text
    assert 'id="md-backend-path-input"' in text
    assert 'id="md-backend-browse-btn"' in text
    assert 'id="md-backend-import-btn"' in text
    assert 'id="md-dropzone"' in text
    assert 'id="pimd-upload-card"' in text
    assert 'id="pimd-upload-input"' in text
    assert 'id="pimd-backend-path-input"' in text
    assert 'id="pimd-backend-browse-btn"' in text
    assert 'id="pimd-backend-import-btn"' in text
    assert 'id="pimd-dropzone"' in text
    assert 'id="md-backend-browser-modal"' in text
    assert 'id="md-backend-browser-list"' in text
    assert 'id="md-backend-browser-up-btn"' in text
    assert 'id="pimd-display-mode-select"' in text
    assert 'id="pimd-bead-select"' in text
    assert 'id="viewer-controls-title"' in text
    assert 'id="controls-tab-measure"' in text
    assert 'id="controls-tab-export"' in text
    assert 'id="internal-render-scale-slider"' in text
    assert 'id="md-legacy-export-controls"' in text
    assert 'id="md-sampling-export-panel"' in text
    assert 'id="md-sampling-start-frame"' in text
    assert 'id="md-sampling-end-frame"' in text
    assert 'id="md-sampling-frame-stride"' in text
    assert 'id="md-sampling-charge"' in text
    assert 'id="md-sampling-multiplicity"' in text
    assert 'id="md-sampling-bead-fields"' in text
    assert 'id="md-sampling-bead-start"' in text
    assert 'id="md-sampling-bead-end"' in text
    assert 'id="md-sampling-bead-stride"' in text
    assert 'id="md-sampling-summary"' in text
    assert 'id="md-export-geometry-bundle-btn"' in text
    assert 'id="md-export-geometry-bundle-status"' in text
    assert 'id="save-frame-xyz-btn"' in text
    assert 'id="save-traj-xyz-btn"' in text
    assert 'id="viewer"' in text
    assert 'id="bond-plot"' in text
    assert 'id="bond-color-settings-panel"' in text
    assert 'data-appearance-control' in text
    assert "/assets/md/md_page.js" in text
    assert "/assets/vendor/h5wasm.js" in text
    assert '/assets/dashboard/dashboard_appearance.js' in text
    assert '/assets/dashboard/dashboard_state.js' not in text
    assert '/assets/dashboard/dashboard_data_loader.js' not in text


def test_md_page_injects_local_xyz_config() -> None:
    app = _make_app()
    endpoint = _find_endpoint(app, "/md.html")

    response = endpoint()

    assert response.status_code == 200
    text = response.body.decode("utf-8")
    assert 'id="md-config-json"' in text
    assert '"data_mode":"local_xyz"' in text
    assert '"pimd_mode":"local_h5"' in text
    assert '"api_base":"/api"' in text
    assert '"workflow":"/workflow.html"' in text
    assert '"molecule3d":"/molecule3d.html"' in text


def test_md_page_injects_configured_api_base() -> None:
    app = _make_app_with_api_base("/custom-api")
    endpoint = _find_endpoint(app, "/md.html")

    response = endpoint()

    assert response.status_code == 200
    text = response.body.decode("utf-8")
    assert 'id="md-config-json"' in text
    assert '"api_base":"/custom-api"' in text


def test_normal_modes_page_includes_upload_controls_and_assets() -> None:
    app = _make_app()
    endpoint = _find_endpoint(app, "/normal_modes.html")

    response = endpoint()

    assert response.status_code == 200
    text = response.body.decode("utf-8")
    assert "observable_dashboard_theme_v1" in text
    assert 'id="normal-modes-config-json"' in text
    assert 'id="nm-file-input"' in text
    assert 'id="nm-open-sampling-settings-btn"' in text
    assert 'id="nm-mode-list"' in text
    assert 'id="nm-mode-table-scroll"' in text
    assert 'class="mode-table-header"' in text
    assert '>Mode</div>' in text
    assert '>Frequency</div>' in text
    assert '>Type</div>' in text
    assert '>IR</div>' in text
    assert 'id="nm-workspace-modes-btn"' in text
    assert 'id="nm-workspace-sampling-btn"' in text
    assert 'id="nm-modes-viewer-card"' in text
    assert 'id="nm-modes-viewer"' in text
    assert 'id="nm-modes-status"' in text
    assert 'id="nm-sampling-viewer-card"' in text
    assert 'id="nm-sampling-viewer"' in text
    assert 'id="nm-sampling-status"' in text
    assert 'id="nm-sampling-summary-card"' in text
    assert 'id="nm-export-geometry-btn"' in text
    assert 'id="nm-export-bundle-btn"' in text
    assert 'id="nm-export-status"' in text
    assert 'id="nm-spectrum-plot"' in text
    assert 'id="nm-spectrum-width-slider"' in text
    assert 'id="nm-spectrum-status"' in text
    assert 'id="nm-distribution-card"' in text
    assert 'id="nm-measurement-plot"' in text
    assert 'id="nm-measurement-atom-3"' in text
    assert 'id="nm-speed-slider"' in text
    assert 'id="nm-speed-label"' in text
    assert 'id="nm-show-atom-index"' in text
    assert 'id="nm-sampling-modal"' in text
    assert 'id="nm-sampling-charge"' in text
    assert 'id="nm-sampling-multiplicity"' in text
    assert 'id="nm-geometry-export-modal"' in text
    assert 'id="nm-geometry-export-file-name"' in text
    assert 'id="nm-geometry-export-directory"' in text
    assert 'id="nm-geometry-export-directory-browse-btn"' in text
    assert 'id="nm-geometry-directory-browser-modal"' in text
    assert 'id="nm-geometry-directory-browser-select-btn"' in text
    assert 'id="nm-sampling-plan-preview-body"' in text
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
    assert "fetch(`${getApiBase()}/normal-modes/sample-text`" in text
    assert "/normal-modes/sample-batches/${encodeURIComponent(state.samplingResult.batch_id)}/measurements" in text
    assert "/normal-modes/sample-batches/${encodeURIComponent(batchId)}/export" in text
    assert "/normal-modes/sample-batches/${encodeURIComponent(batchId)}/export-geometry" in text
    assert "/normal-modes/sample-batches/${encodeURIComponent(batchId)}/export-geometry/save" in text
    assert "new URL(`${getApiBase()}/files`, window.location.origin)" in text
    assert "samplingCharge" in text
    assert "samplingMultiplicity" in text
    assert "nm-geometry-export-modal" in text
    assert "nm-geometry-directory-browser-modal" in text
    assert "DEFAULT_GEOMETRY_EXPORT_DIRECTORY" in text


def test_distribution_compare_page_includes_upload_controls_and_assets() -> None:
    app = _make_app()
    endpoint = _find_endpoint(app, "/distribution_compare.html")

    response = endpoint()

    assert response.status_code == 200
    text = response.body.decode("utf-8")
    assert "observable_dashboard_theme_v1" in text
    assert 'id="distribution-compare-config-json"' in text
    assert 'id="dc-upload-input"' in text
    assert 'id="dc-open-server-bundle-btn"' in text
    assert 'id="dc-refresh-btn"' in text
    assert 'id="dc-distribution-count"' in text
    assert 'id="dc-active-count"' in text
    assert 'id="dc-distribution-list"' in text
    assert 'id="dc-file-browser-modal"' in text
    assert 'id="dc-workspace-selection-btn"' in text
    assert 'id="dc-workspace-overlay-btn"' in text
    assert 'id="dc-workspace-summary-btn"' in text
    assert 'id="dc-workspace-spectrum-btn"' in text
    assert 'id="dc-workspace-selection-panel"' in text
    assert 'id="dc-workspace-overlay-panel"' in text
    assert 'id="dc-workspace-summary-panel"' in text
    assert 'id="dc-workspace-spectrum-panel"' in text
    assert 'id="dc-measurement-kind"' in text
    assert 'id="dc-measurement-atom-2-group"' in text
    assert 'id="dc-measurement-atom-3-group"' in text
    assert 'id="dc-histogram-bins"' in text
    assert 'id="dc-selection-enabled"' in text
    assert 'id="dc-window-center-ev"' in text
    assert 'id="dc-window-width-ev"' in text
    assert 'id="dc-selection-profile-panel"' in text
    assert 'id="dc-compare-status"' in text
    assert 'id="dc-plot-active-pill"' in text
    assert 'id="dc-plot"' in text
    assert 'id="dc-umap-status"' in text
    assert 'id="dc-umap-active-pill"' in text
    assert 'id="dc-umap-plot"' in text
    assert 'id="dc-summary-meta"' in text
    assert 'id="dc-summary-grid"' in text
    assert 'id="dc-spectrum-delta-ev"' in text
    assert 'id="dc-spectrum-x-unit"' in text
    assert 'id="dc-spectrum-pair-status"' in text
    assert 'id="dc-spectrum-pair-panel"' in text
    assert 'id="dc-spectrum-status"' in text
    assert 'id="dc-spectrum-active-pill"' in text
    assert 'id="dc-spectrum-plot"' in text
    assert 'id="dc-spectrum-compare-btn"' not in text
    assert "Compare Spectrum" not in text
    assert "Transition Pairs" in text
    assert "Import Bundle Directory From Server" in text
    assert "Browse Server Directories" in text
    assert "Import TAR.GZ From Server" not in text
    assert 'data-appearance-control' in text
    assert 'assets/vendor/plotly-2.35.2.min.js' in text
    assert 'src="assets/distributions/distribution_compare_page.js"' in text
    assert 'src="assets/dashboard/dashboard_appearance.js"' in text


def test_distribution_compare_page_injects_configured_api_base() -> None:
    app = _make_app_with_api_base("/custom-api")
    endpoint = _find_endpoint(app, "/distribution_compare.html")

    response = endpoint()

    assert response.status_code == 200
    text = response.body.decode("utf-8")
    assert 'id="distribution-compare-config-json"' in text
    assert '{"api_base":"/custom-api"}' in text


def test_distribution_compare_page_script_reads_injected_api_base() -> None:
    text = (
        PKG_ROOT
        / "frontend"
        / "public"
        / "assets"
        / "distributions"
        / "distribution_compare_page.js"
    ).read_text(encoding="utf-8")
    assert "distribution-compare-config-json" in text
    assert "state.endpoints.load" in text
    assert "state.endpoints.loadByPath" in text
    assert "state.endpoints.browseFiles" in text
    assert "?filename=${encodeURIComponent(file.name)}" in text
    assert "WORKSPACE_SELECTION" in text
    assert "state.selectionEnabled" in text
    assert "state.endpoints.projectSoapUmap" in text
    assert "state.endpoints.compareGeometryWindow" in text
    assert "state.endpoints.projectSoapUmapWindow" in text
    assert "buildGeometryWindowPayload" in text
    assert "buildUmapPayload" in text
    assert "renderUmapPlot" in text
    assert "state.endpoints.compareSpectrum" in text
    assert "buildSpectrumPayload" in text
    assert "renderSpectrumPlot" in text
    assert "clearEmptyPlotPlaceholder" in text
    assert "clearEmptyPlotPlaceholder(dom.spectrumPlot)" in text
    assert "buildDeleteUrl" in text


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
