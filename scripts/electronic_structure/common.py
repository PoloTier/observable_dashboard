from __future__ import annotations

import hashlib
import io
import json
import re
import stat
import sys
import textwrap
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np


SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from backend.server.distribution_bundle import (  # noqa: E402
    DISTRIBUTION_BUNDLE_SCHEMA_VERSION,
    build_topology_signature,
)
from backend.server.molden import BOHR_TO_ANG, PERIODIC_SYMBOLS  # noqa: E402


ELECTRONIC_STRUCTURE_METHOD = "pyscf_tddft"
DEFAULT_SCF_CONV_TOL = 1e-9
DEFAULT_TD_CONV_TOL = 1e-6
DEFAULT_MAX_CYCLE = 100

_REQUIRED_MANIFEST_FIELDS = (
    "kind",
    "schema_version",
    "label",
    "source_name",
    "created_at_utc",
    "n_samples",
    "n_atoms",
    "topology_signature",
    "sampling_channels",
    "electronics",
)
_GEOMETRY_CHANNEL_SPECS: dict[str, dict[str, str | None]] = {
    "atom_numbers": {"unit": None, "group": "sampling"},
    "atom_masses_amu": {"unit": "amu", "group": "sampling"},
    "coords_bohr": {"unit": "bohr", "group": "sampling"},
    "velocities_bohr_per_au_time": {"unit": "bohr/au_time", "group": "sampling"},
}
_ELECTRONIC_CHANNEL_SPECS: dict[str, dict[str, str | None]] = {
    "state_energy_hartree": {"unit": "Hartree", "group": "electronic"},
    "transition_pairs": {"unit": None, "group": "electronic"},
    "transition_dipole_au": {"unit": "a.u.", "group": "electronic"},
    "transition_intensity": {"unit": "dimensionless", "group": "electronic"},
}
_ALL_CHANNEL_SPECS: dict[str, dict[str, str | None]] = {
    **_GEOMETRY_CHANNEL_SPECS,
    **_ELECTRONIC_CHANNEL_SPECS,
}
_REQUIRED_GEOMETRY_CHANNEL_NAMES = (
    "atom_numbers",
    "atom_masses_amu",
    "coords_bohr",
)
_PROFILE_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


@dataclass(frozen=True, slots=True)
class GeometrySample:
    sample_idx: int
    sample_id: str
    geom_sha1: str
    charge: int
    multiplicity: int


@dataclass(frozen=True, slots=True)
class GeometryBundle:
    bundle_path: Path
    manifest: dict[str, Any]
    kind: str
    atom_numbers: np.ndarray
    atom_masses_amu: np.ndarray
    coords_bohr: np.ndarray
    velocities_bohr_per_au_time: np.ndarray | None
    sample_ids: list[str]
    samples: list[GeometrySample]
    topology_signature: str
    batch_id: str
    sampling_method: str
    source_name: str
    charge: int
    multiplicity: int
    seed: int | None

    @property
    def n_samples(self) -> int:
        return int(self.coords_bohr.shape[0])

    @property
    def n_atoms(self) -> int:
        return int(self.coords_bohr.shape[1])


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def normalize_profile_id(value: Any, *, label: str = "profile_id") -> str:
    text = str(value or "").strip()
    if not text:
        raise ValueError(f"{label} must be a non-empty string.")
    if "/" in text or "\\" in text:
        raise ValueError(f"{label} must not contain path separators: {text!r}")
    if text in {".", ".."}:
        raise ValueError(f"{label} must not be {text!r}.")
    if _PROFILE_ID_PATTERN.fullmatch(text) is None:
        raise ValueError(
            f"{label} must match the portable pattern [A-Za-z0-9][A-Za-z0-9._-]*, found {text!r}."
        )
    return text


def _load_json_bytes(payload: bytes, *, expected_path: str) -> Any:
    try:
        return json.loads(payload.decode("utf-8"))
    except Exception as exc:  # noqa: BLE001
        raise ValueError(f"Failed to decode JSON payload from {expected_path}: {exc}") from exc


