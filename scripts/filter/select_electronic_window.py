"""Select geometry-state records from one bundle and one explicit profile.

Usage example:

    python scripts/filter/select_electronic_window.py \
      --bundle path/to/bundle \
      --profile-id td_b3lyp \
      --pump-energy-ev 3.10 \
      --bandwidth-ev 0.30 \
      --target-count 50 \
      --selection-id pump_310nm \
      --seed 7

Selection model used by this script:

1. Candidate unit is one geometry-state record from the chosen electronic
   profile. In the current PySCF workflow, recorded transitions are normally
   0 -> n, but this script still reads the actual `transition_pairs` stored in
   the profile instead of hard-coding that assumption.

2. Excitation energy for one recorded transition is

       E_exc = (E_final - E_initial) * 27.211386245988  [eV]

   where the state energies come from `state_energy_hartree`.

3. The pump window is fixed to

       [pump_energy_ev - bandwidth_ev / 2, pump_energy_ev + bandwidth_ev / 2]

4. Only candidates with finite excitation energy inside that window and finite
   non-negative oscillator strength are kept.

5. For the filtered candidates, the sampling weight is

       weight_ratio = f / f_max

   where `f` is the candidate oscillator strength and `f_max` is the maximum
   oscillator strength among all filtered candidates.

6. Sampling is weighted random sampling without replacement. After each draw,
   probabilities are renormalized over the remaining candidates until exactly
   `target_count` records are selected.
"""

from __future__ import annotations

import argparse
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

import numpy as np


SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from backend.server.distribution_bundle import (  # noqa: E402
    DistributionBundle,
    ElectronicProfile,
    load_distribution_bundle_from_directory,
)
from scripts.basic.units import HARTREE_TO_EV  # noqa: E402
from scripts.electronic_structure.common import (  # noqa: E402
    normalize_profile_id,
    utc_now_iso,
)
from scripts.filter.common import (  # noqa: E402
    SelectedRecord,
    normalize_selection_id,
    parse_state_filter,
    write_selection_outputs,
)


@dataclass(frozen=True, slots=True)
class SelectionCandidate:
    original_sample_id: str
    original_sample_idx: int
    sampled_state: int
    excitation_energy_ev: float
    oscillator_strength: float


@dataclass(frozen=True, slots=True)
class SelectionRunResult:
    selection_id: str
    candidate_count: int
    selected_count: int
    unique_geometry_count: int
    selection_dir: Path
    manifest_path: Path
    records_path: Path
    xyz_path: Path
    index_path: Path


def _positive_float(value: str) -> float:
    parsed = float(value)
    if not np.isfinite(parsed) or parsed <= 0.0:
        raise argparse.ArgumentTypeError(f"Expected a positive finite float, found {value!r}.")
    return parsed


def _positive_int(value: str) -> int:
    parsed = int(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError(f"Expected a positive integer, found {value!r}.")
    return parsed


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Select geometry-state records from one explicit electronic profile "
            "within an excitation-energy window and write a bundle-local selection."
        )
    )
    parser.add_argument(
        "--bundle",
        required=True,
        type=Path,
        help="Path to a distribution bundle directory root.",
    )
    parser.add_argument(
        "--profile-id",
        required=True,
        help="Explicit electronic profile id to sample from.",
    )
    parser.add_argument(
        "--pump-energy-ev",
        required=True,
        type=_positive_float,
        help="Pump-center energy in eV.",
    )
    parser.add_argument(
        "--bandwidth-ev",
        required=True,
        type=_positive_float,
        help="Window width in eV.",
    )
    parser.add_argument(
        "--target-count",
        required=True,
        type=_positive_int,
        help="Exact number of geometry-state records to sample.",
    )
    parser.add_argument(
        "--states",
        nargs="+",
        help="Optional excited-state indices to include. Accepts space- or comma-separated values.",
    )
    parser.add_argument(
        "--selection-id",
        help="Optional explicit selection id. If omitted, one is generated automatically.",
    )
    parser.add_argument(
        "--seed",
        type=int,
        help="Optional RNG seed for deterministic weighted sampling.",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Replace an existing selection directory with the same selection id.",
    )
    return parser


def _default_selection_id(
    *,
    profile_id: str,
    pump_energy_ev: float,
    bandwidth_ev: float,
    target_count: int,
) -> str:
    def _format_token(value: float) -> str:
        text = f"{float(value):.6f}".rstrip("0").rstrip(".")
        return text.replace("-", "m").replace(".", "p")

    timestamp_token = (
        utc_now_iso()
        .replace("-", "")
        .replace(":", "")
        .replace(".", "")
    )
    return normalize_selection_id(
        "selection__"
        f"{profile_id}__"
        f"e{_format_token(pump_energy_ev)}__"
        f"bw{_format_token(bandwidth_ev)}__"
        f"n{int(target_count)}__"
        f"{timestamp_token}"
    )


