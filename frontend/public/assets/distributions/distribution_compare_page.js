(function () {
  const PLOT_EXPORT_DPI = 300;
  const CSS_BASE_DPI = 96;
  const PLOT_EXPORT_SCALE = PLOT_EXPORT_DPI / CSS_BASE_DPI;
  const EV_TO_NM = 1239.841984;
  const TRACE_PALETTE = [
    '#2563eb',
    '#f97316',
    '#16a34a',
    '#dc2626',
    '#7c3aed',
    '#0891b2',
    '#ca8a04',
    '#db2777',
  ];
  const PAIR_TRACE_PALETTE = [
    '#0f766e',
    '#7c3aed',
    '#dc2626',
    '#ca8a04',
    '#2563eb',
    '#db2777',
    '#0891b2',
    '#16a34a',
  ];
  const DISTRIBUTION_DASH_PATTERNS = ['solid', 'dash', 'dot', 'dashdot', 'longdash', 'longdashdot'];
  const WORKSPACE_SELECTION = 'selection';
  const WORKSPACE_OVERLAY = 'overlay';
  const WORKSPACE_SUMMARY = 'summary';
  const WORKSPACE_SPECTRUM = 'spectrum';

  const dom = {
    filePicker: document.getElementById('dc-file-picker'),
    fileInput: document.getElementById('dc-upload-input'),
    openServerBundleBtn: document.getElementById('dc-open-server-bundle-btn'),
    fileName: document.getElementById('dc-file-name'),
    refreshBtn: document.getElementById('dc-refresh-btn'),
    distributionCount: document.getElementById('dc-distribution-count'),
    activeCount: document.getElementById('dc-active-count'),
    listStatus: document.getElementById('dc-list-status'),
    distributionList: document.getElementById('dc-distribution-list'),
    workspaceSelectionBtn: document.getElementById('dc-workspace-selection-btn'),
    workspaceOverlayBtn: document.getElementById('dc-workspace-overlay-btn'),
    workspaceSummaryBtn: document.getElementById('dc-workspace-summary-btn'),
    workspaceSpectrumBtn: document.getElementById('dc-workspace-spectrum-btn'),
    workspaceHint: document.getElementById('dc-workspace-hint'),
    workspaceSelectionPanel: document.getElementById('dc-workspace-selection-panel'),
    workspaceOverlayPanel: document.getElementById('dc-workspace-overlay-panel'),
    workspaceSummaryPanel: document.getElementById('dc-workspace-summary-panel'),
    workspaceSpectrumPanel: document.getElementById('dc-workspace-spectrum-panel'),
    selectionEnabled: document.getElementById('dc-selection-enabled'),
    measurementKind: document.getElementById('dc-measurement-kind'),
    windowCenterEv: document.getElementById('dc-window-center-ev'),
    windowWidthEv: document.getElementById('dc-window-width-ev'),
    selectionProfilePanel: document.getElementById('dc-selection-profile-panel'),
    atom0: document.getElementById('dc-measurement-atom-0'),
    atom1: document.getElementById('dc-measurement-atom-1'),
    atom2: document.getElementById('dc-measurement-atom-2'),
    atom2Group: document.getElementById('dc-measurement-atom-2-group'),
    atom3: document.getElementById('dc-measurement-atom-3'),
    atom3Group: document.getElementById('dc-measurement-atom-3-group'),
    histogramBins: document.getElementById('dc-histogram-bins'),
    compareBtn: document.getElementById('dc-compare-btn'),
    compareStatus: document.getElementById('dc-compare-status'),
    plotActivePill: document.getElementById('dc-plot-active-pill'),
    plot: document.getElementById('dc-plot'),
    umapStatus: document.getElementById('dc-umap-status'),
    umapActivePill: document.getElementById('dc-umap-active-pill'),
    umapPlot: document.getElementById('dc-umap-plot'),
    summaryCount: document.getElementById('dc-summary-count'),
    summaryMeta: document.getElementById('dc-summary-meta'),
    summaryGrid: document.getElementById('dc-summary-grid'),
    spectrumDeltaEv: document.getElementById('dc-spectrum-delta-ev'),
    spectrumXAxisUnit: document.getElementById('dc-spectrum-x-unit'),
    spectrumPairPanel: document.getElementById('dc-spectrum-pair-panel'),
    spectrumPairStatus: document.getElementById('dc-spectrum-pair-status'),
    spectrumStatus: document.getElementById('dc-spectrum-status'),
    spectrumActivePill: document.getElementById('dc-spectrum-active-pill'),
    spectrumPlot: document.getElementById('dc-spectrum-plot'),
    fileBrowserModal: document.getElementById('dc-file-browser-modal'),
    fileBrowserCloseBtn: document.getElementById('dc-file-browser-close-btn'),
    fileBrowserUpBtn: document.getElementById('dc-file-browser-up-btn'),
    fileBrowserRoot: document.getElementById('dc-file-browser-root'),
    fileBrowserPath: document.getElementById('dc-file-browser-path'),
    fileBrowserStatus: document.getElementById('dc-file-browser-status'),
    fileBrowserList: document.getElementById('dc-file-browser-list'),
  };

  const config = readConfig();
  const state = {
    apiBase: config.apiBase,
    endpoints: config.endpoints,
    uploadFieldName: config.uploadFieldName,
    workspace: WORKSPACE_OVERLAY,
    distributions: [],
    activeIds: new Set(),
    activeSpectrumSeriesKeys: new Set(),
    uploadInFlight: false,
    listInFlight: false,
    compareInFlight: false,
    umapInFlight: false,
    spectrumCompareInFlight: false,
    pathLoadInFlight: false,
    browseListInFlight: false,
    deleteInFlightIds: new Set(),
    compareRequestSeq: 0,
    umapRequestSeq: 0,
    spectrumRequestSeq: 0,
    lastCompareResult: null,
    lastUmapResult: null,
    lastSpectrumResult: null,
    spectrumPairOptions: [],
    selectedSpectrumPairKeys: new Set(),
    selectionEnabled: false,
    selectionProfilesByDistribution: {},
  };
  let fileBrowserCurrentPath = '';
  let fileBrowserParentPath = null;
  let overlayRefreshTimer = null;
  let overlayRefreshPending = { geometry: false, umap: false };
  const DEFAULT_WINDOW_CENTER_EV = 3.9;
  const DEFAULT_WINDOW_WIDTH_EV = 0.30;
  const DEFAULT_SOAP_R_CUT = 5.0;
  const DEFAULT_SOAP_N_MAX = 6;
  const DEFAULT_SOAP_L_MAX = 4;
  const DEFAULT_SOAP_SIGMA = 0.3;
  const DEFAULT_UMAP_N_NEIGHBORS = 50;
  const DEFAULT_UMAP_MIN_DIST = 0.1;
  const DEFAULT_UMAP_METRIC = 'euclidean';
  const DEFAULT_UMAP_RANDOM_STATE = 42;

  function readConfig() {
    const defaults = {
      apiBase: '/api',
      uploadFieldName: 'file',
      endpoints: {},
    };
    const scriptEl = document.getElementById('distribution-compare-config-json');
    if (!scriptEl) {
      return finalizeConfig(defaults);
    }
    try {
      const parsed = JSON.parse(scriptEl.textContent || '{}');
      return finalizeConfig({
        apiBase: typeof parsed?.api_base === 'string' ? parsed.api_base.trim() : '/api',
        uploadFieldName: typeof parsed?.upload_field_name === 'string' && parsed.upload_field_name.trim()
          ? parsed.upload_field_name.trim()
          : 'file',
        endpoints: parsed?.endpoints && typeof parsed.endpoints === 'object' ? parsed.endpoints : {},
      });
    } catch (_) {
      return finalizeConfig(defaults);
    }
  }

  function finalizeConfig(partial) {
    const apiBase = normalizeApiBase(partial.apiBase);
    const endpoints = partial.endpoints || {};
    return {
      apiBase,
      uploadFieldName: partial.uploadFieldName || 'file',
      endpoints: {
        list: resolveEndpoint(apiBase, endpoints.list, '/distributions'),
        load: resolveEndpoint(apiBase, endpoints.load, '/distributions/load'),
        browseFiles: resolveEndpoint(apiBase, endpoints.browse_files || endpoints.browseFiles, '/distributions/files'),
        loadByPath: resolveEndpoint(apiBase, endpoints.load_by_path || endpoints.loadByPath, '/distributions/load-path'),
        deleteBase: resolveEndpoint(apiBase, endpoints.delete_base || endpoints.deleteBase, '/distributions'),
        compareGeometry: resolveEndpoint(
          apiBase,
          endpoints.compare_geometry || endpoints.compareGeometry,
          '/distributions/compare-geometry'
        ),
        compareGeometryWindow: resolveEndpoint(
          apiBase,
          endpoints.compare_geometry_window || endpoints.compareGeometryWindow,
          '/distributions/compare-geometry-window'
        ),
        projectSoapUmapWindow: resolveEndpoint(
          apiBase,
          endpoints.project_soap_umap_window || endpoints.projectSoapUmapWindow,
          '/distributions/project-soap-umap-window'
        ),
        projectSoapUmap: resolveEndpoint(
          apiBase,
          endpoints.project_soap_umap || endpoints.projectSoapUmap,
          '/distributions/project-soap-umap'
        ),
        compareSpectrum: resolveEndpoint(
          apiBase,
          endpoints.compare_spectrum || endpoints.compareSpectrum,
          '/distributions/compare-spectrum'
        ),
      },
    };
  }

  function normalizeApiBase(rawValue) {
    const raw = typeof rawValue === 'string' ? rawValue.trim() : '';
    if (!raw) return '/api';
    return raw.replace(/\/$/, '') || '/api';
  }

  function resolveEndpoint(apiBase, configuredValue, fallbackPath) {
    const value = typeof configuredValue === 'string' ? configuredValue.trim() : '';
    if (value) {
      if (/^https?:\/\//i.test(value)) return value;
      if (value.startsWith('/')) return value;
      return `${apiBase}/${value.replace(/^\/+/, '')}`;
    }
    return `${apiBase}${fallbackPath}`;
  }

  const { getAppearanceModule, mergePlotlyLayout, readCssVar } = window.DashboardPlotUtils;

  function getPlotColors() {
    const appearance = getAppearanceModule();
    if (appearance && typeof appearance.getPlotColors === 'function') {
      return appearance.getPlotColors();
    }
    return {
      traceMutedColor: 'rgba(120,120,120,0.35)',
      accentFillColor: 'rgba(31,119,180,0.18)',
    };
  }

  function setListStatus(message, isError = false) {
    if (!dom.listStatus) return;
    dom.listStatus.textContent = String(message || '');
    dom.listStatus.classList.toggle('error', !!isError);
  }

  function setCompareStatus(message, isError = false) {
    if (!dom.compareStatus) return;
    dom.compareStatus.textContent = String(message || '');
    dom.compareStatus.classList.toggle('error', !!isError);
  }

  function setUmapStatus(message, isError = false) {
    if (!dom.umapStatus) return;
    dom.umapStatus.textContent = String(message || '');
    dom.umapStatus.classList.toggle('error', !!isError);
  }

  function setSpectrumStatus(message, isError = false) {
    if (!dom.spectrumStatus) return;
    dom.spectrumStatus.textContent = String(message || '');
    dom.spectrumStatus.classList.toggle('error', !!isError);
  }

  function setSpectrumPairStatus(message, isError = false) {
    if (!dom.spectrumPairStatus) return;
    dom.spectrumPairStatus.textContent = String(message || '');
    dom.spectrumPairStatus.classList.toggle('error', !!isError);
  }

  function setFileName(message) {
    if (!dom.fileName) return;
    dom.fileName.textContent = String(message || 'No bundle chosen.');
  }

  function syncVisibleWorkspacePlot() {
    if (typeof Plotly === 'undefined') return;
    const tasks = [];
    if (state.workspace === WORKSPACE_OVERLAY) {
      if (dom.plot && state.lastCompareResult) {
        tasks.push({ plotEl: dom.plot, result: state.lastCompareResult, renderFn: renderComparePlot });
      }
      if (dom.umapPlot && state.lastUmapResult) {
        tasks.push({ plotEl: dom.umapPlot, result: state.lastUmapResult, renderFn: renderUmapPlot });
      }
    } else if (state.workspace === WORKSPACE_SPECTRUM) {
      if (dom.spectrumPlot && state.lastSpectrumResult) {
        tasks.push({ plotEl: dom.spectrumPlot, result: state.lastSpectrumResult, renderFn: renderSpectrumPlot });
      }
    }
    if (!tasks.length) return;

    const refreshOne = ({ plotEl, result, renderFn }) => {
      const hasRenderedPlot = Array.isArray(plotEl.data) && plotEl.data.length > 0;
      if (hasRenderedPlot && Plotly.Plots && typeof Plotly.Plots.resize === 'function') {
        try {
          Plotly.Plots.resize(plotEl);
          return;
        } catch (_) {
          // Fall back to a full rerender if the plot was created while hidden.
        }
      }
      renderFn(result);
    };

    const refresh = () => {
      for (const task of tasks) {
        refreshOne(task);
      }
    };

    if (typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(refresh);
      return;
    }
    refresh();
  }

  function syncWorkspaceUi() {
    const inSelection = state.workspace === WORKSPACE_SELECTION;
    const inOverlay = state.workspace === WORKSPACE_OVERLAY;
    const inSummary = state.workspace === WORKSPACE_SUMMARY;
    const inSpectrum = state.workspace === WORKSPACE_SPECTRUM;

    if (dom.workspaceSelectionBtn) {
      dom.workspaceSelectionBtn.classList.toggle('is-active', inSelection);
      dom.workspaceSelectionBtn.setAttribute('aria-selected', inSelection ? 'true' : 'false');
    }
    if (dom.workspaceOverlayBtn) {
      dom.workspaceOverlayBtn.classList.toggle('is-active', inOverlay);
      dom.workspaceOverlayBtn.setAttribute('aria-selected', inOverlay ? 'true' : 'false');
    }
    if (dom.workspaceSummaryBtn) {
      dom.workspaceSummaryBtn.classList.toggle('is-active', inSummary);
      dom.workspaceSummaryBtn.setAttribute('aria-selected', inSummary ? 'true' : 'false');
    }
    if (dom.workspaceSpectrumBtn) {
      dom.workspaceSpectrumBtn.classList.toggle('is-active', inSpectrum);
      dom.workspaceSpectrumBtn.setAttribute('aria-selected', inSpectrum ? 'true' : 'false');
    }

    if (dom.workspaceSelectionPanel) {
      dom.workspaceSelectionPanel.hidden = !inSelection;
    }
    if (dom.workspaceOverlayPanel) {
      dom.workspaceOverlayPanel.hidden = !inOverlay;
    }
    if (dom.workspaceSummaryPanel) {
      dom.workspaceSummaryPanel.hidden = !inSummary;
    }
    if (dom.workspaceSpectrumPanel) {
      dom.workspaceSpectrumPanel.hidden = !inSpectrum;
    }

    if (dom.workspaceHint) {
      dom.workspaceHint.textContent = inSelection
        ? 'Choose the selection window and the active electronic profile for each distribution.'
        : inOverlay
          ? 'Adjust structure settings. Histogram and UMAP refresh automatically for the active distributions.'
        : inSummary
          ? 'Review the current all-vs-selected geometry statistics for each distribution.'
          : 'Inspect the automatically refreshed absorption spectra and optional transition-pair overlays.';
    }

    syncVisibleWorkspacePlot();
  }

  function setWorkspace(nextWorkspace) {
    const workspace = nextWorkspace === WORKSPACE_SELECTION
      ? WORKSPACE_SELECTION
      : nextWorkspace === WORKSPACE_SUMMARY
      ? WORKSPACE_SUMMARY
      : nextWorkspace === WORKSPACE_SPECTRUM
        ? WORKSPACE_SPECTRUM
        : WORKSPACE_OVERLAY;
    if (workspace === state.workspace) {
      syncWorkspaceUi();
      return;
    }
    state.workspace = workspace;
    syncWorkspaceUi();
  }

  function setFileBrowserOpen(isOpen) {
    if (!dom.fileBrowserModal) return;
    dom.fileBrowserModal.hidden = !isOpen;
    dom.fileBrowserModal.setAttribute('aria-hidden', isOpen ? 'false' : 'true');
    document.body.style.overflow = isOpen ? 'hidden' : '';
  }

  function setFileBrowserStatus(message, isError = false) {
    if (!dom.fileBrowserStatus) return;
    dom.fileBrowserStatus.textContent = String(message || '');
    dom.fileBrowserStatus.classList.toggle('error', !!isError);
  }

  function syncMeasurementKindUi() {
    const kind = String(dom.measurementKind?.value || 'bond');
    if (dom.atom2Group) {
      dom.atom2Group.classList.toggle('hidden', kind === 'bond');
    }
    if (dom.atom3Group) {
      dom.atom3Group.classList.toggle('hidden', kind !== 'dihedral');
    }
  }

  function syncActionState() {
    const busy = state.uploadInFlight || state.listInFlight || state.pathLoadInFlight || state.browseListInFlight;
    if (dom.fileInput) dom.fileInput.disabled = busy;
    if (dom.filePicker) dom.filePicker.classList.toggle('is-disabled', busy);
    if (dom.openServerBundleBtn) dom.openServerBundleBtn.disabled = busy;
    if (dom.refreshBtn) dom.refreshBtn.disabled = busy;
    if (dom.selectionEnabled) dom.selectionEnabled.disabled = busy;
    if (dom.compareBtn) {
      dom.compareBtn.disabled = state.compareInFlight || !getActiveIds().length;
    }
    if (dom.fileBrowserUpBtn) {
      dom.fileBrowserUpBtn.disabled = busy || fileBrowserParentPath == null;
    }
    if (dom.fileBrowserCloseBtn) {
      dom.fileBrowserCloseBtn.disabled = state.pathLoadInFlight;
    }
  }

  function measurementAtomCount(kind) {
    if (kind === 'dihedral') return 4;
    if (kind === 'angle') return 3;
    return 2;
  }

  function measurementAxisTitle(kind, unit) {
    if (kind === 'bond') return `Distance${unit ? ` (${unit})` : ''}`;
    if (kind === 'angle') return `Angle${unit ? ` (${unit})` : ''}`;
    if (kind === 'dihedral') return `Dihedral${unit ? ` (${unit})` : ''}`;
    return unit ? `Value (${unit})` : 'Value';
  }

  function defaultUnitForKind(kind) {
    if (kind === 'bond') return 'A';
    if (kind === 'angle' || kind === 'dihedral') return 'deg';
    return '';
  }

  function buildDeleteUrl(distributionId) {
    return `${state.endpoints.deleteBase}/${encodeURIComponent(String(distributionId || ''))}`;
  }

  function getActiveIds() {
    const validIds = new Set(state.distributions.map((item) => item.id));
    const ordered = [];
    for (const distribution of state.distributions) {
      if (state.activeIds.has(distribution.id) && validIds.has(distribution.id)) {
        ordered.push(distribution.id);
      }
    }
    return ordered;
  }

  function spectrumSeriesKey(distributionId, profileId) {
    const dist = String(distributionId || '').trim();
    const profile = String(profileId || '').trim();
    if (!dist || !profile) return '';
    return `${dist}::${profile}`;
  }

  function getActiveSpectrumSeriesItems() {
    const items = [];
    for (const distribution of state.distributions) {
      const profiles = Array.isArray(distribution.electronicProfiles) ? distribution.electronicProfiles : [];
      for (const profile of profiles) {
        const key = spectrumSeriesKey(distribution.id, profile.profileId);
        if (!key || !state.activeSpectrumSeriesKeys.has(key)) continue;
        items.push({
          key,
          distribution,
          profile,
        });
      }
    }
    return items;
  }

  function getActiveSelectionItems() {
    const items = [];
    for (const distribution of state.distributions) {
      if (!state.activeIds.has(distribution.id)) continue;
      const profiles = Array.isArray(distribution.electronicProfiles) ? distribution.electronicProfiles : [];
      if (!profiles.length) continue;
      const preferredProfileId = firstNonEmptyString(
        state.selectionProfilesByDistribution[distribution.id],
        distribution.defaultElectronicProfileId
      );
      const selectedProfile = profiles.find((profile) => profile.profileId === preferredProfileId) || profiles[0];
      if (!selectedProfile) continue;
      items.push({
        distribution,
        profile: selectedProfile,
      });
    }
    return items;
  }

  function getSelectionContext() {
    const activeDistributions = state.distributions.filter((distribution) => state.activeIds.has(distribution.id));
    const eligibleItems = [];
    const skippedDistributions = [];
    for (const distribution of activeDistributions) {
      const profiles = Array.isArray(distribution.electronicProfiles) ? distribution.electronicProfiles : [];
      if (!profiles.length) {
        skippedDistributions.push(distribution);
        continue;
      }
      const preferredProfileId = firstNonEmptyString(
        state.selectionProfilesByDistribution[distribution.id],
        distribution.defaultElectronicProfileId
      );
      const selectedProfile = profiles.find((profile) => profile.profileId === preferredProfileId) || profiles[0];
      if (!selectedProfile) {
        skippedDistributions.push(distribution);
        continue;
      }
      eligibleItems.push({
        distribution,
        profile: selectedProfile,
      });
    }
    return {
      activeDistributions,
      eligibleItems,
      skippedDistributions,
    };
  }

  function getSelectionSkippedLabels(limit = 3) {
    const skipped = getSelectionContext().skippedDistributions;
    return skipped.slice(0, Math.max(0, limit)).map((distribution) => distribution.name || distribution.id);
  }

  function buildSkippedDistributionsText() {
    const skipped = getSelectionContext().skippedDistributions;
    if (!skipped.length) return '';
    const labels = getSelectionSkippedLabels(3);
    let text = ` Skipped ${skipped.length} active bundle${skipped.length === 1 ? '' : 's'} without electronic profiles`;
    if (labels.length) {
      text += `: ${labels.join(', ')}`;
      if (skipped.length > labels.length) {
        text += ', ...';
      }
    }
    return `${text}.`;
  }

  function syncSelectionControlsState() {
    const enabled = !!state.selectionEnabled;
    if (dom.selectionEnabled) {
      dom.selectionEnabled.checked = enabled;
    }
    if (dom.windowCenterEv) dom.windowCenterEv.disabled = !enabled;
    if (dom.windowWidthEv) dom.windowWidthEv.disabled = !enabled;
    if (dom.selectionProfilePanel) {
      dom.selectionProfilePanel.querySelectorAll('select').forEach((selectEl) => {
        selectEl.disabled = !enabled;
      });
    }
  }

  function getSelectedSpectrumPairs() {
    return state.spectrumPairOptions
      .filter((option) => state.selectedSpectrumPairKeys.has(option.key))
      .map((option) => option.pair.slice(0, 2));
  }

  function syncActivePills() {
    const total = state.distributions.length;
    const active = getActiveIds().length;
    const activeSelectionItems = getActiveSelectionItems().length;
    const activeSpectrumSeries = getActiveSpectrumSeriesItems().length;
    if (dom.distributionCount) dom.distributionCount.textContent = String(total);
    if (dom.activeCount) dom.activeCount.textContent = `${active} active`;
    if (dom.plotActivePill) dom.plotActivePill.textContent = `${active} active`;
    if (dom.umapActivePill) {
      dom.umapActivePill.textContent = state.selectionEnabled
        ? `${activeSelectionItems} prof${activeSelectionItems === 1 ? '' : 's'}`
        : `${active} bundle${active === 1 ? '' : 's'}`;
    }
    if (dom.spectrumActivePill) dom.spectrumActivePill.textContent = `${activeSpectrumSeries} series`;
  }

  function purgePlot() {
    if (dom.plot && typeof Plotly !== 'undefined') {
      try {
        Plotly.purge(dom.plot);
      } catch (_) {
        // Ignore purge failures for partially initialized plots.
      }
    }
  }

  function clearPlot(message) {
    if (!dom.plot) return;
    purgePlot();
    dom.plot.innerHTML = '';
    const empty = document.createElement('div');
    empty.className = 'distribution-empty';
    empty.textContent = String(message || 'No comparison has been rendered yet.');
    dom.plot.appendChild(empty);
  }

  function purgeUmapPlot() {
    if (dom.umapPlot && typeof Plotly !== 'undefined') {
      try {
        Plotly.purge(dom.umapPlot);
      } catch (_) {
        // Ignore purge failures for partially initialized plots.
      }
    }
  }

  function clearUmapPlot(message) {
    if (!dom.umapPlot) return;
    purgeUmapPlot();
    dom.umapPlot.innerHTML = '';
    const empty = document.createElement('div');
    empty.className = 'distribution-empty';
    empty.textContent = String(message || 'No UMAP projection has been rendered yet.');
    dom.umapPlot.appendChild(empty);
  }

  function purgeSpectrumPlot() {
    if (dom.spectrumPlot && typeof Plotly !== 'undefined') {
      try {
        Plotly.purge(dom.spectrumPlot);
      } catch (_) {
        // Ignore purge failures for partially initialized plots.
      }
    }
  }

  function clearSpectrumPlot(message) {
    if (!dom.spectrumPlot) return;
    purgeSpectrumPlot();
    dom.spectrumPlot.innerHTML = '';
    const empty = document.createElement('div');
    empty.className = 'distribution-empty';
    empty.textContent = String(message || 'No spectrum comparison has been rendered yet.');
    dom.spectrumPlot.appendChild(empty);
  }

  function clearEmptyPlotPlaceholder(plotEl) {
    if (!plotEl) return;
    if (!plotEl.querySelector('.distribution-empty')) return;
    plotEl.innerHTML = '';
  }

  function formatTransitionPair(pair) {
    if (!Array.isArray(pair) || pair.length !== 2) return '';
    return `${pair[0]}->${pair[1]}`;
  }

  function pairKey(pair) {
    if (!Array.isArray(pair) || pair.length !== 2) return '';
    return `${pair[0]}->${pair[1]}`;
  }

  function normalizeSpectrumPair(rawValue) {
    const pair = normalizeAtomIndices(rawValue).slice(0, 2);
    if (pair.length !== 2) return null;
    return pair;
  }

  function normalizeSpectrumPairOption(rawItem) {
    const raw = rawItem && typeof rawItem === 'object' ? rawItem : {};
    const pair = normalizeSpectrumPair(raw.pair || []);
    if (!pair) return null;
    return {
      pair,
      key: pairKey(pair),
      label: firstNonEmptyString(raw.label, raw.name) || formatTransitionPair(pair),
    };
  }

  function normalizeSpectrumPairOptionsPayload(payload) {
    const rawPairs = Array.isArray(payload && payload.available_pairs) ? payload.available_pairs : [];
    const rawSkipped = Array.isArray(payload && payload.skipped) ? payload.skipped : [];
    return {
      availablePairs: rawPairs
        .map((item) => normalizeSpectrumPairOption(item))
        .filter(Boolean),
      skipped: rawSkipped
        .map((item) => normalizeSpectrumSkipped(item))
        .filter(Boolean),
    };
  }

  function renderSpectrumPairOptions(options = {}) {
    const availablePairs = Array.isArray(options.availablePairs) ? options.availablePairs : state.spectrumPairOptions;
    const emptyMessage = firstNonEmptyString(options.emptyMessage);
    if (!dom.spectrumPairPanel) return;
    dom.spectrumPairPanel.innerHTML = '';
    if (!availablePairs.length) {
      const empty = document.createElement('div');
      empty.className = 'spectrum-pair-empty';
      empty.textContent = emptyMessage || 'No common transition pairs are available for the selected spectrum series.';
      dom.spectrumPairPanel.appendChild(empty);
      return;
    }

    for (const option of availablePairs) {
      const row = document.createElement('label');
      row.className = 'spectrum-pair-option';
      row.setAttribute('for', `dc-spectrum-pair-${option.key.replace(/[^a-zA-Z0-9_-]+/g, '-')}`);

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.id = `dc-spectrum-pair-${option.key.replace(/[^a-zA-Z0-9_-]+/g, '-')}`;
      checkbox.dataset.spectrumPairKey = option.key;
      checkbox.checked = state.selectedSpectrumPairKeys.has(option.key);

      const label = document.createElement('div');
      label.className = 'spectrum-pair-option-label';
      label.textContent = option.label;

      row.appendChild(checkbox);
      row.appendChild(label);
      dom.spectrumPairPanel.appendChild(row);
    }
  }

  function clearSummary(message) {
    if (dom.summaryCount) dom.summaryCount.textContent = '0';
    if (dom.summaryMeta) {
      dom.summaryMeta.textContent = String(message || 'No comparison result available.');
    }
    if (!dom.summaryGrid) return;
    dom.summaryGrid.innerHTML = '';
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = String(message || 'No comparison result available.');
    dom.summaryGrid.appendChild(empty);
  }

  function tryParseJson(rawText) {
    if (typeof rawText !== 'string' || !rawText.trim()) return null;
    try {
      return JSON.parse(rawText);
    } catch (_) {
      return null;
    }
  }

  async function fetchPayload(url, options) {
    const response = await fetch(url, options);
    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    let payload = null;
    if (contentType.includes('application/json')) {
      payload = await response.json().catch(() => null);
    } else {
      const text = await response.text().catch(() => '');
      payload = tryParseJson(text);
      if (payload == null) payload = text;
    }
    if (!response.ok) {
      throw new Error(extractErrorMessage(payload, `${response.status} ${response.statusText}`));
    }
    return payload;
  }

  function extractErrorMessage(payload, fallback) {
    if (typeof payload === 'string') {
      const text = payload.trim();
      return text || fallback || 'Request failed.';
    }
    if (payload && typeof payload === 'object') {
      const candidates = [
        payload.detail,
        payload.message,
        payload.error,
        payload.title,
        payload.reason,
      ];
      for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
      }
      if (Array.isArray(payload.detail) && payload.detail.length) {
        return payload.detail
          .map((item) => (typeof item === 'string' ? item : JSON.stringify(item)))
          .join('; ');
      }
    }
    return fallback || 'Request failed.';
  }

  function firstNonEmptyString(...values) {
    for (const value of values) {
      if (typeof value !== 'string') continue;
      const trimmed = value.trim();
      if (trimmed) return trimmed;
    }
    return '';
  }

  function firstFiniteNumber(...values) {
    for (const value of values) {
      const number = Number(value);
      if (Number.isFinite(number)) return number;
    }
    return null;
  }

  function coerceNumberArray(rawValue) {
    if (!Array.isArray(rawValue)) return [];
    return rawValue
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value));
  }

  function basename(pathValue) {
    const text = String(pathValue || '').trim();
    if (!text) return '';
    const parts = text.split(/[\\/]/);
    return parts[parts.length - 1] || text;
  }

  function toggleDomId(distributionId) {
    const token = encodeURIComponent(String(distributionId || 'distribution')).replace(/%/g, '-');
    return `dc-active-${token}`;
  }

  function uniqueSortedNumbers(values) {
    return Array.from(new Set(values.map((value) => Number(value)).filter((value) => Number.isFinite(value)))).sort((a, b) => a - b);
  }

  function normalizeElectronicProfile(rawItem, distributionId) {
    const raw = rawItem && typeof rawItem === 'object' ? rawItem : {};
    const profileId = firstNonEmptyString(raw.profile_id, raw.id, raw.key, raw.uid);
    if (!profileId) return null;
    const label = firstNonEmptyString(raw.label, raw.name, profileId);
    const engine = firstNonEmptyString(raw.engine);
    const method = firstNonEmptyString(raw.method);
    const reference = firstNonEmptyString(raw.reference);
    const xc = firstNonEmptyString(raw.xc);
    const basis = firstNonEmptyString(raw.basis);
    const nExcitedStates = firstFiniteNumber(raw.n_excited_states, raw.nstates, raw.n_states);
    const nStates = firstFiniteNumber(raw.n_states, raw.state_count, raw.nstate);
    const nTransition = firstFiniteNumber(raw.n_transition, raw.transition_count, raw.ntransition);
    const successCount = firstFiniteNumber(raw.success_count, raw.successes, raw.ok_count, 0);
    const failedCount = firstFiniteNumber(raw.failed_count, raw.failures, raw.error_count, 0);
    return {
      profileId,
      label,
      engine,
      method,
      reference,
      xc,
      basis,
      nExcitedStates,
      nStates,
      nTransition,
      successCount,
      failedCount,
      seriesKey: spectrumSeriesKey(distributionId, profileId),
    };
  }

  function normalizeDistributionRecord(rawItem, index) {
    const raw = rawItem && typeof rawItem === 'object' ? rawItem : {};
    const id = firstNonEmptyString(
      raw.distribution_id,
      raw.id,
      raw.key,
      raw.uid,
      raw.uuid,
      raw.name ? `distribution-${raw.name}` : ''
    ) || `distribution-${index + 1}`;
    const sourceFilename = firstNonEmptyString(
      raw.source_name,
      raw.source_filename,
      raw.file_name,
      raw.filename,
      raw.bundle_name,
      raw.archive_name,
      raw.source_path
    );
    const name = firstNonEmptyString(
      raw.name,
      raw.label,
      raw.display_name,
      raw.distribution_name,
      raw.manifest && raw.manifest.name,
      basename(sourceFilename),
      id
    );
    const sampleCount = firstFiniteNumber(
      raw.sample_count,
      raw.nsamples,
      raw.n_samples,
      raw.num_samples,
      raw.nsample
    );
    const atomCount = firstFiniteNumber(
      raw.atom_count,
      raw.natoms,
      raw.n_atoms,
      Array.isArray(raw.atom_numbers) ? raw.atom_numbers.length : null
    );
    const createdAt = firstNonEmptyString(
      raw.created_at_utc,
      raw.loaded_at_utc,
      raw.cached_at_utc,
      raw.created_at,
      raw.loaded_at,
      raw.timestamp
    );
    const description = firstNonEmptyString(
      raw.description,
      raw.notes,
      raw.manifest && raw.manifest.description,
      raw.source_path
    );
    const electronicProfiles = Array.isArray(raw.electronic_profiles)
      ? raw.electronic_profiles
          .map((item) => normalizeElectronicProfile(item, id))
          .filter(Boolean)
      : [];
    const hasGeometry = raw.has_geometry !== false;
    const hasElectronic = electronicProfiles.length > 0 || !!(
      raw.has_electronic ||
      raw.has_electronics ||
      raw.electronic ||
      raw.electronics ||
      raw.manifest && raw.manifest.electronic
    );
    return {
      id,
      name,
      sourceFilename,
      sampleCount,
      atomCount,
      createdAt,
      description,
      hasGeometry,
      hasElectronic,
      defaultElectronicProfileId: firstNonEmptyString(raw.default_electronic_profile_id) || null,
      electronicProfiles,
      raw,
    };
  }

  function normalizeFileBrowserPayload(payload) {
    return {
      rootLabel: firstNonEmptyString(payload && payload.root_label, payload && payload.rootLabel),
      currentPath: firstNonEmptyString(payload && payload.current_path, payload && payload.currentPath),
      parentPath: firstNonEmptyString(payload && payload.parent_path, payload && payload.parentPath) || null,
      entries: Array.isArray(payload && payload.entries)
        ? payload.entries.map((entry) => ({
            name: firstNonEmptyString(entry && entry.name),
            relativePath: firstNonEmptyString(entry && entry.relative_path, entry && entry.relativePath),
            kind: firstNonEmptyString(entry && entry.kind) === 'directory' ? 'directory' : 'file',
            loadable: !!(entry && entry.loadable),
          }))
        : [],
    };
  }

  function renderFileBrowserEntries(entries) {
    if (!dom.fileBrowserList) return;
    dom.fileBrowserList.innerHTML = '';
    if (!Array.isArray(entries) || !entries.length) {
      const empty = document.createElement('div');
      empty.className = 'file-browser-empty';
      empty.textContent = 'No files or directories available in this location.';
      dom.fileBrowserList.appendChild(empty);
      return;
    }

    for (const entry of entries) {
      const directoryIsLoadable = entry.kind === 'directory' && entry.loadable;
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'file-browser-item';
      if (entry.kind === 'file' && !entry.loadable) {
        row.classList.add('file-disabled');
      }

      const main = document.createElement('div');
      main.className = 'file-browser-item-main';
      const nameEl = document.createElement('div');
      nameEl.className = 'file-browser-item-name';
      nameEl.textContent = entry.name;
      const metaEl = document.createElement('div');
      metaEl.className = 'file-browser-item-meta';
      if (directoryIsLoadable) {
        metaEl.textContent = 'Importable bundle directory';
      } else if (entry.kind === 'directory') {
        metaEl.textContent = 'Directory';
      } else if (entry.loadable) {
        metaEl.textContent = 'Importable bundle file';
      } else {
        metaEl.textContent = 'File';
      }
      main.appendChild(nameEl);
      main.appendChild(metaEl);

      const actionEl = document.createElement('div');
      actionEl.className = 'file-browser-item-meta';
      actionEl.textContent = entry.kind === 'directory'
        ? (directoryIsLoadable ? 'Import' : 'Open')
        : (entry.loadable ? 'Import' : '');

      row.appendChild(main);
      row.appendChild(actionEl);

      if (directoryIsLoadable) {
        row.addEventListener('click', () => {
          if (state.pathLoadInFlight || state.browseListInFlight) return;
          void loadBundleFromPath(entry.relativePath);
        });
      } else if (entry.kind === 'directory') {
        row.addEventListener('click', () => {
          if (state.browseListInFlight || state.pathLoadInFlight) return;
          void loadBrowsePath(entry.relativePath);
        });
      } else if (entry.loadable) {
        row.addEventListener('click', () => {
          if (state.pathLoadInFlight || state.browseListInFlight) return;
          void loadBundleFromPath(entry.relativePath);
        });
      }

      dom.fileBrowserList.appendChild(row);
    }
  }

  function extractDistributionRecords(payload) {
    if (Array.isArray(payload)) return payload;
    if (!payload || typeof payload !== 'object') return [];
    if (Array.isArray(payload.distributions)) return payload.distributions;
    if (Array.isArray(payload.items)) return payload.items;
    if (Array.isArray(payload.results)) return payload.results;
    if (payload.distributions && typeof payload.distributions === 'object') {
      return Object.values(payload.distributions);
    }
    return [];
  }

  function formatTimestamp(rawValue) {
    const text = firstNonEmptyString(rawValue);
    if (!text) return '';
    const date = new Date(text);
    if (Number.isNaN(date.getTime())) return text;
    return date.toLocaleString();
  }

  function buildProfileSummaryText(profile) {
    const parts = [];
    const methodParts = [
      firstNonEmptyString(profile.engine),
      firstNonEmptyString(profile.method),
      firstNonEmptyString(profile.reference),
      firstNonEmptyString(profile.xc),
      firstNonEmptyString(profile.basis),
    ].filter(Boolean);
    if (methodParts.length) {
      parts.push(methodParts.join(' | '));
    }
    if (Number.isFinite(profile.nExcitedStates)) {
      parts.push(`n_exc=${Math.round(profile.nExcitedStates)}`);
    }
    if (Number.isFinite(profile.nStates)) {
      parts.push(`${Math.round(profile.nStates)} states`);
    }
    if (Number.isFinite(profile.nTransition)) {
      parts.push(`${Math.round(profile.nTransition)} transitions`);
    }
    if (Number.isFinite(profile.successCount) || Number.isFinite(profile.failedCount)) {
      parts.push(`ok ${Math.round(Number(profile.successCount || 0))} / fail ${Math.round(Number(profile.failedCount || 0))}`);
    }
    return parts.join(' | ');
  }

  function renderDistributionList() {
    syncActivePills();
    if (!dom.distributionList) return;
    dom.distributionList.innerHTML = '';
    if (!state.distributions.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = 'No cached distributions are available yet.';
      dom.distributionList.appendChild(empty);
      return;
    }

    for (const distribution of state.distributions) {
      const article = document.createElement('article');
      article.className = 'distribution-item';
      if (state.activeIds.has(distribution.id)) article.classList.add('is-active');
      if (state.deleteInFlightIds.has(distribution.id)) article.classList.add('is-busy');

      const top = document.createElement('div');
      top.className = 'distribution-item-top';

      const toggleWrap = document.createElement('label');
      toggleWrap.className = 'distribution-toggle';
      toggleWrap.setAttribute('for', toggleDomId(distribution.id));

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.id = toggleDomId(distribution.id);
      checkbox.checked = state.activeIds.has(distribution.id);
      checkbox.disabled = state.deleteInFlightIds.has(distribution.id);
      checkbox.dataset.distributionActiveId = distribution.id;

      const titleWrap = document.createElement('div');
      const title = document.createElement('div');
      title.className = 'distribution-name';
      title.textContent = distribution.name;
      const idEl = document.createElement('div');
      idEl.className = 'distribution-id';
      idEl.textContent = `ID: ${distribution.id}`;
      titleWrap.appendChild(title);
      titleWrap.appendChild(idEl);

      toggleWrap.appendChild(checkbox);
      toggleWrap.appendChild(titleWrap);

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'distribution-delete';
      deleteBtn.type = 'button';
      deleteBtn.textContent = 'x';
      deleteBtn.title = `Delete ${distribution.name}`;
      deleteBtn.setAttribute('aria-label', `Delete ${distribution.name}`);
      deleteBtn.dataset.distributionDeleteId = distribution.id;
      deleteBtn.disabled = state.deleteInFlightIds.has(distribution.id);

      top.appendChild(toggleWrap);
      top.appendChild(deleteBtn);
      article.appendChild(top);

      const meta = document.createElement('div');
      meta.className = 'distribution-meta';
      if (Number.isFinite(distribution.sampleCount)) {
        meta.appendChild(buildChip(`${distribution.sampleCount} samples`));
      }
      if (Number.isFinite(distribution.atomCount)) {
        meta.appendChild(buildChip(`${distribution.atomCount} atoms`));
      }
      if (distribution.hasGeometry) {
        meta.appendChild(buildChip('geometry', 'success'));
      }
      if (distribution.hasElectronic) {
        meta.appendChild(buildChip(`${distribution.electronicProfiles.length} profile${distribution.electronicProfiles.length === 1 ? '' : 's'}`));
      }
      if (distribution.sourceFilename) {
        meta.appendChild(buildChip(basename(distribution.sourceFilename)));
      }
      article.appendChild(meta);

      const description = document.createElement('div');
      description.className = 'distribution-description';
      const createdText = formatTimestamp(distribution.createdAt);
      const copyParts = [];
      if (distribution.description) copyParts.push(distribution.description);
      if (createdText) copyParts.push(`Loaded: ${createdText}`);
      description.textContent = copyParts.join(' | ') || 'Ready for comparison.';
      article.appendChild(description);

      if (distribution.electronicProfiles.length) {
        const profileSection = document.createElement('div');
        profileSection.className = 'distribution-profile-section';

        const profileTitle = document.createElement('div');
        profileTitle.className = 'distribution-profile-title';
        profileTitle.textContent = 'Spectrum Profiles';
        profileSection.appendChild(profileTitle);

        for (const profile of distribution.electronicProfiles) {
          const row = document.createElement('label');
          row.className = 'distribution-profile-option';
          row.setAttribute('for', `dc-spectrum-series-${profile.seriesKey.replace(/[^a-zA-Z0-9_-]+/g, '-')}`);

          const profileCheckbox = document.createElement('input');
          profileCheckbox.type = 'checkbox';
          profileCheckbox.id = `dc-spectrum-series-${profile.seriesKey.replace(/[^a-zA-Z0-9_-]+/g, '-')}`;
          profileCheckbox.dataset.spectrumSeriesKey = profile.seriesKey;
          profileCheckbox.checked = state.activeSpectrumSeriesKeys.has(profile.seriesKey);
          profileCheckbox.disabled = state.deleteInFlightIds.has(distribution.id);

          const body = document.createElement('div');
          body.className = 'distribution-profile-body';

          const nameRow = document.createElement('div');
          nameRow.className = 'distribution-profile-name';
          nameRow.textContent = profile.label;
          if (distribution.defaultElectronicProfileId && distribution.defaultElectronicProfileId === profile.profileId) {
            const defaultChip = document.createElement('span');
            defaultChip.className = 'chip';
            defaultChip.textContent = 'default';
            nameRow.appendChild(defaultChip);
          }

          const metaRow = document.createElement('div');
          metaRow.className = 'distribution-profile-meta';
          metaRow.textContent = buildProfileSummaryText(profile) || profile.profileId;

          body.appendChild(nameRow);
          body.appendChild(metaRow);
          row.appendChild(profileCheckbox);
          row.appendChild(body);
          profileSection.appendChild(row);
        }

        article.appendChild(profileSection);
      }

      dom.distributionList.appendChild(article);
    }
  }

  function renderSelectionProfileControls() {
    syncActivePills();
    if (!dom.selectionProfilePanel) return;
    dom.selectionProfilePanel.innerHTML = '';

    const activeIds = getActiveIds();
    if (!activeIds.length) {
      const empty = document.createElement('div');
      empty.className = 'spectrum-pair-empty';
      empty.textContent = 'Enable one or more cached distributions to configure window-selection profiles.';
      dom.selectionProfilePanel.appendChild(empty);
      syncSelectionControlsState();
      return;
    }

    const activeDistributions = state.distributions.filter((distribution) => state.activeIds.has(distribution.id));
    const selectableDistributions = activeDistributions.filter(
      (distribution) => Array.isArray(distribution.electronicProfiles) && distribution.electronicProfiles.length > 0
    );
    if (!selectableDistributions.length) {
      const empty = document.createElement('div');
      empty.className = 'spectrum-pair-empty';
      empty.textContent = 'Active distributions need at least one electronic profile before window selection can be applied.';
      dom.selectionProfilePanel.appendChild(empty);
      syncSelectionControlsState();
      return;
    }

    for (const distribution of selectableDistributions) {
      const profiles = Array.isArray(distribution.electronicProfiles) ? distribution.electronicProfiles : [];
      if (!profiles.length) continue;
      const selectedProfileId = firstNonEmptyString(
        state.selectionProfilesByDistribution[distribution.id],
        distribution.defaultElectronicProfileId,
        profiles[0] && profiles[0].profileId
      );
      const selectedProfile = profiles.find((profile) => profile.profileId === selectedProfileId) || profiles[0];
      const item = document.createElement('div');
      item.className = 'selection-profile-item';

      const name = document.createElement('div');
      name.className = 'selection-profile-name';
      name.textContent = distribution.name;

      const select = document.createElement('select');
      select.dataset.selectionProfileDistributionId = distribution.id;
      select.disabled = !state.selectionEnabled;
      for (const profile of profiles) {
        const option = document.createElement('option');
        option.value = profile.profileId;
        option.textContent = profile.label;
        option.selected = profile.profileId === selectedProfile.profileId;
        select.appendChild(option);
      }

      const meta = document.createElement('div');
      meta.className = 'selection-profile-meta';
      meta.textContent = buildProfileSummaryText(selectedProfile) || selectedProfile.profileId;

      item.appendChild(name);
      item.appendChild(select);
      item.appendChild(meta);
      dom.selectionProfilePanel.appendChild(item);
    }
    syncSelectionControlsState();
  }

  function buildChip(text, modifier) {
    const chip = document.createElement('span');
    chip.className = modifier ? `chip ${modifier}` : 'chip';
    chip.textContent = String(text || '');
    return chip;
  }

  async function refreshDistributions(options = {}) {
    const preserveActive = options.preserveActive !== false;
    const autoActivateIds = Array.isArray(options.autoActivateIds) ? options.autoActivateIds : [];
    state.listInFlight = true;
    syncActionState();
    if (!state.uploadInFlight) {
      setListStatus('Loading cached distributions...', false);
    }
    try {
      const payload = await fetchPayload(state.endpoints.list, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
      const records = extractDistributionRecords(payload)
        .map((item, index) => normalizeDistributionRecord(item, index));
      const previousActiveIds = preserveActive ? new Set(state.activeIds) : new Set();
      const previousSpectrumSeriesKeys = preserveActive ? new Set(state.activeSpectrumSeriesKeys) : new Set();
      const previousSelectionProfiles = preserveActive ? { ...state.selectionProfilesByDistribution } : {};
      state.distributions = records;

      const nextActiveIds = new Set();
      const nextSpectrumSeriesKeys = new Set();
      const availableSpectrumSeriesKeys = records.flatMap((record) =>
        (Array.isArray(record.electronicProfiles) ? record.electronicProfiles : []).map((profile) => profile.seriesKey)
      );
      if (records.length) {
        if (previousActiveIds.size) {
          for (const record of records) {
            if (previousActiveIds.has(record.id)) nextActiveIds.add(record.id);
          }
        }
        if (previousSpectrumSeriesKeys.size) {
          for (const record of records) {
            for (const profile of (record.electronicProfiles || [])) {
              if (previousSpectrumSeriesKeys.has(profile.seriesKey)) {
                nextSpectrumSeriesKeys.add(profile.seriesKey);
              }
            }
          }
        }
        for (const id of autoActivateIds) {
          const record = records.find((item) => item.id === id);
          if (!record) continue;
          nextActiveIds.add(id);
          for (const profile of (record.electronicProfiles || [])) {
            nextSpectrumSeriesKeys.add(profile.seriesKey);
          }
        }
        if (!nextActiveIds.size) {
          for (const record of records) nextActiveIds.add(record.id);
        }
        if (!nextSpectrumSeriesKeys.size) {
          for (const key of availableSpectrumSeriesKeys) nextSpectrumSeriesKeys.add(key);
        }
      }
      state.activeIds = nextActiveIds;
      state.activeSpectrumSeriesKeys = nextSpectrumSeriesKeys;
      const nextSelectionProfiles = {};
      for (const record of records) {
        const profiles = Array.isArray(record.electronicProfiles) ? record.electronicProfiles : [];
        if (!profiles.length) continue;
        const availableProfileIds = new Set(profiles.map((profile) => profile.profileId));
        let selectedProfileId = firstNonEmptyString(
          previousSelectionProfiles[record.id],
          record.defaultElectronicProfileId
        );
        if (!selectedProfileId || !availableProfileIds.has(selectedProfileId)) {
          selectedProfileId = profiles[0].profileId;
        }
        nextSelectionProfiles[record.id] = selectedProfileId;
      }
      state.selectionProfilesByDistribution = nextSelectionProfiles;

      renderDistributionList();
      renderSelectionProfileControls();
      scheduleOverlayRefresh({ geometry: true, umap: true, immediate: true });
      await refreshSpectrumView();
      const distributionCount = records.length;
      setListStatus(
        distributionCount
          ? `Loaded ${distributionCount} cached distribution${distributionCount === 1 ? '' : 's'}.`
          : 'No cached distributions are available yet.',
        false
      );
    } catch (error) {
      state.distributions = [];
      state.activeIds = new Set();
      state.activeSpectrumSeriesKeys = new Set();
      state.lastCompareResult = null;
      state.lastUmapResult = null;
      state.lastSpectrumResult = null;
      state.spectrumPairOptions = [];
      state.selectedSpectrumPairKeys = new Set();
      state.selectionProfilesByDistribution = {};
      renderDistributionList();
      renderSelectionProfileControls();
      renderSpectrumPairOptions({
        availablePairs: [],
        emptyMessage: 'Unable to load transition pairs because the distribution list failed to load.',
      });
      clearPlot('Unable to load cached distributions from the backend.');
      clearUmapPlot('Unable to load cached distributions from the backend.');
      clearSpectrumPlot('Unable to load cached distributions from the backend.');
      clearSummary('Unable to load cached distributions from the backend.');
      setListStatus(`Failed to load distributions: ${error.message}`, true);
      setUmapStatus('Unable to render the SOAP UMAP projection because the distribution list failed to load.', true);
      setSpectrumPairStatus('Unable to load transition pairs because the distribution list failed to load.', true);
      setSpectrumStatus('Unable to render absorption spectra because the distribution list failed to load.', true);
    } finally {
      state.listInFlight = false;
      syncActionState();
    }
  }

  function clearSpectrumDataState() {
    state.lastSpectrumResult = null;
    state.spectrumPairOptions = [];
    state.selectedSpectrumPairKeys = new Set();
  }

  function resetSpectrumView(message, pairMessage, pairStatusMessage, spectrumStatusMessage) {
    clearSpectrumDataState();
    renderSpectrumPairOptions({
      availablePairs: [],
      emptyMessage: pairMessage,
    });
    clearSpectrumPlot(message);
    setSpectrumPairStatus(pairStatusMessage, false);
    setSpectrumStatus(spectrumStatusMessage, false);
  }

  function updateSpectrumPairStatus(options = {}) {
    const availablePairCount = Array.isArray(options.availablePairs) ? options.availablePairs.length : state.spectrumPairOptions.length;
    if (availablePairCount > 0) {
      setSpectrumPairStatus(
        `Showing ${availablePairCount} common transition pair${availablePairCount === 1 ? '' : 's'} across the selected spectrum series.`,
        false
      );
      return;
    }
    setSpectrumPairStatus(
      'No common valid transition pairs are shared by the selected spectrum series. Total spectra remain available.',
      false
    );
  }

  async function refreshSpectrumView() {
    if (!state.distributions.length) {
      resetSpectrumView(
        'Load one or more cached distributions to display absorption spectra.',
        'Load one or more electronic profiles to discover common transition pairs.',
        'Only common valid pairs across the selected spectrum series are listed here.',
        'Load one or more cached distributions with electronic profiles to display spectra.'
      );
      syncActionState();
      return;
    }

    const activeSpectrumSeries = getActiveSpectrumSeriesItems();
    if (!activeSpectrumSeries.length) {
      resetSpectrumView(
        'No electronic profiles are currently enabled for spectrum comparison.',
        'No spectrum profiles are selected, so no transition pairs are available.',
        'Only common valid pairs across the selected spectrum series are listed here.',
        'Enable one or more electronic profiles to display spectra.'
      );
      syncActionState();
      return;
    }

    let payload = null;
    try {
      payload = buildSpectrumPayload();
    } catch (error) {
      setSpectrumStatus(error.message, true);
      return;
    }

    const requestSeq = ++state.spectrumRequestSeq;
    state.spectrumCompareInFlight = true;
    syncActionState();
    setSpectrumStatus('Refreshing absorption spectra...', false);
    setSpectrumPairStatus('Refreshing common transition pairs...', false);
    try {
      const responsePayload = await fetchPayload(state.endpoints.compareSpectrum, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      if (requestSeq !== state.spectrumRequestSeq) return;
      const normalized = normalizeSpectrumResult(responsePayload, payload);
      if (!normalized.entries.length || !normalized.xEnergyEv.length) {
        throw new Error('The backend returned no absorption spectrum data for this request.');
      }
      state.spectrumPairOptions = Array.isArray(normalized.availablePairs) ? normalized.availablePairs : [];
      const validPairKeys = new Set(state.spectrumPairOptions.map((item) => item.key));
      state.selectedSpectrumPairKeys = new Set(
        Array.from(state.selectedSpectrumPairKeys).filter((key) => validPairKeys.has(key))
      );
      renderSpectrumPairOptions({ availablePairs: state.spectrumPairOptions });
      updateSpectrumPairStatus({ availablePairs: state.spectrumPairOptions });
      state.lastSpectrumResult = normalized;
      renderSpectrumPlot(normalized);
      setSpectrumStatus(buildSpectrumStatus(normalized), false);
    } catch (error) {
      if (requestSeq !== state.spectrumRequestSeq) return;
      const message = String(error?.message || '');
      if (message.includes('No selected spectrum series with valid electronic transitions')) {
        resetSpectrumView(
          'Selected electronic profiles do not currently contain valid transitions for absorption spectra.',
          'No common transition pairs are available because the selected electronic profiles have no valid transitions.',
          'Only common valid pairs across the selected spectrum series are listed here.',
          'None of the selected electronic profiles contain valid transitions for absorption spectra.'
        );
      } else {
        setSpectrumPairStatus(`Failed to refresh common transition pairs: ${message}`, true);
        setSpectrumStatus(`Failed to refresh absorption spectra: ${message}`, true);
      }
    } finally {
      if (requestSeq === state.spectrumRequestSeq) {
        state.spectrumCompareInFlight = false;
        syncActionState();
      }
    }
  }

  function scheduleOverlayRefresh(options = {}) {
    const immediate = options.immediate === true;
    if (options.geometry) overlayRefreshPending.geometry = true;
    if (options.umap) overlayRefreshPending.umap = true;
    if (!overlayRefreshPending.geometry && !overlayRefreshPending.umap) return;

    const flush = () => {
      overlayRefreshTimer = null;
      const pending = {
        geometry: overlayRefreshPending.geometry,
        umap: overlayRefreshPending.umap,
      };
      overlayRefreshPending = { geometry: false, umap: false };
      if (pending.geometry) {
        void refreshGeometryWindowView();
      }
      if (pending.umap) {
        void refreshUmapView();
      }
    };

    if (overlayRefreshTimer != null) {
      clearTimeout(overlayRefreshTimer);
      overlayRefreshTimer = null;
    }
    if (immediate) {
      flush();
      return;
    }
    overlayRefreshTimer = window.setTimeout(flush, 400);
  }

  function readWindowCenterValue() {
    const rawValue = firstFiniteNumber(dom.windowCenterEv && dom.windowCenterEv.value, DEFAULT_WINDOW_CENTER_EV);
    return Number.isFinite(rawValue) ? Number(rawValue) : DEFAULT_WINDOW_CENTER_EV;
  }

  function readWindowWidthValue() {
    const rawValue = firstFiniteNumber(dom.windowWidthEv && dom.windowWidthEv.value, DEFAULT_WINDOW_WIDTH_EV);
    return Number.isFinite(rawValue) ? Number(rawValue) : DEFAULT_WINDOW_WIDTH_EV;
  }

  function readWindowBounds() {
    const center = readWindowCenterValue();
    const width = readWindowWidthValue();
    if (!Number.isFinite(center) || !Number.isFinite(width) || width <= 0) return null;
    const halfWidth = width / 2;
    return {
      center,
      width,
      min: center - halfWidth,
      max: center + halfWidth,
    };
  }

  function clearGeometryWindowResult(message, statusMessage, isError = false) {
    state.lastCompareResult = null;
    clearPlot(message);
    clearSummary(message);
    setCompareStatus(statusMessage || message, isError);
  }

  function clearUmapResult(message, statusMessage, isError = false) {
    state.lastUmapResult = null;
    clearUmapPlot(message);
    setUmapStatus(statusMessage || message, isError);
  }

  function buildGeometryWindowPayload(selectionContext = getSelectionContext()) {
    const items = Array.isArray(selectionContext.eligibleItems) ? selectionContext.eligibleItems : [];
    if (!items.length) {
      throw new Error(
        'Selection is enabled, but none of the active distributions provide an electronic profile for window selection.'
      );
    }
    const measurement = collectMeasurementInputs();
    const windowCenterEv = parsePositiveFloatInput(dom.windowCenterEv, 'Window center');
    return {
      items: items.map((item) => ({
        distribution_id: item.distribution.id,
        profile_id: item.profile.profileId,
      })),
      measurement_kind: measurement.measurementKind,
      atom_indices: measurement.atomIndices,
      bins: Number.isFinite(measurement.histogramBins) ? measurement.histogramBins : 60,
      window_center_ev: windowCenterEv,
      window_width_ev: parsePositiveFloatInput(dom.windowWidthEv, 'Window width'),
    };
  }

  function buildUmapPayload(selectionContext = getSelectionContext()) {
    const items = Array.isArray(selectionContext.eligibleItems) ? selectionContext.eligibleItems : [];
    if (!items.length) {
      throw new Error(
        'Selection is enabled, but none of the active distributions provide an electronic profile for the SOAP UMAP projection.'
      );
    }
    return {
      items: items.map((item) => ({
        distribution_id: item.distribution.id,
        profile_id: item.profile.profileId,
      })),
      window_center_ev: parsePositiveFloatInput(dom.windowCenterEv, 'Window center'),
      window_width_ev: parsePositiveFloatInput(dom.windowWidthEv, 'Window width'),
      soap_atom_indices: [],
      soap_r_cut: DEFAULT_SOAP_R_CUT,
      soap_n_max: DEFAULT_SOAP_N_MAX,
      soap_l_max: DEFAULT_SOAP_L_MAX,
      soap_sigma: DEFAULT_SOAP_SIGMA,
      umap_n_neighbors: DEFAULT_UMAP_N_NEIGHBORS,
      umap_min_dist: DEFAULT_UMAP_MIN_DIST,
      umap_metric: DEFAULT_UMAP_METRIC,
      umap_random_state: DEFAULT_UMAP_RANDOM_STATE,
    };
  }

  function buildProjectSoapUmapPayload() {
    const activeIds = getActiveIds();
    if (!activeIds.length) {
      throw new Error('Enable at least one active distribution before requesting the SOAP UMAP projection.');
    }
    return {
      distribution_ids: activeIds,
      soap_atom_indices: [],
      soap_r_cut: DEFAULT_SOAP_R_CUT,
      soap_n_max: DEFAULT_SOAP_N_MAX,
      soap_l_max: DEFAULT_SOAP_L_MAX,
      soap_sigma: DEFAULT_SOAP_SIGMA,
      umap_n_neighbors: DEFAULT_UMAP_N_NEIGHBORS,
      umap_min_dist: DEFAULT_UMAP_MIN_DIST,
      umap_metric: DEFAULT_UMAP_METRIC,
      umap_random_state: DEFAULT_UMAP_RANDOM_STATE,
    };
  }

  async function refreshGeometryWindowView() {
    let payload = null;
    const selectionContext = getSelectionContext();
    try {
      payload = state.selectionEnabled
        ? buildGeometryWindowPayload(selectionContext)
        : buildComparePayload();
    } catch (error) {
      clearGeometryWindowResult(
        state.selectionEnabled
          ? 'Enable one or more active distributions with electronic profiles to display the windowed geometry comparison.'
          : 'Enable one or more active distributions to display the geometry comparison.',
        `${error.message}${state.selectionEnabled ? buildSkippedDistributionsText() : ''}`,
        true
      );
      return;
    }

    const requestSeq = ++state.compareRequestSeq;
    state.compareInFlight = true;
    syncActionState();
    setCompareStatus(
      state.selectionEnabled
        ? 'Refreshing all-vs-selected geometry comparison...'
        : 'Refreshing all-geometry comparison...',
      false
    );
    try {
      const responsePayload = await fetchPayload(
        state.selectionEnabled ? state.endpoints.compareGeometryWindow : state.endpoints.compareGeometry,
        {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        }
      );
      if (requestSeq !== state.compareRequestSeq) return;
      const normalized = normalizeCompareResult(responsePayload, payload);
      if (!normalized.entries.length) {
        throw new Error(
          state.selectionEnabled
            ? 'The backend returned no geometry distributions for the current window selection.'
            : 'The backend returned no geometry distributions for the active bundles.'
        );
      }
      normalized.selectionEnabled = state.selectionEnabled;
      normalized.skippedDistributions = state.selectionEnabled
        ? selectionContext.skippedDistributions.map((distribution) => distribution.name || distribution.id)
        : [];
      state.lastCompareResult = normalized;
      renderComparePlot(normalized);
      renderSummary(normalized);
      setCompareStatus(buildGeometryWindowStatus(normalized), false);
    } catch (error) {
      if (requestSeq !== state.compareRequestSeq) return;
      clearGeometryWindowResult(
        state.selectionEnabled
          ? 'Failed to render the windowed geometry comparison.'
          : 'Failed to render the geometry comparison.',
        `Failed to refresh the ${state.selectionEnabled ? 'windowed ' : ''}geometry comparison: ${error.message}`,
        true
      );
    } finally {
      if (requestSeq === state.compareRequestSeq) {
        state.compareInFlight = false;
        syncActionState();
      }
    }
  }

  async function refreshUmapView() {
    let payload = null;
    const selectionContext = getSelectionContext();
    try {
      payload = state.selectionEnabled
        ? buildUmapPayload(selectionContext)
        : buildProjectSoapUmapPayload();
    } catch (error) {
      clearUmapResult(
        state.selectionEnabled
          ? 'Enable one or more active distributions with electronic profiles to display the SOAP UMAP projection.'
          : 'Enable one or more active distributions to display the SOAP UMAP projection.',
        `${error.message}${state.selectionEnabled ? buildSkippedDistributionsText() : ''}`,
        true
      );
      return;
    }

    const requestSeq = ++state.umapRequestSeq;
    state.umapInFlight = true;
    syncActionState();
    setUmapStatus('Refreshing SOAP UMAP projection...', false);
    try {
      const responsePayload = await fetchPayload(
        state.selectionEnabled ? state.endpoints.projectSoapUmapWindow : state.endpoints.projectSoapUmap,
        {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        }
      );
      if (requestSeq !== state.umapRequestSeq) return;
      const normalized = normalizeUmapResult(responsePayload, payload);
      if (!normalized.points.length) {
        throw new Error('The backend returned no projected geometries for the SOAP UMAP request.');
      }
      normalized.selectionEnabled = state.selectionEnabled;
      normalized.skippedDistributions = state.selectionEnabled
        ? selectionContext.skippedDistributions.map((distribution) => distribution.name || distribution.id)
        : [];
      state.lastUmapResult = normalized;
      renderUmapPlot(normalized);
      setUmapStatus(buildUmapStatus(normalized), false);
    } catch (error) {
      if (requestSeq !== state.umapRequestSeq) return;
      clearUmapResult(
        'Failed to render the SOAP UMAP projection.',
        `Failed to refresh the SOAP UMAP projection: ${error.message}`,
        true
      );
    } finally {
      if (requestSeq === state.umapRequestSeq) {
        state.umapInFlight = false;
        syncActionState();
      }
    }
  }

  function extractUploadDistributionIds(payload) {
    const ids = [];
    if (payload && typeof payload === 'object') {
      const singular = firstNonEmptyString(payload.distribution_id, payload.id);
      if (singular) ids.push(singular);
      const records = extractDistributionRecords(payload);
      for (const item of records) {
        const id = firstNonEmptyString(item && item.distribution_id, item && item.id);
        if (id) ids.push(id);
      }
    }
    return Array.from(new Set(ids));
  }

  async function uploadBundle(file) {
    if (!(file instanceof File)) return;
    state.uploadInFlight = true;
    syncActionState();
    setFileName(file.name);
    setListStatus(`Uploading ${file.name}...`, false);
    setCompareStatus('Upload in progress. Comparison controls will remain available after refresh.', false);
    try {
      const payload = await fetchPayload(
        `${state.endpoints.load}?filename=${encodeURIComponent(file.name)}`,
        {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/octet-stream',
          },
          body: file,
        }
      );
      const uploadedIds = extractUploadDistributionIds(payload);
      await refreshDistributions({ preserveActive: true, autoActivateIds: uploadedIds });
      setListStatus(`Uploaded ${file.name} and refreshed the cached distribution list.`, false);
    } catch (error) {
      setListStatus(`Failed to upload ${file.name}: ${error.message}`, true);
    } finally {
      state.uploadInFlight = false;
      syncActionState();
      if (dom.fileInput) dom.fileInput.value = '';
    }
  }

  async function loadBrowsePath(path) {
    state.browseListInFlight = true;
    syncActionState();
    setFileBrowserStatus('Loading files...', false);
    try {
      const url = new URL(state.endpoints.browseFiles, window.location.origin);
      const normalizedPath = String(path || '').trim();
      if (normalizedPath) {
        url.searchParams.set('path', normalizedPath);
      }
      const payload = normalizeFileBrowserPayload(
        await fetchPayload(url.toString(), {
          method: 'GET',
          headers: { Accept: 'application/json' },
        })
      );
      fileBrowserCurrentPath = payload.currentPath || '';
      fileBrowserParentPath = payload.parentPath;
      if (dom.fileBrowserRoot) dom.fileBrowserRoot.textContent = `Root: ${payload.rootLabel || ''}`;
      if (dom.fileBrowserPath) dom.fileBrowserPath.textContent = fileBrowserCurrentPath ? `/${fileBrowserCurrentPath}` : '/';
      renderFileBrowserEntries(payload.entries);
      setFileBrowserStatus('', false);
    } catch (error) {
      renderFileBrowserEntries([]);
      setFileBrowserStatus(`Failed to load server files: ${error.message}`, true);
    } finally {
      state.browseListInFlight = false;
      syncActionState();
    }
  }

  async function loadBundleFromPath(relativePath) {
    const normalizedPath = String(relativePath || '').trim();
    if (!normalizedPath) return;
    state.pathLoadInFlight = true;
    syncActionState();
    setFileBrowserStatus(`Importing ${normalizedPath}...`, false);
    setListStatus(`Importing ${normalizedPath} from server...`, false);
    setFileName(basename(normalizedPath) || normalizedPath);
    try {
      const payload = await fetchPayload(state.endpoints.loadByPath, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ path: normalizedPath }),
      });
      const uploadedIds = extractUploadDistributionIds(payload);
      await refreshDistributions({ preserveActive: true, autoActivateIds: uploadedIds });
      setFileBrowserStatus(`Imported ${normalizedPath}.`, false);
      setListStatus(`Imported ${normalizedPath} from server and refreshed the cached distribution list.`, false);
      setFileBrowserOpen(false);
    } catch (error) {
      setFileBrowserStatus(`Failed to import ${normalizedPath}: ${error.message}`, true);
      setListStatus(`Failed to import ${normalizedPath}: ${error.message}`, true);
    } finally {
      state.pathLoadInFlight = false;
      syncActionState();
    }
  }

  function parseNonNegativeIntegerInput(inputEl, label) {
    const text = String(inputEl?.value || '').trim();
    if (!text) {
      throw new Error(`${label} is required.`);
    }
    const value = Number.parseInt(text, 10);
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`${label} must be a non-negative integer.`);
    }
    return value;
  }

  function parseHistogramBinCount() {
    const text = String(dom.histogramBins?.value || '').trim();
    if (!text) return null;
    const value = Number.parseInt(text, 10);
    if (!Number.isFinite(value) || value < 5) {
      throw new Error('Histogram bins must be an integer greater than or equal to 5.');
    }
    return Math.min(value, 400);
  }

  function parsePositiveFloatInput(inputEl, label) {
    const text = String(inputEl?.value || '').trim();
    if (!text) {
      throw new Error(`${label} is required.`);
    }
    const value = Number(text);
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`${label} must be a positive number.`);
    }
    return value;
  }

  function collectMeasurementInputs() {
    const kind = String(dom.measurementKind?.value || 'bond');
    const atomCount = measurementAtomCount(kind);
    const labels = ['Atom i', 'Atom j', 'Atom k', 'Atom l'];
    const inputs = [dom.atom0, dom.atom1, dom.atom2, dom.atom3];
    const atomIndices = [];
    for (let index = 0; index < atomCount; index++) {
      atomIndices.push(parseNonNegativeIntegerInput(inputs[index], labels[index]));
    }
    const duplicateCount = new Set(atomIndices).size;
    if (kind === 'bond' && duplicateCount !== atomIndices.length) {
      throw new Error('Bond atom indices must refer to two distinct atoms.');
    }
    const knownAtomCounts = uniqueSortedNumbers(
      state.distributions
        .filter((distribution) => state.activeIds.has(distribution.id))
        .map((distribution) => distribution.atomCount)
    );
    if (knownAtomCounts.length > 1) {
      throw new Error('Active distributions report different atom counts and should not be compared together.');
    }
    if (knownAtomCounts.length === 1 && atomIndices.some((value) => value >= knownAtomCounts[0])) {
      throw new Error(`Atom indices must be smaller than ${knownAtomCounts[0]}.`);
    }
    return {
      measurementKind: kind,
      atomIndices,
      histogramBins: parseHistogramBinCount(),
    };
  }

  function buildComparePayload() {
    const activeIds = getActiveIds();
    if (!activeIds.length) {
      throw new Error('Enable at least one cached distribution before requesting a comparison.');
    }
    const measurement = collectMeasurementInputs();
    const payload = {
      distribution_ids: activeIds,
      measurement_kind: measurement.measurementKind,
      atom_indices: measurement.atomIndices,
    };
    if (Number.isFinite(measurement.histogramBins)) {
      payload.bins = measurement.histogramBins;
    }
    return payload;
  }

  function buildSpectrumPayload() {
    const activeSpectrumSeries = getActiveSpectrumSeriesItems();
    if (!activeSpectrumSeries.length) {
      throw new Error('Enable at least one electronic profile before displaying absorption spectra.');
    }

    const deltaEv = parsePositiveFloatInput(dom.spectrumDeltaEv, 'Lorentzian delta');
    if (deltaEv > 1) {
      throw new Error('Lorentzian delta must be less than or equal to 1 eV.');
    }
    return {
      series: activeSpectrumSeries.map((item) => ({
        distribution_id: item.distribution.id,
        profile_id: item.profile.profileId,
      })),
      delta_ev: deltaEv,
    };
  }

  function normalizeHistogram(rawItem) {
    const source = rawItem && typeof rawItem === 'object' && rawItem.histogram && typeof rawItem.histogram === 'object'
      ? rawItem.histogram
      : rawItem;
    if (!source || typeof source !== 'object') return null;
    const counts = coerceNumberArray(source.counts || source.bin_counts || source.hist || source.y);
    if (!counts.length) return null;
    const binCenters = coerceNumberArray(source.bin_centers || source.centers || source.bin_center);
    const binEdges = coerceNumberArray(source.bin_edges || source.edges || source.bins);
    if (binCenters.length === counts.length) {
      return { counts, x: binCenters, binEdges };
    }
    if (binEdges.length === counts.length + 1) {
      const centers = [];
      for (let index = 0; index < counts.length; index++) {
        centers.push((binEdges[index] + binEdges[index + 1]) / 2);
      }
      return { counts, x: centers, binEdges };
    }
    return null;
  }

  function computeQuantile(sortedValues, fraction) {
    if (!Array.isArray(sortedValues) || !sortedValues.length) return null;
    if (sortedValues.length === 1) return sortedValues[0];
    const clamped = Math.max(0, Math.min(1, Number(fraction)));
    const index = (sortedValues.length - 1) * clamped;
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    if (lower === upper) return sortedValues[lower];
    const weight = index - lower;
    return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
  }

  function summarizeValues(values) {
    if (!Array.isArray(values) || !values.length) return null;
    const sorted = values.slice().sort((a, b) => a - b);
    const count = sorted.length;
    const sum = sorted.reduce((accumulator, value) => accumulator + value, 0);
    const mean = sum / count;
    let variance = 0;
    if (count > 1) {
      for (const value of sorted) {
        variance += (value - mean) ** 2;
      }
      variance /= (count - 1);
    }
    return {
      count,
      min: sorted[0],
      max: sorted[count - 1],
      mean,
      std: count > 1 ? Math.sqrt(variance) : 0,
      p05: computeQuantile(sorted, 0.05),
      p50: computeQuantile(sorted, 0.5),
      p95: computeQuantile(sorted, 0.95),
    };
  }

  function summarizeHistogram(histogram) {
    if (!histogram || !Array.isArray(histogram.counts) || !Array.isArray(histogram.x) || !histogram.counts.length) {
      return null;
    }
    let count = 0;
    let weightedSum = 0;
    for (let index = 0; index < histogram.counts.length; index++) {
      const y = Number(histogram.counts[index]);
      const x = Number(histogram.x[index]);
      if (!Number.isFinite(y) || !Number.isFinite(x)) continue;
      count += y;
      weightedSum += x * y;
    }
    if (!count) return null;
    const mean = weightedSum / count;
    let weightedVariance = 0;
    for (let index = 0; index < histogram.counts.length; index++) {
      const y = Number(histogram.counts[index]);
      const x = Number(histogram.x[index]);
      if (!Number.isFinite(y) || !Number.isFinite(x)) continue;
      weightedVariance += ((x - mean) ** 2) * y;
    }
    const firstEdge = Array.isArray(histogram.binEdges) && histogram.binEdges.length ? histogram.binEdges[0] : histogram.x[0];
    const lastEdge = Array.isArray(histogram.binEdges) && histogram.binEdges.length
      ? histogram.binEdges[histogram.binEdges.length - 1]
      : histogram.x[histogram.x.length - 1];
    return {
      count,
      min: Number(firstEdge),
      max: Number(lastEdge),
      mean,
      std: Math.sqrt(weightedVariance / count),
      p05: null,
      p50: null,
      p95: null,
    };
  }

  function normalizeSummary(rawSummary, values, histogram) {
    const raw = rawSummary && typeof rawSummary === 'object' ? rawSummary : {};
    const fallback = values.length ? summarizeValues(values) : summarizeHistogram(histogram);
    return {
      count: firstFiniteNumber(raw.count, raw.n, raw.sample_count, fallback && fallback.count),
      min: firstFiniteNumber(raw.min, raw.minimum, fallback && fallback.min),
      max: firstFiniteNumber(raw.max, raw.maximum, fallback && fallback.max),
      mean: firstFiniteNumber(raw.mean, raw.avg, raw.average, fallback && fallback.mean),
      std: firstFiniteNumber(raw.std, raw.stdev, raw.sigma, fallback && fallback.std),
      p05: firstFiniteNumber(raw.p05, raw.q05, raw.percentile_05, fallback && fallback.p05),
      p50: firstFiniteNumber(raw.p50, raw.median, raw.q50, fallback && fallback.p50),
      p95: firstFiniteNumber(raw.p95, raw.q95, raw.percentile_95, fallback && fallback.p95),
    };
  }

  function lookupDistributionName(distributionId, fallbackName) {
    const match = state.distributions.find((item) => item.id === distributionId);
    return match ? match.name : (fallbackName || distributionId || 'distribution');
  }

  function lookupDistributionFilename(distributionId) {
    const match = state.distributions.find((item) => item.id === distributionId);
    return match ? match.sourceFilename : '';
  }

  function normalizeCompareEntry(rawItem, index) {
    const raw = rawItem && typeof rawItem === 'object' ? rawItem : {};
    const distributionId = firstNonEmptyString(raw.distribution_id, raw.id, raw.key, raw.uid) || `series-${index + 1}`;
    const allValues = coerceNumberArray(
      raw.all_values ||
      raw.values ||
      raw.measurement_values ||
      raw.measurements ||
      raw.samples ||
      raw.data
    );
    const selectedValues = coerceNumberArray(
      raw.selected_values ||
      raw.selected_measurements ||
      raw.selected ||
      raw.window_selected_values
    );
    const histogram = normalizeHistogram(raw);
    if (!allValues.length && !histogram) return null;
    const sourceFilename = firstNonEmptyString(
      raw.source_filename,
      raw.file_name,
      raw.filename,
      lookupDistributionFilename(distributionId)
    );
    const name = firstNonEmptyString(
      raw.name,
      raw.label,
      raw.display_name,
      lookupDistributionName(distributionId, ''),
      basename(sourceFilename),
      distributionId
    );
    return {
      id: distributionId,
      name,
      sourceFilename,
      profileId: firstNonEmptyString(raw.profile_id),
      profileLabel: firstNonEmptyString(raw.profile_label),
      values: allValues,
      allValues,
      selectedValues,
      histogram,
      allSummary: normalizeSummary(
        raw.all_summary || raw.summary || raw.stats || raw.statistics,
        allValues,
        histogram
      ),
      selectedSummary: normalizeSummary(
        raw.selected_summary || raw.selected_stats || raw.selected_statistics,
        selectedValues,
        null
      ),
      selectedCount: firstFiniteNumber(
        raw.selected_count,
        raw.selection_count,
        selectedValues.length
      ) || 0,
      selectedFraction: firstFiniteNumber(
        raw.selected_fraction,
        allValues.length > 0 ? (selectedValues.length / allValues.length) : 0
      ) || 0,
      effectiveSampleSize: firstFiniteNumber(raw.effective_sample_size, raw.ess, 0) || 0,
      meanSelectionWeight: firstFiniteNumber(raw.mean_selection_weight, 0) || 0,
      maxSelectionWeight: firstFiniteNumber(raw.max_selection_weight, 0) || 0,
      summary: normalizeSummary(
        raw.all_summary || raw.summary || raw.stats || raw.statistics,
        allValues,
        histogram
      ),
    };
  }

  function extractCompareEntries(payload) {
    if (Array.isArray(payload)) return payload;
    if (!payload || typeof payload !== 'object') return [];
    if (Array.isArray(payload.distributions)) return payload.distributions;
    if (Array.isArray(payload.series)) return payload.series;
    if (Array.isArray(payload.traces)) return payload.traces;
    if (Array.isArray(payload.items)) return payload.items;
    if (Array.isArray(payload.results)) return payload.results;
    if (Array.isArray(payload.datasets)) return payload.datasets;
    return [];
  }

  function normalizeAtomIndices(rawValue) {
    if (!Array.isArray(rawValue)) return [];
    return rawValue
      .map((value) => Number.parseInt(String(value), 10))
      .filter((value) => Number.isFinite(value) && value >= 0);
  }

  function normalizeCompareResult(payload, fallbackRequest) {
    const entries = extractCompareEntries(payload)
      .map((item, index) => normalizeCompareEntry(item, index))
      .filter(Boolean);
    const measurementKind = firstNonEmptyString(
      payload && payload.measurement_kind,
      payload && payload.kind,
      payload && payload.measurement && payload.measurement.kind,
      fallbackRequest && fallbackRequest.measurement_kind,
      dom.measurementKind && dom.measurementKind.value
    ) || 'bond';
    const atomIndices = normalizeAtomIndices(
      (payload && payload.atom_indices) ||
      (payload && payload.indices) ||
      (payload && payload.measurement && payload.measurement.atom_indices) ||
      (fallbackRequest && fallbackRequest.atom_indices) ||
      []
    );
    const unit = firstNonEmptyString(
      payload && payload.unit,
      payload && payload.units,
      payload && payload.measurement && payload.measurement.unit
    ) || defaultUnitForKind(measurementKind);
    return {
      measurementKind,
      atomIndices,
      unit,
      bins: firstFiniteNumber(payload && payload.bins, fallbackRequest && fallbackRequest.bins),
      windowCenterEv: firstFiniteNumber(payload && payload.window_center_ev, fallbackRequest && fallbackRequest.window_center_ev),
      windowWidthEv: firstFiniteNumber(payload && payload.window_width_ev, fallbackRequest && fallbackRequest.window_width_ev),
      windowMinEv: firstFiniteNumber(payload && payload.window_min_ev),
      windowMaxEv: firstFiniteNumber(payload && payload.window_max_ev),
      selectionMode: firstNonEmptyString(payload && payload.selection_mode, 'none') || 'none',
      entries,
    };
  }

  function normalizeUmapPoint(rawItem) {
    const raw = rawItem && typeof rawItem === 'object' ? rawItem : {};
    const distributionId = firstNonEmptyString(raw.distribution_id, raw.id, raw.key, raw.uid);
    const profileId = firstNonEmptyString(raw.profile_id, raw.profile);
    const x = firstFiniteNumber(raw.x);
    const y = firstFiniteNumber(raw.y);
    if (!distributionId || !profileId || !Number.isFinite(x) || !Number.isFinite(y)) return null;
    return {
      distributionId,
      distributionLabel: firstNonEmptyString(raw.distribution_label, lookupDistributionName(distributionId, '')) || distributionId,
      profileId,
      profileLabel: firstNonEmptyString(raw.profile_label, profileId),
      sampleIndex: firstFiniteNumber(raw.sample_index, 0) || 0,
      sampleId: firstNonEmptyString(raw.sample_id, `sample-${raw.sample_index || 0}`),
      x: Number(x),
      y: Number(y),
      selectionWeight: firstFiniteNumber(raw.selection_weight, 0) || 0,
      normalizedSelectionWeight: firstFiniteNumber(raw.normalized_selection_weight, 0) || 0,
      hardSelected: !!raw.hard_selected,
    };
  }

  function normalizeUmapResult(payload, fallbackRequest) {
    const rawProjectionMeta = payload && payload.projection_meta && typeof payload.projection_meta === 'object'
      ? payload.projection_meta
      : {};
    const rawSelectionMeta = payload && payload.selection_meta && typeof payload.selection_meta === 'object'
      ? payload.selection_meta
      : {};
    const rawDistributions = Array.isArray(payload && payload.distributions) ? payload.distributions : [];
    return {
      points: Array.isArray(payload && payload.points)
        ? payload.points.map((item) => normalizeUmapPoint(item)).filter(Boolean)
        : [],
      projectionMeta: {
        method: firstNonEmptyString(rawProjectionMeta.method, 'umap') || 'umap',
        featureKind: firstNonEmptyString(rawProjectionMeta.feature_kind, 'soap_atomwise_pooled') || 'soap_atomwise_pooled',
        axisLabels: Array.isArray(rawProjectionMeta.axis_labels)
          ? rawProjectionMeta.axis_labels.map((value) => String(value))
          : ['UMAP 1', 'UMAP 2'],
        featureDimension: firstFiniteNumber(rawProjectionMeta.feature_dimension, 0) || 0,
      },
      selectionMeta: {
        windowCenterEv: firstFiniteNumber(rawSelectionMeta.window_center_ev, fallbackRequest && fallbackRequest.window_center_ev),
        windowWidthEv: firstFiniteNumber(rawSelectionMeta.window_width_ev, fallbackRequest && fallbackRequest.window_width_ev),
        windowMinEv: firstFiniteNumber(rawSelectionMeta.window_min_ev),
        windowMaxEv: firstFiniteNumber(rawSelectionMeta.window_max_ev),
        selectionMode: firstNonEmptyString(rawSelectionMeta.selection_mode, 'none') || 'none',
        topologySignature: firstNonEmptyString(rawSelectionMeta.topology_signature),
      },
      distributions: rawDistributions
        .map((item) => {
          const raw = item && typeof item === 'object' ? item : {};
          const distributionId = firstNonEmptyString(raw.distribution_id);
          if (!distributionId) return null;
          return {
            distributionId,
            distributionLabel: firstNonEmptyString(raw.distribution_label, lookupDistributionName(distributionId, '')) || distributionId,
            profileId: firstNonEmptyString(raw.profile_id),
            profileLabel: firstNonEmptyString(raw.profile_label),
            totalCount: firstFiniteNumber(raw.total_count, 0) || 0,
            selectedCount: firstFiniteNumber(raw.selected_count, 0) || 0,
            selectedFraction: firstFiniteNumber(raw.selected_fraction, 0) || 0,
            effectiveSampleSize: firstFiniteNumber(raw.effective_sample_size, 0) || 0,
            droppedCount: firstFiniteNumber(raw.dropped_count, 0) || 0,
          };
        })
        .filter(Boolean),
    };
  }

  function normalizeSpectrumSeries(rawItem, index) {
    const raw = rawItem && typeof rawItem === 'object' ? rawItem : {};
    const distributionId = firstNonEmptyString(raw.distribution_id, raw.id, raw.key, raw.uid) || `spectrum-${index + 1}`;
    const profileId = firstNonEmptyString(raw.profile_id, raw.profile, raw.profile_key, raw.series_profile_id) || `profile-${index + 1}`;
    const totalYNormalized = coerceNumberArray(
      raw.total_y_normalized || raw.total || raw.y_normalized || raw.y || raw.values || raw.data
    );
    if (!totalYNormalized.length) return null;
    const sourceFilename = firstNonEmptyString(
      raw.source_filename,
      raw.source_name,
      raw.file_name,
      raw.filename,
      lookupDistributionFilename(distributionId)
    );
    const distributionLabel = firstNonEmptyString(
      raw.distribution_label,
      lookupDistributionName(distributionId, '')
    );
    const profileLabel = firstNonEmptyString(raw.profile_label, raw.profile_name, profileId);
    const name = firstNonEmptyString(
      raw.series_label,
      raw.name,
      raw.label,
      raw.display_name,
      distributionLabel && profileLabel ? `${distributionLabel} | ${profileLabel}` : '',
      basename(sourceFilename),
      spectrumSeriesKey(distributionId, profileId)
    );
    const pairCurves = Array.isArray(raw.pair_curves)
      ? raw.pair_curves
          .map((item) => {
            const pairRaw = item && typeof item === 'object' ? item : {};
            const pair = normalizeSpectrumPair(pairRaw.pair || []);
            const yNormalized = coerceNumberArray(pairRaw.y_normalized || pairRaw.y || pairRaw.values || pairRaw.data);
            if (!pair || !yNormalized.length) return null;
            return {
              pair,
              key: pairKey(pair),
              label: formatTransitionPair(pair),
              yNormalized,
            };
          })
          .filter(Boolean)
      : [];
    return {
      id: spectrumSeriesKey(distributionId, profileId),
      distributionId,
      profileId,
      distributionLabel,
      profileLabel,
      name,
      sourceFilename,
      totalYNormalized,
      pairCurves,
    };
  }

  function normalizeSpectrumSkipped(rawItem) {
    const raw = rawItem && typeof rawItem === 'object' ? rawItem : {};
    const distributionId = firstNonEmptyString(raw.distribution_id, raw.id, raw.key, raw.uid);
    const profileId = firstNonEmptyString(raw.profile_id, raw.profile);
    const distributionLabel = firstNonEmptyString(
      raw.distribution_label,
      lookupDistributionName(distributionId, '')
    );
    const profileLabel = firstNonEmptyString(raw.profile_label, profileId);
    const reason = firstNonEmptyString(raw.reason, raw.detail, raw.message);
    if (!distributionId && !distributionLabel && !profileId && !profileLabel && !reason) return null;
    return {
      id: spectrumSeriesKey(distributionId, profileId),
      distributionId,
      profileId,
      label: distributionLabel && profileLabel ? `${distributionLabel} | ${profileLabel}` : (distributionLabel || profileLabel || ''),
      reason: reason || 'skipped',
    };
  }

  function normalizeSpectrumResult(payload, fallbackRequest) {
    const rawSeries = Array.isArray(payload && payload.series) ? payload.series : [];
    const rawSkipped = Array.isArray(payload && payload.skipped) ? payload.skipped : [];
    return {
      deltaEv: firstFiniteNumber(payload && payload.delta_ev, fallbackRequest && fallbackRequest.delta_ev),
      xEnergyEv: coerceNumberArray(payload && payload.x_energy_ev),
      availablePairs: normalizeSpectrumPairOptionsPayload(payload).availablePairs,
      entries: rawSeries
        .map((item, index) => normalizeSpectrumSeries(item, index))
        .filter(Boolean),
      skipped: rawSkipped
        .map((item) => normalizeSpectrumSkipped(item))
        .filter(Boolean),
    };
  }

  function formatMeasurementValue(value, kind) {
    if (value == null) return 'n/a';
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 'n/a';
    if (kind === 'bond') return numeric.toFixed(4);
    return numeric.toFixed(2);
  }

  function buildTraceColor(index) {
    if (TRACE_PALETTE[index]) return TRACE_PALETTE[index];
    const accent = readCssVar('--accent', '#0f5dcf');
    if (!accent) return '#2563eb';
    return accent;
  }

  function buildPairTraceColor(index) {
    if (PAIR_TRACE_PALETTE[index]) return PAIR_TRACE_PALETTE[index];
    return buildTraceColor(index);
  }

  function buildDistributionDashPattern(index) {
    return DISTRIBUTION_DASH_PATTERNS[index % DISTRIBUTION_DASH_PATTERNS.length];
  }

  function renderComparePlot(result) {
    if (!dom.plot) return;
    if (typeof Plotly === 'undefined') {
      clearPlot('Plot unavailable because Plotly failed to load.');
      return;
    }
    if (!result || !Array.isArray(result.entries) || !result.entries.length) {
      clearPlot('No comparison data was returned for the active distributions.');
      return;
    }
    clearEmptyPlotPlaceholder(dom.plot);
    const plotColors = getPlotColors();
    const requestedBins = Number.parseInt(String(dom.histogramBins?.value || ''), 10);
    const traces = [];
    result.entries.forEach((entry, index) => {
      const color = buildTraceColor(index);
      if (entry.allValues.length) {
        const allTrace = {
          type: 'histogram',
          name: `${entry.name} all`,
          x: entry.allValues,
          legendgroup: entry.id,
          opacity: result.entries.length > 1 ? 0.32 : 0.46,
          marker: {
            color,
            line: {
              color: plotColors.traceMutedColor || 'rgba(120,120,120,0.35)',
              width: 1,
            },
          },
          hovertemplate:
            `${entry.name} all` +
            `<br>value=%{x:.4f}` +
            `<br>count=%{y}` +
            '<extra></extra>',
        };
        if (Number.isFinite(requestedBins) && requestedBins >= 5) {
          allTrace.nbinsx = requestedBins;
        }
        traces.push(allTrace);
      }
      if (entry.selectedValues.length) {
        const selectedTrace = {
          type: 'histogram',
          name: `${entry.name} selected`,
          x: entry.selectedValues,
          legendgroup: entry.id,
          opacity: 0.82,
          marker: {
            color,
            line: {
              color: readCssVar('--text', '#172033'),
              width: 1.2,
            },
          },
          hovertemplate:
            `${entry.name} selected` +
            `<br>value=%{x:.4f}` +
            `<br>count=%{y}` +
            '<extra></extra>',
        };
        if (Number.isFinite(requestedBins) && requestedBins >= 5) {
          selectedTrace.nbinsx = requestedBins;
        }
        traces.push(selectedTrace);
      }
      if (!entry.allValues.length && entry.histogram) {
        traces.push({
        type: 'bar',
        name: `${entry.name} all`,
        x: entry.histogram.x,
        y: entry.histogram.counts,
        opacity: result.entries.length > 1 ? 0.46 : 0.72,
        marker: {
          color,
          line: {
            color: plotColors.traceMutedColor || 'rgba(120,120,120,0.35)',
            width: 1,
          },
        },
        hovertemplate:
          `${entry.name} all` +
          `<br>center=%{x:.4f}` +
          `<br>count=%{y}` +
          '<extra></extra>',
        });
      }
    });

    const atomLabel = result.atomIndices.length ? ` [${result.atomIndices.join(', ')}]` : '';
    const windowLabel = result.selectionMode !== 'none' && Number.isFinite(result.windowMinEv) && Number.isFinite(result.windowMaxEv)
      ? `window ${Number(result.windowMinEv).toFixed(2)}-${Number(result.windowMaxEv).toFixed(2)} eV`
      : '';
    const layout = mergePlotlyLayout({
      height: 408,
      margin: { l: 58, r: 20, t: 18, b: 54 },
      barmode: 'overlay',
      bargap: 0.06,
      hovermode: 'closest',
      showlegend: true,
      legend: {
        orientation: 'h',
        x: 0,
        xanchor: 'left',
        y: 1.14,
        yanchor: 'bottom',
      },
      xaxis: {
        title: measurementAxisTitle(result.measurementKind, result.unit),
        showline: true,
        mirror: 'ticks',
        ticks: 'outside',
      },
      yaxis: {
        title: 'Count',
        showline: true,
        mirror: 'ticks',
        ticks: 'outside',
        rangemode: 'tozero',
      },
      annotations: [
        {
          xref: 'paper',
          yref: 'paper',
          x: 1,
          y: 1.16,
          xanchor: 'right',
          yanchor: 'bottom',
          showarrow: false,
          text: [result.measurementKind, atomLabel.trim(), windowLabel].filter(Boolean).join(' '),
          font: { size: 12, color: readCssVar('--muted', '#64748b') },
        },
      ],
    });

    Plotly.react(
      dom.plot,
      traces,
      layout,
      {
        responsive: true,
        displaylogo: false,
        toImageButtonOptions: { format: 'png', scale: PLOT_EXPORT_SCALE },
      }
    );
  }

  function buildGeometryWindowStatus(result) {
    const entryCount = Array.isArray(result?.entries) ? result.entries.length : 0;
    if (!entryCount) {
      return result?.selectionMode === 'none'
        ? 'No geometry comparison result available.'
        : 'No windowed geometry comparison result available.';
    }
    const skipped = Array.isArray(result?.skippedDistributions) ? result.skippedDistributions : [];
    if (result?.selectionMode === 'none') {
      let text = `Rendered ${entryCount} distribution${entryCount === 1 ? '' : 's'} using all geometries.`;
      if (skipped.length) {
        text += ` Skipped ${skipped.length} bundle${skipped.length === 1 ? '' : 's'} without electronic profiles.`;
      }
      return text;
    }
    const selectedCount = result.entries.reduce((accumulator, entry) => accumulator + Number(entry.selectedCount || 0), 0);
    const totalCount = result.entries.reduce((accumulator, entry) => accumulator + Number(entry.allSummary?.count || entry.allValues?.length || 0), 0);
    let text = `Rendered ${entryCount} distribution${entryCount === 1 ? '' : 's'} with ${selectedCount} selected geometr${selectedCount === 1 ? 'y' : 'ies'}.`;
    if (totalCount > 0) {
      text += ` Selected fraction ${(100 * selectedCount / totalCount).toFixed(1)}%.`;
    }
    if (Number.isFinite(result.windowMinEv) && Number.isFinite(result.windowMaxEv)) {
      text += ` Window ${Number(result.windowMinEv).toFixed(2)}-${Number(result.windowMaxEv).toFixed(2)} eV.`;
    }
    if (skipped.length) {
      text += ` Skipped ${skipped.length} bundle${skipped.length === 1 ? '' : 's'} without electronic profiles.`;
    }
    return text;
  }

  function buildUmapStatus(result) {
    const pointCount = Array.isArray(result?.points) ? result.points.length : 0;
    if (!pointCount) return 'No SOAP UMAP projection is available.';
    const skipped = Array.isArray(result?.skippedDistributions) ? result.skippedDistributions : [];
    if (result?.selectionMeta?.selectionMode === 'none') {
      let text = `Projected ${pointCount} geometr${pointCount === 1 ? 'y' : 'ies'} into a joint SOAP UMAP map using all geometries.`;
      if (skipped.length) {
        text += ` Skipped ${skipped.length} bundle${skipped.length === 1 ? '' : 's'} without electronic profiles.`;
      }
      return text;
    }
    const selectedCount = result.points.filter((point) => point.hardSelected || point.normalizedSelectionWeight > 0).length;
    let text = `Projected ${pointCount} geometr${pointCount === 1 ? 'y' : 'ies'} into a joint SOAP UMAP map.`;
    if (selectedCount > 0) {
      text += ` Highlighted ${selectedCount} window-selected geometr${selectedCount === 1 ? 'y' : 'ies'}.`;
    }
    if (skipped.length) {
      text += ` Skipped ${skipped.length} bundle${skipped.length === 1 ? '' : 's'} without electronic profiles.`;
    }
    return text;
  }

  function renderUmapPlot(result) {
    if (!dom.umapPlot) return;
    if (typeof Plotly === 'undefined') {
      clearUmapPlot('Plot unavailable because Plotly failed to load.');
      return;
    }
    if (!result || !Array.isArray(result.points) || !result.points.length) {
      clearUmapPlot('No SOAP UMAP projection data was returned for the active distributions.');
      return;
    }
    clearEmptyPlotPlaceholder(dom.umapPlot);

    const traces = [];
    const groupedPoints = new Map();
    for (const point of result.points) {
      if (!groupedPoints.has(point.distributionId)) {
        groupedPoints.set(point.distributionId, []);
      }
      groupedPoints.get(point.distributionId).push(point);
    }

    Array.from(groupedPoints.entries()).forEach(([distributionId, points], index) => {
      const color = buildTraceColor(index);
      const label = firstNonEmptyString(points[0] && points[0].distributionLabel, distributionId) || distributionId;
      traces.push({
        type: 'scattergl',
        mode: 'markers',
        name: `${label} all`,
        legendgroup: distributionId,
        x: points.map((point) => point.x),
        y: points.map((point) => point.y),
        customdata: points.map((point) => [
          point.profileLabel,
          point.sampleIndex,
          point.sampleId,
        ]),
        marker: {
          color,
          size: 8,
          opacity: 0.28,
        },
        hovertemplate:
          `${label} all` +
          '<br>profile=%{customdata[0]}' +
          '<br>sample=%{customdata[2]}' +
          '<br>sample index=%{customdata[1]}' +
          '<br>x=%{x:.4f}' +
          '<br>y=%{y:.4f}' +
          '<extra></extra>',
      });

      const selectedPoints = points.filter((point) => point.hardSelected || point.normalizedSelectionWeight > 0);
      if (!selectedPoints.length) return;
      traces.push({
        type: 'scattergl',
        mode: 'markers',
        name: `${label} selected`,
        legendgroup: distributionId,
        x: selectedPoints.map((point) => point.x),
        y: selectedPoints.map((point) => point.y),
        customdata: selectedPoints.map((point) => [
          point.profileLabel,
          point.sampleIndex,
          point.sampleId,
          Number(point.normalizedSelectionWeight || 0),
          Number(point.selectionWeight || 0),
        ]),
        marker: {
          color,
          opacity: 0.92,
          size: selectedPoints.map((point) => 10 + 18 * Math.max(Number(point.normalizedSelectionWeight || 0), 0)),
          line: {
            color: readCssVar('--text', '#172033'),
            width: 0.8,
          },
        },
        hovertemplate:
          `${label} selected` +
          '<br>profile=%{customdata[0]}' +
          '<br>sample=%{customdata[2]}' +
          '<br>sample index=%{customdata[1]}' +
          '<br>x=%{x:.4f}' +
          '<br>y=%{y:.4f}' +
          '<br>normalized weight=%{customdata[3]:.4f}' +
          '<br>selection weight=%{customdata[4]:.4f}' +
          '<extra></extra>',
      });
    });

    const layout = mergePlotlyLayout({
      height: 420,
      margin: { l: 58, r: 20, t: 18, b: 54 },
      hovermode: 'closest',
      showlegend: true,
      legend: {
        orientation: 'h',
        x: 0,
        xanchor: 'left',
        y: 1.14,
        yanchor: 'bottom',
      },
      xaxis: {
        title: result.projectionMeta.axisLabels[0] || 'UMAP 1',
        showline: true,
        mirror: 'ticks',
        ticks: 'outside',
      },
      yaxis: {
        title: result.projectionMeta.axisLabels[1] || 'UMAP 2',
        showline: true,
        mirror: 'ticks',
        ticks: 'outside',
      },
      annotations: [
        {
          xref: 'paper',
          yref: 'paper',
          x: 1,
          y: 1.16,
          xanchor: 'right',
          yanchor: 'bottom',
          showarrow: false,
          text: result.projectionMeta.featureKind || 'soap_atomwise_pooled',
          font: { size: 12, color: readCssVar('--muted', '#64748b') },
        },
      ],
    });

    Plotly.react(
      dom.umapPlot,
      traces,
      layout,
      {
        responsive: true,
        displaylogo: false,
        toImageButtonOptions: { format: 'png', scale: PLOT_EXPORT_SCALE },
      }
    );
  }

  function getSpectrumXAxisUnit() {
    const raw = String(dom.spectrumXAxisUnit?.value || 'ev').trim().toLowerCase();
    return raw === 'nm' ? 'nm' : 'ev';
  }

  function buildSpectrumTraceData(result, yValues) {
    const numericYValues = Array.isArray(yValues) ? yValues : [];
    const pointCount = Math.min(result.xEnergyEv.length, numericYValues.length);
    const unit = getSpectrumXAxisUnit();
    const pairs = [];
    for (let index = 0; index < pointCount; index++) {
      const energyEv = Number(result.xEnergyEv[index]);
      const yValue = Number(numericYValues[index]);
      if (!Number.isFinite(energyEv) || energyEv <= 0 || !Number.isFinite(yValue)) continue;
      pairs.push({
        x: unit === 'nm' ? (EV_TO_NM / energyEv) : energyEv,
        y: yValue,
      });
    }
    if (unit === 'nm') {
      pairs.sort((left, right) => left.x - right.x);
    }
    return {
      x: pairs.map((item) => item.x),
      y: pairs.map((item) => item.y),
      unit,
    };
  }

  function buildSpectrumAnnotationText(result) {
    const selectedPairCount = getSelectedSpectrumPairs().length;
    if (selectedPairCount <= 0) return 'total spectra';
    return `total spectra + ${selectedPairCount} pair overlay${selectedPairCount === 1 ? '' : 's'}`;
  }

  function buildSpectrumStatus(result) {
    const entryCount = Array.isArray(result?.entries) ? result.entries.length : 0;
    if (!entryCount) {
      return 'No absorption spectrum result available.';
    }
    const selectedPairCount = getSelectedSpectrumPairs().length;
    let text =
      `Rendered ${entryCount} spectrum series.`;
    if (selectedPairCount > 0) {
      text += ` Added ${selectedPairCount} selected pair overlay${selectedPairCount === 1 ? '' : 's'}.`;
    }
    if (Number.isFinite(result.deltaEv)) {
      text += ` Lorentzian delta ${Number(result.deltaEv).toFixed(3)} eV.`;
    }
    const skipped = Array.isArray(result.skipped) ? result.skipped : [];
    if (skipped.length) {
      const skippedLabels = skipped
        .slice(0, 3)
        .map((item) => item.label || item.id || 'distribution')
        .filter(Boolean);
      text += ` Skipped ${skipped.length}`;
      if (skippedLabels.length) {
        text += `: ${skippedLabels.join(', ')}`;
        if (skipped.length > skippedLabels.length) {
          text += ', ...';
        }
      }
      text += '.';
    }
    return text;
  }

  function renderSpectrumPlot(result) {
    if (!dom.spectrumPlot) return;
    if (typeof Plotly === 'undefined') {
      clearSpectrumPlot('Plot unavailable because Plotly failed to load.');
      return;
    }
    if (!result || !Array.isArray(result.entries) || !result.entries.length || !Array.isArray(result.xEnergyEv) || !result.xEnergyEv.length) {
      clearSpectrumPlot('No absorption spectrum data was returned for the active distributions.');
      return;
    }
    clearEmptyPlotPlaceholder(dom.spectrumPlot);

    const traces = [];
    const selectedPairList = getSelectedSpectrumPairs();
    const selectedPairIndexByKey = new Map(
      selectedPairList.map((pair, index) => [pairKey(pair), index])
    );

    result.entries.forEach((entry, distributionIndex) => {
      const totalTraceData = buildSpectrumTraceData(result, entry.totalYNormalized);
      if (totalTraceData.x.length && totalTraceData.y.length) {
        const unit = totalTraceData.unit === 'nm' ? 'nm' : 'eV';
        traces.push({
          type: 'scatter',
          mode: 'lines',
          name: `${entry.name} total`,
          x: totalTraceData.x,
          y: totalTraceData.y,
          line: {
            color: buildTraceColor(distributionIndex),
            width: 2.8,
          },
          hovertemplate:
            `${entry.name} total` +
            `<br>${totalTraceData.unit === 'nm' ? 'wavelength' : 'energy'}=%{x:.4f} ${unit}` +
            '<br>normalized sigma=%{y:.4f}' +
            '<extra></extra>',
        });
      }

      const pairCurveIndex = new Map((Array.isArray(entry.pairCurves) ? entry.pairCurves : []).map((curve) => [curve.key, curve]));
      for (const pair of selectedPairList) {
        const key = pairKey(pair);
        const pairCurve = pairCurveIndex.get(key);
        if (!pairCurve) continue;
        const pairTraceData = buildSpectrumTraceData(result, pairCurve.yNormalized);
        if (!pairTraceData.x.length || !pairTraceData.y.length) continue;
        const unit = pairTraceData.unit === 'nm' ? 'nm' : 'eV';
        const pairIndex = selectedPairIndexByKey.has(key) ? selectedPairIndexByKey.get(key) : 0;
        traces.push({
          type: 'scatter',
          mode: 'lines',
          name: `${entry.name} ${pairCurve.label}`,
          x: pairTraceData.x,
          y: pairTraceData.y,
          line: {
            color: buildPairTraceColor(pairIndex || 0),
            width: 1.8,
            dash: buildDistributionDashPattern(distributionIndex),
          },
          opacity: 0.88,
          hovertemplate:
            `${entry.name} ${pairCurve.label}` +
            `<br>${pairTraceData.unit === 'nm' ? 'wavelength' : 'energy'}=%{x:.4f} ${unit}` +
            '<br>normalized sigma=%{y:.4f}' +
            '<extra></extra>',
        });
      }
    });

    if (!traces.length) {
      clearSpectrumPlot('No finite absorption spectrum values remain after unit conversion.');
      return;
    }

    const xUnit = getSpectrumXAxisUnit();
    const windowBounds = state.selectionEnabled ? readWindowBounds() : null;
    const shapes = [];
    if (windowBounds) {
      let x0 = windowBounds.min;
      let x1 = windowBounds.max;
      if (xUnit === 'nm') {
        x0 = EV_TO_NM / Math.max(windowBounds.max, 1.0e-12);
        x1 = EV_TO_NM / Math.max(windowBounds.min, 1.0e-12);
      }
      const shapeMin = Math.min(x0, x1);
      const shapeMax = Math.max(x0, x1);
      if (Number.isFinite(shapeMin) && Number.isFinite(shapeMax) && shapeMax > shapeMin) {
        shapes.push({
          type: 'rect',
          xref: 'x',
          yref: 'paper',
          x0: shapeMin,
          x1: shapeMax,
          y0: 0,
          y1: 1,
          fillcolor: readCssVar('--accent-soft', 'rgba(15, 93, 207, 0.14)'),
          line: { width: 0 },
          layer: 'below',
        });
      }
    }
    const layout = mergePlotlyLayout({
      height: 408,
      margin: { l: 68, r: 20, t: 18, b: 54 },
      hovermode: 'closest',
      showlegend: true,
      legend: {
        orientation: 'h',
        x: 0,
        xanchor: 'left',
        y: 1.14,
        yanchor: 'bottom',
      },
      xaxis: {
        title: xUnit === 'nm' ? 'Wavelength (nm)' : 'Energy (eV)',
        showline: true,
        mirror: 'ticks',
        ticks: 'outside',
      },
      yaxis: {
        title: 'Normalized Absorption Cross Section',
        range: [0, 1.05],
        showline: true,
        mirror: 'ticks',
        ticks: 'outside',
        rangemode: 'tozero',
      },
      shapes,
      annotations: [
        {
          xref: 'paper',
          yref: 'paper',
          x: 1,
          y: 1.16,
          xanchor: 'right',
          yanchor: 'bottom',
          showarrow: false,
          text: buildSpectrumAnnotationText(result),
          font: { size: 12, color: readCssVar('--muted', '#64748b') },
        },
      ],
    });

    Plotly.react(
      dom.spectrumPlot,
      traces,
      layout,
      {
        responsive: true,
        displaylogo: false,
        toImageButtonOptions: { format: 'png', scale: PLOT_EXPORT_SCALE },
      }
    );
  }

  function summaryStat(label, valueText) {
    const wrap = document.createElement('div');
    wrap.className = 'summary-stat';
    const labelEl = document.createElement('div');
    labelEl.className = 'summary-stat-label';
    labelEl.textContent = label;
    const valueEl = document.createElement('div');
    valueEl.className = 'summary-stat-value';
    valueEl.textContent = valueText;
    wrap.appendChild(labelEl);
    wrap.appendChild(valueEl);
    return wrap;
  }

  function buildSummaryGroup(titleText, summary, measurementKind) {
    const group = document.createElement('div');
    group.className = 'summary-group';
    const title = document.createElement('div');
    title.className = 'summary-group-title';
    title.textContent = titleText;
    const stats = document.createElement('div');
    stats.className = 'summary-stats';
    stats.appendChild(summaryStat('count', Number.isFinite(summary.count) ? String(Math.round(summary.count)) : 'n/a'));
    stats.appendChild(summaryStat('mean', formatMeasurementValue(summary.mean, measurementKind)));
    stats.appendChild(summaryStat('std', formatMeasurementValue(summary.std, measurementKind)));
    stats.appendChild(summaryStat('min', formatMeasurementValue(summary.min, measurementKind)));
    stats.appendChild(summaryStat('p05', formatMeasurementValue(summary.p05, measurementKind)));
    stats.appendChild(summaryStat('median', formatMeasurementValue(summary.p50, measurementKind)));
    stats.appendChild(summaryStat('p95', formatMeasurementValue(summary.p95, measurementKind)));
    stats.appendChild(summaryStat('max', formatMeasurementValue(summary.max, measurementKind)));
    group.appendChild(title);
    group.appendChild(stats);
    return group;
  }

  function renderSummary(result) {
    if (!dom.summaryGrid || !dom.summaryMeta || !dom.summaryCount) return;
    dom.summaryGrid.innerHTML = '';
    const entryCount = Array.isArray(result?.entries) ? result.entries.length : 0;
    dom.summaryCount.textContent = String(entryCount);
    if (!entryCount) {
      clearSummary('No comparison result available.');
      return;
    }
    const atomLabel = result.atomIndices.length ? `atoms [${result.atomIndices.join(', ')}]` : 'requested atoms';
    const skipped = Array.isArray(result?.skippedDistributions) ? result.skippedDistributions : [];
    let metaText = result.selectionMode === 'none'
      ? `${result.measurementKind} comparison for ${atomLabel} across ${entryCount} distribution${entryCount === 1 ? '' : 's'} with selection disabled.`
      : `${result.measurementKind} comparison for ${atomLabel} across ${entryCount} distribution${entryCount === 1 ? '' : 's'}.`;
    if (skipped.length) {
      metaText += ` Skipped ${skipped.length} active bundle${skipped.length === 1 ? '' : 's'} without electronic profiles.`;
    }
    dom.summaryMeta.textContent = metaText;

    for (const entry of result.entries) {
      const card = document.createElement('article');
      card.className = 'summary-item';

      const head = document.createElement('div');
      head.className = 'summary-item-head';
      const title = document.createElement('div');
      title.className = 'summary-item-title';
      title.textContent = entry.name;
      const subtitle = document.createElement('div');
      subtitle.className = 'summary-item-subtitle';
      const subtitleParts = [];
      if (entry.sourceFilename) subtitleParts.push(basename(entry.sourceFilename));
      subtitleParts.push(`ID: ${entry.id}`);
      subtitle.textContent = subtitleParts.join(' | ');
      head.appendChild(title);
      head.appendChild(subtitle);
      card.appendChild(head);

      if (result.selectionMode !== 'none') {
        const selectionStats = document.createElement('div');
        selectionStats.className = 'summary-stats';
        selectionStats.appendChild(
          summaryStat(
            'selected',
            `${Math.round(Number(entry.selectedCount || 0))}/${Math.round(Number(entry.allSummary?.count || 0))}`
          )
        );
        selectionStats.appendChild(summaryStat('fraction', `${(100 * Number(entry.selectedFraction || 0)).toFixed(1)}%`));
        selectionStats.appendChild(summaryStat('ESS', Number(entry.effectiveSampleSize || 0).toFixed(2)));
        card.appendChild(selectionStats);
      }

      const groups = document.createElement('div');
      groups.className = 'summary-groups';
      groups.appendChild(buildSummaryGroup('All geometries', entry.allSummary || entry.summary, result.measurementKind));
      if (result.selectionMode !== 'none') {
        groups.appendChild(buildSummaryGroup('Selected geometries', entry.selectedSummary || entry.summary, result.measurementKind));
      }
      card.appendChild(groups);

      dom.summaryGrid.appendChild(card);
    }
  }

  function reconcileCompareResult() {
    if (!state.lastCompareResult) {
      syncActionState();
      return;
    }
    const validIds = new Set(state.distributions.map((distribution) => distribution.id));
    const nextEntries = state.lastCompareResult.entries.filter((entry) => validIds.has(entry.id) || entry.id.startsWith('series-'));
    if (!nextEntries.length) {
      state.lastCompareResult = null;
      clearPlot('Load one or more bundles, choose a measurement, and draw the first overlay histogram.');
      clearSummary('Comparison metadata and per-distribution statistics will appear here after the first plot.');
      syncActionState();
      return;
    }
    state.lastCompareResult = {
      ...state.lastCompareResult,
      entries: nextEntries.map((entry) => ({
        ...entry,
        name: lookupDistributionName(entry.id, entry.name),
        sourceFilename: firstNonEmptyString(entry.sourceFilename, lookupDistributionFilename(entry.id)),
      })),
    };
    renderComparePlot(state.lastCompareResult);
    renderSummary(state.lastCompareResult);
    syncActionState();
  }

  async function compareGeometry() {
    let payload = null;
    try {
      payload = buildComparePayload();
    } catch (error) {
      setCompareStatus(error.message, true);
      return;
    }

    const requestSeq = ++state.compareRequestSeq;
    state.compareInFlight = true;
    syncActionState();
    setCompareStatus('Computing comparison histogram...', false);
    try {
      const responsePayload = await fetchPayload(state.endpoints.compareGeometry, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      if (requestSeq !== state.compareRequestSeq) return;
      const normalized = normalizeCompareResult(responsePayload, payload);
      if (!normalized.entries.length) {
        throw new Error('The backend returned no comparable distributions for this request.');
      }
      state.lastCompareResult = normalized;
      renderComparePlot(normalized);
      renderSummary(normalized);
      setCompareStatus(
        `Rendered ${normalized.entries.length} distribution${normalized.entries.length === 1 ? '' : 's'} for ${normalized.measurementKind}.`,
        false
      );
    } catch (error) {
      if (requestSeq !== state.compareRequestSeq) return;
      setCompareStatus(`Failed to compare geometry: ${error.message}`, true);
    } finally {
      if (requestSeq === state.compareRequestSeq) {
        state.compareInFlight = false;
        syncActionState();
      }
    }
  }

  async function deleteDistribution(distributionId) {
    if (!distributionId) return;
    state.deleteInFlightIds.add(distributionId);
    renderDistributionList();
    syncActionState();
    setListStatus(`Deleting ${distributionId}...`, false);
    try {
      await fetchPayload(buildDeleteUrl(distributionId), {
        method: 'DELETE',
        headers: { Accept: 'application/json' },
      });
      state.activeIds.delete(distributionId);
      await refreshDistributions({ preserveActive: true });
      setListStatus(`Deleted ${distributionId}.`, false);
    } catch (error) {
      setListStatus(`Failed to delete ${distributionId}: ${error.message}`, true);
    } finally {
      state.deleteInFlightIds.delete(distributionId);
      renderDistributionList();
      syncActionState();
    }
  }

  function handleListClick(event) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const deleteId = target.dataset.distributionDeleteId;
    if (deleteId) {
      event.preventDefault();
      deleteDistribution(deleteId);
    }
  }

  function handleListChange(event) {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    const spectrumSeriesSelectionKey = firstNonEmptyString(target.dataset.spectrumSeriesKey);
    if (spectrumSeriesSelectionKey) {
      if (target.checked) {
        state.activeSpectrumSeriesKeys.add(spectrumSeriesSelectionKey);
      } else {
        state.activeSpectrumSeriesKeys.delete(spectrumSeriesSelectionKey);
      }
      renderDistributionList();
      void refreshSpectrumView();
      syncActionState();
      return;
    }
    const distributionId = target.dataset.distributionActiveId;
    if (!distributionId) return;
    if (target.checked) {
      state.activeIds.add(distributionId);
    } else {
      state.activeIds.delete(distributionId);
    }
    renderDistributionList();
    renderSelectionProfileControls();
    scheduleOverlayRefresh({ geometry: true, umap: true });
    void refreshSpectrumView();
    syncActionState();
  }

  function handleSelectionProfileChange(event) {
    const target = event.target;
    if (!(target instanceof HTMLSelectElement)) return;
    const distributionId = firstNonEmptyString(target.dataset.selectionProfileDistributionId);
    const profileId = firstNonEmptyString(target.value);
    if (!distributionId || !profileId) return;
    state.selectionProfilesByDistribution[distributionId] = profileId;
    renderSelectionProfileControls();
    scheduleOverlayRefresh({ geometry: true, umap: true });
  }

  function handleSpectrumPairChange(event) {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    const key = firstNonEmptyString(target.dataset.spectrumPairKey);
    if (!key) return;
    if (target.checked) {
      state.selectedSpectrumPairKeys.add(key);
    } else {
      state.selectedSpectrumPairKeys.delete(key);
    }
    if (state.lastSpectrumResult) {
      renderSpectrumPlot(state.lastSpectrumResult);
      setSpectrumStatus(buildSpectrumStatus(state.lastSpectrumResult), false);
    }
  }

  function bindEvents() {
    const bindOverlayRefreshControl = (inputEl, options = {}) => {
      if (!inputEl) return;
      inputEl.addEventListener('change', () => {
        if (options.rerenderSpectrum && state.lastSpectrumResult) {
          renderSpectrumPlot(state.lastSpectrumResult);
        }
        scheduleOverlayRefresh({
          geometry: options.geometry !== false,
          umap: !!options.umap,
        });
      });
    };

    dom.fileInput?.addEventListener('change', (event) => {
      const inputEl = event.currentTarget;
      if (!(inputEl instanceof HTMLInputElement) || !inputEl.files || !inputEl.files.length) return;
      uploadBundle(inputEl.files[0]);
    });
    dom.openServerBundleBtn?.addEventListener('click', () => {
      setFileBrowserOpen(true);
      void loadBrowsePath('');
    });
    dom.refreshBtn?.addEventListener('click', () => {
      refreshDistributions({ preserveActive: true });
    });
    dom.selectionEnabled?.addEventListener('change', (event) => {
      const target = event.currentTarget;
      if (!(target instanceof HTMLInputElement)) return;
      state.selectionEnabled = !!target.checked;
      syncSelectionControlsState();
      renderSelectionProfileControls();
      if (state.lastSpectrumResult) {
        renderSpectrumPlot(state.lastSpectrumResult);
      }
      scheduleOverlayRefresh({ geometry: true, umap: true, immediate: true });
    });
    dom.workspaceSelectionBtn?.addEventListener('click', () => {
      setWorkspace(WORKSPACE_SELECTION);
    });
    dom.workspaceOverlayBtn?.addEventListener('click', () => {
      setWorkspace(WORKSPACE_OVERLAY);
    });
    dom.workspaceSummaryBtn?.addEventListener('click', () => {
      setWorkspace(WORKSPACE_SUMMARY);
    });
    dom.workspaceSpectrumBtn?.addEventListener('click', () => {
      setWorkspace(WORKSPACE_SPECTRUM);
    });
    dom.measurementKind?.addEventListener('change', () => {
      syncMeasurementKindUi();
      scheduleOverlayRefresh({ geometry: true });
    });
    bindOverlayRefreshControl(dom.atom0, { geometry: true });
    bindOverlayRefreshControl(dom.atom1, { geometry: true });
    bindOverlayRefreshControl(dom.atom2, { geometry: true });
    bindOverlayRefreshControl(dom.atom3, { geometry: true });
    bindOverlayRefreshControl(dom.histogramBins, { geometry: true });
    bindOverlayRefreshControl(dom.windowCenterEv, { geometry: true, umap: true, rerenderSpectrum: true });
    bindOverlayRefreshControl(dom.windowWidthEv, { geometry: true, umap: true, rerenderSpectrum: true });
    dom.selectionProfilePanel?.addEventListener('change', handleSelectionProfileChange);
    dom.spectrumDeltaEv?.addEventListener('change', () => {
      void refreshSpectrumView();
    });
    dom.spectrumDeltaEv?.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      if (event.currentTarget instanceof HTMLElement) {
        event.currentTarget.blur();
      }
    });
    dom.spectrumXAxisUnit?.addEventListener('change', () => {
      if (state.lastSpectrumResult) {
        renderSpectrumPlot(state.lastSpectrumResult);
      }
    });
    dom.spectrumPairPanel?.addEventListener('change', handleSpectrumPairChange);
    dom.distributionList?.addEventListener('click', handleListClick);
    dom.distributionList?.addEventListener('change', handleListChange);
    dom.fileBrowserCloseBtn?.addEventListener('click', () => {
      if (state.pathLoadInFlight) return;
      setFileBrowserOpen(false);
    });
    dom.fileBrowserUpBtn?.addEventListener('click', () => {
      if (state.pathLoadInFlight || state.browseListInFlight || fileBrowserParentPath == null) return;
      void loadBrowsePath(fileBrowserParentPath);
    });
    dom.fileBrowserModal?.querySelector('[data-file-browser-close]')?.addEventListener('click', () => {
      if (state.pathLoadInFlight) return;
      setFileBrowserOpen(false);
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && dom.fileBrowserModal && !dom.fileBrowserModal.hidden && !state.pathLoadInFlight) {
        setFileBrowserOpen(false);
      }
    });
  }

  function initAppearance() {
    const appearance = getAppearanceModule();
    if (!appearance) return;
    if (typeof appearance.initControls === 'function') {
      appearance.initControls();
    }
    if (typeof appearance.subscribe === 'function') {
      appearance.subscribe(() => {
        if (state.workspace === WORKSPACE_OVERLAY && state.lastCompareResult) {
          renderComparePlot(state.lastCompareResult);
        }
        if (state.workspace === WORKSPACE_OVERLAY && state.lastUmapResult) {
          renderUmapPlot(state.lastUmapResult);
        }
        if (state.workspace === WORKSPACE_SPECTRUM && state.lastSpectrumResult) {
          renderSpectrumPlot(state.lastSpectrumResult);
        }
      });
    }
  }

  function init() {
    state.selectionEnabled = false;
    syncMeasurementKindUi();
    clearPlot('Load one or more bundles, choose a measurement, and the histogram will refresh automatically.');
    clearUmapPlot('Enable one or more active distributions to project SOAP features into UMAP.');
    clearSpectrumPlot('Enable one or more electronic profiles to display absorption spectra.');
    renderSelectionProfileControls();
    syncSelectionControlsState();
    renderSpectrumPairOptions({
      availablePairs: [],
      emptyMessage: 'Enable one or more electronic profiles to discover common transition pairs.',
    });
    clearSummary('Auto-refreshed comparison metadata and per-distribution statistics will appear here after the first plot.');
    setCompareStatus(
      'Geometry comparison refreshes automatically. Selection is currently disabled, so all geometries are included.',
      false
    );
    setUmapStatus(
      'SOAP UMAP refreshes automatically for the active distributions. Selection is currently disabled.',
      false
    );
    setSpectrumPairStatus('Only common valid pairs across the selected spectrum series are listed here.', false);
    setSpectrumStatus(
      'Enable one or more electronic profiles to display spectra.',
      false
    );
    syncWorkspaceUi();
    bindEvents();
    initAppearance();
    syncActionState();
    refreshDistributions({ preserveActive: false });
  }

  init();
})();
