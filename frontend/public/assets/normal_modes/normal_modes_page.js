(function () {
  const MODE_FRAME_COUNT = 32;
  const BASE_PLAYBACK_FPS = 14;
  const PLAYBACK_RATE_MIN = 0.5;
  const PLAYBACK_RATE_MAX = 4.0;
  const PLAYBACK_RATE_STEP = 0.25;
  const PLAYBACK_RATE_DEFAULT = 1.0;
  const MODEL_STICK_RADIUS_BASE = 0.15;
  const MODEL_SPHERE_SCALE_BASE = 0.28;
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

  const dom = {
    fileInput: document.getElementById('nm-file-input'),
    fileName: document.getElementById('nm-file-name'),
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
    modeDetail: document.getElementById('nm-mode-detail'),
    spectrumModeCount: document.getElementById('nm-spectrum-mode-count'),
    spectrumWidthSlider: document.getElementById('nm-spectrum-width-slider'),
    spectrumWidthLabel: document.getElementById('nm-spectrum-width-label'),
    spectrumPlot: document.getElementById('nm-spectrum-plot'),
    spectrumStatus: document.getElementById('nm-spectrum-status'),
    viewerEl: document.getElementById('nm-viewer'),
    statusEl: document.getElementById('nm-status'),
  };

  const state = {
    viewer: null,
    model: null,
    parsed: null,
    fileName: '',
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
    spectrumFwhm: SPECTRUM_FWHM_DEFAULT,
  };

  function setStatus(message, isError = false) {
    if (!dom.statusEl) return;
    dom.statusEl.textContent = String(message || '');
    dom.statusEl.classList.toggle('error', !!isError);
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

  function atomicNumberToElement(rawValue) {
    const value = Number.parseInt(String(rawValue), 10);
    const symbols = getPeriodicSymbols();
    if (Number.isFinite(value) && value > 0 && value < symbols.length && symbols[value]) {
      return symbols[value];
    }
    return 'C';
  }

  function buildXyzFrame(coords, atomNumbers, frameIndex) {
    if (!Array.isArray(coords) || !coords.length) return '';
    const lines = [
      String(coords.length),
      `Normal mode frame ${Number.parseInt(String(frameIndex), 10) + 1}`,
    ];
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

  function currentViewerTheme() {
    const appearance = getAppearanceModule();
    if (appearance && typeof appearance.getViewerTheme === 'function') {
      return appearance.getViewerTheme();
    }
    return {
      backgroundColor: '#fbfdff',
    };
  }

  function applyViewerAppearance() {
    if (!state.viewer || typeof state.viewer.setBackgroundColor !== 'function') return;
    state.viewer.setBackgroundColor(currentViewerTheme().backgroundColor || '#fbfdff');
    state.viewer.render();
  }

  function resizeViewer() {
    if (!state.viewer) return;
    state.viewer.resize();
    state.viewer.render();
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
    const hasFrames = frameCount > 0;
    const frameIndex = hasFrames ? clampFrameIndex(state.currentFrame) : 0;
    state.currentFrame = frameIndex;
    if (dom.frameSlider) {
      dom.frameSlider.disabled = !hasFrames;
      dom.frameSlider.min = '0';
      dom.frameSlider.max = String(Math.max(0, frameCount - 1));
      dom.frameSlider.step = '1';
      dom.frameSlider.value = String(frameIndex);
    }
    if (dom.frameLabel) {
      dom.frameLabel.textContent = hasFrames ? `Frame ${frameIndex + 1}/${frameCount}` : 'Frame 0/0';
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

  function getPlaybackIntervalMs() {
    const fps = BASE_PLAYBACK_FPS * clampPlaybackRate(state.playbackRate);
    if (!Number.isFinite(fps) || fps <= 0) {
      return Math.round(1000 / BASE_PLAYBACK_FPS);
    }
    return Math.max(1, Math.round(1000 / fps));
  }

  function modeTagClass(kind) {
    const value = String(kind || '').trim().toLowerCase();
    if (value === 'imaginary') return 'imaginary';
    if (value === 'zero') return 'zero';
    return 'positive';
  }

  function formatFrequency(rawValue) {
    const value = Number(rawValue);
    return Number.isFinite(value) ? value.toFixed(4) : 'n/a';
  }

  function formatIntensity(rawValue) {
    const value = Number(rawValue);
    return Number.isFinite(value) ? value.toFixed(4) : 'n/a';
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

  function clearViewerModel() {
    if (!state.viewer) return;
    state.viewer.removeAllModels();
    state.model = null;
  }

  function loadFramesIntoViewer(frames, atomNumbers, { refit = true } = {}) {
    if (!state.viewer || !Array.isArray(frames) || !frames.length) return false;
    const firstFrameXyz = buildXyzFrame(frames[0], atomNumbers, 0);
    if (!firstFrameXyz) return false;

    clearViewerModel();
    const model = state.viewer.addModel(firstFrameXyz, 'xyz');
    if (!model) return false;
    if (typeof model.setCoordinates === 'function') {
      model.setCoordinates(frames, 'array');
    }
    state.model = model;
    state.viewer.setStyle(
      {},
      {
        stick: { radius: MODEL_STICK_RADIUS_BASE, colorscheme: 'Jmol' },
        sphere: { scale: MODEL_SPHERE_SCALE_BASE, colorscheme: 'Jmol' },
      }
    );
    if (refit && typeof state.viewer.zoomTo === 'function') {
      state.viewer.zoomTo();
    }
    state.viewer.render();
    return true;
  }

  async function renderFrame(frameIndex) {
    if (!state.viewer || !state.model) return false;
    const frameCount = Array.isArray(state.frameCoords) ? state.frameCoords.length : 0;
    if (frameCount <= 0) return false;
    const nextIndex = clampFrameIndex(frameIndex);
    const renderSeq = ++state.renderSeq;
    state.currentFrame = nextIndex;
    if (typeof state.model.setFrame === 'function') {
      await state.model.setFrame(nextIndex, state.viewer);
    }
    if (renderSeq !== state.renderSeq) return false;
    state.viewer.render();
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
    if (!state.isPlaying) return;
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
    if (!Array.isArray(state.frameCoords) || !state.frameCoords.length || !state.model) return;
    stopPlayback();
    state.isPlaying = true;
    state.playbackLastTickMs = 0;
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
      clearViewerModel();
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
      setStatus('Failed to initialize 3D viewer for the selected mode.', true);
      syncFrameUi();
      renderModeDetail();
      return;
    }
    void renderFrame(0);
    renderModeDetail();
  }

  function setSelectedMode(modeIndex, { refit = false } = {}) {
    const summaries = Array.isArray(state.parsed?.mode_summaries) ? state.parsed.mode_summaries : [];
    const nextIndex = Number.parseInt(String(modeIndex), 10);
    if (!Number.isFinite(nextIndex) || nextIndex < 0 || nextIndex >= summaries.length) {
      return;
    }
    state.selectedModeIndex = nextIndex;
    renderModeList();
    rebuildCurrentModeFrames({ refit });
    renderSpectrum();
  }

  function applyParsedPayload(payload) {
    state.parsed = payload;
    state.fileName = String(payload?.source_name || '');
    if (dom.fileName) {
      dom.fileName.textContent = state.fileName || 'Uploaded molden file';
      dom.fileName.title = state.fileName || 'Uploaded molden file';
    }
    const defaultModeIndex = Number.parseInt(String(payload?.default_mode_index), 10);
    renderModeList();
    setSelectedMode(Number.isFinite(defaultModeIndex) ? defaultModeIndex : 0, { refit: true });
    setStatus(
      `Parsed ${state.fileName}: ${Number(payload?.n_atoms || 0)} atoms, ` +
      `${Array.isArray(payload?.mode_summaries) ? payload.mode_summaries.length : 0} modes.`
    );
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
    return response.json();
  }

  async function handleFileSelection(file) {
    if (!file) return;
    setStatus(`Parsing ${file.name}...`);
    try {
      const payload = await parseUploadedFile(file);
      applyParsedPayload(payload);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setStatus(`Failed to parse ${file.name}: ${detail}`, true);
    } finally {
      if (dom.fileInput) {
        dom.fileInput.value = '';
      }
    }
  }

  function syncControls() {
    syncAmplitudeUi();
    syncPlaybackRateUi();
    syncSpectrumWidthUi();
    syncFrameUi();
    renderModeDetail();
    renderModeList();
    renderSpectrum();
  }

  function bindEvents() {
    if (dom.fileInput) {
      dom.fileInput.addEventListener('change', () => {
        const file = dom.fileInput?.files?.[0] || null;
        void handleFileSelection(file);
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
        rebuildCurrentModeFrames({ refit: false });
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

    window.addEventListener('resize', resizeViewer);

    const appearance = getAppearanceModule();
    if (appearance && typeof appearance.initControls === 'function') {
      appearance.initControls();
    }
    if (appearance && typeof appearance.subscribe === 'function') {
      appearance.subscribe(() => {
        applyViewerAppearance();
        renderSpectrum();
      });
    }
  }

  function initViewer() {
    if (typeof $3Dmol === 'undefined') {
      setStatus('3Dmol.js failed to load.', true);
      return false;
    }
    if (!dom.viewerEl) {
      setStatus('Viewer container not found.', true);
      return false;
    }
    state.viewer = $3Dmol.createViewer(dom.viewerEl, {
      backgroundColor: currentViewerTheme().backgroundColor || '#fbfdff',
    });
    resizeViewer();
    return true;
  }

  function init() {
    syncControls();
    bindEvents();
    if (!initViewer()) return;
    applyViewerAppearance();
  }

  init();
})();