def _load_npy_bytes(payload: bytes, *, expected_path: str) -> np.ndarray:
    try:
        return np.load(io.BytesIO(payload), allow_pickle=False)
    except Exception as exc:  # noqa: BLE001
        raise ValueError(f"Failed to decode NumPy payload from {expected_path}: {exc}") from exc


def _normalize_text_list(value: Any, *, expected_length: int, path: str) -> list[str]:
    if not isinstance(value, list):
        raise ValueError(f"{path} must be a JSON list.")
    items = [str(item) for item in value]
    if len(items) != int(expected_length):
        raise ValueError(f"{path} length mismatch: expected {expected_length}, found {len(items)}.")
    return items


def _normalize_manifest_channels(
    value: Any,
    *,
    allowed_specs: dict[str, dict[str, str | None]],
    required_names: tuple[str, ...],
) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        raise ValueError("Bundle manifest channels must be a JSON list of objects.")

    normalized: list[dict[str, Any]] = []
    seen_names: set[str] = set()
    for index, raw_item in enumerate(value):
        if not isinstance(raw_item, dict):
            raise ValueError(
                f"Bundle manifest channel entry at index {index} must be an object with name, unit, and group."
            )
        item_keys = set(raw_item.keys())
        if item_keys != {"name", "unit", "group"}:
            raise ValueError(
                "Bundle manifest channel entries must contain only 'name', 'unit', and 'group' fields."
            )

        name = str(raw_item.get("name") or "").strip()
        if not name:
            raise ValueError(f"Bundle manifest channel entry at index {index} is missing a valid name.")
        if name in seen_names:
            raise ValueError(f"Bundle manifest channels contain a duplicate name: {name}.")
        if name not in allowed_specs:
            raise ValueError(f"Bundle manifest channels contain an unsupported name: {name}.")

        expected_spec = allowed_specs[name]
        group = str(raw_item.get("group") or "").strip()
        expected_group = str(expected_spec["group"] or "")
        if group != expected_group:
            raise ValueError(f"Bundle manifest channel {name} must use group {expected_group!r}, found {group!r}.")

        unit = raw_item.get("unit")
        expected_unit = expected_spec["unit"]
        if expected_unit is None:
            if unit is not None:
                raise ValueError(f"Bundle manifest channel {name} must use unit null.")
        elif str(unit or "").strip() != expected_unit:
            raise ValueError(f"Bundle manifest channel {name} must use unit {expected_unit!r}, found {unit!r}.")

        normalized.append({"name": name, "unit": expected_unit, "group": expected_group})
        seen_names.add(name)

    for required_name in required_names:
        if required_name not in seen_names:
            raise ValueError(f"Bundle manifest channels are missing required channel: {required_name}.")
    return normalized


def _geometry_channel_entries(*, include_velocities: bool) -> list[dict[str, Any]]:
    names = list(_REQUIRED_GEOMETRY_CHANNEL_NAMES)
    if include_velocities:
        names.append("velocities_bohr_per_au_time")
    return [
        {
            "name": name,
            "unit": _GEOMETRY_CHANNEL_SPECS[name]["unit"],
            "group": _GEOMETRY_CHANNEL_SPECS[name]["group"],
        }
        for name in names
    ]


def _electronic_channel_entries() -> list[dict[str, Any]]:
    ordered_names = (
        "state_energy_hartree",
        "transition_pairs",
        "transition_dipole_au",
        "transition_intensity",
    )
    return [
        {
            "name": name,
            "unit": _ELECTRONIC_CHANNEL_SPECS[name]["unit"],
            "group": _ELECTRONIC_CHANNEL_SPECS[name]["group"],
        }
        for name in ordered_names
    ]


def write_json(path: Path, payload: Any) -> None:
    text = f"{json.dumps(payload, indent=2, sort_keys=True)}\n"
    path.write_text(text, encoding="utf-8")


