/* The screenshot area of the Report a Problem dialog (report.js; the owner, 17 Nov 2026: "where does the picture
   go?" must be answered by the dialog itself, and one picture is not enough). A dashed box that takes pictures, up to
   MAX_COUNT: a click opens the system's file picker (several files at once), pictures dropped on the dialog are
   taken, and so is one pasted while the dialog is open. Each is listed above the box with its thumbnail and can be
   taken back on its own.
   A tracker's page takes ONE picture from a paste, so what travels is one PNG: a single picture as it is, several
   joined one under the other (a grey band between them). Every picture is drawn again on a canvas, no larger than
   MAX_SIDE a side (only the pixels go on, nothing else a camera or a tool wrote into the file); the joined PNG stays
   under MAX_BYTES (drawn smaller until it does) and is handed to the host, `picture.set(base64) → Promise<boolean>`,
   which keeps it until the tracker's page opens (`picture.copy()`) or the person takes it back (`picture.clear()`).
     Git.report.picture({ picture, onChange }) → { el, input, state(), count(), take(files), remove(i), drop(e), paste(e), over(on), dispose(keep) }
     state(): 'none' | 'working' | 'ready' | 'failed' */
(function () {
  'use strict';
  const Git = window.Git;
  const h = Git.h, t = (...a) => Git.t(...a);
  Git.addTR({
    'Add screenshots': 'Ekran görüntüsü ekle',
    'Add another screenshot': 'Bir ekran görüntüsü daha ekle',
    'Drop pictures here, click to choose files, or paste one': 'Resimleri buraya sürükleyip bırak, dosya seçmek için tıkla ya da yapıştır',
    'Preparing…': 'Hazırlanıyor…',
    'Ready': 'Hazır',
    'This file is not a picture that can be read': 'Bu dosya okunabilen bir resim değil',
    'The picture could not be handed over': 'Resim aktarılamadı',
    'At most {0} pictures': 'En çok {0} resim',
    '{0} pictures, joined into one image': '{0} resim, tek resimde birleştirildi',
    'Remove {0}': '{0} kaldır', 'Screenshot': 'Ekran görüntüsü', 'Screenshots': 'Ekran görüntüleri',
  });
  const MAX_COUNT = 6;
  const MAX_SIDE = 2200;               // px a side of one picture: a full screen at 1x, a laptop screen at 2x halved
  const MAX_HEIGHT = 12000;            // px of the joined picture
  const MAX_BYTES = 3.5 * 1024 * 1024; // of the PNG that travels; a larger one is drawn smaller
  const GAP = 24;                      // px between two pictures in the joined one
  const BAND = '#808080';              // the band there and beside a narrower picture: plain on light and dark screens
  const TYPES = /^image\/(png|jpeg|webp|gif|bmp)$/;

  const load = (file) => new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode')); };
    img.src = url;
  });
  const blobOf = (canvas) => new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  const sheet = (w, hh) => { const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(hh)); return c; };
  /** The file's pixels on a canvas of at most MAX_SIDE a side, and a small picture of it for the list. */
  async function drawn(file) {
    const img = await load(file);
    const w = img.naturalWidth, hh = img.naturalHeight;
    if (!w || !hh) throw new Error('empty');
    const scale = Math.min(1, MAX_SIDE / Math.max(w, hh));
    const canvas = sheet(w * scale, hh * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    const k = Math.min(1, 216 / canvas.width, 144 / canvas.height);
    const small = sheet(canvas.width * k, canvas.height * k);
    small.getContext('2d').drawImage(canvas, 0, 0, small.width, small.height);
    return { canvas, w: canvas.width, h: canvas.height, thumb: small.toDataURL('image/png') };
  }
  /** One PNG of all `pics`, one under the other. → { blob, width, height } */
  async function join(pics) {
    const W = Math.max(...pics.map((p) => p.w));
    const H = pics.reduce((n, p) => n + p.h, 0) + GAP * (pics.length - 1);
    let scale = Math.min(1, MAX_HEIGHT / H);
    for (let i = 0; i < 8; i++) {
      const canvas = sheet(W * scale, H * scale), ctx = canvas.getContext('2d');
      if (pics.length > 1) { ctx.fillStyle = BAND; ctx.fillRect(0, 0, canvas.width, canvas.height); }
      let y = 0;
      for (const p of pics) {
        const w = Math.max(1, Math.round(p.w * scale)), hh = Math.max(1, Math.round(p.h * scale));
        ctx.drawImage(p.canvas, 0, y, w, hh);
        y += hh + Math.round(GAP * scale);
      }
      const blob = await blobOf(canvas);
      if (!blob) throw new Error('encode');
      if (blob.size <= MAX_BYTES) return { blob, width: canvas.width, height: canvas.height };
      scale *= 0.75;
    }
    throw new Error('too large');
  }
  const base64 = (blob) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(new Error('read'));
    r.readAsDataURL(blob);
  });
  const sizeText = (n) => (n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
  const pictures = (list) => Array.prototype.filter.call(list || [], (f) => f && TYPES.test(f.type || ''));

  Git.report.picture = function (o) {
    const P = o.picture;
    let pics = [];              // { name, canvas, w, h, thumb }
    let state = 'none', note = '', problem = '';
    let turn = 0, reading = 0;
    let sending = Promise.resolve();      // the host takes one picture at a time: the next waits for the one on its way
    const changed = () => { draw(); if (o.onChange) o.onChange(); };
    const input = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', multiple: true, hidden: true, id: 'g-report-file' });
    const list = h('div.g-report-list', { id: 'g-report-list' });
    const zone = h('div.g-report-zone', { id: 'g-report-zone', role: 'button', tabIndex: 0 });
    const status = h('div.g-dim.g-report-pics-status', { id: 'g-report-status', role: 'status', 'aria-live': 'polite' });
    const el = h('div.g-report-pictures', { id: 'g-report-pictures' }, list, zone, status);
    const full = () => pics.length >= MAX_COUNT;
    const choose = () => { if (!full()) input.click(); };
    input.addEventListener('change', () => { const fs = pictures(input.files); input.value = ''; if (fs.length) take(fs); });
    zone.addEventListener('click', choose);
    zone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); choose(); } });

    function draw() {
      el.dataset.state = state;
      el.dataset.count = String(pics.length);
      Git.clear(list);
      pics.forEach((p, i) => list.appendChild(h('div.g-report-item', { dataset: { i: String(i) } },
        h('img.g-report-thumb', { src: p.thumb, alt: '' }),
        h('div.g-report-zone-words', h('div.g-report-zone-title', p.name), h('div.g-report-zone-sub', p.w + '×' + p.h)),
        h('button.g-report-zone-x', { type: 'button', title: t('Remove {0}', p.name), 'aria-label': t('Remove {0}', p.name),
          onclick: (e) => { e.stopPropagation(); remove(i); } }, Git.icon('closeSmall')))));
      Git.clear(zone);
      zone.hidden = full() && !problem;
      zone.classList.toggle('more', pics.length > 0);
      zone.classList.toggle('bad', !!problem);
      zone.setAttribute('aria-label', pics.length ? t('Add another screenshot') : t('Add screenshots'));
      zone.appendChild(h('span.g-report-zone-ic', Git.icon('general/upload')));
      zone.appendChild(h('div.g-report-zone-words',
        h('div.g-report-zone-title', problem || (pics.length ? t('Add another screenshot') : t('Add screenshots'))),
        h('div.g-report-zone-sub', t('Drop pictures here, click to choose files, or paste one'))));
      status.textContent = note;
    }
    /** What travels follows the list: the pictures joined into one PNG and handed to the host, or nothing. */
    async function sync() {
      const mine = ++turn;
      if (!pics.length) {
        state = reading ? 'working' : problem ? 'failed' : 'none';
        note = reading ? t('Preparing…') : '';
        try { Promise.resolve(P.clear()).catch(() => {}); } catch (e) { /* the host is gone */ }
        changed();
        return;
      }
      state = 'working';
      note = t('Preparing…');
      changed();
      let made = null, ok = false;
      try { made = await join(pics); } catch (e) { made = null; }
      if (mine !== turn) return;
      if (made) {
        const data = await base64(made.blob).catch(() => null);
        const sent = sending.then(() => (mine === turn && data ? P.set(data) : false)).then((r) => r === true, () => false);
        sending = sent;
        ok = await sent;
      }
      if (mine !== turn) return;
      state = ok ? 'ready' : 'failed';
      // short: the dialog's own line under the box says how the picture travels
      note = ok ? (pics.length > 1 ? t('{0} pictures, joined into one image', pics.length) + ': ' : '') + made.width + '×' + made.height + ', ' + sizeText(made.blob.size) + ' · ' + t('Ready')
        : t('The picture could not be handed over');
      changed();
    }
    /** Takes picture files (one or a list), as many as there is room for. */
    async function take(files) {
      const all = (files && typeof files.length === 'number' && !(files instanceof Blob) ? Array.prototype.slice.call(files) : [files]).filter(Boolean);
      const room = MAX_COUNT - pics.length - reading;
      const mine = all.slice(0, Math.max(0, room));
      problem = all.length > mine.length ? t('At most {0} pictures', MAX_COUNT) : '';
      if (!mine.length) { changed(); return; }
      reading += mine.length;
      turn++;
      state = 'working';
      note = t('Preparing…');
      changed();
      for (const file of mine) {
        const name = String((file && file.name) || t('Screenshot')).slice(0, 80);
        let d = null;
        try { if (file && TYPES.test(file.type || '')) d = await drawn(file); } catch (e) { d = null; }
        reading--;
        if (disposed) return;
        if (d) pics.push(Object.assign({ name }, d)); else problem = t('This file is not a picture that can be read');
      }
      await sync();
    }
    function remove(i) {
      if (i === undefined) pics = []; else pics.splice(i, 1);
      problem = '';
      sync();
    }
    let disposed = false;
    draw();
    return {
      el, input, take, remove,
      state: () => state,
      count: () => pics.length,
      /** A drag over the dialog (`on`), and what was dropped or pasted there: true when pictures were taken. */
      over(on) { zone.classList.toggle('over', !!on); },
      drop(e) { zone.classList.remove('over'); const fs = pictures(e.dataTransfer && e.dataTransfer.files); if (fs.length) take(fs); return fs.length > 0; },
      paste(e) { const fs = pictures(e.clipboardData && e.clipboardData.files); if (fs.length) take(fs); return fs.length > 0; },
      /** The dialog closed; `keep`: the picture is on its way to the clipboard, the host takes it back later. */
      dispose(keep) {
        disposed = true;
        turn++;
        if (pics.length && !keep) { try { Promise.resolve(P.clear()).catch(() => {}); } catch (e) { /* gone */ } }
        pics = [];
      },
    };
  };
})();
