(function () {
const root = window.ObservableDashboard || (window.ObservableDashboard = {});
const shared = root.shared;
const math3d = window.ObservableDashboardMath;
if (!shared || !math3d) return;

const { state, trajectories, trajIds, requiredIndexCount } = shared;
const { distance3, angleDeg, dihedralDeg, unwrapDegrees } = math3d;

const PLOT_EXPORT_DPI = 300;
const CSS_BASE_DPI = 96;
const PLOT_EXPORT_SCALE = PLOT_EXPORT_DPI / CSS_BASE_DPI;
const HOVER_SYNC_CLEAR_DELAY_MS = 80;
const HOVER_SYNC_LINE_STYLE = { color: 'rgba(80,80,80,0.35)', width: 1 };

let hoverSyncTime = null;
let hoverSyncClearTimer = null;
let hoverSyncRaf = 0;
let hoverSyncPendingTime = null;

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

function quantile(sortedArr, p) {
  if (!sortedArr.length) return NaN;
  if (sortedArr.length === 1) return sortedArr[0];
  const pos = (sortedArr.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedArr[lo];
  const w = pos - lo;
  return sortedArr[lo] * (1 - w) + sortedArr[hi] * w;
}

function computeQuantiles(seriesList) {
  const timeMap = new Map();
  for (const series of seriesList) {
    const n = Math.min(series.time.length, series.value.length);
    for (let i = 0; i < n; i++) {
      const t = Number(series.time[i]);
      const y = Number(series.value[i]);
      if (!Number.isFinite(t) || !Number.isFinite(y)) continue;
      const key = t.toFixed(8);
      if (!timeMap.has(key)) {
        timeMap.set(key, { t: t, vals: [] });
      }
      timeMap.get(key).vals.push(y);
    }
  }

  const items = Array.from(timeMap.values()).sort((a, b) => a.t - b.t);
  const out = { time: [], q25: [], q50: [], q75: [] };
  for (const item of items) {
    if (!item.vals.length) continue;
    const vals = item.vals.slice().sort((a, b) => a - b);
    out.time.push(item.t);
    out.q25.push(quantile(vals, 0.25));
    out.q50.push(quantile(vals, 0.50));
    out.q75.push(quantile(vals, 0.75));
  }
  return out;
}

function computeMeanSeries(seriesList) {
  const timeMap = new Map();
  for (const series of seriesList) {
    const n = Math.min(series.time.length, series.value.length);
    for (let i = 0; i < n; i++) {
      const t = Number(series.time[i]);
      const y = Number(series.value[i]);
      if (!Number.isFinite(t) || !Number.isFinite(y)) continue;
      const key = t.toFixed(8);
      if (!timeMap.has(key)) {
        timeMap.set(key, { t: t, sum: 0, count: 0 });
      }
      const item = timeMap.get(key);
      item.sum += y;
      item.count += 1;
    }
  }

  const items = Array.from(timeMap.values()).sort((a, b) => a.t - b.t);
  const out = { time: [], mean: [] };
  for (const item of items) {
    if (!item.count) continue;
    out.time.push(item.t);
    out.mean.push(item.sum / item.count);
  }
  return out;
}

function getSelectedTrajIds() {
  if (state.selectedTraj === 'all') return trajIds.slice();
  return trajectories[state.selectedTraj] ? [state.selectedTraj] : [];
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
  if (observable === 'state') return 'State index (argmax |c|²)';
  if (observable === '|c|^2') return '|c_i|^2';
  if (observable === 'eig') return 'eig';
  if (observable === 'nac') return 'NAC norm';
  return observable;
}

function buildScalarSeries(trajId, observable, indices) {
  const rec = trajectories[trajId];
  if (!rec) return null;

  if (observable === 'bond' || observable === 'angle' || observable === 'dihedral') {
    const time = rec.time || [];
    const coords = rec.coords || [];
    if (!time.length || !coords.length) return null;

    const nAtoms = rec.n_atoms || (coords[0] ? coords[0].length : 0);
    const maxIdx = Math.max(...indices);
    if (maxIdx >= nAtoms || Math.min(...indices) < 0) {
      return { error: `Atom index out of bounds (0-${nAtoms - 1})` };
    }

    const n = Math.min(time.length, coords.length);
    const values = [];
    const outTime = [];
    for (let i = 0; i < n; i++) {
      const frame = coords[i];
      if (observable === 'bond') {
        values.push(distance3(frame[indices[0]], frame[indices[1]]));
      } else if (observable === 'angle') {
        values.push(angleDeg(frame[indices[0]], frame[indices[1]], frame[indices[2]]));
      } else {
        values.push(dihedralDeg(frame[indices[0]], frame[indices[1]], frame[indices[2]], frame[indices[3]]));
      }
      outTime.push(time[i]);
    }

    if (observable === 'dihedral') {
      return { time: outTime, value: unwrapDegrees(values) };
    }
    return { time: outTime, value: values };
  }

  if (observable === 'etot') {
    if (!rec.etot_time || !rec.etot) return null;
    return { time: rec.etot_time, value: rec.etot };
  }

  if (observable === 'state') {
    if (!rec.state_time || !rec.state) return null;
    return { time: rec.state_time, value: rec.state };
  }

  if (observable === 'nac') {
    if (!rec.nac_time || !rec.nac_norm) return null;
    return { time: rec.nac_time, value: rec.nac_norm };
  }

  return null;
}

function buildEigSeries(trajId) {
  const rec = trajectories[trajId];
  if (!rec || !rec.eig_time || !rec.eig) return null;
  return { time: rec.eig_time, values: rec.eig };
}

function buildCProbSeries(trajId) {
  const rec = trajectories[trajId];
  if (!rec || !rec.c_prob_time || !rec.c_prob) return null;
  return { time: rec.c_prob_time, values: rec.c_prob };
}

function stateColor(stateIndex) {
  const palette = ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd'];
  return palette[stateIndex % palette.length];
}

function trajHoverLabel(trajId) {
  return String(trajId);
}

function addAllModeScalar(figData, seriesList, namePrefix, lineColor) {
  const drawTraces = state.showAllTraces || !state.showEnsemble;
  if (drawTraces) {
    for (const series of seriesList) {
      const trajLabel = trajHoverLabel(series.traj_id);
      figData.push({
        x: series.time,
        y: series.value,
        type: 'scatter',
        mode: 'lines',
        line: { color: 'rgba(120,120,120,0.35)', width: 1 },
        name: `${namePrefix} traj ${series.traj_id}`,
        showlegend: false,
        hovertemplate: `${trajLabel}<br>t=%{x:.4f}<br>y=%{y:.6f}<extra></extra>`
      });
    }
  }

  if (state.showEnsemble) {
    const q = computeQuantiles(seriesList);
    if (q.time.length) {
      figData.push({
        x: q.time,
        y: q.q75,
        type: 'scatter',
        mode: 'lines',
        line: { color: lineColor, width: 0 },
        name: `${namePrefix} q75`,
        showlegend: false,
        hoverinfo: 'skip'
      });
      figData.push({
        x: q.time,
        y: q.q25,
        type: 'scatter',
        mode: 'lines',
        fill: 'tonexty',
        fillcolor: 'rgba(31,119,180,0.18)',
        line: { color: lineColor, width: 0 },
        name: `${namePrefix} q25-q75`,
        showlegend: true,
        hovertemplate: 't=%{x:.4f}<br>q25=%{y:.6f}<extra></extra>'
      });
      figData.push({
        x: q.time,
        y: q.q50,
        type: 'scatter',
        mode: 'lines',
        line: { color: lineColor, width: 2.5 },
        name: `${namePrefix} median`,
        showlegend: true,
        hovertemplate: 't=%{x:.4f}<br>median=%{y:.6f}<extra></extra>'
      });
    }
  }
}

function addAllModeEig(figData, eigSeriesList) {
  const stateCount = Math.max(...eigSeriesList.map((s) => (s.values[0] ? s.values[0].length : 0)), 0);
  const drawTraces = state.showAllTraces || !state.showEnsemble;

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

    if (!scalarSeries.length) continue;

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
      const q = computeQuantiles(scalarSeries);
      if (q.time.length) {
        figData.push({
          x: q.time,
          y: q.q75,
          type: 'scatter',
          mode: 'lines',
          line: { color: color, width: 0 },
          name: `eig state ${s} q75`,
          showlegend: false,
          hoverinfo: 'skip'
        });
        figData.push({
          x: q.time,
          y: q.q25,
          type: 'scatter',
          mode: 'lines',
          fill: 'tonexty',
          fillcolor: 'rgba(0,0,0,0.08)',
          line: { color: color, width: 0 },
          name: `eig state ${s} q25-q75`,
          showlegend: true,
          hovertemplate: 't=%{x:.4f}<br>q25=%{y:.6f}<extra></extra>'
        });
        figData.push({
          x: q.time,
          y: q.q50,
          type: 'scatter',
          mode: 'lines',
          line: { color: color, width: 2.5 },
          name: `eig state ${s} median`,
          showlegend: true,
          hovertemplate: 't=%{x:.4f}<br>median=%{y:.6f}<extra></extra>'
        });
      }
    }
  }
}

function addAllModeCProb(figData, cProbSeriesList) {
  const componentCount = Math.max(...cProbSeriesList.map((s) => (s.values[0] ? s.values[0].length : 0)), 0);
  const drawTraces = state.showAllTraces || !state.showEnsemble;

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

    if (!scalarSeries.length) continue;

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
      const q = computeQuantiles(scalarSeries);
      if (q.time.length) {
        figData.push({
          x: q.time,
          y: q.q75,
          type: 'scatter',
          mode: 'lines',
          line: { color: color, width: 0 },
          name: `|c|^2 component ${component} q75`,
          showlegend: false,
          hoverinfo: 'skip'
        });
        figData.push({
          x: q.time,
          y: q.q25,
          type: 'scatter',
          mode: 'lines',
          fill: 'tonexty',
          fillcolor: 'rgba(0,0,0,0.08)',
          line: { color: color, width: 0 },
          name: `|c|^2 component ${component} q25-q75`,
          showlegend: true,
          hovertemplate: 't=%{x:.4f}<br>q25=%{y:.6f}<extra></extra>'
        });
        figData.push({
          x: q.time,
          y: q.q50,
          type: 'scatter',
          mode: 'lines',
          line: { color: color, width: 2.5 },
          name: `|c|^2 component ${component} median`,
          showlegend: true,
          hovertemplate: 't=%{x:.4f}<br>median=%{y:.6f}<extra></extra>'
        });
      }
    }
  }
}

