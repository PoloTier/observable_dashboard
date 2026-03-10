(function () {
  const root = window.ObservableMol3D || (window.ObservableMol3D = {});

  function showBootError(message) {
    const statusEl = document.getElementById('status');
    if (statusEl) {
      statusEl.textContent = message;
      statusEl.classList.add('error');
      return;
    }

    const box = document.createElement('div');
    box.style.margin = '12px';
    box.style.padding = '10px 12px';
    box.style.border = '1px solid #d33';
    box.style.borderRadius = '6px';
    box.style.background = '#fff6f6';
    box.style.color = '#b00020';
    box.style.font = '14px/1.4 sans-serif';
    box.textContent = message;
    document.body.prepend(box);
  }

  const constants = root.constants;
  const utils = root.utils;
  const createMol3dStore = root.createMol3dStore;
  if (!constants || !utils || typeof createMol3dStore !== 'function') {
    showBootError('3D page failed to initialize: missing base mol3d modules (constants/utils/store).');
    return;
  }

  function parseScriptJson(id, label, allowTemplateHint = false) {
    const el = document.getElementById(id);
    if (!el) return null;
    const raw = String(el.textContent || '');
    try {
      return JSON.parse(raw);
    } catch (error) {
      let hint = `${label} is not valid JSON.`;
      if (
        allowTemplateHint &&
        (raw.includes('{{ bootstrap_json') || raw.includes('{%'))
      ) {
        hint = 'Detected an unrendered template. Open served /molecule3d.html instead of templates/molecule3d.html.j2.';
      }
      console.error(`ObservableMol3D parse failed for ${id}:`, error);
      showBootError(`3D page failed to initialize: ${hint}`);
      return null;
    }
  }

  const bootstrap = parseScriptJson('bootstrap-json', 'bootstrap-json', true);
  if (!bootstrap) {
    showBootError('3D page failed to initialize: missing bootstrap-json script.');
    return;
  }

  const dataMode = String(bootstrap.data_mode || 'api');
  if (dataMode !== 'api') {
    showBootError(`3D page expects API mode, but received data_mode='${dataMode}'.`);
    return;
  }

  const meta = bootstrap.meta || {};
  const defaults = bootstrap.defaults || {};
  const bootstrapTrajIds = Array.isArray(bootstrap.traj_ids) ? bootstrap.traj_ids : [];
  const metaTrajIds = Array.isArray(meta?.traj_ids) ? meta.traj_ids : [];
  const trajIds = (bootstrapTrajIds.length ? bootstrapTrajIds : metaTrajIds).map((v) => String(v));
  const apiBase = typeof bootstrap.api_base === 'string' && bootstrap.api_base.trim()
    ? bootstrap.api_base
    : '/api';

  const dom = {
    controlsPrimary: document.getElementById('controls-primary'),
    controlsGroups: document.getElementById('controls-groups'),
    measureControlsGroup: document.getElementById('measure-controls-group'),
    playbackControlsGroup: document.getElementById('playback-controls-group'),
    renderControlsGroup: document.getElementById('render-controls-group'),
    nacControlsGroup: document.getElementById('nac-controls-group'),
    gifRangeControlsGroup: document.getElementById('gif-range-controls-group'),
    trajSelect: document.getElementById('traj-select'),
    playBtn: document.getElementById('play-btn'),
    playbackRateSlider: document.getElementById('playback-rate-slider'),
    playbackRateLabel: document.getElementById('playback-rate-label'),
    playbackStrideSlider: document.getElementById('playback-stride-slider'),
    playbackStrideLabel: document.getElementById('playback-stride-label'),
    frameSlider: document.getElementById('frame-slider'),
    frameLabel: document.getElementById('frame-label'),
    showAtomIndexCheckbox: document.getElementById('show-atom-index'),
    atomSizeSlider: document.getElementById('atom-size-slider'),
    atomSizeLabel: document.getElementById('atom-size-label'),
    bondRadiusSlider: document.getElementById('bond-radius-slider'),
    bondRadiusLabel: document.getElementById('bond-radius-label'),
    hbondLineWidthSlider: document.getElementById('hbond-line-width-slider'),
    hbondLineWidthLabel: document.getElementById('hbond-line-width-label'),
    atomStyleRangeInput: document.getElementById('atom-style-range-input'),
    atomStyleModeSelect: document.getElementById('atom-style-mode-select'),
    atomStyleAddBtn: document.getElementById('atom-style-add-btn'),
    atomStyleClearBtn: document.getElementById('atom-style-clear-btn'),
    atomStyleRulesEl: document.getElementById('atom-style-rules'),
    measureTypeBondBtn: document.getElementById('measure-type-bond-btn'),
    measureTypeAngleBtn: document.getElementById('measure-type-angle-btn'),
    measureTypeDihedralBtn: document.getElementById('measure-type-dihedral-btn'),
    selectBondBtn: document.getElementById('select-bond-btn'),
    clearBondBtn: document.getElementById('clear-bond-btn'),
    bondSelectionInfoEl: document.getElementById('bond-selection-info'),
    bondListEl: document.getElementById('bond-list'),
    bondPlotEl: document.getElementById('bond-plot'),
    saveFrameBtn: document.getElementById('save-frame-xyz-btn'),
    saveTrajBtn: document.getElementById('save-traj-xyz-btn'),
    gifExportStartInput: document.getElementById('gif-export-start'),
    gifExportEndInput: document.getElementById('gif-export-end'),
    exportGifBtn: document.getElementById('export-gif-btn'),
    exportVideoBtn: document.getElementById('export-video-btn'),
    cancelGifExportBtn: document.getElementById('cancel-gif-export-btn'),
    gifExportProgressEl: document.getElementById('gif-export-progress'),
    showNacVectorsCheckbox: document.getElementById('show-nac-vectors'),
    nacStateISelect: document.getElementById('nac-state-i'),
    nacStateJSelect: document.getElementById('nac-state-j'),
    nacScaleSlider: document.getElementById('nac-scale-slider'),
    nacScaleLabel: document.getElementById('nac-scale-label'),
    nacRangeLabel: document.getElementById('nac-range-label'),
    showDeVectorsCheckbox: document.getElementById('show-de-vectors'),
    dePairRowsContainer: document.getElementById('de-pair-rows'),
    addDePairBtn: document.getElementById('add-de-pair-btn'),
    dePairRowTemplate: document.getElementById('de-pair-row-template'),
    deScaleSlider: document.getElementById('de-scale-slider'),
    deScaleLabel: document.getElementById('de-scale-label'),
    deRangeLabel: document.getElementById('de-range-label'),
    deVisualHintEl: document.getElementById('de-visual-hint'),
    showDeNacVectorsCheckbox: document.getElementById('show-de-nac-vectors'),
    deNacScaleSlider: document.getElementById('de-nac-scale-slider'),
    deNacScaleLabel: document.getElementById('de-nac-scale-label'),
    deNacRangeLabel: document.getElementById('de-nac-range-label'),
    sourcePklEl: document.getElementById('source-pkl'),
    statusEl: document.getElementById('status'),
    bondColorSettingsBtn: document.getElementById('bond-color-settings-btn'),
    bondColorSettingsPanelEl: document.getElementById('bond-color-settings-panel'),
    bondColorSettingsTitleEl: document.getElementById('bond-color-settings-title'),
    bondColorSettingsCloseBtn: document.getElementById('bond-color-settings-close-btn'),
    bondColorSettingsListEl: document.getElementById('bond-color-settings-list'),
    viewerEl: document.getElementById('viewer'),
    showHydrogenBondsCheckbox: document.getElementById('show-hydrogen-bonds'),
    hbondControlsGroup: document.getElementById('hbond-controls-group'),
  };

  const measureTypeButtons = {
    bond: dom.measureTypeBondBtn,
    angle: dom.measureTypeAngleBtn,
    dihedral: dom.measureTypeDihedralBtn,
  };

  const state = {
    viewer: null,
    timer: null,
    isPlaying: false,
    playbackRate: constants.PLAYBACK_RATE_DEFAULT,
    playbackStride: constants.PLAYBACK_STRIDE_DEFAULT,
    atomSizeScale: constants.RENDER_SCALE_DEFAULT,
    bondRadiusScale: constants.RENDER_SCALE_DEFAULT,
    hbondLineScale: 1.8,
    atomRenderRules: [],
    atomRenderRuleNextId: 1,
    isGifExporting: false,
    gifExportCancelRequested: false,
    gifExportTask: null,
    videoExportTask: null,
    activeExportKind: '',
    gifExportRangeStart: 0,
    gifExportRangeEnd: 0,
    currentTrajId: null,
    xyzFrames: [],
    currentFrame: 0,
    currentCoords: [],
    currentTimes: [],
    currentModel: null,
    nacAvailable: false,
    nacStateCount: 0,
    nacComponentCount: 0,
    deAvailable: false,
    deStateCount: 0,
    deComponentCount: 0,
    deGlobalNormScope: '',
    deGlobalNormP5: null,
    deGlobalNormP90: null,
    deGlobalNormP95: null,
    deGlobalNormCount: 0,
    deNacAvailable: false,
    deNacStateCount: 0,
    deNacComponentCount: 0,
    showNacVectors: false,
    showDeVectors: false,
    showDeNacVectors: false,
    nacStateI: 0,
    nacStateJ: 1,
    deStateI: 0,
    deStateJ: 0,
    deRows: [],
    deNextRowId: 1,
    nacVectors: [],
    nacTimes: [],
    nacCurrentPairKey: null,
    nacUserScale: constants.NAC_SCALE_DEFAULT,
    nacAutoBaseScale: 1,
    nacMagnitudeRange: null,
    isNacLoading: false,
    deVectors: [],
    deTimes: [],
    deCurrentPairKey: null,
    deUserScale: constants.NAC_SCALE_DEFAULT,
    deAutoBaseScale: 1,
    deMagnitudeRange: null,
    isDeLoading: false,
    deNacVectors: [],
    deNacTimes: [],
    deNacCurrentPairKey: null,
    deNacUserScale: constants.NAC_SCALE_DEFAULT,
    deNacAutoBaseScale: 1,
    deNacMagnitudeRange: null,
    isDeNacLoading: false,
    activeMeasureType: 'bond',
    isMeasureSelectMode: false,
    pendingAtomIndices: [],
    measurementTracks: {
      bond: [],
      angle: [],
      dihedral: [],
    },
    highlightedKeysByType: {
      bond: new Set(),
      angle: new Set(),
      dihedral: new Set(),
    },
    measurementPlotReady: false,
    isMeasurementColorSettingsOpen: false,
    showHydrogenBonds: false,
    hbondCache: null,
    atomNumbers: [],
  };

  const store = createMol3dStore(state);
  const dispatch = (action) => store.dispatch(action);
  const subscribe = (listener, keys) => store.subscribe(listener, keys);

  const actions = Object.freeze({
    setPlaybackRate(rate) {
      return { type: 'SET_PLAYBACK_RATE', payload: { rate } };
    },
    setPlaybackStride(stride) {
      return { type: 'SET_PLAYBACK_STRIDE', payload: { stride } };
    },
    setAtomSizeScale(scale) {
      return { type: 'SET_ATOM_SIZE_SCALE', payload: { scale } };
    },
    setBondRadiusScale(scale) {
      return { type: 'SET_BOND_RADIUS_SCALE', payload: { scale } };
    },
    setHbondLineScale(scale) {
      return { type: 'SET_HBOND_LINE_SCALE', payload: { scale } };
    },
    setNacUserScale(scale) {
      return { type: 'SET_NAC_USER_SCALE', payload: { scale } };
    },
    setDeUserScale(scale) {
      return { type: 'SET_DE_USER_SCALE', payload: { scale } };
    },
    setDeNacUserScale(scale) {
      return { type: 'SET_DE_NAC_USER_SCALE', payload: { scale } };
    },
    setGifExporting(exporting) {
      return { type: 'SET_GIF_EXPORTING', payload: { exporting } };
    },
    setGifExportRange(start, end, nFrames) {
      return {
        type: 'SET_GIF_EXPORT_RANGE',
        payload: { start, end, nFrames },
      };
    },
  });

  function setStatus(message, isError = false) {
    if (!dom.statusEl) return;
    dom.statusEl.textContent = message || '';
    dom.statusEl.classList.toggle('error', !!isError);
  }

  function clampNumber(value, min, max) {
    return utils.clampNumber(value, min, max);
  }

  function parseFiniteNumber(raw) {
    return utils.parseFiniteNumber(raw);
  }

  function clampPlaybackRate(raw) {
    const fallback = constants.PLAYBACK_RATE_DEFAULT;
    const minRate = constants.PLAYBACK_RATE_MIN;
    const maxRate = constants.PLAYBACK_RATE_MAX;
    const step = constants.PLAYBACK_RATE_STEP;
    const parsed = parseFiniteNumber(raw);
    if (parsed === null) return fallback;
    const clamped = clampNumber(parsed, minRate, maxRate);
    if (!Number.isFinite(step) || step <= 0) return clamped;
    const snapped = minRate + Math.round((clamped - minRate) / step) * step;
    return Number(clampNumber(snapped, minRate, maxRate).toFixed(4));
  }

  function formatPlaybackRate(rate) {
    return `${clampPlaybackRate(rate).toFixed(1)}x`;
  }

  function syncPlaybackRateUi() {
    const playbackRate = clampPlaybackRate(state.playbackRate);
    if (dom.playbackRateSlider) {
      dom.playbackRateSlider.min = String(constants.PLAYBACK_RATE_MIN);
      dom.playbackRateSlider.max = String(constants.PLAYBACK_RATE_MAX);
      dom.playbackRateSlider.step = String(constants.PLAYBACK_RATE_STEP);
      dom.playbackRateSlider.value = String(playbackRate);
    }
    if (dom.playbackRateLabel) {
      dom.playbackRateLabel.textContent = formatPlaybackRate(playbackRate);
    }
  }

  function clampPlaybackStride(raw) {
    const fallback = constants.PLAYBACK_STRIDE_DEFAULT;
    const minStride = constants.PLAYBACK_STRIDE_MIN;
    const maxStride = constants.PLAYBACK_STRIDE_MAX;
    const step = constants.PLAYBACK_STRIDE_STEP;
    const parsed = parseFiniteNumber(raw);
    if (parsed === null) return fallback;
    const clamped = clampNumber(parsed, minStride, maxStride);
    const normalizedStep = Number.isFinite(step) && step > 0 ? step : 1;
    const snapped = minStride + Math.round((clamped - minStride) / normalizedStep) * normalizedStep;
    return clampNumber(Math.trunc(snapped), minStride, maxStride);
  }

  function formatPlaybackStride(stride) {
    return `x${clampPlaybackStride(stride)}`;
  }

  function syncPlaybackStrideUi() {
    const playbackStride = clampPlaybackStride(state.playbackStride);
    if (dom.playbackStrideSlider) {
      dom.playbackStrideSlider.min = String(constants.PLAYBACK_STRIDE_MIN);
      dom.playbackStrideSlider.max = String(constants.PLAYBACK_STRIDE_MAX);
      dom.playbackStrideSlider.step = String(constants.PLAYBACK_STRIDE_STEP);
      dom.playbackStrideSlider.value = String(playbackStride);
    }
    if (dom.playbackStrideLabel) {
      dom.playbackStrideLabel.textContent = formatPlaybackStride(playbackStride);
    }
  }

  function clampAtomSizeScale(raw) {
    const fallback = constants.RENDER_SCALE_DEFAULT;
    const minScale = constants.RENDER_SCALE_MIN;
    const maxScale = constants.RENDER_SCALE_MAX;
    const step = constants.RENDER_SCALE_STEP;
    const parsed = parseFiniteNumber(raw);
    if (parsed === null) return fallback;
    const clamped = clampNumber(parsed, minScale, maxScale);
    const normalizedStep = Number.isFinite(step) && step > 0 ? step : 0;
    if (normalizedStep <= 0) return Number(clamped.toFixed(4));
    const snapped = minScale + Math.round((clamped - minScale) / normalizedStep) * normalizedStep;
    return Number(clampNumber(snapped, minScale, maxScale).toFixed(4));
  }

  function formatAtomSizeScale(scale) {
    return `${clampAtomSizeScale(scale).toFixed(1)}x`;
  }

  function syncAtomSizeScaleUi() {
    const atomSizeScale = clampAtomSizeScale(state.atomSizeScale);
    if (dom.atomSizeSlider) {
      dom.atomSizeSlider.min = String(constants.RENDER_SCALE_MIN);
      dom.atomSizeSlider.max = String(constants.RENDER_SCALE_MAX);
      dom.atomSizeSlider.step = String(constants.RENDER_SCALE_STEP);
      dom.atomSizeSlider.value = String(atomSizeScale);
    }
    if (dom.atomSizeLabel) {
      dom.atomSizeLabel.textContent = formatAtomSizeScale(atomSizeScale);
    }
  }

  function clampBondRadiusScale(raw) {
    return clampAtomSizeScale(raw);
  }

  function formatBondRadiusScale(scale) {
    return `${clampBondRadiusScale(scale).toFixed(1)}x`;
  }

  function syncBondRadiusScaleUi() {
    const bondRadiusScale = clampBondRadiusScale(state.bondRadiusScale);
    if (dom.bondRadiusSlider) {
      dom.bondRadiusSlider.min = String(constants.RENDER_SCALE_MIN);
      dom.bondRadiusSlider.max = String(constants.RENDER_SCALE_MAX);
      dom.bondRadiusSlider.step = String(constants.RENDER_SCALE_STEP);
      dom.bondRadiusSlider.value = String(bondRadiusScale);
    }
    if (dom.bondRadiusLabel) {
      dom.bondRadiusLabel.textContent = formatBondRadiusScale(bondRadiusScale);
    }
  }

  function clampHbondLineScale(raw) {
    return clampAtomSizeScale(raw);
  }

  function formatHbondLineScale(scale) {
    return `${clampHbondLineScale(scale).toFixed(1)}x`;
  }

  function syncHbondLineScaleUi() {
    const hbondLineScale = clampHbondLineScale(state.hbondLineScale);
    if (dom.hbondLineWidthSlider) {
      dom.hbondLineWidthSlider.min = String(constants.RENDER_SCALE_MIN);
      dom.hbondLineWidthSlider.max = String(constants.RENDER_SCALE_MAX);
      dom.hbondLineWidthSlider.step = String(constants.RENDER_SCALE_STEP);
      dom.hbondLineWidthSlider.value = String(hbondLineScale);
    }
    if (dom.hbondLineWidthLabel) {
      dom.hbondLineWidthLabel.textContent = formatHbondLineScale(hbondLineScale);
    }
  }

  function clampNacScale(raw) {
    const fallback = constants.NAC_SCALE_DEFAULT;
    const minScale = constants.NAC_SCALE_MIN;
    const maxScale = constants.NAC_SCALE_MAX;
    const step = constants.NAC_SCALE_STEP;
    const parsed = parseFiniteNumber(raw);
    if (parsed === null) return fallback;
    const clamped = clampNumber(parsed, minScale, maxScale);
    const normalizedStep = Number.isFinite(step) && step > 0 ? step : 0;
    if (normalizedStep <= 0) return Number(clamped.toFixed(4));
    const snapped = minScale + Math.round((clamped - minScale) / normalizedStep) * normalizedStep;
    return Number(clampNumber(snapped, minScale, maxScale).toFixed(4));
  }

  function formatNacScale(scale) {
    return `${clampNacScale(scale).toFixed(1)}x`;
  }

  function syncNacScaleUi() {
    const nacScale = clampNacScale(state.nacUserScale);
    if (dom.nacScaleSlider) {
      dom.nacScaleSlider.min = String(constants.NAC_SCALE_MIN);
      dom.nacScaleSlider.max = String(constants.NAC_SCALE_MAX);
      dom.nacScaleSlider.step = String(constants.NAC_SCALE_STEP);
      dom.nacScaleSlider.value = String(nacScale);
    }
    if (dom.nacScaleLabel) {
      dom.nacScaleLabel.textContent = formatNacScale(nacScale);
    }
  }

  function clampDeScale(raw) {
    return clampNacScale(raw);
  }

  function formatDeScale(scale) {
    return `${clampDeScale(scale).toFixed(1)}x`;
  }

  function syncDeScaleUi() {
    const deScale = clampDeScale(state.deUserScale);
    if (dom.deScaleSlider) {
      dom.deScaleSlider.min = String(constants.NAC_SCALE_MIN);
      dom.deScaleSlider.max = String(constants.NAC_SCALE_MAX);
      dom.deScaleSlider.step = String(constants.NAC_SCALE_STEP);
      dom.deScaleSlider.value = String(deScale);
    }
    if (dom.deScaleLabel) {
      dom.deScaleLabel.textContent = formatDeScale(deScale);
    }
  }

  function clampDeNacScale(raw) {
    return clampNacScale(raw);
  }

  function formatDeNacScale(scale) {
    return `${clampDeNacScale(scale).toFixed(1)}x`;
  }

  function syncDeNacScaleUi() {
    const deNacScale = clampDeNacScale(state.deNacUserScale);
    if (dom.deNacScaleSlider) {
      dom.deNacScaleSlider.min = String(constants.NAC_SCALE_MIN);
      dom.deNacScaleSlider.max = String(constants.NAC_SCALE_MAX);
      dom.deNacScaleSlider.step = String(constants.NAC_SCALE_STEP);
      dom.deNacScaleSlider.value = String(deNacScale);
    }
    if (dom.deNacScaleLabel) {
      dom.deNacScaleLabel.textContent = formatDeNacScale(deNacScale);
    }
  }

  function clampGifExportRange(start, end, nFrames) {
    const frameCount = Math.max(0, Number.parseInt(String(nFrames), 10) || 0);
    if (frameCount <= 0) {
      return { start: 0, end: 0 };
    }
    const minIdx = 0;
    const maxIdx = frameCount - 1;

    let s = Number.parseInt(String(start), 10);
    let e = Number.parseInt(String(end), 10);
    if (!Number.isFinite(s)) s = minIdx;
    if (!Number.isFinite(e)) e = maxIdx;

    s = Math.max(minIdx, Math.min(maxIdx, s));
    e = Math.max(minIdx, Math.min(maxIdx, e));
    if (s > e) {
      const temp = s;
      s = e;
      e = temp;
    }
    return { start: s, end: e };
  }

  function effectivePlaybackFps() {
    const sourceFps = constants.BASE_FPS * clampPlaybackRate(state.playbackRate);
    const stride = clampPlaybackStride(state.playbackStride);
    const rawFps = sourceFps / stride;
    const minFps = constants.GIF_EXPORT_MIN_FPS;
    const maxFps = constants.GIF_EXPORT_MAX_FPS;
    const safeFps = Number.isFinite(rawFps) ? rawFps : minFps;
    return Math.max(minFps, Math.min(maxFps, safeFps));
  }

  function syncGifExportRangeUi() {
    const frameCount = Array.isArray(state.xyzFrames) ? state.xyzFrames.length : 0;
    const range = clampGifExportRange(state.gifExportRangeStart, state.gifExportRangeEnd, frameCount);
    const maxIdx = Math.max(0, frameCount - 1);
    if (dom.gifExportStartInput) {
      dom.gifExportStartInput.min = '0';
      dom.gifExportStartInput.max = String(maxIdx);
      dom.gifExportStartInput.step = '1';
      dom.gifExportStartInput.value = String(range.start);
      dom.gifExportStartInput.disabled = frameCount <= 0 || state.isGifExporting;
    }
    if (dom.gifExportEndInput) {
      dom.gifExportEndInput.min = '0';
      dom.gifExportEndInput.max = String(maxIdx);
      dom.gifExportEndInput.step = '1';
      dom.gifExportEndInput.value = String(range.end);
      dom.gifExportEndInput.disabled = frameCount <= 0 || state.isGifExporting;
    }
  }

  function syncGifExportControlsUi() {
    const hasFrames = !!state.currentTrajId && Array.isArray(state.xyzFrames) && state.xyzFrames.length > 0;
    const exporting = !!state.isGifExporting;
    if (dom.exportGifBtn) {
      dom.exportGifBtn.disabled = exporting || !hasFrames;
    }
    if (dom.exportVideoBtn) {
      dom.exportVideoBtn.disabled = exporting || !hasFrames;
    }
    if (dom.cancelGifExportBtn) {
      dom.cancelGifExportBtn.hidden = !exporting;
      dom.cancelGifExportBtn.disabled = !exporting;
      if (exporting) {
        const kind = state.activeExportKind === 'video' ? 'Video' : 'GIF';
        dom.cancelGifExportBtn.textContent = 'Cancel ' + kind;
      } else {
        dom.cancelGifExportBtn.textContent = 'Cancel Export';
      }
    }
    syncGifExportRangeUi();
  }

  function setGifExportUiState(exporting) {
    dispatch(actions.setGifExporting(exporting));
    syncGifExportControlsUi();
  }

  function setGifExportProgress(current, total, label = 'GIF') {
    if (!dom.gifExportProgressEl) return;
    const nTotal = Number.parseInt(String(total), 10) || 0;
    if (nTotal <= 0) {
      dom.gifExportProgressEl.textContent = '';
      return;
    }
    const nCurrent = Math.max(0, Math.min(nTotal, Number.parseInt(String(current), 10) || 0));
    const percent = Math.round((nCurrent / nTotal) * 100);
    const prefix = String(label || 'GIF').trim().toUpperCase() || 'GIF';
    dom.gifExportProgressEl.textContent = prefix + ' ' + nCurrent + '/' + nTotal + ' (' + percent + '%)';
  }

  function getControlsGroupElement(groupKey) {
    if (groupKey === 'measure') return dom.measureControlsGroup;
    if (groupKey === 'playback') return dom.playbackControlsGroup;
    if (groupKey === 'render') return dom.renderControlsGroup;
    if (groupKey === 'nac') return dom.nacControlsGroup;
    if (groupKey === 'gifRange') return dom.gifRangeControlsGroup;
    return null;
  }

  function setControlsGroupOpen(groupKey, open) {
    const groupEl = getControlsGroupElement(groupKey);
    if (!groupEl) return false;
    if (open) {
      groupEl.setAttribute('open', '');
    } else {
      groupEl.removeAttribute('open');
    }
    return true;
  }

  function getControlsGroupOpen(groupKey) {
    const groupEl = getControlsGroupElement(groupKey);
    if (!groupEl) return false;
    return groupEl.hasAttribute('open');
  }

  function normalizeMeasureType(type) {
    return constants.MEASURE_META[type] ? type : 'bond';
  }

  function getMeasureMeta(type = state.activeMeasureType) {
    return constants.MEASURE_META[normalizeMeasureType(type)];
  }

  function getTracks(type = state.activeMeasureType) {
    return state.measurementTracks[normalizeMeasureType(type)];
  }

  function getHighlightedKeys(type = state.activeMeasureType) {
    return state.highlightedKeysByType[normalizeMeasureType(type)];
  }

  function getTrackLabel(track) {
    return Array.isArray(track?.atoms) ? track.atoms.join('-') : '';
  }

  function normalizeHexColor(color) {
    return utils.normalizeHexColor(color);
  }

  function sanitizeColorInput(color) {
    return utils.sanitizeColorInput(color);
  }

  function getNextColor(type) {
    const tracks = getTracks(type);
    return constants.BOND_COLOR_PALETTE[tracks.length % constants.BOND_COLOR_PALETTE.length];
  }

  function setColorSettingsOpen(open) {
    state.isMeasurementColorSettingsOpen = !!open;
    if (dom.bondColorSettingsPanelEl) {
      dom.bondColorSettingsPanelEl.hidden = !state.isMeasurementColorSettingsOpen;
    }
    if (dom.bondColorSettingsBtn) {
      dom.bondColorSettingsBtn.classList.toggle('active', state.isMeasurementColorSettingsOpen);
      dom.bondColorSettingsBtn.setAttribute('aria-expanded', state.isMeasurementColorSettingsOpen ? 'true' : 'false');
    }
  }

  function setDownloadButtonsEnabled(enabled) {
    const disabled = !enabled;
    if (dom.saveFrameBtn) dom.saveFrameBtn.disabled = disabled;
    if (dom.saveTrajBtn) dom.saveTrajBtn.disabled = disabled;
    syncGifExportControlsUi();
  }

  function setNacRangeLabel(text) {
    if (!dom.nacRangeLabel) return;
    const normalized = String(text || '').trim();
    dom.nacRangeLabel.textContent = normalized || '|NAC|: n/a';
  }

  function setDeRangeLabel(text) {
    if (!dom.deRangeLabel) return;
    const normalized = String(text || '').trim();
    dom.deRangeLabel.textContent = normalized || '|dE|: n/a';
  }

  function setDeNacRangeLabel(text) {
    if (!dom.deNacRangeLabel) return;
    const normalized = String(text || '').trim();
    dom.deNacRangeLabel.textContent = normalized || '|dE*NAC|: n/a';
  }

  function setNacControlsEnabled(enabled) {
    const hasNac = !!enabled && !!state.nacAvailable && state.nacStateCount >= 2;
    const hasDe = !!enabled && !!state.deAvailable && state.deStateCount >= 1;
    const hasDeNac = !!enabled && !!state.deNacAvailable && state.deNacStateCount >= 2;

    const hasAnyPairVector = hasNac || hasDeNac;
    const pairStateCount = Math.max(
      hasNac ? Number(state.nacStateCount) : 0,
      hasDeNac ? Number(state.deNacStateCount) : 0
    );
    const pairSelectLoading = !!state.isNacLoading || !!state.isDeNacLoading;
    const selectDisabled = !hasAnyPairVector || pairSelectLoading || pairStateCount < 2;

    const deRowsLoading = !!state.isDeLoading;
    const deRowsDisabled = !hasDe || deRowsLoading;

    const nacScaleDisabled = !hasNac || state.isNacLoading || !state.showNacVectors;
    const deScaleDisabled = !hasDe || state.isDeLoading || !state.showDeVectors;
    const deNacScaleDisabled = !hasDeNac || state.isDeNacLoading || !state.showDeNacVectors;

    if (dom.showNacVectorsCheckbox) {
      dom.showNacVectorsCheckbox.checked = !!state.showNacVectors;
      dom.showNacVectorsCheckbox.disabled = !hasNac || state.isNacLoading;
    }
    if (dom.showDeVectorsCheckbox) {
      dom.showDeVectorsCheckbox.checked = !!state.showDeVectors;
      dom.showDeVectorsCheckbox.disabled = !hasDe || state.isDeLoading;
    }
    if (dom.showDeNacVectorsCheckbox) {
      dom.showDeNacVectorsCheckbox.checked = !!state.showDeNacVectors;
      dom.showDeNacVectorsCheckbox.disabled = !hasDeNac || state.isDeNacLoading;
    }

    if (dom.nacStateISelect) dom.nacStateISelect.disabled = selectDisabled;
    if (dom.nacStateJSelect) dom.nacStateJSelect.disabled = selectDisabled;

    if (dom.addDePairBtn) {
      dom.addDePairBtn.disabled = deRowsDisabled;
    }
    if (dom.dePairRowsContainer) {
      const rows = dom.dePairRowsContainer.querySelectorAll('.de-pair-row');
      const rowCount = Math.max(0, Number.parseInt(String(state.deRows?.length || 0), 10) || 0);
      for (const rowEl of rows) {
        const enableInput = rowEl.querySelector('.de-row-enabled');
        const stateISelect = rowEl.querySelector('.de-row-state-i');
        const stateJSelect = rowEl.querySelector('.de-row-state-j');
        const removeBtn = rowEl.querySelector('.de-row-remove-btn');
        if (enableInput) enableInput.disabled = deRowsDisabled;
        if (stateISelect) stateISelect.disabled = deRowsDisabled;
        if (stateJSelect) stateJSelect.disabled = deRowsDisabled;
        if (removeBtn) removeBtn.disabled = deRowsDisabled || rowCount <= 1;
      }
    }

    if (dom.nacScaleSlider) dom.nacScaleSlider.disabled = nacScaleDisabled;
    if (dom.deScaleSlider) dom.deScaleSlider.disabled = deScaleDisabled;
    if (dom.deNacScaleSlider) dom.deNacScaleSlider.disabled = deNacScaleDisabled;
    if (dom.deVisualHintEl) {
      dom.deVisualHintEl.style.opacity = hasDe ? '1' : '0.55';
    }
  }

  const ATOM_RENDER_MODES = Object.freeze(['sphere', 'stick', 'line', 'cartoon']);
  const ATOM_RENDER_RULE_MAX_SPAN = 20000;

  function getCurrentAtomCount() {
    const frame0 = Array.isArray(state.currentCoords) ? state.currentCoords[0] : null;
    return Array.isArray(frame0) ? frame0.length : 0;
  }

  function getSupportedAtomRenderModes() {
    return ATOM_RENDER_MODES.slice();
  }

  function normalizeAtomRenderMode(rawMode) {
    const mode = String(rawMode || '').trim().toLowerCase();
    return ATOM_RENDER_MODES.includes(mode) ? mode : null;
  }

  function parseAtomIndexRuleSpec(rawSpec, atomCount = null) {
    const text = String(rawSpec || '').trim();
    if (!text) {
      return { indices: [], error: 'Please enter atom indices/ranges (0-based).' };
    }

    const indexSet = new Set();
    const segments = text.split(',');
    for (const segmentRaw of segments) {
      const segment = segmentRaw.trim();
      if (!segment) {
        return { indices: [], error: 'Invalid atom index rule: empty segment.' };
      }

      if (/^\d+$/.test(segment)) {
        indexSet.add(Number.parseInt(segment, 10));
        continue;
      }

      const rangeMatch = segment.match(/^(\d+)\s*-\s*(\d+)$/);
      if (rangeMatch) {
        let start = Number.parseInt(rangeMatch[1], 10);
        let end = Number.parseInt(rangeMatch[2], 10);
        if (!Number.isFinite(start) || !Number.isFinite(end)) {
          return { indices: [], error: `Invalid atom index segment '${segment}'.` };
        }
        if (end < start) {
          const tmp = start;
          start = end;
          end = tmp;
        }
        if (end - start > ATOM_RENDER_RULE_MAX_SPAN) {
          return { indices: [], error: `Atom range '${segment}' is too large.` };
        }
        for (let idx = start; idx <= end; idx++) {
          indexSet.add(idx);
        }
        continue;
      }

      const openEndedMatch = segment.match(/^(\d+)\s*-\s*$/);
      if (openEndedMatch) {
        const start = Number.parseInt(openEndedMatch[1], 10);
        if (!Number.isFinite(start)) {
          return { indices: [], error: `Invalid atom index segment '${segment}'.` };
        }
        const resolvedAtomCount = Number.parseInt(String(atomCount), 10);
        if (!Number.isFinite(resolvedAtomCount) || resolvedAtomCount <= 0) {
          return { indices: [], error: `Segment '${segment}' requires a loaded trajectory.` };
        }
        const end = resolvedAtomCount - 1;
        if (start > end) {
          return { indices: [], error: `Atom index ${start} is out of range. Valid range: 0-${end}.` };
        }
        if (end - start > ATOM_RENDER_RULE_MAX_SPAN) {
          return { indices: [], error: `Atom range '${segment}' is too large.` };
        }
        for (let idx = start; idx <= end; idx++) {
          indexSet.add(idx);
        }
        continue;
      }

      return { indices: [], error: `Invalid atom index segment '${segment}'. Use N, A-B, or A-.` };
    }

    const indices = Array.from(indexSet).sort((a, b) => a - b);
    if (!indices.length) {
      return { indices: [], error: 'No valid atom indices were found in the rule.' };
    }
    return { indices, error: '' };
  }

  function formatAtomIndexRuleSpec(indices) {
    if (!Array.isArray(indices) || !indices.length) return '';

    const sorted = Array.from(new Set(indices
      .map((value) => Number.parseInt(String(value), 10))
      .filter((value) => Number.isFinite(value) && value >= 0)))
      .sort((a, b) => a - b);
    if (!sorted.length) return '';

    const parts = [];
    let start = sorted[0];
    let prev = sorted[0];
    for (let idx = 1; idx < sorted.length; idx++) {
      const value = sorted[idx];
      if (value === prev + 1) {
        prev = value;
        continue;
      }
      parts.push(start === prev ? String(start) : `${start}-${prev}`);
      start = value;
      prev = value;
    }
    parts.push(start === prev ? String(start) : `${start}-${prev}`);
    return parts.join(', ');
  }

  function renderAtomRenderRulesUi() {
    if (!dom.atomStyleRulesEl) return;

    const rules = Array.isArray(state.atomRenderRules) ? state.atomRenderRules : [];
    dom.atomStyleRulesEl.innerHTML = '';
    if (!rules.length) {
      const emptyEl = document.createElement('div');
      emptyEl.className = 'atom-style-rule-empty';
      emptyEl.textContent = 'No per-atom style rules. Using default style.';
      dom.atomStyleRulesEl.appendChild(emptyEl);
      if (dom.atomStyleClearBtn) dom.atomStyleClearBtn.disabled = true;
      return;
    }

    for (const rule of rules) {
      const rowEl = document.createElement('div');
      rowEl.className = 'atom-style-rule-row';
      rowEl.dataset.atomStyleRuleId = String(rule.id);

      const modeEl = document.createElement('span');
      modeEl.className = 'atom-style-rule-mode';
      modeEl.textContent = String(rule.mode || '');
      rowEl.appendChild(modeEl);

      const specEl = document.createElement('span');
      specEl.className = 'atom-style-rule-spec';
      specEl.textContent = String(rule.rawSpec || '');
      rowEl.appendChild(specEl);

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'atom-style-rule-remove-btn';
      removeBtn.dataset.atomStyleRuleId = String(rule.id);
      removeBtn.textContent = 'Remove';
      rowEl.appendChild(removeBtn);

      dom.atomStyleRulesEl.appendChild(rowEl);
    }

    if (dom.atomStyleClearBtn) dom.atomStyleClearBtn.disabled = false;
  }

  function addAtomRenderRule(rawSpec, rawMode) {
    const atomCount = getCurrentAtomCount();
    if (atomCount <= 0) {
      setStatus('Load a trajectory before adding atom-style rules.', true);
      return null;
    }

    const mode = normalizeAtomRenderMode(rawMode);
    if (!mode) {
      setStatus('Invalid render mode. Supported: sphere, stick, line, cartoon.', true);
      return null;
    }

    const parsed = parseAtomIndexRuleSpec(rawSpec, atomCount);
    if (parsed.error) {
      setStatus(parsed.error, true);
      return null;
    }

    const outOfRange = parsed.indices.find((index) => index < 0 || index >= atomCount);
    if (Number.isFinite(outOfRange)) {
      setStatus(`Atom index ${outOfRange} is out of range. Valid range: 0-${atomCount - 1}.`, true);
      return null;
    }

    if (!Array.isArray(state.atomRenderRules)) {
      state.atomRenderRules = [];
    }
    const nextId = Number.parseInt(String(state.atomRenderRuleNextId), 10);
    const ruleId = Number.isFinite(nextId) && nextId > 0 ? nextId : 1;
    state.atomRenderRuleNextId = ruleId + 1;

    const rule = {
      id: ruleId,
      rawSpec: formatAtomIndexRuleSpec(parsed.indices),
      indices: parsed.indices.slice(),
      mode,
    };
    state.atomRenderRules.push(rule);
    renderAtomRenderRulesUi();
    return rule;
  }

  function removeAtomRenderRule(rawRuleId) {
    if (!Array.isArray(state.atomRenderRules) || !state.atomRenderRules.length) return false;
    const ruleId = Number.parseInt(String(rawRuleId), 10);
    if (!Number.isFinite(ruleId)) return false;

    const idx = state.atomRenderRules.findIndex((rule) => Number.parseInt(String(rule?.id), 10) === ruleId);
    if (idx < 0) return false;
    state.atomRenderRules.splice(idx, 1);
    renderAtomRenderRulesUi();
    return true;
  }

  function clearAtomRenderRules() {
    if (!Array.isArray(state.atomRenderRules) || !state.atomRenderRules.length) {
      renderAtomRenderRulesUi();
      return 0;
    }
    const cleared = state.atomRenderRules.length;
    state.atomRenderRules = [];
    renderAtomRenderRulesUi();
    return cleared;
  }

  function sanitizeFilenamePart(text) {
    return utils.sanitizeFilenamePart(text);
  }

  subscribe(syncPlaybackRateUi, ['playbackRate']);
  subscribe(syncPlaybackStrideUi, ['playbackStride']);
  subscribe(syncAtomSizeScaleUi, ['atomSizeScale']);
  subscribe(syncBondRadiusScaleUi, ['bondRadiusScale']);
  subscribe(syncHbondLineScaleUi, ['hbondLineScale']);
  subscribe(syncNacScaleUi, ['nacUserScale']);
  subscribe(syncDeScaleUi, ['deUserScale']);
  subscribe(syncDeNacScaleUi, ['deNacUserScale']);
  subscribe(syncGifExportControlsUi, ['gifExportRangeStart', 'gifExportRangeEnd', 'isGifExporting']);

  syncPlaybackRateUi();
  syncPlaybackStrideUi();
  syncAtomSizeScaleUi();
  syncBondRadiusScaleUi();
  syncHbondLineScaleUi();
  syncNacScaleUi();
  syncDeScaleUi();
  syncDeNacScaleUi();
  syncGifExportControlsUi();
  setGifExportProgress(0, 0);
  setNacRangeLabel('|NAC|: n/a');
  setDeRangeLabel('|dE|: n/a');
  setDeNacRangeLabel('|dE*NAC|: n/a');
  setNacControlsEnabled(false);
  renderAtomRenderRulesUi();

  root.shared = {
    bootstrap,
    meta,
    defaults,
    trajIds,
    dataMode,
    apiBase,
    dom,
    constants,
    measureTypeButtons,
    state,
    store,
    actions,
    dispatch,
    subscribe,
    setStatus,
    clampNumber,
    parseFiniteNumber,
    clampPlaybackRate,
    formatPlaybackRate,
    syncPlaybackRateUi,
    clampPlaybackStride,
    formatPlaybackStride,
    syncPlaybackStrideUi,
    clampAtomSizeScale,
    formatAtomSizeScale,
    syncAtomSizeScaleUi,
    clampBondRadiusScale,
    formatBondRadiusScale,
    syncBondRadiusScaleUi,
    clampHbondLineScale,
    formatHbondLineScale,
    syncHbondLineScaleUi,
    clampNacScale,
    formatNacScale,
    syncNacScaleUi,
    clampDeScale,
    formatDeScale,
    syncDeScaleUi,
    clampDeNacScale,
    formatDeNacScale,
    syncDeNacScaleUi,
    clampGifExportRange,
    effectivePlaybackFps,
    syncGifExportRangeUi,
    setGifExportUiState,
    setGifExportProgress,
    setControlsGroupOpen,
    getControlsGroupOpen,
    normalizeMeasureType,
    getMeasureMeta,
    getTracks,
    getHighlightedKeys,
    getTrackLabel,
    normalizeHexColor,
    sanitizeColorInput,
    getNextColor,
    setColorSettingsOpen,
    setDownloadButtonsEnabled,
    setNacRangeLabel,
    setDeRangeLabel,
    setDeNacRangeLabel,
    setNacControlsEnabled,
    getCurrentAtomCount,
    getSupportedAtomRenderModes,
    normalizeAtomRenderMode,
    parseAtomIndexRuleSpec,
    formatAtomIndexRuleSpec,
    renderAtomRenderRulesUi,
    addAtomRenderRule,
    removeAtomRenderRule,
    clearAtomRenderRules,
    sanitizeFilenamePart,
  };
})();