def _resolve_profile(bundle: DistributionBundle, *, profile_id: str) -> ElectronicProfile:
    normalized_profile_id = normalize_profile_id(profile_id, label="profile_id")
    if not bundle.electronic_profiles:
        raise ValueError("Distribution bundle does not contain any electronic profiles.")
    profile = bundle.electronic_profiles.get(normalized_profile_id)
    if profile is None:
        available_profile_ids = sorted(bundle.electronic_profiles)
        raise ValueError(
            f"Electronic profile {normalized_profile_id!r} was not found in the bundle. "
            f"Available profiles: {available_profile_ids}."
        )
    return profile


def _available_recorded_states(profile: ElectronicProfile) -> list[int]:
    transition_pairs = np.asarray(profile.transition_pairs, dtype=int)
    if transition_pairs.size <= 0:
        return []
    return sorted({int(pair[1]) for pair in transition_pairs.tolist()})


def _collect_candidates(
    *,
    bundle: DistributionBundle,
    profile: ElectronicProfile,
    state_filter: list[int] | None,
    window_min_ev: float,
    window_max_ev: float,
) -> list[SelectionCandidate]:
    # One candidate corresponds to one geometry-state record in the selected profile.
    transition_pairs = np.asarray(profile.transition_pairs, dtype=int)
    excitation_energy_ev = (
        profile.state_energy_hartree[:, transition_pairs[:, 1]]
        - profile.state_energy_hartree[:, transition_pairs[:, 0]]
    ) * float(HARTREE_TO_EV)
    transition_intensity = np.asarray(profile.transition_intensity, dtype=float)
    state_filter_set = None if state_filter is None else set(int(value) for value in state_filter)

    candidates: list[SelectionCandidate] = []
    seen_keys: set[tuple[int, int]] = set()
    for sample_idx, sample_id in enumerate(bundle.sample_ids):
        for transition_idx, pair in enumerate(transition_pairs.tolist()):
            sampled_state = int(pair[1])
            if state_filter_set is not None and sampled_state not in state_filter_set:
                continue

            excitation = float(excitation_energy_ev[sample_idx, transition_idx])
            oscillator_strength = float(transition_intensity[sample_idx, transition_idx])
            is_valid = (
                np.isfinite(excitation)
                and np.isfinite(oscillator_strength)
                and excitation > 0.0
                and oscillator_strength >= 0.0
                and excitation >= float(window_min_ev)
                and excitation <= float(window_max_ev)
            )
            if not is_valid:
                continue

            candidate_key = (int(sample_idx), sampled_state)
            if candidate_key in seen_keys:
                raise ValueError(
                    "Filtered selection candidates are ambiguous because more than one transition maps to "
                    f"sample_idx={sample_idx} and sampled_state={sampled_state}. "
                    "Current selection output expects at most one recorded transition per sampled_state."
                )
            seen_keys.add(candidate_key)
            candidates.append(
                SelectionCandidate(
                    original_sample_id=str(sample_id),
                    original_sample_idx=int(sample_idx),
                    sampled_state=sampled_state,
                    excitation_energy_ev=excitation,
                    oscillator_strength=oscillator_strength,
                )
            )
    return candidates


def _sample_candidates(
    candidates: list[SelectionCandidate],
    *,
    target_count: int,
    seed: int | None,
) -> list[SelectionCandidate]:
    candidate_count = len(candidates)
    if candidate_count <= 0:
        raise ValueError("No candidates are available for weighted sampling.")
    if int(target_count) > candidate_count:
        raise ValueError(
            f"target_count={target_count} exceeds the filtered candidate count {candidate_count}."
        )

    oscillator_strengths = np.asarray([candidate.oscillator_strength for candidate in candidates], dtype=float)
    positive_weight_count = int(np.count_nonzero(oscillator_strengths > 0.0))
    if positive_weight_count <= 0:
        raise ValueError("All filtered candidates have zero oscillator strength, so weighted sampling is undefined.")
    if int(target_count) > positive_weight_count:
        raise ValueError(
            f"target_count={target_count} exceeds the number of positive-weight candidates {positive_weight_count}."
        )

    max_strength = float(np.max(oscillator_strengths))
    if not np.isfinite(max_strength) or max_strength <= 0.0:
        raise ValueError("Filtered candidates do not contain a finite positive oscillator-strength maximum.")
    # Weight rule fixed by design: weight_ratio = f / f_max over filtered candidates.
    weight_ratio = np.asarray(oscillator_strengths / max_strength, dtype=float)

    rng = np.random.default_rng(seed)
    remaining_indices = np.arange(candidate_count, dtype=int)
    remaining_weights = np.asarray(weight_ratio, dtype=float)
    chosen_indices: list[int] = []
    for _ in range(int(target_count)):
        total_weight = float(np.sum(remaining_weights))
        if not np.isfinite(total_weight) or total_weight <= 0.0:
            raise ValueError("Weighted sampling ran out of positive probability mass before reaching target_count.")
        probabilities = np.asarray(remaining_weights / total_weight, dtype=float)
        picked_position = int(rng.choice(remaining_indices.shape[0], p=probabilities))
        chosen_indices.append(int(remaining_indices[picked_position]))
        remaining_indices = np.delete(remaining_indices, picked_position)
        remaining_weights = np.delete(remaining_weights, picked_position)

    return [candidates[index] for index in chosen_indices]


