/* The dialogs of the Commit view and the Files tool window.
   Git.dialogs.rollback(paths)     IntelliJ's "Rollback Changes": the local changes as a tree (grouped like the Commit view),
                                   the given paths ticked, "Delete local copies of added files", the legend; Rollback runs
                                   Git.actions.doRollback(ticked, deleteAdded)
   Git.dialogs.deleteFiles(paths)  the Delete confirmation; Delete runs Git.actions.doDelete(paths) */
(function () {
  'use strict';
  const Git = window.Git;
  const h = Git.h, t = (...a) => Git.t(...a);
  const R = Git.repo;
  Git.dialogs = Git.dialogs || {};

  Git.addTR({
    'Rollback Changes': 'Değişiklikleri geri al', 'Delete local copies of added files': 'Eklenen dosyaların yerel kopyalarını sil',
    'Rollback': 'Geri al', 'Cancel': 'Vazgeç', 'Changes': 'Değişiklikler', '1 file': '1 dosya', '{0} files': '{0} dosya',
    'added': 'eklenen', 'modified': 'değişen', 'deleted': 'silinen',
    'Delete': 'Sil', 'Delete file "{0}"?': '"{0}" dosyası silinsin mi?', 'Delete {0} files?': '{0} dosya silinsin mi?',
    'Delete directory "{0}"?': '"{0}" klasörü silinsin mi?', 'Delete {0} directories?': '{0} klasör silinsin mi?',
    'Delete {0} files and {1} directories?': '{0} dosya ve {1} klasör silinsin mi?',
    'Delete {0} and {1}?': '{0} ve {1} silinsin mi?', '1 file': '1 dosya', '{0} files': '{0} dosya', '1 directory': '1 klasör', '{0} directories': '{0} klasör',
    'The content is saved first: the notification brings it back.': 'İçerik önce saklanır: bildirimdeki "Geri getir" geri getirir.',
  });

  const countText = (n) => (n === 1 ? t('1 file') : t('{0} files', n));
  const grouped = () => String(Git.host.prefs.get('commit-group', '0')) === '1';

  /** The legend IntelliJ writes under a change list: "1 added  2 modified  1 deleted" in the status colors. */
  Git.changesLegend = function (el, files) {
    const counts = { A: 0, M: 0, D: 0 };
    files.forEach((f) => { const k = f.status === '?' ? 'A' : f.status === 'R' ? 'M' : f.status; counts[k] = (counts[k] || 0) + 1; });
    Git.clear(el);
    [['A', 'added'], ['M', 'modified'], ['D', 'deleted']].forEach(([k, word]) => {
      if (counts[k]) el.appendChild(h('span', { style: { color: Git.statusColor(k) } }, counts[k] + ' ' + t(word)));
    });
    return el;
  };

  // ---------------------------------------------------------------- Rollback Changes
  Git.dialogs.rollback = function (paths) {
    const all = Git.localChanges().slice().sort((a, b) => Git.changesModel.byName(Git.fileName(a.path), Git.fileName(b.path)) || Git.changesModel.byName(a.path, b.path));
    if (!all.length) return null;
    const want = new Set(paths && paths.length ? paths : all.map((f) => f.path));
    const picked = new Set(all.filter((f) => want.has(f.path) || (f.oldPath && want.has(f.oldPath))).map((f) => f.path));
    let deleteAdded = false, dlg = null;
    const tri = (files) => { const n = files.filter((f) => picked.has(f.path)).length; return n === 0 ? false : n === files.length ? true : 'mixed'; };
    const fileNode = (f) => ({ id: 'f:' + f.path, kind: 'file', label: Git.fileName(f.path), get icon() { return Git.fileIcon(f.path); },
      color: Git.statusColor(f.status), dim: grouped() ? null : Git.dirName(f.path) || R.name, tooltip: f.oldPath ? f.oldPath + ' → ' + f.path : f.path,
      checked: picked.has(f.path), data: { files: [f] } });
    const dirNode = (d) => ({ id: 'd:' + d.path, kind: 'dir', label: d.name, icon: 'nodes/folder', dim: countText(d.files.length), checked: tri(d.files),
      data: { files: d.files }, children: d.children.map((x) => (x.kind === 'dir' ? dirNode(x) : fileNode(x.file))) });
    const legend = h('div.gc-rb-legend');
    const treeEl = h('div.gc-rb-tree');
    const tree = Git.tree({ el: treeEl, multi: true,
      nodes: () => [{ id: 'changes', kind: 'group', label: t('Changes'), bold: true, dim: countText(all.length), checked: tri(all), data: { files: all },
        children: grouped() ? [{ id: 'd:', kind: 'dir', label: R.name, icon: 'nodes/module', dim: countText(all.length), checked: tri(all), data: { files: all },
          children: Git.changesModel.dirTree(all).map((x) => (x.kind === 'dir' ? dirNode(x) : fileNode(x.file))) }] : all.map(fileNode) }],
      onCheck: (node, on) => {
        node.data.files.forEach((f) => (on ? picked.add(f.path) : picked.delete(f.path)));
        update();
      } });
    function update() {
      tree.render();
      Git.changesLegend(legend, all.filter((f) => picked.has(f.path)));
      if (dlg) dlg.buttons['gc-rb-ok'].disabled = !picked.size;
    }
    const box = Git.checkbox({ id: 'gc-rb-delete', label: t('Delete local copies of added files'), checked: false, onChange: (v) => { deleteAdded = v; } });
    dlg = Git.dialog({ title: t('Rollback Changes'), width: 520, className: 'gc-rb', content: [treeEl, legend, box],
      buttons: [{ label: t('Cancel') }, { label: t('Rollback'), primary: true, id: 'gc-rb-ok', disabled: !picked.size,
        onClick: () => { Git.actions.doRollback(all.filter((f) => picked.has(f.path)).map((f) => f.path), deleteAdded); } }] });
    update();
    return dlg;
  };

  // ---------------------------------------------------------------- Delete
  Git.dialogs.deleteFiles = function (paths, o) {
    if (!paths || !paths.length) return null;
    // a folder: the Files tree says so (o.folder), the Commit view lists an untracked folder as "dir/" (QA L7)
    const isDir = (p) => /\/$/.test(p) || (o && o.folder && paths.length === 1);
    const name = (p) => p.replace(/\/+$/, '').split('/').pop();
    const dirs = paths.filter(isDir).length, files = paths.length - dirs;
    const text = paths.length === 1 ? (dirs ? t('Delete directory "{0}"?', name(paths[0])) : t('Delete file "{0}"?', name(paths[0])))
      : !dirs ? t('Delete {0} files?', files) : !files ? t('Delete {0} directories?', dirs)
        : t('Delete {0} and {1}?', files === 1 ? t('1 file') : t('{0} files', files), dirs === 1 ? t('1 directory') : t('{0} directories', dirs));
    return Git.confirm({ title: t('Delete'), danger: true, yes: t('Delete'), text,
      detail: t('The content is saved first: the notification brings it back.'), onYes: () => Git.actions.doDelete(paths) });
  };
})();
