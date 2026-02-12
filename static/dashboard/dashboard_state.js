(function () {
  const root = window.ObservableDashboard || (window.ObservableDashboard = {});

  function showBootError(message) {
    const statusEl = document.getElementById('panel-status');
    if (statusEl) {
      statusEl.textContent = message;
      statusEl.classList.add('error');
      return;
    }

    const box = document.createElement('div');
    box.style.margin = '12px';
    box.style.padding = '10px 12px';
    box.style.border = '1px solid #d33';
    box.style.borderRadius = '6px';
    box.style.background = '#fff6f6';
    box.style.color = '#b00020';
    box.style.font = '14px/1.4 sans-serif';
    box.textContent = message;
    document.body.prepend(box);
  }

  const payloadEl = document.getElementById('payload-json');
  if (!payloadEl) {
    showBootError('Dashboard failed to initialize: missing embedded payload-json script.');
    return;
  }

  let payload;
  try {
    payload = JSON.parse(payloadEl.textContent || '');
  } catch (error) {
    const raw = String(payloadEl.textContent || '');
    const templateHint = raw.includes('{{ payload_json') || raw.includes('{%');
    const hint = templateHint
      ? 'Detected an unrendered template. Open generated analysis_viz/index.html instead of templates/index.html.j2.'
      : 'Embedded payload-json content is not valid JSON.';
    console.error('ObservableDashboard payload parse failed:', error);
    showBootError(`Dashboard failed to initialize: ${hint}`);
    return;
  }

  const meta = payload.meta;
  const trajectories = payload.trajectories;
  const trajIds = meta.traj_ids;

  const STORAGE_KEY = 'traj_dashboard_state_v1';
  const MIN_PANELS = 1;
  const MAX_PANELS = Math.max(1, Number(payload.defaults?.ui?.max_panels || 8));
  const DEFAULT_PANEL_COUNT = Math.min(MAX_PANELS, Math.max(MIN_PANELS, Number(payload.defaults?.ui?.default_panel_count || 4)));

  const observableOptions = ['bond', 'angle', 'dihedral', 'etot', 'eig', 'nac', 'state', '|c|^2'];

  function requiredIndexCount(observable) {
    if (observable === 'bond') return 2;
    if (observable === 'angle') return 3;
    if (observable === 'dihedral') return 4;
    return 0;
  }

  function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  function defaultPanelForIndex(index) {
    const defaultPanels = Array.isArray(payload.defaults?.panels) ? payload.defaults.panels : [];
    if (index < defaultPanels.length && defaultPanels[index]) {
      return deepClone(defaultPanels[index]);
    }
    return { observable: 'etot', indices: [] };
  }

  function normalizePanel(panel, fallbackIndex) {
    const fallback = defaultPanelForIndex(fallbackIndex);
    const out = {
      observable: observableOptions.includes(panel?.observable) ? panel.observable : fallback.observable,
      indices: []
    };

    const needed = requiredIndexCount(out.observable);
    const raw = Array.isArray(panel?.indices) ? panel.indices : (Array.isArray(fallback.indices) ? fallback.indices : []);
    const parsed = [];
    for (const v of raw) {
      const n = Number.parseInt(v, 10);
      if (Number.isFinite(n)) parsed.push(n);
    }

    if (needed > 0) {
      while (parsed.length < needed) parsed.push(0);
      out.indices = parsed.slice(0, needed);
    }
    return out;
  }

  function makeDefaultPanels() {
    const out = [];
    for (let i = 0; i < DEFAULT_PANEL_COUNT; i++) {
      out.push(normalizePanel(defaultPanelForIndex(i), i));
    }
    return out;
  }

  function setGlobalStatus(message, isError = false) {
    const el = document.getElementById('panel-status');
    el.textContent = message || '';
    if (isError) {
      el.classList.add('error');
    } else {
      el.classList.remove('error');
    }
  }

  function buildInitialState() {
    return {
      selectedTraj: 'all',
      showEnsemble: !!payload.defaults?.plot?.show_ensemble_by_default,
      showAllTraces: !!payload.defaults?.plot?.show_all_traces_in_all_mode,
      panels: makeDefaultPanels()
    };
  }

  function loadStateFromStorage(baseState) {
    let raw;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch {
      return baseState;
    }

    if (!raw) return baseState;

    try {
      const parsed = JSON.parse(raw);

      if (typeof parsed.selectedTraj === 'string') {
        if (parsed.selectedTraj === 'all' || trajIds.includes(parsed.selectedTraj)) {
          baseState.selectedTraj = parsed.selectedTraj;
        }
      }

      if (typeof parsed.showEnsemble === 'boolean') baseState.showEnsemble = parsed.showEnsemble;
      if (typeof parsed.showAllTraces === 'boolean') baseState.showAllTraces = parsed.showAllTraces;

      if (Array.isArray(parsed.panels)) {
        const panelCount = Math.min(MAX_PANELS, Math.max(MIN_PANELS, parsed.panels.length));
        const restored = [];
        for (let i = 0; i < panelCount; i++) {
          restored.push(normalizePanel(parsed.panels[i] || {}, i));
        }
        baseState.panels = restored;
      }
    } catch {
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch {
        // ignore localStorage cleanup error
      }
    }

    return baseState;
  }

  function saveStateToStorage() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        selectedTraj: state.selectedTraj,
        showEnsemble: state.showEnsemble,
        showAllTraces: state.showAllTraces,
        panels: state.panels
      }));
    } catch {
      // ignore storage failures
    }
  }

  const state = loadStateFromStorage(buildInitialState());

  root.shared = {
    payload,
    meta,
    trajectories,
    trajIds,
    STORAGE_KEY,
    MIN_PANELS,
    MAX_PANELS,
    DEFAULT_PANEL_COUNT,
    observableOptions,
    requiredIndexCount,
    defaultPanelForIndex,
    normalizePanel,
    makeDefaultPanels,
    state,
    saveStateToStorage,
    setGlobalStatus,
  };
})();
