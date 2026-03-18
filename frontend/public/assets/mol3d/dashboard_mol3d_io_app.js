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
  const VIDEO_EXPORT_CANCELED_ERROR = '__video_export_canceled__';
  const VIDEO_EXPORT_UNAVAILABLE_MESSAGE = 'Video export is unavailable in this browser. Please use GIF export.';

  function getFrameCount() {
    return typeof shared.getCurrentFrameCount === 'function'
      ? shared.getCurrentFrameCount()
      : (Array.isArray(state.currentCoords) ? state.currentCoords.length : 0);
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

  function setSourcePklInfo() {
    if (!dom.sourcePklEl) return;
    const sourceLabel = String(meta?.source_label || '').trim();
    const sourcePkl = String(meta?.source_pkl || '');
    if (sourceLabel && !sourcePkl) {
      dom.sourcePklEl.textContent = `Source: ${sourceLabel}`;
      dom.sourcePklEl.title = sourceLabel;
      return;
    }
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
    if (!state.currentTrajId || getFrameCount() <= 0) {
      shared.setStatus('No frame available to save.', true);
      return;
    }
    try {
      const trajPart = shared.sanitizeFilenamePart(state.currentTrajId);
      const frameNumber = state.currentFrame + 1;
      const filename = `traj_${trajPart}_frame_${frameNumber}.xyz`;
      const xyzText = transformers.buildXyzFrame(buildCurrentTrajectoryRecord(), state.currentFrame);
      if (!xyzText) {
        shared.setStatus('Failed to build XYZ text for the current frame.', true);
        return;
      }
      downloadTextFile(xyzText, filename);
      shared.setStatus(`Saved current frame to ${filename}`);
    } catch (err) {
      shared.setStatus(`Failed to save current frame: ${err}`, true);
    }
  }

  function saveTrajectoryXyz() {
    if (!state.currentTrajId || getFrameCount() <= 0) {
      shared.setStatus('No trajectory available to save.', true);
      return;
    }
    try {
      const trajPart = shared.sanitizeFilenamePart(state.currentTrajId);
      const filename = `traj_${trajPart}_all_frames.xyz`;
      const xyzText = transformers.buildTrajectoryXyz(buildCurrentTrajectoryRecord());
      if (!xyzText) {
        shared.setStatus('Failed to build XYZ text for the trajectory.', true);
        return;
      }
      downloadTextFile(xyzText, filename);
      shared.setStatus(`Saved trajectory to ${filename}`);
    } catch (err) {
      shared.setStatus(`Failed to save trajectory: ${err}`, true);
    }
  }

  function resetGifExportRangeToFullTrajectory() {
    const frameCount = getFrameCount();
    const end = frameCount > 0 ? frameCount - 1 : 0;
    shared.dispatch(shared.actions.setGifExportRange(0, end, frameCount));
    shared.syncGifExportRangeUi();
  }

  function syncGifExportRangeFromInputs(notifyAdjust = false) {
    const frameCount = getFrameCount();
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

  function makeVideoFilename({ trajId, start, end, stride, fps }) {
    const trajPart = shared.sanitizeFilenamePart(trajId);
    const fpsText = Number.isFinite(fps) ? fps.toFixed(2).replace('.', 'p') : 'na';
    return `traj_${trajPart}_frames_${start}_${end}_stride_${stride}_fps_${fpsText}.webm`;
  }

  function getViewerCanvas() {
    const canvas = dom.viewerEl ? dom.viewerEl.querySelector('canvas') : null;
    if (canvas instanceof HTMLCanvasElement) {
      return canvas;
    }
    return null;
  }

  function pickSupportedWebmMimeType() {
    if (typeof MediaRecorder === 'undefined') return null;
    const candidates = [
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm',
    ];
    if (typeof MediaRecorder.isTypeSupported !== 'function') {
      return candidates[candidates.length - 1];
    }
    for (const mimeType of candidates) {
      try {
        if (MediaRecorder.isTypeSupported(mimeType)) {
          return mimeType;
        }
      } catch (_) {
        // keep trying candidates
      }
    }
    return null;
  }

  function waitMs(ms) {
    const delay = Math.max(0, Number(ms) || 0);
    return new Promise((resolve) => {
      setTimeout(resolve, delay);
    });
  }

  function stopMediaStreamTracks(stream) {
    if (!stream || typeof stream.getTracks !== 'function') return;
    const tracks = stream.getTracks();
    for (const track of tracks) {
      try {
        track.stop();
      } catch (_) {
        // best effort stop
      }
    }
  }

  function isExportCanceledMessage(message) {
    return message === GIF_EXPORT_CANCELED_ERROR || message === VIDEO_EXPORT_CANCELED_ERROR;
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

    if (state.videoExportTask && typeof state.videoExportTask.abort === 'function') {
      try {
        state.videoExportTask.abort();
      } catch (_) {
        // best effort cancel
      }
    }

    if (showStatus) {
      shared.setStatus('Canceling export...');
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
    if (!state.currentTrajId || getFrameCount() <= 0) {
      shared.setStatus('No trajectory available to export GIF.', true);
      return;
    }
    if (state.isGifExporting) {
      shared.setStatus('Export is already running.');
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
    state.videoExportTask = null;
    state.activeExportKind = 'gif';
    state.gifExportCancelRequested = false;
    shared.setControlsGroupOpen('gifRange', true);
    shared.setGifExportUiState(true);
    shared.setGifExportProgress(0, frameIndices.length, 'GIF');
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
        await viewer.renderFrame(frameIndex);
        await sleepToNextFrame();
        const dataUri = captureViewerFrameDataUri();
        const image = await loadImageFromDataUri(dataUri);
        gif.addFrame(image, { delay, copy: true });
        added += 1;
        shared.setGifExportProgress(added, frameIndices.length, 'GIF');
      }

      if (state.gifExportCancelRequested) {
        throw new Error(GIF_EXPORT_CANCELED_ERROR);
      }

      const blob = await new Promise((resolve, reject) => {
        gif.on('progress', (progress) => {
          const done = Math.max(0, Math.min(frameIndices.length, Math.round(progress * frameIndices.length)));
          shared.setGifExportProgress(done, frameIndices.length, 'GIF');
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
      shared.setGifExportProgress(frameIndices.length, frameIndices.length, 'GIF');
      shared.setStatus(`Saved GIF to ${filename}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isExportCanceledMessage(message) || state.gifExportCancelRequested) {
        shared.setStatus('GIF export canceled.');
      } else {
        shared.setStatus(`Failed to export GIF: ${message}`, true);
      }
    } finally {
      state.gifExportTask = null;
      state.videoExportTask = null;
      state.gifExportCancelRequested = false;
      state.activeExportKind = '';
      shared.setGifExportUiState(false);
    }
  }

  async function exportTrajectoryVideo() {
    const viewer = root.viewer;
    if (!viewer || typeof viewer.renderFrame !== 'function') return;
    if (!state.currentTrajId || getFrameCount() <= 0) {
      shared.setStatus('No trajectory available to export video.', true);
      return;
    }
    if (state.isGifExporting) {
      shared.setStatus('Export is already running.');
      return;
    }

    if (typeof MediaRecorder === 'undefined') {
      shared.setStatus(VIDEO_EXPORT_UNAVAILABLE_MESSAGE, true);
      return;
    }

    const mimeType = pickSupportedWebmMimeType();
    if (!mimeType) {
      shared.setStatus(VIDEO_EXPORT_UNAVAILABLE_MESSAGE, true);
      return;
    }

    const canvas = getViewerCanvas();
    if (!canvas || typeof canvas.captureStream !== 'function') {
      shared.setStatus(VIDEO_EXPORT_UNAVAILABLE_MESSAGE, true);
      return;
    }

    viewer.stopPlayback();
    const { start, end } = syncGifExportRangeFromInputs(true);
    const stride = shared.clampPlaybackStride(state.playbackStride);
    const fps = shared.effectivePlaybackFps();
    const safeFps = Number.isFinite(fps) && fps > 0 ? fps : 10;
    const frameIntervalMs = 1000 / safeFps;
    const frameIndices = [];
    for (let idx = start; idx <= end; idx += stride) {
      frameIndices.push(idx);
    }
    if (!frameIndices.length) {
      shared.setStatus('No frames selected for video export.', true);
      return;
    }

    let stream = null;
    let recorder = null;
    let stopPromise = null;
    let recorderStarted = false;

    try {
      stream = canvas.captureStream(safeFps);
      const chunks = [];

      recorder = new MediaRecorder(stream, { mimeType });
      stopPromise = new Promise((resolve, reject) => {
        recorder.ondataavailable = (event) => {
          if (event && event.data && event.data.size > 0) {
            chunks.push(event.data);
          }
        };
        recorder.onerror = (event) => {
          const detail = event?.error?.message || event?.name || 'unknown recorder error';
          reject(new Error(`Video recorder error: ${detail}`));
        };
        recorder.onstop = () => {
          if (state.gifExportCancelRequested) {
            reject(new Error(VIDEO_EXPORT_CANCELED_ERROR));
            return;
          }
          resolve(new Blob(chunks, { type: mimeType || 'video/webm' }));
        };
      });

      state.gifExportTask = null;
      state.videoExportTask = {
        recorder,
        stream,
        abort() {
          try {
            if (recorder && recorder.state !== 'inactive') {
              recorder.stop();
            }
          } catch (_) {
            // best effort stop
          }
          stopMediaStreamTracks(stream);
        },
      };
      state.activeExportKind = 'video';
      state.gifExportCancelRequested = false;

      shared.setControlsGroupOpen('gifRange', true);
      shared.setGifExportUiState(true);
      shared.setGifExportProgress(0, frameIndices.length, 'VIDEO');
      shared.setStatus(
        `Exporting VIDEO ${start}-${end} (0-based), stride=${stride}, fps=${safeFps.toFixed(2)}, frames=${frameIndices.length}...`
      );

      recorder.start(200);
      recorderStarted = true;
      const startedAt = typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now();

      let rendered = 0;
      for (const frameIndex of frameIndices) {
        if (state.gifExportCancelRequested) {
          throw new Error(VIDEO_EXPORT_CANCELED_ERROR);
        }
        await viewer.renderFrame(frameIndex);
        await sleepToNextFrame();

        rendered += 1;
        shared.setGifExportProgress(rendered, frameIndices.length, 'VIDEO');

        const now = typeof performance !== 'undefined' && typeof performance.now === 'function'
          ? performance.now()
          : Date.now();
        const elapsed = now - startedAt;
        const targetElapsed = rendered * frameIntervalMs;
        if (targetElapsed > elapsed) {
          await waitMs(targetElapsed - elapsed);
        }
      }

      if (state.gifExportCancelRequested) {
        throw new Error(VIDEO_EXPORT_CANCELED_ERROR);
      }

      if (recorder.state !== 'inactive') {
        recorder.stop();
      }

      const blob = await stopPromise;

      if (state.gifExportCancelRequested) {
        throw new Error(VIDEO_EXPORT_CANCELED_ERROR);
      }

      const filename = makeVideoFilename({
        trajId: state.currentTrajId,
        start,
        end,
        stride,
        fps: safeFps,
      });
      downloadBlobFile(blob, filename);
      shared.setGifExportProgress(frameIndices.length, frameIndices.length, 'VIDEO');
      shared.setStatus(`Saved VIDEO to ${filename}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isExportCanceledMessage(message) || state.gifExportCancelRequested) {
        shared.setStatus('Video export canceled.');
      } else {
        shared.setStatus(`Failed to export video: ${message}`, true);
      }
    } finally {
      if (recorder && recorder.state !== 'inactive') {
        try {
          recorder.stop();
        } catch (_) {
          // best effort stop
        }
      }
      if (stopPromise && recorderStarted) {
        try {
          await stopPromise;
        } catch (_) {
          // settled via cancel/error
        }
      }
      stopMediaStreamTracks(stream);
      state.gifExportTask = null;
      state.videoExportTask = null;
      state.gifExportCancelRequested = false;
      state.activeExportKind = '';
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

  async function applyTrajectoryRecord(selectedTrajId, rec, options = {}) {
    const viewer = root.viewer;
    const measurement = root.measurement;
    if (!viewer || !measurement) return false;

    const preparedTrajectory = typeof transformers.prepareRenderableTrajectory === 'function'
      ? transformers.prepareRenderableTrajectory(rec)
      : rec;

    state.currentCoords = Array.isArray(preparedTrajectory?.coords) ? preparedTrajectory.coords : [];
    state.currentTimes = Array.isArray(preparedTrajectory?.time) ? preparedTrajectory.time : [];
    state.atomNumbers = Array.isArray(preparedTrajectory?.atom_numbers) ? preparedTrajectory.atom_numbers : [];
    state.hbondCache = null;

    state.xyzFrames = [];
    state.currentTrajId = selectedTrajId;
    state.currentModel = null;
    state.currentModelRenderMode = '';
    state.currentFrame = 0;
    measurement.syncMeasurementStateForTrajectoryChange();
    vectorOps.applyTrajectoryNacMeta(preparedTrajectory);

    const frameCount = getFrameCount();
    if (frameCount <= 0) {
      clearLoadedTrajectoryView();
      measurement.syncMeasurementStateForTrajectoryChange();
      shared.setStatus(`Trajectory ${selectedTrajId} has no valid coordinate frames.`, true);
      return false;
    }

    const firstFrameXyz = typeof transformers.buildXyzFrame === 'function'
      ? transformers.buildXyzFrame(preparedTrajectory, 0)
      : '';
    if (!firstFrameXyz || typeof viewer.initializeTrajectoryModel !== 'function') {
      clearLoadedTrajectoryView();
      measurement.syncMeasurementStateForTrajectoryChange();
      shared.setStatus(`Trajectory ${selectedTrajId} could not initialize the 3D viewer.`, true);
      return false;
    }

    const initialized = viewer.initializeTrajectoryModel(firstFrameXyz, state.currentCoords);
    if (!initialized) {
      clearLoadedTrajectoryView();
      measurement.syncMeasurementStateForTrajectoryChange();
      shared.setStatus(`Trajectory ${selectedTrajId} could not initialize the 3D viewer.`, true);
      return false;
    }

    if (dom.frameSlider) {
      dom.frameSlider.min = '0';
      dom.frameSlider.max = String(frameCount - 1);
      dom.frameSlider.step = '1';
    }
    resetGifExportRangeToFullTrajectory();
    shared.setDownloadButtonsEnabled(true);
    shared.setGifExportUiState(false);
    const restoredVectors = typeof vectorOps.restoreDesiredVectorVisibility === 'function'
      ? await vectorOps.restoreDesiredVectorVisibility()
      : null;

    let statusMessage = String(options.loadedMessage || `Loaded trajectory ${selectedTrajId} (${frameCount} frames).`);
    let statusIsError = false;
    if (Array.isArray(restoredVectors?.restored) && restoredVectors.restored.length) {
      statusMessage += ` Restored vectors: ${restoredVectors.restored.join(', ')}.`;
    }
    if (Array.isArray(restoredVectors?.unavailable) && restoredVectors.unavailable.length) {
      statusMessage += ` Unavailable here: ${restoredVectors.unavailable.join(', ')}.`;
    }
    if (Array.isArray(restoredVectors?.failed) && restoredVectors.failed.length) {
      statusMessage += ` Failed to restore: ${restoredVectors.failed.join('; ')}.`;
      statusIsError = true;
    }

    shared.setStatus(statusMessage, statusIsError);
    await viewer.renderFrame(0, true);
    return true;
  }

  function clearLoadedTrajectoryView() {
    const hbond = root.hbond;
    cancelGifExport(false);
    state.xyzFrames = [];
    state.currentTrajId = null;
    state.currentCoords = [];
    state.currentTimes = [];
    state.currentModel = null;
    state.currentModelRenderMode = '';
    state.atomNumbers = [];
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
    if (dom.framePrevBtn) dom.framePrevBtn.disabled = true;
    if (dom.frameNextBtn) dom.frameNextBtn.disabled = true;
    const viewer = root.viewer;
    if (viewer && typeof viewer.clearScene === 'function') {
      viewer.clearScene();
    }
    if (hbond && typeof hbond.resetHydrogenBondState === 'function') {
      hbond.resetHydrogenBondState();
    }
    if (state.viewer) state.viewer.render();
  }

  async function loadTrajectory(trajId) {
    const viewer = root.viewer;
    const measurement = root.measurement;
    if (!viewer || !measurement) return;

    const selectedTrajId = transformers.normalizeTrajId(trajId);
    const requestSeq = ++loadRequestSeq;
    const hbond = root.hbond;
    cancelGifExport(false);
    viewer.stopPlayback();
    if (hbond && typeof hbond.resetHydrogenBondState === 'function') {
      hbond.resetHydrogenBondState();
    }
    shared.setDownloadButtonsEnabled(false);
    shared.setGifExportProgress(0, 0);
    shared.setStatus(`Loading trajectory ${selectedTrajId} from API...`);

    let rec = null;
    try {
      rec = await network.getTrajectoryRecord(selectedTrajId);
    } catch (error) {
      if (requestSeq !== loadRequestSeq) return;
      const detail = error instanceof Error ? error.message : String(error);
      clearLoadedTrajectoryView();
      measurement.syncMeasurementStateForTrajectoryChange();
      shared.setStatus(`Failed to load trajectory ${selectedTrajId} from API: ${detail}`, true);
      return;
    }

    if (requestSeq !== loadRequestSeq) return;

    if (!rec) {
      clearLoadedTrajectoryView();
      measurement.syncMeasurementStateForTrajectoryChange();
      shared.setStatus(`Trajectory ${selectedTrajId} not found.`, true);
      return;
    }
    await applyTrajectoryRecord(selectedTrajId, rec);
  }

  async function loadTrajectoryRecord(trajId, rec, options = {}) {
    const viewer = root.viewer;
    const measurement = root.measurement;
    if (!viewer || !measurement) return false;

    const selectedTrajId = transformers.normalizeTrajId(trajId);
    const requestSeq = ++loadRequestSeq;
    const hbond = root.hbond;
    cancelGifExport(false);
    viewer.stopPlayback();
    if (hbond && typeof hbond.resetHydrogenBondState === 'function') {
      hbond.resetHydrogenBondState();
    }
    shared.setDownloadButtonsEnabled(false);
    shared.setGifExportProgress(0, 0);
    if (options.loadingMessage) {
      shared.setStatus(String(options.loadingMessage));
    }

    if (!rec || typeof rec !== 'object') {
      clearLoadedTrajectoryView();
      measurement.syncMeasurementStateForTrajectoryChange();
      shared.setStatus(`Trajectory ${selectedTrajId} is empty or invalid.`, true);
      return false;
    }
    if (requestSeq !== loadRequestSeq) return false;
    return applyTrajectoryRecord(selectedTrajId, rec, options);
  }

  vectorOps.registerVectorSources();

  root.ioApp = {
    setSourcePklInfo,
    downloadTextFile,
    saveCurrentFrameXyz,
    saveTrajectoryXyz,
    syncGifExportRangeFromInputs,
    exportTrajectoryGif,
    exportTrajectoryVideo,
    cancelGifExport,
    loadTrajectory,
    loadTrajectoryRecord,
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
