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
    requiredIndexCount,
    normalizePanel,
    defaultPanelForIndex,
    makeDefaultPanels,
    saveStateToStorage,
    setGlobalStatus,
  } = shared;

  function syncPanelControls(panelIndex) {
    const panelState = state.panels[panelIndex];
    const observable = panelState.observable;
    const needed = requiredIndexCount(observable);
    const indicesWrap = document.getElementById(`indices-wrap-${panelIndex}`);
    const applyBtn = document.getElementById(`apply-${panelIndex}`);
    const cloneBtn = document.getElementById(`clone-${panelIndex}`);

    if (!indicesWrap || !applyBtn || !cloneBtn) return;

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
      <div class="panel-controls">
        <select id="obs-${panelIndex}"></select>
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
    for (const obs of observableOptions) {
      const opt = document.createElement('option');
      opt.value = obs;
      opt.textContent = obs;
      obsSelect.appendChild(opt);
    }

    obsSelect.value = state.panels[panelIndex].observable;

    obsSelect.addEventListener('change', () => {
      state.panels[panelIndex].observable = obsSelect.value;
      syncPanelControls(panelIndex);
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
          indices: source.indices.slice()
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
  };

  initGlobalControls();
  rebuildPanels();
  saveStateToStorage();
})();
