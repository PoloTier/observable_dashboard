(function () {
  const root = window.ObservableMol3D || (window.ObservableMol3D = {});
  const shared = root.shared;
  const measurement = root.measurement;
  const viewer = root.viewer;
  const io = root.io;

  if (!shared || !measurement || !viewer || !io) {
    return;
  }

  const { dom, trajIds, state, dataMode } = shared;
  let viewerResizeObserver = null;
  let removeAppearanceSubscription = null;

  function getFrameCount() {
    return typeof shared.getCurrentFrameCount === 'function'
      ? shared.getCurrentFrameCount()
      : (Array.isArray(state.currentCoords) ? state.currentCoords.length : 0);
  }

  function bind(el, event, handler) {
    if (el) el.addEventListener(event, handler);
  }

  function currentViewerBackgroundColor() {
    const appearance = window.ObservableAppearance;
    if (appearance && typeof appearance.getViewerTheme === 'function') {
      return String(appearance.getViewerTheme()?.backgroundColor || '#ffffff');
    }
    return '#ffffff';
  }

  function bindAppearanceControls() {
    const appearance = window.ObservableAppearance;
    if (!appearance) return;
    if (typeof appearance.initControls === 'function') {
      appearance.initControls();
    }
    if (removeAppearanceSubscription || typeof appearance.subscribe !== 'function') return;

    removeAppearanceSubscription = appearance.subscribe(() => {
      if (typeof viewer.applyAppearanceTheme === 'function') {
        viewer.applyAppearanceTheme({ rerender: true });
      }
      if (typeof measurement.renderMeasurementPlot === 'function') {
        measurement.renderMeasurementPlot();
      }
    });
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
      if (Number.isFinite(idx)) void viewer.renderFrame(idx);
    });

    const stepFrame = (delta) => {
      if (!state.currentTrajId || getFrameCount() <= 0) return;
      viewer.stopPlayback();
      void viewer.renderFrame(state.currentFrame + delta);
    };

    bind(dom.framePrevBtn, 'click', () => {
      stepFrame(-1);
    });

    bind(dom.frameNextBtn, 'click', () => {
      stepFrame(1);
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
      if (!state.currentTrajId || getFrameCount() <= 0) return;
      if (state.isPlaying) viewer.stopPlayback({ renderCurrentFrame: true });
      else viewer.startPlayback();
    });

    bind(dom.showAtomIndexCheckbox, 'change', () => {
      if (!state.currentTrajId || getFrameCount() <= 0) return;
      void viewer.renderFrame(state.currentFrame);
    });

    bind(dom.dynamicBondsCheckbox, 'change', () => {
      const enabled = !!dom.dynamicBondsCheckbox?.checked;
      viewer.stopPlayback();
      if (typeof viewer.setDynamicBondsEnabled === 'function') {
        viewer.setDynamicBondsEnabled(enabled);
      } else {
        state.dynamicBonds = enabled;
      }
      if (!state.currentTrajId || getFrameCount() <= 0) return;
      void viewer.renderFrame(state.currentFrame);
    });

    bind(dom.showHydrogenBondsCheckbox, 'change', async () => {
      const enabled = !!dom.showHydrogenBondsCheckbox?.checked;
      const hbond = root.hbond;
      if (hbond && typeof hbond.setHydrogenBondsVisible === 'function') {
        await hbond.setHydrogenBondsVisible(enabled);
        return;
      }
      state.showHydrogenBonds = enabled;
      if (!state.currentTrajId || getFrameCount() <= 0) return;
      void viewer.renderFrame(state.currentFrame);
    });

    bind(dom.atomSizeSlider, 'input', () => {
      shared.dispatch(shared.actions.setAtomSizeScale(dom.atomSizeSlider?.value));
      if (!state.currentTrajId || getFrameCount() <= 0) return;
      viewer.refreshModelStyle();
      void viewer.renderFrame(state.currentFrame);
    });

    bind(dom.bondRadiusSlider, 'input', () => {
      shared.dispatch(shared.actions.setBondRadiusScale(dom.bondRadiusSlider?.value));
      if (!state.currentTrajId || getFrameCount() <= 0) return;
      viewer.refreshModelStyle();
      void viewer.renderFrame(state.currentFrame);
    });

    bind(dom.internalRenderScaleSlider, 'input', () => {
      viewer.stopPlayback();
      shared.dispatch(shared.actions.setInternalRenderScale(dom.internalRenderScaleSlider?.value));
      viewer.resizeViewer();
      if (!state.currentTrajId || getFrameCount() <= 0) return;
      void viewer.renderFrame(state.currentFrame);
    });

    bind(dom.hbondLineWidthSlider, 'input', () => {
      shared.dispatch(shared.actions.setHbondLineScale(dom.hbondLineWidthSlider?.value));
      if (!state.currentTrajId || getFrameCount() <= 0 || !state.showHydrogenBonds) return;
      void viewer.renderFrame(state.currentFrame);
    });
  }

  function refreshModelStyleAndRender() {
    if (!state.currentTrajId || getFrameCount() <= 0) return;
    viewer.refreshModelStyle();
    void viewer.renderFrame(state.currentFrame);
  }

  function addAtomStyleRuleFromInputs() {
    const rawSpec = dom.atomStyleRangeInput ? dom.atomStyleRangeInput.value : '';
    const rawMode = dom.atomStyleModeSelect ? dom.atomStyleModeSelect.value : '';
    const rule = shared.addAtomRenderRule(rawSpec, rawMode);
    if (!rule) return;
    if (dom.atomStyleRangeInput) dom.atomStyleRangeInput.value = '';
    shared.setStatus(`Added atom-style rule ${rule.rawSpec} -> ${rule.mode}.`);
    refreshModelStyleAndRender();
  }

  function bindRenderStyleRuleControls() {
    if (dom.atomStyleModeSelect && !dom.atomStyleModeSelect.value) {
      dom.atomStyleModeSelect.value = 'sphere';
    }

    bind(dom.atomStyleAddBtn, 'click', () => {
      addAtomStyleRuleFromInputs();
    });

    bind(dom.atomStyleRangeInput, 'keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      addAtomStyleRuleFromInputs();
    });

    bind(dom.atomStyleClearBtn, 'click', () => {
      const cleared = shared.clearAtomRenderRules();
      if (cleared <= 0) {
        shared.setStatus('No atom-style rules to clear.');
        return;
      }
      shared.setStatus(`Cleared ${cleared} atom-style rule${cleared === 1 ? '' : 's'}.`);
      refreshModelStyleAndRender();
    });

    bind(dom.atomStyleRulesEl, 'click', (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const removeBtn = target.closest('.atom-style-rule-remove-btn');
      if (!removeBtn) return;
      const ruleId = removeBtn.getAttribute('data-atom-style-rule-id');
      if (ruleId === null) return;
      const removed = shared.removeAtomRenderRule(ruleId);
      if (!removed) return;
      shared.setStatus('Removed atom-style rule.');
      refreshModelStyleAndRender();
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
    bind(dom.exportVideoBtn, 'click', () => io.exportTrajectoryVideo());
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
      if (!state.currentTrajId || getFrameCount() <= 0 || !state.showNacVectors) return;
      void viewer.renderFrame(state.currentFrame);
    });

    bind(dom.deScaleSlider, 'input', () => {
      shared.dispatch(shared.actions.setDeUserScale(dom.deScaleSlider?.value));
      if (!state.currentTrajId || getFrameCount() <= 0 || !state.showDeVectors) return;
      void viewer.renderFrame(state.currentFrame);
    });

    bind(dom.deNacScaleSlider, 'input', () => {
      shared.dispatch(shared.actions.setDeNacUserScale(dom.deNacScaleSlider?.value));
      if (!state.currentTrajId || getFrameCount() <= 0 || !state.showDeNacVectors) return;
      void viewer.renderFrame(state.currentFrame);
    });
  }

  function bindLifecycleCleanup() {
    window.addEventListener('beforeunload', () => {
      io.cancelGifExport(false);
      viewer.stopPlayback();
      if (typeof removeAppearanceSubscription === 'function') {
        removeAppearanceSubscription();
        removeAppearanceSubscription = null;
      }
      if (viewerResizeObserver) {
        viewerResizeObserver.disconnect();
        viewerResizeObserver = null;
      }
      window.removeEventListener('resize', viewer.resizeViewer);
    });
  }

  function bindViewerResizeObserver() {
    if (!dom.viewerEl || typeof ResizeObserver !== 'function') return;

    let rafPending = false;
    let lastWidth = -1;
    let lastHeight = -1;

    viewerResizeObserver = new ResizeObserver((entries) => {
      if (!state.viewer || !entries.length) return;

      const entry = entries[entries.length - 1];
      const width = Math.round(entry.contentRect.width);
      const height = Math.round(entry.contentRect.height);
      if (width === lastWidth && height === lastHeight) return;

      lastWidth = width;
      lastHeight = height;
      if (rafPending) return;

      rafPending = true;
      window.requestAnimationFrame(() => {
        rafPending = false;
        if (!state.viewer) return;
        viewer.resizeViewer();
      });
    });

    viewerResizeObserver.observe(dom.viewerEl);
  }

  function init() {
    bindAppearanceControls();
    io.setSourcePklInfo();
    shared.setDownloadButtonsEnabled(false);
    shared.setNacControlsEnabled(false);
    measurement.updateMeasurementControlState();

    if (typeof $3Dmol === 'undefined') {
      shared.setStatus('3Dmol.js failed to load. Please check network access.', true);
      return;
    }

    viewer.enforceViewerBounds();
    state.viewer = viewer.createViewerInstance(dom.viewerEl, { backgroundColor: currentViewerBackgroundColor() });
    viewer.resizeViewer();
    if (typeof viewer.applyAppearanceTheme === 'function') {
      viewer.applyAppearanceTheme({ rerender: false });
    }
    viewer.setPlaybackRate(state.playbackRate);
    viewer.setPlaybackStride(state.playbackStride);
    window.addEventListener('resize', viewer.resizeViewer);
    bindViewerResizeObserver();

    if (dataMode === 'api') {
      populateTrajectoryOptions();
    } else if (dom.trajSelect) {
      dom.trajSelect.disabled = true;
    }
    bindTrajectoryControls();
    bindPlaybackControls();
    bindRenderStyleRuleControls();
    bindMeasurementControls();
    bindExportControls();
    bindNacControls();
    bindLifecycleCleanup();

    if (dataMode === 'local_xyz') {
      shared.setStatus('Upload a multi-frame XYZ file to begin.', false);
      return;
    }

    if (!trajIds.length) {
      shared.setStatus('No trajectories found in dataset.', true);
      return;
    }

    if (dom.trajSelect) dom.trajSelect.value = trajIds[0];
    io.loadTrajectory(trajIds[0]);
  }

  init();
})();
