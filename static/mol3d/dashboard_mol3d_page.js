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

  function bind(el, event, handler) {
    if (el) el.addEventListener(event, handler);
  }

  function populateTrajectoryOptions() {
    if (!dom.trajSelect) return;
    dom.trajSelect.innerHTML = '';
    for (const trajId of trajIds) {
      const opt = document.createElement('option');
      opt.value = trajId;
      opt.textContent = trajId;
      dom.trajSelect.appendChild(opt);
    }
  }

  // Trajectory selection + per-frame scrub.
  function bindTrajectoryControls() {
    bind(dom.trajSelect, 'change', () => {
      io.loadTrajectory(dom.trajSelect.value);
    });

    bind(dom.frameSlider, 'input', () => {
      viewer.stopPlayback();
      const idx = Number.parseInt(dom.frameSlider.value, 10);
      if (Number.isFinite(idx)) viewer.renderFrame(idx);
    });
  }

  // Playback rate/stride, play/pause and view toggles.
  function bindPlaybackControls() {
    bind(dom.playbackRateSlider, 'input', () => {
      const playbackRate = Number.parseFloat(dom.playbackRateSlider.value);
      viewer.setPlaybackRate(playbackRate);
    });

    bind(dom.playbackStrideSlider, 'input', () => {
      const playbackStride = Number.parseInt(dom.playbackStrideSlider.value, 10);
      viewer.setPlaybackStride(playbackStride);
    });

    bind(dom.playBtn, 'click', () => {
      if (!state.currentTrajId || !state.xyzFrames.length) return;
      if (state.isPlaying) viewer.stopPlayback();
      else viewer.startPlayback();
    });

    bind(dom.showAtomIndexCheckbox, 'change', () => {
      if (!state.currentTrajId || !state.xyzFrames.length) return;
      viewer.renderFrame(state.currentFrame);
    });

    bind(dom.atomSizeSlider, 'input', () => {
      shared.dispatch(shared.actions.setAtomSizeScale(dom.atomSizeSlider?.value));
      if (!state.currentTrajId || !state.xyzFrames.length) return;
      viewer.renderFrame(state.currentFrame);
    });

    bind(dom.bondRadiusSlider, 'input', () => {
      shared.dispatch(shared.actions.setBondRadiusScale(dom.bondRadiusSlider?.value));
      if (!state.currentTrajId || !state.xyzFrames.length) return;
      viewer.renderFrame(state.currentFrame);
    });
  }

  // Measurement-type switching and per-track controls.
  function bindMeasurementControls() {
    bind(dom.measureTypeBondBtn, 'click', () => measurement.setActiveMeasureType('bond'));
    bind(dom.measureTypeAngleBtn, 'click', () => measurement.setActiveMeasureType('angle'));
    bind(dom.measureTypeDihedralBtn, 'click', () => measurement.setActiveMeasureType('dihedral'));

    bind(dom.selectBondBtn, 'click', () => measurement.toggleMeasureSelectMode());
    bind(dom.clearBondBtn, 'click', () => measurement.removeHighlightedTracks());

    bind(dom.bondColorSettingsBtn, 'click', () => {
      if (!shared.getTracks().length) return;
      shared.setColorSettingsOpen(!state.isMeasurementColorSettingsOpen);
      measurement.renderColorSettingsPanel();
    });
    bind(dom.bondColorSettingsCloseBtn, 'click', () => shared.setColorSettingsOpen(false));
  }

  // File export actions and GIF range controls.
  function bindExportControls() {
    bind(dom.saveFrameBtn, 'click', () => io.saveCurrentFrameXyz());
    bind(dom.saveTrajBtn, 'click', () => io.saveTrajectoryXyz());
    bind(dom.gifExportStartInput, 'change', () => io.syncGifExportRangeFromInputs(true));
    bind(dom.gifExportEndInput, 'change', () => io.syncGifExportRangeFromInputs(true));
    bind(dom.exportGifBtn, 'click', () => io.exportTrajectoryGif());
    bind(dom.cancelGifExportBtn, 'click', () => io.cancelGifExport());
  }

  function bindNacControls() {
    bind(dom.showNacVectorsCheckbox, 'change', async () => {
      const enabled = !!dom.showNacVectorsCheckbox?.checked;
      await io.setNacVectorsVisible(enabled);
    });

    bind(dom.showDeVectorsCheckbox, 'change', async () => {
      const enabled = !!dom.showDeVectorsCheckbox?.checked;
      await io.setDeVectorsVisible(enabled);
    });

    bind(dom.showDeNacVectorsCheckbox, 'change', async () => {
      const enabled = !!dom.showDeNacVectorsCheckbox?.checked;
      await io.setDeNacVectorsVisible(enabled);
    });

    bind(dom.nacStateISelect, 'change', async () => {
      await io.updateNacStatePairFromControls('i');
    });

    bind(dom.nacStateJSelect, 'change', async () => {
      await io.updateNacStatePairFromControls('j');
    });

    bind(dom.addDePairBtn, 'click', async () => {
      await io.addDeRow();
    });

    bind(dom.dePairRowsContainer, 'change', async (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;

      if (target.classList.contains('de-row-enabled')) {
        const rowId = target.getAttribute('data-de-row-id');
        if (rowId !== null) {
          await io.toggleDeRowEnabled(rowId, !!target.checked);
        }
        return;
      }

      if (target.classList.contains('de-row-state-i')) {
        const rowId = target.getAttribute('data-de-row-id');
        if (rowId !== null) {
          await io.updateDeRowPair(rowId, 'i');
        }
        return;
      }

      if (target.classList.contains('de-row-state-j')) {
        const rowId = target.getAttribute('data-de-row-id');
        if (rowId !== null) {
          await io.updateDeRowPair(rowId, 'j');
        }
      }
    });

    bind(dom.dePairRowsContainer, 'click', async (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const removeBtn = target.closest('.de-row-remove-btn');
      if (!removeBtn) return;
      const rowId = removeBtn.getAttribute('data-de-row-id');
      if (rowId === null) return;
      await io.removeDeRow(rowId);
    });

    bind(dom.nacScaleSlider, 'input', () => {
      shared.dispatch(shared.actions.setNacUserScale(dom.nacScaleSlider?.value));
      if (!state.currentTrajId || !state.xyzFrames.length || !state.showNacVectors) return;
      viewer.renderFrame(state.currentFrame);
    });

    bind(dom.deScaleSlider, 'input', () => {
      shared.dispatch(shared.actions.setDeUserScale(dom.deScaleSlider?.value));
      if (!state.currentTrajId || !state.xyzFrames.length || !state.showDeVectors) return;
      viewer.renderFrame(state.currentFrame);
    });

    bind(dom.deNacScaleSlider, 'input', () => {
      shared.dispatch(shared.actions.setDeNacUserScale(dom.deNacScaleSlider?.value));
      if (!state.currentTrajId || !state.xyzFrames.length || !state.showDeNacVectors) return;
      viewer.renderFrame(state.currentFrame);
    });
  }

  function bindLifecycleCleanup() {
    window.addEventListener('beforeunload', () => {
      io.cancelGifExport(false);
      viewer.stopPlayback();
      window.removeEventListener('resize', viewer.resizeViewer);
    });
  }

  function init() {
    io.setSourcePklInfo();
    shared.setDownloadButtonsEnabled(false);
    shared.setNacControlsEnabled(false);
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

    populateTrajectoryOptions();
    bindTrajectoryControls();
    bindPlaybackControls();
    bindMeasurementControls();
    bindExportControls();
    bindNacControls();
    bindLifecycleCleanup();

    if (!trajIds.length) {
      shared.setStatus('No trajectories found in dataset.', true);
      return;
    }

    if (dom.trajSelect) dom.trajSelect.value = trajIds[0];
    io.loadTrajectory(trajIds[0]);
  }

  init();
})();
