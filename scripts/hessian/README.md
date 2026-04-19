# MACE Hessian Workspace Scripts

This folder contains a single local workflow for evaluating Cartesian Hessians
from geometry sampling bundles with a MACE model.

The input is always a sampling directory root, for example a normal-modes or
trajectory sampling export that already contains:

- `manifest.json`
- `meta/sample_ids.json`
- `sampling/atom_numbers.npy`
- `sampling/atom_masses_amu.npy`
- `sampling/coords_bohr.npy`

## What The Script Does

`compute_mace_hessians.py` reads one or more geometries from the sampling
bundle, converts each geometry into `ase.Atoms`, calls
`mace.calculators.MACECalculator.get_hessian(...)`, and writes a directory-based
workspace under the sampling folder.

By default it evaluates the full ensemble in `sampling/coords_bohr.npy`.

If you pass `--selection-id`, it instead resolves the unique geometry set from
`selection/<selection_id>/selected_records.json`. This avoids recomputing the
same geometry multiple times when a selection contains repeated electronic
records for one structure.

## Example: Full Sampling Bundle

```bash
python scripts/hessian/compute_mace_hessians.py \
  --sampling-dir path/to/sampling_dir \
  --model /path/to/mace_model.model \
  --device cpu
```

This creates a workspace like:

```text
path/to/sampling_dir/
  hessian_workspaces/
    mace_hessian__mace_model.model__all/
      manifest.json
      target_index.json
      all_structures.xyz
      samples/
        sample_000000__nm_sample_000000/
          target_meta.json
          geometry.xyz
          coords_bohr.npy
          coords_ang.npy
          hessian_cartesian_model_units.npy
          hessian_cartesian_ev_per_ang2.npy
          hessian_cartesian_hartree_per_bohr2.npy
```

## Example: One Structure From A Selection

```bash
python scripts/hessian/compute_mace_hessians.py \
  --sampling-dir path/to/sampling_dir \
  --selection-id window_all \
  --subset-geometry-index 0 \
  --model /path/to/mace_model.model \
  --device cuda
```

Useful filters:

- `--sample-idx 5`
- `--sample-id nm-sample-demo_sample_000005`
- `--subset-geometry-index 0`

The filters can be repeated to keep multiple targets.

## Units

Each successful target directory stores the Hessian in three forms:

- `hessian_cartesian_model_units.npy`
- `hessian_cartesian_ev_per_ang2.npy`
- `hessian_cartesian_hartree_per_bohr2.npy`

The native MACE tensor is normalized into a dense Cartesian matrix with
component order:

`[x1, y1, z1, x2, y2, z2, ...]`

If your model does not use native `eV` and `angstrom`, provide the conversion
factors explicitly:

```bash
python scripts/hessian/compute_mace_hessians.py \
  --sampling-dir path/to/sampling_dir \
  --model /path/to/model \
  --energy-units-to-ev 27.211386245988 \
  --length-units-to-a 0.529177210903
```

## Notes

- This v1 workflow only supports a single MACE model file per run.
- `float64` is the default dtype because Hessians are second derivatives.
- The script writes one subdirectory per target geometry so large runs do not
  require keeping every Hessian stacked in memory.

