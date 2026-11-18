/* Git prototype: shared UI pieces every Git view is built from (see git/README.md for the contract).
   Git.h, Git.icon, Git.btn, Git.toolBtn, Git.checkbox, Git.field, Git.menu, Git.popup, Git.dialog,
   Git.splitter, Git.tree, balloons for Git.notify, the shared labels (Git.t and the languages: lang.js). */
(function () {
  'use strict';
  const Git = (window.Git = window.Git || {});

  const prefs = () => (Git.host && Git.host.prefs) || { get: (k, d) => d, set() {} };

  // ---------------------------------------------------------------- labels (Git.t, Git.addTR, Git.setLang: lang.js)
  Git.addTR({ 'Today': 'Bugün', 'Yesterday': 'Dün', 'Moments ago': 'Az önce', 'A minute ago': '1 dakika önce', '{0} minutes ago': '{0} dakika önce',
    '1 hour ago': '1 saat önce', 'Cancel': 'Vazgeç', 'OK': 'Tamam', 'Close': 'Kapat', 'Apply': 'Uygula', 'Loading…': 'Yükleniyor…',
    'Error loading changes': 'Değişiklikler yüklenemedi' });

  // ---------------------------------------------------------------- DOM
  /** h('div.a.b#id', { title, style, onclick, dataset, hidden, ... }, ...children) */
  Git.h = function (spec, attrs, ...kids) {
    const m = /^([a-z0-9]+)?((?:[.#][\w-]+)*)$/i.exec(spec) || [];
    const el = document.createElement(m[1] || 'div');
    (m[2] || '').replace(/([.#])([\w-]+)/g, (_, kind, name) => { if (kind === '.') el.classList.add(name); else el.id = name; });
    if (attrs && (attrs.nodeType || typeof attrs !== 'object' || Array.isArray(attrs))) { kids.unshift(attrs); attrs = null; }
    Object.keys(attrs || {}).forEach((k) => {
      const v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'class') String(v).split(/\s+/).filter(Boolean).forEach((c) => el.classList.add(c));
      else if (k === 'style' && typeof v === 'object') Object.keys(v).forEach((p) => (p.startsWith('--') ? el.style.setProperty(p, v[p]) : (el.style[p] = v[p])));
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'text') el.textContent = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'hidden' || k === 'disabled' || k === 'checked' || k === 'readOnly' || k === 'value' || k === 'tabIndex' || k === 'indeterminate') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    });
    const add = (kid) => {
      if (kid == null || kid === false) return;
      if (Array.isArray(kid)) kid.forEach(add);
      else el.appendChild(kid.nodeType ? kid : document.createTextNode(String(kid)));
    };
    kids.forEach(add);
    return el;
  };
  const h = Git.h;
  Git.clear = function (el) { while (el.firstChild) el.removeChild(el.firstChild); return el; };

  /** An IntelliJ icon by name (git/icons.js holds the SVG sources). */
  Git.icon = function (name, size) {
    const svg = (Git.ICONS || {})[name];
    const el = h('span.g-ic', { 'aria-hidden': 'true', dataset: { ic: name } });
    if (svg) el.innerHTML = svg; else el.classList.add('g-ic-missing');
    if (size) { el.style.width = size + 'px'; el.style.height = size + 'px'; }
    return el;
  };

  Git.btn = function (label, o) {
    o = o || {};
    return h('button.g-btn', { type: 'button', id: o.id, class: (o.primary ? 'primary ' : '') + (o.danger ? 'danger ' : '') + (o.small ? 'small' : ''),
      disabled: !!o.disabled, title: o.title, onclick: o.onClick }, label);
  };

  /** Icon button of a toolbar. `o`: { icon, title, onClick, active, disabled, arrow, id, label } */
  Git.toolBtn = function (o) {
    return h('button.g-tool', { type: 'button', id: o.id, title: o.title, 'aria-label': o.title, 'aria-pressed': o.active == null ? null : String(!!o.active),
      class: (o.active ? 'on ' : '') + (o.label ? 'with-label' : ''), disabled: !!o.disabled, onclick: o.onClick },
      o.icon ? Git.icon(o.icon) : null, o.label ? h('span', o.label) : null, o.arrow ? Git.icon('chevronDownSmall', 12) : null);
  };

  Git.checkbox = function (o) {
    const input = h('input', { type: 'checkbox', id: o.id, checked: o.checked === true, indeterminate: o.checked === 'mixed', disabled: !!o.disabled,
      onchange: (e) => o.onChange && o.onChange(e.target.checked, e) });
    return h('label.g-check', { class: o.disabled ? 'disabled' : '', title: o.title }, input, h('span.g-check-box'), o.label ? h('span.g-check-label', o.label) : null);
  };

  Git.radio = function (o) {
    const input = h('input', { type: 'radio', name: o.name, id: o.id, checked: !!o.checked, value: o.value, onchange: () => o.onChange && o.onChange(o.value) });
    return h('label.g-check.radio', input, h('span.g-check-box'), h('span.g-check-label', o.label), o.hint ? h('span.g-check-hint', o.hint) : null);
  };

  /** Text field. `o`: { id, value, placeholder, onInput, onEnter, icon, mono, multiline, rows } */
  Git.field = function (o) {
    const input = h(o.multiline ? 'textarea' : 'input', { id: o.id, class: 'g-input' + (o.mono ? ' mono' : ''), placeholder: o.placeholder, spellcheck: 'false',
      rows: o.rows, 'aria-label': o.label || o.placeholder, autocomplete: 'off',
      oninput: (e) => o.onInput && o.onInput(e.target.value),
      onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey && !o.multiline && o.onEnter) { e.preventDefault(); o.onEnter(e.target.value); } } });
    if (!o.multiline) input.type = 'text';
    input.value = o.value || '';
    const wrap = h('div.g-field', o.icon ? Git.icon(o.icon) : null, input, o.trailing || null);
    wrap.input = input;
    return wrap;
  };

  // ---------------------------------------------------------------- menus (the shell's menu component, menu.js)
  /** Opens a menu at an element (below it) or at a mouse event. `items`: { label, shortcut, checked, disabled, danger, action, children } or '-'. */
  Git.menu = function (at, items, opts) {
    let x, y;
    if (at && at.nodeType) { const r = at.getBoundingClientRect(); x = r.left; y = r.bottom + 2; }
    else if (at && at.clientX != null) { x = at.clientX; y = at.clientY; if (at.preventDefault) at.preventDefault(); }
    else { x = at.x; y = at.y; }
    const list = items.filter((it, i) => !(it === '-' && (i === 0 || i === items.length - 1 || items[i - 1] === '-')));
    if (Git.popupMenu) return Git.popupMenu.show(x, y, list, { width: (opts && opts.width) || Git.popupMenu.width(list) });
    return fallbackMenu(x, y, list);
  };
  function fallbackMenu(x, y, items) {
    const box = h('div.g-menu');
    let pop;
    items.forEach((it) => {
      if (it === '-') { box.appendChild(h('div.g-menu-sep')); return; }
      box.appendChild(h('button.g-menu-item', { type: 'button', disabled: !!it.disabled, class: it.danger ? 'danger' : '',
        onclick: (e) => { if (it.children) { Git.menu({ x: e.clientX + 8, y: e.clientY }, it.children); return; } pop.close(); if (it.action) it.action(); } },
        h('span.g-menu-check', it.checked ? '✓' : ''), h('span.g-menu-label', it.label), it.shortcut ? h('span.g-menu-key', it.shortcut) : null,
        it.children ? h('span.g-menu-key', '›') : null));
    });
    pop = Git.popup({ x, y, content: box });
    return pop;
  }

  // ---------------------------------------------------------------- popups
  // ---------------------------------------------------------------- the focus sink (the Esc rule)
  /* A host that embeds the page may close it on Esc unless a text field (input, textarea, select, contentEditable) has
     focus (the Esc rule). While
     a menu, popup or dialog of ours is open, an editable element inside it holds focus: its own field, or this
     read-only input when it has none. Keys still reach the overlay's handlers (they bubble from the sink). A click on
     a button inside an overlay moves focus back to the sink; Tab still walks the controls (keyboard navigation). */
  const EDITABLE = /^(INPUT|TEXTAREA|SELECT)$/;
  Git.isEditable = (el) => !!el && (EDITABLE.test(el.tagName) && !(el.tagName === 'INPUT' && /^(checkbox|radio|button|submit|range|color|file)$/i.test(el.type)) || el.isContentEditable === true);
  Git.focusSink = function (kind) {
    const sink = document.createElement('input');
    sink.type = 'text';
    sink.readOnly = true;
    sink.tabIndex = -1;
    sink.className = 'g-sink';
    sink.dataset.sink = kind || 'overlay';
    sink.setAttribute('aria-hidden', 'true');
    sink.autocomplete = 'off';
    return sink;
  };
  const focusQuiet = (el) => { try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); } };
  /** The innermost open overlay element that contains `node` (menus, popups, dialogs). */
  function overlayOf(node) {
    return node && node.closest ? node.closest('.cmenu, .g-popup, .g-dialog') : null;
  }
  let pointerAt = 0;
  document.addEventListener('mousedown', () => { pointerAt = Date.now(); }, true);
  document.addEventListener('focusin', (e) => {
    const box = overlayOf(e.target);
    if (!box || Git.isEditable(e.target) || Date.now() - pointerAt > 600) return;
    const sink = box.querySelector(':scope > .g-sink, :scope > .g-dialog-sinkwrap > .g-sink') || box.querySelector('.g-sink');
    if (sink && sink !== e.target) focusQuiet(sink);
  });
  // A click inside an overlay that leaves focus nowhere (WebKit does not focus a clicked button; a control that redraws
  // its list removes the focused row) brings it back to that overlay's sink, so Esc stays the overlay's.
  document.addEventListener('click', (e) => {
    const box = overlayOf(e.target);
    if (!box) return;
    setTimeout(() => {
      if (!box.isConnected) return;
      const a = document.activeElement;
      if (a && a !== document.body && (box.contains(a) || overlayOf(a))) return;
      const sink = box.querySelector(':scope > .g-sink, :scope > .g-dialog-sinkwrap > .g-sink') || box.querySelector('.g-sink');
      if (sink) focusQuiet(sink);
    }, 0);
  }, true);
  /** Puts focus on the overlay's sink unless an editable element inside it already has it, or the overlay belongs to
      the focused text field: a list under a field (its `anchor` holds the field) or a submenu of a popup whose own
      field has the keyboard (its parent holds it). That field keeps focus and the list follows its keys; taking the
      focus away would blur the field, and a field's blur closes its list. */
  function holdFocus(box, sink, owners) {
    const a = document.activeElement;
    if (a && Git.isEditable(a) && (box.contains(a) || (owners || []).some((x) => x && x.contains && x.contains(a)))) return;
    focusQuiet(sink);
  }

  const stack = [];
  /** Floating panel. `o`: { anchor | x,y, content, placement: 'below'|'right'|'above', width, className, onClose, parent } */
  Git.popup = function (o) {
    const sink = Git.focusSink('popup');
    const el = h('div.g-popup', { class: o.className || '', role: 'dialog' }, sink, o.content);
    if (o.width) el.style.width = o.width + 'px';
    (document.getElementById('g-layer') || document.body).appendChild(el);
    const before = document.activeElement;
    const pop = { el, parent: o.parent || null, closed: false, sink };
    pop.place = function () {
      const vw = window.innerWidth, vh = window.innerHeight;
      const w = el.offsetWidth, ht = el.offsetHeight;
      let x = o.x || 0, y = o.y || 0;
      if (o.anchor) {
        const r = o.anchor.getBoundingClientRect();
        if (o.placement === 'right') { x = r.right + 2; y = r.top - 4; if (x + w > vw - 8) x = r.left - w - 2; }
        else if (o.placement === 'above') { x = r.left; y = r.top - ht - 4; }
        else { x = r.left; y = r.bottom + 4; if (y + ht > vh - 8 && r.top - ht - 4 > 8) y = r.top - ht - 4; }
      }
      el.style.left = Math.max(8, Math.min(x, vw - w - 8)) + 'px';
      el.style.top = Math.max(8, Math.min(y, vh - ht - 8)) + 'px';
    };
    pop.close = function () {
      if (pop.closed) return;
      pop.closed = true;
      stack.filter((p) => p.parent === pop).forEach((p) => p.close());
      const i = stack.indexOf(pop);
      if (i >= 0) stack.splice(i, 1);
      const had = el.contains(document.activeElement);
      el.remove();
      if (had && before && before.isConnected) focusQuiet(before);
      if (o.onClose) o.onClose();
    };
    stack.push(pop);
    pop.place();
    holdFocus(el, sink, [o.anchor, o.parent && o.parent.el]);
    return pop;
  };
  Git.closePopups = function () { stack.slice().forEach((p) => p.close()); };
  document.addEventListener('mousedown', (e) => {
    // Clicking outside closes a popup unless the click is inside one of its descendants.
    if (e.target && e.target.closest && e.target.closest('.cmenu')) return;   // a menu opened from a popup
    stack.slice().forEach((p) => {
      const inside = (q) => q.el.contains(e.target) || stack.some((c) => c.parent === q && inside(c));
      if (!inside(p) && !(p.keepFor && p.keepFor.contains(e.target))) p.close();
    });
  }, true);
  document.addEventListener('keydown', (e) => {
    // An open menu takes its own Esc first (it may sit over a popup).
    if (e.key === 'Escape' && stack.length && !(Git.popupMenu && Git.popupMenu.isOpen())) { e.stopPropagation(); e.preventDefault(); stack[stack.length - 1].close(); }
  }, true);

  // ---------------------------------------------------------------- dialogs
  const dialogs = [];
  /** Modal dialog over the page. `o`: { title, content, buttons: [{ label, primary, danger, id, disabled, keepOpen, onClick(dlg) }],
      left (footer's left side), width, height, className, onClose }. Enter runs the primary button, Esc closes. */
  Git.dialog = function (o) {
    const body = h('div.g-dialog-body', o.content);
    const footer = h('div.g-dialog-footer');
    const dlg = { closed: false, body, footer, buttons: {} };
    const left = h('div.g-dialog-left', o.left || null);
    footer.appendChild(left);
    (o.buttons || []).forEach((b) => {
      const el = Git.btn(b.label, { primary: b.primary, danger: b.danger, disabled: b.disabled, id: b.id, title: b.title,
        onClick: () => { const keep = b.onClick ? b.onClick(dlg) === false : false; if (!b.keepOpen && !keep) dlg.close(); } });
      if (b.primary) dlg.primary = el;
      if (b.id) dlg.buttons[b.id] = el;
      footer.appendChild(el);
    });
    const title = h('div.g-dialog-title', h('span.g-dialog-title-text', o.title || ''),
      h('button.g-dialog-x', { type: 'button', title: Git.t('Close'), 'aria-label': Git.t('Close'), onclick: () => dlg.close() }, Git.icon('close')));
    const sink = Git.focusSink('dialog');
    const box = h('div.g-dialog', { class: o.className || '', role: 'dialog', 'aria-modal': 'true', 'aria-label': o.title || '' }, sink, title, body, footer);
    const before = document.activeElement;
    if (o.width) box.style.width = o.width + 'px';
    if (o.height) box.style.height = o.height + 'px';
    const shade = h('div.g-shade', box);
    dlg.el = box;
    dlg.setTitle = (t) => { title.firstChild.textContent = t; };
    dlg.close = function () {
      if (dlg.closed) return;
      dlg.closed = true;
      const had = shade.contains(document.activeElement);
      shade.remove();
      const i = dialogs.indexOf(dlg);
      if (i >= 0) dialogs.splice(i, 1);
      if (had && before && before.isConnected) focusQuiet(before);
      if (o.onClose) o.onClose();
    };
    shade.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !stack.length) { e.stopPropagation(); e.preventDefault(); dlg.close(); }
      if (e.key === 'Enter' && dlg.primary && !dlg.primary.disabled && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'BUTTON') { e.preventDefault(); dlg.primary.click(); }
    });
    (document.getElementById('g-layer') || document.body).appendChild(shade);
    dialogs.push(dlg);
    // A field of the dialog takes focus; without one the sink holds it (not the primary button: Esc there would
    // close the embedding host's page). Enter still runs the primary button (the keydown above).
    const field = Array.prototype.find.call(box.querySelectorAll('[autofocus], input:not(.g-sink), textarea, select'), (x) => Git.isEditable(x) && !x.disabled);
    focusQuiet(sink);
    if (field) setTimeout(() => { if (!dlg.closed) focusQuiet(field); }, 0);
    return dlg;
  };
  Git.openDialogs = () => dialogs.slice();

  /** Yes/No style question. Resolves through `onYes`. */
  Git.confirm = function (o) {
    return Git.dialog({ title: o.title, width: o.width || 420, className: 'g-confirm',
      content: h('div.g-confirm-text', o.text, o.detail ? h('div.g-confirm-detail', o.detail) : null),
      buttons: [{ label: o.no || Git.t('Cancel') }, { label: o.yes || Git.t('OK'), primary: !o.danger, danger: o.danger, onClick: () => { o.onYes && o.onYes(); } }] });
  };

  // ---------------------------------------------------------------- balloons
  let balloons;
  function host() {
    if (!balloons || !balloons.isConnected) {
      balloons = h('div.g-balloons', { 'aria-live': 'polite' });
      (document.getElementById('g-layer') || document.body).appendChild(balloons);
    }
    return balloons;
  }
  const kindIcon = { info: 'balloonInformation', success: 'balloonInformation', warning: 'balloonWarning', error: 'balloonError' };
  /** `n`: { kind: 'info'|'success'|'warning'|'error', title, text?, actions?: [{ label, run, keep }], sticky, timeout,
      whileOp, progress: true (a bar; n.update(text, fraction) moves it) }. Returns `n` with n.close() / n.update(). */
  Git.notify = function (n) {
    n.close = n.close || function () { n.closed = true; };
    n.update = n.update || function () {};
    Git.emit('notify', n);
    return n;
  };
  Git.on('notify', function (n) {
    const el = h('div.g-balloon', { class: n.kind || 'info', role: 'status' });
    const close = () => { n.closed = true; el.classList.add('out'); setTimeout(() => el.remove(), 160); };
    n.close = close;
    el.appendChild(Git.icon(kindIcon[n.kind || 'info']));
    const textEl = h('div.g-balloon-text', n.text || '');
    textEl.hidden = !n.text;
    const main = h('div.g-balloon-main', n.title ? h('div.g-balloon-title', n.title) : null, textEl);
    if (n.progress) {
      const bar = h('div.g-progress', { role: 'progressbar' }, h('div.g-progress-fill'));
      main.appendChild(bar);
      n.update = (text, fraction) => {
        if (text != null) { textEl.textContent = text; textEl.hidden = !text; }
        bar.classList.toggle('indeterminate', fraction == null);
        bar.firstChild.style.width = fraction == null ? '' : Math.round(Math.max(0, Math.min(1, fraction)) * 100) + '%';
      };
      n.update(null, null);
    }
    if (n.actions && n.actions.length) {
      main.appendChild(h('div.g-balloon-actions', n.actions.map((a) => h('button.g-link', { type: 'button', onclick: () => { if (!a.keep) close(); a.run(); } }, a.label))));
    }
    el.appendChild(main);
    el.appendChild(h('button.g-balloon-x', { type: 'button', title: Git.t('Close'), 'aria-label': Git.t('Close'), onclick: close }, Git.icon('closeSmall')));
    host().appendChild(el);
    while (host().children.length > 4) host().firstChild.remove();
    if (n.kind !== 'error' && !n.sticky && !n.progress) {
      let timer = setTimeout(close, n.timeout || 10000);
      el.addEventListener('mouseenter', () => clearTimeout(timer));
      el.addEventListener('mouseleave', () => { timer = setTimeout(close, 4000); });
    }
    // A notice about a paused merge or rebase goes away with the operation it speaks of.
    if (n.whileOp) { const off = Git.on('change', () => { if (!Git.repo.op) { off(); close(); } }); }
    Git.emit('notified', n);
  });

  // ---------------------------------------------------------------- splitter
  /** A drag handle that resizes `target`. `o`: { target, edge: 'left'|'right'|'top'|'bottom' (the side of target the handle is on),
      min, max, key (remembered size), onResize(px), onStart() (a drag is about to resize for the first time),
      onReset() (the handle was double clicked: the remembered size is forgotten and the owner goes back to its own
      default; without it a double click does nothing) }.
      A press that moves less than DRAG_START px resizes and stores nothing. */
  const DRAG_START = 2;
  Git.splitter = function (o) {
    const horizontal = o.edge === 'left' || o.edge === 'right';
    const handle = h('div.g-split', { class: horizontal ? 'h' : 'v', role: 'separator', 'aria-orientation': horizontal ? 'vertical' : 'horizontal' });
    const prop = horizontal ? 'width' : 'height';
    const apply = (size) => {
      const max = typeof o.max === 'function' ? o.max() : o.max || 4000;
      const v = Math.max(o.min || 80, Math.min(size, max));
      o.target.style[prop] = v + 'px';
      o.target.style.flex = '0 0 auto';
      if (o.onResize) o.onResize(v);
      return v;
    };
    if (o.key) { const saved = +prefs().get('size.' + o.key, 0); if (saved) apply(saved); }
    // The handle's hit area (4 px each side of its line) lies over the edges of the panes it separates: a wheel there
    // scrolls the scroller under it instead of doing nothing.
    handle.addEventListener('wheel', (e) => {
      handle.style.pointerEvents = 'none';
      let el = document.elementFromPoint(e.clientX, e.clientY);
      handle.style.pointerEvents = '';
      while (el && el !== document.body && !(el.scrollHeight > el.clientHeight && /(auto|scroll)/.test(getComputedStyle(el).overflowY))) el = el.parentElement;
      if (!el || el === document.body) return;
      const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1;
      el.scrollBy(e.deltaX * k, e.deltaY * k);
      e.preventDefault();
    }, { passive: false });
    // Pointer events with capture: in a host's frame (a panel or a stage of the host) a button released outside the frame
    // never reaches this document, so the drag also ends on pointercancel, a lost capture, a window blur and a move that
    // arrives with no button down. It always ends the same way: listeners off, the class gone, the size stored.
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const id = e.pointerId;
      try { handle.setPointerCapture(id); } catch (err) { /* a synthetic or already released pointer */ }
      const start = horizontal ? e.clientX : e.clientY;
      const size = o.target.getBoundingClientRect()[prop];
      const sign = o.edge === 'left' || o.edge === 'top' ? -1 : 1;
      document.body.classList.add(horizontal ? 'g-resizing-h' : 'g-resizing-v');
      let last = null, done = false;                             // last: null until the drag has resized once
      const move = (ev) => {
        if (ev.pointerId !== id) return;
        if (ev.buttons === 0) { end(); return; }                 // released where this document did not see it
        const by = (horizontal ? ev.clientX : ev.clientY) - start;
        if (last === null) {
          if (Math.abs(by) < DRAG_START) return;                 // a click, or the hand's tremble in a double click
          if (o.onStart) o.onStart();
        }
        last = apply(size + sign * by);
      };
      const finish = (ev) => { if (!ev || ev.pointerId === undefined || ev.pointerId === id) end(); };
      function end() {
        if (done) return;
        done = true;
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', finish);
        document.removeEventListener('pointercancel', finish);
        handle.removeEventListener('lostpointercapture', finish);
        window.removeEventListener('blur', end);
        try { if (handle.hasPointerCapture && handle.hasPointerCapture(id)) handle.releasePointerCapture(id); } catch (err) { /* gone */ }
        document.body.classList.remove('g-resizing-h', 'g-resizing-v');
        if (o.key && last !== null) prefs().set('size.' + o.key, Math.round(last));
      }
      // captured events are retargeted to the handle and bubble to the document; uncaptured ones reach it directly
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', finish);
      document.addEventListener('pointercancel', finish);
      handle.addEventListener('lostpointercapture', finish);
      window.addEventListener('blur', end);
    });
    // dblclick is not one of the mouse events a cancelled pointerdown suppresses
    if (o.onReset) handle.addEventListener('dblclick', (e) => {
      e.preventDefault();
      if (o.key) prefs().set('size.' + o.key, 0);
      o.onReset();
    });
    return handle;
  };

  // ---------------------------------------------------------------- small helpers
  /** "Today 14:05", "Yesterday 09:12", then a date: the way the log's Date column reads. */
  Git.formatDate = function (ms, withTime) {
    const d = new Date(ms), now = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const time = p(d.getHours()) + ':' + p(d.getMinutes());
    const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((day(now) - day(d)) / 86400000);
    // Up to 61 minutes back the IDE says how long ago (DateFormatUtil.formatPrettyDateTime).
    const delta = now.getTime() - ms;
    if (withTime !== false && delta >= 0 && delta <= 61 * 60000) {
      const n = Math.round(delta / 60000);
      return n === 0 ? Git.t('Moments ago') : n === 1 ? Git.t('A minute ago') : n >= 60 ? Git.t('1 hour ago') : Git.t('{0} minutes ago', n);
    }
    if (diff === 0) return Git.t('Today') + ' ' + time;
    if (diff === 1) return Git.t('Yesterday') + ' ' + time;
    const dmy = Git.dateOrder() === 'dmy';
    const date = dmy ? p(d.getDate()) + '.' + p(d.getMonth() + 1) + '.' + d.getFullYear()
      : (d.getMonth() + 1) + '/' + d.getDate() + '/' + String(d.getFullYear()).slice(2);
    return withTime === false ? date : date + (dmy ? ' ' : ', ') + time;
  };
  // A folder path may end with a slash (git lists untracked folders as `dir/`): its name is `dir`, not ''.
  const noSlash = (path) => String(path).replace(/\/+$/, '');
  Git.fileName = (path) => noSlash(path).split('/').pop();
  Git.dirName = (path) => noSlash(path).split('/').slice(0, -1).join('/');
  Git.copy = function (text) {
    if (Git.host && Git.host.copy) { Git.host.copy(text); return; }
    try { navigator.clipboard.writeText(text).catch(() => {}); } catch (e) { /* refused in some viewers */ }
  };
  Git.statusColor = function (status) {
    return { M: 'var(--g-modified)', A: 'var(--g-added)', D: 'var(--g-deleted)', R: 'var(--g-modified)', '?': 'var(--g-unversioned)', C: 'var(--g-conflict)' }[status] || 'inherit';
  };
  /** The file icon of a path (fileicons.js: the host's theme, else Seti). */
  Git.fileIcon = function (path) {
    const html = Git.fileIcons ? Git.fileIcons.html(Git.fileName(path)) : '';
    if (html) return h('span.g-file-ic', { html, 'aria-hidden': 'true' });
    return Git.icon('file');
  };
  /** A folder of the work tree: the host theme's folder icon (HTML), or '' for IntelliJ's `nodes/folder`. */
  Git.folderIconHTML = function (name, expanded) {
    return Git.fileIcons ? Git.fileIcons.html(Git.fileName(name), { dir: true, expanded: !!expanded }) : '';
  };
  /** The same as an element: the host's icon, else IntelliJ's folder. */
  Git.folderIcon = function (name, expanded) {
    const html = Git.folderIconHTML(name, expanded);
    return html ? h('span.g-file-ic', { html, 'aria-hidden': 'true' }) : Git.icon('nodes/folder');
  };
})();
