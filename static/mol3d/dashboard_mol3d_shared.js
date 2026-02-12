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
    trajSelect: document.getElementById('traj-select'),
    playBtn: document.getElementById('play-btn'),
    playbackRateSlider: document.getElementById('playback-rate-slider'),
    playbackRateLabel: document.getElementById('playback-rate-label'),
    playbackStrideSlider: document.getElementById('playback-stride-slider'),
    playbackStrideLabel: document.getElementById('playback-stride-label'),
    frameSlider: document.getElementById('frame-slider'),
    frameLabel: document.getElementById('frame-label'),
    showAtomIndexCheckbox: document.getElementById('show-atom-index'),
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
    sourcePklEl: document.getElementById('source-pkl'),
    statusEl: document.getElementById('status'),
    bondColorSettingsBtn: document.getElementById('bond-color-settings-btn'),
    bondColorSettingsPanelEl: document.getElementById('bond-color-settings-panel'),
    bondColorSettingsTitleEl: document.getElementById('bond-color-settings-title'),
    bondColorSettingsCloseBtn: document.getElementById('bond-color-settings-close-btn'),
    bondColorSettingsListEl: document.getElementById('bond-color-settings-list'),
    viewerEl: document.getElementById('viewer'),
  };

  const constants = {
    BASE_FPS: 10,
    PLAYBACK_RATE_MIN: 1,
    PLAYBACK_RATE_MAX: 10,
    PLAYBACK_RATE_STEP: 0.5,
    PLAYBACK_RATE_DEFAULT: 1,
    PLAYBACK_STRIDE_MIN: 1,
    PLAYBACK_STRIDE_MAX: 20,
    PLAYBACK_STRIDE_STEP: 1,
    PLAYBACK_STRIDE_DEFAULT: 1,
    MEASURE_PERF_HINT_THRESHOLD: 20,
    PLOT_EXPORT_DPI: 300,
    CSS_BASE_DPI: 96,
    PLOT_EXPORT_SCALE: 300 / 96,
    BOND_COLOR_PALETTE: [
      '#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd',
      '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf'
    ],
    MEASURE_TYPES: ['bond', 'angle', 'dihedral'],
    MEASURE_META: {
      bond: {
        displayName: 'Bond',
        pluralName: 'Bonds',
        lowerName: 'bond',
        requiredAtoms: 2,
        yAxisTitle: 'Distance (Å)',
        valueUnit: 'Å',
        hoverValueLabel: 'd',
        hoverDecimals: 4,
        decimals: 3,
        plotEmptyText: 'Select Bond to show distance vs time.',
        plotNoDataText: 'No valid bond-distance data for selected bonds.',
        selectHintText: 'Select Bond mode: click atom A then atom B.',
        needsUnwrap: false,
      },
      angle: {
        displayName: 'Angle',
        pluralName: 'Angles',
        lowerName: 'angle',
        requiredAtoms: 3,
        yAxisTitle: 'Angle (deg)',
        valueUnit: 'deg',
        hoverValueLabel: 'θ',
        hoverDecimals: 4,
        decimals: 2,
        plotEmptyText: 'Select Angle to show angle vs time.',
        plotNoDataText: 'No valid angle data for selected angles.',
        selectHintText: 'Select Angle mode: click atom A, atom B, then atom C.',
        needsUnwrap: false,
      },
      dihedral: {
        displayName: 'Dihedral',
        pluralName: 'Dihedrals',
        lowerName: 'dihedral',
        requiredAtoms: 4,
        yAxisTitle: 'Dihedral (deg, unwrapped)',
        valueUnit: 'deg',
        hoverValueLabel: 'φ',
        hoverDecimals: 4,
        decimals: 2,
        plotEmptyText: 'Select Dihedral to show dihedral vs time.',
        plotNoDataText: 'No valid dihedral data for selected dihedrals.',
        selectHintText: 'Select Dihedral mode: click atoms A, B, C, then D.',
        needsUnwrap: true,
      },
    },
    PERIODIC_SYMBOLS: [
      '', 'H', 'He', 'Li', 'Be', 'B', 'C', 'N', 'O', 'F', 'Ne',
      'Na', 'Mg', 'Al', 'Si', 'P', 'S', 'Cl', 'Ar', 'K', 'Ca',
      'Sc', 'Ti', 'V', 'Cr', 'Mn', 'Fe', 'Co', 'Ni', 'Cu', 'Zn',
      'Ga', 'Ge', 'As', 'Se', 'Br', 'Kr', 'Rb', 'Sr', 'Y', 'Zr',
      'Nb', 'Mo', 'Tc', 'Ru', 'Rh', 'Pd', 'Ag', 'Cd', 'In', 'Sn',
      'Sb', 'Te', 'I', 'Xe', 'Cs', 'Ba', 'La', 'Ce', 'Pr', 'Nd',
      'Pm', 'Sm', 'Eu', 'Gd', 'Tb', 'Dy', 'Ho', 'Er', 'Tm', 'Yb',
      'Lu', 'Hf', 'Ta', 'W', 'Re', 'Os', 'Ir', 'Pt', 'Au', 'Hg',
      'Tl', 'Pb', 'Bi', 'Po', 'At', 'Rn', 'Fr', 'Ra', 'Ac', 'Th',
      'Pa', 'U', 'Np', 'Pu', 'Am', 'Cm', 'Bk', 'Cf', 'Es', 'Fm',
      'Md', 'No', 'Lr', 'Rf', 'Db', 'Sg', 'Bh', 'Hs', 'Mt', 'Ds',
      'Rg', 'Cn', 'Nh', 'Fl', 'Mc', 'Lv', 'Ts', 'Og'
    ],
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
    currentTrajId: null,
    xyzFrames: [],
    currentFrame: 0,
    currentCoords: [],
    currentTimes: [],
    currentModel: null,
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
  };

  function setStatus(message, isError = false) {
    if (!dom.statusEl) return;
    dom.statusEl.textContent = message || '';
    dom.statusEl.classList.toggle('error', !!isError);
  }

  function clampPlaybackRate(raw) {
    const fallback = constants.PLAYBACK_RATE_DEFAULT;
    const minRate = constants.PLAYBACK_RATE_MIN;
    const maxRate = constants.PLAYBACK_RATE_MAX;
    const step = constants.PLAYBACK_RATE_STEP;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return fallback;
    const clamped = Math.max(minRate, Math.min(maxRate, parsed));
    if (!Number.isFinite(step) || step <= 0) return clamped;
    const snapped = minRate + Math.round((clamped - minRate) / step) * step;
    return Number(Math.max(minRate, Math.min(maxRate, snapped)).toFixed(4));
  }

  function formatPlaybackRate(rate) {
    return `${clampPlaybackRate(rate).toFixed(1)}x`;
  }

  function syncPlaybackRateUi() {
    state.playbackRate = clampPlaybackRate(state.playbackRate);
    if (dom.playbackRateSlider) {
      dom.playbackRateSlider.min = String(constants.PLAYBACK_RATE_MIN);
      dom.playbackRateSlider.max = String(constants.PLAYBACK_RATE_MAX);
      dom.playbackRateSlider.step = String(constants.PLAYBACK_RATE_STEP);
      dom.playbackRateSlider.value = String(state.playbackRate);
    }
    if (dom.playbackRateLabel) {
      dom.playbackRateLabel.textContent = formatPlaybackRate(state.playbackRate);
    }
  }

  function clampPlaybackStride(raw) {
    const fallback = constants.PLAYBACK_STRIDE_DEFAULT;
    const minStride = constants.PLAYBACK_STRIDE_MIN;
    const maxStride = constants.PLAYBACK_STRIDE_MAX;
    const step = constants.PLAYBACK_STRIDE_STEP;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return fallback;
    const clamped = Math.max(minStride, Math.min(maxStride, parsed));
    const normalizedStep = Number.isFinite(step) && step > 0 ? step : 1;
    const snapped = minStride + Math.round((clamped - minStride) / normalizedStep) * normalizedStep;
    return Math.max(minStride, Math.min(maxStride, Math.trunc(snapped)));
  }

  function formatPlaybackStride(stride) {
    return `x${clampPlaybackStride(stride)}`;
  }

  function syncPlaybackStrideUi() {
    state.playbackStride = clampPlaybackStride(state.playbackStride);
    if (dom.playbackStrideSlider) {
      dom.playbackStrideSlider.min = String(constants.PLAYBACK_STRIDE_MIN);
      dom.playbackStrideSlider.max = String(constants.PLAYBACK_STRIDE_MAX);
      dom.playbackStrideSlider.step = String(constants.PLAYBACK_STRIDE_STEP);
      dom.playbackStrideSlider.value = String(state.playbackStride);
    }
    if (dom.playbackStrideLabel) {
      dom.playbackStrideLabel.textContent = formatPlaybackStride(state.playbackStride);
    }
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
    const text = String(color || '').trim();
    if (!text) return '#1f77b4';
    const m = text.match(/^#([0-9A-Fa-f]{6})$/);
    if (m) return `#${m[1].toLowerCase()}`;
    return '#1f77b4';
  }

  function sanitizeColorInput(color) {
    const text = String(color || '').trim();
    if (/^#([0-9A-Fa-f]{6})$/.test(text)) return text.toLowerCase();
    if (/^#([0-9A-Fa-f]{3})$/.test(text)) {
      const s = text.slice(1).toLowerCase();
      return `#${s[0]}${s[0]}${s[1]}${s[1]}${s[2]}${s[2]}`;
    }
    return null;
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
  }

  function sanitizeFilenamePart(text) {
    const cleaned = String(text).trim().replace(/[^A-Za-z0-9._-]+/g, '_');
    return cleaned || 'unknown';
  }

  syncPlaybackRateUi();
  syncPlaybackStrideUi();

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
    setStatus,
    clampPlaybackRate,
    formatPlaybackRate,
    syncPlaybackRateUi,
    clampPlaybackStride,
    formatPlaybackStride,
    syncPlaybackStrideUi,
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
    sanitizeFilenamePart,
  };
})();
