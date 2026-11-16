/*
 * dn-ask.js — Ctrl+Alt+C: asisten ketik singkat yang berdiri sendiri (bukan tab),
 * memakai maskot voice assistant yang sama. Jalur data nyata dulu (agenda,
 * laptop lambat, kurs dolar, ringkasan notifikasi, buat jadwal), baru LLM.
 * Semua jawaban disimpan SATU KALI ke tab Conversation.
 */
(() => {
  if (globalThis.dnAsk) return;

  const st = {
    mounted: null,
    phase: "idle", // idle | thinking | done | err
    q: "",
    answer: "",
    err: "",
    runId: 0,
    avatarEl: null,
    proposal: null, // {title, at, note}
  };

  const CHIPS = [
    "Apa agenda hari ini?",
    "Ringkas notifikasi",
    "Kenapa laptop lambat?",
    "Kurs dolar hari ini?",
  ];

  const log = (line) => {
    try {
      window.bridge?.send("dnptt:log", "[ask] " + line);
    } catch (_) {}
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

  // Bersihkan sisa markdown dari jawaban model (**tebal**, # judul, * list)

  // Buang markup tool-call model (minimax/invoke/parameter) tanpa regex,
  // supaya jawaban yang bocor dari model jadi bersih.
  function stripToolMarkup(t) {
    let x = String(t == null ? "" : t);
    const pairs = [["<minimax>", "</minimax>"], ["<invoke", "</invoke>"], ["<parameter", "</parameter>"]];
    for (const pr of pairs) {
      let guard = 0;
      while (guard++ < 20) {
        const a = x.toLowerCase().indexOf(pr[0]);
        if (a < 0) break;
        const b = x.toLowerCase().indexOf(pr[1], a);
        if (b < 0) { x = x.slice(0, a); break; }
        x = x.slice(0, a) + x.slice(b + pr[1].length);
      }
    }
    x = x.split("</invoke>").join("").split("</parameter>").join("").split("</minimax>").join("");
    x = x.split("[object Object]").join("");
    return x;
  }

  // Jawaban bisa berupa objek (tool call) -> ambil teksnya kalau ada.
  function answerToText(res) {
    if (!res) return "";
    if (typeof res === "string") return res;
    if (typeof res.text === "string") return res.text;
    if (typeof res.say === "string") return res.say;
    if (typeof res.answer === "string") return res.answer;
    if (res.text && typeof res.text.content === "string") return res.text.content;
    if (Array.isArray(res.text)) {
      const j = res.text
        .map((c) => (typeof c === "string" ? c : c && typeof c.text === "string" ? c.text : ""))
        .filter(Boolean)
        .join(" ");
      if (j) return j;
    }
    if (res.content && typeof res.content === "string") return res.content;
    return "";
  }

  // Tanggal yang ditanyakan: hari ini / besok / lusa / "tanggal N"
  function targetDate(q) {
    const s = String(q || "").toLowerCase();
    const now = new Date();
    if (s.indexOf("lusa") >= 0) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2);
      return { date: ymd(d), label: "lusa" };
    }
    if (s.indexOf("besok") >= 0) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      return { date: ymd(d), label: "besok" };
    }
    const m = s.match(/(?:tanggal|tgl)[ ]*([0-9]{1,2})/);
    if (m) {
      const day = parseInt(m[1], 10);
      let d = new Date(now.getFullYear(), now.getMonth(), day);
      if (d < new Date(now.getFullYear(), now.getMonth(), now.getDate())) {
        d = new Date(now.getFullYear(), now.getMonth() + 1, day);
      }
      return {
        date: ymd(d),
        label: d.toLocaleDateString("id-ID", { weekday: "long", day: "numeric", month: "long" }),
      };
    }
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return { date: ymd(d), label: "hari ini" };
  }

  function cleanAnswer(t) {
    return stripToolMarkup(t || "")
      .replace(/\*\*(.+?)\*\*/g, "$1")
      .replace(/(^|\n)#{1,6}\s*/g, "$1")
      .replace(/(^|\n)\s*\*\s+/g, "$1- ")
      .replace(/\u2022/g, "-")
      .replace(/[ \t]+$/gm, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  const pad2 = (n) => String(n).padStart(2, "0");
  const ymd = (d) => d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  const todayStr = () => ymd(new Date());

  // ---- deteksi waktu Indonesia -------------------------------------------
  function parseSchedule(q) {
    const s = q.toLowerCase();
    const isSchedule =
      s.indexOf("jadwal") >= 0 || s.indexOf("buat jadwal") >= 0 || s.indexOf("meeting") >= 0 ||
      s.indexOf("rapat") >= 0 || s.indexOf("agenda") >= 0 || s.indexOf("janji") >= 0 ||
      s.indexOf("konsultasi") >= 0 || s.indexOf("presentasi") >= 0;
    if (!isSchedule) return null;

    // waktu: "jam 7", "jam 07", "jam 7:30", "pukul 19.30"
    let hh = null, mm = "00";
    let mt = s.match(/(?:jam|pukul)\s*(\d{1,2})(?::|\.)(\d{2})?/);
    if (mt) {
      hh = parseInt(mt[1], 10);
      mm = mt[2] ? mt[2] : "00";
    } else {
      mt = s.match(/\b(\d{1,2}):(\d{2})\b/);
      if (mt) { hh = parseInt(mt[1], 10); mm = mt[2]; }
    }
    if (hh === null || hh > 23) return null;

    // tanggal eksplisit: "tanggal 17", "tgl 17", "17 november", "17/11"
    let day = null, month = null, year = null;
    let md = s.match(/(?:tanggal|tgl)\s*(\d{1,2})(?:\s*(\d{1,2}))?/);
    if (md) {
      day = parseInt(md[1], 10);
      if (md[2]) month = parseInt(md[2], 10) - 1;
    } else {
      md = s.match(/\b(\d{1,2})\s+(januari|februari|maret|april|mei|juni|juli|agustus|september|oktober|november|desember)/);
      if (md) {
        day = parseInt(md[1], 10);
        const names = ["januari","februari","maret","april","mei","juni","juli","agustus","september","oktober","november","desember"];
        month = names.indexOf(md[2]);
      }
    }

    const now = new Date();
    let d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (day != null) {
      // tanggal eksplisit: bulan berjalan, atau bulan depan kalau lewat
      if (month == null) month = d.getMonth();
      d = new Date(now.getFullYear(), month, day);
      if (d < new Date(now.getFullYear(), now.getMonth(), now.getDate())) {
        d = new Date(now.getFullYear(), month + 1, day);
      }
    } else if (s.indexOf("lusa") >= 0) {
      d.setDate(d.getDate() + 2);
    } else if (s.indexOf("besok") >= 0) {
      d.setDate(d.getDate() + 1);
    }
    if (year) d.setFullYear(year);

    // judul: buang kata waktu/tanggal, sisanya = nama agenda
    let title = q
      .replace(/(?:jam|pukul)\s*\d{1,2}(?::|\.)?\d{0,2}/gi, " ")
      .replace(/(?:tanggal|tgl)\s*\d{1,2}(?:\s*\d{1,2})?/gi, " ")
      .replace(/\b\d{1,2}\s+(januari|februari|maret|april|mei|juni|juli|agustus|september|oktober|november|desember)\b/gi, " ")
      .replace(/\b(besok|lusa|hari ini|nanti|malam ini|sore|pagi|siang)\b/gi, " ")
      .replace(/\b(buat|bikin|buatkan|buat|jadwalkan|schedule|tambah)\s*/gi, " ")
      .replace(/[^\w\s]/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!title) title = "Agenda";

    return { title: title.slice(0, 60), at: ymd(d) + "T" + pad2(hh) + ":" + mm, note: "" };
  }

  function fmtTanggal(iso) {
    const d = new Date(iso + ":00");
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString("id-ID", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  }

  // ---- jalur data nyata ---------------------------------------------------
  async function agendaAnswer(q) {
    const list = (await inv("store:get", "calendarEvents")) || [];
    const t = targetDate(q);
    const evts = (Array.isArray(list) ? list : [])
      .filter((e) => e && (e.date || String(e.at || "").slice(0, 10)) === t.date)
      .sort((a, b) => String(a.at).localeCompare(String(b.at)));
    if (!evts.length) return "Tidak ada agenda di kalender DeskNotch untuk " + t.label + " (" + t.date + ").";
    const lines = evts.map((e) => "- " + (e.time || String(e.at || "").slice(11, 16)) + " " + (e.title || "") + (e.note ? " (" + e.note + ")" : ""));
    return "Agenda " + t.label + " (" + t.date + "):\n" + lines.join("\n");
  }

  async function slowAnswer() {
    const d = await inv("system:diagnose");
    if (!d || d.ok === false) return "Gagal membaca kondisi laptop: " + ((d && d.reason) || "tidak diketahui") + ".";
    const notes = Array.isArray(d.notes) ? d.notes : [];
    const top = (d.top_processes || []).slice(0, 3).map((p) => p.name + " (" + Math.round(p.mem_mb || 0) + " MB)");
    const lines = [
      "Kondisi laptop sekarang:",
      "- CPU: " + (d.cpu_pct != null ? Math.round(d.cpu_pct) + "%" : "tidak terbaca"),
      "- RAM: " + (d.ram_used_gb != null ? d.ram_used_gb + " / " + d.ram_total_gb + " GB" : "tidak terbaca"),
      "- Disk C: " + (d.disk_c_free_gb != null ? d.disk_c_free_gb + " GB bebas" : "tidak terbaca"),
    ];
    if (top.length) lines.push("- Proses teratas: " + top.join(", "));
    if (notes.length) lines.push("", "Catatan: " + notes.join("; "));
    return lines.join("\n");
  }

  async function rateAnswer() {
    const r = await inv("rates:get");
    if (!r || r.ok === false) return "Gagal mengambil kurs: " + ((r && r.reason) || "tidak diketahui") + ".";
    const fmt = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 0 });
    const when = r.fetched_at_ms ? new Date(r.fetched_at_ms).toLocaleString("id-ID") : "tidak diketahui";
    return (
      "Kurs USD/IDR: " + fmt.format(Math.round(r.rate || 0)) + " rupiah per 1 dolar.\n" +
      "Sumber: " + (r.source || "-") + " (diambil " + when + ")."
    );
  }

  async function summaryAnswer() {
    const list = (await inv("store:get", "dnNotifList")) || [];
    const arr = Array.isArray(list) ? list : [];
    if (!arr.length) return "Belum ada notifikasi yang tercatat.";
    const unread = arr.filter((n) => !n.read).length;
    const lines = arr.slice(0, 6).map((n) => "- " + (n.app || "?") + ": " + (n.title || n.body || ""));
    return "Ada " + arr.length + " notifikasi (" + unread + " belum dibaca):\n" + lines.join("\n");
  }

  async function deterministicAnswer(q) {
    const s = q.toLowerCase();
    const sched = parseSchedule(q);
    if (sched) {
      st.proposal = sched;
      return (
        "Siap. Jadwal: " + sched.title + "\n" +
        fmtTanggal(sched.at) + " pukul " + sched.at.slice(11, 16) + ".\n" +
        "Tekan \"+ Tambah ke Calendar\" untuk menyimpannya ke kalender DeskNotch (dan pengingatnya)."
      );
    }
    const wantsAgenda =
      s.indexOf("agenda") >= 0 || s.indexOf("jadwal") >= 0 || s.indexOf("meeting") >= 0 ||
      s.indexOf("besok") >= 0 || s.indexOf("lusa") >= 0;
    const makesSchedule =
      s.indexOf("buat") >= 0 || s.indexOf("bikin") >= 0 || s.indexOf("tambah") >= 0 || s.indexOf("jadwalkan") >= 0;
    if (wantsAgenda && !makesSchedule) return agendaAnswer(q);
    if (s.indexOf("lambat") >= 0 || s.indexOf("slow") >= 0 || s.indexOf("nge-lag") >= 0 ||
        s.indexOf("nge lag") >= 0 || s.indexOf("berat") >= 0 || s.indexOf("hang") >= 0) return slowAnswer();
    if (s.indexOf("kurs") >= 0 || s.indexOf("dollar") >= 0 || s.indexOf("usd") >= 0) return rateAnswer();
    if (s.indexOf("ringkas") >= 0 && s.indexOf("notif") >= 0) return summaryAnswer();
    return null;
  }

  function rememberExchange(q, a) {
    try {
      if (globalThis.dnConvo && globalThis.dnConvo.remember) {
        globalThis.dnConvo.remember("user", q);
        globalThis.dnConvo.remember("assistant", a);
      }
    } catch (e) {
      log("remember err: " + ((e && e.message) || e));
    }
  }

  async function addProposalToCalendar() {
    const p = st.proposal;
    if (!p) return;
    const cur = (await inv("store:get", "calendarEvents")) || [];
    const list = Array.isArray(cur) ? cur : [];
    const parts = String(p.at || "").split("T");
    const dd = new Date((parts[0] || "") + "T" + (parts[1] || "00:00") + ":00");
    const ms = isNaN(dd.getTime()) ? Date.now() : dd.getTime();
    const evt = {
      id: "cal" + Date.now(),
      title: p.title,
      at: ms,
      date: parts[0] || "",
      time: parts[1] || "",
      note: p.note || "",
    };
    list.push(evt);
    await inv("store:set", "calendarEvents", list);
    const rem = (await inv("store:get", "reminders")) || [];
    const rems = Array.isArray(rem) ? rem : [];
    rems.push({ id: evt.id, at: evt.at, message: evt.title });
    await inv("store:set", "reminders", rems);
    log("calendar event added: " + evt.title + " @ " + evt.at);
    st.proposal = null;
    paint();
  }

  (function style() {
    if (document.getElementById("dn-ask-style")) return;
    const t = document.createElement("style");
    t.id = "dn-ask-style";
    t.textContent = [
      ".dn-ask-chip{all:unset;cursor:pointer;font-size:10.5px;font-weight:500;padding:4px 11px;border-radius:9999px;background:rgba(255,255,255,0.08);color:rgba(255,255,255,0.75);transition:background .15s}",
      ".dn-ask-chip:hover{background:rgba(255,255,255,0.16);color:#fff}",
      ".dn-ask-input{all:unset;flex:1;min-width:0;font-size:11.5px;color:#fff;padding:7px 12px;border-radius:12px;background:rgba(255,255,255,0.07)}",
      ".dn-ask-input::placeholder{color:rgba(255,255,255,0.32)}",
      ".dn-ask-input:focus{background:rgba(255,255,255,0.1)}",
      ".dn-ask-send{all:unset;cursor:pointer;width:28px;height:28px;border-radius:9999px;background:rgba(255,255,255,0.1);color:#fff;display:grid;place-items:center;flex-shrink:0}",
      ".dn-ask-send:hover{background:rgba(255,255,255,0.2)}",
      ".dn-ask-mic{all:unset;cursor:pointer;width:28px;height:28px;border-radius:9999px;background:rgba(255,255,255,0.07);color:rgba(255,255,255,0.6);display:grid;place-items:center;flex-shrink:0}",
      ".dn-ask-mic:hover{background:rgba(255,255,255,0.14);color:#fff}",
      ".dn-ask-stop{all:unset;cursor:pointer;width:24px;height:24px;border-radius:9999px;background:rgba(255,255,255,0.14);display:grid;place-items:center;flex-shrink:0}",
      ".dn-ask-stop:hover{background:rgba(255,255,255,0.22)}",
      ".dn-ask-dot{width:5px;height:5px;border-radius:9999px;background:rgba(255,255,255,0.6);display:inline-block;animation:dnaskb 1.1s infinite}",
      ".dn-ask-dot:nth-child(2){animation-delay:.18s}",
      ".dn-ask-dot:nth-child(3){animation-delay:.36s}",
      "@keyframes dnaskb{0%,100%{opacity:.25}50%{opacity:1}}",
      ".dn-ask-add{all:unset;cursor:pointer;font-size:9.5px;font-weight:600;padding:4px 10px;border-radius:9999px;background:rgba(56,189,248,0.16);color:#7dd3fc;border:1px solid rgba(56,189,248,0.32)}",
      ".dn-ask-add:hover{background:rgba(56,189,248,0.3);color:#fff}",
    ].join(String.fromCharCode(10));
    document.head.appendChild(t);
  })();

  const SEND_SVG =
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 14 0"/><path d="m12 5 7 7-7 7"/></svg>';
  const MIC_SVG =
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19v3M19 10v2a7 7 0 0 1-14 0v-2M9 2h6v10a3 3 0 0 1-6 0V2Z"/></svg>';
  const STOP_SVG = '<span style="width:8px;height:8px;border-radius:2px;background:#fff;display:block"></span>';

  const MASCOT_FALLBACK =
    '<div style="width:34px;height:34px;border-radius:9999px;background:rgba(255,255,255,0.1);display:grid;place-items:center;flex-shrink:0">' +
    '<svg width="24" height="24" viewBox="0 0 36 36"><path d="M8 21c0-6.5 4.2-11 10-11s10 4.5 10 11v5.5l-3.3-2.2-3.4 2.2-3.3-2.2-3.3 2.2-3.4-2.2L8 26.5Z" fill="#fff"/><circle cx="14.6" cy="19" r="1.7" fill="#101014"/><circle cx="21.4" cy="19" r="1.7" fill="#101014"/></svg></div>';

  function paint() {
    const c = st.mounted;
    if (!c || !c.isConnected) return;

    let body = "";
    if (st.phase === "thinking") {
      body =
        '<div style="font-size:10.5px;color:rgba(255,255,255,0.45);margin-bottom:3px">&quot;' +
        esc2(st.q) + "&quot;</div>" +
        '<div style="display:flex;align-items:center;gap:7px">' +
        '<span style="font-size:12px;font-weight:600;color:#fff">Menyusun jawaban</span>' +
        '<span class="dn-ask-dot"></span><span class="dn-ask-dot"></span><span class="dn-ask-dot"></span>' +
        "</div>";
    } else if (st.phase === "done") {
      body =
        '<div style="font-size:11.5px;line-height:1.55;color:rgba(255,255,255,0.92);white-space:pre-wrap;' +
        'max-height:132px;overflow-y:auto;padding:2px 2px 12px">' +
        esc2(cleanAnswer(st.answer)) +
        "</div>";
      if (st.proposal) {
        body +=
          '<div style="display:flex;align-items:center;gap:8px;margin:0 0 10px 2px">' +
          '<button class="dn-ask-add">+ Tambah ke Calendar</button>' +
          '<span style="font-size:9.5px;color:rgba(255,255,255,0.45)">' +
          esc2(st.proposal.title + " - " + fmtTanggal(st.proposal.at) + " " + st.proposal.at.slice(11, 16)) +
          "</span></div>";
      }
    } else if (st.phase === "err") {
      body = '<div style="font-size:10.5px;color:rgba(255,255,255,0.55);padding:2px 2px 10px">Gagal: ' + esc2(st.err) + "</div>";
    }

    const head =
      st.phase === "idle"
        ? '<div style="font-size:12.5px;font-weight:600;color:rgba(255,255,255,0.92);margin-bottom:6px">Ada yang bisa dibantu?</div>' +
          '<div style="display:flex;gap:5px;flex-wrap:wrap">' +
          CHIPS.map((x) => '<button class="dn-ask-chip" data-q="' + esc2(x) + '">' + esc2(x) + "</button>").join("") +
          "</div>"
        : body;

    const ph = st.phase === "thinking" ? "Menjawab..." : "Tanya singkat...";
    const right =
      st.phase === "thinking"
        ? '<button class="dn-ask-stop" title="Stop">' + STOP_SVG + "</button>"
        : '<button class="dn-ask-send" title="Kirim">' + SEND_SVG + "</button>";

    container_set(
      '<div style="display:flex;flex-direction:column;height:100%;min-height:0">' +
        '<div style="display:flex;gap:9px;align-items:flex-start;flex:1;min-height:0">' +
        '<div style="min-width:0;flex:1">' + head + "</div></div>" +
        '<div style="display:flex;gap:7px;align-items:center;margin-top:8px">' +
        '<input class="dn-ask-input" placeholder="' + ph + '"' + (st.phase === "thinking" ? " disabled" : "") + ">" +
        '<button class="dn-ask-mic" title="Suara: Ctrl+Alt+V">' + MIC_SVG + "</button>" +
        right +
        "</div></div>"
    );

    const input = c.querySelector(".dn-ask-input");
    const submit = () => {
      const val = (input.value || "").trim();
      if (!val || st.phase === "thinking") return;
      run(val);
    };
    const send = c.querySelector(".dn-ask-send");
    if (send) send.onclick = submit;
    if (input) {
      input.onkeydown = (e) => {
        if (e.key === "Enter") submit();
      };
      if (st.phase !== "thinking") setTimeout(() => input.focus(), 30);
    }
    c.querySelectorAll(".dn-ask-chip").forEach((el) => {
      el.onclick = () => run(el.dataset.q);
    });
    const mic = c.querySelector(".dn-ask-mic");
    if (mic)
      mic.onclick = () => {
        log("voice pakai Ctrl+Alt+V");
      };
    const stop = c.querySelector(".dn-ask-stop");
    if (stop)
      stop.onclick = () => {
        st.runId++;
        st.phase = "idle";
        st.answer = "";
        st.err = "";
        st.proposal = null;
        paint();
      };
    const addBtn = c.querySelector(".dn-ask-add");
    if (addBtn) addBtn.onclick = () => addProposalToCalendar();
  }

  async function run(q) {
    st.q = q;
    st.answer = "";
    st.err = "";
    st.proposal = null;
    st.phase = "thinking";
    const myId = ++st.runId;
    paint();

    let text = null;
    try {
      text = await deterministicAnswer(q);
    } catch (e) {
      log("det err: " + ((e && e.message) || e));
    }
    if (text == null) {
      try {
        const res =
          globalThis.dnRouter && globalThis.dnRouter.ask
            ? await globalThis.dnRouter.ask(q, { surface: "conversation", noRemember: true })
            : null;
        text = answerToText(res);
      } catch (e) {
        text = "";
        st.err = (e && e.message) || String(e);
      }
    }
    if (myId !== st.runId) return;
    if (!text) {
      st.phase = "err";
      st.err = st.err || "Tidak ada jawaban. Cek koneksi 9router di Settings.";
      paint();
      return;
    }
    st.phase = "done";
    st.answer = text;
    rememberExchange(q, cleanAnswer(text));
    paint();
  }

  function container_set(html) {
    st.mounted.innerHTML = html;
  }

  function render() {
    try {
      paint();
    } catch (e) {
      log("render err: " + ((e && e.message) || e));
    }
  }

  function renderAt(container) {
    if (!container) return;
    st.mounted = container;
    if (!st.logged) {
      st.logged = true;
      log("render dipanggil");
    }
    st.phase = "idle";
    st.answer = "";
    st.err = "";
    st.proposal = null;
    render();
  }
  function unmount() {
    st.mounted = null;
  }

  globalThis.dnAsk = { render: renderAt, unmount, _st: st };
})();
