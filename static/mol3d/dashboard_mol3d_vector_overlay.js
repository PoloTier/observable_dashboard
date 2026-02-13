(function () {
  const root = window.ObservableMol3D || (window.ObservableMol3D = {});
  const shared = root.shared;
  if (!shared) return;

  const { state } = shared;
  const registeredSources = new Map();

  const DEFAULT_COLOR = '#2c7bb6';
  const COLOR_STOPS = [
    [44, 123, 182],   // blue
    [255, 255, 191],  // yellow
    [215, 25, 28],    // red
  ];
  const DEFAULT_ARROW_STYLE = {
    radius: 0.06,
    radiusRatio: 1.6,
    mid: 0.78,
    fromCap: 1,
    toCap: 1,
  };

  function isFiniteVec3(vec) {
    if (!Array.isArray(vec) || vec.length < 3) return false;
    return (
      Number.isFinite(Number(vec[0])) &&
      Number.isFinite(Number(vec[1])) &&
      Number.isFinite(Number(vec[2]))
    );
  }

  function vectorMagnitude(vec) {
    if (!isFiniteVec3(vec)) return NaN;
    const x = Number(vec[0]);
    const y = Number(vec[1]);
    const z = Number(vec[2]);
    return Math.sqrt(x * x + y * y + z * z);
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function rgbToHex(r, g, b) {
    const toHex = (value) => {
      const v = Math.max(0, Math.min(255, Math.round(value)));
      return v.toString(16).padStart(2, '0');
    };
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  }

  function magnitudeToColor(magnitude, minValue, maxValue) {
    const mag = Number(magnitude);
    const min = Number(minValue);
    const max = Number(maxValue);
    if (!Number.isFinite(mag) || !Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
      return DEFAULT_COLOR;
    }

    const t = Math.max(0, Math.min(1, (mag - min) / (max - min)));
    if (t <= 0.5) {
      const local = t / 0.5;
      return rgbToHex(
        lerp(COLOR_STOPS[0][0], COLOR_STOPS[1][0], local),
        lerp(COLOR_STOPS[0][1], COLOR_STOPS[1][1], local),
        lerp(COLOR_STOPS[0][2], COLOR_STOPS[1][2], local)
      );
    }

    const local = (t - 0.5) / 0.5;
    return rgbToHex(
      lerp(COLOR_STOPS[1][0], COLOR_STOPS[2][0], local),
      lerp(COLOR_STOPS[1][1], COLOR_STOPS[2][1], local),
      lerp(COLOR_STOPS[1][2], COLOR_STOPS[2][2], local)
    );
  }

  function normalizePoint(vec) {
    return {
      x: Number(vec[0]),
      y: Number(vec[1]),
      z: Number(vec[2]),
    };
  }

  function drawVectorArrow(viewer, origin, vector, options = {}) {
    if (!viewer || typeof viewer.addArrow !== 'function') return false;
    if (!isFiniteVec3(origin) || !isFiniteVec3(vector)) return false;

    const scale = Number.isFinite(Number(options.scale)) ? Number(options.scale) : 1;
    const vx = Number(vector[0]) * scale;
    const vy = Number(vector[1]) * scale;
    const vz = Number(vector[2]) * scale;
    if (!Number.isFinite(vx) || !Number.isFinite(vy) || !Number.isFinite(vz)) return false;

    const length = Math.sqrt(vx * vx + vy * vy + vz * vz);
    if (!(length > 1e-12)) return false;

    const start = normalizePoint(origin);
    const end = {
      x: start.x + vx,
      y: start.y + vy,
      z: start.z + vz,
    };
    if (!Number.isFinite(end.x) || !Number.isFinite(end.y) || !Number.isFinite(end.z)) return false;

    viewer.addArrow({
      ...DEFAULT_ARROW_STYLE,
      ...(options.arrowStyle && typeof options.arrowStyle === 'object' ? options.arrowStyle : {}),
      start,
      end,
      color: typeof options.color === 'string' && options.color ? options.color : DEFAULT_COLOR,
    });
    return true;
  }

  function resolveVectorColor(magnitude, descriptor, atomIndex, vector) {
    if (typeof descriptor.colorForMagnitude === 'function') {
      const color = descriptor.colorForMagnitude({
        magnitude,
        atomIndex,
        vector,
      });
      if (typeof color === 'string' && color) return color;
    }
    return magnitudeToColor(
      magnitude,
      Number(descriptor?.magnitudeRange?.min),
      Number(descriptor?.magnitudeRange?.max)
    );
  }

  function renderVectorOverlayDescriptor(viewer, descriptor) {
    if (!viewer || !descriptor || descriptor.enabled === false) return 0;
    const coordsFrame = descriptor.coordsFrame;
    const vectorsFrame = descriptor.vectorsFrame;
    if (!Array.isArray(coordsFrame) || !Array.isArray(vectorsFrame)) return 0;

    const atomCount = Math.min(coordsFrame.length, vectorsFrame.length);
    let drawn = 0;
    // atomIdx is the flattened arrow index; providers can map it to per-arrow metadata.
    for (let atomIdx = 0; atomIdx < atomCount; atomIdx++) {
      const origin = coordsFrame[atomIdx];
      const vector = vectorsFrame[atomIdx];
      if (!isFiniteVec3(origin) || !isFiniteVec3(vector)) continue;

      const magnitude = vectorMagnitude(vector);
      if (!Number.isFinite(magnitude)) continue;

      const color = resolveVectorColor(magnitude, descriptor, atomIdx, vector);
      const ok = drawVectorArrow(viewer, origin, vector, {
        scale: descriptor.scale,
        color,
        arrowStyle: descriptor.arrowStyle,
      });
      if (ok) drawn += 1;
    }
    return drawn;
  }

  function registerVectorSource(sourceId, provider) {
    const id = String(sourceId || '').trim();
    if (!id) throw new Error('sourceId must be a non-empty string');
    if (typeof provider !== 'function') throw new Error('provider must be a function');
    registeredSources.set(id, provider);
  }

  function unregisterVectorSource(sourceId) {
    const id = String(sourceId || '').trim();
    if (!id) return false;
    return registeredSources.delete(id);
  }

  function getRegisteredSourceIds() {
    return Array.from(registeredSources.keys());
  }

  function renderRegisteredOverlays(frameIndex) {
    const viewer = state.viewer;
    if (!viewer) return 0;

    const idx = Number.parseInt(String(frameIndex), 10);
    if (!Number.isFinite(idx) || idx < 0) return 0;

    let drawn = 0;
    for (const [sourceId, provider] of registeredSources.entries()) {
      let descriptor = null;
      try {
        descriptor = provider({
          sourceId,
          frameIndex: idx,
          state,
        });
      } catch (error) {
        console.error(`Vector overlay provider failed for "${sourceId}":`, error);
        continue;
      }
      if (!descriptor) continue;

      const withCoords = {
        ...descriptor,
        coordsFrame: Array.isArray(descriptor.coordsFrame)
          ? descriptor.coordsFrame
          : (Array.isArray(state.currentCoords) ? state.currentCoords[idx] : null),
      };
      drawn += renderVectorOverlayDescriptor(viewer, withCoords);
    }
    return drawn;
  }

  root.vectorOverlay = {
    isFiniteVec3,
    vectorMagnitude,
    magnitudeToColor,
    drawVectorArrow,
    renderVectorOverlayDescriptor,
    registerVectorSource,
    unregisterVectorSource,
    getRegisteredSourceIds,
    renderRegisteredOverlays,
  };
})();
