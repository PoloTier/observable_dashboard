import json
from pathlib import Path
from typing import Any

from jinja2 import Environment, FileSystemLoader, select_autoescape

PACKAGE_DIR = Path(__file__).resolve().parent
TEMPLATES_DIR = PACKAGE_DIR / "templates"
STATIC_DIR = PACKAGE_DIR / "static"


def _json_html_safe(obj: Any) -> str:
    text = json.dumps(obj, separators=(",", ":"))
    return text.replace("</", "<\\/")


def _render_html(template_name: str, *, bootstrap_json: str) -> str:
    env = Environment(
        loader=FileSystemLoader(str(TEMPLATES_DIR)),
        autoescape=select_autoescape(enabled_extensions=("html", "xml"), default=True),
    )
    template = env.get_template(template_name)
    return template.render(bootstrap_json=bootstrap_json)
