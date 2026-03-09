from pathlib import Path
from typing import Any, Dict, List

import yaml

ALLOWED_OBSERVABLES = {"bond", "angle", "dihedral", "etot", "eig", "nac", "de_nac", "state", "|c|^2"}


def required_index_count(observable: str) -> int:
    if observable == "bond":
        return 2
    if observable == "angle":
        return 3
    if observable == "dihedral":
        return 4
    if observable == "de_nac":
        return 2
    return 0


def default_panel_templates() -> List[Dict[str, Any]]:
    return [
        {"observable": "bond", "indices": [0, 1]},
        {"observable": "angle", "indices": [0, 1, 2]},
        {"observable": "dihedral", "indices": [0, 1, 2, 3]},
        {"observable": "etot", "indices": []},
    ]


def fallback_panel_for_index(index: int) -> Dict[str, Any]:
    templates = default_panel_templates()
    if index < len(templates):
        return dict(templates[index])
    return {"observable": "etot", "indices": []}


def normalize_panel(panel_cfg: Dict[str, Any], fallback: Dict[str, Any]) -> Dict[str, Any]:
    observable = panel_cfg.get("observable", fallback["observable"])
    if observable not in ALLOWED_OBSERVABLES:
        observable = fallback["observable"]

    count = required_index_count(observable)
    raw_indices = panel_cfg.get("indices", fallback.get("indices", []))
    parsed_indices: List[int] = []

    if isinstance(raw_indices, list):
        for value in raw_indices:
            try:
                parsed_indices.append(int(value))
            except (TypeError, ValueError):
                continue

    if count > 0:
        while len(parsed_indices) < count:
            if len(fallback.get("indices", [])) > len(parsed_indices):
                parsed_indices.append(int(fallback["indices"][len(parsed_indices)]))
            else:
                if observable == "de_nac" and len(parsed_indices) == 1:
                    parsed_indices.append(1)
                else:
                    parsed_indices.append(0)
        parsed_indices = parsed_indices[:count]
        if observable == "de_nac" and len(parsed_indices) == 2 and parsed_indices[0] == parsed_indices[1]:
            parsed_indices[1] = parsed_indices[0] + 1
    else:
        parsed_indices = []

    return {
        "observable": observable,
        "indices": parsed_indices,
    }


def load_config(config_path: Path) -> Dict[str, Any]:
    if not config_path.exists():
        raise FileNotFoundError(f"Config file not found: {config_path}")

    with open(config_path, "r", encoding="utf-8") as f:
        user_cfg = yaml.safe_load(f) or {}

    ui_cfg_raw = user_cfg.get("ui", {}) if isinstance(user_cfg.get("ui"), dict) else {}
    default_panel_count = int(ui_cfg_raw.get("default_panel_count", 4))

    if default_panel_count < 1:
        raise ValueError("ui.default_panel_count must be >= 1")

    raw_panels = user_cfg.get("panels") if isinstance(user_cfg.get("panels"), list) else []
    normalized_panels: List[Dict[str, Any]] = []

    if raw_panels:
        for idx, panel in enumerate(raw_panels):
            panel_dict = panel if isinstance(panel, dict) else {}
            normalized_panels.append(normalize_panel(panel_dict, fallback_panel_for_index(idx)))
    else:
        normalized_panels = [fallback_panel_for_index(i) for i in range(default_panel_count)]

    while len(normalized_panels) < default_panel_count:
        normalized_panels.append(fallback_panel_for_index(len(normalized_panels)))

    plot_cfg_raw = user_cfg.get("plot", {}) if isinstance(user_cfg.get("plot"), dict) else {}
    show_ensemble = bool(plot_cfg_raw.get("show_ensemble_by_default", True))
    show_all_traces = bool(plot_cfg_raw.get("show_all_traces_in_all_mode", False))

    nac_cfg_raw = user_cfg.get("nac", {}) if isinstance(user_cfg.get("nac"), dict) else {}
    nac_mode = nac_cfg_raw.get("mode", "norm")
    if nac_mode not in {"norm", "pair_norm"}:
        raise ValueError("nac.mode must be 'norm' or 'pair_norm'")

    return {
        "panels": normalized_panels,
        "ui": {
            "default_panel_count": default_panel_count,
        },
        "plot": {
            "show_ensemble_by_default": show_ensemble,
            "show_all_traces_in_all_mode": show_all_traces,
        },
        "nac": {
            "mode": "norm",
        },
    }
