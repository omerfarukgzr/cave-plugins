/* The label languages (ui/git/README.md "Adding a language"). English is the key language: every label is written as
   IntelliJ's English text through Git.t(), and a language is a table from that text to its own. English is the
   default; a stored choice (Git.host.prefs 'lang') wins, `?lang=` sets one (workbench.js).
     Git.addLang(code, { name, locale, dates }, table)  registers a language or adds labels to it; `name` is what the
                                 language menus show, `locale` formats numbers and upper-cases text, `dates` is the
                                 order of a short date: 'mdy' (11/14/25) or 'dmy' (14.11.2025)
     Git.addTR(table)            the shorthand for Turkish (the tables in every module)
     Git.languages()             [{ code, name }] in the order they were registered, for the menus
     Git.languageMenu()          the language rows for a menu of a single view (none in the workbench)
     Git.setLang(code)           switches (any registered code; an unknown one is English), stores it, emits 'lang'
     Git.t(en, ...args)          the label in the current language; `{0}`, `{1}` are filled from the arguments
     Git.locale(), Git.dateOrder()   the current language's locale and short date order
   Loaded before ui.js and the views: their addTR tables run when they load. */
(function () {
  'use strict';
  const Git = (window.Git = window.Git || {});
  const langs = new Map();      // code -> { code, name, locale, dates, table }
  const prefs = () => (Git.host && Git.host.prefs) || { get: (k, d) => d, set() {} };
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  let wanted = null;            // the stored or asked-for code, also when it is not registered (yet)

  Git.addLang = function (code, info, table) {
    if (typeof code !== 'string' || !/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(code)) throw new Error('language code: ' + code);
    let l = langs.get(code);
    if (!l) { l = { code, name: code, locale: code, dates: 'mdy', table: {} }; langs.set(code, l); }
    if (info) {
      if (typeof info.name === 'string' && info.name) l.name = info.name;
      if (typeof info.locale === 'string' && info.locale) l.locale = info.locale;
      if (info.dates === 'dmy' || info.dates === 'mdy') l.dates = info.dates;
    }
    if (table) Object.assign(l.table, table);
    // a stored or asked-for language that registers after the start (a host's own file) takes over then
    if (code === wanted && Git.lang !== code) apply(code);
  };
  Git.addTR = (table) => Git.addLang('tr', null, table);
  Git.languages = () => Array.from(langs.values(), (l) => ({ code: l.code, name: l.name }));
  const current = () => langs.get(Git.lang) || langs.get('en');
  Git.locale = () => current().locale;
  Git.dateOrder = () => current().dates;

  Git.t = function (en, ...args) {
    const table = current().table;
    const s = has(table, en) ? table[en] : en;
    return args.length ? s.replace(/\{(\d+)\}/g, (_, i) => (args[+i] == null ? '' : args[+i])) : s;
  };

  // <html lang> follows the labels (upper-case text in CSS: the Turkish dotted İ only in Turkish)
  function apply(code) {
    Git.lang = langs.has(code) ? code : 'en';
    try { if (typeof document !== 'undefined' && document.documentElement) document.documentElement.lang = Git.lang; } catch (e) { /* no page */ }
  }
  /** `o.store === false`: do not store it (another frame stored it already, workbench.js follows the storage event). */
  Git.setLang = function (code, o) {
    wanted = langs.has(code) ? code : 'en';
    apply(wanted);
    if (!(o && o.store === false)) prefs().set('lang', Git.lang);
    if (Git.emit) Git.emit('lang', Git.lang);
  };

  /** Menu items to pick the language, for views without the workbench's Settings menu (a single view such as an Orca
      panel, the center tab): a separator, the "Language" title and one checked row per language; [] in the workbench,
      whose Settings menu has them. A pick goes through Git.switchLang (workbench.js: switch and redraw). */
  Git.languageMenu = function () {
    if (!Git.workbench || Git.workbench.mode === 'workbench') return [];
    const pick = (code) => (Git.switchLang ? Git.switchLang(code) : Git.setLang(code));
    return ['-', { header: Git.t('Language'), label: Git.t('Language'), disabled: true }]
      .concat(Git.languages().map((l) => ({ label: l.name, checked: l.code === Git.lang, action: () => pick(l.code) })));
  };

  Git.addLang('en', { name: 'English', locale: 'en-US', dates: 'mdy' });
  Git.addLang('tr', { name: 'Türkçe', locale: 'tr-TR', dates: 'dmy' });
  Git.addTR({ 'Language': 'Dil' });
  wanted = prefs().get('lang', 'en');
  apply(wanted);
})();
