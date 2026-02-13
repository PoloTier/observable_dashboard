from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Literal

import numpy as np

BOHR_TO_ANGSTROM = 0.529177210903
STATE_COEFF_KEY = "_.0.record.c"
TensorKind = Literal["scalar", "matrix", "tensor4", "complex_matrix"]
Transformer = Callable[[Any], np.ndarray]


def flatten_time_array(raw: Any) -> np.ndarray:
    arr = np.asarray(raw)
    if arr.ndim == 0:
        return np.array([float(arr)], dtype=float)
    if arr.ndim == 1:
        return arr.astype(float)
    return arr.reshape(arr.shape[0], -1)[:, 0].astype(float)


def reshape_coords(raw: Any) -> np.ndarray:
    arr = np.asarray(raw)
    if arr.ndim == 1:
        if arr.size % 3 != 0:
            raise ValueError(f"Coordinate vector length {arr.size} is not divisible by 3")
        arr = arr.reshape(1, -1)
    else:
        arr = arr.reshape(arr.shape[0], -1)

    if arr.shape[1] % 3 != 0:
        raise ValueError(f"Coordinate width {arr.shape[1]} is not divisible by 3")

    n_atoms = arr.shape[1] // 3
    return arr.reshape(arr.shape[0], n_atoms, 3).astype(float)


def reshape_scalar_series(raw: Any) -> np.ndarray:
    arr = np.asarray(raw)
    if arr.ndim == 0:
        return np.array([float(arr)], dtype=float)
    if arr.ndim == 1:
        return arr.astype(float)
    return arr.reshape(arr.shape[0], -1)[:, 0].astype(float)


def reshape_complex_series(raw: Any) -> np.ndarray:
    arr = np.asarray(raw)
    if arr.size == 0:
        return np.empty((0, 0), dtype=np.complex128)
    if arr.ndim == 0:
        return np.array([[np.complex128(arr)]], dtype=np.complex128)
    return arr.reshape(arr.shape[0], -1).astype(np.complex128)


def reshape_eig(raw: Any) -> np.ndarray:
    arr = np.asarray(raw)
    if arr.ndim == 1:
        return arr.reshape(-1, 1).astype(float)
    return arr.reshape(arr.shape[0], -1).astype(float)


def reshape_nac(raw: Any) -> np.ndarray:
    arr = np.asarray(raw)
    if arr.ndim < 4:
        raise ValueError(f"NAC array needs >=4 dimensions, got {arr.shape}")
    return arr.reshape(arr.shape[0], -1, arr.shape[-2], arr.shape[-1]).astype(float)


@dataclass(slots=True)
class FieldSpec:
    name: str
    source_key_name: str
    tensor_kind: TensorKind
    transformer: Transformer
    required: bool = False
    empty_warn: str | None = None


@dataclass(slots=True)
class MetaAccumulator:
    n_atoms_max: int = 0
    n_states_max: int = 0
    state_component_count: int = 0


