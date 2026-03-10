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

  function parseScriptJson(id, label, allowTemplateHint = false) {
    const el = document.getElementById(id);
    if (!el) return null;
    const raw = String(el.textContent || '');
    try {
      return JSON.parse(raw);
    } catch (error) {
      let hint = `${label} is not valid JSON.`;
      if (allowTemplateHint && (raw.includes('{{ bootstrap_json') || raw.includes('{%'))) {
        hint = 'Detected an unrendered template. Open served dashboard page instead of templates/index.html.j2.';
      }
      console.error(`ObservableDashboard parse failed for ${id}:`, error);
      showBootError(`Dashboard failed to initialize: ${hint}`);
      return null;
    }
  }

  const bootstrap = parseScriptJson('bootstrap-json', 'bootstrap-json', true);
  if (!bootstrap) {
    showBootError('Dashboard failed to initialize: missing bootstrap-json script.');
    return;
  }

  const dataMode = String(bootstrap.data_mode || 'api');
  if (dataMode !== 'api') {
    showBootError(`Dashboard frontend expects API mode, but received data_mode='${dataMode}'.`);
    return;
  }

  const meta = bootstrap.meta || {};
  const defaults = bootstrap.defaults || {};
  const trajIds = Array.isArray(bootstrap.traj_ids)
    ? bootstrap.traj_ids.map((v) => String(v))
    : (Array.isArray(meta?.traj_ids) ? meta.traj_ids.map((v) => String(v)) : []);
  const apiBase = typeof bootstrap.api_base === 'string' && bootstrap.api_base.trim()
    ? bootstrap.api_base
    : '/api';

  const STORAGE_KEY = 'traj_dashboard_state_v1';
  const MIN_PANELS = 1;
  const DEFAULT_PANEL_COUNT = Math.max(MIN_PANELS, Number(defaults?.ui?.default_panel_count || 4));
  const RAW_ALIAS_PREFIX = 'raw_alias::';
  const observableOptions = [
    'bond', 'angle', 'dihedral', 'etot', 'eig', 'nac', 'de_nac', 'state', '|c|^2', 'raw_key', 'expression'
  ];
  const ensembleStatModes = ['mean_ci95_bootstrap', 'median_iqr', 'renorm_mean_ci95_bootstrap'];

  function normalizeRawKeyAliases(rawAliases) {
    const out = {};
    if (Array.isArray(rawAliases)) {
      for (const item of rawAliases) {
        const alias = String(item?.alias || '').trim();
        const rawKey = String(item?.raw_key || '').trim();
        if (!alias || !rawKey) continue;
        out[alias] = rawKey;
      }
      return out;
    }
    if (rawAliases && typeof rawAliases === 'object') {
      for (const [rawAlias, rawKeyValue] of Object.entries(rawAliases)) {
        const alias = String(rawAlias || '').trim();
        const rawKey = String(rawKeyValue || '').trim();
        if (!alias || !rawKey) continue;
        out[alias] = rawKey;
      }
    }
    return out;
  }

  function parseRawAliasObservable(observable) {
    const text = String(observable || '');
    if (!text.startsWith(RAW_ALIAS_PREFIX)) return '';
    return text.slice(RAW_ALIAS_PREFIX.length).trim();
  }

  function isRawAliasObservable(observable) {
    return parseRawAliasObservable(observable).length > 0;
  }

  function makeRawAliasObservable(alias) {
    return `${RAW_ALIAS_PREFIX}${String(alias || '').trim()}`;
  }

  function rawAliasFromObservable(observable) {
    return parseRawAliasObservable(observable);
  }

  function isRawObservable(observable) {
    return String(observable || '') === 'raw_key' || isRawAliasObservable(observable);
  }

  function canonicalObservable(observable) {
    if (isRawAliasObservable(observable)) return 'raw_key';
    return String(observable || '');
  }

  function resolveRawKeyForPanel(panelState, rawKeyAliases) {
    const observable = String(panelState?.observable || '');
    if (observable === 'raw_key') {
      return String(panelState?.rawKey || '').trim();
    }
    const alias = rawAliasFromObservable(observable);
    if (!alias) return '';
    const aliasMap = normalizeRawKeyAliases(rawKeyAliases);
    return String(aliasMap[alias] || '').trim();
  }

  function requiredIndexCount(observable) {
    const canonical = canonicalObservable(observable);
    if (canonical === 'bond') return 2;
    if (canonical === 'angle') return 3;
    if (canonical === 'dihedral') return 4;
    if (canonical === 'de_nac') return 2;
    if (canonical === 'expression') return 0;
    return 0;
  }

  function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  function defaultPanelForIndex(index) {
    const defaultPanels = Array.isArray(defaults?.panels) ? defaults.panels : [];
    if (index < defaultPanels.length && defaultPanels[index]) {
      return deepClone(defaultPanels[index]);
    }
    return { observable: 'etot', indices: [] };
  }

  function normalizePanel(panel, fallbackIndex) {
    const fallback = defaultPanelForIndex(fallbackIndex);
    const fallbackObservable = String(fallback?.observable || 'etot');
    const fallbackAllowed = observableOptions.includes(fallbackObservable) || isRawAliasObservable(fallbackObservable)
      ? fallbackObservable
      : 'etot';
    const observableCandidate = String(panel?.observable || fallbackAllowed);
    const normalizedObservable = observableOptions.includes(observableCandidate) || isRawAliasObservable(observableCandidate)
      ? observableCandidate
      : fallbackAllowed;
    const modeCandidate = String(panel?.ensembleStatMode ?? fallback?.ensembleStatMode ?? 'mean_ci95_bootstrap');
    const out = {
      observable: normalizedObservable,
      indices: [],
      rawKey: '',
      expression: '',
      expressionLabel: '',
      ensembleStatMode: ensembleStatModes.includes(modeCandidate) ? modeCandidate : 'mean_ci95_bootstrap',
    };

    if (out.observable === 'raw_key') {
      const candidate = panel?.rawKey ?? fallback?.rawKey ?? '';
      out.rawKey = String(candidate || '').trim();
    }

    if (out.observable === 'expression') {
      const expressionCandidate = panel?.expression ?? fallback?.expression ?? '';
      const expressionLabelCandidate = panel?.expressionLabel ?? fallback?.expressionLabel ?? '';
      out.expression = String(expressionCandidate || '').trim();
      out.expressionLabel = String(expressionLabelCandidate || '').trim();
    }

    const needed = requiredIndexCount(out.observable);
    const raw = Array.isArray(panel?.indices)
      ? panel.indices
      : (Array.isArray(fallback.indices) ? fallback.indices : []);

    const parsed = [];
    for (const v of raw) {
      const n = Number.parseInt(v, 10);
      if (Number.isFinite(n)) parsed.push(n);
    }

    if (needed > 0) {
      while (parsed.length < needed) {
        if (out.observable === 'de_nac' && parsed.length === 1) {
          parsed.push(1);
        } else {
          parsed.push(0);
        }
      }
      out.indices = parsed.slice(0, needed);
      if (out.observable === 'de_nac' && out.indices.length === 2 && out.indices[0] === out.indices[1]) {
        out.indices[1] = out.indices[0] + 1;
      }
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
    if (!el) return;
    el.textContent = message || '';
    el.classList.toggle('error', !!isError);
  }

  function buildInitialState() {
    return {
      selectedTraj: 'all',
      showEnsemble: !!defaults?.plot?.show_ensemble_by_default,
      showAllTraces: !!defaults?.plot?.show_all_traces_in_all_mode,
      panels: makeDefaultPanels(),
      rawKeyAliases: normalizeRawKeyAliases(bootstrap?.raw_key_aliases),
      dataMode: 'api',
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
        const panelCount = Math.max(MIN_PANELS, parsed.panels.length);
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
        // ignore
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
        panels: state.panels,
      }));
    } catch {
      // ignore storage failures
    }
  }

  const state = loadStateFromStorage(buildInitialState());
  state.dataMode = 'api';

  root.shared = {
    bootstrap,
    meta,
    defaults,
    trajIds,
    dataMode: 'api',
    apiBase,
    STORAGE_KEY,
    MIN_PANELS,
    DEFAULT_PANEL_COUNT,
    RAW_ALIAS_PREFIX,
    observableOptions,
    ensembleStatModes,
    normalizeRawKeyAliases,
    parseRawAliasObservable,
    isRawAliasObservable,
    makeRawAliasObservable,
    rawAliasFromObservable,
    isRawObservable,
    canonicalObservable,
    resolveRawKeyForPanel,
    requiredIndexCount,
    defaultPanelForIndex,
    normalizePanel,
    makeDefaultPanels,
    state,
    saveStateToStorage,
    setGlobalStatus,
  };
})();
