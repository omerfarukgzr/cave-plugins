/* The repository picker page (no repository given and none remembered, or the one asked for is not a
   repository). Recent repositories (repos.recent), repositories found under the discovery roots (repos.discover),
   and a path field with folder completion (fs.complete).
   Git.picker.mount(el, { error?, errorText?, path?, onOpen(path), ask? })
     errorText  the host's own sentence in place of the picker's wording of `error`
     ask        { title, text, items: [{ root, name, hint? }], onPick(root) }: the host knows the few folders it can be
                (Orca: the workspaces that carry the focused name) and asks only that — one question, the choices,
                and a link to the full picker. Not an error: nothing went wrong. */
(function () {
  'use strict';
  const Git = window.Git;
  const h = Git.h, t = (...a) => Git.t(...a);

  Git.addTR({
    'Open Git Repository': 'Git deposu aç', 'Recent': 'Son kullanılanlar', 'Found on this Mac': 'Bu Mac\'te bulunanlar',
    'Repository folder': 'Depo klasörü', 'Open': 'Aç', 'Searching…': 'Aranıyor…', 'Nothing found': 'Bir şey bulunamadı',
    'Not a Git repository: {0}': 'Git deposu değil: {0}', 'The folder does not exist: {0}': 'Klasör yok: {0}',
    'Bare repositories cannot be opened: {0}': 'Bare depolar açılamaz: {0}', 'Cannot open {0}': '{0} açılamadı',
    'No repositories opened yet': 'Henüz depo açılmadı', 'Type a folder path, Tab completes it': 'Klasör yolunu yaz, Tab tamamlar',
    'Open another folder…': 'Başka bir klasör aç…',
  });

  /** The host's one question (o.ask): a title, a sentence, the folders to pick from, a link to the full picker. */
  function mountAsk(el, o) {
    const a = o.ask;
    const row = (r) => h('button.wp-row.wp-ask-row', { type: 'button', title: r.root, onclick: () => a.onPick(r.root), dataset: { root: r.root } },
      Git.icon('nodes/module'), h('span.wp-name', r.name), h('span.wp-root.g-dim', r.hint || r.root));
    const page = h('div#wp.g-root.wp',
      h('div.wp-box.wp-ask',
        h('div.wp-title', a.title),
        h('div.wp-note#wp-ask', a.text),
        h('div.wp-list#wp-choices', a.items.map(row)),
        h('div.wp-links',
          h('button.g-link.wp-other', { type: 'button', id: 'wp-other', onclick: () => Git.picker.mount(el, Object.assign({}, o, { ask: null })) }, t('Open another folder…')),
          Git.report ? Git.report.link() : null)));   // a question the host could not answer itself is worth a report (report.js)
    Git.clear(el).appendChild(page);
    const first = page.querySelector('.wp-ask-row');
    if (first) setTimeout(() => first.focus(), 0);
  }

  function errorText(err, path) {
    const code = err && err.code, reason = err && err.data && err.data.reason;
    if (code === 'not_a_repo' && reason === 'missing') return t('The folder does not exist: {0}', path);
    if (code === 'not_a_repo' && reason === 'bare') return t('Bare repositories cannot be opened: {0}', path);
    if (code === 'not_a_repo') return t('Not a Git repository: {0}', path);
    return t('Cannot open {0}', path) + (code ? ' (' + code + ')' : '');
  }

  Git.picker = {
    mount(el, o) {
      o = o || {};
      if (o.ask && o.ask.items && o.ask.items.length) { mountAsk(el, o); return; }
      let shown = [], active = -1, seq = 0;
      const open = (path) => { if (path && o.onOpen) o.onOpen(path); };
      const list = h('div.wp-suggest', { role: 'listbox', id: 'wp-suggest', hidden: true });
      const field = Git.field({ id: 'wp-path', placeholder: t('Type a folder path, Tab completes it'), value: o.path || '', mono: true,
        onInput: () => complete(), onEnter: (v) => open(active >= 0 && shown[active] ? shown[active].path : v.trim()) });
      field.classList.add('wp-field');
      const recentBox = h('div.wp-list#wp-recent', h('div.g-dim', t('Searching…')));
      const foundBox = h('div.wp-list#wp-found', h('div.g-dim', t('Searching…')));
      const row = (r) => h('button.wp-row', { type: 'button', title: r.root, disabled: r.exists === false, onclick: () => open(r.root), dataset: { root: r.root } },
        Git.icon('nodes/module'), h('span.wp-name', r.name), h('span.wp-root.g-dim', r.root));
      const page = h('div#wp.g-root.wp',
        h('div.wp-box',
          h('div.wp-title', t('Open Git Repository')),
          o.error ? h('div.wp-error#wp-error', { role: 'alert' }, Git.icon('status/error'), h('span', o.errorText || errorText(o.error, o.path || ''))) : null,
          o.error && Git.report ? Git.report.link() : null,
          h('label.g-label', { for: 'wp-path' }, t('Repository folder')),
          h('div.wp-pathrow', h('div.wp-fieldwrap', field, list), Git.btn(t('Open'), { primary: true, id: 'wp-open', onClick: () => open(field.input.value.trim()) })),
          h('div.wp-head', t('Recent')), recentBox,
          h('div.wp-head', t('Found on this Mac')), foundBox));
      Git.clear(el).appendChild(page);

      function draw() {
        Git.clear(list);
        shown.forEach((e, i) => list.appendChild(h('button.wp-item', { type: 'button', role: 'option', class: i === active ? 'on' : '',
          onmousedown: (ev) => ev.preventDefault(), onclick: () => { field.input.value = e.path + (e.repo ? '' : '/'); if (e.repo) open(e.path); else complete(); } },
          Git.icon(e.repo ? 'nodes/module' : 'nodes/folder'), h('span', e.name))));
        list.hidden = !shown.length;
      }
      async function complete() {
        const prefix = field.input.value;
        const my = ++seq;
        active = -1;
        if (!/^(\/|~)/.test(prefix)) { shown = []; draw(); return; }
        try {
          const res = await Git.backend.call('fs.complete', { prefix, limit: 30 });
          if (my !== seq) return;
          shown = res.entries || [];
        } catch (e) { if (my === seq) shown = []; }
        draw();
      }
      field.input.addEventListener('keydown', (e) => {
        if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && shown.length) {
          e.preventDefault();
          active = e.key === 'ArrowDown' ? (active + 1) % shown.length : (active <= 0 ? shown.length : active) - 1;
          draw();
        } else if (e.key === 'Tab' && shown.length) {
          e.preventDefault();
          const pick = shown[active >= 0 ? active : 0];
          field.input.value = pick.path + '/';
          complete();
        }
      });
      Git.backend.call('repos.recent', {}).then((res) => {
        Git.clear(recentBox);
        const repos = res.repos || [];
        if (!repos.length) recentBox.appendChild(h('div.g-dim', t('No repositories opened yet')));
        repos.forEach((r) => recentBox.appendChild(row(r)));
      }, () => { Git.clear(recentBox); });
      Git.backend.call('repos.discover', {}).then((res) => {
        Git.clear(foundBox);
        const repos = res.repos || [];
        if (!repos.length) foundBox.appendChild(h('div.g-dim', t('Nothing found')));
        repos.slice(0, 200).forEach((r) => foundBox.appendChild(row(r)));
      }, () => { Git.clear(foundBox).appendChild(h('div.g-dim', t('Nothing found'))); });
      setTimeout(() => field.input.focus(), 0);
      if (o.path) complete();
    },
  };
})();
