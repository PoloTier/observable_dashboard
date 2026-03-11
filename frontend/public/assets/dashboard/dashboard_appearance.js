(function () {
  const STORAGE_KEY = 'observable_dashboard_theme_v1';
  const VALID_MODES = new Set(['light', 'dark']);
  const listeners = new Set();
  const controlStates = new Set();
  let panelEventsBound = false;

  const THEMES = {
    light: {
      label: 'Light',
      plotly: {
        template: 'plotly_white',
        paperBgcolor: 'rgba(255,255,255,0)',
        plotBgcolor: 'rgba(255,255,255,0.82)',
        fontColor: '#1f2937',
        gridColor: 'rgba(148,163,184,0.26)',
        lineColor: 'rgba(148,163,184,0.44)',
        zeroLineColor: 'rgba(148,163,184,0.38)',
        legendBgcolor: 'rgba(255,255,255,0.68)',
        legendBorderColor: 'rgba(203,213,225,0.74)',
        hoverBgcolor: '#ffffff',
        hoverBorderColor: '#cbd5e1',
        hoverFontColor: '#111827',
      },
      plotColors: {
        hoverSyncLineColor: 'rgba(71,85,105,0.34)',
        traceMutedColor: 'rgba(120,120,120,0.35)',
        neutralFillColor: 'rgba(15,23,42,0.08)',
        accentFillColor: 'rgba(31,119,180,0.18)',
        dangerFillColor: 'rgba(214,39,40,0.18)',
        cursorLineColor: '#d62728',
      },
      viewer: {
        backgroundColor: '#fbfdff',
        labelBackgroundColor: '#ffffff',
        labelBackgroundOpacity: 0.82,
        atomIndexColor: '#dc2626',
      },
    },
    dark: {
      label: 'Dark',
      plotly: {
        template: 'plotly_dark',
        paperBgcolor: 'rgba(6,11,22,0)',
        plotBgcolor: 'rgba(9,16,32,0.72)',
        fontColor: '#e5eef8',
        gridColor: 'rgba(148,163,184,0.18)',
        lineColor: 'rgba(148,163,184,0.3)',
        zeroLineColor: 'rgba(148,163,184,0.26)',
        legendBgcolor: 'rgba(7,12,24,0.56)',
        legendBorderColor: 'rgba(71,85,105,0.7)',
        hoverBgcolor: '#0f172a',
        hoverBorderColor: '#334155',
        hoverFontColor: '#f8fafc',
      },
      plotColors: {
        hoverSyncLineColor: 'rgba(191,219,254,0.34)',
        traceMutedColor: 'rgba(203,213,225,0.3)',
        neutralFillColor: 'rgba(148,163,184,0.16)',
        accentFillColor: 'rgba(96,165,250,0.22)',
        dangerFillColor: 'rgba(248,113,113,0.22)',
        cursorLineColor: '#f87171',
      },
      viewer: {
        backgroundColor: '#060b16',
        labelBackgroundColor: '#0f172a',
        labelBackgroundOpacity: 0.9,
        atomIndexColor: '#fda4af',
      },
    },
  };

  function normalizeMode(rawMode) {
    const text = String(rawMode || '').trim().toLowerCase();
    return VALID_MODES.has(text) ? text : 'light';
  }

  function cloneObject(value) {
    if (!value || typeof value !== 'object') return value;
    return JSON.parse(JSON.stringify(value));
  }

  function applyModeToDocument(mode) {
    const rootEl = document.documentElement;
    rootEl.setAttribute('data-theme', mode);
    rootEl.style.colorScheme = mode;
  }

  function loadStoredMode() {
    try {
      const savedMode = localStorage.getItem(STORAGE_KEY);
      if (VALID_MODES.has(savedMode || '')) return savedMode;
    } catch {
      // ignore storage failures
    }
    return '';
  }

  function persistMode(mode) {
    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      // ignore storage failures
    }
  }

  function themeForMode(mode) {
    return THEMES[normalizeMode(mode)] || THEMES.light;
  }

  let currentMode = normalizeMode(document.documentElement.getAttribute('data-theme') || loadStoredMode() || 'light');
  applyModeToDocument(currentMode);

  function notifyListeners() {
    for (const listener of listeners) {
      try {
        listener(currentMode, themeForMode(currentMode));
      } catch (error) {
        console.error('ObservableAppearance listener failed:', error);
      }
    }
  }

  function getMode() {
    return currentMode;
  }

  function setMode(nextMode, { persist = true } = {}) {
    const normalizedMode = normalizeMode(nextMode);
    if (normalizedMode === currentMode) {
      applyModeToDocument(currentMode);
      if (persist) persistMode(currentMode);
      notifyListeners();
      return currentMode;
    }

    currentMode = normalizedMode;
    applyModeToDocument(currentMode);
    if (persist) persistMode(currentMode);
    notifyListeners();
    return currentMode;
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function getTheme() {
    return cloneObject(themeForMode(currentMode));
  }

  function getPlotlyLayoutPatch() {
    const theme = themeForMode(currentMode).plotly;
    return {
      template: theme.template,
      paper_bgcolor: theme.paperBgcolor,
      plot_bgcolor: theme.plotBgcolor,
      font: { color: theme.fontColor },
      title: { font: { color: theme.fontColor } },
      xaxis: {
        color: theme.fontColor,
        gridcolor: theme.gridColor,
        linecolor: theme.lineColor,
        zerolinecolor: theme.zeroLineColor,
      },
      yaxis: {
        color: theme.fontColor,
        gridcolor: theme.gridColor,
        linecolor: theme.lineColor,
        zerolinecolor: theme.zeroLineColor,
      },
      legend: {
        bgcolor: theme.legendBgcolor,
        bordercolor: theme.legendBorderColor,
        borderwidth: 1,
        font: { color: theme.fontColor },
      },
      hoverlabel: {
        bgcolor: theme.hoverBgcolor,
        bordercolor: theme.hoverBorderColor,
        font: { color: theme.hoverFontColor },
      },
    };
  }

  function getPlotColors() {
    return cloneObject(themeForMode(currentMode).plotColors);
  }

  function getViewerTheme() {
    return cloneObject(themeForMode(currentMode).viewer);
  }

  function setSelectedOptionStyles(controlEl) {
    const optionEls = controlEl.querySelectorAll('.appearance-option');
    for (const optionEl of optionEls) {
      const radio = optionEl.querySelector('input[type="radio"][name="appearance-mode"]');
      const isSelected = !!radio?.checked;
      optionEl.classList.toggle('is-selected', isSelected);
    }
  }

  function syncControl(controlEl) {
    const buttonEl = controlEl.querySelector('[data-appearance-trigger]');
    const panelEl = controlEl.querySelector('[data-appearance-panel]');
    const radios = controlEl.querySelectorAll('input[type="radio"][name="appearance-mode"]');
    for (const radio of radios) {
      radio.checked = radio.value === currentMode;
    }
    setSelectedOptionStyles(controlEl);

    if (buttonEl && panelEl) {
      buttonEl.setAttribute('aria-expanded', panelEl.hidden ? 'false' : 'true');
      const themeLabel = themeForMode(currentMode).label;
      buttonEl.setAttribute('title', `Appearance: ${themeLabel}`);
    }
  }

  function closePanelState(controlState) {
    if (!controlState) return;
    controlState.panelEl.hidden = true;
    controlState.buttonEl.setAttribute('aria-expanded', 'false');
  }

  function openPanelState(controlState) {
    if (!controlState) return;
    for (const candidateState of controlStates) {
      if (candidateState !== controlState) closePanelState(candidateState);
    }
    controlState.panelEl.hidden = false;
    controlState.buttonEl.setAttribute('aria-expanded', 'true');
  }

  function closeAllPanels({ exceptControl = null } = {}) {
    for (const controlState of controlStates) {
      if (controlState.controlEl === exceptControl) continue;
      closePanelState(controlState);
    }
  }

  function bindPanelEvents() {
    if (panelEventsBound) return;
    panelEventsBound = true;

    document.addEventListener(
      'pointerdown',
      (event) => {
        if (!(event.target instanceof Node)) {
          closeAllPanels();
          return;
        }

        for (const controlState of controlStates) {
          if (controlState.controlEl.contains(event.target)) return;
        }

        closeAllPanels();
      },
      true,
    );

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeAllPanels();
    });

    window.addEventListener('blur', () => {
      closeAllPanels();
    });
  }

  function initControls() {
    bindPanelEvents();
    const controlEls = document.querySelectorAll('[data-appearance-control]');
    for (const controlEl of controlEls) {
      if (!(controlEl instanceof HTMLElement)) continue;
      syncControl(controlEl);
      if (controlEl.dataset.appearanceBound === '1') continue;

      const buttonEl = controlEl.querySelector('[data-appearance-trigger]');
      const panelEl = controlEl.querySelector('[data-appearance-panel]');
      const radios = controlEl.querySelectorAll('input[type="radio"][name="appearance-mode"]');
      if (!buttonEl || !panelEl) continue;

      const controlState = { controlEl, buttonEl, panelEl };
      controlStates.add(controlState);

      buttonEl.addEventListener('click', () => {
        if (panelEl.hidden) openPanelState(controlState);
        else closePanelState(controlState);
      });

      for (const radio of radios) {
        radio.addEventListener('change', () => {
          if (!radio.checked) return;
          setMode(radio.value);
          closePanelState(controlState);
        });
      }

      subscribe(() => syncControl(controlEl));
      controlEl.dataset.appearanceBound = '1';
    }
  }

  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY) return;
    const nextMode = normalizeMode(event.newValue || 'light');
    if (nextMode === currentMode) return;
    currentMode = nextMode;
    applyModeToDocument(currentMode);
    notifyListeners();
  });

  window.ObservableAppearance = {
    STORAGE_KEY,
    getMode,
    setMode,
    subscribe,
    getTheme,
    getPlotlyLayoutPatch,
    getPlotColors,
    getViewerTheme,
    initControls,
  };
})();
