/* The Console tab of the Git tool window (IntelliJ's VCS Console, B §18). The engine reports every git command
   of a user operation on the `console` stream (Git.repo.console). IntelliJ's own reads run as "silent" handlers and
   never reach its Console; here the engine's reads inside an operation (rev-parse, for-each-ref, cat-file, ls-files,
   status, …) are left out the same way, with their output: the Console shows the commands that do the work
   (checkout, cherry-pick, commit, push, …) and what they printed. "-c …" options are folded, as in IntelliJ.
   Toolbar: Use Soft Wraps, Scroll to the end, Clear All. The tab itself appears once a command ran and closing it
   drops the output (workbench.js). Git.logUI.consoleShown(lines) is the filter (tests). */
(function () {
  'use strict';
  const Git = window.Git;
  const h = Git.h, t = (...a) => Git.t(...a);

  Git.addTR({ 'Use Soft Wraps': 'Satırları sar', 'Scroll to the end': 'Sona kaydır', 'Clear All': 'Tümünü temizle' });

  const FOLD = /^(.*? git) ((?:-c \S+ )+)(.*)$/;
  /** Plumbing and reads: IntelliJ runs these silently (GitHandler.setSilent), so its Console never shows them. */
  const SILENT = new Set(['rev-parse', 'symbolic-ref', 'cat-file', 'ls-files', 'ls-tree', 'ls-remote', 'for-each-ref', 'rev-list', 'merge-base',
    'show-ref', 'status', 'config', 'log', 'show', 'diff', 'diff-tree', 'diff-index', 'diff-files', 'name-rev', 'var', 'check-ref-format',
    'check-ignore', 'check-attr', 'hash-object', 'write-tree', 'commit-tree', 'merge-tree', 'mktree', 'read-tree', 'count-objects', 'describe',
    'cherry', 'blame', 'grep', 'version', 'update-index', 'worktree', 'stash list', 'remote', 'fsck', 'verify-commit', 'shortlog']);
  /** The git subcommand of a command line ("12:00:01.123: [repo] git -c a=b -c c=d fetch origin" → "fetch"). */
  function subcommand(text) {
    const at = text.search(/(^|\s)git(\s|$)/);
    if (at < 0) return null;
    const words = text.slice(at).trim().split(/\s+/).slice(1);
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (w === '-c' || w === '-C' || w === '--git-dir' || w === '--work-tree') { i++; continue; }
      if (w.startsWith('-')) continue;
      return w === 'stash' && words[i + 1] === 'list' ? 'stash list' : w;
    }
    return null;
  }
  /** The lines the Console shows: every command that is not a silent read, with the output that follows it. */
  function shown(lines) {
    const out = [];
    let keep = true;
    lines.forEach((line) => {
      if (line.kind === 'cmd') keep = !SILENT.has(subcommand(line.text));
      if (keep) out.push(line);
    });
    return out;
  }
  Git.logUI = Git.logUI || {};
  Git.logUI.consoleShown = shown;

  Git.views.console = {
    mount(el) {
      let wrap = false, stick = true;
      const out = h('div.g-console-out.g-scroll', { tabIndex: 0 });
      const bar = h('div.g-toolbar.vertical');
      const root = h('div.g-console.g-grow', bar, h('div.g-split.h'), out);
      const draw = () => {
        Git.clear(out);
        shown(Git.repo.console).forEach((line) => {
          const row = h('div.g-console-line', { class: line.kind });
          const m = line.kind === 'cmd' && FOLD.exec(line.text);
          if (m) {
            const fold = h('button.g-console-fold', { type: 'button', title: m[2].trim(), onclick: () => { fold.textContent = fold.textContent === '-c ...' ? m[2].trim() : '-c ...'; } }, '-c ...');
            row.appendChild(document.createTextNode(m[1] + ' '));
            row.appendChild(fold);
            row.appendChild(document.createTextNode(' ' + m[3]));
          } else row.textContent = line.text;
          out.appendChild(row);
        });
        out.classList.toggle('wrap', wrap);
        if (stick) out.scrollTop = out.scrollHeight;
      };
      const tools = () => {
        Git.clear(bar);
        bar.appendChild(Git.toolBtn({ icon: 'softWrap', title: t('Use Soft Wraps'), active: wrap, onClick: () => { wrap = !wrap; tools(); draw(); } }));
        bar.appendChild(Git.toolBtn({ icon: 'scrollDown', title: t('Scroll to the end'), active: stick, onClick: () => { stick = !stick; tools(); draw(); } }));
        bar.appendChild(Git.toolBtn({ icon: 'delete', title: t('Clear All'), onClick: () => { Git.repo.console.length = 0; draw(); } }));
      };
      tools();
      draw();
      el.appendChild(root);
      const off = Git.on('console', draw);
      out.addEventListener('scroll', () => { stick = out.scrollTop + out.clientHeight >= out.scrollHeight - 4; });
      return () => off();
    },
  };
})();
