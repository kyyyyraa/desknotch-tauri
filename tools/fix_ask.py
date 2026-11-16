import io
p = 'ui/dn-ask.js'
s = open(p, encoding='utf-8').read()

helper = '''
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
'''

def rep(old, new, tag):
    global s
    n = s.count(old)
    assert n == 1, (tag, n)
    s = s.replace(old, new)
    print('OK', tag)

rep("  function cleanAnswer(t) {", helper + "\n  function cleanAnswer(t) {", 'helper')
rep('  function cleanAnswer(t) {\n    return String(t || "")',
    '  function cleanAnswer(t) {\n    return stripToolMarkup(t || "")', 'cleanAnswer')

NL2 = 'String.fromCharCode(10)'
rep("  async function agendaAnswer() {", "  async function agendaAnswer(q) {", 'agenda sig')
rep("    const today = todayStr();", "    const t = targetDate(q);", 'agenda today')
rep('.filter((e) => e && String(e.at || "").slice(0, 10) === today)',
    '.filter((e) => e && String(e.at || "").slice(0, 10) === t.date)', 'agenda filter')
rep('if (!evts.length) return "Tidak ada agenda di kalender DeskNotch untuk hari ini (" + today + ").";',
    'if (!evts.length) return "Tidak ada agenda di kalender DeskNotch untuk " + t.label + " (" + t.date + ").";',
    'agenda empty')
rep('return "Agenda hari ini (" + today + "):', 'return "Agenda " + t.label + " (" + t.date + "):', 'agenda head')

old_call = '''    if ((s.indexOf("agenda") >= 0 || s.indexOf("jadwal") >= 0 || s.indexOf("meeting") >= 0) &&
        (s.indexOf("hari ini") >= 0 || s.indexOf("today") >= 0)) return agendaAnswer();'''
new_call = '''    const wantsAgenda =
      s.indexOf("agenda") >= 0 || s.indexOf("jadwal") >= 0 || s.indexOf("meeting") >= 0 ||
      s.indexOf("besok") >= 0 || s.indexOf("lusa") >= 0;
    const makesSchedule =
      s.indexOf("buat") >= 0 || s.indexOf("bikin") >= 0 || s.indexOf("tambah") >= 0 || s.indexOf("jadwalkan") >= 0;
    if (wantsAgenda && !makesSchedule) return agendaAnswer(q);'''
rep(old_call, new_call, 'agenda call')

rep('        text = (res && (res.text || res.say)) || "";', '        text = answerToText(res);', 'answerToText')

old_mascot = '''    const mascot = st.avatarEl
      ? '<div style="width:40px;height:40px;flex-shrink:0;display:grid;place-items:center">' + st.avatarEl + "</div>"
      : MASCOT_FALLBACK;

    container_set(
      '<div style="display:flex;flex-direction:column;height:100%;min-height:0;padding:2px 2px 0">' +
        '<div style="display:flex;gap:9px;align-items:flex-start;flex:1;min-height:0">' + mascot +
        '<div style="min-width:0;flex:1">' + head + "</div></div>" +'''
new_mascot = '''    container_set(
      '<div style="display:flex;flex-direction:column;height:100%;min-height:0">' +
        '<div style="display:flex;gap:9px;align-items:flex-start;flex:1;min-height:0">' +
        '<div style="min-width:0;flex:1">' + head + "</div></div>" +'''
rep(old_mascot, new_mascot, 'hapus avatar sendiri')

rep('''  function renderAt(container, avatarEl) {
    if (!container) return;
    st.mounted = container;
    if (avatarEl) st.avatarEl = avatarEl;''',
'''  function renderAt(container) {
    if (!container) return;
    st.mounted = container;''', 'renderAt')

open(p, 'w', encoding='utf-8', newline='').write(s)
print('dn-ask patched OK')
