(function () {
  const root = window.ObservableDashboard || (window.ObservableDashboard = {});
  const shared = root.shared;
  if (!shared) return;

  const DEFAULT_CONCURRENCY = 6;
  const apiBase = String(shared.apiBase || '/api').replace(/\/+$/, '');
  const normalizeRawKeyAliases = typeof shared.normalizeRawKeyAliases === 'function'
    ? shared.normalizeRawKeyAliases
    : (() => ({}));
  const cache = new Map();
  const inflight = new Map();

  function normalizeTrajId(trajId) {
    return String(trajId);
  }

  function normalizeRawKey(rawKey) {
    return String(rawKey || '').trim();
  }

  function normalizeExpression(expression) {
    return String(expression || '').trim();
  }

  function normalizeHoppingAlgorithm(algorithm) {
    return String(algorithm) === 'max_abs_c' ? 'max_abs_c' : 'max_abs_c';
  }

  function normalizeHoppingTimeRule(timeRule) {
    return String(timeRule) === 'arrival_frame' ? 'arrival_frame' : 'arrival_frame';
  }

  function normalizeHoppingTrajIds(trajIds) {
    if (!Array.isArray(trajIds)) return [];
    const out = [];
    const seen = new Set();
    for (const item of trajIds) {
      const trajId = String(item || '').trim();
      if (!trajId || seen.has(trajId)) continue;
      seen.add(trajId);
      out.push(trajId);
    }
    return out;
  }

  function normalizeHoppingTransitions(transitions) {
    if (!Array.isArray(transitions)) return [];
    const out = [];
    const seen = new Set();
    for (const item of transitions) {
      const fromState = Number.parseInt(item?.from_state ?? item?.fromState, 10);
      const toState = Number.parseInt(item?.to_state ?? item?.toState, 10);
      if (!Number.isFinite(fromState) || !Number.isFinite(toState)) continue;
      if (fromState < 0 || toState < 0 || fromState === toState) continue;
      const transitionKey = `${fromState}->${toState}`;
      if (seen.has(transitionKey)) continue;
      seen.add(transitionKey);
      out.push({
        transition_key: transitionKey,
        from_state: fromState,
        to_state: toState,
      });
    }
    return out;
  }

  function normalizeIndices(indices) {
    if (!Array.isArray(indices)) return [];
    const out = [];
    for (const v of indices) {
      const n = Number.parseInt(v, 10);
      if (!Number.isFinite(n)) continue;
      out.push(n);
    }
    return out;
  }

  function normalizeEnsembleStatMode(mode) {
    const text = String(mode);
    if (text === 'median_iqr' || text === 'renorm_mean_ci95_bootstrap') return text;
    return 'mean_ci95_bootstrap';
  }

  function makeSeriesKey(trajId, observable, indices) {
    const normalizedTraj = normalizeTrajId(trajId);
    const normalizedIndices = normalizeIndices(indices);
    return `${normalizedTraj}::${String(observable)}::${normalizedIndices.join(',')}`;
  }

  function makeRawKeySeriesKey(trajId, rawKey) {
    return `raw::${normalizeTrajId(trajId)}::${normalizeRawKey(rawKey)}`;
  }

  function makeEnsembleSeriesKey(observable, indices, rawKey, statMode) {
    return [
      'ensemble',
      String(observable),
      normalizeIndices(indices).join(','),
      normalizeRawKey(rawKey),
      normalizeEnsembleStatMode(statMode),
    ].join('::');
  }

  function makeExpressionSeriesKey(trajId, expression) {
    return `expr_series::${normalizeTrajId(trajId)}::${normalizeExpression(expression)}`;
  }

  function makeExpressionEnsembleKey(expression, statMode) {
    return [
      'expr_ensemble',
      normalizeExpression(expression),
      normalizeEnsembleStatMode(statMode),
    ].join('::');
  }

  function makeExpressionDatasetKey(expression) {
    return `expr_dataset::${normalizeExpression(expression)}`;
  }

  function makeHoppingEventsKey(trajIds, algorithm, timeRule, transitions) {
    const normalizedTrajIds = normalizeHoppingTrajIds(trajIds);
    const normalizedTransitions = normalizeHoppingTransitions(transitions);
    return [
      'hopping',
      normalizedTrajIds.join(','),
      normalizeHoppingAlgorithm(algorithm),
      normalizeHoppingTimeRule(timeRule),
      normalizedTransitions.map((item) => item.transition_key).join('|'),
    ].join('::');
  }

  function normalizeSeriesPayload(trajId, observable, indices, payload) {
    const seriesKind = payload?.series_kind === 'matrix' ? 'matrix' : 'scalar';
    const out = {
      traj_id: normalizeTrajId(trajId),
      observable: String(observable),
      indices: normalizeIndices(indices),
      series_kind: seriesKind,
      time: Array.isArray(payload?.time) ? payload.time : [],
      value: null,
      values: null,
      n_points: Number.isFinite(Number(payload?.n_points)) ? Number(payload.n_points) : 0,
      n_components: null,
      cached: !!payload?.cached,
    };

    if (seriesKind === 'matrix') {
      out.values = Array.isArray(payload?.values) ? payload.values : [];
      out.n_components = Number.isFinite(Number(payload?.n_components)) ? Number(payload.n_components) : 0;
    } else {
      out.value = Array.isArray(payload?.value) ? payload.value : [];
    }

    return out;
  }

  function normalizeRawKeySeriesPayload(trajId, rawKey, payload) {
    const seriesKind = payload?.series_kind === 'matrix' ? 'matrix' : 'scalar';
    const out = {
      traj_id: normalizeTrajId(trajId),
      raw_key: normalizeRawKey(rawKey),
      series_kind: seriesKind,
      time: Array.isArray(payload?.time) ? payload.time : [],
      value: null,
      values: null,
      n_points: Number.isFinite(Number(payload?.n_points)) ? Number(payload.n_points) : 0,
      n_components: null,
      component_labels: Array.isArray(payload?.component_labels)
        ? payload.component_labels.map((v) => String(v))
        : null,
      cached: !!payload?.cached,
    };

    if (seriesKind === 'matrix') {
      out.values = Array.isArray(payload?.values) ? payload.values : [];
      out.n_components = Number.isFinite(Number(payload?.n_components)) ? Number(payload.n_components) : 0;
    } else {
      out.value = Array.isArray(payload?.value) ? payload.value : [];
    }

    return out;
  }

  function normalizeEnsembleSeriesPayload(observable, indices, rawKey, statMode, payload) {
    const componentSeriesRaw = Array.isArray(payload?.component_series) ? payload.component_series : [];
    const componentSeries = componentSeriesRaw.map((series, idx) => ({
      component: Number.isFinite(Number(series?.component)) ? Number(series.component) : idx,
      label: typeof series?.label === 'string' ? series.label : null,
      time: Array.isArray(series?.time) ? series.time : [],
      low: Array.isArray(series?.low) ? series.low : [],
      center: Array.isArray(series?.center) ? series.center : [],
      high: Array.isArray(series?.high) ? series.high : [],
      sample_count: Array.isArray(series?.sample_count) ? series.sample_count : [],
    }));
    return {
      observable: String(observable),
      indices: normalizeIndices(indices),
      raw_key: normalizeRawKey(rawKey) || null,
      stat_mode: normalizeEnsembleStatMode(statMode),
      component_series: componentSeries,
      n_trajectories: Number.isFinite(Number(payload?.n_trajectories)) ? Number(payload.n_trajectories) : 0,
      cached: !!payload?.cached,
    };
  }

  function normalizeSampleCount(values) {
    if (!Array.isArray(values)) return null;
    const out = [];
    for (const value of values) {
      const n = Number.parseInt(value, 10);
      out.push(Number.isFinite(n) ? n : 0);
    }
    return out;
  }

  function normalizeExpressionPayload(trajId, expression, payload) {
    const normalizedExpression = normalizeExpression(expression);
    const scope = payload?.scope === 'trajectory' ? 'trajectory' : 'dataset';
    const seriesKind = payload?.series_kind === 'matrix' ? 'matrix' : 'scalar';
    const out = {
      traj_id: trajId == null ? null : normalizeTrajId(trajId),
      expression: normalizedExpression,
      scope,
      series_kind: seriesKind,
      time: Array.isArray(payload?.time) ? payload.time : [],
      value: null,
      values: null,
      n_points: Number.isFinite(Number(payload?.n_points)) ? Number(payload.n_points) : 0,
      n_components: null,
      n_trajectories: Number.isFinite(Number(payload?.n_trajectories)) ? Number(payload.n_trajectories) : 0,
      sample_count: normalizeSampleCount(payload?.sample_count),
      cached: !!payload?.cached,
    };

    if (seriesKind === 'matrix') {
      out.values = Array.isArray(payload?.values) ? payload.values : [];
      out.n_components = Number.isFinite(Number(payload?.n_components)) ? Number(payload.n_components) : 0;
    } else {
      out.value = Array.isArray(payload?.value) ? payload.value : [];
    }

    return out;
  }

  function normalizeExpressionEnsemblePayload(expression, statMode, payload) {
    const normalizedExpression = normalizeExpression(expression);
    const normalizedMode = normalizeEnsembleStatMode(statMode);
    const seriesKind = payload?.series_kind === 'matrix' ? 'matrix' : 'scalar';
    const componentSeriesRaw = Array.isArray(payload?.component_series) ? payload.component_series : [];
    const componentSeries = componentSeriesRaw.map((series, idx) => ({
      component: Number.isFinite(Number(series?.component)) ? Number(series.component) : idx,
      label: typeof series?.label === 'string' ? series.label : null,
      time: Array.isArray(series?.time) ? series.time : [],
      low: Array.isArray(series?.low) ? series.low : [],
      center: Array.isArray(series?.center) ? series.center : [],
      high: Array.isArray(series?.high) ? series.high : [],
      sample_count: Array.isArray(series?.sample_count) ? series.sample_count : [],
    }));
    return {
      expression: normalizedExpression,
      series_kind: seriesKind,
      n_components: Number.isFinite(Number(payload?.n_components)) ? Number(payload.n_components) : null,
      stat_mode: normalizedMode,
      component_series: componentSeries,
      n_trajectories: Number.isFinite(Number(payload?.n_trajectories)) ? Number(payload.n_trajectories) : 0,
      cached: !!payload?.cached,
    };
  }

  function normalizeHoppingPayload(trajIds, algorithm, timeRule, transitions, payload) {
    const normalizedTrajIds = normalizeHoppingTrajIds(payload?.traj_ids ?? trajIds);
    const normalizedAlgorithm = normalizeHoppingAlgorithm(payload?.algorithm ?? algorithm);
    const normalizedTimeRule = normalizeHoppingTimeRule(payload?.time_rule ?? timeRule);
    const normalizedTransitions = normalizeHoppingTransitions(payload?.transitions ?? transitions);
    const rawEventsByTraj = payload?.events_by_traj && typeof payload.events_by_traj === 'object'
      ? payload.events_by_traj
      : {};
    const eventsByTraj = {};
    for (const trajId of normalizedTrajIds) {
      const rawEvents = Array.isArray(rawEventsByTraj?.[trajId]) ? rawEventsByTraj[trajId] : [];
      eventsByTraj[trajId] = rawEvents.map((item) => ({
        transition_key: String(item?.transition_key || ''),
        from_state: Number.isFinite(Number(item?.from_state)) ? Number(item.from_state) : 0,
        to_state: Number.isFinite(Number(item?.to_state)) ? Number(item.to_state) : 0,
        frame_from: Number.isFinite(Number(item?.frame_from)) ? Number(item.frame_from) : 0,
        frame_to: Number.isFinite(Number(item?.frame_to)) ? Number(item.frame_to) : 0,
        time: Number.isFinite(Number(item?.time)) ? Number(item.time) : NaN,
      }));
    }
    const countsByTrajRaw = Array.isArray(payload?.counts_by_traj) ? payload.counts_by_traj : [];
    const totalsRaw = Array.isArray(payload?.totals_by_transition) ? payload.totals_by_transition : [];
    return {
      traj_ids: normalizedTrajIds,
      algorithm: normalizedAlgorithm,
      time_rule: normalizedTimeRule,
      transitions: normalizedTransitions,
      events_by_traj: eventsByTraj,
      counts_by_traj: countsByTrajRaw.map((item) => ({
        traj_id: String(item?.traj_id || ''),
        transition_key: String(item?.transition_key || ''),
        from_state: Number.isFinite(Number(item?.from_state)) ? Number(item.from_state) : 0,
        to_state: Number.isFinite(Number(item?.to_state)) ? Number(item.to_state) : 0,
        count: Number.isFinite(Number(item?.count)) ? Number(item.count) : 0,
      })),
      totals_by_transition: totalsRaw.map((item) => ({
        transition_key: String(item?.transition_key || ''),
        from_state: Number.isFinite(Number(item?.from_state)) ? Number(item.from_state) : 0,
        to_state: Number.isFinite(Number(item?.to_state)) ? Number(item.to_state) : 0,
        count: Number.isFinite(Number(item?.count)) ? Number(item.count) : 0,
      })),
      cached: !!payload?.cached,
    };
  }

  async function fetchSeries(trajId, observable, indices) {
    const response = await fetch(`${apiBase}/series`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        traj_id: normalizeTrajId(trajId),
        observable: String(observable),
        indices: normalizeIndices(indices),
      }),
    });

    if (!response.ok) {
      let detail = `HTTP ${response.status}`;
      try {
        const err = await response.json();
        if (err && typeof err.detail === 'string' && err.detail.trim()) {
          detail = err.detail;
        }
      } catch {
        // ignore parse error and keep generic detail
      }
      throw new Error(`Series request failed: ${detail}`);
    }

    const payload = await response.json();
    return normalizeSeriesPayload(trajId, observable, indices, payload);
  }

  async function fetchRawKeySeries(trajId, rawKey) {
    const response = await fetch(`${apiBase}/raw-key-series`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        traj_id: normalizeTrajId(trajId),
        raw_key: normalizeRawKey(rawKey),
      }),
    });

    if (!response.ok) {
      let detail = `HTTP ${response.status}`;
      try {
        const err = await response.json();
        if (err && typeof err.detail === 'string' && err.detail.trim()) {
          detail = err.detail;
        }
      } catch {
        // ignore parse error and keep generic detail
      }
      throw new Error(`Raw key series request failed: ${detail}`);
    }

    const payload = await response.json();
    return normalizeRawKeySeriesPayload(trajId, rawKey, payload);
  }

  async function fetchEnsembleSeries(observable, indices, rawKey, statMode) {
    const normalizedObservable = String(observable);
    const normalizedIndices = normalizeIndices(indices);
    const normalizedRawKey = normalizeRawKey(rawKey);
    const normalizedMode = normalizeEnsembleStatMode(statMode);
    const response = await fetch(`${apiBase}/ensemble-series`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        observable: normalizedObservable,
        indices: normalizedIndices,
        raw_key: normalizedObservable === 'raw_key' ? normalizedRawKey : null,
        stat_mode: normalizedMode,
      }),
    });

    if (!response.ok) {
      let detail = `HTTP ${response.status}`;
      try {
        const err = await response.json();
        if (err && typeof err.detail === 'string' && err.detail.trim()) {
          detail = err.detail;
        }
      } catch {
        // ignore parse error and keep generic detail
      }
      throw new Error(`Ensemble series request failed: ${detail}`);
    }

    const payload = await response.json();
    return normalizeEnsembleSeriesPayload(
      normalizedObservable,
      normalizedIndices,
      normalizedRawKey,
      normalizedMode,
      payload
    );
  }

  async function fetchExpressionSeries(trajId, expression) {
    const normalizedTraj = normalizeTrajId(trajId);
    const normalizedExpression = normalizeExpression(expression);
    const response = await fetch(`${apiBase}/expression-series`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        traj_id: normalizedTraj,
        expression: normalizedExpression,
      }),
    });

    if (!response.ok) {
      let detail = `HTTP ${response.status}`;
      try {
        const err = await response.json();
        if (err && typeof err.detail === 'string' && err.detail.trim()) {
          detail = err.detail;
        }
      } catch {
        // ignore parse error and keep generic detail
      }
      throw new Error(`Expression series request failed: ${detail}`);
    }

    const payload = await response.json();
    return normalizeExpressionPayload(normalizedTraj, normalizedExpression, payload);
  }

  async function fetchExpressionEnsemble(expression, statMode) {
    const normalizedExpression = normalizeExpression(expression);
    const normalizedMode = normalizeEnsembleStatMode(statMode);
    const response = await fetch(`${apiBase}/expression-ensemble`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expression: normalizedExpression,
        stat_mode: normalizedMode,
      }),
    });

    if (!response.ok) {
      let detail = `HTTP ${response.status}`;
      try {
        const err = await response.json();
        if (err && typeof err.detail === 'string' && err.detail.trim()) {
          detail = err.detail;
        }
      } catch {
        // ignore parse error and keep generic detail
      }
      throw new Error(`Expression ensemble request failed: ${detail}`);
    }

    const payload = await response.json();
    return normalizeExpressionEnsemblePayload(normalizedExpression, normalizedMode, payload);
  }

  async function fetchExpressionDataset(expression) {
    const normalizedExpression = normalizeExpression(expression);
    const response = await fetch(`${apiBase}/expression-dataset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expression: normalizedExpression,
      }),
    });

    if (!response.ok) {
      let detail = `HTTP ${response.status}`;
      try {
        const err = await response.json();
        if (err && typeof err.detail === 'string' && err.detail.trim()) {
          detail = err.detail;
        }
      } catch {
        // ignore parse error and keep generic detail
      }
      throw new Error(`Expression dataset request failed: ${detail}`);
    }

    const payload = await response.json();
    return normalizeExpressionPayload(null, normalizedExpression, payload);
  }

  async function fetchHoppingEvents(trajIds, algorithm, timeRule, transitions) {
    const normalizedTrajIds = normalizeHoppingTrajIds(trajIds);
    const normalizedAlgorithm = normalizeHoppingAlgorithm(algorithm);
    const normalizedTimeRule = normalizeHoppingTimeRule(timeRule);
    const normalizedTransitions = normalizeHoppingTransitions(transitions);
    const response = await fetch(`${apiBase}/hopping-events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        traj_ids: normalizedTrajIds,
        algorithm: normalizedAlgorithm,
        time_rule: normalizedTimeRule,
        transitions: normalizedTransitions.map((item) => ({
          from_state: item.from_state,
          to_state: item.to_state,
        })),
      }),
    });

    if (!response.ok) {
      let detail = `HTTP ${response.status}`;
      try {
        const err = await response.json();
        if (err && typeof err.detail === 'string' && err.detail.trim()) {
          detail = err.detail;
        }
      } catch {
        // ignore parse error and keep generic detail
      }
      throw new Error(`Hopping events request failed: ${detail}`);
    }

    const payload = await response.json();
    return normalizeHoppingPayload(normalizedTrajIds, normalizedAlgorithm, normalizedTimeRule, normalizedTransitions, payload);
  }

  async function refreshDataset() {
    const response = await fetch(`${apiBase}/refresh-dataset`, {
      method: 'POST',
    });

    if (!response.ok) {
      let detail = `HTTP ${response.status}`;
      try {
        const err = await response.json();
        if (err && typeof err.detail === 'string' && err.detail.trim()) {
          detail = err.detail;
        }
      } catch {
        // ignore parse error and keep generic detail
      }
      throw new Error(`Dataset refresh failed: ${detail}`);
    }

    const payload = await response.json();
    return {
      status: String(payload?.status || ''),
      traj_count: Number(payload?.traj_count || 0),
      source_pkl: String(payload?.source_pkl || ''),
      cleared_series_cache_entries: Number(payload?.cleared_series_cache_entries || 0),
      cleared_mol3d_cache_entries: Number(payload?.cleared_mol3d_cache_entries || 0),
      dataset_revision: Number(payload?.dataset_revision || 0),
    };
  }

  async function listFiles(path = '') {
    const normalizedPath = String(path || '').trim();
    const url = new URL(`${apiBase}/files`, window.location.origin);
    if (normalizedPath) {
      url.searchParams.set('path', normalizedPath);
    }

    const response = await fetch(url.toString(), {
      method: 'GET',
    });

    if (!response.ok) {
      let detail = `HTTP ${response.status}`;
      try {
        const err = await response.json();
        if (err && typeof err.detail === 'string' && err.detail.trim()) {
          detail = err.detail;
        }
      } catch {
        // ignore parse error and keep generic detail
      }
      throw new Error(`File list request failed: ${detail}`);
    }

    const payload = await response.json();
    return {
      root_label: String(payload?.root_label || ''),
      current_path: String(payload?.current_path || ''),
      parent_path: payload?.parent_path == null ? null : String(payload.parent_path || ''),
      entries: Array.isArray(payload?.entries)
        ? payload.entries.map((entry) => ({
            name: String(entry?.name || ''),
            relative_path: String(entry?.relative_path || ''),
            kind: entry?.kind === 'directory' ? 'directory' : 'file',
            loadable: !!entry?.loadable,
          }))
        : [],
    };
  }

  async function loadDataset(path) {
    const normalizedPath = String(path || '').trim();
    const response = await fetch(`${apiBase}/load-dataset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: normalizedPath }),
    });

    if (!response.ok) {
      let detail = `HTTP ${response.status}`;
      try {
        const err = await response.json();
        if (err && typeof err.detail === 'string' && err.detail.trim()) {
          detail = err.detail;
        }
      } catch {
        // ignore parse error and keep generic detail
      }
      throw new Error(`Dataset load failed: ${detail}`);
    }

    const payload = await response.json();
    return {
      status: String(payload?.status || ''),
      traj_count: Number(payload?.traj_count || 0),
      source_pkl: String(payload?.source_pkl || ''),
      cleared_series_cache_entries: Number(payload?.cleared_series_cache_entries || 0),
      cleared_mol3d_cache_entries: Number(payload?.cleared_mol3d_cache_entries || 0),
      dataset_revision: Number(payload?.dataset_revision || 0),
    };
  }

  function normalizeInspectKeys(keys) {
    if (!Array.isArray(keys)) return [];
    const out = [];
    const seen = new Set();
    for (const key of keys) {
      const text = String(key || '').trim();
      if (!text || seen.has(text)) continue;
      seen.add(text);
      out.push(text);
    }
    return out;
  }

  function normalizeRawKeyAliasItems(items) {
    const aliasMap = normalizeRawKeyAliases(Array.isArray(items) ? items : []);
    const aliases = Object.keys(aliasMap)
      .sort((a, b) => a.localeCompare(b))
      .map((alias) => ({ alias, raw_key: aliasMap[alias] }));
    return {
      aliases,
      alias_map: aliasMap,
    };
  }

  async function inspectKeys(keys) {
    const normalizedKeys = normalizeInspectKeys(keys);
    const response = await fetch(`${apiBase}/inspect-keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: normalizedKeys }),
    });

    if (!response.ok) {
      let detail = `HTTP ${response.status}`;
      try {
        const err = await response.json();
        if (err && typeof err.detail === 'string' && err.detail.trim()) {
          detail = err.detail;
        }
      } catch {
        // ignore parse error and keep generic detail
      }
      throw new Error(`Inspect keys request failed: ${detail}`);
    }

    const payload = await response.json();
    const responseKeys = Array.isArray(payload?.keys)
      ? normalizeInspectKeys(payload.keys)
      : [];
    const rows = Array.isArray(payload?.rows) ? payload.rows : [];
    return {
      keys: responseKeys,
      rows,
    };
  }

  async function fetchRawKeyAliases() {
    const response = await fetch(`${apiBase}/raw-key-aliases`, {
      method: 'GET',
    });

    if (!response.ok) {
      let detail = `HTTP ${response.status}`;
      try {
        const err = await response.json();
        if (err && typeof err.detail === 'string' && err.detail.trim()) {
          detail = err.detail;
        }
      } catch {
        // ignore parse error and keep generic detail
      }
      throw new Error(`Raw key aliases request failed: ${detail}`);
    }

    const payload = await response.json();
    return normalizeRawKeyAliasItems(payload?.aliases);
  }

  async function upsertRawKeyAlias(alias, rawKey) {
    const response = await fetch(`${apiBase}/raw-key-aliases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        alias: String(alias || '').trim(),
        raw_key: normalizeRawKey(rawKey),
      }),
    });

    if (!response.ok) {
      let detail = `HTTP ${response.status}`;
      try {
        const err = await response.json();
        if (err && typeof err.detail === 'string' && err.detail.trim()) {
          detail = err.detail;
        }
      } catch {
        // ignore parse error and keep generic detail
      }
      throw new Error(`Raw key alias update failed: ${detail}`);
    }

    const payload = await response.json();
    return normalizeRawKeyAliasItems(payload?.aliases);
  }

  function clearLocalSeriesCache() {
    cache.clear();
    inflight.clear();
  }

  async function ensureSeries(trajId, observable, indices) {
    const key = makeSeriesKey(trajId, observable, indices);
    if (cache.has(key)) return;

    if (inflight.has(key)) {
      await inflight.get(key);
      return;
    }

    const pending = fetchSeries(trajId, observable, indices)
      .then((series) => {
        cache.set(key, series);
      })
      .finally(() => {
        inflight.delete(key);
      });

    inflight.set(key, pending);
    await pending;
  }

  async function ensureRawKeySeries(trajId, rawKey) {
    const key = makeRawKeySeriesKey(trajId, rawKey);
    if (cache.has(key)) return;

    if (inflight.has(key)) {
      await inflight.get(key);
      return;
    }

    const pending = fetchRawKeySeries(trajId, rawKey)
      .then((series) => {
        cache.set(key, series);
      })
      .finally(() => {
        inflight.delete(key);
      });

    inflight.set(key, pending);
    await pending;
  }

  async function ensureEnsembleSeries(observable, indices, rawKey, statMode) {
    const key = makeEnsembleSeriesKey(observable, indices, rawKey, statMode);
    if (cache.has(key)) return;

    if (inflight.has(key)) {
      await inflight.get(key);
      return;
    }

    const pending = fetchEnsembleSeries(observable, indices, rawKey, statMode)
      .then((series) => {
        cache.set(key, series);
      })
      .finally(() => {
        inflight.delete(key);
      });

    inflight.set(key, pending);
    await pending;
  }

  async function ensureExpressionSeries(trajId, expression) {
    const key = makeExpressionSeriesKey(trajId, expression);
    if (cache.has(key)) return;

    if (inflight.has(key)) {
      await inflight.get(key);
      return;
    }

    const pending = fetchExpressionSeries(trajId, expression)
      .then((series) => {
        cache.set(key, series);
      })
      .finally(() => {
        inflight.delete(key);
      });

    inflight.set(key, pending);
    await pending;
  }

  async function ensureExpressionEnsemble(expression, statMode) {
    const key = makeExpressionEnsembleKey(expression, statMode);
    if (cache.has(key)) return;

    if (inflight.has(key)) {
      await inflight.get(key);
      return;
    }

    const pending = fetchExpressionEnsemble(expression, statMode)
      .then((series) => {
        cache.set(key, series);
      })
      .finally(() => {
        inflight.delete(key);
      });

    inflight.set(key, pending);
    await pending;
  }

  async function ensureExpressionDataset(expression) {
    const key = makeExpressionDatasetKey(expression);
    if (cache.has(key)) return;

    if (inflight.has(key)) {
      await inflight.get(key);
      return;
    }

    const pending = fetchExpressionDataset(expression)
      .then((series) => {
        cache.set(key, series);
      })
      .finally(() => {
        inflight.delete(key);
      });

    inflight.set(key, pending);
    await pending;
  }

  async function ensureHoppingEvents(trajIds, algorithm, timeRule, transitions) {
    const key = makeHoppingEventsKey(trajIds, algorithm, timeRule, transitions);
    if (cache.has(key)) return;

    if (inflight.has(key)) {
      await inflight.get(key);
      return;
    }

    const pending = fetchHoppingEvents(trajIds, algorithm, timeRule, transitions)
      .then((payload) => {
        cache.set(key, payload);
      })
      .finally(() => {
        inflight.delete(key);
      });

    inflight.set(key, pending);
    await pending;
  }

  function getSeries(trajId, observable, indices) {
    const key = makeSeriesKey(trajId, observable, indices);
    return cache.get(key) || null;
  }

  function getRawKeySeries(trajId, rawKey) {
    const key = makeRawKeySeriesKey(trajId, rawKey);
    return cache.get(key) || null;
  }

  function getEnsembleSeries(observable, indices, rawKey, statMode) {
    const key = makeEnsembleSeriesKey(observable, indices, rawKey, statMode);
    return cache.get(key) || null;
  }

  function getExpressionSeries(trajId, expression) {
    const key = makeExpressionSeriesKey(trajId, expression);
    return cache.get(key) || null;
  }

  function getExpressionEnsemble(expression, statMode) {
    const key = makeExpressionEnsembleKey(expression, statMode);
    return cache.get(key) || null;
  }

  function getExpressionDataset(expression) {
    const key = makeExpressionDatasetKey(expression);
    return cache.get(key) || null;
  }

  function getHoppingEvents(trajIds, algorithm, timeRule, transitions) {
    const key = makeHoppingEventsKey(trajIds, algorithm, timeRule, transitions);
    return cache.get(key) || null;
  }

  function normalizeRequirements(requirements) {
    const raw = Array.isArray(requirements)
      ? requirements
      : (Array.isArray(requirements?.requirements) ? requirements.requirements : []);

    const out = [];
    const seen = new Set();
    for (const item of raw) {
      const observable = String(item?.observable || '');
      if (!observable) continue;
      const indices = normalizeIndices(item?.indices);
      const key = `${observable}::${indices.join(',')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ observable, indices });
    }
    return out;
  }

  async function runWithConcurrency(items, worker, concurrency) {
    const queue = items.slice();
    const workers = [];
    const maxWorkers = Math.max(1, Math.min(concurrency, queue.length || 1));

    for (let i = 0; i < maxWorkers; i++) {
      workers.push((async () => {
        while (queue.length) {
          const item = queue.shift();
          if (!item) continue;
          await worker(item);
        }
      })());
    }

    await Promise.all(workers);
  }

  async function ensureAllForPanelRequirements(requirements, onProgress) {
    const normalizedReqs = normalizeRequirements(requirements);
    const trajIds = Array.isArray(shared.trajIds) ? shared.trajIds.map((v) => String(v)) : [];
    const tasks = [];

    for (const trajId of trajIds) {
      for (const req of normalizedReqs) {
        tasks.push({ trajId, observable: req.observable, indices: req.indices.slice() });
      }
    }

    if (!tasks.length) {
      if (typeof onProgress === 'function') onProgress(0, 0, null);
      return { done: 0, total: 0 };
    }

    let done = 0;
    await runWithConcurrency(tasks, async (task) => {
      await ensureSeries(task.trajId, task.observable, task.indices);
      done += 1;
      if (typeof onProgress === 'function') onProgress(done, tasks.length, task);
    }, DEFAULT_CONCURRENCY);

    return { done, total: tasks.length };
  }

  function initFromBootstrap(bootstrap) {
    return bootstrap;
  }

  root.dataLoader = {
    initFromBootstrap,
    ensureSeries,
    getSeries,
    ensureRawKeySeries,
    getRawKeySeries,
    ensureEnsembleSeries,
    getEnsembleSeries,
    ensureExpressionSeries,
    getExpressionSeries,
    ensureExpressionEnsemble,
    getExpressionEnsemble,
    ensureExpressionDataset,
    getExpressionDataset,
    ensureHoppingEvents,
    getHoppingEvents,
    ensureAllForPanelRequirements,
    makeSeriesKey,
    makeRawKeySeriesKey,
    makeEnsembleSeriesKey,
    makeExpressionSeriesKey,
    makeExpressionEnsembleKey,
    makeExpressionDatasetKey,
    makeHoppingEventsKey,
    listFiles,
    loadDataset,
    refreshDataset,
    inspectKeys,
    fetchRawKeyAliases,
    upsertRawKeyAlias,
    clearLocalSeriesCache,
  };
})();
