from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from backend.server.constants import (
    BOHR_TO_ANG,
    PERIODIC_SYMBOLS,
    SYMBOL_TO_ATOMIC_NUMBER,
)

SECTION_RE = re.compile(r"^\s*\[([^\]]+)\](.*)$")
FLOAT_RE = re.compile(r"[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[EeDd][-+]?\d+)?")


def _float_from_text(text: str) -> float:
    return float(str(text).replace("D", "E").replace("d", "e"))


def _extract_floats(line: str) -> list[float]:
    return [_float_from_text(token) for token in FLOAT_RE.findall(str(line))]


def _collect_sections(content: str) -> dict[str, tuple[str, list[str]]]:
    sections: dict[str, tuple[str, list[str]]] = {}
    current_name: str | None = None
    current_header = ""
    current_body: list[str] = []

    for raw_line in str(content).splitlines():
        match = SECTION_RE.match(raw_line)
        if match:
            if current_name is not None and current_name not in sections:
                sections[current_name] = (current_header, current_body)
            current_name = str(match.group(1) or "").strip().upper()
            current_header = str(match.group(2) or "").strip()
            current_body = []
            continue
        if current_name is not None:
            current_body.append(raw_line.rstrip())

    if current_name is not None and current_name not in sections:
        sections[current_name] = (current_header, current_body)
    return sections


def _infer_atomic_number(symbol_text: str, explicit_text: str | None) -> int:
    if explicit_text is not None:
        try:
            value = int(round(_float_from_text(explicit_text)))
            if value > 0:
                return value
        except ValueError:
            pass

    symbol = str(symbol_text or "").strip().capitalize()
    atomic_number = SYMBOL_TO_ATOMIC_NUMBER.get(symbol.upper(), 0)
    if atomic_number > 0:
        return atomic_number
    raise ValueError(f"Could not determine atomic number for atom symbol '{symbol_text}'.")


def _parse_atoms(header: str, body: list[str]) -> tuple[list[int], list[list[float]]]:
    unit_text = str(header or "").upper()
    scale = 1.0
    if "AU" in unit_text or "BOHR" in unit_text:
        scale = BOHR_TO_ANG

    atom_numbers: list[int] = []
    coords_ang: list[list[float]] = []
    for line in body:
        text = str(line).strip()
        if not text:
            continue
        parts = text.split()
        if len(parts) < 6:
            raise ValueError(f"Invalid [Atoms] row: '{text}'")
        atom_numbers.append(_infer_atomic_number(parts[0], parts[2]))
        try:
            x, y, z = (_float_from_text(parts[-3]), _float_from_text(parts[-2]), _float_from_text(parts[-1]))
        except ValueError as exc:
            raise ValueError(f"Invalid [Atoms] coordinates: '{text}'") from exc
        coords_ang.append([x * scale, y * scale, z * scale])

    if not atom_numbers:
        raise ValueError("Molden file is missing atom rows in [Atoms].")
    return atom_numbers, coords_ang


def _parse_fr_coord(body: list[str], *, n_atoms: int) -> list[list[float]]:
    coords_ang: list[list[float]] = []
    for line in body:
        text = str(line).strip()
        if not text:
            continue
        floats = _extract_floats(text)
        if len(floats) < 3:
            raise ValueError(f"Invalid [FR-COORD] row: '{text}'")
        coords_ang.append([floats[-3] * BOHR_TO_ANG, floats[-2] * BOHR_TO_ANG, floats[-1] * BOHR_TO_ANG])

    if len(coords_ang) != n_atoms:
        raise ValueError(
            f"[FR-COORD] atom count mismatch: expected {n_atoms}, found {len(coords_ang)}."
        )
    return coords_ang


def _parse_scalar_block(body: list[str]) -> list[float]:
    values: list[float] = []
    for line in body:
        text = str(line).strip()
        if not text:
            continue
        values.extend(_extract_floats(text))
    return values


