(function () {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const XLINK_NS = 'http://www.w3.org/1999/xlink';

  function readConfig() {
    const scriptEl = document.getElementById('workflow-config-json');
    if (!scriptEl) {
      return {
        pages: {},
        features: {},
      };
    }
    try {
      return JSON.parse(scriptEl.textContent || '{}');
    } catch (_) {
      return {
        pages: {},
        features: {},
      };
    }
  }

  function svgEl(name, attrs = {}) {
    const el = document.createElementNS(SVG_NS, name);
    Object.entries(attrs).forEach(([key, value]) => {
      if (value == null) return;
      if (key === 'href') {
        el.setAttributeNS(XLINK_NS, 'href', String(value));
        el.setAttribute('href', String(value));
        return;
      }
      el.setAttribute(key, String(value));
    });
    return el;
  }

  function appendText(group, x, y, lines, opts = {}) {
    const text = svgEl('text', {
      x,
      y,
      'font-family': 'Segoe UI, Helvetica Neue, sans-serif',
      'font-size': opts.fontSize || 24,
      'font-weight': opts.fontWeight || 600,
      fill: opts.fill || 'var(--wf-text, #132230)',
      'text-anchor': opts.anchor || 'middle',
      'dominant-baseline': opts.baseline || 'middle',
    });
    lines.forEach((line, index) => {
      const tspan = svgEl('tspan', {
        x,
        dy: index === 0 ? '0' : (opts.lineHeight || 26),
      });
      tspan.textContent = line;
      text.appendChild(tspan);
    });
    group.appendChild(text);
    return text;
  }

  function createNodeShape(group, node) {
    const x = node.x;
    const y = node.y;
    const w = node.w;
    const h = node.h;
    const stroke = node.stroke || '#4a5563';
    const fill = node.fill || '#ffffff';

    if (node.kind === 'source' || node.kind === 'output') {
      const inset = Math.min(26, Math.max(18, w * 0.08));
      const points = node.kind === 'source'
        ? [
          [x + inset, y],
          [x + w, y],
          [x + w - inset, y + h],
          [x, y + h],
        ]
        : [
          [x, y],
          [x + w - inset, y],
          [x + w, y + h],
          [x + inset, y + h],
        ];
      group.appendChild(svgEl('polygon', {
        points: points.map((pair) => pair.join(',')).join(' '),
        fill,
        stroke,
        'stroke-width': 2.4,
      }));
      return;
    }

    const outer = svgEl('rect', {
      x,
      y,
      width: w,
      height: h,
      rx: node.kind === 'artifact' ? 10 : 18,
      ry: node.kind === 'artifact' ? 10 : 18,
      fill,
      stroke,
      'stroke-width': 2.4,
      'stroke-dasharray': node.kind === 'external' ? '10 8' : null,
    });
    group.appendChild(outer);
    if (node.kind === 'view') {
      group.appendChild(svgEl('rect', {
        x: x + 8,
        y: y + 8,
        width: w - 16,
        height: h - 16,
        rx: 14,
        ry: 14,
        fill: 'none',
        stroke,
        'stroke-width': 1.4,
        opacity: 0.8,
      }));
    }
  }

  function createNode(parent, node) {
    const link = node.href ? svgEl('a', { href: node.href, target: node.target || '_self' }) : svgEl('g');
    if (node.href) {
      link.setAttribute('class', 'wf-node-link');
    }
    const group = svgEl('g', {
      transform: node.href ? 'translate(0 0)' : null,
      style: node.href ? 'cursor:pointer;' : null,
    });
    createNodeShape(group, node);

    const titleLines = Array.isArray(node.title) ? node.title : [node.title];
    const subtitleLines = Array.isArray(node.subtitle) ? node.subtitle : [node.subtitle];
    const centerX = node.x + node.w / 2;
    const titleY = node.y + node.h / 2 - (subtitleLines.filter(Boolean).length ? 16 : 0);
    appendText(group, centerX, titleY, titleLines.filter(Boolean), {
      fontSize: node.kind === 'artifact' ? 25 : 24,
      fontWeight: 700,
    });
    if (subtitleLines.filter(Boolean).length) {
      appendText(group, centerX, titleY + 28, subtitleLines.filter(Boolean), {
        fontSize: 17,
        fontWeight: 500,
        fill: '#5c6a79',
        lineHeight: 22,
      });
    }

    if (node.badge) {
      const badge = svgEl('rect', {
        x: node.x + node.w - 118,
        y: node.y + 10,
        width: 104,
        height: 28,
        rx: 14,
        ry: 14,
        fill: '#0f766e',
        opacity: 0.92,
      });
      group.appendChild(badge);
      appendText(group, node.x + node.w - 66, node.y + 24, [node.badge], {
        fontSize: 12,
        fontWeight: 800,
        fill: '#ffffff',
      });
    }

    link.appendChild(group);
    parent.appendChild(link);
  }

  function polyline(parent, points, opts = {}) {
    parent.appendChild(svgEl('polyline', {
      points: points.map((pair) => pair.join(',')).join(' '),
      fill: 'none',
      stroke: opts.stroke || '#667685',
      'stroke-width': opts.width || 6,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'marker-end': opts.markerEnd || 'url(#wf-arrow)',
      'marker-start': opts.markerStart || null,
      'stroke-dasharray': opts.dash || null,
      opacity: opts.opacity || 1,
    }));
  }

  function renderFlowchart(config) {
    const svg = document.getElementById('wf-flowchart');
    if (!svg) return;
    svg.innerHTML = '';

    const defs = svgEl('defs');
    defs.appendChild(svgEl('marker', {
      id: 'wf-arrow',
      viewBox: '0 0 10 10',
      refX: '9',
      refY: '5',
      markerWidth: '8',
      markerHeight: '8',
      orient: 'auto-start-reverse',
    }));
    defs.querySelector('#wf-arrow').appendChild(svgEl('path', {
      d: 'M 0 0 L 10 5 L 0 10 z',
      fill: '#667685',
    }));
    svg.appendChild(defs);

    const stages = [
      { x: 20, y: 20, w: 1460, h: 280, label: 'Stage 1. Ensemble Generation' },
      { x: 20, y: 330, w: 1460, h: 220, label: 'Stage 2. Annotation, Comparison, and Selection' },
      { x: 20, y: 580, w: 1460, h: 180, label: 'Stage 3. Dynamics Production' },
      { x: 20, y: 790, w: 1460, h: 250, label: 'Stage 4. Interactive Analysis' },
    ];

    stages.forEach((stage) => {
      svg.appendChild(svgEl('rect', {
        x: stage.x,
        y: stage.y,
        width: stage.w,
        height: stage.h,
        rx: 24,
        ry: 24,
        fill: 'rgba(255,255,255,0.56)',
        stroke: 'rgba(15,23,42,0.08)',
        'stroke-width': 2,
      }));
      appendText(svg, stage.x + 18, stage.y + 24, [stage.label], {
        anchor: 'start',
        fontSize: 18,
        fontWeight: 800,
        fill: '#64748b',
      });
    });

    const nodes = [
      {
        id: 'normal_modes',
        kind: 'view',
        x: 150,
        y: 92,
        w: 340,
        h: 96,
        title: ['normal_modes.html'],
        subtitle: ['sampling and geometry export'],
        href: config.pages.normal_modes || '/normal_modes.html',
        fill: '#ffffff',
        stroke: '#4b5563',
      },
      {
        id: 'md',
        kind: 'source',
        x: 930,
        y: 90,
        w: 380,
        h: 100,
        title: ['md.html'],
        subtitle: ['multi-frame XYZ import', 'local PIMD H5 import'],
        href: config.pages.md || '/md.html',
        fill: '#f7fafc',
        stroke: '#4b5563',
        badge: config.features && config.features.pimd_placeholder ? 'PIMD Soon' : '',
      },
      {
        id: 'bundle',
        kind: 'artifact',
        x: 575,
        y: 210,
        w: 350,
        h: 90,
        title: ['Geometry Bundle'],
        subtitle: ['persistent ensemble record'],
        fill: '#edf2f7',
        stroke: '#475569',
      },
      {
        id: 'qm',
        kind: 'external',
        x: 120,
        y: 390,
        w: 300,
        h: 108,
        title: ['QM Single-Point'],
        subtitle: ['external scripts'],
        fill: '#ffffff',
        stroke: '#64748b',
      },
      {
        id: 'dist',
        kind: 'view',
        x: 530,
        y: 388,
        w: 380,
        h: 112,
        title: ['distribution_compare.html'],
        subtitle: ['compare and select'],
        href: config.pages.distribution_compare || '/distribution_compare.html',
        fill: '#ffffff',
        stroke: '#4b5563',
      },
      {
        id: 'ic',
        kind: 'artifact',
        x: 1075,
        y: 396,
        w: 280,
        h: 96,
        title: ['Initial Conditions'],
        subtitle: ['selected geometry-state set'],
        fill: '#edf2f7',
        stroke: '#475569',
      },
      {
        id: 'engine',
        kind: 'external',
        x: 270,
        y: 622,
        w: 470,
        h: 100,
        title: ['PSiNad / Newton-X / SHARC-MM'],
        subtitle: ['trajectory propagation'],
        fill: '#ffffff',
        stroke: '#64748b',
      },
      {
        id: 'dataset',
        kind: 'artifact',
        x: 920,
        y: 626,
        w: 360,
        h: 92,
        title: ['Dynamics Dataset'],
        subtitle: ['analysis-ready trajectories'],
        fill: '#edf2f7',
        stroke: '#475569',
      },
      {
        id: 'dashboard',
        kind: 'view',
        x: 110,
        y: 862,
        w: 320,
        h: 104,
        title: ['index.html'],
        subtitle: ['2D trajectory panels'],
        href: config.pages.dashboard || '/index.html',
        fill: '#ffffff',
        stroke: '#4b5563',
      },
      {
        id: 'molecule3d',
        kind: 'view',
        x: 560,
        y: 862,
        w: 320,
        h: 104,
        title: ['molecule3d.html'],
        subtitle: ['3D structure viewer'],
        href: config.pages.molecule3d || '/molecule3d.html',
        fill: '#ffffff',
        stroke: '#4b5563',
      },
      {
        id: 'export',
        kind: 'output',
        x: 1080,
        y: 868,
        w: 240,
        h: 92,
        title: ['Exported'],
        subtitle: ['observables'],
        fill: '#ffffff',
        stroke: '#4b5563',
      },
    ];

    nodes.forEach((node) => createNode(svg, node));

    polyline(svg, [[320, 188], [320, 220], [590, 220]]);
    polyline(svg, [[1120, 190], [1120, 220], [910, 220]]);
    polyline(svg, [[750, 300], [750, 388], [420, 388]]);
    polyline(svg, [[420, 444], [530, 444]]);
    polyline(svg, [[910, 444], [1075, 444]]);
    polyline(svg, [[1215, 492], [1215, 560], [740, 560], [740, 622]]);
    polyline(svg, [[740, 672], [920, 672]]);
    polyline(svg, [[1100, 718], [1100, 812], [270, 812], [270, 862]]);
    polyline(svg, [[1100, 718], [1100, 812], [720, 812], [720, 862]]);
    polyline(svg, [[1100, 718], [1100, 868]]);
    polyline(svg, [[430, 914], [560, 914]], {
      markerEnd: 'url(#wf-arrow)',
      markerStart: 'url(#wf-arrow)',
      dash: '14 10',
      width: 5,
    });
  }

  function renderQuickLinks(config) {
    const container = document.getElementById('wf-quick-links');
    if (!container) return;
    container.innerHTML = '';

    const cards = [
      {
        title: 'Normal Modes Sampling',
        file: 'normal_modes.html',
        href: config.pages.normal_modes || '/normal_modes.html',
        copy: 'Upload a molden file, inspect normal modes, generate sampled geometries, and export geometry bundles.',
      },
      {
        title: 'Local MD Viewer',
        file: 'md.html',
        href: config.pages.md || '/md.html',
        copy: 'Load a multi-frame XYZ file directly in the browser, scrub frames, measure geometry, and export trajectory XYZ.',
      },
      {
        title: 'Distribution Comparison',
        file: 'distribution_compare.html',
        href: config.pages.distribution_compare || '/distribution_compare.html',
        copy: 'Compare geometry distributions and electronic spectra across cached bundles before selecting initial conditions.',
      },
      {
        title: '2D Dashboard',
        file: 'index.html',
        href: config.pages.dashboard || '/index.html',
        copy: 'Inspect trajectory observables, ensemble traces, hopping events, raw-key panels, and expression-driven plots.',
      },
      {
        title: '3D API Viewer',
        file: 'molecule3d.html',
        href: config.pages.molecule3d || '/molecule3d.html',
        copy: 'Open the dataset-backed 3D viewer for trajectory playback, vector overlays, hydrogen bonds, and media export.',
      },
    ];

    cards.forEach((card) => {
      const link = document.createElement('a');
      link.className = 'quick-link';
      link.href = card.href;

      const file = document.createElement('span');
      file.className = 'quick-link-file';
      file.textContent = card.file;

      const title = document.createElement('span');
      title.className = 'quick-link-title';
      title.textContent = card.title;

      const copy = document.createElement('p');
      copy.className = 'quick-link-copy';
      copy.textContent = card.copy;

      const meta = document.createElement('div');
      meta.className = 'quick-link-meta';
      meta.textContent = 'Open page';

      link.appendChild(file);
      link.appendChild(title);
      link.appendChild(copy);
      link.appendChild(meta);
      container.appendChild(link);
    });
  }

  const config = readConfig();
  renderFlowchart(config);
  renderQuickLinks(config);
})();
