from __future__ import annotations

from pathlib import Path
import sys

import pytest

# Keep tests runnable from repository root without requiring editable install.
REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from scripts.basic.elements import atom_symbol, atomic_mass_amu, atomic_number_from_symbol
from scripts.basic.units import ANGSTROM_TO_BOHR, BOHR_TO_ANGSTROM, EV_TO_HARTREE, HARTREE_TO_EV


def test_scripts_basic_element_lookups_are_consistent() -> None:
    assert atom_symbol(8) == "O"
    assert atomic_number_from_symbol("cl") == 17
    assert atomic_mass_amu(1) == pytest.approx(1.008, rel=1e-12)


def test_scripts_basic_unit_conversions_are_reciprocal() -> None:
    assert BOHR_TO_ANGSTROM * ANGSTROM_TO_BOHR == pytest.approx(1.0, rel=1e-12)
    assert HARTREE_TO_EV * EV_TO_HARTREE == pytest.approx(1.0, rel=1e-12)
