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

  function normalizeNotebookVariable(variable) {
    return String(variable || '').trim();
  }

  function normalizeNotebookSessionId(sessionId) {
    return String(sessionId || '').trim();
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

  function makeNotebookSeriesKey(sessionId, variable, trajId) {
    return [
      'notebook_series',
      normalizeNotebookSessionId(sessionId),
      normalizeNotebookVariable(variable),
      normalizeTrajId(trajId),
    ].join('::');
  }

  function makeNotebookEnsembleKey(sessionId, variable, statMode) {
    return [
      'notebook_ensemble',
      normalizeNotebookSessionId(sessionId),
      normalizeNotebookVariable(variable),
      normalizeEnsembleStatMode(statMode),
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

  function normalizeNotebookSeriesPayload(sessionId, variable, trajId, payload) {
    const normalizedSessionId = normalizeNotebookSessionId(sessionId);
    const normalizedVariable = normalizeNotebookVariable(variable);
    const normalizedTraj = normalizeTrajId(trajId);
    const seriesKind = payload?.series_kind === 'matrix' ? 'matrix' : 'scalar';
    const out = {
      session_id: normalizedSessionId,
      variable: normalizedVariable,
      traj_id: normalizedTraj,
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

  function normalizeNotebookEnsemblePayload(sessionId, variable, statMode, payload) {
    const normalizedSessionId = normalizeNotebookSessionId(sessionId);
    const normalizedVariable = normalizeNotebookVariable(variable);
    const normalizedMode = normalizeEnsembleStatMode(statMode);
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
      session_id: normalizedSessionId,
      variable: normalizedVariable,
      stat_mode: normalizedMode,
      component_series: componentSeries,
      n_trajectories: Number.isFinite(Number(payload?.n_trajectories)) ? Number(payload.n_trajectories) : 0,
      cached: !!payload?.cached,
    };
  }

  function normalizeNotebookVariableSummary(item) {
    return {
      name: String(item?.name || ''),
      series_kind: item?.series_kind === 'matrix' ? 'matrix' : 'scalar',
      traj_count: Number.isFinite(Number(item?.traj_count)) ? Number(item.traj_count) : 0,
      n_points: Number.isFinite(Number(item?.n_points)) ? Number(item.n_points) : 0,
      n_components: Number.isFinite(Number(item?.n_components)) ? Number(item.n_components) : null,
      component_labels: Array.isArray(item?.component_labels) ? item.component_labels.map((v) => String(v)) : null,
      preview_traj_id: item?.preview_traj_id == null ? null : String(item.preview_traj_id),
      dtype: String(item?.dtype || ''),
      shape: Array.isArray(item?.shape) ? item.shape.map((v) => Number.parseInt(v, 10)).filter(Number.isFinite) : [],
      nan_count: Number.isFinite(Number(item?.nan_count)) ? Number(item.nan_count) : 0,
      updated_at: Number.isFinite(Number(item?.updated_at)) ? Number(item.updated_at) : 0,
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

  async function createNotebookSession() {
    const response = await fetch(`${apiBase}/notebook/session`, {
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
        // ignore parse error
      }
      throw new Error(`Notebook session create failed: ${detail}`);
    }
    const payload = await response.json();
    return {
      session_id: normalizeNotebookSessionId(payload?.session_id),
      dataset_revision: Number.isFinite(Number(payload?.dataset_revision)) ? Number(payload.dataset_revision) : 0,
      source_pkl: String(payload?.source_pkl || ''),
      traj_ids: Array.isArray(payload?.traj_ids) ? payload.traj_ids.map((v) => String(v)) : [],
      session_version: Number.isFinite(Number(payload?.session_version)) ? Number(payload.session_version) : 0,
    };
  }

  async function deleteNotebookSession(sessionId) {
    const normalizedSessionId = normalizeNotebookSessionId(sessionId);
    const response = await fetch(`${apiBase}/notebook/session/${encodeURIComponent(normalizedSessionId)}`, {
      method: 'DELETE',
    });
    if (!response.ok) {
      let detail = `HTTP ${response.status}`;
      try {
        const err = await response.json();
        if (err && typeof err.detail === 'string' && err.detail.trim()) {
          detail = err.detail;
        }
      } catch {
        // ignore parse error
      }
      throw new Error(`Notebook session delete failed: ${detail}`);
    }
    return response.json();
  }

  async function resetNotebookSession(sessionId) {
    const normalizedSessionId = normalizeNotebookSessionId(sessionId);
    const response = await fetch(
      `${apiBase}/notebook/session/${encodeURIComponent(normalizedSessionId)}/reset`,
      { method: 'POST' }
    );
    if (!response.ok) {
      let detail = `HTTP ${response.status}`;
      try {
        const err = await response.json();
        if (err && typeof err.detail === 'string' && err.detail.trim()) {
          detail = err.detail;
        }
      } catch {
        // ignore parse error
      }
      throw new Error(`Notebook session reset failed: ${detail}`);
    }
    const payload = await response.json();
    return {
      status: String(payload?.status || ''),
      session_id: normalizeNotebookSessionId(payload?.session_id),
      dataset_revision: Number.isFinite(Number(payload?.dataset_revision)) ? Number(payload.dataset_revision) : 0,
      session_version: Number.isFinite(Number(payload?.session_version)) ? Number(payload.session_version) : 0,
    };
  }

  async function fetchNotebookPublished(sessionId) {
    const normalizedSessionId = normalizeNotebookSessionId(sessionId);
    const response = await fetch(
      `${apiBase}/notebook/session/${encodeURIComponent(normalizedSessionId)}/published`,
      { method: 'GET' }
    );
    if (!response.ok) {
      let detail = `HTTP ${response.status}`;
      try {
        const err = await response.json();
        if (err && typeof err.detail === 'string' && err.detail.trim()) {
          detail = err.detail;
        }
      } catch {
        // ignore parse error
      }
      throw new Error(`Notebook published variables request failed: ${detail}`);
    }
    const payload = await response.json();
    return {
      session_id: normalizeNotebookSessionId(payload?.session_id),
      session_version: Number.isFinite(Number(payload?.session_version)) ? Number(payload.session_version) : 0,
      variables: Array.isArray(payload?.variables) ? payload.variables.map(normalizeNotebookVariableSummary) : [],
    };
  }

  async function executeNotebookCell(sessionId, code, mode, trajId) {
    const normalizedSessionId = normalizeNotebookSessionId(sessionId);
    const normalizedMode = String(mode) === 'all' ? 'all' : 'current';
    const normalizedCode = String(code || '');
    const normalizedTrajId = trajId == null ? null : normalizeTrajId(trajId);
    const body = {
      code: normalizedCode,
      mode: normalizedMode,
      traj_id: normalizedMode === 'current' ? normalizedTrajId : null,
    };

    const response = await fetch(
      `${apiBase}/notebook/session/${encodeURIComponent(normalizedSessionId)}/execute`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    );
    if (!response.ok) {
      let detail = `HTTP ${response.status}`;
      try {
        const err = await response.json();
        if (err && typeof err.detail === 'string' && err.detail.trim()) {
          detail = err.detail;
        }
      } catch {
        // ignore parse error
      }
      throw new Error(`Notebook execute failed: ${detail}`);
    }
    const payload = await response.json();
    return {
      ok: !!payload?.ok,
      session_id: normalizeNotebookSessionId(payload?.session_id),
      mode: String(payload?.mode) === 'all' ? 'all' : 'current',
      traj_id: payload?.traj_id == null ? null : normalizeTrajId(payload.traj_id),
      stdout: String(payload?.stdout || ''),
      stderr: String(payload?.stderr || ''),
      error_message: payload?.error_message == null ? null : String(payload.error_message),
      traceback: payload?.traceback == null ? null : String(payload.traceback),
      published_updates: Array.isArray(payload?.published_updates)
        ? payload.published_updates.map((v) => String(v)).filter((v) => v.trim())
        : [],
      run_ms: Number.isFinite(Number(payload?.run_ms)) ? Number(payload.run_ms) : 0,
      session_version: Number.isFinite(Number(payload?.session_version)) ? Number(payload.session_version) : 0,
      dataset_revision: Number.isFinite(Number(payload?.dataset_revision)) ? Number(payload.dataset_revision) : 0,
    };
  }

  async function fetchNotebookSeries(sessionId, variable, trajId) {
    const normalizedSessionId = normalizeNotebookSessionId(sessionId);
    const normalizedVariable = normalizeNotebookVariable(variable);
    const normalizedTraj = normalizeTrajId(trajId);
    const response = await fetch(`${apiBase}/notebook-series`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: normalizedSessionId,
        variable: normalizedVariable,
        traj_id: normalizedTraj,
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
        // ignore parse error
      }
      throw new Error(`Notebook series request failed: ${detail}`);
    }
    const payload = await response.json();
    return normalizeNotebookSeriesPayload(normalizedSessionId, normalizedVariable, normalizedTraj, payload);
  }

  async function fetchNotebookEnsemble(sessionId, variable, statMode) {
    const normalizedSessionId = normalizeNotebookSessionId(sessionId);
    const normalizedVariable = normalizeNotebookVariable(variable);
    const normalizedMode = normalizeEnsembleStatMode(statMode);
    const response = await fetch(`${apiBase}/notebook-ensemble`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: normalizedSessionId,
        variable: normalizedVariable,
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
        // ignore parse error
      }
      throw new Error(`Notebook ensemble request failed: ${detail}`);
    }
    const payload = await response.json();
    return normalizeNotebookEnsemblePayload(normalizedSessionId, normalizedVariable, normalizedMode, payload);
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

  async function ensureNotebookSeries(sessionId, variable, trajId) {
    const key = makeNotebookSeriesKey(sessionId, variable, trajId);
    if (cache.has(key)) return;

    if (inflight.has(key)) {
      await inflight.get(key);
      return;
    }

    const pending = fetchNotebookSeries(sessionId, variable, trajId)
      .then((series) => {
        cache.set(key, series);
      })
      .finally(() => {
        inflight.delete(key);
      });

    inflight.set(key, pending);
    await pending;
  }

  async function ensureNotebookEnsemble(sessionId, variable, statMode) {
    const key = makeNotebookEnsembleKey(sessionId, variable, statMode);
    if (cache.has(key)) return;

    if (inflight.has(key)) {
      await inflight.get(key);
      return;
    }

    const pending = fetchNotebookEnsemble(sessionId, variable, statMode)
      .then((series) => {
        cache.set(key, series);
      })
      .finally(() => {
        inflight.delete(key);
      });

    inflight.set(key, pending);
    await pending;
  }

  function clearNotebookCacheForSession(sessionId) {
    const prefix = `${normalizeNotebookSessionId(sessionId)}::`;
    for (const key of Array.from(cache.keys())) {
      const text = String(key);
      if (text.startsWith(`notebook_series::${prefix}`) || text.startsWith(`notebook_ensemble::${prefix}`)) {
        cache.delete(key);
      }
    }
    for (const key of Array.from(inflight.keys())) {
      const text = String(key);
      if (text.startsWith(`notebook_series::${prefix}`) || text.startsWith(`notebook_ensemble::${prefix}`)) {
        inflight.delete(key);
      }
    }
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

  function getNotebookSeries(sessionId, variable, trajId) {
    const key = makeNotebookSeriesKey(sessionId, variable, trajId);
    return cache.get(key) || null;
  }

  function getNotebookEnsemble(sessionId, variable, statMode) {
    const key = makeNotebookEnsembleKey(sessionId, variable, statMode);
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
    createNotebookSession,
    deleteNotebookSession,
    resetNotebookSession,
    fetchNotebookPublished,
    executeNotebookCell,
    ensureNotebookSeries,
    getNotebookSeries,
    ensureNotebookEnsemble,
    getNotebookEnsemble,
    clearNotebookCacheForSession,
    ensureAllForPanelRequirements,
    makeSeriesKey,
    makeRawKeySeriesKey,
    makeEnsembleSeriesKey,
    makeExpressionSeriesKey,
    makeExpressionEnsembleKey,
    makeExpressionDatasetKey,
    makeNotebookSeriesKey,
    makeNotebookEnsembleKey,
    refreshDataset,
    inspectKeys,
    fetchRawKeyAliases,
    upsertRawKeyAlias,
    clearLocalSeriesCache,
  };
})();
