(function () {
  const root = window.ObservableMol3D || (window.ObservableMol3D = {});
  const shared = root.shared;
  const network = root.ioNetwork;
  const transformers = root.ioTransformers;
  const vectorOps = root.ioVectorOps;
  if (!shared || !network || !transformers || !vectorOps) return;

  const { meta, dom, constants, state } = shared;
  let loadRequestSeq = 0;
  const GIF_EXPORT_CANCELED_ERROR = '__gif_export_canceled__';

  function setSourcePklInfo() {
    if (!dom.sourcePklEl) return;
    const sourcePkl = String(meta?.source_pkl || '');
    if (sourcePkl) {
      const filename = sourcePkl.split(/[\\/]/).pop() || sourcePkl;
      dom.sourcePklEl.textContent = `PKL: ${filename}`;
      dom.sourcePklEl.title = sourcePkl;
      return;
    }
    dom.sourcePklEl.textContent = 'PKL: unknown';
    dom.sourcePklEl.title = 'unknown';
  }

  function downloadBlobFile(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  function downloadTextFile(text, filename) {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    downloadBlobFile(blob, filename);
  }

  function saveCurrentFrameXyz() {
    if (!state.currentTrajId || !state.xyzFrames.length) {
      shared.setStatus('No frame available to save.', true);
      return;
    }
    try {
      const trajPart = shared.sanitizeFilenamePart(state.currentTrajId);
      const frameNumber = state.currentFrame + 1;
      const filename = `traj_${trajPart}_frame_${frameNumber}.xyz`;
      downloadTextFile(state.xyzFrames[state.currentFrame], filename);
      shared.setStatus(`Saved current frame to ${filename}`);
    } catch (err) {
      shared.setStatus(`Failed to save current frame: ${err}`, true);
    }
  }

  function saveTrajectoryXyz() {
    if (!state.currentTrajId || !state.xyzFrames.length) {
      shared.setStatus('No trajectory available to save.', true);
      return;
    }
    try {
      const trajPart = shared.sanitizeFilenamePart(state.currentTrajId);
      const filename = `traj_${trajPart}_all_frames.xyz`;
      downloadTextFile(state.xyzFrames.join('\n'), filename);
      shared.setStatus(`Saved trajectory to ${filename}`);
    } catch (err) {
      shared.setStatus(`Failed to save trajectory: ${err}`, true);
    }
  }

  function resetGifExportRangeToFullTrajectory() {
    const frameCount = state.xyzFrames.length;
    const end = frameCount > 0 ? frameCount - 1 : 0;
    shared.dispatch(shared.actions.setGifExportRange(0, end, frameCount));
    shared.syncGifExportRangeUi();
  }

  function syncGifExportRangeFromInputs(notifyAdjust = false) {
    const frameCount = state.xyzFrames.length;
    if (frameCount <= 0) {
      shared.dispatch(shared.actions.setGifExportRange(0, 0, 0));
      shared.syncGifExportRangeUi();
      return { start: 0, end: 0 };
    }
    const rawStart = dom.gifExportStartInput ? Number.parseInt(dom.gifExportStartInput.value, 10) : state.gifExportRangeStart;
    const rawEnd = dom.gifExportEndInput ? Number.parseInt(dom.gifExportEndInput.value, 10) : state.gifExportRangeEnd;
    shared.dispatch(shared.actions.setGifExportRange(rawStart, rawEnd, frameCount));
    const normalized = shared.clampGifExportRange(state.gifExportRangeStart, state.gifExportRangeEnd, frameCount);
    const changed = normalized.start !== rawStart || normalized.end !== rawEnd;
    shared.syncGifExportRangeUi();
    if (notifyAdjust && changed) {
      shared.setStatus(`GIF frame range adjusted to [${normalized.start}, ${normalized.end}] (0-based).`);
    }
    return normalized;
  }

  function sleepToNextFrame() {
    return new Promise((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  }

  function captureViewerFrameDataUri() {
    if (state.viewer && typeof state.viewer.pngURI === 'function') {
      const uri = state.viewer.pngURI();
      if (typeof uri === 'string' && uri.startsWith('data:image/')) {
        return uri;
      }
    }
    const canvas = dom.viewerEl ? dom.viewerEl.querySelector('canvas') : null;
    if (canvas && typeof canvas.toDataURL === 'function') {
      return canvas.toDataURL('image/png');
    }
    throw new Error('Viewer frame capture is not available.');
  }

  function loadImageFromDataUri(uri) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('Failed to decode captured frame image.'));
      image.src = uri;
    });
  }

  function makeGifFilename({ trajId, start, end, stride, fps }) {
    const trajPart = shared.sanitizeFilenamePart(trajId);
    const fpsText = Number.isFinite(fps) ? fps.toFixed(2).replace('.', 'p') : 'na';
    return `traj_${trajPart}_frames_${start}_${end}_stride_${stride}_fps_${fpsText}.gif`;
  }

  function cancelGifExport(showStatus = true) {
    if (!state.isGifExporting) return false;
    state.gifExportCancelRequested = true;
    if (state.gifExportTask && typeof state.gifExportTask.abort === 'function') {
      try {
        state.gifExportTask.abort();
      } catch (_) {
        // best effort cancel
      }
    }
    if (showStatus) {
      shared.setStatus('Canceling GIF export...');
    }
    return true;
  }

  async function exportTrajectoryGif() {
    const viewer = root.viewer;
    if (!viewer || typeof viewer.renderFrame !== 'function') return;
    if (typeof GIF === 'undefined') {
      shared.setStatus('GIF encoder is unavailable. Please verify assets/vendor/gif.min.js.', true);
      return;
    }
    if (!state.currentTrajId || !state.xyzFrames.length) {
      shared.setStatus('No trajectory available to export GIF.', true);
      return;
    }
    if (state.isGifExporting) {
      shared.setStatus('GIF export is already running.');
      return;
    }

    viewer.stopPlayback();
    const { start, end } = syncGifExportRangeFromInputs(true);
    const stride = shared.clampPlaybackStride(state.playbackStride);
    const fps = shared.effectivePlaybackFps();
    const delay = Math.max(1, Math.round(1000 / fps));
    const frameIndices = [];
    for (let idx = start; idx <= end; idx += stride) {
      frameIndices.push(idx);
    }
    if (!frameIndices.length) {
      shared.setStatus('No frames selected for GIF export.', true);
      return;
    }

    const workerCount = Math.max(1, Number.parseInt(String(constants.GIF_EXPORT_DEFAULT_WORKERS), 10) || 1);
    const gif = new GIF({
      workers: workerCount,
      quality: constants.GIF_EXPORT_DEFAULT_QUALITY,
      workerScript: constants.GIF_EXPORT_WORKER_URL,
    });

    state.gifExportTask = gif;
    state.gifExportCancelRequested = false;
    shared.setControlsGroupOpen('gifRange', true);
    shared.setGifExportUiState(true);
    shared.setGifExportProgress(0, frameIndices.length);
    shared.setStatus(
      `Exporting GIF ${start}-${end} (0-based), stride=${stride}, fps=${fps.toFixed(2)}, frames=${frameIndices.length}...`
    );

    try {
      let added = 0;
      for (const frameIndex of frameIndices) {
        if (state.gifExportCancelRequested) {
          throw new Error(GIF_EXPORT_CANCELED_ERROR);
        }
        // Render -> capture -> decode image in order for deterministic GIF frames.
        viewer.renderFrame(frameIndex);
        await sleepToNextFrame();
        const dataUri = captureViewerFrameDataUri();
        const image = await loadImageFromDataUri(dataUri);
        gif.addFrame(image, { delay, copy: true });
        added += 1;
        shared.setGifExportProgress(added, frameIndices.length);
      }

      if (state.gifExportCancelRequested) {
        throw new Error(GIF_EXPORT_CANCELED_ERROR);
      }

      const blob = await new Promise((resolve, reject) => {
        gif.on('progress', (progress) => {
          const done = Math.max(0, Math.min(frameIndices.length, Math.round(progress * frameIndices.length)));
          shared.setGifExportProgress(done, frameIndices.length);
        });
        gif.on('finished', (result) => resolve(result));
        gif.on('abort', () => reject(new Error(GIF_EXPORT_CANCELED_ERROR)));
        gif.render();
      });

      if (state.gifExportCancelRequested) {
        throw new Error(GIF_EXPORT_CANCELED_ERROR);
      }

      const filename = makeGifFilename({
        trajId: state.currentTrajId,
        start,
        end,
        stride,
        fps,
      });
      downloadBlobFile(blob, filename);
      shared.setGifExportProgress(frameIndices.length, frameIndices.length);
      shared.setStatus(`Saved GIF to ${filename}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === GIF_EXPORT_CANCELED_ERROR || state.gifExportCancelRequested) {
        shared.setStatus('GIF export canceled.');
      } else {
        shared.setStatus(`Failed to export GIF: ${message}`, true);
      }
    } finally {
      state.gifExportTask = null;
      state.gifExportCancelRequested = false;
      shared.setGifExportUiState(false);
    }
  }

  async function setNacVectorsVisible(enabled) {
    return vectorOps.setNacVectorsVisible(enabled);
  }

  async function setDeVectorsVisible(enabled) {
    return vectorOps.setDeVectorsVisible(enabled);
  }

  async function setDeNacVectorsVisible(enabled) {
    return vectorOps.setDeNacVectorsVisible(enabled);
  }

  async function updateNacStatePairFromControls(preferredField = 'j') {
    return vectorOps.updateNacStatePairFromControls(preferredField);
  }

  async function updateDeStatePairFromControls(preferredField = 'j') {
    return vectorOps.updateDeStatePairFromControls(preferredField);
  }

  async function addDeRow() {
    return vectorOps.addDeRow();
  }

  async function removeDeRow(rowId) {
    return vectorOps.removeDeRow(rowId);
  }

  async function toggleDeRowEnabled(rowId, enabled) {
    return vectorOps.toggleDeRowEnabled(rowId, enabled);
  }

  async function updateDeRowPair(rowId, preferredField = 'j') {
    return vectorOps.updateDeRowPair(rowId, preferredField);
  }

  async function loadNacPair(forceReload = false) {
    return vectorOps.loadNacPair(forceReload);
  }

  async function loadDePair(forceReload = false) {
    return vectorOps.loadDePair(forceReload);
  }

  async function loadDeNacPair(forceReload = false) {
    return vectorOps.loadDeNacPair(forceReload);
  }

  function clearLoadedTrajectoryView() {
    cancelGifExport(false);
    state.xyzFrames = [];
    state.currentTrajId = null;
    state.currentCoords = [];
    state.currentTimes = [];
    state.currentModel = null;
    shared.dispatch(shared.actions.setGifExportRange(0, 0, 0));
    vectorOps.clearVectorViewState();
    shared.setDownloadButtonsEnabled(false);
    shared.syncGifExportRangeUi();
    shared.setGifExportProgress(0, 0);

    if (dom.frameLabel) dom.frameLabel.textContent = 'Frame 0/0';
    if (dom.frameSlider) {
      dom.frameSlider.min = '0';
      dom.frameSlider.max = '0';
      dom.frameSlider.value = '0';
    }
    const viewer = root.viewer;
    if (viewer && typeof viewer.clearScene === 'function') {
      viewer.clearScene();
    }
    if (state.viewer) state.viewer.render();
  }

  async function loadTrajectory(trajId) {
    const viewer = root.viewer;
    const measurement = root.measurement;
    if (!viewer || !measurement) return;

    const selectedTrajId = transformers.normalizeTrajId(trajId);
    const requestSeq = ++loadRequestSeq;
    cancelGifExport(false);
    viewer.stopPlayback();
    shared.setDownloadButtonsEnabled(false);
    shared.setGifExportProgress(0, 0);
    shared.setStatus(`Loading trajectory ${selectedTrajId} from API...`);

    let rec = null;
    try {
      rec = await network.getTrajectoryRecord(selectedTrajId);
    } catch (error) {
      if (requestSeq !== loadRequestSeq) return;
      const detail = error instanceof Error ? error.message : String(error);
      measurement.clearMeasurementState();
      clearLoadedTrajectoryView();
      shared.setStatus(`Failed to load trajectory ${selectedTrajId} from API: ${detail}`, true);
      return;
    }

    if (requestSeq !== loadRequestSeq) return;

    if (!rec) {
      measurement.clearMeasurementState();
      clearLoadedTrajectoryView();
      shared.setStatus(`Trajectory ${selectedTrajId} not found.`, true);
      return;
    }

    state.currentCoords = Array.isArray(rec.coords) ? rec.coords : [];
    state.currentTimes = Array.isArray(rec.time) ? rec.time : [];

    state.xyzFrames = transformers.buildXyzFrames(rec);
    state.currentTrajId = selectedTrajId;
    state.currentModel = null;
    measurement.clearMeasurementState();
    vectorOps.applyTrajectoryNacMeta(rec);

    if (!state.xyzFrames.length) {
      clearLoadedTrajectoryView();
      shared.setStatus(`Trajectory ${selectedTrajId} has no valid coordinate frames.`, true);
      return;
    }

    if (dom.frameSlider) {
      dom.frameSlider.min = '0';
      dom.frameSlider.max = String(state.xyzFrames.length - 1);
      dom.frameSlider.step = '1';
    }
    resetGifExportRangeToFullTrajectory();
    shared.setDownloadButtonsEnabled(true);
    shared.setGifExportUiState(false);

    shared.setStatus(`Loaded trajectory ${selectedTrajId} (${state.xyzFrames.length} frames).`);
    viewer.renderFrame(0, true);
  }

  vectorOps.registerVectorSources();

  root.ioApp = {
    setSourcePklInfo,
    downloadTextFile,
    saveCurrentFrameXyz,
    saveTrajectoryXyz,
    syncGifExportRangeFromInputs,
    exportTrajectoryGif,
    cancelGifExport,
    loadTrajectory,
    setNacVectorsVisible,
    setDeVectorsVisible,
    setDeNacVectorsVisible,
    updateNacStatePairFromControls,
    updateDeStatePairFromControls,
    addDeRow,
    removeDeRow,
    toggleDeRowEnabled,
    updateDeRowPair,
    loadNacPair,
    loadDePair,
    loadDeNacPair,
  };
})();
