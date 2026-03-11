(function () {
  const root = window.ObservableMol3D || (window.ObservableMol3D = {});
  const shared = root.shared;
  const network = root.ioNetwork;
  const transformers = root.ioTransformers;
  if (!shared || !network || !transformers) return;

  const { dom, state } = shared;

  function parseStateCount(rawValue) {
    return Math.max(0, Number.parseInt(String(rawValue), 10) || 0);
  }

  function getNacPairSelectorStateCount() {
    return Math.max(
      0,
      parseStateCount(state.nacStateCount),
      parseStateCount(state.deNacStateCount)
    );
  }

  // Backward-compatible alias used by older callers.
  function getPairSelectorStateCount() {
    return getNacPairSelectorStateCount();
  }

  function getDeSelectorStateCount() {
    return parseStateCount(state.deStateCount);
  }

  function populateNacStateOptions(nStates) {
    const count = parseStateCount(nStates);
    const selects = [dom.nacStateISelect, dom.nacStateJSelect];
    for (const selectEl of selects) {
      if (!selectEl) continue;
      selectEl.innerHTML = '';
      for (let idx = 0; idx < count; idx++) {
        const option = document.createElement('option');
        option.value = String(idx);
        option.textContent = String(idx);
        selectEl.appendChild(option);
      }
    }
  }

  function makeDeRowId() {
    const next = Math.max(1, Number.parseInt(String(state.deNextRowId), 10) || 1);
    state.deNextRowId = next + 1;
    return next;
  }

  function makeLocalDePairKey(stateI, stateJ) {
    return `${Number.parseInt(String(stateI), 10)}::${Number.parseInt(String(stateJ), 10)}`;
  }

  const DE_PAIR_HUE_PALETTE = Object.freeze([
    12, 34, 56, 84, 116, 148, 180, 212, 244, 272, 300, 332,
  ]);

  function clamp01(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 0;
    if (numeric <= 0) return 0;
    if (numeric >= 1) return 1;
    return numeric;
  }

  function hashStringFNV1a(text) {
    const input = String(text || '');
    let hash = 0x811c9dc5;
    for (let idx = 0; idx < input.length; idx++) {
      hash ^= input.charCodeAt(idx);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash >>> 0;
  }

  function normalizeHue(rawHue) {
    const hue = Number(rawHue);
    if (!Number.isFinite(hue)) return 210;
    const normalized = ((hue % 360) + 360) % 360;
    return normalized;
  }

  function hslToHex(hue, saturationPct, lightnessPct) {
    const h = normalizeHue(hue) / 360;
    const s = clamp01(Number(saturationPct) / 100);
    const l = clamp01(Number(lightnessPct) / 100);

    const toHex = (value) => {
      const bounded = Math.max(0, Math.min(255, Math.round(value)));
      return bounded.toString(16).padStart(2, '0');
    };

    if (s <= 1e-12) {
      const gray = l * 255;
      return `#${toHex(gray)}${toHex(gray)}${toHex(gray)}`;
    }

    const q = l < 0.5 ? l * (1 + s) : (l + s - l * s);
    const p = 2 * l - q;
    const hue2rgb = (tRaw) => {
      let t = tRaw;
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < (1 / 6)) return p + (q - p) * 6 * t;
      if (t < 0.5) return q;
      if (t < (2 / 3)) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };

    const r = hue2rgb(h + 1 / 3) * 255;
    const g = hue2rgb(h) * 255;
    const b = hue2rgb(h - 1 / 3) * 255;
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  }

  function resolveDePairHue(pairKey) {
    const key = String(pairKey || '').trim();
    if (!key) return 210;
    const hash = hashStringFNV1a(key);
    const baseHue = DE_PAIR_HUE_PALETTE[hash % DE_PAIR_HUE_PALETTE.length];
    const jitter = ((hash >>> 8) % 25) - 12;
    return normalizeHue(baseHue + jitter);
  }

  function normalizeMagnitudeRatio(magnitude, magnitudeRange) {
    const minValue = Number(magnitudeRange?.min);
    const maxValue = Number(magnitudeRange?.max);
    const mag = Number(magnitude);
    if (!Number.isFinite(minValue) || !Number.isFinite(maxValue) || maxValue <= minValue) {
      return 0.5;
    }
    if (!Number.isFinite(mag)) {
      return 0.5;
    }
    return clamp01((mag - minValue) / (maxValue - minValue));
  }

  function buildDePairColor(pairKey, magnitude, magnitudeRange) {
    const hue = resolveDePairHue(pairKey);
    const ratio = normalizeMagnitudeRatio(magnitude, magnitudeRange);
    const saturation = 45 + 35 * ratio;
    const lightness = 70 - 40 * ratio;
    return hslToHex(hue, saturation, lightness);
  }

  function getDePairSwatchColor(stateI, stateJ) {
    const pairKey = makeLocalDePairKey(stateI, stateJ);
    return buildDePairColor(pairKey, NaN, null);
  }

  function makeDeRowPairKey(row, trajId = state.currentTrajId) {
    if (!row || !trajId) return null;
    return network.makeDePairKey(trajId, row.stateI, row.stateJ);
  }

  function createDeRow(stateI = 0, stateJ = 0, enabled = true) {
    const normalized = transformers.normalizeStatePair(stateI, stateJ, getDeSelectorStateCount());
    return {
      id: makeDeRowId(),
      enabled: !!enabled,
      stateI: normalized.stateI,
      stateJ: normalized.stateJ,
      pairKey: null,
      vectors: [],
      times: [],
      isLoading: false,
      lastValidStateI: normalized.stateI,
      lastValidStateJ: normalized.stateJ,
    };
  }

  function getDeRowsArray() {
    if (!Array.isArray(state.deRows)) {
      state.deRows = [];
    }
    return state.deRows;
  }

  function findDeRowIndexById(rowId) {
    const id = Number.parseInt(String(rowId), 10);
    if (!Number.isFinite(id)) return -1;
    return getDeRowsArray().findIndex((row) => Number.parseInt(String(row?.id), 10) === id);
  }

  function findDeRowById(rowId) {
    const idx = findDeRowIndexById(rowId);
    if (idx < 0) return null;
    return getDeRowsArray()[idx] || null;
  }

  function clearDeRowData(row) {
    if (!row || typeof row !== 'object') return;
    row.pairKey = null;
    row.vectors = [];
    row.times = [];
    row.isLoading = false;
  }

  function syncDeLoadingFlag() {
    const rows = getDeRowsArray();
    state.isDeLoading = rows.some((row) => !!row?.isLoading);
  }

  function syncDeStateSelectValues() {
    const firstRow = getDeRowsArray()[0] || null;
    if (firstRow) {
      state.deStateI = Number.parseInt(String(firstRow.stateI), 10) || 0;
      state.deStateJ = Number.parseInt(String(firstRow.stateJ), 10) || 0;
      state.deVectors = Array.isArray(firstRow.vectors) ? firstRow.vectors : [];
      state.deTimes = Array.isArray(firstRow.times) ? firstRow.times : [];
      state.deCurrentPairKey = firstRow.pairKey || null;
      return;
    }

    state.deStateI = 0;
    state.deStateJ = 0;
    state.deVectors = [];
    state.deTimes = [];
    state.deCurrentPairKey = null;
  }

  function findNextUnusedDePair(nStates, usedPairKeys) {
    const count = parseStateCount(nStates);
    if (count <= 0) {
      const key00 = makeLocalDePairKey(0, 0);
      if (usedPairKeys && usedPairKeys.has(key00)) return null;
      return { stateI: 0, stateJ: 0 };
    }

    for (let i = 0; i < count; i++) {
      for (let j = 0; j < count; j++) {
        const key = makeLocalDePairKey(i, j);
        if (!usedPairKeys || !usedPairKeys.has(key)) {
          return { stateI: i, stateJ: j };
        }
      }
    }
    return null;
  }

  function getUsedDePairKeys(excludeRowId = null) {
    const used = new Set();
    const excludeId = excludeRowId === null
      ? null
      : (Number.parseInt(String(excludeRowId), 10));
    for (const row of getDeRowsArray()) {
      if (!row) continue;
      const rowId = Number.parseInt(String(row.id), 10);
      if (Number.isFinite(excludeId) && rowId === excludeId) continue;
      used.add(makeLocalDePairKey(row.stateI, row.stateJ));
    }
    return used;
  }

  function isDuplicateDePair(rowId, stateI, stateJ) {
    const key = makeLocalDePairKey(stateI, stateJ);
    const used = getUsedDePairKeys(rowId);
    return used.has(key);
  }

  function ensureAtLeastOneDeRow() {
    const rows = getDeRowsArray();
    if (rows.length > 0) return rows;

    const next = findNextUnusedDePair(getDeSelectorStateCount(), new Set()) || { stateI: 0, stateJ: 0 };
    rows.push(createDeRow(next.stateI, next.stateJ, true));
    return rows;
  }

  function normalizeDeRowsForStateCount() {
    const rows = ensureAtLeastOneDeRow();
    const nStates = getDeSelectorStateCount();
    const maxUniquePairs = Math.max(1, nStates > 0 ? nStates * nStates : 1);
    if (rows.length > maxUniquePairs) {
      rows.splice(maxUniquePairs);
    }

    const used = new Set();
    for (const row of rows) {
      if (!row) continue;
      const prevI = row.stateI;
      const prevJ = row.stateJ;
      const normalized = transformers.normalizeStatePair(prevI, prevJ, nStates);
      let nextI = normalized.stateI;
      let nextJ = normalized.stateJ;
      let pairKey = makeLocalDePairKey(nextI, nextJ);
      if (used.has(pairKey)) {
        const nextUnused = findNextUnusedDePair(nStates, used);
        if (nextUnused) {
          nextI = nextUnused.stateI;
          nextJ = nextUnused.stateJ;
          pairKey = makeLocalDePairKey(nextI, nextJ);
        }
      }

      const pairChanged = prevI !== nextI || prevJ !== nextJ;
      row.stateI = nextI;
      row.stateJ = nextJ;
      row.lastValidStateI = nextI;
      row.lastValidStateJ = nextJ;
      if (pairChanged) {
        clearDeRowData(row);
      }
      used.add(pairKey);
    }

    if (!rows.length) {
      rows.push(createDeRow(0, 0, true));
    }
  }

  function buildDeRowElement(row, nStates, rowCount) {
    if (!row) return null;

    let rowEl = null;
    if (dom.dePairRowTemplate && dom.dePairRowTemplate.content) {
      const fromTemplate = dom.dePairRowTemplate.content.firstElementChild;
      if (fromTemplate) {
        rowEl = fromTemplate.cloneNode(true);
      }
    }

    if (!rowEl) {
      rowEl = document.createElement('div');
      rowEl.className = 'de-pair-row';
      rowEl.innerHTML = [
        '<span class="de-row-swatch" aria-hidden="true"></span>',
        '<label class="check-label" title="Toggle this dE pair">',
        '  <input class="de-row-enabled" type="checkbox" checked />',
        '  On',
        '</label>',
        '<label class="de-row-label">i</label>',
        '<select class="de-row-state-i"></select>',
        '<label class="de-row-label">j</label>',
        '<select class="de-row-state-j"></select>',
        '<button class="de-row-remove-btn" type="button">Remove</button>',
      ].join('');
    }

    rowEl.dataset.deRowId = String(row.id);
    rowEl.classList.toggle('disabled', !row.enabled);

    const swatchEl = rowEl.querySelector('.de-row-swatch');
    const enabledInput = rowEl.querySelector('.de-row-enabled');
    const stateISelect = rowEl.querySelector('.de-row-state-i');
    const stateJSelect = rowEl.querySelector('.de-row-state-j');
    const removeBtn = rowEl.querySelector('.de-row-remove-btn');

    if (enabledInput) {
      enabledInput.checked = !!row.enabled;
      enabledInput.dataset.deRowId = String(row.id);
    }

    const populateSelect = (selectEl, value, className) => {
      if (!selectEl) return;
      selectEl.dataset.deRowId = String(row.id);
      selectEl.classList.add(className);
      selectEl.innerHTML = '';
      if (nStates > 0) {
        for (let idx = 0; idx < nStates; idx++) {
          const option = document.createElement('option');
          option.value = String(idx);
          option.textContent = String(idx);
          selectEl.appendChild(option);
        }
      } else {
        const option = document.createElement('option');
        option.value = '0';
        option.textContent = '0';
        selectEl.appendChild(option);
      }
      selectEl.value = String(value);
    };

    populateSelect(stateISelect, row.stateI, 'de-row-state-i');
    populateSelect(stateJSelect, row.stateJ, 'de-row-state-j');

    if (removeBtn) {
      removeBtn.dataset.deRowId = String(row.id);
      removeBtn.disabled = rowCount <= 1;
    }

    if (swatchEl) {
      swatchEl.style.backgroundColor = getDePairSwatchColor(row.stateI, row.stateJ);
      swatchEl.style.opacity = row.enabled ? '1' : '0.35';
      swatchEl.title = `dE pair ${formatDePair(row.stateI, row.stateJ)}`;
    }

    return rowEl;
  }

  function renderDeRowsUi() {
    if (!dom.dePairRowsContainer) return;

    normalizeDeRowsForStateCount();
    syncDeStateSelectValues();

    const rows = getDeRowsArray();
    const nStates = getDeSelectorStateCount();
    dom.dePairRowsContainer.innerHTML = '';
    for (const row of rows) {
      const rowEl = buildDeRowElement(row, nStates, rows.length);
      if (rowEl) {
        dom.dePairRowsContainer.appendChild(rowEl);
      }
    }
  }

  function populateDeStateOptions(nStates) {
    state.deStateCount = parseStateCount(nStates);
    normalizeDeRowsForStateCount();
    renderDeRowsUi();
  }

  function resolveDeRowControls(rowId) {
    const row = findDeRowById(rowId);
    if (!row) {
      return null;
    }
    if (!dom.dePairRowsContainer) {
      return { row, rawI: row.stateI, rawJ: row.stateJ };
    }

    const rowEl = dom.dePairRowsContainer.querySelector(`.de-pair-row[data-de-row-id="${row.id}"]`);
    if (!rowEl) {
      return { row, rawI: row.stateI, rawJ: row.stateJ };
    }

    const stateISelect = rowEl.querySelector('.de-row-state-i');
    const stateJSelect = rowEl.querySelector('.de-row-state-j');
    const rawI = stateISelect ? stateISelect.value : row.stateI;
    const rawJ = stateJSelect ? stateJSelect.value : row.stateJ;
    return { row, rawI, rawJ };
  }

  function formatDePair(stateI, stateJ) {
    return `${Number.parseInt(String(stateI), 10)}-${Number.parseInt(String(stateJ), 10)}`;
  }

  function describeEnabledDePairs() {
    const pairs = getDeRowsArray()
      .filter((row) => !!row?.enabled)
      .map((row) => formatDePair(row.stateI, row.stateJ));
    if (!pairs.length) return '(none)';
    return pairs.join(', ');
  }

  function resetNacStateSelection() {
    state.nacStateI = 0;
    state.nacStateJ = 1;
  }

  function resetDeStateSelection() {
    state.deRows = [];
    state.deNextRowId = 1;
    ensureAtLeastOneDeRow();
    normalizeDeRowsForStateCount();
    syncDeStateSelectValues();
    renderDeRowsUi();
  }

  const VECTOR_KIND_CONFIG = Object.freeze({
    nac: {
      kind: 'nac',
      label: 'NAC',
      sourceId: 'nac',
      vectorsField: 'nacVectors',
      timesField: 'nacTimes',
      currentPairKeyField: 'nacCurrentPairKey',
      autoBaseScaleField: 'nacAutoBaseScale',
      magnitudeRangeField: 'nacMagnitudeRange',
      isLoadingField: 'isNacLoading',
      showField: 'showNacVectors',
      availableField: 'nacAvailable',
      stateCountField: 'nacStateCount',
      componentCountField: 'nacComponentCount',
      checkboxAccessor: () => dom.showNacVectorsCheckbox,
      setRangeLabel: (text) => shared.setNacRangeLabel(text),
      labels: {
        notLoaded: '|NAC|: not loaded',
        unavailable: '|NAC|: unavailable',
        noFinite: '|NAC|: no finite vectors',
        loadFailed: '|NAC|: load failed',
      },
      loadingStatus: (stateI, stateJ) => `Loading NAC vectors for states ${stateI}-${stateJ}...`,
      unavailableStatus: 'NAC vectors are unavailable for this trajectory.',
      showingStatus: () => `Showing NAC vectors for states ${state.nacStateI}-${state.nacStateJ}.`,
      hiddenStatus: 'NAC vectors hidden.',
      notFoundError: (trajId) => `NAC vectors not found for trajectory ${trajId}.`,
      makePairKey: network.makeNacPairKey,
      getRecord: network.getNacRecord,
      resolvePairFromState: () => {
        const normalizedPair = transformers.normalizeDistinctStatePair(
          state.nacStateI,
          state.nacStateJ,
          state.nacStateCount,
          'j'
        );
        state.nacStateI = normalizedPair.stateI;
        state.nacStateJ = normalizedPair.stateJ;
        syncNacStateSelectValues();
        return normalizedPair;
      },
      getEffectiveScale: () => {
        const userScale = shared.clampNacScale(state.nacUserScale);
        const autoScale = Number.isFinite(state.nacAutoBaseScale) ? Number(state.nacAutoBaseScale) : 1;
        return userScale * autoScale;
      },
      formatRangeLabel: (stats) => {
        return `|NAC| P5-P95: ${transformers.formatMagnitude(stats.colorMin)} ~ ${transformers.formatMagnitude(stats.colorMax)}`;
      },
    },
    de: {
      kind: 'de',
      label: 'dE',
      sourceId: 'de',
      vectorsField: 'deVectors',
      timesField: 'deTimes',
      currentPairKeyField: 'deCurrentPairKey',
      autoBaseScaleField: 'deAutoBaseScale',
      magnitudeRangeField: 'deMagnitudeRange',
      isLoadingField: 'isDeLoading',
      showField: 'showDeVectors',
      availableField: 'deAvailable',
      stateCountField: 'deStateCount',
      componentCountField: 'deComponentCount',
      checkboxAccessor: () => dom.showDeVectorsCheckbox,
      setRangeLabel: (text) => shared.setDeRangeLabel(text),
      labels: {
        notLoaded: '|dE|: not loaded',
        unavailable: '|dE|: unavailable',
        noFinite: '|dE|: no finite vectors',
        loadFailed: '|dE|: load failed',
      },
      loadingStatus: (stateI, stateJ) => `Loading dE vectors for states ${stateI}-${stateJ}...`,
      unavailableStatus: 'dE vectors are unavailable for this trajectory.',
      showingStatus: () => `Showing dE vectors for states ${describeEnabledDePairs()}.`,
      hiddenStatus: 'dE vectors hidden.',
      notFoundError: (trajId) => `dE vectors not found for trajectory ${trajId}.`,
      makePairKey: network.makeDePairKey,
      getRecord: network.getDeRecord,
      resolvePairFromState: () => {
        ensureAtLeastOneDeRow();
        const first = getDeRowsArray()[0];
        const normalizedPair = transformers.normalizeStatePair(first.stateI, first.stateJ, state.deStateCount);
        first.stateI = normalizedPair.stateI;
        first.stateJ = normalizedPair.stateJ;
        first.lastValidStateI = normalizedPair.stateI;
        first.lastValidStateJ = normalizedPair.stateJ;
        syncDeStateSelectValues();
        return normalizedPair;
      },
      getEffectiveScale: () => {
        const userScale = shared.clampDeScale(state.deUserScale);
        const autoScale = Number.isFinite(state.deAutoBaseScale) ? Number(state.deAutoBaseScale) : 1;
        return userScale * autoScale;
      },
      formatRangeLabel: (stats) => {
        const prefix = stats?.scope === 'traj_global' ? '|dE| Global(traj) P5-P95' : '|dE| P5-P95';
        return `${prefix}: ${transformers.formatMagnitude(stats.colorMin)} ~ ${transformers.formatMagnitude(stats.colorMax)}`;
      },
    },
    deNac: {
      kind: 'deNac',
      label: 'dE*NAC',
      sourceId: 'de_nac',
      vectorsField: 'deNacVectors',
      timesField: 'deNacTimes',
      currentPairKeyField: 'deNacCurrentPairKey',
      autoBaseScaleField: 'deNacAutoBaseScale',
      magnitudeRangeField: 'deNacMagnitudeRange',
      isLoadingField: 'isDeNacLoading',
      showField: 'showDeNacVectors',
      availableField: 'deNacAvailable',
      stateCountField: 'deNacStateCount',
      componentCountField: 'deNacComponentCount',
      checkboxAccessor: () => dom.showDeNacVectorsCheckbox,
      setRangeLabel: (text) => shared.setDeNacRangeLabel(text),
      labels: {
        notLoaded: '|dE*NAC|: not loaded',
        unavailable: '|dE*NAC|: unavailable',
        noFinite: '|dE*NAC|: no finite vectors',
        loadFailed: '|dE*NAC|: load failed',
      },
      loadingStatus: (stateI, stateJ) => `Loading dE*NAC vectors for states ${stateI}-${stateJ}...`,
      unavailableStatus: 'dE*NAC vectors are unavailable for this trajectory.',
      showingStatus: () => `Showing dE*NAC vectors for states ${state.nacStateI}-${state.nacStateJ}.`,
      hiddenStatus: 'dE*NAC vectors hidden.',
      notFoundError: (trajId) => `dE*NAC vectors not found for trajectory ${trajId}.`,
      makePairKey: network.makeDeNacPairKey,
      getRecord: network.getDeNacRecord,
      // Keep deNac pair resolution behavior unchanged for strict compatibility.
      resolvePairFromState: () => {
        let stateI = Number.parseInt(String(state.nacStateI), 10);
        let stateJ = Number.parseInt(String(state.nacStateJ), 10);
        if (!Number.isFinite(stateI)) stateI = 0;
        if (!Number.isFinite(stateJ)) stateJ = 1;
        return { stateI, stateJ };
      },
      getEffectiveScale: () => {
        const userScale = shared.clampDeNacScale(state.deNacUserScale);
        const autoScale = Number.isFinite(state.deNacAutoBaseScale) ? Number(state.deNacAutoBaseScale) : 1;
        return userScale * autoScale;
      },
      formatRangeLabel: (stats) => {
        return `|dE*NAC| P5-P95: ${transformers.formatMagnitude(stats.colorMin)} ~ ${transformers.formatMagnitude(stats.colorMax)}`;
      },
    },
  });

  function assertConfig(kind) {
    const config = VECTOR_KIND_CONFIG[kind];
    if (!config) {
      throw new Error(`Unknown vector kind: ${kind}`);
    }

    const requiredFields = [
      'kind',
      'label',
      'sourceId',
      'vectorsField',
      'timesField',
      'currentPairKeyField',
      'autoBaseScaleField',
      'magnitudeRangeField',
      'isLoadingField',
      'showField',
      'availableField',
      'stateCountField',
      'componentCountField',
      'checkboxAccessor',
      'setRangeLabel',
      'labels',
      'loadingStatus',
      'unavailableStatus',
      'showingStatus',
      'hiddenStatus',
      'notFoundError',
      'makePairKey',
      'getRecord',
      'resolvePairFromState',
      'getEffectiveScale',
      'formatRangeLabel',
    ];
    for (const field of requiredFields) {
      if (!(field in config)) {
        throw new Error(`Vector config for ${kind} is missing required field: ${field}`);
      }
    }

    return config;
  }

  function validateConfigs() {
    try {
      assertConfig('nac');
      assertConfig('de');
      assertConfig('deNac');
      return true;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`dashboard_mol3d_io_vector_ops: ${detail}`);
      return false;
    }
  }

  if (!validateConfigs()) return;

  const VECTOR_VISIBILITY_PREFERENCE_FIELDS = Object.freeze({
    nac: 'desiredShowNacVectors',
    de: 'desiredShowDeVectors',
    deNac: 'desiredShowDeNacVectors',
  });

  function getVisibilityPreferenceField(kind) {
    const field = VECTOR_VISIBILITY_PREFERENCE_FIELDS[kind];
    if (!field) {
      throw new Error(`Unknown vector preference kind: ${kind}`);
    }
    return field;
  }

  function getDesiredVectorVisibility(kind) {
    return !!state[getVisibilityPreferenceField(kind)];
  }

  function setDesiredVectorVisibility(kind, enabled) {
    state[getVisibilityPreferenceField(kind)] = !!enabled;
    return !!state[getVisibilityPreferenceField(kind)];
  }

  function getStateCount(config) {
    return parseStateCount(state[config.stateCountField]);
  }

  function getDeTrajectoryGlobalStats() {
    if (String(state.deGlobalNormScope || '') !== 'traj_global') {
      return null;
    }
    if (parseStateCount(state.deGlobalNormCount) <= 0) {
      return null;
    }

    const stats = transformers.buildMagnitudeStatsFromQuantiles(
      state.deGlobalNormP5,
      state.deGlobalNormP90,
      state.deGlobalNormP95
    );
    if (!stats) {
      return null;
    }

    return {
      ...stats,
      scope: 'traj_global',
    };
  }

  function resolveMagnitudeStats(kind, vectors) {
    if (kind === 'de') {
      const globalStats = getDeTrajectoryGlobalStats();
      if (globalStats) {
        return globalStats;
      }
    }
    return transformers.computeNacMagnitudeStats(vectors);
  }

  function mergeDeVectorsByFrame(rows) {
    const safeRows = Array.isArray(rows) ? rows : [];
    const maxFrames = safeRows.reduce((max, row) => {
      const rowFrames = Array.isArray(row?.vectors) ? row.vectors.length : 0;
      return Math.max(max, rowFrames);
    }, 0);

    const merged = [];
    for (let frameIdx = 0; frameIdx < maxFrames; frameIdx++) {
      const frameVectors = [];
      for (const row of safeRows) {
        if (!row || !Array.isArray(row.vectors)) continue;
        const rowFrame = row.vectors[frameIdx];
        if (!Array.isArray(rowFrame)) continue;
        for (const vec of rowFrame) {
          frameVectors.push(vec);
        }
      }
      merged.push(frameVectors);
    }
    return merged;
  }

  function updateDeMagnitudeStatsFromRows() {
    const config = assertConfig('de');
    const loadedEnabledRows = getDeRowsArray().filter((row) => {
      return !!row?.enabled && Array.isArray(row.vectors) && row.vectors.length > 0;
    });

    if (!loadedEnabledRows.length) {
      state.deMagnitudeRange = null;
      state.deAutoBaseScale = 1;
      if (!state.deAvailable || getDeSelectorStateCount() < 1) {
        config.setRangeLabel(config.labels.unavailable);
      } else {
        config.setRangeLabel(config.labels.notLoaded);
      }
      return null;
    }

    const mergedVectors = mergeDeVectorsByFrame(loadedEnabledRows);
    const stats = resolveMagnitudeStats('de', mergedVectors);
    if (!stats) {
      state.deMagnitudeRange = null;
      state.deAutoBaseScale = 1;
      config.setRangeLabel(config.labels.noFinite);
      return null;
    }

    state.deMagnitudeRange = { min: stats.colorMin, max: stats.colorMax };
    state.deAutoBaseScale = stats.autoScale;
    config.setRangeLabel(config.formatRangeLabel(stats));
    return stats;
  }

  function setCheckboxChecked(config, checked) {
    const checkbox = config.checkboxAccessor();
    if (checkbox) {
      checkbox.checked = !!checked;
    }
  }

  function resetVectorOverlayState(kind) {
    const config = assertConfig(kind);

    if (kind === 'de') {
      state[config.showField] = false;
      state[config.vectorsField] = [];
      state[config.timesField] = [];
      state[config.currentPairKeyField] = null;
      state[config.autoBaseScaleField] = 1;
      state[config.magnitudeRangeField] = null;
      for (const row of getDeRowsArray()) {
        clearDeRowData(row);
      }
      syncDeLoadingFlag();
      syncDeStateSelectValues();
      setCheckboxChecked(config, false);
      return;
    }

    state[config.showField] = false;
    state[config.vectorsField] = [];
    state[config.timesField] = [];
    state[config.currentPairKeyField] = null;
    state[config.autoBaseScaleField] = 1;
    state[config.magnitudeRangeField] = null;
    state[config.isLoadingField] = false;
    setCheckboxChecked(config, false);
  }

  function resetVectorPairData(kind) {
    const config = assertConfig(kind);

    if (kind === 'de') {
      for (const row of getDeRowsArray()) {
        clearDeRowData(row);
      }
      syncDeLoadingFlag();
      syncDeStateSelectValues();
      state[config.currentPairKeyField] = null;
      state[config.vectorsField] = [];
      state[config.timesField] = [];
      state[config.magnitudeRangeField] = null;
      state[config.autoBaseScaleField] = 1;
      if (state[config.availableField] && getStateCount(config) >= 1) {
        config.setRangeLabel(config.labels.notLoaded);
      }
      return;
    }

    state[config.currentPairKeyField] = null;
    state[config.vectorsField] = [];
    state[config.timesField] = [];
    state[config.magnitudeRangeField] = null;
    state[config.autoBaseScaleField] = 1;
    if (state[config.availableField] && getStateCount(config) >= 2) {
      config.setRangeLabel(config.labels.notLoaded);
    }
  }

  function buildVectorOverlayDescriptorGeneric(kind, frameIndex) {
    if (kind === 'de') {
      return buildDeVectorOverlayDescriptor(frameIndex);
    }

    const config = assertConfig(kind);
    if (!state[config.showField] || !state[config.availableField]) return null;

    const vectors = state[config.vectorsField];
    if (!Array.isArray(vectors) || !vectors.length) return null;

    const idx = Number.parseInt(String(frameIndex), 10);
    if (!Number.isFinite(idx) || idx < 0) return null;

    const coordsFrame = Array.isArray(state.currentCoords) ? state.currentCoords[idx] : null;
    const vectorsFrame = vectors[idx];
    if (!Array.isArray(coordsFrame) || !Array.isArray(vectorsFrame)) return null;

    return {
      enabled: true,
      coordsFrame,
      vectorsFrame,
      scale: config.getEffectiveScale(),
      magnitudeRange: state[config.magnitudeRangeField],
      arrowStyle: {
        radius: 0.06,
        radiusRatio: 1.6,
        mid: 0.78,
        fromCap: 1,
        toCap: 1,
      },
    };
  }

  function buildNacVectorOverlayDescriptor(frameIndex) {
    return buildVectorOverlayDescriptorGeneric('nac', frameIndex);
  }

  function buildDeVectorOverlayDescriptor(frameIndex) {
    if (!state.showDeVectors || !state.deAvailable) return null;

    const idx = Number.parseInt(String(frameIndex), 10);
    if (!Number.isFinite(idx) || idx < 0) return null;

    const coordsMaster = Array.isArray(state.currentCoords) ? state.currentCoords[idx] : null;
    if (!Array.isArray(coordsMaster) || !coordsMaster.length) return null;

    const coordsFrame = [];
    const vectorsFrame = [];
    const pairKeysFrame = [];
    const rows = getDeRowsArray();
    for (const row of rows) {
      if (!row?.enabled) continue;
      if (!Array.isArray(row.vectors) || !row.vectors.length) continue;
      const rowVectors = row.vectors[idx];
      if (!Array.isArray(rowVectors)) continue;
      const pairKey = makeLocalDePairKey(row.stateI, row.stateJ);
      const atomCount = Math.min(coordsMaster.length, rowVectors.length);
      for (let atomIdx = 0; atomIdx < atomCount; atomIdx++) {
        coordsFrame.push(coordsMaster[atomIdx]);
        vectorsFrame.push(rowVectors[atomIdx]);
        pairKeysFrame.push(pairKey);
      }
    }

    if (!vectorsFrame.length) return null;

    const userScale = shared.clampDeScale(state.deUserScale);
    const autoScale = Number.isFinite(state.deAutoBaseScale) ? Number(state.deAutoBaseScale) : 1;
    const magnitudeRange = state.deMagnitudeRange;

    return {
      enabled: true,
      coordsFrame,
      vectorsFrame,
      scale: userScale * autoScale,
      magnitudeRange,
      colorForMagnitude: ({ magnitude, atomIndex }) => {
        const vectorIndex = Number.parseInt(String(atomIndex), 10);
        const pairKey = Number.isFinite(vectorIndex) && vectorIndex >= 0 && vectorIndex < pairKeysFrame.length
          ? pairKeysFrame[vectorIndex]
          : '';
        return buildDePairColor(pairKey, magnitude, magnitudeRange);
      },
      arrowStyle: {
        radius: 0.06,
        radiusRatio: 1.6,
        mid: 0.78,
        fromCap: 1,
        toCap: 1,
      },
    };
  }

  function buildDeNacVectorOverlayDescriptor(frameIndex) {
    return buildVectorOverlayDescriptorGeneric('deNac', frameIndex);
  }

  function registerVectorSource(kind) {
    const vectorOverlay = root.vectorOverlay;
    if (!vectorOverlay || typeof vectorOverlay.registerVectorSource !== 'function') return;

    const config = assertConfig(kind);
    vectorOverlay.registerVectorSource(config.sourceId, ({ frameIndex }) => {
      return buildVectorOverlayDescriptorGeneric(kind, frameIndex);
    });
  }

  function registerVectorSources() {
    registerVectorSource('nac');
    registerVectorSource('de');
    registerVectorSource('deNac');
  }

  async function loadVectorPairGeneric(kind, forceReload = false) {
    if (kind === 'de') {
      return loadDePair(forceReload);
    }

    const config = assertConfig(kind);
    const trajId = state.currentTrajId;
    if (!trajId || !state[config.availableField] || getStateCount(config) < 2) {
      return null;
    }

    const resolvedPair = config.resolvePairFromState();
    const stateI = resolvedPair.stateI;
    const stateJ = resolvedPair.stateJ;
    const pairKey = config.makePairKey(trajId, stateI, stateJ);
    const vectors = state[config.vectorsField];

    if (!forceReload && state[config.currentPairKeyField] === pairKey && Array.isArray(vectors) && vectors.length) {
      return {
        traj_id: trajId,
        state_i: stateI,
        state_j: stateJ,
        time: state[config.timesField],
        vectors,
      };
    }

    state[config.isLoadingField] = true;
    shared.setNacControlsEnabled(true);
    shared.setStatus(config.loadingStatus(stateI, stateJ));

    try {
      const record = await config.getRecord(trajId, stateI, stateJ);
      if (!record) {
        throw new Error(config.notFoundError(trajId));
      }
      if (trajId !== state.currentTrajId) {
        return null;
      }

      state[config.vectorsField] = Array.isArray(record.vectors) ? record.vectors : [];
      state[config.timesField] = Array.isArray(record.time) ? record.time : [];
      state[config.currentPairKeyField] = pairKey;

      const stats = resolveMagnitudeStats(kind, state[config.vectorsField]);
      if (stats) {
        state[config.magnitudeRangeField] = { min: stats.colorMin, max: stats.colorMax };
        state[config.autoBaseScaleField] = stats.autoScale;
        config.setRangeLabel(config.formatRangeLabel(stats));
      } else {
        state[config.magnitudeRangeField] = null;
        state[config.autoBaseScaleField] = 1;
        config.setRangeLabel(config.labels.noFinite);
      }
      return record;
    } catch (error) {
      if (trajId === state.currentTrajId) {
        state[config.vectorsField] = [];
        state[config.timesField] = [];
        state[config.currentPairKeyField] = null;
        state[config.magnitudeRangeField] = null;
        state[config.autoBaseScaleField] = 1;
        config.setRangeLabel(config.labels.loadFailed);
      }
      throw error;
    } finally {
      if (trajId === state.currentTrajId) {
        state[config.isLoadingField] = false;
        shared.setNacControlsEnabled(true);
      }
    }
  }

  function loadNacPair(forceReload = false) {
    return loadVectorPairGeneric('nac', forceReload);
  }

  async function loadDeRow(rowId, forceReload = false) {
    const config = assertConfig('de');
    const trajId = state.currentTrajId;
    const row = findDeRowById(rowId);
    if (!row || !trajId || !state.deAvailable || getDeSelectorStateCount() < 1) {
      return null;
    }

    const normalizedPair = transformers.normalizeStatePair(row.stateI, row.stateJ, state.deStateCount);
    row.stateI = normalizedPair.stateI;
    row.stateJ = normalizedPair.stateJ;
    row.lastValidStateI = normalizedPair.stateI;
    row.lastValidStateJ = normalizedPair.stateJ;

    const stateI = row.stateI;
    const stateJ = row.stateJ;
    const pairKey = makeDeRowPairKey(row, trajId);

    if (!forceReload && row.pairKey === pairKey && Array.isArray(row.vectors) && row.vectors.length) {
      syncDeStateSelectValues();
      updateDeMagnitudeStatsFromRows();
      return {
        traj_id: trajId,
        state_i: stateI,
        state_j: stateJ,
        time: row.times,
        vectors: row.vectors,
      };
    }

    row.isLoading = true;
    syncDeLoadingFlag();
    shared.setNacControlsEnabled(true);
    shared.setStatus(config.loadingStatus(stateI, stateJ));

    try {
      const record = await config.getRecord(trajId, stateI, stateJ);
      if (!record) {
        throw new Error(config.notFoundError(trajId));
      }
      if (trajId !== state.currentTrajId) {
        return null;
      }

      row.vectors = Array.isArray(record.vectors) ? record.vectors : [];
      row.times = Array.isArray(record.time) ? record.time : [];
      row.pairKey = pairKey;
      row.lastValidStateI = row.stateI;
      row.lastValidStateJ = row.stateJ;

      syncDeStateSelectValues();
      updateDeMagnitudeStatsFromRows();
      return record;
    } catch (error) {
      if (trajId === state.currentTrajId) {
        clearDeRowData(row);
        syncDeStateSelectValues();
        updateDeMagnitudeStatsFromRows();
      }
      throw error;
    } finally {
      if (trajId === state.currentTrajId) {
        row.isLoading = false;
        syncDeLoadingFlag();
        shared.setNacControlsEnabled(true);
      }
    }
  }

  async function loadDePair(forceReload = false) {
    ensureAtLeastOneDeRow();
    const firstRow = getDeRowsArray()[0] || null;
    if (!firstRow) return null;
    return loadDeRow(firstRow.id, forceReload);
  }

  function loadDeNacPair(forceReload = false) {
    return loadVectorPairGeneric('deNac', forceReload);
  }

  async function loadEnabledDeRows(forceReload = false) {
    const enabledRows = getDeRowsArray().filter((row) => !!row?.enabled);
    let loadedCount = 0;
    const errors = [];

    for (const row of enabledRows) {
      try {
        const record = await loadDeRow(row.id, forceReload);
        if (record) {
          loadedCount += 1;
        }
      } catch (error) {
        errors.push({ row, error });
      }
    }

    return {
      enabledRows,
      loadedCount,
      errors,
    };
  }

  function rerenderCurrentFrame() {
    const viewer = root.viewer;
    if (viewer && typeof viewer.renderFrame === 'function') {
      void viewer.renderFrame(state.currentFrame);
    }
  }

  async function setVectorsVisibleGeneric(kind, enabled) {
    if (kind === 'de') {
      return setDeVectorsVisible(enabled);
    }

    const config = assertConfig(kind);
    const viewer = root.viewer;
    const shouldShow = !!enabled;
    setDesiredVectorVisibility(kind, shouldShow);

    if (!state.currentTrajId || shared.getCurrentFrameCount() <= 0) {
      state[config.showField] = false;
      setCheckboxChecked(config, false);
      return false;
    }

    if (shouldShow) {
      if (!state[config.availableField] || getStateCount(config) < 2) {
        state[config.showField] = false;
        setCheckboxChecked(config, false);
        shared.setNacControlsEnabled(true);
        shared.setStatus(config.unavailableStatus);
        if (viewer && typeof viewer.renderFrame === 'function') void viewer.renderFrame(state.currentFrame);
        return false;
      }
      try {
        await loadVectorPairGeneric(kind, false);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        state[config.showField] = false;
        setCheckboxChecked(config, false);
        shared.setNacControlsEnabled(true);
        shared.setStatus(`Failed to load ${config.label} vectors: ${detail}`, true);
        if (viewer && typeof viewer.renderFrame === 'function') void viewer.renderFrame(state.currentFrame);
        return false;
      }
    }

    state[config.showField] = shouldShow;
    setCheckboxChecked(config, shouldShow);
    shared.setNacControlsEnabled(true);

    if (viewer && typeof viewer.renderFrame === 'function') {
      void viewer.renderFrame(state.currentFrame);
    }
    if (shouldShow) {
      shared.setStatus(config.showingStatus());
    } else {
      shared.setStatus(config.hiddenStatus);
    }
    return true;
  }

  function setNacVectorsVisible(enabled) {
    return setVectorsVisibleGeneric('nac', enabled);
  }

  async function setDeVectorsVisible(enabled) {
    const config = assertConfig('de');
    const shouldShow = !!enabled;
    setDesiredVectorVisibility('de', shouldShow);

    if (!state.currentTrajId || shared.getCurrentFrameCount() <= 0) {
      state.showDeVectors = false;
      setCheckboxChecked(config, false);
      return false;
    }

    if (shouldShow) {
      if (!state.deAvailable || getDeSelectorStateCount() < 1) {
        state.showDeVectors = false;
        setCheckboxChecked(config, false);
        shared.setNacControlsEnabled(true);
        shared.setStatus(config.unavailableStatus);
        rerenderCurrentFrame();
        return false;
      }

      ensureAtLeastOneDeRow();
      normalizeDeRowsForStateCount();
      renderDeRowsUi();

      const { enabledRows, loadedCount, errors } = await loadEnabledDeRows(false);
      if (enabledRows.length > 0 && loadedCount <= 0) {
        const detail = errors.length
          ? (errors[0].error instanceof Error ? errors[0].error.message : String(errors[0].error))
          : 'No enabled dE rows loaded.';
        state.showDeVectors = false;
        setCheckboxChecked(config, false);
        shared.setNacControlsEnabled(true);
        shared.setStatus(`Failed to load dE vectors: ${detail}`, true);
        rerenderCurrentFrame();
        return false;
      }

      if (errors.length > 0) {
        const errRows = errors
          .map(({ row, error }) => `${formatDePair(row.stateI, row.stateJ)}(${error instanceof Error ? error.message : String(error)})`)
          .join('; ');
        shared.setStatus(`Some dE rows failed to load: ${errRows}`, true);
      }
    }

    state.showDeVectors = shouldShow;
    setCheckboxChecked(config, shouldShow);
    updateDeMagnitudeStatsFromRows();
    shared.setNacControlsEnabled(true);
    rerenderCurrentFrame();

    if (shouldShow) {
      shared.setStatus(`Showing dE vectors for states ${describeEnabledDePairs()}.`);
    } else {
      shared.setStatus(config.hiddenStatus);
    }
    return true;
  }

  async function restoreDesiredVectorVisibility() {
    const restored = [];
    const unavailable = [];
    const failed = [];

    const restoreSimpleVector = async (kind) => {
      const config = assertConfig(kind);
      state[config.showField] = false;
      setCheckboxChecked(config, false);

      if (!getDesiredVectorVisibility(kind)) {
        return;
      }
      if (!state[config.availableField] || getStateCount(config) < 2) {
        unavailable.push(config.label);
        return;
      }

      try {
        await loadVectorPairGeneric(kind, false);
        state[config.showField] = true;
        setCheckboxChecked(config, true);
        restored.push(config.label);
      } catch (error) {
        state[config.showField] = false;
        setCheckboxChecked(config, false);
        const detail = error instanceof Error ? error.message : String(error);
        failed.push(`${config.label}(${detail})`);
      }
    };

    await restoreSimpleVector('nac');

    const deConfig = assertConfig('de');
    state.showDeVectors = false;
    setCheckboxChecked(deConfig, false);
    if (getDesiredVectorVisibility('de')) {
      if (!state.deAvailable || getDeSelectorStateCount() < 1) {
        unavailable.push(deConfig.label);
      } else {
        ensureAtLeastOneDeRow();
        normalizeDeRowsForStateCount();
        renderDeRowsUi();

        const { enabledRows, loadedCount, errors } = await loadEnabledDeRows(false);
        if (enabledRows.length > 0 && loadedCount > 0) {
          state.showDeVectors = true;
          setCheckboxChecked(deConfig, true);
          restored.push(deConfig.label);
        } else if (errors.length > 0) {
          deConfig.setRangeLabel(deConfig.labels.loadFailed);
        }

        if (errors.length > 0) {
          const detail = errors
            .map(({ row, error }) => {
              const pair = row ? formatDePair(row.stateI, row.stateJ) : 'unknown';
              const message = error instanceof Error ? error.message : String(error);
              return `${pair}(${message})`;
            })
            .join('; ');
          failed.push(`${deConfig.label}(${detail})`);
        }
        updateDeMagnitudeStatsFromRows();
      }
    }

    await restoreSimpleVector('deNac');
    shared.setNacControlsEnabled(true);

    return { restored, unavailable, failed };
  }

  function setDeNacVectorsVisible(enabled) {
    return setVectorsVisibleGeneric('deNac', enabled);
  }

  function syncNacStateSelectValues() {
    if (dom.nacStateISelect) dom.nacStateISelect.value = String(state.nacStateI);
    if (dom.nacStateJSelect) dom.nacStateJSelect.value = String(state.nacStateJ);
  }

  async function updateNacStatePairFromControls(preferredField = 'j') {
    const selectorStateCount = getNacPairSelectorStateCount();
    if (selectorStateCount < 2) {
      return;
    }

    const rawI = dom.nacStateISelect ? dom.nacStateISelect.value : state.nacStateI;
    const rawJ = dom.nacStateJSelect ? dom.nacStateJSelect.value : state.nacStateJ;
    const normalizedPair = transformers.normalizeDistinctStatePair(
      rawI,
      rawJ,
      selectorStateCount,
      preferredField
    );
    state.nacStateI = normalizedPair.stateI;
    state.nacStateJ = normalizedPair.stateJ;
    syncNacStateSelectValues();

    if (state.nacAvailable && parseStateCount(state.nacStateCount) >= 2) {
      resetVectorPairData('nac');
    }
    if (state.deNacAvailable && parseStateCount(state.deNacStateCount) >= 2) {
      resetVectorPairData('deNac');
    }

    const shouldReloadNac = !!state.showNacVectors && !!state.nacAvailable && parseStateCount(state.nacStateCount) >= 2;
    const shouldReloadDeNac = !!state.showDeNacVectors && !!state.deNacAvailable && parseStateCount(state.deNacStateCount) >= 2;
    if (!shouldReloadNac && !shouldReloadDeNac) {
      shared.setNacControlsEnabled(true);
      shared.setStatus(`Vector state pair set to ${state.nacStateI}-${state.nacStateJ}.`);
      return;
    }

    let nacError = '';
    let deNacError = '';

    if (shouldReloadNac) {
      try {
        await loadVectorPairGeneric('nac', true);
      } catch (error) {
        nacError = error instanceof Error ? error.message : String(error);
        state.showNacVectors = false;
        setCheckboxChecked(assertConfig('nac'), false);
      }
    }

    if (shouldReloadDeNac) {
      try {
        await loadVectorPairGeneric('deNac', true);
      } catch (error) {
        deNacError = error instanceof Error ? error.message : String(error);
        state.showDeNacVectors = false;
        setCheckboxChecked(assertConfig('deNac'), false);
      }
    }

    shared.setNacControlsEnabled(true);
    rerenderCurrentFrame();

    if (nacError && deNacError) {
      shared.setStatus(`Failed to update vectors: NAC(${nacError}); dE*NAC(${deNacError})`, true);
      return;
    }
    if (nacError) {
      shared.setStatus(`Failed to update NAC vectors: ${nacError}`, true);
      return;
    }
    if (deNacError) {
      shared.setStatus(`Failed to update dE*NAC vectors: ${deNacError}`, true);
      return;
    }

    if (shouldReloadNac && shouldReloadDeNac) {
      shared.setStatus(`Updated NAC and dE*NAC vectors to states ${state.nacStateI}-${state.nacStateJ}.`);
    } else if (shouldReloadNac) {
      shared.setStatus(`Updated NAC vectors to states ${state.nacStateI}-${state.nacStateJ}.`);
    } else {
      shared.setStatus(`Updated dE*NAC vectors to states ${state.nacStateI}-${state.nacStateJ}.`);
    }
  }

  async function updateDeRowPair(rowId, preferredField = 'j') {
    void preferredField;

    const selectorStateCount = getDeSelectorStateCount();
    if (selectorStateCount < 1) {
      return false;
    }

    const control = resolveDeRowControls(rowId);
    if (!control) {
      return false;
    }

    const { row, rawI, rawJ } = control;
    const normalizedPair = transformers.normalizeStatePair(rawI, rawJ, selectorStateCount);
    if (isDuplicateDePair(row.id, normalizedPair.stateI, normalizedPair.stateJ)) {
      row.stateI = row.lastValidStateI;
      row.stateJ = row.lastValidStateJ;
      renderDeRowsUi();
      shared.setNacControlsEnabled(true);
      shared.setStatus('Duplicate pair not allowed for dE rows.', true);
      return false;
    }

    const pairChanged = row.stateI !== normalizedPair.stateI || row.stateJ !== normalizedPair.stateJ;
    row.stateI = normalizedPair.stateI;
    row.stateJ = normalizedPair.stateJ;
    row.lastValidStateI = normalizedPair.stateI;
    row.lastValidStateJ = normalizedPair.stateJ;

    if (pairChanged) {
      clearDeRowData(row);
    }

    syncDeStateSelectValues();
    renderDeRowsUi();

    if (state.showDeVectors && state.deAvailable && row.enabled) {
      try {
        await loadDeRow(row.id, true);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        shared.setNacControlsEnabled(true);
        rerenderCurrentFrame();
        shared.setStatus(`Failed to update dE row ${formatDePair(row.stateI, row.stateJ)}: ${detail}`, true);
        return false;
      }

      updateDeMagnitudeStatsFromRows();
      shared.setNacControlsEnabled(true);
      rerenderCurrentFrame();
      shared.setStatus(`Updated dE row to states ${formatDePair(row.stateI, row.stateJ)}.`);
      return true;
    }

    updateDeMagnitudeStatsFromRows();
    shared.setNacControlsEnabled(true);
    rerenderCurrentFrame();
    shared.setStatus(`dE row state pair set to ${formatDePair(row.stateI, row.stateJ)}.`);
    return true;
  }

  async function updateDeStatePairFromControls(preferredField = 'j') {
    ensureAtLeastOneDeRow();
    const firstRow = getDeRowsArray()[0] || null;
    if (!firstRow) {
      return false;
    }
    return updateDeRowPair(firstRow.id, preferredField);
  }

  async function addDeRow() {
    if (!state.deAvailable || getDeSelectorStateCount() < 1) {
      shared.setStatus('dE vectors are unavailable for this trajectory.', true);
      return false;
    }

    ensureAtLeastOneDeRow();
    const used = getUsedDePairKeys();
    const next = findNextUnusedDePair(getDeSelectorStateCount(), used);
    if (!next) {
      shared.setStatus('All pairs already added for dE rows.');
      return false;
    }

    const row = createDeRow(next.stateI, next.stateJ, true);
    getDeRowsArray().push(row);
    syncDeStateSelectValues();
    renderDeRowsUi();
    shared.setNacControlsEnabled(true);
    shared.setStatus(`Added dE row ${formatDePair(row.stateI, row.stateJ)}.`);

    if (state.showDeVectors) {
      try {
        await loadDeRow(row.id, false);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        shared.setNacControlsEnabled(true);
        rerenderCurrentFrame();
        shared.setStatus(`Failed to load new dE row ${formatDePair(row.stateI, row.stateJ)}: ${detail}`, true);
        return false;
      }
      updateDeMagnitudeStatsFromRows();
      rerenderCurrentFrame();
    }

    return true;
  }

  async function removeDeRow(rowId) {
    const rows = getDeRowsArray();
    const idx = findDeRowIndexById(rowId);
    if (idx < 0) {
      return false;
    }

    const selectorStateCount = getDeSelectorStateCount();
    if (rows.length <= 1) {
      const row = rows[0];
      const defaultPair = transformers.normalizeStatePair(0, 0, selectorStateCount);
      row.enabled = true;
      row.stateI = defaultPair.stateI;
      row.stateJ = defaultPair.stateJ;
      row.lastValidStateI = defaultPair.stateI;
      row.lastValidStateJ = defaultPair.stateJ;
      clearDeRowData(row);
      syncDeStateSelectValues();
      renderDeRowsUi();

      if (state.showDeVectors && state.deAvailable) {
        try {
          await loadDeRow(row.id, false);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          shared.setNacControlsEnabled(true);
          rerenderCurrentFrame();
          shared.setStatus(`Failed to reload default dE row: ${detail}`, true);
          return false;
        }
      }

      updateDeMagnitudeStatsFromRows();
      shared.setNacControlsEnabled(true);
      rerenderCurrentFrame();
      shared.setStatus(`Reset last dE row to ${formatDePair(row.stateI, row.stateJ)}.`);
      return true;
    }

    const removed = rows[idx];
    rows.splice(idx, 1);
    syncDeStateSelectValues();
    renderDeRowsUi();
    updateDeMagnitudeStatsFromRows();
    shared.setNacControlsEnabled(true);
    rerenderCurrentFrame();
    shared.setStatus(`Removed dE row ${formatDePair(removed.stateI, removed.stateJ)}.`);
    return true;
  }

  async function toggleDeRowEnabled(rowId, enabled) {
    const row = findDeRowById(rowId);
    if (!row) {
      return false;
    }

    row.enabled = !!enabled;
    renderDeRowsUi();

    if (state.showDeVectors && row.enabled && state.deAvailable) {
      try {
        await loadDeRow(row.id, false);
      } catch (error) {
        row.enabled = false;
        renderDeRowsUi();
        const detail = error instanceof Error ? error.message : String(error);
        shared.setNacControlsEnabled(true);
        rerenderCurrentFrame();
        shared.setStatus(`Failed to enable dE row ${formatDePair(row.stateI, row.stateJ)}: ${detail}`, true);
        return false;
      }
    }

    updateDeMagnitudeStatsFromRows();
    shared.setNacControlsEnabled(true);
    rerenderCurrentFrame();
    shared.setStatus(`dE row ${formatDePair(row.stateI, row.stateJ)} ${row.enabled ? 'enabled' : 'disabled'}.`);
    return true;
  }

  function applyTrajectoryNacMeta(record) {
    state.nacAvailable = !!record?.nac_available;
    state.nacStateCount = parseStateCount(record?.nac_state_count);
    state.nacComponentCount = parseStateCount(record?.nac_component_count);

    state.deAvailable = !!record?.de_available;
    state.deStateCount = parseStateCount(record?.de_state_count);
    state.deComponentCount = parseStateCount(record?.de_component_count);
    state.deGlobalNormScope = typeof record?.de_global_norm_scope === 'string' ? record.de_global_norm_scope : '';
    state.deGlobalNormP5 = Number.isFinite(Number(record?.de_global_norm_p5)) ? Number(record.de_global_norm_p5) : null;
    state.deGlobalNormP90 = Number.isFinite(Number(record?.de_global_norm_p90)) ? Number(record.de_global_norm_p90) : null;
    state.deGlobalNormP95 = Number.isFinite(Number(record?.de_global_norm_p95)) ? Number(record.de_global_norm_p95) : null;
    state.deGlobalNormCount = parseStateCount(record?.de_global_norm_count);

    state.deNacAvailable = !!record?.de_nac_available;
    state.deNacStateCount = parseStateCount(record?.de_nac_state_count);
    state.deNacComponentCount = parseStateCount(record?.de_nac_component_count);

    resetVectorOverlayState('nac');
    resetVectorOverlayState('de');
    resetVectorOverlayState('deNac');

    const nacSelectorStateCount = getNacPairSelectorStateCount();
    const deSelectorStateCount = getDeSelectorStateCount();

    populateNacStateOptions(nacSelectorStateCount);
    populateDeStateOptions(deSelectorStateCount);

    const normalizedNacPair = transformers.normalizeDistinctStatePair(state.nacStateI, state.nacStateJ, nacSelectorStateCount, 'j');
    state.nacStateI = normalizedNacPair.stateI;
    state.nacStateJ = normalizedNacPair.stateJ;
    syncNacStateSelectValues();

    normalizeDeRowsForStateCount();
    syncDeStateSelectValues();
    renderDeRowsUi();

    if (!state.nacAvailable || parseStateCount(state.nacStateCount) < 2) {
      shared.setNacRangeLabel(assertConfig('nac').labels.unavailable);
    } else {
      shared.setNacRangeLabel(assertConfig('nac').labels.notLoaded);
    }

    if (!state.deAvailable || parseStateCount(state.deStateCount) < 1) {
      shared.setDeRangeLabel(assertConfig('de').labels.unavailable);
    } else {
      shared.setDeRangeLabel(assertConfig('de').labels.notLoaded);
    }

    if (!state.deNacAvailable || parseStateCount(state.deNacStateCount) < 2) {
      shared.setDeNacRangeLabel(assertConfig('deNac').labels.unavailable);
    } else {
      shared.setDeNacRangeLabel(assertConfig('deNac').labels.notLoaded);
    }

    shared.setNacControlsEnabled(nacSelectorStateCount >= 2 || deSelectorStateCount >= 1);
  }

  function clearVectorViewState() {
    state.nacAvailable = false;
    state.nacStateCount = 0;
    state.nacComponentCount = 0;

    state.deAvailable = false;
    state.deStateCount = 0;
    state.deComponentCount = 0;
    state.deGlobalNormScope = '';
    state.deGlobalNormP5 = null;
    state.deGlobalNormP90 = null;
    state.deGlobalNormP95 = null;
    state.deGlobalNormCount = 0;

    state.deNacAvailable = false;
    state.deNacStateCount = 0;
    state.deNacComponentCount = 0;

    resetVectorOverlayState('nac');
    resetVectorOverlayState('de');
    resetVectorOverlayState('deNac');

    shared.syncNacScaleUi();
    shared.syncDeScaleUi();
    shared.syncDeNacScaleUi();

    shared.setNacRangeLabel('|NAC|: n/a');
    shared.setDeRangeLabel('|dE|: n/a');
    shared.setDeNacRangeLabel('|dE*NAC|: n/a');
    shared.setNacControlsEnabled(false);
  }

  root.ioVectorOps = {
    VECTOR_KIND_CONFIG,
    assertConfig,
    getPairSelectorStateCount,
    getNacPairSelectorStateCount,
    getDeSelectorStateCount,
    populateNacStateOptions,
    populateDeStateOptions,
    syncNacStateSelectValues,
    syncDeStateSelectValues,
    resetNacStateSelection,
    resetDeStateSelection,
    makeDeRowId,
    makeDeRowPairKey,
    findNextUnusedDePair,
    isDuplicateDePair,
    ensureAtLeastOneDeRow,
    renderDeRowsUi,
    resetVectorOverlayState,
    resetVectorPairData,
    buildVectorOverlayDescriptorGeneric,
    buildNacVectorOverlayDescriptor,
    buildDeVectorOverlayDescriptor,
    buildDeNacVectorOverlayDescriptor,
    registerVectorSource,
    registerVectorSources,
    loadVectorPairGeneric,
    loadNacPair,
    loadDePair,
    loadDeRow,
    loadDeNacPair,
    setVectorsVisibleGeneric,
    setNacVectorsVisible,
    setDeVectorsVisible,
    setDeNacVectorsVisible,
    restoreDesiredVectorVisibility,
    updateNacStatePairFromControls,
    updateDeStatePairFromControls,
    addDeRow,
    removeDeRow,
    toggleDeRowEnabled,
    updateDeRowPair,
    applyTrajectoryNacMeta,
    clearVectorViewState,
  };
})();
