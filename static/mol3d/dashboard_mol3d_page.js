(function () {
  const root = window.ObservableMol3D || (window.ObservableMol3D = {});
  const shared = root.shared;
  const measurement = root.measurement;
  const viewer = root.viewer;
  const io = root.io;

  if (!shared || !measurement || !viewer || !io) {
    return;
  }

  const { dom, trajIds, state } = shared;

  function init() {
    io.setSourcePklInfo();
    shared.setDownloadButtonsEnabled(false);
    measurement.updateMeasurementControlState();

    if (typeof $3Dmol === 'undefined') {
      shared.setStatus('3Dmol.js failed to load. Please check network access.', true);
      return;
    }

    viewer.enforceViewerBounds();
    state.viewer = $3Dmol.createViewer(dom.viewerEl, { backgroundColor: 'white' });
    viewer.resizeViewer();
    viewer.setPlaybackRate(state.playbackRate);
    viewer.setPlaybackStride(state.playbackStride);
    window.addEventListener('resize', viewer.resizeViewer);

    if (dom.trajSelect) {
      dom.trajSelect.innerHTML = '';
      for (const trajId of trajIds) {
        const opt = document.createElement('option');
        opt.value = trajId;
        opt.textContent = trajId;
        dom.trajSelect.appendChild(opt);
      }
    }

    dom.trajSelect?.addEventListener('change', () => {
      io.loadTrajectory(dom.trajSelect.value);
    });

    dom.frameSlider?.addEventListener('input', () => {
      viewer.stopPlayback();
      const idx = Number.parseInt(dom.frameSlider.value, 10);
      if (Number.isFinite(idx)) viewer.renderFrame(idx);
    });

    dom.playbackRateSlider?.addEventListener('input', () => {
      const playbackRate = Number.parseFloat(dom.playbackRateSlider.value);
      viewer.setPlaybackRate(playbackRate);
    });

    dom.playbackStrideSlider?.addEventListener('input', () => {
      const playbackStride = Number.parseInt(dom.playbackStrideSlider.value, 10);
      viewer.setPlaybackStride(playbackStride);
    });

    dom.showAtomIndexCheckbox?.addEventListener('change', () => {
      if (!state.currentTrajId || !state.xyzFrames.length) return;
      viewer.renderFrame(state.currentFrame);
    });

    dom.playBtn?.addEventListener('click', () => {
      if (!state.currentTrajId || !state.xyzFrames.length) return;
      if (state.isPlaying) viewer.stopPlayback();
      else viewer.startPlayback();
    });

    dom.saveFrameBtn?.addEventListener('click', () => {
      io.saveCurrentFrameXyz();
    });

    dom.saveTrajBtn?.addEventListener('click', () => {
      io.saveTrajectoryXyz();
    });

    dom.measureTypeBondBtn?.addEventListener('click', () => {
      measurement.setActiveMeasureType('bond');
    });

    dom.measureTypeAngleBtn?.addEventListener('click', () => {
      measurement.setActiveMeasureType('angle');
    });

    dom.measureTypeDihedralBtn?.addEventListener('click', () => {
      measurement.setActiveMeasureType('dihedral');
    });

    dom.selectBondBtn?.addEventListener('click', () => {
      measurement.toggleMeasureSelectMode();
    });

    dom.clearBondBtn?.addEventListener('click', () => {
      measurement.removeHighlightedTracks();
    });

    dom.bondColorSettingsBtn?.addEventListener('click', () => {
      if (!shared.getTracks().length) return;
      shared.setColorSettingsOpen(!state.isMeasurementColorSettingsOpen);
      measurement.renderColorSettingsPanel();
    });

    dom.bondColorSettingsCloseBtn?.addEventListener('click', () => {
      shared.setColorSettingsOpen(false);
    });

    if (!trajIds.length) {
      shared.setStatus('No trajectories found in dataset.', true);
      return;
    }

    if (dom.trajSelect) {
      dom.trajSelect.value = trajIds[0];
    }
    io.loadTrajectory(trajIds[0]);

    window.addEventListener('beforeunload', () => {
      viewer.stopPlayback();
      window.removeEventListener('resize', viewer.resizeViewer);
    });
  }

  init();
})();
