/* What a diff tab shows, before it is drawn (diffview.js draws it). No DOM.
   Git.diffLoad
     .tabId(spec) · .titleOf(spec) · .alive(spec)   tab identity, the title known before the contents load, whether a
                                                    local diff still has something to show
     .load(spec) -> Promise<src>                    { title, revert, left, right, note?, same?, plain? }; a side is
                                                    { text, binary, tooLarge, id, eol, label, path?, rev?, locked? } or null
                                                    (the file does not exist there); `revert` = the » arrows write the
                                                    work tree (a local change with both sides as text)
     .noteFor(src)                                  IntelliJ's message instead of the panes (binary, too large) or null
     .sameNote(src, m)                              the note under panes without differences: identical, only line
                                                    separators, only whitespace
     .signature(src) · .revTip(id)
     .settings · .setting(name, value) · .IGNORE · .HIGHLIGHT   the viewer settings shared by every diff tab (prefs
                                                    `diff.settings`; Git.diffTab.settings / .set are the same) */
(function () {
  'use strict';
  const Git = window.Git;
  const t = (...a) => Git.t(...a);
  const L = (Git.diffLoad = {});

  Git.addTR({
    'Current version': 'Geçerli sürüm', 'Commit: {0}': 'Commit: {0}', 'Repository Diff: {0}': 'Depo diff\'i: {0}', 'Diff': 'Diff',
    'commit {0}': 'commit {0}', 'Author: {0}': 'Yazar: {0}', 'Date: {0}': 'Tarih: {0}',
    'Files are too large to compare': 'Dosyalar karşılaştırılamayacak kadar büyük', 'Files contents are different': 'Dosya içerikleri farklı',
    'Files contents are identical': 'Dosya içerikleri aynı', 'Binary file viewer': 'İkili dosya görüntüleyici',
    'Cannot find file: {0}': 'Dosya bulunamadı: {0}', 'Contents are identical': 'İçerikler aynı',
    'Contents have differences only in line separators': 'İçerikler yalnız satır sonu karakterlerinde farklı',
    'Differences ignored': 'Farklar yok sayıldı', 'No newline at end of file': 'Dosya sonunda satır sonu yok',
  });

  Git.addTR({
    'Previous Difference': 'Önceki fark', 'Next Difference': 'Sonraki fark', 'Jump to Source': 'Kaynağa git',
    'Compare Previous File': 'Önceki dosyayı karşılaştır', 'Compare Next File': 'Sonraki dosyayı karşılaştır',
    '1 file': '1 dosya', '{0}/{1} files': '{0}/{1} dosya',
    'Side-by-side viewer': 'Yan yana görünüm', 'Unified viewer': 'Birleşik görünüm',
    'Ignore Differences': 'Farkları yok say', 'None': 'Hiçbiri', 'Trim whitespaces': 'Baştaki ve sondaki boşlukları yok say', 'Ignore whitespaces': 'Boşlukları yok say',
    'Ignore whitespaces and empty lines': 'Boşlukları ve boş satırları yok say',
    'Highlighting Differences': 'Farkları vurgula', 'Lines': 'Satırlar', 'Words': 'Kelimeler', 'Split changes': 'Bölünmüş değişiklikler', 'Characters': 'Karakterler',
    // the old toolbar's dropdown texts, still used by the History tab (log-history.js)
    'Do not ignore': 'Yok sayma', 'Highlight words': 'Kelimeleri vurgula', 'Highlight lines': 'Satırları vurgula', 'Do not highlight': 'Vurgulama',
    'Settings': 'Ayarlar', 'Align Changes In Side-by-Side Diff': 'Yan yana diff\'te değişiklikleri hizala',
    'Collapse Unchanged Fragments': 'Değişmeyen bölümleri katla', 'Synchronize Scrolling': 'Kaydırmayı eşzamanla',
    'No differences': 'Fark yok', '1 difference': '1 fark', '{0} differences': '{0} fark', 'Revert': 'Geri al', 'Append': 'Ekle',
    'Differences highlighting is off': 'Fark vurgulama kapalı',
    'Press again to go to the next file': 'Sonraki dosyaya geçmek için yeniden bas',
    'Press again to go to the previous file': 'Önceki dosyaya geçmek için yeniden bas',
    'Collapsed unchanged lines': 'Katlanmış, değişmeyen satırlar',
    'Unable to calculate diff. File is too big and there are too many changes.': 'Fark hesaplanamıyor. Dosya çok büyük ve çok fazla değişiklik var.',
  });

  // ---------------------------------------------------------------- viewer settings (shared by every diff tab, kept in prefs)
  // DiffBundle option.ignore.policy.* / option.highlighting.policy.*, in IgnorePolicy / HighlightPolicy order ("Ignore
  // formatting" and "Ignore language-specific changes" need a language parser: left out)
  L.IGNORE = [['none', 'None'], ['trim', 'Trim whitespaces'], ['ws', 'Ignore whitespaces'], ['ws-empty', 'Ignore whitespaces and empty lines']];
  L.HIGHLIGHT = [['lines', 'Lines'], ['words', 'Words'], ['split', 'Split changes'], ['chars', 'Characters'], ['none', 'None']];
  const KEY = 'diff.settings';
  L.settings = { mode: 'side', ignore: 'none', highlight: 'words', collapse: false, sync: true, align: false };
  try { Object.assign(L.settings, (Git.host && Git.host.prefs && Git.host.prefs.get(KEY, null)) || {}); } catch (e) { /* defaults */ }
  L.setting = function (name, value) {
    L.settings[name] = value;
    try { Git.host.prefs.set(KEY, L.settings); } catch (e) { /* not kept */ }
    Git.emit('diff-settings', name);
  };

  L.tabId = (spec) => (spec.tabId ? spec.tabId : spec.kind === 'local' ? 'diff:local' : spec.kind === 'commit' ? 'diff:commit' : spec.kind === 'stash' ? 'diff:stash'
    : spec.kind === 'file' ? 'file:' + spec.path : spec.id || 'diff:texts');
  L.titleOf = function (spec) {
    const name = Git.fileName(spec.path || '');
    if (spec.kind === 'local') return t('Commit: {0}', name);
    if (spec.kind === 'stash') return spec.ref + ': ' + name;          // GB stash.editor.diff.preview.id.change.title "{0}: {1}"
    if (spec.kind === 'commit') return t('Repository Diff: {0}', name);
    if (spec.kind === 'file') return name;
    return spec.title || name || t('Diff');
  };
  L.alive = function (spec) {
    if (spec.kind === 'local') return !!Git.localFile(spec.path);
    return true;
  };
  const side = (c, o) => (c && c.exists ? Object.assign({ text: c.text, binary: c.binary, tooLarge: c.tooLarge, id: c.id, eol: c.eol, kind: c.kind }, o) : null);

  L.load = async function (spec) {
    const title = L.titleOf(spec);
    if (spec.kind === 'local') {
      const f = Git.localFile(spec.path);
      if (!f) return null;
      const head = Git.headId(), added = f.status === 'A' || f.status === '?' || !head;
      const l = added ? null : { path: f.oldPath || spec.path, rev: head }, r = f.status === 'D' ? null : { path: spec.path, worktree: true };
      const p = await Git.content.pair(l, r);
      const left = l ? side(p.left, { rev: head, label: Git.short(head), path: l.path, locked: true }) : null;
      const right = r ? side(p.right, { label: t('Current version'), worktree: true }) : null;
      const text = (s) => s && s.text != null && !s.binary && !s.tooLarge && s.kind === 'file';
      return { title, revert: !!(left && right && text(left) && text(right)), left, right };
    }
    if (spec.kind === 'commit') {
      const d = await Git.content.details(spec.commit);
      const entry = (d.changes || []).find((x) => (spec.parent ? x.parent === spec.parent : true)) || (d.changes || [])[0];
      const ch = entry && entry.files.find((x) => x.path === spec.path);
      if (!ch) return { title, note: t('Cannot find file: {0}', spec.path) };
      const parent = entry.parent;
      const l = ch.status === 'A' || !parent ? null : { path: ch.oldPath || spec.path, rev: parent };
      const r = ch.status === 'D' ? null : { path: spec.path, rev: d.id };
      const p = await Git.content.pair(l, r);
      return { title, same: p.same,
        left: l ? side(p.left, { rev: parent, label: Git.short(parent), path: l.path, locked: true }) : null,
        right: r ? side(p.right, { rev: d.id, label: Git.short(d.id), file: spec.path, path: ch.oldPath ? spec.path : null, locked: true }) : null };
    }
    if (spec.kind === 'stash') {
      // IntelliJ's default ("With the local version of a file", GitStashChange.createDiffWithLocalRequestProducer):
      // the local file on the left, the stash's version on the right titled "Stash@{n}"
      const ch = (spec.changes || []).find((x) => x.path === spec.path) || { path: spec.path, status: spec.status || 'M' };
      const l = { path: spec.path, worktree: true };
      const r = ch.status === 'D' ? null : { path: spec.path, rev: spec.rev };
      const p = await Git.content.pair(l, r);
      return { title, same: p.same,
        left: side(p.left, { label: t('Current version'), worktree: true, path: spec.path }),
        right: r ? side(p.right, { rev: spec.rev, label: spec.ref, file: spec.path, locked: true }) : null };
    }
    if (spec.kind === 'file') {
      const c = await Git.content.file({ path: spec.path, worktree: true });
      if (!c.exists) return { title, note: t('Cannot find file: {0}', spec.path) };
      return { title, plain: true, left: null, right: side(c, { label: spec.path, path: spec.path }) };
    }
    const own = (s) => (s && s.text != null ? { text: s.text, label: s.title || '', locked: !!s.locked, path: s.path || null } : null);
    return { title, left: own(spec.left), right: own(spec.right) };
  };

  L.noteFor = function (src) {
    if (src.note) return src.note;
    const sides = [src.left, src.right].filter(Boolean);
    if (sides.some((s) => s.tooLarge)) return t('Files are too large to compare');
    if (sides.some((s) => s.binary)) return src.plain ? t('Binary file viewer') : src.same || (src.left && src.right && src.left.id && src.left.id === src.right.id) ? t('Files contents are identical') : t('Files contents are different');
    return null;
  };
  /** Both sides there and no difference shown: why (DiffBundle's notices). */
  L.sameNote = function (src, m) {
    if (!src.left || !src.right || m.changes.length) return null;
    const a = src.left.text || '', b = src.right.text || '';
    if (a === b) return t('Contents are identical');
    if (a.replace(/\r\n?/g, '\n') === b.replace(/\r\n?/g, '\n')) return t('Contents have differences only in line separators');
    return null;                                  // the ignore policy hid them: the count says "Differences ignored"
  };
  /** No difference shown although the texts differ beyond line separators (DiffUtil.getStatusText: "Differences ignored"). */
  L.allIgnored = function (src, m) {
    if (!src.left || !src.right || m.changes.length) return false;
    return (src.left.text || '').replace(/\r\n?/g, '\n') !== (src.right.text || '').replace(/\r\n?/g, '\n');
  };
  L.signature = (src) => [src.left ? src.left.text + '\u0001' + src.left.label : '\u0002', src.right ? src.right.text + '\u0001' + src.right.label : '\u0002', src.revert, src.note || ''].join('\u0000');
  L.revTip = function (id) {
    const c = Git.commit(id);
    return c ? [t('commit {0}', c.id), t('Author: {0}', Git.author(c.author).name), t('Date: {0}', Git.formatDate(c.time)), '', c.subject].join('\n') : '';
  };
})();
