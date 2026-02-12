(function () {
  const root = window.ObservableMol3D || (window.ObservableMol3D = {});
  const shared = root.shared;
  const geometry = root.geometry;
  if (!shared || !geometry) return;

  const { dom, constants, state } = shared;

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

      if (type === 'bond') {
        const value = geometry.distance3(points[0], points[1]);
        if (!Number.isFinite(value)) continue;
        addOverlayLine(points[0], points[1], track.color);
        addOverlayLabel(formatOverlayValue(type, value), geometry.midpoint3(points[0], points[1]), track.color, { x: 0, y: -8 });
        continue;
      }

      if (type === 'angle') {
        const value = geometry.angleDeg(points[0], points[1], points[2]);
        if (!Number.isFinite(value)) continue;
        addOverlayLine(points[0], points[1], track.color);
        addOverlayLine(points[1], points[2], track.color);
        addOverlayLabel(
          formatOverlayValue(type, value),
          linePoint(points[1]),
          track.color,
          { x: 0, y: -10 }
        );
        continue;
      }

      const value = geometry.dihedralDeg(points[0], points[1], points[2], points[3]);
      if (!Number.isFinite(value)) continue;
      addOverlayLine(points[0], points[1], track.color);
      addOverlayLine(points[1], points[2], track.color);
      addOverlayLine(points[2], points[3], track.color);
      addOverlayLabel(formatOverlayValue(type, value), geometry.midpoint3(points[1], points[2]), track.color, { x: 0, y: -10 });
    }
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

  function stopPlayback() {
    if (state.timer) {
      clearInterval(state.timer);
      state.timer = null;
    }
    state.isPlaying = false;
    if (dom.playBtn) dom.playBtn.textContent = 'Play';
  }

  function renderFrame(frameIndex, refitView = false) {
    if (!state.viewer || !state.xyzFrames.length) return;

    const idx = Math.max(0, Math.min(frameIndex, state.xyzFrames.length - 1));
    state.currentFrame = idx;

    state.viewer.removeAllLabels();
    state.viewer.removeAllShapes();
    state.viewer.removeAllModels();
    const model = state.viewer.addModel(state.xyzFrames[idx], 'xyz');
    state.currentModel = model;
    state.viewer.setStyle({}, {
      stick: { radius: 0.15, colorscheme: 'Jmol' },
      sphere: { scale: 0.28, colorscheme: 'Jmol' }
    });
    bindAtomClickHandler();
    addAtomIndexLabels(model);
    renderMeasurementOverlayForFrame();
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
    state.timer = setInterval(() => {
      const next = (state.currentFrame + 1) % state.xyzFrames.length;
      renderFrame(next);
    }, Math.round(1000 / constants.FPS));
  }

  root.viewer = {
    enforceViewerBounds,
    resizeViewer,
    linePoint,
    addOverlayLine,
    addOverlayLabel,
    formatOverlayValue,
    renderMeasurementOverlayForFrame,
    getAtomIndexLabelText,
    addAtomIndexLabels,
    bindAtomClickHandler,
    stopPlayback,
    renderFrame,
    startPlayback,
  };
})();
