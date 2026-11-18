/* Updates of the product itself, with a host that has releases (`Git.host.update`; without it nothing here shows):
     Git.host.update = {
       steps()  → one sentence: how a person updates by hand in this host
       check()  → Promise<info>     what the host's update channel says now
       checkNow() → Promise<info>   optional: reads the channel now ("Check for Updates…" in the Options menu)
       run()    → Promise<{ result }>   'done' | 'approval' | 'current' | anything else: asks the host to update by itself
     }
     info = { state: 'unknown' | 'current' | 'available' | 'required', current, latest, minimum, note }
   Nothing here ever locks the page (the owner, 17 Nov 2026: no lock, not below the minimum either).
   'available': a newer release is out. A dot on the Options button and a row in its menu ("Update to 0.1.12…"); the
   row opens a dialog with the note, the way by hand and Update Now.
   'required': this release is below the oldest one that should still be used (a fix nobody should work without).
   The same dot (in the warning color) and row, and the dialog opens by itself, at most once a day; "Later" closes it
   and the page goes on.
   'unknown' (the channel could not be read) and 'current' show nothing.
     Git.update.apply(info) → state   the host's answer; marks the Options button
     Git.update.refresh()   → Promise<state>   asks the host again (a page that became visible)
     Git.update.remind()    → the dialog, when the state is 'required' and it was not shown today; else null
     Git.update.state()     → the state so far
     Git.update.rows()      → the Options menu's rows: "Check for Updates…" always (with a host), "Update to …" too
                              while a newer release is out
     Git.update.checkNow()  → Promise: reads the channel now; a newer release opens its dialog, else a short answer
     Git.update.open()      → the dialog of a newer release
     Git.update.reload()    → starts the page again after an update (replaceable) */
