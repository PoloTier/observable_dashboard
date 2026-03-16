# Electronic-Structure Offline Scripts

These scripts implement a directory-based offline workflow for attaching one or
more PySCF TDDFT calculations to a geometry sampling folder exported from the
normal-modes workflow.

The sampling folder is the canonical artifact. Geometry data stays at the root
of the bundle, and each electronic-structure calculation is stored as its own
profile under `electronics/<profile_id>/`.

This workflow does not use legacy single-`electronic/` layouts.

## End-to-End Flow

1. Export a geometry sampling folder from the normal-modes workflow.
2. Run `prepare_pyscf_jobs.py` once for each electronic-structure setup you
   want to test.
3. Run the generated PySCF jobs externally. Each sample job writes a
   `result.json`.
4. Run `assemble_distribution_bundle.py` for each prepared workspace to write a
   profile into `electronics/<profile_id>/` and update the root
   `manifest.json`.
5. Load the sampling folders into the distribution comparison page. Spectrum
   comparison can then overlay:
   - multiple electronic profiles from the same sampling distribution
   - profiles from different sampling distributions
   - any transition pairs common to all selected profile series

## Sampling Folder Layout

The input to `prepare_pyscf_jobs.py` must be a sampling directory root, not an
archive file. At minimum it must contain:

- `manifest.json`
- `meta/sample_ids.json`
- `sampling/atom_numbers.npy`
- `sampling/atom_masses_amu.npy`
- `sampling/coords_bohr.npy`

Optional geometry payloads that remain valid:

- `sampling/velocities_bohr_per_au_time.npy`
- `sampling/all_structures.xyz`

The root manifest uses schema v4. Geometry channels live in
`manifest.json.sampling_channels`, and electronic profiles are indexed under
`manifest.json.electronics`:

```json
{
  "kind": "normal_modes_sampling",
  "schema_version": 4,
  "sampling_channels": [
    {"name": "atom_numbers", "unit": null, "group": "sampling"},
    {"name": "atom_masses_amu", "unit": "amu", "group": "sampling"},
    {"name": "coords_bohr", "unit": "bohr", "group": "sampling"}
  ],
  "electronics": {
    "default_profile_id": null,
    "profiles": []
  }
}
```

The required sampling channels are:

- `atom_numbers`
- `atom_masses_amu`
- `coords_bohr`

## Result Layout After Assembly

After one or more electronic calculations are assembled, the sampling folder
looks like this:

```text
path/to/normal_modes_geometry_dir/
  manifest.json
  meta/
    sample_ids.json
  sampling/
    atom_numbers.npy
    atom_masses_amu.npy
    coords_bohr.npy
    velocities_bohr_per_au_time.npy          # optional
    all_structures.xyz                       # optional
  electronics/
    pyscf_tddft__auto__b3lyp__6-31g__n5/
      manifest.json
      state_energy_hartree.npy
      transition_pairs.npy
      transition_dipole_au.npy
      transition_intensity.npy
    pyscf_tddft__uks__pbe0__def2-svp__n8/
      manifest.json
      state_energy_hartree.npy
      transition_pairs.npy
      transition_dipole_au.npy
      transition_intensity.npy
  electronic_workspaces/
    pyscf_tddft__auto__b3lyp__6-31g__n5/
    pyscf_tddft__uks__pbe0__def2-svp__n8/
```

Each profile directory is self-contained, while the root manifest maintains the
cross-profile index:

```json
{
  "electronics": {
    "default_profile_id": "pyscf_tddft__auto__b3lyp__6-31g__n5",
    "profiles": [
      {
        "id": "pyscf_tddft__auto__b3lyp__6-31g__n5",
        "label": "TDDFT b3lyp/6-31g* (AUTO, n=5)",
        "path": "electronics/pyscf_tddft__auto__b3lyp__6-31g__n5",
        "engine": "pyscf",
        "method": "tddft",
        "reference": "auto",
        "xc": "b3lyp",
        "basis": "6-31g*",
        "n_excited_states": 5,
        "success_count": 16,
        "failed_count": 0
      }
    ]
  }
}
```

## Step 1: Prepare PySCF Jobs

Run:

```bash
python scripts/electronic_structure/prepare_pyscf_jobs.py \
  --sampling-dir path/to/normal_modes_geometry_dir \
  --xc b3lyp \
  --basis 6-31g* \
  --nstates 5
```

By default this creates a workspace under the sampling directory using a stable
profile id derived from the method settings:

```text
path/to/normal_modes_geometry_dir/
  electronic_workspaces/
    pyscf_tddft__auto__b3lyp__6-31g__n5/
```

You can override the profile metadata explicitly:

```bash
python scripts/electronic_structure/prepare_pyscf_jobs.py \
  --sampling-dir path/to/normal_modes_geometry_dir \
  --xc pbe0 \
  --basis def2-svp \
  --nstates 8 \
  --reference uks \
  --profile-id pyscf_tddft__uks__pbe0__def2-svp__n8 \
  --profile-label "TDDFT PBE0/def2-SVP (UKS, n=8)"
```

You can also override the workspace location with `--workspace` or `--outdir`.

Generated workspace contents:

- `prepare_manifest.json`
- `run_all.sh`
- `jobs/<sample_id>/geometry.xyz`
- `jobs/<sample_id>/sample_meta.json`
- `jobs/<sample_id>/run_pyscf_tddft.py`

Important behavior:

- `charge` and `multiplicity` are read from the sampling folder and are not
  overridden on the command line.
