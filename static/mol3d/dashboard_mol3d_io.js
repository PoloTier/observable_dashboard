(function () {
  const root = window.ObservableMol3D || (window.ObservableMol3D = {});
  const shared = root.shared;
  if (!shared) return;

  const { payload, trajectories, dom, constants, state } = shared;

  function setSourcePklInfo() {
    if (!dom.sourcePklEl) return;
    const sourcePkl = String(payload.meta?.source_pkl || '');
    if (sourcePkl) {
      const filename = sourcePkl.split(/[\\/]/).pop() || sourcePkl;
      dom.sourcePklEl.textContent = `PKL: ${filename}`;
      dom.sourcePklEl.title = sourcePkl;
      return;
    }
    dom.sourcePklEl.textContent = 'PKL: unknown';
    dom.sourcePklEl.title = 'unknown';
  }

  function downloadTextFile(text, filename) {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
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

  function atomicNumberToElement(z) {
    const n = Number.parseInt(z, 10);
    if (!Number.isFinite(n) || n <= 0) return 'C';
    if (n >= constants.PERIODIC_SYMBOLS.length) return 'C';
    return constants.PERIODIC_SYMBOLS[n] || 'C';
  }

  function buildXyzFrames(record) {
    const coords = Array.isArray(record?.coords) ? record.coords : [];
    if (!coords.length) return [];

    const nAtoms = Number(record?.n_atoms || (coords[0] ? coords[0].length : 0));
    if (!Number.isFinite(nAtoms) || nAtoms <= 0) return [];

    let atomNumbers = Array.isArray(record?.atom_numbers) ? record.atom_numbers.slice(0, nAtoms) : [];
    if (atomNumbers.length < nAtoms) {
      atomNumbers = atomNumbers.concat(new Array(nAtoms - atomNumbers.length).fill(6));
    }

    const times = Array.isArray(record?.time) ? record.time : [];
    const frameCount = Math.min(coords.length, times.length || coords.length);
    const out = [];

    for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
      const frame = coords[frameIndex];
      if (!Array.isArray(frame) || frame.length < nAtoms) continue;

      const lines = [
        String(nAtoms),
        `Frame ${frameIndex} time=${Number(times[frameIndex] ?? frameIndex).toFixed(6)} fs`
      ];

      for (let atomIndex = 0; atomIndex < nAtoms; atomIndex++) {
        const xyz = frame[atomIndex];
        if (!Array.isArray(xyz) || xyz.length < 3) {
          lines.push('C 0.000000 0.000000 0.000000');
          continue;
        }

        const elem = atomicNumberToElement(atomNumbers[atomIndex]);
        lines.push(`${elem} ${Number(xyz[0]).toFixed(8)} ${Number(xyz[1]).toFixed(8)} ${Number(xyz[2]).toFixed(8)}`);
      }

      out.push(lines.join('\n'));
    }

    return out;
  }

  function loadTrajectory(trajId) {
    const viewer = root.viewer;
    const measurement = root.measurement;
    if (!viewer || !measurement) return;

    viewer.stopPlayback();

    const rec = trajectories[trajId];
    if (!rec) {
      state.xyzFrames = [];
      state.currentTrajId = null;
      state.currentCoords = [];
      state.currentTimes = [];
      state.currentModel = null;
      shared.setDownloadButtonsEnabled(false);
      measurement.clearMeasurementState();
      shared.setStatus(`Trajectory ${trajId} not found.`, true);
      if (dom.frameLabel) dom.frameLabel.textContent = 'Frame 0/0';
      if (dom.frameSlider) {
        dom.frameSlider.min = '0';
        dom.frameSlider.max = '0';
        dom.frameSlider.value = '0';
      }
      if (state.viewer) {
        state.viewer.removeAllLabels();
        state.viewer.removeAllModels();
        state.viewer.render();
      }
      return;
    }

    state.currentCoords = Array.isArray(rec.coords) ? rec.coords : [];
    state.currentTimes = Array.isArray(rec.time) ? rec.time : [];

    state.xyzFrames = buildXyzFrames(rec);
    state.currentTrajId = trajId;
    state.currentModel = null;
    measurement.clearMeasurementState();

    if (!state.xyzFrames.length) {
      shared.setDownloadButtonsEnabled(false);
      shared.setStatus(`Trajectory ${trajId} has no valid coordinate frames.`, true);
      if (dom.frameLabel) dom.frameLabel.textContent = 'Frame 0/0';
      if (dom.frameSlider) {
        dom.frameSlider.min = '0';
        dom.frameSlider.max = '0';
        dom.frameSlider.value = '0';
      }
      if (state.viewer) {
        state.viewer.removeAllLabels();
        state.viewer.removeAllModels();
        state.viewer.render();
      }
      return;
    }

    if (dom.frameSlider) {
      dom.frameSlider.min = '0';
      dom.frameSlider.max = String(state.xyzFrames.length - 1);
      dom.frameSlider.step = '1';
    }
    shared.setDownloadButtonsEnabled(true);

    shared.setStatus(`Loaded trajectory ${trajId} (${state.xyzFrames.length} frames).`);
    viewer.renderFrame(0, true);
  }

  root.io = {
    setSourcePklInfo,
    downloadTextFile,
    saveCurrentFrameXyz,
    saveTrajectoryXyz,
    atomicNumberToElement,
    buildXyzFrames,
    loadTrajectory,
  };
})();
