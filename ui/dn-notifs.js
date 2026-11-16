/*
 * dn-notifs.js — Tab Notifikasi: daftar notifikasi yang masuk (termasuk yang
 * terlewat), klik = menuju tujuan (URL launch / site), hover = Reply +
 * Mark as read + hapus. Header: saklar DND (bell, merah saat aktif) + Bersihkan.
 * Sumber event: Rust `notif:arrived` (watcher toast Windows).
 * Persist: store key "dnNotifList" (max 50 entri terakhir).
 */
(() => {
  if (globalThis.dnNotifs) return;

  const st = { list: [], mounted: null, dnd: false, settings: null };

  // VARIADIC: invoke(channel, ...args) — versi lama (c, a) MEMBUANG argumen
  // ke-3 -> store:set "key" tanpa value (data tak pernah tersimpan).
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
  const log = (line) => {
    try {
      window.bridge?.send("dnptt:log", "[nf] " + line);
    } catch (_) {}
  };

  // style sekali (scrollbar tipis gaya conversation + reveal hover)
  (function style() {
    if (document.getElementById("dn-nf-style")) return;
    const t = document.createElement("style");
    t.id = "dn-nf-style";
    t.textContent = [
      ".dn-nf-list{scrollbar-width:thin;scrollbar-color:rgba(255,255,255,0.14) transparent}",
      ".dn-nf-list::-webkit-scrollbar{width:5px}",
      ".dn-nf-list::-webkit-scrollbar-track{background:transparent}",
      ".dn-nf-list::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.14);border-radius:9999px}",
      ".dn-nf-row .dn-nf-act{opacity:0;transition:opacity .15s}",
      ".dn-nf-row:hover .dn-nf-act{opacity:1}",
      ".dn-nf-row:hover .dn-nf-time{opacity:0}",
      ".dn-nf-row{transition:background .15s}",
      ".dn-nf-row:hover{background:rgba(255,255,255,0.05)}",
      ".dn-nf-txt{font-size:10.5px;font-weight:600;color:rgba(255,255,255,0.9);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".dn-nf-body{font-size:10px;line-height:1.35;color:rgba(255,255,255,0.45);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".dn-nf-btn{all:unset;cursor:pointer;font-size:9px;font-weight:600;padding:3px 8px;border-radius:9999px;background:rgba(255,255,255,0.1);color:rgba(255,255,255,0.8);white-space:nowrap}",
      ".dn-nf-btn:hover{background:rgba(255,255,255,0.18);color:#fff}",
      ".dn-nf-x{all:unset;cursor:pointer;width:18px;height:18px;border-radius:9999px;display:grid;place-items:center;color:rgba(255,255,255,0.5);font-size:11px;line-height:1}",
      ".dn-nf-x:hover{background:rgba(255,255,255,0.12);color:#fff}",
    ].join("\n");
    document.head.appendChild(t);
  })();

  function persist() {
    inv("store:set", "dnNotifList", st.list.slice(0, 50));
  }

  // ---- DND (jangan ganggu) — bell di header, merah saat aktif ----
  async function loadDnd() {
    const cur = await inv("store:get", "settings");
    if (cur && typeof cur === "object" && !Array.isArray(cur)) {
      st.settings = cur;
      st.dnd = cur.dnd === true;
    }
    paintHeader();
  }
  async function toggleDnd() {
    const base =
      st.settings && typeof st.settings === "object" && !Array.isArray(st.settings)
        ? st.settings
        : (await inv("store:get", "settings")) || {};
    const safe = base && typeof base === "object" && !Array.isArray(base) ? base : {};
    const merged = Object.assign({}, safe, { dnd: !(safe.dnd === true) });
    st.settings = merged;
    st.dnd = merged.dnd;
    inv("store:set", "settings", merged);
    log("dnd -> " + merged.dnd);
    paintHeader();
    document.dispatchEvent(new CustomEvent("dnnotif:state"));
  }
  window.bridge?.on("store:changed", (k, v) => {
    if (k === "settings" && v && typeof v === "object") {
      st.settings = v;
      st.dnd = v.dnd === true;
      paintHeader();
    }
  });

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
    log("app=" + (p.app || "?") + " launch=" + String(p.launch || "").slice(0, 400) + " jid=" + (p.jid || "-"));
    if (st.list.length > 50) st.list.length = 50;
    persist();
    renderList();
    document.dispatchEvent(new CustomEvent("dnnotif:state"));
  });

  window.bridge?.invoke("store:get", "dnNotifList").then((l) => {
    if (Array.isArray(l)) st.list = l;
    renderList();
  }).catch(() => {});
  loadDnd();

  // target tujuan satu notifikasi (urutan: launch URL -> jid chat -> site)
  function targetOf(n) {
    const url = String(n.launch || "")
      .split(String.fromCharCode(10)).join("|").split("|")
      .map((seg) => seg.trim())
      .find((seg) => seg.startsWith("http"));
    if (url) return url;
    if (n.jid && n.jid.indexOf("@s.whatsapp.net") >= 0) {
      const phone = String(n.jid).split("@")[0].replace(/[^0-9]/g, "");
      if (phone.length >= 8) return "https://web.whatsapp.com/send?phone=" + phone;
    }
    if (n.site) {
      let h = String(n.site);
      if (h.indexOf("://") >= 0) h = h.slice(h.indexOf("://") + 3);
      return "https://" + h.split("/")[0];
    }
    return "";
  }
  // Reply = menuju app sumbernya (fokus + URL di browser sumber)
  function replyTo(n) {
    inv("notif:open", { hint: n.rawApp || n.app, url: targetOf(n), profile: n.profile || "" });
    n.read = true;
    persist();
    renderList();
  }
  function markRead(n, rowEl) {
    n.read = true;
    persist();
    if (rowEl) {
      rowEl.style.opacity = ".5";
      const dot = rowEl.querySelector(".dn-nf-dot");
      if (dot) dot.remove();
    }
  }
  function removeAt(idx) {
    st.list.splice(idx, 1);
    persist();
    renderList();
  }

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
      d.textContent = st.dnd
        ? "Mode jangan ganggu aktif — notifikasi tetap tercatat di sini."
        : "Belum ada notifikasi yang masuk.";
      listEl.appendChild(d);
      return;
    }
    st.list.forEach((n, idx) => {
      const row = document.createElement("div");
      row.className = "dn-nf-row";
      row.style.cssText =
        "position:relative;display:flex;gap:8px;padding:6px 8px;border-radius:10px;cursor:pointer;align-items:center" +
        (n.read ? ";opacity:.5" : "");
      row.title = (n.app || "") + " - " + (n.title || "") + (n.body ? " - " + n.body : "");
      row.innerHTML =
        '<div style="width:20px;height:20px;border-radius:6px;background:rgba(255,255,255,0.08);display:grid;place-items:center;flex-shrink:0;font-size:9px;font-weight:700;color:rgba(255,255,255,0.7)">' +
        esc2(n.app.slice(0, 2).toUpperCase()) +
        '</div><div style="min-width:0;flex:1">' +
        '<div style="display:flex;gap:6px;align-items:baseline">' +
        '<span class="dn-nf-txt" style="flex:1">' +
        esc2(n.title || "(tanpa judul)") +
        '</span><span class="dn-nf-time" style="font-size:9px;color:rgba(255,255,255,0.3);flex-shrink:0;transition:opacity .15s">' +
        relTime(n.at) +
        "</span></div>" +
        (n.body ? '<div class="dn-nf-body">' + esc2(n.body) + "</div>" : "") +
        "</div>" +
        '<div class="dn-nf-act" style="position:absolute;right:8px;top:8px;display:flex;gap:4px;align-items:center;flex-shrink:0">' +
        '<button class="dn-nf-btn dn-a-reply" title="Buka di app sumber">Buka</button>' +
        (n.read
          ? ""
          : '<button class="dn-nf-btn dn-a-read" title="Tandai dibaca">Read</button>') +
        '<button class="dn-nf-x dn-a-del" title="Hapus">&times;</button>' +
        "</div>" +
        (n.read
          ? ""
          : '<span class="dn-nf-dot" style="position:absolute;right:10px;bottom:8px;width:6px;height:6px;border-radius:9999px;background:#38bdf8;flex-shrink:0"></span>');
      row.onclick = () => replyTo(n);
      row.querySelector(".dn-a-reply").onclick = (e) => {
        e.stopPropagation();
        replyTo(n);
      };
      const rb = row.querySelector(".dn-a-read");
      if (rb)
        rb.onclick = (e) => {
          e.stopPropagation();
          markRead(n, row);
        };
      row.querySelector(".dn-a-del").onclick = (e) => {
        e.stopPropagation();
        removeAt(idx);
      };
      listEl.appendChild(row);
    });
  }

  function paintHeader() {
    const c = st.mounted;
    if (!c || !c.isConnected) return;
    const bell = c.querySelector(".dn-nf-dnd");
    if (!bell) return;
    bell.style.background = st.dnd ? "#ef4444" : "rgba(255,255,255,0.08)";
    bell.style.color = st.dnd ? "#fff" : "rgba(255,255,255,0.7)";
    bell.title = st.dnd ? "Jangan ganggu: NYALA (klik matikan)" : "Jangan ganggu: mati (klik nyalakan)";
    bell.classList.toggle("dn-dnd-on", st.dnd);
  }

  function render(container) {
    if (!container) return;
    st.mounted = container;
    container.innerHTML =
      '<div style="display:flex;flex-direction:column;height:100%;min-height:0">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 14px 4px;flex-shrink:0">' +
      '<span style="font-size:9px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:rgba(255,255,255,0.45)">Notifikasi</span>' +
      '<div style="display:flex;gap:6px;align-items:center">' +
      '<button class="dn-nf-dnd" title="Jangan ganggu" style="all:unset;cursor:pointer;width:24px;height:24px;border-radius:9999px;background:rgba(255,255,255,0.08);color:rgba(255,255,255,0.7);display:grid;place-items:center">' +
      '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>' +
      "</button>" +
      '<button class="dn-nf-clear dn-nf-btn" style="font-size:9.5px">Bersihkan</button>' +
      "</div></div>" +
      '<div class="dn-nf-list" style="flex:1;min-height:0;overflow-y:auto;padding:4px 10px 10px;display:flex;flex-direction:column;gap:4px"></div>' +
      "</div>";
    container.querySelector(".dn-nf-clear").onclick = () => {
      st.list = [];
      persist();
      renderList();
    };
    container.querySelector(".dn-nf-dnd").onclick = () => toggleDnd();
    paintHeader();
    renderList();
  }

  function unmount() {
    st.mounted = null;
  }

  globalThis.dnNotifs = { render, unmount, toggleDnd, _st: st };
})();
