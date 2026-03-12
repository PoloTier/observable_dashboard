(function () {
  const MODE_FRAME_COUNT = 32;
  const BASE_PLAYBACK_FPS = 14;
  const PLAYBACK_RATE_MIN = 0.5;
  const PLAYBACK_RATE_MAX = 4.0;
  const PLAYBACK_RATE_STEP = 0.25;
  const PLAYBACK_RATE_DEFAULT = 1.0;
  const MODEL_STICK_RADIUS_BASE = 0.15;
  const MODEL_SPHERE_SCALE_BASE = 0.28;
  const OVERLAY_STICK_RADIUS = 0.095;
  const OVERLAY_OPACITY = 0.72;
  const EQUILIBRIUM_STICK_RADIUS = 0.17;
  const EQUILIBRIUM_SPHERE_SCALE = 0.3;
  const SAMPLING_REFERENCE_COLOR = '#cbd5e1';
  const SAMPLING_REFERENCE_STICK_OPACITY = 0.46;
  const SAMPLING_OVERLAY_COLORS = [
    '#60a5fa',
    '#fb923c',
    '#4ade80',
    '#fde047',
    '#c084fc',
    '#f472b6',
    '#22d3ee',
    '#a3e635',
  ];
  const PLOT_EXPORT_DPI = 300;
  const CSS_BASE_DPI = 96;
  const PLOT_EXPORT_SCALE = PLOT_EXPORT_DPI / CSS_BASE_DPI;
  const SPECTRUM_FWHM_MIN = 4;
  const SPECTRUM_FWHM_MAX = 80;
  const SPECTRUM_FWHM_DEFAULT = 20;
  const SPECTRUM_RANGE_MARGIN_MIN = 40;
  const SPECTRUM_RANGE_MARGIN_FACTOR = 4.0;
  const SPECTRUM_POINTS_PER_CM1 = 1.25;
  const SPECTRUM_POINT_COUNT_MIN = 720;
  const SPECTRUM_POINT_COUNT_MAX = 4096;
  const WORKSPACE_MODES = 'modes';
  const WORKSPACE_SAMPLING = 'sampling';
  const SAMPLER_WIGNER_FINITE_T = 'wigner_finite_t';
  const SAMPLER_WIGNER_ZERO_T = 'wigner_zero_t';
  const SAMPLER_CLASSICAL_FINITE_T = 'classical_finite_t';
  const SAMPLER_FROZEN = 'frozen';
  const MAX_PREVIEW_COUNT = 256;
  const DEFAULT_SAMPLE_COUNT = 2048;
  const DEFAULT_PREVIEW_COUNT = 64;
  const DEFAULT_TEMPERATURE_K = 300;
  const DEFAULT_FREQ_MIN_CM1 = 1.0;

  const SAMPLER_OPTIONS = [
    { value: SAMPLER_WIGNER_FINITE_T, label: 'Wigner finite T' },
    { value: SAMPLER_WIGNER_ZERO_T, label: 'Wigner 0 K' },
    { value: SAMPLER_CLASSICAL_FINITE_T, label: 'Classical finite T' },
    { value: SAMPLER_FROZEN, label: 'Frozen' },
  ];

  const SAMPLER_OVERRIDE_OPTIONS = [
    { value: '', label: 'Keep default' },
    ...SAMPLER_OPTIONS,
  ];

  const dom = {
    layout: document.getElementById('nm-layout'),
    modesSidebar: document.getElementById('nm-modes-sidebar'),
    workspaceModesPanel: document.getElementById('nm-workspace-modes-panel'),
    workspaceSamplingPanel: document.getElementById('nm-workspace-sampling-panel'),
    fileInput: document.getElementById('nm-file-input'),
    fileName: document.getElementById('nm-file-name'),
    openSamplingSettingsBtn: document.getElementById('nm-open-sampling-settings-btn'),
    workspaceModesBtn: document.getElementById('nm-workspace-modes-btn'),
    workspaceSamplingBtn: document.getElementById('nm-workspace-sampling-btn'),
    workspaceHint: document.getElementById('nm-workspace-hint'),
    modeCount: document.getElementById('nm-mode-count'),
    modeList: document.getElementById('nm-mode-list'),
    amplitudeSlider: document.getElementById('nm-amplitude-slider'),
    amplitudeLabel: document.getElementById('nm-amplitude-label'),
    speedSlider: document.getElementById('nm-speed-slider'),
    speedLabel: document.getElementById('nm-speed-label'),
    playBtn: document.getElementById('nm-play-btn'),
    prevBtn: document.getElementById('nm-prev-btn'),
    nextBtn: document.getElementById('nm-next-btn'),
    frameSlider: document.getElementById('nm-frame-slider'),
    frameLabel: document.getElementById('nm-frame-label'),
    showAtomIndexCheckbox: document.getElementById('nm-show-atom-index'),
    modeDetail: document.getElementById('nm-mode-detail'),
    modesControlsCard: document.getElementById('nm-modes-controls-card'),
    samplingSummaryCard: document.getElementById('nm-sampling-summary-card'),
    samplingSummaryGrid: document.getElementById('nm-sampling-summary-grid'),
    samplingBatchPill: document.getElementById('nm-sampling-batch-pill'),
    exportBundleBtn: document.getElementById('nm-export-bundle-btn'),
    exportStatus: document.getElementById('nm-export-status'),
    distributionCard: document.getElementById('nm-distribution-card'),
    distributionBatchPill: document.getElementById('nm-distribution-batch-pill'),
    measurementKind: document.getElementById('nm-measurement-kind'),
    measurementAtom0: document.getElementById('nm-measurement-atom-0'),
    measurementAtom1: document.getElementById('nm-measurement-atom-1'),
    measurementAtom2: document.getElementById('nm-measurement-atom-2'),
    measurementAtom2Group: document.getElementById('nm-measurement-atom-2-group'),
    measurementAtom3: document.getElementById('nm-measurement-atom-3'),
    measurementAtom3Group: document.getElementById('nm-measurement-atom-3-group'),
    measurementPlotBtn: document.getElementById('nm-measurement-plot-btn'),
    measurementStatus: document.getElementById('nm-measurement-status'),
    measurementPlot: document.getElementById('nm-measurement-plot'),
    spectrumCard: document.getElementById('nm-spectrum-card'),
    spectrumModeCount: document.getElementById('nm-spectrum-mode-count'),
    spectrumWidthSlider: document.getElementById('nm-spectrum-width-slider'),
    spectrumWidthLabel: document.getElementById('nm-spectrum-width-label'),
    spectrumPlot: document.getElementById('nm-spectrum-plot'),
    spectrumStatus: document.getElementById('nm-spectrum-status'),
    modesViewerCard: document.getElementById('nm-modes-viewer-card'),
    samplingViewerCard: document.getElementById('nm-sampling-viewer-card'),
    modesViewerEl: document.getElementById('nm-modes-viewer'),
    samplingViewerEl: document.getElementById('nm-sampling-viewer'),
    modesStatusEl: document.getElementById('nm-modes-status'),
    samplingStatusEl: document.getElementById('nm-sampling-status'),
    samplingModal: document.getElementById('nm-sampling-modal'),
    samplingModalCloseBtn: document.getElementById('nm-sampling-modal-close-btn'),
    samplingSampleCount: document.getElementById('nm-sampling-sample-count'),
    samplingPreviewCount: document.getElementById('nm-sampling-preview-count'),
    samplingTemperature: document.getElementById('nm-sampling-temperature'),
    samplingSeed: document.getElementById('nm-sampling-seed'),
    samplingFreqMin: document.getElementById('nm-sampling-freq-min'),
    samplingFreqMax: document.getElementById('nm-sampling-freq-max'),
    samplingPositionDefault: document.getElementById('nm-sampling-position-default'),
    samplingMomentumDefault: document.getElementById('nm-sampling-momentum-default'),
    samplingRulesCount: document.getElementById('nm-sampling-rules-count'),
    samplingRulesList: document.getElementById('nm-sampling-rules-list'),
    samplingAddRuleBtn: document.getElementById('nm-sampling-add-rule-btn'),
    samplingPlanCount: document.getElementById('nm-sampling-plan-count'),
    samplingPlanPreviewBody: document.getElementById('nm-sampling-plan-preview-body'),
    samplingModalStatus: document.getElementById('nm-sampling-modal-status'),
    samplingModalFooterStatus: document.getElementById('nm-sampling-modal-footer-status'),
    samplingSubmitBtn: document.getElementById('nm-sampling-submit-btn'),
  };

  const state = {
    modesViewer: null,
    samplingViewer: null,
    modeModel: null,
    parsed: null,
    uploadedContent: '',
    fileName: '',
    workspace: WORKSPACE_MODES,
    selectedModeIndex: -1,
    atomNumbers: [],
    frameCoords: [],
    currentFrame: 0,
    amplitudeScale: 1.0,
    playbackRate: PLAYBACK_RATE_DEFAULT,
    isPlaying: false,
    playbackRafId: 0,
    playbackLastTickMs: 0,
    renderSeq: 0,
    modeAtomIndexLabels: [],
    modeAtomIndexLabelSignature: '',
    modeAtomIndexLabelThemeKey: '',
    spectrumFwhm: SPECTRUM_FWHM_DEFAULT,
    samplingRules: [],
    nextSamplingRuleId: 1,
    samplingPreviewState: { rows: [], errors: [], payload: null },
    samplingResult: null,
    samplingJobInFlight: false,
    exportJobInFlight: false,
    lastMeasurementPayload: null,
  };

  function getStatusElement(workspace = state.workspace) {
    return workspace === WORKSPACE_SAMPLING ? dom.samplingStatusEl : dom.modesStatusEl;
  }

  function setStatus(message, isError = false, workspace = state.workspace) {
    const statusEl = getStatusElement(workspace);
    if (!statusEl) return;
    statusEl.textContent = String(message || '');
    statusEl.classList.toggle('error', !!isError);
  }

  function setSamplingModalStatus(message, isError = false) {
    if (!dom.samplingModalStatus) return;
    dom.samplingModalStatus.textContent = String(message || '');
    dom.samplingModalStatus.classList.toggle('error', !!isError);
  }

  function setSamplingModalFooterStatus(message, isError = false) {
    if (!dom.samplingModalFooterStatus) return;
    dom.samplingModalFooterStatus.textContent = String(message || '');
    dom.samplingModalFooterStatus.classList.toggle('error', !!isError);
  }

  function setMeasurementStatus(message, isError = false) {
    if (!dom.measurementStatus) return;
    dom.measurementStatus.textContent = String(message || '');
    dom.measurementStatus.classList.toggle('error', !!isError);
  }

  function setExportStatus(message, isError = false) {
    if (!dom.exportStatus) return;
    dom.exportStatus.textContent = String(message || '');
    dom.exportStatus.classList.toggle('error', !!isError);
  }

  function getPeriodicSymbols() {
    const symbols = window.ObservableMol3D?.constants?.PERIODIC_SYMBOLS;
    return Array.isArray(symbols) ? symbols : [];
  }

  function getAppearanceModule() {
    return window.ObservableAppearance || null;
  }

  function getPlotColors() {
    const appearance = getAppearanceModule();
    if (appearance && typeof appearance.getPlotColors === 'function') {
      return appearance.getPlotColors();
    }
    return {
      traceMutedColor: 'rgba(120,120,120,0.35)',
      accentFillColor: 'rgba(31,119,180,0.18)',
      cursorLineColor: '#d62728',
    };
  }

  function mergePlotlyLayout(baseLayout) {
    const appearance = getAppearanceModule();
    if (!appearance || typeof appearance.getPlotlyLayoutPatch !== 'function') {
      return baseLayout;
    }

    const patch = appearance.getPlotlyLayoutPatch();
    return {
      ...patch,
      ...baseLayout,
      font: {
        ...(patch.font || {}),
        ...(baseLayout.font || {}),
      },
      title: {
        ...(patch.title || {}),
        ...(baseLayout.title || {}),
        font: {
          ...((patch.title && patch.title.font) || {}),
          ...((baseLayout.title && baseLayout.title.font) || {}),
        },
      },
      xaxis: {
        ...(patch.xaxis || {}),
        ...(baseLayout.xaxis || {}),
      },
      yaxis: {
        ...(patch.yaxis || {}),
        ...(baseLayout.yaxis || {}),
      },
      legend: {
        ...(patch.legend || {}),
        ...(baseLayout.legend || {}),
        font: {
          ...((patch.legend && patch.legend.font) || {}),
          ...((baseLayout.legend && baseLayout.legend.font) || {}),
        },
      },
      hoverlabel: {
        ...(patch.hoverlabel || {}),
        ...(baseLayout.hoverlabel || {}),
        font: {
          ...((patch.hoverlabel && patch.hoverlabel.font) || {}),
          ...((baseLayout.hoverlabel && baseLayout.hoverlabel.font) || {}),
        },
      },
    };
  }

  function readCssVar(name, fallback) {
    const rootStyle = typeof window.getComputedStyle === 'function'
      ? window.getComputedStyle(document.documentElement)
      : null;
    const rawValue = rootStyle ? rootStyle.getPropertyValue(name) : '';
    const value = String(rawValue || '').trim();
    return value || fallback;
  }

  function getApiBase() {
    const scriptEl = document.getElementById('normal-modes-config-json');
    if (scriptEl) {
      try {
        const parsed = JSON.parse(scriptEl.textContent || '{}');
        const apiBase = typeof parsed?.api_base === 'string' ? parsed.api_base.trim() : '';
        if (apiBase) {
          return apiBase.replace(/\/$/, '') || '/api';
        }
      } catch (_) {
        // Ignore malformed config and fall back to the default API base.
      }
    }
    return '/api';
  }

  function triggerBlobDownload(fileName, blob) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = String(fileName || 'download.bin');
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  }

  function getDownloadFilename(response, fallback) {
    const header = String(response?.headers?.get('Content-Disposition') || '');
    const match = header.match(/filename=\"([^\"]+)\"/i);
    if (match && match[1]) {
      return match[1];
    }
    return String(fallback || 'normal_modes_sampling_bundle.tar.gz');
  }

  function atomicNumberToElement(rawValue) {
    const value = Number.parseInt(String(rawValue), 10);
    const symbols = getPeriodicSymbols();
    if (Number.isFinite(value) && value > 0 && value < symbols.length && symbols[value]) {
      return symbols[value];
    }
    return 'C';
  }

  function buildXyzText(coords, atomNumbers, commentText) {
    if (!Array.isArray(coords) || !coords.length) return '';
    const lines = [String(coords.length), String(commentText || 'Normal mode structure')];
    for (let atomIndex = 0; atomIndex < coords.length; atomIndex++) {
      const row = Array.isArray(coords[atomIndex]) ? coords[atomIndex] : [0, 0, 0];
      const x = Number(row[0]);
      const y = Number(row[1]);
      const z = Number(row[2]);
      lines.push(
        `${atomicNumberToElement(atomNumbers[atomIndex])} ` +
        `${(Number.isFinite(x) ? x : 0).toFixed(8)} ` +
        `${(Number.isFinite(y) ? y : 0).toFixed(8)} ` +
        `${(Number.isFinite(z) ? z : 0).toFixed(8)}`
      );
    }
    return lines.join('\n');
  }

  function buildXyzFrame(coords, atomNumbers, frameIndex) {
    return buildXyzText(coords, atomNumbers, `Normal mode frame ${Number.parseInt(String(frameIndex), 10) + 1}`);
  }

  function samplingOverlayColor(index) {
    const palette = SAMPLING_OVERLAY_COLORS;
    if (!Array.isArray(palette) || !palette.length) {
      return '#2563eb';
    }
    const normalized = Number.isFinite(index) ? Math.abs(Math.trunc(index)) : 0;
    return palette[normalized % palette.length];
  }

  function samplingReferenceStyle() {
    return {
      stick: {
        radius: EQUILIBRIUM_STICK_RADIUS,
        color: SAMPLING_REFERENCE_COLOR,
        opacity: SAMPLING_REFERENCE_STICK_OPACITY,
      },
    };
  }

  function samplingOverlayStyle(index) {
    const color = samplingOverlayColor(index);
    return {
      stick: { radius: OVERLAY_STICK_RADIUS, color, opacity: OVERLAY_OPACITY },
    };
  }

  function currentViewerTheme() {
    const appearance = getAppearanceModule();
    if (appearance && typeof appearance.getViewerTheme === 'function') {
      return appearance.getViewerTheme();
    }
    return {
      backgroundColor: '#fbfdff',
    };
  }

  function getViewer(workspace = state.workspace) {
    return workspace === WORKSPACE_SAMPLING ? state.samplingViewer : state.modesViewer;
  }

  function getViewerElement(workspace = state.workspace) {
    return workspace === WORKSPACE_SAMPLING ? dom.samplingViewerEl : dom.modesViewerEl;
  }

  function resizeViewer(workspace = state.workspace) {
    const viewer = getViewer(workspace);
    if (!viewer) return;
    viewer.resize();
    viewer.render();
  }

  function applyViewerAppearance() {
    const backgroundColor = currentViewerTheme().backgroundColor || '#fbfdff';
    const viewers = [state.modesViewer, state.samplingViewer];
    for (const viewer of viewers) {
      if (!viewer || typeof viewer.setBackgroundColor !== 'function') continue;
      viewer.setBackgroundColor(backgroundColor);
      viewer.render();
    }
    clearModeAtomIndexLabels();
    syncModeAtomIndexLabels();
  }

  function linePoint(point) {
    if (point && typeof point === 'object' && !Array.isArray(point)) {
      return {
        x: Number(point.x),
        y: Number(point.y),
        z: Number(point.z),
      };
    }
    return {
      x: Number(point?.[0]),
      y: Number(point?.[1]),
      z: Number(point?.[2]),
    };
  }

  function clampFrameIndex(rawIndex) {
    const frameCount = Array.isArray(state.frameCoords) ? state.frameCoords.length : 0;
    if (frameCount <= 0) return 0;
    const parsed = Number.parseInt(String(rawIndex), 10);
    if (!Number.isFinite(parsed)) return 0;
    return Math.max(0, Math.min(frameCount - 1, parsed));
  }

  function clampNumber(value, min, max) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return min;
    return Math.max(min, Math.min(max, numeric));
  }

  function clampPlaybackRate(rawValue) {
    const parsed = Number(rawValue);
    if (!Number.isFinite(parsed)) return PLAYBACK_RATE_DEFAULT;
    const clamped = clampNumber(parsed, PLAYBACK_RATE_MIN, PLAYBACK_RATE_MAX);
    const snapped = PLAYBACK_RATE_MIN + Math.round((clamped - PLAYBACK_RATE_MIN) / PLAYBACK_RATE_STEP) * PLAYBACK_RATE_STEP;
    return Number(clampNumber(snapped, PLAYBACK_RATE_MIN, PLAYBACK_RATE_MAX).toFixed(2));
  }

  function formatFrequency(rawValue) {
    const value = Number(rawValue);
    return Number.isFinite(value) ? value.toFixed(4) : 'n/a';
  }

  function formatIntensity(rawValue) {
    const value = Number(rawValue);
    return Number.isFinite(value) ? value.toFixed(4) : 'n/a';
  }

  function humanSamplerLabel(value) {
    const sampler = String(value || '');
    const match = SAMPLER_OPTIONS.find((item) => item.value === sampler);
    return match ? match.label : (sampler || 'n/a');
  }

  function shortSamplerLabel(value) {
    const sampler = String(value || '');
    if (sampler === SAMPLER_WIGNER_FINITE_T) return 'Wigner finite T';
    if (sampler === SAMPLER_WIGNER_ZERO_T) return 'Wigner 0 K';
    if (sampler === SAMPLER_CLASSICAL_FINITE_T) return 'Classical finite T';
    if (sampler === SAMPLER_FROZEN) return 'Frozen';
    return 'n/a';
  }

  function samplerFamilyLabel(value) {
    const sampler = String(value || '');
    if (sampler === SAMPLER_FROZEN) return 'Frozen';
    if (sampler === SAMPLER_CLASSICAL_FINITE_T) return 'Classical';
    if (sampler.startsWith('wigner')) return 'Wigner';
    return sampler || 'n/a';
  }

  function modeTagClass(kind) {
    const value = String(kind || '').trim().toLowerCase();
    if (value === 'imaginary') return 'imaginary';
    if (value === 'zero') return 'zero';
    return 'positive';
  }

  function renderEmptyTableRow(tbody, message) {
    if (!tbody) return;
    tbody.innerHTML = '';
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 7;
    const empty = document.createElement('div');
    empty.className = 'modal-empty';
    empty.textContent = String(message || '');
    cell.appendChild(empty);
    row.appendChild(cell);
    tbody.appendChild(row);
  }

  function syncAmplitudeUi() {
    const parsed = Number(dom.amplitudeSlider?.value);
    state.amplitudeScale = Number.isFinite(parsed) ? parsed : 1.0;
    if (dom.amplitudeSlider) {
      dom.amplitudeSlider.value = state.amplitudeScale.toFixed(1);
    }
    if (dom.amplitudeLabel) {
      dom.amplitudeLabel.textContent = `${state.amplitudeScale.toFixed(1)}x`;
    }
  }

  function syncPlaybackRateUi() {
    state.playbackRate = clampPlaybackRate(state.playbackRate);
    if (dom.speedSlider) {
      dom.speedSlider.min = String(PLAYBACK_RATE_MIN);
      dom.speedSlider.max = String(PLAYBACK_RATE_MAX);
      dom.speedSlider.step = String(PLAYBACK_RATE_STEP);
      dom.speedSlider.value = state.playbackRate.toFixed(2);
    }
    if (dom.speedLabel) {
      dom.speedLabel.textContent = `${state.playbackRate.toFixed(2)}x`;
    }
  }

  function syncSpectrumWidthUi() {
    const parsed = Number(dom.spectrumWidthSlider?.value);
    const clamped = clampNumber(parsed, SPECTRUM_FWHM_MIN, SPECTRUM_FWHM_MAX);
    state.spectrumFwhm = Number.isFinite(clamped) ? Math.round(clamped) : SPECTRUM_FWHM_DEFAULT;
    if (dom.spectrumWidthSlider) {
      dom.spectrumWidthSlider.min = String(SPECTRUM_FWHM_MIN);
      dom.spectrumWidthSlider.max = String(SPECTRUM_FWHM_MAX);
      dom.spectrumWidthSlider.step = '1';
      dom.spectrumWidthSlider.value = String(state.spectrumFwhm);
    }
    if (dom.spectrumWidthLabel) {
      dom.spectrumWidthLabel.textContent = `${state.spectrumFwhm.toFixed(0)} cm^-1`;
    }
  }

  function syncFrameUi() {
    const frameCount = Array.isArray(state.frameCoords) ? state.frameCoords.length : 0;
    const hasFrames = frameCount > 0 && state.workspace === WORKSPACE_MODES;
    const frameIndex = frameCount > 0 ? clampFrameIndex(state.currentFrame) : 0;
    state.currentFrame = frameIndex;
    if (dom.frameSlider) {
      dom.frameSlider.disabled = !hasFrames;
      dom.frameSlider.min = '0';
      dom.frameSlider.max = String(Math.max(0, frameCount - 1));
      dom.frameSlider.step = '1';
      dom.frameSlider.value = String(frameIndex);
    }
    if (dom.frameLabel) {
      dom.frameLabel.textContent = frameCount > 0 ? `Frame ${frameIndex + 1}/${frameCount}` : 'Frame 0/0';
    }
    if (dom.prevBtn) {
      dom.prevBtn.disabled = !hasFrames || frameIndex <= 0;
    }
    if (dom.nextBtn) {
      dom.nextBtn.disabled = !hasFrames || frameIndex >= frameCount - 1;
    }
    if (dom.playBtn) {
      dom.playBtn.disabled = !hasFrames;
      dom.playBtn.textContent = state.isPlaying ? 'Pause' : 'Play';
    }
  }

  function shouldRenderModeAtomIndexLabels() {
    return (
      state.workspace === WORKSPACE_MODES &&
      !!dom.showAtomIndexCheckbox?.checked &&
      !state.isPlaying
    );
  }

  function getModeFrameCoords(frameIndex = state.currentFrame) {
    const frames = Array.isArray(state.frameCoords) ? state.frameCoords : [];
    const idx = Number.parseInt(String(frameIndex), 10);
    if (!Number.isFinite(idx) || idx < 0 || idx >= frames.length) return null;
    const frame = frames[idx];
    return Array.isArray(frame) ? frame : null;
  }

  function getModeAtomIndexThemeKey(theme = currentViewerTheme()) {
    return `${theme?.atomIndexColor || ''}|${theme?.labelBackgroundColor || ''}|${theme?.labelBackgroundOpacity || ''}`;
  }

  function getModeAtomIndexLabelSignature() {
    const frame = getModeFrameCoords(0);
    const atomCount = Array.isArray(frame) ? frame.length : 0;
    return `${atomCount}`;
  }

  function removeModeTrackedLabel(label) {
    if (!state.modesViewer || !label || typeof state.modesViewer.removeLabel !== 'function') return;
    try {
      state.modesViewer.removeLabel(label);
    } catch (_) {
      // Best-effort cleanup for stale label handles.
    }
  }

  function clearModeAtomIndexLabels() {
    const labels = Array.isArray(state.modeAtomIndexLabels) ? state.modeAtomIndexLabels.slice() : [];
    state.modeAtomIndexLabels = [];
    state.modeAtomIndexLabelSignature = '';
    state.modeAtomIndexLabelThemeKey = '';
    for (const label of labels) {
      removeModeTrackedLabel(label);
    }
  }

  function setModeAtomIndexLabelsVisible(visible) {
    const labels = Array.isArray(state.modeAtomIndexLabels) ? state.modeAtomIndexLabels : [];
    for (const label of labels) {
      if (label?.sprite) {
        label.sprite.visible = !!visible;
      }
    }
  }

  function buildModeAtomIndexLabelStyle(position, theme = currentViewerTheme()) {
    return {
      position: linePoint(position),
      alignment: 'center',
      showBackground: true,
      backgroundColor: theme.labelBackgroundColor || '#ffffff',
      backgroundOpacity: Number.isFinite(Number(theme.labelBackgroundOpacity))
        ? Number(theme.labelBackgroundOpacity)
        : 0.82,
      borderThickness: 1,
      borderColor: theme.atomIndexColor || '#dc2626',
      fontColor: theme.atomIndexColor || '#dc2626',
      fontSize: 13,
      inFront: true,
      screenOffset: { x: 6, y: -6 },
    };
  }

  function createModeAtomIndexLabels(frame, signature, theme = currentViewerTheme()) {
    if (!state.modesViewer || !Array.isArray(frame) || !frame.length) return false;
    clearModeAtomIndexLabels();
    const labels = [];
    for (let atomIndex = 0; atomIndex < frame.length; atomIndex++) {
      const label = state.modesViewer.addLabel(
        String(atomIndex),
        buildModeAtomIndexLabelStyle(frame[atomIndex], theme)
      );
      if (label) labels.push(label);
    }
    state.modeAtomIndexLabels = labels;
    state.modeAtomIndexLabelSignature = signature;
    state.modeAtomIndexLabelThemeKey = getModeAtomIndexThemeKey(theme);
    return labels.length > 0;
  }

  function updateModeAtomIndexLabelPosition(label, position) {
    if (!label) return;
    const nextPosition = linePoint(position);
    if (label.stylespec && typeof label.stylespec === 'object') {
      label.stylespec.position = nextPosition;
    }
    if (label.sprite?.position && typeof label.sprite.position.set === 'function') {
      label.sprite.position.set(nextPosition.x, nextPosition.y, nextPosition.z);
    }
  }

  function updateModeAtomIndexLabelPositions(frame) {
    const labels = Array.isArray(state.modeAtomIndexLabels) ? state.modeAtomIndexLabels : [];
    if (!Array.isArray(frame) || !labels.length) return;
    const count = Math.min(labels.length, frame.length);
    for (let atomIndex = 0; atomIndex < count; atomIndex++) {
      updateModeAtomIndexLabelPosition(labels[atomIndex], frame[atomIndex]);
    }
  }

  function rebuildModeAtomIndexLabelStyles(frame, theme = currentViewerTheme()) {
    if (!state.modesViewer || typeof state.modesViewer.setLabelStyle !== 'function') return false;
    const labels = Array.isArray(state.modeAtomIndexLabels) ? state.modeAtomIndexLabels : [];
    if (!labels.length || !Array.isArray(frame)) return false;
    const count = Math.min(labels.length, frame.length);
    for (let atomIndex = 0; atomIndex < count; atomIndex++) {
      const currentLabel = labels[atomIndex];
      const nextStyle = buildModeAtomIndexLabelStyle(frame[atomIndex], theme);
      labels[atomIndex] = state.modesViewer.setLabelStyle(currentLabel, nextStyle) || currentLabel;
    }
    state.modeAtomIndexLabelThemeKey = getModeAtomIndexThemeKey(theme);
    return true;
  }

  function syncModeAtomIndexLabels(frameIndex = state.currentFrame) {
    if (!state.modesViewer) return;
    if (!shouldRenderModeAtomIndexLabels()) {
      setModeAtomIndexLabelsVisible(false);
      return;
    }

    const frame = getModeFrameCoords(frameIndex);
    if (!Array.isArray(frame) || !frame.length) {
      clearModeAtomIndexLabels();
      return;
    }

    const signature = getModeAtomIndexLabelSignature();
    const theme = currentViewerTheme();
    const themeKey = getModeAtomIndexThemeKey(theme);
    const needsRebuild = (
      !Array.isArray(state.modeAtomIndexLabels) ||
      state.modeAtomIndexLabels.length !== frame.length ||
      state.modeAtomIndexLabelSignature !== signature
    );
    if (needsRebuild) {
      createModeAtomIndexLabels(frame, signature, theme);
    } else if (state.modeAtomIndexLabelThemeKey !== themeKey) {
      rebuildModeAtomIndexLabelStyles(frame, theme);
    }

    updateModeAtomIndexLabelPositions(frame);
    setModeAtomIndexLabelsVisible(true);
  }

  function getPlaybackIntervalMs() {
    const fps = BASE_PLAYBACK_FPS * clampPlaybackRate(state.playbackRate);
    if (!Number.isFinite(fps) || fps <= 0) {
      return Math.round(1000 / BASE_PLAYBACK_FPS);
    }
    return Math.max(1, Math.round(1000 / fps));
  }

  function purgeSpectrumPlot() {
    if (dom.spectrumPlot && typeof Plotly !== 'undefined') {
      try {
        Plotly.purge(dom.spectrumPlot);
      } catch (_) {
        // Ignore purge failures during empty-state transitions.
      }
    }
  }

  function setSpectrumPlotEmpty(message) {
    if (!dom.spectrumPlot) return;
    purgeSpectrumPlot();
    dom.spectrumPlot.innerHTML = '';
    const emptyEl = document.createElement('div');
    emptyEl.className = 'mode-empty';
    emptyEl.textContent = String(message || 'No IR spectrum available.');
    dom.spectrumPlot.appendChild(emptyEl);
  }

  function getIrSpectrumModes() {
    const summaries = Array.isArray(state.parsed?.mode_summaries) ? state.parsed.mode_summaries : [];
    const modes = [];
    for (const summary of summaries) {
      const modeIndex = Number.parseInt(String(summary?.mode_index), 10);
      const frequency = Number(summary?.frequency_cm1);
      const intensity = Number(summary?.intensity);
      if (!Number.isFinite(modeIndex) || !Number.isFinite(frequency) || frequency <= 0) continue;
      if (!Number.isFinite(intensity) || intensity < 0) continue;
      modes.push({
        modeIndex,
        frequencyCm1: frequency,
        intensity,
      });
    }
    return modes;
  }

  function gaussianSigmaFromFwhm(fwhm) {
    const width = Number(fwhm);
    if (!Number.isFinite(width) || width <= 0) return 1;
    return width / (2 * Math.sqrt(2 * Math.log(2)));
  }

  function buildBroadenedSpectrum(irModes, fwhm) {
    if (!Array.isArray(irModes) || !irModes.length) {
      return { x: [], y: [], maxY: 0 };
    }

    let minFreq = irModes[0].frequencyCm1;
    let maxFreq = irModes[0].frequencyCm1;
    for (const mode of irModes) {
      minFreq = Math.min(minFreq, mode.frequencyCm1);
      maxFreq = Math.max(maxFreq, mode.frequencyCm1);
    }

    const span = Math.max(maxFreq - minFreq, 1);
    const margin = Math.max(SPECTRUM_RANGE_MARGIN_MIN, fwhm * SPECTRUM_RANGE_MARGIN_FACTOR, span * 0.08);
    const xMin = Math.max(0, minFreq - margin);
    const xMax = maxFreq + margin;
    const xSpan = Math.max(xMax - xMin, 1);
    const pointCount = Math.max(
      SPECTRUM_POINT_COUNT_MIN,
      Math.min(SPECTRUM_POINT_COUNT_MAX, Math.round(xSpan * SPECTRUM_POINTS_PER_CM1))
    );
    const sigma = gaussianSigmaFromFwhm(fwhm);
    const x = new Array(pointCount);
    const y = new Array(pointCount).fill(0);
    const step = pointCount > 1 ? xSpan / (pointCount - 1) : 1;

    for (let index = 0; index < pointCount; index++) {
      x[index] = xMin + step * index;
    }

    for (const mode of irModes) {
      for (let index = 0; index < pointCount; index++) {
        const dx = (x[index] - mode.frequencyCm1) / sigma;
        if (Math.abs(dx) > 8) continue;
        y[index] += mode.intensity * Math.exp(-0.5 * dx * dx);
      }
    }

    let maxY = 0;
    for (const value of y) {
      if (Number.isFinite(value)) maxY = Math.max(maxY, value);
    }
    return { x, y, maxY };
  }

  function buildStickSegments(irModes) {
    const x = [];
    const y = [];
    for (const mode of irModes) {
      x.push(mode.frequencyCm1, mode.frequencyCm1, null);
      y.push(0, mode.intensity, null);
    }
    return { x, y };
  }

  function summarizeSelectedIrMode(irModes) {
    if (!Array.isArray(irModes) || !irModes.length) return null;
    return irModes.find((mode) => mode.modeIndex === state.selectedModeIndex) || null;
  }

  function renderSpectrum() {
    if (dom.spectrumModeCount) {
      dom.spectrumModeCount.textContent = '0';
    }
    if (!dom.spectrumStatus) return;

    if (!state.parsed) {
      setSpectrumPlotEmpty('Upload a molden file to render the IR spectrum.');
      dom.spectrumStatus.textContent =
        'IR spectrum rendering uses positive frequencies with finite intensities from [INT].';
      return;
    }

    if (typeof Plotly === 'undefined') {
      setSpectrumPlotEmpty('Plot unavailable because Plotly failed to load.');
      dom.spectrumStatus.textContent = 'Plotly.js is required to draw the IR spectrum.';
      return;
    }

    const irModes = getIrSpectrumModes();
    if (dom.spectrumModeCount) {
      dom.spectrumModeCount.textContent = String(irModes.length);
    }
    if (!irModes.length) {
      setSpectrumPlotEmpty('This molden file does not contain any positive modes with finite IR intensities.');
      dom.spectrumStatus.textContent =
        'The IR spectrum only includes modes with frequency > 0 and finite values in [INT].';
      return;
    }

    const broadened = buildBroadenedSpectrum(irModes, state.spectrumFwhm);
    const stickData = buildStickSegments(irModes);
    const selectedMode = summarizeSelectedIrMode(irModes);
    const plotColors = getPlotColors();
    const accentColor = readCssVar('--accent', '#0f5dcf');
    const selectedColor = plotColors.cursorLineColor || readCssVar('--danger', '#b42318');
    const traces = [
      {
        type: 'scatter',
        mode: 'lines',
        name: 'Broadened total',
        x: broadened.x,
        y: broadened.y,
        line: { color: accentColor, width: 2.5 },
        fill: 'tozeroy',
        fillcolor: plotColors.accentFillColor || 'rgba(31,119,180,0.18)',
        hovertemplate: '%{x:.2f} cm^-1<br>Total intensity=%{y:.4f}<extra></extra>',
      },
      {
        type: 'scatter',
        mode: 'lines',
        name: 'Stick spectrum',
        x: stickData.x,
        y: stickData.y,
        line: {
          color: plotColors.traceMutedColor || 'rgba(120,120,120,0.35)',
          width: 1.2,
        },
        hoverinfo: 'skip',
      },
    ];

    const shapes = [];
    if (selectedMode) {
      traces.push({
        type: 'scatter',
        mode: 'lines',
        name: `Mode ${selectedMode.modeIndex + 1}`,
        x: [selectedMode.frequencyCm1, selectedMode.frequencyCm1],
        y: [0, selectedMode.intensity],
        line: { color: selectedColor, width: 2.6 },
        hovertemplate:
          `Mode ${selectedMode.modeIndex + 1}<br>` +
          `${selectedMode.frequencyCm1.toFixed(2)} cm^-1<br>` +
          `IR=${selectedMode.intensity.toFixed(4)}<extra></extra>`,
      });
      shapes.push({
        type: 'line',
        x0: selectedMode.frequencyCm1,
        x1: selectedMode.frequencyCm1,
        yref: 'paper',
        y0: 0,
        y1: 1,
        line: { color: selectedColor, width: 1.2, dash: 'dot' },
      });
    }

    const yMax = Math.max(
      broadened.maxY,
      ...irModes.map((mode) => (Number.isFinite(mode.intensity) ? mode.intensity : 0))
    );
    const baseLayout = {
      height: 340,
      margin: { l: 68, r: 24, t: 18, b: 56 },
      hovermode: 'closest',
      showlegend: true,
      legend: {
        orientation: 'h',
        yanchor: 'bottom',
        y: 1.02,
        xanchor: 'right',
        x: 1,
      },
      xaxis: {
        title: 'Wavenumber (cm^-1)',
        autorange: 'reversed',
        showline: true,
        mirror: 'ticks',
        ticks: 'outside',
      },
      yaxis: {
        title: 'Intensity (arb. units)',
        range: [0, Math.max(yMax * 1.08, 1)],
        showline: true,
        mirror: 'ticks',
        ticks: 'outside',
        rangemode: 'tozero',
      },
      shapes,
    };
    const layout = mergePlotlyLayout(baseLayout);

    Plotly.react(dom.spectrumPlot, traces, layout, {
      responsive: true,
      displaylogo: false,
      toImageButtonOptions: {
        format: 'png',
        scale: PLOT_EXPORT_SCALE,
      },
    });

    let statusText =
      `Showing ${irModes.length} IR sticks and a Gaussian-broadened total spectrum ` +
      `(FWHM ${state.spectrumFwhm.toFixed(0)} cm^-1).`;
    if (selectedMode) {
      statusText +=
        ` Selected: mode ${selectedMode.modeIndex + 1} at ${selectedMode.frequencyCm1.toFixed(2)} cm^-1 ` +
        `with IR ${selectedMode.intensity.toFixed(4)}.`;
    }
    dom.spectrumStatus.textContent = statusText;
  }

  function renderModeDetail() {
    if (!dom.modeDetail) return;
    const summaries = Array.isArray(state.parsed?.mode_summaries) ? state.parsed.mode_summaries : [];
    const summary = summaries[state.selectedModeIndex] || null;
    if (!summary) {
      dom.modeDetail.textContent =
        'No mode selected. The displayed displacement scale is a visualization factor, not a physical amplitude.';
      return;
    }

    const parts = [
      `Mode ${Number(summary.mode_index) + 1}`,
      `${formatFrequency(summary.frequency_cm1)} cm^-1`,
      `type=${String(summary.kind || 'positive')}`,
    ];
    if (summary.intensity != null) {
      parts.push(`IR=${formatIntensity(summary.intensity)}`);
    }
    parts.push(`amplitude=${state.amplitudeScale.toFixed(1)}x`);
    dom.modeDetail.innerHTML =
      `<strong>${parts[0]}</strong><br />` +
      `${parts.slice(1).join(' · ')}<br />` +
      'The displacement scale shown here is for visualization only.';
  }

  function renderModeList() {
    if (!dom.modeList || !dom.modeCount) return;
    const summaries = Array.isArray(state.parsed?.mode_summaries) ? state.parsed.mode_summaries : [];
    dom.modeCount.textContent = String(summaries.length);
    dom.modeList.innerHTML = '';
    if (!summaries.length) {
      const emptyEl = document.createElement('div');
      emptyEl.className = 'mode-empty';
      emptyEl.innerHTML = 'Upload a <code>molden</code> file to populate normal modes.';
      dom.modeList.appendChild(emptyEl);
      return;
    }

    for (const summary of summaries) {
      const modeIndex = Number.parseInt(String(summary?.mode_index), 10);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'mode-item';
      if (modeIndex === state.selectedModeIndex) {
        button.classList.add('is-active');
      }
      button.dataset.modeIndex = String(modeIndex);

      const rowEl = document.createElement('div');
      rowEl.className = 'mode-item-row';
      const titleEl = document.createElement('span');
      titleEl.className = 'mode-cell mode-cell-index';
      titleEl.textContent = `Mode ${modeIndex + 1}`;

      const frequencyEl = document.createElement('span');
      frequencyEl.className = 'mode-cell mode-cell-frequency';
      frequencyEl.textContent = `${formatFrequency(summary.frequency_cm1)} cm^-1`;

      const kindEl = document.createElement('span');
      kindEl.className = 'mode-cell mode-cell-kind';
      const tagEl = document.createElement('span');
      tagEl.className = `mode-tag ${modeTagClass(summary.kind)}`;
      tagEl.textContent = String(summary.kind || 'positive');
      kindEl.appendChild(tagEl);

      const intensityEl = document.createElement('span');
      intensityEl.className = 'mode-cell mode-cell-ir';
      if (summary.intensity != null) {
        intensityEl.textContent = `IR ${formatIntensity(summary.intensity)}`;
      } else {
        intensityEl.classList.add('mode-ir-empty');
        intensityEl.textContent = '—';
      }

      rowEl.appendChild(titleEl);
      rowEl.appendChild(frequencyEl);
      rowEl.appendChild(kindEl);
      rowEl.appendChild(intensityEl);
      button.appendChild(rowEl);
      dom.modeList.appendChild(button);
    }
  }

  function buildModeFrames(baseCoords, modeVectors, amplitudeScale) {
    const frames = [];
    const coords = Array.isArray(baseCoords) ? baseCoords : [];
    const vectors = Array.isArray(modeVectors) ? modeVectors : [];
    for (let frameIndex = 0; frameIndex < MODE_FRAME_COUNT; frameIndex++) {
      const phase = Math.sin((2 * Math.PI * frameIndex) / MODE_FRAME_COUNT);
      const frame = [];
      for (let atomIndex = 0; atomIndex < coords.length; atomIndex++) {
        const coord = Array.isArray(coords[atomIndex]) ? coords[atomIndex] : [0, 0, 0];
        const vector = Array.isArray(vectors[atomIndex]) ? vectors[atomIndex] : [0, 0, 0];
        frame.push([
          Number(coord[0] || 0) + amplitudeScale * phase * Number(vector[0] || 0),
          Number(coord[1] || 0) + amplitudeScale * phase * Number(vector[1] || 0),
          Number(coord[2] || 0) + amplitudeScale * phase * Number(vector[2] || 0),
        ]);
      }
      frames.push(frame);
    }
    return frames;
  }

  function clearViewerScene(workspace = state.workspace) {
    const viewer = getViewer(workspace);
    if (!viewer) return;
    if (workspace === WORKSPACE_MODES) {
      clearModeAtomIndexLabels();
    }
    viewer.removeAllModels();
    if (workspace === WORKSPACE_MODES) {
      state.modeModel = null;
    }
  }

  function addStaticModel(coords, atomNumbers, commentText, style, workspace = state.workspace) {
    const viewer = getViewer(workspace);
    if (!viewer) return null;
    const xyzText = buildXyzText(coords, atomNumbers, commentText);
    if (!xyzText) return null;
    const model = viewer.addModel(xyzText, 'xyz');
    if (!model || typeof model.setStyle !== 'function') return model || null;
    model.setStyle({}, style);
    return model;
  }

  function loadFramesIntoViewer(frames, atomNumbers, { refit = true } = {}) {
    const viewer = state.modesViewer;
    if (!viewer || !Array.isArray(frames) || !frames.length) return false;
    const firstFrameXyz = buildXyzFrame(frames[0], atomNumbers, 0);
    if (!firstFrameXyz) return false;

    clearViewerScene(WORKSPACE_MODES);
    const model = viewer.addModel(firstFrameXyz, 'xyz');
    if (!model) return false;
    if (typeof model.setCoordinates === 'function') {
      model.setCoordinates(frames, 'array');
    }
    state.modeModel = model;
    viewer.setStyle(
      {},
      {
        stick: { radius: MODEL_STICK_RADIUS_BASE, colorscheme: 'Jmol' },
        sphere: { scale: MODEL_SPHERE_SCALE_BASE, colorscheme: 'Jmol' },
      }
    );
    if (refit && typeof viewer.zoomTo === 'function') {
      viewer.zoomTo();
    }
    viewer.render();
    return true;
  }

  async function renderFrame(frameIndex) {
    if (state.workspace !== WORKSPACE_MODES) return false;
    if (!state.modesViewer || !state.modeModel) return false;
    const frameCount = Array.isArray(state.frameCoords) ? state.frameCoords.length : 0;
    if (frameCount <= 0) return false;
    const nextIndex = clampFrameIndex(frameIndex);
    const renderSeq = ++state.renderSeq;
    state.currentFrame = nextIndex;
    if (typeof state.modeModel.setFrame === 'function') {
      await state.modeModel.setFrame(nextIndex, state.modesViewer);
    }
    if (renderSeq !== state.renderSeq) return false;
    syncModeAtomIndexLabels(nextIndex);
    state.modesViewer.render();
    syncFrameUi();
    return true;
  }

  function stopPlayback() {
    if (state.playbackRafId) {
      cancelAnimationFrame(state.playbackRafId);
      state.playbackRafId = 0;
    }
    state.isPlaying = false;
    state.playbackLastTickMs = 0;
    syncModeAtomIndexLabels();
    syncFrameUi();
  }

  function restartPlaybackTimerIfPlaying() {
    if (!state.isPlaying) return;
    state.playbackLastTickMs = 0;
  }

  function schedulePlaybackTick() {
    if (!state.isPlaying) return;
    state.playbackRafId = requestAnimationFrame(runPlaybackTick);
  }

  function runPlaybackTick(timestamp) {
    if (!state.isPlaying || state.workspace !== WORKSPACE_MODES) return;
    const frameCount = Array.isArray(state.frameCoords) ? state.frameCoords.length : 0;
    if (frameCount <= 0) {
      stopPlayback();
      return;
    }
    if (!Number.isFinite(state.playbackLastTickMs) || state.playbackLastTickMs <= 0) {
      state.playbackLastTickMs = timestamp;
      schedulePlaybackTick();
      return;
    }

    const intervalMs = getPlaybackIntervalMs();
    if (timestamp - state.playbackLastTickMs >= intervalMs) {
      state.playbackLastTickMs = timestamp;
      void renderFrame((state.currentFrame + 1) % frameCount);
    }
    schedulePlaybackTick();
  }

  function startPlayback() {
    if (state.workspace !== WORKSPACE_MODES) return;
    if (!Array.isArray(state.frameCoords) || !state.frameCoords.length || !state.modeModel) return;
    stopPlayback();
    state.isPlaying = true;
    state.playbackLastTickMs = 0;
    syncModeAtomIndexLabels();
    syncFrameUi();
    schedulePlaybackTick();
  }

  function rebuildCurrentModeFrames({ refit = false } = {}) {
    const coords = Array.isArray(state.parsed?.coords_ang) ? state.parsed.coords_ang : [];
    const modes = Array.isArray(state.parsed?.mode_vectors_ang) ? state.parsed.mode_vectors_ang : [];
    const vectors = modes[state.selectedModeIndex];
    if (!coords.length || !Array.isArray(vectors)) {
      state.frameCoords = [];
      state.currentFrame = 0;
      clearViewerScene(WORKSPACE_MODES);
      syncFrameUi();
      renderModeDetail();
      return;
    }

    stopPlayback();
    state.atomNumbers = Array.isArray(state.parsed?.atom_numbers) ? state.parsed.atom_numbers.slice() : [];
    state.frameCoords = buildModeFrames(coords, vectors, state.amplitudeScale);
    state.currentFrame = 0;
    if (!loadFramesIntoViewer(state.frameCoords, state.atomNumbers, { refit })) {
      state.frameCoords = [];
      setStatus('Failed to initialize 3D viewer for the selected mode.', true, WORKSPACE_MODES);
      syncFrameUi();
      renderModeDetail();
      return;
    }
    void renderFrame(0);
    renderModeDetail();
  }

  function renderEquilibriumStructure({ refit = false, workspace = WORKSPACE_SAMPLING } = {}) {
    const coords = Array.isArray(state.parsed?.coords_ang) ? state.parsed.coords_ang : [];
    const atomNumbers = Array.isArray(state.parsed?.atom_numbers) ? state.parsed.atom_numbers : [];
    const viewer = getViewer(workspace);
    clearViewerScene(workspace);
    if (!viewer || !coords.length || !atomNumbers.length) {
      if (viewer) viewer.render();
      return;
    }
    addStaticModel(
      coords,
      atomNumbers,
      'Equilibrium structure',
      workspace === WORKSPACE_SAMPLING
        ? samplingReferenceStyle()
        : {
            stick: { radius: EQUILIBRIUM_STICK_RADIUS, colorscheme: 'Jmol' },
            sphere: { scale: EQUILIBRIUM_SPHERE_SCALE, colorscheme: 'Jmol' },
          },
      workspace
    );
    if (refit && typeof viewer.zoomTo === 'function') {
      viewer.zoomTo();
    }
    viewer.render();
  }

  function renderSamplingPreview({ refit = false } = {}) {
    const workspace = WORKSPACE_SAMPLING;
    const viewer = getViewer(workspace);
    clearViewerScene(workspace);
    if (!viewer) return;
    const sample = state.samplingResult;
    const atomNumbers = Array.isArray(sample?.atom_numbers) ? sample.atom_numbers : [];
    const equilibrium = Array.isArray(sample?.equilibrium_coords_ang) ? sample.equilibrium_coords_ang : [];
    const previews = Array.isArray(sample?.preview_coords_ang) ? sample.preview_coords_ang : [];
    if (!atomNumbers.length || !equilibrium.length) {
      renderEquilibriumStructure({ refit, workspace });
      setStatus('Sampling batch has no preview coordinates to render.', true, WORKSPACE_SAMPLING);
      return;
    }

    addStaticModel(
      equilibrium,
      atomNumbers,
      'Equilibrium structure',
      samplingReferenceStyle(),
      workspace
    );
    for (let index = 0; index < previews.length; index++) {
      const coords = previews[index];
      if (!Array.isArray(coords) || !coords.length) continue;
      addStaticModel(
        coords,
        atomNumbers,
        `Sample overlay ${index + 1}`,
        samplingOverlayStyle(index),
        workspace
      );
    }
    if (refit && typeof viewer.zoomTo === 'function') {
      viewer.zoomTo();
    }
    viewer.render();
    setStatus(
      `Showing 1 reference structure plus ${previews.length} sampled overlay` +
      `${previews.length === 1 ? '' : 's'} from batch ${sample?.batch_id || 'n/a'}.`,
      false,
      WORKSPACE_SAMPLING
    );
  }

  function setSelectedMode(modeIndex, { refit = false } = {}) {
    const summaries = Array.isArray(state.parsed?.mode_summaries) ? state.parsed.mode_summaries : [];
    const nextIndex = Number.parseInt(String(modeIndex), 10);
    if (!Number.isFinite(nextIndex) || nextIndex < 0 || nextIndex >= summaries.length) {
      return;
    }
    state.selectedModeIndex = nextIndex;
    renderModeList();
    if (state.workspace === WORKSPACE_MODES) {
      rebuildCurrentModeFrames({ refit });
    }
    renderSpectrum();
  }

  function createEmptyRule() {
    const id = state.nextSamplingRuleId++;
    return {
      id,
      selectorType: 'freq_range',
      modeIndicesText: '',
      freqMinText: '',
      freqMaxText: '',
      positionSampler: '',
      momentumSampler: '',
    };
  }

  function parseModeIndicesText(rawText) {
    const text = String(rawText || '').trim();
    if (!text) {
      throw new Error('Mode-indices rules require at least one 0-based mode index.');
    }
    const values = new Set();
    const segments = text.split(',').map((item) => item.trim()).filter(Boolean);
    if (!segments.length) {
      throw new Error('Mode-indices rules require at least one 0-based mode index.');
    }
    for (const segment of segments) {
      const rangeMatch = segment.match(/^(\d+)\s*-\s*(\d+)$/);
      if (rangeMatch) {
        const start = Number.parseInt(rangeMatch[1], 10);
        const end = Number.parseInt(rangeMatch[2], 10);
        if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) {
          throw new Error(`Invalid mode range: ${segment}`);
        }
        for (let value = start; value <= end; value++) {
          values.add(value);
        }
        continue;
      }
      const parsed = Number.parseInt(segment, 10);
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`Invalid mode index: ${segment}`);
      }
      values.add(parsed);
    }
    return Array.from(values).sort((a, b) => a - b);
  }

  function parseOptionalNumber(rawValue) {
    const text = String(rawValue ?? '').trim();
    if (!text) return null;
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function formatOptionalNumber(value, fallback = '—') {
    if (!Number.isFinite(Number(value))) return fallback;
    return String(value);
  }

  function buildSamplingConfigFromForm() {
    const sampleCount = Number.parseInt(String(dom.samplingSampleCount?.value || DEFAULT_SAMPLE_COUNT), 10);
    const previewCountRaw = Number.parseInt(String(dom.samplingPreviewCount?.value || DEFAULT_PREVIEW_COUNT), 10);
    const temperature = parseOptionalNumber(dom.samplingTemperature?.value);
    const seed = parseOptionalNumber(dom.samplingSeed?.value);
    const freqMin = parseOptionalNumber(dom.samplingFreqMin?.value);
    const freqMax = parseOptionalNumber(dom.samplingFreqMax?.value);
    const positionDefault = String(dom.samplingPositionDefault?.value || SAMPLER_WIGNER_FINITE_T);
    const momentumDefault = String(dom.samplingMomentumDefault?.value || SAMPLER_WIGNER_FINITE_T);
    const errors = [];
    if (!Number.isFinite(sampleCount) || sampleCount <= 0) {
      errors.push('Sample count must be a positive integer.');
    }
    if (!Number.isFinite(previewCountRaw) || previewCountRaw <= 0) {
      errors.push('Preview count must be a positive integer.');
    }
    if (temperature != null && temperature <= 0) {
      errors.push('Temperature must be positive when provided.');
    }
    if (seed != null && seed < 0) {
      errors.push('Seed must be >= 0.');
    }
    if (freqMin != null && freqMax != null && freqMin > freqMax) {
      errors.push('Frequency min must be <= frequency max.');
    }

    const rules = [];
    for (const rule of state.samplingRules) {
      const selectorType = String(rule.selectorType || 'freq_range');
      const positionSampler = String(rule.positionSampler || '').trim();
      const momentumSampler = String(rule.momentumSampler || '').trim();
      if (selectorType === 'mode_indices') {
        try {
          const modeIndices = parseModeIndicesText(rule.modeIndicesText);
          rules.push({
            selector_type: 'mode_indices',
            mode_indices: modeIndices,
            ...(positionSampler ? { position_sampler: positionSampler } : {}),
            ...(momentumSampler ? { momentum_sampler: momentumSampler } : {}),
          });
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          errors.push(detail);
        }
      } else {
        const ruleFreqMin = parseOptionalNumber(rule.freqMinText);
        const ruleFreqMax = parseOptionalNumber(rule.freqMaxText);
        if (ruleFreqMin != null && ruleFreqMax != null && ruleFreqMin > ruleFreqMax) {
          errors.push('Each frequency-range rule must use min <= max.');
        }
        rules.push({
          selector_type: 'freq_range',
          ...(ruleFreqMin != null ? { freq_min_cm1: ruleFreqMin } : {}),
          ...(ruleFreqMax != null ? { freq_max_cm1: ruleFreqMax } : {}),
          ...(positionSampler ? { position_sampler: positionSampler } : {}),
          ...(momentumSampler ? { momentum_sampler: momentumSampler } : {}),
        });
      }
    }

    const previewCount = Number.isFinite(previewCountRaw)
      ? Math.max(1, Math.min(MAX_PREVIEW_COUNT, previewCountRaw, Number.isFinite(sampleCount) ? sampleCount : MAX_PREVIEW_COUNT))
      : DEFAULT_PREVIEW_COUNT;

    return {
      payload: {
        sample_count: Number.isFinite(sampleCount) ? sampleCount : DEFAULT_SAMPLE_COUNT,
        preview_count: previewCount,
        position_default: positionDefault,
        momentum_default: momentumDefault,
        ...(temperature != null ? { temperature_k: temperature } : {}),
        ...(seed != null ? { seed: Math.trunc(seed) } : {}),
        ...(freqMin != null ? { freq_min_cm1: freqMin } : {}),
        ...(freqMax != null ? { freq_max_cm1: freqMax } : {}),
        rules,
      },
      errors,
    };
  }

  function buildSamplingPlanPreview() {
    const summaries = Array.isArray(state.parsed?.mode_summaries) ? state.parsed.mode_summaries : [];
    const { payload, errors } = buildSamplingConfigFromForm();
    const planRows = [];
    if (!summaries.length) {
      return { payload, rows: planRows, errors };
    }

    for (const summary of summaries) {
      const modeIndex = Number.parseInt(String(summary?.mode_index), 10);
      const frequencyCm1 = Number(summary?.frequency_cm1);
      const kind = String(summary?.kind || 'positive').trim().toLowerCase() || 'positive';
      let included = true;
      let reason = 'included';

      if (Number.isFinite(payload.freq_min_cm1) && frequencyCm1 < Number(payload.freq_min_cm1)) {
        included = false;
        reason = 'excluded_by_freq_min';
      }
      if (Number.isFinite(payload.freq_max_cm1) && frequencyCm1 > Number(payload.freq_max_cm1)) {
        included = false;
        reason = 'excluded_by_freq_max';
      }

      let positionSampler = String(payload.position_default);
      let momentumSampler = String(payload.momentum_default);
      if (included) {
        for (const rule of payload.rules) {
          let matches = false;
          if (rule.selector_type === 'mode_indices') {
            matches = Array.isArray(rule.mode_indices) && rule.mode_indices.includes(modeIndex);
          } else {
            const minValue = Number(rule.freq_min_cm1);
            const maxValue = Number(rule.freq_max_cm1);
            if (Number.isFinite(minValue) && frequencyCm1 < minValue) {
              matches = false;
            } else if (Number.isFinite(maxValue) && frequencyCm1 > maxValue) {
              matches = false;
            } else {
              matches = true;
            }
          }
          if (!matches) continue;
          if (typeof rule.position_sampler === 'string' && rule.position_sampler) {
            positionSampler = rule.position_sampler;
          }
          if (typeof rule.momentum_sampler === 'string' && rule.momentum_sampler) {
            momentumSampler = rule.momentum_sampler;
          }
        }
      } else {
        positionSampler = SAMPLER_FROZEN;
        momentumSampler = SAMPLER_FROZEN;
      }

      let statusText = included ? 'included' : 'excluded';
      let statusClass = included ? 'included' : 'excluded';
      if (included && (kind === 'zero' || kind === 'imaginary')) {
        if (positionSampler !== SAMPLER_FROZEN || momentumSampler !== SAMPLER_FROZEN) {
          reason = `${kind}_frequency_requires_frozen`;
          statusText = 'invalid';
          statusClass = 'excluded';
          errors.push(`Mode ${modeIndex + 1} has ${kind} frequency and only supports frozen sampling.`);
        } else {
          reason = `${kind}_frequency_frozen`;
        }
      }

      const requiresTemperature =
        positionSampler === SAMPLER_WIGNER_FINITE_T ||
        positionSampler === SAMPLER_CLASSICAL_FINITE_T ||
        momentumSampler === SAMPLER_WIGNER_FINITE_T ||
        momentumSampler === SAMPLER_CLASSICAL_FINITE_T;
      if (requiresTemperature && !Number.isFinite(payload.temperature_k)) {
        const detail = `Mode ${modeIndex + 1} requires temperature for finite-temperature sampling.`;
        if (!errors.includes(detail)) {
          errors.push(detail);
        }
      }

      planRows.push({
        modeIndex,
        frequencyCm1,
        kind,
        included,
        positionSampler,
        momentumSampler,
        reason,
        statusText,
        statusClass,
      });
    }

    return {
      payload,
      rows: planRows,
      errors,
    };
  }

  function renderSamplingRules() {
    if (!dom.samplingRulesList || !dom.samplingRulesCount) return;
    dom.samplingRulesCount.textContent = String(state.samplingRules.length);
    dom.samplingRulesList.innerHTML = '';
    if (!state.samplingRules.length) {
      const empty = document.createElement('div');
      empty.className = 'modal-empty';
      empty.textContent = 'No override rules yet. Use defaults or add a rule by frequency range or mode indices.';
      dom.samplingRulesList.appendChild(empty);
      return;
    }

    for (const rule of state.samplingRules) {
      const row = document.createElement('div');
      row.className = 'rule-row';
      row.dataset.ruleId = String(rule.id);

      const grid = document.createElement('div');
      grid.className = 'rule-grid';

      const selectorGroup = document.createElement('div');
      selectorGroup.className = 'field-group';
      const selectorLabel = document.createElement('label');
      selectorLabel.textContent = 'Selector';
      const selectorSelect = document.createElement('select');
      selectorSelect.innerHTML = `
        <option value="freq_range">Frequency range</option>
        <option value="mode_indices">Mode indices</option>
      `;
      selectorSelect.value = rule.selectorType;
      selectorSelect.addEventListener('change', () => {
        rule.selectorType = selectorSelect.value || 'freq_range';
        renderSamplingRules();
        renderSamplingPlanPreview();
      });
      selectorGroup.appendChild(selectorLabel);
      selectorGroup.appendChild(selectorSelect);

      const indicesGroup = document.createElement('div');
      indicesGroup.className = `field-group${rule.selectorType === 'mode_indices' ? '' : ' u-hidden'}`;
      const indicesLabel = document.createElement('label');
      indicesLabel.textContent = 'Mode indices';
      const indicesInput = document.createElement('input');
      indicesInput.type = 'text';
      indicesInput.placeholder = '0, 1, 5-8';
      indicesInput.value = rule.modeIndicesText;
      indicesInput.addEventListener('input', () => {
        rule.modeIndicesText = indicesInput.value;
        renderSamplingPlanPreview();
      });
      indicesGroup.appendChild(indicesLabel);
      indicesGroup.appendChild(indicesInput);

      const freqMinGroup = document.createElement('div');
      freqMinGroup.className = `field-group${rule.selectorType === 'freq_range' ? '' : ' u-hidden'}`;
      const freqMinLabel = document.createElement('label');
      freqMinLabel.textContent = 'Rule freq min';
      const freqMinInput = document.createElement('input');
      freqMinInput.type = 'number';
      freqMinInput.step = '0.0001';
      freqMinInput.placeholder = 'optional';
      freqMinInput.value = rule.freqMinText;
      freqMinInput.addEventListener('input', () => {
        rule.freqMinText = freqMinInput.value;
        renderSamplingPlanPreview();
      });
      freqMinGroup.appendChild(freqMinLabel);
      freqMinGroup.appendChild(freqMinInput);

      const freqMaxGroup = document.createElement('div');
      freqMaxGroup.className = `field-group${rule.selectorType === 'freq_range' ? '' : ' u-hidden'}`;
      const freqMaxLabel = document.createElement('label');
      freqMaxLabel.textContent = 'Rule freq max';
      const freqMaxInput = document.createElement('input');
      freqMaxInput.type = 'number';
      freqMaxInput.step = '0.0001';
      freqMaxInput.placeholder = 'optional';
      freqMaxInput.value = rule.freqMaxText;
      freqMaxInput.addEventListener('input', () => {
        rule.freqMaxText = freqMaxInput.value;
        renderSamplingPlanPreview();
      });
      freqMaxGroup.appendChild(freqMaxLabel);
      freqMaxGroup.appendChild(freqMaxInput);

      const qGroup = document.createElement('div');
      qGroup.className = 'field-group';
      const qLabel = document.createElement('label');
      qLabel.textContent = 'Position override';
      const qSelect = document.createElement('select');
      qSelect.innerHTML = SAMPLER_OVERRIDE_OPTIONS.map((item) => `<option value="${item.value}">${item.label}</option>`).join('');
      qSelect.value = rule.positionSampler;
      qSelect.addEventListener('change', () => {
        rule.positionSampler = qSelect.value;
        renderSamplingPlanPreview();
      });
      qGroup.appendChild(qLabel);
      qGroup.appendChild(qSelect);

      const pGroup = document.createElement('div');
      pGroup.className = 'field-group';
      const pLabel = document.createElement('label');
      pLabel.textContent = 'Momentum override';
      const pSelect = document.createElement('select');
      pSelect.innerHTML = SAMPLER_OVERRIDE_OPTIONS.map((item) => `<option value="${item.value}">${item.label}</option>`).join('');
      pSelect.value = rule.momentumSampler;
      pSelect.addEventListener('change', () => {
        rule.momentumSampler = pSelect.value;
        renderSamplingPlanPreview();
      });
      pGroup.appendChild(pLabel);
      pGroup.appendChild(pSelect);

      grid.appendChild(selectorGroup);
      grid.appendChild(indicesGroup);
      grid.appendChild(freqMinGroup);
      grid.appendChild(freqMaxGroup);
      grid.appendChild(qGroup);
      grid.appendChild(pGroup);

      const actions = document.createElement('div');
      actions.className = 'distribution-actions';
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'rule-remove-btn';
      removeBtn.textContent = 'Remove Rule';
      removeBtn.addEventListener('click', () => {
        state.samplingRules = state.samplingRules.filter((item) => item.id !== rule.id);
        renderSamplingRules();
        renderSamplingPlanPreview();
      });
      actions.appendChild(removeBtn);

      row.appendChild(grid);
      row.appendChild(actions);
      dom.samplingRulesList.appendChild(row);
    }
  }

  function renderSamplingPlanPreview() {
    const preview = buildSamplingPlanPreview();
    state.samplingPreviewState = preview;
    if (!dom.samplingPlanPreviewBody || !dom.samplingPlanCount) return;
    dom.samplingPlanCount.textContent = String(preview.rows.length);
    if (!preview.rows.length) {
      renderEmptyTableRow(dom.samplingPlanPreviewBody, 'Upload a molden file to populate the sampling preview table.');
      setSamplingModalStatus('Upload a molden file to preview per-mode sampling decisions.', false);
      setSamplingModalFooterStatus(
        'The preview table reflects the current settings; the backend response is the final source of truth.',
        false
      );
      if (dom.samplingSubmitBtn) {
        dom.samplingSubmitBtn.disabled = true;
      }
      return;
    }

    dom.samplingPlanPreviewBody.innerHTML = '';
    for (const row of preview.rows) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>Mode ${row.modeIndex + 1}</td>
        <td>${formatFrequency(row.frequencyCm1)} cm^-1</td>
        <td>${row.kind}</td>
        <td><span class="plan-status ${row.statusClass}">${row.statusText}</span></td>
        <td>${shortSamplerLabel(row.positionSampler)}</td>
        <td>${shortSamplerLabel(row.momentumSampler)}</td>
        <td>${row.reason}</td>
      `;
      dom.samplingPlanPreviewBody.appendChild(tr);
    }

    const hasErrors = preview.errors.length > 0;
    if (hasErrors) {
      setSamplingModalStatus(preview.errors[0], true);
      setSamplingModalFooterStatus(
        `${preview.errors.length} validation issue${preview.errors.length === 1 ? '' : 's'} must be fixed before sampling.`,
        true
      );
    } else {
      const includedCount = preview.rows.filter((item) => item.included).length;
      const excludedCount = preview.rows.length - includedCount;
      setSamplingModalStatus(
        `Previewing ${preview.rows.length} modes: ${includedCount} included, ${excludedCount} excluded.`,
        false
      );
      setSamplingModalFooterStatus(
        'The preview table reflects the current settings; the backend response is the final source of truth.',
        false
      );
    }
    if (dom.samplingSubmitBtn) {
      dom.samplingSubmitBtn.disabled = !state.parsed || hasErrors || state.samplingJobInFlight;
    }
  }

  function summarizeSamplerCounts(plan, key) {
    const counts = { Wigner: 0, Classical: 0, Frozen: 0 };
    for (const item of plan) {
      if (!item || !item.included) continue;
      const family = samplerFamilyLabel(item[key]);
      if (family === 'Wigner') counts.Wigner += 1;
      else if (family === 'Classical') counts.Classical += 1;
      else counts.Frozen += 1;
    }
    return `Wigner ${counts.Wigner} · Classical ${counts.Classical} · Frozen ${counts.Frozen}`;
  }

  function summaryItem(label, value) {
    const item = document.createElement('div');
    item.className = 'summary-item';
    const labelEl = document.createElement('span');
    labelEl.className = 'summary-label';
    labelEl.textContent = String(label || '');
    const valueEl = document.createElement('span');
    valueEl.className = 'summary-value';
    valueEl.textContent = String(value || '');
    item.appendChild(labelEl);
    item.appendChild(valueEl);
    return item;
  }

  function renderSamplingSummary() {
    if (!dom.samplingSummaryGrid || !dom.samplingBatchPill || !dom.distributionBatchPill) return;
    const sample = state.samplingResult;
    dom.samplingBatchPill.textContent = sample?.preview_count != null ? String(sample.preview_count) : '0';
    dom.distributionBatchPill.textContent = sample?.sample_count != null ? String(sample.sample_count) : '0';
    dom.samplingSummaryGrid.innerHTML = '';
    if (dom.exportBundleBtn) {
      dom.exportBundleBtn.disabled = !sample?.batch_id || state.exportJobInFlight;
    }
    if (!sample) {
      const empty = document.createElement('div');
      empty.className = 'summary-empty';
      empty.textContent = 'Run a normal-mode sampling job to populate the ensemble summary.';
      dom.samplingSummaryGrid.appendChild(empty);
      setExportStatus('Export a reproducibility bundle after a sampling batch is available.', false);
      return;
    }

    const plan = Array.isArray(sample.mode_sampling_plan) ? sample.mode_sampling_plan : [];
    const includedCount = plan.filter((item) => item && item.included).length;
    const excludedCount = plan.length - includedCount;
    const freqMinText = formatOptionalNumber(parseOptionalNumber(dom.samplingFreqMin?.value), 'none');
    const freqMaxText = formatOptionalNumber(parseOptionalNumber(dom.samplingFreqMax?.value), 'none');

    dom.samplingSummaryGrid.appendChild(summaryItem('Batch ID', sample.batch_id || 'n/a'));
    dom.samplingSummaryGrid.appendChild(summaryItem('Sample Count', `${sample.sample_count || 0}`));
    dom.samplingSummaryGrid.appendChild(summaryItem('Preview Count', `${sample.preview_count || 0}`));
    dom.samplingSummaryGrid.appendChild(summaryItem('Temperature', `${formatOptionalNumber(sample.temperature_k ?? parseOptionalNumber(dom.samplingTemperature?.value), 'n/a')} K`));
    dom.samplingSummaryGrid.appendChild(summaryItem('Seed', `${sample.seed}`));
    dom.samplingSummaryGrid.appendChild(summaryItem('Completed At', sample.sampling_completed_at_utc || 'n/a'));
    dom.samplingSummaryGrid.appendChild(summaryItem('Frequency Filter', `min=${freqMinText} · max=${freqMaxText}`));
    dom.samplingSummaryGrid.appendChild(summaryItem('Rules', `${state.samplingRules.length}`));
    dom.samplingSummaryGrid.appendChild(summaryItem('Modes', `${includedCount} included · ${excludedCount} excluded`));
    dom.samplingSummaryGrid.appendChild(summaryItem('Q Mix', summarizeSamplerCounts(plan, 'position_sampler')));
    dom.samplingSummaryGrid.appendChild(summaryItem('P Mix', summarizeSamplerCounts(plan, 'momentum_sampler')));
    if (!state.exportJobInFlight) {
      setExportStatus(`Export ready for batch ${sample.batch_id}.`, false);
    }
  }

  function purgeMeasurementPlot() {
    if (dom.measurementPlot && typeof Plotly !== 'undefined') {
      try {
        Plotly.purge(dom.measurementPlot);
      } catch (_) {
        // ignore
      }
    }
  }

  function clearMeasurementPlot(message) {
    if (!dom.measurementPlot) return;
    purgeMeasurementPlot();
    dom.measurementPlot.innerHTML = '';
    const empty = document.createElement('div');
    empty.className = 'distribution-empty';
    empty.textContent = String(message || 'Run sampling and request a bond, angle, or dihedral histogram.');
    dom.measurementPlot.appendChild(empty);
  }

  function syncMeasurementKindUi() {
    const kind = String(dom.measurementKind?.value || 'bond');
    if (dom.measurementAtom2Group) {
      dom.measurementAtom2Group.classList.toggle('u-hidden', kind === 'bond');
    }
    if (dom.measurementAtom3Group) {
      dom.measurementAtom3Group.classList.toggle('u-hidden', kind !== 'dihedral');
    }
  }

  function measurementXAxisTitle(kind) {
    if (kind === 'bond') return 'Distance (Å)';
    if (kind === 'angle') return 'Angle (deg)';
    if (kind === 'dihedral') return 'Dihedral (deg)';
    return 'Value';
  }

  function renderMeasurementHistogram(payload) {
    if (!dom.measurementPlot) return;
    if (typeof Plotly === 'undefined') {
      clearMeasurementPlot('Plot unavailable because Plotly failed to load.');
      return;
    }
    const values = Array.isArray(payload?.values) ? payload.values.map((value) => Number(value)).filter(Number.isFinite) : [];
    if (!values.length) {
      clearMeasurementPlot('No valid measurement values were returned for this sample batch.');
      return;
    }
    const plotColors = getPlotColors();
    const accentColor = readCssVar('--accent', '#0f5dcf');
    const layout = mergePlotlyLayout({
      height: 340,
      margin: { l: 58, r: 18, t: 18, b: 48 },
      bargap: 0.05,
      xaxis: {
        title: measurementXAxisTitle(payload.measurement_kind),
        showline: true,
        mirror: 'ticks',
        ticks: 'outside',
      },
      yaxis: {
        title: 'Count',
        showline: true,
        mirror: 'ticks',
        ticks: 'outside',
        rangemode: 'tozero',
      },
    });
    Plotly.react(
      dom.measurementPlot,
      [
        {
          type: 'histogram',
          x: values,
          marker: {
            color: accentColor,
            line: { color: plotColors.traceMutedColor || 'rgba(120,120,120,0.35)', width: 1 },
          },
          hovertemplate:
            `${payload.measurement_kind} histogram` +
            `<br>value=%{x:.4f}` +
            `<br>count=%{y}<extra></extra>`,
        },
      ],
      layout,
      {
        responsive: true,
        displaylogo: false,
        toImageButtonOptions: { format: 'png', scale: PLOT_EXPORT_SCALE },
      }
    );
  }

  function syncWorkspaceUi() {
    const inModes = state.workspace === WORKSPACE_MODES;
    if (dom.workspaceModesBtn) {
      dom.workspaceModesBtn.classList.toggle('is-active', inModes);
      dom.workspaceModesBtn.setAttribute('aria-selected', inModes ? 'true' : 'false');
    }
    if (dom.workspaceSamplingBtn) {
      dom.workspaceSamplingBtn.classList.toggle('is-active', !inModes);
      dom.workspaceSamplingBtn.setAttribute('aria-selected', !inModes ? 'true' : 'false');
    }
    if (dom.workspaceHint) {
      dom.workspaceHint.textContent = inModes
        ? 'View the selected mode animation and the corresponding IR spectrum.'
        : 'View sampled-ensemble overlays and geometry distributions from the current batch.';
    }
    if (dom.workspaceModesPanel) {
      dom.workspaceModesPanel.hidden = !inModes;
    }
    if (dom.workspaceSamplingPanel) {
      dom.workspaceSamplingPanel.hidden = inModes;
    }
    syncModeAtomIndexLabels();
    syncFrameUi();
  }

  function renderWorkspaceViewer({ refit = false } = {}) {
    if (state.workspace === WORKSPACE_MODES) {
      if (!state.modesViewer) return;
      resizeViewer(WORKSPACE_MODES);
      if (state.parsed && state.selectedModeIndex >= 0) {
        rebuildCurrentModeFrames({ refit });
      } else {
        clearViewerScene(WORKSPACE_MODES);
        state.modesViewer.render();
      }
      return;
    }

    if (!state.samplingViewer) return;
    stopPlayback();
    resizeViewer(WORKSPACE_SAMPLING);
    if (state.samplingResult) {
      renderSamplingPreview({ refit });
      return;
    }
    renderEquilibriumStructure({ refit, workspace: WORKSPACE_SAMPLING });
  }

  function setWorkspace(nextWorkspace, { refit = false } = {}) {
    const workspace = nextWorkspace === WORKSPACE_SAMPLING ? WORKSPACE_SAMPLING : WORKSPACE_MODES;
    if (workspace === state.workspace) {
      syncWorkspaceUi();
      renderWorkspaceViewer({ refit });
      return;
    }
    if (workspace !== WORKSPACE_MODES) {
      stopPlayback();
    }
    state.workspace = workspace;
    syncWorkspaceUi();
    renderWorkspaceViewer({ refit });
    if (workspace === WORKSPACE_SAMPLING && !state.samplingResult) {
      setStatus('Sampling view is ready. Open Sampling Settings to generate an ensemble.', false, WORKSPACE_SAMPLING);
    }
  }

  function openSamplingModal() {
    if (!dom.samplingModal) return;
    dom.samplingModal.hidden = false;
    renderSamplingRules();
    renderSamplingPlanPreview();
  }

  function closeSamplingModal() {
    if (!dom.samplingModal) return;
    dom.samplingModal.hidden = true;
  }

  async function parseUploadedFile(file) {
    const content = await file.text();
    const response = await fetch(`${getApiBase()}/normal-modes/parse-text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: String(file?.name || 'uploaded.molden'),
        content,
      }),
    });
    if (!response.ok) {
      let detail = `HTTP ${response.status}`;
      try {
        const payload = await response.json();
        if (payload && typeof payload.detail === 'string' && payload.detail.trim()) {
          detail = payload.detail.trim();
        }
      } catch (_) {
        // Best-effort error parsing.
      }
      throw new Error(detail);
    }
    return {
      content,
      payload: await response.json(),
    };
  }

  function resetSamplingState() {
    state.samplingResult = null;
    state.exportJobInFlight = false;
    state.lastMeasurementPayload = null;
    renderSamplingSummary();
    clearMeasurementPlot('Run sampling and request a bond, angle, or dihedral histogram.');
    setMeasurementStatus('Pick a sampled batch, choose a geometry target, and plot its distribution.', false);
  }

  function applyParsedPayload(payload, contentText) {
    state.parsed = payload;
    state.uploadedContent = String(contentText || '');
    state.fileName = String(payload?.source_name || '');
    if (dom.fileName) {
      dom.fileName.textContent = state.fileName || 'Uploaded molden file';
      dom.fileName.title = state.fileName || 'Uploaded molden file';
    }
    resetSamplingState();
    const defaultModeIndex = Number.parseInt(String(payload?.default_mode_index), 10);
    renderModeList();
    renderSpectrum();
    renderSamplingRules();
    renderSamplingPlanPreview();
    setWorkspace(WORKSPACE_MODES, { refit: false });
    setSelectedMode(Number.isFinite(defaultModeIndex) ? defaultModeIndex : 0, { refit: true });
    setStatus(
      `Parsed ${state.fileName}: ${Number(payload?.n_atoms || 0)} atoms, ` +
      `${Array.isArray(payload?.mode_summaries) ? payload.mode_summaries.length : 0} modes.`
    );
  }

  async function handleFileSelection(file) {
    if (!file) return;
    setStatus(`Parsing ${file.name}...`);
    try {
      const parsed = await parseUploadedFile(file);
      applyParsedPayload(parsed.payload, parsed.content);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      state.parsed = null;
      state.uploadedContent = '';
      resetSamplingState();
      renderModeList();
      renderSpectrum();
      renderSamplingPlanPreview();
      setStatus(`Failed to parse ${file.name}: ${detail}`, true);
    } finally {
      if (dom.fileInput) {
        dom.fileInput.value = '';
      }
    }
  }

  async function submitSamplingJob() {
    if (!state.parsed || !state.uploadedContent) {
      setSamplingModalStatus('Upload a molden file before launching a sampling job.', true);
      return;
    }
    const preview = buildSamplingPlanPreview();
    state.samplingPreviewState = preview;
    if (preview.errors.length) {
      setSamplingModalStatus(preview.errors[0], true);
      setSamplingModalFooterStatus('Fix the current sampling settings before launching the job.', true);
      return;
    }

    const requestPayload = {
      filename: state.fileName || 'uploaded.molden',
      content: state.uploadedContent,
      ...preview.payload,
    };

    state.samplingJobInFlight = true;
    renderSamplingPlanPreview();
    setSamplingModalFooterStatus('Sampling on backend...', false);
    setStatus(`Sampling ${requestPayload.sample_count} structures on backend...`);
    try {
      const response = await fetch(`${getApiBase()}/normal-modes/sample-text`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestPayload),
      });
      if (!response.ok) {
        let detail = `HTTP ${response.status}`;
        try {
          const payload = await response.json();
          if (payload && typeof payload.detail === 'string' && payload.detail.trim()) {
            detail = payload.detail.trim();
          }
        } catch (_) {
          // Best-effort error parsing.
        }
        throw new Error(detail);
      }
      const payload = await response.json();
      state.samplingResult = payload;
      state.lastMeasurementPayload = null;
      renderSamplingSummary();
      clearMeasurementPlot('Choose a bond, angle, or dihedral target to draw a histogram for the sampled batch.');
      setMeasurementStatus(
        `Batch ${payload.batch_id} ready. Previewing ${payload.preview_count}/${payload.sample_count} sampled structures.`,
        false
      );
      closeSamplingModal();
      setWorkspace(WORKSPACE_SAMPLING, { refit: true });
      setStatus(
        `Sampled ${payload.sample_count} structures. Previewing ${payload.preview_count} in the sampling workspace.`
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setSamplingModalStatus(`Failed to sample normal modes: ${detail}`, true);
      setSamplingModalFooterStatus('The sampling request failed on backend.', true);
      setStatus(`Failed to sample normal modes: ${detail}`, true);
    } finally {
      state.samplingJobInFlight = false;
      renderSamplingPlanPreview();
    }
  }

  async function exportSamplingBundle() {
    const batchId = String(state.samplingResult?.batch_id || '').trim();
    if (!batchId) {
      setExportStatus('Run sampling first to create an exportable batch.', true);
      return;
    }

    state.exportJobInFlight = true;
    renderSamplingSummary();
    setExportStatus(`Exporting reproducibility bundle for ${batchId}...`, false);
    let finalStatusMessage = '';
    let finalStatusIsError = false;
    try {
      const response = await fetch(
        `${getApiBase()}/normal-modes/sample-batches/${encodeURIComponent(batchId)}/export`
      );
      if (!response.ok) {
        let detail = `HTTP ${response.status}`;
        try {
          const payload = await response.json();
          if (payload && typeof payload.detail === 'string' && payload.detail.trim()) {
            detail = payload.detail.trim();
          }
        } catch (_) {
          // Best-effort error parsing.
        }
        throw new Error(detail);
      }

      const fileName = getDownloadFilename(response, `normal_modes_sampling_${batchId}.tar.gz`);
      const archiveBlob = await response.blob();
      triggerBlobDownload(fileName, archiveBlob);
      finalStatusMessage = `Downloaded ${fileName}.`;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      finalStatusMessage = `Failed to export bundle: ${detail}`;
      finalStatusIsError = true;
    } finally {
      state.exportJobInFlight = false;
      renderSamplingSummary();
      setExportStatus(finalStatusMessage || `Export ready for batch ${batchId}.`, finalStatusIsError);
    }
  }

  async function plotMeasurementHistogram() {
    if (!state.samplingResult?.batch_id) {
      setMeasurementStatus('Run sampling first to create a sample batch.', true);
      return;
    }
    const kind = String(dom.measurementKind?.value || 'bond');
    const atomIndices = [
      Number.parseInt(String(dom.measurementAtom0?.value || ''), 10),
      Number.parseInt(String(dom.measurementAtom1?.value || ''), 10),
    ];
    if (kind === 'angle' || kind === 'dihedral') {
      atomIndices.push(Number.parseInt(String(dom.measurementAtom2?.value || ''), 10));
    }
    if (kind === 'dihedral') {
      atomIndices.push(Number.parseInt(String(dom.measurementAtom3?.value || ''), 10));
    }
    if (atomIndices.some((value) => !Number.isFinite(value) || value < 0)) {
      setMeasurementStatus('Measurement atom indices must be non-negative integers.', true);
      return;
    }
    setMeasurementStatus(`Computing ${kind} distribution on backend...`, false);
    try {
      const response = await fetch(
        `${getApiBase()}/normal-modes/sample-batches/${encodeURIComponent(state.samplingResult.batch_id)}/measurements`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            measurement_kind: kind,
            atom_indices: atomIndices,
          }),
        }
      );
      if (!response.ok) {
        let detail = `HTTP ${response.status}`;
        try {
          const payload = await response.json();
          if (payload && typeof payload.detail === 'string' && payload.detail.trim()) {
            detail = payload.detail.trim();
          }
        } catch (_) {
          // Best-effort error parsing.
        }
        throw new Error(detail);
      }
      const payload = await response.json();
      state.lastMeasurementPayload = payload;
      renderMeasurementHistogram(payload);
      setMeasurementStatus(
        `${payload.measurement_kind} (${payload.atom_indices.join('-')}) · n=${payload.sample_count} · ` +
        `min=${payload.min.toFixed(4)} · max=${payload.max.toFixed(4)} · ` +
        `mean=${payload.mean.toFixed(4)} · std=${payload.std.toFixed(4)}`,
        false
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setMeasurementStatus(`Failed to compute measurement histogram: ${detail}`, true);
    }
  }

  function bindEvents() {
    if (dom.fileInput) {
      dom.fileInput.addEventListener('change', () => {
        const file = dom.fileInput?.files?.[0] || null;
        void handleFileSelection(file);
      });
    }

    if (dom.openSamplingSettingsBtn) {
      dom.openSamplingSettingsBtn.addEventListener('click', () => {
        openSamplingModal();
      });
    }
    if (dom.samplingModalCloseBtn) {
      dom.samplingModalCloseBtn.addEventListener('click', () => {
        closeSamplingModal();
      });
    }
    if (dom.samplingModal) {
      dom.samplingModal.addEventListener('click', (event) => {
        if (event.target === dom.samplingModal) {
          closeSamplingModal();
        }
      });
    }
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && dom.samplingModal && !dom.samplingModal.hidden) {
        closeSamplingModal();
      }
    });

    if (dom.workspaceModesBtn) {
      dom.workspaceModesBtn.addEventListener('click', () => {
        setWorkspace(WORKSPACE_MODES, { refit: true });
      });
    }
    if (dom.workspaceSamplingBtn) {
      dom.workspaceSamplingBtn.addEventListener('click', () => {
        setWorkspace(WORKSPACE_SAMPLING, { refit: true });
      });
    }

    if (dom.modeList) {
      dom.modeList.addEventListener('click', (event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const button = target.closest('.mode-item');
        if (!button) return;
        const modeIndex = button.getAttribute('data-mode-index');
        if (modeIndex == null) return;
        setSelectedMode(modeIndex, { refit: false });
      });
    }

    if (dom.amplitudeSlider) {
      dom.amplitudeSlider.addEventListener('input', () => {
        syncAmplitudeUi();
        if (!state.parsed || state.selectedModeIndex < 0) {
          renderModeDetail();
          return;
        }
        if (state.workspace === WORKSPACE_MODES) {
          rebuildCurrentModeFrames({ refit: false });
        } else {
          renderModeDetail();
        }
      });
    }

    if (dom.speedSlider) {
      dom.speedSlider.addEventListener('input', () => {
        state.playbackRate = clampPlaybackRate(dom.speedSlider?.value);
        syncPlaybackRateUi();
        restartPlaybackTimerIfPlaying();
      });
    }

    if (dom.spectrumWidthSlider) {
      dom.spectrumWidthSlider.addEventListener('input', () => {
        syncSpectrumWidthUi();
        renderSpectrum();
      });
    }

    if (dom.playBtn) {
      dom.playBtn.addEventListener('click', () => {
        if (state.isPlaying) {
          stopPlayback();
          return;
        }
        startPlayback();
      });
    }

    if (dom.prevBtn) {
      dom.prevBtn.addEventListener('click', () => {
        stopPlayback();
        void renderFrame(state.currentFrame - 1);
      });
    }

    if (dom.nextBtn) {
      dom.nextBtn.addEventListener('click', () => {
        stopPlayback();
        void renderFrame(state.currentFrame + 1);
      });
    }

    if (dom.frameSlider) {
      dom.frameSlider.addEventListener('input', () => {
        stopPlayback();
        void renderFrame(dom.frameSlider?.value);
      });
    }

    if (dom.showAtomIndexCheckbox) {
      dom.showAtomIndexCheckbox.addEventListener('change', () => {
        syncModeAtomIndexLabels();
        if (state.workspace === WORKSPACE_MODES && state.modesViewer) {
          state.modesViewer.render();
        }
      });
    }

    const previewInputs = [
      dom.samplingSampleCount,
      dom.samplingPreviewCount,
      dom.samplingTemperature,
      dom.samplingSeed,
      dom.samplingFreqMin,
      dom.samplingFreqMax,
      dom.samplingPositionDefault,
      dom.samplingMomentumDefault,
    ];
    for (const input of previewInputs) {
      if (!input) continue;
      input.addEventListener('input', () => {
        renderSamplingPlanPreview();
      });
      input.addEventListener('change', () => {
        renderSamplingPlanPreview();
      });
    }

    if (dom.samplingAddRuleBtn) {
      dom.samplingAddRuleBtn.addEventListener('click', () => {
        state.samplingRules.push(createEmptyRule());
        renderSamplingRules();
        renderSamplingPlanPreview();
      });
    }

    if (dom.samplingSubmitBtn) {
      dom.samplingSubmitBtn.addEventListener('click', () => {
        void submitSamplingJob();
      });
    }

    if (dom.exportBundleBtn) {
      dom.exportBundleBtn.addEventListener('click', () => {
        void exportSamplingBundle();
      });
    }

    if (dom.measurementKind) {
      dom.measurementKind.addEventListener('change', () => {
        syncMeasurementKindUi();
      });
    }
    if (dom.measurementPlotBtn) {
      dom.measurementPlotBtn.addEventListener('click', () => {
        void plotMeasurementHistogram();
      });
    }

    window.addEventListener('resize', () => {
      resizeViewer(WORKSPACE_MODES);
      resizeViewer(WORKSPACE_SAMPLING);
    });

    const appearance = getAppearanceModule();
    if (appearance && typeof appearance.initControls === 'function') {
      appearance.initControls();
    }
    if (appearance && typeof appearance.subscribe === 'function') {
      appearance.subscribe(() => {
        applyViewerAppearance();
        renderSpectrum();
        if (state.lastMeasurementPayload) {
          renderMeasurementHistogram(state.lastMeasurementPayload);
        }
      });
    }
  }

  function initViewer() {
    if (typeof $3Dmol === 'undefined') {
      setStatus('3Dmol.js failed to load.', true, WORKSPACE_MODES);
      setStatus('3Dmol.js failed to load.', true, WORKSPACE_SAMPLING);
      return false;
    }
    if (!dom.modesViewerEl || !dom.samplingViewerEl) {
      setStatus('Viewer container not found.', true, WORKSPACE_MODES);
      setStatus('Viewer container not found.', true, WORKSPACE_SAMPLING);
      return false;
    }
    const backgroundColor = currentViewerTheme().backgroundColor || '#fbfdff';
    state.modesViewer = $3Dmol.createViewer(dom.modesViewerEl, {
      backgroundColor,
    });
    state.samplingViewer = $3Dmol.createViewer(dom.samplingViewerEl, {
      backgroundColor,
    });
    resizeViewer(WORKSPACE_MODES);
    resizeViewer(WORKSPACE_SAMPLING);
    return true;
  }

  function syncControls() {
    syncAmplitudeUi();
    syncPlaybackRateUi();
    syncSpectrumWidthUi();
    syncMeasurementKindUi();
    syncWorkspaceUi();
    syncFrameUi();
    renderModeDetail();
    renderModeList();
    renderSpectrum();
    renderSamplingRules();
    renderSamplingPlanPreview();
    renderSamplingSummary();
    clearMeasurementPlot('Run sampling and request a bond, angle, or dihedral histogram.');
    setMeasurementStatus('Pick a sampled batch, choose a geometry target, and plot its distribution.', false);
  }

  function init() {
    syncControls();
    bindEvents();
    if (!initViewer()) return;
    applyViewerAppearance();
    renderWorkspaceViewer({ refit: true });
  }

  init();
})();