def _parse_fr_norm_coord(body: list[str], *, n_atoms: int) -> list[list[list[float]]]:
    modes: list[list[list[float]]] = []
    current_rows: list[list[float]] | None = None

    for line in body:
        text = str(line).strip()
        if not text:
            continue
        if text.lower().startswith("vibration"):
            if current_rows is not None:
                if len(current_rows) != n_atoms:
                    raise ValueError(
                        f"[FR-NORM-COORD] vibration block has {len(current_rows)} rows; expected {n_atoms}."
                    )
                modes.append(current_rows)
            current_rows = []
            continue

        if current_rows is None:
            continue

        floats = _extract_floats(text)
        if len(floats) < 3:
            raise ValueError(f"Invalid [FR-NORM-COORD] row: '{text}'")
        current_rows.append(
            [
                floats[-3] * BOHR_TO_ANG,
                floats[-2] * BOHR_TO_ANG,
                floats[-1] * BOHR_TO_ANG,
            ]
        )

    if current_rows is not None:
        if len(current_rows) != n_atoms:
            raise ValueError(
                f"[FR-NORM-COORD] vibration block has {len(current_rows)} rows; expected {n_atoms}."
            )
        modes.append(current_rows)

    if not modes:
        raise ValueError("Molden file is missing vibration blocks in [FR-NORM-COORD].")
    return modes


def _normalize_source_name(filename: str) -> str:
    name = Path(str(filename or "").strip()).name
    return name or "uploaded.molden"


def parse_molden_normal_modes(content: str, *, source_name: str) -> dict[str, Any]:
    sections = _collect_sections(content)
    atoms_section = sections.get("ATOMS")
    if atoms_section is None:
        raise ValueError("Molden file is missing required [Atoms] section.")
    freq_section = sections.get("FREQ")
    if freq_section is None:
        raise ValueError("Molden file is missing required [FREQ] section.")
    norm_section = sections.get("FR-NORM-COORD")
    if norm_section is None:
        raise ValueError("Molden file is missing required [FR-NORM-COORD] section.")

    atom_numbers, atoms_coords_ang = _parse_atoms(*atoms_section)
    n_atoms = len(atom_numbers)

    fr_coord_section = sections.get("FR-COORD")
    coords_ang = (
        _parse_fr_coord(fr_coord_section[1], n_atoms=n_atoms)
        if fr_coord_section is not None
        else atoms_coords_ang
    )

    frequencies = _parse_scalar_block(freq_section[1])
    if not frequencies:
        raise ValueError("Molden file is missing frequency values in [FREQ].")

    intensities: list[float] = []
    int_section = sections.get("INT")
    if int_section is not None:
        parsed_intensities = _parse_scalar_block(int_section[1])
        if len(parsed_intensities) == len(frequencies):
            intensities = parsed_intensities

    mode_vectors_ang = _parse_fr_norm_coord(norm_section[1], n_atoms=n_atoms)
    if len(mode_vectors_ang) != len(frequencies):
        raise ValueError(
            "Frequency count does not match vibration block count: "
            f"{len(frequencies)} frequencies vs {len(mode_vectors_ang)} vibration blocks."
        )

    def _mode_kind(frequency: float) -> str:
        if frequency < 0:
            return "imaginary"
        if abs(frequency) <= 1e-12:
            return "zero"
        return "positive"

    mode_summaries = []
    for idx, frequency in enumerate(frequencies):
        intensity = intensities[idx] if idx < len(intensities) else None
        mode_summaries.append(
            {
                "mode_index": idx,
                "frequency_cm1": float(frequency),
                "intensity": None if intensity is None else float(intensity),
                "kind": _mode_kind(float(frequency)),
            }
        )

    default_mode_index = 0
    for idx, frequency in enumerate(frequencies):
        if float(frequency) > 0:
            default_mode_index = idx
            break

    return {
        "source_name": _normalize_source_name(source_name),
        "n_atoms": n_atoms,
        "atom_numbers": [int(value) for value in atom_numbers],
        "coords_ang": [[float(x), float(y), float(z)] for x, y, z in coords_ang],
        "mode_summaries": mode_summaries,
        "mode_vectors_ang": [
            [[float(x), float(y), float(z)] for x, y, z in mode]
            for mode in mode_vectors_ang
        ],
        "default_mode_index": int(default_mode_index),
    }
