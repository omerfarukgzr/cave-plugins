/* The pop-up menu of the default skin: rounded, dark, a 30 px row, sections, submenus. Ported from the approved
   prototype's shell menu so menus look exactly as there, with no host code.
   Styles: ui/css/shell.css (.cmenu, .cm-*, .cm-glyph); its three glyphs are drawn here (glyph()).
   Git.popupMenu.show(x, y, items, { width = 248, native = false }) -> menu | null · .close() · .isOpen()
     items: { label, icon?, iconHTML?, shortcut?, disabled?, danger?, checked?, action?, children?, title?, why?, bold?, hint?, tag?, badgeHTML?, key? } | '-' | { header }
     (`key`: the row's data-key, for a caller that updates a row's `.cm-short` in place)
     (`title`: the row's tooltip; `why`: on a disabled row, the reason, shown under the label and as the tooltip)
   ↑↓ move, → opens a submenu, ← closes it, Return/Space run, Esc or a click outside closes, a letter jumps.
   The Esc rule (ui.js): focus sits in a read-only text field inside the menu (the "focus sink", ui.js), so Esc reaches
   the page and closes only the menu. */
(function () {
  'use strict';
  const Git = window.Git;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  /** The menu's own glyphs: plain strokes in currentColor, drawn here (no icon font, no sprite, nothing of a system's
      symbol set). Each has the box its place was laid out for: [width, height], the path, the stroke width. */
  const GLYPHS = {
    checkmark: [12, 12, 'M2.3 6.9 4.9 9.6 9.9 2.4', 1.6],
    'chevron.right': [8, 11, 'M2.3 1.8 6 5.5 2.3 9.2', 1.35],
    xmark: [9, 9, 'M1.7 1.7 7.3 7.3M7.3 1.7 1.7 7.3', 1.4],
  };
  /** glyph('checkmark') -> '<svg class="cm-glyph">…</svg>'; '' for a name it does not draw. `extra`: more classes. */
  function glyph(name, extra) {
    const g = GLYPHS[name];
    if (!g) return '';
    return '<svg class="cm-glyph' + (extra ? ' ' + extra : '') + '" width="' + g[0] + '" height="' + g[1] + '" viewBox="0 0 ' + g[0] + ' ' + g[1] +
      '" fill="none" stroke="currentColor" stroke-width="' + g[3] + '" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + g[2] + '"/></svg>';
  }
  function html(text) { const t = document.createElement('template'); t.innerHTML = text.trim(); return t.content.firstElementChild; }
  function layer() {
    let el = document.getElementById('g-menu-layer');
    if (!el) { el = document.createElement('div'); el.id = 'g-menu-layer'; el.className = 'g-menu-layer'; document.body.appendChild(el); }
    return el;
  }

  let root = null, restore = null;

  class Menu {
    constructor(items, width, parent, opts) {
      this.items = items;
      this.width = width;
      this.parent = parent;
      this.opts = opts || {};
      this.child = null;
      this.highlighted = null;
      this.openSubmenu = null;
      this.el = this.build();
    }
    selectable(i) { const it = this.items[i]; return it && it !== '-' && !it.header && !it.disabled; }
    build() {
      const el = html('<div class="cmenu' + (this.opts.native ? ' native' : '') + '" tabindex="-1" role="menu" style="width:' + this.width + 'px"></div>');
      this.sink = Git.focusSink ? Git.focusSink('menu') : null;
      if (this.sink) el.appendChild(this.sink);
      this.items.forEach((it, i) => el.appendChild(this.row(it, i)));
      el.addEventListener('contextmenu', (e) => e.preventDefault());
      return el;
    }
    row(it, i) {
      if (it === '-') return html('<div class="cm-sep" role="separator"></div>');
      if (it.header) return html('<div class="cm-head"><span class="t t11">' + esc(String(it.header).toLocaleUpperCase(Git.locale())) + '</span></div>');
      const check = it.checked === undefined ? '' : '<span class="cm-check">' + (it.checked ? glyph('checkmark') : '') + '</span>';
      const icon = it.iconHTML ? '<span class="cm-icon">' + it.iconHTML + '</span>' : it.icon && glyph(it.icon) ? '<span class="cm-icon">' + glyph(it.icon) + '</span>' : '';
      const tail = it.children ? glyph('chevron.right', 'cm-arrow') : it.shortcut ? '<span class="cm-short">' + esc(it.shortcut) + '</span>' : '';
      // `why`: the reason a disabled item cannot run (IntelliJ shows it in the status bar): a dim second line + tooltip
      const why = it.disabled && it.why ? '<span class="cm-why t t11">' + esc(it.why) + '</span>' : '';
      // `bold`, `hint` (dim text after the label, cut first), `tag` (a quiet word), `badgeHTML` (a small icon after them)
      const more = (it.hint ? '<span class="cm-hint t t12 shrink">' + esc(it.hint) + '</span>' : '')
        + (it.tag ? '<span class="cm-tag t t11">' + esc(it.tag) + '</span>' : '') + (it.badgeHTML ? '<span class="cm-badge">' + it.badgeHTML + '</span>' : '');
      const label = why ? '<span class="cm-two shrink"><span class="cm-title t t13">' + esc(it.label) + '</span>' + why + '</span>'
        : '<span class="cm-title t t13 shrink' + (it.bold ? ' cm-bold' : '') + '">' + esc(it.label) + '</span>' + more;
      const body = icon + label + '<span class="cm-gap"></span>' + tail;
      const el = html('<div class="cm-row' + (it.danger ? ' danger' : '') + (it.disabled ? ' is-disabled' : '') + (why ? ' has-why' : '') + '" role="menuitem" aria-disabled="'
        + (it.disabled ? 'true' : 'false') + '" data-i="' + i + '"' + (it.key ? ' data-key="' + esc(it.key) + '"' : '') + '>' + check + body + '</div>');
      if (it.title || why) el.title = it.title || it.why;
      el.addEventListener('mouseenter', () => { if (it.disabled) return; this.setHighlight(i); this.openSub(i, false); });
      el.addEventListener('mouseleave', () => { if (this.highlighted === i && this.openSubmenu !== i) this.setHighlight(null); });
      el.addEventListener('click', (e) => { e.stopPropagation(); if (!it.disabled) this.run(i); });
      return el;
    }
    focus() { const f = this.sink || this.el; try { f.focus({ preventScroll: true }); } catch (e) { f.focus(); } }
    setHighlight(i) {
      this.highlighted = i;
      this.el.querySelectorAll('.cm-row').forEach((r) => {
        const n = Number(r.dataset.i);
        r.classList.toggle('is-lit', !this.items[n].disabled && (n === this.highlighted || n === this.openSubmenu));
      });
    }
    move(step) {
      const rows = this.items.map((_, i) => i).filter((i) => this.selectable(i));
      if (!rows.length) return;
      const at = rows.indexOf(this.highlighted);
      if (at < 0) { this.setHighlight(step > 0 ? rows[0] : rows[rows.length - 1]); return; }
      this.setHighlight(rows[(at + step + rows.length) % rows.length]);
    }
    jump(c) {
      const rows = this.items.map((_, i) => i).filter((i) => this.selectable(i));
      const at = rows.indexOf(this.highlighted);
      const order = rows.slice(at + 1).concat(rows.slice(0, at + 1));
      const key = c.toLocaleLowerCase('tr');
      const hit = order.find((i) => (this.items[i].label || '').toLocaleLowerCase('tr')[0] === key);
      if (hit !== undefined) this.setHighlight(hit);
    }
    run(i) {
      const it = this.items[i];
      if (!it || it === '-' || it.header || it.disabled) return;
      if (it.children) { this.openSub(i, true); return; }
      closeAll();
      if (typeof it.action === 'function') {
        try { it.action(it); } catch (e) { console.error('menu action failed', e); }
      }
    }
    openSub(i, select) {
      const it = this.items[i];
      const hasRows = it && it.children && !it.disabled;
      if (!hasRows) {
        if (this.child) this.child.closeSelf();
        this.child = null;
        this.openSubmenu = null;
        this.setHighlight(this.highlighted);
        return;
      }
      if (this.openSubmenu === i && this.child) {
        if (select) { this.child.move(1); this.child.focus(); }
        return;
      }
      if (this.child) this.child.closeSelf();
      this.openSubmenu = i;
      this.setHighlight(this.highlighted);
      const items = it.children.filter((c, k, all) => !(c === '-' && (k === 0 || k === all.length - 1 || all[k - 1] === '-')));
      const sub = new Menu(items, Math.max(180, menuWidth(items, 180)), this, { native: this.opts.native });
      this.child = sub;
      const mine = this.el.getBoundingClientRect();
      const row = this.el.querySelector('.cm-row[data-i="' + i + '"]').getBoundingClientRect();
      sub.present(mine.right - 4, row.top - 5, row.bottom + 5);
      if (select) { sub.move(1); sub.focus(); } else this.focus();
    }
    present(x, y, rowBottom) {
      layer().appendChild(this.el);
      const w = this.el.offsetWidth, hgt = this.el.offsetHeight;
      const vw = window.innerWidth, vh = window.innerHeight;
      let left = Math.min(Math.max(x, 4), vw - w - 4);
      if (this.parent && x + w > vw - 4) left = Math.max(4, this.parent.el.getBoundingClientRect().left - w + 4);
      let top = y;
      if (top + hgt > vh - 4) top = Math.max((rowBottom !== undefined ? rowBottom : y) - hgt, 4);
      this.el.style.left = Math.round(left) + 'px';
      this.el.style.top = Math.round(top) + 'px';
      this.el.addEventListener('keydown', (e) => this.key(e));
      this.focus();
    }
    key(e) {
      e.stopPropagation();
      switch (e.key) {
        case 'ArrowDown': this.move(1); break;
        case 'ArrowUp': this.move(-1); break;
        case 'ArrowRight': if (this.highlighted !== null) this.openSub(this.highlighted, true); break;
        case 'ArrowLeft': if (this.parent) { const p = this.parent; this.closeSelf(); p.child = null; p.focus(); } break;
        case 'Enter': case ' ': if (this.highlighted !== null) this.run(this.highlighted); break;
        case 'Escape': closeAll(); break;
        case 'Tab': break;
        default:
          if (e.key.length === 1 && /\p{L}/u.test(e.key) && !e.metaKey && !e.ctrlKey) this.jump(e.key); else return;
      }
      e.preventDefault();
    }
    closeSelf() {
      if (this.child) this.child.closeSelf();
      this.child = null;
      if (this.parent) { this.parent.openSubmenu = null; this.parent.setHighlight(this.parent.highlighted); }
      this.el.remove();
    }
  }

  let ruler = null;
  /** The prototype's menu has one fixed width; Git's labels can be long, so a menu is as wide as its longest row needs. */
  function menuWidth(items, min) {
    if (!ruler) ruler = document.createElement('canvas').getContext('2d');
    ruler.font = '13px -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif';
    let widest = 0;
    items.forEach((it) => {
      if (!it || it === '-' || !it.label) return;
      const w = ruler.measureText(it.label).width + (it.shortcut ? ruler.measureText(it.shortcut).width + 28 : 0)
        + (it.checked !== undefined ? 25 : 0) + (it.children ? 22 : 0) + (it.iconHTML || it.icon ? 25 : 0)
        + (it.hint ? ruler.measureText(it.hint).width * 12 / 13 + 9 : 0) + (it.tag ? ruler.measureText(it.tag).width * 11 / 13 + 21 : 0) + (it.badgeHTML ? 23 : 0);
      if (w > widest) widest = w;
      const why = it.disabled && it.why ? ruler.measureText(it.why).width * 11 / 13 + (it.checked !== undefined ? 25 : 0) : 0;
      if (why > widest) widest = why;
    });
    return Math.max(min || 200, Math.min(440, Math.ceil(widest) + 48));
  }

  function closeAll() {
    if (!root) return;
    const r = root;
    root = null;
    r.closeSelf();
    document.removeEventListener('mousedown', outside, true);
    window.removeEventListener('blur', closeAll);
    window.removeEventListener('resize', closeAll);
    const back = restore;
    restore = null;
    const active = document.activeElement;
    if (back && back.isConnected && (!active || active === document.body || !active.isConnected)) {
      try { back.focus({ preventScroll: true }); } catch (e) { /* gone */ }
    }
    Git.emit('menu-close');
  }
  const inMenus = (target) => !!(target && target.closest && target.closest('.cmenu'));
  function outside(e) { if (!inMenus(e.target)) closeAll(); }

  function show(x, y, items, opts) {
    closeAll();
    if (!items || !items.length) return null;
    const o = opts || {};
    restore = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
    root = new Menu(items, o.width || menuWidth(items), null, o);
    root.present(x, y);
    document.addEventListener('mousedown', outside, true);
    window.addEventListener('blur', closeAll);
    window.addEventListener('resize', closeAll);
    return root;
  }

  Git.popupMenu = { show, close: closeAll, isOpen: () => root !== null, width: menuWidth, glyph };
})();
