/* Report a Problem (the owner, 17 Nov 2026: a wrong repository on a friend's machine could only be explained by
   guessing). A dialog that makes a bug report in the form any tracker expects, and asks the person for as little as
   it can: ONE field, what happened (its first line is the report's title), and a screenshot if they have one. The
   plugin adds the rest by itself: the Environment (product, app, system, git) and the diagnostics. It hands the
   report over as Copy, or to the host's tracker (a page the host opens in the browser, filled in; the person submits
   it there). This page sends nothing itself. Only with a host that offers it:
     Git.host.report = {
       diagnostics() → Promise<{ environment: [string], lines: [string], detail: { head: [string], tail: [string] } }>
                                           the host's facts: its Environment lines, its summary lines and its
                                           detailed log (sections, and a timeline newest first); or just the lines
       github                              the new-issue page of a GitHub repository ("https://github.com/<owner>/
                                           <repository>/issues/new"): the tracker is that page, filled in from
                                           `title` and `body`; `url`, `fits`, `where` and `images` follow from it
       url(title, body) → string | null    instead of `github`, another tracker: the page to open for a report with
                                           that title and text; the host may write the link to be read
       fits(url) → boolean                 the tracker takes a link this long (without it: `max`)
       asks() → string                     a sentence for the dialog when the host asks the person before it opens a
                                           site
       where                               the tracker's name on the button ("GitHub")
       max                                 the longest url the tracker takes, in its standard spelling (default 6500)
       images                              the tracker's page takes a dropped, pasted or chosen picture
       open                                what is sent there can be read by anyone
       picture                             { set(base64 of a PNG) → Promise<bool>, copy() → Promise<bool>, clear() }:
                                           the host can carry a screenshot to the tracker's page, over the clipboard
     }
   The report's text (Markdown, the headings of a bug report form; a part the person left empty reads "_No response_"):
     ### What happened · ### Screenshot · ### Environment (a list) · <details> Diagnostics · <details> Detailed log
   The report that travels in a link has the same parts, the detailed log readable too (the owner, 17 Nov 2026: an
   issue must bring the log with it, and not as a code nobody can read): the person's words first and without a
   heading, the Environment on one line, then the diagnostics and as many lines of the detailed log as the link has
   room for (its sections first, then the timeline, newest first). Copy has all of them.
   A picture cannot travel with the report (a link carries text only). With `picture` the dialog has a screenshot
   area (report-picture.js): the picture is handed to the host when it is added, and as the tracker's page opens the
   host puts it on the clipboard, where the person pastes it into the page; the report's text has a line for it and
   the notice says so. Without `picture` but with `images` the dialog only says where a screenshot goes.
   What the plugin adds, from the host and from here: versions, kinds, counts, error names. Never a folder path, a
   project, workspace, branch or file name, never content. The dialog shows every line before anything leaves.
     Git.report.available() · .open() · .menu() → menu rows ([] without a host) · .link() → a link button | null */
