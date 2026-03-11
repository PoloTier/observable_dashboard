(function () {
  const root = window.ObservableDashboard || (window.ObservableDashboard = {});
  const shared = root.shared;
  const plot = root.plot;
  const dataLoader = root.dataLoader;
  if (!shared || !plot || !dataLoader) return;

  const {
    meta,
    defaults,
    trajIds,
    datasetLoaded,
    state,
    STORAGE_KEY,
    MIN_PANELS,
    observableOptions,
    ensembleStatModes,
    hoppingAlgorithmOptions,
    hoppingTimeRuleOptions,
    normalizeRawKeyAliases,
    makeRawAliasObservable,
    rawAliasFromObservable,
    isRawObservable,
    resolveRawKeyForPanel,
    requiredIndexCount,
    normalizePanel,
    normalizeHoppingConfig,
    defaultPanelForIndex,
    makeDefaultPanels,
    defaultHoppingGroupForIndex,
    buildDefaultHoppingConfig,
    saveStateToStorage,
    setGlobalStatus,
  } = shared;
  const INSPECTOR_STORAGE_KEY = 'traj_dashboard_key_inspector_v1';
  const INSPECTOR_MAX_KEYS = 200;
  const EXPR_INSPECTOR_INPUT_STORAGE_KEY = 'traj_dashboard_expression_input_v1';
  const EXPR_INSPECTOR_LABEL_STORAGE_KEY = 'traj_dashboard_expression_label_v1';
  const EXPR_PREVIEW_LIMIT = 12;
  const PANEL_ROW_LAYOUT_STORAGE_KEY = 'traj_dashboard_panel_row_layout_v1';
  const PANEL_PRESET_KIND = 'observable_dashboard_panel_preset';
  const PANEL_PRESET_SCHEMA_VERSION = 2;
  const HEADER_SECTION_KEYS = ['summary', 'inspector', 'hopping'];
  let draggingPanelIndex = -1;
  let draggingPanelRef = null;
  let panelRows = [];
  let activeHeaderSectionKey = 'summary';

  function clearDashboardStorageForDatasetSwitch() {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore storage failures
    }
    try {
      localStorage.removeItem(PANEL_ROW_LAYOUT_STORAGE_KEY);
    } catch {
      // ignore storage failures
    }
  }

  function getHeaderSectionElement(sectionKey) {
    if (sectionKey === 'summary') return document.getElementById('dashboard-summary-section');
    if (sectionKey === 'inspector') return document.getElementById('dashboard-inspector-section');
    if (sectionKey === 'hopping') return document.getElementById('dashboard-hopping-section');
    return null;
  }

  function getHeaderSectionTabElement(sectionKey) {
    if (sectionKey === 'summary') return document.getElementById('dashboard-top-tab-summary');
    if (sectionKey === 'inspector') return document.getElementById('dashboard-top-tab-inspector');
    if (sectionKey === 'hopping') return document.getElementById('dashboard-top-tab-hopping');
    return null;
  }

  function normalizeHeaderSectionKey(sectionKey) {
    const text = String(sectionKey || '').trim();
    return HEADER_SECTION_KEYS.includes(text) ? text : '';
  }

  function syncHeaderSectionUi() {
    const currentKey = normalizeHeaderSectionKey(activeHeaderSectionKey);
    for (const sectionKey of HEADER_SECTION_KEYS) {
      const sectionEl = getHeaderSectionElement(sectionKey);
      const tabEl = getHeaderSectionTabElement(sectionKey);
      const isActive = sectionKey === currentKey;
      if (sectionEl) {
        sectionEl.hidden = !isActive;
        sectionEl.setAttribute('aria-hidden', isActive ? 'false' : 'true');
      }
      if (tabEl) {
        tabEl.classList.toggle('is-active', isActive);
        tabEl.setAttribute('aria-expanded', isActive ? 'true' : 'false');
        tabEl.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      }
    }
  }

  function setHeaderSectionOpen(sectionKey, open = true) {
    const normalizedSectionKey = normalizeHeaderSectionKey(sectionKey);
    if (!normalizedSectionKey) return false;
    if (open) {
      activeHeaderSectionKey = normalizedSectionKey;
    } else if (activeHeaderSectionKey === normalizedSectionKey) {
      activeHeaderSectionKey = '';
    }
    syncHeaderSectionUi();
    return true;
  }

  function getHeaderSectionOpen(sectionKey) {
    return activeHeaderSectionKey === normalizeHeaderSectionKey(sectionKey);
  }

  function bindHeaderSectionToggles() {
    for (const sectionKey of HEADER_SECTION_KEYS) {
      const tabEl = getHeaderSectionTabElement(sectionKey);
      if (!(tabEl instanceof HTMLElement)) continue;
      if (tabEl.dataset.headerSectionBound === '1') continue;
      tabEl.addEventListener('click', () => {
        const isOpen = getHeaderSectionOpen(sectionKey);
        setHeaderSectionOpen(sectionKey, !isOpen);
      });
      tabEl.dataset.headerSectionBound = '1';
    }
  }

  function transitionKeyForGroup(group) {
    return `${Number.parseInt(group?.fromState, 10)}->${Number.parseInt(group?.toState, 10)}`;
  }

  function enabledHoppingGroups() {
    const groups = Array.isArray(state?.hopping?.groups) ? state.hopping.groups : [];
    return groups.filter((group) => {
      if (!group || group.enabled === false) return false;
      const fromState = Number.parseInt(group.fromState, 10);
      const toState = Number.parseInt(group.toState, 10);
      return Number.isFinite(fromState) && Number.isFinite(toState) && fromState >= 0 && toState >= 0 && fromState !== toState;
    });
  }

  function currentHoppingTrajIds() {
    if (state.selectedTraj === 'all') return trajIds.slice();
    return trajIds.includes(String(state.selectedTraj || '')) ? [String(state.selectedTraj)] : [];
  }

  function hoppingAlgorithmLabel(algorithm) {
    return String(algorithm) === 'max_abs_c' ? 'max |c|' : String(algorithm || '');
  }

  function hoppingTimeRuleLabel(timeRule) {
    return String(timeRule) === 'arrival_frame' ? 'Arrival frame t[k+1]' : String(timeRule || '');
  }

  function setHoppingStatus(message, isError = false) {
    const statusEl = document.getElementById('hopping-status');
    if (!statusEl) return;
    statusEl.textContent = String(message || '');
    statusEl.classList.toggle('error', !!isError);
  }

  function renderHoppingGroupRows() {
    const mountEl = document.getElementById('hopping-groups');
    if (!mountEl) return;
    mountEl.innerHTML = '';

    const groups = Array.isArray(state?.hopping?.groups) ? state.hopping.groups : [];
    if (!groups.length) {
      const emptyEl = document.createElement('div');
      emptyEl.className = 'hopping-group-empty';
      emptyEl.textContent = 'No hop groups configured. Add a transition such as 1 -> 0.';
      mountEl.appendChild(emptyEl);
      return;
    }

    for (let index = 0; index < groups.length; index++) {
      const group = groups[index];
      const row = document.createElement('div');
      row.className = 'hopping-group-row';
      row.innerHTML = `
        <label class="hopping-group-toggle">
          <input type="checkbox" id="hopping-group-enabled-${index}" />
          Enabled
        </label>
        <label class="hopping-group-toggle">
          from
          <input type="number" id="hopping-group-from-${index}" min="0" step="1" />
        </label>
        <label class="hopping-group-toggle">
          to
          <input type="number" id="hopping-group-to-${index}" min="0" step="1" />
        </label>
        <input type="color" id="hopping-group-color-${index}" class="hopping-group-color" />
        <div class="hopping-group-label" id="hopping-group-label-${index}"></div>
        <div class="hopping-group-label">${hoppingAlgorithmLabel(state?.hopping?.algorithm)}</div>
        <button class="btn danger" id="hopping-group-remove-${index}" type="button">Remove</button>
      `;

      const enabledInput = row.querySelector(`#hopping-group-enabled-${index}`);
      const fromInput = row.querySelector(`#hopping-group-from-${index}`);
      const toInput = row.querySelector(`#hopping-group-to-${index}`);
      const colorInput = row.querySelector(`#hopping-group-color-${index}`);
      const labelEl = row.querySelector(`#hopping-group-label-${index}`);
      const removeBtn = row.querySelector(`#hopping-group-remove-${index}`);

      function syncLabel() {
        if (!labelEl) return;
        const fromValue = Number.parseInt(fromInput?.value, 10);
        const toValue = Number.parseInt(toInput?.value, 10);
        labelEl.textContent = Number.isFinite(fromValue) && Number.isFinite(toValue)
          ? `${fromValue} -> ${toValue}`
          : transitionKeyForGroup(group);
      }

      if (enabledInput) enabledInput.checked = group.enabled !== false;
      if (fromInput) fromInput.value = String(group.fromState);
      if (toInput) toInput.value = String(group.toState);
      if (colorInput) colorInput.value = String(group.color || '#d62728');
      syncLabel();

      enabledInput?.addEventListener('change', () => {
        group.enabled = enabledInput.checked;
        setHoppingStatus('Config updated. Click Apply Hopping to recompute.');
        saveStateToStorage();
      });
      fromInput?.addEventListener('input', () => {
        group.fromState = Number.parseInt(fromInput.value, 10);
        syncLabel();
        setHoppingStatus('Config updated. Click Apply Hopping to recompute.');
        saveStateToStorage();
      });
      toInput?.addEventListener('input', () => {
        group.toState = Number.parseInt(toInput.value, 10);
        syncLabel();
        setHoppingStatus('Config updated. Click Apply Hopping to recompute.');
        saveStateToStorage();
      });
      colorInput?.addEventListener('input', () => {
        group.color = String(colorInput.value || '#d62728');
        setHoppingStatus('Config updated. Click Apply Hopping to recompute.');
        saveStateToStorage();
      });
      removeBtn?.addEventListener('click', () => {
        state.hopping.groups.splice(index, 1);
        state.hopping = normalizeHoppingConfig(state.hopping);
        renderHoppingGroupRows();
        setHoppingStatus('Config updated. Click Apply Hopping to recompute.');
        saveStateToStorage();
      });

      mountEl.appendChild(row);
    }
  }

  function renderHoppingSummaryTable(record, activeGroups) {
    const mountEl = document.getElementById('hopping-summary');
    if (!mountEl) return;
    mountEl.innerHTML = '';

    const groups = Array.isArray(activeGroups) ? activeGroups : [];
    if (!groups.length) return;

    const metaEl = document.createElement('div');
    metaEl.className = 'inspector-key-actions-title';
    metaEl.textContent = (
      `algorithm=${hoppingAlgorithmLabel(record?.algorithm)}; `
      + `time_rule=${hoppingTimeRuleLabel(record?.time_rule)}; `
      + `traj_count=${Array.isArray(record?.traj_ids) ? record.traj_ids.length : 0}`
    );
    mountEl.appendChild(metaEl);

    const counts = new Map();
    const countItems = Array.isArray(record?.counts_by_traj) ? record.counts_by_traj : [];
    for (const item of countItems) {
      counts.set(`${item.traj_id}::${item.transition_key}`, Number(item.count) || 0);
    }
    const totals = new Map();
    const totalsItems = Array.isArray(record?.totals_by_transition) ? record.totals_by_transition : [];
    for (const item of totalsItems) {
      totals.set(String(item.transition_key || ''), Number(item.count) || 0);
    }

    const table = document.createElement('table');
    table.className = 'inspector-table';
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    const trajHead = document.createElement('th');
    trajHead.textContent = 'traj_id';
    headRow.appendChild(trajHead);
    for (const group of groups) {
      const th = document.createElement('th');
      th.textContent = transitionKeyForGroup(group);
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    const rowTrajIds = Array.isArray(record?.traj_ids) ? record.traj_ids : [];
    for (const trajId of rowTrajIds) {
      const tr = document.createElement('tr');
      const trajTd = document.createElement('td');
      const trajCode = document.createElement('code');
      trajCode.textContent = String(trajId);
      trajTd.appendChild(trajCode);
      tr.appendChild(trajTd);
      for (const group of groups) {
        const td = document.createElement('td');
        const key = transitionKeyForGroup(group);
        td.textContent = String(counts.get(`${trajId}::${key}`) || 0);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }

    const totalRow = document.createElement('tr');
    const totalLabel = document.createElement('td');
    totalLabel.textContent = 'total';
    totalRow.appendChild(totalLabel);
    for (const group of groups) {
      const td = document.createElement('td');
      td.textContent = String(totals.get(transitionKeyForGroup(group)) || 0);
      totalRow.appendChild(td);
    }
    tbody.appendChild(totalRow);
    table.appendChild(tbody);
    mountEl.appendChild(table);
  }

  async function renderHoppingSummary() {
    const mountEl = document.getElementById('hopping-summary');
    if (!mountEl) return;

    const hasDataset = !!datasetLoaded && trajIds.length > 0;
    if (!hasDataset) {
      mountEl.innerHTML = '';
      setHoppingStatus('Load a dataset to inspect hopping events.');
      return;
    }

    const activeGroups = enabledHoppingGroups();
    if (!activeGroups.length) {
      mountEl.innerHTML = '';
      setHoppingStatus('No enabled hopping groups. Add a hop and click Apply Hopping.');
      return;
    }

    const selectedTrajIds = currentHoppingTrajIds();
    if (!selectedTrajIds.length) {
      mountEl.innerHTML = '';
      setHoppingStatus('No trajectory selected for hopping summary.', true);
      return;
    }

    setHoppingStatus('Computing hopping summary...');
    try {
      const transitions = activeGroups.map((group) => ({
        from_state: group.fromState,
        to_state: group.toState,
      }));
      await dataLoader.ensureHoppingEvents(
        selectedTrajIds,
        state?.hopping?.algorithm,
        state?.hopping?.timeRule,
        transitions
      );
      const record = dataLoader.getHoppingEvents(
        selectedTrajIds,
        state?.hopping?.algorithm,
        state?.hopping?.timeRule,
        transitions
      );
      if (!record) {
        mountEl.innerHTML = '';
        setHoppingStatus('No hopping data returned for the current selection.', true);
        return;
      }
      renderHoppingSummaryTable(record, activeGroups);
      const totalEventCount = (Array.isArray(record.totals_by_transition) ? record.totals_by_transition : [])
        .reduce((sum, item) => sum + (Number(item?.count) || 0), 0);
      setHoppingStatus(`Computed ${totalEventCount} hopping events for ${selectedTrajIds.length} trajectory(s).`);
    } catch (error) {
      mountEl.innerHTML = '';
      const detail = error instanceof Error ? error.message : String(error);
      setHoppingStatus(detail, true);
    }
  }

  async function applyHoppingConfig() {
    state.hopping = normalizeHoppingConfig(state.hopping);
    renderHoppingGroupRows();
    saveStateToStorage();
    await renderHoppingSummary();
    await plot.renderAllPanels();
  }

  function initHoppingModule() {
    const algorithmSelect = document.getElementById('hopping-algorithm');
    const timeRuleSelect = document.getElementById('hopping-time-rule');
    const addBtn = document.getElementById('hopping-add-group');
    const applyBtn = document.getElementById('hopping-apply');
    if (!(algorithmSelect instanceof HTMLSelectElement) || !(timeRuleSelect instanceof HTMLSelectElement)) return;
    const hasDataset = !!datasetLoaded && trajIds.length > 0;

    algorithmSelect.innerHTML = '';
    for (const algorithm of hoppingAlgorithmOptions) {
      const opt = document.createElement('option');
      opt.value = algorithm;
      opt.textContent = hoppingAlgorithmLabel(algorithm);
      algorithmSelect.appendChild(opt);
    }
    timeRuleSelect.innerHTML = '';
    for (const timeRule of hoppingTimeRuleOptions) {
      const opt = document.createElement('option');
      opt.value = timeRule;
      opt.textContent = hoppingTimeRuleLabel(timeRule);
      timeRuleSelect.appendChild(opt);
    }

    state.hopping = normalizeHoppingConfig(state.hopping);
    algorithmSelect.value = state.hopping.algorithm;
    timeRuleSelect.value = state.hopping.timeRule;
    algorithmSelect.disabled = !hasDataset;
    timeRuleSelect.disabled = !hasDataset;
    if (addBtn) addBtn.disabled = !hasDataset;
    if (applyBtn) applyBtn.disabled = !hasDataset;
    renderHoppingGroupRows();

    if (algorithmSelect.dataset.hoppingBound !== '1') {
      algorithmSelect.addEventListener('change', () => {
        state.hopping.algorithm = algorithmSelect.value;
        setHoppingStatus('Config updated. Click Apply Hopping to recompute.');
        saveStateToStorage();
      });
      algorithmSelect.dataset.hoppingBound = '1';
    }
    if (timeRuleSelect.dataset.hoppingBound !== '1') {
      timeRuleSelect.addEventListener('change', () => {
        state.hopping.timeRule = timeRuleSelect.value;
        setHoppingStatus('Config updated. Click Apply Hopping to recompute.');
        saveStateToStorage();
      });
      timeRuleSelect.dataset.hoppingBound = '1';
    }
    if (addBtn && addBtn.dataset.hoppingBound !== '1') {
      addBtn.addEventListener('click', () => {
        const nextIndex = Array.isArray(state?.hopping?.groups) ? state.hopping.groups.length : 0;
        state.hopping.groups.push(defaultHoppingGroupForIndex(nextIndex));
        state.hopping = normalizeHoppingConfig(state.hopping);
        renderHoppingGroupRows();
        setHoppingStatus('Config updated. Click Apply Hopping to recompute.');
        saveStateToStorage();
      });
      addBtn.dataset.hoppingBound = '1';
    }
    if (applyBtn && applyBtn.dataset.hoppingBound !== '1') {
      applyBtn.addEventListener('click', async () => {
        if (applyBtn.disabled) return;
        applyBtn.disabled = true;
        try {
          await applyHoppingConfig();
        } finally {
          applyBtn.disabled = false;
        }
      });
      applyBtn.dataset.hoppingBound = '1';
    }

    void renderHoppingSummary();
  }

  function loadSavedPanelRowLayout() {
    try {
      const raw = localStorage.getItem(PANEL_ROW_LAYOUT_STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      const out = [];
      for (const value of parsed) {
        const n = Number.parseInt(value, 10);
        if (!Number.isFinite(n) || n <= 0) continue;
        out.push(n);
      }
      return out;
    } catch {
      return [];
    }
  }

  function buildRowsFromLayout(panels, rowSizes) {
    const panelList = Array.isArray(panels) ? panels : [];
    if (!panelList.length) return [];
    if (!Array.isArray(rowSizes) || !rowSizes.length) return [panelList.slice()];
    if (rowSizes.reduce((acc, n) => acc + n, 0) !== panelList.length) return [panelList.slice()];

    const rows = [];
    let cursor = 0;
    for (const size of rowSizes) {
      rows.push(panelList.slice(cursor, cursor + size));
      cursor += size;
    }
    return rows.length ? rows : [panelList.slice()];
  }

  function savePanelRowLayout(rows) {
    try {
      const sizes = Array.isArray(rows)
        ? rows
            .map((row) => (Array.isArray(row) ? row.length : 0))
            .filter((count) => count > 0)
        : [];
      localStorage.setItem(PANEL_ROW_LAYOUT_STORAGE_KEY, JSON.stringify(sizes));
    } catch {
      // ignore storage failures
    }
  }

  function currentPanelRowLayout() {
    syncPanelRowsWithState();
    return panelRows
      .map((row) => (Array.isArray(row) ? row.length : 0))
      .filter((count) => count > 0);
  }

  function triggerJsonDownload(fileName, payload) {
    const text = JSON.stringify(payload, null, 2);
    const blob = new Blob([`${text}\n`], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  }

  function exportPanelPreset() {
    const rowLayout = currentPanelRowLayout();
    const sourcePkl = String(meta?.source_pkl || '');
    const payload = {
      kind: PANEL_PRESET_KIND,
      schema_version: PANEL_PRESET_SCHEMA_VERSION,
      exported_at: new Date().toISOString(),
      source_pkl: sourcePkl || null,
      selected_traj: String(state.selectedTraj || 'all'),
      show_ensemble: !!state.showEnsemble,
      show_all_traces: !!state.showAllTraces,
      hopping: normalizeHoppingConfig(state.hopping),
      panels: Array.isArray(state.panels)
        ? state.panels.map((panel, index) => normalizePanel(panel, index))
        : [],
      panel_row_layout: rowLayout,
      raw_key_aliases: normalizeRawKeyAliases(state.rawKeyAliases),
    };
    const sourceName = sourcePkl.split(/[\\/]/).pop() || 'dashboard';
    const safeName = sourceName.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'dashboard';
    triggerJsonDownload(`${safeName}_panel_preset.json`, payload);
    setGlobalStatus(`Exported ${payload.panels.length} panel settings.`);
  }

  function normalizeImportedPanelPreset(rawPreset) {
    if (!rawPreset || typeof rawPreset !== 'object') {
      throw new Error('Preset file is not a JSON object.');
    }

    const kind = String(rawPreset.kind || '');
    if (kind && kind !== PANEL_PRESET_KIND) {
      throw new Error(`Unsupported preset kind: ${kind}`);
    }

    const rawPanels = Array.isArray(rawPreset.panels) ? rawPreset.panels : [];
    if (!rawPanels.length) {
      throw new Error('Preset contains no panels.');
    }

    const panels = rawPanels.map((panel, index) => normalizePanel(panel, index));
    const selectedTrajCandidate = String(rawPreset.selected_traj ?? rawPreset.selectedTraj ?? 'all');
    const selectedTraj = selectedTrajCandidate === 'all' || trajIds.includes(selectedTrajCandidate)
      ? selectedTrajCandidate
      : 'all';
    const showEnsemble = typeof rawPreset.show_ensemble === 'boolean'
      ? rawPreset.show_ensemble
      : (typeof rawPreset.showEnsemble === 'boolean' ? rawPreset.showEnsemble : !!defaults?.plot?.show_ensemble_by_default);
    const showAllTraces = typeof rawPreset.show_all_traces === 'boolean'
      ? rawPreset.show_all_traces
      : (typeof rawPreset.showAllTraces === 'boolean'
        ? rawPreset.showAllTraces
        : !!defaults?.plot?.show_all_traces_in_all_mode);
    const rowLayoutRaw = rawPreset.panel_row_layout ?? rawPreset.panelRowLayout ?? [];
    const panelRowLayout = Array.isArray(rowLayoutRaw)
      ? rowLayoutRaw
          .map((value) => Number.parseInt(value, 10))
          .filter((value) => Number.isFinite(value) && value > 0)
      : [];
    const rawKeyAliases = normalizeRawKeyAliases(rawPreset.raw_key_aliases ?? rawPreset.rawKeyAliases ?? []);

    return {
      panels,
      selectedTraj,
      showEnsemble,
      showAllTraces,
      hopping: normalizeHoppingConfig(rawPreset.hopping),
      panelRowLayout,
      rawKeyAliases,
    };
  }

  async function persistImportedRawKeyAliases(aliasMap) {
    const entries = Object.entries(normalizeRawKeyAliases(aliasMap));
    if (!entries.length) return normalizeRawKeyAliases(state.rawKeyAliases);

    let merged = normalizeRawKeyAliases(state.rawKeyAliases);
    for (const [alias, rawKey] of entries) {
      const payload = await dataLoader.upsertRawKeyAlias(alias, rawKey);
      merged = applyAliasMapFromPayload(payload);
    }
    return merged;
  }

  async function applyImportedPanelPreset(rawPreset, controls) {
    const preset = normalizeImportedPanelPreset(rawPreset);
    await persistImportedRawKeyAliases(preset.rawKeyAliases);

    state.panels = preset.panels.map((panel, index) => normalizePanel(panel, index));
    state.selectedTraj = preset.selectedTraj;
    state.showEnsemble = preset.showEnsemble;
    state.showAllTraces = preset.showAllTraces;
    state.hopping = preset.hopping;
    panelRows = buildRowsFromLayout(state.panels, preset.panelRowLayout);

    if (controls?.trajSelect) controls.trajSelect.value = state.selectedTraj;
    if (controls?.ensembleCb) controls.ensembleCb.checked = state.showEnsemble;
    if (controls?.tracesCb) controls.tracesCb.checked = state.showAllTraces;

    initHoppingModule();
    rebuildPanels();
    saveStateToStorage();
    setGlobalStatus(`Imported ${state.panels.length} panel settings.`);
  }

  panelRows = buildRowsFromLayout(state.panels, loadSavedPanelRowLayout());

  function parseInspectorKeys(rawText) {
    const out = [];
    const seen = new Set();
    const chunks = String(rawText || '').split(/[\n,]+/);
    for (const chunk of chunks) {
      const key = chunk.trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(key);
    }
    return out;
  }

  function saveInspectorInput(rawText) {
    try {
      localStorage.setItem(INSPECTOR_STORAGE_KEY, String(rawText || ''));
    } catch {
      // ignore storage failures
    }
  }

  function loadInspectorInput() {
    try {
      return localStorage.getItem(INSPECTOR_STORAGE_KEY) || '';
    } catch {
      return '';
    }
  }

  function clearInspectorInputStorage() {
    try {
      localStorage.removeItem(INSPECTOR_STORAGE_KEY);
    } catch {
      // ignore storage failures
    }
  }

  function saveExpressionInspectorInput(rawText) {
    try {
      localStorage.setItem(EXPR_INSPECTOR_INPUT_STORAGE_KEY, String(rawText || ''));
    } catch {
      // ignore storage failures
    }
  }

  function saveExpressionInspectorLabel(rawText) {
    try {
      localStorage.setItem(EXPR_INSPECTOR_LABEL_STORAGE_KEY, String(rawText || ''));
    } catch {
      // ignore storage failures
    }
  }

  function loadExpressionInspectorInput() {
    try {
      return localStorage.getItem(EXPR_INSPECTOR_INPUT_STORAGE_KEY) || '';
    } catch {
      return '';
    }
  }

  function loadExpressionInspectorLabel() {
    try {
      return localStorage.getItem(EXPR_INSPECTOR_LABEL_STORAGE_KEY) || '';
    } catch {
      return '';
    }
  }

  function clearExpressionInspectorStorage() {
    try {
      localStorage.removeItem(EXPR_INSPECTOR_INPUT_STORAGE_KEY);
      localStorage.removeItem(EXPR_INSPECTOR_LABEL_STORAGE_KEY);
    } catch {
      // ignore storage failures
    }
  }

  function setInspectorStatus(message, isError = false) {
    const statusEl = document.getElementById('key-inspector-status');
    if (!statusEl) return;
    statusEl.textContent = String(message || '');
    statusEl.classList.toggle('error', !!isError);
  }

  function clearInspectorResults() {
    const resultsEl = document.getElementById('key-inspector-results');
    if (!resultsEl) return;
    resultsEl.innerHTML = '';
  }

  function setExpressionInspectorStatus(message, isError = false) {
    const statusEl = document.getElementById('expr-inspector-status');
    if (!statusEl) return;
    statusEl.textContent = String(message || '');
    statusEl.classList.toggle('error', !!isError);
  }

  function clearExpressionInspectorResults() {
    const resultsEl = document.getElementById('expr-inspector-results');
    if (!resultsEl) return;
    resultsEl.innerHTML = '';
  }

  function applyAliasMapFromPayload(payload) {
    const aliasMap = normalizeRawKeyAliases(payload?.aliases ?? payload?.alias_map ?? []);
    state.rawKeyAliases = aliasMap;
    return aliasMap;
  }

  async function addRawKeyAliasPanel(rawKey, aliasName) {
    const key = String(rawKey || '').trim();
    const alias = String(aliasName || key).trim();
    if (!key) {
      setGlobalStatus('Cannot add panel: raw key is empty.', true);
      return false;
    }
    if (!alias) {
      setGlobalStatus('Cannot add panel: alias is empty.', true);
      return false;
    }

    try {
      const payload = await dataLoader.upsertRawKeyAlias(alias, key);
      applyAliasMapFromPayload(payload);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setGlobalStatus(detail, true);
      return false;
    }

    const observable = makeRawAliasObservable(alias);
    state.panels.push(normalizePanel({ observable, indices: [] }, state.panels.length));
    rebuildPanels();
    saveStateToStorage();
    setGlobalStatus(`Added panel ${state.panels.length}: ${alias} -> ${key}`);
    return true;
  }

  function normalizeExpressionInput(rawText) {
    return String(rawText || '').trim();
  }

  function normalizeExpressionLabel(rawText) {
    return String(rawText || '').trim();
  }

  async function addExpressionPanel(expression, label) {
    const expressionText = normalizeExpressionInput(expression);
    const labelText = normalizeExpressionLabel(label);
    if (!expressionText) {
      setGlobalStatus('Cannot add panel: expression is empty.', true);
      return false;
    }

    state.panels.push(
      normalizePanel(
        {
          observable: 'expression',
          expression: expressionText,
          expressionLabel: labelText,
          indices: [],
        },
        state.panels.length
      )
    );
    rebuildPanels();
    saveStateToStorage();
    setGlobalStatus(`Added panel ${state.panels.length}: expression`);
    return true;
  }

  function previewCellText(value) {
    if (Array.isArray(value)) {
      if (!value.length) return '[]';
      const preview = value.slice(0, 4).map((v) => (
        (v == null || (typeof v === 'number' && !Number.isFinite(v))) ? 'null' : String(v)
      ));
      return value.length > 4 ? `[${preview.join(', ')}, ...]` : `[${preview.join(', ')}]`;
    }
    if (value == null) return 'null';
    if (typeof value === 'number' && !Number.isFinite(value)) return 'null';
    return String(value);
  }

  function renderExpressionInspectorResults(record, contextText) {
    const resultsEl = document.getElementById('expr-inspector-results');
    if (!resultsEl) return;
    resultsEl.innerHTML = '';

    const meta = document.createElement('div');
    meta.className = 'inspector-key-actions-title';
    const scopeText = String(record?.scope || 'dataset');
    const kindText = String(record?.series_kind || 'scalar');
    const nPoints = Number.isFinite(Number(record?.n_points)) ? Number(record.n_points) : 0;
    const nTraj = Number.isFinite(Number(record?.n_trajectories)) ? Number(record.n_trajectories) : 0;
    const sampleCount = Array.isArray(record?.sample_count) ? record.sample_count : null;
    meta.textContent = (
      `${contextText}; scope=${scopeText}; kind=${kindText}; n_points=${nPoints}; `
      + `n_trajectories=${nTraj}${sampleCount ? '; sample_count=yes' : ''}`
    );
    resultsEl.appendChild(meta);

    const time = Array.isArray(record?.time) ? record.time : [];
    const scalar = Array.isArray(record?.value) ? record.value : null;
    const matrix = Array.isArray(record?.values) ? record.values : null;
    const sample = Array.isArray(record?.sample_count) ? record.sample_count : null;
    const scalarLen = scalar ? scalar.length : Number.MAX_SAFE_INTEGER;
    const matrixLen = matrix ? matrix.length : Number.MAX_SAFE_INTEGER;
    const rowCount = Math.min(EXPR_PREVIEW_LIMIT, time.length, scalarLen, matrixLen);

    if (!rowCount) return;

    const table = document.createElement('table');
    table.className = 'inspector-table';
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const title of ['idx', 'time', 'value', 'sample_count']) {
      const th = document.createElement('th');
      th.textContent = title;
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (let i = 0; i < rowCount; i++) {
      const tr = document.createElement('tr');
      const value = scalar ? scalar[i] : (matrix ? matrix[i] : null);
      const sampleValue = sample && i < sample.length ? sample[i] : null;
      const cells = [i, time[i], previewCellText(value), sampleValue == null ? '' : sampleValue];
      for (const cell of cells) {
        const td = document.createElement('td');
        const code = document.createElement('code');
        code.textContent = String(cell);
        td.appendChild(code);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    resultsEl.appendChild(table);
  }

  async function runExpressionInspector() {
    const inputEl = document.getElementById('expr-inspector-input');
    const labelEl = document.getElementById('expr-inspector-label');
    const runBtn = document.getElementById('expr-inspector-run');
    const addBtn = document.getElementById('expr-inspector-add');
    const clearBtn = document.getElementById('expr-inspector-clear');
    if (!inputEl || !labelEl || !runBtn || !addBtn || !clearBtn) return;

    const expression = normalizeExpressionInput(inputEl.value);
    const expressionLabel = normalizeExpressionLabel(labelEl.value);
    saveExpressionInspectorInput(expression);
    saveExpressionInspectorLabel(expressionLabel);
    if (!expression) {
      clearExpressionInspectorResults();
      setExpressionInspectorStatus('Expression is empty.', true);
      return;
    }

    runBtn.disabled = true;
    addBtn.disabled = true;
    clearBtn.disabled = true;
    setExpressionInspectorStatus('Running expression...');
    const started = performance.now();
    try {
      let record = null;
      let contextText = '';
      if (state.selectedTraj === 'all') {
        throw new Error('Expression supports single trajectory only. Select a specific traj_id instead of all.');
      } else {
        const trajId = String(state.selectedTraj || '');
        if (!trajId || !trajIds.includes(trajId)) {
          throw new Error(`Invalid selected trajectory: '${trajId || 'empty'}'.`);
        }
        await dataLoader.ensureExpressionSeries(trajId, expression);
        record = dataLoader.getExpressionSeries(trajId, expression);
        contextText = `context=traj(${trajId})`;
      }

      if (!record) {
        throw new Error('Expression returned empty result.');
      }

      renderExpressionInspectorResults(record, contextText);
      const elapsedMs = Math.max(0, performance.now() - started);
      setExpressionInspectorStatus(`Expression evaluated in ${elapsedMs.toFixed(1)}ms.`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      clearExpressionInspectorResults();
      setExpressionInspectorStatus(detail, true);
    } finally {
      runBtn.disabled = false;
      addBtn.disabled = false;
      clearBtn.disabled = false;
    }
  }

  function renderInspectorActions(keys, mountEl) {
    if (!mountEl || !Array.isArray(keys) || !keys.length) return;
    const actionWrap = document.createElement('div');
    actionWrap.className = 'inspector-key-actions';

    const title = document.createElement('div');
    title.className = 'inspector-key-actions-title';
    title.textContent = 'Add key to panel';
    actionWrap.appendChild(title);

    for (const rawKey of keys) {
      const key = String(rawKey || '');
      if (!key) continue;
      const row = document.createElement('div');
      row.className = 'inspector-key-action-row';

      const code = document.createElement('code');
      code.textContent = key;
      row.appendChild(code);

      const aliasInput = document.createElement('input');
      aliasInput.type = 'text';
      aliasInput.className = 'inspector-alias-input';
      aliasInput.value = key;
      aliasInput.placeholder = 'Alias name';
      aliasInput.title = 'Alias shown in panel dropdown';
      row.appendChild(aliasInput);

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn inspector-add-btn';
      btn.textContent = 'Add to panel';
      btn.addEventListener('click', async () => {
        if (btn.disabled) return;
        btn.disabled = true;
        try {
          await addRawKeyAliasPanel(key, aliasInput.value);
        } finally {
          btn.disabled = false;
        }
      });
      row.appendChild(btn);
      actionWrap.appendChild(row);
    }

    mountEl.appendChild(actionWrap);
  }

  function renderInspectorResults(keys, rows) {
    const resultsEl = document.getElementById('key-inspector-results');
    if (!resultsEl) return 0;
    resultsEl.innerHTML = '';

    if (!Array.isArray(keys) || !keys.length) {
      return 0;
    }

    const table = document.createElement('table');
    table.className = 'inspector-table';

    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    const trajHead = document.createElement('th');
    trajHead.textContent = 'traj_id';
    headRow.appendChild(trajHead);
    for (const key of keys) {
      const keyHead = document.createElement('th');
      keyHead.textContent = String(key);
      headRow.appendChild(keyHead);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    let missingCells = 0;
    for (const rawRow of rows) {
      const row = rawRow && typeof rawRow === 'object' ? rawRow : {};
      const values = row.values && typeof row.values === 'object' ? row.values : {};
      const tr = document.createElement('tr');

      const trajTd = document.createElement('td');
      const trajCode = document.createElement('code');
      trajCode.textContent = String(row.traj_id || '');
      trajTd.appendChild(trajCode);
      tr.appendChild(trajTd);

      for (const key of keys) {
        const td = document.createElement('td');
        const code = document.createElement('code');
        const value = String(values[key] ?? 'MISSING');
        code.textContent = value;
        td.appendChild(code);
        if (value === 'MISSING') {
          td.classList.add('missing');
          missingCells += 1;
        }
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }

    table.appendChild(tbody);
    resultsEl.appendChild(table);
    renderInspectorActions(keys, resultsEl);
    return missingCells;
  }

  async function runInspector() {
    const inputEl = document.getElementById('key-inspector-input');
    const runBtn = document.getElementById('key-inspector-run');
    const clearBtn = document.getElementById('key-inspector-clear');
    if (!inputEl || !runBtn || !clearBtn) return;

    const rawText = String(inputEl.value || '');
    saveInspectorInput(rawText);
    const keys = parseInspectorKeys(rawText);
    if (!keys.length) {
      clearInspectorResults();
      setInspectorStatus('No keys provided.');
      return;
    }
    if (keys.length > INSPECTOR_MAX_KEYS) {
      clearInspectorResults();
      setInspectorStatus(`Too many keys: ${keys.length} (max ${INSPECTOR_MAX_KEYS}).`, true);
      return;
    }

    runBtn.disabled = true;
    clearBtn.disabled = true;
    const started = performance.now();
    setInspectorStatus('Inspecting keys...');
    try {
      const payload = await dataLoader.inspectKeys(keys);
      const responseKeys = Array.isArray(payload?.keys) ? payload.keys : keys;
      const rows = Array.isArray(payload?.rows) ? payload.rows : [];
      const missingCells = renderInspectorResults(responseKeys, rows);
      const elapsedMs = Math.max(0, performance.now() - started);
      setInspectorStatus(
        `keys=${responseKeys.length}, traj=${rows.length}, missingCells=${missingCells}, time=${elapsedMs.toFixed(1)}ms`
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      clearInspectorResults();
      setInspectorStatus(detail, true);
    } finally {
      runBtn.disabled = false;
      clearBtn.disabled = false;
    }
  }

  function initKeyInspector() {
    const inputEl = document.getElementById('key-inspector-input');
    const runBtn = document.getElementById('key-inspector-run');
    const clearBtn = document.getElementById('key-inspector-clear');
    if (!inputEl || !runBtn || !clearBtn) return;

    const exprInputEl = document.getElementById('expr-inspector-input');
    const exprLabelEl = document.getElementById('expr-inspector-label');
    const exprRunBtn = document.getElementById('expr-inspector-run');
    const exprAddBtn = document.getElementById('expr-inspector-add');
    const exprClearBtn = document.getElementById('expr-inspector-clear');

    const saved = loadInspectorInput();
    if (saved) {
      inputEl.value = saved;
      void runInspector();
    }

    const savedExpr = loadExpressionInspectorInput();
    const savedExprLabel = loadExpressionInspectorLabel();
    if (exprInputEl && savedExpr) {
      exprInputEl.value = savedExpr;
      void runExpressionInspector();
    }
    if (exprLabelEl && savedExprLabel) {
      exprLabelEl.value = savedExprLabel;
    }

    inputEl.addEventListener('input', () => {
      saveInspectorInput(inputEl.value);
    });

    runBtn.addEventListener('click', async () => {
      await runInspector();
    });

    clearBtn.addEventListener('click', () => {
      inputEl.value = '';
      clearInspectorInputStorage();
      clearInspectorResults();
      setInspectorStatus('');
    });

    if (exprInputEl && exprLabelEl && exprRunBtn && exprAddBtn && exprClearBtn) {
      exprInputEl.addEventListener('input', () => {
        saveExpressionInspectorInput(exprInputEl.value);
      });
      exprLabelEl.addEventListener('input', () => {
        saveExpressionInspectorLabel(exprLabelEl.value);
      });

      exprRunBtn.addEventListener('click', async () => {
        await runExpressionInspector();
      });

      exprAddBtn.addEventListener('click', async () => {
        if (exprAddBtn.disabled) return;
        exprAddBtn.disabled = true;
        try {
          await addExpressionPanel(exprInputEl.value, exprLabelEl.value);
        } finally {
          exprAddBtn.disabled = false;
        }
      });

      exprClearBtn.addEventListener('click', () => {
        exprInputEl.value = '';
        exprLabelEl.value = '';
        clearExpressionInspectorStorage();
        clearExpressionInspectorResults();
        setExpressionInspectorStatus('');
      });
    }
  }

  function ensembleStatModeLabel(mode) {
    if (mode === 'median_iqr') return 'Median + q25/q75';
    if (mode === 'renorm_mean_ci95_bootstrap') return 'Renormalize mean + 95% CI';
    return 'Mean + 95% CI';
  }

  function panelObservableOptions(selectedObservable) {
    const entries = observableOptions.map((obs) => ({
      value: obs,
      label: obs,
    }));

    const aliasMap = normalizeRawKeyAliases(state.rawKeyAliases);
    const aliasNames = Object.keys(aliasMap).sort((a, b) => a.localeCompare(b));
    for (const alias of aliasNames) {
      entries.push({
        value: makeRawAliasObservable(alias),
        label: alias,
      });
    }

    const selectedAlias = rawAliasFromObservable(selectedObservable);
    if (selectedAlias && !Object.prototype.hasOwnProperty.call(aliasMap, selectedAlias)) {
      entries.push({
        value: makeRawAliasObservable(selectedAlias),
        label: `${selectedAlias} (missing)`,
      });
    }

    return entries;
  }

  function syncPanelControls(panelIndex) {
    const panelState = state.panels[panelIndex];
    const observable = panelState.observable;
    const needed = requiredIndexCount(observable);
    const indicesWrap = document.getElementById(`indices-wrap-${panelIndex}`);
    const statSelect = document.getElementById(`stat-${panelIndex}`);
    const exprWrap = document.getElementById(`expr-wrap-${panelIndex}`);
    const exprInput = document.getElementById(`expr-${panelIndex}`);
    const exprLabelInput = document.getElementById(`expr-label-${panelIndex}`);
    const hoppingOverlayInput = document.getElementById(`hopping-overlay-${panelIndex}`);
    const applyBtn = document.getElementById(`apply-${panelIndex}`);
    const subtitleEl = document.getElementById(`panel-subtitle-${panelIndex}`);

    if (!indicesWrap || !applyBtn) return;
    if (statSelect) {
      if (!ensembleStatModes.includes(panelState.ensembleStatMode)) {
        panelState.ensembleStatMode = 'mean_ci95_bootstrap';
      }
      statSelect.value = panelState.ensembleStatMode;
    }

    if (exprInput) {
      exprInput.value = String(panelState.expression || '');
    }
    if (exprLabelInput) {
      exprLabelInput.value = String(panelState.expressionLabel || '');
    }
    if (hoppingOverlayInput) {
      hoppingOverlayInput.checked = !!panelState.showHoppingOverlay;
    }

    if (subtitleEl) {
      if (observable === 'expression') {
        const expressionText = String(panelState.expression || '').trim();
        subtitleEl.textContent = expressionText ? `expr: ${expressionText}` : 'expr: (empty)';
        subtitleEl.title = expressionText;
        subtitleEl.style.display = 'block';
      } else if (isRawObservable(observable)) {
        const alias = rawAliasFromObservable(observable);
        const key = resolveRawKeyForPanel(panelState, state.rawKeyAliases);
        if (alias) {
          subtitleEl.textContent = key
            ? `raw alias: ${alias} -> ${key}`
            : `raw alias: ${alias} (mapping missing)`;
        } else {
          subtitleEl.textContent = key ? `raw key: ${key}` : 'raw key: (set from Inspector)';
        }
        subtitleEl.title = subtitleEl.textContent;
        subtitleEl.style.display = 'block';
      } else {
        subtitleEl.textContent = '';
        subtitleEl.title = '';
        subtitleEl.style.display = 'none';
      }
    }

    if (observable === 'expression') {
      if (exprWrap) exprWrap.style.display = 'flex';
      if (statSelect) statSelect.style.display = 'inline-block';
      indicesWrap.style.display = 'none';
      applyBtn.style.display = 'inline-block';
    } else {
      if (exprWrap) exprWrap.style.display = 'none';
      if (statSelect) statSelect.style.display = 'inline-block';
    }

    if (observable !== 'expression' && needed > 0) {
      indicesWrap.style.display = 'flex';
      applyBtn.style.display = 'inline-block';
    } else if (observable !== 'expression') {
      indicesWrap.style.display = 'none';
      applyBtn.style.display = 'none';
    }

    for (let i = 0; i < 4; i++) {
      const input = document.getElementById(`idx-${panelIndex}-${i}`);
      if (!input) continue;

      if (i < needed) {
        input.style.display = 'inline-block';
        if (panelState.indices.length <= i) panelState.indices.push(0);
        input.value = panelState.indices[i];
      } else {
        input.style.display = 'none';
        input.value = '';
      }
    }
  }

  function updateRemoveButtonState() {
    const disable = state.panels.length <= MIN_PANELS;
    for (let i = 0; i < state.panels.length; i++) {
      const btn = document.getElementById(`remove-${i}`);
      if (!btn) continue;
      btn.disabled = disable;
      btn.style.opacity = disable ? '0.5' : '1';
      btn.style.cursor = disable ? 'not-allowed' : 'pointer';
    }
  }

  function syncPanelRowsWithState() {
    const currentPanels = Array.isArray(state.panels) ? state.panels : [];
    if (!currentPanels.length) {
      panelRows = [];
      return;
    }

    if (!Array.isArray(panelRows) || !panelRows.length) {
      panelRows = [currentPanels.slice()];
      return;
    }

    const currentSet = new Set(currentPanels);
    const seen = new Set();
    const syncedRows = [];

    for (const row of panelRows) {
      if (!Array.isArray(row)) continue;
      const kept = [];
      for (const panelRef of row) {
        if (!currentSet.has(panelRef) || seen.has(panelRef)) continue;
        kept.push(panelRef);
        seen.add(panelRef);
      }
      if (kept.length) syncedRows.push(kept);
    }

    const missing = currentPanels.filter((panelRef) => !seen.has(panelRef));
    if (!syncedRows.length) syncedRows.push([]);
    if (missing.length) {
      syncedRows[syncedRows.length - 1].push(...missing);
    }

    panelRows = syncedRows.filter((row) => row.length > 0);
    if (!panelRows.length) {
      panelRows = [currentPanels.slice()];
    }

    const flattened = panelRows.flat();
    if (
      flattened.length !== currentPanels.length
      || flattened.some((panelRef, idx) => panelRef !== currentPanels[idx])
    ) {
      state.panels = flattened;
    }
  }

  function clearPanelDragState() {
    draggingPanelIndex = -1;
    draggingPanelRef = null;
    const dashboard = document.getElementById('dashboard');
    if (!dashboard) return;
    dashboard.classList.remove('drag-layout-active');
    dashboard.querySelectorAll('.panel.dragging, .panel.drag-over').forEach((el) => {
      el.classList.remove('dragging');
      el.classList.remove('drag-over');
    });
    dashboard.querySelectorAll('.dashboard-row.drag-over, .dashboard-row-dropzone.drag-over').forEach((el) => {
      el.classList.remove('drag-over');
    });
  }

  function removePanelFromRows(panelRef) {
    for (let rowIndex = 0; rowIndex < panelRows.length; rowIndex++) {
      const row = panelRows[rowIndex];
      const colIndex = row.indexOf(panelRef);
      if (colIndex < 0) continue;
      row.splice(colIndex, 1);
      if (!row.length) panelRows.splice(rowIndex, 1);
      return true;
    }
    return false;
  }

  function movePanelBeforeTarget(panelRef, targetRef) {
    if (!panelRef || !targetRef || panelRef === targetRef) return false;
    removePanelFromRows(panelRef);
    for (const row of panelRows) {
      const idx = row.indexOf(targetRef);
      if (idx < 0) continue;
      row.splice(idx, 0, panelRef);
      return true;
    }
    if (!panelRows.length) panelRows = [[]];
    panelRows[panelRows.length - 1].push(panelRef);
    return true;
  }

  function movePanelToRowEnd(panelRef, rowIndex) {
    if (!panelRef) return false;
    removePanelFromRows(panelRef);
    const targetRow = Math.max(0, Math.min(Number.parseInt(rowIndex, 10), panelRows.length - 1));
    if (!Number.isFinite(targetRow)) return false;
    if (!panelRows[targetRow]) panelRows[targetRow] = [];
    panelRows[targetRow].push(panelRef);
    return true;
  }

  function movePanelToNewRow(panelRef, rowInsertIndex) {
    if (!panelRef) return false;
    removePanelFromRows(panelRef);
    const insertIndex = Math.max(0, Math.min(Number.parseInt(rowInsertIndex, 10), panelRows.length));
    if (!Number.isFinite(insertIndex)) return false;
    panelRows.splice(insertIndex, 0, [panelRef]);
    return true;
  }

  function applyPanelMove(fromIndex, movedPanelRef, statusMode = 'move') {
    syncPanelRowsWithState();
    savePanelRowLayout(panelRows);
    const toIndex = state.panels.indexOf(movedPanelRef);
    clearPanelDragState();
    rebuildPanels();
    saveStateToStorage();
    if (toIndex < 0) return;
    if (statusMode === 'new-row') {
      setGlobalStatus(`Moved panel ${fromIndex + 1} to new row (position ${toIndex + 1}).`);
    } else {
      setGlobalStatus(`Moved panel ${fromIndex + 1} to position ${toIndex + 1}.`);
    }
  }

  function bindRowDropEvents(rowEl, rowIndex) {
    rowEl.addEventListener('dragover', (event) => {
      if (!draggingPanelRef) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      const dashboard = document.getElementById('dashboard');
      if (dashboard) {
        dashboard.querySelectorAll('.dashboard-row.drag-over').forEach((el) => el.classList.remove('drag-over'));
      }
      rowEl.classList.add('drag-over');
    });

    rowEl.addEventListener('drop', (event) => {
      if (!draggingPanelRef) return;
      if (event.target && event.target.closest && event.target.closest('.panel')) return;
      event.preventDefault();
      const fromIndex = draggingPanelIndex;
      const movedPanelRef = draggingPanelRef;
      if (!movePanelToRowEnd(movedPanelRef, rowIndex)) {
        clearPanelDragState();
        return;
      }
      applyPanelMove(fromIndex, movedPanelRef, 'move');
    });
  }

  function buildRowDropzone(rowInsertIndex) {
    const dropzone = document.createElement('div');
    dropzone.className = 'dashboard-row-dropzone';
    dropzone.textContent = 'Drop here to create a new row';

    dropzone.addEventListener('dragover', (event) => {
      if (!draggingPanelRef) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      const dashboard = document.getElementById('dashboard');
      if (dashboard) {
        dashboard.querySelectorAll('.dashboard-row-dropzone.drag-over').forEach((el) => el.classList.remove('drag-over'));
      }
      dropzone.classList.add('drag-over');
    });

    dropzone.addEventListener('drop', (event) => {
      if (!draggingPanelRef) return;
      event.preventDefault();
      const fromIndex = draggingPanelIndex;
      const movedPanelRef = draggingPanelRef;
      if (!movePanelToNewRow(movedPanelRef, rowInsertIndex)) {
        clearPanelDragState();
        return;
      }
      applyPanelMove(fromIndex, movedPanelRef, 'new-row');
    });

    return dropzone;
  }

  function bindPanelDragEvents(panel, panelIndex) {
    const dragHandle = panel.querySelector(`#drag-${panelIndex}`);
    if (!dragHandle) return;
    const panelRef = state.panels[panelIndex];

    dragHandle.addEventListener('dragstart', (event) => {
      draggingPanelIndex = panelIndex;
      draggingPanelRef = panelRef;
      panel.classList.add('dragging');
      const dashboard = document.getElementById('dashboard');
      dashboard?.classList.add('drag-layout-active');
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', String(panelIndex));
      }
    });
    dragHandle.addEventListener('dragend', () => {
      clearPanelDragState();
    });

    panel.addEventListener('dragover', (event) => {
      if (!draggingPanelRef || draggingPanelRef === panelRef) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      const dashboard = document.getElementById('dashboard');
      if (dashboard) {
        dashboard.querySelectorAll('.panel.drag-over').forEach((el) => el.classList.remove('drag-over'));
      }
      panel.classList.add('drag-over');
    });

    panel.addEventListener('drop', (event) => {
      if (!draggingPanelRef || draggingPanelRef === panelRef) return;
      event.preventDefault();
      event.stopPropagation();
      const fromIndex = draggingPanelIndex;
      const movedPanelRef = draggingPanelRef;
      if (!movePanelBeforeTarget(movedPanelRef, panelRef)) {
        clearPanelDragState();
        return;
      }
      applyPanelMove(fromIndex, movedPanelRef, 'move');
    });
  }

  function buildPanel(panelIndex) {
    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.innerHTML = `
    <div class="panel-head">
      <div class="panel-head-row">
        <div class="panel-title">Panel ${panelIndex + 1}</div>
        <button class="panel-drag-handle" id="drag-${panelIndex}" type="button" draggable="true" title="Drag to reorder" aria-label="Drag panel to reorder">Drag</button>
      </div>
      <div class="panel-subtitle" id="panel-subtitle-${panelIndex}"></div>
      <div class="panel-controls">
        <select id="obs-${panelIndex}"></select>
        <select id="stat-${panelIndex}" class="panel-stat-mode"></select>
        <div id="indices-wrap-${panelIndex}" class="indices-wrap">
          <input type="number" id="idx-${panelIndex}-0" step="1" />
          <input type="number" id="idx-${panelIndex}-1" step="1" />
          <input type="number" id="idx-${panelIndex}-2" step="1" />
          <input type="number" id="idx-${panelIndex}-3" step="1" />
        </div>
        <div id="expr-wrap-${panelIndex}" class="expr-wrap">
          <input type="text" id="expr-${panelIndex}" class="expr-input" placeholder="Expression" />
          <input type="text" id="expr-label-${panelIndex}" class="expr-label-input" placeholder="Label (optional)" />
        </div>
        <label class="panel-hop-toggle">
          <input type="checkbox" id="hopping-overlay-${panelIndex}" />
          Show hopping
        </label>
        <button class="btn" id="apply-${panelIndex}">Apply</button>
        <button class="btn" id="export-${panelIndex}">Export Data</button>
        <button
          class="btn danger panel-remove-btn"
          id="remove-${panelIndex}"
          type="button"
          aria-label="Remove panel ${panelIndex + 1}"
          title="Remove panel ${panelIndex + 1}"
        >×</button>
      </div>
    </div>
    <div class="panel-msg" id="msg-${panelIndex}"></div>
    <div class="plot" id="plot-${panelIndex}"></div>
  `;

    const obsSelect = panel.querySelector(`#obs-${panelIndex}`);
    const statSelect = panel.querySelector(`#stat-${panelIndex}`);
    const exprInput = panel.querySelector(`#expr-${panelIndex}`);
    const exprLabelInput = panel.querySelector(`#expr-label-${panelIndex}`);
    const hoppingOverlayInput = panel.querySelector(`#hopping-overlay-${panelIndex}`);
    const currentObservable = String(state.panels[panelIndex].observable || '');
    for (const entry of panelObservableOptions(currentObservable)) {
      const opt = document.createElement('option');
      opt.value = entry.value;
      opt.textContent = entry.label;
      obsSelect.appendChild(opt);
    }
    for (const mode of ensembleStatModes) {
      const opt = document.createElement('option');
      opt.value = mode;
      opt.textContent = ensembleStatModeLabel(mode);
      statSelect.appendChild(opt);
    }

    obsSelect.value = currentObservable;
    statSelect.value = ensembleStatModes.includes(state.panels[panelIndex].ensembleStatMode)
      ? state.panels[panelIndex].ensembleStatMode
      : 'mean_ci95_bootstrap';

    obsSelect.addEventListener('change', () => {
      state.panels[panelIndex].observable = obsSelect.value;
      if (!isRawObservable(state.panels[panelIndex].observable)) {
        state.panels[panelIndex].rawKey = '';
      }
      if (state.panels[panelIndex].observable !== 'expression') {
        state.panels[panelIndex].expression = '';
        state.panels[panelIndex].expressionLabel = '';
      }
      syncPanelControls(panelIndex);
      plot.renderPanel(panelIndex);
      saveStateToStorage();
    });
    statSelect.addEventListener('change', () => {
      state.panels[panelIndex].ensembleStatMode = statSelect.value;
      plot.renderPanel(panelIndex);
      saveStateToStorage();
    });
    hoppingOverlayInput?.addEventListener('change', () => {
      state.panels[panelIndex].showHoppingOverlay = !!hoppingOverlayInput.checked;
      plot.renderPanel(panelIndex);
      saveStateToStorage();
    });

    panel.querySelector(`#apply-${panelIndex}`).addEventListener('click', () => {
      plot.renderPanel(panelIndex);
      saveStateToStorage();
    });

    const exportBtn = panel.querySelector(`#export-${panelIndex}`);
    exportBtn?.addEventListener('click', async () => {
      if (exportBtn.disabled) return;
      if (!plot || typeof plot.exportPanelData !== 'function') {
        setGlobalStatus('Export is unavailable in current frontend build.', true);
        return;
      }
      exportBtn.disabled = true;
      try {
        await plot.exportPanelData(panelIndex);
      } catch {
        // Error details are already handled inside plot.exportPanelData().
      } finally {
        exportBtn.disabled = false;
      }
    });

    exprInput?.addEventListener('input', () => {
      state.panels[panelIndex].expression = String(exprInput.value || '').trim();
      saveStateToStorage();
    });
    exprLabelInput?.addEventListener('input', () => {
      state.panels[panelIndex].expressionLabel = String(exprLabelInput.value || '').trim();
      saveStateToStorage();
    });

    exprInput?.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.shiftKey) return;
      event.preventDefault();
      plot.renderPanel(panelIndex);
      saveStateToStorage();
    });

    panel.querySelector(`#remove-${panelIndex}`).addEventListener('click', () => {
      if (state.panels.length <= MIN_PANELS) {
        setGlobalStatus('At least one panel must remain.', true);
        return;
      }
      state.panels.splice(panelIndex, 1);
      rebuildPanels();
      saveStateToStorage();
      setGlobalStatus(`Removed panel ${panelIndex + 1}.`);
    });

    bindPanelDragEvents(panel, panelIndex);
    return panel;
  }

  function rebuildPanels() {
    const dashboard = document.getElementById('dashboard');
    if (!dashboard) return;
    clearPanelDragState();
    syncPanelRowsWithState();
    dashboard.innerHTML = '';

    let panelIndex = 0;
    for (let rowIndex = 0; rowIndex < panelRows.length; rowIndex++) {
      dashboard.appendChild(buildRowDropzone(rowIndex));
      const rowEl = document.createElement('div');
      rowEl.className = 'dashboard-row';
      bindRowDropEvents(rowEl, rowIndex);
      const rowPanels = panelRows[rowIndex];
      for (let col = 0; col < rowPanels.length; col++) {
        rowEl.appendChild(buildPanel(panelIndex));
        panelIndex += 1;
      }
      dashboard.appendChild(rowEl);
    }
    dashboard.appendChild(buildRowDropzone(panelRows.length));

    for (let i = 0; i < state.panels.length; i++) {
      syncPanelControls(i);
    }

    updateRemoveButtonState();
    savePanelRowLayout(panelRows);
    plot.renderAllPanels();
  }

  function normalizeBreakSummary(rawSummary) {
    if (!rawSummary || typeof rawSummary !== 'object') return null;
    const rawBroken = Array.isArray(rawSummary.broken_trajs) ? rawSummary.broken_trajs : [];
    const brokenTrajs = [];
    for (const item of rawBroken) {
      const trajId = String(item?.traj_id || '').trim();
      const breakFrameIndex = Number.parseInt(item?.break_frame_index, 10);
      if (!trajId || !Number.isFinite(breakFrameIndex) || breakFrameIndex < 0) continue;
      const breakTimeRaw = Number(item?.break_time);
      const reason = String(item?.reason || 'unknown').trim() || 'unknown';
      const sourceKeyRaw = String(item?.source_key || '').trim();
      brokenTrajs.push({
        traj_id: trajId,
        break_frame_index: breakFrameIndex,
        break_time: Number.isFinite(breakTimeRaw) ? breakTimeRaw : null,
        reason,
        source_key: sourceKeyRaw || null,
      });
    }

    const totalTrajRaw = Number.parseInt(rawSummary.total_traj, 10);
    const totalTraj = Number.isFinite(totalTrajRaw) && totalTrajRaw >= 0 ? totalTrajRaw : trajIds.length;
    const brokenTrajCountRaw = Number.parseInt(rawSummary.broken_traj_count, 10);
    const brokenTrajCount = Number.isFinite(brokenTrajCountRaw) && brokenTrajCountRaw >= 0
      ? brokenTrajCountRaw
      : brokenTrajs.length;
    const completeTrajCountRaw = Number.parseInt(rawSummary.complete_traj_count, 10);
    const completeTrajCount = Number.isFinite(completeTrajCountRaw) && completeTrajCountRaw >= 0
      ? completeTrajCountRaw
      : Math.max(0, totalTraj - brokenTrajCount);

    return {
      totalTraj,
      brokenTrajCount,
      completeTrajCount,
      brokenTrajs,
    };
  }

  function formatBreakTime(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 'n/a';
    const abs = Math.abs(number);
    if ((abs > 0 && abs < 1e-3) || abs >= 1e4) {
      return number.toExponential(3);
    }
    const fixed = number.toFixed(6);
    return fixed.replace(/\.?0+$/, '');
  }

  function renderTrajectoryBreakSummary() {
    const statusEl = document.getElementById('break-summary-status');
    const listEl = document.getElementById('break-summary-list');
    if (!statusEl || !listEl) return;

    const summary = normalizeBreakSummary(meta?.trajectory_break_summary);
    listEl.innerHTML = '';

    if (!summary) {
      statusEl.textContent = 'Trajectory completion summary is unavailable for this dataset.';
      statusEl.classList.remove('ok');
      statusEl.classList.add('warn');
      return;
    }

    const total = Math.max(0, Number(summary.totalTraj) || 0);
    const brokenCount = Math.max(0, Number(summary.brokenTrajCount) || 0);
    const completeCount = Math.max(0, Number(summary.completeTrajCount) || 0);

    if (brokenCount <= 0) {
      statusEl.textContent = `All trajectories complete (${completeCount}/${total}).`;
      statusEl.classList.remove('warn');
      statusEl.classList.add('ok');
      const item = document.createElement('div');
      item.className = 'break-summary-item';
      item.textContent = 'No broken trajectories detected.';
      listEl.appendChild(item);
      return;
    }

    statusEl.textContent = `Broken trajectories: ${brokenCount}/${total}.`;
    statusEl.classList.remove('ok');
    statusEl.classList.add('warn');

    const rows = Array.isArray(summary.brokenTrajs) ? summary.brokenTrajs : [];
    for (const row of rows) {
      const trajId = String(row?.traj_id || '').trim();
      const frameIndex = Number.parseInt(row?.break_frame_index, 10);
      if (!trajId || !Number.isFinite(frameIndex)) continue;
      const reason = String(row?.reason || 'unknown').trim() || 'unknown';
      const sourceKey = row?.source_key ? String(row.source_key) : '';
      const item = document.createElement('div');
      item.className = 'break-summary-item';
      const sourceLabel = sourceKey ? `, key=${sourceKey}` : '';
      item.textContent = `traj ${trajId}: break@frame ${frameIndex}, t=${formatBreakTime(row?.break_time)}, reason=${reason}${sourceLabel}`;
      listEl.appendChild(item);
    }
  }

  function initGlobalControls() {
    const appearance = window.ObservableAppearance;
    const hasDataset = !!datasetLoaded && trajIds.length > 0;
    bindHeaderSectionToggles();
    setHeaderSectionOpen('summary');
    const sourcePklEl = document.getElementById('source-pkl');
    if (sourcePklEl) {
      const sourcePkl = String(meta?.source_pkl || '');
      if (sourcePkl) {
        const filename = sourcePkl.split(/[\\/]/).pop() || sourcePkl;
        sourcePklEl.textContent = `PKL: ${filename}`;
        sourcePklEl.title = sourcePkl;
      } else {
        sourcePklEl.textContent = 'PKL: none loaded';
        sourcePklEl.title = 'No dataset loaded';
      }
    }
    renderTrajectoryBreakSummary();
    initHoppingModule();
    const emptyStateEl = document.getElementById('dataset-empty-state');
    if (emptyStateEl) {
      emptyStateEl.hidden = hasDataset;
    }

    const trajSelect = document.getElementById('global-traj');
    if (!trajSelect) return;
    trajSelect.innerHTML = '';

    const allOpt = document.createElement('option');
    allOpt.value = 'all';
    allOpt.textContent = 'All';
    trajSelect.appendChild(allOpt);

    for (const trajId of trajIds) {
      const opt = document.createElement('option');
      opt.value = trajId;
      opt.textContent = trajId;
      trajSelect.appendChild(opt);
    }

    if (state.selectedTraj !== 'all' && !trajIds.includes(state.selectedTraj)) {
      state.selectedTraj = 'all';
    }
    trajSelect.value = state.selectedTraj;
    trajSelect.disabled = !hasDataset;

    trajSelect.addEventListener('change', () => {
      state.selectedTraj = trajSelect.value;
      plot.renderAllPanels();
      void renderHoppingSummary();
      saveStateToStorage();
    });

    const ensembleCb = document.getElementById('global-ensemble');
    if (!ensembleCb) return;
    ensembleCb.checked = state.showEnsemble;
    ensembleCb.disabled = !hasDataset;
    ensembleCb.addEventListener('change', () => {
      state.showEnsemble = ensembleCb.checked;
      plot.renderAllPanels();
      saveStateToStorage();
    });

    const tracesCb = document.getElementById('global-traces');
    if (!tracesCb) return;
    tracesCb.checked = state.showAllTraces;
    tracesCb.disabled = !hasDataset;
    tracesCb.addEventListener('change', () => {
      state.showAllTraces = tracesCb.checked;
      plot.renderAllPanels();
      saveStateToStorage();
    });

    const mol3dLink = document.querySelector('.mol3d-link');
    if (mol3dLink instanceof HTMLAnchorElement) {
      const storedHref = mol3dLink.dataset.href || mol3dLink.getAttribute('href') || 'molecule3d.html';
      mol3dLink.dataset.href = storedHref;
      if (hasDataset) {
        mol3dLink.setAttribute('href', storedHref);
        mol3dLink.removeAttribute('aria-disabled');
        mol3dLink.removeAttribute('tabindex');
        mol3dLink.classList.remove('disabled');
      } else {
        mol3dLink.removeAttribute('href');
        mol3dLink.setAttribute('aria-disabled', 'true');
        mol3dLink.setAttribute('tabindex', '-1');
        mol3dLink.classList.add('disabled');
      }
    }

    const refreshPklBtn = document.getElementById('refresh-pkl-btn');
    if (refreshPklBtn) refreshPklBtn.disabled = !hasDataset;
    refreshPklBtn?.addEventListener('click', async () => {
      if (refreshPklBtn.disabled) return;
      refreshPklBtn.disabled = true;
      setGlobalStatus('Refreshing dataset...');
      try {
        await dataLoader.refreshDataset();
        dataLoader.clearLocalSeriesCache();
        window.location.reload();
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        setGlobalStatus(`Refresh failed: ${detail}`, true);
      } finally {
        refreshPklBtn.disabled = false;
      }
    });

    const openPklBtn = document.getElementById('open-pkl-btn');
    const fileBrowserModal = document.getElementById('file-browser-modal');
    const fileBrowserCloseBtn = document.getElementById('file-browser-close-btn');
    const fileBrowserUpBtn = document.getElementById('file-browser-up-btn');
    const fileBrowserRootEl = document.getElementById('file-browser-root');
    const fileBrowserPathEl = document.getElementById('file-browser-path');
    const fileBrowserStatusEl = document.getElementById('file-browser-status');
    const fileBrowserListEl = document.getElementById('file-browser-list');
    let fileBrowserCurrentPath = '';
    let fileBrowserParentPath = null;
    let fileBrowserBusy = false;

    function setFileBrowserOpen(isOpen) {
      if (!fileBrowserModal) return;
      fileBrowserModal.hidden = !isOpen;
      fileBrowserModal.setAttribute('aria-hidden', isOpen ? 'false' : 'true');
      document.body.style.overflow = isOpen ? 'hidden' : '';
    }

    function setFileBrowserStatus(message, isError = false) {
      if (!fileBrowserStatusEl) return;
      fileBrowserStatusEl.textContent = String(message || '');
      fileBrowserStatusEl.classList.toggle('error', !!isError);
    }

    function renderFileBrowserEntries(entries) {
      if (!fileBrowserListEl) return;
      fileBrowserListEl.innerHTML = '';
      if (!Array.isArray(entries) || !entries.length) {
        const emptyEl = document.createElement('div');
        emptyEl.className = 'file-browser-empty';
        emptyEl.textContent = 'No files or directories available in this location.';
        fileBrowserListEl.appendChild(emptyEl);
        return;
      }

      for (const entry of entries) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'file-browser-item';
        if (entry.kind === 'file' && !entry.loadable) {
          row.classList.add('file-disabled');
        }

        const main = document.createElement('div');
        main.className = 'file-browser-item-main';
        const nameEl = document.createElement('div');
        nameEl.className = 'file-browser-item-name';
        nameEl.textContent = String(entry.name || '');
        const metaEl = document.createElement('div');
        metaEl.className = 'file-browser-item-meta';
        if (entry.kind === 'directory') {
          metaEl.textContent = 'Directory';
        } else if (entry.loadable) {
          metaEl.textContent = 'PKL file';
        } else {
          metaEl.textContent = 'File';
        }
        main.appendChild(nameEl);
        main.appendChild(metaEl);

        const actionEl = document.createElement('div');
        actionEl.className = 'file-browser-item-meta';
        actionEl.textContent = entry.kind === 'directory' ? 'Open' : (entry.loadable ? 'Load' : '');

        row.appendChild(main);
        row.appendChild(actionEl);

        if (entry.kind === 'directory') {
          row.addEventListener('click', async () => {
            if (fileBrowserBusy) return;
            await loadFileBrowserPath(entry.relative_path);
          });
        } else if (entry.loadable) {
          row.addEventListener('click', async () => {
            if (fileBrowserBusy) return;
            fileBrowserBusy = true;
            setFileBrowserStatus(`Loading ${entry.relative_path}...`);
            setGlobalStatus(`Loading dataset: ${entry.relative_path}...`);
            try {
              await dataLoader.loadDataset(entry.relative_path);
              dataLoader.clearLocalSeriesCache();
              clearDashboardStorageForDatasetSwitch();
              setGlobalStatus('Dataset loaded. Reloading...');
              window.location.reload();
            } catch (error) {
              const detail = error instanceof Error ? error.message : String(error);
              setFileBrowserStatus(detail, true);
              setGlobalStatus(`Load failed: ${detail}`, true);
              fileBrowserBusy = false;
            }
          });
        }

        fileBrowserListEl.appendChild(row);
      }
    }

    async function loadFileBrowserPath(path) {
      if (!fileBrowserRootEl || !fileBrowserPathEl) return;
      fileBrowserBusy = true;
      if (fileBrowserUpBtn) fileBrowserUpBtn.disabled = true;
      setFileBrowserStatus('Loading files...');
      try {
        const payload = await dataLoader.listFiles(path);
        fileBrowserCurrentPath = payload.current_path || '';
        fileBrowserParentPath = payload.parent_path == null ? null : payload.parent_path;
        fileBrowserRootEl.textContent = `Root: ${payload.root_label || ''}`;
        fileBrowserPathEl.textContent = fileBrowserCurrentPath ? `/${fileBrowserCurrentPath}` : '/';
        if (fileBrowserUpBtn) fileBrowserUpBtn.disabled = fileBrowserParentPath == null;
        renderFileBrowserEntries(payload.entries);
        setFileBrowserStatus('');
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        renderFileBrowserEntries([]);
        setFileBrowserStatus(detail, true);
      } finally {
        fileBrowserBusy = false;
      }
    }

    openPklBtn?.addEventListener('click', async () => {
      setFileBrowserOpen(true);
      await loadFileBrowserPath('');
    });
    fileBrowserCloseBtn?.addEventListener('click', () => setFileBrowserOpen(false));
    fileBrowserUpBtn?.addEventListener('click', async () => {
      if (fileBrowserBusy || fileBrowserParentPath == null) return;
      await loadFileBrowserPath(fileBrowserParentPath);
    });
    fileBrowserModal?.querySelector('[data-file-browser-close]')?.addEventListener('click', () => {
      setFileBrowserOpen(false);
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && fileBrowserModal && !fileBrowserModal.hidden) {
        setFileBrowserOpen(false);
      }
    });

    const addBtn = document.getElementById('add-panel');
    if (!addBtn) return;
    addBtn.addEventListener('click', () => {
      state.panels.push(normalizePanel(defaultPanelForIndex(state.panels.length), state.panels.length));
      rebuildPanels();
      saveStateToStorage();
      setGlobalStatus(`Added panel ${state.panels.length}.`);
    });

    const exportAllDataBtn = document.getElementById('export-all-panels-data');
    exportAllDataBtn?.addEventListener('click', async () => {
      if (exportAllDataBtn.disabled) return;
      if (!plot || typeof plot.exportAllPanelsDataTarGz !== 'function') {
        setGlobalStatus('TAR.GZ export is unavailable in current frontend build.', true);
        return;
      }
      exportAllDataBtn.disabled = true;
      try {
        await plot.exportAllPanelsDataTarGz();
      } catch {
        // Error details are already handled in plot.exportAllPanelsDataTarGz().
      } finally {
        exportAllDataBtn.disabled = false;
      }
    });

    const exportBtn = document.getElementById('export-panels');
    exportBtn?.addEventListener('click', () => {
      try {
        exportPanelPreset();
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        setGlobalStatus(`Export failed: ${detail}`, true);
      }
    });

    const importInput = document.getElementById('import-panels-file');
    const importBtn = document.getElementById('import-panels');
    importBtn?.addEventListener('click', () => {
      if (!(importInput instanceof HTMLInputElement)) return;
      importInput.click();
    });
    importInput?.addEventListener('change', async () => {
      if (!(importInput instanceof HTMLInputElement)) return;
      const file = importInput.files && importInput.files[0] ? importInput.files[0] : null;
      importInput.value = '';
      if (!file) return;

      if (importBtn) importBtn.disabled = true;
      setGlobalStatus(`Importing panel preset: ${file.name}...`);
      try {
        const text = await file.text();
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch (error) {
          throw new Error(`Preset JSON parse failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        await applyImportedPanelPreset(parsed, { trajSelect, ensembleCb, tracesCb });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        setGlobalStatus(`Import failed: ${detail}`, true);
      } finally {
        if (importBtn) importBtn.disabled = false;
      }
    });

    const resetBtn = document.getElementById('reset-panels');
    if (!resetBtn) return;
    resetBtn.addEventListener('click', () => {
      state.panels = makeDefaultPanels();
      state.selectedTraj = 'all';
      state.showEnsemble = !!defaults?.plot?.show_ensemble_by_default;
      state.showAllTraces = !!defaults?.plot?.show_all_traces_in_all_mode;
      state.hopping = buildDefaultHoppingConfig();

      trajSelect.value = state.selectedTraj;
      ensembleCb.checked = state.showEnsemble;
      tracesCb.checked = state.showAllTraces;

      initHoppingModule();
      rebuildPanels();
      saveStateToStorage();
      setGlobalStatus('Reset to default panel layout.');
    });

    if (appearance && typeof appearance.initControls === 'function') {
      appearance.initControls();
    }
    if (appearance && typeof appearance.subscribe === 'function') {
      appearance.subscribe(() => {
        plot.renderAllPanels({ suppressStatus: true });
      });
    }
  }

  root.ui = {
    rebuildPanels,
    initGlobalControls,
    initKeyInspector,
  };

  initGlobalControls();
  initKeyInspector();
  rebuildPanels();
  saveStateToStorage();
})();