(function () {
  'use strict';
  const Git = window.Git;
  const h = Git.h, t = (...a) => Git.t(...a);
  Git.addTR({
    'Update to {0}…': '{0} sürümüne güncelle…',
    'Update Available': 'Güncelleme var',
    'Please Update': 'Lütfen güncelle',
    '{0} {1} is out. You have {2}.': '{0} {1} çıktı. Sende {2} var.',
    '{0} {1} has a problem that version {2} fixes. Please update.': '{0} {1} sürümünde, {2} sürümünün düzelttiği bir sorun var. Lütfen güncelle.',
    'Update Now': 'Şimdi güncelle', 'Later': 'Sonra', 'Updating…': 'Güncelleniyor…',
    'Updating… This can take a minute or two.': 'Güncelleniyor… Bir iki dakika sürebilir.',
    'Updated. Reopen this panel if it does not reload by itself.': 'Güncellendi. Panel kendiliğinden yenilenmezse kapatıp yeniden aç.',
    'The update needs your approval because it asks for new access.': 'Güncelleme yeni izin istediği için onayını bekliyor.',
    'The update could not be installed from here.': 'Güncelleme buradan kurulamadı.',
    'No newer version was found yet.': 'Henüz daha yeni bir sürüm bulunamadı.',
    'Still version {0}.': 'Sürüm hâlâ {0}.',
    'Check for Updates…': 'Güncellemeleri denetle…', 'Check for Updates': 'Güncellemeleri denetle', 'Checking…': 'Denetleniyor…',
    'You have the latest version, {0} {1}.': 'En yeni sürüm sende: {0} {1}.',
    'Could not check for updates. Try again later.': 'Güncellemeler denetlenemedi. Biraz sonra yeniden dene.',
    'You already have the latest version.': 'En yeni sürüm zaten sende.',
  });
  const U = (Git.update = {});
  const REMINDED = 'product.update.reminded';      // host pref: "<minimum>@<day>" of the last dialog that opened by itself
  const DAY_MS = 24 * 60 * 60 * 1000;
  let info = { state: 'unknown', current: null, latest: null, minimum: null, note: '' };
  let dialog = null;
  const host = () => (Git.host && Git.host.update && typeof Git.host.update.check === 'function' ? Git.host.update : null);
  const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
  const version = (v) => (typeof v === 'string' && /^\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(v) ? v : null);
  const newer = () => info.state === 'available' || info.state === 'required';

  U.state = () => info.state;
  U.info = () => Object.assign({}, info);

  /** Takes the host's answer. Anything that is not a well-formed answer counts as 'unknown'. */
  U.apply = function (next) {
    const ok = next && typeof next === 'object' && ['current', 'available', 'required'].includes(next.state) && version(next.current) && version(next.latest);
    info = ok
      ? { state: next.state, current: next.current, latest: next.latest, minimum: version(next.minimum) || next.latest, note: text(next.note, 200) }
      : { state: 'unknown', current: null, latest: null, minimum: null, note: '' };
    U.mark(document.getElementById('wb-options'));
    return info.state;
  };
  /** The dot on the Options button: a newer release is out; in the warning color when this one should not be used. */
  U.mark = function (button) {
    if (!button) return;
    button.classList.toggle('has-update', newer());
    button.classList.toggle('update-required', info.state === 'required');
  };

  U.refresh = function () {
    const H = host();
    if (!H) return Promise.resolve(info.state);
    return Promise.resolve().then(() => H.check()).then((next) => U.apply(next), () => info.state);
  };

  U.rows = function () {
    if (!host()) return [];
    const rows = [{ label: t('Check for Updates…'), action: () => { U.checkNow(); } }];
    if (newer()) rows.push({ label: t('Update to {0}…', info.latest), action: () => U.open() });
    return rows;
  };

  /**
   * "Check for Updates…": the host reads its channel now (not the answer kept from its last read). A newer release
   * opens its dialog (Update Now is one press away); otherwise a short dialog says it is the latest, or that the
   * channel could not be read.
   */
  let checking = null;
  U.checkNow = function () {
    const H = host();
    if (!H) return Promise.resolve(null);
    if (checking) return checking;
    const ask = typeof H.checkNow === 'function' ? H.checkNow : H.check;
    const status = h('div.g-update-status', { id: 'g-update-status', role: 'status', 'aria-live': 'polite' }, t('Checking…'));
    const d = Git.dialog({ title: t('Check for Updates'), width: 420, className: 'g-update-check', content: h('div.g-update', status), buttons: [{ label: t('Close') }] });
    // `checked`: how this read went; a read that did not get through keeps the host's last answer, so "latest" would
    // only be what an older read said
    checking = Promise.resolve().then(() => ask()).then((next) => ({ state: U.apply(next), read: !next || next.checked === undefined || next.checked === 'ok' }),
      () => ({ state: 'unknown', read: false })).then(({ state, read }) => {
      checking = null;
      if (state === 'available' || state === 'required') {
        try { d.close(); } catch (e) { /* closed already */ }
        return U.open();
      }
      status.textContent = state === 'current' && read ? t('You have the latest version, {0} {1}.', Git.product(), info.current) : t('Could not check for updates. Try again later.');
      return d;
    });
    return checking;
  };

  /** After an update the page starts again on the new release's files (a frame that refuses stays, and says "reopen"). */
  U.reload = () => { setTimeout(() => { try { location.reload(); } catch (e) { /* the frame may refuse */ } }, 600); };

  U.open = function () {
    const H = host();
    if (!H || !newer()) return null;
    if (dialog && !dialog.closed) return dialog;
    const was = info.current, required = info.state === 'required';
    const status = h('div.g-update-status', { id: 'g-update-status', role: 'status', 'aria-live': 'polite' });
    const steps = typeof H.steps === 'function' ? text(H.steps(), 400) : '';
    const say = (s) => { status.textContent = s; };
    let busy = false;
    /** "Update Now": the host tries; then the channel is read again, and a release that moved starts the page again. */
    async function run(button) {
      if (busy || typeof H.run !== 'function') return;
      busy = true;
      button.disabled = true;
      say(t('Updating… This can take a minute or two.'));
      let result = 'lost';       // no answer: the host may have replaced the product under this page
      try { const r = await H.run(); result = r && typeof r.result === 'string' ? r.result : 'failed'; } catch (e) { result = 'lost'; }
      // the new release answers with its own version once the host has swapped it in
      let moved = false;
      for (let i = 0; i < 4 && !moved; i++) {
        await new Promise((r) => setTimeout(r, i ? 1500 : 300));
        try { const next = await H.check(); if (next && version(next.current) && next.current !== was) moved = true; } catch (e) { /* the host is restarting */ }
      }
      if (moved) { say(t('Updated. Reopen this panel if it does not reload by itself.')); U.reload(); return; }
      busy = false;
      button.disabled = false;
      // 'done' without a new version: the host answered, its catalog offers nothing newer yet (the steps say how to refresh it)
      const why = result === 'approval' ? t('The update needs your approval because it asks for new access.')
        : result === 'current' ? t('You already have the latest version.')
        : result === 'done' ? t('No newer version was found yet.') : t('The update could not be installed from here.');
      say(why + ' ' + t('Still version {0}.', was || '?'));
    }
    dialog = Git.dialog({ title: required ? t('Please Update') : t('Update Available'), width: 460, className: 'g-update-dlg',
      content: h('div.g-update', { dataset: { state: info.state } },
        h('div.g-update-text', { id: 'g-update-text' }, required
          ? t('{0} {1} has a problem that version {2} fixes. Please update.', Git.product(), info.current, info.minimum)
          : t('{0} {1} is out. You have {2}.', Git.product(), info.latest, info.current)),
        info.note ? h('div.g-update-note', { id: 'g-update-note' }, info.note) : null,
        steps ? h('div.g-update-steps', { id: 'g-update-steps' }, steps) : null,
        status),
      buttons: [{ label: t('Later') }].concat(typeof H.run === 'function'
        ? [{ label: t('Update Now'), id: 'g-update-run', primary: true, keepOpen: true, onClick: (d) => { run(d.buttons['g-update-run']); } }] : []) });
    return dialog;
  };

  /**
   * Below the minimum the dialog opens by itself, but not at every start of the page (a host may start it again at
   * every switch of a side bar tab): once a day for a given minimum, remembered with the host's preferences.
   */
  U.remind = function () {
    if (!host() || info.state !== 'required') return null;
    const now = Date.now();
    let last = null;
    try { last = Git.host.prefs.get(REMINDED, null); } catch (e) { last = null; }
    const m = typeof last === 'string' ? /^(\d+\.\d+\.\d+)@(\d+)$/.exec(last) : null;
    if (m && m[1] === info.minimum && now - Number(m[2]) < DAY_MS && now >= Number(m[2])) return null;
    try { Git.host.prefs.set(REMINDED, info.minimum + '@' + now); } catch (e) { /* no storage: it opens again next time */ }
    return U.open();
  };
})();
