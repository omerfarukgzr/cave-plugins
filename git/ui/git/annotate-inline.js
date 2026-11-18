/* Inline blame in the file view (fileview.js): GitToolBox's "inline blame", GitLens' current line blame. The caret
   line shows, after its text and faded, who last changed it: "<author>, <date> • <subject>" (the date as the Log's
   Date column reads, Git.formatDate). A line not committed yet shows nothing. Hovering names the hash, the author,
   the full date and the whole subject; a click shows the commit in the Log (as a click in the annotation column does).
   The blame is the engine's `annotate` (the same call and Options as annotate.js), read once per file and revision
   (the work tree file: per HEAD and text) in the background and kept; moving the caret only draws. On by default;
   "Show Inline Blame" in the file view's gutter menu turns it off (prefs `fileview.inlineBlame`).
     Git.inlineBlame.on() · .set(on) · .need(view) · .el(view, i) · .item() (the menu item) */
(function () {
  'use strict';
  const Git = window.Git;
  const h = Git.h, t = (...a) => Git.t(...a);
  Git.addTR({ 'Show Inline Blame': 'Satır içi blame\'i göster' });

  const PREF = 'fileview.inlineBlame';
  const CAP = 24;                                   // blames kept (one per file and revision)
  const cache = new Map();                          // key -> { lines: [id|null], commits } | null (git could not blame it) | Promise
  let enabled = null;
  const on = () => {
    if (enabled === null) { try { enabled = Git.host.prefs.get(PREF, true) !== false; } catch (e) { enabled = true; } }
    return enabled;
  };
  const opts = () => (Git.annotate && Git.annotate.opts) || {};
  /** The blame's identity: the revision, or for the work tree file HEAD and the text, with the annotation Options. */
  function keyOf(v) {
    const o = opts(), flags = (o.ignoreWhitespace ? 'w' : '') + (o.movesInFile ? 'M' : '') + (o.movesAcrossFiles ? 'C' : '');
    return v.path + '\u0000' + (v.rev || ((Git.headId() || '') + ':' + Git.changesModel.textHash(v.text || ''))) + '\u0000' + flags;
  }
  function keep(key, value) {
    cache.delete(key);
    cache.set(key, value);
    while (cache.size > CAP) cache.delete(cache.keys().next().value);
  }
  /** The blame for the view as it is now: the annotation column's when it is of the same text, else the kept one. */
  function blameOf(v) {
    const key = keyOf(v);
    if (v.blame && v.blameKey === (v.rev || Git.headId() || '') + ':' + Git.changesModel.textHash(v.text || '')) return v.blame;
    const b = cache.get(key);
    return b && typeof b.then !== 'function' ? b : null;
  }

  Git.inlineBlame = {
    on,
    set(value) {
      enabled = !!value;
      try { Git.host.prefs.set(PREF, enabled); } catch (e) { /* not kept */ }
      if (Git.fileView && Git.fileView.all) Git.fileView.all().forEach((v) => { if (v.root) { if (enabled) Git.inlineBlame.need(v); if (v.draw) v.draw(true); } });
    },
    /** Reads the blame in the background when the view has a caret line and none is kept for its text yet. */
    need(v) {
      if (!on() || !v || !v.root || v.line == null || !v.lines.length || !v.tracked() || blameOf(v)) return;
      const key = keyOf(v);
      if (cache.has(key)) return;                     // asked already (or git cannot blame it)
      const params = { repo: Git.repo.root, path: v.path, ignoreWhitespace: !!opts().ignoreWhitespace, movesInFile: !!opts().movesInFile, movesAcrossFiles: !!opts().movesAcrossFiles };
      if (v.rev) params.rev = v.rev;
      const ask = Git.backend.call('annotate', params).then((res) => {
        keep(key, { lines: (res.lines || []).map((l) => (l && l.id) || null), commits: res.commits || {} });
        if (v.root && keyOf(v) === key && v.draw) v.draw(true);
      }, () => { keep(key, null); });
      keep(key, ask);
    },
    /** The annotation after line i's text, or null (no caret there, not committed, no blame yet, turned off). */
    el(v, i) {
      if (!on() || v.line !== i) return null;
      const b = blameOf(v), id = b && b.lines[i];
      const c = id && b.commits[id];
      if (!c) return null;
      const who = (c.author && c.author.name) || '';
      const full = new Date(c.time);
      const tip = id + '\n' + who + (c.author && c.author.email ? ' <' + c.author.email + '>' : '') + '\n' + full.toLocaleString() + '\n\n' + (c.subject || '');
      return h('span.fv-inline', { title: tip, dataset: { id } }, who + ', ' + Git.formatDate(c.time) + ' • ' + (c.subject || ''));
    },
    /** "Show Inline Blame" for the file view's menus. */
    item: () => ({ label: t('Show Inline Blame'), checked: on(), action: () => Git.inlineBlame.set(!on()) }),
  };
})();
