/*
 * dn-calendar.js — Tab Calendar compact ala Isle: KIRI grid bulan, KANAN
 * daftar event hari terpilih (tanpa blok "Mendatang"). Setiap event juga
 * ditulis ke store "reminders" supaya popup pengingat menyala tepat waktu.
 */
(() => {
  if (globalThis.dnCalendar) return;

  const st = { events: [], mounted: null, month: new Date(), sel: null };

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
  const MONTHS = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli",
    "Agustus", "September", "Oktober", "November", "Desember"];
  const DAYS = ["S", "S", "R", "K", "J", "S", "M"];

  const ymd = (d) =>
    d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");

  function persist() {
    inv("store:set", "calendarEvents", st.events.slice(0, 200));
  }

  async function syncReminder(evt, remove) {
    const cur = await inv("store:get", "reminders");
    const list = Array.isArray(cur) ? cur.filter((r) => r && r.id !== evt.id) : [];
    if (!remove) list.push({ id: evt.id, at: evt.at, message: evt.note ? evt.title + " - " + evt.note : evt.title });
    inv("store:set", "reminders", list);
  }

  window.bridge?.on("store:changed", (k, v) => {
    if (k === "calendarEvents" && Array.isArray(v)) st.events = v;
    if (st.mounted) render();
  });
  inv("store:get", "calendarEvents").then((e) => {
    if (Array.isArray(e)) st.events = e;
    if (st.mounted) render();
  }).catch(() => {});

  // "at" harus epoch ms (angka) — chunk reminder membandingkan e.at > Date.now();
  // string ISO tidak pernah jatuh tempo. Tanggal/waktu disimpan terpisah.
  function epochMs(date, time) {
    const d = new Date(date + "T" + (time || "00:00") + ":00");
    return isNaN(d.getTime()) ? Date.now() : d.getTime();
  }

  function addEvent(title, date, time, endTime, note) {
    if (!title || !date || !time) return;
    const evt = {
      id: "cal" + Date.now(),
      title: title.trim(),
      at: epochMs(date, time),
      date: date,
      time: time,
      endTime: endTime || "",
      endAt: endTime ? epochMs(date, endTime) : 0,
      note: (note || "").trim(),
    };
    st.events.push(evt);
    persist();
    syncReminder(evt, false);
    st.sel = date;
    render();
  }
  function delEvent(id) {
    const evt = st.events.find((e) => e.id === id);
    st.events = st.events.filter((e) => e.id !== id);
    persist();
    if (evt) syncReminder(evt, true);
    render();
  }

  (function style() {
    if (document.getElementById("dn-cal-style")) return;
    const t = document.createElement("style");
    t.id = "dn-cal-style";
    t.textContent = [
      ".dn-cal-day{min-height:19px;font-size:9.5px;color:rgba(255,255,255,0.7);border-radius:6px;display:flex;flex-direction:column;align-items:center;justify-content:center;cursor:pointer;position:relative}",
      ".dn-cal-day:hover{background:rgba(255,255,255,0.07)}",
      ".dn-cal-day.sel{background:rgba(255,255,255,0.16);color:rgba(255,255,255,0.9)}",
      ".dn-cal-day.tdy{background:#f4f4f5;color:#101014;font-weight:700}",
      ".dn-cal-day.tdy.sel{background:#e4e4e7;color:#101014}",
      ".dn-cal-day i{width:3px;height:3px;border-radius:9999px;background:#38bdf8;position:absolute;bottom:1px}",
      ".dn-cal-day.tdy i{background:#0ea5e9}",
      ".dn-cal-ev{display:flex;gap:6px;align-items:center;padding:4px 8px;border-radius:9px;background:rgba(255,255,255,0.06)}",
      ".dn-cal-ev:hover{background:rgba(255,255,255,0.11)}",
      ".dn-cal-t{font-size:9px;font-weight:700;color:rgba(255,255,255,0.55);font-variant-numeric:tabular-nums;flex-shrink:0}",
      ".dn-cal-et{font-size:10.5px;font-weight:600;color:rgba(255,255,255,0.92);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dn-cal-en{font-size:9.5px;color:rgba(255,255,255,0.45);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dn-cal-tpill{font-size:9px;font-weight:700;color:#fbbf24;background:rgba(251,146,60,0.15);padding:2px 7px;border-radius:9999px;font-variant-numeric:tabular-nums;flex-shrink:0}",
      ".dn-cal-del{all:unset;cursor:pointer;width:15px;height:15px;border-radius:9999px;display:grid;place-items:center;color:rgba(255,255,255,0.45);font-size:10px;flex-shrink:0}",
      ".dn-cal-del:hover{background:rgba(220,38,38,0.5);color:#fff}",
      ".dn-cal-inline{all:unset;font-size:10.5px;color:#fff;padding:5px 9px;border-radius:9px;background:rgba(255,255,255,0.07)}",
      ".dn-cal-inline::placeholder{color:rgba(255,255,255,0.32)}",
      ".dn-cal-inline:focus{background:rgba(255,255,255,0.11)}",
      ".dn-cal-x{all:unset;cursor:pointer;width:19px;height:19px;border-radius:9999px;display:grid;place-items:center;color:rgba(255,255,255,0.6);font-size:12px}",
      ".dn-cal-x:hover{background:rgba(255,255,255,0.1);color:#fff}",
    ].join(String.fromCharCode(10));
    document.head.appendChild(t);
  })();

  // "makan 20:00-20:30" -> {title:"makan", start:"20:00", end:"20:30"}
  function parseInline(text) {
    const t = String(text || "").trim();
    if (!t) return null;
    const re = /(\d{1,2}):(\d{2})\s*[-–]\s*(\d{1,2}):(\d{2})/;
    const re1 = /(\d{1,2}):(\d{2})/;
    let title = t;
    let start = "09:00";
    let end = "";
    const m2 = t.match(re);
    if (m2) {
      start = (m2[1].length === 1 ? "0" : "") + m2[1] + ":" + m2[2];
      end = (m2[3].length === 1 ? "0" : "") + m2[3] + ":" + m2[4];
      title = t.replace(m2[0], " ").replace(/\s+/g, " ").trim();
    } else {
      const m1 = t.match(re1);
      if (m1) {
        start = (m1[1].length === 1 ? "0" : "") + m1[1] + ":" + m1[2];
        title = t.replace(m1[0], " ").replace(/\s+/g, " ").trim();
      }
    }
    title = title.replace(/^[-–:]\s*/, "").trim();
    if (!title) title = "Event";
    return { title: title, start: start, end: end };
  }

  function render() {
    try {
      paint();
    } catch (e) {
      window.bridge && window.bridge.send && window.bridge.send("dnptt:log", "[dncal] err: " + ((e && e.message) || e));
    }
  }

  function paint() {
    const c = st.mounted;
    if (!c || !c.isConnected) return;
    const y = st.month.getFullYear();
    const m = st.month.getMonth();
    const first = new Date(y, m, 1);
    const startIdx = (first.getDay() + 6) % 7;
    const dim = new Date(y, m + 1, 0).getDate();
    const today = ymd(new Date());
    const sel = st.sel || today;
    const selDate = new Date(sel + "T09:00");
    const selLabel =
      sel === today
        ? "Hari ini, " + selDate.toLocaleDateString("id-ID", { day: "numeric", month: "long" })
        : selDate.toLocaleDateString("id-ID", { weekday: "long", day: "numeric", month: "long" });
    const dayEvents = st.events
      .filter((e) => (e.date || String(e.at || "").slice(0, 10)) === sel)
      .sort((a, b) => String(a.at).localeCompare(String(b.at)));

    let cells = "";
    for (let i = 0; i < startIdx; i++) cells += "<div></div>";
    for (let d = 1; d <= dim; d++) {
      const key = y + "-" + String(m + 1).padStart(2, "0") + "-" + String(d).padStart(2, "0");
      const has = st.events.some((e) => (e.date || String(e.at || "").slice(0, 10)) === key);
      cells +=
        '<div class="dn-cal-day' + (key === sel ? " sel" : "") + (key === today ? " tdy" : "") + '" data-d="' + key + '">' +
        d + (has ? "<i></i>" : "") + "</div>";
    }

    const rows = dayEvents.length
      ? dayEvents
          .map((e) => {
            const hhmm = e.time || String(e.at || "").slice(11, 16);
            const end = e.endTime || "";
            return (
              '<div class="dn-cal-ev" data-id="' + e.id + '">' +
              '<div style="min-width:0;flex:1"><div class="dn-cal-et">' + esc2(e.title) + "</div>" +
              (e.note ? '<div class="dn-cal-en">' + esc2(e.note) + "</div>" : "") +
              "</div>" +
              '<span class="dn-cal-tpill">' + esc2(hhmm + (end ? "-" + end : "")) + "</span>" +
              '<button class="dn-cal-del" title="Hapus">&times;</button></div>'
            );
          })
          .join("")
      : '<div style="font-size:10px;color:rgba(255,255,255,0.32);padding:2px">Belum ada event di tanggal ini.</div>';

    container_set(
      '<div style="display:flex;gap:10px;height:100%;min-height:0;padding:2px 0 0">' +
        '<div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:4px">' +
        '<div style="display:flex;align-items:center;gap:5px">' +
        '<button class="dn-cal-prev dn-cal-x">&lsaquo;</button>' +
        '<span style="font-size:9.5px;font-weight:700;color:#f87171;letter-spacing:0.6px">' + MONTHS[m].toUpperCase() + " " + y + "</span>" +
        '<button class="dn-cal-next dn-cal-x">&rsaquo;</button>' +
        "</div>" +
        '<div style="display:grid;grid-template-columns:repeat(7,1fr);gap:1px">' +
        DAYS.map((d) => '<div style="font-size:8px;color:rgba(255,255,255,0.3);text-align:center;font-weight:700">' + d + "</div>").join("") +
        cells +
        "</div>" +
        "</div>" +
        '<div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:5px;border-left:1px solid rgba(255,255,255,0.07);padding-left:10px">' +
        '<div style="font-size:11px;font-weight:600;color:rgba(255,255,255,0.9)">' + esc2(selLabel) + "</div>" +
        '<input class="dn-cal-inline" placeholder="Tambah event - mis. Makan 20:00" maxlength="80">' +
        '<div style="display:flex;flex-direction:column;gap:3px;overflow-y:auto;flex:1;min-height:0">' + rows + "</div>" +
        "</div>" +
        "</div>"
    );

    const q = (s2) => c.querySelector(s2);
    q(".dn-cal-prev").onclick = () => {
      st.month = new Date(y, m - 1, 1);
      render();
    };
    q(".dn-cal-next").onclick = () => {
      st.month = new Date(y, m + 1, 1);
      render();
    };
    c.querySelectorAll(".dn-cal-day").forEach((el) => {
      el.onclick = () => {
        st.sel = el.dataset.d;
        render();
      };
    });
    c.querySelectorAll(".dn-cal-ev").forEach((el) => {
      el.querySelector(".dn-cal-del").onclick = (e) => {
        e.stopPropagation();
        delEvent(el.dataset.id);
      };
    });
    const inline = q(".dn-cal-inline");
    if (inline) {
      inline.onkeydown = (e) => {
        if (e.key !== "Enter") return;
        const p = parseInline(inline.value);
        if (!p) return;
        addEvent(p.title, st.sel || ymd(new Date()), p.start, p.end, "");
        inline.value = "";
      };
    }
  }

  function container_set(html) {
    st.mounted.innerHTML = html;
  }

  function mount(container) {
    if (!container) return;
    st.mounted = container;
    render();
  }
  function unmount() {
    st.mounted = null;
  }

  globalThis.dnCalendar = { render: mount, unmount, addEvent, _st: st };
})();
