import json
import shutil
from pathlib import Path
from typing import Any, Dict

from jinja2 import Environment, FileSystemLoader, select_autoescape

PACKAGE_DIR = Path(__file__).resolve().parent
TEMPLATES_DIR = PACKAGE_DIR / "templates"
STATIC_DIR = PACKAGE_DIR / "static"


def _render_html(payload: Dict[str, Any], template_name: str) -> str:
    payload_json = json.dumps(payload, separators=(",", ":"))
    payload_json = payload_json.replace("</", "<\\/")

    env = Environment(
        loader=FileSystemLoader(str(TEMPLATES_DIR)),
        autoescape=select_autoescape(enabled_extensions=("html", "xml"), default=True),
    )
    template = env.get_template(template_name)
    return template.render(payload_json=payload_json)


def _write_assets(out_dir: Path) -> None:
    assets_out = out_dir / "assets"
    if assets_out.exists() and assets_out.is_dir():
        shutil.rmtree(assets_out)
    assets_out.mkdir(parents=True, exist_ok=True)

    for asset_relpath in (
        "vendor/plotly-2.35.2.min.js",
        "vendor/3Dmol-min.js",
        "dashboard/dashboard.css",
        "dashboard/dashboard_state.js",
        "math/dashboard_math3d.js",
        "dashboard/dashboard_plot.js",
        "dashboard/dashboard_ui.js",
        "mol3d/dashboard_mol3d_shared.js",
        "mol3d/dashboard_mol3d_geometry.js",
        "mol3d/dashboard_mol3d_measurement.js",
        "mol3d/dashboard_mol3d_viewer.js",
        "mol3d/dashboard_mol3d_io.js",
        "mol3d/dashboard_mol3d_page.js",
    ):
        src = STATIC_DIR / asset_relpath
        dst = assets_out / asset_relpath
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)


def write_single_page(out_dir: Path, payload: Dict[str, Any]) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)

    for stale_name in ["geometry", "electronic", "data"]:
        stale_dir = out_dir / stale_name
        if stale_dir.exists() and stale_dir.is_dir():
            shutil.rmtree(stale_dir)

    html = _render_html(payload, "index.html.j2")
    (out_dir / "index.html").write_text(html, encoding="utf-8")

    molecule_html = _render_html(payload, "molecule3d.html.j2")
    (out_dir / "molecule3d.html").write_text(molecule_html, encoding="utf-8")
    _write_assets(out_dir)
