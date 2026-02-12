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

    for asset_name in (
        "dashboard.css",
        "dashboard_state.js",
        "dashboard_math3d.js",
        "dashboard_plot.js",
        "dashboard_ui.js",
        "dashboard_mol3d_shared.js",
        "dashboard_mol3d_geometry.js",
        "dashboard_mol3d_measurement.js",
        "dashboard_mol3d_viewer.js",
        "dashboard_mol3d_io.js",
        "dashboard_mol3d_page.js",
    ):
        src = STATIC_DIR / asset_name
        dst = assets_out / asset_name
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
