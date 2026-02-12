(function () {
  const root = window.ObservableMol3D || (window.ObservableMol3D = {});
  const shared = root.shared;
  if (!shared) return;

  const { meta, dom, constants, state, apiBase } = shared;
  const trajectoryCache = new Map();
  const trajectoryInflight = new Map();
  let loadRequestSeq = 0;

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

  function normalizeTrajId(trajId) {
    return String(trajId);
  }

  function normalizeTrajectoryPayload(trajId, payload) {
    const coords = Array.isArray(payload?.coords) ? payload.coords : [];
    const inferredAtoms = coords.length && Array.isArray(coords[0]) ? coords[0].length : 0;
    return {
      traj_id: normalizeTrajId(trajId),
      time: Array.isArray(payload?.time) ? payload.time : [],
      coords,
      n_atoms: Number.isFinite(Number(payload?.n_atoms)) ? Number(payload.n_atoms) : inferredAtoms,
      atom_numbers: Array.isArray(payload?.atom_numbers) ? payload.atom_numbers : [],
    };
  }

  function buildTrajectoryApiUrl(trajId) {
    const base = typeof apiBase === 'string' && apiBase.trim() ? apiBase.trim() : '/api';
    const normalizedBase = base.endsWith('/') ? base.slice(0, -1) : base;
    return `${normalizedBase}/molecule3d/trajectory/${encodeURIComponent(normalizeTrajId(trajId))}`;
  }

  async function fetchTrajectoryFromApi(trajId) {
    const url = buildTrajectoryApiUrl(trajId);
    const response = await fetch(url, { cache: 'default' });

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      let detail = `HTTP ${response.status}`;
      try {
        const payload = await response.json();
        if (typeof payload?.detail === 'string' && payload.detail.trim()) {
          detail = `${detail}: ${payload.detail}`;
        }
      } catch (_) {
        // best effort detail parsing
      }
      throw new Error(detail);
    }

    const payload = await response.json();
    return normalizeTrajectoryPayload(trajId, payload);
  }

  async function getTrajectoryRecord(trajId) {
    const key = normalizeTrajId(trajId);

    if (trajectoryCache.has(key)) {
      return trajectoryCache.get(key);
    }
    if (trajectoryInflight.has(key)) {
      return trajectoryInflight.get(key);
    }

    const pending = fetchTrajectoryFromApi(key)
      .then((payload) => {
        if (payload) {
          trajectoryCache.set(key, payload);
        }
        return payload;
      })
      .finally(() => {
        trajectoryInflight.delete(key);
      });
    trajectoryInflight.set(key, pending);
    return pending;
  }

  function clearLoadedTrajectoryView() {
    state.xyzFrames = [];
    state.currentTrajId = null;
    state.currentCoords = [];
    state.currentTimes = [];
    state.currentModel = null;
    shared.setDownloadButtonsEnabled(false);

    if (dom.frameLabel) dom.frameLabel.textContent = 'Frame 0/0';
    if (dom.frameSlider) {
      dom.frameSlider.min = '0';
      dom.frameSlider.max = '0';
      dom.frameSlider.value = '0';
    }
    if (state.viewer) {
      state.viewer.removeAllLabels();
      state.viewer.removeAllShapes();
      state.viewer.removeAllModels();
      state.viewer.render();
    }
  }

  async function loadTrajectory(trajId) {
    const viewer = root.viewer;
    const measurement = root.measurement;
    if (!viewer || !measurement) return;

    const selectedTrajId = normalizeTrajId(trajId);
    const requestSeq = ++loadRequestSeq;
    viewer.stopPlayback();
    shared.setDownloadButtonsEnabled(false);
    shared.setStatus(`Loading trajectory ${selectedTrajId} from API...`);

    let rec = null;
    try {
      rec = await getTrajectoryRecord(selectedTrajId);
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

    state.xyzFrames = buildXyzFrames(rec);
    state.currentTrajId = selectedTrajId;
    state.currentModel = null;
    measurement.clearMeasurementState();

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
    shared.setDownloadButtonsEnabled(true);

    shared.setStatus(`Loaded trajectory ${selectedTrajId} (${state.xyzFrames.length} frames).`);
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
