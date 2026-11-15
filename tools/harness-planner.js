// r72j harness: replicate the EXACT planner request the app sends and print the
// plan (secrets never printed: the API key is unsealed in-process and deleted).
const fs = require('fs');
const http = require('http');
const path = require('path');

const storePath = path.join(process.env.APPDATA, 'DeskNotch', 'desknotch-store.json');
const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
const settings = store.settings || {};
const voiceModel = settings.dnRouterVoiceModel || 'voice';
const sealed = settings.dnRouterKey || '';
console.log('voiceModel:', voiceModel);
console.log('apiKey sealed:', sealed ? 'present (len ' + sealed.length + ')' : 'MISSING');

// dn-router buildActionPrompt(tools) — verbatim
function buildActionPrompt(tools) {
  const toolLines = tools.map(function (t) {
    return '- "' + t.name + '": ' + t.desc + (t.args ? ' | args: ' + JSON.stringify(t.args) : '');
  });
  return [
    'Kamu adalah AI agent DeskNotch di Windows. Kamu BISA dan HARUS bertindak: setiap tool di daftar benar-benar dijalankan oleh DeskNotch di laptop pengguna ini.',
    'Kemampuan nyata yang kamu punya: membuka/menutup aplikasi, mengatur volume & media, membuka tab browser, mencari file, menambah todo & pengingat, mengganti tema, dan menjalankan perintah shell (tool "shell").',
    'JANGAN PERNAH menyuruh pengguna mengetik perintah sendiri, menempelkan output, atau bertanya "mau saya jalankan?" — izin SUDAH diurus oleh kartu persetujuan DeskNotch sebelum eksekusi. Langsung pilih tool dan isi args-nya.',
    'Kalau butuh informasi dari laptop (misal daftar file), JANGAN minta pengguna mencarinya: panggil tool yang bisa mengetahuinya (search_file atau shell) dan lakukan sendiri.',
    '',
    'Balas HANYA dengan satu objek JSON. Tanpa markdown, tanpa pagar kode, tanpa penjelasan pembuka/penutup.',
    'Format wajib:',
    '{"steps":[{"tool":"<nama tool>","args":{...}}],"say":"<konfirmasi pendek>"}',
    '',
    'Aturan:',
    '- "steps": array berisi 0 sampai 6 langkah aksi terurut.',
    '- Setiap langkah: {"tool":"<nama tool>","args":{...}}.',
    '- JANGAN MENJELASKAN CARANYA KE PENGGUNA. Jika pengguna meminta tindakan (putar video, cari di youtube, kirim pesan, buka tab, atur volume), PILIH TOOL YANG SESUAI.',
    '- Untuk memutar video YouTube terbaru: gunakan "youtube_play" dengan args {"query":"...","channel":"..."}.',
    '- Untuk mencari di YouTube: gunakan "youtube" dengan args {"query":"..."}.',
    '- Untuk kirim pesan WhatsApp: gunakan "whatsapp" dengan args {"contact":"...","message":"..."}.',
    '- "say": satu kalimat pendek bahasa Indonesia, dibacakan lewat TTS.',
    '- Jika ucapan itu pertanyaan murni, obrolan, atau tidak butuh aksi sistem sama sekali, balas {"steps":[],"say":"<jawaban singkat>"}. Contoh: "siapa presiden indonesia" BUKAN aksi sistem, jadi steps harus kosong dan jawabannya di "say".',
    '- Jangan pernah menolak dengan alasan tidak punya izin atau akses ke laptop; DeskNotch yang mengeksekusi rencanamu.',
    '- search_file mencari NAMA FILE di Desktop/Dokumen/Download dan MENARUHNYA DI SHELF notch (tidak membuka file). Untuk "cari file X", pilih search_file.',
    '- Untuk MENGHAPUS file, WAJIB pakai tool "delete_file" dengan args {"query":"<nama file>"} — JANGAN menulis perintah shell sendiri. delete_file mencari path yang benar dulu lalu menghapus ke Recycle Bin. Jangan pernah menebak nama file.',
    '- Tool "shell" menjalankan perintah di Windows (PowerShell). Gunakan untuk hal yang tidak punya tool khusus: cek disk, ipconfig, buka folder dengan explorer, hapus file ke Recycle Bin, dll. Tulis perintah PowerShell yang valid di Windows — JANGAN pakai perintah Linux seperti find/gio/rm.',
    '',
    'Daftar tool yang tersedia:',
    toolLines.join('\n'),
    '',
    'Waktu sekarang di laptop pengguna: ' + new Date().toLocaleString('id-ID') + '.',
    '',
    'Ucapan pengguna di bawah. Pilih tool yang sesuai dan balas HANYA JSON-nya.'
  ].join('\n');
}

const TOOLS = [
  { name: 'open_app', args: { app: 'string' }, desc: 'luncurkan atau fokuskan aplikasi desktop' },
  { name: 'open_tab', args: { site: 'string', url: 'string?' }, desc: 'buka atau pakai ulang tab browser' },
  { name: 'volume', args: { level: 'number?', delta: 'number?' }, desc: 'atur volume 0-100 atau ubah relatif' },
  { name: 'media', args: { action: 'play-pause|next|previous' }, desc: 'kontrol pemutar media' },
  { name: 'youtube', args: { query: 'string' }, desc: 'cari video di YouTube' },
  { name: 'youtube_play', args: { query: 'string', channel: 'string?' }, desc: 'putar video YouTube paling baru, langsung autoplay' },
  { name: 'spotify', args: { query: 'string' }, desc: 'putar lagu di Spotify' },
  { name: 'whatsapp', args: { contact: 'string', message: 'string' }, desc: 'siapkan pesan WhatsApp' },
  { name: 'type_text', args: { text: 'string' }, desc: 'ketik atau tempel teks ke aplikasi aktif' },
  { name: 'press_key', args: { key: 'string' }, desc: 'kirim kombinasi tombol, misal ctrl+s' },
  { name: 'theme', args: { mode: 'light|dark' }, desc: 'ganti tema laptop Windows ke mode terang atau gelap' },
  { name: 'search_file', args: { query: 'string', hint: 'download|documents|desktop?' }, desc: 'cari file di komputer (Desktop/Dokumen/Download)' },
  { name: 'todo_add', args: { text: 'string' }, desc: 'tambah satu tugas ke daftar to do di notch' },
  { name: 'reminder_add', args: { text: 'string', time: 'string?' }, desc: 'tambah pengingat' },
];

const body = JSON.stringify({
  model: voiceModel,
  messages: [
    { role: 'system', content: buildActionPrompt(TOOLS) },
    { role: 'user', content: 'putar video windah basudara yang lagi hits' }
  ],
  stream: false,
  response_format: { type: 'json_object' }
});

const req = http.request({
  host: '127.0.0.1',
  port: 20128,
  path: '/v1/chat/completions',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + sealed,   // sealed key sent as-is; if the gateway needs plain, PS unseal below
    'Content-Length': Buffer.byteLength(body)
  },
  timeout: 30000
}, function (res) {
  let d = '';
  res.on('data', c => d += c);
  res.on('end', () => {
    console.log('HTTP', res.statusCode);
    try {
      const j = JSON.parse(d);
      const content = j.choices && j.choices[0] && j.choices[0].message ? j.choices[0].message.content : d;
      console.log('CONTENT:', String(content).slice(0, 600));
    } catch (e) {
      console.log('RAW:', d.slice(0, 600));
    }
  });
});
req.on('error', e => console.log('ERR:', e.message));
req.on('timeout', () => { console.log('TIMEOUT'); req.destroy(); });
req.end(body);
