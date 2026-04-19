(function () {
  const root = window.ObservableMol3D || (window.ObservableMol3D = {});
  const shared = root.shared;
  const io = root.io;
  const viewer = root.viewer;
  const measurement = root.measurement;
  const transformers = root.ioTransformers;
  if (!shared || !io || !viewer || !measurement || !transformers) return;

  const sharedDom = shared.dom || {};
  const dom = {
    mdTab: document.getElementById('md-mode-tab-md'),
    pimdTab: document.getElementById('md-mode-tab-pimd'),
    mdPanel: document.getElementById('md-panel-md'),
    pimdPanel: document.getElementById('md-panel-pimd'),
    mdUploadCard: document.getElementById('md-upload-card'),
    pimdUploadCard: document.getElementById('pimd-upload-card'),
    uploadInput: document.getElementById('md-upload-input'),
    mdBackendPathInput: document.getElementById('md-backend-path-input'),
    mdBackendBrowseBtn: document.getElementById('md-backend-browse-btn'),
    mdBackendImportBtn: document.getElementById('md-backend-import-btn'),
    dropzone: document.getElementById('md-dropzone'),
    uploadFileName: document.getElementById('md-upload-file-name'),
    metaFile: document.getElementById('md-meta-file'),
    metaFileSubvalue: document.getElementById('md-meta-file-subvalue'),
    metaFrames: document.getElementById('md-meta-frames'),
    metaAtoms: document.getElementById('md-meta-atoms'),
    metaElements: document.getElementById('md-meta-elements'),
    pimdInput: document.getElementById('pimd-upload-input'),
    pimdBackendPathInput: document.getElementById('pimd-backend-path-input'),
    pimdBackendBrowseBtn: document.getElementById('pimd-backend-browse-btn'),
    pimdBackendImportBtn: document.getElementById('pimd-backend-import-btn'),
    pimdDropzone: document.getElementById('pimd-dropzone'),
    pimdUploadFileName: document.getElementById('pimd-upload-file-name'),
    pimdMetaFile: document.getElementById('pimd-meta-file'),
    pimdMetaFileSubvalue: document.getElementById('pimd-meta-file-subvalue'),
    pimdMetaFrames: document.getElementById('pimd-meta-frames'),
    pimdMetaBeads: document.getElementById('pimd-meta-beads'),
    pimdMetaAtoms: document.getElementById('pimd-meta-atoms'),
    pimdMetaElements: document.getElementById('pimd-meta-elements'),
    pimdMetaEnergy: document.getElementById('pimd-meta-energy'),
    pimdMetaTemperature: document.getElementById('pimd-meta-temperature'),
    pimdDisplayModeSelect: document.getElementById('pimd-display-mode-select'),
    pimdBeadSelect: document.getElementById('pimd-bead-select'),
    sourceInfo: document.getElementById('source-pkl'),
    workflowLink: document.getElementById('md-open-workflow-link'),
    apiViewerLink: document.getElementById('md-open-api-viewer-link'),
    viewerControlsTitle: document.getElementById('viewer-controls-title'),
    legacyExportControls: document.getElementById('md-legacy-export-controls'),
    samplingExportPanel: document.getElementById('md-sampling-export-panel'),
    samplingStartFrame: document.getElementById('md-sampling-start-frame'),
    samplingEndFrame: document.getElementById('md-sampling-end-frame'),
    samplingFrameStride: document.getElementById('md-sampling-frame-stride'),
    samplingCharge: document.getElementById('md-sampling-charge'),
    samplingMultiplicity: document.getElementById('md-sampling-multiplicity'),
    samplingBeadFields: document.getElementById('md-sampling-bead-fields'),
    samplingBeadStart: document.getElementById('md-sampling-bead-start'),
    samplingBeadEnd: document.getElementById('md-sampling-bead-end'),
    samplingBeadStride: document.getElementById('md-sampling-bead-stride'),
    samplingSummary: document.getElementById('md-sampling-summary'),
    exportGeometryBundleBtn: document.getElementById('md-export-geometry-bundle-btn'),
    exportGeometryBundleStatus: document.getElementById('md-export-geometry-bundle-status'),
    backendBrowserModal: document.getElementById('md-backend-browser-modal'),
    backendBrowserTitle: document.getElementById('md-backend-browser-title'),
    backendBrowserSubtitle: document.getElementById('md-backend-browser-subtitle'),
    backendBrowserRoot: document.getElementById('md-backend-browser-root'),
    backendBrowserPath: document.getElementById('md-backend-browser-path'),
    backendBrowserCloseBtn: document.getElementById('md-backend-browser-close-btn'),
    backendBrowserUpBtn: document.getElementById('md-backend-browser-up-btn'),
    backendBrowserStatus: document.getElementById('md-backend-browser-status'),
    backendBrowserList: document.getElementById('md-backend-browser-list'),
  };

  const bootstrap = shared.bootstrap && typeof shared.bootstrap === 'object' ? shared.bootstrap : {};
  const pages = bootstrap.pages && typeof bootstrap.pages === 'object' ? bootstrap.pages : {};
  const symbolToAtomicNumber = buildSymbolMap(shared.constants?.PERIODIC_SYMBOLS || []);
  const atomicNumberToSymbol = Array.isArray(shared.constants?.PERIODIC_SYMBOLS)
    ? shared.constants.PERIODIC_SYMBOLS
    : [];

  const localState = {
    panelMode: 'md',
    activeDatasetKind: 'md',
    mdData: null,
    mdSourceFile: null,
    mdSourceLabel: 'Local XYZ',
    mdSourceOrigin: 'local',
    pimdData: null,
    pimdSourceFile: null,
    pimdSourceLabel: '',
    pimdSourceOrigin: 'local',
    pimdDisplayMode: 'single',
    pimdSelectedBead: 0,
    pimdFsPath: '',
    appearanceUnsubscribe: null,
    samplingExportInFlight: false,
    backendBrowserMode: 'md',
    backendBrowserBusy: false,
    backendBrowserCurrentPath: '',
    backendBrowserParentPath: null,
  };

  if (dom.workflowLink && pages.workflow) {
    dom.workflowLink.href = String(pages.workflow);
  }
  if (dom.apiViewerLink && pages.molecule3d) {
    dom.apiViewerLink.href = String(pages.molecule3d);
  }

  function buildSymbolMap(symbols) {
    const map = new Map();
    symbols.forEach((symbol, index) => {
      const text = String(symbol || '').trim();
      if (!text || index <= 0) return;
      map.set(text.toUpperCase(), index);
    });
    return map;
  }

  function summarizeAtomNumbers(atomNumbers) {
    const counts = new Map();
    atomNumbers.forEach((value) => {
      const atomicNumber = Number.parseInt(String(value), 10);
      const symbol = atomicNumber > 0 && atomicNumber < atomicNumberToSymbol.length
        ? String(atomicNumberToSymbol[atomicNumber] || 'X')
        : 'X';
      counts.set(symbol, (counts.get(symbol) || 0) + 1);
    });
    return Array.from(counts.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([symbol, count]) => `${symbol} × ${count}`)
      .join(', ');
  }

  function setPanelMode(mode) {
    const normalized = mode === 'pimd' ? 'pimd' : 'md';
    localState.panelMode = normalized;
    if (dom.mdPanel) dom.mdPanel.hidden = normalized !== 'md';
    if (dom.pimdPanel) dom.pimdPanel.hidden = normalized !== 'pimd';
    if (dom.mdTab) {
      dom.mdTab.classList.toggle('is-active', normalized === 'md');
      dom.mdTab.setAttribute('aria-selected', normalized === 'md' ? 'true' : 'false');
    }
    if (dom.pimdTab) {
      dom.pimdTab.classList.toggle('is-active', normalized === 'pimd');
      dom.pimdTab.setAttribute('aria-selected', normalized === 'pimd' ? 'true' : 'false');
    }
  }

  function setSourceInfo(label) {
    if (!dom.sourceInfo) return;
    const text = String(label || 'Local file');
    dom.sourceInfo.textContent = `Source: ${text}`;
    dom.sourceInfo.title = text;
  }

  function updateViewerTitle() {
    if (!dom.viewerControlsTitle) return;
    dom.viewerControlsTitle.textContent = localState.activeDatasetKind === 'pimd'
      ? 'PIMD Viewer Controls'
      : 'MD Viewer Controls';
  }

  function setMdUploadFileName(message) {
    if (dom.uploadFileName) dom.uploadFileName.textContent = String(message || 'No file loaded.');
  }

  function setPimdUploadFileName(message) {
    if (dom.pimdUploadFileName) dom.pimdUploadFileName.textContent = String(message || 'No file loaded.');
  }

  function getApiBase() {
    const apiBase = typeof shared.apiBase === 'string' ? shared.apiBase.trim() : '';
    return (apiBase ? apiBase : '/api').replace(/\/$/, '') || '/api';
  }

  function getBackendInputEl(mode) {
    return mode === 'pimd' ? dom.pimdBackendPathInput : dom.mdBackendPathInput;
  }

  function normalizeBrowserRelativePath(rawValue) {
    return String(rawValue || '').trim().replace(/\\/g, '/');
  }

  function browserModeTitle(mode) {
    return mode === 'pimd' ? 'Choose Server PIMD File' : 'Choose Server XYZ File';
  }

  function browserModeSubtitle(mode) {
    return mode === 'pimd'
      ? 'Browse the server root and click a .h5 or .hdf5 file to import it.'
      : 'Browse the server root and click a .xyz file to import it.';
  }

  function isBackendPathBrowsable(rawValue) {
    const text = normalizeBrowserRelativePath(rawValue);
    return !!text && !pathIsAbsoluteLike(text);
  }

  function pathIsAbsoluteLike(pathText) {
    return pathText.startsWith('/') || /^[A-Za-z]:\//.test(pathText);
  }

  function backendBrowserFileSupported(entryName, mode) {
    const text = String(entryName || '').trim();
    return mode === 'pimd' ? /\.(?:h5|hdf5)$/i.test(text) : /\.xyz$/i.test(text);
  }

  function initialBackendBrowserPath(mode) {
    const inputValue = normalizeBrowserRelativePath(getBackendInputEl(mode)?.value);
    if (!isBackendPathBrowsable(inputValue)) {
      return '';
    }
    if (backendBrowserFileSupported(inputValue, mode)) {
      const parts = inputValue.split('/').filter(Boolean);
      parts.pop();
      return parts.join('/');
    }
    return inputValue;
  }

  async function listBrowseRootFiles(path = '') {
    const normalizedPath = normalizeBrowserRelativePath(path);
    const url = new URL(`${getApiBase()}/files`, window.location.origin);
    if (normalizedPath) {
      url.searchParams.set('path', normalizedPath);
    }

    const response = await fetch(url.toString(), { method: 'GET' });
    if (!response.ok) {
      throw new Error(await readErrorResponseDetail(response));
    }

    const payload = await response.json();
    return {
      rootLabel: String(payload?.root_label || ''),
      currentPath: String(payload?.current_path || ''),
      parentPath: payload?.parent_path == null ? null : String(payload.parent_path || ''),
      entries: Array.isArray(payload?.entries)
        ? payload.entries.map((entry) => ({
            name: String(entry?.name || ''),
            relativePath: String(entry?.relative_path || ''),
            kind: entry?.kind === 'directory' ? 'directory' : 'file',
          }))
        : [],
    };
  }

  const { triggerBlobDownload } = window.DashboardPlotUtils;

  function getDownloadFilename(response, fallback) {
    const header = String(response?.headers?.get('Content-Disposition') || '');
    const utf8Match = header.match(/filename\*=UTF-8''([^;]+)/i);
    if (utf8Match && utf8Match[1]) {
      try {
        return decodeURIComponent(utf8Match[1]);
      } catch (_) {
        return utf8Match[1];
      }
    }
    const match = header.match(/filename=\"([^\"]+)\"/i);
    if (match && match[1]) {
      return match[1];
    }
    return String(fallback || 'trajectory_geometry_bundle.tar.gz');
  }

  function sanitizeFilenamePart(rawValue, fallback = 'trajectory') {
    const text = String(rawValue || '').trim();
    const sanitized = text.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._-]+|[._-]+$/g, '');
    return sanitized || String(fallback || 'trajectory');
  }

  function defaultSamplingDownloadName() {
    const file = localState.activeDatasetKind === 'pimd' ? localState.pimdSourceFile : localState.mdSourceFile;
    const sourceBase = sanitizeFilenamePart(String(file?.name || 'trajectory').replace(/\.[^.]+$/, ''), 'trajectory');
    return `trajectory_geometry_${sourceBase}.tar.gz`;
  }

  function setSamplingStatus(message, isError = false) {
    if (!dom.exportGeometryBundleStatus) return;
    dom.exportGeometryBundleStatus.textContent = String(message || '');
    dom.exportGeometryBundleStatus.classList.toggle('error', !!isError);
  }

  function setSamplingSummary(message, isError = false) {
    if (!dom.samplingSummary) return;
    dom.samplingSummary.textContent = String(message || '');
    dom.samplingSummary.classList.toggle('error', !!isError);
  }

  function getActiveSamplingFrameCount() {
    if (localState.activeDatasetKind === 'pimd') {
      return Number.parseInt(String(localState.pimdData?.nFrames), 10) || 0;
    }
    return Number.parseInt(String(localState.mdData?.n_frames), 10) || 0;
  }

  function getActiveSamplingBeadCount() {
    if (localState.activeDatasetKind === 'pimd') {
      return Number.parseInt(String(localState.pimdData?.nBeads), 10) || 0;
    }
    return 1;
  }

  function getActiveSamplingSourceFile() {
    return localState.activeDatasetKind === 'pimd' ? localState.pimdSourceFile : localState.mdSourceFile;
  }

  function parseIntegerInput(inputEl, label, { min = null, defaultValue = null } = {}) {
    const raw = String(inputEl?.value ?? '').trim();
    if (!raw && defaultValue !== null) {
      return Number(defaultValue);
    }
    if (!raw) {
      throw new Error(`${label} is required.`);
    }
    const numeric = Number(raw);
    if (!Number.isFinite(numeric) || !Number.isInteger(numeric)) {
      throw new Error(`${label} must be an integer.`);
    }
    if (min !== null && numeric < min) {
      throw new Error(`${label} must be >= ${min}.`);
    }
    return numeric;
  }

  function expandIndexSelection(start, end, stride) {
    const values = [];
    for (let index = start; index <= end; index += stride) {
      values.push(index);
    }
    return values;
  }

  function parseSamplingSelection() {
    const sourceFile = getActiveSamplingSourceFile();
    if (!(sourceFile instanceof File)) {
      throw new Error('Load a trajectory before exporting a sampling bundle.');
    }

    const frameCount = getActiveSamplingFrameCount();
    if (frameCount <= 0) {
      throw new Error('The active trajectory has no frames to sample.');
    }

    const startFrame = parseIntegerInput(dom.samplingStartFrame, 'Start frame', { min: 0, defaultValue: 0 });
    const endFrame = parseIntegerInput(dom.samplingEndFrame, 'End frame', {
      min: 0,
      defaultValue: frameCount - 1,
    });
    const frameStride = parseIntegerInput(dom.samplingFrameStride, 'Frame stride', { min: 1, defaultValue: 1 });
    const charge = parseIntegerInput(dom.samplingCharge, 'Charge', { defaultValue: 0 });
    const multiplicity = parseIntegerInput(dom.samplingMultiplicity, 'Multiplicity', { min: 1, defaultValue: 1 });

    if (startFrame >= frameCount) {
      throw new Error(`Start frame ${startFrame} is out of range. Valid frames: 0-${frameCount - 1}.`);
    }
    if (endFrame < startFrame || endFrame >= frameCount) {
      throw new Error(`End frame ${endFrame} is out of range. Valid frames: ${startFrame}-${frameCount - 1}.`);
    }

    const frameIndices = expandIndexSelection(startFrame, endFrame, frameStride);
    if (!frameIndices.length) {
      throw new Error('Frame selection produced zero samples.');
    }

    const isPimd = localState.activeDatasetKind === 'pimd';
    const beadCount = getActiveSamplingBeadCount();
    let beadStart = null;
    let beadEnd = null;
    let beadStride = 1;
    let beadIndices = [0];

    if (isPimd) {
      if (beadCount <= 0) {
        throw new Error('The active PIMD trajectory has no beads to sample.');
      }
      beadStart = parseIntegerInput(dom.samplingBeadStart, 'Bead start', { min: 0, defaultValue: 0 });
      beadEnd = parseIntegerInput(dom.samplingBeadEnd, 'Bead end', { min: 0, defaultValue: beadCount - 1 });
      beadStride = parseIntegerInput(dom.samplingBeadStride, 'Bead stride', { min: 1, defaultValue: 1 });

      if (beadStart >= beadCount) {
        throw new Error(`Bead start ${beadStart} is out of range. Valid beads: 0-${beadCount - 1}.`);
      }
      if (beadEnd < beadStart || beadEnd >= beadCount) {
        throw new Error(`Bead end ${beadEnd} is out of range. Valid beads: ${beadStart}-${beadCount - 1}.`);
      }

      beadIndices = expandIndexSelection(beadStart, beadEnd, beadStride);
      if (!beadIndices.length) {
        throw new Error('Bead selection produced zero samples.');
      }
    }

    return {
      sourceFile,
      sourceKind: isPimd ? 'pimd_h5' : 'md_xyz',
      startFrame,
      endFrame,
      frameStride,
      frameIndices,
      charge,
      multiplicity,
      beadStart,
      beadEnd,
      beadStride,
      beadIndices,
      sampleCount: frameIndices.length * beadIndices.length,
    };
  }

  function setMdMetadata(fileName, record, sourceOrigin = 'local') {
    const frameCount = Array.isArray(record?.coords) ? record.coords.length : 0;
    const atomCount = Number.parseInt(String(record?.n_atoms), 10) || 0;
    if (dom.metaFile) dom.metaFile.textContent = fileName || 'none';
    if (dom.metaFileSubvalue) {
      dom.metaFileSubvalue.textContent = frameCount > 0
        ? `Parsed ${frameCount} frame${frameCount === 1 ? '' : 's'} from a ${sourceOrigin === 'backend' ? 'backend path' : 'local'} XYZ trajectory.`
        : 'Waiting for upload or backend import.';
    }
    if (dom.metaFrames) dom.metaFrames.textContent = String(frameCount);
    if (dom.metaAtoms) dom.metaAtoms.textContent = String(atomCount);
    if (dom.metaElements) {
      dom.metaElements.textContent = atomCount > 0
        ? summarizeAtomNumbers(Array.isArray(record?.atom_numbers) ? record.atom_numbers : [])
        : 'Element summary appears after parsing.';
    }
  }

  function setPimdMetadata(data) {
    const hasData = !!data;
    if (dom.pimdMetaFile) dom.pimdMetaFile.textContent = hasData ? (data.sourceLabel || data.fileName) : 'none';
    if (dom.pimdMetaFileSubvalue) {
      dom.pimdMetaFileSubvalue.textContent = hasData
        ? `Schema ${data.schemaName || 'observable_dashboard_pimd'} v${data.schemaVersion}, coordinates in ${data.coordUnit}, imported from ${data.sourceOrigin === 'backend' ? 'a backend path' : 'a local file'}.`
        : 'Waiting for a standardized PIMD H5 import.';
    }
    if (dom.pimdMetaFrames) dom.pimdMetaFrames.textContent = hasData ? String(data.nFrames) : '0';
    if (dom.pimdMetaBeads) {
      dom.pimdMetaBeads.textContent = hasData
        ? `${data.nBeads} beads, ${data.stepKindLabel}.`
        : 'Bead count appears after parsing.';
    }
    if (dom.pimdMetaAtoms) dom.pimdMetaAtoms.textContent = hasData ? String(data.nAtoms) : '0';
    if (dom.pimdMetaElements) {
      dom.pimdMetaElements.textContent = hasData
        ? summarizeAtomNumbers(data.atomNumbers)
        : 'Element summary appears after parsing.';
    }
    if (dom.pimdMetaEnergy) {
      if (!hasData || !data.potentialEnergy.length) {
        dom.pimdMetaEnergy.textContent = 'n/a';
      } else {
        const meanPotential = data.potentialEnergy.reduce((sum, value) => sum + value, 0) / data.potentialEnergy.length;
        dom.pimdMetaEnergy.textContent = `${meanPotential.toFixed(6)} Eh`;
      }
    }
    if (dom.pimdMetaTemperature) {
      dom.pimdMetaTemperature.textContent = hasData
        ? `T = ${data.temperatureK.toFixed(2)} K, step range ${data.step[0]}-${data.step[data.step.length - 1]}.`
        : 'Temperature appears after parsing.';
    }
  }

  function splitLines(text) {
    return String(text || '').replace(/\r\n?/g, '\n').split('\n');
  }

  function parseAtomicToken(rawToken, lineNumber) {
    const token = String(rawToken || '').trim();
    if (!token) {
      throw new Error(`Missing atom label on line ${lineNumber}.`);
    }
    if (/^\d+$/.test(token)) {
      const atomicNumber = Number.parseInt(token, 10);
      if (atomicNumber > 0) return atomicNumber;
    }
    const normalized = token[0].toUpperCase() + token.slice(1).toLowerCase();
    const atomicNumber = symbolToAtomicNumber.get(normalized.toUpperCase());
    if (atomicNumber) return atomicNumber;
    throw new Error(`Unsupported atom label '${token}' on line ${lineNumber}.`);
  }

  function parseCoordinate(rawValue, lineNumber, fieldLabel) {
    const numeric = Number(rawValue);
    if (Number.isFinite(numeric)) return numeric;
    throw new Error(`Invalid ${fieldLabel} coordinate on line ${lineNumber}.`);
  }

  function parseFrameTime(comment, frameIndex) {
    const text = String(comment || '');
    const match = text.match(/(?:^|[\s,;])(?:time|t)\s*=\s*([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)/i);
    if (match) {
      const numeric = Number(match[1]);
      if (Number.isFinite(numeric)) return numeric;
    }
    return frameIndex;
  }

  function nextNonEmptyLineIndex(lines, startIndex) {
    let index = startIndex;
    while (index < lines.length && !String(lines[index] || '').trim()) {
      index += 1;
    }
    return index;
  }

  function parseMultiFrameXyz(text, fileName) {
    const lines = splitLines(text);
    const coords = [];
    const times = [];
    let atomNumbers = null;
    let index = 0;

    while (true) {
      index = nextNonEmptyLineIndex(lines, index);
      if (index >= lines.length) break;

      const atomCountLine = String(lines[index] || '').trim();
      const atomCount = Number.parseInt(atomCountLine, 10);
      if (!Number.isFinite(atomCount) || atomCount <= 0) {
        throw new Error(`Expected atom count at line ${index + 1}, received '${atomCountLine || ''}'.`);
      }

      const commentIndex = index + 1;
      if (commentIndex >= lines.length) {
        throw new Error(`Missing comment line after atom count at line ${index + 1}.`);
      }
      const comment = String(lines[commentIndex] || '');
      const frame = [];
      const frameAtomNumbers = [];

      for (let atomIndex = 0; atomIndex < atomCount; atomIndex++) {
        const lineIndex = commentIndex + 1 + atomIndex;
        if (lineIndex >= lines.length) {
          throw new Error(`Unexpected end of file while reading frame ${coords.length + 1}.`);
        }
        const rawLine = String(lines[lineIndex] || '').trim();
        if (!rawLine) {
          throw new Error(`Unexpected blank atom row on line ${lineIndex + 1}.`);
        }
        const parts = rawLine.split(/\s+/);
        if (parts.length < 4) {
          throw new Error(`Atom row on line ${lineIndex + 1} must contain element and x y z coordinates.`);
        }
        frameAtomNumbers.push(parseAtomicToken(parts[0], lineIndex + 1));
        frame.push([
          parseCoordinate(parts[1], lineIndex + 1, 'x'),
          parseCoordinate(parts[2], lineIndex + 1, 'y'),
          parseCoordinate(parts[3], lineIndex + 1, 'z'),
        ]);
      }

      if (!atomNumbers) {
        atomNumbers = frameAtomNumbers;
      } else if (
        atomNumbers.length !== frameAtomNumbers.length ||
        atomNumbers.some((value, atomIndex) => value !== frameAtomNumbers[atomIndex])
      ) {
        throw new Error('All frames must keep the same atom ordering and element sequence.');
      }

      coords.push(frame);
      times.push(parseFrameTime(comment, coords.length - 1));
      index = commentIndex + 1 + atomCount;
    }

    if (!coords.length || !atomNumbers) {
      throw new Error(`No XYZ frames were parsed from ${fileName || 'the uploaded file'}.`);
    }

    return {
      traj_id: String(fileName || 'local_xyz'),
      time: times,
      coords,
      n_atoms: atomNumbers.length,
      atom_numbers: atomNumbers,
      n_frames: coords.length,
      nac_available: false,
      nac_state_count: 0,
      nac_component_count: 0,
      de_available: false,
      de_state_count: 0,
      de_component_count: 0,
      de_global_norm_scope: '',
      de_global_norm_p5: null,
      de_global_norm_p90: null,
      de_global_norm_p95: null,
      de_global_norm_count: 0,
      de_nac_available: false,
      de_nac_state_count: 0,
      de_nac_component_count: 0,
    };
  }

  function ensureH5WasmReady() {
    const lib = window.h5wasm;
    if (!lib || !lib.ready) {
      throw new Error('h5wasm failed to load. Please verify assets/vendor/h5wasm.js.');
    }
    return lib.ready;
  }

  function ensurePimdFilesystemDir(FS) {
    try {
      FS.mkdir('/observable_dashboard');
    } catch (_) {
      // directory may already exist
    }
  }

  function deleteFsPath(FS, path) {
    if (!FS || !path) return;
    try {
      FS.unlink(path);
    } catch (_) {
      // best effort cleanup
    }
  }

  function attrValue(attrs, key) {
    const attr = attrs && typeof attrs === 'object' ? attrs[key] : null;
    if (!attr || typeof attr !== 'object' || !('value' in attr)) return null;
    return attr.value;
  }

  function scalarString(value, fallback = '') {
    if (typeof value === 'string') return value;
    if (value instanceof Uint8Array) {
      try {
        return new TextDecoder().decode(value);
      } catch (_) {
        return fallback;
      }
    }
    return value == null ? fallback : String(value);
  }

  function scalarNumber(value, fallback = Number.NaN) {
    if (typeof value === 'bigint') return Number(value);
    if (Array.isArray(value) && value.length) return scalarNumber(value[0], fallback);
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : fallback;
  }

  function typedToNumberArray(value) {
    if (ArrayBuffer.isView(value)) {
      return Array.from(value, (item) => (typeof item === 'bigint' ? Number(item) : Number(item)));
    }
    if (Array.isArray(value)) {
      return value.map((item) => scalarNumber(item, NaN));
    }
    return [];
  }

  function readRequiredDataset(file, name) {
    const dataset = file.get(name) || file.get(`/${name}`);
    if (!dataset) {
      throw new Error(`Missing required dataset '${name}'.`);
    }
    return dataset;
  }

  function buildPimdFrameXyz(atomNumbers, frameCoords, commentText) {
    const lines = [String(atomNumbers.length), String(commentText || '')];
    for (let atomIndex = 0; atomIndex < atomNumbers.length; atomIndex++) {
      const atomicNumber = Number.parseInt(String(atomNumbers[atomIndex]), 10);
      const symbol = atomicNumber > 0 && atomicNumber < atomicNumberToSymbol.length
        ? String(atomicNumberToSymbol[atomicNumber] || 'C')
        : 'C';
      const xyz = Array.isArray(frameCoords?.[atomIndex]) ? frameCoords[atomIndex] : [0, 0, 0];
      lines.push(
        `${symbol} ${Number(xyz[0] || 0).toFixed(8)} ${Number(xyz[1] || 0).toFixed(8)} ${Number(xyz[2] || 0).toFixed(8)}`
      );
    }
    return lines.join('\n');
  }

  async function parsePimdFile(file) {
    const lib = window.h5wasm;
    const { FS } = await ensureH5WasmReady();
    ensurePimdFilesystemDir(FS);

    if (localState.pimdFsPath) {
      deleteFsPath(FS, localState.pimdFsPath);
      localState.pimdFsPath = '';
    }

    const arrayBuffer = await file.arrayBuffer();
    const safeName = (file.name || 'pimd.h5').replace(/[^A-Za-z0-9._-]+/g, '_');
    const virtualPath = `/observable_dashboard/${Date.now()}_${safeName}`;
    FS.writeFile(virtualPath, new Uint8Array(arrayBuffer));
    localState.pimdFsPath = virtualPath;

    let handle = null;
    try {
      handle = new lib.File(virtualPath, 'r');
      const attrs = handle.attrs || {};

      const coordsDataset = readRequiredDataset(handle, 'coords');
      const stepDataset = readRequiredDataset(handle, 'step');
      const atomNumbersDataset = readRequiredDataset(handle, 'atom_numbers');
      const potentialEnergyDataset = readRequiredDataset(handle, 'potential_energy');
      const potentialEnergyBeadsDataset = readRequiredDataset(handle, 'potential_energy_beads');

      const coordsShape = Array.isArray(coordsDataset.shape) ? coordsDataset.shape.map((value) => Number(value)) : [];
      if (coordsShape.length !== 4) {
        throw new Error(`Dataset 'coords' must have shape [n_frames, n_beads, n_atoms, 3], got ${JSON.stringify(coordsShape)}.`);
      }
      const [nFrames, nBeads, nAtoms, xyzSize] = coordsShape;
      if (!(nFrames > 0 && nBeads > 0 && nAtoms > 0 && xyzSize === 3)) {
        throw new Error(`Dataset 'coords' has invalid shape ${JSON.stringify(coordsShape)}.`);
      }

      const coordsFlat = coordsDataset.value;
      const atomNumbers = typedToNumberArray(atomNumbersDataset.value).map((value) => Number.parseInt(String(value), 10));
      const step = typedToNumberArray(stepDataset.value);
      const potentialEnergy = typedToNumberArray(potentialEnergyDataset.value);
      const potentialEnergyBeads = typedToNumberArray(potentialEnergyBeadsDataset.value);

      if (!ArrayBuffer.isView(coordsFlat) || coordsFlat.length !== nFrames * nBeads * nAtoms * 3) {
        throw new Error(`Dataset 'coords' has unexpected flattened size ${coordsFlat?.length || 0}.`);
      }
      if (atomNumbers.length !== nAtoms) {
        throw new Error(`Dataset 'atom_numbers' length ${atomNumbers.length} does not match n_atoms=${nAtoms}.`);
      }
      if (step.length !== nFrames) {
        throw new Error(`Dataset 'step' length ${step.length} does not match n_frames=${nFrames}.`);
      }
      if (potentialEnergy.length !== nFrames) {
        throw new Error(`Dataset 'potential_energy' length ${potentialEnergy.length} does not match n_frames=${nFrames}.`);
      }
      if (potentialEnergyBeads.length !== nFrames * nBeads) {
        throw new Error(
          `Dataset 'potential_energy_beads' length ${potentialEnergyBeads.length} does not match n_frames*n_beads=${nFrames * nBeads}.`
        );
      }

      const schemaName = scalarString(attrValue(attrs, 'schema_name'), '');
      if (schemaName && schemaName !== 'observable_dashboard_pimd') {
        throw new Error(`Unsupported PIMD schema '${schemaName}'.`);
      }

      const coordUnit = scalarString(attrValue(attrs, 'coord_unit'), 'bohr').trim().toLowerCase() || 'bohr';
      if (coordUnit !== 'bohr' && coordUnit !== 'angstrom') {
        throw new Error(`Unsupported coordinate unit '${coordUnit}'.`);
      }

      const energyUnit = scalarString(attrValue(attrs, 'energy_unit'), 'hartree').trim().toLowerCase() || 'hartree';
      const stepKind = scalarString(attrValue(attrs, 'step_kind'), 'step').trim() || 'step';
      const stepKindLabel = stepKind.replaceAll('_', ' ');
      const temperatureK = scalarNumber(attrValue(attrs, 'temperature_K'), Number.NaN);
      const schemaVersion = scalarNumber(attrValue(attrs, 'schema_version'), 1);

      return {
        fileName: String(file.name || 'pimd.h5'),
        fileBaseName: String(file.name || 'pimd').replace(/\.[^.]+$/, '') || 'pimd',
        schemaName: schemaName || 'observable_dashboard_pimd',
        schemaVersion,
        nFrames,
        nBeads,
        nAtoms,
        atomNumbers,
        step,
        stepKind,
        stepKindLabel,
        temperatureK: Number.isFinite(temperatureK) ? temperatureK : Number.NaN,
        coordUnit,
        energyUnit,
        coordsFlat,
        potentialEnergy,
        potentialEnergyBeads,
        coordsScale: coordUnit === 'bohr' ? Number(shared.constants?.BOHR_TO_ANGSTROM || 0.529177210903) : 1,
        beadTrajectoryCache: new Map(),
      };
    } finally {
      if (handle && typeof handle.close === 'function') {
        try {
          handle.close();
        } catch (_) {
          // best effort close
        }
      }
      deleteFsPath(FS, virtualPath);
      if (localState.pimdFsPath === virtualPath) {
        localState.pimdFsPath = '';
      }
    }
  }

  function buildPimdBeadTrajectory(data, beadIndex) {
    if (!data || !Number.isInteger(beadIndex) || beadIndex < 0 || beadIndex >= data.nBeads) {
      return [];
    }
    const cached = data.beadTrajectoryCache.get(beadIndex);
    if (cached) return cached;

    const frames = new Array(data.nFrames);
    const frameStride = data.nBeads * data.nAtoms * 3;
    const beadStride = data.nAtoms * 3;
    for (let frameIndex = 0; frameIndex < data.nFrames; frameIndex++) {
      const frame = new Array(data.nAtoms);
      const beadOffset = frameIndex * frameStride + beadIndex * beadStride;
      for (let atomIndex = 0; atomIndex < data.nAtoms; atomIndex++) {
        const coordOffset = beadOffset + atomIndex * 3;
        frame[atomIndex] = [
          Number(data.coordsFlat[coordOffset]) * data.coordsScale,
          Number(data.coordsFlat[coordOffset + 1]) * data.coordsScale,
          Number(data.coordsFlat[coordOffset + 2]) * data.coordsScale,
        ];
      }
      frames[frameIndex] = frame;
    }

    data.beadTrajectoryCache.set(beadIndex, frames);
    return frames;
  }

  function buildPimdRecord(data, beadIndex) {
    const coords = buildPimdBeadTrajectory(data, beadIndex);
    return {
      traj_id: `${data.fileBaseName}_bead_${beadIndex}`,
      time: data.step.slice(),
      coords,
      n_atoms: data.nAtoms,
      atom_numbers: data.atomNumbers.slice(),
      n_frames: data.nFrames,
      nac_available: false,
      nac_state_count: 0,
      nac_component_count: 0,
      de_available: false,
      de_state_count: 0,
      de_component_count: 0,
      de_global_norm_scope: '',
      de_global_norm_p5: null,
      de_global_norm_p90: null,
      de_global_norm_p95: null,
      de_global_norm_count: 0,
      de_nac_available: false,
      de_nac_state_count: 0,
      de_nac_component_count: 0,
    };
  }

  function buildPimdAuxiliarySpecs(data, focusBead) {
    const specs = [];
    for (let beadIndex = 0; beadIndex < data.nBeads; beadIndex++) {
      if (beadIndex === focusBead) continue;
      const coordsFrames = buildPimdBeadTrajectory(data, beadIndex);
      specs.push({
        coordsFrames,
        firstFrameXyz: buildPimdFrameXyz(
          data.atomNumbers,
          coordsFrames[0],
          `bead=${beadIndex} step=${data.step[0]}`
        ),
      });
    }
    return specs;
  }

  function getPlotThemePatch() {
    const appearance = window.ObservableAppearance;
    return appearance && typeof appearance.getPlotlyLayoutPatch === 'function'
      ? appearance.getPlotlyLayoutPatch()
      : {};
  }

  function getPlotColors() {
    const appearance = window.ObservableAppearance;
    return appearance && typeof appearance.getPlotColors === 'function'
      ? appearance.getPlotColors()
      : { cursorLineColor: '#d62728' };
  }

  function mergePlotLayout(baseLayout, patch) {
    return {
      ...baseLayout,
      ...patch,
      xaxis: { ...(baseLayout.xaxis || {}), ...(patch.xaxis || {}) },
      yaxis: { ...(baseLayout.yaxis || {}), ...(patch.yaxis || {}) },
      legend: { ...(baseLayout.legend || {}), ...(patch.legend || {}) },
      hoverlabel: { ...(baseLayout.hoverlabel || {}), ...(patch.hoverlabel || {}) },
    };
  }

  function clearBondPlot(message) {
    if (!sharedDom.bondPlotEl) return;
    if (typeof Plotly !== 'undefined') {
      try {
        Plotly.purge(sharedDom.bondPlotEl);
      } catch (_) {
        // ignore purge failures
      }
    }
    sharedDom.bondPlotEl.innerHTML = `<div class="bond-plot-empty">${message}</div>`;
  }

  function bindPimdPlotClick() {
    if (!sharedDom.bondPlotEl || sharedDom.bondPlotEl.dataset.pimdPlotClickBound === '1') return;
    if (typeof sharedDom.bondPlotEl.on !== 'function') return;
    sharedDom.bondPlotEl.on('plotly_click', (event) => {
      if (localState.activeDatasetKind !== 'pimd') return;
      const pointIndex = Number.parseInt(String(event?.points?.[0]?.pointIndex), 10);
      if (!Number.isFinite(pointIndex)) return;
      viewer.stopPlayback();
      void viewer.renderFrame(pointIndex);
    });
    sharedDom.bondPlotEl.dataset.pimdPlotClickBound = '1';
  }

  function updatePimdPotentialCursor(frameIndex) {
    if (localState.activeDatasetKind !== 'pimd' || !localState.pimdData || !sharedDom.bondPlotEl) return;
    if (typeof Plotly === 'undefined') return;
    const step = Number(localState.pimdData.step[frameIndex]);
    if (!Number.isFinite(step)) return;
    Plotly.relayout(sharedDom.bondPlotEl, {
      'shapes[0].x0': step,
      'shapes[0].x1': step,
    });
  }

  function renderPimdPotentialPlot() {
    if (localState.activeDatasetKind !== 'pimd' || !localState.pimdData) return;
    if (!sharedDom.bondPlotEl) return;

    sharedDom.bondPlotEl.dataset.plotOwner = 'pimd';
    if (typeof Plotly === 'undefined') {
      clearBondPlot('Plot unavailable (Plotly failed to load).');
      return;
    }

    const data = localState.pimdData;
    const currentFrame = Math.max(0, Math.min(shared.state.currentFrame || 0, data.nFrames - 1));
    const cursorStep = Number(data.step[currentFrame]);
    const plotColors = getPlotColors();
    const baseLayout = {
      margin: { l: 68, r: 20, t: 34, b: 48 },
      xaxis: { title: 'Step' },
      yaxis: { title: `Potential Energy (${data.energyUnit})` },
      showlegend: false,
      shapes: Number.isFinite(cursorStep) ? [{
        type: 'line',
        x0: cursorStep,
        x1: cursorStep,
        yref: 'paper',
        y0: 0,
        y1: 1,
        line: { color: plotColors.cursorLineColor, dash: 'dash', width: 1.6 },
      }] : [],
    };
    const layout = mergePlotLayout(baseLayout, getPlotThemePatch());
    const trace = {
      x: data.step,
      y: data.potentialEnergy,
      type: 'scatter',
      mode: 'lines',
      line: { color: '#1f77b4', width: 2 },
      hovertemplate: `step=%{x}<br>Ep=%{y:.6f} ${data.energyUnit}<extra></extra>`,
      name: 'Potential Energy',
    };

    Plotly.react(sharedDom.bondPlotEl, [trace], layout, {
      responsive: true,
      displaylogo: false,
      toImageButtonOptions: {
        format: 'png',
        scale: Number(shared.constants?.PLOT_EXPORT_SCALE || (300 / 96)),
      },
    });
    bindPimdPlotClick();
  }

  function syncSamplingExportUi() {
    const isPimd = localState.activeDatasetKind === 'pimd';
    const sourceFile = getActiveSamplingSourceFile();
    const hasSource = sourceFile instanceof File;
    const frameCount = getActiveSamplingFrameCount();
    const beadCount = getActiveSamplingBeadCount();
    const controlsDisabled = !hasSource || frameCount <= 0 || localState.samplingExportInFlight;

    if (dom.legacyExportControls) {
      dom.legacyExportControls.hidden = isPimd;
    }
    if (dom.samplingBeadFields) {
      dom.samplingBeadFields.hidden = !isPimd;
    }

    if (dom.samplingStartFrame) {
      dom.samplingStartFrame.max = String(Math.max(frameCount - 1, 0));
      dom.samplingStartFrame.disabled = controlsDisabled;
    }
    if (dom.samplingEndFrame) {
      dom.samplingEndFrame.max = String(Math.max(frameCount - 1, 0));
      dom.samplingEndFrame.disabled = controlsDisabled;
    }
    if (dom.samplingFrameStride) dom.samplingFrameStride.disabled = controlsDisabled;
    if (dom.samplingCharge) dom.samplingCharge.disabled = controlsDisabled;
    if (dom.samplingMultiplicity) dom.samplingMultiplicity.disabled = controlsDisabled;

    if (dom.samplingBeadStart) {
      dom.samplingBeadStart.max = String(Math.max(beadCount - 1, 0));
      dom.samplingBeadStart.disabled = controlsDisabled || !isPimd;
    }
    if (dom.samplingBeadEnd) {
      dom.samplingBeadEnd.max = String(Math.max(beadCount - 1, 0));
      dom.samplingBeadEnd.disabled = controlsDisabled || !isPimd;
    }
    if (dom.samplingBeadStride) {
      dom.samplingBeadStride.disabled = controlsDisabled || !isPimd;
    }

    if (!hasSource || frameCount <= 0) {
      if (dom.exportGeometryBundleBtn) dom.exportGeometryBundleBtn.disabled = true;
      setSamplingSummary('Load a trajectory to prepare sampling export.');
      return;
    }

    try {
      const selection = parseSamplingSelection();
      const frameSummary = `frames ${selection.startFrame}-${selection.endFrame} every ${selection.frameStride}`;
      if (isPimd) {
        const beadSummary = `beads ${selection.beadStart}-${selection.beadEnd} every ${selection.beadStride}`;
        setSamplingSummary(
          `Sampling ${selection.sampleCount} geometries from ${sourceFile.name}: ${selection.frameIndices.length} frame(s) × ${selection.beadIndices.length} bead(s), ${frameSummary}, ${beadSummary}.`
        );
      } else {
        setSamplingSummary(
          `Sampling ${selection.sampleCount} geometries from ${sourceFile.name}: ${selection.frameIndices.length} frame(s), ${frameSummary}.`
        );
      }
      if (dom.exportGeometryBundleBtn) {
        dom.exportGeometryBundleBtn.disabled = localState.samplingExportInFlight || selection.sampleCount <= 0;
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setSamplingSummary(detail, true);
      if (dom.exportGeometryBundleBtn) dom.exportGeometryBundleBtn.disabled = true;
    }
  }

  function resetSamplingControlsForActiveDataset() {
    const frameCount = getActiveSamplingFrameCount();
    const beadCount = getActiveSamplingBeadCount();

    if (dom.samplingStartFrame) dom.samplingStartFrame.value = '0';
    if (dom.samplingEndFrame) dom.samplingEndFrame.value = String(Math.max(frameCount - 1, 0));
    if (dom.samplingFrameStride) dom.samplingFrameStride.value = '1';
    if (dom.samplingCharge) dom.samplingCharge.value = '0';
    if (dom.samplingMultiplicity) dom.samplingMultiplicity.value = '1';
    if (dom.samplingBeadStart) dom.samplingBeadStart.value = '0';
    if (dom.samplingBeadEnd) dom.samplingBeadEnd.value = String(Math.max(beadCount - 1, 0));
    if (dom.samplingBeadStride) dom.samplingBeadStride.value = '1';

    setSamplingStatus('');
    syncSamplingExportUi();
  }

  async function readErrorResponseDetail(response) {
    try {
      const payload = await response.json();
      if (typeof payload?.detail === 'string' && payload.detail.trim()) {
        return payload.detail;
      }
      if (payload?.detail != null) {
        return JSON.stringify(payload.detail);
      }
    } catch (_) {
      // ignore JSON parsing errors and fall back to text
    }

    try {
      const text = await response.text();
      if (text.trim()) return text.trim();
    } catch (_) {
      // ignore body read failures
    }
    return `Request failed with status ${response.status}.`;
  }

  function normalizeBackendPath(rawValue) {
    return String(rawValue || '').trim();
  }

  function inferFileNameFromPath(rawPath, fallback) {
    const normalizedPath = normalizeBackendPath(rawPath).replace(/[?#].*$/, '');
    const parts = normalizedPath.split(/[\\/]+/).filter(Boolean);
    const candidate = parts.length ? parts[parts.length - 1] : '';
    return candidate || String(fallback || 'source.dat');
  }

  async function fetchSourceFileFromBackend(rawPath, sourceKind) {
    const normalizedPath = normalizeBackendPath(rawPath);
    if (!normalizedPath) {
      throw new Error('Path is required.');
    }

    const isPimd = sourceKind === 'pimd';
    const endpoint = isPimd ? '/md/load-pimd-path' : '/md/load-xyz-path';
    const fallbackFileName = inferFileNameFromPath(normalizedPath, isPimd ? 'trajectory.h5' : 'trajectory.xyz');
    const response = await fetch(`${getApiBase()}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: normalizedPath }),
    });
    if (!response.ok) {
      throw new Error(await readErrorResponseDetail(response));
    }

    const blob = await response.blob();
    return {
      file: new File([blob], fallbackFileName, {
        type: isPimd ? 'application/octet-stream' : 'text/plain',
      }),
      sourceLabel: normalizedPath,
    };
  }

  function setBackendBrowserStatus(message, isError = false) {
    if (!dom.backendBrowserStatus) return;
    dom.backendBrowserStatus.textContent = String(message || '');
    dom.backendBrowserStatus.classList.toggle('error', !!isError);
  }

  function syncBackendBrowserUi() {
    const busy = !!localState.backendBrowserBusy;
    if (dom.backendBrowserUpBtn) {
      dom.backendBrowserUpBtn.disabled = busy || localState.backendBrowserParentPath == null;
    }
    if (dom.backendBrowserCloseBtn) {
      dom.backendBrowserCloseBtn.disabled = busy;
    }
  }

  async function handleBackendBrowserFileSelection(relativePath) {
    const mode = localState.backendBrowserMode === 'pimd' ? 'pimd' : 'md';
    const inputEl = getBackendInputEl(mode);
    if (inputEl) {
      inputEl.value = String(relativePath || '');
    }
    closeBackendBrowser({ force: true });
    if (mode === 'pimd') {
      await importPimdBackendPath();
      return;
    }
    await importXyzBackendPath();
  }

  function renderBackendBrowserEntries(entries) {
    if (!dom.backendBrowserList) return;
    dom.backendBrowserList.innerHTML = '';
    const mode = localState.backendBrowserMode === 'pimd' ? 'pimd' : 'md';
    const visibleEntries = Array.isArray(entries)
      ? entries.filter((entry) => {
          if (!entry || typeof entry !== 'object') return false;
          if (entry.kind === 'directory') return true;
          return backendBrowserFileSupported(entry.name, mode);
        })
      : [];

    if (!visibleEntries.length) {
      const empty = document.createElement('div');
      empty.className = 'modal-empty';
      empty.textContent = mode === 'pimd'
        ? 'No matching .h5 or .hdf5 files are available here.'
        : 'No matching .xyz files are available here.';
      dom.backendBrowserList.appendChild(empty);
      return;
    }

    for (const entry of visibleEntries) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'directory-browser-item';

      const main = document.createElement('div');
      main.className = 'directory-browser-item-main';
      const nameEl = document.createElement('div');
      nameEl.className = 'directory-browser-item-name';
      nameEl.textContent = entry.name || entry.relativePath || '(entry)';
      const metaEl = document.createElement('div');
      metaEl.className = 'directory-browser-item-meta';
      metaEl.textContent = entry.relativePath ? `/${entry.relativePath}` : '/';
      main.appendChild(nameEl);
      main.appendChild(metaEl);

      const actionEl = document.createElement('div');
      actionEl.className = 'directory-browser-item-meta';
      actionEl.textContent = entry.kind === 'directory' ? 'Open' : 'Import';

      button.appendChild(main);
      button.appendChild(actionEl);
      button.addEventListener('click', () => {
        if (localState.backendBrowserBusy) return;
        if (entry.kind === 'directory') {
          void loadBackendBrowserPath(entry.relativePath);
          return;
        }
        void handleBackendBrowserFileSelection(entry.relativePath);
      });
      dom.backendBrowserList.appendChild(button);
    }
  }

  async function loadBackendBrowserPath(path, { fallbackToRoot = false } = {}) {
    if (!dom.backendBrowserRoot || !dom.backendBrowserPath) return;
    localState.backendBrowserBusy = true;
    syncBackendBrowserUi();
    setBackendBrowserStatus('Loading files...', false);
    try {
      const payload = await listBrowseRootFiles(path);
      localState.backendBrowserCurrentPath = payload.currentPath || '';
      localState.backendBrowserParentPath = payload.parentPath == null ? null : payload.parentPath;
      dom.backendBrowserRoot.textContent = `Root: ${payload.rootLabel || ''}`;
      dom.backendBrowserPath.textContent = `Current path: ${payload.currentPath ? `/${payload.currentPath}` : '/'}`;
      renderBackendBrowserEntries(payload.entries);
      setBackendBrowserStatus('', false);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (fallbackToRoot && String(path || '').trim()) {
        localState.backendBrowserBusy = false;
        syncBackendBrowserUi();
        await loadBackendBrowserPath('', { fallbackToRoot: false });
        setBackendBrowserStatus(`Could not open ${path}. Showing the browse root instead.`, true);
        return;
      }
      renderBackendBrowserEntries([]);
      setBackendBrowserStatus(`Failed to load files: ${detail}`, true);
    } finally {
      localState.backendBrowserBusy = false;
      syncBackendBrowserUi();
    }
  }

  function openBackendBrowser(mode) {
    if (!dom.backendBrowserModal) return;
    localState.backendBrowserMode = mode === 'pimd' ? 'pimd' : 'md';
    if (dom.backendBrowserTitle) {
      dom.backendBrowserTitle.textContent = browserModeTitle(localState.backendBrowserMode);
    }
    if (dom.backendBrowserSubtitle) {
      dom.backendBrowserSubtitle.textContent = browserModeSubtitle(localState.backendBrowserMode);
    }
    dom.backendBrowserModal.hidden = false;
    void loadBackendBrowserPath(initialBackendBrowserPath(localState.backendBrowserMode), { fallbackToRoot: true });
  }

  function closeBackendBrowser({ force = false } = {}) {
    if (!dom.backendBrowserModal) return;
    if (localState.backendBrowserBusy && !force) return;
    dom.backendBrowserModal.hidden = true;
  }

  async function exportGeometryBundle() {
    if (localState.samplingExportInFlight) return;

    let selection = null;
    try {
      selection = parseSamplingSelection();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setSamplingStatus(detail, true);
      syncSamplingExportUi();
      return;
    }

    const params = new URLSearchParams({
      source_kind: selection.sourceKind,
      source_name: selection.sourceFile.name || 'trajectory',
      start_frame: String(selection.startFrame),
      end_frame: String(selection.endFrame),
      frame_stride: String(selection.frameStride),
      charge: String(selection.charge),
      multiplicity: String(selection.multiplicity),
    });
    if (selection.sourceKind === 'pimd_h5') {
      params.set('bead_start', String(selection.beadStart));
      params.set('bead_end', String(selection.beadEnd));
      params.set('bead_stride', String(selection.beadStride));
    }

    localState.samplingExportInFlight = true;
    setSamplingStatus(`Exporting ${selection.sampleCount} sampled geometry frame(s)...`);
    syncSamplingExportUi();

    try {
      const response = await fetch(`${getApiBase()}/md/export-geometry-bundle?${params.toString()}`, {
        method: 'POST',
        headers: {
          'Content-Type': selection.sourceFile.type || 'application/octet-stream',
        },
        body: selection.sourceFile,
      });
      if (!response.ok) {
        throw new Error(await readErrorResponseDetail(response));
      }

      const blob = await response.blob();
      const fileName = getDownloadFilename(response, defaultSamplingDownloadName());
      triggerBlobDownload(fileName, blob);
      setSamplingStatus(`Downloaded ${fileName}.`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setSamplingStatus(`Geometry bundle export failed: ${detail}`, true);
    } finally {
      localState.samplingExportInFlight = false;
      syncSamplingExportUi();
    }
  }

  function configureViewerUiForActiveDataset() {
    const isPimd = localState.activeDatasetKind === 'pimd';
    updateViewerTitle();

    if (sharedDom.bondListEl) {
      sharedDom.bondListEl.classList.toggle('is-visually-hidden', isPimd);
    }
    if (sharedDom.bondColorSettingsBtn) {
      sharedDom.bondColorSettingsBtn.classList.toggle('is-visually-hidden', isPimd);
    }
    if (sharedDom.bondColorSettingsPanelEl) {
      sharedDom.bondColorSettingsPanelEl.classList.toggle('is-visually-hidden', isPimd);
    }
    if (sharedDom.controlsTabMeasureBtn) {
      sharedDom.controlsTabMeasureBtn.classList.toggle('is-visually-hidden', isPimd);
    }
    if (sharedDom.controlsTabExportBtn) {
      sharedDom.controlsTabExportBtn.classList.remove('is-visually-hidden');
    }
    if (sharedDom.measureControlsGroup) {
      sharedDom.measureControlsGroup.classList.toggle('is-visually-hidden', isPimd);
    }
    if (sharedDom.gifRangeControlsGroup) {
      sharedDom.gifRangeControlsGroup.classList.remove('is-visually-hidden');
    }

    if (isPimd) {
      const allowAtomIndices = localState.pimdDisplayMode === 'single';
      let rerenderAfterToggle = false;

      shared.setColorSettingsOpen(false);
      shared.setFrameLabelFormatter((frameIndex, frameCount) => {
        const step = localState.pimdData && Array.isArray(localState.pimdData.step)
          ? localState.pimdData.step[frameIndex]
          : null;
        return Number.isFinite(Number(step))
          ? `Step ${step} | Frame ${frameIndex + 1}/${frameCount}`
          : `Frame ${frameIndex + 1}/${frameCount}`;
      });
      shared.setFrameRenderCallback((frameIndex) => updatePimdPotentialCursor(frameIndex));
      if (shared.getControlsGroupOpen('measure')) {
        shared.setControlsGroupOpen('playback', true);
      }
      if (sharedDom.showAtomIndexCheckbox) {
        if (!allowAtomIndices && sharedDom.showAtomIndexCheckbox.checked) {
          sharedDom.showAtomIndexCheckbox.checked = false;
          rerenderAfterToggle = true;
        }
        sharedDom.showAtomIndexCheckbox.disabled = !allowAtomIndices;
      }
      if (sharedDom.dynamicBondsCheckbox) {
        sharedDom.dynamicBondsCheckbox.checked = false;
        sharedDom.dynamicBondsCheckbox.disabled = true;
      }
      viewer.setDynamicBondsEnabled(false);
      shared.setDownloadButtonsEnabled(false);
      renderPimdPotentialPlot();
      if (rerenderAfterToggle && shared.state.currentTrajId) {
        void viewer.renderFrame(shared.state.currentFrame || 0, false);
      }
      syncSamplingExportUi();
      return;
    }

    shared.setFrameLabelFormatter(null);
    shared.setFrameRenderCallback(null);
    if (sharedDom.showAtomIndexCheckbox) {
      sharedDom.showAtomIndexCheckbox.disabled = false;
    }
    if (sharedDom.dynamicBondsCheckbox) {
      sharedDom.dynamicBondsCheckbox.disabled = false;
    }
    if (sharedDom.bondPlotEl) {
      sharedDom.bondPlotEl.dataset.plotOwner = 'measurement';
    }
    if (typeof measurement.renderMeasurementPlot === 'function') {
      measurement.renderMeasurementPlot();
    }
    syncSamplingExportUi();
  }

  function setActiveDatasetKind(kind) {
    localState.activeDatasetKind = kind === 'pimd' ? 'pimd' : 'md';
    configureViewerUiForActiveDataset();
  }

  function populatePimdBeadSelect(nBeads, selectedBead) {
    if (!dom.pimdBeadSelect) return;
    dom.pimdBeadSelect.innerHTML = '';
    for (let beadIndex = 0; beadIndex < nBeads; beadIndex++) {
      const option = document.createElement('option');
      option.value = String(beadIndex);
      option.textContent = `Bead ${beadIndex}`;
      dom.pimdBeadSelect.appendChild(option);
    }
    dom.pimdBeadSelect.value = String(selectedBead);
    dom.pimdBeadSelect.disabled = localState.pimdDisplayMode !== 'single';
  }

  async function applyCurrentMdView({ refitView = true } = {}) {
    if (!localState.mdData) return false;
    const record = localState.mdData;
    const sourceName = String(localState.mdSourceFile?.name || record.traj_id || 'local_xyz');
    const sourceLabel = String(localState.mdSourceLabel || sourceName);

    viewer.clearAuxiliaryModels();
    if (typeof measurement.clearMeasurementState === 'function') {
      measurement.clearMeasurementState();
    }

    await io.loadTrajectoryRecord(sourceName.replace(/\.[^.]+$/, '') || 'local_xyz', record, {
      loadingMessage: `Preparing viewer for ${sourceLabel}...`,
      loadedMessage: `Loaded XYZ ${sourceLabel} (${record.n_frames} frames).`,
    });

    setSourceInfo(sourceLabel);
    setActiveDatasetKind('md');
    if (!refitView) {
      await viewer.renderFrame(shared.state.currentFrame || 0, false);
    }
    return true;
  }

  async function applyCurrentPimdView({ refitView = true } = {}) {
    if (!localState.pimdData) return false;
    const data = localState.pimdData;
    const beadIndex = Math.max(0, Math.min(localState.pimdSelectedBead, data.nBeads - 1));
    const record = buildPimdRecord(data, beadIndex);
    const sourceLabel = String(localState.pimdSourceLabel || data.fileName || record.traj_id || 'pimd');

    if (typeof measurement.clearMeasurementState === 'function') {
      measurement.clearMeasurementState();
    }

    await io.loadTrajectoryRecord(record.traj_id, record, {
      loadingMessage: `Preparing PIMD viewer for ${sourceLabel}...`,
      loadedMessage: `Loaded PIMD ${sourceLabel} (${data.nFrames} frames, ${data.nBeads} beads).`,
    });

    viewer.clearAuxiliaryModels();
    if (localState.pimdDisplayMode === 'all') {
      viewer.setAuxiliaryTrajectories(buildPimdAuxiliarySpecs(data, beadIndex));
      await viewer.renderFrame(shared.state.currentFrame || 0, refitView);
    }

    shared.setDownloadButtonsEnabled(false);
    setSourceInfo(sourceLabel);
    setActiveDatasetKind('pimd');
    return true;
  }

  async function switchPanelMode(mode) {
    const normalized = mode === 'pimd' ? 'pimd' : 'md';
    setPanelMode(normalized);

    if (normalized === 'md') {
      if (localState.mdData && localState.activeDatasetKind !== 'md') {
        await applyCurrentMdView({ refitView: false });
      }
      return;
    }

    if (localState.pimdData && localState.activeDatasetKind !== 'pimd') {
      await applyCurrentPimdView({ refitView: false });
    }
  }

  async function importPimdFile(file, options = {}) {
    if (!(file instanceof File)) return;
    const sourceOrigin = options.sourceOrigin === 'backend' ? 'backend' : 'local';
    const sourceLabel = String(options.sourceLabel || file.name || 'pimd.h5');
    setPanelMode('pimd');
    setPimdUploadFileName(`Reading ${sourceLabel}...`);
    shared.setStatus(`Reading ${sourceOrigin === 'backend' ? 'backend' : 'local'} PIMD H5 file ${sourceLabel}...`);

    let data = null;
    try {
      data = await parsePimdFile(file);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      shared.setStatus(`Failed to parse ${sourceLabel}: ${detail}`, true);
      if (localState.pimdData) {
        setPimdUploadFileName(localState.pimdSourceLabel || localState.pimdData.fileName);
        setPimdMetadata(localState.pimdData);
      } else {
        setPimdUploadFileName(sourceLabel);
        setPimdMetadata(null);
      }
      return;
    }

    data.sourceLabel = sourceLabel;
    data.sourceOrigin = sourceOrigin;
    localState.pimdData = data;
    localState.pimdSourceFile = file;
    localState.pimdSourceLabel = sourceLabel;
    localState.pimdSourceOrigin = sourceOrigin;
    localState.pimdSelectedBead = 0;
    localState.pimdDisplayMode = 'single';
    if (dom.pimdDisplayModeSelect) dom.pimdDisplayModeSelect.value = 'single';
    populatePimdBeadSelect(data.nBeads, 0);
    setPimdMetadata(data);
    setPimdUploadFileName(sourceLabel);
    await applyCurrentPimdView({ refitView: true });
    resetSamplingControlsForActiveDataset();
  }

  async function importXyzFile(file, options = {}) {
    if (!(file instanceof File)) return;
    const sourceOrigin = options.sourceOrigin === 'backend' ? 'backend' : 'local';
    const sourceLabel = String(options.sourceLabel || file.name || 'trajectory.xyz');
    setPanelMode('md');
    setMdUploadFileName(`Reading ${sourceLabel}...`);
    shared.setStatus(`Reading ${sourceOrigin === 'backend' ? 'backend' : 'local'} XYZ file ${sourceLabel}...`);

    let text = '';
    try {
      text = await file.text();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      shared.setStatus(`Failed to read ${sourceLabel}: ${detail}`, true);
      setMdUploadFileName(localState.mdSourceLabel || localState.mdSourceFile?.name || sourceLabel);
      return;
    }

    let record = null;
    try {
      record = parseMultiFrameXyz(text, file.name);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      shared.setStatus(`Failed to parse ${sourceLabel}: ${detail}`, true);
      if (localState.mdData) {
        setMdMetadata(localState.mdSourceLabel || localState.mdSourceFile?.name || sourceLabel, localState.mdData, localState.mdSourceOrigin);
        setMdUploadFileName(localState.mdSourceLabel || localState.mdSourceFile?.name || sourceLabel);
      } else {
        setMdMetadata(sourceLabel, null, sourceOrigin);
      }
      return;
    }

    localState.mdData = record;
    localState.mdSourceFile = file;
    localState.mdSourceLabel = sourceLabel;
    localState.mdSourceOrigin = sourceOrigin;
    setMdMetadata(sourceLabel, record, sourceOrigin);
    setMdUploadFileName(sourceLabel);
    await applyCurrentMdView({ refitView: true });
    resetSamplingControlsForActiveDataset();
  }

  async function importXyzBackendPath() {
    const normalizedPath = normalizeBackendPath(dom.mdBackendPathInput?.value);
    if (!normalizedPath) {
      shared.setStatus('Enter an XYZ path before importing from the backend.', true);
      return;
    }

    setPanelMode('md');
    setMdUploadFileName(`Fetching ${normalizedPath}...`);
    shared.setStatus(`Fetching backend XYZ path ${normalizedPath}...`);

    try {
      const payload = await fetchSourceFileFromBackend(normalizedPath, 'md');
      await importXyzFile(payload.file, {
        sourceLabel: payload.sourceLabel,
        sourceOrigin: 'backend',
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      shared.setStatus(`Failed to load backend XYZ path ${normalizedPath}: ${detail}`, true);
      setMdUploadFileName(localState.mdSourceLabel || localState.mdSourceFile?.name || 'No file loaded.');
    }
  }

  async function importPimdBackendPath() {
    const normalizedPath = normalizeBackendPath(dom.pimdBackendPathInput?.value);
    if (!normalizedPath) {
      shared.setStatus('Enter a PIMD H5 path before importing from the backend.', true);
      return;
    }

    setPanelMode('pimd');
    setPimdUploadFileName(`Fetching ${normalizedPath}...`);
    shared.setStatus(`Fetching backend PIMD path ${normalizedPath}...`);

    try {
      const payload = await fetchSourceFileFromBackend(normalizedPath, 'pimd');
      await importPimdFile(payload.file, {
        sourceLabel: payload.sourceLabel,
        sourceOrigin: 'backend',
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      shared.setStatus(`Failed to load backend PIMD path ${normalizedPath}: ${detail}`, true);
      setPimdUploadFileName(localState.pimdSourceLabel || localState.pimdSourceFile?.name || 'No file loaded.');
    }
  }

  function bindDropzone(dropzoneEl, inputEl, acceptFile, onFile) {
    if (!dropzoneEl) return;

    ['dragenter', 'dragover'].forEach((eventName) => {
      dropzoneEl.addEventListener(eventName, (event) => {
        event.preventDefault();
        dropzoneEl.classList.add('is-dragover');
      });
    });

    ['dragleave', 'dragend', 'drop'].forEach((eventName) => {
      dropzoneEl.addEventListener(eventName, (event) => {
        event.preventDefault();
        dropzoneEl.classList.remove('is-dragover');
      });
    });

    dropzoneEl.addEventListener('drop', async (event) => {
      const files = event.dataTransfer && event.dataTransfer.files ? Array.from(event.dataTransfer.files) : [];
      const file = files.find((item) => acceptFile(item)) || files[0] || null;
      await onFile(file);
      if (inputEl) inputEl.value = '';
    });
  }

  function bindModeTabs() {
    dom.mdTab?.addEventListener('click', () => {
      void switchPanelMode('md');
    });
    dom.pimdTab?.addEventListener('click', () => {
      void switchPanelMode('pimd');
    });
  }

  function bindUploadControls() {
    dom.uploadInput?.addEventListener('change', async () => {
      const file = dom.uploadInput && dom.uploadInput.files ? dom.uploadInput.files[0] : null;
      await importXyzFile(file);
      if (dom.uploadInput) dom.uploadInput.value = '';
    });

    dom.pimdInput?.addEventListener('change', async () => {
      const file = dom.pimdInput && dom.pimdInput.files ? dom.pimdInput.files[0] : null;
      await importPimdFile(file);
      if (dom.pimdInput) dom.pimdInput.value = '';
    });

    dom.mdBackendImportBtn?.addEventListener('click', () => {
      void importXyzBackendPath();
    });
    dom.mdBackendBrowseBtn?.addEventListener('click', () => {
      openBackendBrowser('md');
    });
    dom.mdBackendPathInput?.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      void importXyzBackendPath();
    });

    dom.pimdBackendImportBtn?.addEventListener('click', () => {
      void importPimdBackendPath();
    });
    dom.pimdBackendBrowseBtn?.addEventListener('click', () => {
      openBackendBrowser('pimd');
    });
    dom.pimdBackendPathInput?.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      void importPimdBackendPath();
    });

    bindDropzone(
      dom.dropzone,
      dom.uploadInput,
      (file) => file instanceof File && /\.xyz$/i.test(file.name),
      importXyzFile,
    );

    bindDropzone(
      dom.pimdDropzone,
      dom.pimdInput,
      (file) => file instanceof File && /\.(?:h5|hdf5)$/i.test(file.name),
      importPimdFile,
    );
  }

  function bindBackendBrowserControls() {
    dom.backendBrowserCloseBtn?.addEventListener('click', () => {
      closeBackendBrowser();
    });
    dom.backendBrowserUpBtn?.addEventListener('click', () => {
      if (localState.backendBrowserParentPath == null) return;
      void loadBackendBrowserPath(localState.backendBrowserParentPath);
    });
    dom.backendBrowserModal?.addEventListener('click', (event) => {
      if (event.target !== dom.backendBrowserModal) return;
      closeBackendBrowser();
    });
  }

  function bindPimdControls() {
    dom.pimdDisplayModeSelect?.addEventListener('change', async () => {
      localState.pimdDisplayMode = dom.pimdDisplayModeSelect?.value === 'all' ? 'all' : 'single';
      if (dom.pimdBeadSelect) {
        dom.pimdBeadSelect.disabled = localState.pimdDisplayMode !== 'single';
      }
      if (!localState.pimdData) return;
      await applyCurrentPimdView({ refitView: false });
    });

    dom.pimdBeadSelect?.addEventListener('change', async () => {
      const beadIndex = Number.parseInt(String(dom.pimdBeadSelect?.value || 0), 10);
      localState.pimdSelectedBead = Number.isFinite(beadIndex) ? beadIndex : 0;
      if (!localState.pimdData || localState.pimdDisplayMode !== 'single') return;
      await applyCurrentPimdView({ refitView: false });
    });
  }

  function bindSamplingExportControls() {
    [
      dom.samplingStartFrame,
      dom.samplingEndFrame,
      dom.samplingFrameStride,
      dom.samplingCharge,
      dom.samplingMultiplicity,
      dom.samplingBeadStart,
      dom.samplingBeadEnd,
      dom.samplingBeadStride,
    ].forEach((inputEl) => {
      inputEl?.addEventListener('input', () => syncSamplingExportUi());
      inputEl?.addEventListener('change', () => syncSamplingExportUi());
    });

    dom.exportGeometryBundleBtn?.addEventListener('click', () => {
      void exportGeometryBundle();
    });
  }

  function bindAppearanceUpdates() {
    const appearance = window.ObservableAppearance;
    if (!appearance || typeof appearance.subscribe !== 'function') return;
    localState.appearanceUnsubscribe = appearance.subscribe(() => {
      if (localState.activeDatasetKind === 'pimd') {
        renderPimdPotentialPlot();
      }
    });
  }

  function init() {
    bindModeTabs();
    bindUploadControls();
    bindBackendBrowserControls();
    bindPimdControls();
    bindSamplingExportControls();
    bindAppearanceUpdates();

    setPanelMode('md');
    setMdMetadata('', null);
    setPimdMetadata(null);
    setSourceInfo('Local XYZ');
    setActiveDatasetKind('md');
    setMdUploadFileName('No file loaded.');
    setPimdUploadFileName('No file loaded.');
    syncSamplingExportUi();
  }

  init();
})();
