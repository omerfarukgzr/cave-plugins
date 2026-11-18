// Shared helpers of the cave-plugins right-column panels (sdk/panel/panel.js, copied into every plugin's ui/ by
// sdk/sync.sh). No framework, no network beyond this page's own server. Every text goes in as a text node
// (never innerHTML), so names that come from processes or files cannot inject markup.
"use strict";

const Panel = (() => {
  const meta = document.querySelector('meta[name="panel-token"]');
  const token = meta ? meta.content : "";
  const query = new URLSearchParams(location.search);

  async function api(path, body) {
    const opts = { method: body ? "POST" : "GET", cache: "no-store", headers: { "X-Panel-Token": token } };
    if (body) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(path, opts);
    } catch (e) {
      throw new Error("Eklentinin sunucusuna ulaşılamadı.");
    }
    let data = {};
    try { data = await res.json(); } catch (e) { /* not JSON */ }
    if (!res.ok) throw new Error(data.hata || "İstek başarısız oldu.");
    return data;
  }

  // h("div", {class: "row", onclick: fn, title: "…"}, child, "text", [more])
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") el.className = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (k === "disabled") el.disabled = true;
      else el.setAttribute(k, v === true ? "" : String(v));
    }
    add(el, children);
    return el;
  }
  function add(el, children) {
    for (const c of children) {
      if (c === null || c === undefined || c === false) continue;
      if (Array.isArray(c)) add(el, c);
      else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
    }
  }

  const PATHS = {
    play: "M4 2.5v11l9-5.5z",
    stop: "M3.5 3.5h9v9h-9z",
    restart: "M13 8a5 5 0 1 1-1.6-3.7M13 2.5v3h-3",
    open: "M6 3H3v10h10v-3M9 2.5h4.5V7M13.5 2.5 7.5 8.5",
    log: "M3 3.5h10M3 6.5h10M3 9.5h7M3 12.5h5",
    back: "M10 3 5 8l5 5",
    info: "M8 7v4.5M8 4.6v.1M8 14.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13z",
    rack: "M2.5 2.5h11v4h-11zM2.5 9.5h11v4h-11zM5 4.5h.1M5 11.5h.1",
    gauge: "M2.5 11a5.5 5.5 0 1 1 11 0M8 11l2.5-3.5",
    up: "M8 13V3M4 7l4-4 4 4",
    x: "M4 4l8 8M12 4l-8 8",
  };
  function icon(name) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("fill", name === "play" || name === "stop" ? "currentColor" : "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", name === "play" || name === "stop" ? "0" : "1.5");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("d", PATHS[name] || "");
    svg.appendChild(p);
    return svg;
  }

  function iconButton(name, title, onclick, disabled) {
    return h("button", { class: "ib", title, "aria-label": title, onclick, disabled }, icon(name));
  }

  function segmented(options, current, onchange) {
    return h("div", { class: "seg", role: "tablist" },
      options.map(([value, label]) => h("button", {
        class: value === current ? "on" : null, role: "tab", "aria-selected": String(value === current),
        onclick: () => { if (value !== current) onchange(value); },
      }, label)));
  }

  function toggle(on, title, onchange, disabled) {
    return h("button", { class: "sw" + (on ? " on" : ""), role: "switch", "aria-checked": String(!!on), title,
      disabled, onclick: () => onchange(!on) });
  }

  function dot(kind) { return h("span", { class: "dot" + (kind ? " " + kind : "") }); }

  // 640 -> "640 MB", 3277 -> "3,2 GB" (Turkish decimal comma)
  function mb(value) {
    if (typeof value !== "number" || !isFinite(value)) return "";
    if (Math.round(value) < 1024) return Math.round(Math.max(0, value)) + " MB";
    return (value / 1024).toFixed(1).replace(".", ",") + " GB";
  }

  function duration(sec) {
    if (typeof sec !== "number" || !isFinite(sec) || sec < 0) return "";
    if (sec < 60) return Math.round(sec) + " sn";
    if (sec < 3600) return Math.floor(sec / 60) + " dk";
    return Math.floor(sec / 3600) + " sa " + Math.floor((sec % 3600) / 60) + " dk";
  }

  function mount(root, ...children) {
    root.replaceChildren();
    add(root, children);
  }

  // Runs fn once now (even in a page loaded hidden), then every `ms` while the page is visible; nothing while hidden.
  function poll(fn, ms) {
    let timer = null;
    let running = false;
    async function tick(first) {
      clearTimeout(timer);
      timer = null;
      if (first !== true && document.visibilityState !== "visible") return;
      if (!running) {
        running = true;
        try { await fn(); } finally { running = false; }
      }
      if (document.visibilityState === "visible") timer = setTimeout(tick, ms);
    }
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") tick();
      else { clearTimeout(timer); timer = null; }
    });
    tick(true);
    return { now: () => tick(true) };
  }

  return { api, h, icon, iconButton, segmented, toggle, dot, mb, duration, mount, poll, query, token };
})();
