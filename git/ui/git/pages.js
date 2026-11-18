/* Pages of a single view (?view=…; workbench.js). A single view has no editor area and no Git tool window,
   so what the workbench opens as an editor tab (Git.tabs: diff, read-only file view) or as a tab of the Git tool window
   (Git.frame.openTab: File History, Compare with Branch, the repository at a revision, …) is shown here as a page that
   covers the view: a header like the view's own (.wb-rhead) with Back and the tab's title, the tab's content under it.
   The view under the pages stays mounted (inert, its selection, scroll and filters untouched). Pages stack; Back or
   Esc closes the top one (unmount / off is called) and focus returns to where it was. Opening an id that is in the
   stack brings that page to the top and refills it as the workbench does an existing tab. Another repository, a
   rebuild (language, skin) or a whole-page state closes every page.
   In the full workbench nothing here runs: every call goes to workbench.js unchanged.
     Git.pages.list() -> [{ id, kind: 'editor'|'dock', title }] (bottom first) · .top() -> id | null · .closeAll() */
(function () {
  'use strict';
  const Git = window.Git;
  const h = Git.h, t = (...a) => Git.t(...a);
  const W = Git.workbench, F = Git.frame, Tabs = Git.tabs;

  Git.addTR({ 'Back': 'Geri' });

  const stack = [];   // { id, kind, title, mount, unmount|off, el, body, pane, titleEl, before }
  const P = (Git.pages = {});
  const single = () => W.mode === 'single';
  /** Views that are a host's own tab (?view=tab, the Orca center tab): the first page has no Back (Esc stops there);
      the host replaces it with P.closeAll() and a new opener. */
  const bare = () => W.view === 'tab';
  const root = () => document.querySelector('#wb.wb-single');
  const find = (id) => stack.find((p) => p.id === id) || null;
  const titleText = (p) => (typeof p.title === 'function' ? p.title() : p.title) || p.id;
  const topOf = (kind) => { for (let i = stack.length - 1; i >= 0; i--) if (!kind || stack[i].kind === kind) return stack[i]; return null; };

  /** The top page shows; everything under it (the view, lower pages) is covered and inert. */
  function layout() {
    const r = root();
    if (!r) return;
    const top = stack.length ? stack[stack.length - 1].el : null;
    Array.prototype.forEach.call(r.children, (el) => {
      const covered = !!top && el !== top;
      el.inert = covered;
      el.classList.toggle('wb-covered', covered);
      if (covered) el.setAttribute('aria-hidden', 'true'); else el.removeAttribute('aria-hidden');
    });
    // the order of the stack is the stacking order; the elements stay where they are (moving one would lose its scroll)
    stack.forEach((p, i) => { p.el.style.zIndex = String(10 + i); });
    r.classList.toggle('wb-has-page', !!top);
  }
  function drawTitle(p) {
    const text = titleText(p);
    p.titleEl.textContent = text;
    p.titleEl.title = text;
  }
  function focusIn(p) {
    if (!p.el.isConnected || p.el.contains(document.activeElement)) return;
    try { p.pane.focus({ preventScroll: true }); } catch (e) { /* not focusable */ }
  }
  function build(p) {
    p.titleEl = h('span.wb-page-title');      // a file name: not in the capitals of a tool window title
    const back = h('button.wb-page-back', { type: 'button', title: t('Back') + '  Esc', 'aria-label': t('Back'), onclick: () => close(p.id) },
      Git.icon('general/chevronLeft', 16), h('span', t('Back')));
    // the same element the workbench gives the tab: an editor pane, or a pane of the Git tool window
    p.pane = p.kind === 'editor' ? h('div.wb-ed-pane', { tabIndex: -1 }) : h('div.g-dock-pane.g-col', { tabIndex: -1 });
    p.body = h('div.wb-page-body', p.pane);
    // A bare view (the Orca center tab: the host closes it): its first page has no Back; it names itself in a slim line
    // unless it is a plain diff (whose own heads say what it is). Pages opened from it stack with Back as anywhere.
    let head = h('div.wb-rhead.wb-page-head', back, p.titleEl);
    if (p.base) head = p.plain ? null : h('div.wb-page-slim', p.titleEl);
    // while another worktree is shown its strip stays under the page's head too (worktrees.js). A bare view shows
    // the worktree its host put there, so its strip only says which one (also on the first page): no way back.
    const strip = Git.worktrees ? Git.worktrees.strip() : null;
    if (strip && bare()) { const back = strip.querySelector('.wb-wt-back'); if (back) back.remove(); }
    p.el = h('div.wb-page', { role: 'region', class: p.base ? 'wb-page-base' : '', dataset: { page: p.id, kind: p.kind } }, head, strip, p.body);
    drawTitle(p);
  }
  function mount(p) {
    try {
      if (p.kind === 'editor') { if (p.mount) p.mount(p.pane); }
      else { const off = p.mount ? p.mount(p.pane) : null; p.off = typeof off === 'function' ? off : null; }
    } catch (e) { console.error(e); }
  }
  function release(p) {
    try { if (p.kind === 'editor') { if (p.unmount) p.unmount(); } else if (p.off) p.off(); } catch (e) { console.error(e); }
    p.off = null;
  }
  /** Brings an existing page to the top (it keeps its element and the focus it had before it first opened). */
  function raise(p) {
    const i = stack.indexOf(p);
    if (i < stack.length - 1) { stack.splice(i, 1); stack.push(p); }
    layout();
  }
  function push(spec, kind) {
    const r = root();
    let p = find(spec.id);
    if (p) {
      if (spec.title) p.title = spec.title;
      if (kind === 'editor') {
        if (spec.mount && spec.mount !== p.mount && spec.remount) { release(p); Git.clear(p.pane); p.mount = spec.mount; p.unmount = spec.unmount; mount(p); }
      } else {        // the Git tool window mounts an existing tab again with its new content
        release(p); Git.clear(p.pane); p.mount = spec.mount; mount(p);
      }
      drawTitle(p);
      raise(p);
      focusIn(p);
      return p.id;
    }
    p = { id: spec.id, kind, title: spec.title || spec.id, mount: spec.mount, unmount: spec.unmount, off: null,
      base: bare() && !stack.length, plain: !!spec.plain,
      before: document.activeElement && document.activeElement !== document.body ? document.activeElement : null };
    build(p);
    stack.push(p);
    if (r) r.appendChild(p.el);          // in the document before it mounts: the content measures itself
    layout();
    mount(p);
    focusIn(p);
    return p.id;
  }
  function close(id) {
    const p = find(id);
    if (!p) return;
    const wasTop = stack[stack.length - 1] === p;
    const had = p.el.contains(document.activeElement);
    stack.splice(stack.indexOf(p), 1);
    release(p);
    p.el.remove();
    layout();
    if (!wasTop && !had) return;
    // focus goes back where it was when the page opened (or into the page that shows now)
    const next = stack[stack.length - 1];
    const back = p.before && p.before.isConnected && !p.before.closest('[inert]') ? p.before : null;
    if (back) { try { back.focus({ preventScroll: true }); } catch (e) { /* gone */ } }
    else if (next) focusIn(next);
  }
  P.closeAll = function () { stack.slice().reverse().forEach((p) => { stack.splice(stack.indexOf(p), 1); release(p); p.el.remove(); }); layout(); };
  P.list = () => stack.map((p) => ({ id: p.id, kind: p.kind, title: titleText(p) }));
  P.top = () => (stack.length ? stack[stack.length - 1].id : null);
  P.close = close;

  // ---------------------------------------------------------------- Git.tabs / Git.frame in a single view
  const tabs = { open: Tabs.open, close: Tabs.close, select: Tabs.select, active: Tabs.active, list: Tabs.list, setTitle: Tabs.setTitle };
  // (a host that shows tabs elsewhere takes them before they get here: ui/git/openers.js, Git.host.forward)
  Tabs.open = (spec) => (single() && root() ? push(spec, 'editor') : tabs.open(spec));
  Tabs.close = (id) => (single() ? close(id) : tabs.close(id));
  Tabs.select = (id) => { if (!single()) return tabs.select(id); const p = find(id); if (p) { raise(p); focusIn(p); } };
  Tabs.active = () => (single() ? (topOf('editor') || {}).id || null : tabs.active());
  Tabs.list = () => (single() ? stack.filter((p) => p.kind === 'editor').map((p) => ({ id: p.id, title: titleText(p) })) : tabs.list());
  Tabs.setTitle = (id, title) => { if (!single()) return tabs.setTitle(id, title); const p = find(id); if (p && p.title !== title) { p.title = title; drawTitle(p); } };

  const frame = { openTab: F.openTab, closeTab: F.closeTab, selectTab: F.selectTab, setTabTitle: F.setTabTitle, activeTab: F.activeTab, rebuild: F.rebuild };
  F.openTab = (tab) => (single() && root() ? push(tab, 'dock') : frame.openTab(tab));
  F.closeTab = (id) => (single() ? close(id) : frame.closeTab(id));
  /** The view's own tab ('log' in the Log view: Show in Log) shows the view: the pages over it close. */
  F.selectTab = (id) => {
    if (!single()) return frame.selectTab(id);
    const p = find(id);
    if (p) { raise(p); focusIn(p); } else if (id === W.view) P.closeAll();
  };
  F.setTabTitle = (id, title) => { if (!single()) return frame.setTabTitle(id, title); const p = find(id); if (p && p.title !== title) { p.title = title; drawTitle(p); } };
  F.activeTab = () => (single() ? (topOf('dock') || {}).id || W.view : frame.activeTab());
  F.rebuild = function (...a) { P.closeAll(); return frame.rebuild.apply(this, a); };
  // another repository and the whole-page states replace the view: its pages go first
  ['open', 'picker', 'loading', 'unreachable'].forEach((name) => {
    const real = W[name];
    W[name] = function (...a) { P.closeAll(); return real.apply(this, a); };
  });

  // ---------------------------------------------------------------- Esc
  // After menus, popups and dialogs (ui.js, menu.js stop the key) and unless the page's content took it.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
    if (!single() || !stack.length || stack[stack.length - 1].base) return;   // never past the center tab's first page
    if ((Git.openDialogs && Git.openDialogs().length) || (Git.popupMenu && Git.popupMenu.isOpen())) return;
    e.preventDefault();
    close(stack[stack.length - 1].id);
  });
})();
