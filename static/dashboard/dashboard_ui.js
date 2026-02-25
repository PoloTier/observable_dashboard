(function () {
  const root = window.ObservableDashboard || (window.ObservableDashboard = {});
  const shared = root.shared;
  const plot = root.plot;
  const dataLoader = root.dataLoader;
  const notebook = root.notebook;
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
  const EXPR_INSPECTOR_INPUT_STORAGE_KEY = 'traj_dashboard_expression_input_v1';
  const EXPR_INSPECTOR_LABEL_STORAGE_KEY = 'traj_dashboard_expression_label_v1';
  const EXPR_PREVIEW_LIMIT = 12;

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
    if (state.panels.length >= MAX_PANELS) {
      setGlobalStatus(`Reached maximum panels (${MAX_PANELS}).`, true);
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
        await dataLoader.ensureExpressionDataset(expression);
        record = dataLoader.getExpressionDataset(expression);
        contextText = 'context=dataset(all)';
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
    const inspectorEl = document.getElementById('key-inspector');
    const inputEl = document.getElementById('key-inspector-input');
    const runBtn = document.getElementById('key-inspector-run');
    const clearBtn = document.getElementById('key-inspector-clear');
    if (!inspectorEl || !inputEl || !runBtn || !clearBtn) return;

    const exprInputEl = document.getElementById('expr-inspector-input');
    const exprLabelEl = document.getElementById('expr-inspector-label');
    const exprRunBtn = document.getElementById('expr-inspector-run');
    const exprAddBtn = document.getElementById('expr-inspector-add');
    const exprClearBtn = document.getElementById('expr-inspector-clear');

    const saved = loadInspectorInput();
    if (saved) {
      inputEl.value = saved;
      inspectorEl.setAttribute('open', '');
      void runInspector();
    }

    const savedExpr = loadExpressionInspectorInput();
    const savedExprLabel = loadExpressionInspectorLabel();
    if (exprInputEl && savedExpr) {
      exprInputEl.value = savedExpr;
      inspectorEl.setAttribute('open', '');
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
    return 'Mean + 95% CI';
  }

  function notebookVariableSummaries() {
    if (!notebook || typeof notebook.getPublishedVariables !== 'function') return [];
    const raw = notebook.getPublishedVariables();
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((item) => String(item?.name || '').trim())
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
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
    const notebookWrap = document.getElementById(`notebook-wrap-${panelIndex}`);
    const notebookVarSelect = document.getElementById(`notebook-var-${panelIndex}`);
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

    if (exprInput) {
      exprInput.value = String(panelState.expression || '');
    }
    if (exprLabelInput) {
      exprLabelInput.value = String(panelState.expressionLabel || '');
    }

    if (notebookVarSelect) {
      const summaries = notebookVariableSummaries();
      const currentValue = String(panelState.notebookVar || '').trim();
      notebookVarSelect.innerHTML = '';
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = '(select notebook variable)';
      notebookVarSelect.appendChild(placeholder);
      for (const summary of summaries) {
        const opt = document.createElement('option');
        opt.value = String(summary.name);
        opt.textContent = String(summary.name);
        notebookVarSelect.appendChild(opt);
      }
      if (currentValue && !summaries.some((summary) => String(summary.name) === currentValue)) {
        const missingOpt = document.createElement('option');
        missingOpt.value = currentValue;
        missingOpt.textContent = `${currentValue} (missing)`;
        notebookVarSelect.appendChild(missingOpt);
      }
      notebookVarSelect.value = currentValue;
    }

    if (subtitleEl) {
      if (observable === 'expression') {
        const expressionText = String(panelState.expression || '').trim();
        subtitleEl.textContent = expressionText ? `expr: ${expressionText}` : 'expr: (empty)';
        subtitleEl.title = expressionText;
        subtitleEl.style.display = 'block';
      } else if (observable === 'notebook_var') {
        const notebookVar = String(panelState.notebookVar || '').trim();
        subtitleEl.textContent = notebookVar ? `notebook: ${notebookVar}` : 'notebook: (select variable)';
        subtitleEl.title = subtitleEl.textContent;
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
      if (notebookWrap) notebookWrap.style.display = 'none';
      if (statSelect) statSelect.style.display = 'none';
      indicesWrap.style.display = 'none';
      applyBtn.style.display = 'inline-block';
      cloneBtn.style.display = 'inline-block';
    } else if (observable === 'notebook_var') {
      if (exprWrap) exprWrap.style.display = 'none';
      if (notebookWrap) notebookWrap.style.display = 'flex';
      if (statSelect) statSelect.style.display = 'none';
      indicesWrap.style.display = 'none';
      applyBtn.style.display = 'inline-block';
      cloneBtn.style.display = 'inline-block';
    } else {
      if (exprWrap) exprWrap.style.display = 'none';
      if (notebookWrap) notebookWrap.style.display = 'none';
      if (statSelect) statSelect.style.display = 'inline-block';
    }

    if (observable !== 'expression' && observable !== 'notebook_var' && needed > 0) {
      indicesWrap.style.display = 'flex';
      applyBtn.style.display = 'inline-block';
      cloneBtn.style.display = 'inline-block';
    } else if (observable !== 'expression' && observable !== 'notebook_var') {
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
        <div id="expr-wrap-${panelIndex}" class="expr-wrap">
          <input type="text" id="expr-${panelIndex}" class="expr-input" placeholder="Expression" />
          <input type="text" id="expr-label-${panelIndex}" class="expr-label-input" placeholder="Label (optional)" />
        </div>
        <div id="notebook-wrap-${panelIndex}" class="notebook-wrap">
          <select id="notebook-var-${panelIndex}" class="notebook-var-select"></select>
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
    const exprInput = panel.querySelector(`#expr-${panelIndex}`);
    const exprLabelInput = panel.querySelector(`#expr-label-${panelIndex}`);
    const notebookVarSelect = panel.querySelector(`#notebook-var-${panelIndex}`);
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
      if (state.panels[panelIndex].observable !== 'notebook_var') {
        state.panels[panelIndex].notebookVar = '';
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

    exprInput?.addEventListener('input', () => {
      state.panels[panelIndex].expression = String(exprInput.value || '').trim();
      saveStateToStorage();
    });
    exprLabelInput?.addEventListener('input', () => {
      state.panels[panelIndex].expressionLabel = String(exprLabelInput.value || '').trim();
      saveStateToStorage();
    });

    notebookVarSelect?.addEventListener('change', () => {
      state.panels[panelIndex].notebookVar = String(notebookVarSelect.value || '').trim();
      plot.renderPanel(panelIndex);
      saveStateToStorage();
    });

    exprInput?.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.shiftKey) return;
      event.preventDefault();
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
          expression: String(source.expression || ''),
          expressionLabel: String(source.expressionLabel || ''),
          notebookVar: String(source.notebookVar || ''),
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

  function refreshNotebookPanelControls() {
    for (let i = 0; i < state.panels.length; i++) {
      syncPanelControls(i);
    }
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
    refreshNotebookPanelControls,
    initGlobalControls,
    initKeyInspector,
  };

  if (notebook && typeof notebook.subscribePublishedVariables === 'function') {
    notebook.subscribePublishedVariables(() => {
      refreshNotebookPanelControls();
      if (state.panels.some((panel) => String(panel?.observable || '') === 'notebook_var')) {
        plot.renderAllPanels();
      }
    });
  }

  initGlobalControls();
  initKeyInspector();
  rebuildPanels();
  saveStateToStorage();
})();
