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
    state,
    MIN_PANELS,
    MAX_PANELS,
    observableOptions,
    ensembleStatModes,
    normalizeRawKeyAliases,
    makeRawAliasObservable,
    rawAliasFromObservable,
    isRawObservable,
    resolveRawKeyForPanel,
    requiredIndexCount,
    normalizePanel,
    defaultPanelForIndex,
    makeDefaultPanels,
    saveStateToStorage,
    setGlobalStatus,
  } = shared;
  const INSPECTOR_STORAGE_KEY = 'traj_dashboard_key_inspector_v1';
  const INSPECTOR_MAX_KEYS = 200;

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
    if (state.panels.length >= MAX_PANELS) {
      setGlobalStatus(`Reached maximum panels (${MAX_PANELS}).`, true);
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
    const inspectorEl = document.getElementById('key-inspector');
    const inputEl = document.getElementById('key-inspector-input');
    const runBtn = document.getElementById('key-inspector-run');
    const clearBtn = document.getElementById('key-inspector-clear');
    if (!inspectorEl || !inputEl || !runBtn || !clearBtn) return;

    const saved = loadInspectorInput();
    if (saved) {
      inputEl.value = saved;
      inspectorEl.setAttribute('open', '');
      void runInspector();
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
  }

  function ensembleStatModeLabel(mode) {
    if (mode === 'median_iqr') return 'Median + q25/q75';
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
    const applyBtn = document.getElementById(`apply-${panelIndex}`);
    const cloneBtn = document.getElementById(`clone-${panelIndex}`);
    const subtitleEl = document.getElementById(`panel-subtitle-${panelIndex}`);

    if (!indicesWrap || !applyBtn || !cloneBtn) return;
    if (statSelect) {
      if (!ensembleStatModes.includes(panelState.ensembleStatMode)) {
        panelState.ensembleStatMode = 'mean_ci95_bootstrap';
      }
      statSelect.value = panelState.ensembleStatMode;
    }

    if (subtitleEl) {
      if (isRawObservable(observable)) {
        const alias = rawAliasFromObservable(observable);
        const key = resolveRawKeyForPanel(panelState, state.rawKeyAliases);
        if (alias) {
          subtitleEl.textContent = key
            ? `raw alias: ${alias} -> ${key}`
            : `raw alias: ${alias} (mapping missing)`;
        } else {
          subtitleEl.textContent = key ? `raw key: ${key}` : 'raw key: (set from Inspector)';
        }
        subtitleEl.style.display = 'block';
      } else {
        subtitleEl.textContent = '';
        subtitleEl.style.display = 'none';
      }
    }

    if (needed > 0) {
      indicesWrap.style.display = 'flex';
      applyBtn.style.display = 'inline-block';
      cloneBtn.style.display = 'inline-block';
    } else {
      indicesWrap.style.display = 'none';
      applyBtn.style.display = 'none';
      cloneBtn.style.display = 'none';
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

  function buildPanel(panelIndex) {
    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.innerHTML = `
    <div class="panel-head">
      <div class="panel-title">Panel ${panelIndex + 1}</div>
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
        <button class="btn" id="apply-${panelIndex}">Apply</button>
        <button class="btn" id="clone-${panelIndex}">Apply to all panels</button>
        <button class="btn danger" id="remove-${panelIndex}">Remove Panel</button>
      </div>
    </div>
    <div class="panel-msg" id="msg-${panelIndex}"></div>
    <div class="plot" id="plot-${panelIndex}"></div>
  `;

    const obsSelect = panel.querySelector(`#obs-${panelIndex}`);
    const statSelect = panel.querySelector(`#stat-${panelIndex}`);
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
      syncPanelControls(panelIndex);
      plot.renderPanel(panelIndex);
      saveStateToStorage();
    });
    statSelect.addEventListener('change', () => {
      state.panels[panelIndex].ensembleStatMode = statSelect.value;
      plot.renderPanel(panelIndex);
      saveStateToStorage();
    });

    panel.querySelector(`#apply-${panelIndex}`).addEventListener('click', () => {
      plot.renderPanel(panelIndex);
      saveStateToStorage();
    });

    panel.querySelector(`#clone-${panelIndex}`).addEventListener('click', () => {
      const source = state.panels[panelIndex];
      for (let i = 0; i < state.panels.length; i++) {
        if (i === panelIndex) continue;
        state.panels[i] = {
          observable: source.observable,
          indices: source.indices.slice(),
          rawKey: String(source.rawKey || ''),
          ensembleStatMode: String(source.ensembleStatMode || 'mean_ci95_bootstrap'),
        };
      }
      rebuildPanels();
      saveStateToStorage();
      setGlobalStatus('Applied panel settings to all panels.');
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

    return panel;
  }

  function rebuildPanels() {
    const dashboard = document.getElementById('dashboard');
    dashboard.innerHTML = '';

    for (let i = 0; i < state.panels.length; i++) {
      dashboard.appendChild(buildPanel(i));
    }

    for (let i = 0; i < state.panels.length; i++) {
      syncPanelControls(i);
    }

    updateRemoveButtonState();
    plot.renderAllPanels();
  }

  function initGlobalControls() {
    const sourcePklEl = document.getElementById('source-pkl');
    if (sourcePklEl) {
      const sourcePkl = String(meta?.source_pkl || '');
      if (sourcePkl) {
        const filename = sourcePkl.split(/[\\/]/).pop() || sourcePkl;
        sourcePklEl.textContent = `PKL: ${filename}`;
        sourcePklEl.title = sourcePkl;
      } else {
        sourcePklEl.textContent = 'PKL: unknown';
        sourcePklEl.title = 'unknown';
      }
    }

    const trajSelect = document.getElementById('global-traj');
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

    trajSelect.addEventListener('change', () => {
      state.selectedTraj = trajSelect.value;
      plot.renderAllPanels();
      saveStateToStorage();
    });

    const ensembleCb = document.getElementById('global-ensemble');
    ensembleCb.checked = state.showEnsemble;
    ensembleCb.addEventListener('change', () => {
      state.showEnsemble = ensembleCb.checked;
      plot.renderAllPanels();
      saveStateToStorage();
    });

    const tracesCb = document.getElementById('global-traces');
    tracesCb.checked = state.showAllTraces;
    tracesCb.addEventListener('change', () => {
      state.showAllTraces = tracesCb.checked;
      plot.renderAllPanels();
      saveStateToStorage();
    });

    const refreshPklBtn = document.getElementById('refresh-pkl-btn');
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

    const addBtn = document.getElementById('add-panel');
    addBtn.addEventListener('click', () => {
      if (state.panels.length >= MAX_PANELS) {
        setGlobalStatus(`Reached maximum panels (${MAX_PANELS}).`, true);
        return;
      }
      state.panels.push(normalizePanel(defaultPanelForIndex(state.panels.length), state.panels.length));
      rebuildPanels();
      saveStateToStorage();
      setGlobalStatus(`Added panel ${state.panels.length}.`);
    });

    const resetBtn = document.getElementById('reset-panels');
    resetBtn.addEventListener('click', () => {
      state.panels = makeDefaultPanels();
      state.selectedTraj = 'all';
      state.showEnsemble = !!defaults?.plot?.show_ensemble_by_default;
      state.showAllTraces = !!defaults?.plot?.show_all_traces_in_all_mode;

      trajSelect.value = state.selectedTraj;
      ensembleCb.checked = state.showEnsemble;
      tracesCb.checked = state.showAllTraces;

      rebuildPanels();
      saveStateToStorage();
      setGlobalStatus('Reset to default panel layout.');
    });
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
