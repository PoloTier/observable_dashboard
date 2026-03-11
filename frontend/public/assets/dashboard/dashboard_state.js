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
  const datasetLoaded = !!meta?.dataset_loaded;
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
  const hoppingAlgorithmOptions = ['max_abs_c'];
  const hoppingTimeRuleOptions = ['arrival_frame'];
  const hoppingColorPalette = ['#d62728', '#1f77b4', '#2ca02c', '#ff7f0e', '#9467bd', '#17becf'];

  function nStatesMax() {
    const value = Number.parseInt(meta?.n_states, 10);
    return Number.isFinite(value) && value > 0 ? value : 0;
  }

  function normalizeHexColor(value, fallback) {
    const text = String(value || '').trim();
    return /^#[0-9a-fA-F]{6}$/.test(text) ? text.toLowerCase() : String(fallback || '#d62728');
  }

  function defaultHoppingPairForIndex(index) {
    const stateCount = nStatesMax();
    const fallback = { fromState: 1, toState: 0 };
    if (stateCount < 2) return fallback;

    const pairs = [];
    for (let fromState = 1; fromState < stateCount; fromState++) {
      for (let toState = 0; toState < stateCount; toState++) {
        if (fromState === toState) continue;
        pairs.push({ fromState, toState });
      }
    }
    if (!pairs.length) return fallback;
    const normalizedIndex = Math.max(0, Number.parseInt(index, 10) || 0);
    return pairs[normalizedIndex % pairs.length];
  }

  function defaultHoppingGroupForIndex(index) {
    const pair = defaultHoppingPairForIndex(index);
    return {
      id: `hop_${Math.max(0, Number.parseInt(index, 10) || 0)}_${pair.fromState}_${pair.toState}`,
      fromState: pair.fromState,
      toState: pair.toState,
      color: hoppingColorPalette[Math.max(0, Number.parseInt(index, 10) || 0) % hoppingColorPalette.length],
      enabled: true,
    };
  }

  function normalizeHoppingGroup(group, fallbackIndex) {
    const fallback = defaultHoppingGroupForIndex(fallbackIndex);
    let fromState = Number.parseInt(group?.fromState ?? group?.from_state ?? fallback.fromState, 10);
    let toState = Number.parseInt(group?.toState ?? group?.to_state ?? fallback.toState, 10);
    if (!Number.isFinite(fromState) || fromState < 0) fromState = fallback.fromState;
    if (!Number.isFinite(toState) || toState < 0) toState = fallback.toState;

    const stateCount = nStatesMax();
    if (stateCount > 0) {
      fromState = Math.min(fromState, stateCount - 1);
      toState = Math.min(toState, stateCount - 1);
    }
    if (fromState === toState) {
      if (stateCount >= 2) {
        toState = fromState > 0 ? fromState - 1 : 1;
      } else {
        fromState = fallback.fromState;
        toState = fallback.toState;
      }
    }

    const idCandidate = String(group?.id || '').trim();
    return {
      id: idCandidate || `hop_${Math.max(0, Number.parseInt(fallbackIndex, 10) || 0)}_${fromState}_${toState}`,
      fromState,
      toState,
      color: normalizeHexColor(group?.color, fallback.color),
      enabled: group?.enabled !== false,
    };
  }

  function buildDefaultHoppingConfig() {
    return {
      algorithm: 'max_abs_c',
      timeRule: 'arrival_frame',
      groups: nStatesMax() >= 2 ? [defaultHoppingGroupForIndex(0)] : [],
    };
  }

  function normalizeHoppingConfig(rawHopping) {
    const fallback = buildDefaultHoppingConfig();
    const algorithmCandidate = String(rawHopping?.algorithm || fallback.algorithm);
    const timeRuleCandidate = String(rawHopping?.timeRule ?? rawHopping?.time_rule ?? fallback.timeRule);
    const rawGroups = Array.isArray(rawHopping?.groups) ? rawHopping.groups : [];
    const groups = [];
    const seenPairs = new Set();
    for (let i = 0; i < rawGroups.length; i++) {
      const group = normalizeHoppingGroup(rawGroups[i], i);
      const pairKey = `${group.fromState}->${group.toState}`;
      if (seenPairs.has(pairKey)) continue;
      seenPairs.add(pairKey);
      groups.push(group);
    }
    return {
      algorithm: hoppingAlgorithmOptions.includes(algorithmCandidate) ? algorithmCandidate : fallback.algorithm,
      timeRule: hoppingTimeRuleOptions.includes(timeRuleCandidate) ? timeRuleCandidate : fallback.timeRule,
      groups,
    };
  }

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
      showHoppingOverlay: !!(panel?.showHoppingOverlay ?? fallback?.showHoppingOverlay ?? false),
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
      hopping: buildDefaultHoppingConfig(),
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
      if (parsed.hopping && typeof parsed.hopping === 'object') {
        baseState.hopping = normalizeHoppingConfig(parsed.hopping);
      }

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
        hopping: state.hopping,
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
    datasetLoaded,
    dataMode: 'api',
    apiBase,
    STORAGE_KEY,
    MIN_PANELS,
    DEFAULT_PANEL_COUNT,
    RAW_ALIAS_PREFIX,
    observableOptions,
    ensembleStatModes,
    hoppingAlgorithmOptions,
    hoppingTimeRuleOptions,
    hoppingColorPalette,
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
    defaultHoppingGroupForIndex,
    normalizeHoppingGroup,
    buildDefaultHoppingConfig,
    normalizeHoppingConfig,
    state,
    saveStateToStorage,
    setGlobalStatus,
  };
})();
