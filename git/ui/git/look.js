/* The host's look: the fonts (and the file icon theme's key) of the app the page runs in, so the page follows what the
   owner picked there instead of its own choice (docs/ARCHITECTURE.md §1 "What a host provides"). Optional: a host
   without it keeps the skins' own fonts (git.css, git-diff.css), exactly as before.
     Git.host.look() -> look | Promise<look> | null
       look = { code: { family, size, lineHeight }?, ui: { family }?, icons: string? }
         code.family      a CSS font-family list: diffs, the file view and blame, the Console, hashes, commit messages
                          shown in the Log, the merge tool
         code.size        px: the diff, the file view and blame (not the merge tool, whose rows are a fixed 22 px)
         code.lineHeight  px; 0 or absent: round(size × 1.5), the editor's automatic line height on macOS
         ui.family        a CSS font-family list for the rest of the page
         icons            the key of the host's file icon theme; when it changes the page is drawn again, since the
                          icons come from Git.host.fileIcon (fileicons.js)
     Git.host.onLookChange(fn) -> off (optional): the host calls fn(look?) when its look changed; without an argument the
       base asks look() again.
   The look is written as inline custom properties on <html>, which win over both skins; a field the host does not give
   is removed, so the skin's value holds. A change of fonts emits 'look' (the diff and the file view redraw: their row
   math reads --gd-line when drawing); a change of `icons` also redraws the page (Git.frame.rebuild, as a skin does).
   Git.look = { current() -> the applied look (normalised) or null, apply(look) } */
(function () {
  'use strict';
  const Git = window.Git;
  const MONO = 'ui-monospace, Menlo, monospace';
  const SANS = '-apple-system, BlinkMacSystemFont, system-ui, sans-serif';
  // a value goes into a declaration: nothing that could end it or open another one
  const clean = (s) => (typeof s === 'string' ? s.replace(/[;{}<>\\]/g, '').trim().slice(0, 400) : '');
  const px = (v, min, max) => (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? Math.round(v) : 0);
  const withFallback = (family, generic, stack) => (!family ? '' : new RegExp('\\b' + generic + '\\b', 'i').test(family) ? family : family + ', ' + stack);

  /** The look as CSS: { '--g-mono': '…', … } (only what the host gave), plus the icon key. */
  function normalise(look) {
    const out = { vars: {}, icons: '' };
    if (!look || typeof look !== 'object') return out;
    const code = look.code && typeof look.code === 'object' ? look.code : null;
    if (code) {
      const family = withFallback(clean(code.family), 'monospace', MONO);
      if (family) { out.vars['--g-mono'] = family; out.vars['--gd-font'] = family; }
      const size = px(code.size, 8, 40);
      if (size) {
        out.vars['--gd-size'] = size + 'px';
        out.vars['--gd-line'] = (px(code.lineHeight, size, 120) || Math.round(size * 1.5)) + 'px';
      }
    }
    const ui = look.ui && typeof look.ui === 'object' ? look.ui : null;
    if (ui) {
      const family = withFallback(clean(ui.family), 'sans-serif', SANS);
      if (family) out.vars['--g-font'] = family;
    }
    if (typeof look.icons === 'string') out.icons = look.icons.slice(0, 100);
    return out;
  }
  const NAMES = ['--g-font', '--g-mono', '--gd-font', '--gd-size', '--gd-line'];
  let applied = null, sig = '';

  function apply(look) {
    const next = normalise(look);
    const nextSig = JSON.stringify(next);
    if (nextSig === sig) return false;
    const before = applied;
    sig = nextSig;
    applied = next;
    const st = document.documentElement.style;
    NAMES.forEach((n) => { if (next.vars[n]) st.setProperty(n, next.vars[n]); else st.removeProperty(n); });
    // A look that comes before the page is drawn changes nothing drawn (rebuild waits for an open repository); one that
    // comes later (an asynchronous host) redraws like a change.
    if (Git.emit) Git.emit('look', next);
    if ((before ? before.icons : '') !== next.icons && Git.frame && Git.frame.rebuild) Git.frame.rebuild();
    return true;
  }
  /** The host's look now; a failing or slow host leaves the skin's own fonts. */
  function ask() {
    let got;
    try { got = Git.host && typeof Git.host.look === 'function' ? Git.host.look() : null; } catch (e) { got = null; }
    if (got && typeof got.then === 'function') got.then((l) => { if (l) apply(l); }, () => { /* no look */ });
    else if (got) apply(got);
  }
  Git.look = {
    current: () => (applied ? { vars: Object.assign({}, applied.vars), icons: applied.icons } : null),
    apply,
  };
  ask();
  try {
    if (Git.host && typeof Git.host.onLookChange === 'function') Git.host.onLookChange((l) => { if (l && typeof l === 'object') apply(l); else ask(); });
  } catch (e) { /* the host offers no change notice */ }
})();
