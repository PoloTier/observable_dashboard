/**
 * Shared plot/UI utility functions used across multiple pages.
 *
 * Exposed on window.DashboardPlotUtils so IIFE-scoped page modules
 * can reference them without ES module imports.
 *
 * Must be loaded AFTER dashboard_appearance.js (provides
 * window.ObservableAppearance) and BEFORE any page module that uses
 * these helpers.
 */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ */
  /*  Appearance helpers                                                 */
  /* ------------------------------------------------------------------ */

  /** Return the global appearance module, or null if not loaded. */
  function getAppearanceModule() {
    return window.ObservableAppearance || null;
  }

  /**
   * Merge a Plotly layout object with the current theme patch.
   *
   * Deep-merges font/title/xaxis/yaxis/legend/hoverlabel subkeys so
   * the theme provides defaults while the caller's layout wins on
   * conflict.
   */
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

  /* ------------------------------------------------------------------ */
  /*  CSS variable reader                                                */
  /* ------------------------------------------------------------------ */

  /** Read a CSS custom property from :root, with a fallback value. */
  function readCssVar(name, fallback) {
    const rootStyle = typeof window.getComputedStyle === 'function'
      ? window.getComputedStyle(document.documentElement)
      : null;
    const rawValue = rootStyle ? rootStyle.getPropertyValue(name) : '';
    const value = String(rawValue || '').trim();
    return value || fallback;
  }

  /* ------------------------------------------------------------------ */
  /*  Download helper                                                    */
  /* ------------------------------------------------------------------ */

  /** Trigger a browser download for a Blob with the given filename. */
  function triggerBlobDownload(fileName, blob) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = String(fileName || 'download.bin');
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  }

  /* ------------------------------------------------------------------ */
  /*  Public API                                                         */
  /* ------------------------------------------------------------------ */

  window.DashboardPlotUtils = {
    getAppearanceModule,
    mergePlotlyLayout,
    readCssVar,
    triggerBlobDownload,
  };
})();