def _build_selected_records(selected_candidates: list[SelectionCandidate]) -> list[SelectedRecord]:
    subset_geometry_index_by_sample_idx: dict[int, int] = {}
    selected_records: list[SelectedRecord] = []
    for selection_rank, candidate in enumerate(selected_candidates, start=1):
        subset_geometry_index = subset_geometry_index_by_sample_idx.setdefault(
            int(candidate.original_sample_idx),
            len(subset_geometry_index_by_sample_idx),
        )
        selected_records.append(
            SelectedRecord(
                selection_rank=int(selection_rank),
                original_sample_id=str(candidate.original_sample_id),
                original_sample_idx=int(candidate.original_sample_idx),
                sampled_state=int(candidate.sampled_state),
                excitation_energy_ev=float(candidate.excitation_energy_ev),
                subset_geometry_index=int(subset_geometry_index),
            )
        )
    return selected_records


def run_selection(
    *,
    bundle_dir: Path,
    profile_id: str,
    pump_energy_ev: float,
    bandwidth_ev: float,
    target_count: int,
    states: Sequence[str] | None = None,
    selection_id: str | None = None,
    seed: int | None = None,
    force: bool = False,
) -> SelectionRunResult:
    """Run one selection on one bundle and one explicitly requested profile."""
    bundle_root = Path(bundle_dir).resolve()
    bundle = load_distribution_bundle_from_directory(bundle_root)
    profile = _resolve_profile(bundle, profile_id=profile_id)

    state_filter = parse_state_filter(states)
    available_states = _available_recorded_states(profile)
    if not available_states:
        raise ValueError(f"Electronic profile {profile.profile_id!r} does not contain any recorded transitions.")
    if state_filter is not None:
        missing_states = [state for state in state_filter if state not in set(available_states)]
        if missing_states:
            raise ValueError(
                f"Requested states {missing_states} are not present in electronic profile {profile.profile_id!r}. "
                f"Available recorded states: {available_states}."
            )

    window_half_width_ev = float(bandwidth_ev) / 2.0
    window_min_ev = float(pump_energy_ev) - window_half_width_ev
    window_max_ev = float(pump_energy_ev) + window_half_width_ev
    candidates = _collect_candidates(
        bundle=bundle,
        profile=profile,
        state_filter=state_filter,
        window_min_ev=window_min_ev,
        window_max_ev=window_max_ev,
    )
    if not candidates:
        raise ValueError(
            "No geometry-state candidates remain after applying the profile, state, and excitation-energy filters."
        )

    normalized_selection_id = normalize_selection_id(
        selection_id
        if selection_id is not None
        else _default_selection_id(
            profile_id=profile.profile_id,
            pump_energy_ev=float(pump_energy_ev),
            bandwidth_ev=float(bandwidth_ev),
            target_count=int(target_count),
        )
    )
    sampled_candidates = _sample_candidates(
        candidates,
        target_count=int(target_count),
        seed=seed,
    )
    selected_records = _build_selected_records(sampled_candidates)
    created_at_utc = utc_now_iso()
    manifest_payload = {
        "selection_id": normalized_selection_id,
        "created_at_utc": created_at_utc,
        "profile_id": str(profile.profile_id),
        "profile_label": str(profile.label),
        "pump_energy_ev": float(pump_energy_ev),
        "bandwidth_ev": float(bandwidth_ev),
        "window_min_ev": float(window_min_ev),
        "window_max_ev": float(window_max_ev),
        "target_count": int(target_count),
        "seed": (None if seed is None else int(seed)),
        "candidate_count": int(len(candidates)),
        "selected_count": int(len(selected_records)),
        "unique_geometry_count": int(len({record.subset_geometry_index for record in selected_records})),
        "state_filter": ("all_recorded_states" if state_filter is None else list(state_filter)),
    }
    write_result = write_selection_outputs(
        bundle_root=bundle_root,
        bundle=bundle,
        selection_id=normalized_selection_id,
        manifest_payload=manifest_payload,
        selected_records=selected_records,
        force=bool(force),
    )
    return SelectionRunResult(
        selection_id=normalized_selection_id,
        candidate_count=int(len(candidates)),
        selected_count=int(len(selected_records)),
        unique_geometry_count=int(manifest_payload["unique_geometry_count"]),
        selection_dir=write_result.selection_dir,
        manifest_path=write_result.manifest_path,
        records_path=write_result.records_path,
        xyz_path=write_result.xyz_path,
        index_path=write_result.index_path,
    )


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(list(argv) if argv is not None else None)
    try:
        result = run_selection(
            bundle_dir=args.bundle,
            profile_id=args.profile_id,
            pump_energy_ev=args.pump_energy_ev,
            bandwidth_ev=args.bandwidth_ev,
            target_count=args.target_count,
            states=args.states,
            selection_id=args.selection_id,
            seed=args.seed,
            force=args.force,
        )
    except ValueError as exc:
        parser.exit(2, f"Error: {exc}\n")

    print(
        "Wrote selection "
        f"{result.selection_id} with {result.selected_count} record(s) "
        f"to {result.selection_dir}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
