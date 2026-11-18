/* Git prototype: draws one log row's slice of the commit graph (a port of SimpleGraphCellPainter, PaintParameters
   and HeadNodePainter from intellij-community's vcs-log, Apache-2.0).
   Each row gets its own <svg>: the lower half of the lines that leave this row, the upper half of the lines that
   arrive from the row above, long-edge arrows, then the commit's node on top. Lines are straight between row centers.
   Git.graphPaint.metrics(rowHeight)             sizes, aligned to the screen's pixel grid like the IDE does
   Git.graphPaint.row(graph, index, rowHeight)   → <svg> for that row (graph = Git.graph.create(...) or the old layout)
   Git.graphPaint.indent(layoutRow, rowHeight)   → x where the row's text starts */
(function () {
  'use strict';
  const Git = window.Git;
  const NS = 'http://www.w3.org/2000/svg';
  const P = (Git.graphPaint = {});

  // PaintParameters, defined for a 22 px row and scaled with the row height.
  const WIDTH_NODE = 16, CIRCLE_RADIUS = 4, THICK_LINE = 1.5, GRAPH_TEXT_GAP = 2, BASE = 22, HEAD_DELTA = 2;
  const ARROW_LENGTH = 0.3, ARROW_ANGLE = Math.acos(Math.sqrt(0.7));

  const cache = new Map();
  P.metrics = function (h) {
    const scale = (window.devicePixelRatio || 1) >= 1.5 ? 2 : 1;
    const key = h + ':' + scale;
    if (cache.has(key)) return cache.get(key);
    const px = 1 / scale;
    const snap = (v) => Math.round(v / px) * px;                  // nearest device pixel
    const floorOdd = (v) => { let n = Math.floor(v / px); if (n % 2 === 0) n -= 1; return n * px; };
    const s = (v) => (v * h) / BASE;
    // Values of the IDE for the two row heights it uses, at 1x and at Retina; other heights fall back to the formulas.
    const known = {
      '24:1': { rowCenter: 11, elementWidth: 17, elementCenter: 8, line: 1, circle: 7, radius: 3, headOuter: 13, headRadius: 6, delta: 2 },
      '24:2': { rowCenter: 11.5, elementWidth: 16.5, elementCenter: 8.5, line: 1.5, circle: 8.5, radius: 4, headOuter: 12.5, headRadius: 6, delta: 2 },
      '26:1': { rowCenter: 13, elementWidth: 17, elementCenter: 9, line: 1, circle: 9, radius: 4, headOuter: 13, headRadius: 6, delta: 2 },
      '26:2': { rowCenter: 12.5, elementWidth: 18.5, elementCenter: 9, line: 1.5, circle: 8.5, radius: 4, headOuter: 13.5, headRadius: 6.5, delta: 2 },
    };
    const m = known[key] || {
      rowCenter: snap(h / 2 - px / 2), elementWidth: snap(s(WIDTH_NODE)), elementCenter: snap(s(WIDTH_NODE) / 2), line: Math.max(px, snap(s(THICK_LINE))),
      circle: floorOdd(2 * s(CIRCLE_RADIUS)), radius: Math.floor(s(CIRCLE_RADIUS)), headOuter: floorOdd(2 * s(CIRCLE_RADIUS + HEAD_DELTA)),
      headRadius: Math.floor(s(CIRCLE_RADIUS + HEAD_DELTA)), delta: Math.floor(s(HEAD_DELTA)),
    };
    m.h = h;
    m.arrow = ARROW_LENGTH * h;
    m.arrowGap = m.radius / 2 + 1;
    m.textStep = s(WIDTH_NODE);
    m.textGap = Math.floor(s(GRAPH_TEXT_GAP));
    cache.set(key, m);
    return m;
  };

  const el = (name, attrs) => {
    const node = document.createElementNS(NS, name);
    Object.keys(attrs).forEach((k) => node.setAttribute(k, attrs[k]));
    return node;
  };
  const xOf = (m, pos) => m.elementWidth * pos + m.elementCenter;

  function arrowHead(m, x, y, fromX, fromY, color) {
    // Two short strokes at the tip, turning back toward where the line comes from.
    const back = Math.atan2(fromY - y, fromX - x);
    const g = el('g', { stroke: color, 'stroke-width': m.line, 'stroke-linecap': 'round', fill: 'none' });
    [back - ARROW_ANGLE, back + ARROW_ANGLE].forEach((a) => {
      g.appendChild(el('line', { x1: x, y1: y, x2: x + m.arrow * Math.cos(a), y2: y + m.arrow * Math.sin(a) }));
    });
    return g;
  }

  /** x where a row's text starts: its own widest point, but never less than the table's recommended width. */
  P.indent = function (row, h) {
    const m = P.metrics(h);
    return Math.floor(row.cols * m.textStep) + m.textGap;
  };

  /** The edge under a point of row `index`'s cell (x, y in the cell's pixels), IntelliJ's click on an edge: the nearest
      line within 4 px, not on the commit's node. → { up, down } (the edge's two rows) or null. No DOM. */
  P.edgeAt = function (layout, index, x, y, h) {
    const m = P.metrics(h);
    const get = layout.withEnds ? (i) => layout.withEnds(i) : (i) => layout.row(i);
    const row = get(index), above = index > 0 ? get(index - 1) : null;
    if (!row) return null;
    const c = m.rowCenter;
    if (Math.hypot(x - xOf(m, row.pos), y - c) <= m.radius + 2) return null;
    const dist = (x1, y1, x2, y2) => {
      const dx = x2 - x1, dy = y2 - y1, len = dx * dx + dy * dy;
      const k = len ? Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / len)) : 0;
      return Math.hypot(x - (x1 + k * dx), y - (y1 + k * dy));
    };
    let best = null, bestD = 4;
    const look = (lines, y0) => (lines || []).forEach((l) => {
      if (l.up == null) return;
      const d = dist(xOf(m, l.from), y0, xOf(m, l.to), y0 + h);
      if (d <= bestD) { bestD = d; best = { up: l.up, down: l.down }; }
    });
    if (above) look(above.lines, c - h);
    look(row.lines, c);
    return best;
  };

  /** `layout` is either Git.graph.create(...) (rows read with layout.row(i)) or the old { rows } of Git.graph.layout. */
  P.row = function (layout, index, h) {
    const m = P.metrics(h);
    const get = typeof layout.row === 'function' ? (i) => layout.row(i) : (i) => layout.rows[i];
    const row = get(index);
    const above = index > 0 ? get(index - 1) : null;
    const width = P.indent(row, h);
    const svg = el('svg', { class: 'g-graph', width, height: h, viewBox: '0 0 ' + width + ' ' + h, 'aria-hidden': 'true', focusable: 'false' });
    svg.style.overflow = 'hidden';
    // Dashed edges of a filtered log (SimpleGraphCellPainter: gap = half a row - 2, the dash centered on the row).
    const line = (x1, y1, x2, y2, color, dashed) => {
      const ln = el('line', { x1, y1, x2, y2, stroke: color, 'stroke-width': m.line, 'stroke-linecap': 'round' });
      if (dashed) {
        const len = x2 - x1 ? Math.hypot(x2 - x1, y2 - y1) : h, gap = h / 2 - 2, dash = len / Math.max(1, Math.floor(len / h)) - gap;
        ln.setAttribute('stroke-dasharray', dash + ' ' + gap);
        ln.setAttribute('stroke-dashoffset', dash / 2);
      }
      svg.appendChild(ln);
    };
    const c = m.rowCenter;
    if (above) {
      above.lines.forEach((l) => {
        line(xOf(m, l.from), c - h, xOf(m, l.to), c, l.color, l.dashed && !l.arrow);
        if (l.arrow) { const mx = (xOf(m, l.from) + xOf(m, l.to)) / 2; svg.appendChild(arrowHead(m, mx, 0, xOf(m, l.to), c, l.color)); }
      });
    }
    row.lines.forEach((l) => {
      line(xOf(m, l.from), c, xOf(m, l.to), c + h, l.color, l.dashed && !l.arrow);
      if (l.arrow) { const mx = (xOf(m, l.from) + xOf(m, l.to)) / 2; svg.appendChild(arrowHead(m, mx, h, xOf(m, l.from), c, l.color)); }
    });
    row.stubs.forEach((s) => {
      const x = xOf(m, s.pos);
      const y = s.dir === 'down' ? h - m.arrowGap : m.arrowGap;
      // a not loaded parent (history cut at the cap) keeps its id as the target, marked so the Log can tell it apart
      const g = el('g', { class: 'g-graph-stub', 'data-dir': s.dir });
      if (s.target) g.setAttribute('data-target', s.target);
      if (s.notLoaded) g.setAttribute('data-not-loaded', '');
      g.appendChild(el('line', { x1: x, y1: c, x2: x, y2: y, stroke: s.color, 'stroke-width': m.line, 'stroke-linecap': 'round' }));
      g.appendChild(arrowHead(m, x, y, x, c, s.color));
      g.appendChild(el('rect', { x: x - m.elementWidth / 2, y: 0, width: m.elementWidth, height: h, fill: 'transparent' }));
      svg.appendChild(g);
    });
    (row.upArrow || []).forEach((a) => svg.appendChild(arrowHead(m, xOf(m, a.pos), 0, xOf(m, a.pos), c, a.color)));

    // The node. A circle is placed by its top-left corner (center - radius) and its diameter, as the IDE does.
    const x0 = xOf(m, row.pos);
    const circle = (radius, diameter, fill, cls) => svg.appendChild(el('circle', { cx: x0 - radius + diameter / 2, cy: c - radius + diameter / 2, r: diameter / 2, fill, class: cls || '' }));
    if (row.head) {
      circle(m.headRadius, m.headOuter, row.color);
      circle(m.headRadius - m.delta, m.headOuter - 2 * m.delta, 'var(--g-row-bg, var(--g-panel))', 'g-graph-ring');
      circle(m.headRadius - 2 * m.delta, m.headOuter - 4 * m.delta, row.color);
    } else {
      circle(m.radius, m.circle, row.color);
    }
    return svg;
  };
})();
