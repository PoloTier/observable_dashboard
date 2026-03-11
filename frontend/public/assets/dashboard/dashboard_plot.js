(function () {
  const root = window.ObservableDashboard || (window.ObservableDashboard = {});
  const shared = root.shared;
  const dataLoader = root.dataLoader;
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
  const TAR_BLOCK_SIZE = 512;
  const PANEL_DATA_BUNDLE_KIND = 'observable_dashboard_panel_data_bundle';
  const PANEL_DATA_BUNDLE_SCHEMA_VERSION = 1;
  const textEncoder = new TextEncoder();

  let hoverSyncTime = null;
  let hoverSyncClearTimer = null;
  let hoverSyncRaf = 0;
  let hoverSyncPendingTime = null;
  let renderQueue = Promise.resolve();

  function getAppearanceModule() {
    return window.ObservableAppearance || null;
  }

  function getPlotThemeColors() {
    const appearance = getAppearanceModule();
    if (appearance && typeof appearance.getPlotColors === 'function') {
      return appearance.getPlotColors();
    }
    return {
      hoverSyncLineColor: 'rgba(80,80,80,0.35)',
      traceMutedColor: 'rgba(120,120,120,0.35)',
      neutralFillColor: 'rgba(0,0,0,0.08)',
      accentFillColor: 'rgba(31,119,180,0.18)',
      dangerFillColor: 'rgba(214,39,40,0.18)',
    };
  }

  function mergePlotlyLayout(baseLayout) {
    const appearance = getAppearanceModule();
    if (!appearance || typeof appearance.getPlotlyLayoutPatch !== 'function') {
      return baseLayout;
    }

    const patch = appearance.getPlotlyLayoutPatch();
    return {
      ...patch,
      ...baseLayout,
      font: {
        ...(patch.font || {}),
        ...(baseLayout.font || {}),
      },
      title: {
        ...(patch.title || {}),
        ...(baseLayout.title || {}),
        font: {
          ...((patch.title && patch.title.font) || {}),
          ...((baseLayout.title && baseLayout.title.font) || {}),
        },
      },
      xaxis: {
        ...(patch.xaxis || {}),
        ...(baseLayout.xaxis || {}),
      },
      yaxis: {
        ...(patch.yaxis || {}),
        ...(baseLayout.yaxis || {}),
      },
      legend: {
        ...(patch.legend || {}),
        ...(baseLayout.legend || {}),
        font: {
          ...((patch.legend && patch.legend.font) || {}),
          ...((baseLayout.legend && baseLayout.legend.font) || {}),
        },
      },
      hoverlabel: {
        ...(patch.hoverlabel || {}),
        ...(baseLayout.hoverlabel || {}),
        font: {
          ...((patch.hoverlabel && patch.hoverlabel.font) || {}),
          ...((baseLayout.hoverlabel && baseLayout.hoverlabel.font) || {}),
        },
      },
    };
  }

  function enqueueRender(task) {
    renderQueue = renderQueue.then(task, task);
    return renderQueue;
  }

  function buildHoverSyncShape(t) {
    const plotThemeColors = getPlotThemeColors();
    return {
      type: 'line',
      x0: t,
      x1: t,
      yref: 'paper',
      y0: 0,
      y1: 1,
      line: { color: plotThemeColors.hoverSyncLineColor, width: 1 },
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
    const mode = String(panelState?.ensembleStatMode);
    if (mode === 'median_iqr' || mode === 'renorm_mean_ci95_bootstrap') return mode;
    return 'mean_ci95_bootstrap';
  }

  function ensembleCenterName(statMode) {
    if (statMode === 'renorm_mean_ci95_bootstrap') return 'renorm mean';
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

  function sanitizeFilenamePart(text, fallback = 'panel') {
    const raw = String(text || '').trim().toLowerCase();
    const cleaned = raw
      .replace(/[^a-z0-9._-]+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '');
    if (!cleaned) return fallback;
    return cleaned.slice(0, 64);
  }

  function toFiniteOrNaN(rawValue) {
    if (rawValue == null) return NaN;
    const number = Number(rawValue);
    return Number.isFinite(number) ? number : NaN;
  }

  function numberToken(value) {
    if (!Number.isFinite(value)) return 'nan';
    if (Object.is(value, -0)) return '0';
    return String(value);
  }

  function encodeUtf8(text) {
    return textEncoder.encode(String(text || ''));
  }

  function writeTarString(header, offset, length, text) {
    const bytes = encodeUtf8(text);
    if (bytes.length > length) {
      throw new Error(`Archive entry name is too long: ${text}`);
    }
    header.set(bytes, offset);
  }

  function writeTarOctal(header, offset, length, value) {
    const normalized = Math.max(0, Math.floor(Number(value) || 0));
    const octal = normalized.toString(8);
    if (octal.length > length - 1) {
      throw new Error(`Archive field is too large: ${normalized}`);
    }
    const padded = octal.padStart(length - 1, '0');
    writeTarString(header, offset, length - 1, padded);
    header[offset + length - 1] = 0;
  }

  function writeTarChecksum(header, checksum) {
    const octal = Math.max(0, Math.floor(checksum)).toString(8).padStart(6, '0');
    writeTarString(header, 148, 6, octal);
    header[154] = 0;
    header[155] = 32;
  }

  function makeTarHeader(name, size, modifiedAt) {
    const header = new Uint8Array(TAR_BLOCK_SIZE);
    const seconds = Math.max(
      0,
      Math.floor((modifiedAt instanceof Date ? modifiedAt : new Date(modifiedAt || Date.now())).getTime() / 1000)
    );
    writeTarString(header, 0, 100, name);
    writeTarOctal(header, 100, 8, 0o644);
    writeTarOctal(header, 108, 8, 0);
    writeTarOctal(header, 116, 8, 0);
    writeTarOctal(header, 124, 12, size);
    writeTarOctal(header, 136, 12, seconds);
    header.fill(32, 148, 156);
    header[156] = 48;
    writeTarString(header, 257, 6, 'ustar');
    writeTarString(header, 263, 2, '00');
    writeTarString(header, 265, 4, 'root');
    writeTarString(header, 297, 4, 'root');
    let checksum = 0;
    for (let i = 0; i < header.length; i++) {
      checksum += header[i];
    }
    writeTarChecksum(header, checksum);
    return header;
  }

  function normalizeArchiveFiles(files) {
    return files.map((file, index) => {
      const name = String(file?.name || '').trim();
      if (!name) {
        throw new Error(`Archive entry ${index + 1} is missing a file name.`);
      }
      const bytes = file?.bytes instanceof Uint8Array
        ? file.bytes
        : encodeUtf8(file?.text || '');
      if (encodeUtf8(name).length > 100) {
        throw new Error(`Archive entry name exceeds tar limit: ${name}`);
      }
      return {
        name,
        bytes,
        modifiedAt: file?.modifiedAt instanceof Date ? file.modifiedAt : new Date(file?.modifiedAt || Date.now()),
      };
    });
  }

  function buildTarArchiveBlob(files) {
    const normalizedFiles = normalizeArchiveFiles(files);
    const parts = [];
    for (const file of normalizedFiles) {
      const header = makeTarHeader(file.name, file.bytes.length, file.modifiedAt);
      parts.push(header, file.bytes);
      const remainder = file.bytes.length % TAR_BLOCK_SIZE;
      if (remainder > 0) {
        parts.push(new Uint8Array(TAR_BLOCK_SIZE - remainder));
      }
    }
    parts.push(new Uint8Array(TAR_BLOCK_SIZE * 2));
    return new Blob(parts, { type: 'application/x-tar' });
  }

  async function gzipTarBlob(tarBlob) {
    if (typeof CompressionStream !== 'function') {
      throw new Error('TAR.GZ export is unavailable in this browser.');
    }
    const compressedStream = tarBlob.stream().pipeThrough(new CompressionStream('gzip'));
    return await new Response(compressedStream).blob();
  }

  function splitFilenameExtension(fileName) {
    const text = String(fileName || '');
    const lastDot = text.lastIndexOf('.');
    if (lastDot <= 0) {
      return { base: text, ext: '' };
    }
    return {
      base: text.slice(0, lastDot),
      ext: text.slice(lastDot),
    };
  }

  function makeUniqueArchiveFileNames(fileNames) {
    const used = new Set();
    return fileNames.map((fileName) => {
      const original = String(fileName || '').trim();
      if (!used.has(original)) {
        used.add(original);
        return original;
      }
      const { base, ext } = splitFilenameExtension(original);
      let suffix = 2;
      while (true) {
        const candidate = `${base}_${suffix}${ext}`;
        if (!used.has(candidate)) {
          used.add(candidate);
          return candidate;
        }
        suffix += 1;
      }
    });
  }

  function deduceMatrixComponentCount(seriesRecord) {
    const preferred = Number(seriesRecord?.n_components);
    if (Number.isFinite(preferred) && preferred > 0) return Math.trunc(preferred);
    const rows = Array.isArray(seriesRecord?.values) ? seriesRecord.values : [];
    let maxComponents = 0;
    for (const row of rows) {
      if (!Array.isArray(row)) continue;
      if (row.length > maxComponents) maxComponents = row.length;
    }
    return maxComponents;
  }

  async function getBuiltinSeriesRecord(trajId, observable, indices) {
    await dataLoader.ensureSeries(trajId, observable, indices);
    const record = dataLoader.getSeries(trajId, observable, indices);
    if (!record) {
      throw new Error(`No series data for observable '${observable}' on traj '${trajId}'.`);
    }
    const seriesKind = record.series_kind === 'matrix' ? 'matrix' : 'scalar';
    if (seriesKind === 'matrix') {
      return {
        series_kind: 'matrix',
        time: Array.isArray(record.time) ? record.time : [],
        values: Array.isArray(record.values) ? record.values : [],
        n_components: Number.isFinite(Number(record.n_components)) ? Number(record.n_components) : 0,
      };
    }
    return {
      series_kind: 'scalar',
      time: Array.isArray(record.time) ? record.time : [],
      value: Array.isArray(record.value) ? record.value : [],
      n_components: 1,
    };
  }

  async function getExpressionExportSeriesRecord(trajId, expressionText) {
    const record = await getExpressionSeriesRecord(trajId, expressionText, true);
    if (!record) {
      throw new Error(`No expression data for traj '${trajId}'.`);
    }
    if (record.series_kind === 'matrix') {
      return {
        series_kind: 'matrix',
        time: Array.isArray(record.time) ? record.time : [],
        values: Array.isArray(record.values) ? record.values : [],
        n_components: Number.isFinite(Number(record.n_components)) ? Number(record.n_components) : 0,
      };
    }
    return {
      series_kind: 'scalar',
      time: Array.isArray(record.time) ? record.time : [],
      value: Array.isArray(record.value) ? record.value : [],
      n_components: 1,
    };
  }

  async function getExportSeriesRecordForTraj({ trajId, observable, indices, rawKey, expressionText }) {
    if (observable === 'raw_key') {
      const record = await getRawKeySeriesRecord(trajId, rawKey, true);
      if (!record) {
        throw new Error(`No raw key data for '${rawKey}' on traj '${trajId}'.`);
      }
      return record;
    }
    if (observable === 'expression') {
      return getExpressionExportSeriesRecord(trajId, expressionText);
    }
    return getBuiltinSeriesRecord(trajId, observable, indices);
  }

  function triggerBlobDownload(fileName, blob) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  }

  function triggerTextDownload(fileName, textContent) {
    const blob = new Blob([textContent], { type: 'text/plain;charset=utf-8' });
    triggerBlobDownload(fileName, blob);
  }

  async function buildPanelExportPayload(panelIndex) {
    const panelState = state.panels[panelIndex];
    if (!panelState) {
      throw new Error(`Panel ${panelIndex + 1} does not exist.`);
    }

    const panelObservable = String(panelState.observable || '');
    const observable = canonicalObservable(panelObservable);
    const rawAlias = rawAliasFromObservable(panelObservable);
    const needed = requiredIndexCount(panelObservable);
    let indices = [];

    if (needed > 0) {
      const parsed = parsePanelIndices(panelIndex);
      if (!parsed) {
        throw new Error('Indices must be integers.');
      }
      indices = parsed;
      panelState.indices = parsed.slice();
    } else {
      panelState.indices = [];
    }

    const rawKey = observable === 'raw_key' ? resolveRawKeyForPanel(panelState, state.rawKeyAliases) : '';
    const rawName = String(rawAlias || rawKey || 'raw_key').trim();
    const expressionText = observable === 'expression' ? String(panelState.expression || '').trim() : '';

    if (observable === 'raw_key' && !rawKey) {
      throw new Error('Raw key is empty. Set it from PKL Key Inspector first.');
    }
    if (observable === 'expression' && !expressionText) {
      throw new Error('Expression is empty.');
    }

    const orderedTrajIds = trajIds.slice();
    if (!orderedTrajIds.length) {
      throw new Error('No trajectory available for export.');
    }

    const seriesByTraj = [];
    for (const trajId of orderedTrajIds) {
      const record = await getExportSeriesRecordForTraj({
        trajId,
        observable,
        indices,
        rawKey,
        expressionText,
      });
      seriesByTraj.push(record);
    }

    const componentCounts = seriesByTraj.map((record) => {
      if (record?.series_kind !== 'matrix') return 1;
      return deduceMatrixComponentCount(record);
    });

    const timeSet = new Set();
    for (const record of seriesByTraj) {
      const timeValues = Array.isArray(record?.time) ? record.time : [];
      for (const rawTime of timeValues) {
        const t = Number(rawTime);
        if (!Number.isFinite(t)) continue;
        timeSet.add(t);
      }
    }
    const sortedTimes = Array.from(timeSet).sort((a, b) => a - b);
    if (!sortedTimes.length) {
      throw new Error('No data points available for export.');
    }

    const scalarMaps = [];
    const matrixMaps = [];
    for (const record of seriesByTraj) {
      const timeValues = Array.isArray(record?.time) ? record.time : [];
      if (record?.series_kind === 'matrix') {
        const values = Array.isArray(record?.values) ? record.values : [];
        const map = new Map();
        const n = Math.min(timeValues.length, values.length);
        for (let i = 0; i < n; i++) {
          const t = Number(timeValues[i]);
          if (!Number.isFinite(t)) continue;
          const row = Array.isArray(values[i]) ? values[i] : [];
          map.set(t, row.map((item) => toFiniteOrNaN(item)));
        }
        scalarMaps.push(null);
        matrixMaps.push(map);
      } else {
        const values = Array.isArray(record?.value) ? record.value : [];
        const map = new Map();
        const n = Math.min(timeValues.length, values.length);
        for (let i = 0; i < n; i++) {
          const t = Number(timeValues[i]);
          if (!Number.isFinite(t)) continue;
          map.set(t, toFiniteOrNaN(values[i]));
        }
        scalarMaps.push(map);
        matrixMaps.push(null);
      }
    }

    const header = ['time'];
    for (let trajIndex = 0; trajIndex < orderedTrajIds.length; trajIndex++) {
      const componentCount = Math.max(0, Number(componentCounts[trajIndex]) || 0);
      for (let component = 0; component < componentCount; component++) {
        header.push(`${trajIndex}-${component}`);
      }
    }

    const lines = [header.join(' ')];
    for (const t of sortedTimes) {
      const row = [numberToken(t)];
      for (let trajIndex = 0; trajIndex < orderedTrajIds.length; trajIndex++) {
        const componentCount = Math.max(0, Number(componentCounts[trajIndex]) || 0);
        if (!componentCount) continue;
        const record = seriesByTraj[trajIndex];
        if (record?.series_kind === 'matrix') {
          const valueRow = matrixMaps[trajIndex]?.get(t) || null;
          for (let component = 0; component < componentCount; component++) {
            const value = Array.isArray(valueRow) && component < valueRow.length
              ? toFiniteOrNaN(valueRow[component])
              : NaN;
            row.push(numberToken(value));
          }
        } else {
          const value = scalarMaps[trajIndex]?.get(t);
          row.push(numberToken(toFiniteOrNaN(value)));
          for (let component = 1; component < componentCount; component++) {
            row.push('nan');
          }
        }
      }
      lines.push(row.join(' '));
    }

    const namePart = (() => {
      if (observable === 'expression') {
        const label = String(panelState.expressionLabel || '').trim();
        return sanitizeFilenamePart(label || expressionText || 'expression', 'expression');
      }
      if (observable === 'raw_key') {
        return sanitizeFilenamePart(rawName || 'raw_key', 'raw_key');
      }
      const withIndices = needed > 0 ? `${observable}_${indices.join('-')}` : observable;
      return sanitizeFilenamePart(withIndices || 'panel', 'panel');
    })();

    return {
      panelIndex,
      observable,
      indices: indices.slice(),
      raw_key: rawKey || null,
      expression: expressionText || null,
      fileName: `${namePart}_all_traj.txt`,
      textContent: `${lines.join('\n')}\n`,
      rowCount: sortedTimes.length,
      columnCount: header.length,
    };
  }

  async function exportPanelData(panelIndex) {
    panelMessage(panelIndex, '');
    setGlobalStatus(`Exporting panel ${panelIndex + 1} data...`);
    try {
      const payload = await buildPanelExportPayload(panelIndex);
      triggerTextDownload(payload.fileName, payload.textContent);
      setGlobalStatus(
        `Exported panel ${panelIndex + 1}: ${payload.fileName} (${payload.rowCount} rows, ${payload.columnCount} cols).`
      );
      return payload;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      panelMessage(panelIndex, detail);
      setGlobalStatus(`Export failed (Panel ${panelIndex + 1}): ${detail}`, true);
      throw error;
    }
  }

  async function exportAllPanelsDataTarGz() {
    const totalPanels = Array.isArray(state.panels) ? state.panels.length : 0;
    if (!totalPanels) {
      throw new Error('No panels available for export.');
    }

    for (let panelIndex = 0; panelIndex < totalPanels; panelIndex++) {
      panelMessage(panelIndex, '');
    }

    setGlobalStatus(`Exporting all panel data: 0/${totalPanels}`);
    try {
      const payloads = [];
      for (let panelIndex = 0; panelIndex < totalPanels; panelIndex++) {
        try {
          const payload = await buildPanelExportPayload(panelIndex);
          payloads.push(payload);
          setGlobalStatus(`Exporting all panel data: ${panelIndex + 1}/${totalPanels}`);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          panelMessage(panelIndex, detail);
          throw new Error(`Panel ${panelIndex + 1}: ${detail}`);
        }
      }

      const exportedAt = new Date();
      const archiveFileNames = makeUniqueArchiveFileNames(payloads.map((payload) => payload.fileName));
      const manifest = {
        kind: PANEL_DATA_BUNDLE_KIND,
        schema_version: PANEL_DATA_BUNDLE_SCHEMA_VERSION,
        exported_at: exportedAt.toISOString(),
        archive_format: 'tar.gz',
        panel_count: totalPanels,
        files: payloads.map((payload, idx) => ({
          panel_index: payload.panelIndex + 1,
          observable: payload.observable,
          indices: payload.indices,
          raw_key: payload.raw_key,
          expression: payload.expression,
          original_file_name: payload.fileName,
          archive_file_name: archiveFileNames[idx],
          row_count: payload.rowCount,
          column_count: payload.columnCount,
        })),
      };
      const files = [
        {
          name: 'manifest.json',
          text: `${JSON.stringify(manifest, null, 2)}\n`,
          modifiedAt: exportedAt,
        },
        ...payloads.map((payload, idx) => ({
          name: archiveFileNames[idx],
          text: payload.textContent,
          modifiedAt: exportedAt,
        })),
      ];
      const tarBlob = buildTarArchiveBlob(files);
      const tarGzBlob = await gzipTarBlob(tarBlob);
      const tarGzFileName = 'all_panels_data.tar.gz';
      triggerBlobDownload(tarGzFileName, tarGzBlob);
      setGlobalStatus(`Exported all panel data: ${tarGzFileName} (${totalPanels} panels).`);
      return {
        fileName: tarGzFileName,
        panelCount: totalPanels,
        fileCount: files.length,
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setGlobalStatus(`Export all failed: ${detail}`, true);
      throw error;
    }
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

  async function getExpressionEnsembleRecord(expression, statMode, allowFetch) {
    if (allowFetch) {
      await dataLoader.ensureExpressionEnsemble(expression, statMode);
    }
    const record = dataLoader.getExpressionEnsemble(expression, statMode);
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

  function enabledHoppingGroups() {
    const groups = Array.isArray(state?.hopping?.groups) ? state.hopping.groups : [];
    return groups.filter((group) => {
      if (!group || group.enabled === false) return false;
      const fromState = Number.parseInt(group.fromState, 10);
      const toState = Number.parseInt(group.toState, 10);
      return Number.isFinite(fromState) && Number.isFinite(toState) && fromState >= 0 && toState >= 0 && fromState !== toState;
    });
  }

  function hoppingTransitionKey(group) {
    return `${Number.parseInt(group?.fromState, 10)}->${Number.parseInt(group?.toState, 10)}`;
  }

  async function getHoppingEventsRecord(trajIds, allowFetch = true) {
    const groups = enabledHoppingGroups();
    if (!groups.length) return null;
    const normalizedTrajIds = Array.isArray(trajIds) ? trajIds.map((trajId) => String(trajId)) : [];
    const transitions = groups.map((group) => ({
      from_state: Number.parseInt(group.fromState, 10),
      to_state: Number.parseInt(group.toState, 10),
    }));
    if (allowFetch) {
      await dataLoader.ensureHoppingEvents(
        normalizedTrajIds,
        state?.hopping?.algorithm,
        state?.hopping?.timeRule,
        transitions
      );
    }
    return dataLoader.getHoppingEvents(
      normalizedTrajIds,
      state?.hopping?.algorithm,
      state?.hopping?.timeRule,
      transitions
    );
  }

  function interpolateScalarValue(timeValues, valueValues, targetTime) {
    const time = Array.isArray(timeValues) ? timeValues : [];
    const values = Array.isArray(valueValues) ? valueValues : [];
    const n = Math.min(time.length, values.length);
    if (!n) return NaN;

    let prevT = NaN;
    let prevY = NaN;
    let hasPrev = false;
    for (let i = 0; i < n; i++) {
      const t = Number(time[i]);
      const y = Number(values[i]);
      if (!Number.isFinite(t) || !Number.isFinite(y)) continue;
      if (Math.abs(t - targetTime) <= 1e-9) return y;
      if (t > targetTime) {
        if (hasPrev && Math.abs(t - prevT) > 1e-12) {
          const alpha = (targetTime - prevT) / (t - prevT);
          return prevY + ((y - prevY) * alpha);
        }
        return y;
      }
      prevT = t;
      prevY = y;
      hasPrev = true;
    }
    return hasPrev ? prevY : NaN;
  }

  function interpolateMatrixComponentValue(timeValues, matrixValues, componentIndex, targetTime) {
    const time = Array.isArray(timeValues) ? timeValues : [];
    const values = Array.isArray(matrixValues) ? matrixValues : [];
    const n = Math.min(time.length, values.length);
    if (!n || componentIndex < 0) return NaN;

    let prevT = NaN;
    let prevY = NaN;
    let hasPrev = false;
    for (let i = 0; i < n; i++) {
      const row = Array.isArray(values[i]) ? values[i] : null;
      if (!row || componentIndex >= row.length) continue;
      const t = Number(time[i]);
      const y = Number(row[componentIndex]);
      if (!Number.isFinite(t) || !Number.isFinite(y)) continue;
      if (Math.abs(t - targetTime) <= 1e-9) return y;
      if (t > targetTime) {
        if (hasPrev && Math.abs(t - prevT) > 1e-12) {
          const alpha = (targetTime - prevT) / (t - prevT);
          return prevY + ((y - prevY) * alpha);
        }
        return y;
      }
      prevT = t;
      prevY = y;
      hasPrev = true;
    }
    return hasPrev ? prevY : NaN;
  }

  function addScalarHoppingOverlay(figData, seriesList, hoppingRecord, groups) {
    const groupMap = new Map(groups.map((group) => [hoppingTransitionKey(group), group]));
    for (const group of groups) {
      const x = [];
      const y = [];
      const customdata = [];
      const transitionKey = hoppingTransitionKey(group);
      for (const series of seriesList) {
        const trajId = String(series?.traj_id || '');
        const events = Array.isArray(hoppingRecord?.events_by_traj?.[trajId]) ? hoppingRecord.events_by_traj[trajId] : [];
        for (const event of events) {
          if (String(event?.transition_key || '') !== transitionKey) continue;
          const eventTime = Number(event?.time);
          const eventY = interpolateScalarValue(series.time, series.value, eventTime);
          if (!Number.isFinite(eventTime) || !Number.isFinite(eventY)) continue;
          x.push(eventTime);
          y.push(eventY);
          customdata.push([trajId, transitionKey, Number(event?.frame_from) || 0, Number(event?.frame_to) || 0, 'series']);
        }
      }
      if (!x.length) continue;
      figData.push({
        x,
        y,
        customdata,
        type: 'scatter',
        mode: 'markers',
        marker: {
          color: groupMap.get(transitionKey)?.color || '#d62728',
          size: 9,
          symbol: 'diamond',
          line: { color: 'rgba(0,0,0,0.45)', width: 1 },
        },
        name: `hop ${transitionKey}`,
        legendgroup: `hop-${transitionKey}`,
        showlegend: true,
        hovertemplate: 'traj=%{customdata[0]}<br>hop=%{customdata[1]}<br>t=%{x:.4f}<br>y=%{y:.6f}<br>frames=%{customdata[2]}→%{customdata[3]}<extra></extra>',
      });
    }
  }

  function addMatrixHoppingOverlay(figData, seriesList, hoppingRecord, groups, options = {}) {
    const groupMap = new Map(groups.map((group) => [hoppingTransitionKey(group), group]));
    const componentStrategy = String(options?.componentStrategy || 'all_components');
    const componentLabels = Array.isArray(options?.componentLabels) ? options.componentLabels : null;
    const tracesByKey = new Map();
    const legendShown = new Set();

    function ensureTrace(traceKey, transitionKey, componentIndex, role) {
      if (tracesByKey.has(traceKey)) return tracesByKey.get(traceKey);
      const group = groupMap.get(transitionKey);
      const curveLabel = componentLabel(componentLabels, componentIndex);
      const roleSuffix = role === 'from'
        ? ` (from ${componentIndex})`
        : role === 'to'
          ? ` (to ${componentIndex})`
          : ` (${curveLabel})`;
      const trace = {
        x: [],
        y: [],
        customdata: [],
        type: 'scatter',
        mode: 'markers',
        marker: {
          color: group?.color || '#d62728',
          size: role === 'component' ? 7 : 9,
          symbol: role === 'from' ? 'diamond-open' : (role === 'to' ? 'diamond' : 'circle'),
          line: { color: 'rgba(0,0,0,0.45)', width: 1 },
        },
        name: `hop ${transitionKey}${roleSuffix}`,
        legendgroup: `hop-${transitionKey}`,
        showlegend: !legendShown.has(transitionKey),
        hovertemplate: 'traj=%{customdata[0]}<br>hop=%{customdata[1]}<br>curve=%{customdata[4]}<br>t=%{x:.4f}<br>y=%{y:.6f}<br>frames=%{customdata[2]}→%{customdata[3]}<extra></extra>',
      };
      legendShown.add(transitionKey);
      tracesByKey.set(traceKey, trace);
      return trace;
    }

    for (const series of seriesList) {
      const trajId = String(series?.traj_id || '');
      const events = Array.isArray(hoppingRecord?.events_by_traj?.[trajId]) ? hoppingRecord.events_by_traj[trajId] : [];
      const time = Array.isArray(series?.time) ? series.time : [];
      const values = Array.isArray(series?.values) ? series.values : [];
      let componentCount = 0;
      for (const row of values) {
        if (!Array.isArray(row)) continue;
        componentCount = Math.max(componentCount, row.length);
      }
      if (!componentCount) continue;

      for (const event of events) {
        const transitionKey = String(event?.transition_key || '');
        if (!groupMap.has(transitionKey)) continue;
        const eventTime = Number(event?.time);
        if (!Number.isFinite(eventTime)) continue;

        const componentSpecs = [];
        if (componentStrategy === 'state_pair') {
          componentSpecs.push({ index: Number(event?.from_state), role: 'from' });
          componentSpecs.push({ index: Number(event?.to_state), role: 'to' });
        } else {
          for (let componentIndex = 0; componentIndex < componentCount; componentIndex++) {
            componentSpecs.push({ index: componentIndex, role: 'component' });
          }
        }

        for (const componentSpec of componentSpecs) {
          const componentIndex = Number(componentSpec.index);
          if (!Number.isFinite(componentIndex) || componentIndex < 0 || componentIndex >= componentCount) continue;
          const eventY = interpolateMatrixComponentValue(time, values, componentIndex, eventTime);
          if (!Number.isFinite(eventY)) continue;
          const traceKey = `${transitionKey}::${componentIndex}::${componentSpec.role}`;
          const trace = ensureTrace(traceKey, transitionKey, componentIndex, componentSpec.role);
          trace.x.push(eventTime);
          trace.y.push(eventY);
          trace.customdata.push([
            trajId,
            transitionKey,
            Number(event?.frame_from) || 0,
            Number(event?.frame_to) || 0,
            componentLabel(componentLabels, componentIndex),
          ]);
        }
      }
    }

    for (const trace of tracesByKey.values()) {
      if (!Array.isArray(trace.x) || !trace.x.length) continue;
      figData.push(trace);
    }
  }

  async function applyHoppingOverlay(figData, context, trajIds) {
    if (!context || !Array.isArray(context?.seriesList) || !context.seriesList.length) return;
    const groups = enabledHoppingGroups();
    if (!groups.length) return;
    const record = await getHoppingEventsRecord(trajIds, true);
    if (!record) return;

    if (context.seriesKind === 'matrix') {
      addMatrixHoppingOverlay(figData, context.seriesList, record, groups, {
        componentStrategy: context.componentStrategy,
        componentLabels: context.componentLabels,
      });
      return;
    }
    addScalarHoppingOverlay(figData, context.seriesList, record, groups);
  }

  function addAllModeScalar(
    figData,
    seriesList,
    namePrefix,
    lineColor,
    ensembleRecord,
    statMode,
    { lineShape = null, fillColor = null, centerHoverLabel = 'y', forceDrawTraces = false } = {}
  ) {
    const plotThemeColors = getPlotThemeColors();
    const drawTraces = !!forceDrawTraces || state.showAllTraces || !state.showEnsemble;
    const shapePart = lineShape ? { shape: lineShape } : {};
    if (drawTraces) {
      for (const series of seriesList) {
        const trajLabel = trajHoverLabel(series.traj_id);
        figData.push({
          x: series.time,
          y: series.value,
          type: 'scatter',
          mode: 'lines',
          line: { color: plotThemeColors.traceMutedColor, width: 1, ...shapePart },
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
        fillColor: fillColor || plotThemeColors.accentFillColor,
        lineShape,
        centerHoverLabel,
      });
    }
  }

  function addAllModeEig(figData, eigSeriesList, ensembleRecord, statMode, options = {}) {
    const forceDrawTraces = !!options.forceDrawTraces;
    const traceStateCount = Math.max(...eigSeriesList.map((s) => (s.values[0] ? s.values[0].length : 0)), 0);
    const ensembleComponents = Array.isArray(ensembleRecord?.component_series) ? ensembleRecord.component_series : [];
    const ensembleStateCount = Math.max(
      ...ensembleComponents.map((s) => (Number.isFinite(Number(s?.component)) ? Number(s.component) + 1 : 0)),
      0
    );
    const stateCount = Math.max(traceStateCount, ensembleStateCount);
    const drawTraces = forceDrawTraces || state.showAllTraces || !state.showEnsemble;
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
        const plotThemeColors = getPlotThemeColors();
        addEnsembleBandAndCenter(figData, ensembleComp, {
          namePrefix: `eig state ${s}`,
          statMode,
          lineColor: color,
          fillColor: plotThemeColors.neutralFillColor,
        });
      }
    }
  }

  function addAllModeCProb(figData, cProbSeriesList, ensembleRecord, statMode, options = {}) {
    const forceDrawTraces = !!options.forceDrawTraces;
    const traceComponentCount = Math.max(...cProbSeriesList.map((s) => (s.values[0] ? s.values[0].length : 0)), 0);
    const ensembleComponents = Array.isArray(ensembleRecord?.component_series) ? ensembleRecord.component_series : [];
    const ensembleComponentCount = Math.max(
      ...ensembleComponents.map((s) => (Number.isFinite(Number(s?.component)) ? Number(s.component) + 1 : 0)),
      0
    );
    const componentCount = Math.max(traceComponentCount, ensembleComponentCount);
    const drawTraces = forceDrawTraces || state.showAllTraces || !state.showEnsemble;
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
        const plotThemeColors = getPlotThemeColors();
        addEnsembleBandAndCenter(figData, ensembleComp, {
          namePrefix: `|c|^2 component ${component}`,
          statMode,
          lineColor: color,
          fillColor: plotThemeColors.neutralFillColor,
          centerHoverLabel: '|c|^2',
        });
      }
    }
  }

  function addAllModeRawKeyMatrix(figData, matrixSeriesList, rawKey, componentLabels = null, ensembleRecord, statMode, options = {}) {
    const forceDrawTraces = !!options.forceDrawTraces;
    const traceComponentCount = Math.max(...matrixSeriesList.map((s) => (s.values[0] ? s.values[0].length : 0)), 0);
    const ensembleComponents = Array.isArray(ensembleRecord?.component_series) ? ensembleRecord.component_series : [];
    const ensembleComponentCount = Math.max(
      ...ensembleComponents.map((s) => (Number.isFinite(Number(s?.component)) ? Number(s.component) + 1 : 0)),
      0
    );
    const componentCount = Math.max(traceComponentCount, ensembleComponentCount);
    const drawTraces = forceDrawTraces || state.showAllTraces || !state.showEnsemble;
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
        const plotThemeColors = getPlotThemeColors();
        addEnsembleBandAndCenter(figData, ensembleComp, {
          namePrefix: `${rawKey} ${label}`,
          statMode,
          lineColor: color,
          fillColor: plotThemeColors.neutralFillColor,
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
    const hoppingOverlayEnabled = !!panelState.showHoppingOverlay && enabledHoppingGroups().length > 0;

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

    const drawAllTraces = state.selectedTraj === 'all' && (hoppingOverlayEnabled || state.showAllTraces || !state.showEnsemble);
    if (drawAllTraces && observable !== 'raw_key' && observable !== 'expression') {
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
    let hoppingOverlayContext = null;
    let yLabel = panelYLabel(observable);
    let title = observable;
    let plotTitleTooltip = '';
    const rawKey = observable === 'raw_key' ? resolveRawKeyForPanel(panelState, state.rawKeyAliases) : '';
    const rawName = String(rawAlias || rawKey || 'raw_key').trim();
    const expressionText = observable === 'expression' ? String(panelState.expression || '').trim() : '';
    const expressionLabel = observable === 'expression' ? String(panelState.expressionLabel || '').trim() : '';
    if (observable === 'expression') {
      const fullTitle = expressionLabel || expressionText || 'expression';
      title = truncateText(fullTitle, 120);
      plotTitleTooltip = fullTitle;
      yLabel = expressionText || 'expression';
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
          const drawTraces = hoppingOverlayEnabled || state.showAllTraces || !state.showEnsemble;
          const expressionScalarSeries = [];
          const expressionMatrixSeries = [];
          let expectedKind = '';
          let ensembleRecord = null;

          if (drawTraces) {
            let done = 0;
            const total = selectedIds.length;
            setGlobalStatus(`Computing All (Panel ${panelIndex + 1}): 0/${total}`);

            for (const trajId of selectedIds) {
              const seriesRecord = await getExpressionSeriesRecord(trajId, expressionText, true);
              done += 1;
              setGlobalStatus(`Computing All (Panel ${panelIndex + 1}): ${done}/${total}`);
              if (!seriesRecord) continue;
              if (!expectedKind) {
                expectedKind = seriesRecord.series_kind;
              } else if (seriesRecord.series_kind !== expectedKind) {
                throw new Error(
                  (
                    `Expression '${expressionText}' has mixed series kinds across trajectories `
                    + '(scalar and matrix), which is not supported in All mode.'
                  )
                );
              }
              if (seriesRecord.series_kind === 'matrix') {
                expressionMatrixSeries.push({ traj_id: trajId, time: seriesRecord.time, values: seriesRecord.values });
              } else {
                expressionScalarSeries.push({ traj_id: trajId, time: seriesRecord.time, value: seriesRecord.value });
              }
            }
            setGlobalStatus(`All auto compute complete (Panel ${panelIndex + 1}): ${done}/${total}`);
          }

          if (state.showEnsemble) {
            ensembleRecord = await getExpressionEnsembleRecord(expressionText, panelStatMode, true);
            const componentSeries = Array.isArray(ensembleRecord?.component_series)
              ? ensembleRecord.component_series
              : [];
            if (!componentSeries.length) {
              panelMessage(panelIndex, `No expression ensemble data for '${expressionText}'.`);
              purgePlot(plotId);
              return;
            }
            const ensembleKind = ensembleRecord?.series_kind === 'matrix' ? 'matrix' : 'scalar';
            if (expectedKind && ensembleKind !== expectedKind) {
              throw new Error(
                (
                  `Expression '${expressionText}' has inconsistent series kind between traces and ensemble `
                  + '(scalar and matrix), which is unsupported.'
                )
              );
            }
            if (!expectedKind) {
              expectedKind = ensembleKind;
            }
          }

          if (drawTraces) {
            if (!expectedKind) {
              panelMessage(panelIndex, `No expression data found for '${expressionText}'.`);
              purgePlot(plotId);
              return;
            }
            if (expectedKind === 'matrix') {
              if (!expressionMatrixSeries.length && !state.showEnsemble) {
                panelMessage(panelIndex, `No expression matrix data found for '${expressionText}'.`);
                purgePlot(plotId);
                return;
              }
              addAllModeRawKeyMatrix(
                figData,
                expressionMatrixSeries,
                traceNameBase,
                null,
                ensembleRecord,
                panelStatMode,
                { forceDrawTraces: hoppingOverlayEnabled }
              );
              if (!figData.length) {
                panelMessage(panelIndex, `No expression components available for '${expressionText}'.`);
                purgePlot(plotId);
                return;
              }
              hoppingOverlayContext = {
                seriesKind: 'matrix',
                seriesList: expressionMatrixSeries,
                componentStrategy: 'all_components',
                componentLabels: null,
              };
            } else {
              if (!expressionScalarSeries.length && !state.showEnsemble) {
                panelMessage(panelIndex, `No expression data found for '${expressionText}'.`);
                purgePlot(plotId);
                return;
              }
              addAllModeScalar(figData, expressionScalarSeries, traceNameBase, '#1f77b4', ensembleRecord, panelStatMode, {
                forceDrawTraces: hoppingOverlayEnabled,
              });
              hoppingOverlayContext = {
                seriesKind: 'scalar',
                seriesList: expressionScalarSeries,
              };
            }
          } else {
            const componentSeries = Array.isArray(ensembleRecord?.component_series)
              ? ensembleRecord.component_series
              : [];
            if (!componentSeries.length) {
              panelMessage(panelIndex, `No expression ensemble data for '${expressionText}'.`);
              purgePlot(plotId);
              return;
            }
            if (componentSeries.length === 1) {
              addAllModeScalar(figData, [], traceNameBase, '#1f77b4', ensembleRecord, panelStatMode);
            } else {
              const labels = componentSeries.map((series, idx) => {
                const text = String(series?.label || '').trim();
                return text || `component ${idx}`;
              });
              addAllModeRawKeyMatrix(figData, [], traceNameBase, labels, ensembleRecord, panelStatMode);
            }
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
            hoppingOverlayContext = {
              seriesKind: 'matrix',
              seriesList: [{ traj_id: trajId, time: seriesRecord.time, values: seriesRecord.values }],
              componentStrategy: 'all_components',
              componentLabels: null,
            };
          } else {
            addExpressionScalarTrace(
              figData,
              `${traceNameBase} traj ${trajId}`,
              seriesRecord.time,
              seriesRecord.value,
              seriesRecord.sample_count,
              '#1f77b4'
            );
            hoppingOverlayContext = {
              seriesKind: 'scalar',
              seriesList: [{ traj_id: trajId, time: seriesRecord.time, value: seriesRecord.value }],
            };
          }
        }

        if (!figData.length) {
          panelMessage(panelIndex, 'Expression evaluated but returned no plottable points.');
          purgePlot(plotId);
          return;
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
          const drawTraces = hoppingOverlayEnabled || state.showAllTraces || !state.showEnsemble;
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
                panelStatMode,
                { forceDrawTraces: hoppingOverlayEnabled }
              );
              if (!figData.length) {
                panelMessage(panelIndex, `No raw key components available for '${rawKey}'.`);
                purgePlot(plotId);
                return;
              }
              hoppingOverlayContext = {
                seriesKind: 'matrix',
                seriesList: rawMatrixSeries,
                componentStrategy: 'all_components',
                componentLabels: allModeComponentLabels,
              };
            } else {
              if (!rawScalarSeries.length) {
                panelMessage(panelIndex, `No raw key scalar data found for '${rawKey}'.`);
                purgePlot(plotId);
                return;
              }
              addAllModeScalar(figData, rawScalarSeries, rawName, '#1f77b4', ensembleRecord, panelStatMode, {
                forceDrawTraces: hoppingOverlayEnabled,
              });
              hoppingOverlayContext = {
                seriesKind: 'scalar',
                seriesList: rawScalarSeries,
              };
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
            hoppingOverlayContext = {
              seriesKind: 'matrix',
              seriesList: [{ traj_id: selectedIds[0], time: series.time, values: series.values }],
              componentStrategy: 'all_components',
              componentLabels: labels,
            };
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
            hoppingOverlayContext = {
              seriesKind: 'scalar',
              seriesList: [{ traj_id: selectedIds[0], time: series.time, value: series.value }],
            };
          }
        }
      } else if (observable === 'state') {
        if (state.selectedTraj === 'all') {
          const drawTraces = hoppingOverlayEnabled || state.showAllTraces || !state.showEnsemble;
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
            fillColor: getPlotThemeColors().dangerFillColor,
            centerHoverLabel: 'state',
            forceDrawTraces: hoppingOverlayEnabled,
          });
          hoppingOverlayContext = {
            seriesKind: 'scalar',
            seriesList: stateSeries,
          };
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
          hoppingOverlayContext = {
            seriesKind: 'scalar',
            seriesList: [series],
          };
        }
      } else if (observable === 'eig') {
        if (state.selectedTraj === 'all') {
          const drawTraces = hoppingOverlayEnabled || state.showAllTraces || !state.showEnsemble;
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
          addAllModeEig(figData, eigSeriesList, ensembleRecord, panelStatMode, {
            forceDrawTraces: hoppingOverlayEnabled,
          });
          if (!figData.length) {
            panelMessage(panelIndex, 'No eig components available for selected trajectory set.');
            purgePlot(plotId);
            return;
          }
          hoppingOverlayContext = {
            seriesKind: 'matrix',
            seriesList: eigSeriesList,
            componentStrategy: 'state_pair',
            componentLabels: null,
          };
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
          hoppingOverlayContext = {
            seriesKind: 'matrix',
            seriesList: [{ traj_id: selectedIds[0], time: series.time, values: series.values }],
            componentStrategy: 'state_pair',
            componentLabels: null,
          };
        }
      } else if (observable === '|c|^2') {
        if (state.selectedTraj === 'all') {
          const drawTraces = hoppingOverlayEnabled || state.showAllTraces || !state.showEnsemble;
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
          addAllModeCProb(figData, cProbSeriesList, ensembleRecord, panelStatMode, {
            forceDrawTraces: hoppingOverlayEnabled,
          });
          if (!figData.length) {
            panelMessage(panelIndex, 'No |c|^2 components available for selected trajectory set.');
            purgePlot(plotId);
            return;
          }
          hoppingOverlayContext = {
            seriesKind: 'matrix',
            seriesList: cProbSeriesList,
            componentStrategy: 'state_pair',
            componentLabels: null,
          };
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
          hoppingOverlayContext = {
            seriesKind: 'matrix',
            seriesList: [{ traj_id: selectedIds[0], time: series.time, values: series.values }],
            componentStrategy: 'state_pair',
            componentLabels: null,
          };
        }
      } else {
        const drawTraces = state.selectedTraj !== 'all' || hoppingOverlayEnabled || state.showAllTraces || !state.showEnsemble;
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
          addAllModeScalar(figData, scalarSeries, observable, '#1f77b4', ensembleRecord, panelStatMode, {
            forceDrawTraces: hoppingOverlayEnabled,
          });
          if (!figData.length) {
            panelMessage(panelIndex, `No ${observable} data for selection.`);
            purgePlot(plotId);
            return;
          }
          hoppingOverlayContext = {
            seriesKind: 'scalar',
            seriesList: scalarSeries,
          };
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
          hoppingOverlayContext = {
            seriesKind: 'scalar',
            seriesList: [series],
          };
        }
      }

      if (hoppingOverlayEnabled) {
        await applyHoppingOverlay(figData, hoppingOverlayContext, selectedIds);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      panelMessage(panelIndex, `Data load failed: ${detail}`);
      setGlobalStatus(`Data load failed (Panel ${panelIndex + 1}): ${detail}`, true);
      purgePlot(plotId);
      return;
    }

    const baseLayout = {
      title: { text: title, font: { size: 15 } },
      xaxis: { title: 'Time (fs)' },
      yaxis: { title: yLabel },
      margin: { l: 58, r: 18, t: 48, b: 48 },
      legend: { orientation: 'h', yanchor: 'bottom', y: 1.02, xanchor: 'left', x: 0 }
    };

    if (observable === 'state') {
      baseLayout.yaxis = {
        ...baseLayout.yaxis,
        tickmode: 'linear',
        tick0: 0,
        dtick: 1,
      };
    }

    const layout = mergePlotlyLayout(baseLayout);

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

  function renderAllPanels(options = {}) {
    const suppressStatus = !!options?.suppressStatus;
    return enqueueRender(async () => {
      await renderAllPanelsCore();
      if (!suppressStatus && state.selectedTraj === 'all' && trajIds.length > 0) {
        setGlobalStatus('All auto compute complete.');
      }
    });
  }

  root.plot = {
    renderPanel,
    renderAllPanels,
    exportPanelData,
    exportAllPanelsDataTarGz,
    exportAllPanelsDataZip: exportAllPanelsDataTarGz,
    bindHoverSyncHandlers,
  };
})();
