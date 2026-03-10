(function () {
  const root = window.ObservableDashboard || (window.ObservableDashboard = {});
  const shared = root.shared;
  const dataLoader = root.dataLoader;
  if (!shared || !dataLoader) return;

  const NOTEBOOK_SESSION_STORAGE_KEY = 'traj_dashboard_notebook_session_v1';
  const NOTEBOOK_CELLS_STORAGE_KEY = 'traj_dashboard_notebook_cells_v1';
  const PREVIEW_ROW_LIMIT = 20;

  const publishedSubscribers = new Set();
  let sessionId = '';
  let sessionVersion = 0;
  let publishedVariables = [];

  let cells = [];
  let nextCellId = 1;

  function setNotebookStatus(message, isError = false) {
    const el = document.getElementById('notebook-status');
    if (!el) return;
    el.textContent = String(message || '');
    el.classList.toggle('error', !!isError);
  }

  function readSessionIdFromStorage() {
    try {
      return String(sessionStorage.getItem(NOTEBOOK_SESSION_STORAGE_KEY) || '').trim();
    } catch {
      return '';
    }
  }

  function writeSessionIdToStorage(value) {
    try {
      if (!value) {
        sessionStorage.removeItem(NOTEBOOK_SESSION_STORAGE_KEY);
      } else {
        sessionStorage.setItem(NOTEBOOK_SESSION_STORAGE_KEY, String(value));
      }
    } catch {
      // ignore storage failures
    }
  }

  function loadCellsFromStorage() {
    try {
      const raw = localStorage.getItem(NOTEBOOK_CELLS_STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .map((item) => String(item?.code || ''))
        .filter((code) => code.trim().length > 0)
        .map((code) => ({ id: nextCellId++, code, output: null }));
    } catch {
      return [];
    }
  }

  function saveCellsToStorage() {
    try {
      const payload = cells.map((cell) => ({ code: String(cell.code || '') }));
      localStorage.setItem(NOTEBOOK_CELLS_STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // ignore storage failures
    }
  }

  function normalizePublishedList(payload) {
    if (!payload || !Array.isArray(payload.variables)) return [];
    return payload.variables
      .filter((item) => String(item?.name || '').trim())
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }

  function notifyPublishedSubscribers() {
    for (const fn of Array.from(publishedSubscribers)) {
      try {
        fn(publishedVariables.slice());
      } catch {
        // ignore subscriber errors
      }
    }
  }

  async function createSession() {
    const payload = await dataLoader.createNotebookSession();
    sessionId = String(payload?.session_id || '');
    sessionVersion = Number(payload?.session_version || 0);
    writeSessionIdToStorage(sessionId);
    return sessionId;
  }

  async function ensureSession() {
    if (!sessionId) {
      sessionId = readSessionIdFromStorage();
    }
    if (!sessionId) {
      await createSession();
      return sessionId;
    }

    try {
      const payload = await dataLoader.fetchNotebookPublished(sessionId);
      sessionVersion = Number(payload?.session_version || 0);
      publishedVariables = normalizePublishedList(payload);
      notifyPublishedSubscribers();
      return sessionId;
    } catch {
      await createSession();
      return sessionId;
    }
  }

  async function refreshPublishedVariables() {
    if (!sessionId) await ensureSession();
    if (!sessionId) return [];
    const payload = await dataLoader.fetchNotebookPublished(sessionId);
    sessionVersion = Number(payload?.session_version || 0);
    publishedVariables = normalizePublishedList(payload);
    notifyPublishedSubscribers();
    renderPublishedVariables();
    return publishedVariables;
  }

  function trajForCurrentMode(summary) {
    const selectedTraj = String(shared.state?.selectedTraj || '');
    if (selectedTraj && selectedTraj !== 'all') return selectedTraj;
    const previewTraj = String(summary?.preview_traj_id || '').trim();
    if (previewTraj) return previewTraj;
    if (Array.isArray(shared.trajIds) && shared.trajIds.length) return String(shared.trajIds[0]);
    return '';
  }

  function previewCellValue(value) {
    if (Array.isArray(value)) {
      const preview = value.slice(0, 4).map((v) => String(v));
      return value.length > 4 ? `[${preview.join(', ')}, ...]` : `[${preview.join(', ')}]`;
    }
    if (value == null) return 'null';
    return String(value);
  }

  function renderNotebookPreview(record, summary, trajId) {
    const previewEl = document.getElementById('notebook-preview');
    if (!previewEl) return;
    previewEl.innerHTML = '';

    const title = document.createElement('div');
    title.className = 'inspector-key-actions-title';
    title.textContent = (
      `preview ${summary?.name || ''}; traj=${trajId}; `
      + `kind=${record?.series_kind || 'scalar'}; n_points=${Number(record?.n_points || 0)}`
    );
    previewEl.appendChild(title);

    const time = Array.isArray(record?.time) ? record.time : [];
    const scalar = Array.isArray(record?.value) ? record.value : null;
    const matrix = Array.isArray(record?.values) ? record.values : null;
    const rowCount = Math.min(
      PREVIEW_ROW_LIMIT,
      time.length,
      scalar ? scalar.length : Number.MAX_SAFE_INTEGER,
      matrix ? matrix.length : Number.MAX_SAFE_INTEGER
    );

    if (rowCount > 0) {
      const table = document.createElement('table');
      table.className = 'inspector-table';
      const thead = document.createElement('thead');
      const headRow = document.createElement('tr');
      for (const titleText of ['idx', 'time', 'value']) {
        const th = document.createElement('th');
        th.textContent = titleText;
        headRow.appendChild(th);
      }
      thead.appendChild(headRow);
      table.appendChild(thead);

      const tbody = document.createElement('tbody');
      for (let i = 0; i < rowCount; i++) {
        const value = scalar ? scalar[i] : (matrix ? matrix[i] : null);
        const tr = document.createElement('tr');
        for (const cellValue of [i, time[i], previewCellValue(value)]) {
          const td = document.createElement('td');
          const code = document.createElement('code');
          code.textContent = String(cellValue);
          td.appendChild(code);
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      previewEl.appendChild(table);
    }

    if (typeof Plotly !== 'undefined' && time.length > 0) {
      const miniPlot = document.createElement('div');
      miniPlot.className = 'notebook-mini-plot';
      previewEl.appendChild(miniPlot);
      const y = [];
      const x = [];
      if (Array.isArray(record?.value)) {
        const n = Math.min(record.value.length, time.length);
        for (let i = 0; i < n; i++) {
          x.push(time[i]);
          y.push(record.value[i]);
        }
      } else if (Array.isArray(record?.values)) {
        const n = Math.min(record.values.length, time.length);
        for (let i = 0; i < n; i++) {
          const row = record.values[i];
          if (!Array.isArray(row) || !row.length) continue;
          x.push(time[i]);
          y.push(row[0]);
        }
      }
      if (x.length) {
        Plotly.react(
          miniPlot,
          [{
            x,
            y,
            type: 'scatter',
            mode: 'lines',
            line: { color: '#1f77b4', width: 1.5 },
            name: String(summary?.name || 'preview'),
          }],
          {
            template: 'plotly_white',
            margin: { l: 36, r: 12, t: 20, b: 26 },
            xaxis: { title: 't' },
            yaxis: { title: String(summary?.name || 'value') },
            showlegend: false,
            height: 220,
          },
          { responsive: true, displaylogo: false }
        );
      }
    }
  }

  async function previewVariable(summary) {
    const targetTrajId = trajForCurrentMode(summary);
    if (!targetTrajId) {
      setNotebookStatus('No trajectory available for preview.', true);
      return;
    }
    try {
      await ensureSession();
      await dataLoader.ensureNotebookSeries(sessionId, summary.name, targetTrajId);
      const record = dataLoader.getNotebookSeries(sessionId, summary.name, targetTrajId);
      if (!record) {
        throw new Error(`No series for variable '${summary.name}' on traj ${targetTrajId}.`);
      }
      renderNotebookPreview(record, summary, targetTrajId);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setNotebookStatus(detail, true);
    }
  }

  function addPanelForVariable(variableName) {
    shared.state.panels.push(
      shared.normalizePanel(
        {
          observable: 'notebook_var',
          notebookVar: String(variableName || '').trim(),
          indices: [],
        },
        shared.state.panels.length
      )
    );
    if (root.ui && typeof root.ui.rebuildPanels === 'function') {
      root.ui.rebuildPanels();
    }
    shared.saveStateToStorage();
    shared.setGlobalStatus(`Added panel ${shared.state.panels.length}: notebook ${variableName}`);
  }

  function renderPublishedVariables() {
    const wrap = document.getElementById('notebook-published-list');
    if (!wrap) return;
    wrap.innerHTML = '';

    if (!publishedVariables.length) {
      const empty = document.createElement('div');
      empty.className = 'inspector-key-actions-title';
      empty.textContent = 'No published variables yet.';
      wrap.appendChild(empty);
      return;
    }

    const table = document.createElement('table');
    table.className = 'inspector-table';
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const name of ['name', 'kind', 'traj', 'shape', 'actions']) {
      const th = document.createElement('th');
      th.textContent = name;
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (const summary of publishedVariables) {
      const tr = document.createElement('tr');

      const tdName = document.createElement('td');
      const code = document.createElement('code');
      code.textContent = String(summary.name || '');
      tdName.appendChild(code);
      tr.appendChild(tdName);

      const tdKind = document.createElement('td');
      tdKind.textContent = String(summary.series_kind || 'scalar');
      tr.appendChild(tdKind);

      const tdTraj = document.createElement('td');
      tdTraj.textContent = String(summary.traj_count || 0);
      tr.appendChild(tdTraj);

      const tdShape = document.createElement('td');
      tdShape.textContent = `[${(Array.isArray(summary.shape) ? summary.shape : []).join(', ')}]`;
      tr.appendChild(tdShape);

      const tdActions = document.createElement('td');
      const previewBtn = document.createElement('button');
      previewBtn.type = 'button';
      previewBtn.className = 'btn';
      previewBtn.textContent = 'Preview';
      previewBtn.addEventListener('click', () => {
        void previewVariable(summary);
      });
      tdActions.appendChild(previewBtn);

      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'btn';
      addBtn.textContent = 'Add Panel';
      addBtn.style.marginLeft = '6px';
      addBtn.addEventListener('click', () => {
        addPanelForVariable(summary.name);
      });
      tdActions.appendChild(addBtn);
      tr.appendChild(tdActions);

      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
  }

  function cellById(cellId) {
    return cells.find((cell) => Number(cell.id) === Number(cellId)) || null;
  }

  function renderCellOutput(cell, output) {
    cell.output = output || null;
    const stdoutEl = document.getElementById(`nb-cell-stdout-${cell.id}`);
    const stderrEl = document.getElementById(`nb-cell-stderr-${cell.id}`);
    const statusEl = document.getElementById(`nb-cell-status-${cell.id}`);
    if (!stdoutEl || !stderrEl || !statusEl) return;

    if (!output) {
      stdoutEl.textContent = '';
      stderrEl.textContent = '';
      statusEl.textContent = '';
      statusEl.classList.remove('error');
      return;
    }

    const stdout = String(output?.stdout || '');
    const stderr = String(output?.stderr || '');
    const errorMessage = output?.error_message ? String(output.error_message) : '';
    const traceback = output?.traceback ? String(output.traceback) : '';
    stdoutEl.textContent = stdout;
    stderrEl.textContent = `${stderr}${errorMessage ? `${stderr ? '\n' : ''}${errorMessage}` : ''}${traceback ? `\n${traceback}` : ''}`;

    const runMs = Number(output?.run_ms || 0);
    const updates = Array.isArray(output?.published_updates) ? output.published_updates : [];
    if (output && output.ok === false) {
      statusEl.textContent = `Run failed (${runMs.toFixed(1)}ms).`;
      statusEl.classList.add('error');
    } else {
      statusEl.textContent = `Run finished (${runMs.toFixed(1)}ms), published=${updates.length}.`;
      statusEl.classList.remove('error');
    }
  }

  async function runCell(cellId, mode) {
    const cell = cellById(cellId);
    if (!cell) return;
    const code = String(cell.code || '');
    if (!code.trim()) {
      setNotebookStatus('Cell is empty.', true);
      return;
    }

    if (mode === 'current' && String(shared.state.selectedTraj || '') === 'all') {
      setNotebookStatus('Run Current requires selecting a specific trajectory (not All).', true);
      return;
    }

    try {
      await ensureSession();
      const trajId = mode === 'current' ? String(shared.state.selectedTraj || '') : null;
      setNotebookStatus(`Running cell ${cellId} (${mode})...`);
      const output = await dataLoader.executeNotebookCell(sessionId, code, mode, trajId);
      sessionVersion = Number(output?.session_version || 0);
      dataLoader.clearNotebookCacheForSession(sessionId);
      renderCellOutput(cell, output);
      await refreshPublishedVariables();
      if (root.ui && typeof root.ui.refreshNotebookPanelControls === 'function') {
        root.ui.refreshNotebookPanelControls();
      }
      if (Array.isArray(output?.published_updates) && output.published_updates.length > 0) {
        if (root.plot && typeof root.plot.renderAllPanels === 'function') {
          void root.plot.renderAllPanels();
        }
      }
      if (output.ok) {
        setNotebookStatus(`Cell ${cellId} executed (${mode}).`);
      } else {
        setNotebookStatus(`Cell ${cellId} finished with error.`, true);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setNotebookStatus(detail, true);
    }
  }

  async function runAllCells(mode) {
    if (!cells.length) {
      setNotebookStatus('No cells to run.');
      return;
    }
    if (mode === 'current' && String(shared.state.selectedTraj || '') === 'all') {
      setNotebookStatus('Run Current requires selecting a specific trajectory (not All).', true);
      return;
    }
    for (const cell of cells) {
      await runCell(cell.id, mode);
    }
  }

  function moveCell(cellId, direction) {
    const idx = cells.findIndex((item) => Number(item.id) === Number(cellId));
    if (idx < 0) return;
    const target = idx + direction;
    if (target < 0 || target >= cells.length) return;
    const next = cells.slice();
    const [item] = next.splice(idx, 1);
    next.splice(target, 0, item);
    cells = next;
    saveCellsToStorage();
    renderCells();
  }

  function removeCell(cellId) {
    cells = cells.filter((item) => Number(item.id) !== Number(cellId));
    if (!cells.length) {
      cells.push({ id: nextCellId++, code: '', output: null });
    }
    saveCellsToStorage();
    renderCells();
  }

  function renderCells() {
    const container = document.getElementById('notebook-cells');
    if (!container) return;
    container.innerHTML = '';

    for (const cell of cells) {
      const wrap = document.createElement('div');
      wrap.className = 'notebook-cell';
      wrap.innerHTML = `
        <div class="notebook-cell-head">
          <div class="notebook-cell-title">Cell ${cell.id}</div>
          <div class="notebook-cell-actions">
            <button class="btn" id="nb-cell-run-current-${cell.id}" type="button">Run Current</button>
            <button class="btn" id="nb-cell-run-all-${cell.id}" type="button">Run All Traj</button>
            <button class="btn" id="nb-cell-up-${cell.id}" type="button">Up</button>
            <button class="btn" id="nb-cell-down-${cell.id}" type="button">Down</button>
            <button class="btn danger" id="nb-cell-remove-${cell.id}" type="button">Remove</button>
          </div>
        </div>
        <textarea id="nb-cell-code-${cell.id}" class="notebook-cell-code" rows="6" placeholder="import numpy as np
arr = get_raw('_.0.record.Etot')
publish('etot_copy', arr)"></textarea>
        <div class="notebook-cell-status" id="nb-cell-status-${cell.id}"></div>
        <pre class="notebook-cell-output" id="nb-cell-stdout-${cell.id}"></pre>
        <pre class="notebook-cell-output error" id="nb-cell-stderr-${cell.id}"></pre>
      `;
      container.appendChild(wrap);

      const codeEl = wrap.querySelector(`#nb-cell-code-${cell.id}`);
      codeEl.value = String(cell.code || '');
      codeEl.addEventListener('input', () => {
        cell.code = String(codeEl.value || '');
        saveCellsToStorage();
      });
      codeEl.addEventListener('keydown', (event) => {
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
          event.preventDefault();
          void runCell(cell.id, 'current');
        }
      });

      wrap.querySelector(`#nb-cell-run-current-${cell.id}`)?.addEventListener('click', () => {
        void runCell(cell.id, 'current');
      });
      wrap.querySelector(`#nb-cell-run-all-${cell.id}`)?.addEventListener('click', () => {
        void runCell(cell.id, 'all');
      });
      wrap.querySelector(`#nb-cell-up-${cell.id}`)?.addEventListener('click', () => moveCell(cell.id, -1));
      wrap.querySelector(`#nb-cell-down-${cell.id}`)?.addEventListener('click', () => moveCell(cell.id, 1));
      wrap.querySelector(`#nb-cell-remove-${cell.id}`)?.addEventListener('click', () => removeCell(cell.id));

      renderCellOutput(cell, cell.output);
    }
  }

  function addCell() {
    cells.push({ id: nextCellId++, code: '', output: null });
    saveCellsToStorage();
    renderCells();
  }

  async function resetSession() {
    if (!sessionId) await ensureSession();
    if (!sessionId) return;
    await dataLoader.resetNotebookSession(sessionId);
    sessionVersion += 1;
    dataLoader.clearNotebookCacheForSession(sessionId);
    publishedVariables = [];
    notifyPublishedSubscribers();
    renderPublishedVariables();
    const preview = document.getElementById('notebook-preview');
    if (preview) preview.innerHTML = '';
    setNotebookStatus('Notebook kernel reset.');
    if (root.ui && typeof root.ui.refreshNotebookPanelControls === 'function') {
      root.ui.refreshNotebookPanelControls();
    }
  }

  function initNotebookWorkspace() {
    const panel = document.getElementById('notebook-workspace');
    if (!panel) return;

    cells = loadCellsFromStorage();
    if (!cells.length) {
      cells = [{ id: nextCellId++, code: '', output: null }];
    }
    renderCells();

    const addCellBtn = document.getElementById('notebook-add-cell');
    addCellBtn?.addEventListener('click', () => addCell());

    const runAllCurrentBtn = document.getElementById('notebook-run-all-cells-current');
    runAllCurrentBtn?.addEventListener('click', () => {
      void runAllCells('current');
    });

    const runAllAllBtn = document.getElementById('notebook-run-all-cells-all');
    runAllAllBtn?.addEventListener('click', () => {
      void runAllCells('all');
    });

    const refreshBtn = document.getElementById('notebook-refresh-published');
    refreshBtn?.addEventListener('click', () => {
      void refreshPublishedVariables();
    });

    const resetBtn = document.getElementById('notebook-reset');
    resetBtn?.addEventListener('click', () => {
      void resetSession();
    });

    void ensureSession()
      .then(() => refreshPublishedVariables())
      .catch((error) => {
        const detail = error instanceof Error ? error.message : String(error);
        setNotebookStatus(detail, true);
      });
  }

  root.notebook = {
    ensureSession,
    refreshPublishedVariables,
    getSessionId: () => String(sessionId || ''),
    getSessionVersion: () => Number(sessionVersion || 0),
    getPublishedVariables: () => publishedVariables.slice(),
    subscribePublishedVariables: (fn) => {
      if (typeof fn !== 'function') return () => {};
      publishedSubscribers.add(fn);
      return () => publishedSubscribers.delete(fn);
    },
    addPanelForVariable,
  };

  initNotebookWorkspace();
})();
