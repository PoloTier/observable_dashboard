(function () {
  const root = window.ObservableMol3D || (window.ObservableMol3D = {});

  function createStoreConstants() {
    return root.constants || {};
  }

  function createStoreUtils() {
    return root.utils || {};
  }

  function clampPlaybackRate(raw) {
    const constants = createStoreConstants();
    const utils = createStoreUtils();
    const fallback = constants.PLAYBACK_RATE_DEFAULT;
    const minRate = constants.PLAYBACK_RATE_MIN;
    const maxRate = constants.PLAYBACK_RATE_MAX;
    const step = constants.PLAYBACK_RATE_STEP;
    const parsed = utils.parseFiniteNumber ? utils.parseFiniteNumber(raw) : Number(raw);
    if (!Number.isFinite(parsed)) return fallback;
    const clamped = utils.clampNumber
      ? utils.clampNumber(parsed, minRate, maxRate)
      : Math.max(minRate, Math.min(maxRate, parsed));
    if (!Number.isFinite(step) || step <= 0) return clamped;
    const snapped = minRate + Math.round((clamped - minRate) / step) * step;
    const bounded = utils.clampNumber
      ? utils.clampNumber(snapped, minRate, maxRate)
      : Math.max(minRate, Math.min(maxRate, snapped));
    return Number(bounded.toFixed(4));
  }

  function clampPlaybackStride(raw) {
    const constants = createStoreConstants();
    const utils = createStoreUtils();
    const fallback = constants.PLAYBACK_STRIDE_DEFAULT;
    const minStride = constants.PLAYBACK_STRIDE_MIN;
    const maxStride = constants.PLAYBACK_STRIDE_MAX;
    const step = constants.PLAYBACK_STRIDE_STEP;
    const parsed = utils.parseFiniteNumber ? utils.parseFiniteNumber(raw) : Number(raw);
    if (!Number.isFinite(parsed)) return fallback;
    const clamped = utils.clampNumber
      ? utils.clampNumber(parsed, minStride, maxStride)
      : Math.max(minStride, Math.min(maxStride, parsed));
    const normalizedStep = Number.isFinite(step) && step > 0 ? step : 1;
    const snapped = minStride + Math.round((clamped - minStride) / normalizedStep) * normalizedStep;
    const bounded = utils.clampNumber
      ? utils.clampNumber(Math.trunc(snapped), minStride, maxStride)
      : Math.max(minStride, Math.min(maxStride, Math.trunc(snapped)));
    return bounded;
  }

  function clampNacScale(raw) {
    const constants = createStoreConstants();
    const utils = createStoreUtils();
    const fallback = constants.NAC_SCALE_DEFAULT;
    const minScale = constants.NAC_SCALE_MIN;
    const maxScale = constants.NAC_SCALE_MAX;
    const step = constants.NAC_SCALE_STEP;
    const parsed = utils.parseFiniteNumber ? utils.parseFiniteNumber(raw) : Number(raw);
    if (!Number.isFinite(parsed)) return fallback;
    const clamped = utils.clampNumber
      ? utils.clampNumber(parsed, minScale, maxScale)
      : Math.max(minScale, Math.min(maxScale, parsed));
    const normalizedStep = Number.isFinite(step) && step > 0 ? step : 0;
    if (normalizedStep <= 0) return Number(clamped.toFixed(4));
    const snapped = minScale + Math.round((clamped - minScale) / normalizedStep) * normalizedStep;
    const bounded = utils.clampNumber
      ? utils.clampNumber(snapped, minScale, maxScale)
      : Math.max(minScale, Math.min(maxScale, snapped));
    return Number(bounded.toFixed(4));
  }

  function clampRenderScale(raw) {
    const constants = createStoreConstants();
    const utils = createStoreUtils();
    const fallback = constants.RENDER_SCALE_DEFAULT;
    const minScale = constants.RENDER_SCALE_MIN;
    const maxScale = constants.RENDER_SCALE_MAX;
    const step = constants.RENDER_SCALE_STEP;
    const parsed = utils.parseFiniteNumber ? utils.parseFiniteNumber(raw) : Number(raw);
    if (!Number.isFinite(parsed)) return fallback;
    const clamped = utils.clampNumber
      ? utils.clampNumber(parsed, minScale, maxScale)
      : Math.max(minScale, Math.min(maxScale, parsed));
    const normalizedStep = Number.isFinite(step) && step > 0 ? step : 0;
    if (normalizedStep <= 0) return Number(clamped.toFixed(4));
    const snapped = minScale + Math.round((clamped - minScale) / normalizedStep) * normalizedStep;
    const bounded = utils.clampNumber
      ? utils.clampNumber(snapped, minScale, maxScale)
      : Math.max(minScale, Math.min(maxScale, snapped));
    return Number(bounded.toFixed(4));
  }

  function clampGifExportRange(start, end, nFrames) {
    const frameCount = Math.max(0, Number.parseInt(String(nFrames), 10) || 0);
    if (frameCount <= 0) return { start: 0, end: 0 };

    const minIdx = 0;
    const maxIdx = frameCount - 1;
    let s = Number.parseInt(String(start), 10);
    let e = Number.parseInt(String(end), 10);
    if (!Number.isFinite(s)) s = minIdx;
    if (!Number.isFinite(e)) e = maxIdx;
    s = Math.max(minIdx, Math.min(maxIdx, s));
    e = Math.max(minIdx, Math.min(maxIdx, e));
    if (s > e) {
      const tmp = s;
      s = e;
      e = tmp;
    }
    return { start: s, end: e };
  }

  function resolvePayload(action) {
    if (!action || typeof action !== 'object') return {};
    if (action.payload && typeof action.payload === 'object') return action.payload;
    return action;
  }

  function resolveFrameCountFromPayload(payload, state) {
    const fromPayload = Number.parseInt(String(payload.nFrames), 10);
    if (Number.isFinite(fromPayload) && fromPayload >= 0) return fromPayload;
    const fromState = Array.isArray(state.currentCoords) ? state.currentCoords.length : 0;
    return Math.max(0, fromState);
  }

  function createMol3dStore(initialState) {
    const state = initialState && typeof initialState === 'object' ? initialState : {};
    const listeners = new Set();

    function getState() {
      return state;
    }

    function subscribe(listener, keys) {
      if (typeof listener !== 'function') {
        throw new Error('store.subscribe(listener, keys) requires a function listener.');
      }
      const keySet = Array.isArray(keys) && keys.length
        ? new Set(keys.map((value) => String(value)))
        : null;
      const entry = { listener, keySet };
      listeners.add(entry);
      return () => {
        listeners.delete(entry);
      };
    }

    function shouldNotify(entry, changedKeys) {
      if (!entry.keySet) return true;
      for (const key of changedKeys) {
        if (entry.keySet.has(key)) return true;
      }
      return false;
    }

    function notify(changedKeys, action) {
      if (!changedKeys.length) return;
      const frozenKeys = Object.freeze(changedKeys.slice());
      for (const entry of listeners) {
        if (!shouldNotify(entry, frozenKeys)) continue;
        try {
          entry.listener(state, frozenKeys, action);
        } catch (error) {
          console.error('ObservableMol3D store listener failed:', error);
        }
      }
    }

    function setIfChanged(changedKeys, key, value) {
      if (Object.is(state[key], value)) return;
      state[key] = value;
      changedKeys.push(key);
    }

    function dispatch(action) {
      const safeAction = action && typeof action === 'object' ? action : {};
      const payload = resolvePayload(safeAction);
      const type = String(safeAction.type || '');
      const changedKeys = [];

      if (type === 'SET_PLAYBACK_RATE') {
        setIfChanged(changedKeys, 'playbackRate', clampPlaybackRate(payload.rate));
      } else if (type === 'SET_PLAYBACK_STRIDE') {
        setIfChanged(changedKeys, 'playbackStride', clampPlaybackStride(payload.stride));
      } else if (type === 'SET_NAC_USER_SCALE') {
        setIfChanged(changedKeys, 'nacUserScale', clampNacScale(payload.scale));
      } else if (type === 'SET_DE_USER_SCALE') {
        setIfChanged(changedKeys, 'deUserScale', clampNacScale(payload.scale));
      } else if (type === 'SET_DE_NAC_USER_SCALE') {
        setIfChanged(changedKeys, 'deNacUserScale', clampNacScale(payload.scale));
      } else if (type === 'SET_ATOM_SIZE_SCALE') {
        setIfChanged(changedKeys, 'atomSizeScale', clampRenderScale(payload.scale));
      } else if (type === 'SET_BOND_RADIUS_SCALE') {
        setIfChanged(changedKeys, 'bondRadiusScale', clampRenderScale(payload.scale));
      } else if (type === 'SET_HBOND_LINE_SCALE') {
        setIfChanged(changedKeys, 'hbondLineScale', clampRenderScale(payload.scale));
      } else if (type === 'SET_GIF_EXPORTING') {
        setIfChanged(changedKeys, 'isGifExporting', !!payload.exporting);
      } else if (type === 'SET_GIF_EXPORT_RANGE') {
        const frameCount = resolveFrameCountFromPayload(payload, state);
        const range = clampGifExportRange(
          payload.start,
          payload.end,
          frameCount
        );
        setIfChanged(changedKeys, 'gifExportRangeStart', range.start);
        setIfChanged(changedKeys, 'gifExportRangeEnd', range.end);
      }

      notify(changedKeys, safeAction);
      return state;
    }

    return {
      getState,
      dispatch,
      subscribe,
    };
  }

  root.createMol3dStore = createMol3dStore;
})();
