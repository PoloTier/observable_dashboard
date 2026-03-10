(function () {
  const root = window.ObservableMol3D || (window.ObservableMol3D = {});
  const shared = root.shared;
  if (!shared) return;

  const { constants } = shared;

  function atomicNumberToElement(z) {
    const n = Number.parseInt(z, 10);
    if (!Number.isFinite(n) || n <= 0) return 'C';
    if (n >= constants.PERIODIC_SYMBOLS.length) return 'C';
    return constants.PERIODIC_SYMBOLS[n] || 'C';
  }

  function buildXyzFrames(record) {
    const coords = Array.isArray(record?.coords) ? record.coords : [];
    if (!coords.length) return [];

    const nAtoms = Number(record?.n_atoms || (coords[0] ? coords[0].length : 0));
    if (!Number.isFinite(nAtoms) || nAtoms <= 0) return [];

    let atomNumbers = Array.isArray(record?.atom_numbers) ? record.atom_numbers.slice(0, nAtoms) : [];
    if (atomNumbers.length < nAtoms) {
      atomNumbers = atomNumbers.concat(new Array(nAtoms - atomNumbers.length).fill(6));
    }

    const times = Array.isArray(record?.time) ? record.time : [];
    const frameCount = Math.min(coords.length, times.length || coords.length);
    const out = [];

    for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
      const frame = coords[frameIndex];
      if (!Array.isArray(frame) || frame.length < nAtoms) continue;

      const lines = [
        String(nAtoms),
        `Frame ${frameIndex} time=${Number(times[frameIndex] ?? frameIndex).toFixed(6)} fs`
      ];

      for (let atomIndex = 0; atomIndex < nAtoms; atomIndex++) {
        const xyz = frame[atomIndex];
        if (!Array.isArray(xyz) || xyz.length < 3) {
          lines.push('C 0.000000 0.000000 0.000000');
          continue;
        }

        const elem = atomicNumberToElement(atomNumbers[atomIndex]);
        lines.push(`${elem} ${Number(xyz[0]).toFixed(8)} ${Number(xyz[1]).toFixed(8)} ${Number(xyz[2]).toFixed(8)}`);
      }

      out.push(lines.join('\n'));
    }

    return out;
  }

  function normalizeTrajId(trajId) {
    return String(trajId);
  }

  function normalizeTrajectoryPayload(trajId, payload) {
    const coords = Array.isArray(payload?.coords) ? payload.coords : [];
    const inferredAtoms = coords.length && Array.isArray(coords[0]) ? coords[0].length : 0;
    const parseFiniteOrNull = (rawValue) => {
      const numeric = Number(rawValue);
      return Number.isFinite(numeric) ? numeric : null;
    };
    return {
      traj_id: normalizeTrajId(trajId),
      time: Array.isArray(payload?.time) ? payload.time : [],
      coords,
      n_atoms: Number.isFinite(Number(payload?.n_atoms)) ? Number(payload.n_atoms) : inferredAtoms,
      atom_numbers: Array.isArray(payload?.atom_numbers) ? payload.atom_numbers : [],
      nac_available: !!payload?.nac_available,
      nac_state_count: Number.parseInt(String(payload?.nac_state_count), 10) || 0,
      nac_component_count: Number.parseInt(String(payload?.nac_component_count), 10) || 0,
      de_available: !!payload?.de_available,
      de_state_count: Number.parseInt(String(payload?.de_state_count), 10) || 0,
      de_component_count: Number.parseInt(String(payload?.de_component_count), 10) || 0,
      de_global_norm_scope: typeof payload?.de_global_norm_scope === 'string' ? payload.de_global_norm_scope : '',
      de_global_norm_p5: parseFiniteOrNull(payload?.de_global_norm_p5),
      de_global_norm_p90: parseFiniteOrNull(payload?.de_global_norm_p90),
      de_global_norm_p95: parseFiniteOrNull(payload?.de_global_norm_p95),
      de_global_norm_count: Number.parseInt(String(payload?.de_global_norm_count), 10) || 0,
      de_nac_available: !!payload?.de_nac_available,
      de_nac_state_count: Number.parseInt(String(payload?.de_nac_state_count), 10) || 0,
      de_nac_component_count: Number.parseInt(String(payload?.de_nac_component_count), 10) || 0,
    };
  }

  function normalizeNacPayload(trajId, stateI, stateJ, payload) {
    return {
      traj_id: normalizeTrajId(trajId),
      state_i: Number.parseInt(String(payload?.state_i), 10) || Number.parseInt(String(stateI), 10) || 0,
      state_j: Number.parseInt(String(payload?.state_j), 10) || Number.parseInt(String(stateJ), 10) || 1,
      n_states: Number.parseInt(String(payload?.n_states), 10) || 0,
      n_atoms: Number.parseInt(String(payload?.n_atoms), 10) || 0,
      n_frames: Number.parseInt(String(payload?.n_frames), 10) || 0,
      time: Array.isArray(payload?.time) ? payload.time : [],
      vectors: Array.isArray(payload?.vectors) ? payload.vectors : [],
    };
  }

  function normalizeDePayload(trajId, stateI, stateJ, payload) {
    return {
      traj_id: normalizeTrajId(trajId),
      state_i: Number.parseInt(String(payload?.state_i), 10) || Number.parseInt(String(stateI), 10) || 0,
      state_j: Number.parseInt(String(payload?.state_j), 10) || Number.parseInt(String(stateJ), 10) || 1,
      n_states: Number.parseInt(String(payload?.n_states), 10) || 0,
      n_atoms: Number.parseInt(String(payload?.n_atoms), 10) || 0,
      n_frames: Number.parseInt(String(payload?.n_frames), 10) || 0,
      time: Array.isArray(payload?.time) ? payload.time : [],
      vectors: Array.isArray(payload?.vectors) ? payload.vectors : [],
    };
  }

  function normalizeDeNacPayload(trajId, stateI, stateJ, payload) {
    return {
      traj_id: normalizeTrajId(trajId),
      state_i: Number.parseInt(String(payload?.state_i), 10) || Number.parseInt(String(stateI), 10) || 0,
      state_j: Number.parseInt(String(payload?.state_j), 10) || Number.parseInt(String(stateJ), 10) || 1,
      n_states: Number.parseInt(String(payload?.n_states), 10) || 0,
      n_atoms: Number.parseInt(String(payload?.n_atoms), 10) || 0,
      n_frames: Number.parseInt(String(payload?.n_frames), 10) || 0,
      time: Array.isArray(payload?.time) ? payload.time : [],
      vectors: Array.isArray(payload?.vectors) ? payload.vectors : [],
    };
  }

  function normalizeHbondPayload(trajId, payload) {
    const normalizedTrajId = normalizeTrajId(payload?.traj_id ?? trajId);
    const parseFiniteOrFallback = (rawValue, fallback) => {
      const numeric = Number(rawValue);
      return Number.isFinite(numeric) ? numeric : fallback;
    };
    const nFrames = Math.max(0, Number.parseInt(String(payload?.n_frames), 10) || 0);
    const nAtoms = Math.max(0, Number.parseInt(String(payload?.n_atoms), 10) || 0);
    const donorAcceptorRaw = Array.isArray(payload?.donor_acceptor_atomic_numbers)
      ? payload.donor_acceptor_atomic_numbers
      : [];
    const donorAcceptorAtomicNumbers = donorAcceptorRaw
      .map((value) => Number.parseInt(String(value), 10))
      .filter((value) => Number.isFinite(value) && value > 0);

    const hbondsRaw = Array.isArray(payload?.hbonds) ? payload.hbonds : [];
    const hbonds = [];
    for (const item of hbondsRaw) {
      const frame = Number.parseInt(String(item?.frame), 10);
      const donorIdx = Number.parseInt(String(item?.donor_idx), 10);
      const hIdx = Number.parseInt(String(item?.h_idx), 10);
      const acceptorIdx = Number.parseInt(String(item?.acceptor_idx), 10);
      const distance = Number(item?.distance);
      const angle = Number(item?.angle);

      if (!Number.isFinite(frame) || frame < 0) continue;
      if (nFrames > 0 && frame >= nFrames) continue;
      if (!Number.isFinite(donorIdx) || donorIdx < 0) continue;
      if (!Number.isFinite(hIdx) || hIdx < 0) continue;
      if (!Number.isFinite(acceptorIdx) || acceptorIdx < 0) continue;
      if (nAtoms > 0 && (donorIdx >= nAtoms || hIdx >= nAtoms || acceptorIdx >= nAtoms)) continue;
      if (!Number.isFinite(distance)) continue;
      if (!Number.isFinite(angle)) continue;

      hbonds.push({
        frame,
        donor_idx: donorIdx,
        h_idx: hIdx,
        acceptor_idx: acceptorIdx,
        distance,
        angle,
      });
    }

    return {
      traj_id: normalizedTrajId,
      n_frames: nFrames,
      n_atoms: nAtoms,
      donor_acceptor_atomic_numbers: donorAcceptorAtomicNumbers.length ? donorAcceptorAtomicNumbers : [7, 8, 9],
      hbond_distance_cutoff: parseFiniteOrFallback(payload?.hbond_distance_cutoff, 3.5),
      hbond_angle_cutoff: parseFiniteOrFallback(payload?.hbond_angle_cutoff, 120),
      dh_bond_length: parseFiniteOrFallback(payload?.dh_bond_length, 1.3),
      hbonds,
    };
  }

  function clampStateIndex(rawValue, fallback, nStates) {
    const parsed = Number.parseInt(String(rawValue), 10);
    if (!Number.isFinite(parsed)) return fallback;
    if (nStates <= 0) return fallback;
    return Math.max(0, Math.min(nStates - 1, parsed));
  }

  function normalizeStatePair(stateI, stateJ, nStates) {
    const count = Number.parseInt(String(nStates), 10) || 0;
    if (count <= 0) {
      return { stateI: 0, stateJ: 0 };
    }
    const i = clampStateIndex(stateI, 0, count);
    const j = clampStateIndex(stateJ, 0, count);
    return { stateI: i, stateJ: j };
  }

  function normalizeDistinctStatePair(stateI, stateJ, nStates, preferredField) {
    const count = Number.parseInt(String(nStates), 10) || 0;
    if (count <= 1) {
      return { stateI: 0, stateJ: 0 };
    }
    let i = clampStateIndex(stateI, 0, count);
    let j = clampStateIndex(stateJ, 1, count);
    if (i === j) {
      if (preferredField === 'i') {
        j = (i + 1) % count;
      } else {
        i = (j + 1) % count;
      }
    }
    return { stateI: i, stateJ: j };
  }

  function formatMagnitude(value) {
    if (!Number.isFinite(value)) return 'n/a';
    const abs = Math.abs(value);
    if ((abs > 0 && abs < 1e-3) || abs >= 1e3) {
      return value.toExponential(2);
    }
    return value.toFixed(4);
  }

  function quantileFromSorted(sorted, q) {
    if (!Array.isArray(sorted) || !sorted.length) return NaN;
    const clampedQ = Math.max(0, Math.min(1, Number(q)));
    const pos = (sorted.length - 1) * clampedQ;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    if (lo === hi) return sorted[lo];
    const t = pos - lo;
    return sorted[lo] * (1 - t) + sorted[hi] * t;
  }

  function collectNacMagnitudes(vectors) {
    const mags = [];
    if (!Array.isArray(vectors)) return mags;
    for (const frame of vectors) {
      if (!Array.isArray(frame)) continue;
      for (const vec of frame) {
        if (!Array.isArray(vec) || vec.length < 3) continue;
        const x = Number(vec[0]);
        const y = Number(vec[1]);
        const z = Number(vec[2]);
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
        mags.push(Math.sqrt(x * x + y * y + z * z));
      }
    }
    return mags;
  }

  function computeAutoScaleFromP90(p90Raw) {
    let p90 = Number(p90Raw);
    if (!Number.isFinite(p90) || p90 <= 1e-12) {
      p90 = 1e-12;
    }
    const rawAutoScale = constants.NAC_TARGET_P90_LENGTH / p90;
    return Math.max(
      constants.NAC_AUTO_BASE_SCALE_MIN,
      Math.min(constants.NAC_AUTO_BASE_SCALE_MAX, rawAutoScale)
    );
  }

  function buildMagnitudeStatsFromQuantiles(colorMinRaw, p90Raw, colorMaxRaw) {
    let colorMin = Number(colorMinRaw);
    let colorMax = Number(colorMaxRaw);
    let p90 = Number(p90Raw);
    if (!Number.isFinite(colorMin) || !Number.isFinite(colorMax) || !Number.isFinite(p90)) {
      return null;
    }
    if (colorMax <= colorMin) {
      colorMax = colorMin + 1e-12;
    }
    if (p90 <= 1e-12) {
      p90 = Math.max(colorMax, 1e-12);
    }

    return {
      colorMin,
      colorMax,
      autoScale: computeAutoScaleFromP90(p90),
    };
  }

  function computeNacMagnitudeStats(vectors) {
    const mags = collectNacMagnitudes(vectors);
    if (!mags.length) return null;
    mags.sort((a, b) => a - b);

    let colorMin = quantileFromSorted(mags, constants.NAC_MAG_COLOR_Q_MIN);
    let colorMax = quantileFromSorted(mags, constants.NAC_MAG_COLOR_Q_MAX);
    if (!Number.isFinite(colorMin)) colorMin = mags[0];
    if (!Number.isFinite(colorMax)) colorMax = mags[mags.length - 1];
    if (colorMax <= colorMin) {
      colorMin = mags[0];
      colorMax = mags[mags.length - 1];
    }
    if (colorMax <= colorMin) {
      colorMax = colorMin + 1e-12;
    }

    let p90 = quantileFromSorted(mags, constants.NAC_AUTO_SCALE_Q);
    if (!Number.isFinite(p90) || p90 <= 1e-12) {
      p90 = Math.max(mags[mags.length - 1], 1e-12);
    }

    return {
      colorMin,
      colorMax,
      autoScale: computeAutoScaleFromP90(p90),
    };
  }

  root.ioTransformers = {
    atomicNumberToElement,
    buildXyzFrames,
    normalizeTrajId,
    normalizeTrajectoryPayload,
    normalizeNacPayload,
    normalizeDePayload,
    normalizeDeNacPayload,
    normalizeHbondPayload,
    clampStateIndex,
    normalizeStatePair,
    normalizeDistinctStatePair,
    formatMagnitude,
    quantileFromSorted,
    collectNacMagnitudes,
    computeAutoScaleFromP90,
    buildMagnitudeStatsFromQuantiles,
    computeNacMagnitudeStats,
  };
})();
