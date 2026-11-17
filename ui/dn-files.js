/*
 * dn-files.js — Tab Files ala Isle: strip HORIZONTAL (scroll ke kanan),
 * kartu: teks (teks), gambar (thumbnail), dokumen (logo PDF dll).
 * Hover kartu -> tombol pin (pindah ke paling kiri) + tombol hapus.
 */
(() => {
  if (globalThis.dnFiles) return;

  const st = {
    mounted: null,
    filter: "clip", // clip | shelf
    q: "",
    type: null,
    searchOpen: false,
    shelf: [],
    found: [],
    clips: [],
    pins: [], // {key}
  };

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
  const log = (line) => {
    try {
      window.bridge?.send("dnptt:log", "[dnfiles] " + line);
    } catch (_) {}
  };

  (function style() {
    if (document.getElementById("dn-files-style")) return;
    const t = document.createElement("style");
    t.id = "dn-files-style";
    t.textContent = [
      ".dn-fl-pill{all:unset;cursor:pointer;font-size:10px;font-weight:600;padding:4px 11px;border-radius:9999px;color:rgba(255,255,255,0.55);transition:background .15s,color .15s}",
      ".dn-fl-pill.on{background:rgba(255,255,255,0.14);color:#fff}",
      ".dn-fl-pill:hover{color:#fff}",
      ".dn-fl-type{all:unset;cursor:pointer;width:22px;height:22px;border-radius:8px;display:grid;place-items:center;color:rgba(255,255,255,0.5);font-size:10px;font-weight:700;border:1px solid transparent}",
      ".dn-fl-type:hover{background:rgba(255,255,255,0.08);color:#fff}",
      ".dn-fl-type.on{background:rgba(255,255,255,0.16);color:#fff;border-color:rgba(255,255,255,0.25)}",
      ".dn-fl-search{all:unset;flex:1;min-width:0;font-size:10.5px;color:#fff;padding:4px 9px;border-radius:9999px;background:rgba(255,255,255,0.07)}",
      ".dn-fl-search::placeholder{color:rgba(255,255,255,0.3)}",
      ".dn-fl-sbtn{all:unset;cursor:pointer;width:22px;height:22px;border-radius:9999px;display:grid;place-items:center;color:rgba(255,255,255,0.55);flex-shrink:0}",
      ".dn-fl-sbtn:hover{background:rgba(255,255,255,0.1);color:#fff}",
      ".dn-fl-trash{all:unset;cursor:pointer;width:22px;height:22px;border-radius:9999px;display:grid;place-items:center;color:rgba(255,255,255,0.55);flex-shrink:0}",
      ".dn-fl-trash:hover{background:rgba(255,255,255,0.1);color:#fff}",
      ".dn-fl-strip{display:flex;gap:6px;align-items:stretch;overflow-x:auto;overflow-y:hidden;padding:2px 12px 8px;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,0.14) transparent}",
      ".dn-fl-strip::-webkit-scrollbar{height:5px}",
      ".dn-fl-strip::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.14);border-radius:9999px}",
      ".dn-fl-card{position:relative;flex:0 0 auto;width:108px;height:84px;border-radius:12px;background:rgba(255,255,255,0.07);padding:6px;cursor:pointer;overflow:hidden;transition:background .15s}",
      ".dn-fl-card:hover{background:rgba(255,255,255,0.12)}",
      ".dn-fl-thumb{width:100%;height:100%;border-radius:8px;background:rgba(255,255,255,0.06);background-size:cover;background-position:center;display:grid;place-items:center;font-size:22px;color:rgba(255,255,255,0.55);overflow:hidden}",      ".dn-fl-thumb.full{position:absolute;inset:0;border-radius:0}",      ".dn-fl-time{position:absolute;top:5px;left:6px;font-size:8.5px;font-weight:600;color:rgba(255,255,255,0.75);text-shadow:0 1px 2px rgba(0,0,0,0.5);z-index:2}",      ".dn-fl-dim{position:absolute;bottom:5px;left:6px;font-size:8px;font-weight:600;color:#fff;background:rgba(0,0,0,0.45);padding:1px 5px;border-radius:9999px;z-index:2}",
      ".dn-fl-title{font-size:10px;font-weight:700;color:rgba(255,255,255,0.94);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dn-fl-sub{font-size:9px;color:rgba(255,255,255,0.45);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:1px}",
      ".dn-fl-act{position:absolute;top:3px;right:3px;display:flex;gap:2px;opacity:0;transition:opacity .15s}",
      ".dn-fl-card:hover .dn-fl-act{opacity:1}",
      ".dn-fl-pin{width:15px;height:15px;border-radius:9999px;display:grid;place-items:center;background:rgba(0,0,0,0.55);color:#fff;font-size:9px;cursor:pointer}",
      ".dn-fl-pin:hover{background:rgba(56,189,248,0.85)}",
      ".dn-fl-pin.on{background:#38bdf8}",
      ".dn-fl-x{width:15px;height:15px;border-radius:9999px;display:grid;place-items:center;background:rgba(0,0,0,0.55);color:#fff;font-size:9px;cursor:pointer}",
      ".dn-fl-x:hover{background:rgba(220,38,38,0.85)}",
      ".dn-fl-badge{position:absolute;top:3px;left:3px;padding:1px 5px;border-radius:9999px;background:rgba(0,0,0,0.55);font-size:8px;color:rgba(255,255,255,0.75)}",
    ].join(String.fromCharCode(10));
    document.head.appendChild(t);
  })();

  const SEARCH_SVG =
    '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>';
  const TRASH_SVG =
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
  const PIN_SVG =
    '<svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor"><path d="M14 2 22 10l-3 3-2-2-4 4v3l-2 2-6-6 2-2h3l4-4-2-2 3-3Z"/></svg>';
  const TYPES = [
    { k: "text", ic: "T" },
    { k: "link", ic: "&#128279;" },
    { k: "image", ic: "&#128444;" },
    { k: "file", ic: "&#128196;" },
  ];

  const IMAGE_EXT = ["png", "jpg", "jpeg", "gif", "webp", "bmp"];
  const DOC_EXT = ["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "zip", "rar", "7z"];
  const TEXT_EXT = ["txt", "md", "log", "json", "csv", "srt", "ini", "yml", "yaml"];

  function extOf(name) {
    const n = String(name || "").toLowerCase();
    const dot = n.lastIndexOf(".");
    return dot >= 0 ? n.slice(dot + 1) : "";
  }
  // Logo sesuai tipe file (PDF / dokumen / gambar / teks / folder)
  const TYPE_ICON = {
    pdf: '<svg width="26" height="26" viewBox="0 0 24 24" fill="none"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" fill="#e5484d"/><path d="M14 2v6h6" fill="#fff" opacity=".55"/><text x="12" y="19" font-size="7" font-family="sans-serif" font-weight="700" fill="#fff" text-anchor="middle">PDF</text></svg>',
    doc: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" fill="#3b82f6"/><path d="M14 2v6h6" fill="#fff" opacity=".55"/></svg>',
    sheet: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" fill="#22c55e"/><path d="M14 2v6h6" fill="#fff" opacity=".55"/></svg>',
    text: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" fill="#94a3b8"/><path d="M14 2v6h6" fill="#fff" opacity=".55"/><path d="M8 13h8M8 17h5" stroke="#0b0b0d" stroke-width="1.4" stroke-linecap="round"/></svg>',
    image: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none"><rect x="3" y="4" width="18" height="16" rx="2" fill="#a855f7"/><circle cx="9" cy="10" r="1.6" fill="#fff"/><path d="m5 18 5-5 4 4 2-2 3 3" stroke="#fff" stroke-width="1.4" fill="none"/></svg>',
    folder: '<svg width="26" height="26" viewBox="0 0 24 24" fill="none"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" fill="#fbbf24"/></svg>',
    zip: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" fill="#f59e0b"/><path d="M14 2v6h6" fill="#fff" opacity=".55"/></svg>',
  };
  function typeIcon(item) {
    if (item.isDir) return TYPE_ICON.folder;
    const e = extOf(item.name);
    if (e === "pdf") return TYPE_ICON.pdf;
    if (["doc", "docx", "odt"].indexOf(e) >= 0) return TYPE_ICON.doc;
    if (["xls", "xlsx", "csv", "ods"].indexOf(e) >= 0) return TYPE_ICON.sheet;
    if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"].indexOf(e) >= 0) return TYPE_ICON.image;
    if (["zip", "rar", "7z"].indexOf(e) >= 0) return TYPE_ICON.zip;
    if (TEXT_EXT.indexOf(e) >= 0) return TYPE_ICON.text;
    return TYPE_ICON.doc;
  }

  function fileType(item) {
    const e = extOf(item.name);
    if (IMAGE_EXT.indexOf(e) >= 0) return "image";
    if (TEXT_EXT.indexOf(e) >= 0) return "text";
    if (DOC_EXT.indexOf(e) >= 0) return "file";
    return "file";
  }
  function clipType(item) {
    if (item.kind === "image" || item.image) return "image";
    const t = String(item.text || "");
    return t.indexOf("http") === 0 ? "link" : "text";
  }
  function typeMatch(item, kind) {
    if (!st.type) return true;
    return kind === "clip" ? clipType(item) === st.type : fileType(item) === st.type;
  }
  function matches(item, kind) {
    if (!typeMatch(item, kind)) return false;
    if (!st.q) return true;
    const hay =
      kind === "clip"
        ? String(item.text || "") + " " + (item.image ? "gambar" : "")
        : String(item.name || "") + " " + String(item.path || "");
    return hay.toLowerCase().indexOf(st.q) >= 0;
  }
  function relTime(ts) {
    const m = Math.floor((Date.now() - ts) / 60000);
    if (m < 1) return "baru saja";
    if (m < 60) return m + "m";
    const h = Math.floor(m / 60);
    if (h < 24) return h + "j";
    return Math.floor(h / 24) + "h";
  }

  async function load() {
    try {
      await loadInner();
    } catch (e) {
      log("load err: " + ((e && e.message) || e));
    }
  }
  async function loadInner() {
    const shelfPaths = await inv("store:get", "shelf");
    const paths = Array.isArray(shelfPaths) ? shelfPaths : [];
    st.shelf = (await inv("files:describe", paths)) || [];
    const found = await inv("store:get", "dnSearchResults");
    st.found = Array.isArray(found) ? found : [];
    const pins = await inv("store:get", "lrcPins");
    st.pins = Array.isArray(pins) ? pins : [];
    renderList();
  }

  const keyOf = (kind, it) => (kind === "clip" ? "c:" + String(it.text || it.image || "") : "f:" + String(it.path || it.name || ""));
  function isPinned(kind, it) {
    return st.pins.indexOf(keyOf(kind, it)) >= 0;
  }
  function togglePin(kind, it) {
    const k = keyOf(kind, it);
    const i = st.pins.indexOf(k);
    if (i >= 0) st.pins.splice(i, 1);
    else st.pins.unshift(k);
    inv("store:set", "lrcPins", st.pins);
    renderList();
  }

  function cardShell(inner, badge) {
    const card = document.createElement("div");
    card.className = "dn-fl-card";
    card.innerHTML =
      (badge ? '<span class="dn-fl-badge">' + badge + "</span>" : "") +
      inner +
      '<div class="dn-fl-act">' +
      '<button class="dn-fl-pin" title="Sematkan (ke paling kiri)">' + PIN_SVG + "</button>" +
      '<button class="dn-fl-x" title="Hapus">&times;</button>' +
      "</div>";
    return card;
  }

  function clipCard(item, kind, idx) {
    const isImg = !!item.image;
    const isLink = clipType(item) === "link";
    const raw = String(item.text || "");
    const time = relTime(item.at);
    const card = cardShell(
      isImg
        ? '<div class="dn-fl-thumb full" style="background-image:url(&quot;' + item.image + '&quot;)"></div>' +
          '<div class="dn-fl-time">' + esc2(time) + "</div>"
        : '<div class="dn-fl-time">' + esc2(time) + "</div>" +
          '<div style="position:absolute;left:6px;right:6px;bottom:6px">' +
          '<div class="dn-fl-title">' + esc2(raw.slice(0, 60).replace(/\s+/g, " ")) + "</div>" +
          '<div class="dn-fl-sub">' + esc2(raw.slice(0, 120).replace(/\s+/g, " ")) + "</div></div>",
      ""
    );
    card.title = "Klik untuk salin ke clipboard";
    card.onclick = () => {
      if (isImg) {
        // salin balik gambar ke clipboard Windows (CF_DIB)
        inv("clipboard:copy-image", { data_url: item.image }).then((ok) => {
          log("copy gambar: " + (ok ? "ok" : "gagal"));
        });
        return;
      }
      inv("clipboard:copy", { text: raw });
      log("copy ulang: " + raw.slice(0, 40));
    };
    const pin = card.querySelector(".dn-fl-pin");
    if (isPinned(kind, item)) pin.classList.add("on");
    pin.onclick = (e) => {
      e.stopPropagation();
      togglePin(kind, item);
    };
    card.querySelector(".dn-fl-x").onclick = (e) => {
      e.stopPropagation();
      st.clips.splice(idx, 1);
      inv("store:set", "clipboardHistory", st.clips);
      renderList();
    };
    return card;
  }

  function fileCard(item, kind, idx) {
    const t = fileType(item);
    const time = relTime(item.at || Date.now());
    const isImg = !!item.thumb || t === "image";
    const card = cardShell(
      isImg
        ? '<div class="dn-fl-thumb full" style="background-image:url(&quot;' + (item.thumb || "") + '&quot;)"></div>' +
          '<div class="dn-fl-time">' + esc2(time) + "</div>"
        : '<div class="dn-fl-thumb" style="position:absolute;inset:6px 6px 26px;height:auto">' +
          typeIcon(item) + "</div>" +
          '<div class="dn-fl-time">' + esc2(time) + "</div>" +
          '<div style="position:absolute;left:6px;right:6px;bottom:6px">' +
          '<div class="dn-fl-title">' + esc2(item.name || "") + "</div>" +
          '<div class="dn-fl-sub">' + esc2(extOf(item.name).toUpperCase()) + "</div></div>",
      ""
    );
    card.title = item.path || "";
    card.onclick = () => inv("files:open", item.path);
    const pin = card.querySelector(".dn-fl-pin");
    if (isPinned(kind, item)) pin.classList.add("on");
    pin.onclick = (e) => {
      e.stopPropagation();
      togglePin(kind, item);
    };
    card.querySelector(".dn-fl-x").onclick = (e) => {
      e.stopPropagation();
      st.shelf = st.shelf.filter((x) => x.path !== item.path);
      inv("store:set", "shelf", st.shelf.map((x) => x.path));
      st.found = st.found.filter((x) => x.path !== item.path);
      inv("store:set", "dnSearchResults", st.found);
      renderList();
    };
    return card;
  }

  function renderList() {
    const c = st.mounted;
    if (!c || !c.isConnected) return;
    const strip = c.querySelector(".dn-fl-strip");
    if (!strip) return;
    strip.innerHTML = "";
    const kind = st.filter;
    const src = kind === "clip" ? st.clips : st.shelf.concat(st.found);
    let items = src.filter((it) => matches(it, kind));
    // yang disematkan selalu di paling kiri
    items = items.slice().sort((a, b) => {
      const pa = isPinned(kind, a) ? 0 : 1;
      const pb = isPinned(kind, b) ? 0 : 1;
      if (pa !== pb) return pa - pb;
      return 0;
    });
    if (!items.length) {
      const d = document.createElement("div");
      d.style.cssText =
        "font-size:11px;color:rgba(255,255,255,0.32);text-align:center;margin-top:24px;padding:0 20px;width:100%";
      d.textContent =
        st.q || st.type
          ? "Tidak ada yang cocok dengan filter ini."
          : kind === "clip"
            ? "Riwayat clipboard kosong. Salin teks atau gambar, otomatis tercatat."
            : "Belum ada file. Drag file ke notch atau minta asisten: carikan file X.";
      strip.appendChild(d);
      return;
    }
    items.forEach((it, i) => {
      strip.appendChild(kind === "clip" ? clipCard(it, kind, i) : fileCard(it, kind, i));
    });
  }

  function paint(container) {
    if (!container) return;
    st.mounted = container;
    const typeBtns = TYPES.map(
      (t) =>
        '<button class="dn-fl-type' + (st.type === t.k ? " on" : "") + '" data-t="' + t.k + '" title="Filter: ' + t.k + '">' +
        t.ic +
        "</button>"
    ).join("");
    const searchArea = st.searchOpen
      ? '<input class="dn-fl-search" placeholder="Cari nama..." value="' + esc2(st.q) + '">'
      : '<button class="dn-fl-sbtn dn-fl-search-toggle" title="Cari">' + SEARCH_SVG + "</button>";
    container.innerHTML =
      '<div style="display:flex;flex-direction:column;height:100%;min-height:0">' +
      '<div style="display:flex;align-items:center;gap:5px;padding:5px 12px 4px;flex-shrink:0">' +
      '<button class="dn-fl-pill dn-p-clip' + (st.filter === "clip" ? " on" : "") + '" data-f="clip">Clipboard</button>' +
      '<button class="dn-fl-pill dn-p-shelf' + (st.filter === "shelf" ? " on" : "") + '" data-f="shelf">Files</button>' +
      '<div style="display:flex;gap:2px;align-items:center;margin-left:2px">' + typeBtns + "</div>" +
      '<div style="flex:1"></div>' +
      searchArea +
      '<button class="dn-fl-trash" title="Bersihkan daftar ini">' + TRASH_SVG + "</button>" +
      "</div>" +
      '<div class="dn-fl-strip"></div>' +
      "</div>";
    container.querySelector(".dn-p-clip").onclick = () => {
      st.filter = "clip";
      paint(container);
    };
    container.querySelector(".dn-p-shelf").onclick = () => {
      st.filter = "shelf";
      paint(container);
    };
    container.querySelectorAll(".dn-fl-type").forEach((el) => {
      el.onclick = () => {
        st.type = st.type === el.dataset.t ? null : el.dataset.t;
        paint(container);
      };
    });
    const tog = container.querySelector(".dn-fl-search-toggle");
    if (tog)
      tog.onclick = () => {
        st.searchOpen = true;
        paint(container);
        const inp = container.querySelector(".dn-fl-search");
        if (inp) inp.focus();
      };
    const sEl = container.querySelector(".dn-fl-search");
    if (sEl) {
      sEl.value = st.q;
      sEl.oninput = () => {
        st.q = sEl.value.trim().toLowerCase();
        renderList();
      };
      sEl.onkeydown = (e) => {
        if (e.key === "Escape" && !sEl.value) {
          st.searchOpen = false;
          paint(container);
        }
      };
    }
    container.querySelector(".dn-fl-trash").onclick = () => {
      if (st.filter === "clip") {
        st.clips = [];
        inv("store:set", "clipboardHistory", []);
      } else {
        st.shelf = [];
        st.found = [];
        inv("store:set", "shelf", []);
        inv("store:set", "dnSearchResults", []);
      }
      renderList();
    };
    renderList();
  }

  function render(container) {
    try {
      paint(container);
    } catch (e) {
      log("err: " + ((e && e.message) || e));
    }
  }
  function unmount() {
    st.mounted = null;
  }
  function renderAt(container) {
    render(container);
    load();
  }

  window.addEventListener("shelf:add", (e) => {
    const paths = (e && e.detail) || [];
    if (!paths.length) return;
    inv("files:describe", paths).then((desc) => {
      const add = (desc || []).filter((d) => d && !st.shelf.some((s2) => s2.path === d.path));
      if (!add.length) return;
      st.shelf = add.concat(st.shelf);
      inv("store:set", "shelf", st.shelf.map((s2) => s2.path));
      st.filter = "shelf";
      if (st.mounted) render(st.mounted);
    });
  });

  window.bridge?.on("shelf:dropped", (p) => {
    const paths = (p && p.paths) || [];
    if (!paths.length) return;
    inv("files:describe", paths).then((desc) => {
      const add = (desc || []).filter((d) => d && !st.shelf.some((s2) => s2.path === d.path));
      if (!add.length) return;
      st.shelf = add.concat(st.shelf);
      inv("store:set", "shelf", st.shelf.map((s2) => s2.path));
      st.filter = "shelf";
      st.type = null;
      st.q = "";
      st.searchOpen = false;
      if (st.mounted) render(st.mounted);
      log("drop: " + add.length + " file masuk shelf");
    });
  });

  // Rust mengirim files:drag-leave saat drag OS keluar dari notch tanpa
  // drop. State "tab Files terbuka" sendiri ada di React chunk (listener
  // files:drag-nya mengabaikan payload), jadi dari sini state itu tidak
  // bisa direset: kita re-broadcast sebagai DOM CustomEvent supaya script
  // lain bisa mengosongkan hover/dropzone miliknya.
  window.bridge?.on("files:drag-leave", () => {
    try {
      window.dispatchEvent(new CustomEvent("files:drag-leave"));
    } catch (_) {}
    log("drag leave: batal hover drag");
  });

  window.bridge?.on("clipboard:new", (p) => {
    if (!p) return;
    const text = String(p.text || "");
    const image = String(p.image || "");
    if (!text && !image) return;
    // dedupe: teks yang sama tidak boleh muncul dua kali di riwayat
    const dup = st.clips.some((c) => c.text === text && (c.image || "") === image);
    if (dup) return;
    st.clips.unshift({
      text: text,
      image: image,
      kind: image && !text ? "image" : "text",
      at: p.at || Date.now(),
      read: false,
    });
    if (st.clips.length > 30) st.clips.length = 30;
    inv("store:set", "clipboardHistory", st.clips);
    renderList();
  });

  inv("store:get", "clipboardHistory").then((l) => {
    if (Array.isArray(l)) st.clips = l;
    renderList();
  }).catch(() => {});

  window.bridge?.on("store:changed", (k) => {
    if (k === "dnSearchResults" || k === "shelf") load();
  });

  globalThis.dnFiles = { render: renderAt, unmount, _st: st };
})();
