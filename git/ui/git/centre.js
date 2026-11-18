/* Centre presence: whether a diff shows in the centre right now (the editor area of this page, or a host's centre page
   that is open and visible). IntelliJ's preview diff (A §5.1): while no diff shows there, a single click on a changed
   file only selects it and a double click (Enter, ⌘D) opens the diff; while one shows, selecting another file (a click,
   the arrow keys) switches that diff to it.
     Git.centre.shown() -> Promise<boolean>   this page's active editor tab is a diff, else what the centre page reported
     Git.centre.preview(open)                 runs open() when a diff shows in the centre (the latest call wins)
     Git.centre.state() -> { diff, visible }  what this page would report as a centre page
   The centre page is the single view `tab` (a host's own centre tab, ui/git/pages.js). It reports { diff, visible, root }
   every BEAT ms from an animation frame (a page the host hides or throws away stops rendering, so its reports stop)
   and at once when it changes or goes; a report older than TTL means "no diff in the centre". Transport (host
   contract, docs/ARCHITECTURE.md §6.2): `Git.host.centreReport(state)` / `Git.host.centreShown(root)` when the host
   gives them (its centre page and its panels live in separate stores), else this origin's localStorage under
   `<storagePrefix>centre` (pages of one origin: the centre page and the panels of one local server). */
(function () {
  'use strict';
  const Git = window.Git;
  const BEAT = 1000;            // a host's request budget counts these (Orca: 120 messages per 10 s for the plugin)
  const TTL = 2500;
  const KEY = () => Git.storagePrefix() + 'centre';
  const host = () => Git.host || {};

  /** The id of the editor tab in front: the top page of a single view, the selected tab of the workbench. */
  function front() {
    const W = Git.workbench;
    if (!W) return null;
    if (W.mode === 'single') return Git.pages ? Git.pages.top() : null;
    return Git.tabs && Git.tabs.active ? Git.tabs.active() : null;
  }
  const isDiff = (id) => !!(id && Git.diffTab && Git.diffTab.tab(id) && Git.diffTab.tab(id).root);
  // Laid out with a size, and not hidden since the last `visibilitychange` (the state itself is not trusted before an
  // event: an off-screen test view calls itself hidden from the start). A page that is not rendered runs no animation
  // frames either, so its beats stop.
  let hidden = false;
  const visible = () => !hidden && window.innerWidth > 0 && window.innerHeight > 0;
  const centrePage = () => !!(Git.workbench && Git.workbench.mode === 'single' && Git.workbench.view === 'tab');

  function state() { return { diff: isDiff(front()), visible: visible() }; }
  /** This page's own editor area (the workbench) shows a diff. */
  const local = () => !!(Git.workbench && Git.workbench.mode !== 'single' && isDiff(front()));

  // ---------------------------------------------------------------- the centre page reports
  function send(s) {
    const root = Git.repo && Git.repo.root;
    if (!root) return;
    const msg = { root, diff: !!s.diff, visible: !!s.visible };
    if (typeof host().centreReport === 'function') { try { Promise.resolve(host().centreReport(msg)).catch(() => {}); } catch (e) { /* host gone */ } return; }
    try { localStorage.setItem(KEY(), JSON.stringify(Object.assign({ at: Date.now() }, msg))); } catch (e) { /* storage blocked */ }
  }
  let last = '', lastAt = 0, frame = 0;
  function beat() {
    if (!centrePage() || frame) return;
    // from an animation frame: a page that does not render (hidden, thrown away) sends nothing and its report expires
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (!centrePage()) return;
      const s = state(), k = s.diff + '|' + s.visible + '|' + (Git.repo && Git.repo.root);
      if (k === last && Date.now() - lastAt < BEAT - 50) return;
      last = k; lastAt = Date.now();
      send(s);
    });
  }
  setInterval(beat, BEAT);
  // changes show within a short tick (a page opened or closed, the tab hidden)
  setInterval(() => { if (centrePage()) { const s = state(); if (s.diff + '|' + s.visible + '|' + (Git.repo && Git.repo.root) !== last) beat(); } }, 150);
  document.addEventListener('visibilitychange', () => {
    hidden = document.visibilityState === 'hidden';
    if (!centrePage()) return;
    if (!hidden) beat();
    else { last = ''; send({ diff: false, visible: false }); }
  });
  window.addEventListener('pagehide', () => { if (centrePage()) send({ diff: false, visible: false }); });

  // ---------------------------------------------------------------- the panels ask
  function stored(root) {
    try {
      const v = JSON.parse(localStorage.getItem(KEY()) || 'null');
      return !!(v && v.root === root && v.diff && v.visible && typeof v.at === 'number' && Date.now() - v.at < TTL);
    } catch (e) { return false; }
  }
  function shown() {
    if (local()) return Promise.resolve(true);
    if (centrePage()) return Promise.resolve(false);           // the centre page lists nothing to preview
    const root = Git.repo && Git.repo.root;
    if (!root) return Promise.resolve(false);
    if (typeof host().centreShown === 'function') {
      try { return Promise.resolve(host().centreShown(root)).then((v) => v === true, () => false); } catch (e) { return Promise.resolve(false); }
    }
    return Promise.resolve(stored(root));
  }
  let ticket = 0;
  function preview(open) {
    const mine = ++ticket;
    return shown().then((ok) => { if (ok && mine === ticket) open(); return ok && mine === ticket; });
  }

  Git.centre = { shown, preview, state, BEAT, TTL };
})();
