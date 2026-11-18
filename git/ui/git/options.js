/* The Options button of a single view's header (⋮, as the "Options" of an IntelliJ tool window's header): what is
   not a view option and has no Settings menu to live in outside the workbench. Before, the language and Report a
   Problem stood at the end of View Options (the eye), where nobody looked for them (the owner, 17 Nov 2026).
   Its menu: the language, Report a Problem… (report.js, with a host that takes reports), "Update to …" while a newer
   release is out (update.js; the button then carries a dot) and the product with its version (`Git.host.version`, a
   row that does nothing).
     Git.options.button() → the header's button, or null in the workbench (its Settings menu has these)
     Git.options.shown()  → a button is on the page
     Git.options.rows()   → the same rows for the end of a view's own menu when the page has no such button (a single
                            view without a header); [] when it has one, and in the workbench */
(function () {
  'use strict';
  const Git = window.Git;
  const t = (...a) => Git.t(...a);
  Git.addTR({ 'Options': 'Seçenekler' });
  const O = (Git.options = {});
  const single = () => !!(Git.workbench && Git.workbench.mode !== 'workbench');
  const report = () => (Git.report && Git.report.available() ? [{ label: t('Report a Problem…'), action: () => Git.report.open() }] : []);
  function items() {
    const pick = (code) => (Git.switchLang ? Git.switchLang(code) : Git.setLang(code));
    const list = [{ header: t('Language'), label: t('Language'), disabled: true }]
      .concat(Git.languages().map((l) => ({ label: l.name, checked: l.code === Git.lang, action: () => pick(l.code) })));
    const rep = report();
    if (rep.length) list.push('-', ...rep);
    const version = Git.host && typeof Git.host.version === 'string' && Git.host.version ? ' ' + Git.host.version : '';
    // a newer release (update.js): its row stands right above the version it replaces
    list.push('-', ...(Git.update ? Git.update.rows() : []), { label: Git.product() + version, disabled: true });
    return list;
  }
  O.button = function () {
    if (!single()) return null;
    const b = Git.toolBtn({ icon: 'general/moreVertical', title: t('Options'), id: 'wb-options', onClick: (e) => Git.menu(e.currentTarget, items()) });
    b.classList.add('wb-options');
    if (Git.update) Git.update.mark(b);
    return b;
  };
  O.shown = () => !!document.getElementById('wb-options');
  O.rows = () => (!single() || O.shown() ? [] : Git.languageMenu().concat(Git.report ? Git.report.menu() : []));
})();
