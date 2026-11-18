/* The change marker popup of the file view (IntelliJ's LineStatusMarkerPopup, A §6.2, tut__change_marker.png,
   add__changeMarkerToolbar.png): a click on a gutter marker opens, under the change, a toolbar — Previous Change, Next
   Change, Rollback Lines, Show Diff for Lines, Copy, Highlight Words (a modified block only) — and the lines as they were
   before (HEAD's). The inline commit field, Amend and the changelist picker are partial commit parts (out of scope).
   Rollback Lines writes the block's HEAD lines back (Git.actions.writeBlock: changes.write, trash first, "Restore").
   ⌃⌥⇧↓ / ⌃⌥⇧↑ (Next / Previous Change) move the caret from change to change.
     Git.fileMarker.open(view, blockIndex) · .blockAt(view, lineIndex) -> index | -1 · .step(view, d) · .close() */
(function () {
  'use strict';
  const Git = window.Git;
  const h = Git.h, t = (...a) => Git.t(...a);
  const FM = (Git.fileMarker = {});
  let pop = null, words = true;

  Git.addTR({
    'Previous Change': 'Önceki değişiklik', 'Next Change': 'Sonraki değişiklik', 'Rollback Lines': 'Satırları geri al',
    'Show Diff for Lines': 'Satırların diff\'ini göster', 'Copy': 'Kopyala', 'Highlight Words': 'Kelimeleri vurgula',
    'Diff for Range': 'Aralık diff\'i', 'Base revision': 'Temel revizyon', 'Current': 'Geçerli',
  });

  const blocks = (v) => (v.marks && v.marks.blocks) || [];
  /** The change block a row's marker stands for (a deletion sits above its line; past the end, on the last line). */
  FM.blockAt = function (v, i) {
    const list = blocks(v), n = v.lines.length;
    for (let k = 0; k < list.length; k++) {
      const b = list[k];
      if (b.type === 'del' ? b.b0 === i || (b.b0 >= n && i === n - 1) : i >= b.b0 && i < b.b1) return k;
    }
    return -1;
  };
  const oldLines = (v, b) => (v.baseLines || []).slice(b.a0, b.a1);
  const curLines = (v, b) => v.lines.slice(b.b0, b.b1);
  FM.close = function () { if (pop) { pop.close(); pop = null; } };

  /** Moves the caret to the next / previous change (wraps like IntelliJ's VcsShowNextChangeMarker does not: it stops). */
  FM.step = function (v, d, reopen) {
    const list = blocks(v);
    if (!list.length) return -1;
    const at = v.line == null ? (d > 0 ? -1 : v.lines.length) : v.line;
    let k = -1;
    if (d > 0) k = list.findIndex((b) => Math.min(b.b0, v.lines.length - 1) > at);
    else for (let j = list.length - 1; j >= 0; j--) if (Math.min(list[j].b0, v.lines.length - 1) < at) { k = j; break; }
    if (k < 0) return -1;
    v.goTo(Math.min(list[k].b0, v.lines.length - 1) + 1);
    if (reopen) setTimeout(() => FM.open(v, k), 0);
    return k;
  };

  /** Rollback Lines: the diff viewer's write-back (Git.changesModel.writeBack) on the file's own line model, so every
      other line keeps its line end (a file with mixed CRLF / LF stays mixed). The markers' blocks come from the texts
      with CRLF read as LF; both models have the same lines, so the block's indices hold. The markers show no
      final-newline-only change: the file keeps its own final newline. */
  function rollback(v, b) {
    const M = Git.changesModel, cur = { text: v.text, eol: v.eol }, base = { text: v.baseText, eol: v.baseEol };
    const m = M.lineModel(base, cur);
    delete m.noEol;
    const text = M.writeBack(m, { a0: b.a0, a1: b.a1, b0: b.b0, b1: b.b1 }, 'revert', cur, base);
    FM.close();
    return Git.actions.writeBlock(v.path, text, M.expectOf(v.text), 'revert');
  }
  function showDiff(v, b) {
    const join = (lines) => (lines.length ? lines.join('\n') + '\n' : '');
    FM.close();
    Git.diffTab.open({ kind: 'texts', id: 'diff:range', title: t('Diff for Range'), path: v.path,
      left: { title: t('Base revision'), text: join(oldLines(v, b)), locked: true }, right: { title: t('Current'), text: join(curLines(v, b)) } });
  }

  /** The old lines, with the changed words marked when Highlight Words is on (a modified block). */
  function oldBody(v, b) {
    const lines = oldLines(v, b);
    const body = h('div.fv-pop-old', { role: 'document' });
    let w = null;
    if (words && b.type === 'mod') { try { w = Git.diffParts.words(lines, curLines(v, b)); } catch (e) { w = null; } }
    lines.forEach((s, i) => {
      const runs = s ? [{ t: s, c: '' }] : [];
      body.appendChild(h('div.fv-pop-line', { html: Git.diffParts.lineHTML(runs, w ? w.a[i] : null) || ' ' }));
    });
    return body;
  }
  FM.open = function (v, k) {
    FM.close();
    const list = blocks(v), b = list[k];
    if (!b || !v.root) return null;
    const row = v.root.querySelector('.fv-row[data-line="' + (Math.min(b.type === 'del' ? b.b0 : b.b1 - 1, v.lines.length - 1) + 1) + '"]');
    const old = oldLines(v, b);
    const tool = (icon, title, id, o) => Git.toolBtn(Object.assign({ icon, title, id }, o));
    const bar = h('div.g-toolbar.fv-pop-bar', { role: 'toolbar' },
      tool('general/up', t('Previous Change') + '  ⌃⌥⇧↑', 'fv-pop-prev', { disabled: k <= 0, onClick: () => FM.step(v, -1, true) }),
      tool('general/down', t('Next Change') + '  ⌃⌥⇧↓', 'fv-pop-next', { disabled: k >= list.length - 1, onClick: () => FM.step(v, 1, true) }),
      tool('vcs/revert', t('Rollback Lines'), 'fv-pop-rollback', { disabled: !v.baseLines || v.rev, onClick: () => rollback(v, b) }),
      tool('vcs/diff', t('Show Diff for Lines'), 'fv-pop-diff', { onClick: () => showDiff(v, b) }),
      tool('general/copy', t('Copy'), 'fv-pop-copy', { disabled: !old.length, onClick: () => { Git.copy(old.join('\n') + '\n'); FM.close(); } }),
      b.type === 'mod' ? tool('inline/exactWords', t('Highlight Words'), 'fv-pop-words', { active: words, onClick: () => { words = !words; FM.open(v, k); } }) : null);
    const content = h('div.fv-pop', { dataset: { block: String(k) } }, bar, old.length ? oldBody(v, b) : null);
    pop = Git.popup({ anchor: row || v.root, placement: 'below', className: 'fv-marker-pop', content, onClose: () => { pop = null; } });
    return pop;
  };
})();
