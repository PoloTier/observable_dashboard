from __future__ import annotations

from pathlib import Path
import sys
import types

import numpy as np
import pytest

# Keep tests runnable from repository root without requiring editable install.
REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

import scripts.filter.spectrum_window_inspector as spectrum_window_inspector  # noqa: E402
from scripts.filter.spectrum_window_inspector import (  # noqa: E402
    build_demo_bundle,
    build_soap_feature_set,
    build_soap_projection,
)


class _FakeAtoms:
    def __init__(self, *, numbers: list[int], positions: np.ndarray) -> None:
        self.numbers = list(numbers)
        self.positions = np.asarray(positions, dtype=float)


class _FakeSOAP:
    def __init__(
        self,
        *,
        species: list[int],
        r_cut: float,
        n_max: int,
        l_max: int,
        sigma: float,
        periodic: bool,
        average: str,
        sparse: bool,
    ) -> None:
        self.feature_count = int(n_max) + 1
        self.average = str(average)
        assert self.average == "off"

    def create(self, systems: list[_FakeAtoms], *, n_jobs: int, only_physical_cores: bool) -> np.ndarray:
        assert n_jobs >= 1
        assert only_physical_cores is False

        tensor: list[np.ndarray] = []
        for sample_index, system in enumerate(systems):
            atom_rows: list[np.ndarray] = []
            for atom_index, atom_number in enumerate(system.numbers):
                coord_sum = float(np.sum(system.positions[atom_index]))
                atom_rows.append(
                    np.asarray(
                        [
                            float(atom_number),
                            float(sample_index + 1),
                            float(atom_index + 1),
                            coord_sum,
                            coord_sum + float(atom_number),
                            coord_sum + float(sample_index + atom_index),
                            coord_sum + 0.5,
                        ][: self.feature_count],
                        dtype=float,
                    )
                )
            tensor.append(np.stack(atom_rows, axis=0))
        return np.stack(tensor, axis=0)


class _FakeUMAP:
    def __init__(
        self,
        *,
        n_components: int,
        n_neighbors: int,
        min_dist: float,
        metric: str,
        random_state: int,
    ) -> None:
        assert n_components == 2
        assert n_neighbors >= 2
        assert min_dist >= 0.0
        assert metric == "euclidean"
        assert random_state == 42

    def fit_transform(self, data: np.ndarray) -> np.ndarray:
        matrix = np.asarray(data, dtype=float)
        if matrix.ndim != 2:
            raise AssertionError(f"Expected 2D input, got {matrix.shape}.")
        first = matrix[:, 0]
        second = matrix[:, 1] if matrix.shape[1] > 1 else np.zeros(matrix.shape[0], dtype=float)
        return np.column_stack([first, second])


class _FakeIsomap:
    def __init__(
        self,
        *,
        n_components: int,
        n_neighbors: int,
        metric: str,
    ) -> None:
        assert n_components == 2
        assert n_neighbors >= 2
        assert metric == "euclidean"

    def fit_transform(self, data: np.ndarray) -> np.ndarray:
        matrix = np.asarray(data, dtype=float)
        if matrix.ndim != 2:
            raise AssertionError(f"Expected 2D input, got {matrix.shape}.")
        first = matrix[:, 0]
        second = matrix[:, -1]
        return np.column_stack([first, second])


def _install_fake_soap_modules(monkeypatch) -> None:
    ase_module = types.ModuleType("ase")
    ase_module.Atoms = _FakeAtoms

    dscribe_module = types.ModuleType("dscribe")
    descriptors_module = types.ModuleType("dscribe.descriptors")
    descriptors_module.SOAP = _FakeSOAP
    dscribe_module.descriptors = descriptors_module

    monkeypatch.setitem(sys.modules, "ase", ase_module)
    monkeypatch.setitem(sys.modules, "dscribe", dscribe_module)
    monkeypatch.setitem(sys.modules, "dscribe.descriptors", descriptors_module)


def _install_fake_umap_module(monkeypatch) -> None:
    umap_module = types.ModuleType("umap")
    umap_module.UMAP = _FakeUMAP
    monkeypatch.setitem(sys.modules, "umap", umap_module)


