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
      'stroke-width': opts.width || 4,
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
      viewBox: '0 0 8 8',
      refX: '7.2',
      refY: '4',
      markerWidth: '6',
      markerHeight: '6',
      orient: 'auto-start-reverse',
    }));
    defs.querySelector('#wf-arrow').appendChild(svgEl('path', {
      d: 'M 0 0 L 8 4 L 0 8 z',
      fill: '#667685',
    }));
    svg.appendChild(defs);

    const stages = [
      { id: 'stage1', x: 20, y: 20, w: 1460, h: 210, label: 'Stage 1. Ensemble Generation', routeY: 62 },
      { id: 'stage2', x: 20, y: 260, w: 1460, h: 210, label: 'Stage 2. Annotation, Comparison, and Selection', routeY: 312 },
      { id: 'stage3', x: 20, y: 500, w: 1460, h: 190, label: 'Stage 3. Dynamics Production', routeY: 552 },
      { id: 'stage4', x: 20, y: 720, w: 1460, h: 230, label: 'Stage 4. Interactive Analysis', routeY: 772 },
    ];

    stages.forEach((stage) => {
      svg.appendChild(svgEl('rect', {
        x: stage.x,
        y: stage.y,
        width: stage.w,
        height: stage.h,
        rx: 24,
        ry: 24,
        fill: 'rgba(15,23,42,0.02)',
        stroke: 'rgba(15,23,42,0.12)',
        'stroke-width': 1.6,
      }));
      appendText(svg, stage.x + 18, stage.y + 24, [stage.label], {
        anchor: 'start',
        fontSize: 18,
        fontWeight: 800,
        fill: '#5b6570',
      });
    });

    const nodes = [
      {
        id: 'normal_modes',
        kind: 'view',
        x: 120,
        y: 104,
        w: 360,
        h: 96,
        title: ['normal_modes.html'],
        subtitle: ['sampling and export'],
        href: config.pages.normal_modes || '/normal_modes.html',
        fill: '#ffffff',
        stroke: '#4b5563',
      },
      {
        id: 'md',
        kind: 'view',
        x: 1020,
        y: 104,
        w: 300,
        h: 96,
        title: ['md.html'],
        subtitle: ['MD / PIMD import'],
        href: config.pages.md || '/md.html',
        fill: '#ffffff',
        stroke: '#4b5563',
      },
      {
        id: 'bundle',
        kind: 'artifact',
        x: 560,
        y: 106,
        w: 380,
        h: 92,
        title: ['Geometry Bundle'],
        subtitle: ['persistent ensemble record'],
        fill: '#edf2f7',
        stroke: '#475569',
      },
      {
        id: 'qm',
        kind: 'external',
        x: 102,
        y: 342,
        w: 304,
        h: 112,
        title: ['QM single-point', 'calculation'],
        subtitle: ['external scripts'],
        fill: '#ffffff',
        stroke: '#64748b',
      },
      {
        id: 'dist',
        kind: 'view',
        x: 552,
        y: 340,
        w: 336,
        h: 116,
        title: ['distribution_compare', '.html'],
        subtitle: ['compare and select'],
        href: config.pages.distribution_compare || '/distribution_compare.html',
        fill: '#ffffff',
        stroke: '#4b5563',
      },
      {
        id: 'ic',
        kind: 'artifact',
        x: 1074,
        y: 348,
        w: 292,
        h: 100,
        title: ['Initial Conditions'],
        subtitle: ['selected geometry-state set'],
        fill: '#edf2f7',
        stroke: '#475569',
      },
      {
        id: 'engine',
        kind: 'external',
        x: 186,
        y: 572,
        w: 444,
        h: 104,
        title: ['PSiNad / Newton-X / SHARC-MM'],
        subtitle: ['trajectory propagation'],
        fill: '#ffffff',
        stroke: '#64748b',
      },
      {
        id: 'dataset',
        kind: 'artifact',
        x: 822,
        y: 572,
        w: 420,
        h: 104,
        title: ['Assembled dynamics dataset'],
        subtitle: ['analysis-ready trajectories'],
        fill: '#edf2f7',
        stroke: '#475569',
      },
      {
        id: 'dashboard',
        kind: 'view',
        x: 104,
        y: 804,
        w: 280,
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
        x: 558,
        y: 804,
        w: 300,
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
        y: 808,
        w: 232,
        h: 96,
        title: ['Exported', 'observables'],
        subtitle: [],
        fill: '#ffffff',
        stroke: '#4b5563',
      },
    ];

    nodes.forEach((node) => createNode(svg, node));

    const nodeById = Object.fromEntries(nodes.map((node) => [node.id, node]));
    const stageById = Object.fromEntries(stages.map((stage) => [stage.id, stage]));
    const topCenter = (nodeId) => {
      const node = nodeById[nodeId];
      return [node.x + node.w / 2, node.y];
    };
    const bottomCenter = (nodeId) => {
      const node = nodeById[nodeId];
      return [node.x + node.w / 2, node.y + node.h];
    };
    const leftCenter = (nodeId) => {
      const node = nodeById[nodeId];
      return [node.x, node.y + node.h / 2];
    };
    const rightCenter = (nodeId) => {
      const node = nodeById[nodeId];
      return [node.x + node.w, node.y + node.h / 2];
    };
    const verticalThenHorizontal = (fromId, toId, offset = 28) => {
      const start = bottomCenter(fromId);
      const end = topCenter(toId);
      const elbowY = start[1] + offset;
      return [
        start,
        [start[0], elbowY],
        [end[0], elbowY],
        end,
      ];
    };
    const routeIntoStage = (fromId, toId, stageId, offset = 28) => {
      const start = bottomCenter(fromId);
      const end = topCenter(toId);
      const targetStage = stageById[stageId];
      const laneY = Math.max(start[1] + offset, Number(targetStage?.routeY || 0));
      return [
        start,
        [start[0], laneY],
        [end[0], laneY],
        end,
      ];
    };

    polyline(svg, [rightCenter('normal_modes'), leftCenter('bundle')]);
    polyline(svg, [leftCenter('md'), rightCenter('bundle')]);
    polyline(svg, routeIntoStage('bundle', 'qm', 'stage2', 56));
    polyline(svg, [rightCenter('qm'), leftCenter('dist')]);
    polyline(svg, [rightCenter('dist'), leftCenter('ic')]);
    polyline(svg, routeIntoStage('ic', 'engine', 'stage3', 68));
    polyline(svg, [rightCenter('engine'), leftCenter('dataset')]);
    polyline(svg, routeIntoStage('dataset', 'dashboard', 'stage4', 78));
    polyline(svg, routeIntoStage('dataset', 'molecule3d', 'stage4', 78));
    polyline(svg, routeIntoStage('dataset', 'export', 'stage4', 78));
    polyline(svg, [rightCenter('dashboard'), leftCenter('molecule3d')], {
      markerEnd: 'url(#wf-arrow)',
      markerStart: 'url(#wf-arrow)',
      dash: '14 10',
      width: 3.5,
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
        copy: 'Upload a molden file, inspect modes, generate ensembles, and export the geometry bundle record.',
      },
      {
        title: 'MD / PIMD Import',
        file: 'md.html',
        href: config.pages.md || '/md.html',
        copy: 'Import MD XYZ or standardized PIMD H5 trajectories, preview structures, and export sampled geometry bundles.',
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
        copy: 'Open the dataset-backed 3D structure viewer for trajectory playback, vector overlays, hydrogen bonds, and media export.',
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
