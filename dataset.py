from typing import Any, Dict, Tuple

import numpy as np

BOHR_TO_ANGSTROM = 0.529177210903
STATE_COEFF_KEY = "_.0.record.c"


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


def _mask_series_1d(raw_time: np.ndarray, base_len: int, valid_mask: np.ndarray, values: np.ndarray) -> Tuple[np.ndarray, np.ndarray]:
    series_len = min(base_len, len(values))
    values = values[:series_len]
    times = raw_time[:series_len]
    local_mask = valid_mask[:series_len]
    return times[local_mask], values[local_mask]


def _mask_series_2d(raw_time: np.ndarray, base_len: int, valid_mask: np.ndarray, values: np.ndarray) -> Tuple[np.ndarray, np.ndarray]:
    series_len = min(base_len, len(values))
    values = values[:series_len]
    times = raw_time[:series_len]
    local_mask = valid_mask[:series_len]
    return times[local_mask], values[local_mask]


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
    n_atoms_max = 0
    n_states_max = 0
    state_component_count = 0

    sorted_ids = sorted(master_dataset.keys(), key=lambda x: int(x) if str(x).isdigit() else str(x))

    for traj_id in sorted_ids:
        traj_data = master_dataset[traj_id]
        if time_key not in traj_data or coord_key not in traj_data:
            print(f"[WARN] Skip traj {traj_id}: missing '{time_key}' or '{coord_key}'")
            continue

        try:
            raw_time = flatten_time_array(traj_data[time_key])
            raw_coords = reshape_coords(traj_data[coord_key])
            raw_coords = raw_coords * BOHR_TO_ANGSTROM
        except Exception as exc:
            print(f"[WARN] Skip traj {traj_id}: failed to parse time/coords ({exc})")
            continue

        base_len = min(len(raw_time), len(raw_coords))
        if base_len == 0:
            print(f"[WARN] Skip traj {traj_id}: zero frame length")
            continue

        raw_time = raw_time[:base_len]
        raw_coords = raw_coords[:base_len]

        if drop_zero_frames:
            valid_mask = ~np.all(np.isclose(raw_coords, 0.0, atol=1e-12), axis=(1, 2))
        else:
            valid_mask = np.ones(base_len, dtype=bool)

        if not np.any(valid_mask):
            print(f"[WARN] Skip traj {traj_id}: all frames filtered out")
            continue

        time_vals = raw_time[valid_mask]
        coords_vals = raw_coords[valid_mask]

        record: Dict[str, Any] = {
            "time": time_vals.tolist(),
            "coords": coords_vals.tolist(),
            "n_atoms": int(coords_vals.shape[1]),
        }

        atom_numbers = _extract_atom_numbers(
            traj_data=traj_data,
            n_atoms=int(coords_vals.shape[1]),
            traj_id=traj_id,
        )
        record["atom_numbers"] = atom_numbers.tolist()

        n_atoms_max = max(n_atoms_max, int(coords_vals.shape[1]))

        if etot_key in traj_data:
            try:
                etot = reshape_scalar_series(traj_data[etot_key])
                if etot.size == 0:
                    print(f"[WARN] traj {traj_id}: empty Etot series, skip")
                else:
                    etot_ref0 = float(etot[0])
                    etot_rel = etot - etot_ref0

                    etot_time, etot_val = _mask_series_1d(raw_time, base_len, valid_mask, etot_rel)
                    record["etot_time"] = etot_time.tolist()
                    record["etot"] = etot_val.tolist()
            except Exception as exc:
                print(f"[WARN] traj {traj_id}: failed to parse Etot ({exc})")

        if STATE_COEFF_KEY in traj_data:
            try:
                coeff = reshape_complex_series(traj_data[STATE_COEFF_KEY])
                if coeff.size == 0:
                    print(f"[WARN] traj {traj_id}: empty state coefficient series, skip")
                else:
                    prob = np.abs(coeff) ** 2
                    c_prob_time, c_prob_val = _mask_series_2d(raw_time, base_len, valid_mask, prob)
                    record["c_prob_time"] = c_prob_time.tolist()
                    record["c_prob"] = c_prob_val.tolist()

                    state_idx = np.argmax(prob, axis=1).astype(int)
                    state_time, state_val = _mask_series_1d(raw_time, base_len, valid_mask, state_idx)
                    record["state_time"] = state_time.tolist()
                    record["state"] = state_val.tolist()
                    if prob.ndim == 2:
                        state_component_count = max(state_component_count, int(prob.shape[1]))
            except Exception as exc:
                print(f"[WARN] traj {traj_id}: failed to parse state from '{STATE_COEFF_KEY}' ({exc})")

        if eig_key in traj_data:
            try:
                eig = reshape_eig(traj_data[eig_key])
                eig_time, eig_val = _mask_series_2d(raw_time, base_len, valid_mask, eig)
                record["eig_time"] = eig_time.tolist()
                record["eig"] = eig_val.tolist()
                if eig_val.size > 0:
                    n_states_max = max(n_states_max, int(eig_val.shape[1]))
            except Exception as exc:
                print(f"[WARN] traj {traj_id}: failed to parse eig ({exc})")

        if nac_key in traj_data:
            try:
                nac = reshape_nac(traj_data[nac_key])
                nac_time, nac_val = _mask_series_2d(raw_time, base_len, valid_mask, nac)
                if nac_val.shape[-1] >= 2:
                    nac_norm = np.sqrt(np.sum(nac_val[:, :, 0, 1] ** 2, axis=1))
                    record["nac_time"] = nac_time.tolist()
                    record["nac_norm"] = nac_norm.tolist()
                else:
                    print(f"[WARN] traj {traj_id}: NAC has <2 states, skip nac_norm")
            except Exception as exc:
                print(f"[WARN] traj {traj_id}: failed to parse nac ({exc})")

        trajectories[str(traj_id)] = record

    traj_ids = sorted(trajectories.keys(), key=lambda x: int(x) if str(x).isdigit() else str(x))

    return {
        "meta": {
            "traj_ids": traj_ids,
            "n_atoms": n_atoms_max,
            "n_states": n_states_max,
            "time_unit": "fs",
            "length_unit": "angstrom",
            "coord_unit": "angstrom",
            "etot_unit": "hartree",
            "etot_reference": "raw_frame0",
            "state_definition": "argmax(|c|^2)",
            "state_source_key": STATE_COEFF_KEY,
            "state_index_base": 0,
            "state_component_count": state_component_count,
        },
        "trajectories": trajectories,
    }
