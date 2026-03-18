from __future__ import annotations

from pathlib import Path
import sys

import h5py
import numpy as np
import pytest

# Keep tests runnable from repository root without requiring editable install.
REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from scripts.convert_pimd_h5 import KB_HARTREE_PER_K, convert_pimd_files


def _write_xyz(path: Path, symbols: list[str], coords: np.ndarray) -> None:
    lines = [str(len(symbols)), "synthetic reference"]
    for symbol, xyz in zip(symbols, coords, strict=True):
        lines.append(f"{symbol} {float(xyz[0]):.8f} {float(xyz[1]):.8f} {float(xyz[2]):.8f}")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def test_convert_pimd_files_writes_standard_schema(tmp_path: Path) -> None:
    traj_path = tmp_path / "traj.h5"
    ener_path = tmp_path / "ener.h5"
    xyz_path = tmp_path / "ref.xyz"
    out_path = tmp_path / "standard_pimd.h5"

    n_raw_frames = 5
    n_beads = 2
    n_atoms = 2
    beta_value = 1.0 / (KB_HARTREE_PER_K * 300.0)

    reference_coords = np.asarray(
        [
            [0.0, 0.0, 0.0],
            [2.0, 0.0, 0.0],
        ],
        dtype=float,
    )
    _write_xyz(xyz_path, ["H", "O"], reference_coords)

    coords = np.zeros((1, n_raw_frames, n_beads * n_atoms * 3), dtype=float)
    bead_energies = np.zeros((1, n_raw_frames, n_beads), dtype=float)
    for raw_frame in range(1, n_raw_frames):
        frame_coords = np.asarray(
            [
                [[raw_frame + 0.00, 0.0, 0.0], [raw_frame + 0.10, 1.0, 0.0]],
                [[raw_frame + 0.20, 0.0, 0.0], [raw_frame + 0.30, 1.0, 0.0]],
            ],
            dtype=float,
        )
        coords[0, raw_frame] = frame_coords.reshape(-1)
        bead_energies[0, raw_frame] = np.asarray([0.5 + raw_frame, 1.5 + raw_frame], dtype=float)

    with h5py.File(traj_path, "w") as handle:
        handle.create_dataset("position", data=coords)
        handle.create_dataset("energy", data=bead_energies)

    esti_ep = np.asarray(
        [[
            -9.0,
            -8.0,
            -7.0,
            2.0,
            3.0,
            4.0,
            5.0,
            6.0,
            7.0,
            8.0,
            9.0,
        ]],
        dtype=float,
    )
    with h5py.File(ener_path, "w") as handle:
        handle.create_dataset("esti_Ep", data=esti_ep)
        handle.create_dataset("P", data=np.full((1, esti_ep.shape[1]), n_beads, dtype=np.int32))
        handle.create_dataset("beta", data=np.full((1, esti_ep.shape[1]), beta_value, dtype=float))

    convert_pimd_files(
        traj_path=traj_path,
        ener_path=ener_path,
        xyz_path=xyz_path,
        output_path=out_path,
    )

    with h5py.File(out_path, "r") as handle:
        assert handle.attrs["schema_name"] == "observable_dashboard_pimd"
        assert int(handle.attrs["schema_version"]) == 1
        assert int(handle.attrs["n_atoms"]) == n_atoms
        assert int(handle.attrs["n_beads"]) == n_beads
        assert handle.attrs["coord_unit"] == "bohr"
        assert handle.attrs["energy_unit"] == "hartree"
        assert handle.attrs["step_kind"] == "source_step_index"
        assert handle.attrs["coord_frame_index_kind"] == "traj_saved_frame_index"
        assert float(handle.attrs["temperature_K"]) == pytest.approx(300.0, rel=1e-9)
        assert int(handle.attrs["energy_alignment_start_index"]) == 3
        assert int(handle.attrs["energy_alignment_stride"]) == 1

        atom_numbers = np.asarray(handle["atom_numbers"])
        steps = np.asarray(handle["step"])
        coord_frame_index = np.asarray(handle["coord_frame_index"])
        coords_out = np.asarray(handle["coords"])
        potential_energy = np.asarray(handle["potential_energy"])
        potential_energy_beads = np.asarray(handle["potential_energy_beads"])

    assert atom_numbers.tolist() == [1, 8]
    assert steps.tolist() == [3, 4, 5, 6]
    assert coord_frame_index.tolist() == [1, 2, 3, 4]
    assert coords_out.shape == (4, n_beads, n_atoms, 3)
    assert potential_energy.shape == (4,)
    assert potential_energy_beads.shape == (4, n_beads)
    assert np.allclose(potential_energy, [2.0, 3.0, 4.0, 5.0])
    assert np.allclose(potential_energy_beads.mean(axis=1), potential_energy)
