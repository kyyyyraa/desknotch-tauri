/*
 * dn-notifs.js — Tab Notifikasi: daftar notifikasi yang masuk (termasuk yang
 * terlewat), klik = fokus app asalnya (Discord / WhatsApp / dsb).
 * Sumber event: Rust `notif:arrived` (watcher toast Windows).
 * Persist: store key "dnNotifList" (max 50 entri terakhir).
 */
(() => {
  if (globalThis.dnNotifs) return;

  const st = { list: [], mounted: null };

  // VARIADIC: invoke(channel, ...args) — versi lama (c, a) MEMBUANG argumen
  // ke-3 -> store:set "key" tanpa value (kalibrasi/saklar/daftar notif tak
  // pernah tersimpan; store berisi null).
  const inv = function (c) {
    try {
      const args = [].slice.call(arguments, 1);
      return window.bridge?.invoke.apply(window.bridge, [c].concat(args)) ?? Promise.resolve(null);
    } catch (_) {
      return Promise.resolve(null);
    }
  };
  const esc2 = (v) =>
    String(v ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  const decodeEnt = (v) =>
    String(v || "")
      .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">");
  // launch Zen/Firefox: segmen = program, profile, <PATH>, windowsTag
  // (dipisah newline yang ditulis via fromCharCode). Ambil PATH profil.
  function parseProfile(launchStr) {
    const NL = String.fromCharCode(10);
    const segs = String(launchStr || "").split(NL).join("|").split("|")
      .map(function (x) { return x.trim(); });
    const i = segs.indexOf("profile");
    return i >= 0 && segs[i + 1] ? segs[i + 1] : "";
  }
  const relTime = (ts) => {
    const m = Math.floor((Date.now() - ts) / 60000);
    if (m < 1) return "baru saja";
    if (m < 60) return m + "m";
    const h = Math.floor(m / 60);
    if (h < 24) return h + "j";
    return Math.floor(h / 24) + "h";
  };

  function persist() {
    inv("store:set", "dnNotifList", st.list.slice(0, 50));
  }

  window.bridge?.on("notif:arrived", (p) => {
    if (!p || (!p.title && !p.body)) return;
    st.list.unshift({
      app: p.app || p.rawApp || "App",
      rawApp: p.rawApp || "",
      title: p.title || "",
      body: p.body || "",
      launch: decodeEnt(p.launch || ""),
      profile: parseProfile(decodeEnt(p.launch || "")),
      site: p.site || "",
      jid: p.jid || "",
      at: Date.now(),
      read: false,
    });
    try {
      window.bridge?.send("dnptt:log", "[nf] app=" + (p.app || "?") + " launch=" + String(p.launch || "").slice(0, 400) + " jid=" + (p.jid || "-"));
    } catch (_) {}
    if (st.list.length > 50) st.list.length = 50;
    persist();
    renderList();
    document.dispatchEvent(new CustomEvent("dnnotif:state"));
  });

  window.bridge?.invoke("store:get", "dnNotifList").then((l) => {
    if (Array.isArray(l)) st.list = l;
    renderList();
  }).catch(() => {});

  function renderList() {
    const c = st.mounted;
    if (!c || !c.isConnected) return;
    const listEl = c.querySelector(".dn-nf-list");
    if (!listEl) return;
    listEl.innerHTML = "";
    if (!st.list.length) {
      const d = document.createElement("div");
      d.style.cssText =
        "font-size:11.5px;color:rgba(255,255,255,0.35);text-align:center;margin-top:60px;padding:0 20px";
      d.textContent = "Belum ada notifikasi yang masuk.";
      listEl.appendChild(d);
      return;
    }
    for (const n of st.list) {
      const row = document.createElement("div");
      row.style.cssText =
        "display:flex;gap:10px;padding:8px 10px;border-radius:12px;cursor:pointer;align-items:flex-start" +
        (n.read ? ";opacity:.5" : "");
      row.innerHTML =
        '<div style="width:26px;height:26px;border-radius:8px;background:rgba(255,255,255,0.08);display:grid;place-items:center;flex-shrink:0;font-size:10px;font-weight:700;color:rgba(255,255,255,0.7)">' +
        esc2(n.app.slice(0, 2).toUpperCase()) +
        '</div><div style="min-width:0;flex:1">' +
        '<div style="display:flex;gap:6px;align-items:baseline">' +
        '<span style="font-size:11px;font-weight:600;color:rgba(255,255,255,0.9);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1">' +
        esc2(n.title || "(tanpa judul)") +
        '</span><span style="font-size:9px;color:rgba(255,255,255,0.35);flex-shrink:0">' +
        relTime(n.at) +
        "</span></div>" +
        (n.body
          ? '<div style="font-size:10.5px;line-height:1.4;color:rgba(255,255,255,0.5);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">' +
            esc2(n.body) +
            "</div>"
          : "") +
        '<div style="font-size:9px;color:rgba(255,255,255,0.35);margin-top:2px">' +
        esc2(String(n.app || "").split("-")[0]) +
        "</div></div>" +
        (n.read
          ? ""
          : '<span class="dn-nf-dot" style="width:6px;height:6px;border-radius:9999px;background:#38bdf8;flex-shrink:0;margin-top:6px"></span>');
      row.onclick = () => {
        // launch notifikasi (mis. WhatsApp Web) berisi URL langsung ke chat —
        // persis perilaku klik notifikasi Windows.
        const url = String(n.launch || "")
          .split(String.fromCharCode(10)).join("|").split("|")
          .map((seg) => seg.trim())
          .find((seg) => seg.startsWith("http"));
        let target = url || "";
        if (!target && n.jid && n.jid.indexOf("@s.whatsapp.net") >= 0) {
          const phone = String(n.jid).split("@")[0].replace(/[^0-9]/g, "");
          if (phone.length >= 8) target = "https://web.whatsapp.com/send?phone=" + phone;
        }
        if (!target && n.site) {
          // Toast browser (Zen dkk): launch = data internal Zen, tanpa URL.
          // Buka SITENYA (web.whatsapp.com / gemini.google.com / ...) di
          // browser sumbernya, bukan browser default.
          target = "https://" + (function () {let h = String(n.site);if (h.indexOf("://") >= 0) h = h.slice(h.indexOf("://") + 3);return h.split("/")[0];})();
        }
        // satu channel: fokus sumber + kalau ada URL buka DI sumbernya
        // (exe Zen/Chrome yang sedang jalan), bukan browser default.
        inv("notif:open", { hint: n.rawApp || n.app, url: target, profile: n.profile || "" });
        n.read = true;
        row.style.opacity = ".5";
        const dot = row.querySelector(".dn-nf-dot");
        if (dot) dot.remove();
        persist();
      };
      listEl.appendChild(row);
    }
  }

  function render(container) {
    if (!container) return;
    st.mounted = container;
    container.innerHTML =
      '<div style="display:flex;flex-direction:column;height:100%;min-height:0">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 14px 4px;flex-shrink:0">' +
      '<span style="font-size:9px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:rgba(255,255,255,0.45)">Notifikasi</span>' +
      '<button class="dn-nf-clear" style="all:unset;cursor:pointer;font-size:9.5px;color:rgba(255,255,255,0.45)">Bersihkan</button>' +
      "</div>" +
      '<div class="dn-nf-list" style="flex:1;min-height:0;overflow-y:auto;padding:4px 10px 10px;display:flex;flex-direction:column;gap:4px;scrollbar-width:thin"></div>' +
      "</div>";
    container.querySelector(".dn-nf-clear").onclick = () => {
      st.list = [];
      persist();
      renderList();
    };
    renderList();
  }

  function unmount() {
    st.mounted = null;
  }

  globalThis.dnNotifs = { render, unmount, _st: st };
})();