(function () {
  'use strict';
  const Git = window.Git;
  const h = Git.h, t = (...a) => Git.t(...a);
  Git.addTR({
    'Report a Problem…': 'Sorun Bildir…', 'Report a problem…': 'Sorun bildir…', 'Report a Problem': 'Sorun Bildir',
    '{0} adds technical details by itself: versions, errors and timings. No folder, project, branch or file names.':
      '{0} teknik ayrıntıları kendisi ekler: sürümler, hatalar ve süreler. Klasör, proje, dal ya da dosya adı eklemez.',
    'Show them': 'Göster', 'Hide them': 'Gizle',
    'Collecting…': 'Toplanıyor…',
    'What happened?': 'Ne oldu?', 'What you did, what you expected and what you saw instead': 'Ne yaptın, ne bekliyordun, onun yerine ne gördün',
    'Copy': 'Kopyala', 'Copied': 'Kopyalandı', 'Report on {0}': '{0}\'da Bildir',
    'Opens {0} in your browser, filled in. Nothing is sent until you submit it there.':
      'Tarayıcında {0} doldurulmuş olarak açılır. Orada gönderene kadar hiçbir şey gönderilmez.',
    'The report opened in your browser': 'Rapor tarayıcında açıldı',
    'Submit it there to send it.': 'Göndermek için orada onayla.',
    'A screenshot: drop it onto that page, paste it there or choose the file there.':
      'Ekran görüntüsü: o sayfaya sürükleyip bırak, oraya yapıştır ya da dosyayı orada seç.',
    'What you send there is public.': 'Orada gönderdiğin herkese açıktır.',
    'To add a screenshot, drop it onto the page or paste it there.': 'Ekran görüntüsü eklemek için sayfaya sürükleyip bırak ya da oraya yapıştır.',
    'Screenshots (optional)': 'Ekran görüntüleri (isteğe bağlı)',
    'The page was not opened. Press the button again and allow it, or copy the report.': 'Sayfa açılmadı. Düğmeye yeniden basıp izin ver ya da raporu kopyala.',
    'Paste the screenshots there ({0}).': 'Ekran görüntülerini oraya yapıştır ({0}).',
    'The screenshot is on your clipboard': 'Ekran görüntüsü panonda',
    'The screenshots are on your clipboard as one image': 'Ekran görüntüleri tek resim olarak panonda',
    'Paste it into the page that opened ({0}), then submit it there.': 'Açılan sayfaya yapıştır ({0}), sonra orada gönder.',
    'The screenshot did not reach the clipboard': 'Ekran görüntüsü panoya konamadı',
    'Drop the picture onto the page that opened instead.': 'Onun yerine resmi açılan sayfaya sürükleyip bırak.',
    'Your text was shortened to fit the link.': 'Yazdığın metin bağlantıya sığması için kısaltıldı.',
    'The whole report is on the clipboard: paste it into the page.': 'Raporun tamamı panoda: açılan sayfaya yapıştır.',
  });
  const R = (Git.report = {});
  // ---------------------------------------------------------------- a GitHub repository as the tracker
  // A value of a link, written to be read: a host may show the link's beginning to the person before it opens the
  // site, and a percent sign for every space and letter made it a wall of codes (the owner, 17 Nov 2026). Spaces
  // become "+", letters and digits of any script stay as they are, as do the marks a query may hold; the rest (line
  // breaks, "&", "=", "#", "%", "+") is escaped. A browser spells it the standard way when it sends it.
  const plain = (s) => Array.from(String(s == null ? '' : s)).map((ch) => {
    if (ch === ' ') return '+';
    if (/^[A-Za-z0-9\-_.!~*'(),:;@/?$]$/.test(ch) || (ch.codePointAt(0) > 127 && /^[\p{L}\p{N}]$/u.test(ch))) return ch;
    try { return encodeURIComponent(ch); } catch (e) { return ''; }      // half a surrogate pair
  }).join('');
  // How long a link GitHub takes, measured on 17 Nov 2026 with filler text. The new-issue page answers a link of up
  // to 6900 characters and fails above it (an error page). Someone who is not signed in is sent to the sign-in page
  // with the link carried along, spelled again (every mark of it becomes three characters): that works up to about
  // 7580 characters of the redirect; a longer one is dropped and the report with it. Measured again on 18 Nov 2026
  // after a friend who was not signed in got GitHub's "Whoops, something went wrong!" (500) page: the sign-in page
  // now fails above about 7020 characters of the redirect (the estimate below matched GitHub's own redirect to the
  // character), and a browser also sends its cookies, so the redirect is kept at 6000. Both are kept, with room to
  // spare, so a report arrives whoever opens it.
  const githubFits = (url) => {
    try {
      const href = new URL(url).href;
      return href.length <= 6500 && 35 + href.length + 2 * (href.match(/[^A-Za-z0-9_.-]/g) || []).length <= 6000;
    } catch (e) { return false; }
  };
  /** The host's report settings; a `github` new-issue page is turned into the `url` and `fits` of that tracker. */
  const host = () => {
    const H = Git.host && Git.host.report;
    if (!H || typeof H.diagnostics !== 'function') return null;
    if (typeof H.github !== 'string' || !H.github || typeof H.url === 'function') return H;
    return Object.assign({ where: 'GitHub', images: true, fits: githubFits, url: (title, body) => H.github + '?title=' + plain(title) + '&body=' + plain(body) }, H);
  };
  R.available = () => !!host();

  // ---------------------------------------------------------------- what this page knows: the last error names
  const MAX_ERRORS = 5;
  const errors = [];     // { what, at }
  const word = (v, re, max) => (typeof v === 'string' && re.test(v) ? v.slice(0, max) : '');
  const file = (src) => { const m = /([\w.-]+\.m?js)(?:[?#].*)?$/.exec(String(src || '')); return m ? m[1] : ''; };
  function remember(what) {
    errors.push({ what, at: Date.now() });
    if (errors.length > MAX_ERRORS) errors.shift();
  }
  /** Where an error came from, as the plugin's own files and lines (up to three frames); never the message. */
  const frames = (stack) => {
    const out = [];
    for (const m of String(stack || '').matchAll(/([\w.-]+\.m?js)(?:\?[^:\s)]*)?:(\d+)/g)) { const f = m[1] + ':' + m[2]; if (out.indexOf(f) < 0) out.push(f); if (out.length === 3) break; }
    return out;
  };
  window.addEventListener('error', (ev) => {
    const err = ev && ev.error, at = file(ev && ev.filename);
    const from = frames(err && err.stack);
    remember((word(err && err.name, /^[A-Za-z]+$/, 40) || 'Error') + (from.length ? ' at ' + from.join(' < ') : at ? ' at ' + at + ':' + (Number.isInteger(ev.lineno) ? ev.lineno : 0) : ''));
  });
  window.addEventListener('unhandledrejection', (ev) => {
    const r = ev && ev.reason;
    remember('rejection ' + (word(r && r.code, /^[A-Za-z_.-]+$/, 40) || word(r && r.name, /^[A-Za-z]+$/, 40) || 'unknown'));
  });
  if (typeof Git.on === 'function') Git.on('notify', (n) => { if (n && n.kind === 'error') remember('notice ' + (word(n.code, /^[A-Za-z_.-]+$/, 40) || 'error')); });
  const ago = (ms) => { const s = Math.max(0, Math.round((Date.now() - ms) / 1000)); return s < 90 ? s + ' s ago' : Math.round(s / 60) + ' min ago'; };

  // ---------------------------------------------------------------- what this page did: its calls and how long they took
  // The person may not have seen that something failed or was slow (the owner, 17 Nov 2026). Every call this page
  // makes to the engine is noted by its NAME, its outcome (the error's code) and its time as the page saw it (the
  // host's transport included); never its parameters or its answer.
  const MAX_CALLS = 300;
  const calls = [];      // { n, ok, code, ms, at }
  function watch() {
    const B = Git.backend;
    if (!B || typeof B.call !== 'function' || B.call.reportWatched) return;
    const real = B.call;
    const noted = function (method) {
      const t0 = performance.now();
      const done = (ok, err) => {
        calls.push({ n: word(method, /^[a-z][A-Za-z]*(\.[A-Za-z]+){0,3}$/, 60) || 'call', ok, code: ok ? null : word(err && err.code, /^[A-Za-z_]+$/, 40) || 'error', ms: Math.round(performance.now() - t0), at: Date.now() });
        if (calls.length > MAX_CALLS) calls.shift();
      };
      let p;
      try { p = real.apply(this, arguments); } catch (e) { done(false, e); throw e; }
      // the caller gets the same outcome (a rejection stays a rejection for whoever handles it, or for nobody)
      return Promise.resolve(p).then((v) => { done(true); return v; }, (e) => { done(false, e); throw e; });
    };
    noted.reportWatched = true;
    B.call = noted;
  }
  watch();
  let booted = null;     // ms from the page's start to the first repository shown
  if (typeof Git.on === 'function') Git.on('workbench', () => { watch(); if (booted === null) booted = Math.round(performance.now()); });

  /** The repository as numbers and states: what is in it and where it stands, never what it is called. */
  function repositoryLine() {
    const r = Git.repo;
    if (!r || !r.root) return 'repository: none';
    const head = r.head || {};
    const kind = (url) => {
      const u = String(url || '');
      const where = /github\.com/i.test(u) ? 'github' : /gitlab\.com/i.test(u) ? 'gitlab' : /bitbucket\.org/i.test(u) ? 'bitbucket' : /dev\.azure\.com|visualstudio\.com/i.test(u) ? 'azure' : 'other';
      const how = /^https?:/i.test(u) ? 'https' : /^ssh:|^[\w.-]+@[\w.-]+:/.test(u) ? 'ssh' : /^file:|^\//.test(u) ? 'local' : 'other';
      return where + ' ' + how;
    };
    const remotes = (r.remoteNames || []).map((n) => kind((r.remoteUrls || {})[n]));
    let upstream = 'no';
    try { upstream = head.branch && Git.upstream && Git.upstream(head.branch) ? 'yes' : 'no'; } catch (e) { upstream = 'unknown'; }
    return 'repository: ' + (r.local || []).length + ' changes' + (r.localTruncated ? ' (truncated)' : '') + ', ' + (r.conflicts || []).length + ' conflicts'
      + ', operation ' + (r.op ? word(r.op.type, /^[a-z-]+$/, 20) || 'other' : 'none')
      + ', head ' + (head.unborn ? 'unborn' : head.detached ? 'detached' : 'branch') + ', upstream ' + upstream
      + ', ' + (r.stashes || []).length + ' stashes, ' + Object.keys(r.branches || {}).length + ' branches, ' + remotes.length + ' remotes' + (remotes.length ? ' (' + remotes.join(', ') + ')' : '')
      + (r.linked ? ', a linked worktree' : '') + ', log ' + ((r.log && r.log.loaded) || 0) + ' commits' + (r.log && r.log.complete ? '' : ' so far');
  }

  /** This page's line of the Environment: where the person was (the view, its size, the labels' language). */
  function pageEnvironment() {
    const W = Git.workbench || {};
    const lang = (Git.languages().find((l) => l.code === Git.lang) || {}).name || Git.lang;
    return (W.view || 'workbench') + ' view, ' + window.innerWidth + '×' + window.innerHeight + ', ' + lang;
  }
  /** This page's technical lines: its state, the repository's shape, its calls, the app, the last error names. */
  function pageLines() {
    const W = Git.workbench || {};
    const repo = Git.repo && Git.repo.root ? (Git.store && Git.store.status) || 'open' : 'none';
    const heap = performance.memory && Number.isFinite(performance.memory.usedJSHeapSize) ? ', heap ' + Math.round(performance.memory.usedJSHeapSize / 1024 / 1024) + ' MB' : '';
    const out = [
      'page: ' + (W.mode || 'not started') + ', repository ' + repo + (Git.worktrees && Git.worktrees.away() ? ', another worktree shown' : '')
        + (booted !== null ? ', shown after ' + booted + ' ms' : '') + ', ' + document.getElementsByTagName('*').length + ' elements' + heap,
      repositoryLine(),
    ];
    if (calls.length) {
      const failed = calls.filter((c) => !c.ok);
      const slow = new Map();
      for (const c of calls) if (!slow.has(c.n) || slow.get(c.n) < c.ms) slow.set(c.n, c.ms);
      out.push('page calls: ' + (calls.length - failed.length) + ' ok, ' + failed.length + ' failed; slowest '
        + Array.from(slow).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([n, ms]) => n + ' ' + ms + ' ms').join(', '));
      if (failed.length) out.push('page failed calls: ' + failed.slice(-6).reverse().map((c) => c.n + ' ' + c.code + ' (' + ago(c.at) + ')').join('; '));
    } else out.push('page calls: none');
    out.push('errors: ' + (errors.length ? errors.map((e) => e.what + ' (' + ago(e.at) + ')').join('; ') : 'none'));
    return out;
  }

  // main-thread stalls, where the browser tells (Chromium's "longtask" entries): how many and the longest
  const stalls = { n: 0, max: 0 };
  try {
    new PerformanceObserver((list) => { for (const e of list.getEntries()) { stalls.n++; if (e.duration > stalls.max) stalls.max = Math.round(e.duration); } })
      .observe({ type: 'longtask', buffered: true });
  } catch (e) { /* not offered here */ }
  const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0);
  /** This page's part of the detailed log: its settings (the plain ones), its calls as a table and one by one,
      its errors. Names of the plugin's own things, numbers and codes; never a parameter, an answer or a message. */
  function pageDetail() {
    const W = Git.workbench || {}, out = [];
    const prefs = (Git.host && Git.host.prefs) || { get: (k, d) => d };
    const flag = (k) => { let v; try { v = prefs.get(k, null); } catch (e) { v = null; } return typeof v === 'boolean' || typeof v === 'number' ? String(v) : typeof v === 'string' && /^[\w-]{1,20}$/.test(v) ? v : v == null ? '-' : 'set'; };
    const sizes = [];
    try {
      const pre = Git.storagePrefix() + 'size.';
      for (let i = 0; i < localStorage.length && sizes.length < 40; i++) {
        const k = localStorage.key(i);
        if (!k || k.indexOf(pre) !== 0) continue;
        const name = k.slice(pre.length), v = Number(JSON.parse(localStorage.getItem(k)));
        if (/^[a-z0-9-]{1,40}$/.test(name) && Number.isFinite(v)) sizes.push(name + ' ' + Math.round(v));
      }
    } catch (e) { /* no storage in this frame */ }
    out.push('[page] view ' + (W.view || 'workbench') + ', ' + (W.mode || 'not started') + ', ' + window.innerWidth + '×' + window.innerHeight + ' at ' + (window.devicePixelRatio || 1) + 'x'
      + ', language ' + Git.lang + ', skin ' + (word(document.documentElement.dataset.gitSkin, /^[a-z]+$/, 20) || 'default')
      + (booted !== null ? '; shown after ' + booted + ' ms' : '') + '; open for ' + Math.round(performance.now() / 1000) + ' s; ' + document.getElementsByTagName('*').length + ' elements'
      + '; long tasks ' + stalls.n + (stalls.n ? ' (longest ' + stalls.max + ' ms)' : ''));
    out.push('[page settings] commit-group ' + flag('commit-group') + ', commit.ignored ' + flag('commit.ignored') + ', wb.right ' + flag('wb.right') + ', wb.rightView ' + flag('wb.rightView')
      + (sizes.length ? '; sizes: ' + sizes.sort().join(', ') : ''));
    out.push(repositoryLine());
    const by = new Map();
    for (const c of calls) { if (!by.has(c.n)) by.set(c.n, []); by.get(c.n).push(c); }
    out.push('[page calls by method] ' + calls.length + ' (as the page saw them, the host\'s transport included)');
    for (const [n, list] of Array.from(by).sort((a, b) => b[1].length - a[1].length)) {
      const ms = list.map((c) => c.ms).sort((a, b) => a - b);
      out.push(n + ': n ' + list.length + ', failed ' + list.filter((c) => !c.ok).length + ', p50 ' + pct(ms, 0.5) + ', p95 ' + pct(ms, 0.95) + ', max ' + ms[ms.length - 1] + ' ms');
    }
    out.push('[page errors] ' + (errors.length ? errors.map((e) => e.what + ' (' + ago(e.at) + ')').join('; ') : 'none'));
    const t = Date.now();
    out.push('[page calls] newest first');
    for (let i = calls.length - 1; i >= 0 && i >= calls.length - 80; i--) {
      const c = calls[i];
      out.push('-' + ((t - c.at) / 1000).toFixed(1) + 's ' + c.n + (c.ok ? ' ok ' : ' FAILED ' + c.code + ' ') + c.ms + 'ms');
    }
    return out;
  }

  const HEAD = 'Diagnostics (written by the plugin; no folder, project, branch or file names)';
  const NONE = '_No response_';
  const SHOT = 'Drag an image here, paste it or choose the file below.';
  const MAC = /Mac|iPhone|iPad/.test(String(navigator.platform || navigator.userAgent || ''));
  const PASTE_KEY = MAC ? '⌘V' : 'Ctrl+V';
  const SHOT_PASTE = 'It is on your clipboard: click here and paste it (' + (MAC ? 'Cmd+V' : 'Ctrl+V') + ').';
  const SHOTS_PASTE = 'They are on your clipboard as one image: click here and paste it (' + (MAC ? 'Cmd+V' : 'Ctrl+V') + ').';
  /** The report's text. `o`: { what, shot (the Screenshot section's line; null: no such section), environment,
      lines, log (the detailed log's lines), title (a first heading, for a report that is copied: the tracker has its
      own title field), link (the text travels in a link) }. */
  function compose(o) {
    const out = [];
    // In a link a mark outside ASCII is six to nine characters of code, and what the link has room for is counted in
    // those: the plugin's own lines are written with plain letters there. The person's words stay as they wrote them.
    const own = o.link ? (l) => String(l).replace(/×/g, 'x').replace(/ · /g, ', ').replace(/…/g, '...') : (l) => l;
    if (o.link) {
      // A host may show the link's beginning to the person before it opens the site (Orca does), and a heading mark
      // or a list is a row of codes there. So the text begins with their own words and goes on in plain sentences.
      out.push(String(o.what || '').trim() || NONE, '');
      if (o.shot != null) out.push('**Screenshot**', '', o.shot || NONE, '');
      out.push('**Environment**', '', o.environment.map(own).join(', '), '', 'Technical details from ' + Git.product() + ' follow: versions, errors and timings.', '');
    } else {
      if (o.title) out.push('# ' + o.title, '');
      out.push('### What happened', '', String(o.what || '').trim() || NONE, '');
      if (o.shot != null) out.push('### Screenshot', '', o.shot || NONE, '');
      out.push('### Environment', '', o.environment.map((l) => '- ' + l).join('\n'), '');
    }
    out.push('<details>', '<summary>' + HEAD + '</summary>', '', '```', o.lines.map(own).join('\n'), '```', '', '</details>', '');
    if (o.log && o.log.length) out.push('<details>', '<summary>Detailed log</summary>', '', '```', o.log.map(own).join('\n'), '```', '', '</details>', '');
    return out.join('\n');
  }
  /** The report's title: the first line of what the person wrote (one field is all they are asked for). */
  const titleOf = (what) => {
    const first = String(what || '').trim().split('\n')[0].trim();
    return first ? first.slice(0, 120) : 'Problem report';
  };
  const CUT = ' […]';
  /** The first lines that fit `budget` characters, and a last line saying how many were left out. */
  function fitLines(lines, budget) {
    const out = [];
    let used = 0;
    for (const l of lines) {
      if (used + l.length + 1 > budget) break;
      out.push(l);
      used += l.length + 1;
    }
    return out.length === lines.length ? out : out.concat('… ' + (lines.length - out.length) + ' more lines: the copied report has them all');
  }
  /** The tracker's page for the report. A link has a length limit: first the person's text is shortened (it also
      goes to the clipboard whole), then the diagnostics give up their last lines. { url, cut } (`cut`: the text). */
  function linkFor(H, o) {
    const whole = String(o.what || ''), log = o.log || [];
    // What counts is the link's standard spelling (a host may write it to be read: letters as they are); the host
    // may know more about its tracker than a length (`fits`).
    const max = H.max || 6500;
    const fits = (url) => {
      if (typeof H.fits === 'function') { try { return H.fits(url) === true; } catch (e) { return false; } }
      try { return new URL(url).href.length <= max; } catch (e) { return url.length <= max; }
    };
    // the first `n` lines of the detailed log, and a last line saying how many stayed behind
    const some = (n) => (n >= log.length ? log : n > 0 ? log.slice(0, n).concat('… ' + (log.length - n) + ' more lines left out: no room in the link') : null);
    const make = (what, lines, n) => H.url(o.title, compose(Object.assign({}, o, { link: true, title: null, lines, log: some(n), what: what + (what.length < whole.length ? CUT : '') })));
    // The person's text first, the diagnostics next, and the detailed log takes the room that is left: as many of
    // its lines as fit (the sections, then the timeline newest first).
    const withLog = (what, lines) => {
      const bare = make(what, lines, 0);
      if (!bare || !fits(bare)) return bare;
      let lo = 0, hi = log.length;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2), url = make(what, lines, mid);
        if (url && fits(url)) lo = mid; else hi = mid - 1;
      }
      return lo ? make(what, lines, lo) : bare;
    };
    for (const budget of [1500, 1000, 600]) {
      let what = whole, cut = false;
      const lines = fitLines(o.lines, budget);
      for (let i = 0; i < 40; i++) {
        const url = withLog(what, lines);
        if (!url) return { url: null, cut };
        if (fits(url)) return { url, cut };
        cut = true;
        if (what.length <= 200) break;                   // the text keeps its beginning; the diagnostics give way next
        what = what.slice(0, Math.max(200, Math.floor(what.length * 0.75)));
      }
    }
    return { url: make(whole.slice(0, 200), fitLines(o.lines, 300), 0), cut: whole.length > 200 };
  }

  R.open = function () {
    const H = host();
    if (!H) return null;
    const where = H.where || 'GitHub';
    let facts = null;       // { environment, lines } once the host answered
    // What the plugin adds is not laid out in the dialog (the owner, 17 Nov 2026: the complaint and the picture are
    // all a person should have to look at); one line says what kind of thing it is, and a link shows it whole.
    const data = h('pre.g-report-data', { id: 'g-report-data', tabIndex: 0, hidden: true }, t('Collecting…'));
    const SHOW = 'Show them', HIDE = 'Hide them';
    const more = h('button.g-link.g-report-more', { type: 'button', id: 'g-report-more', 'aria-expanded': 'false', 'aria-controls': 'g-report-data',
      onclick: () => { data.hidden = !data.hidden; more.setAttribute('aria-expanded', String(!data.hidden)); more.textContent = data.hidden ? t(SHOW) : t(HIDE); } }, t(SHOW));
    // One field for the person (the owner, 17 Nov 2026: three were too many): the title is its first line.
    const field = Git.field({ id: 'g-report-text', multiline: true, rows: 5, placeholder: t('What you did, what you expected and what you saw instead') });
    field.input.maxLength = 4000;
    const canOpen = typeof H.url === 'function' && Git.host && typeof Git.host.openExternal === 'function';
    // The screenshot area (report-picture.js), with a host that can carry a picture to the tracker's page.
    let sent = false;
    let dlg = null;
    const sync = () => {
      const send = dlg && dlg.buttons['g-report-send'];
      if (send) send.disabled = facts === null || opening || !!(P && P.state() === 'working');
    };
    let opening = false;        // the host is opening the tracker's page (it may be asking the person first)
    const refused = h('div.g-report-refused', { id: 'g-report-refused', role: 'alert', hidden: true },
      t('The page was not opened. Press the button again and allow it, or copy the report.'));
    const P = canOpen && H.picture && typeof H.picture.set === 'function' && R.picture ? R.picture({ picture: H.picture, onChange: () => sync() }) : null;
    const label = (text, id) => h('label.g-label', id ? { for: id } : {}, text);
    // the hints are lines of the body: beside the buttons they had no room in a narrow panel (they ran under them)
    const content = h('div.g-report',
      label(t('What happened?'), 'g-report-text'), field,
      P ? label(t('Screenshots (optional)')) : null, P ? P.el : null, P ? P.input : null,
      // what goes out with the report, in one line; the link beside it shows every line of it
      h('div.g-report-note', h('span', t('{0} adds technical details by itself: versions, errors and timings. No folder, project, branch or file names.', Git.product()) + ' '), more),
      data,
      // one short paragraph: where it goes, that it is public, and what to do with the picture there
      canOpen ? h('div.g-dim.g-report-hint', t('Opens {0} in your browser, filled in. Nothing is sent until you submit it there.', where)
        + (typeof H.asks === 'function' ? ' ' + H.asks() : '')      // a host that asks before it opens a site says so
        + (H.open ? ' ' + t('What you send there is public.') : '')
        + (P ? ' ' + t('Paste the screenshots there ({0}).', PASTE_KEY) : H.images ? ' ' + t('A screenshot: drop it onto that page, paste it there or choose the file there.') : '')) : null,
      canOpen ? refused : null);
    // the detailed log as lines: the sections, then the timeline (what a link drops first)
    const fullLog = () => facts.head.concat(facts.tail.length ? ['[timeline] newest first'].concat(facts.tail) : []);
    // The same lines in the order a link wants them, since a link is cut from its end: the sections, the timeline
    // (it has the git commands too), and this page's own list of calls last.
    const linkLog = () => {
      const at = facts.head.indexOf('[page calls] newest first');
      return (at < 0 ? facts.head : facts.head.slice(0, at)).concat(facts.tail.length ? ['[timeline] newest first'].concat(facts.tail) : [], at < 0 ? [] : facts.head.slice(at));
    };
    const report = (extra) => Object.assign({ what: field.input.value, environment: facts.environment, lines: facts.lines, log: fullLog() }, extra);
    dlg = Git.dialog({ title: t('Report a Problem'), width: 560, className: 'g-report-dlg', content,
      onClose: () => { if (P) P.dispose(sent); },
      buttons: [{ label: t('Cancel') },
        { label: t('Copy'), id: 'g-report-copy', disabled: true, keepOpen: true, onClick: () => {
          Git.copy(compose(report({ title: titleOf(field.input.value), shot: null })));
          const b = dlg.buttons['g-report-copy'], was = b.textContent;
          b.textContent = t('Copied');
          setTimeout(() => { if (b.isConnected) b.textContent = was; }, 1500);
        } }].concat(canOpen ? [{ label: t('Report on {0}', where), id: 'g-report-send', primary: true, disabled: true, onClick: () => {
          // straight from the click: a host may open a page only on the person's own gesture
          const title = titleOf(field.input.value);
          const withPicture = !!(P && P.state() === 'ready');
          const several = withPicture && P.count() > 1;        // joined into one image (report-picture.js)
          const shot = withPicture ? (several ? SHOTS_PASTE : SHOT_PASTE) : H.images ? SHOT : null;
          // the report has a Screenshot part only for a picture that is on its way; without one the notice says
          // where a picture goes
          const { url, cut } = linkFor(H, report({ title, shot: withPicture ? shot : null, log: linkLog() }));
          if (!url) return false;
          // a picture needs the clipboard for itself: a text that was shortened is then not copied
          if (cut && !withPicture) Git.copy(compose(report({ title, shot: null })));
          const shortened = cut ? t('Your text was shortened to fit the link.') + ' ' + (withPicture ? '' : t('The whole report is on the clipboard: paste it into the page.') + ' ') : '';
          // A host may ask the person before it opens a site (Orca does, the first time) and they may say no. The
          // dialog stays until the page is known to have opened, so nothing they wrote is lost, and the picture goes
          // to the clipboard only then.
          opening = true;
          refused.hidden = true;
          sync();
          Promise.resolve(Git.host.openExternal(url)).then((ok) => ok !== false, () => false).then((ok) => {
            opening = false;
            if (dlg.closed) return;
            sync();
            if (!ok) { refused.hidden = false; return; }
            if (withPicture) {
              sent = true;
              Promise.resolve(H.picture.copy()).then((done) => done === true, () => false).then((done) => {
                Git.notify(done ? { kind: 'info', title: several ? t('The screenshots are on your clipboard as one image') : t('The screenshot is on your clipboard'), text: shortened + t('Paste it into the page that opened ({0}), then submit it there.', PASTE_KEY) }
                  : { kind: 'error', title: t('The screenshot did not reach the clipboard'), text: shortened + t('Drop the picture onto the page that opened instead.') });
                // the worker's copy of the picture has done its work
                setTimeout(() => { try { Promise.resolve(H.picture.clear()).catch(() => {}); } catch (e) { /* the host is gone */ } }, 120000);
              });
            } else {
              Git.notify({ kind: 'info', title: t('The report opened in your browser'),
                text: (shortened || t('Submit it there to send it.') + ' ').trim() + (shot ? ' ' + t('To add a screenshot, drop it onto the page or paste it there.') : '') });
            }
            dlg.close();
          });
          return false;      // open until the host said whether the page opened
        } }] : []) });
    if (P) {
      // a picture dropped anywhere on the dialog is taken, and so is one pasted while it is open
      const box = dlg.el;
      const files = (e) => !!(e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0);
      box.addEventListener('dragover', (e) => { if (files(e)) { e.preventDefault(); P.over(true); } });
      box.addEventListener('dragleave', (e) => { if (!box.contains(e.relatedTarget)) P.over(false); });
      box.addEventListener('drop', (e) => { if (files(e) || (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length)) { e.preventDefault(); P.drop(e); } });
      box.addEventListener('paste', (e) => { if (P.paste(e)) e.preventDefault(); });
    }
    const clean = (list, n) => (Array.isArray(list) ? list : []).filter((x) => typeof x === 'string' && x).map((x) => x.slice(0, 400)).slice(0, n);
    const ready = (answer) => {
      if (dlg.closed) return;
      const given = Array.isArray(answer) ? { environment: [], lines: answer } : answer || {};
      const detail = given.detail && typeof given.detail === 'object' ? given.detail : {};
      facts = { environment: clean(given.environment, 10).concat(pageEnvironment()), lines: clean(given.lines, 40).concat(pageLines()),
        head: clean(detail.head, 400).concat(pageDetail()), tail: clean(detail.tail, 800) };
      data.textContent = facts.environment.join('\n') + '\n\n' + facts.lines.join('\n') + '\n\n' + fullLog().join('\n');
      Object.keys(dlg.buttons).forEach((id) => { dlg.buttons[id].disabled = false; });
      sync();
    };
    // the host's facts; when it cannot give them the page's own still make a report
    let asked;
    try { asked = Promise.resolve(H.diagnostics()); } catch (e) { asked = Promise.resolve([]); }
    asked.then(ready, () => ready(['host: no answer']));
    return dlg;
  };

  /** Rows for the end of a menu: a separator and "Report a Problem…"; nothing without a host that takes reports. A
      single view (a host's panel, a centre tab) has them in its own menus; the workbench only in its Settings menu
      (`o.settings`), so [] for any other menu there, as Git.languageMenu does. */
  R.menu = (o) => (R.available() && ((o && o.settings) || !Git.workbench || Git.workbench.mode !== 'workbench')
    ? ['-', { label: t('Report a Problem…'), action: () => R.open() }] : []);
  /** A link for a page that says something went wrong (the picker's question and error pages). */
  R.link = () => (R.available() ? h('button.g-link.g-report-link', { type: 'button', id: 'g-report-link', onclick: () => R.open() }, t('Report a problem…')) : null);
})();
