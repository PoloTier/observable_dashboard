(function () {
  const root = window.ObservableMol3D || (window.ObservableMol3D = {});
  const shared = root.shared;
  const math3d = window.ObservableDashboardMath;
  if (!shared || !math3d) return;

  const {
    distance3,
    dot,
    cross,
    norm,
    sub,
    angleDeg,
    dihedralDeg,
    unwrapDegrees,
    midpoint3,
  } = math3d;

  function toArray3(atomLike) {
    if (!atomLike) return null;
    const x = Number(atomLike.x);
    const y = Number(atomLike.y);
    const z = Number(atomLike.z);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
    return [x, y, z];
  }

  function resolveAtomIndex(atom, frameCoords) {
    const nAtoms = Array.isArray(frameCoords) ? frameCoords.length : 0;
    if (!nAtoms) return null;

    const idxCandidate = Number.parseInt(atom?.index, 10);
    if (Number.isFinite(idxCandidate) && idxCandidate >= 0 && idxCandidate < nAtoms) {
      return idxCandidate;
    }

    const atomPos = toArray3(atom);
    if (!atomPos) return null;

    let bestIdx = null;
    let bestDist = Number.POSITIVE_INFINITY;
    for (let i = 0; i < nAtoms; i++) {
      const p = frameCoords[i];
      if (!Array.isArray(p) || p.length < 3) continue;
      const d = distance3(atomPos, p);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    return bestIdx;
  }

  function canonicalMeasurement(type, atoms) {
    const normalizedType = shared.normalizeMeasureType(type);
    const meta = shared.getMeasureMeta(normalizedType);
    if (!Array.isArray(atoms) || atoms.length !== meta.requiredAtoms) return null;

    const parsedAtoms = atoms.map((value) => Number.parseInt(value, 10));
    if (parsedAtoms.some((value) => !Number.isFinite(value))) return null;
    if (new Set(parsedAtoms).size !== parsedAtoms.length) return null;

    if (normalizedType === 'bond') {
      const low = Math.min(parsedAtoms[0], parsedAtoms[1]);
      const high = Math.max(parsedAtoms[0], parsedAtoms[1]);
      return { atoms: [low, high], key: `${low}-${high}` };
    }

    if (normalizedType === 'angle') {
      const a = parsedAtoms[0];
      const b = parsedAtoms[1];
      const c = parsedAtoms[2];
      const first = Math.min(a, c);
      const third = Math.max(a, c);
      return { atoms: [first, b, third], key: `${first}-${b}-${third}` };
    }

    const forward = parsedAtoms.join('-');
    const reverse = parsedAtoms.slice().reverse().join('-');
    const key = forward < reverse ? forward : reverse;
    return {
      atoms: key.split('-').map((value) => Number.parseInt(value, 10)),
      key,
    };
  }

  root.geometry = {
    distance3,
    dot,
    cross,
    norm,
    sub,
    angleDeg,
    dihedralDeg,
    unwrapDegrees,
    midpoint3,
    toArray3,
    resolveAtomIndex,
    canonicalMeasurement,
  };
})();
