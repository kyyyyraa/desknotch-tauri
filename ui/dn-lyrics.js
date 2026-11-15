/*
 * dn-lyrics.js — Tab Music + lirik sinkron (LRCLIB via Rust `lrc:get`).
 * Sumber posisi: `smtc:position` (tick 500ms dari Rust) + interpolasi wallclock.
 * Dipakai oleh 2 permukaan:
 *   1. Tab Music (chunk: dnMusicTab -> dnLyrics.render(container, accent))
 *   2. Lirik tengah strip tertutup (chunk: dnLyricMid -> dnLyrics.mountMid(el));
 *      lebar shell mengikuti teks via dnLyrics.shellW(base) / dnLyrics.midActive()
 */
(() => {
  if (globalThis.dnLyrics) return;

  const st = {
    sig: "",
    song: null,
    lines: [],
    plain: "",
    status: "idle", // idle|loading|synced|plain|instrumental|not-found|no-track|error
    hasWordSync: false,
    basePosMs: 0,
    baseWall: 0,
    posMs: 0,
    playing: false,
    durMs: 0,
    curIdx: -1,
    curText: "",
    midW: 0, // lebar teks baris aktif (px), untuk shell strip tertutup
    lastAnchor: -1, // posisi SMTC terakhir yang diterima (ms)
    settings: null,
    offsets: null, // { "artist|track": ms }
    matchKey: "", // key lagu yang sedang punya lirik synced
    lrcOn: null, // kunci standalone lyricsOnClosed (null = belum pernah di-set)
    lastMediaWall: 0, // timestamp event media terakhir (position/now-playing)
    lastPlayingWall: 0, // terakhir kali BENAR-BENAR play (untuk membedakan pause vs media palsu)
  };

  const el = {
    tab: null, // container root dari dnMusicTab
    list: null,
    rows: [],
    bar: null,
    tCur: null,
    tTot: null,
    art: null,
    meta: null,
    title: null,
    artist: null,
    status: null,
    pp: null,
    mid: null, // layer lirik tengah (chunk dnLyricMid)
  };
  let mountedAcc = "";
  let userScrollUntil = 0;

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
  // dnptt:log = channel bridge_send — invoke TIDAK dicatat logfile.
  const log = (line) => {
    try {
      window.bridge?.send("dnptt:log", "[lyr] " + line);
    } catch (_) {}
  };
  const fmt = (ms) => {
    if (!ms || ms < 0 || !isFinite(ms)) return "0:00";
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };

  // ---- style: scrollbar tipis + baris lirik (injeksi sekali ke head) ----
  (function style() {
    if (document.getElementById("dn-lyr-style")) return;
    const css = `
.dn-lyr-scroll{scrollbar-width:thin;scrollbar-color:rgba(255,255,255,0.16) transparent}
.dn-lyr-scroll::-webkit-scrollbar{width:6px}
.dn-lyr-scroll::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.16);border-radius:9999px}
@keyframes dnlyr-eq{0%{transform:scaleY(.4)}50%{transform:scaleY(1)}100%{transform:scaleY(.4)}}
.dn-lyr-row{font-size:11px;line-height:1.45;padding:5px 8px;font-weight:600;color:rgba(255,255,255,0.5);transition:color .15s;user-select:none}
.dn-lyr-row:hover{color:rgba(255,255,255,0.75)}
.dn-lyr-row.is-past{color:rgba(255,255,255,0.30)}
.dn-lyr-row.is-cur{font-size:14.5px;font-weight:800;color:#fff}
.dn-lyr-plain{font-size:11.5px;line-height:1.6;color:rgba(255,255,255,0.6);white-space:pre-wrap;padding:5px 8px}
.dn-lyr-empty{font-size:11.5px;color:rgba(255,255,255,0.35);text-align:center;margin-top:40px}
.dn-art.has-art svg{display:none}`;
    const t = document.createElement("style");
    t.id = "dn-lyr-style";
    t.textContent = css;
    document.head.appendChild(t);
  })();

  const lyricsOnClosed = () => {
    // kunci fungsional STANDALONE ("lyricsOnClosed" bool di store) — bukan di
    // dalam objek settings: menulis settings utuh dari sini memicu re-render
    // besar yang pernah crash. Fallback ke settings lama kalau belum pernah
    // di-toggle lewat kunci baru.
    if (st.lrcOn === true) return true;
    if (st.lrcOn === false) return false;
    return st.settings ? st.settings.lyricsOnClosed !== false : true;
  };

  function indexAt(ms) {
    let lo = 0,
      hi = st.lines.length - 1,
      res = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (st.lines[mid].t <= ms) {
        res = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return res;
  }

  // Trackers sumber posisi SMTC. Chrome/YouTube mem-bekukan SMTC Position
  // saat lagu jalan (hanya update saat pause/play/seek — terbukti via probe),
  // jadi kalau sumber beku: JANGAN re-anchor, biarkan interpolasi wallclock
  // jalan. Sumber yang benar-benar bergerak (Spotify) tetap dipakai normal.
  const LYR_LEAD_MS = 900; // kompensasi dasar (mayoritas LRC telat terhadap vokal)
  // Offset per lagu (ms, bisa minus) - diatur tombol -/+ di tab Music,
  // tersimpan di store "lrcOffsets" ber-key artist|track hasil match LRCLIB.
  function normKey(str) {
    return String(str || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  }
  function effLead() {
    return LYR_LEAD_MS + (st.matchKey && st.offsets ? st.offsets[st.matchKey] || 0 : 0);
  }
  let srcLast = -1;
  let srcMoves = 0;
  let frozenPos = -1;

  function resetSrc() {
    srcLast = -1;
    srcMoves = 0;
    frozenPos = -1;
  }

  function setPos(posMs, playing) {
    st.lastMediaWall = Date.now();
    if (playing) {
      st.lastPlayingWall = Date.now();
      if (srcLast >= 0) {
        if (posMs > srcLast + 150) srcMoves++;
        else if (posMs === srcLast) srcMoves = Math.max(0, srcMoves - 1);
        else srcMoves = 0;
      }
      srcLast = posMs;
      const srcLive = srcMoves >= 2; // sumber men-tick sendiri
      const est = curMs();
      const drift = est - posMs;
      if (srcLive) {
        // sumber hidup: resync biasa + deteksi seek
        if (Math.abs(drift) > 2000) {
          st.basePosMs = posMs;
          st.baseWall = Date.now();
          st.posMs = posMs;
        }
      } else if (drift > 2500 || drift < -2500) {
        // sumber beku: terima posisi baru HANYA kalau nilainya berubah
        // (itu tanda pause/play/seek nyata dari sumber, bukan tick beku)
        if (posMs !== frozenPos) {
          st.basePosMs = posMs;
          st.baseWall = Date.now();
          st.posMs = posMs;
        }
        frozenPos = posMs;
      }
      st.playing = true;
    } else {
      st.playing = false;
      st.basePosMs = posMs;
      st.baseWall = Date.now();
      st.posMs = posMs;
      resetSrc();
    }
    paintProgress();
  }

  function curMs() {
    return st.playing ? st.basePosMs + (Date.now() - st.baseWall) : st.basePosMs;
  }

  // Seek lewat SMTC (crate windows61). Hanya bergerak kalau sumber MENERIMA
  // seek — kalau tidak, posisi tidak boleh dipindah (biar tetap sinkron audio).
  function doSeek(sec) {
    inv("lrc:seek", { pos_sec: sec }).then((ok) => {
      if (ok) {
        st.basePosMs = Math.round(sec * 1000);
        st.baseWall = Date.now();
        st.posMs = st.basePosMs;
        paintProgress();
        document.dispatchEvent(new CustomEvent("dnlyr:state"));
      } else {
        log("seek ditolak sumber");
      }
    });
  }

  // ---- lirik tengah strip tertutup ----
  // Lagu SELESAI (pos di akhir + tidak playing) -> sembunyikan lirik, jam kembali.
  function songEnded() {
    return !st.playing && st.durMs > 0 && st.basePosMs >= st.durMs - 1500;
  }
  // Sesi media hilang total (browser ditutup dsb): tidak ada event > 5s.
  function mediaGone() {
    return st.lastMediaWall > 0 && Date.now() - st.lastMediaWall > 5000;
  }

  function midActive() {
    // TANPA syarat playing: saat pause/buffering sebentar lirik tetap tampil
    // (dulu hilang -> "harus hover dulu"/"lirik berhenti"). TAPI lagu yang
    // sudah selesai atau media yang hilang harus sembunyi lagi.
    return !!(
      st.status === "synced" &&
      st.curIdx >= 0 &&
      st.curText &&
      lyricsOnClosed() &&
      !songEnded() &&
      !mediaGone()
    );
  }

  // Dipanggil DI DALAM render React — wajib sinkron & cepat (tanpa await/dispatch).
  function shellW(base) {
    return midActive() ? Math.max(240, Math.min(1000, st.midW + 190)) : base;
  }

  // React bisa membuat ulang node — validasi ulang tiap paint.
  function midEl() {
    if (el.mid && el.mid.isConnected) return el.mid;
    el.mid = document.getElementById("dn-lyr-mid") || null;
    return el.mid;
  }

  function mountMid(m) {
    el.mid = m || null;
    paintMid();
  }

  function measureMid() {
    const m = midEl();
    if (!m || !st.curText) return;
    // Ukur elemen lirik ASLI: scrollWidth = lebar teks penuh walau truncate.
    // Span tersembunyi kebiasaan mengukur (font-weight beda) -> teks kepotong.
    m.textContent = st.curText;
    st.midW = Math.min(780, Math.round(m.scrollWidth) + 2);
  }

  function paintMid() {
    const m = midEl();
    if (!m) return;
    if (midActive()) {
      if (m.textContent !== st.curText) m.textContent = st.curText;
      measureMid();
      m.style.maxWidth = Math.max(180, shellW(240) - 190) + "px";
      if (m.style.display === "none") m.style.display = "";
    } else if (m.textContent !== "") {
      m.textContent = "";
    }
  }

  // ---- paint: tab music ----
  function paintProgress() {
    if (el.bar) {
      const pct =
        st.durMs > 0 ? Math.min(100, Math.max(0, (curMs() / st.durMs) * 100)) : 0;
      el.bar.style.width = pct.toFixed(2) + "%";
    }
    if (el.tCur) el.tCur.textContent = fmt(curMs());
    if (el.tTot) el.tTot.textContent = fmt(st.durMs);
    if (el.pp) {
      const want = st.playing ? "pause" : "play";
      if (el.pp.dataset.mode !== want) {
        el.pp.dataset.mode = want;
        el.pp.innerHTML =
          want === "play"
            ? '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.14v13.72a1 1 0 0 0 1.5.86l11-6.86a1 1 0 0 0 0-1.72l-11-6.86a1 1 0 0 0-1.5.86Z"/></svg>'
            : '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4.5" height="16" rx="1"/><rect x="13.5" y="4" width="4.5" height="16" rx="1"/></svg>';
      }
    }
  }

  function rowClass(i) {
    if (i === st.curIdx) return "dn-lyr-row is-cur";
    if (i < st.curIdx) return "dn-lyr-row is-past";
    return "dn-lyr-row";
  }

  function paintRows() {
    if (!el.rows.length) return;
    for (let i = 0; i < el.rows.length; i++) {
      const r = el.rows[i];
      const want = rowClass(i);
      if (r.className !== want) r.className = want;
    }
    const cur = el.rows[st.curIdx];
    if (cur && Date.now() > userScrollUntil) {
      cur.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }

  function paintStatus() {
    if (!el.status) return;
    const map = {
      loading: "Mencari lirik\u2026",
      "not-found": "Lirik tidak ditemukan",
      instrumental: "Instrumental",
      plain: "Lirik tanpa sinkron",
      error: "Gagal memuat lirik",
    };
    el.status.textContent = map[st.status] || "";
    if (el.offRow) {
      const show = st.status === "synced";
      el.offRow.style.display = show ? "flex" : "none";
      if (show && el.offVal) {
        const v = st.matchKey && st.offsets ? st.offsets[st.matchKey] || 0 : 0;
        el.offVal.textContent = (v >= 0 ? "+" : "−") + (Math.abs(v) / 1000).toFixed(2) + "s";
      }
    }
  }

  function paint() {
    paintProgress();
    paintRows();
    paintStatus();
    paintMid();
  }

  function renderList() {
    if (!el.list) return;
    el.list.innerHTML = "";
    el.rows = [];
    if (st.status === "synced") {
      for (let i = 0; i < st.lines.length; i++) {
        const d = document.createElement("div");
        d.textContent = st.lines[i].text;
        d.dataset.i = String(i);
        d.title = "Klik: lompat ke baris ini";
        d.style.cursor = "pointer";
        const t = st.lines[i].t;
        d.onclick = () => doSeek(t / 1000);
        el.list.appendChild(d);
        el.rows.push(d);
      }
    } else if (st.status === "plain") {
      const d = document.createElement("div");
      d.className = "dn-lyr-plain";
      d.textContent = st.plain;
      el.list.appendChild(d);
    } else if (st.status === "idle" || st.status === "no-track") {
      const d = document.createElement("div");
      d.className = "dn-lyr-empty";
      d.textContent = "Putar lagu di mana saja \u2014 YouTube, Spotify, atau browser apa pun.";
      el.list.appendChild(d);
    }
    paintRows();
    paintStatus();
  }

  function paintMeta() {
    if (el.art) {
      const url = st.song?.thumbnailUrl;
      if (url) {
        // JANGAN pakai shorthand style.background — itu menghapus
        // background-size/position yang sudah diset inline (art jadi crop
        // pojok = kelihatan warna solid).
        el.art.style.backgroundImage = `url("${url}")`;
        el.art.style.backgroundSize = "cover";
        el.art.style.backgroundPosition = "center";
        el.art.classList.add("has-art");
      } else {
        el.art.style.backgroundImage = "";
        el.art.style.backgroundColor = "rgba(255,255,255,0.06)";
        el.art.classList.remove("has-art");
      }
    }
    if (el.title) el.title.textContent = st.song?.title || "Tidak ada lagu";
    if (el.artist) el.artist.textContent = st.song?.artist || "";
    if (el.meta) el.meta.style.opacity = st.song ? "1" : ".4";
  }

  // ---- render tab (dipanggil dari dnMusicTab di chunk; notch 620x320) ----
  function render(container, accent) {
    if (!container) return;
    el.tab = container;
    mountedAcc = accent || "#38bdf8";
    const a = mountedAcc;
    container.innerHTML = `
<div style="display:flex;height:100%;min-height:0">
  <div style="width:210px;flex-shrink:0;border-right:1px solid rgba(255,255,255,0.07);padding:12px 14px;display:flex;flex-direction:column;gap:9px;min-width:0">
    <div class="dn-art" style="width:76px;height:76px;border-radius:14px;background:rgba(255,255,255,0.06);background-size:cover;background-position:center;display:grid;place-items:center;flex-shrink:0">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.4)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
    </div>
    <div class="dn-meta" style="width:100%;min-width:0">
      <div class="dn-title" style="font-size:13px;font-weight:600;color:rgba(255,255,255,0.92);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">Tidak ada lagu</div>
      <div class="dn-artist" style="font-size:10.5px;color:rgba(255,255,255,0.5);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"></div>
    </div>
    <div style="width:100%">
      <div style="height:3px;border-radius:9999px;background:rgba(255,255,255,0.1);overflow:hidden">
        <div class="dn-bar" style="height:100%;width:0%;border-radius:9999px;background:${a}"></div>
      </div>
      <div style="display:flex;justify-content:space-between;margin-top:4px;font-size:9.5px;color:rgba(255,255,255,0.45);font-variant-numeric:tabular-nums">
        <span class="dn-tcur">0:00</span><span class="dn-ttot">0:00</span>
      </div>
    </div>
    <div style="display:flex;align-items:center;gap:12px">
      <button class="dn-prev" aria-label="Sebelumnya" style="all:unset;cursor:pointer;color:rgba(255,255,255,0.7);display:grid;place-items:center"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M6 5v14M20 5.14v13.72a1 1 0 0 1-1.5.86l-10-6.86a1 1 0 0 1 0-1.72l10-6.86a1 1 0 0 1 1.5.86Z" transform="scale(-1,1) translate(-24,0)"/></svg></button>
      <button class="dn-pp" data-mode="play" aria-label="Putar" style="all:unset;cursor:pointer;display:grid;place-items:center;width:30px;height:30px;border-radius:9999px;background:rgba(255,255,255,0.1);color:#fff"><svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.14v13.72a1 1 0 0 0 1.5.86l11-6.86a1 1 0 0 0 0-1.72l-11-6.86a1 1 0 0 0-1.5.86Z"/></svg></button>
      <button class="dn-next" aria-label="Berikutnya" style="all:unset;cursor:pointer;color:rgba(255,255,255,0.7);display:grid;place-items:center"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M18 5v14M4 5.14v13.72a1 1 0 0 0 1.5.86l10-6.86a1 1 0 0 0 0-1.72l-10-6.86a1 1 0 0 0-1.5.86Z" transform="scale(-1,1) translate(-24,0)"/></svg></button>
      <button class="dn-bw" aria-label="Mundur 10 detik" style="all:unset;cursor:pointer;color:rgba(255,255,255,0.55);display:grid;place-items:center"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9"/><path d="M3 4v5h5"/></svg></button>
      <button class="dn-fw" aria-label="Maju 10 detik" style="all:unset;cursor:pointer;color:rgba(255,255,255,0.55);display:grid;place-items:center"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9"/><path d="M21 4v5h-5"/></svg></button>
      <button class="dn-bubble" aria-label="Kembali" title="Kembali" style="all:unset;cursor:pointer;color:rgba(255,255,255,0.7);display:grid;place-items:center"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z"/><path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1"/></svg></button>
    </div>
    <div class="dn-status" style="font-size:10px;color:rgba(255,255,255,0.35);min-height:14px"></div>
    <div class="dn-offrow" style="display:none;align-items:center;justify-content:center;gap:6px">
      <button class="dn-offm" aria-label="Lirik lebih awal" style="all:unset;cursor:pointer;width:20px;height:20px;border-radius:9999px;background:rgba(255,255,255,0.08);color:rgba(255,255,255,0.7);display:grid;place-items:center;font-size:12px;line-height:1">&minus;</button>
      <span class="dn-offv" style="font-size:9.5px;color:rgba(255,255,255,0.45);font-variant-numeric:tabular-nums;min-width:46px;text-align:center">+0.0s</span>
      <button class="dn-offp" aria-label="Lirik lebih telat" style="all:unset;cursor:pointer;width:20px;height:20px;border-radius:9999px;background:rgba(255,255,255,0.08);color:rgba(255,255,255,0.7);display:grid;place-items:center;font-size:12px;line-height:1">+</button>
    </div>
  </div>
  <div class="dn-lyr-scroll" style="flex:1;min-width:0;overflow-y:auto;padding:10px 14px"></div>
</div>`;
    el.list = container.querySelector(".dn-lyr-scroll");
    el.list.addEventListener("scroll", () => {
      userScrollUntil = Date.now() + 3000;
    });
    el.art = container.querySelector(".dn-art");
    el.meta = container.querySelector(".dn-meta");
    el.title = container.querySelector(".dn-title");
    el.artist = container.querySelector(".dn-artist");
    el.bar = container.querySelector(".dn-bar");
    el.tCur = container.querySelector(".dn-tcur");
    el.tTot = container.querySelector(".dn-ttot");
    el.status = container.querySelector(".dn-status");
    el.pp = container.querySelector(".dn-pp");
    container.querySelector(".dn-prev").onclick = () => inv("media:key", "previous");
    container.querySelector(".dn-next").onclick = () => inv("media:key", "next");
    el.pp.onclick = () => inv("media:key", "play-pause");
    el.offRow = container.querySelector(".dn-offrow");
    el.offVal = container.querySelector(".dn-offv");
    const adjust = (delta) => {
      if (!st.matchKey) return;
      const base = st.offsets && typeof st.offsets === "object" ? st.offsets : {};
      const cur = base[st.matchKey] || 0;
      const next = Math.max(-3000, Math.min(3000, cur + delta));
      st.offsets = { ...base, [st.matchKey]: next };
      inv("store:set", "lrcOffsets", st.offsets);
      // terapkan SEKARANG: baris langsung lompat sesuai offset baru
      st.curIdx = indexAt(curMs() + effLead());
      st.curText = st.curIdx >= 0 ? st.lines[st.curIdx]?.text || "" : "";
      paintRows();
      measureMid();
      paintMid();
      paintStatus();
      document.dispatchEvent(new CustomEvent("dnlyr:state"));
    };
    container.querySelector(".dn-offm").onclick = () => adjust(-500);
    container.querySelector(".dn-offp").onclick = () => adjust(500);
    container.querySelector(".dn-bw").onclick = () => doSeek(Math.max(0, curMs() / 1000 - 10));
    container.querySelector(".dn-fw").onclick = () => doSeek(curMs() / 1000 + 10);
    container.querySelector(".dn-bubble").onclick = () => toggleClosed();
    container.querySelector(".dn-bubble").title = "Lirik di notch (nyala/mati)";

    paintMeta();
    renderList();
    paintProgress();
  }

  function unmount() {
    el.tab = null;
    el.list = null;
    el.rows = [];
    el.bar = el.tCur = el.tTot = el.art = el.meta = el.title = el.artist = null;
    el.status = el.pp = null;
    el.offRow = el.offVal = null;
  }

  // ---- lirik fetch ----
  let fetching = false;
  async function onNowPlaying(v) {
    if (!v || !v.title) {
      reset("no-track");
      return;
    }
    st.song = v;
    st.durMs = Math.round((v.duration || 0) * 1000);
    st.playing = !!v.isPlaying;
    if (st.playing) st.lastPlayingWall = Date.now();
    st.lastMediaWall = Date.now();
    // Anchor posisi dari event. SMTC position beku saat lagu jalan (Chrome):
    // re-anchor HANYA kalau nilai anchor berubah (pause/play/seek/ganti lagu),
    // bukan pada tiap emit ulang (retry art) yang posisinya sama.
    const anchorMs = Math.round((v.position || 0) * 1000);
    if (!st.playing || anchorMs !== st.lastAnchor) {
      st.basePosMs = anchorMs;
      st.baseWall = Date.now();
      st.posMs = anchorMs;
    }
    st.lastAnchor = anchorMs;
    paintMeta();
    paintProgress();

    const sig = `${v.title}|${v.artist || ""}|${Math.round(v.duration || 0)}`;
    if (sig === st.sig && (st.status === "synced" || st.status === "plain" || st.status === "instrumental")) {
      paintMid();
      document.dispatchEvent(new CustomEvent("dnlyr:state"));
      return; // retry art dsb — lirik sudah ada
    }
    st.sig = sig;
    // lagu baru: timeline mulai dari posisi awal lagu SEKARANG (unconditional).
    // Emit ulang berikutnya (retry art) posisinya sama -> tidak meng-anchor
    // mundur lagi (ini penyebab lirik telat berdetik-detik).
    st.basePosMs = anchorMs;
    st.baseWall = Date.now();
    st.posMs = anchorMs;
    st.lastAnchor = anchorMs;
    resetSrc();
    st.status = "loading";
    st.lines = [];
    st.curIdx = -1;
    st.curText = "";
    renderList();
    paint();

    if (fetching) return;
    fetching = true;
    try {
      const res = await inv("lrc:get", {
        title: v.title,
        artist: v.artist || "",
        album: v.album || "",
        duration: v.duration || 0,
      });
      if (!res) {
        log("invoke error");
      } else {
        log(
          "[lyr] title='" + v.title + "' -> " + (res.status || "?") + " lines=" + (res.lines ? res.lines.length : 0)
        );
      }
      apply(res);
    } catch (_) {
      log("[lyr] invoke error");
      apply(null);
    } finally {
      fetching = false;
    }
  }

  function apply(res) {
    // lagu mungkin sudah ganti saat fetch jalan
    if (!res || !res.ok) {
      st.status = res?.status === "no-track" ? "no-track" : "error";
      document.dispatchEvent(new CustomEvent("dnlyr:state"));
      return;
    }
    if (res.status === "synced") {
      st.lines = res.lines || [];
      st.hasWordSync = !!res.hasWordSync;
      st.status = st.lines.length ? "synced" : "not-found";
      st.matchKey = normKey(res.artistName) + "|" + normKey(res.trackName);
    } else {
      st.status = res.status; // plain|instrumental|not-found
      st.plain = res.plain || "";
    }
    st.curIdx = indexAt(curMs() + effLead());
    st.curText = st.curIdx >= 0 ? st.lines[st.curIdx]?.text || "" : "";
    measureMid();
    renderList();
    paint();
    document.dispatchEvent(new CustomEvent("dnlyr:state"));
  }

  function reset(status) {
    st.sig = "";
    st.song = null;
    st.lines = [];
    st.plain = "";
    st.status = status || "idle";
    st.curIdx = -1;
    st.curText = "";
    st.midW = 0;
    st.playing = false;
    st.lastAnchor = -1;
    resetSrc();
    paintMeta();
    renderList();
    paint();
    document.dispatchEvent(new CustomEvent("dnlyr:state"));
  }

  // UI player boleh tampil hanya kalau: playing, ATAU pause yang barusan
  // (<=90s). Sesi SMTC palsu (judul tab browser tanpa audio) tidak lolos.
  function showPlayerState() {
    if (st.playing) return true;
    if (!st.song || !st.song.title) return false;
    return Date.now() - (st.lastPlayingWall || 0) < 90000;
  }

  // Saklar lirik di notch tertutup (dipakai bubble di kartu musik Home).
  function closedOn() {
    return st.settings ? st.settings.lyricsOnClosed !== false : true;
  }

  async function toggleClosed() {
    try {
      const next = !lyricsOnClosed();
      st.lrcOn = next;
      inv("store:set", "lyricsOnClosed", next);
      log("toggle -> " + next);
    } catch (e) {
      log("toggle error: " + ((e && e.message) || e));
    }
    paint();
    document.dispatchEvent(new CustomEvent("dnlyr:state"));
  }

  // ---- wiring ----
  log("[lyr] boot");
  window.bridge?.on("smtc:now-playing", onNowPlaying);
  window.bridge?.on("smtc:position", (p) => {
    if (p && typeof p.pos_ms === "number") setPos(p.pos_ms, !!p.playing);
  });
  window.bridge?.invoke("store:get", "lyricsOnClosed").then((b) => {
    st.lrcOn = b === true || b === false ? b : null;
    paint();
  }).catch(() => {});
  window.bridge?.invoke("store:get", "lrcOffsets").then((o) => {
    st.offsets = o && typeof o === "object" ? o : null;
    paint();
  }).catch(() => {});
  window.bridge?.invoke("store:get", "settings").then((s) => {
    st.settings = s || null;
    paint();
  }).catch(() => {});
  window.bridge?.on("store:changed", (k, v) => {
    if (k === "lyricsOnClosed") {
      st.lrcOn = v === true || v === false ? v : null;
      paint();
      document.dispatchEvent(new CustomEvent("dnlyr:state"));
    }
    if (k === "lrcOffsets") {
      st.offsets = v && typeof v === "object" ? v : null;
      paint();
    }
    if (k === "settings") {
      st.settings = v || null;
      paint(); // paintMid ikut — settings bisa mengaktifkan/mematikan layer tengah
      document.dispatchEvent(new CustomEvent("dnlyr:state"));
    }
  });

  // Driver lebar notch: saat lirik aktif di strip tertutup, tulis lebar shell
  // LANGSUNG (motion hanya menulis saat render — kalau re-render tidak datang,
  // lebar tidak berubah). main.clientHeight<50 = strip tertutup (bukan
  // expanded/tucked). Saat non-aktif, kembalikan kendali ke motion.
  let writtenW = null;
  let wAnim = null; // tween lebar berjalan
  function stopWidthTween() {
    if (wAnim) {
      cancelAnimationFrame(wAnim.raf);
      wAnim = null;
    }
  }
  // Tween lebar shell 300ms ease-out — besar/kecil per baris terasa halus,
  // bukan lompatan. motion hanya menulis lebar saat render React, jadi di
  // mode lirik aktif kita yang pegang lebar.
  function tweenShellWidth(shell, target) {
    const from = parseFloat(shell.style.width) || 240;
    stopWidthTween();
    if (Math.abs(from - target) < 6) {
      shell.style.width = target + "px";
      return;
    }
    const start = performance.now();
    const DUR = 300;
    const step = (now) => {
      const t = Math.min(1, (now - start) / DUR);
      const e = 1 - Math.pow(1 - t, 3);
      shell.style.width = from + (target - from) * e + "px";
      if (t < 1 && wAnim) wAnim.raf = requestAnimationFrame(step);
    };
    wAnim = { raf: requestAnimationFrame(step) };
  }
  function driveShellWidth() {
    const m = document.querySelector("main");
    if (!m) return;
    const shell = m.parentElement;
    if (!shell || !shell.isConnected) return;
    if (midActive() && m.clientHeight < 50) {
      const target = Math.max(240, Math.min(1000, (st.midW || 0) + 190));
      tweenShellWidth(shell, target);
      writtenW = target;
    } else if (writtenW != null) {
      stopWidthTween();
      shell.style.width = "";
      writtenW = null;
    }
  }

  let tickN = 0;
  let midShown = null;
  setInterval(() => {
    tickN++;
    driveShellWidth();
    if (!st.lines.length) return;
    st.posMs = curMs();
    const idx = indexAt(st.posMs + effLead());
    if (idx !== st.curIdx) {
      st.curIdx = idx;
      st.curText = idx >= 0 ? st.lines[idx].text : "";
      paintRows();
      measureMid();
      paintMid();
      document.dispatchEvent(new CustomEvent("dnlyr:state"));
    } else {
      paintProgress();
      // React bisa baru saja membuat ulang node tengah — isi segera, jangan
      // tunggu baris berikutnya.
      paintMid();
    }
    if (midShown !== midActive()) {
      midShown = midActive();
      document.dispatchEvent(new CustomEvent("dnlyr:state"));
    }
    if (midActive() && tickN % 8 === 0) {
      const m = document.querySelector("main");
      const shell = m && m.parentElement;
      log(
        "w midW=" + st.midW + " domW=" + (shell ? shell.offsetWidth : -1) + " h=" + (m ? m.clientHeight : -1)
      );
    }
  }, 250);

  // logger error global: crash React yang tertangkap boundary tidak selalu
  // sampai sini, tapi error async/JS lain ya — masuk dnptt.log.
  window.addEventListener("error", (e) => {
    log("JS error: " + ((e && e.message) || "?") + " @" + ((e && e.lineno) || "?"));
  });
  window.addEventListener("unhandledrejection", (e) => {
    const r = e && e.reason;
    log("rejection: " + ((r && (r.message || String(r))) || "?"));
  });

  // seed dari state yang sudah jalan (kalau webview reload saat lagu play)
  inv("smtc:get").then((v) => v && onNowPlaying(v)).catch(() => {});

  globalThis.dnLyrics = {
    midActive,
    shellW,
    mountMid,
    render,
    unmount,
    isPlaying: () => st.playing,
    currentText: () => st.curText,
    status: () => st.status,
    mediaKey: (k) => inv("media:key", k),
    toggleClosed,
    closedOn,
    showPlayerState,
    _st: st,
  };
})();