def test_build_soap_feature_set_returns_atomwise_tensor_for_all_atoms(monkeypatch) -> None:
    _install_fake_soap_modules(monkeypatch)
    bundle, _ = build_demo_bundle(sample_count=6)

    feature_set = build_soap_feature_set(bundle, n_max=4, l_max=3)

    assert feature_set.feature_kind == "soap_atomwise"
    assert feature_set.feature_tensor.shape == (6, bundle.n_atoms, 5)
    assert feature_set.atom_indices == list(range(bundle.n_atoms))
    assert feature_set.feature_labels == [f"soap_{index:04d}" for index in range(5)]


def test_build_soap_feature_set_respects_atom_indices_subset(monkeypatch) -> None:
    _install_fake_soap_modules(monkeypatch)
    bundle, _ = build_demo_bundle(sample_count=4)

    feature_set = build_soap_feature_set(bundle, atom_indices=[1, 3], n_max=3, l_max=2)

    assert feature_set.feature_tensor.shape == (4, 2, 4)
    assert feature_set.atom_indices == [1, 3]


def test_build_soap_projection_pools_atomwise_tensor_and_exposes_metadata(monkeypatch) -> None:
    _install_fake_soap_modules(monkeypatch)
    bundle, _ = build_demo_bundle(sample_count=5)

    raw_feature_set = build_soap_feature_set(bundle, atom_indices=[0, 2], n_max=4, l_max=3)
    projection = build_soap_projection(
        bundle,
        atom_indices=[0, 2],
        n_max=4,
        l_max=3,
        method="pca",
    )

    assert projection.feature_kind == "soap_atomwise_pooled"
    assert projection.feature_matrix.shape == (5, 5)
    assert projection.coords_2d.shape == (5, 2)
    assert projection.source_feature_shape == (5, 2, 5)
    assert projection.atom_indices == [0, 2]
    np.testing.assert_allclose(projection.feature_matrix, np.mean(raw_feature_set.feature_tensor, axis=1))


def test_build_soap_projection_supports_umap(monkeypatch) -> None:
    _install_fake_soap_modules(monkeypatch)
    _install_fake_umap_module(monkeypatch)
    bundle, _ = build_demo_bundle(sample_count=5)

    projection = build_soap_projection(
        bundle,
        atom_indices=[0, 2],
        n_max=4,
        l_max=3,
        method="umap",
    )

    assert projection.method == "umap"
    assert projection.coords_2d.shape == (5, 2)
    assert projection.axis_labels == ("UMAP 1", "UMAP 2")
    assert projection.explained_variance_ratio is None
    assert projection.atom_indices == [0, 2]


def test_build_soap_projection_supports_isomap(monkeypatch) -> None:
    _install_fake_soap_modules(monkeypatch)
    monkeypatch.setattr(spectrum_window_inspector, "Isomap", _FakeIsomap)
    bundle, _ = build_demo_bundle(sample_count=5)

    projection = build_soap_projection(
        bundle,
        atom_indices=[0, 2],
        n_max=4,
        l_max=3,
        method="isomap",
    )

    assert projection.method == "isomap"
    assert projection.coords_2d.shape == (5, 2)
    assert projection.axis_labels == ("Isomap 1", "Isomap 2")
    assert projection.explained_variance_ratio is None
    assert projection.atom_indices == [0, 2]


def test_build_soap_projection_umap_requires_optional_dependency(monkeypatch) -> None:
    _install_fake_soap_modules(monkeypatch)
    real_import_module = spectrum_window_inspector.importlib.import_module

    def _raise_for_umap(name: str, package: str | None = None):
        if name == "umap":
            raise ModuleNotFoundError("No module named 'umap'")
        return real_import_module(name, package)

    monkeypatch.setattr(spectrum_window_inspector.importlib, "import_module", _raise_for_umap)
    bundle, _ = build_demo_bundle(sample_count=5)

    with pytest.raises(ModuleNotFoundError, match="UMAP projection requires optional dependency 'umap-learn'"):
        build_soap_projection(
            bundle,
            atom_indices=[0, 2],
            n_max=4,
            l_max=3,
            method="umap",
        )