@dataclass(slots=True)
class TrajectoryBuilder:
    traj_id: Any
    traj_data: Dict[str, Any]
    key_map: Dict[str, str]
    drop_zero_frames: bool
    record: Dict[str, Any] = field(default_factory=dict)
    raw_time: np.ndarray = field(default_factory=lambda: np.empty((0,), dtype=float))
    valid_mask: np.ndarray = field(default_factory=lambda: np.empty((0,), dtype=bool))
    base_len: int = 0
    is_valid: bool = True
    eig_masked: np.ndarray | None = None

    def _get_raw(self, source_key_name: str) -> Any:
        actual_key = self.key_map.get(source_key_name)
        if not actual_key:
            return None
        return self.traj_data.get(actual_key)

    def _validate_tensor_kind(self, spec: FieldSpec, values: np.ndarray) -> None:
        if spec.tensor_kind == "scalar" and values.ndim != 1:
            raise ValueError(f"Expected scalar series [T], got shape={values.shape}")
        if spec.tensor_kind in {"matrix", "complex_matrix"} and values.ndim != 2:
            raise ValueError(f"Expected matrix series [T, C], got shape={values.shape}")
        if spec.tensor_kind == "tensor4" and values.ndim < 4:
            raise ValueError(f"Expected tensor4 series [T, C, S, S], got shape={values.shape}")

    def _align_timeseries(self, values: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        if values.ndim == 0:
            values = values.reshape(1)
        series_len = min(self.base_len, int(values.shape[0]))
        values = values[:series_len]
        times = self.raw_time[:series_len]
        local_mask = self.valid_mask[:series_len]
        return times[local_mask], values[local_mask]

    def prepare_base(self) -> None:
        time_key = self.key_map["time_key"]
        coord_key = self.key_map["coord_key"]
        if time_key not in self.traj_data or coord_key not in self.traj_data:
            print(f"[WARN] Skip traj {self.traj_id}: missing '{time_key}' or '{coord_key}'")
            self.is_valid = False
            return

        try:
            raw_time = flatten_time_array(self.traj_data[time_key])
            raw_coords = reshape_coords(self.traj_data[coord_key])
            raw_coords = raw_coords * BOHR_TO_ANGSTROM
        except Exception as exc:
            print(f"[WARN] Skip traj {self.traj_id}: failed to parse time/coords ({exc})")
            self.is_valid = False
            return

        base_len = min(len(raw_time), len(raw_coords))
        if base_len == 0:
            print(f"[WARN] Skip traj {self.traj_id}: zero frame length")
            self.is_valid = False
            return

        raw_time = raw_time[:base_len]
        raw_coords = raw_coords[:base_len]

        if self.drop_zero_frames:
            valid_mask = ~np.all(np.isclose(raw_coords, 0.0, atol=1e-12), axis=(1, 2))
        else:
            valid_mask = np.ones(base_len, dtype=bool)

        if not np.any(valid_mask):
            print(f"[WARN] Skip traj {self.traj_id}: all frames filtered out")
            self.is_valid = False
            return

        self.raw_time = raw_time
        self.valid_mask = valid_mask
        self.base_len = base_len

        coords_vals = raw_coords[valid_mask]
        self.record["time"] = raw_time[valid_mask].tolist()
        self.record["coords"] = coords_vals.tolist()
        self.record["n_atoms"] = int(coords_vals.shape[1])

    def process_atom_numbers(self) -> None:
        if not self.is_valid:
            return
        atom_numbers = _extract_atom_numbers(
            traj_data=self.traj_data,
            n_atoms=int(self.record["n_atoms"]),
            traj_id=self.traj_id,
        )
        self.record["atom_numbers"] = atom_numbers.tolist()

    def process_field(self, spec: FieldSpec, meta: MetaAccumulator) -> None:
        if not self.is_valid:
            return

        raw_value = self._get_raw(spec.source_key_name)
        if raw_value is None:
            if spec.required:
                print(f"[WARN] traj {self.traj_id}: missing required {spec.source_key_name}")
                self.is_valid = False
            return

        warn_name = "Etot" if spec.name == "etot" else spec.name
        try:
            values = spec.transformer(raw_value)
            self._validate_tensor_kind(spec, values)
        except Exception as exc:
            print(f"[WARN] traj {self.traj_id}: failed to parse {warn_name} ({exc})")
            return

        if spec.name == "etot":
            self._process_etot(values, spec)
            return
        if spec.name == "eig":
            self._process_eig(values, meta)
            return
        if spec.name == "nac":
            self._process_nac(values)
            return

    def _process_etot(self, etot: np.ndarray, spec: FieldSpec) -> None:
        if etot.size == 0:
            if spec.empty_warn:
                print(f"[WARN] traj {self.traj_id}: {spec.empty_warn}")
            return

        etot_ref0 = float(etot[0])
        etot_rel = etot - etot_ref0
        etot_time, etot_val = self._align_timeseries(etot_rel)
        self.record["etot_time"] = etot_time.tolist()
        self.record["etot"] = etot_val.tolist()

    def _process_eig(self, eig: np.ndarray, meta: MetaAccumulator) -> None:
        eig_time, eig_val = self._align_timeseries(eig)
        self.record["eig_time"] = eig_time.tolist()
        self.record["eig"] = eig_val.tolist()
        self.eig_masked = eig_val

        if eig_val.size > 0:
            meta.n_states_max = max(meta.n_states_max, int(eig_val.shape[1]))

    def _process_nac(self, nac: np.ndarray) -> None:
        nac_time, nac_val = self._align_timeseries(nac)
        if nac_val.size == 0:
            print(f"[WARN] traj {self.traj_id}: empty NAC series, skip")
            return
        if nac_val.ndim < 4:
            print(f"[WARN] traj {self.traj_id}: NAC array has invalid ndim={nac_val.ndim}, skip")
            return

        n_components = int(nac_val.shape[1])
        n_states_i = int(nac_val.shape[-2])
        n_states_j = int(nac_val.shape[-1])
        n_states = min(n_states_i, n_states_j)

        self.record["nac_components"] = nac_val.tolist()
        self.record["nac_component_count"] = n_components
        self.record["nac_state_count"] = n_states

        if n_states >= 2:
            self.record["nac_time"] = nac_time.tolist()
            nac_norm = np.sqrt(np.sum(nac_val[:, :, 0, 1] ** 2, axis=1))
            self.record["nac_norm"] = nac_norm.tolist()
        else:
            print(f"[WARN] traj {self.traj_id}: NAC has <2 states, skip nac_norm")

        self.compute_de_nac(nac_time, nac_val)

    def process_state_coeff(self, meta: MetaAccumulator) -> None:
        if not self.is_valid:
            return

        if STATE_COEFF_KEY not in self.traj_data:
            return

        try:
            coeff = reshape_complex_series(self.traj_data[STATE_COEFF_KEY])
            if coeff.size == 0:
                print(f"[WARN] traj {self.traj_id}: empty state coefficient series, skip")
                return

            prob = np.abs(coeff) ** 2
            c_prob_time, c_prob_val = self._align_timeseries(prob)
            self.record["c_prob_time"] = c_prob_time.tolist()
            self.record["c_prob"] = c_prob_val.tolist()

            state_idx = np.argmax(prob, axis=1).astype(int)
            state_time, state_val = self._align_timeseries(state_idx)
            self.record["state_time"] = state_time.tolist()
            self.record["state"] = state_val.tolist()

            if prob.ndim == 2:
                meta.state_component_count = max(meta.state_component_count, int(prob.shape[1]))
        except Exception as exc:
            print(f"[WARN] traj {self.traj_id}: failed to parse state from '{STATE_COEFF_KEY}' ({exc})")

    def compute_de_nac(self, nac_time: np.ndarray, nac_val: np.ndarray) -> None:
        if self.eig_masked is None or self.eig_masked.size == 0:
            print(f"[WARN] traj {self.traj_id}: eig is unavailable, skip (E_j-E_i)*NAC_ij")
            return
        if self.eig_masked.ndim != 2:
            print(f"[WARN] traj {self.traj_id}: eig has invalid ndim={self.eig_masked.ndim}, skip (E_j-E_i)*NAC_ij")
            return

        n_states = min(int(nac_val.shape[-2]), int(nac_val.shape[-1]))
        eig_state_count = int(self.eig_masked.shape[1])
        de_state_count = min(n_states, eig_state_count)
        if de_state_count < 2:
            print(f"[WARN] traj {self.traj_id}: eig/NAC common state count <2, skip (E_j-E_i)*NAC_ij")
            return

        de_frame_count = int(min(nac_val.shape[0], self.eig_masked.shape[0], nac_time.shape[0]))
        if de_frame_count <= 0:
            print(f"[WARN] traj {self.traj_id}: no overlapping frames for eig and NAC, skip (E_j-E_i)*NAC_ij")
            return

        nac_for_de = nac_val[:de_frame_count, :, :de_state_count, :de_state_count]
        eig_for_de = self.eig_masked[:de_frame_count, :de_state_count]
        delta_e = eig_for_de[:, None, :] - eig_for_de[:, :, None]
        de_nac = nac_for_de * delta_e[:, None, :, :]

        self.record["de_nac_time"] = nac_time[:de_frame_count].tolist()
        self.record["de_nac_components"] = de_nac.tolist()
        self.record["de_nac_component_count"] = int(nac_val.shape[1])
        self.record["de_nac_state_count"] = de_state_count
        de_nac_norm = np.sqrt(np.sum(de_nac[:, :, 0, 1] ** 2, axis=1))
        self.record["de_nac_norm"] = de_nac_norm.tolist()

    def finalize_record(self) -> Dict[str, Any]:
        return self.record


def _extract_atom_numbers(traj_data: Dict[str, Any], n_atoms: int, traj_id: Any) -> np.ndarray:
    fallback = np.full(n_atoms, 6, dtype=int)

    raw_atoms = traj_data.get("model.atoms")
    if raw_atoms is None:
        print(f"[WARN] traj {traj_id}: missing 'model.atoms', fallback to carbon")
        return fallback

    try:
        atoms = np.asarray(raw_atoms).reshape(-1).astype(int)
    except Exception as exc:
        print(f"[WARN] traj {traj_id}: failed to parse model.atoms ({exc}), fallback to carbon")
        return fallback

    if atoms.size < n_atoms:
        print(f"[WARN] traj {traj_id}: model.atoms length {atoms.size} < n_atoms {n_atoms}, fallback to carbon")
        return fallback

    atom_numbers = atoms[:n_atoms].copy()
    invalid_mask = atom_numbers <= 0
    if np.any(invalid_mask):
        invalid_count = int(np.count_nonzero(invalid_mask))
        print(f"[WARN] traj {traj_id}: {invalid_count} non-positive atom numbers in model.atoms, replaced with C")
        atom_numbers[invalid_mask] = 6

    return atom_numbers


def prepare_dataset(
    master_dataset: Dict[str, Any],
    time_key: str,
    coord_key: str,
    etot_key: str,
    eig_key: str,
    nac_key: str,
    drop_zero_frames: bool,
) -> Dict[str, Any]:
    trajectories: Dict[str, Any] = {}
    meta_acc = MetaAccumulator()

    sorted_ids = sorted(master_dataset.keys(), key=lambda x: int(x) if str(x).isdigit() else str(x))
    key_map = {
        "time_key": time_key,
        "coord_key": coord_key,
        "etot_key": etot_key,
        "eig_key": eig_key,
        "nac_key": nac_key,
    }
    specs = [
        FieldSpec(
            name="etot",
            source_key_name="etot_key",
            tensor_kind="scalar",
            transformer=reshape_scalar_series,
            empty_warn="empty Etot series, skip",
        ),
        FieldSpec(
            name="eig",
            source_key_name="eig_key",
            tensor_kind="matrix",
            transformer=reshape_eig,
        ),
        FieldSpec(
            name="nac",
            source_key_name="nac_key",
            tensor_kind="tensor4",
            transformer=reshape_nac,
        ),
    ]

    for traj_id in sorted_ids:
        builder = TrajectoryBuilder(
            traj_id=traj_id,
            traj_data=master_dataset[traj_id],
            key_map=key_map,
            drop_zero_frames=drop_zero_frames,
        )
        builder.prepare_base()
        if not builder.is_valid:
            continue

        builder.process_atom_numbers()
        meta_acc.n_atoms_max = max(meta_acc.n_atoms_max, int(builder.record["n_atoms"]))

        for spec in specs:
            builder.process_field(spec, meta_acc)

        builder.process_state_coeff(meta_acc)
        trajectories[str(traj_id)] = builder.finalize_record()

    traj_ids = sorted(trajectories.keys(), key=lambda x: int(x) if str(x).isdigit() else str(x))

    return {
        "meta": {
            "traj_ids": traj_ids,
            "n_atoms": meta_acc.n_atoms_max,
            "n_states": meta_acc.n_states_max,
            "time_unit": "fs",
            "length_unit": "angstrom",
            "coord_unit": "angstrom",
            "etot_unit": "hartree",
            "etot_reference": "raw_frame0",
            "state_definition": "argmax(|c|^2)",
            "state_source_key": STATE_COEFF_KEY,
            "state_index_base": 0,
            "state_component_count": meta_acc.state_component_count,
        },
        "trajectories": trajectories,
    }
