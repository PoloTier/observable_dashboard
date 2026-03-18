(function () {
  const root = window.ObservableMol3D || (window.ObservableMol3D = {});
  const shared = root.shared;
  const geometry = root.geometry;
  if (!shared || !geometry) return;

  const { dom, constants, state } = shared;
  let frameRenderSeq = 0;
  let playbackRenderPending = false;

  function currentViewerTheme() {
    const appearance = window.ObservableAppearance;
    if (appearance && typeof appearance.getViewerTheme === 'function') {
      return appearance.getViewerTheme();
    }
    return {
      backgroundColor: '#fbfdff',
      labelBackgroundColor: '#ffffff',
      labelBackgroundOpacity: 0.82,
      atomIndexColor: '#dc2626',
    };
  }

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

  function applyAppearanceTheme({ rerender = true } = {}) {
    if (!state.viewer) return;
    const theme = currentViewerTheme();
    if (typeof state.viewer.setBackgroundColor === 'function') {
      state.viewer.setBackgroundColor(theme.backgroundColor);
    }
    if (rerender && state.currentTrajId && getFrameCount() > 0) {
      void renderFrame(state.currentFrame);
      return;
    }
    state.viewer.render();
  }

  // --- Overlay primitives -----------------------------------------------------
  function linePoint(point) {
    if (point && typeof point === 'object' && !Array.isArray(point)) {
      return {
        x: Number(point.x),
        y: Number(point.y),
        z: Number(point.z),
      };
    }
    return {
      x: Number(point[0]),
      y: Number(point[1]),
      z: Number(point[2]),
    };
  }

  function interpolatePoint(startPoint, endPoint, t) {
    const start = linePoint(startPoint);
    const end = linePoint(endPoint);
    const alpha = Number(t);
    return [
      start.x + (end.x - start.x) * alpha,
      start.y + (end.y - start.y) * alpha,
      start.z + (end.z - start.z) * alpha,
    ];
  }

  function addOverlayLine(startPoint, endPoint, color, options = {}) {
    const dashed = options.dashed !== undefined ? !!options.dashed : true;
    const dashLength = Number.isFinite(Number(options.dashLength)) ? Number(options.dashLength) : 0.18;
    const gapLength = Number.isFinite(Number(options.gapLength)) ? Number(options.gapLength) : 0.12;
    const linewidth = Number.isFinite(Number(options.linewidth)) ? Number(options.linewidth) : 2;
    state.viewer.addLine({
      start: linePoint(startPoint),
      end: linePoint(endPoint),
      dashed,
      dashLength,
      gapLength,
      color,
      linewidth,
    });
  }

  function addOverlayCylinder(startPoint, endPoint, color, options = {}) {
    const radius = Number.isFinite(Number(options.radius)) ? Number(options.radius) : 0.12;
    const spec = {
      start: linePoint(startPoint),
      end: linePoint(endPoint),
      color,
      radius,
    };
    const opacity = Number(options.opacity);
    if (Number.isFinite(opacity)) {
      spec.opacity = opacity;
    }
    if (options.fromCap !== undefined) {
      spec.fromCap = options.fromCap;
    }
    if (options.toCap !== undefined) {
      spec.toCap = options.toCap;
    }
    state.viewer.addCylinder(spec);
  }

  function addOverlayDashedStick(startPoint, endPoint, color, options = {}) {
    const dashLength = Number.isFinite(Number(options.dashLength)) ? Number(options.dashLength) : 0.18;
    const gapLength = Number.isFinite(Number(options.gapLength)) ? Number(options.gapLength) : 0.12;
    const radius = Number.isFinite(Number(options.radius)) ? Number(options.radius) : 0.12;
    const minSegmentLength = Number.isFinite(Number(options.minSegmentLength))
      ? Math.max(0, Number(options.minSegmentLength))
      : 0;
    const totalLength = geometry.distance3(startPoint, endPoint);
    if (!Number.isFinite(totalLength) || totalLength <= 1e-8) return;

    const stride = Math.max(1e-6, dashLength + gapLength);
    for (let offset = 0; offset < totalLength; offset += stride) {
      const segmentStart = offset / totalLength;
      const segmentEnd = Math.min(totalLength, offset + dashLength) / totalLength;
      if (!(segmentEnd > segmentStart)) continue;
      if ((segmentEnd - segmentStart) * totalLength < minSegmentLength) continue;
      addOverlayCylinder(
        interpolatePoint(startPoint, endPoint, segmentStart),
        interpolatePoint(startPoint, endPoint, segmentEnd),
        color,
        {
          radius,
          opacity: options.opacity,
          fromCap: options.fromCap,
          toCap: options.toCap,
        }
      );
    }
  }

  function addOverlayLabel(text, position, color, screenOffset = { x: 0, y: -8 }) {
    const theme = currentViewerTheme();
    const label = state.viewer.addLabel(text, {
      position,
      backgroundColor: theme.labelBackgroundColor,
      backgroundOpacity: theme.labelBackgroundOpacity,
      borderThickness: 1,
      borderColor: color,
      fontColor: color,
      fontSize: 13,
      inFront: true,
      showBackground: true,
      screenOffset,
    });
    if (label) {
      state.transientOverlayLabels.push(label);
    }
    return label;
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

  function renderHydrogenBondsForFrame() {
    if (!state.showHydrogenBonds) return;
    const hbond = root.hbond;
    if (!hbond || typeof hbond.renderHydrogenBonds !== 'function') return;
    hbond.renderHydrogenBonds(state.currentFrame);
  }

  function getFrameCount() {
    return typeof shared.getCurrentFrameCount === 'function'
      ? shared.getCurrentFrameCount()
      : (Array.isArray(state.currentCoords) ? state.currentCoords.length : 0);
  }

  function shouldRenderAtomIndexLabels() {
    return !!dom.showAtomIndexCheckbox?.checked && !state.isPlaying;
  }

  function syncFrameUi(frameIndex, frameCount) {
    if (dom.frameSlider) dom.frameSlider.value = String(frameIndex);
    if (dom.framePrevBtn) dom.framePrevBtn.disabled = frameCount <= 1 || frameIndex <= 0;
    if (dom.frameNextBtn) dom.frameNextBtn.disabled = frameCount <= 1 || frameIndex >= frameCount - 1;
    if (dom.frameLabel) dom.frameLabel.textContent = shared.formatFrameLabel(frameIndex, frameCount);
  }

  function getAtomIndexLabelText(atomIndex) {
    return String(atomIndex);
  }

  function getFrameCoords(frameIndex = state.currentFrame) {
    const coords = Array.isArray(state.currentCoords) ? state.currentCoords : [];
    const idx = Number.parseInt(String(frameIndex), 10);
    if (!Number.isFinite(idx) || idx < 0 || idx >= coords.length) return null;
    const frame = coords[idx];
    return Array.isArray(frame) ? frame : null;
  }

  function getAtomIndexThemeKey(theme = currentViewerTheme()) {
    return String(theme?.atomIndexColor || '');
  }

  function buildAtomIndexLabelStyle(position, theme = currentViewerTheme()) {
    return {
      position: linePoint(position),
      alignment: 'center',
      showBackground: false,
      fontColor: theme.atomIndexColor,
      fontSize: 13,
      inFront: true,
      screenOffset: { x: 6, y: -6 },
    };
  }

  function getAtomIndexLabelSignature() {
    const atomCount = (() => {
      const frame0 = Array.isArray(state.currentCoords) ? state.currentCoords[0] : null;
      if (Array.isArray(frame0) && frame0.length) return frame0.length;
      return Array.isArray(state.atomNumbers) ? state.atomNumbers.length : 0;
    })();
    const atomNumbers = Array.isArray(state.atomNumbers) ? state.atomNumbers.slice(0, atomCount) : [];
    return `${atomCount}|${atomNumbers.join(',')}`;
  }

  function removeTrackedLabel(label) {
    if (!state.viewer || !label || typeof state.viewer.removeLabel !== 'function') return;
    try {
      state.viewer.removeLabel(label);
    } catch (_) {
      // Best-effort cleanup; stale handles can occur after full viewer resets.
    }
  }

  function clearTransientOverlayLabels() {
    const labels = Array.isArray(state.transientOverlayLabels) ? state.transientOverlayLabels.slice() : [];
    state.transientOverlayLabels = [];
    for (const label of labels) {
      removeTrackedLabel(label);
    }
  }

  function clearAtomIndexLabels() {
    const labels = Array.isArray(state.atomIndexLabels) ? state.atomIndexLabels.slice() : [];
    state.atomIndexLabels = [];
    state.atomIndexLabelSignature = '';
    state.atomIndexLabelThemeKey = '';
    for (const label of labels) {
      removeTrackedLabel(label);
    }
  }

  function setAtomIndexLabelsVisible(visible) {
    const nextVisible = !!visible;
    const labels = Array.isArray(state.atomIndexLabels) ? state.atomIndexLabels : [];
    for (const label of labels) {
      if (label?.sprite) {
        label.sprite.visible = nextVisible;
      }
    }
  }

  function updateAtomIndexLabelPosition(label, position) {
    if (!label) return;
    const nextPosition = linePoint(position);
    if (label.stylespec && typeof label.stylespec === 'object') {
      label.stylespec.position = nextPosition;
    }
    if (label.sprite?.position && typeof label.sprite.position.set === 'function') {
      label.sprite.position.set(nextPosition.x, nextPosition.y, nextPosition.z);
    }
  }

  function updateAtomIndexLabelPositions(frame) {
    const labels = Array.isArray(state.atomIndexLabels) ? state.atomIndexLabels : [];
    if (!Array.isArray(frame) || !labels.length) return;
    const count = Math.min(labels.length, frame.length);
    for (let atomIndex = 0; atomIndex < count; atomIndex++) {
      updateAtomIndexLabelPosition(labels[atomIndex], frame[atomIndex]);
    }
  }

  function rebuildAtomIndexLabelStyles(frame, theme = currentViewerTheme()) {
    if (!state.viewer || typeof state.viewer.setLabelStyle !== 'function') return false;
    const labels = Array.isArray(state.atomIndexLabels) ? state.atomIndexLabels : [];
    if (!labels.length || !Array.isArray(frame)) return false;
    const count = Math.min(labels.length, frame.length);
    for (let atomIndex = 0; atomIndex < count; atomIndex++) {
      const currentLabel = labels[atomIndex];
      const nextStyle = buildAtomIndexLabelStyle(frame[atomIndex], theme);
      labels[atomIndex] = state.viewer.setLabelStyle(currentLabel, nextStyle) || currentLabel;
    }
    state.atomIndexLabelThemeKey = getAtomIndexThemeKey(theme);
    return true;
  }

  function createAtomIndexLabels(frame, signature, theme = currentViewerTheme()) {
    if (!state.viewer || !Array.isArray(frame) || !frame.length) return false;
    clearAtomIndexLabels();
    const labels = [];
    for (let atomIndex = 0; atomIndex < frame.length; atomIndex++) {
      const label = state.viewer.addLabel(
        getAtomIndexLabelText(atomIndex),
        buildAtomIndexLabelStyle(frame[atomIndex], theme)
      );
      if (label) {
        labels.push(label);
      }
    }
    state.atomIndexLabels = labels;
    state.atomIndexLabelSignature = signature;
    state.atomIndexLabelThemeKey = getAtomIndexThemeKey(theme);
    return labels.length > 0;
  }

  function syncAtomIndexLabelsForFrame(frameIndex = state.currentFrame) {
    if (!state.viewer) return;
    if (!shouldRenderAtomIndexLabels()) {
      setAtomIndexLabelsVisible(false);
      return;
    }

    const frame = getFrameCoords(frameIndex);
    if (!Array.isArray(frame) || !frame.length) {
      clearAtomIndexLabels();
      return;
    }

    const signature = getAtomIndexLabelSignature();
    const theme = currentViewerTheme();
    const needsRebuild = (
      !Array.isArray(state.atomIndexLabels)
      || state.atomIndexLabels.length !== frame.length
      || state.atomIndexLabelSignature !== signature
    );

    if (needsRebuild) {
      createAtomIndexLabels(frame, signature, theme);
    } else if (state.atomIndexLabelThemeKey !== getAtomIndexThemeKey(theme)) {
      rebuildAtomIndexLabelStyles(frame, theme);
    }

    updateAtomIndexLabelPositions(frame);
    setAtomIndexLabelsVisible(true);
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

  function clearScene(options = {}) {
    if (!state.viewer) return;
    const preserveAtomIndexLabels = !!options.preserveAtomIndexLabels;
    if (options.invalidateRenderSeq !== false) {
      frameRenderSeq += 1;
    }
    clearTransientOverlayLabels();
    if (!preserveAtomIndexLabels) {
      clearAtomIndexLabels();
    }
    state.viewer.removeAllShapes();
    state.viewer.removeAllModels();
    state.currentModel = null;
    state.currentModelRenderMode = '';
    state.auxiliaryModels = [];
  }

  function clearOverlayScene() {
    if (!state.viewer) return;
    clearTransientOverlayLabels();
    state.viewer.removeAllShapes();
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

  function refreshModelStyle() {
    if (!state.viewer || !state.currentModel) return false;
    const bondRadius = constants.MODEL_STICK_RADIUS_BASE * shared.clampBondRadiusScale(state.bondRadiusScale);
    const atomScale = constants.MODEL_SPHERE_SCALE_BASE * shared.clampAtomSizeScale(state.atomSizeScale);
    applyRenderStyles(state.currentModel, atomScale, bondRadius);
    return true;
  }

  function buildCurrentTrajectoryRecord() {
    const frame0 = Array.isArray(state.currentCoords) ? state.currentCoords[0] : null;
    const atomCount = Array.isArray(frame0) ? frame0.length : 0;
    return {
      coords: Array.isArray(state.currentCoords) ? state.currentCoords : [],
      time: Array.isArray(state.currentTimes) ? state.currentTimes : [],
      atom_numbers: Array.isArray(state.atomNumbers) ? state.atomNumbers : [],
      n_atoms: atomCount,
    };
  }

  function clearAuxiliaryModels() {
    state.auxiliaryModels = [];
  }

  function setAuxiliaryTrajectories(trajectorySpecs) {
    clearAuxiliaryModels();
    if (!state.viewer || !Array.isArray(trajectorySpecs) || !trajectorySpecs.length) {
      return 0;
    }

    const createdModels = [];
    for (const spec of trajectorySpecs) {
      const firstFrameXyz = typeof spec?.firstFrameXyz === 'string' ? spec.firstFrameXyz : '';
      const coordsFrames = Array.isArray(spec?.coordsFrames) ? spec.coordsFrames : [];
      if (!firstFrameXyz || !coordsFrames.length) continue;

      const model = state.viewer.addModel(firstFrameXyz, 'xyz');
      if (!model) continue;
      if (typeof model.setCoordinates === 'function') {
        model.setCoordinates(coordsFrames, 'array');
      }
      createdModels.push(model);
    }

    state.auxiliaryModels = createdModels;
    refreshModelStyle();
    return createdModels.length;
  }

  function buildFrameXyz(frameIndex) {
    const idx = Number.parseInt(String(frameIndex), 10);
    if (!Number.isFinite(idx) || idx < 0) return '';

    if (!Array.isArray(state.xyzFrames)) {
      state.xyzFrames = [];
    }
    const cached = state.xyzFrames[idx];
    if (typeof cached === 'string' && cached) {
      return cached;
    }

    const transformers = root.ioTransformers;
    if (!transformers || typeof transformers.buildXyzFrame !== 'function') {
      return '';
    }

    const xyz = transformers.buildXyzFrame(buildCurrentTrajectoryRecord(), idx);
    if (typeof xyz === 'string' && xyz) {
      state.xyzFrames[idx] = xyz;
      return xyz;
    }
    return '';
  }

  function initializeTrajectoryModel(initialFrameXyz, coordsFrames, options = {}) {
    if (!state.viewer || !initialFrameXyz) return false;
    clearScene({
      preserveAtomIndexLabels: true,
      invalidateRenderSeq: options.invalidateRenderSeq !== false,
    });
    const model = state.viewer.addModel(initialFrameXyz, 'xyz');
    if (!model) return false;

    if (typeof model.setCoordinates === 'function' && Array.isArray(coordsFrames) && coordsFrames.length) {
      model.setCoordinates(coordsFrames, 'array');
    }

    state.currentModel = model;
    state.currentModelRenderMode = 'static';
    refreshModelStyle();
    bindAtomClickHandler();
    return true;
  }

  function ensureStaticTrajectoryModel() {
    if (state.currentModel && state.currentModelRenderMode === 'static') {
      return true;
    }
    const firstFrameXyz = buildFrameXyz(0);
    if (!firstFrameXyz) return false;
    return initializeTrajectoryModel(firstFrameXyz, state.currentCoords, { invalidateRenderSeq: false });
  }

  function rebuildDynamicFrameModel(frameIndex) {
    if (!state.viewer) return false;
    const frameXyz = buildFrameXyz(frameIndex);
    if (!frameXyz) return false;

    clearScene({ preserveAtomIndexLabels: true, invalidateRenderSeq: false });
    const model = state.viewer.addModel(frameXyz, 'xyz');
    if (!model) return false;

    state.currentModel = model;
    state.currentModelRenderMode = 'dynamic';
    refreshModelStyle();
    bindAtomClickHandler();
    return true;
  }

  function setDynamicBondsEnabled(enabled) {
    state.dynamicBonds = !!enabled;
    if (dom.dynamicBondsCheckbox) {
      dom.dynamicBondsCheckbox.checked = state.dynamicBonds;
    }
  }

  // --- Playback lifecycle -----------------------------------------------------
  function stopPlayback(options = {}) {
    if (state.playbackRafId) {
      cancelAnimationFrame(state.playbackRafId);
      state.playbackRafId = 0;
    }
    playbackRenderPending = false;
    state.playbackLastTickMs = 0;
    state.playbackElapsedMs = 0;
    state.isPlaying = false;
    if (dom.playBtn) dom.playBtn.textContent = 'Play';

    if (options.renderCurrentFrame && state.currentTrajId && getFrameCount() > 0 && state.currentModel) {
      void renderFrame(state.currentFrame);
    }
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

  function schedulePlaybackTick() {
    if (!state.isPlaying) return;
    state.playbackRafId = requestAnimationFrame(runPlaybackTick);
  }

  function runPlaybackTick(timestamp) {
    if (!state.isPlaying) return;

    const frameCount = getFrameCount();
    if (frameCount <= 0 || !state.currentModel) {
      stopPlayback();
      return;
    }

    if (!Number.isFinite(state.playbackLastTickMs) || state.playbackLastTickMs <= 0) {
      state.playbackLastTickMs = timestamp;
      schedulePlaybackTick();
      return;
    }

    const intervalMs = getPlaybackIntervalMs();
    const deltaMs = Math.max(0, timestamp - state.playbackLastTickMs);
    state.playbackLastTickMs = timestamp;
    state.playbackElapsedMs = Math.min(intervalMs * 4, state.playbackElapsedMs + deltaMs);

    if (state.playbackElapsedMs >= intervalMs && !playbackRenderPending) {
      const stride = shared.clampPlaybackStride(state.playbackStride);
      const steps = Math.max(1, Math.floor(state.playbackElapsedMs / intervalMs));
      const next = (state.currentFrame + stride * steps) % frameCount;
      state.playbackElapsedMs -= steps * intervalMs;
      playbackRenderPending = true;
      Promise.resolve(renderFrame(next))
        .catch((error) => {
          console.error('ObservableMol3D playback render failed:', error);
        })
        .finally(() => {
          playbackRenderPending = false;
        });
    }

    schedulePlaybackTick();
  }

  function restartPlaybackTimerIfPlaying() {
    if (!state.isPlaying) return;
    state.playbackLastTickMs = 0;
    state.playbackElapsedMs = 0;
  }

  // Full frame render: switch existing model frame, redraw overlays/labels, sync UI cursor.
  async function renderFrame(frameIndex, refitView = false) {
    const frameCount = getFrameCount();
    if (!state.viewer || frameCount <= 0) return false;

    const idx = Math.max(0, Math.min(frameIndex, frameCount - 1));
    const renderSeq = ++frameRenderSeq;
    state.currentFrame = idx;
    syncFrameUi(idx, frameCount);

    if (state.dynamicBonds) {
      if (!rebuildDynamicFrameModel(idx)) return false;
    } else {
      if (!ensureStaticTrajectoryModel()) return false;
      if (typeof state.currentModel?.setFrame === 'function') {
        await state.currentModel.setFrame(idx, state.viewer);
      }
      const auxiliaryModels = Array.isArray(state.auxiliaryModels) ? state.auxiliaryModels : [];
      for (const model of auxiliaryModels) {
        if (typeof model?.setFrame === 'function') {
          await model.setFrame(idx, state.viewer);
        }
      }
    }

    if (renderSeq !== frameRenderSeq) return false;

    clearOverlayScene();
    bindAtomClickHandler();
    syncAtomIndexLabelsForFrame(idx);
    renderMeasurementOverlayForFrame();
    renderVectorOverlayForFrame();
    renderHydrogenBondsForFrame();
    if (refitView) {
      state.viewer.zoomTo();
      state.viewer.zoom(1.12, 0);
    }
    state.viewer.render();

    const measurement = root.measurement;
    if (measurement) {
      measurement.updateMeasurementPlotFrameCursor();
    }

    shared.notifyFrameRendered(idx, frameCount);

    return true;
  }

  function startPlayback() {
    if (getFrameCount() <= 0 || !state.currentModel) return;
    stopPlayback();
    state.isPlaying = true;
    state.playbackElapsedMs = 0;
    state.playbackLastTickMs = 0;
    if (dom.playBtn) dom.playBtn.textContent = 'Pause';
    void renderFrame(state.currentFrame);
    schedulePlaybackTick();
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
    interpolatePoint,
    addOverlayLine,
    addOverlayCylinder,
    addOverlayDashedStick,
    addOverlayLabel,
    formatOverlayValue,
    renderMeasurementOverlayForFrame,
    renderVectorOverlayForFrame,
    renderHydrogenBondsForFrame,
    getAtomIndexLabelText,
    syncAtomIndexLabelsForFrame,
    bindAtomClickHandler,
    clearScene,
    clearAuxiliaryModels,
    setAuxiliaryTrajectories,
    clearOverlayScene,
    applyAppearanceTheme,
    refreshModelStyle,
    initializeTrajectoryModel,
    setDynamicBondsEnabled,
    stopPlayback,
    getPlaybackIntervalMs,
    renderFrame,
    startPlayback,
    setPlaybackRate,
    setPlaybackStride,
  };
})();
