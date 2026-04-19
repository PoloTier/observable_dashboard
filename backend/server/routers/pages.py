from __future__ import annotations

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, HTMLResponse

from backend.server.app_helpers import json_script_text
from backend.server.app_state import AppState


def build_pages_router(state: AppState) -> APIRouter:
    router = APIRouter()
    frontend_dir = state.frontend_dir
    api_base = state.api_base

    @router.get("/", response_class=HTMLResponse)
    def index_page() -> HTMLResponse:
        index_file = frontend_dir / "index.html"
        if index_file.exists():
            return HTMLResponse(index_file.read_text())
        return HTMLResponse(
            "<h1>Frontend not found</h1><p>Please build frontend or check installation.</p>",
            status_code=404,
        )

    @router.get("/index.html", response_class=HTMLResponse)
    def index_page_alias() -> HTMLResponse:
        return index_page()

    @router.get("/workflow.html", response_class=HTMLResponse)
    def workflow_page() -> HTMLResponse:
        workflow_file = frontend_dir / "workflow.html"
        if workflow_file.exists():
            html = workflow_file.read_text()
            config_json = json_script_text(
                {
                    "pages": {
                        "normal_modes": "/normal_modes.html",
                        "distribution_compare": "/distribution_compare.html",
                        "dashboard": "/index.html",
                        "molecule3d": "/molecule3d.html",
                        "md": "/md.html",
                    },
                    "features": {
                        "pimd_placeholder": False,
                    },
                }
            )
            html = html.replace(
                '<script id="workflow-config-json" type="application/json">{}</script>',
                f'<script id="workflow-config-json" type="application/json">{config_json}</script>',
                1,
            )
            return HTMLResponse(html)
        return HTMLResponse("<h1>Workflow page not found</h1>", status_code=404)

    @router.get("/molecule3d.html", response_class=HTMLResponse)
    def molecule3d_page() -> HTMLResponse:
        mol3d_file = frontend_dir / "molecule3d.html"
        if mol3d_file.exists():
            return HTMLResponse(mol3d_file.read_text())
        return HTMLResponse("<h1>Molecule3D page not found</h1>", status_code=404)

    @router.get("/md.html", response_class=HTMLResponse)
    def md_page() -> HTMLResponse:
        md_file = frontend_dir / "md.html"
        if md_file.exists():
            html = md_file.read_text()
            config_json = json_script_text(
                {
                    "data_mode": "local_xyz",
                    "pimd_mode": "local_h5",
                    "api_base": api_base,
                    "pages": {
                        "workflow": "/workflow.html",
                        "molecule3d": "/molecule3d.html",
                    },
                    "meta": {
                        "source_label": "Local XYZ",
                    },
                }
            )
            html = html.replace(
                '<script id="md-config-json" type="application/json">{}</script>',
                f'<script id="md-config-json" type="application/json">{config_json}</script>',
                1,
            )
            return HTMLResponse(html)
        return HTMLResponse("<h1>MD page not found</h1>", status_code=404)

    @router.get("/normal_modes.html", response_class=HTMLResponse)
    def normal_modes_page() -> HTMLResponse:
        normal_modes_file = frontend_dir / "normal_modes.html"
        if normal_modes_file.exists():
            html = normal_modes_file.read_text()
            config_json = json_script_text({"api_base": api_base})
            html = html.replace(
                '<script id="normal-modes-config-json" type="application/json">{}</script>',
                f'<script id="normal-modes-config-json" type="application/json">{config_json}</script>',
                1,
            )
            return HTMLResponse(html)
        return HTMLResponse("<h1>Normal Modes page not found</h1>", status_code=404)

    @router.get("/distribution_compare.html", response_class=HTMLResponse)
    def distribution_compare_page() -> HTMLResponse:
        compare_file = frontend_dir / "distribution_compare.html"
        if compare_file.exists():
            html = compare_file.read_text()
            config_json = json_script_text({"api_base": api_base})
            html = html.replace(
                '<script id="distribution-compare-config-json" type="application/json">{}</script>',
                f'<script id="distribution-compare-config-json" type="application/json">{config_json}</script>',
                1,
            )
            return HTMLResponse(html)
        return HTMLResponse("<h1>Distribution Compare page not found</h1>", status_code=404)

    @router.get("/src/{file_path:path}")
    def serve_src(file_path: str) -> FileResponse:
        src_root = (frontend_dir / "src").resolve()
        src_file = (src_root / file_path).resolve()
        try:
            src_file.relative_to(src_root)
        except ValueError as exc:
            raise HTTPException(status_code=403, detail="Path traversal is not allowed.") from exc
        if src_file.exists() and src_file.is_file():
            return FileResponse(src_file)
        raise HTTPException(status_code=404, detail="File not found")

    return router