def write_text(path: Path, payload: str, *, executable: bool = False) -> None:
    path.write_text(str(payload), encoding="utf-8")
    if executable:
        current_mode = path.stat().st_mode
        path.chmod(current_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def write_npy(path: Path, array: np.ndarray) -> None:
    with path.open("wb") as handle:
        np.save(handle, np.asarray(array), allow_pickle=False)


def ensure_empty_directory(path: Path) -> None:
    if path.exists():
        if not path.is_dir():
            raise ValueError(f"Output path exists but is not a directory: {path}")
        if any(path.iterdir()):
            raise ValueError(f"Output directory must be empty: {path}")
        return
    path.mkdir(parents=True, exist_ok=False)


def atom_symbol(atomic_number: int) -> str:
    index = int(atomic_number)
    if 0 < index < len(PERIODIC_SYMBOLS) and PERIODIC_SYMBOLS[index]:
        return str(PERIODIC_SYMBOLS[index])
    return "X"


def geometry_sha1(atom_numbers: np.ndarray, coords_bohr_sample: np.ndarray) -> str:
    atom_bytes = np.asarray(atom_numbers, dtype=np.int32).reshape(-1).tobytes(order="C")
    coords_bytes = np.asarray(coords_bohr_sample, dtype=np.float64).reshape(-1).tobytes(order="C")
    return hashlib.sha1(atom_bytes + coords_bytes).hexdigest()  # noqa: S324


def coords_bohr_to_xyz_text(
    atom_numbers: np.ndarray,
    coords_bohr_sample: np.ndarray,
    *,
    comment_line: str,
) -> str:
    atom_numbers_array = np.asarray(atom_numbers, dtype=int).reshape(-1)
    coords_bohr_array = np.asarray(coords_bohr_sample, dtype=float)
    if coords_bohr_array.ndim != 2 or coords_bohr_array.shape[1] != 3:
        raise ValueError(
            f"coords_bohr_sample must have shape [n_atoms, 3], got {coords_bohr_array.shape}."
        )
    if coords_bohr_array.shape[0] != atom_numbers_array.shape[0]:
        raise ValueError(
            "coords_bohr_sample and atom_numbers must align on atom count: "
            f"coords={coords_bohr_array.shape}, atom_numbers={atom_numbers_array.shape}."
        )
    coords_ang = np.asarray(coords_bohr_array * float(BOHR_TO_ANG), dtype=float)
    lines = [str(atom_numbers_array.shape[0]), str(comment_line)]
    for atom_index, atomic_number in enumerate(atom_numbers_array.tolist()):
        x, y, z = coords_ang[atom_index]
        lines.append(
            f"{atom_symbol(int(atomic_number))} "
            f"{float(x):.8f} {float(y):.8f} {float(z):.8f}"
        )
    return "\n".join(lines) + "\n"


def coords_bohr_trajectory_to_xyz_text(
    atom_numbers: np.ndarray,
    coords_bohr: np.ndarray,
    *,
    batch_id: str,
    sample_ids: list[str],
) -> str:
    coords_array = np.asarray(coords_bohr, dtype=float)
    if coords_array.ndim != 3 or coords_array.shape[2] != 3:
        raise ValueError(f"coords_bohr must have shape [n_samples, n_atoms, 3], got {coords_array.shape}.")
    if int(coords_array.shape[0]) != len(sample_ids):
        raise ValueError(
            f"coords_bohr and sample_ids must align on sample count: coords={coords_array.shape}, "
            f"sample_ids={len(sample_ids)}."
        )

    frames = []
    for sample_idx, sample_id in enumerate(sample_ids):
        frames.append(
            coords_bohr_to_xyz_text(
                atom_numbers,
                coords_array[sample_idx],
                comment_line=f"batch_id={batch_id} sample_idx={sample_idx} sample_id={sample_id}",
            )
        )
    return "".join(frames)


def load_geometry_bundle(bundle_path: Path) -> GeometryBundle:
    bundle_path = Path(bundle_path).resolve()
    if bundle_path.is_file():
        raise ValueError(
            f"Geometry bundle path must be a sampling directory root, not a file archive: {bundle_path}"
        )
    if not bundle_path.is_dir():
        raise ValueError(f"Geometry bundle path is not a directory: {bundle_path}")

    manifest_path = bundle_path / "manifest.json"
    sample_ids_path = bundle_path / "meta" / "sample_ids.json"
    atom_numbers_path = bundle_path / "sampling" / "atom_numbers.npy"
    atom_masses_path = bundle_path / "sampling" / "atom_masses_amu.npy"
    coords_path = bundle_path / "sampling" / "coords_bohr.npy"
    velocities_path = bundle_path / "sampling" / "velocities_bohr_per_au_time.npy"

    if not manifest_path.is_file():
        raise ValueError(f"Geometry bundle is missing required file: {manifest_path}")
    if not sample_ids_path.is_file():
        raise ValueError(f"Geometry bundle is missing required file: {sample_ids_path}")
    if not atom_numbers_path.is_file():
        raise ValueError(f"Geometry bundle is missing required file: {atom_numbers_path}")
    if not atom_masses_path.is_file():
        raise ValueError(f"Geometry bundle is missing required file: {atom_masses_path}")
    if not coords_path.is_file():
        raise ValueError(f"Geometry bundle is missing required file: {coords_path}")

    manifest = _load_json_bytes(manifest_path.read_bytes(), expected_path="manifest.json")
    if not isinstance(manifest, dict):
        raise ValueError("manifest.json must decode to a JSON object.")
    missing = [field for field in _REQUIRED_MANIFEST_FIELDS if field not in manifest]
    if missing:
        raise ValueError(f"Geometry bundle manifest is missing required fields: {', '.join(missing)}")
    if "channels" in manifest:
        raise ValueError("Geometry bundle manifest field 'channels' is not supported in schema v4.")
    if "units" in manifest:
        raise ValueError("Geometry bundle manifest field 'units' is not supported in schema v4.")
    if "atom_index_base" in manifest:
        raise ValueError("Geometry bundle manifest field 'atom_index_base' is not supported in schema v4.")
    if "provenance" in manifest:
        raise ValueError("Geometry bundle manifest field 'provenance' is not supported in schema v4.")
    if int(manifest.get("schema_version") or 0) != int(DISTRIBUTION_BUNDLE_SCHEMA_VERSION):
        raise ValueError(f"Geometry bundle manifest schema_version must be {DISTRIBUTION_BUNDLE_SCHEMA_VERSION}.")

    kind = str(manifest.get("kind") or "").strip()
    if not kind:
        raise ValueError("Geometry bundle manifest kind must be a non-empty string.")

    electronics = manifest.get("electronics")
    if not isinstance(electronics, dict):
        raise ValueError("Geometry bundle manifest field 'electronics' must be an object.")
    if set(electronics.keys()) != {"default_profile_id", "profiles"}:
        raise ValueError(
            "Geometry bundle manifest field 'electronics' must contain only 'default_profile_id' and 'profiles'."
        )
    if not isinstance(electronics.get("profiles"), list):
        raise ValueError("Geometry bundle manifest field 'electronics.profiles' must be a JSON list.")

    sample_ids = _load_json_bytes(sample_ids_path.read_bytes(), expected_path="meta/sample_ids.json")
    manifest_channels = _normalize_manifest_channels(
        manifest.get("sampling_channels"),
        allowed_specs=_GEOMETRY_CHANNEL_SPECS,
        required_names=_REQUIRED_GEOMETRY_CHANNEL_NAMES,
    )

    atom_numbers = np.asarray(
        _load_npy_bytes(atom_numbers_path.read_bytes(), expected_path="sampling/atom_numbers.npy"),
        dtype=int,
    ).reshape(-1)
    atom_masses_amu = np.asarray(
        _load_npy_bytes(atom_masses_path.read_bytes(), expected_path="sampling/atom_masses_amu.npy"),
        dtype=float,
    ).reshape(-1)
    coords_bohr = np.asarray(
        _load_npy_bytes(coords_path.read_bytes(), expected_path="sampling/coords_bohr.npy"),
        dtype=float,
    )
    if coords_bohr.ndim != 3 or coords_bohr.shape[2] != 3:
        raise ValueError(
            f"sampling/coords_bohr.npy must have shape [n_samples, n_atoms, 3], got {coords_bohr.shape}."
        )
    if atom_numbers.shape[0] != int(coords_bohr.shape[1]):
        raise ValueError(
            "sampling/atom_numbers.npy must align with coords atom axis: "
            f"atom_numbers={atom_numbers.shape}, coords={coords_bohr.shape}."
        )
    if atom_masses_amu.shape[0] != int(coords_bohr.shape[1]):
        raise ValueError(
            "sampling/atom_masses_amu.npy must align with coords atom axis: "
            f"atom_masses_amu={atom_masses_amu.shape}, coords={coords_bohr.shape}."
        )

    velocities_bohr_per_au_time: np.ndarray | None = None
    if velocities_path.is_file():
        velocities_bohr_per_au_time = np.asarray(
            _load_npy_bytes(
                velocities_path.read_bytes(),
                expected_path="sampling/velocities_bohr_per_au_time.npy",
            ),
            dtype=float,
        )
        if velocities_bohr_per_au_time.shape != coords_bohr.shape:
            raise ValueError(
                "sampling/velocities_bohr_per_au_time.npy must align with sampling/coords_bohr.npy: "
                f"velocities={velocities_bohr_per_au_time.shape}, coords={coords_bohr.shape}."
            )

    n_samples = int(coords_bohr.shape[0])
    n_atoms = int(coords_bohr.shape[1])
    sample_ids = _normalize_text_list(sample_ids, expected_length=n_samples, path="meta/sample_ids.json")

    manifest_sample_count = int(manifest.get("n_samples") or -1)
    if manifest_sample_count != n_samples:
        raise ValueError(f"manifest n_samples mismatch: manifest={manifest_sample_count}, data={n_samples}.")
    manifest_atom_count = int(manifest.get("n_atoms") or -1)
    if manifest_atom_count != n_atoms:
        raise ValueError(f"manifest n_atoms mismatch: manifest={manifest_atom_count}, data={n_atoms}.")

    topology_signature = build_topology_signature(atom_numbers)
    manifest_topology_signature = str(manifest.get("topology_signature") or "").strip()
    if manifest_topology_signature != topology_signature:
        raise ValueError(
            "manifest topology_signature does not match atom_numbers ordering: "
            f"manifest={manifest_topology_signature} data={topology_signature}."
        )

    actual_channel_names = set(_REQUIRED_GEOMETRY_CHANNEL_NAMES)
    if velocities_bohr_per_au_time is not None:
        actual_channel_names.add("velocities_bohr_per_au_time")
    declared_geometry_channel_names = {
        str(entry["name"])
        for entry in manifest_channels
        if str(entry["name"]) in _GEOMETRY_CHANNEL_SPECS
    }
    if declared_geometry_channel_names != actual_channel_names:
        raise ValueError(
            "Geometry bundle manifest geometry channels do not match the directory payloads: "
            f"manifest={sorted(declared_geometry_channel_names)} data={sorted(actual_channel_names)}."
        )

    samples: list[GeometrySample] = []
    charge_raw = manifest.get("charge")
    multiplicity_raw = manifest.get("multiplicity")
    if charge_raw is None:
        raise ValueError("Geometry bundle manifest is missing required field: charge.")
    if multiplicity_raw is None:
        raise ValueError("Geometry bundle manifest is missing required field: multiplicity.")
    charge = int(charge_raw)
    multiplicity = int(multiplicity_raw)

    for sample_idx, sample_id in enumerate(sample_ids):
        geom_sha1_value = geometry_sha1(atom_numbers, coords_bohr[sample_idx])
        samples.append(
            GeometrySample(
                sample_idx=sample_idx,
                sample_id=sample_id,
                geom_sha1=geom_sha1_value,
                charge=charge,
                multiplicity=multiplicity,
            )
        )

    batch_id = str(manifest.get("batch_id") or "").strip()
    if not batch_id:
        raise ValueError("Geometry bundle manifest is missing required field: batch_id.")
    sampling_method = str(manifest.get("sampling_method") or "").strip()
    if not sampling_method:
        raise ValueError("Geometry bundle manifest is missing required field: sampling_method.")
    source_name = str(manifest.get("source_name") or bundle_path.name).strip()
    if not source_name:
        raise ValueError("Geometry bundle is missing source_name.")
    seed_raw = manifest.get("seed")
    seed = None if seed_raw is None else int(seed_raw)

    return GeometryBundle(
        bundle_path=bundle_path,
        manifest=dict(manifest),
        kind=kind,
        atom_numbers=atom_numbers.astype(int),
        atom_masses_amu=np.asarray(atom_masses_amu, dtype=float),
        coords_bohr=np.asarray(coords_bohr, dtype=float),
        velocities_bohr_per_au_time=(
            None
            if velocities_bohr_per_au_time is None
            else np.asarray(velocities_bohr_per_au_time, dtype=float)
        ),
        sample_ids=list(sample_ids),
        samples=samples,
        topology_signature=topology_signature,
        batch_id=batch_id,
        sampling_method=sampling_method,
        source_name=source_name,
        charge=charge,
        multiplicity=multiplicity,
        seed=seed,
    )


def build_generated_pyscf_job_script() -> str:
    return textwrap.dedent(
        """\
        #!/usr/bin/env python3
        from __future__ import annotations

        import json
        import os
        import traceback
        from datetime import datetime, timezone
        from pathlib import Path

        import numpy as np


        def load_json(path: Path) -> dict:
            return json.loads(path.read_text(encoding="utf-8"))


        def read_xyz(path: Path) -> list[tuple[str, tuple[float, float, float]]]:
            lines = [line.strip() for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
            if len(lines) < 2:
                raise ValueError(f"XYZ file is too short: {path}")
            atom_count = int(lines[0])
            coord_lines = lines[2:]
            if len(coord_lines) != atom_count:
                raise ValueError(
                    f"XYZ atom count mismatch in {path}: expected {atom_count}, found {len(coord_lines)}."
                )
            atoms: list[tuple[str, tuple[float, float, float]]] = []
            for line in coord_lines:
                fields = line.split()
                if len(fields) != 4:
                    raise ValueError(f"Invalid XYZ coordinate line in {path}: {line!r}")
                symbol = str(fields[0])
                x = float(fields[1])
                y = float(fields[2])
                z = float(fields[3])
                atoms.append((symbol, (x, y, z)))
            return atoms


        def write_result(path: Path, payload: dict) -> None:
            path.write_text(f"{json.dumps(payload, indent=2, sort_keys=True)}\\n", encoding="utf-8")


        def utc_now_iso() -> str:
            return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


        def configure_thread_env(config: dict) -> None:
            explicit_env_names = ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS")
            if any(str(os.environ.get(name) or "").strip() for name in explicit_env_names):
                return

            configured_raw = config.get("num_threads")
            thread_count: int | None = None if configured_raw is None else int(configured_raw)
            if thread_count is None or int(thread_count) <= 0:
                return

            thread_text = str(int(thread_count))
            for name in explicit_env_names:
                os.environ.setdefault(name, thread_text)


        def select_reference(config: dict, *, multiplicity: int) -> str:
            requested = str(config.get("reference") or "auto").strip().lower()
            if requested == "auto":
                return "rks" if int(multiplicity) == 1 else "uks"
            if requested not in {"rks", "uks"}:
                raise ValueError(f"Unsupported reference setting: {requested}")
            if requested == "rks" and int(multiplicity) != 1:
                raise ValueError("RKS reference only supports multiplicity=1 in this v1 script.")
            return requested


        def main() -> int:
            job_dir = Path(__file__).resolve().parent
            workspace_dir = job_dir.parents[1]
            sample_meta = load_json(job_dir / "sample_meta.json")
            config = load_json(workspace_dir / "prepare_manifest.json")
            result_path = job_dir / "result.json"
            started_at_utc = utc_now_iso()
            base_payload = {
                "sample_id": str(sample_meta["sample_id"]),
                "sample_idx": int(sample_meta["sample_idx"]),
                "geom_sha1": str(sample_meta["geom_sha1"]),
                "engine": "pyscf",
                "method": "tddft",
                "reference": str(config.get("reference") or "auto").strip().lower(),
                "xc": str(config["xc"]),
                "basis": str(config["basis"]),
                "n_excited_states": int(config["n_excited_states"]),
            }

            try:
                configure_thread_env(config)

                from pyscf import dft, gto, tddft

                atoms = read_xyz(job_dir / "geometry.xyz")
                charge = int(sample_meta["charge"])
                multiplicity = int(sample_meta["multiplicity"])
                spin = multiplicity - 1
                reference = select_reference(config, multiplicity=multiplicity)

                mol = gto.M(
                    atom=atoms,
                    unit="Angstrom",
                    basis=str(config["basis"]),
                    charge=charge,
                    spin=spin,
                    verbose=4,
                )
                mf = dft.RKS(mol) if reference == "rks" else dft.UKS(mol)
                mf.xc = str(config["xc"])
                mf.conv_tol = float(config.get("scf_conv_tol") or 1e-9)
                mf.max_cycle = int(config.get("max_cycle") or 100)
                memory_mb = config.get("memory_mb")
                if memory_mb is not None:
                    mf.max_memory = int(memory_mb)

                scf_energy = mf.kernel()
                if scf_energy is None:
                    raise ValueError("SCF returned no total energy.")
                if not bool(getattr(mf, "converged", False)):
                    raise ValueError("SCF did not converge.")

                td = tddft.TDDFT(mf)
                td.nstates = int(config["n_excited_states"])
                td.conv_tol = float(config.get("td_conv_tol") or 1e-6)
                if hasattr(td, "max_cycle"):
                    td.max_cycle = int(config.get("max_cycle") or 100)
                td.kernel()

                excitation_energies = np.asarray(getattr(td, "e"), dtype=float).reshape(-1)
                transition_dipole = np.asarray(td.transition_dipole(), dtype=float)
                transition_intensity = np.asarray(td.oscillator_strength(gauge="length"), dtype=float).reshape(-1)
                if transition_dipole.shape != (excitation_energies.shape[0], 3):
                    raise ValueError(
                        "transition_dipole() returned unexpected shape: "
                        f"{transition_dipole.shape} for {excitation_energies.shape[0]} excited states."
                    )
                if transition_intensity.shape != (excitation_energies.shape[0],):
                    raise ValueError(
                        "oscillator_strength() returned unexpected shape: "
                        f"{transition_intensity.shape} for {excitation_energies.shape[0]} excited states."
                    )

                td_converged_raw = getattr(td, "converged", None)
                td_converged = True
                if td_converged_raw is not None:
                    td_converged = bool(np.all(np.asarray(td_converged_raw, dtype=bool)))
                if not td_converged:
                    raise ValueError("TDDFT did not converge for all requested excited states.")

                result_payload = dict(base_payload)
                result_payload.update(
                    {
                        "status": "ok",
                        "reference": reference,
                        "started_at_utc": started_at_utc,
                        "finished_at_utc": utc_now_iso(),
                        "scf_converged": bool(getattr(mf, "converged", False)),
                        "td_converged": td_converged,
                        "state_energy_hartree": [float(scf_energy)]
                        + [float(scf_energy + delta_e) for delta_e in excitation_energies.tolist()],
                        "transition_pairs": [[0, state_index + 1] for state_index in range(excitation_energies.shape[0])],
                        "transition_dipole_au": transition_dipole.astype(float).tolist(),
                        "transition_intensity": transition_intensity.astype(float).tolist(),
                    }
                )
                write_result(result_path, result_payload)
                return 0
            except Exception as exc:  # noqa: BLE001
                error_payload = dict(base_payload)
                error_payload.update(
                    {
                        "status": "error",
                        "started_at_utc": started_at_utc,
                        "finished_at_utc": utc_now_iso(),
                        "error_message": f"{type(exc).__name__}: {exc}",
                        "traceback": traceback.format_exc(),
                    }
                )
                write_result(result_path, error_payload)
                return 1


        if __name__ == "__main__":
            raise SystemExit(main())
        """
    )


def build_run_all_script() -> str:
    return textwrap.dedent(
        """\
        #!/usr/bin/env bash
        set -euo pipefail

        ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
        mapfile -t JOB_DIRS < <(find "$ROOT_DIR/jobs" -mindepth 1 -maxdepth 1 -type d | sort)

        for job_dir in "${JOB_DIRS[@]}"; do
          echo "==> $(basename "$job_dir")"
          (
            cd "$job_dir"
            python run_pyscf_tddft.py > stdout.log 2>&1
          )
        done
        """
    )
