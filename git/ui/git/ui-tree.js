/* Git.tree: the virtual tree list every file and branch tree is built on (see git/README.md for the contract).
   Needs ui.js (Git.h, Git.icon, Git.checkbox) and, when a tree is created, vlist.js. */
(function () {
  'use strict';
  const Git = (window.Git = window.Git || {});
  const h = Git.h;
  /** Tree list. `o`: { el, nodes(): [node], multi, onSelect(nodes), onActivate(node, ev), onContext(node, ev, nodes), onCheck(node, checked), onToggle,
        emptyText, rowHeight, dragSelect (a press on a selected row keeps a multi-selection until the release; see tree.keepSelection),
        onPick(node, ev) (the reader picked one row: a plain single click that leaves it the only selected row, or the
        selection moved by the arrow keys; not a ⌘/Shift click, a checkbox, a context menu, a drag or a selection made by code) }.
      node: { id, label, icon (name or element), color, bold, italic, strike, dim (grey text after the label), right (element or text at the row's end),
        children, open (initial; default true), checked (true|false|'mixed'; presence shows a checkbox), tooltip, data, selectable (default true), kind }
      Virtual: only the rows in view are in the DOM (needs vlist.js loaded); `el` should be the scroll container with a
      height of its own (a tree whose element grows with its content still works, it just draws every row). */
  Git.tree = function (o) {
    const el = o.el;
    el.classList.add('g-tree');
    el.tabIndex = 0;
    el.setAttribute('role', 'tree');
    const open = new Map();
    let selected = [], selSet = new Set();
    let rows = [], index = new Map();               // visible rows in order; node id -> row (first occurrence)
    let anchor = null, empty = null;
    const rowIndex = new WeakMap();                 // row element -> row
    const tree = { el };
    const isOpen = (n) => (open.has(n.id) ? open.get(n.id) : n.open !== false);
    const at = (id) => (index.has(id) ? index.get(id) : -1);
    const setSelected = (ids) => { selected = ids; selSet = new Set(ids); };
    /** A work tree folder (`nodes/folder`; not a branch folder, kind 'folder') in the host's icon theme, open or
        closed: its HTML, or '' for IntelliJ's icon (ui.js Git.folderIconHTML). */
    const hostFolder = (n, folder) => (n.icon === 'nodes/folder' && n.kind !== 'folder' && typeof n.label === 'string' && Git.folderIconHTML
      ? Git.folderIconHTML(n.label, folder && isOpen(n)) : '');

    function flatten() {
      rows = [];
      index = new Map();
      const walk = (list, depth, parent) => list.forEach((n) => {
        if (!index.has(n.id)) index.set(n.id, rows.length);
        rows.push({ node: n, depth, parent });
        if (n.children && n.children.length && isOpen(n)) walk(n.children, depth + 1, n);
      });
      walk(o.nodes() || [], 0, null);
    }
    // Only the rows in view are in the DOM (vlist.js); the rest are drawn when they scroll in.
    function drawRow(i) {
      const r = rows[i], n = r.node;
      const folder = !!(n.children && n.children.length), on = selSet.has(n.id);
      const row = h('div.g-row', { role: 'treeitem', dataset: { id: n.id }, title: n.tooltip, 'aria-selected': String(on),
        'aria-expanded': folder ? String(isOpen(n)) : null, class: (on ? 'sel ' : '') + (n.kind ? 'k-' + n.kind : ''),
        style: { paddingLeft: 6 + r.depth * 16 + 'px' } });
      row.appendChild(h('span.g-row-chev', { class: folder ? (isOpen(n) ? 'open' : '') : 'none',
        onclick: (e) => { e.stopPropagation(); if (folder) tree.toggle(n.id); } }, folder ? Git.icon('chevronRight', 16) : null));
      if (n.checked !== undefined) {
        // the node of this id now (a render that kept this row may have new node objects behind it)
        const now = () => (index.has(n.id) ? rows[index.get(n.id)].node : n);
        row.appendChild(Git.checkbox({ checked: n.checked, onChange: (v) => o.onCheck && o.onCheck(now(), v) }));
      }
      const dirIcon = hostFolder(n, folder);
      if (dirIcon) row.appendChild(h('span.g-file-ic', { html: dirIcon, 'aria-hidden': 'true' }));
      else if (n.icon) row.appendChild(n.icon.nodeType ? n.icon : Git.icon(n.icon));
      row.appendChild(h('span.g-row-label', { class: (n.bold ? 'bold ' : '') + (n.italic ? 'italic ' : '') + (n.strike ? 'strike' : ''), style: n.color ? { color: n.color } : null }, n.label));
      if (n.dim) row.appendChild(h('span.g-row-dim', n.dim));
      if (n.right) row.appendChild(h('span.g-row-right', n.right));
      rowIndex.set(row, r);
      return row;
    }
    if (!Git.vlist) throw new Error('Git.tree needs ui/git/vlist.js (add <script src="vlist.js"> to the page)');
    const rowHeight = () => o.rowHeight || parseFloat(getComputedStyle(el).getPropertyValue('--g-row')) || 24;
    const list = Git.vlist({ el, rowHeight, count: () => rows.length, render: drawRow, overscan: 10 });

    /** What drawRow would draw for the rows, as a string: a render that would draw the same keeps the rows in the DOM
        (a busy repository re-renders its trees on every status or refs event; replacing the rows under the wheel makes
        scrolling stick). Elements (icons, a branch's sync counters) count by their markup. */
    const part = (x) => (x == null ? '' : x.nodeType ? x.outerHTML : String(x));
    function signature() {
      return rows.map((r) => { const n = r.node; return [n.id, r.depth, n.children && n.children.length ? (isOpen(n) ? 'o' : 'c') : '', String(n.checked),
        hostFolder(n, !!(n.children && n.children.length)) || part(n.icon), part(n.label), n.bold ? 1 : 0, n.italic ? 1 : 0, n.strike ? 1 : 0, n.color || '', part(n.dim), part(n.right), n.tooltip || '', n.kind || '',
        selSet.has(n.id) ? 1 : 0].join('\u0001'); }).join('\u0002') + '\u0003' + (empty ? empty.textContent : '');
    }
    let drawn = null;
    tree.render = function () {
      flatten();
      setSelected(selected.filter((id) => index.has(id)));
      const none = !rows.length && !!o.emptyText;
      if (none && !empty) empty = el.insertBefore(h('div.g-tree-empty'), list.inner);
      if (empty) { if (none) empty.textContent = o.emptyText; else { empty.remove(); empty = null; } }
      const sig = signature();
      if (sig === drawn) {
        list.each((row, i) => { if (rows[i]) rowIndex.set(row, rows[i]); });   // the kept rows answer for the new nodes
        return tree;
      }
      drawn = sig;
      list.refresh();
      return tree;
    };

    function emit() { if (o.onSelect) o.onSelect(tree.selected()); }
    function mark() {
      list.each((row, i) => {
        const on = selSet.has(rows[i].node.id);
        row.classList.toggle('sel', on);
        row.setAttribute('aria-selected', String(on));
      });
    }
    tree.selected = () => selected.map((id) => (index.has(id) ? rows[index.get(id)].node : null)).filter(Boolean);
    tree.select = function (ids, quiet) {
      setSelected((Array.isArray(ids) ? ids : ids == null ? [] : [ids]).filter((id) => index.has(id)));
      anchor = selected[selected.length - 1] || null;
      mark();
      if (anchor != null) list.scrollTo(index.get(anchor), { align: 'nearest' });
      if (!quiet) emit();
      return tree;
    };
    tree.toggle = function (id, value) {
      const r = index.has(id) ? rows[index.get(id)] : null;
      if (!r) return;
      const v = value == null ? !isOpen(r.node) : value;
      open.set(id, v);
      if (o.onToggle) o.onToggle(r.node, v);
      tree.render();
    };
    tree.expandAll = function () { const all = (list) => list.forEach((n) => { if (n.children) { open.set(n.id, true); all(n.children); } }); all(o.nodes() || []); tree.render(); };
    tree.collapseAll = function () { const all = (list) => list.forEach((n) => { if (n.children) { open.set(n.id, false); all(n.children); } }); all(o.nodes() || []); tree.render(); };
    tree.rows = () => rows.map((r) => r.node);

    const rowOf = (e) => { const row = e.target.closest && e.target.closest('.g-row'); return (row && el.contains(row) && rowIndex.get(row)) || null; };
    // `o.dragSelect` (a tree whose rows can be dragged): a plain press on a row of a multi-selection keeps the selection
    // (the drag takes all of it); the release selects that row alone unless a drag began (tree.keepSelection()), as
    // Swing's tree does with drag enabled.
    let pressed = null;
    const released = () => {
      document.removeEventListener('mouseup', released, true);
      const id = pressed;
      pressed = null;
      if (id == null || !index.has(id)) return;
      setSelected([id]);
      mark();
      emit();
    };
    tree.keepSelection = function () { pressed = null; };
    el.addEventListener('mousedown', (e) => {
      const r = rowOf(e);
      if (!r || e.target.closest('.g-check') || e.target.closest('.g-row-chev')) return;
      if (r.node.selectable === false) return;
      const id = r.node.id;
      if (e.button === 2 && selSet.has(id)) return;
      if (o.dragSelect && e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && selected.length > 1 && selSet.has(id)) {
        anchor = id;
        pressed = id;
        document.addEventListener('mouseup', released, true);
        return;
      }
      if (o.multi && (e.metaKey || e.ctrlKey) && e.button === 0) setSelected(selSet.has(id) ? selected.filter((x) => x !== id) : selected.concat(id));
      else if (o.multi && e.shiftKey && anchor) {
        const a = at(anchor), b = at(id);
        setSelected(rows.slice(Math.min(a, b), Math.max(a, b) + 1).filter((x) => x.node.selectable !== false).map((x) => x.node.id));
      } else setSelected([id]);
      if (!e.shiftKey) anchor = id;
      mark();
      emit();
    });
    // a click is the end of a press without a drag (a drag's release click is eaten, commit-drag.js); the second click
    // of a double click is not a pick (the double click activates)
    el.addEventListener('click', (e) => {
      if (!o.onPick || e.button !== 0 || e.detail > 1 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const r = rowOf(e);
      if (!r || e.target.closest('.g-check') || e.target.closest('.g-row-chev')) return;
      if (selected.length === 1 && selected[0] === r.node.id) o.onPick(r.node, e);
    });
    const picked = (e) => { if (o.onPick && selected.length === 1 && index.has(selected[0])) o.onPick(rows[index.get(selected[0])].node, e); };
    el.addEventListener('dblclick', (e) => {
      const r = rowOf(e);
      if (!r || e.target.closest('.g-check')) return;
      if (r.node.children && r.node.children.length && !o.activateFolders) tree.toggle(r.node.id);
      else if (o.onActivate) o.onActivate(r.node, e);
    });
    el.addEventListener('contextmenu', (e) => {
      const r = rowOf(e);
      if (!o.onContext) return;
      e.preventDefault();
      if (r) o.onContext(r.node, e, tree.selected());
    });
    el.addEventListener('keydown', (e) => {
      const i = at(anchor);
      const go = (k) => { const r = rows[Math.max(0, Math.min(rows.length - 1, k))]; if (r) tree.select(r.node.id); };
      const plain = !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
      if (e.key === 'ArrowDown') { e.preventDefault(); go(i + 1); if (plain) picked(e); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); go(i < 0 ? 0 : i - 1); if (plain) picked(e); }
      else if (e.key === 'ArrowRight' && i >= 0) { e.preventDefault(); const n = rows[i].node; if (n.children && n.children.length && !isOpen(n)) tree.toggle(n.id, true); else go(i + 1); }
      else if (e.key === 'ArrowLeft' && i >= 0) { e.preventDefault(); const r = rows[i]; if (r.node.children && r.node.children.length && isOpen(r.node)) tree.toggle(r.node.id, false); else if (r.parent) tree.select(r.parent.id); }
      else if (e.key === 'Enter' && i >= 0 && o.onActivate) { e.preventDefault(); o.onActivate(rows[i].node, e); }
      else if (e.key === ' ' && i >= 0 && rows[i].node.checked !== undefined && o.onCheck) { e.preventDefault(); o.onCheck(rows[i].node, rows[i].node.checked !== true); }
      else if (o.onKey) o.onKey(e, tree.selected());
    });
    return tree;
  };
})();
