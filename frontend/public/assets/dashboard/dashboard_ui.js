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
  const PANEL_ROW_LAYOUT_STORAGE_KEY = 'traj_dashboard_panel_row_layout_v1';
  let draggingPanelIndex = -1;
  let draggingPanelRef = null;
  let panelRows = [];

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
    if (mode === 'renorm_mean_ci95_bootstrap') return 'Renormalize mean + 95% CI';
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
      if (statSelect) statSelect.style.display = 'inline-block';
      indicesWrap.style.display = 'none';
      applyBtn.style.display = 'inline-block';
    } else if (observable === 'notebook_var') {
      if (exprWrap) exprWrap.style.display = 'none';
      if (notebookWrap) notebookWrap.style.display = 'flex';
      if (statSelect) statSelect.style.display = 'none';
      indicesWrap.style.display = 'none';
      applyBtn.style.display = 'inline-block';
    } else {
      if (exprWrap) exprWrap.style.display = 'none';
      if (notebookWrap) notebookWrap.style.display = 'none';
      if (statSelect) statSelect.style.display = 'inline-block';
    }

    if (observable !== 'expression' && observable !== 'notebook_var' && needed > 0) {
      indicesWrap.style.display = 'flex';
      applyBtn.style.display = 'inline-block';
    } else if (observable !== 'expression' && observable !== 'notebook_var') {
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
        <div id="notebook-wrap-${panelIndex}" class="notebook-wrap">
          <select id="notebook-var-${panelIndex}" class="notebook-var-select"></select>
        </div>
        <button class="btn" id="apply-${panelIndex}">Apply</button>
        <button class="btn" id="export-${panelIndex}">Export Data</button>
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

  function refreshNotebookPanelControls() {
    for (let i = 0; i < state.panels.length; i++) {
      syncPanelControls(i);
    }
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
    const detailsEl = document.getElementById('traj-break-summary');
    const statusEl = document.getElementById('break-summary-status');
    const listEl = document.getElementById('break-summary-list');
    if (!detailsEl || !statusEl || !listEl) return;

    const summary = normalizeBreakSummary(meta?.trajectory_break_summary);
    listEl.innerHTML = '';

    if (!summary) {
      statusEl.textContent = 'Trajectory completion summary is unavailable for this dataset.';
      statusEl.classList.remove('ok');
      statusEl.classList.add('warn');
      detailsEl.setAttribute('open', '');
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
      detailsEl.removeAttribute('open');
      return;
    }

    statusEl.textContent = `Broken trajectories: ${brokenCount}/${total}.`;
    statusEl.classList.remove('ok');
    statusEl.classList.add('warn');
    detailsEl.setAttribute('open', '');

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
    renderTrajectoryBreakSummary();

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
