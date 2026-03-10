(function () {
  function distance3(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length < 3 || b.length < 3) return NaN;
    const dx = Number(a[0]) - Number(b[0]);
    const dy = Number(a[1]) - Number(b[1]);
    const dz = Number(a[2]) - Number(b[2]);
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  function dot(a, b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  }

  function cross(a, b) {
    return [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0],
    ];
  }

  function norm(a) {
    return Math.sqrt(dot(a, a));
  }

  function sub(a, b) {
    return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  }

  function angleDeg(p1, p2, p3) {
    const v1 = sub(p1, p2);
    const v2 = sub(p3, p2);
    let n1 = norm(v1);
    let n2 = norm(v2);
    if (n1 === 0) n1 = 1;
    if (n2 === 0) n2 = 1;
    let c = dot(v1, v2) / (n1 * n2);
    if (c > 1) c = 1;
    if (c < -1) c = -1;
    return Math.acos(c) * 180.0 / Math.PI;
  }

  function dihedralDeg(p1, p2, p3, p4) {
    const b1 = sub(p2, p1);
    const b2 = sub(p3, p2);
    const b3 = sub(p4, p3);
    const n1 = cross(b1, b2);
    const n2 = cross(b2, b3);
    let b2n = norm(b2);
    if (b2n === 0) b2n = 1;
    const b2u = [b2[0] / b2n, b2[1] / b2n, b2[2] / b2n];
    const m1 = cross(n1, b2u);
    const x = dot(n1, n2);
    const y = dot(m1, n2);
    return Math.atan2(y, x) * 180.0 / Math.PI;
  }

  function unwrapDegrees(values) {
    if (!values.length) return values;
    const out = [values[0]];
    for (let i = 1; i < values.length; i++) {
      let v = values[i];
      const prev = out[i - 1];
      let delta = v - prev;
      while (delta > 180) {
        v -= 360;
        delta -= 360;
      }
      while (delta < -180) {
        v += 360;
        delta += 360;
      }
      out.push(v);
    }
    return out;
  }

  function midpoint3(a, b) {
    return {
      x: (Number(a[0]) + Number(b[0])) / 2,
      y: (Number(a[1]) + Number(b[1])) / 2,
      z: (Number(a[2]) + Number(b[2])) / 2,
    };
  }

  window.ObservableDashboardMath = {
    distance3,
    dot,
    cross,
    norm,
    sub,
    angleDeg,
    dihedralDeg,
    unwrapDegrees,
    midpoint3,
  };
})();