- `prepare_manifest.json` records `profile_id` and `profile_label` in addition
  to the calculation settings.
- `sample_meta.json` records only:
  - `sample_id`
  - `sample_idx`
  - `geom_sha1`
  - `charge`
  - `multiplicity`
- `geom_sha1` is used as a sample-level consistency check during assembly.
- If the target workspace already exists and is non-empty, use `--force` to
  rebuild it.

## Step 2: Run External Jobs

For a local serial run:

```bash
bash path/to/normal_modes_geometry_dir/electronic_workspaces/pyscf_tddft__auto__b3lyp__6-31g__n5/run_all.sh
```

You can also distribute the per-sample job directories to a cluster or other
machines. The only required contract is that each job directory ends with a
`result.json`.

The generated `run_pyscf_tddft.py` script reads:

- `../prepare_manifest.json`
- `geometry.xyz`
- `sample_meta.json`

It writes:

- `result.json`
- `stdout.log` when run through `run_all.sh`

Each successful `result.json` contains:

- sample identity and consistency fields:
  - `sample_id`
  - `sample_idx`
  - `geom_sha1`
- calculation settings:
  - `engine`
  - `method`
  - `reference`
  - `xc`
  - `basis`
  - `n_excited_states`
- status fields:
  - `status`
  - `started_at_utc`
  - `finished_at_utc`
  - `scf_converged`
  - `td_converged`
- electronic payloads:
  - `state_energy_hartree`
  - `transition_pairs`
  - `transition_dipole_au`
  - `transition_intensity`

Failed jobs should still write `result.json` with `status: "error"` plus an
`error_message`.

## Step 3: Assemble Workspace(s) Into Profile(s)

Run:

```bash
python scripts/electronic_structure/assemble_distribution_bundle.py \
  --sampling-dir path/to/normal_modes_geometry_dir
```

Behavior:

- if `electronic_workspaces/` contains exactly one prepared workspace, it is
  assembled directly
- if `electronic_workspaces/` contains multiple prepared workspaces, the script
  now assembles all of them in one run
- if you want to assemble only one specific workspace, pass `--workspace`
  explicitly

Example explicit single-workspace assembly:

```bash
python scripts/electronic_structure/assemble_distribution_bundle.py \
  --sampling-dir path/to/normal_modes_geometry_dir \
  --workspace path/to/normal_modes_geometry_dir/electronic_workspaces/pyscf_tddft__uks__pbe0__def2-svp__n8
```

In automatic multi-workspace mode:

- each workspace is treated as one target profile
- existing results are overwritten only when the incoming workspace uses the
  same `profile_id`
- other already assembled profiles are preserved
- if one workspace fails validation, the script continues assembling the rest
  and prints a success/failure summary at the end
- the process returns a non-zero exit code if any workspace failed, even when
  some other workspaces were assembled successfully

This step writes the following files into the original sampling directory:

- `electronics/<profile_id>/manifest.json`
- `electronics/<profile_id>/state_energy_hartree.npy`
- `electronics/<profile_id>/transition_pairs.npy`
- `electronics/<profile_id>/transition_dipole_au.npy`
- `electronics/<profile_id>/transition_intensity.npy`

It also updates the root `manifest.json` by:

- upserting one entry into `electronics.profiles`
- setting `electronics.default_profile_id` only if it was previously empty
- leaving all other existing electronic profiles untouched

If you assemble the same `profile_id` again, that profile directory and its
index entry are replaced. Other profile ids are preserved.

The root `kind` is not changed. It continues to describe the geometry sampling
provenance.

## Profile Manifest

Each `electronics/<profile_id>/manifest.json` records the profile-specific
metadata and array shapes, for example:

```json
{
  "profile_id": "pyscf_tddft__auto__b3lyp__6-31g__n5",
  "label": "TDDFT b3lyp/6-31g* (AUTO, n=5)",
  "engine": "pyscf",
  "method": "tddft",
  "reference": "uks",
  "xc": "b3lyp",
  "basis": "6-31g*",
  "n_excited_states": 5,
  "n_samples": 16,
  "n_states": 6,
  "n_transition": 5,
  "sample_ids": ["sample_000000", "sample_000001"],
  "channels": [
    {"name": "state_energy_hartree", "unit": "Hartree", "group": "electronic"},
    {"name": "transition_pairs", "unit": null, "group": "electronic"},
    {"name": "transition_dipole_au", "unit": "a.u.", "group": "electronic"},
    {"name": "transition_intensity", "unit": "dimensionless", "group": "electronic"}
  ],
  "success_count": 16,
  "failed_count": 0,
  "failed_samples": []
}
```

## Validation and Failure Handling

During assembly, each successful `result.json` is validated against the
prepared geometry bundle and the workspace manifest:

- `sample_id`
- `sample_idx`
- `geom_sha1`
- `engine`
- `method`
- `xc`
- `basis`
- `n_excited_states`

Additional consistency rules:

- `transition_pairs` must be identical across all successful samples in the
  same profile
- the total number of states must match across all successful samples in the
  same profile
- `reference` must match across all successful samples in the same profile
- a `geom_sha1` mismatch is treated as a hard error

Failure recording is intentionally simple:

- there is no `sample_ok.npy`
- failed samples are listed only in
  `electronics/<profile_id>/manifest.json.failed_samples`
- failed samples keep their slot in the floating-point arrays and are filled
  with `NaN`
- missing `result.json` is recorded as a failed sample, not silent success

## PySCF Dependency

These scripts do not add `pyscf` to the main project dependencies. Install it
separately in the environment where you want to run TDDFT calculations.
