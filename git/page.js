/* The Cave host's page adapter. The server Cave starts (sunucu.sh, host.json) answers the page's host/adapter.js with
   this file, so it runs before any UI script and hands the UI Cave's identity (fields: ui/host/product.js):
     product        the plugin's earlier name in messages, as before the base became neutral
     storagePrefix  that name plus ":", so the preferences an earlier install stored (skin, language, splitters) are read
     skinLabel      the default skin is called "Cave" in the Appearance menu
     skinAliases    a stored or ?skin= value "cave" (the skin's earlier name) is the default skin
     startCommand   what the "cannot reach the server" page tells to run (the market copy has none: unreachableHint)
     unreachableHint  the market copy's own advice on that page: Cave runs the server, so turn the plugin off and on
   The two values that differ between the owner's install and the market copy (hosts/cave/yayin.mjs replaces the
   SETTINGS line below when it publishes) are the start command and the tracker of Report a Problem.
     report         Report a Problem (ui/git/report.js): the server's facts (server/report.js) and this plugin's
                    repository as the tracker; a screenshot goes to the clipboard through the server (macOS)
   and, inside Cave (eklenti.json `paneller` and `orta`, Cave's docs/eklentiler.md):
     forward        a panel in Cave's right column (?view=commit, ?view=log) sends what it opens (ui/git/openers.js) to
                    Cave through the `cavePanel` message handler, with the editor tab it belongs in (`sekme`: Cave
                    opens or reuses that tab of its editor strip); Cave answers true when its centre page shows it,
                    false (refused, or no such handler) runs it here as before
     views.tab      the centre page (?view=tab), the equivalent of Orca's center tab (hosts/orca/editor.js): Cave hands
                    it the opener with window.caveOrta({ name, args, root }); everything shown before goes. The last
                    one is kept in sessionStorage and shown again after the page reloaded itself for a new build
   Centre presence (ui/git/centre.js: a single click switches the diff only while one shows in the centre): a Cave
   that offers it says itself what its editor shows (caveOrtaDurumu / the 'orta-durum' request, below), since its
   editor stays mounted, maybe under a cover, while the owner is in another app. Without it the base default holds:
   the centre page and the panels come from the same local server and share Cave's website data store, so the
   base's localStorage report works as it is. A centre tab Cave did not open is reported to the log (Git.diag). */
