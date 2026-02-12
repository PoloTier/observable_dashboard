(function () {
  const root = window.ObservableDashboard || (window.ObservableDashboard = {});
  const shared = root.shared;
  if (!shared) return;

  const DEFAULT_CONCURRENCY = 6;
  const apiBase = String(shared.apiBase || '/api').replace(/\/+$/, '');
  const cache = new Map();
  const inflight = new Map();

  function normalizeTrajId(trajId) {
    return String(trajId);
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

  function makeSeriesKey(trajId, observable, indices) {
    const normalizedTraj = normalizeTrajId(trajId);
    const normalizedIndices = normalizeIndices(indices);
    return `${normalizedTraj}::${String(observable)}::${normalizedIndices.join(',')}`;
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

  function getSeries(trajId, observable, indices) {
    const key = makeSeriesKey(trajId, observable, indices);
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
    ensureAllForPanelRequirements,
    makeSeriesKey,
    refreshDataset,
    clearLocalSeriesCache,
  };
})();
