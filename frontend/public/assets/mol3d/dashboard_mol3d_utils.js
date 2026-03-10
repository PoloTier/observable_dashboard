(function () {
  const root = window.ObservableMol3D || (window.ObservableMol3D = {});

  function clampNumber(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function parseFiniteNumber(raw) {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return null;
    return parsed;
  }

  function sanitizeFilenamePart(text) {
    const cleaned = String(text).trim().replace(/[^A-Za-z0-9._-]+/g, '_');
    return cleaned || 'unknown';
  }

  function normalizeHexColor(color) {
    const text = String(color || '').trim();
    if (!text) return '#1f77b4';
    const m = text.match(/^#([0-9A-Fa-f]{6})$/);
    if (m) return `#${m[1].toLowerCase()}`;
    return '#1f77b4';
  }

  function sanitizeColorInput(color) {
    const text = String(color || '').trim();
    if (/^#([0-9A-Fa-f]{6})$/.test(text)) return text.toLowerCase();
    if (/^#([0-9A-Fa-f]{3})$/.test(text)) {
      const s = text.slice(1).toLowerCase();
      return `#${s[0]}${s[0]}${s[1]}${s[1]}${s[2]}${s[2]}`;
    }
    return null;
  }

  root.utils = {
    clampNumber,
    parseFiniteNumber,
    sanitizeFilenamePart,
    normalizeHexColor,
    sanitizeColorInput,
  };
})();