function renderPanel(panelIndex) {
  panelMessage(panelIndex, '');

  const panelState = state.panels[panelIndex];
  if (!panelState) return;

  const observable = panelState.observable;
  const needed = requiredIndexCount(observable);
  const plotId = `plot-${panelIndex}`;

  let indices = [];
  if (needed > 0) {
    const parsed = parsePanelIndices(panelIndex);
    if (!parsed) {
      panelMessage(panelIndex, 'Indices must be integers.');
      Plotly.purge(plotId);
      return;
    }
    indices = parsed;
    panelState.indices = parsed.slice();
  } else {
    panelState.indices = [];
  }

  const selectedIds = getSelectedTrajIds();
  if (!selectedIds.length) {
    panelMessage(panelIndex, 'No trajectory available.');
    Plotly.purge(plotId);
    return;
  }

  const figData = [];
  const yLabel = panelYLabel(observable);
  let title = observable;
  if (needed > 0) {
    title = `${observable} (${indices.join('-')})`;
  }

  if (observable === 'state') {
    const stateSeries = [];
    for (const trajId of selectedIds) {
      const series = buildScalarSeries(trajId, 'state', []);
      if (!series) continue;
      if (series.error) {
        panelMessage(panelIndex, series.error);
        continue;
      }
      stateSeries.push({ traj_id: trajId, time: series.time, value: series.value });
    }

    if (!stateSeries.length) {
      if (!document.getElementById(`msg-${panelIndex}`)?.textContent) {
        panelMessage(panelIndex, 'No state data for selection.');
      }
      Plotly.purge(plotId);
      return;
    }

    if (state.selectedTraj === 'all') {
      const drawTraces = state.showAllTraces || !state.showEnsemble;

      if (drawTraces) {
        for (const series of stateSeries) {
          const trajLabel = trajHoverLabel(series.traj_id);
          figData.push({
            x: series.time,
            y: series.value,
            type: 'scatter',
            mode: 'lines',
            line: { color: 'rgba(214,39,40,0.28)', width: 1.1, shape: 'hv' },
            name: `state traj ${series.traj_id}`,
            showlegend: false,
            hovertemplate: `${trajLabel}<br>t=%{x:.4f}<br>state=%{y:.0f}<extra></extra>`
          });
        }
      }

      if (state.showEnsemble) {
        const meanSeries = computeMeanSeries(stateSeries);
        if (meanSeries.time.length) {
          figData.push({
            x: meanSeries.time,
            y: meanSeries.mean,
            type: 'scatter',
            mode: 'lines',
            line: { color: '#d62728', width: 2.5, shape: 'hv' },
            name: 'state mean (all trajectories)',
            showlegend: true,
            hovertemplate: 't=%{x:.4f}<br>mean state=%{y:.3f}<extra></extra>'
          });
        }
      }
    } else {
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
      const eigSeriesList = [];
      for (const trajId of selectedIds) {
        const series = buildEigSeries(trajId);
        if (!series) continue;
        eigSeriesList.push({ traj_id: trajId, time: series.time, values: series.values });
      }

      if (!eigSeriesList.length) {
        panelMessage(panelIndex, 'No eig data for selected trajectory set.');
        Plotly.purge(plotId);
        return;
      }

      addAllModeEig(figData, eigSeriesList);
    } else {
      const series = buildEigSeries(selectedIds[0]);
      if (!series || !series.values.length) {
        panelMessage(panelIndex, 'No eig data for selected trajectory.');
        Plotly.purge(plotId);
        return;
      }

      const nStates = Array.isArray(series.values[0]) ? series.values[0].length : 0;
      if (!nStates) {
        panelMessage(panelIndex, 'No eig states available.');
        Plotly.purge(plotId);
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
      const cProbSeriesList = [];
      for (const trajId of selectedIds) {
        const series = buildCProbSeries(trajId);
        if (!series) continue;
        cProbSeriesList.push({ traj_id: trajId, time: series.time, values: series.values });
      }

      if (!cProbSeriesList.length) {
        panelMessage(panelIndex, 'No |c|^2 data for selected trajectory set.');
        Plotly.purge(plotId);
        return;
      }

      addAllModeCProb(figData, cProbSeriesList);
    } else {
      const series = buildCProbSeries(selectedIds[0]);
      if (!series || !series.values.length) {
        panelMessage(panelIndex, 'No |c|^2 data for selected trajectory.');
        Plotly.purge(plotId);
        return;
      }

      const nComponents = Array.isArray(series.values[0]) ? series.values[0].length : 0;
      if (!nComponents) {
        panelMessage(panelIndex, 'No |c|^2 components available.');
        Plotly.purge(plotId);
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
        Plotly.purge(plotId);
        return;
      }
    }
  } else {
    const scalarSeries = [];
    for (const trajId of selectedIds) {
      const series = buildScalarSeries(trajId, observable, indices);
      if (!series) continue;
      if (series.error) {
        panelMessage(panelIndex, series.error);
        continue;
      }
      scalarSeries.push({ traj_id: trajId, time: series.time, value: series.value });
    }

    if (!scalarSeries.length) {
      if (!document.getElementById(`msg-${panelIndex}`)?.textContent) {
        panelMessage(panelIndex, `No ${observable} data for selection.`);
      }
      Plotly.purge(plotId);
      return;
    }

    if (state.selectedTraj === 'all') {
      addAllModeScalar(figData, scalarSeries, observable, '#1f77b4');
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
  bindHoverSyncHandlers(plotEl);
  if (plotEl && Number.isFinite(hoverSyncTime) && typeof Plotly !== 'undefined') {
    try {
      Plotly.relayout(plotEl, { shapes: [buildHoverSyncShape(hoverSyncTime)] });
    } catch {
      // ignore relayout errors for plots that are rebuilding
    }
  }
}

function renderAllPanels() {
  for (let i = 0; i < state.panels.length; i++) {
    renderPanel(i);
  }
}

root.plot = {
  renderPanel,
  renderAllPanels,
  bindHoverSyncHandlers,
};
})();
