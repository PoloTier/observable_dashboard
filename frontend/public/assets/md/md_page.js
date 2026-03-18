(function () {
  const root = window.ObservableMol3D || (window.ObservableMol3D = {});
  const shared = root.shared;
  const io = root.io;
  if (!shared || !io) return;

  const dom = {
    mdTab: document.getElementById('md-mode-tab-md'),
    pimdTab: document.getElementById('md-mode-tab-pimd'),
    mdPanel: document.getElementById('md-panel-md'),
    pimdPanel: document.getElementById('md-panel-pimd'),
    uploadInput: document.getElementById('md-upload-input'),
    dropzone: document.getElementById('md-dropzone'),
    uploadFileName: document.getElementById('md-upload-file-name'),
    metaFile: document.getElementById('md-meta-file'),
    metaFileSubvalue: document.getElementById('md-meta-file-subvalue'),
    metaFrames: document.getElementById('md-meta-frames'),
    metaAtoms: document.getElementById('md-meta-atoms'),
    metaElements: document.getElementById('md-meta-elements'),
    sourceInfo: document.getElementById('source-pkl'),
    workflowLink: document.getElementById('md-open-workflow-link'),
    apiViewerLink: document.getElementById('md-open-api-viewer-link'),
  };

  const bootstrap = shared.bootstrap && typeof shared.bootstrap === 'object' ? shared.bootstrap : {};
  const pages = bootstrap.pages && typeof bootstrap.pages === 'object' ? bootstrap.pages : {};
  const symbolToAtomicNumber = buildSymbolMap(shared.constants?.PERIODIC_SYMBOLS || []);

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

  function setMode(mode) {
    const isMd = mode !== 'pimd';
    if (dom.mdPanel) dom.mdPanel.hidden = !isMd;
    if (dom.pimdPanel) dom.pimdPanel.hidden = isMd;
    if (dom.mdTab) {
      dom.mdTab.classList.toggle('is-active', isMd);
      dom.mdTab.setAttribute('aria-selected', isMd ? 'true' : 'false');
    }
    if (dom.pimdTab) {
      dom.pimdTab.classList.toggle('is-active', !isMd);
      dom.pimdTab.setAttribute('aria-selected', !isMd ? 'true' : 'false');
    }
  }

  function bindModeTabs() {
    dom.mdTab?.addEventListener('click', () => setMode('md'));
    dom.pimdTab?.addEventListener('click', () => setMode('pimd'));
  }

  function setUploadFileName(message) {
    if (!dom.uploadFileName) return;
    dom.uploadFileName.textContent = String(message || 'No file loaded.');
  }

  function setSourceInfo(fileName) {
    if (!dom.sourceInfo) return;
    const label = String(fileName || 'Local XYZ');
    dom.sourceInfo.textContent = `Source: ${label}`;
    dom.sourceInfo.title = label;
  }

  function summarizeAtomNumbers(atomNumbers) {
    const counts = new Map();
    const symbols = Array.isArray(shared.constants?.PERIODIC_SYMBOLS) ? shared.constants.PERIODIC_SYMBOLS : [];
    atomNumbers.forEach((value) => {
      const atomicNumber = Number.parseInt(String(value), 10);
      const symbol = atomicNumber > 0 && atomicNumber < symbols.length ? String(symbols[atomicNumber] || 'X') : 'X';
      counts.set(symbol, (counts.get(symbol) || 0) + 1);
    });
    return Array.from(counts.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([symbol, count]) => `${symbol} × ${count}`)
      .join(', ');
  }

  function updateMetadata(fileName, record) {
    const frameCount = Array.isArray(record?.coords) ? record.coords.length : 0;
    const atomCount = Number.parseInt(String(record?.n_atoms), 10) || 0;
    if (dom.metaFile) dom.metaFile.textContent = fileName || 'none';
    if (dom.metaFileSubvalue) {
      dom.metaFileSubvalue.textContent = frameCount > 0
        ? `Parsed ${frameCount} frame${frameCount === 1 ? '' : 's'} from a local XYZ trajectory.`
        : 'Waiting for upload.';
    }
    if (dom.metaFrames) dom.metaFrames.textContent = String(frameCount);
    if (dom.metaAtoms) dom.metaAtoms.textContent = String(atomCount);
    if (dom.metaElements) {
      dom.metaElements.textContent = atomCount > 0
        ? summarizeAtomNumbers(Array.isArray(record?.atom_numbers) ? record.atom_numbers : [])
        : 'Element summary appears after parsing.';
    }
    setSourceInfo(fileName || 'Local XYZ');
    setUploadFileName(fileName || 'No file loaded.');
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

  async function importXyzFile(file) {
    if (!(file instanceof File)) return;
    setMode('md');
    setUploadFileName(`Reading ${file.name}...`);
    shared.setStatus(`Reading local XYZ file ${file.name}...`);

    let text = '';
    try {
      text = await file.text();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      shared.setStatus(`Failed to read ${file.name}: ${detail}`, true);
      setUploadFileName(file.name);
      return;
    }

    let record = null;
    try {
      record = parseMultiFrameXyz(text, file.name);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      shared.setStatus(`Failed to parse ${file.name}: ${detail}`, true);
      updateMetadata(file.name, null);
      return;
    }

    updateMetadata(file.name, record);
    await io.loadTrajectoryRecord(file.name.replace(/\.[^.]+$/, '') || 'local_xyz', record, {
      loadingMessage: `Preparing viewer for ${file.name}...`,
      loadedMessage: `Loaded local XYZ ${file.name} (${record.n_frames} frames).`,
    });
  }

  function bindUploadControls() {
    dom.uploadInput?.addEventListener('change', async () => {
      const file = dom.uploadInput && dom.uploadInput.files ? dom.uploadInput.files[0] : null;
      await importXyzFile(file);
      if (dom.uploadInput) {
        dom.uploadInput.value = '';
      }
    });

    if (!dom.dropzone) return;

    ['dragenter', 'dragover'].forEach((eventName) => {
      dom.dropzone.addEventListener(eventName, (event) => {
        event.preventDefault();
        dom.dropzone.classList.add('is-dragover');
      });
    });

    ['dragleave', 'dragend', 'drop'].forEach((eventName) => {
      dom.dropzone.addEventListener(eventName, (event) => {
        event.preventDefault();
        dom.dropzone.classList.remove('is-dragover');
      });
    });

    dom.dropzone.addEventListener('drop', async (event) => {
      const files = event.dataTransfer && event.dataTransfer.files ? Array.from(event.dataTransfer.files) : [];
      const file = files.find((item) => /\.xyz$/i.test(item.name)) || files[0] || null;
      await importXyzFile(file);
    });
  }

  bindModeTabs();
  bindUploadControls();
  updateMetadata('', null);
  setMode('md');
})();
