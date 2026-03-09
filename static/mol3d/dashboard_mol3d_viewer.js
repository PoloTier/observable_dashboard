(function () {
  const root = window.ObservableMol3D || (window.ObservableMol3D = {});
  const shared = root.shared;
  const geometry = root.geometry;
  if (!shared || !geometry) return;

  const { dom, constants, state } = shared;

  // --- Viewer layout ----------------------------------------------------------
  function enforceViewerBounds() {
    if (!dom.viewerEl) return;

    dom.viewerEl.style.position = 'relative';
    dom.viewerEl.style.display = 'block';
    dom.viewerEl.style.overflow = 'hidden';

    const children = dom.viewerEl.children;
    for (const child of children) {
      if (!(child instanceof HTMLElement)) continue;
      child.style.maxWidth = '100%';
      child.style.maxHeight = '100%';
      child.style.position = 'absolute';
      child.style.inset = '0';
    }
  }

  function resizeViewer() {
    if (!state.viewer) return;
    enforceViewerBounds();
    state.viewer.resize();
    state.viewer.render();
  }

  // --- Overlay primitives -----------------------------------------------------
  function linePoint(point) {
    return {
      x: Number(point[0]),
      y: Number(point[1]),
      z: Number(point[2]),
    };
  }

  function addOverlayLine(startPoint, endPoint, color) {
    state.viewer.addLine({
      start: linePoint(startPoint),
      end: linePoint(endPoint),
      dashed: true,
      dashLength: 0.18,
      gapLength: 0.12,
      color,
      linewidth: 2,
    });
  }

  function addOverlayLabel(text, position, color, screenOffset = { x: 0, y: -8 }) {
    state.viewer.addLabel(text, {
      position,
      backgroundColor: '#ffffff',
      backgroundOpacity: 0.72,
      borderThickness: 1,
      borderColor: color,
      fontColor: color,
      fontSize: 13,
      inFront: true,
      showBackground: true,
      screenOffset,
    });
  }

  function formatOverlayValue(type, value) {
    const meta = shared.getMeasureMeta(type);
    if (type === 'bond') {
      return `${value.toFixed(meta.decimals)} Å`;
    }
    return `${value.toFixed(meta.decimals)}°`;
  }

  function computeOverlayMeasurementValue(type, points) {
    if (type === 'bond') {
      return geometry.distance3(points[0], points[1]);
    }
    if (type === 'angle') {
      return geometry.angleDeg(points[0], points[1], points[2]);
    }
    return geometry.dihedralDeg(points[0], points[1], points[2], points[3]);
  }

  function getOverlayLineSegments(type) {
    if (type === 'bond') return [[0, 1]];
    if (type === 'angle') return [[0, 1], [1, 2]];
    return [[0, 1], [1, 2], [2, 3]];
  }

  function getOverlayLabelPosition(type, points) {
    if (type === 'bond') return geometry.midpoint3(points[0], points[1]);
    if (type === 'angle') return linePoint(points[1]);
    return geometry.midpoint3(points[1], points[2]);
  }

  function getOverlayLabelOffset(type) {
    if (type === 'bond') return { x: 0, y: -8 };
    return { x: 0, y: -10 };
  }

  function addMeasurementOverlay(track, type, points) {
    const value = computeOverlayMeasurementValue(type, points);
    if (!Number.isFinite(value)) return;

    for (const [startIdx, endIdx] of getOverlayLineSegments(type)) {
      addOverlayLine(points[startIdx], points[endIdx], track.color);
    }
    addOverlayLabel(
      formatOverlayValue(type, value),
      getOverlayLabelPosition(type, points),
      track.color,
      getOverlayLabelOffset(type)
    );
  }

  // Render measurement overlays from highlighted tracks in the current frame.
  function renderMeasurementOverlayForFrame() {
    if (!state.viewer) return;
    const measurement = root.measurement;
    if (!measurement) return;

    const type = state.activeMeasureType;
    const highlightedTracks = measurement.getHighlightedTracks(type);
    if (!highlightedTracks.length) return;

    const frame = Array.isArray(state.currentCoords) ? state.currentCoords[state.currentFrame] : null;
    if (!Array.isArray(frame)) return;

    for (const track of highlightedTracks) {
      const atoms = Array.isArray(track.atoms) ? track.atoms : [];
      if (atoms.some((index) => index < 0 || index >= frame.length)) continue;

      const points = atoms.map((index) => frame[index]);
      if (points.some((point) => !Array.isArray(point) || point.length < 3)) continue;
      addMeasurementOverlay(track, type, points);
    }
  }

  function renderVectorOverlayForFrame() {
    const vectorOverlay = root.vectorOverlay;
    if (!vectorOverlay || typeof vectorOverlay.renderRegisteredOverlays !== 'function') {
      return;
    }
    vectorOverlay.renderRegisteredOverlays(state.currentFrame);
  }

  function getAtomIndexLabelText(atomIndex) {
    return String(atomIndex);
  }

  function addAtomIndexLabels(model) {
    if (!state.viewer || !model || !dom.showAtomIndexCheckbox?.checked) return;

    const atomList = model.selectedAtoms({});
    if (!Array.isArray(atomList) || !atomList.length) return;

    atomList.forEach((atom, atomIndex) => {
      state.viewer.addLabel(getAtomIndexLabelText(atomIndex), {
        position: { x: atom.x, y: atom.y, z: atom.z },
        alignment: 'center',
        showBackground: false,
        fontColor: '#dc2626',
        fontSize: 13,
        inFront: true,
        screenOffset: { x: 6, y: -6 }
      });
    });
  }

  function bindAtomClickHandler() {
    if (!state.viewer || !state.currentModel) return;
    state.viewer.setClickable({}, true, (atom) => {
      const measurement = root.measurement;
      if (measurement) {
        measurement.handleAtomClick(atom);
      }
    });
  }

  function clearScene() {
    if (!state.viewer) return;
    state.viewer.removeAllLabels();
    state.viewer.removeAllShapes();
    state.viewer.removeAllModels();
  }

  function buildDefaultRenderStyle(atomScale, bondRadius) {
    return {
      stick: { radius: bondRadius, colorscheme: 'Jmol' },
      sphere: { scale: atomScale, colorscheme: 'Jmol' },
    };
  }

  function buildPerAtomRenderStyle(mode, atomScale, bondRadius) {
    if (mode === 'sphere') {
      return { sphere: { scale: atomScale, colorscheme: 'Jmol' } };
    }
    if (mode === 'stick') {
      return { stick: { radius: bondRadius, colorscheme: 'Jmol' } };
    }
    if (mode === 'line') {
      return { line: { linewidth: 1.2, colorscheme: 'Jmol' } };
    }
    if (mode === 'cartoon') {
      return { cartoon: {} };
    }
    return null;
  }

  function resolveModelAtomCount(model) {
    const frame = Array.isArray(state.currentCoords) ? state.currentCoords[state.currentFrame] : null;
    if (Array.isArray(frame) && frame.length) return frame.length;

    if (!model || typeof model.selectedAtoms !== 'function') return 0;
    const atoms = model.selectedAtoms({});
    return Array.isArray(atoms) ? atoms.length : 0;
  }

  function sanitizeRuleIndices(rawIndices, atomCount) {
    if (!Array.isArray(rawIndices) || atomCount <= 0) return [];

    const seen = new Set();
    const out = [];
    for (const rawIndex of rawIndices) {
      const idx = Number.parseInt(String(rawIndex), 10);
      if (!Number.isFinite(idx) || idx < 0 || idx >= atomCount) continue;
      if (seen.has(idx)) continue;
      seen.add(idx);
      out.push(idx);
    }
    out.sort((a, b) => a - b);
    return out;
  }

  function applyRenderStyles(model, atomScale, bondRadius) {
    if (!state.viewer || !model) return;

    state.viewer.setStyle({}, buildDefaultRenderStyle(atomScale, bondRadius));

    const rules = Array.isArray(state.atomRenderRules) ? state.atomRenderRules : [];
    if (!rules.length) return;

    const atomCount = resolveModelAtomCount(model);
    if (atomCount <= 0) return;

    for (const rule of rules) {
      const mode = typeof shared.normalizeAtomRenderMode === 'function'
        ? shared.normalizeAtomRenderMode(rule?.mode)
        : null;
      if (!mode) continue;

      const indices = sanitizeRuleIndices(rule?.indices, atomCount);
      if (!indices.length) continue;

      const style = buildPerAtomRenderStyle(mode, atomScale, bondRadius);
      if (!style) continue;
      state.viewer.setStyle({ index: indices }, style);
    }
  }

  // --- Playback lifecycle -----------------------------------------------------
  function stopPlayback() {
    if (state.timer) {
      clearInterval(state.timer);
      state.timer = null;
    }
    state.isPlaying = false;
    if (dom.playBtn) dom.playBtn.textContent = 'Play';
  }

  function getPlaybackIntervalMs() {
    const sourceFps = constants.BASE_FPS * state.playbackRate;
    const stride = shared.clampPlaybackStride(state.playbackStride);
    const renderFps = sourceFps / stride;
    if (!Number.isFinite(renderFps) || renderFps <= 0) {
      return Math.max(1, Math.round(1000 / constants.BASE_FPS));
    }
    return Math.max(1, Math.round(1000 / renderFps));
  }

  function startPlaybackTimer() {
    if (!state.xyzFrames.length) return;
    const stride = shared.clampPlaybackStride(state.playbackStride);
    state.timer = setInterval(() => {
      const next = (state.currentFrame + stride) % state.xyzFrames.length;
      renderFrame(next);
    }, getPlaybackIntervalMs());
  }

  function restartPlaybackTimerIfPlaying() {
    if (!state.isPlaying) return;
    if (state.timer) {
      clearInterval(state.timer);
      state.timer = null;
    }
    startPlaybackTimer();
  }

  // Full frame render: replace model, redraw overlay/labels, sync UI cursor.
  function renderFrame(frameIndex, refitView = false) {
    if (!state.viewer || !state.xyzFrames.length) return;

    const idx = Math.max(0, Math.min(frameIndex, state.xyzFrames.length - 1));
    state.currentFrame = idx;

    clearScene();
    const model = state.viewer.addModel(state.xyzFrames[idx], 'xyz');
    state.currentModel = model;
    const bondRadius = constants.MODEL_STICK_RADIUS_BASE * shared.clampBondRadiusScale(state.bondRadiusScale);
    const atomScale = constants.MODEL_SPHERE_SCALE_BASE * shared.clampAtomSizeScale(state.atomSizeScale);
    applyRenderStyles(model, atomScale, bondRadius);
    bindAtomClickHandler();
    addAtomIndexLabels(model);
    renderMeasurementOverlayForFrame();
    renderVectorOverlayForFrame();
    if (refitView) {
      state.viewer.zoomTo();
      state.viewer.zoom(1.12, 0);
    }
    state.viewer.render();

    const measurement = root.measurement;
    if (measurement) {
      measurement.updateMeasurementPlotFrameCursor();
    }

    if (dom.frameSlider) dom.frameSlider.value = String(idx);
    if (dom.frameLabel) dom.frameLabel.textContent = `Frame ${idx + 1}/${state.xyzFrames.length}`;
  }

  function startPlayback() {
    if (!state.xyzFrames.length) return;
    stopPlayback();
    state.isPlaying = true;
    if (dom.playBtn) dom.playBtn.textContent = 'Pause';
    startPlaybackTimer();
  }

  function setPlaybackRate(rate) {
    shared.dispatch(shared.actions.setPlaybackRate(rate));
    restartPlaybackTimerIfPlaying();
  }

  function setPlaybackStride(stride) {
    shared.dispatch(shared.actions.setPlaybackStride(stride));
    restartPlaybackTimerIfPlaying();
  }

  root.viewer = {
    enforceViewerBounds,
    resizeViewer,
    linePoint,
    addOverlayLine,
    addOverlayLabel,
    formatOverlayValue,
    renderMeasurementOverlayForFrame,
    renderVectorOverlayForFrame,
    getAtomIndexLabelText,
    addAtomIndexLabels,
    bindAtomClickHandler,
    clearScene,
    stopPlayback,
    getPlaybackIntervalMs,
    renderFrame,
    startPlayback,
    setPlaybackRate,
    setPlaybackStride,
  };
})();