(function () {
  'use strict';
  const Git = (window.Git = window.Git || {});
  // yayin.mjs-replaces-this-line: the owner's install starts the server by hand and reports to its own repository
  const SETTINGS = { startCommand: null, issues: 'https://github.com/omerfarukgzr/cave-plugins/issues/new' };
  Git.host = Object.assign(Git.host || {}, {
    product: 'cave-git',
    storagePrefix: 'cave-git:',
    skinLabel: 'Cave',
    skinAliases: { cave: 'default' },
  });
  if (SETTINGS.startCommand) Git.host.startCommand = SETTINGS.startCommand;
  else {
    // no command to run: Cave owns the server (ui/git/workbench.js asks for this text when a host gives one)
    Git.host.unreachableHint = () => {
      const en = 'Turn the plugin off and on again on the Eklentiler page of Cave\'s settings, then retry.';
      if (Git.addTR) Git.addTR({ [en]: 'Cave ayarlarındaki Eklentiler sayfasından eklentiyi kapatıp yeniden aç, sonra tekrar dene.' });
      return Git.t(en);
    };
  }

  // Cave's look (ui/git/look.js, fileicons.js): the font and the file icon theme picked in Cave's settings, when this
  // Cave build hands them (Cave's docs/eklentiler.md "Görünüm"). Before the page loads Cave may set
  //   window.caveGorunum = { yazi: { aile: <CSS font-family>, boyut: <px>, satir: <px, 0 = automatic> },
  //                          simge: 'seti' | 'material' | 'minimal' | 'yok' }
  // and calls window.caveGorunumDegisti(<the same shape>) when the owner changes it (no reload: the page redraws).
  // `yazi` is Cave's editor and terminal font: it is the code font here (diffs, the file view, the Console); the rest
  // of the page keeps the system font Cave's own interface uses. `simge` other than 'seti': every file and folder icon
  // is Cave's picture of it, `cave-simge://<theme>/<name>?klasor=0|1&acik=0|1` (16×16), which Cave's web view
  // serves (SVG for material and minimal); 'yok' (no icons) leaves an empty 16×16 box for files and folders alike;
  // 'seti' (or nothing) keeps the base's own Seti icons and IntelliJ's folders. Without caveGorunum nothing
  // changes. The page has no Content-Security-Policy, so the scheme needs no allowance.
  let gorunum = null;
  const takeGorunum = (g) => {
    gorunum = g && typeof g === 'object' ? g : null;
    return gorunum;
  };
  const toLook = (g) => {
    const look = { icons: g && typeof g.simge === 'string' ? g.simge : '' };
    const y = g && g.yazi && typeof g.yazi === 'object' ? g.yazi : null;
    if (y) look.code = { family: typeof y.aile === 'string' ? y.aile : '', size: Number(y.boyut) || 0, lineHeight: Number(y.satir) || 0 };
    return look;
  };
  try { takeGorunum(window.caveGorunum); } catch (e) { gorunum = null; }
  const lookListeners = [];
  window.caveGorunumDegisti = function (g) {
    takeGorunum(g);
    const look = toLook(gorunum);
    lookListeners.slice().forEach((fn) => { try { fn(look); } catch (e) { console.error(e); } });
    return true;
  };
  const THEME = /^[a-z0-9][a-z0-9-]{0,40}$/;
  Object.assign(Git.host, {
    look: () => (gorunum ? toLook(gorunum) : null),
    onLookChange(fn) {
      lookListeners.push(fn);
      return () => { const i = lookListeners.indexOf(fn); if (i >= 0) lookListeners.splice(i, 1); };
    },
    fileIcon(name, o) {
      const theme = gorunum && typeof gorunum.simge === 'string' ? gorunum.simge : '';
      if (!theme || theme === 'seti' || !THEME.test(theme) || typeof name !== 'string' || !name) return null;
      // "no icons" in Cave: an empty 16×16 box, so the names stay where they were
      if (theme === 'yok') return '<span class="ficon"></span>';
      o = o || {};
      const src = 'cave-simge://' + theme + '/' + encodeURIComponent(name) + '?klasor=' + (o.dir ? 1 : 0) + '&amp;acik=' + (o.expanded ? 1 : 0);
      return '<img class="ficon" src="' + src + '" width="16" height="16" alt="" draggable="false">';
    },
  });

  let view = null;
  try { view = new URLSearchParams(location.search).get('view'); } catch (e) { view = null; }
  const bridge = () => {
    try { return window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.cavePanel; } catch (e) { return null; }
  };

  // Jump to Source (ui/git/actions-changes.js jumpToSource → Git.host.openFile): a working-tree file opens in Cave's
  // editor at the line, from a panel and from the centre page alike. Cave answers true when it opened it; anything else
  // (refused, an older Cave without the handler) shows the file here, as the base does without a host editor. A file
  // at a revision stays the base's read-only file view (a Git tab).
  if (bridge()) {
    Git.host.openFile = function (path, o) {
      o = o || {};
      const root = Git.repo && Git.repo.root;
      const handler = bridge();
      if (!root || !handler || typeof path !== 'string' || !path || o.rev) return false;
      const message = { tur: 'dosya', yol: root.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, '') };
      if (Number.isInteger(o.line) && o.line > 0) message.satir = o.line;
      const fallback = () => { if (Git.actions && Git.actions.showFile) Git.actions.showFile(path, o); };
      let answer;
      try { answer = handler.postMessage(message); } catch (e) { return false; }
      Promise.resolve(answer).then((ok) => { if (ok !== true) fallback(); }, fallback);
      return true;
    };
  }

  // Report a Problem (ui/git/report.js; the owner, 17 Nov 2026: in Cave as in Orca). The server tells its own account
  // of what it did (server/report.js: versions, the engine's calls and git commands as names, counts and timings;
  // never a path or a name), the page adds its own, and the report opens as a new issue of this plugin's repository,
  // filled in (a private repository: only its owner reads it, so the dialog does not call it public). The page opens
  // that site with window.open (the standalone host's openExternal): Cave hands it to the default browser. These
  // calls go to the server directly, not through Git.backend: they are not the engine's, and a report must not list
  // its own making among the page's calls.
  const ISSUES = SETTINGS.issues;
  const ask = (method, params) => fetch('/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params: params || {} }), cache: 'no-store' })
    .then((res) => res.json()).then((body) => { if (!body || body.error) throw new Error((body && body.error && body.error.code) || 'transport'); return body.result; });
  const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
  const done = (p) => p.then((r) => !!(r && r.ok === true), () => false);
  Git.host.report = {
    github: ISSUES,
    diagnostics: () => Promise.resolve().then(() => ask('report.diagnostics', {})).then((r) => {
      const env = list(r && r.environment);
      // the app the page runs in, after the product: Cave when its message handler is there (it does not say its version)
      return { environment: bridge() ? env.slice(0, 1).concat('Cave', env.slice(1)) : env, lines: list(r && r.lines), detail: (r && r.detail) || null };
    }, () => ({ environment: [], lines: ['server: no answer'], detail: null })),
  };
  // A screenshot travels over the clipboard (core/report/picture.js; macOS only, and the server is on this machine):
  // the server keeps the PNG and puts it on the clipboard when the tracker's page has opened.
  let mac = false;
  try { mac = /Mac/.test(String(navigator.platform || navigator.userAgent || '')); } catch (e) { mac = false; }
  if (mac) {
    Git.host.report.picture = {
      set: (base64) => done(Promise.resolve().then(() => ask('report.picture.put', { id: 'p' + Date.now().toString(36), seq: 0, last: true, data: base64 }))),
      copy: () => done(Promise.resolve().then(() => ask('report.picture.copy', {}))),
      clear: () => done(Promise.resolve().then(() => ask('report.picture.clear', {}))).then(() => true),
    };
  }

  // A panel page in Cave's column: what it opens goes to Cave's centre.
  if (view !== 'tab' && bridge()) {
    Git.host.forward = function (name, args) {
      const root = Git.repo && Git.repo.root;
      const handler = bridge();
      if (!root || !handler) return false;
      // `sekme`: the editor tab it goes to in Cave (its identity and title, ui/git/openers.js describe); an older Cave
      // ignores the field, a newer one without it uses one tab for everything.
      const message = { tur: 'orta', veri: { name, args, root } };
      let tab = null;
      try { tab = Git.openers && typeof Git.openers.describe === 'function' ? Git.openers.describe(name, args) : null; } catch (e) { tab = null; }
      if (tab && typeof tab.id === 'string' && tab.id) message.sekme = tab.title ? { kimlik: tab.id, baslik: tab.title } : { kimlik: tab.id };
      let answer;
      const missed = (why) => { try { if (Git.diag) Git.diag.report({ kind: 'host', title: 'centre tab not opened', message: name + ': ' + why }); } catch (e) { /* no log */ } };
      try { answer = handler.postMessage(message); } catch (e) { missed('postMessage threw ' + ((e && e.message) || e)); return false; }
      return Promise.resolve(answer).then((ok) => { if (ok !== true) missed('Cave answered ' + JSON.stringify(ok === undefined ? null : ok)); return ok === true; },
        (e) => { missed('Cave refused: ' + ((e && e.message) || e)); return false; });
    };

    // Centre presence from Cave itself, when this Cave build offers it (docs/eklentiler.md "Paneller"): Cave calls
    // window.caveOrtaDurumu({ gorunur, sekme }) when the shown editor tab or the stage changes, and answers the request
    // { tur: 'orta-durum' } with the same object. `sekme` is the kimlik of this plugin's active tab (null: another
    // tab, or none), `gorunur` whether the editor is on the stage. A diff shows when it is visible and its kimlik is a
    // diff tab's (ui/git/openers.js describe: 'diff:local', 'diff:commit', …). Feature-detected: Git.host.centreShown
    // is set only once Cave has answered or called with that shape, so an older Cave (no answer, or false) keeps the
    // base default (the centre page's report in shared storage, ui/git/centre.js).
    let ortaState = null;
    const validState = (s) => !!s && typeof s === 'object' && typeof s.gorunur === 'boolean' && (s.sekme === null || s.sekme === undefined || typeof s.sekme === 'string');
    const diffShown = (s) => !!(s && s.gorunur === true && typeof s.sekme === 'string' && /^diff:/.test(s.sekme));
    const askCave = () => {
      const handler = bridge();
      if (!handler) return Promise.resolve(null);
      let answer;
      try { answer = handler.postMessage({ tur: 'orta-durum' }); } catch (e) { return Promise.resolve(null); }
      return Promise.resolve(answer).then((s) => (validState(s) ? s : null), () => null);
    };
    const adopt = (s) => {
      ortaState = { gorunur: s.gorunur, sekme: typeof s.sekme === 'string' ? s.sekme : null };
      if (Git.host.centreShown !== centreShown) Git.host.centreShown = centreShown;
    };
    // asked fresh at every single click; what Cave last pushed when the answer does not come
    function centreShown() {
      return askCave().then((s) => { if (s) adopt(s); return diffShown(ortaState); });
    }
    window.caveOrtaDurumu = function (s) { if (validState(s)) adopt(s); };
    askCave().then((s) => { if (s) adopt(s); });
  }

  // The selected terminal tab's folder (Cave's docs/eklentiler.md "Seçili sekmenin klasörü", Cave D-user-35): Cave calls
  // window.caveSekme({ klasor }) when the tab selected on its left (a Claude session, a shell) works in another folder,
  // and answers { tur: 'sekme' } with the same object. `klasor` is the project's folder (the page's home) or the root
  // of one of its worktrees. The panels follow it like Orca's follow its focused worktree: a linked worktree is shown
  // in place (Git.worktrees.show), the home goes back (Git.worktrees.back). Only a new value acts, so a worktree the
  // owner picks from the list stays until Cave tells another folder. A value that comes before the repository and its
  // worktree list are ready waits for them. The centre page (?view=tab) does not follow: it shows what a panel opened
  // (its root comes with it), and a diff open there never changes by itself. An older Cave never calls and answers the
  // request with false: nothing happens.
  if (view !== 'tab') {
    let startRepo = null;
    try { startRepo = new URLSearchParams(location.search).get('repo'); } catch (e) { startRepo = null; }
    const trim = (p) => (p.length > 1 ? p.replace(/\/+$/, '') : p);
    const inside = (p, dir) => p === dir || p.startsWith(dir === '/' ? '/' : dir + '/');
    let last = null;        // the last value Cave told (a repeat does nothing)
    let want = null;        // a new value not applied yet
    let reloaded = null;    // the value the worktree list was read again for (a worktree made after the last read)
    let timer = null, waited = 0;
    const ready = () => {
      const W = Git.workbench, WT = Git.worktrees;
      return !!(W && W.mode === 'single' && Git.repo && Git.repo.root && Git.store && Git.store.status === 'ready'
        && WT && typeof WT.home === 'function' && WT.home());
    };
    /** Where `folder` belongs: a worktree root of the list, the home root, or null (not this repository). */
    const target = (folder, list) => {
      const WT = Git.worktrees, homeRoot = WT.home();
      const paths = (list || []).map((w) => w && typeof w.path === 'string' ? trim(w.path) : null).filter(Boolean);
      if (paths.indexOf(folder) >= 0) return folder;
      if (folder === homeRoot || (startRepo && folder === trim(startRepo))) return homeRoot;
      // inside a linked worktree's folder; the home holds the worktrees under it, so it is no holder (a worktree made
      // after the list was read would look like the home)
      const holder = paths.filter((p) => p !== homeRoot && inside(folder, p)).sort((a, b) => b.length - a.length)[0];
      return holder || null;
    };
    const later = () => {
      if (timer || want == null) return;
      // tries again while the repository opens; gives up after two minutes (a folder that is no repository)
      const delay = Math.min(1000, 100 + waited / 4);
      if (waited > 120000) { want = null; return; }
      waited += delay;
      timer = setTimeout(() => { timer = null; apply(); }, delay);
    };
    function apply() {
      if (want == null) return;
      if (!ready()) { later(); return; }
      const WT = Git.worktrees, folder = want, list = WT.list();
      if (list == null) { if (typeof WT.load === 'function') WT.load(); later(); return; }   // the list is read: ask again soon
      const to = target(folder, list);
      if (to == null && reloaded !== folder && typeof WT.load === 'function') {
        reloaded = folder;      // perhaps a worktree made after the list was read: read it once more
        Promise.resolve(WT.load(true)).then(() => apply(), () => apply());
        return;
      }
      want = null;
      if (to == null || to === Git.repo.root) return;
      if (to === WT.home()) WT.back(); else WT.show(to);
    }
    const take = (s) => {
      if (!s || typeof s !== 'object' || typeof s.klasor !== 'string' || !s.klasor || s.klasor[0] !== '/') return false;
      const folder = trim(s.klasor);
      if (folder === last) return true;
      last = folder;
      want = folder;
      reloaded = null;
      waited = 0;
      apply();
      return true;
    };
    let told = false;
    window.caveSekme = function (s) { if (take(s)) told = true; };
    const handler = bridge();
    if (handler) {
      let answer;
      try { answer = handler.postMessage({ tur: 'sekme' }); } catch (e) { answer = null; }
      // what Cave pushed meanwhile is newer than this answer
      Promise.resolve(answer).then((s) => { if (!told) take(s); }, () => {});
    }
  }

  // The centre page on Cave's stage.
  if (view === 'tab') {
    const t = (...a) => Git.t(...a);
    let pending = null;
    let tried = null;            // the repository opened for the pending opener, so a differing name never loops
    // What Cave handed this page is kept in sessionStorage, so the page shows it again after it reloaded itself for a
    // new build of the server (ui/host/standalone.js sets `recovered` just before; Cave does not hand it again). A page
    // Cave opens anew has no such mark and starts empty.
    const KEEP = 'cave-git:centre.op', MARK = 'cave-git:recovered';
    const keep = (op) => { try { sessionStorage.setItem(KEEP, JSON.stringify(op)); } catch (e) { /* no storage */ } };
    try {
      const mark = Number(sessionStorage.getItem(MARK));
      sessionStorage.removeItem(MARK);
      const kept = JSON.parse(sessionStorage.getItem(KEEP) || 'null');
      if (mark && Date.now() - mark < 30000 && kept && typeof kept.name === 'string') pending = kept;
    } catch (e) { /* no storage: nothing kept */ }
    function apply() {
      const W = Git.workbench;
      if (!pending || !W || W.mode !== 'single' || W.view !== 'tab' || !Git.repo || !Git.repo.root) return;
      if (pending.root && pending.root !== Git.repo.root && tried !== pending.root) { tried = pending.root; W.open(pending.root); return; }
      const op = pending;
      pending = null;
      tried = null;
      if (!Git.openers || Git.openers.names().indexOf(op.name) < 0) return;
      if (Git.pages) Git.pages.closeAll();
      try { Git.openers.run(op.name, op.args || {}); } catch (e) { console.error(e); }
    }
    /** Cave calls this with what a panel opened; true: taken (shown now, or once the repository is open). */
    window.caveOrta = function (op) {
      if (!op || typeof op.name !== 'string') return false;
      pending = op;
      keep({ name: op.name, args: op.args || {}, root: op.root || null });
      tried = null;
      apply();
      return true;
    };
    let labels = false;
    Git.views = Git.views || {};
    Git.views.tab = {
      mount(el) {
        if (!labels && Git.addTR) {
          labels = true;
          Git.addTR({
            'Nothing to show yet': 'Henüz gösterilecek bir şey yok',
            'Double-click a changed file in the Git Log or Commit panel, or open a history or a comparison there, to see it here.':
              'Burada görmek için Git Log ya da Commit panelinde değişen bir dosyaya çift tıkla ya da oradan bir geçmiş veya karşılaştırma aç.',
          });
        }
        const h = Git.h;
        Git.clear(el).appendChild(h('div.wb-tab-empty#wb-tab-empty', { role: 'status' },
          h('div.wb-tab-empty-title', t('Nothing to show yet')),
          h('div.wb-tab-empty-text', t('Double-click a changed file in the Git Log or Commit panel, or open a history or a comparison there, to see it here.'))));
        Promise.resolve().then(apply);   // after the view is in the page
      },
    };
  }
})();
