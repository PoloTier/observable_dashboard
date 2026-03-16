from __future__ import annotations

import hashlib
import io
import json
import secrets
import tarfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

import numpy as np

from backend.server.molden import BOHR_TO_ANG


DISTRIBUTION_BUNDLE_KIND = "normal_modes_sampling"
DISTRIBUTION_BUNDLE_SCHEMA_VERSION = 4

CHANNEL_GROUP_SAMPLING = "sampling"
CHANNEL_GROUP_ELECTRONIC = "electronic"

_REQUIRED_ROOT_MANIFEST_FIELDS = (
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
_ROOT_FORBIDDEN_FIELDS = (
    "channels",
    "units",
    "atom_index_base",
    "provenance",
)
_REQUIRED_BUNDLE_FILE_PATHS = (
    "manifest.json",
    "meta/sample_ids.json",
    "sampling/atom_numbers.npy",
    "sampling/atom_masses_amu.npy",
    "sampling/coords_bohr.npy",
)
_CANONICAL_SAMPLING_CHANNEL_SPECS: dict[str, dict[str, str | None]] = {
    "atom_numbers": {"unit": None, "group": CHANNEL_GROUP_SAMPLING},
    "atom_masses_amu": {"unit": "amu", "group": CHANNEL_GROUP_SAMPLING},
    "coords_bohr": {"unit": "bohr", "group": CHANNEL_GROUP_SAMPLING},
    "velocities_bohr_per_au_time": {"unit": "bohr/au_time", "group": CHANNEL_GROUP_SAMPLING},
}
_CANONICAL_ELECTRONIC_CHANNEL_SPECS: dict[str, dict[str, str | None]] = {
    "state_energy_hartree": {"unit": "Hartree", "group": CHANNEL_GROUP_ELECTRONIC},
    "transition_pairs": {"unit": None, "group": CHANNEL_GROUP_ELECTRONIC},
    "transition_dipole_au": {"unit": "a.u.", "group": CHANNEL_GROUP_ELECTRONIC},
    "transition_intensity": {"unit": "dimensionless", "group": CHANNEL_GROUP_ELECTRONIC},
}
_REQUIRED_SAMPLING_CHANNEL_NAMES = (
    "atom_numbers",
    "atom_masses_amu",
    "coords_bohr",
)
_REQUIRED_ELECTRONIC_CHANNEL_NAMES = (
    "state_energy_hartree",
    "transition_pairs",
    "transition_dipole_au",
    "transition_intensity",
)
HARTREE_TO_EV = 27.211386245988


@dataclass(slots=True)
class ElectronicProfile:
    profile_id: str
    label: str
    engine: str
    method: str
    reference: str
    xc: str
    basis: str
    n_excited_states: int
    state_energy_hartree: np.ndarray
    transition_pairs: np.ndarray
    transition_dipole_au: np.ndarray
    transition_intensity: np.ndarray
    success_count: int
    failed_count: int
    failed_samples: list[dict[str, Any]]
    manifest: dict[str, Any]

    @property
    def n_states(self) -> int:
        return int(self.state_energy_hartree.shape[1])

    @property
    def n_transition(self) -> int:
        return int(self.transition_pairs.shape[0])


@dataclass(slots=True)
class DistributionBundle:
    label: str
    source_name: str
    created_at_utc: str
    atom_numbers: np.ndarray
    atom_masses_amu: np.ndarray
    coords_bohr: np.ndarray
    topology_signature: str
    manifest: dict[str, Any]
    sample_ids: list[str]
    electronic_profiles: dict[str, ElectronicProfile]
    default_profile_id: str | None = None
    velocities_bohr_per_au_time: np.ndarray | None = None

    @property
    def n_samples(self) -> int:
        return int(self.coords_bohr.shape[0])

    @property
    def n_atoms(self) -> int:
        return int(self.coords_bohr.shape[1])

    @property
    def available_channels(self) -> list[str]:
        names = ["atom_numbers", "atom_masses_amu", "coords_bohr"]
        if self.velocities_bohr_per_au_time is not None:
            names.append("velocities_bohr_per_au_time")
        return names

    @property
    def has_electronics(self) -> bool:
        return bool(self.electronic_profiles)

    @property
    def default_electronic_profile(self) -> ElectronicProfile | None:
        if not self.default_profile_id:
            return None
        return self.electronic_profiles.get(str(self.default_profile_id))

    @property
    def default_electronic_profile_id(self) -> str | None:
        return None if self.default_profile_id is None else str(self.default_profile_id)

    @property
    def n_states(self) -> int | None:
        profile = self.default_electronic_profile
        return None if profile is None else int(profile.n_states)

    @property
    def n_transition(self) -> int | None:
        profile = self.default_electronic_profile
        return None if profile is None else int(profile.n_transition)


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def build_topology_signature(atom_numbers: np.ndarray) -> str:
    values = np.asarray(atom_numbers, dtype=int).reshape(-1)
    digest = hashlib.sha1(",".join(str(int(value)) for value in values.tolist()).encode("utf-8")).hexdigest()  # noqa: S324
    return f"atoms-{values.shape[0]}-{digest[:16]}"


def make_distribution_id() -> str:
    return f"dist-{secrets.token_urlsafe(9)}"


def _require_member_bytes(archive: tarfile.TarFile, path: str) -> bytes:
    try:
        member = archive.extractfile(path)
    except KeyError as exc:
        raise ValueError(f"Distribution bundle is missing required file: {path}") from exc
    if member is None:
        raise ValueError(f"Distribution bundle is missing required file: {path}")
    return member.read()


def _optional_member_bytes(archive: tarfile.TarFile, path: str) -> bytes | None:
    try:
        member = archive.extractfile(path)
    except KeyError:
        return None
    if member is None:
        return None
    return member.read()


def _read_directory_member_bytes(bundle_dir: Path, relative_path: str, *, required: bool) -> bytes | None:
    relative = Path(relative_path)
    if relative.is_absolute() or any(part in {"", ".", ".."} for part in relative.parts):
        raise ValueError(f"Invalid distribution bundle path: {relative_path}")
    target_path = bundle_dir / relative
    if not target_path.is_file():
        if required:
            raise ValueError(f"Distribution bundle is missing required file: {relative_path}")
        return None
    try:
        return target_path.read_bytes()
    except OSError as exc:
        raise ValueError(f"Failed to read distribution bundle file {relative_path}: {exc}") from exc


def _load_npy(payload: bytes, *, expected_path: str) -> np.ndarray:
    try:
        return np.load(io.BytesIO(payload), allow_pickle=False)
    except Exception as exc:  # noqa: BLE001
        raise ValueError(f"Failed to read NumPy payload from {expected_path}: {exc}") from exc


def _load_json(payload: bytes, *, expected_path: str) -> Any:
    try:
        return json.loads(payload.decode("utf-8"))
    except Exception as exc:  # noqa: BLE001
        raise ValueError(f"Failed to decode JSON payload from {expected_path}: {exc}") from exc


def _require_non_empty_string(value: Any, *, label: str) -> str:
    text = str(value or "").strip()
    if not text:
        raise ValueError(f"{label} must be a non-empty string.")
    return text


def _normalize_text_list(value: Any, *, expected_length: int, path: str) -> list[str]:
    if not isinstance(value, list):
        raise ValueError(f"{path} must be a JSON list.")
    items = [str(item) for item in value]
    if len(items) != int(expected_length):
        raise ValueError(f"{path} length mismatch: expected {expected_length}, found {len(items)}.")
    return items


def _normalize_channel_entries(
    value: Any,
    *,
    allowed_specs: dict[str, dict[str, str | None]],
    required_names: tuple[str, ...],
    field_name: str,
) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        raise ValueError(f"{field_name} must be a JSON list of objects.")

    normalized: list[dict[str, Any]] = []
    seen_names: set[str] = set()
    for index, raw_item in enumerate(value):
        if not isinstance(raw_item, dict):
            raise ValueError(f"{field_name}[{index}] must be an object with name, unit, and group.")
        name = _require_non_empty_string(raw_item.get("name"), label=f"{field_name}[{index}].name")
        if name in seen_names:
            raise ValueError(f"{field_name} contains duplicate channel name: {name}.")
        if name not in allowed_specs:
            raise ValueError(f"{field_name} contains unsupported channel name: {name}.")
        expected_spec = allowed_specs[name]
        expected_group = str(expected_spec["group"] or "")
        group = _require_non_empty_string(raw_item.get("group"), label=f"{field_name}[{index}].group")
        if group != expected_group:
            raise ValueError(f"{field_name} channel {name} must use group {expected_group!r}, found {group!r}.")
        unit = raw_item.get("unit")
        expected_unit = expected_spec["unit"]
        if expected_unit is None:
            if unit is not None:
                raise ValueError(f"{field_name} channel {name} must use unit null.")
        elif str(unit or "").strip() != expected_unit:
            raise ValueError(
                f"{field_name} channel {name} must use unit {expected_unit!r}, found {unit!r}."
            )
        normalized.append({"name": name, "unit": expected_unit, "group": expected_group})
        seen_names.add(name)

    for required_name in required_names:
        if required_name not in seen_names:
            raise ValueError(f"{field_name} is missing required channel: {required_name}.")
    return normalized


def _normalize_root_electronics_index(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("Distribution bundle manifest electronics must be an object.")
    if "profiles" not in value:
        raise ValueError("Distribution bundle manifest electronics must contain profiles.")
    profiles_raw = value.get("profiles")
    if not isinstance(profiles_raw, list):
        raise ValueError("Distribution bundle manifest electronics.profiles must be a JSON list.")

    normalized_profiles: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for index, raw_item in enumerate(profiles_raw):
        if not isinstance(raw_item, dict):
            raise ValueError(f"Distribution bundle manifest electronics.profiles[{index}] must be an object.")
        profile_id = _require_non_empty_string(
            raw_item.get("id"),
            label=f"electronics.profiles[{index}].id",
        )
        if profile_id in seen_ids:
            raise ValueError(f"Distribution bundle manifest electronics contains duplicate profile id: {profile_id}.")
        normalized_profiles.append(
            {
                "id": profile_id,
                "label": _require_non_empty_string(
                    raw_item.get("label"),
                    label=f"electronics.profiles[{index}].label",
                ),
                "path": _require_non_empty_string(
                    raw_item.get("path"),
                    label=f"electronics.profiles[{index}].path",
                ),
                "engine": _require_non_empty_string(
                    raw_item.get("engine"),
                    label=f"electronics.profiles[{index}].engine",
                ),
                "method": _require_non_empty_string(
                    raw_item.get("method"),
                    label=f"electronics.profiles[{index}].method",
                ),
                "reference": _require_non_empty_string(
                    raw_item.get("reference"),
                    label=f"electronics.profiles[{index}].reference",
                ),
                "xc": _require_non_empty_string(
                    raw_item.get("xc"),
                    label=f"electronics.profiles[{index}].xc",
                ),
                "basis": _require_non_empty_string(
                    raw_item.get("basis"),
                    label=f"electronics.profiles[{index}].basis",
                ),
                "n_excited_states": int(raw_item.get("n_excited_states") or 0),
                "success_count": int(raw_item.get("success_count") or 0),
                "failed_count": int(raw_item.get("failed_count") or 0),
            }
        )
        seen_ids.add(profile_id)

    default_profile_id_raw = value.get("default_profile_id")
    default_profile_id = None if default_profile_id_raw is None else str(default_profile_id_raw).strip()
    if normalized_profiles:
        if not default_profile_id:
            raise ValueError("Distribution bundle manifest electronics.default_profile_id is required when profiles exist.")
        if default_profile_id not in seen_ids:
            raise ValueError(
                "Distribution bundle manifest electronics.default_profile_id must reference one of the declared profiles."
            )
    elif default_profile_id:
        raise ValueError("Distribution bundle manifest electronics.default_profile_id must be null when no profiles exist.")

    return {
        "default_profile_id": default_profile_id,
        "profiles": normalized_profiles,
    }


def _validate_root_manifest(manifest: dict[str, Any]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    missing = [field for field in _REQUIRED_ROOT_MANIFEST_FIELDS if field not in manifest]
    if missing:
        raise ValueError(f"Distribution bundle manifest is missing required fields: {', '.join(missing)}")
    for field in _ROOT_FORBIDDEN_FIELDS:
        if field in manifest:
            raise ValueError(f"Distribution bundle manifest field {field!r} is not supported in schema v4.")
    if int(manifest.get("schema_version") or 0) != DISTRIBUTION_BUNDLE_SCHEMA_VERSION:
        raise ValueError(
            f"Distribution bundle manifest schema_version must be {DISTRIBUTION_BUNDLE_SCHEMA_VERSION}."
        )
    _require_non_empty_string(manifest.get("kind"), label="Distribution bundle manifest kind")
    _require_non_empty_string(manifest.get("label"), label="Distribution bundle manifest label")
    _require_non_empty_string(manifest.get("source_name"), label="Distribution bundle manifest source_name")
    _require_non_empty_string(manifest.get("created_at_utc"), label="Distribution bundle manifest created_at_utc")
    sampling_channels = _normalize_channel_entries(
        manifest.get("sampling_channels"),
        allowed_specs=_CANONICAL_SAMPLING_CHANNEL_SPECS,
        required_names=_REQUIRED_SAMPLING_CHANNEL_NAMES,
        field_name="sampling_channels",
    )
    electronics = _normalize_root_electronics_index(manifest.get("electronics"))
    return sampling_channels, electronics


def _validate_profile_manifest(
    manifest: dict[str, Any],
    *,
    profile_id: str,
    expected_n_samples: int,
    expected_sample_ids: list[str],
    expected_topology_signature: str,
) -> dict[str, Any]:
    normalized_profile_id = _require_non_empty_string(
        manifest.get("profile_id"),
        label="Electronic profile manifest profile_id",
    )
    if normalized_profile_id != str(profile_id):
        raise ValueError(
            f"Electronic profile manifest profile_id mismatch: manifest={normalized_profile_id!r} expected={profile_id!r}."
        )
    label = _require_non_empty_string(manifest.get("label"), label="Electronic profile manifest label")
    engine = _require_non_empty_string(manifest.get("engine"), label="Electronic profile manifest engine")
    method = _require_non_empty_string(manifest.get("method"), label="Electronic profile manifest method")
    reference = _require_non_empty_string(
        manifest.get("reference"),
        label="Electronic profile manifest reference",
    )
    xc = _require_non_empty_string(manifest.get("xc"), label="Electronic profile manifest xc")
    basis = _require_non_empty_string(manifest.get("basis"), label="Electronic profile manifest basis")
    n_excited_states = int(manifest.get("n_excited_states") or 0)
    n_samples = int(manifest.get("n_samples") or -1)
    if n_samples != int(expected_n_samples):
        raise ValueError(
            f"Electronic profile manifest n_samples mismatch: manifest={n_samples}, expected={expected_n_samples}."
        )
    topology_signature = _require_non_empty_string(
        manifest.get("topology_signature"),
        label="Electronic profile manifest topology_signature",
    )
    if topology_signature != str(expected_topology_signature):
        raise ValueError(
            "Electronic profile manifest topology_signature does not match the bundle topology_signature."
        )
    sample_ids = _normalize_text_list(
        manifest.get("sample_ids"),
        expected_length=int(expected_n_samples),
        path="electronics/<profile>/manifest.json.sample_ids",
    )
    if sample_ids != [str(item) for item in expected_sample_ids]:
        raise ValueError("Electronic profile manifest sample_ids do not match the bundle sample_ids ordering.")
    channels = _normalize_channel_entries(
        manifest.get("channels"),
        allowed_specs=_CANONICAL_ELECTRONIC_CHANNEL_SPECS,
        required_names=_REQUIRED_ELECTRONIC_CHANNEL_NAMES,
        field_name="electronics/<profile>/manifest.json.channels",
    )
    return {
        "profile_id": normalized_profile_id,
        "label": label,
        "engine": engine,
        "method": method,
        "reference": reference,
        "xc": xc,
        "basis": basis,
        "n_excited_states": n_excited_states,
        "n_samples": n_samples,
        "topology_signature": topology_signature,
        "sample_ids": sample_ids,
        "channels": channels,
        "n_states": int(manifest.get("n_states") or 0),
        "n_transition": int(manifest.get("n_transition") or 0),
        "success_count": int(manifest.get("success_count") or 0),
        "failed_count": int(manifest.get("failed_count") or 0),
        "failed_samples": list(manifest.get("failed_samples") or []),
        "assembled_at_utc": _require_non_empty_string(
            manifest.get("assembled_at_utc"),
            label="Electronic profile manifest assembled_at_utc",
        ),
    }


def is_distribution_bundle_directory(path: Path) -> bool:
    candidate = Path(path)
    if not candidate.is_dir():
        return False
    return all((candidate / relative_path).is_file() for relative_path in _REQUIRED_BUNDLE_FILE_PATHS)


def _load_distribution_bundle_from_members(
    *,
    require_bytes: Callable[[str], bytes],
    optional_bytes: Callable[[str], bytes | None],
    source_name_fallback: str,
) -> DistributionBundle:
    manifest = _load_json(require_bytes("manifest.json"), expected_path="manifest.json")
    if not isinstance(manifest, dict):
        raise ValueError("Distribution bundle manifest.json must decode to an object.")
    sampling_channels, electronics_index = _validate_root_manifest(manifest)

    atom_numbers = np.asarray(
        _load_npy(require_bytes("sampling/atom_numbers.npy"), expected_path="sampling/atom_numbers.npy"),
        dtype=int,
    ).reshape(-1)
    atom_masses_amu = np.asarray(
        _load_npy(require_bytes("sampling/atom_masses_amu.npy"), expected_path="sampling/atom_masses_amu.npy"),
        dtype=float,
    ).reshape(-1)
    coords_bohr = np.asarray(
        _load_npy(require_bytes("sampling/coords_bohr.npy"), expected_path="sampling/coords_bohr.npy"),
        dtype=float,
    )
    if coords_bohr.ndim != 3 or coords_bohr.shape[2] != 3:
        raise ValueError(
            "sampling/coords_bohr.npy must have shape [n_samples, n_atoms, 3], "
            f"got {coords_bohr.shape}."
        )

    n_samples = int(coords_bohr.shape[0])
    n_atoms = int(coords_bohr.shape[1])
    if atom_numbers.shape != (n_atoms,):
        raise ValueError(
            "sampling/atom_numbers.npy must have shape [n_atoms] and align with coords_bohr; "
            f"got atom_numbers={atom_numbers.shape}, coords={coords_bohr.shape}."
        )
    if atom_masses_amu.shape != (n_atoms,):
        raise ValueError(
            "sampling/atom_masses_amu.npy must have shape [n_atoms] and align with coords_bohr; "
            f"got atom_masses_amu={atom_masses_amu.shape}, coords={coords_bohr.shape}."
        )
    if int(manifest.get("n_samples") or -1) != n_samples:
        raise ValueError(f"Manifest n_samples mismatch: manifest={manifest.get('n_samples')} data={n_samples}.")
    if int(manifest.get("n_atoms") or -1) != n_atoms:
        raise ValueError(f"Manifest n_atoms mismatch: manifest={manifest.get('n_atoms')} data={n_atoms}.")

    topology_signature = build_topology_signature(atom_numbers)
    manifest_signature = _require_non_empty_string(
        manifest.get("topology_signature"),
        label="Distribution bundle manifest topology_signature",
    )
    if manifest_signature != topology_signature:
        raise ValueError(
            "Manifest topology_signature does not match atom_numbers ordering: "
            f"manifest={manifest_signature} data={topology_signature}."
        )

    sample_ids = _normalize_text_list(
        _load_json(require_bytes("meta/sample_ids.json"), expected_path="meta/sample_ids.json"),
        expected_length=n_samples,
        path="meta/sample_ids.json",
    )

    actual_sampling_channel_names = set(_REQUIRED_SAMPLING_CHANNEL_NAMES)
    velocities_payload = optional_bytes("sampling/velocities_bohr_per_au_time.npy")
    velocities_bohr_per_au_time: np.ndarray | None = None
    if velocities_payload is not None:
        velocities_bohr_per_au_time = np.asarray(
            _load_npy(
                velocities_payload,
                expected_path="sampling/velocities_bohr_per_au_time.npy",
            ),
            dtype=float,
        )
        if velocities_bohr_per_au_time.shape != coords_bohr.shape:
            raise ValueError(
                "sampling/velocities_bohr_per_au_time.npy must align with coords_bohr: "
                f"velocities={velocities_bohr_per_au_time.shape}, coords={coords_bohr.shape}."
            )
        actual_sampling_channel_names.add("velocities_bohr_per_au_time")

    declared_sampling_channel_names = {str(item["name"]) for item in sampling_channels}
    if declared_sampling_channel_names != actual_sampling_channel_names:
        raise ValueError(
            "Distribution bundle manifest sampling_channels do not match the bundle payloads: "
            f"manifest={sorted(declared_sampling_channel_names)} data={sorted(actual_sampling_channel_names)}."
        )

    electronic_profiles: dict[str, ElectronicProfile] = {}
    for profile_index_item in electronics_index["profiles"]:
        profile_id = str(profile_index_item["id"])
        profile_path = str(profile_index_item["path"])
        expected_profile_root = f"electronics/{profile_id}"
        if profile_path != expected_profile_root:
            raise ValueError(
                f"Distribution bundle manifest electronics profile {profile_id} must use path {expected_profile_root!r}, "
                f"found {profile_path!r}."
            )
        profile_manifest_path = f"{profile_path}/manifest.json"
        profile_manifest_payload = _load_json(
            require_bytes(profile_manifest_path),
            expected_path=profile_manifest_path,
        )
        if not isinstance(profile_manifest_payload, dict):
            raise ValueError(f"{profile_manifest_path} must decode to an object.")
        normalized_profile_manifest = _validate_profile_manifest(
            profile_manifest_payload,
            profile_id=profile_id,
            expected_n_samples=n_samples,
            expected_sample_ids=sample_ids,
            expected_topology_signature=topology_signature,
        )

        for key in ("label", "engine", "method", "reference", "xc", "basis", "n_excited_states"):
            if normalized_profile_manifest[key] != profile_index_item[key]:
                raise ValueError(
                    f"Distribution bundle manifest electronics profile {profile_id} field {key!r} does not match "
                    "the profile manifest."
                )
        for key in ("success_count", "failed_count"):
            if int(normalized_profile_manifest[key]) != int(profile_index_item[key]):
                raise ValueError(
                    f"Distribution bundle manifest electronics profile {profile_id} field {key!r} does not match "
                    "the profile manifest."
                )

        state_energy_hartree = np.asarray(
            _load_npy(
                require_bytes(f"{profile_path}/state_energy_hartree.npy"),
                expected_path=f"{profile_path}/state_energy_hartree.npy",
            ),
            dtype=float,
        )
        if state_energy_hartree.ndim != 2 or state_energy_hartree.shape[0] != n_samples:
            raise ValueError(
                f"{profile_path}/state_energy_hartree.npy must have shape [n_samples, n_states], "
                f"got {state_energy_hartree.shape}."
            )

        transition_pairs = np.asarray(
            _load_npy(
                require_bytes(f"{profile_path}/transition_pairs.npy"),
                expected_path=f"{profile_path}/transition_pairs.npy",
            ),
            dtype=int,
        )
        if transition_pairs.ndim != 2 or transition_pairs.shape[1] != 2:
            raise ValueError(
                f"{profile_path}/transition_pairs.npy must have shape [n_transition, 2], "
                f"got {transition_pairs.shape}."
            )
        if transition_pairs.size > 0:
            if int(np.min(transition_pairs)) < 0:
                raise ValueError(f"{profile_path}/transition_pairs.npy must contain non-negative state indices.")
            if int(np.max(transition_pairs)) >= int(state_energy_hartree.shape[1]):
                raise ValueError(
                    f"{profile_path}/transition_pairs.npy contains a state index outside the state_energy_hartree range."
                )

        transition_dipole_au = np.asarray(
            _load_npy(
                require_bytes(f"{profile_path}/transition_dipole_au.npy"),
                expected_path=f"{profile_path}/transition_dipole_au.npy",
            ),
            dtype=float,
        )
        expected_transition_dipole_shape = (n_samples, int(transition_pairs.shape[0]), 3)
        if transition_dipole_au.shape != expected_transition_dipole_shape:
            raise ValueError(
                f"{profile_path}/transition_dipole_au.npy must have shape {expected_transition_dipole_shape}, "
                f"got {transition_dipole_au.shape}."
            )

        transition_intensity = np.asarray(
            _load_npy(
                require_bytes(f"{profile_path}/transition_intensity.npy"),
                expected_path=f"{profile_path}/transition_intensity.npy",
            ),
            dtype=float,
        )
        expected_transition_intensity_shape = (n_samples, int(transition_pairs.shape[0]))
        if transition_intensity.shape != expected_transition_intensity_shape:
            raise ValueError(
                f"{profile_path}/transition_intensity.npy must have shape {expected_transition_intensity_shape}, "
                f"got {transition_intensity.shape}."
            )

        if normalized_profile_manifest["n_states"] != int(state_energy_hartree.shape[1]):
            raise ValueError(f"{profile_manifest_path} n_states does not match state_energy_hartree.npy.")
        if normalized_profile_manifest["n_transition"] != int(transition_pairs.shape[0]):
            raise ValueError(f"{profile_manifest_path} n_transition does not match transition_pairs.npy.")

        profile_manifest_copy = dict(profile_manifest_payload)
        profile_manifest_copy["channels"] = normalized_profile_manifest["channels"]
        electronic_profiles[profile_id] = ElectronicProfile(
            profile_id=profile_id,
            label=str(normalized_profile_manifest["label"]),
            engine=str(normalized_profile_manifest["engine"]),
            method=str(normalized_profile_manifest["method"]),
            reference=str(normalized_profile_manifest["reference"]),
            xc=str(normalized_profile_manifest["xc"]),
            basis=str(normalized_profile_manifest["basis"]),
            n_excited_states=int(normalized_profile_manifest["n_excited_states"]),
            state_energy_hartree=np.asarray(state_energy_hartree, dtype=float),
            transition_pairs=np.asarray(transition_pairs, dtype=int),
            transition_dipole_au=np.asarray(transition_dipole_au, dtype=float),
            transition_intensity=np.asarray(transition_intensity, dtype=float),
            success_count=int(normalized_profile_manifest["success_count"]),
            failed_count=int(normalized_profile_manifest["failed_count"]),
            failed_samples=[dict(item) for item in normalized_profile_manifest["failed_samples"]],
            manifest=profile_manifest_copy,
        )

    manifest_copy = dict(manifest)
    manifest_copy["sampling_channels"] = sampling_channels
    manifest_copy["electronics"] = electronics_index
    return DistributionBundle(
        label=_require_non_empty_string(manifest.get("label"), label="Distribution bundle manifest label"),
        source_name=_require_non_empty_string(
            manifest.get("source_name") or source_name_fallback,
            label="Distribution bundle manifest source_name",
        ),
        created_at_utc=_require_non_empty_string(
            manifest.get("created_at_utc"),
            label="Distribution bundle manifest created_at_utc",
        ),
        atom_numbers=np.asarray(atom_numbers, dtype=int),
        atom_masses_amu=np.asarray(atom_masses_amu, dtype=float),
        coords_bohr=np.asarray(coords_bohr, dtype=float),
        topology_signature=topology_signature,
        manifest=manifest_copy,
        sample_ids=sample_ids,
        electronic_profiles=electronic_profiles,
        default_profile_id=electronics_index["default_profile_id"],
        velocities_bohr_per_au_time=(
            None if velocities_bohr_per_au_time is None else np.asarray(velocities_bohr_per_au_time, dtype=float)
        ),
    )


def load_distribution_bundle(bundle_bytes: bytes, *, filename: str = "") -> DistributionBundle:
    if not isinstance(bundle_bytes, (bytes, bytearray)) or len(bundle_bytes) <= 0:
        raise ValueError("Distribution bundle upload is empty.")
    try:
        archive = tarfile.open(fileobj=io.BytesIO(bytes(bundle_bytes)), mode="r:gz")
    except Exception as exc:  # noqa: BLE001
        raise ValueError(f"Failed to open distribution bundle {filename or '(upload)'}: {exc}") from exc

    with archive:
        return _load_distribution_bundle_from_members(
            require_bytes=lambda relative_path: _require_member_bytes(archive, relative_path),
            optional_bytes=lambda relative_path: _optional_member_bytes(archive, relative_path),
            source_name_fallback=(filename or "uploaded_distribution.tar.gz"),
        )


def load_distribution_bundle_from_directory(bundle_dir: Path) -> DistributionBundle:
    bundle_root = Path(bundle_dir).resolve()
    if bundle_root.is_file():
        raise ValueError(f"Distribution bundle path must be a directory root, not a file: {bundle_root}")
    if not bundle_root.is_dir():
        raise ValueError(f"Distribution bundle path is not a directory: {bundle_root}")
    return _load_distribution_bundle_from_members(
        require_bytes=lambda relative_path: _read_directory_member_bytes(bundle_root, relative_path, required=True),
        optional_bytes=lambda relative_path: _read_directory_member_bytes(bundle_root, relative_path, required=False),
        source_name_fallback=bundle_root.name,
    )


def _compute_bond_distribution(coords_ang: np.ndarray, i: int, j: int) -> np.ndarray:
    return np.linalg.norm(coords_ang[:, i, :] - coords_ang[:, j, :], axis=1)


def _compute_angle_distribution(coords_ang: np.ndarray, i: int, j: int, k: int) -> np.ndarray:
    v1 = coords_ang[:, i, :] - coords_ang[:, j, :]
    v2 = coords_ang[:, k, :] - coords_ang[:, j, :]
    norm1 = np.linalg.norm(v1, axis=1)
    norm2 = np.linalg.norm(v2, axis=1)
    norm1[norm1 == 0] = 1.0
    norm2[norm2 == 0] = 1.0
    cosang = np.sum(v1 * v2, axis=1) / (norm1 * norm2)
    return np.degrees(np.arccos(np.clip(cosang, -1.0, 1.0)))


def _compute_dihedral_distribution(coords_ang: np.ndarray, i: int, j: int, k: int, l: int) -> np.ndarray:
    p0 = coords_ang[:, i, :]
    p1 = coords_ang[:, j, :]
    p2 = coords_ang[:, k, :]
    p3 = coords_ang[:, l, :]
    b0 = p1 - p0
    b1 = p2 - p1
    b2 = p3 - p2
    b1_norm = np.linalg.norm(b1, axis=1, keepdims=True)
    b1_norm[b1_norm == 0] = 1.0
    b1_unit = b1 / b1_norm
    v = b0 - np.sum(b0 * b1_unit, axis=1, keepdims=True) * b1_unit
    w = b2 - np.sum(b2 * b1_unit, axis=1, keepdims=True) * b1_unit
    return np.degrees(np.arctan2(np.sum(np.cross(b1_unit, v) * w, axis=1), np.sum(v * w, axis=1)))


def compute_geometry_distribution(
    bundle: DistributionBundle,
    *,
    measurement_kind: str,
    atom_indices: list[int],
) -> dict[str, Any]:
    kind = str(measurement_kind).strip().lower()
    atom_indices_int = [int(value) for value in atom_indices]
    for atom_index in atom_indices_int:
        if atom_index < 0 or atom_index >= int(bundle.n_atoms):
            raise ValueError(f"Atom index out of bounds: {atom_index} (valid range 0..{bundle.n_atoms - 1}).")

    coords_ang = np.asarray(bundle.coords_bohr * float(BOHR_TO_ANG), dtype=float)
    if kind == "bond":
        if len(atom_indices_int) != 2:
            raise ValueError("Bond measurement requires exactly 2 atom indices.")
        values = _compute_bond_distribution(coords_ang, atom_indices_int[0], atom_indices_int[1])
        unit = "Angstrom"
    elif kind == "angle":
        if len(atom_indices_int) != 3:
            raise ValueError("Angle measurement requires exactly 3 atom indices.")
        values = _compute_angle_distribution(coords_ang, atom_indices_int[0], atom_indices_int[1], atom_indices_int[2])
        unit = "deg"
    elif kind == "dihedral":
        if len(atom_indices_int) != 4:
            raise ValueError("Dihedral measurement requires exactly 4 atom indices.")
        values = _compute_dihedral_distribution(
            coords_ang,
            atom_indices_int[0],
            atom_indices_int[1],
            atom_indices_int[2],
            atom_indices_int[3],
        )
        unit = "deg"
    else:
        raise ValueError(f"Unsupported measurement_kind: {measurement_kind}")

    finite_values = np.asarray(values[np.isfinite(values)], dtype=float).reshape(-1)
    if finite_values.size <= 0:
        raise ValueError("Measurement values are empty or non-finite for this distribution.")
    return {
        "measurement_kind": kind,
        "atom_indices": atom_indices_int,
        "unit": unit,
        "values": finite_values.astype(float).tolist(),
        "sample_count": int(finite_values.shape[0]),
        "min": float(np.min(finite_values)),
        "max": float(np.max(finite_values)),
        "mean": float(np.mean(finite_values)),
        "std": float(np.std(finite_values)),
    }


def _compute_profile_excitation_payload(
    profile: ElectronicProfile,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    excitation_energy_ev = (
        profile.state_energy_hartree[:, profile.transition_pairs[:, 1]]
        - profile.state_energy_hartree[:, profile.transition_pairs[:, 0]]
    ) * float(HARTREE_TO_EV)
    return (
        np.asarray(excitation_energy_ev, dtype=float),
        np.asarray(profile.transition_pairs, dtype=int),
        np.asarray(profile.transition_intensity, dtype=float),
    )


def _build_valid_transition_sample_mask(
    *,
    excitation_energy_ev: np.ndarray,
    transition_intensity: np.ndarray,
) -> np.ndarray:
    return (
        np.isfinite(excitation_energy_ev)
        & np.isfinite(transition_intensity)
        & (excitation_energy_ev > 0.0)
        & (transition_intensity >= 0.0)
    )


def _build_transition_index_map(transition_pairs: np.ndarray) -> dict[tuple[int, int], np.ndarray]:
    grouped_indices: dict[tuple[int, int], list[int]] = {}
    for index, raw_pair in enumerate(np.asarray(transition_pairs, dtype=int).tolist()):
        pair = (int(raw_pair[0]), int(raw_pair[1]))
        grouped_indices.setdefault(pair, []).append(int(index))
    return {
        pair: np.asarray(indices, dtype=int)
        for pair, indices in sorted(grouped_indices.items(), key=lambda item: item[0])
    }


def collect_absorption_excitation_energies_ev(profile: ElectronicProfile) -> np.ndarray:
    excitation_energy_ev, _, transition_intensity = _compute_profile_excitation_payload(profile)
    valid_mask = _build_valid_transition_sample_mask(
        excitation_energy_ev=excitation_energy_ev,
        transition_intensity=transition_intensity,
    )
    return np.asarray(excitation_energy_ev[valid_mask], dtype=float).reshape(-1)


def collect_valid_absorption_transition_pairs(profile: ElectronicProfile) -> list[tuple[int, int]]:
    excitation_energy_ev, transition_pairs, transition_intensity = _compute_profile_excitation_payload(profile)
    valid_mask = _build_valid_transition_sample_mask(
        excitation_energy_ev=excitation_energy_ev,
        transition_intensity=transition_intensity,
    )
    pair_index_map = _build_transition_index_map(transition_pairs)
    valid_pairs: list[tuple[int, int]] = []
    for pair, transition_indices in pair_index_map.items():
        if np.any(valid_mask[:, transition_indices]):
            valid_pairs.append(pair)
    return valid_pairs


def _lorentzian_lineshape(diff_ev: np.ndarray, *, delta_ev: float) -> np.ndarray:
    delta = float(delta_ev)
    return (delta / np.pi) / (np.square(diff_ev) + delta * delta)


def _compute_absorption_transition_curve(
    *,
    x_energy_ev: np.ndarray,
    excitation_energy_ev: np.ndarray,
    transition_intensity: np.ndarray,
    delta_ev: float,
) -> np.ndarray:
    if excitation_energy_ev.size <= 0:
        return np.zeros_like(x_energy_ev, dtype=float)
    diff_ev = np.asarray(x_energy_ev, dtype=float).reshape(1, -1) - np.asarray(excitation_energy_ev, dtype=float).reshape(-1, 1)
    lineshape = _lorentzian_lineshape(diff_ev, delta_ev=float(delta_ev))
    weighted_curve = (
        np.asarray(excitation_energy_ev, dtype=float).reshape(-1, 1)
        * np.asarray(transition_intensity, dtype=float).reshape(-1, 1)
        * lineshape
    )
    mean_curve = np.mean(weighted_curve, axis=0)
    safe_x_energy_ev = np.maximum(np.asarray(x_energy_ev, dtype=float), 1.0e-12)
    spectrum_curve = np.asarray(mean_curve / safe_x_energy_ev, dtype=float)
    return np.where(np.isfinite(spectrum_curve), spectrum_curve, 0.0)


def _compute_absorption_curve_for_transition_indices(
    *,
    x_energy_ev: np.ndarray,
    excitation_energy_ev: np.ndarray,
    transition_intensity: np.ndarray,
    transition_indices: np.ndarray,
    delta_ev: float,
) -> dict[str, Any]:
    total_curve = np.zeros_like(np.asarray(x_energy_ev, dtype=float), dtype=float)
    contributing_transition_count = 0
    for transition_index in np.asarray(transition_indices, dtype=int).tolist():
        transition_excitation_energy_ev = np.asarray(excitation_energy_ev[:, transition_index], dtype=float).reshape(-1)
        transition_strength = np.asarray(transition_intensity[:, transition_index], dtype=float).reshape(-1)
        valid_mask = _build_valid_transition_sample_mask(
            excitation_energy_ev=transition_excitation_energy_ev,
            transition_intensity=transition_strength,
        )
        if not np.any(valid_mask):
            continue
        total_curve += _compute_absorption_transition_curve(
            x_energy_ev=np.asarray(x_energy_ev, dtype=float),
            excitation_energy_ev=np.asarray(transition_excitation_energy_ev[valid_mask], dtype=float),
            transition_intensity=np.asarray(transition_strength[valid_mask], dtype=float),
            delta_ev=float(delta_ev),
        )
        contributing_transition_count += 1
    if contributing_transition_count <= 0:
        raise ValueError(
            "No valid transitions remain after filtering for finite positive excitation energies "
            "and finite non-negative oscillator strengths."
        )
    return {
        "curve": np.where(np.isfinite(total_curve), total_curve, 0.0),
        "contributing_transition_count": int(contributing_transition_count),
    }


def compute_absorption_spectrum(
    profile: ElectronicProfile,
    *,
    x_energy_ev: np.ndarray,
    delta_ev: float,
    pair_overlays: list[tuple[int, int]] | tuple[tuple[int, int], ...] | None = None,
) -> dict[str, Any]:
    excitation_energy_ev, transition_pairs, transition_intensity = _compute_profile_excitation_payload(profile)
    pair_index_map = _build_transition_index_map(transition_pairs)
    total_payload = _compute_absorption_curve_for_transition_indices(
        x_energy_ev=np.asarray(x_energy_ev, dtype=float),
        excitation_energy_ev=excitation_energy_ev,
        transition_intensity=transition_intensity,
        transition_indices=np.arange(int(transition_pairs.shape[0]), dtype=int),
        delta_ev=float(delta_ev),
    )
    total_curve = np.asarray(total_payload["curve"], dtype=float)
    peak_value = float(np.max(total_curve)) if total_curve.size > 0 else 0.0
    if peak_value > 0.0 and np.isfinite(peak_value):
        total_y_normalized = np.asarray(total_curve / peak_value, dtype=float)
    else:
        total_y_normalized = np.zeros_like(total_curve, dtype=float)

    pair_curves: list[dict[str, Any]] = []
    for raw_pair in list(pair_overlays or []):
        pair = (int(raw_pair[0]), int(raw_pair[1]))
        transition_indices = pair_index_map.get(pair)
        if transition_indices is None or transition_indices.size <= 0:
            raise ValueError(
                f"Requested transition pair {pair[0]}->{pair[1]} is not present in electronic profile {profile.profile_id}."
            )
        pair_payload = _compute_absorption_curve_for_transition_indices(
            x_energy_ev=np.asarray(x_energy_ev, dtype=float),
            excitation_energy_ev=excitation_energy_ev,
            transition_intensity=transition_intensity,
            transition_indices=transition_indices,
            delta_ev=float(delta_ev),
        )
        pair_curve = np.asarray(pair_payload["curve"], dtype=float)
        if peak_value > 0.0 and np.isfinite(peak_value):
            pair_y_normalized = np.asarray(pair_curve / peak_value, dtype=float)
        else:
            pair_y_normalized = np.zeros_like(pair_curve, dtype=float)
        pair_curves.append(
            {
                "pair": [int(pair[0]), int(pair[1])],
                "y_normalized": pair_y_normalized.astype(float).tolist(),
                "contributing_transition_count": int(pair_payload["contributing_transition_count"]),
            }
        )
    return {
        "total_y_normalized": total_y_normalized.astype(float).tolist(),
        "pair_curves": pair_curves,
        "contributing_transition_count": int(total_payload["contributing_transition_count"]),
    }
