(function () {
  const root = window.ObservableMol3D || (window.ObservableMol3D = {});
  const shared = root.shared;
  const transformers = root.ioTransformers;
  if (!shared || !transformers) return;

  const { apiBase } = shared;

  // Trajectory API cache + in-flight de-duplication.
  const trajectoryCache = new Map();
  const trajectoryInflight = new Map();
  const nacCache = new Map();
  const nacInflight = new Map();
  const deCache = new Map();
  const deInflight = new Map();
  const deNacCache = new Map();
  const deNacInflight = new Map();

  function buildTrajectoryApiUrl(trajId) {
    const base = typeof apiBase === 'string' && apiBase.trim() ? apiBase.trim() : '/api';
    const normalizedBase = base.endsWith('/') ? base.slice(0, -1) : base;
    return `${normalizedBase}/molecule3d/trajectory/${encodeURIComponent(transformers.normalizeTrajId(trajId))}`;
  }

  function buildNacApiUrl(trajId, stateI, stateJ) {
    const base = typeof apiBase === 'string' && apiBase.trim() ? apiBase.trim() : '/api';
    const normalizedBase = base.endsWith('/') ? base.slice(0, -1) : base;
    const params = new URLSearchParams({
      state_i: String(stateI),
      state_j: String(stateJ),
    });
    return `${normalizedBase}/molecule3d/nac/${encodeURIComponent(transformers.normalizeTrajId(trajId))}?${params.toString()}`;
  }

  function buildDeApiUrl(trajId, stateI, stateJ) {
    const base = typeof apiBase === 'string' && apiBase.trim() ? apiBase.trim() : '/api';
    const normalizedBase = base.endsWith('/') ? base.slice(0, -1) : base;
    const params = new URLSearchParams({
      state_i: String(stateI),
      state_j: String(stateJ),
    });
    return `${normalizedBase}/molecule3d/de/${encodeURIComponent(transformers.normalizeTrajId(trajId))}?${params.toString()}`;
  }

  function buildDeNacApiUrl(trajId, stateI, stateJ) {
    const base = typeof apiBase === 'string' && apiBase.trim() ? apiBase.trim() : '/api';
    const normalizedBase = base.endsWith('/') ? base.slice(0, -1) : base;
    const params = new URLSearchParams({
      state_i: String(stateI),
      state_j: String(stateJ),
    });
    return `${normalizedBase}/molecule3d/de_nac/${encodeURIComponent(transformers.normalizeTrajId(trajId))}?${params.toString()}`;
  }

  async function readErrorDetail(response) {
    if (!response) return '';
    try {
      const payload = await response.json();
      if (typeof payload?.detail === 'string' && payload.detail.trim()) {
        return payload.detail.trim();
      }
    } catch (_) {
      // best effort detail parsing
    }
    return '';
  }

  async function fetchTrajectoryFromApi(trajId) {
    const normalizedTrajId = transformers.normalizeTrajId(trajId);
    const url = buildTrajectoryApiUrl(normalizedTrajId);
    const response = await fetch(url, { cache: 'default' });

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      const detailText = await readErrorDetail(response);
      const detail = detailText ? `HTTP ${response.status}: ${detailText}` : `HTTP ${response.status}`;
      throw new Error(detail);
    }

    const payload = await response.json();
    return transformers.normalizeTrajectoryPayload(normalizedTrajId, payload);
  }

  async function fetchNacFromApi(trajId, stateI, stateJ) {
    const normalizedTrajId = transformers.normalizeTrajId(trajId);
    const url = buildNacApiUrl(normalizedTrajId, stateI, stateJ);
    const response = await fetch(url, { cache: 'default' });

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      const detailText = await readErrorDetail(response);
      const detail = detailText ? `HTTP ${response.status}: ${detailText}` : `HTTP ${response.status}`;
      throw new Error(detail);
    }

    const payload = await response.json();
    return transformers.normalizeNacPayload(normalizedTrajId, stateI, stateJ, payload);
  }

  async function fetchDeFromApi(trajId, stateI, stateJ) {
    const normalizedTrajId = transformers.normalizeTrajId(trajId);
    const url = buildDeApiUrl(normalizedTrajId, stateI, stateJ);
    const response = await fetch(url, { cache: 'default' });

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      const detailText = await readErrorDetail(response);
      const detail = detailText ? `HTTP ${response.status}: ${detailText}` : `HTTP ${response.status}`;
      throw new Error(detail);
    }

    const payload = await response.json();
    return transformers.normalizeDePayload(normalizedTrajId, stateI, stateJ, payload);
  }

  async function fetchDeNacFromApi(trajId, stateI, stateJ) {
    const normalizedTrajId = transformers.normalizeTrajId(trajId);
    const url = buildDeNacApiUrl(normalizedTrajId, stateI, stateJ);
    const response = await fetch(url, { cache: 'default' });

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      const detailText = await readErrorDetail(response);
      const detail = detailText ? `HTTP ${response.status}: ${detailText}` : `HTTP ${response.status}`;
      throw new Error(detail);
    }

    const payload = await response.json();
    return transformers.normalizeDeNacPayload(normalizedTrajId, stateI, stateJ, payload);
  }

  async function getTrajectoryRecord(trajId) {
    const key = transformers.normalizeTrajId(trajId);

    if (trajectoryCache.has(key)) {
      return trajectoryCache.get(key);
    }
    if (trajectoryInflight.has(key)) {
      return trajectoryInflight.get(key);
    }

    const pending = fetchTrajectoryFromApi(key)
      .then((payload) => {
        if (payload) {
          trajectoryCache.set(key, payload);
        }
        return payload;
      })
      .finally(() => {
        trajectoryInflight.delete(key);
      });
    trajectoryInflight.set(key, pending);
    return pending;
  }

  function makeNacPairKey(trajId, stateI, stateJ) {
    return `${transformers.normalizeTrajId(trajId)}::${Number.parseInt(String(stateI), 10)}::${Number.parseInt(String(stateJ), 10)}`;
  }

  async function getNacRecord(trajId, stateI, stateJ) {
    const key = makeNacPairKey(trajId, stateI, stateJ);
    if (nacCache.has(key)) {
      return nacCache.get(key);
    }
    if (nacInflight.has(key)) {
      return nacInflight.get(key);
    }

    const pending = fetchNacFromApi(trajId, stateI, stateJ)
      .then((payload) => {
        if (payload) {
          nacCache.set(key, payload);
        }
        return payload;
      })
      .finally(() => {
        nacInflight.delete(key);
      });
    nacInflight.set(key, pending);
    return pending;
  }

  function makeDePairKey(trajId, stateI, stateJ) {
    return `${transformers.normalizeTrajId(trajId)}::${Number.parseInt(String(stateI), 10)}::${Number.parseInt(String(stateJ), 10)}`;
  }

  async function getDeRecord(trajId, stateI, stateJ) {
    const key = makeDePairKey(trajId, stateI, stateJ);
    if (deCache.has(key)) {
      return deCache.get(key);
    }
    if (deInflight.has(key)) {
      return deInflight.get(key);
    }

    const pending = fetchDeFromApi(trajId, stateI, stateJ)
      .then((payload) => {
        if (payload) {
          deCache.set(key, payload);
        }
        return payload;
      })
      .finally(() => {
        deInflight.delete(key);
      });
    deInflight.set(key, pending);
    return pending;
  }

  function makeDeNacPairKey(trajId, stateI, stateJ) {
    return `${transformers.normalizeTrajId(trajId)}::${Number.parseInt(String(stateI), 10)}::${Number.parseInt(String(stateJ), 10)}`;
  }

  async function getDeNacRecord(trajId, stateI, stateJ) {
    const key = makeDeNacPairKey(trajId, stateI, stateJ);
    if (deNacCache.has(key)) {
      return deNacCache.get(key);
    }
    if (deNacInflight.has(key)) {
      return deNacInflight.get(key);
    }

    const pending = fetchDeNacFromApi(trajId, stateI, stateJ)
      .then((payload) => {
        if (payload) {
          deNacCache.set(key, payload);
        }
        return payload;
      })
      .finally(() => {
        deNacInflight.delete(key);
      });
    deNacInflight.set(key, pending);
    return pending;
  }

  function clearCaches() {
    trajectoryCache.clear();
    trajectoryInflight.clear();
    nacCache.clear();
    nacInflight.clear();
    deCache.clear();
    deInflight.clear();
    deNacCache.clear();
    deNacInflight.clear();
  }

  root.ioNetwork = {
    buildTrajectoryApiUrl,
    buildNacApiUrl,
    buildDeApiUrl,
    buildDeNacApiUrl,
    readErrorDetail,
    fetchTrajectoryFromApi,
    fetchNacFromApi,
    fetchDeFromApi,
    fetchDeNacFromApi,
    getTrajectoryRecord,
    makeNacPairKey,
    getNacRecord,
    makeDePairKey,
    getDeRecord,
    makeDeNacPairKey,
    getDeNacRecord,
    clearCaches,
  };
})();
