(function () {
  const root = window.ObservableMol3D || (window.ObservableMol3D = {});
  const shared = root.shared;
  const geometry = root.geometry;
  if (!shared || !geometry) return;

  const { dom, constants, state, measureTypeButtons } = shared;

  function getAppearanceModule() {
    return window.ObservableAppearance || null;
  }

  function getPlotColors() {
    const appearance = getAppearanceModule();
    if (appearance && typeof appearance.getPlotColors === 'function') {
      return appearance.getPlotColors();
    }
    return {
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

  // --- Shared refresh helpers -------------------------------------------------
  function rerenderCurrentFrame() {
    const viewerModule = root.viewer;
    if (!viewerModule || typeof viewerModule.renderFrame !== 'function') return;
    if (!state.currentTrajId || !state.xyzFrames.length) return;
    viewerModule.renderFrame(state.currentFrame);
  }

  function refreshViews({ controls = true, plot = true, viewer = true } = {}) {
    if (controls) updateMeasurementControlState();
    if (plot) renderMeasurementPlot();
    if (viewer) rerenderCurrentFrame();
  }

  function refreshControlsOnly() {
    refreshViews({ plot: false, viewer: false });
  }

  // --- Track collection helpers ----------------------------------------------
  function findTrack(type, key) {
    return shared.getTracks(type).find((track) => track.key === key) || null;
  }

  function setTrackColor(type, trackKey, color) {
    const track = findTrack(type, trackKey);
    if (!track) return false;
    const sanitized = shared.sanitizeColorInput(color);
    if (!sanitized) return false;
    if (track.color === sanitized) return true;

    track.color = sanitized;
    refreshViews();
    const meta = shared.getMeasureMeta(type);
    shared.setStatus(`Updated color for ${meta.lowerName} ${shared.getTrackLabel(track)}.`);
    return true;
  }

  // --- Color settings panel ---------------------------------------------------
  function createColorSettingsRow(track, meta) {
    const row = document.createElement('div');
    row.className = 'bond-color-row';
    row.style.borderLeftColor = track.color;

    const swatch = document.createElement('span');
    swatch.className = 'bond-color-swatch';
    swatch.style.backgroundColor = track.color;

    const label = document.createElement('span');
    label.className = 'bond-color-label';
    label.textContent = `${meta.displayName} ${shared.getTrackLabel(track)}`;

    const input = document.createElement('input');
    input.type = 'color';
    input.className = 'bond-color-input';
    input.value = shared.normalizeHexColor(track.color);
    input.title = `Set color for ${meta.lowerName} ${shared.getTrackLabel(track)}`;
    input.addEventListener('input', () => {
      const nextColor = shared.sanitizeColorInput(input.value);
      if (!nextColor) return;
      swatch.style.backgroundColor = nextColor;
      row.style.borderLeftColor = nextColor;
    });
    input.addEventListener('change', () => {
      setTrackColor(track.type, track.key, input.value);
    });

    row.appendChild(swatch);
    row.appendChild(label);
    row.appendChild(input);
    return row;
  }

  function renderColorSettingsPanel() {
    if (!dom.bondColorSettingsListEl) return;
    dom.bondColorSettingsListEl.innerHTML = '';

    const meta = shared.getMeasureMeta();
    const tracks = shared.getTracks();
    if (!tracks.length) {
      const empty = document.createElement('div');
      empty.className = 'bond-color-empty';
      empty.textContent = `No tracked ${meta.pluralName.toLowerCase()}.`;
      dom.bondColorSettingsListEl.appendChild(empty);
      return;
    }

    for (const track of tracks) {
      dom.bondColorSettingsListEl.appendChild(createColorSettingsRow(track, meta));
    }
  }

  // --- Highlight state helpers ------------------------------------------------
  function isHighlighted(type, key) {
    return shared.getHighlightedKeys(type).has(key);
  }

  function getHighlightedTracks(type = state.activeMeasureType) {
    return shared.getTracks(type).filter((track) => shared.getHighlightedKeys(type).has(track.key));
  }

  function ensureHighlighted(type, key) {
    shared.getHighlightedKeys(type).add(key);
  }

  function toggleHighlight(type, key) {
    const highlightedKeys = shared.getHighlightedKeys(type);
    if (highlightedKeys.has(key)) {
      highlightedKeys.delete(key);
      return false;
    }
    highlightedKeys.add(key);
    return true;
  }

  // --- Measurement value/series computation ----------------------------------
  function computeMeasurementValue(type, frame, atoms) {
    if (!Array.isArray(frame) || !Array.isArray(atoms)) return NaN;
    if (atoms.some((index) => index < 0 || index >= frame.length)) return NaN;

    if (type === 'bond') {
      return geometry.distance3(frame[atoms[0]], frame[atoms[1]]);
    }
    if (type === 'angle') {
      return geometry.angleDeg(frame[atoms[0]], frame[atoms[1]], frame[atoms[2]]);
    }
    return geometry.dihedralDeg(frame[atoms[0]], frame[atoms[1]], frame[atoms[2]], frame[atoms[3]]);
  }

  function computeMeasurementSeries(type, atoms) {
    const meta = shared.getMeasureMeta(type);
    const series = [];
    if (!Array.isArray(state.currentCoords) || !state.currentCoords.length) return series;
    const frameCount = Math.min(state.currentCoords.length, state.currentTimes.length || state.currentCoords.length);
    const maxIndex = Math.max(...atoms);
    const rawValues = [];
    const timeValues = [];

    for (let i = 0; i < frameCount; i++) {
      const frame = state.currentCoords[i];
      if (!Array.isArray(frame) || frame.length <= maxIndex) continue;

      const value = computeMeasurementValue(type, frame, atoms);
      if (!Number.isFinite(value)) continue;
      const t = Number(state.currentTimes[i] ?? i);
      rawValues.push(value);
      timeValues.push(t);
    }

    const values = meta.needsUnwrap ? geometry.unwrapDegrees(rawValues) : rawValues;
    for (let i = 0; i < values.length; i++) {
      series.push({ t: timeValues[i], v: values[i] });
    }
    return series;
  }

  function buildTrack(type, atoms, color) {
    const canonical = geometry.canonicalMeasurement(type, atoms);
    if (!canonical) return null;
    return {
      type: shared.normalizeMeasureType(type),
      atoms: canonical.atoms,
      key: canonical.key,
      color,
      series: computeMeasurementSeries(type, canonical.atoms),
    };
  }

  function formatSelectionInfoText() {
    const meta = shared.getMeasureMeta();
    if (state.pendingAtomIndices.length) {
      const parts = state.pendingAtomIndices.map((value) => String(value));
      while (parts.length < meta.requiredAtoms) parts.push('?');
      return `Selecting ${meta.displayName}: ${parts.join(' - ')}`;
    }

    const tracks = shared.getTracks();
    if (!tracks.length) return `${meta.pluralName}: none`;

    return `${meta.pluralName}: ${tracks.length} | Highlighted: ${shared.getHighlightedKeys().size}`;
  }

  function removeTrack(trackKey) {
    const type = state.activeMeasureType;
    const meta = shared.getMeasureMeta(type);
    const tracks = shared.getTracks(type);
    const removeIdx = tracks.findIndex((track) => track.key === trackKey);
    if (removeIdx < 0) return;

    const removedTrack = tracks[removeIdx];
    tracks.splice(removeIdx, 1);
    shared.getHighlightedKeys(type).delete(trackKey);

    refreshViews();
    if (removedTrack) {
      shared.setStatus(`Removed ${meta.lowerName} ${shared.getTrackLabel(removedTrack)}.`);
    }
  }

  function createMeasurementListItem(track, type, meta) {
    const item = document.createElement('div');
    item.className = 'bond-item';
    item.style.borderLeftColor = track.color;
    if (isHighlighted(type, track.key)) item.classList.add('active');

    const trackLabel = shared.getTrackLabel(track);

    const activateBtn = document.createElement('button');
    activateBtn.type = 'button';
    activateBtn.className = 'bond-activate';
    activateBtn.textContent = trackLabel;
    activateBtn.title = `Toggle highlight for ${meta.lowerName} ${trackLabel}`;
    activateBtn.addEventListener('click', () => {
      const isHighlightedNow = toggleHighlight(type, track.key);
      refreshViews();
      shared.setStatus(
        isHighlightedNow
          ? `Highlighted ${meta.lowerName} ${trackLabel}.`
          : `Unhighlighted ${meta.lowerName} ${trackLabel}.`
      );
    });

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'bond-remove';
    removeBtn.textContent = '×';
    removeBtn.title = `Remove ${meta.lowerName} ${trackLabel}`;
    removeBtn.addEventListener('click', () => {
      removeTrack(track.key);
    });

    item.appendChild(activateBtn);
    item.appendChild(removeBtn);
    return item;
  }

  // --- Measurement list and controls -----------------------------------------
  function renderMeasurementList() {
    if (!dom.bondListEl) return;
    dom.bondListEl.innerHTML = '';

    const type = state.activeMeasureType;
    const meta = shared.getMeasureMeta(type);
    const tracks = shared.getTracks(type);

    if (!tracks.length) {
      const empty = document.createElement('div');
      empty.className = 'bond-list-empty';
      empty.textContent = `No ${meta.pluralName.toLowerCase()} selected.`;
      dom.bondListEl.appendChild(empty);
      return;
    }

    for (const track of tracks) {
      dom.bondListEl.appendChild(createMeasurementListItem(track, type, meta));
    }
  }

  function updateMeasurementControlState() {
    const type = state.activeMeasureType;
    const meta = shared.getMeasureMeta(type);
    const tracks = shared.getTracks(type);
    const highlightedKeys = shared.getHighlightedKeys(type);

    for (const measureType of constants.MEASURE_TYPES) {
      const btn = measureTypeButtons[measureType];
      if (!btn) continue;
      btn.classList.toggle('active', measureType === type);
    }

    if (dom.selectBondBtn) {
      dom.selectBondBtn.classList.toggle('active', !!state.isMeasureSelectMode);
      dom.selectBondBtn.textContent = state.isMeasureSelectMode ? 'Selecting…' : `Select ${meta.displayName}`;
      dom.selectBondBtn.disabled = !state.currentTrajId || !state.xyzFrames.length;
    }
    if (dom.clearBondBtn) {
      dom.clearBondBtn.textContent = `Clear ${meta.displayName}`;
      dom.clearBondBtn.disabled = highlightedKeys.size === 0;
    }
    if (dom.bondColorSettingsBtn) {
      dom.bondColorSettingsBtn.textContent = `⚙ ${meta.displayName} Colors`;
      dom.bondColorSettingsBtn.title = `Set tracked ${meta.lowerName} colors`;
      dom.bondColorSettingsBtn.disabled = !tracks.length;
      if (!tracks.length && state.isMeasurementColorSettingsOpen) {
        shared.setColorSettingsOpen(false);
      }
    }
    if (dom.bondColorSettingsTitleEl) {
      dom.bondColorSettingsTitleEl.textContent = `${meta.displayName} Color Settings`;
    }
    if (dom.bondSelectionInfoEl) {
      dom.bondSelectionInfoEl.textContent = formatSelectionInfoText();
    }
    renderMeasurementList();
    renderColorSettingsPanel();
  }

  function disableMeasurementSelectMode() {
    state.isMeasureSelectMode = false;
    state.pendingAtomIndices = [];
    refreshControlsOnly();
  }

  function setActiveMeasureType(type) {
    const normalizedType = shared.normalizeMeasureType(type);
    if (normalizedType === state.activeMeasureType) return;

    const previousMeta = shared.getMeasureMeta(state.activeMeasureType);
    const wasSelecting = state.isMeasureSelectMode;
    state.activeMeasureType = normalizedType;
    state.isMeasureSelectMode = false;
    state.pendingAtomIndices = [];

    refreshViews();

    if (wasSelecting) {
      shared.setStatus(`${previousMeta.displayName} selection canceled.`);
      return;
    }
    shared.setStatus(`Active measurement type: ${shared.getMeasureMeta().displayName}.`);
  }

  function toggleMeasureSelectMode() {
    const meta = shared.getMeasureMeta();
    if (!state.currentTrajId || !state.xyzFrames.length) return;
    if (state.isMeasureSelectMode) {
      disableMeasurementSelectMode();
      shared.setStatus(`${meta.displayName} selection canceled.`);
      return;
    }

    const viewerModule = root.viewer;
    if (viewerModule && typeof viewerModule.stopPlayback === 'function') {
      viewerModule.stopPlayback();
    }

    state.isMeasureSelectMode = true;
    state.pendingAtomIndices = [];
    refreshControlsOnly();
    shared.setStatus(meta.selectHintText);
  }

  function clearMeasurementPlot(message = shared.getMeasureMeta().plotEmptyText) {
    if (!dom.bondPlotEl) return;
    state.measurementPlotReady = false;
    if (typeof Plotly !== 'undefined') {
      try {
        Plotly.purge(dom.bondPlotEl);
      } catch {
        // ignore
      }
    }
    dom.bondPlotEl.innerHTML = `<div class="bond-plot-empty">${message}</div>`;
  }

  // Keep highlighted tracks first so the cursor aligns with user focus.
  function getTrackRenderOrder(type) {
    const tracks = shared.getTracks(type);
    const highlightedTracks = getHighlightedTracks(type);
    const order = highlightedTracks.slice();
    for (const track of tracks) {
      if (!isHighlighted(type, track.key)) order.push(track);
    }
    return order;
  }

  // --- Plot helpers -----------------------------------------------------------
  function getCursorTime() {
    const type = state.activeMeasureType;
    for (const track of getTrackRenderOrder(type)) {
      if (!Array.isArray(track.series) || !track.series.length) continue;
      const idx = Math.max(0, Math.min(state.currentFrame, track.series.length - 1));
      const t = Number(track.series[idx]?.t);
      if (Number.isFinite(t)) return t;
    }
    return null;
  }

  function updateMeasurementPlotFrameCursor() {
    const tracks = shared.getTracks();
    if (!state.measurementPlotReady || !dom.bondPlotEl || !tracks.length) return;
    if (typeof Plotly === 'undefined') return;

    const t = getCursorTime();
    if (!Number.isFinite(t)) return;

    Plotly.relayout(dom.bondPlotEl, {
      'shapes[0].x0': t,
      'shapes[0].x1': t,
    });
  }

  function renderMeasurementPlot() {
    const meta = shared.getMeasureMeta();
    const tracks = shared.getTracks();

    if (!dom.bondPlotEl) return;
    if (!tracks.length) {
      clearMeasurementPlot(meta.plotEmptyText);
      return;
    }
    if (typeof Plotly === 'undefined') {
      dom.bondPlotEl.innerHTML = '<div class="bond-plot-empty">Plot unavailable (Plotly failed to load).</div>';
      state.measurementPlotReady = false;
      return;
    }

    const plotTracks = tracks.filter((track) => Array.isArray(track.series) && track.series.length);
    if (!plotTracks.length) {
      clearMeasurementPlot(meta.plotNoDataText);
      return;
    }

    const unitSuffix = meta.valueUnit ? ` ${meta.valueUnit}` : '';
    const valueFormat = `%{y:.${meta.hoverDecimals}f}`;

    const data = plotTracks.map((track) => {
      const highlighted = isHighlighted(track.type, track.key);
      const trackLabel = `${meta.lowerName} ${shared.getTrackLabel(track)}`;
      return {
        x: track.series.map((point) => point.t),
        y: track.series.map((point) => point.v),
        type: 'scatter',
        mode: 'lines',
        line: { color: track.color, width: highlighted ? 3 : 1.5 },
        opacity: highlighted ? 1 : 0.28,
        name: trackLabel,
        hovertemplate: `${trackLabel}<br>t=%{x:.4f}<br>${meta.hoverValueLabel}=${valueFormat}${unitSuffix}<extra></extra>`,
      };
    });

    const t = getCursorTime();
    const plotColors = getPlotColors();

    const baseLayout = {
      margin: { l: 58, r: 16, t: 34, b: 42 },
      xaxis: { title: 'Time (fs)' },
      yaxis: { title: meta.yAxisTitle },
      showlegend: true,
      legend: {
        orientation: 'h',
        yanchor: 'bottom',
        y: 1.02,
        xanchor: 'left',
        x: 0,
      },
      shapes: Number.isFinite(t) ? [{
        type: 'line',
        x0: t,
        x1: t,
        yref: 'paper',
        y0: 0,
        y1: 1,
        line: { color: plotColors.cursorLineColor, dash: 'dash', width: 1.6 }
      }] : [],
    };

    const layout = mergePlotlyLayout(baseLayout);

    Plotly.react(dom.bondPlotEl, data, layout, {
      responsive: true,
      displaylogo: false,
      toImageButtonOptions: {
        format: 'png',
        scale: constants.PLOT_EXPORT_SCALE,
      },
    });
    state.measurementPlotReady = true;
  }

  function removeHighlightedTracks() {
    const type = state.activeMeasureType;
    const meta = shared.getMeasureMeta(type);
    const highlightedKeys = shared.getHighlightedKeys(type);
    if (!highlightedKeys.size) return;

    const tracks = shared.getTracks(type);
    const removeKeys = new Set(highlightedKeys);
    const kept = [];
    let removedCount = 0;

    for (const track of tracks) {
      if (removeKeys.has(track.key)) {
        removedCount += 1;
      } else {
        kept.push(track);
      }
    }

    state.measurementTracks[type] = kept;
    state.highlightedKeysByType[type] = new Set();

    refreshViews();
    shared.setStatus(`Cleared ${removedCount} highlighted ${meta.lowerName}${removedCount === 1 ? '' : 's'}.`);
  }

  function clearMeasurementState() {
    state.isMeasureSelectMode = false;
    state.pendingAtomIndices = [];
    for (const type of constants.MEASURE_TYPES) {
      state.measurementTracks[type] = [];
      state.highlightedKeysByType[type] = new Set();
    }
    clearMeasurementPlot();
    refreshControlsOnly();
  }

  function syncMeasurementStateForTrajectoryChange() {
    state.isMeasureSelectMode = false;
    state.pendingAtomIndices = [];

    for (const type of constants.MEASURE_TYPES) {
      const tracks = state.measurementTracks[type];
      if (!Array.isArray(tracks) || !tracks.length) continue;
      for (const track of tracks) {
        const atoms = Array.isArray(track?.atoms) ? track.atoms : [];
        track.series = computeMeasurementSeries(type, atoms);
      }
    }

    refreshViews({ viewer: false });
  }

  // --- Atom picking workflow --------------------------------------------------
  function handleAtomClick(atom) {
    if (!state.isMeasureSelectMode) return;
    if (!Array.isArray(state.currentCoords) || !state.currentCoords.length) return;

    const type = state.activeMeasureType;
    const meta = shared.getMeasureMeta(type);
    const frame = state.currentCoords[state.currentFrame];
    const atomIdx = geometry.resolveAtomIndex(atom, frame);
    if (!Number.isFinite(atomIdx)) {
      shared.setStatus('Failed to resolve clicked atom index.', true);
      return;
    }

    if (state.pendingAtomIndices.includes(atomIdx)) {
      shared.setStatus(`Atom ${atomIdx} is already selected for this ${meta.lowerName}. Please choose another atom.`, true);
      return;
    }

    state.pendingAtomIndices.push(atomIdx);
    if (state.pendingAtomIndices.length < meta.requiredAtoms) {
      refreshControlsOnly();
      const ordinals = ['First', 'Second', 'Third', 'Fourth'];
      const orderText = ordinals[state.pendingAtomIndices.length - 1] || `${state.pendingAtomIndices.length}th`;
      const remaining = meta.requiredAtoms - state.pendingAtomIndices.length;
      if (remaining === 1) {
        shared.setStatus(`${orderText} atom selected: ${atomIdx}. Please select one more atom.`);
      } else {
        shared.setStatus(`${orderText} atom selected: ${atomIdx}. Please select ${remaining} more atoms.`);
      }
      return;
    }

    const selectedAtoms = state.pendingAtomIndices.slice(0, meta.requiredAtoms);
    state.pendingAtomIndices = [];
    state.isMeasureSelectMode = false;

    const canonical = geometry.canonicalMeasurement(type, selectedAtoms);
    if (!canonical) {
      refreshControlsOnly();
      shared.setStatus(`Invalid ${meta.lowerName} selection.`, true);
      return;
    }

    const existingTrack = findTrack(type, canonical.key);
    if (existingTrack) {
      ensureHighlighted(type, existingTrack.key);
      refreshViews();
      shared.setStatus(`${meta.displayName} ${shared.getTrackLabel(existingTrack)} is already tracked and is now highlighted.`);
      return;
    }

    const newTrack = buildTrack(type, canonical.atoms, shared.getNextColor(type));
    if (!newTrack) {
      refreshControlsOnly();
      shared.setStatus(`Failed to create selected ${meta.lowerName}.`, true);
      return;
    }

    const tracks = shared.getTracks(type);
    tracks.push(newTrack);
    ensureHighlighted(type, newTrack.key);
    refreshViews();

    const count = tracks.length;
    if (count > constants.MEASURE_PERF_HINT_THRESHOLD) {
      shared.setStatus(`Selected ${meta.lowerName} ${shared.getTrackLabel(newTrack)}. Tracking ${count} ${meta.pluralName.toLowerCase()} may impact rendering performance.`);
      return;
    }
    shared.setStatus(`Selected ${meta.lowerName} ${shared.getTrackLabel(newTrack)}.`);
  }

  root.measurement = {
    findTrack,
    setTrackColor,
    renderColorSettingsPanel,
    isHighlighted,
    getHighlightedTracks,
    ensureHighlighted,
    toggleHighlight,
    buildTrack,
    formatSelectionInfoText,
    renderMeasurementList,
    updateMeasurementControlState,
    disableMeasurementSelectMode,
    setActiveMeasureType,
    toggleMeasureSelectMode,
    clearMeasurementPlot,
    getCursorTime,
    updateMeasurementPlotFrameCursor,
    renderMeasurementPlot,
    computeMeasurementValue,
    computeMeasurementSeries,
    removeTrack,
    removeHighlightedTracks,
    clearMeasurementState,
    syncMeasurementStateForTrajectoryChange,
    handleAtomClick,
  };
})();
