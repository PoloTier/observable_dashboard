(function () {
  const root = window.ObservableDashboard || (window.ObservableDashboard = {});
  const shared = root.shared;
  const dataLoader = root.dataLoader;
  const notebook = root.notebook;
  if (!shared || !dataLoader) return;

  const {
    state,
    trajIds,
    requiredIndexCount,
    canonicalObservable,
    rawAliasFromObservable,
    resolveRawKeyForPanel,
    setGlobalStatus,
  } = shared;

  const PLOT_EXPORT_DPI = 300;
  const CSS_BASE_DPI = 96;
  const PLOT_EXPORT_SCALE = PLOT_EXPORT_DPI / CSS_BASE_DPI;
  const HOVER_SYNC_CLEAR_DELAY_MS = 80;
  const HOVER_SYNC_LINE_STYLE = { color: 'rgba(80,80,80,0.35)', width: 1 };

  let hoverSyncTime = null;
  let hoverSyncClearTimer = null;
  let hoverSyncRaf = 0;
  let hoverSyncPendingTime = null;
  let renderQueue = Promise.resolve();

  function enqueueRender(task) {
    renderQueue = renderQueue.then(task, task);
    return renderQueue;
  }

  function buildHoverSyncShape(t) {
    return {
      type: 'line',
      x0: t,
      x1: t,
      yref: 'paper',
      y0: 0,
      y1: 1,
      line: HOVER_SYNC_LINE_STYLE,
    };
  }

  function getPanelPlotElements() {
    const plotEls = [];
    for (let i = 0; i < state.panels.length; i++) {
      const el = document.getElementById(`plot-${i}`);
      if (!el || !Array.isArray(el.data)) continue;
      plotEls.push(el);
    }
    return plotEls;
  }

  function applyHoverSyncTimeToAllPlots(t) {
    if (typeof Plotly === 'undefined') return;
    const shapeUpdate = Number.isFinite(t) ? [buildHoverSyncShape(t)] : [];
    for (const el of getPanelPlotElements()) {
      try {
        Plotly.relayout(el, { shapes: shapeUpdate });
      } catch {
        // ignore relayout errors for plots that are rebuilding
      }
    }
  }

  function flushHoverSyncRaf() {
    if (hoverSyncRaf) {
      cancelAnimationFrame(hoverSyncRaf);
      hoverSyncRaf = 0;
    }
    hoverSyncRaf = requestAnimationFrame(() => {
      hoverSyncRaf = 0;
      hoverSyncTime = Number.isFinite(hoverSyncPendingTime) ? hoverSyncPendingTime : null;
      applyHoverSyncTimeToAllPlots(hoverSyncTime);
    });
  }

  function setHoverSyncTime(t) {
    if (hoverSyncClearTimer) {
      clearTimeout(hoverSyncClearTimer);
      hoverSyncClearTimer = null;
    }
    if (!Number.isFinite(t)) return;
    if (Number.isFinite(hoverSyncTime) && Math.abs(t - hoverSyncTime) < 1e-9) return;
    hoverSyncPendingTime = t;
    flushHoverSyncRaf();
  }

  function scheduleClearHoverSyncTime() {
    if (hoverSyncClearTimer) clearTimeout(hoverSyncClearTimer);
    hoverSyncClearTimer = setTimeout(() => {
      hoverSyncClearTimer = null;
      hoverSyncPendingTime = null;
      flushHoverSyncRaf();
    }, HOVER_SYNC_CLEAR_DELAY_MS);
  }

  function cancelClearHoverSyncTime() {
    if (!hoverSyncClearTimer) return;
    clearTimeout(hoverSyncClearTimer);
    hoverSyncClearTimer = null;
  }

  function extractHoverTime(evt) {
    const raw = evt?.points?.[0]?.x;
    const t = Number(raw);
    return Number.isFinite(t) ? t : null;
  }

  function bindHoverSyncHandlers(plotEl) {
    if (!plotEl || plotEl.dataset.hoverSyncBound === '1') return;
    if (typeof plotEl.on !== 'function') return;

    plotEl.on('plotly_hover', (evt) => {
      const t = extractHoverTime(evt);
      if (Number.isFinite(t)) setHoverSyncTime(t);
    });
    plotEl.on('plotly_unhover', () => {
      scheduleClearHoverSyncTime();
    });
    plotEl.addEventListener('mouseenter', cancelClearHoverSyncTime);
    plotEl.addEventListener('mouseleave', scheduleClearHoverSyncTime);
    plotEl.dataset.hoverSyncBound = '1';
  }

  function normalizedPanelStatMode(panelState) {
    return String(panelState?.ensembleStatMode) === 'median_iqr' ? 'median_iqr' : 'mean_ci95_bootstrap';
  }

  function ensembleCenterName(statMode) {
    return statMode === 'median_iqr' ? 'median' : 'mean';
  }

  function ensembleIntervalName(statMode) {
    return statMode === 'median_iqr' ? 'q25-q75' : '95% CI';
  }

  function getSelectedTrajIds() {
    if (state.selectedTraj === 'all') return trajIds.slice();
    return trajIds.includes(state.selectedTraj) ? [state.selectedTraj] : [];
  }

  function parsePanelIndices(panelIndex) {
    const observable = state.panels[panelIndex].observable;
    const needed = requiredIndexCount(observable);
    const values = [];
    for (let i = 0; i < needed; i++) {
      const input = document.getElementById(`idx-${panelIndex}-${i}`);
      const parsed = Number.parseInt(input.value, 10);
      if (!Number.isFinite(parsed)) return null;
      values.push(parsed);
    }
    return values;
  }

  function panelMessage(panelIndex, text) {
    const el = document.getElementById(`msg-${panelIndex}`);
    if (el) el.textContent = text || '';
  }

  function panelYLabel(observable) {
    if (observable === 'bond') return 'Distance (Å)';
    if (observable === 'angle') return 'Angle (deg)';
    if (observable === 'dihedral') return 'Dihedral (deg, unwrapped)';
    if (observable === 'etot') return 'ΔEtot (Hartree, E-E0)';
    if (observable === 'de_nac') return '|(E_j-E_i)NAC_ij|';
    if (observable === 'state') return 'State index (argmax |c|²)';
    if (observable === '|c|^2') return '|c_i|^2';
    if (observable === 'eig') return 'eig';
    if (observable === 'nac') return 'NAC norm';
    if (observable === 'notebook_var') return 'notebook variable';
    return observable;
  }

  async function getScalarSeries(trajId, observable, indices, allowFetch) {
    if (allowFetch) {
      await dataLoader.ensureSeries(trajId, observable, indices);
    }
    const record = dataLoader.getSeries(trajId, observable, indices);
    if (!record) return null;
    if (record.series_kind !== 'scalar') {
      throw new Error(`Expected scalar series for ${observable}, got ${record.series_kind}`);
    }
    return {
      time: Array.isArray(record.time) ? record.time : [],
      value: Array.isArray(record.value) ? record.value : [],
    };
  }

  async function getMatrixSeries(trajId, observable, indices, allowFetch) {
    if (allowFetch) {
      await dataLoader.ensureSeries(trajId, observable, indices);
    }
    const record = dataLoader.getSeries(trajId, observable, indices);
    if (!record) return null;
    if (record.series_kind !== 'matrix') {
      throw new Error(`Expected matrix series for ${observable}, got ${record.series_kind}`);
    }
    return {
      time: Array.isArray(record.time) ? record.time : [],
      values: Array.isArray(record.values) ? record.values : [],
    };
  }

  async function getRawKeySeriesRecord(trajId, rawKey, allowFetch) {
    if (allowFetch) {
      await dataLoader.ensureRawKeySeries(trajId, rawKey);
    }
    const record = dataLoader.getRawKeySeries(trajId, rawKey);
    if (!record) return null;
    const seriesKind = record.series_kind === 'matrix' ? 'matrix' : 'scalar';
    if (seriesKind === 'matrix') {
      return {
        series_kind: 'matrix',
        time: Array.isArray(record.time) ? record.time : [],
        values: Array.isArray(record.values) ? record.values : [],
        n_components: Number.isFinite(Number(record.n_components)) ? Number(record.n_components) : 0,
        component_labels: Array.isArray(record.component_labels)
          ? record.component_labels.map((v) => String(v))
          : null,
      };
    }
    return {
      series_kind: 'scalar',
      time: Array.isArray(record.time) ? record.time : [],
      value: Array.isArray(record.value) ? record.value : [],
      n_components: null,
      component_labels: null,
    };
  }

  async function getEnsembleSeriesRecord(observable, indices, rawKey, statMode, allowFetch) {
    if (allowFetch) {
      await dataLoader.ensureEnsembleSeries(observable, indices, rawKey, statMode);
    }
    const record = dataLoader.getEnsembleSeries(observable, indices, rawKey, statMode);
    return record || null;
  }

  async function getExpressionSeriesRecord(trajId, expression, allowFetch) {
    if (allowFetch) {
      await dataLoader.ensureExpressionSeries(trajId, expression);
    }
    const record = dataLoader.getExpressionSeries(trajId, expression);
    if (!record) return null;
    const seriesKind = record.series_kind === 'matrix' ? 'matrix' : 'scalar';
    return {
      scope: String(record.scope || 'trajectory'),
      series_kind: seriesKind,
      expression: String(record.expression || expression),
      time: Array.isArray(record.time) ? record.time : [],
      value: seriesKind === 'scalar' && Array.isArray(record.value) ? record.value : [],
      values: seriesKind === 'matrix' && Array.isArray(record.values) ? record.values : [],
      n_components: Number.isFinite(Number(record.n_components)) ? Number(record.n_components) : 0,
      sample_count: Array.isArray(record.sample_count) ? record.sample_count : null,
    };
  }

  async function getExpressionDatasetRecord(expression, allowFetch) {
    if (allowFetch) {
      await dataLoader.ensureExpressionDataset(expression);
    }
    const record = dataLoader.getExpressionDataset(expression);
    if (!record) return null;
    const seriesKind = record.series_kind === 'matrix' ? 'matrix' : 'scalar';
    return {
      scope: String(record.scope || 'dataset'),
      series_kind: seriesKind,
      expression: String(record.expression || expression),
      time: Array.isArray(record.time) ? record.time : [],
      value: seriesKind === 'scalar' && Array.isArray(record.value) ? record.value : [],
      values: seriesKind === 'matrix' && Array.isArray(record.values) ? record.values : [],
      n_components: Number.isFinite(Number(record.n_components)) ? Number(record.n_components) : 0,
      sample_count: Array.isArray(record.sample_count) ? record.sample_count : null,
    };
  }

  function notebookSessionId() {
    if (!notebook || typeof notebook.getSessionId !== 'function') return '';
    return String(notebook.getSessionId() || '').trim();
  }

  async function getNotebookSeriesRecord(variable, trajId, allowFetch) {
    const sessionId = notebookSessionId();
    if (!sessionId) return null;
    if (allowFetch) {
      await dataLoader.ensureNotebookSeries(sessionId, variable, trajId);
    }
    const record = dataLoader.getNotebookSeries(sessionId, variable, trajId);
    if (!record) return null;
    const seriesKind = record.series_kind === 'matrix' ? 'matrix' : 'scalar';
    return {
      session_id: sessionId,
      variable: String(record.variable || variable),
      traj_id: String(record.traj_id || trajId),
      series_kind: seriesKind,
      time: Array.isArray(record.time) ? record.time : [],
      value: seriesKind === 'scalar' && Array.isArray(record.value) ? record.value : [],
      values: seriesKind === 'matrix' && Array.isArray(record.values) ? record.values : [],
      n_components: Number.isFinite(Number(record.n_components)) ? Number(record.n_components) : 0,
      component_labels: Array.isArray(record.component_labels) ? record.component_labels.map((v) => String(v)) : null,
    };
  }

  async function getNotebookEnsembleRecord(variable, statMode, allowFetch) {
    const sessionId = notebookSessionId();
    if (!sessionId) return null;
    if (allowFetch) {
      await dataLoader.ensureNotebookEnsemble(sessionId, variable, statMode);
    }
    const record = dataLoader.getNotebookEnsemble(sessionId, variable, statMode);
    return record || null;
  }

  function truncateText(text, maxLength) {
    const value = String(text || '');
    const limit = Math.max(8, Number(maxLength) || 80);
    if (value.length <= limit) return value;
    return `${value.slice(0, limit - 1)}…`;
  }

  function addExpressionScalarTrace(figData, name, time, value, sampleCount, color) {
    const n = Math.min(
      Array.isArray(time) ? time.length : 0,
      Array.isArray(value) ? value.length : 0
    );
    if (!n) return;
    const x = time.slice(0, n);
    const y = value.slice(0, n);
    const counts = Array.isArray(sampleCount) && sampleCount.length >= n
      ? sampleCount.slice(0, n)
      : x.map(() => null);
    figData.push({
      x: x,
      y: y,
      customdata: counts,
      type: 'scatter',
      mode: 'lines',
      line: { color: color, width: 2 },
      name,
      showlegend: true,
      hovertemplate: 't=%{x:.4f}<br>y=%{y:.6f}<br>n=%{customdata}<extra></extra>'
    });
  }

  function addEnsembleBandAndCenter(
    figData,
    componentSeries,
    {
      namePrefix,
      statMode,
      lineColor,
      fillColor,
      lineShape = null,
      centerHoverLabel = 'y',
    }
  ) {
    const time = Array.isArray(componentSeries?.time) ? componentSeries.time : [];
    const low = Array.isArray(componentSeries?.low) ? componentSeries.low : [];
    const center = Array.isArray(componentSeries?.center) ? componentSeries.center : [];
    const high = Array.isArray(componentSeries?.high) ? componentSeries.high : [];
    const sampleCount = Array.isArray(componentSeries?.sample_count) ? componentSeries.sample_count : [];
    const n = Math.min(time.length, low.length, center.length, high.length);
    if (!n) return;
    const x = time.slice(0, n);
    const lowY = low.slice(0, n);
    const centerY = center.slice(0, n);
    const highY = high.slice(0, n);
    const countData = sampleCount.length >= n ? sampleCount.slice(0, n) : x.map(() => NaN);
    const centerMetric = ensembleCenterName(statMode);
    const intervalMetric = ensembleIntervalName(statMode);
    const shapePart = lineShape ? { shape: lineShape } : {};

    figData.push({
      x: x,
      y: highY,
      customdata: countData,
      type: 'scatter',
      mode: 'lines',
      line: { color: lineColor, width: 0, ...shapePart },
      name: `${namePrefix} ${intervalMetric} upper`,
      showlegend: false,
      hoverinfo: 'skip'
    });
    figData.push({
      x: x,
      y: lowY,
      customdata: countData,
      type: 'scatter',
      mode: 'lines',
      fill: 'tonexty',
      fillcolor: fillColor,
      line: { color: lineColor, width: 0, ...shapePart },
      name: `${namePrefix} ${intervalMetric}`,
      showlegend: true,
      hovertemplate: 't=%{x:.4f}<br>low=%{y:.6f}<br>n=%{customdata:.0f}<extra></extra>'
    });
    figData.push({
      x: x,
      y: centerY,
      customdata: countData,
      type: 'scatter',
      mode: 'lines',
      line: { color: lineColor, width: 2.5, ...shapePart },
      name: `${namePrefix} ${centerMetric}`,
      showlegend: true,
      hovertemplate: `t=%{x:.4f}<br>${centerHoverLabel}=%{y:.6f}<br>n=%{customdata:.0f}<extra></extra>`
    });
  }

  function stateColor(stateIndex) {
    const palette = ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd'];
    return palette[stateIndex % palette.length];
  }

  function trajHoverLabel(trajId) {
    return String(trajId);
  }

  function componentLabel(componentLabels, index) {
    if (!Array.isArray(componentLabels) || index < 0 || index >= componentLabels.length) {
      return `component ${index}`;
    }
    const text = String(componentLabels[index] || '').trim();
    return text || `component ${index}`;
  }

  function addAllModeScalar(
    figData,
    seriesList,
    namePrefix,
    lineColor,
    ensembleRecord,
    statMode,
    { lineShape = null, fillColor = 'rgba(31,119,180,0.18)', centerHoverLabel = 'y' } = {}
  ) {
    const drawTraces = state.showAllTraces || !state.showEnsemble;
    const shapePart = lineShape ? { shape: lineShape } : {};
    if (drawTraces) {
      for (const series of seriesList) {
        const trajLabel = trajHoverLabel(series.traj_id);
        figData.push({
          x: series.time,
          y: series.value,
          type: 'scatter',
          mode: 'lines',
          line: { color: 'rgba(120,120,120,0.35)', width: 1, ...shapePart },
          name: `${namePrefix} traj ${series.traj_id}`,
          showlegend: false,
          hovertemplate: `${trajLabel}<br>t=%{x:.4f}<br>y=%{y:.6f}<extra></extra>`
        });
      }
    }

    if (state.showEnsemble) {
      const componentSeries = Array.isArray(ensembleRecord?.component_series)
        ? ensembleRecord.component_series[0]
        : null;
      addEnsembleBandAndCenter(figData, componentSeries, {
        namePrefix,
        statMode,
        lineColor,
        fillColor,
        lineShape,
        centerHoverLabel,
      });
    }
  }

  function addAllModeEig(figData, eigSeriesList, ensembleRecord, statMode) {
    const traceStateCount = Math.max(...eigSeriesList.map((s) => (s.values[0] ? s.values[0].length : 0)), 0);
    const ensembleComponents = Array.isArray(ensembleRecord?.component_series) ? ensembleRecord.component_series : [];
    const ensembleStateCount = Math.max(
      ...ensembleComponents.map((s) => (Number.isFinite(Number(s?.component)) ? Number(s.component) + 1 : 0)),
      0
    );
    const stateCount = Math.max(traceStateCount, ensembleStateCount);
    const drawTraces = state.showAllTraces || !state.showEnsemble;
    const ensembleByComponent = new Map();
    for (const comp of ensembleComponents) {
      if (!Number.isFinite(Number(comp?.component))) continue;
      ensembleByComponent.set(Number(comp.component), comp);
    }

    for (let s = 0; s < stateCount; s++) {
      const scalarSeries = [];
      for (const item of eigSeriesList) {
        const n = Math.min(item.time.length, item.values.length);
        const y = [];
        const x = [];
        for (let i = 0; i < n; i++) {
          if (!Array.isArray(item.values[i]) || item.values[i].length <= s) continue;
          x.push(item.time[i]);
          y.push(item.values[i][s]);
        }
        if (x.length) scalarSeries.push({ traj_id: item.traj_id, time: x, value: y });
      }
      const ensembleComp = ensembleByComponent.get(s);
      if (!scalarSeries.length && !ensembleComp) continue;
      const color = stateColor(s);

      if (drawTraces) {
        for (const series of scalarSeries) {
          const trajLabel = trajHoverLabel(series.traj_id);
          figData.push({
            x: series.time,
            y: series.value,
            type: 'scatter',
            mode: 'lines',
            line: { color: color, width: 1 },
            opacity: 0.25,
            name: `eig state ${s} traj ${series.traj_id}`,
            showlegend: false,
            hovertemplate: `${trajLabel}<br>t=%{x:.4f}<br>y=%{y:.6f}<extra></extra>`
          });
        }
      }

      if (state.showEnsemble) {
        addEnsembleBandAndCenter(figData, ensembleComp, {
          namePrefix: `eig state ${s}`,
          statMode,
          lineColor: color,
          fillColor: 'rgba(0,0,0,0.08)',
        });
      }
    }
  }

  function addAllModeCProb(figData, cProbSeriesList, ensembleRecord, statMode) {
    const traceComponentCount = Math.max(...cProbSeriesList.map((s) => (s.values[0] ? s.values[0].length : 0)), 0);
    const ensembleComponents = Array.isArray(ensembleRecord?.component_series) ? ensembleRecord.component_series : [];
    const ensembleComponentCount = Math.max(
      ...ensembleComponents.map((s) => (Number.isFinite(Number(s?.component)) ? Number(s.component) + 1 : 0)),
      0
    );
    const componentCount = Math.max(traceComponentCount, ensembleComponentCount);
    const drawTraces = state.showAllTraces || !state.showEnsemble;
    const ensembleByComponent = new Map();
    for (const comp of ensembleComponents) {
      if (!Number.isFinite(Number(comp?.component))) continue;
      ensembleByComponent.set(Number(comp.component), comp);
    }

    for (let component = 0; component < componentCount; component++) {
      const scalarSeries = [];
      for (const item of cProbSeriesList) {
        const n = Math.min(item.time.length, item.values.length);
        const y = [];
        const x = [];
        for (let i = 0; i < n; i++) {
          if (!Array.isArray(item.values[i]) || item.values[i].length <= component) continue;
          x.push(item.time[i]);
          y.push(item.values[i][component]);
        }
        if (x.length) scalarSeries.push({ traj_id: item.traj_id, time: x, value: y });
      }
      const ensembleComp = ensembleByComponent.get(component);
      if (!scalarSeries.length && !ensembleComp) continue;
      const color = stateColor(component);

      if (drawTraces) {
        for (const series of scalarSeries) {
          const trajLabel = trajHoverLabel(series.traj_id);
          figData.push({
            x: series.time,
            y: series.value,
            type: 'scatter',
            mode: 'lines',
            line: { color: color, width: 1 },
            opacity: 0.25,
            name: `|c|^2 component ${component} traj ${series.traj_id}`,
            showlegend: false,
            hovertemplate: `${trajLabel}<br>t=%{x:.4f}<br>|c|^2=%{y:.6f}<extra></extra>`
          });
        }
      }

      if (state.showEnsemble) {
        addEnsembleBandAndCenter(figData, ensembleComp, {
          namePrefix: `|c|^2 component ${component}`,
          statMode,
          lineColor: color,
          fillColor: 'rgba(0,0,0,0.08)',
          centerHoverLabel: '|c|^2',
        });
      }
    }
  }

  function addAllModeRawKeyMatrix(figData, matrixSeriesList, rawKey, componentLabels = null, ensembleRecord, statMode) {
    const traceComponentCount = Math.max(...matrixSeriesList.map((s) => (s.values[0] ? s.values[0].length : 0)), 0);
    const ensembleComponents = Array.isArray(ensembleRecord?.component_series) ? ensembleRecord.component_series : [];
    const ensembleComponentCount = Math.max(
      ...ensembleComponents.map((s) => (Number.isFinite(Number(s?.component)) ? Number(s.component) + 1 : 0)),
      0
    );
    const componentCount = Math.max(traceComponentCount, ensembleComponentCount);
    const drawTraces = state.showAllTraces || !state.showEnsemble;
    const ensembleByComponent = new Map();
    for (const comp of ensembleComponents) {
      if (!Number.isFinite(Number(comp?.component))) continue;
      ensembleByComponent.set(Number(comp.component), comp);
    }

    for (let component = 0; component < componentCount; component++) {
      const scalarSeries = [];
      for (const item of matrixSeriesList) {
        const n = Math.min(item.time.length, item.values.length);
        const y = [];
        const x = [];
        for (let i = 0; i < n; i++) {
          if (!Array.isArray(item.values[i]) || item.values[i].length <= component) continue;
          x.push(item.time[i]);
          y.push(item.values[i][component]);
        }
        if (x.length) scalarSeries.push({ traj_id: item.traj_id, time: x, value: y });
      }
      const ensembleComp = ensembleByComponent.get(component);
      if (!scalarSeries.length && !ensembleComp) continue;
      const color = stateColor(component);
      let label = componentLabel(componentLabels, component);
      if (
        (!Array.isArray(componentLabels) || component < 0 || component >= componentLabels.length)
        && typeof ensembleComp?.label === 'string'
        && ensembleComp.label.trim()
      ) {
        label = ensembleComp.label.trim();
      }

      if (drawTraces) {
        for (const series of scalarSeries) {
          const trajLabel = trajHoverLabel(series.traj_id);
          figData.push({
            x: series.time,
            y: series.value,
            type: 'scatter',
            mode: 'lines',
            line: { color: color, width: 1 },
            opacity: 0.25,
            name: `${rawKey} ${label} traj ${series.traj_id}`,
            showlegend: false,
            hovertemplate: `${trajLabel}<br>t=%{x:.4f}<br>y=%{y:.6f}<extra></extra>`
          });
        }
      }

      if (state.showEnsemble) {
        addEnsembleBandAndCenter(figData, ensembleComp, {
          namePrefix: `${rawKey} ${label}`,
          statMode,
          lineColor: color,
          fillColor: 'rgba(0,0,0,0.08)',
        });
      }
    }
  }

  function purgePlot(plotId) {
    if (typeof Plotly === 'undefined') return;
    Plotly.purge(plotId);
  }

  async function renderPanelCore(panelIndex) {
    panelMessage(panelIndex, '');

    const panelState = state.panels[panelIndex];
    if (!panelState) return;

    const panelObservable = String(panelState.observable || '');
    const observable = canonicalObservable(panelObservable);
    const rawAlias = rawAliasFromObservable(panelObservable);
    const panelStatMode = normalizedPanelStatMode(panelState);
    const needed = requiredIndexCount(panelObservable);
    const plotId = `plot-${panelIndex}`;

    let indices = [];
    if (needed > 0) {
      const parsed = parsePanelIndices(panelIndex);
      if (!parsed) {
        panelMessage(panelIndex, 'Indices must be integers.');
        purgePlot(plotId);
        return;
      }
      indices = parsed;
      panelState.indices = parsed.slice();
    } else {
      panelState.indices = [];
    }

    const drawAllTraces = state.selectedTraj === 'all' && (state.showAllTraces || !state.showEnsemble);
    if (drawAllTraces && observable !== 'raw_key' && observable !== 'expression' && observable !== 'notebook_var') {
      try {
        setGlobalStatus(`Computing All (Panel ${panelIndex + 1}): 0/0`);
        const result = await dataLoader.ensureAllForPanelRequirements(
          {
            requirements: [{ observable, indices: indices.slice() }],
          },
          (done, total) => {
            setGlobalStatus(`Computing All (Panel ${panelIndex + 1}): ${done}/${total}`);
          }
        );
        setGlobalStatus(`All auto compute complete (Panel ${panelIndex + 1}): ${result.done}/${result.total}`);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        panelMessage(panelIndex, `Auto compute failed: ${detail}`);
        setGlobalStatus(`Auto compute failed (Panel ${panelIndex + 1}): ${detail}`, true);
        purgePlot(plotId);
        return;
      }
    }

    const selectedIds = getSelectedTrajIds();
    if (!selectedIds.length) {
      panelMessage(panelIndex, 'No trajectory available.');
      purgePlot(plotId);
      return;
    }

    const fetchAllowed = state.selectedTraj !== 'all';
    const figData = [];
    let yLabel = panelYLabel(observable);
    let title = observable;
    let plotTitleTooltip = '';
    const rawKey = observable === 'raw_key' ? resolveRawKeyForPanel(panelState, state.rawKeyAliases) : '';
    const rawName = String(rawAlias || rawKey || 'raw_key').trim();
    const expressionText = observable === 'expression' ? String(panelState.expression || '').trim() : '';
    const expressionLabel = observable === 'expression' ? String(panelState.expressionLabel || '').trim() : '';
    const notebookVar = observable === 'notebook_var' ? String(panelState.notebookVar || '').trim() : '';
    if (observable === 'expression') {
      const fullTitle = expressionLabel || expressionText || 'expression';
      title = truncateText(fullTitle, 120);
      plotTitleTooltip = fullTitle;
      yLabel = expressionText || 'expression';
    } else if (observable === 'notebook_var') {
      const fullTitle = notebookVar ? `notebook: ${notebookVar}` : 'notebook variable';
      title = truncateText(fullTitle, 120);
      plotTitleTooltip = fullTitle;
      yLabel = notebookVar || 'notebook variable';
    } else if (observable === 'raw_key') {
      if (rawAlias) {
        title = rawKey ? `${rawAlias} (raw_key: ${rawKey})` : `${rawAlias} (raw key missing)`;
        yLabel = rawAlias;
      } else {
        title = rawKey ? `raw_key: ${rawKey}` : 'raw_key';
        yLabel = rawKey || 'raw_key';
      }
    } else if (needed > 0) {
      title = `${observable} (${indices.join('-')})`;
    }

    try {
      if (observable === 'expression') {
        if (!expressionText) {
          panelMessage(panelIndex, 'Expression is empty. Fill it in panel controls or Expression Inspector.');
          purgePlot(plotId);
          return;
        }

        const traceNameBase = expressionLabel || 'expression';
        if (state.selectedTraj === 'all') {
          const datasetRecord = await getExpressionDatasetRecord(expressionText, true);
          if (!datasetRecord) {
            panelMessage(panelIndex, 'No dataset expression result.');
            purgePlot(plotId);
            return;
          }
          if (datasetRecord.series_kind === 'matrix') {
            const firstRow = Array.isArray(datasetRecord.values?.[0]) ? datasetRecord.values[0] : [];
            const nComponents = Number(datasetRecord.n_components) > 0
              ? Number(datasetRecord.n_components)
              : firstRow.length;
            if (!nComponents) {
              panelMessage(panelIndex, 'No expression matrix components available.');
              purgePlot(plotId);
              return;
            }
            for (let component = 0; component < nComponents; component++) {
              const n = Math.min(datasetRecord.time.length, datasetRecord.values.length);
              const x = [];
              const y = [];
              const counts = [];
              for (let i = 0; i < n; i++) {
                if (!Array.isArray(datasetRecord.values[i]) || datasetRecord.values[i].length <= component) continue;
                x.push(datasetRecord.time[i]);
                y.push(datasetRecord.values[i][component]);
                counts.push(Array.isArray(datasetRecord.sample_count) ? datasetRecord.sample_count[i] : null);
              }
              if (!x.length) continue;
              figData.push({
                x: x,
                y: y,
                customdata: counts,
                type: 'scatter',
                mode: 'lines',
                line: { color: stateColor(component), width: 2 },
                name: `${traceNameBase} component ${component}`,
                showlegend: true,
                hovertemplate: 't=%{x:.4f}<br>y=%{y:.6f}<br>n=%{customdata}<extra></extra>'
              });
            }
          } else {
            addExpressionScalarTrace(
              figData,
              `${traceNameBase} dataset`,
              datasetRecord.time,
              datasetRecord.value,
              datasetRecord.sample_count,
              '#1f77b4'
            );
          }
        } else {
          const trajId = selectedIds[0];
          const seriesRecord = await getExpressionSeriesRecord(trajId, expressionText, true);
          if (!seriesRecord) {
            panelMessage(panelIndex, `No expression data for traj ${trajId}.`);
            purgePlot(plotId);
            return;
          }
          if (seriesRecord.series_kind === 'matrix') {
            const firstRow = Array.isArray(seriesRecord.values?.[0]) ? seriesRecord.values[0] : [];
            const nComponents = Number(seriesRecord.n_components) > 0
              ? Number(seriesRecord.n_components)
              : firstRow.length;
            if (!nComponents) {
              panelMessage(panelIndex, 'No expression matrix components available.');
              purgePlot(plotId);
              return;
            }
            for (let component = 0; component < nComponents; component++) {
              const n = Math.min(seriesRecord.time.length, seriesRecord.values.length);
              const x = [];
              const y = [];
              const counts = [];
              for (let i = 0; i < n; i++) {
                if (!Array.isArray(seriesRecord.values[i]) || seriesRecord.values[i].length <= component) continue;
                x.push(seriesRecord.time[i]);
                y.push(seriesRecord.values[i][component]);
                counts.push(Array.isArray(seriesRecord.sample_count) ? seriesRecord.sample_count[i] : null);
              }
              if (!x.length) continue;
              figData.push({
                x: x,
                y: y,
                customdata: counts,
                type: 'scatter',
                mode: 'lines',
                line: { color: stateColor(component), width: 2 },
                name: `${traceNameBase} component ${component}`,
                showlegend: true,
                hovertemplate: 't=%{x:.4f}<br>y=%{y:.6f}<br>n=%{customdata}<extra></extra>'
              });
            }
          } else {
            addExpressionScalarTrace(
              figData,
              `${traceNameBase} traj ${trajId}`,
              seriesRecord.time,
              seriesRecord.value,
              seriesRecord.sample_count,
              '#1f77b4'
            );
          }
        }

        if (!figData.length) {
          panelMessage(panelIndex, 'Expression evaluated but returned no plottable points.');
          purgePlot(plotId);
          return;
        }
      } else if (observable === 'notebook_var') {
        if (!notebookVar) {
          panelMessage(panelIndex, 'Notebook variable is empty. Pick one from panel controls.');
          purgePlot(plotId);
          return;
        }
        if (!notebookSessionId()) {
          panelMessage(panelIndex, 'Notebook session is unavailable. Open Notebook Workspace and run a cell first.');
          purgePlot(plotId);
          return;
        }

        if (state.selectedTraj === 'all') {
          const drawTraces = state.showAllTraces || !state.showEnsemble;
          const notebookScalarSeries = [];
          const notebookMatrixSeries = [];
          let expectedKind = '';
          let allModeComponentLabels = null;
          let allModeLabelsMismatch = false;
          let allModeSawMissingLabels = false;
          let ensembleRecord = null;

          if (drawTraces) {
            let done = 0;
            const total = selectedIds.length;
            setGlobalStatus(`Computing All (Panel ${panelIndex + 1}): 0/${total}`);

            for (const trajId of selectedIds) {
              const series = await getNotebookSeriesRecord(notebookVar, trajId, true);
              done += 1;
              setGlobalStatus(`Computing All (Panel ${panelIndex + 1}): ${done}/${total}`);
              if (!series) continue;
              if (!expectedKind) {
                expectedKind = series.series_kind;
              } else if (series.series_kind !== expectedKind) {
                throw new Error(
                  (
                    `Notebook variable '${notebookVar}' has mixed series kinds across trajectories `
                    + '(scalar and matrix), which is not supported in All mode.'
                  )
                );
              }

              if (series.series_kind === 'matrix') {
                const labels = Array.isArray(series.component_labels) ? series.component_labels : null;
                if (labels && !allModeComponentLabels) {
                  allModeComponentLabels = labels.slice();
                } else if (labels && allModeComponentLabels) {
                  if (
                    labels.length !== allModeComponentLabels.length
                    || labels.some((label, idx) => String(label) !== String(allModeComponentLabels[idx]))
                  ) {
                    allModeLabelsMismatch = true;
                  }
                } else if (!labels) {
                  allModeSawMissingLabels = true;
                }
                notebookMatrixSeries.push({ traj_id: trajId, time: series.time, values: series.values });
              } else {
                notebookScalarSeries.push({ traj_id: trajId, time: series.time, value: series.value });
              }
            }
            setGlobalStatus(`All auto compute complete (Panel ${panelIndex + 1}): ${done}/${total}`);
          }

          if (state.showEnsemble) {
            ensembleRecord = await getNotebookEnsembleRecord(notebookVar, panelStatMode, true);
            const hasComponents = Array.isArray(ensembleRecord?.component_series) && ensembleRecord.component_series.length > 0;
            if (!hasComponents) {
              panelMessage(panelIndex, `No notebook ensemble data found for '${notebookVar}'.`);
              purgePlot(plotId);
              return;
            }
          }

          if (drawTraces) {
            if (!expectedKind) {
              panelMessage(panelIndex, `No notebook data found for '${notebookVar}'.`);
              purgePlot(plotId);
              return;
            }

            if (expectedKind === 'matrix') {
              if (!notebookMatrixSeries.length) {
                panelMessage(panelIndex, `No notebook matrix data found for '${notebookVar}'.`);
                purgePlot(plotId);
                return;
              }
              if (allModeSawMissingLabels && allModeComponentLabels) {
                allModeLabelsMismatch = true;
              }
              if (allModeLabelsMismatch) {
                allModeComponentLabels = null;
                console.warn(
                  `Notebook variable '${notebookVar}' has inconsistent component labels across trajectories; fallback to index labels.`
                );
              }
              addAllModeRawKeyMatrix(
                figData,
                notebookMatrixSeries,
                notebookVar,
                allModeComponentLabels,
                ensembleRecord,
                panelStatMode
              );
              if (!figData.length) {
                panelMessage(panelIndex, `No notebook components available for '${notebookVar}'.`);
                purgePlot(plotId);
                return;
              }
            } else {
              if (!notebookScalarSeries.length) {
                panelMessage(panelIndex, `No notebook scalar data found for '${notebookVar}'.`);
                purgePlot(plotId);
                return;
              }
              addAllModeScalar(figData, notebookScalarSeries, notebookVar, '#1f77b4', ensembleRecord, panelStatMode);
            }
          } else {
            const componentSeries = Array.isArray(ensembleRecord?.component_series)
              ? ensembleRecord.component_series
              : [];
            if (!componentSeries.length) {
              panelMessage(panelIndex, `No notebook ensemble data found for '${notebookVar}'.`);
              purgePlot(plotId);
              return;
            }
            if (componentSeries.length === 1) {
              addAllModeScalar(figData, [], notebookVar, '#1f77b4', ensembleRecord, panelStatMode);
            } else {
              const labels = componentSeries.map((series, idx) => {
                const text = String(series?.label || '').trim();
                return text || `component ${idx}`;
              });
              addAllModeRawKeyMatrix(figData, [], notebookVar, labels, ensembleRecord, panelStatMode);
            }
          }
        } else {
          const series = await getNotebookSeriesRecord(notebookVar, selectedIds[0], true);
          if (!series) {
            panelMessage(panelIndex, `No notebook data found for '${notebookVar}'.`);
            purgePlot(plotId);
            return;
          }

          if (series.series_kind === 'matrix') {
            const labels = Array.isArray(series.component_labels) ? series.component_labels : null;
            const nComponents = Number(series.n_components) > 0
              ? Number(series.n_components)
              : (labels && labels.length ? labels.length : (Array.isArray(series.values[0]) ? series.values[0].length : 0));
            if (!nComponents) {
              panelMessage(panelIndex, `No notebook components available for '${notebookVar}'.`);
              purgePlot(plotId);
              return;
            }

            for (let component = 0; component < nComponents; component++) {
              const n = Math.min(series.time.length, series.values.length);
              const x = [];
              const y = [];
              for (let i = 0; i < n; i++) {
                if (!Array.isArray(series.values[i]) || series.values[i].length <= component) continue;
                x.push(series.time[i]);
                y.push(series.values[i][component]);
              }
              if (!x.length) continue;
              const label = componentLabel(labels, component);
              figData.push({
                x: x,
                y: y,
                type: 'scatter',
                mode: 'lines',
                line: { color: stateColor(component), width: 2 },
                name: `${notebookVar} ${label}`,
                showlegend: true,
                hovertemplate: 't=%{x:.4f}<br>y=%{y:.6f}<extra></extra>'
              });
            }

            if (!figData.length) {
              panelMessage(panelIndex, `No notebook components available for '${notebookVar}'.`);
              purgePlot(plotId);
              return;
            }
          } else {
            figData.push({
              x: series.time,
              y: series.value,
              type: 'scatter',
              mode: 'lines',
              line: { color: '#1f77b4', width: 2 },
              name: `${notebookVar} traj ${selectedIds[0]}`,
              showlegend: true,
              hovertemplate: 't=%{x:.4f}<br>y=%{y:.6f}<extra></extra>'
            });
          }
        }
      } else if (observable === 'raw_key') {
        if (!rawKey) {
          if (rawAlias) {
            panelMessage(panelIndex, `Raw key alias '${rawAlias}' is not mapped. Re-add it from PKL Key Inspector.`);
          } else {
            panelMessage(panelIndex, 'No raw key set. Use PKL Key Inspector and click "Add to panel".');
          }
          purgePlot(plotId);
          return;
        }

        if (state.selectedTraj === 'all') {
          const drawTraces = state.showAllTraces || !state.showEnsemble;
          const rawScalarSeries = [];
          const rawMatrixSeries = [];
          let expectedKind = '';
          let allModeComponentLabels = null;
          let allModeLabelsMismatch = false;
          let allModeSawMissingLabels = false;
          let ensembleRecord = null;

          if (drawTraces) {
            let done = 0;
            const total = selectedIds.length;
            setGlobalStatus(`Computing All (Panel ${panelIndex + 1}): 0/${total}`);

            for (const trajId of selectedIds) {
              const series = await getRawKeySeriesRecord(trajId, rawKey, true);
              done += 1;
              setGlobalStatus(`Computing All (Panel ${panelIndex + 1}): ${done}/${total}`);
              if (!series) continue;
              if (!expectedKind) {
                expectedKind = series.series_kind;
              } else if (series.series_kind !== expectedKind) {
                throw new Error(
                  (
                    `Raw key '${rawKey}' has mixed series kinds across trajectories `
                    + '(scalar and matrix), which is not supported in All mode.'
                  )
                );
              }

              if (series.series_kind === 'matrix') {
                const labels = Array.isArray(series.component_labels) ? series.component_labels : null;
                if (labels && !allModeComponentLabels) {
                  allModeComponentLabels = labels.slice();
                } else if (labels && allModeComponentLabels) {
                  if (
                    labels.length !== allModeComponentLabels.length
                    || labels.some((label, idx) => String(label) !== String(allModeComponentLabels[idx]))
                  ) {
                    allModeLabelsMismatch = true;
                  }
                } else if (!labels) {
                  allModeSawMissingLabels = true;
                }
                rawMatrixSeries.push({ traj_id: trajId, time: series.time, values: series.values });
              } else {
                rawScalarSeries.push({ traj_id: trajId, time: series.time, value: series.value });
              }
            }
            setGlobalStatus(`All auto compute complete (Panel ${panelIndex + 1}): ${done}/${total}`);
          }

          if (state.showEnsemble) {
            ensembleRecord = await getEnsembleSeriesRecord('raw_key', [], rawKey, panelStatMode, true);
            const hasComponents = Array.isArray(ensembleRecord?.component_series) && ensembleRecord.component_series.length > 0;
            if (!hasComponents) {
              panelMessage(panelIndex, `No raw key ensemble data found for '${rawKey}'.`);
              purgePlot(plotId);
              return;
            }
          }

          if (drawTraces) {
            if (!expectedKind) {
              panelMessage(panelIndex, `No raw key data found for '${rawKey}'.`);
              purgePlot(plotId);
              return;
            }

            if (expectedKind === 'matrix') {
              if (!rawMatrixSeries.length) {
                panelMessage(panelIndex, `No raw key matrix data found for '${rawKey}'.`);
                purgePlot(plotId);
                return;
              }
              if (allModeSawMissingLabels && allModeComponentLabels) {
                allModeLabelsMismatch = true;
              }
              if (allModeLabelsMismatch) {
                allModeComponentLabels = null;
                console.warn(
                  `Raw key '${rawKey}' has inconsistent component labels across trajectories; fallback to index labels.`
                );
              }
              addAllModeRawKeyMatrix(
                figData,
                rawMatrixSeries,
                rawName,
                allModeComponentLabels,
                ensembleRecord,
                panelStatMode
              );
              if (!figData.length) {
                panelMessage(panelIndex, `No raw key components available for '${rawKey}'.`);
                purgePlot(plotId);
                return;
              }
            } else {
              if (!rawScalarSeries.length) {
                panelMessage(panelIndex, `No raw key scalar data found for '${rawKey}'.`);
                purgePlot(plotId);
                return;
              }
              addAllModeScalar(figData, rawScalarSeries, rawName, '#1f77b4', ensembleRecord, panelStatMode);
            }
          } else {
            const componentSeries = Array.isArray(ensembleRecord?.component_series)
              ? ensembleRecord.component_series
              : [];
            if (!componentSeries.length) {
              panelMessage(panelIndex, `No raw key ensemble data found for '${rawKey}'.`);
              purgePlot(plotId);
              return;
            }
            if (componentSeries.length === 1) {
              addAllModeScalar(figData, [], rawName, '#1f77b4', ensembleRecord, panelStatMode);
            } else {
              const labels = componentSeries.map((series, idx) => {
                const text = String(series?.label || '').trim();
                return text || `component ${idx}`;
              });
              addAllModeRawKeyMatrix(figData, [], rawName, labels, ensembleRecord, panelStatMode);
            }
          }
        } else {
          const series = await getRawKeySeriesRecord(selectedIds[0], rawKey, true);
          if (!series) {
            panelMessage(panelIndex, `No raw key data found for '${rawKey}'.`);
            purgePlot(plotId);
            return;
          }

          if (series.series_kind === 'matrix') {
            const labels = Array.isArray(series.component_labels) ? series.component_labels : null;
            const nComponents = Number(series.n_components) > 0
              ? Number(series.n_components)
              : (labels && labels.length ? labels.length : (Array.isArray(series.values[0]) ? series.values[0].length : 0));
            if (!nComponents) {
              panelMessage(panelIndex, `No raw key components available for '${rawKey}'.`);
              purgePlot(plotId);
              return;
            }

            for (let component = 0; component < nComponents; component++) {
              const n = Math.min(series.time.length, series.values.length);
              const x = [];
              const y = [];
              for (let i = 0; i < n; i++) {
                if (!Array.isArray(series.values[i]) || series.values[i].length <= component) continue;
                x.push(series.time[i]);
                y.push(series.values[i][component]);
              }
              if (!x.length) continue;
              const label = componentLabel(labels, component);
              figData.push({
                x: x,
                y: y,
                type: 'scatter',
                mode: 'lines',
                line: { color: stateColor(component), width: 2 },
                name: `${rawName} ${label}`,
                showlegend: true,
                hovertemplate: 't=%{x:.4f}<br>y=%{y:.6f}<extra></extra>'
              });
            }

            if (!figData.length) {
              panelMessage(panelIndex, `No raw key components available for '${rawKey}'.`);
              purgePlot(plotId);
              return;
            }
          } else {
            figData.push({
              x: series.time,
              y: series.value,
              type: 'scatter',
              mode: 'lines',
              line: { color: '#1f77b4', width: 2 },
              name: `${rawName} traj ${selectedIds[0]}`,
              showlegend: true,
              hovertemplate: 't=%{x:.4f}<br>y=%{y:.6f}<extra></extra>'
            });
          }
        }
      } else if (observable === 'state') {
        if (state.selectedTraj === 'all') {
          const drawTraces = state.showAllTraces || !state.showEnsemble;
          const stateSeries = [];
          let ensembleRecord = null;
          if (drawTraces) {
            for (const trajId of selectedIds) {
              const series = await getScalarSeries(trajId, 'state', [], fetchAllowed);
              if (!series) continue;
              stateSeries.push({ traj_id: trajId, time: series.time, value: series.value });
            }
          }
          if (state.showEnsemble) {
            ensembleRecord = await getEnsembleSeriesRecord('state', [], '', panelStatMode, true);
            const hasComponents = Array.isArray(ensembleRecord?.component_series)
              && ensembleRecord.component_series.length > 0;
            if (!hasComponents) {
              panelMessage(panelIndex, 'No state ensemble data for selection.');
              purgePlot(plotId);
              return;
            }
          }
          if (!stateSeries.length && !state.showEnsemble) {
            panelMessage(panelIndex, 'No state data for selection.');
            purgePlot(plotId);
            return;
          }
          addAllModeScalar(figData, stateSeries, 'state', '#d62728', ensembleRecord, panelStatMode, {
            lineShape: 'hv',
            fillColor: 'rgba(214,39,40,0.18)',
            centerHoverLabel: 'state'
          });
        } else {
          const stateSeries = [];
          for (const trajId of selectedIds) {
            const series = await getScalarSeries(trajId, 'state', [], fetchAllowed);
            if (!series) continue;
            stateSeries.push({ traj_id: trajId, time: series.time, value: series.value });
          }
          if (!stateSeries.length) {
            panelMessage(panelIndex, 'No state data for selection.');
            purgePlot(plotId);
            return;
          }
          const series = stateSeries[0];
          figData.push({
            x: series.time,
            y: series.value,
            type: 'scatter',
            mode: 'lines',
            line: { color: '#d62728', width: 2, shape: 'hv' },
            name: `state traj ${series.traj_id}`,
            showlegend: true,
            hovertemplate: 't=%{x:.4f}<br>state=%{y:.0f}<extra></extra>'
          });
        }
      } else if (observable === 'eig') {
        if (state.selectedTraj === 'all') {
          const drawTraces = state.showAllTraces || !state.showEnsemble;
          const eigSeriesList = [];
          let ensembleRecord = null;
          if (drawTraces) {
            for (const trajId of selectedIds) {
              const series = await getMatrixSeries(trajId, 'eig', [], fetchAllowed);
              if (!series) continue;
              eigSeriesList.push({ traj_id: trajId, time: series.time, values: series.values });
            }
          }
          if (state.showEnsemble) {
            ensembleRecord = await getEnsembleSeriesRecord('eig', [], '', panelStatMode, true);
            const hasComponents = Array.isArray(ensembleRecord?.component_series)
              && ensembleRecord.component_series.length > 0;
            if (!hasComponents) {
              panelMessage(panelIndex, 'No eig ensemble data for selected trajectory set.');
              purgePlot(plotId);
              return;
            }
          }
          if (!eigSeriesList.length && !state.showEnsemble) {
            panelMessage(panelIndex, 'No eig data for selected trajectory set.');
            purgePlot(plotId);
            return;
          }
          addAllModeEig(figData, eigSeriesList, ensembleRecord, panelStatMode);
          if (!figData.length) {
            panelMessage(panelIndex, 'No eig components available for selected trajectory set.');
            purgePlot(plotId);
            return;
          }
        } else {
          const series = await getMatrixSeries(selectedIds[0], 'eig', [], true);
          if (!series || !series.values.length) {
            panelMessage(panelIndex, 'No eig data for selected trajectory.');
            purgePlot(plotId);
            return;
          }

          const nStates = Array.isArray(series.values[0]) ? series.values[0].length : 0;
          if (!nStates) {
            panelMessage(panelIndex, 'No eig states available.');
            purgePlot(plotId);
            return;
          }

          for (let s = 0; s < nStates; s++) {
            const y = series.values.map((row) => row[s]);
            figData.push({
              x: series.time,
              y: y,
              type: 'scatter',
              mode: 'lines',
              line: { color: stateColor(s), width: 2 },
              name: `eig state ${s}`,
              showlegend: true,
              hovertemplate: 't=%{x:.4f}<br>y=%{y:.6f}<extra></extra>'
            });
          }
        }
      } else if (observable === '|c|^2') {
        if (state.selectedTraj === 'all') {
          const drawTraces = state.showAllTraces || !state.showEnsemble;
          const cProbSeriesList = [];
          let ensembleRecord = null;
          if (drawTraces) {
            for (const trajId of selectedIds) {
              const series = await getMatrixSeries(trajId, '|c|^2', [], fetchAllowed);
              if (!series) continue;
              cProbSeriesList.push({ traj_id: trajId, time: series.time, values: series.values });
            }
          }
          if (state.showEnsemble) {
            ensembleRecord = await getEnsembleSeriesRecord('|c|^2', [], '', panelStatMode, true);
            const hasComponents = Array.isArray(ensembleRecord?.component_series)
              && ensembleRecord.component_series.length > 0;
            if (!hasComponents) {
              panelMessage(panelIndex, 'No |c|^2 ensemble data for selected trajectory set.');
              purgePlot(plotId);
              return;
            }
          }
          if (!cProbSeriesList.length && !state.showEnsemble) {
            panelMessage(panelIndex, 'No |c|^2 data for selected trajectory set.');
            purgePlot(plotId);
            return;
          }
          addAllModeCProb(figData, cProbSeriesList, ensembleRecord, panelStatMode);
          if (!figData.length) {
            panelMessage(panelIndex, 'No |c|^2 components available for selected trajectory set.');
            purgePlot(plotId);
            return;
          }
        } else {
          const series = await getMatrixSeries(selectedIds[0], '|c|^2', [], true);
          if (!series || !series.values.length) {
            panelMessage(panelIndex, 'No |c|^2 data for selected trajectory.');
            purgePlot(plotId);
            return;
          }

          const nComponents = Array.isArray(series.values[0]) ? series.values[0].length : 0;
          if (!nComponents) {
            panelMessage(panelIndex, 'No |c|^2 components available.');
            purgePlot(plotId);
            return;
          }

          for (let component = 0; component < nComponents; component++) {
            const n = Math.min(series.time.length, series.values.length);
            const x = [];
            const y = [];
            for (let i = 0; i < n; i++) {
              if (!Array.isArray(series.values[i]) || series.values[i].length <= component) continue;
              x.push(series.time[i]);
              y.push(series.values[i][component]);
            }
            if (!x.length) continue;
            figData.push({
              x: x,
              y: y,
              type: 'scatter',
              mode: 'lines',
              line: { color: stateColor(component), width: 2 },
              name: `|c|^2 component ${component}`,
              showlegend: true,
              hovertemplate: 't=%{x:.4f}<br>|c|^2=%{y:.6f}<extra></extra>'
            });
          }

          if (!figData.length) {
            panelMessage(panelIndex, 'No |c|^2 components available.');
            purgePlot(plotId);
            return;
          }
        }
      } else {
        const drawTraces = state.selectedTraj !== 'all' || state.showAllTraces || !state.showEnsemble;
        const scalarSeries = [];
        if (drawTraces) {
          for (const trajId of selectedIds) {
            const series = await getScalarSeries(trajId, observable, indices, fetchAllowed);
            if (!series) continue;
            scalarSeries.push({ traj_id: trajId, time: series.time, value: series.value });
          }
        }

        if (!scalarSeries.length && !(state.selectedTraj === 'all' && state.showEnsemble)) {
          panelMessage(panelIndex, `No ${observable} data for selection.`);
          purgePlot(plotId);
          return;
        }

        if (state.selectedTraj === 'all') {
          let ensembleRecord = null;
          if (state.showEnsemble) {
            ensembleRecord = await getEnsembleSeriesRecord(observable, indices, '', panelStatMode, true);
            const hasComponents = Array.isArray(ensembleRecord?.component_series)
              && ensembleRecord.component_series.length > 0;
            if (!hasComponents) {
              panelMessage(panelIndex, `No ${observable} ensemble data for selection.`);
              purgePlot(plotId);
              return;
            }
          }
          addAllModeScalar(figData, scalarSeries, observable, '#1f77b4', ensembleRecord, panelStatMode);
          if (!figData.length) {
            panelMessage(panelIndex, `No ${observable} data for selection.`);
            purgePlot(plotId);
            return;
          }
        } else {
          const series = scalarSeries[0];
          figData.push({
            x: series.time,
            y: series.value,
            type: 'scatter',
            mode: 'lines',
            line: { color: '#1f77b4', width: 2 },
            name: `${observable} traj ${series.traj_id}`,
            showlegend: true,
            hovertemplate: 't=%{x:.4f}<br>y=%{y:.6f}<extra></extra>'
          });
        }
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      panelMessage(panelIndex, `Data load failed: ${detail}`);
      setGlobalStatus(`Data load failed (Panel ${panelIndex + 1}): ${detail}`, true);
      purgePlot(plotId);
      return;
    }

    const layout = {
      title: { text: title, font: { size: 15 } },
      xaxis: { title: 'Time (fs)' },
      yaxis: { title: yLabel },
      template: 'plotly_white',
      margin: { l: 58, r: 18, t: 48, b: 48 },
      legend: { orientation: 'h', yanchor: 'bottom', y: 1.02, xanchor: 'left', x: 0 }
    };

    if (observable === 'state') {
      layout.yaxis = {
        ...layout.yaxis,
        tickmode: 'linear',
        tick0: 0,
        dtick: 1,
      };
    }

    Plotly.react(plotId, figData, layout, {
      responsive: true,
      displaylogo: false,
      toImageButtonOptions: {
        format: 'png',
        scale: PLOT_EXPORT_SCALE,
      },
    });

    const plotEl = document.getElementById(plotId);
    if (plotEl) {
      plotEl.title = String(plotTitleTooltip || '');
    }
    bindHoverSyncHandlers(plotEl);
    if (plotEl && Number.isFinite(hoverSyncTime) && typeof Plotly !== 'undefined') {
      try {
        Plotly.relayout(plotEl, { shapes: [buildHoverSyncShape(hoverSyncTime)] });
      } catch {
        // ignore relayout errors for plots that are rebuilding
      }
    }
  }

  async function renderAllPanelsCore() {
    for (let i = 0; i < state.panels.length; i++) {
      await renderPanelCore(i);
    }
  }

  function renderPanel(panelIndex) {
    return enqueueRender(() => renderPanelCore(panelIndex));
  }

  function renderAllPanels() {
    return enqueueRender(async () => {
      await renderAllPanelsCore();
      if (state.selectedTraj === 'all') {
        setGlobalStatus('All auto compute complete.');
      }
    });
  }

  root.plot = {
    renderPanel,
    renderAllPanels,
    bindHoverSyncHandlers,
  };
})();
