(function () {
  const root = window.ObservableMol3D || (window.ObservableMol3D = {});
  const shared = root.shared;
  if (!shared) return;

  const { state, dom } = shared;
  let hbondInflightPromise = null;
  let hbondInflightTrajId = '';
  const HBOND_COLOR = '#ff5a36';
  const HBOND_H_TRIM_BASE = 0.28;
  const HBOND_ACCEPTOR_TRIM_BASE = 0.52;
  const HBOND_DASH_LENGTH = 0.82;
  const HBOND_GAP_LENGTH = 0.5;
  const HBOND_MIN_SEGMENT_LENGTH = 0.34;
  const HBOND_RADIUS_MIN = 0.09;
  const HBOND_RADIUS_MAX = 0.34;
  const HBOND_OPACITY = 0.82;

  function buildHbondApiUrl(trajId) {
    const base = typeof shared.apiBase === 'string' && shared.apiBase.trim() ? shared.apiBase.trim() : '/api';
    const normalizedBase = base.endsWith('/') ? base.slice(0, -1) : base;
    const normalizedTrajId = root.ioTransformers && typeof root.ioTransformers.normalizeTrajId === 'function'
      ? root.ioTransformers.normalizeTrajId(trajId)
      : String(trajId);
    return `${normalizedBase}/molecule3d/hbonds/${encodeURIComponent(normalizedTrajId)}`;
  }

  async function readErrorDetail(response) {
    if (!response) return '';
    try {
      const payload = await response.json();
      if (typeof payload?.detail === 'string' && payload.detail.trim()) {
        return payload.detail.trim();
      }
    } catch (_) {
      // best effort detail parsing
    }
    return '';
  }

  async function fetchHbondRecordFallback(trajId) {
    const transformers = root.ioTransformers;
    if (!transformers || typeof transformers.normalizeHbondPayload !== 'function') {
      throw new Error('Hydrogen-bond transformers are unavailable. Hard refresh the page to reload assets.');
    }

    const normalizedTrajId = typeof transformers.normalizeTrajId === 'function'
      ? transformers.normalizeTrajId(trajId)
      : String(trajId);
    const response = await fetch(buildHbondApiUrl(normalizedTrajId), { cache: 'default' });
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      const detailText = await readErrorDetail(response);
      const detail = detailText ? `HTTP ${response.status}: ${detailText}` : `HTTP ${response.status}`;
      throw new Error(detail);
    }
    const payload = await response.json();
    return transformers.normalizeHbondPayload(normalizedTrajId, payload);
  }

  function buildFrameIndexedCache(payload) {
    const nFrames = Math.max(0, Number.parseInt(String(payload?.n_frames), 10) || 0);
    const byFrame = Array.from({ length: nFrames }, () => []);
    const hbonds = Array.isArray(payload?.hbonds) ? payload.hbonds : [];
    for (const hb of hbonds) {
      const frame = Number.parseInt(String(hb?.frame), 10);
      if (!Number.isFinite(frame) || frame < 0 || frame >= byFrame.length) continue;
      byFrame[frame].push(hb);
    }
    return {
      ...payload,
      hbonds_by_frame: byFrame,
    };
  }

  async function ensureHydrogenBondsLoaded() {
    const trajId = state.currentTrajId ? String(state.currentTrajId) : '';
    if (!trajId) return null;

    if (state.hbondCache && state.hbondCache.traj_id === trajId) {
      return state.hbondCache;
    }
    if (hbondInflightPromise && hbondInflightTrajId === trajId) {
      return hbondInflightPromise;
    }

    hbondInflightTrajId = trajId;
    const ioNetwork = root.ioNetwork;
    shared.setStatus(`Computing hydrogen bonds for trajectory ${trajId} on backend...`);
    const loader = ioNetwork && typeof ioNetwork.getHbondRecord === 'function'
      ? ioNetwork.getHbondRecord.bind(ioNetwork)
      : fetchHbondRecordFallback;
    hbondInflightPromise = loader(trajId)
      .then((payload) => {
        if (!payload) {
          if (state.currentTrajId === trajId && state.showHydrogenBonds) {
            shared.setStatus(`Trajectory ${trajId} not found for hydrogen-bond query.`, true);
          }
          return null;
        }
        const indexed = buildFrameIndexedCache(payload);
        if (state.currentTrajId !== trajId) {
          return indexed;
        }

        state.hbondCache = indexed;
        if (state.showHydrogenBonds) {
          const count = Array.isArray(indexed.hbonds) ? indexed.hbonds.length : 0;
          shared.setStatus(`Hydrogen bonds ready: ${count} matches across ${indexed.n_frames} frames.`);
          const viewer = root.viewer;
          if (viewer && typeof viewer.renderFrame === 'function' && state.xyzFrames.length) {
            viewer.renderFrame(state.currentFrame);
          }
        }
        return indexed;
      })
      .catch((error) => {
        const detail = error instanceof Error ? error.message : String(error);
        if (state.currentTrajId === trajId && state.showHydrogenBonds) {
          shared.setStatus(`Failed to load hydrogen bonds: ${detail}`, true);
        }
        return null;
      })
      .finally(() => {
        if (hbondInflightTrajId === trajId) {
          hbondInflightPromise = null;
          hbondInflightTrajId = '';
        }
      });
    return hbondInflightPromise;
  }

  function getHydrogenBondsForFrame(frameIndex) {
    const cache = state.hbondCache;
    if (!cache) return [];
    const idx = Number.parseInt(String(frameIndex), 10);
    if (!Number.isFinite(idx) || idx < 0) return [];
    const buckets = cache.hbonds_by_frame;
    if (!Array.isArray(buckets) || idx >= buckets.length) return [];
    const frameHbonds = buckets[idx];
    return Array.isArray(frameHbonds) ? frameHbonds : [];
  }

  function resolveFlatCap() {
    return window.$3Dmol?.CAP?.FLAT ?? 1;
  }

  function buildHydrogenBondStickStyle() {
    const hbondScale = typeof shared.clampHbondLineScale === 'function'
      ? shared.clampHbondLineScale(state.hbondLineScale)
      : 1;
    const bondRadiusScale = typeof shared.clampBondRadiusScale === 'function'
      ? shared.clampBondRadiusScale(state.bondRadiusScale)
      : 1;
    const baseStickRadius = Number.isFinite(Number(root.constants?.MODEL_STICK_RADIUS_BASE))
      ? Number(root.constants.MODEL_STICK_RADIUS_BASE)
      : 0.15;
    const radius = Math.max(
      HBOND_RADIUS_MIN,
      Math.min(HBOND_RADIUS_MAX, baseStickRadius * bondRadiusScale * (0.55 + 0.45 * hbondScale))
    );
    const flatCap = resolveFlatCap();
    return {
      dashLength: HBOND_DASH_LENGTH,
      gapLength: HBOND_GAP_LENGTH,
      minSegmentLength: HBOND_MIN_SEGMENT_LENGTH,
      radius,
      opacity: HBOND_OPACITY,
      fromCap: flatCap,
      toCap: flatCap,
    };
  }

  function trimHydrogenBondSegment(hydrogenCoord, acceptorCoord) {
    const dx = Number(acceptorCoord[0]) - Number(hydrogenCoord[0]);
    const dy = Number(acceptorCoord[1]) - Number(hydrogenCoord[1]);
    const dz = Number(acceptorCoord[2]) - Number(hydrogenCoord[2]);
    const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (!Number.isFinite(length) || length <= 1e-8) {
      return null;
    }

    const atomScale = typeof shared.clampAtomSizeScale === 'function'
      ? shared.clampAtomSizeScale(state.atomSizeScale)
      : 1;
    const hTrim = HBOND_H_TRIM_BASE * atomScale;
    const aTrim = HBOND_ACCEPTOR_TRIM_BASE * atomScale;
    const usable = length - hTrim - aTrim;
    if (!(usable > 0.12)) {
      return null;
    }

    const ux = dx / length;
    const uy = dy / length;
    const uz = dz / length;
    return {
      start: [
        Number(hydrogenCoord[0]) + ux * hTrim,
        Number(hydrogenCoord[1]) + uy * hTrim,
        Number(hydrogenCoord[2]) + uz * hTrim,
      ],
      end: [
        Number(acceptorCoord[0]) - ux * aTrim,
        Number(acceptorCoord[1]) - uy * aTrim,
        Number(acceptorCoord[2]) - uz * aTrim,
      ],
    };
  }

  function renderHydrogenBonds(frameIndex) {
    const viewer = root.viewer;
    if (!viewer || !state.viewer) return;
    if (!state.showHydrogenBonds) return;

    const trajId = state.currentTrajId ? String(state.currentTrajId) : '';
    if (!trajId) return;
    if (!state.hbondCache || state.hbondCache.traj_id !== trajId) {
      void ensureHydrogenBondsLoaded();
      return;
    }

    const frameHbonds = getHydrogenBondsForFrame(frameIndex);
    const frameCoords = Array.isArray(state.currentCoords) ? state.currentCoords[frameIndex] : null;
    if (!Array.isArray(frameCoords)) return;
    const stickStyle = buildHydrogenBondStickStyle();
    const fallbackLineWidth = Math.max(2, Math.round(stickStyle.radius * 20));

    for (const hbond of frameHbonds) {
      const hydrogenCoord = frameCoords[hbond.h_idx];
      const acceptorCoord = frameCoords[hbond.acceptor_idx];
      if (
        Array.isArray(hydrogenCoord) && hydrogenCoord.length >= 3 &&
        Array.isArray(acceptorCoord) && acceptorCoord.length >= 3
      ) {
        const trimmed = trimHydrogenBondSegment(hydrogenCoord, acceptorCoord);
        if (!trimmed) continue;
        if (typeof viewer.addOverlayDashedStick === 'function') {
          viewer.addOverlayDashedStick(trimmed.start, trimmed.end, HBOND_COLOR, stickStyle);
          continue;
        }
        viewer.addOverlayLine(trimmed.start, trimmed.end, HBOND_COLOR, {
          dashed: true,
          dashLength: stickStyle.dashLength,
          gapLength: stickStyle.gapLength,
          linewidth: fallbackLineWidth,
        });
      }
    }
  }

  async function setHydrogenBondsVisible(enabled) {
    state.showHydrogenBonds = !!enabled;
    if (dom.showHydrogenBondsCheckbox) {
      dom.showHydrogenBondsCheckbox.checked = !!enabled;
    }
    const viewer = root.viewer;

    if (!state.showHydrogenBonds) {
      if (viewer && typeof viewer.renderFrame === 'function' && state.currentTrajId && state.xyzFrames.length) {
        viewer.renderFrame(state.currentFrame);
      }
      return;
    }

    if (!state.currentTrajId || !state.xyzFrames.length) return;
    const payload = await ensureHydrogenBondsLoaded();
    if (!payload) {
      state.showHydrogenBonds = false;
      if (dom.showHydrogenBondsCheckbox) {
        dom.showHydrogenBondsCheckbox.checked = false;
      }
      return;
    }
    if (viewer && typeof viewer.renderFrame === 'function' && state.currentTrajId && state.xyzFrames.length) {
      viewer.renderFrame(state.currentFrame);
    }
  }

  function resetHydrogenBondState() {
    state.hbondCache = null;
    hbondInflightPromise = null;
    hbondInflightTrajId = '';
  }

  root.hbond = {
    ensureHydrogenBondsLoaded,
    renderHydrogenBonds,
    setHydrogenBondsVisible,
    resetHydrogenBondState,
  };
})();
