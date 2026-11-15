// dn-router.js - DeskNotch AI brain via 9router (OpenAI-compatible gateway).
// Renderer side of fase 3g: this only talks to the local gateway at
// http://127.0.0.1:20128. It never touches STT/TTS (9router has no audio
// endpoint) and makes no other network calls.
//
// Public API (window.dnRouter):
//   configure({baseUrl, apiKey, model, voiceModel, convoModel}) -> Promise<boolean>
//   isConfigured()                      -> boolean
//   listModels()                        -> Promise<string[]> ([] on failure)
//   ask(text, opts)                     -> Promise<{text, ms, model}>
//   askAction(text, tools, opts)        -> Promise<{steps, say, error?}>
//   test()                              -> Promise<{ok, models?, error?}>
//   peek(surface)                       -> read-back of the config, key masked
//   DEFAULTS                            -> {baseUrl, model}
//
// Two surfaces share one gateway but want different models: the voice loop
// needs a small, fast model that answers in one breath, while the
// Conversation tab can afford a bigger one. cfg.voiceModel and cfg.convoModel
// hold those choices; cfg.model stays the fallback for whichever surface has
// no explicit pick.
//
// askAction is the "AI decides" half of "AI decides, DeskNotch executes":
// the model never touches the laptop, it only returns a JSON action plan that
// dn-voice-exec.js runs. It never rejects; a failure is a plan with no steps
// plus an error string, so the caller can fall back to a plain spoken answer.
(function () {
  if (window.dnRouter) return;

  var DEFAULTS = { baseUrl: 'http://127.0.0.1:20128', model: '' };

  var cfg = {
    baseUrl: DEFAULTS.baseUrl,
    apiKey: '',
    model: DEFAULTS.model,
    voiceModel: '',
    convoModel: ''
  };
  var loaded = false;   // read-back from the store is async; until it lands nothing is configured

  function getBridge() {
    try { return (window && window.bridge) || null; } catch (_) { return null; }
  }

  function maskKey(key) {
    // the key must never appear whole in a log line
    return (key || '').slice(0, 4) + '\u2026';
  }

  // ---- store --------------------------------------------------------------
  // store:set replaces the whole settings object, so read first and merge
  // (same pattern as storeEnabled in dn-whisper.js).
  function readSettings() {
    var bridge = getBridge();
    if (!bridge || !bridge.invoke) return Promise.resolve(null);
    try { return Promise.resolve(bridge.invoke('store:get', 'settings')); }
    catch (_) { return Promise.resolve(null); }
  }

  function writeSettings(patch) {
    var bridge = getBridge();
    if (!bridge || !bridge.invoke) return Promise.resolve(false);
    var cur;
    try { cur = bridge.invoke('store:get', 'settings'); } catch (_) { cur = null; }
    return Promise.resolve(cur).then(function (settings) {
      var next = (settings && typeof settings === 'object') ? Object.assign({}, settings) : {};
      Object.assign(next, patch);
      return bridge.invoke('store:set', 'settings', next);
    }).then(function () { return true; }).catch(function () { return false; });
  }

  // Read the stored config once at startup. Until this resolves,
  // isConfigured() stays false: a missing store must not fake a configured state.
  function loadStored() {
    return readSettings().then(function (settings) {
      if (settings && typeof settings === 'object') {
        if (settings.dnRouterBaseUrl) cfg.baseUrl = String(settings.dnRouterBaseUrl);
        if (settings.dnRouterKey) cfg.apiKey = String(settings.dnRouterKey);
        if (settings.dnRouterModel) cfg.model = String(settings.dnRouterModel);
        // The two per-surface models are optional. An empty one means "use the
        // shared fallback", so a user who never picks one keeps the old
        // single-model behaviour.
        if (settings.dnRouterVoiceModel) cfg.voiceModel = String(settings.dnRouterVoiceModel);
        if (settings.dnRouterConvoModel) cfg.convoModel = String(settings.dnRouterConvoModel);

        // The key is normally stored encrypted as dnRouterKeySealed, so the
        // plaintext branch above finds nothing and every request went out with
        // an empty Bearer token (401). Decrypt it through the main process.
        var b = getBridge();
        if (!cfg.apiKey && settings.dnRouterKeySealed && b && b.invoke) {
          return b.invoke('dnrouter:open', String(settings.dnRouterKeySealed))
            .then(function (plain) {
              if (plain) cfg.apiKey = String(plain);
            })
            .catch(function () {})
            .then(function () { loaded = true; });
        }
      }
      loaded = true;
    }).catch(function () { loaded = true; });
  }

  // ---- http ---------------------------------------------------------------
  // The gateway lives on localhost and sends no CORS headers, so a direct
  // fetch from the app:// renderer is rejected by Chromium before the socket
  // opens. Everything goes through the main process instead; it has no origin
  // and therefore no CORS, and it refuses any URL that is not the local host.
  function httpJson(method, url, headers, body) {
    var b = getBridge();
    if (!b || typeof b.invoke !== "function") {
      return Promise.reject(new Error("jembatan aplikasi tidak tersedia"));
    }
    var payload = { url: url, method: method, headers: headers || {} };
    if (body != null) payload.body = body;
    // The gateway is an SSH tunnel on localhost: it hiccups. One quick retry
    // turns "kadang konek kadang tidak" into "kadang 1 detik telat".
    var attempt = function () {
      return Promise.resolve(b.invoke("dnrouter:http", payload)).then(function (res) {
        if (!res || typeof res !== "object") throw new Error("tidak ada jawaban dari 9router");
        if (!res.ok && !res.status) throw new Error(res.error || "tidak bisa menghubungi 9router");
        return { ok: !!res.ok, status: Number(res.status) || 0, text: String(res.body || "") };
      });
    };
    return attempt().catch(function (e1) {
      try { if (window.bridge && window.bridge.send) window.bridge.send("dnptt:log", "9router retry: " + (e1 && e1.message ? e1.message : e1)); } catch (_) {}
      return new Promise(function (r) { setTimeout(r, 1200); }).then(attempt);
    });
  }

  function normalizeBase(baseUrl) {
    var b = String(baseUrl || DEFAULTS.baseUrl).trim().replace(/\/+$/, '');
    // People paste the URL they see in the router dashboard, which often ends
    // in /v1. Every request below appends /v1/..., so keeping it produced
    // /v1/v1/chat/completions and a 404. Accept both spellings.
    b = b.replace(/\/v1$/i, '');
    return b || DEFAULTS.baseUrl;
  }

  function getConfigured() {
    return {
      baseUrl: normalizeBase(cfg.baseUrl),
      apiKey: cfg.apiKey,
      model: cfg.model
    };
  }

  // GET {baseUrl}/v1/models. Any failure returns [] — the dropdown just falls
  // back to a text input, so this must never throw.
  function listModels() {
    if (!cfg.apiKey) return Promise.resolve([]);
    var c = getConfigured();
    return httpJson('GET', c.baseUrl + '/v1/models', { 'Authorization': 'Bearer ' + c.apiKey })
      .then(function (res) {
        if (!res.ok) return [];
        var json;
        try { json = JSON.parse(res.text); } catch (_) { return []; }
        var data = json && json.data;
        if (!Array.isArray(data)) return [];
        var ids = [];
        for (var i = 0; i < data.length; i++) {
          if (data[i] && data[i].id) ids.push(String(data[i].id));
        }
        return ids;
      }).catch(function () { return []; });
  }

  // POST {baseUrl}/v1/chat/completions, non-streaming. Errors are
  // human-readable Indonesian because they end up in the notch UI.
  // The Conversation tab keeps the last exchanges. When it is loaded the
  // planner is handed the thread, so a follow up question still knows what
  // came before it.
  function convoHistory(text) {
    try {
      var convo = window.dnConvo;
      if (!convo || typeof convo.recent !== 'function') return [];
      var list = convo.recent(6) || [];
      var out = [];
      for (var i = 0; i < list.length; i++) {
        var e = list[i];
        if (!e || !e.text) continue;
        // the question being asked is already the last user message
        if (text && e.role === 'user' && e.text === String(text)) continue;
        out.push({ role: e.role === 'user' ? 'user' : 'assistant', content: e.text });
      }
      return out;
    } catch (_) {
      return [];
    }
  }

  // Remember the exchange so the next request carries the thread.
  function rememberExchange(question, answer) {
    try {
      var convo = window.dnConvo;
      if (!convo || typeof convo.remember !== 'function') return;
      if (question) convo.remember('user', question);
      if (answer) convo.remember('assistant', answer);
    } catch (_) {}
  }

  // Extracts content from either standard OpenAI JSON response or SSE text stream (data: ...)
  function extractContent(raw) {
    if (!raw) return '';
    var str = String(raw).trim();
    try {
      var json = JSON.parse(str);
      if (json && json.choices && json.choices[0]) {
        var msg = json.choices[0].message || json.choices[0].delta;
        if (msg && msg.content) return String(msg.content);
        if (typeof json.choices[0].text === 'string') return json.choices[0].text;
      }
      if (json && json.content) return String(json.content);
    } catch (_) {}

    if (str.indexOf('data:') !== -1) {
      var lines = str.split('\n');
      var accum = '';
      for (var i = 0; i < lines.length; i++) {
        var l = lines[i].trim();
        if (l.indexOf('data:') !== 0) continue;
        var piece = l.slice(5).trim();
        if (!piece || piece === '[DONE]') continue;
        try {
          var chunk = JSON.parse(piece);
          if (chunk && chunk.choices && chunk.choices[0]) {
            var d = chunk.choices[0].delta || chunk.choices[0].message;
            if (d && d.content) accum += d.content;
          }
        } catch (_) {}
      }
      if (accum.trim()) return accum.trim();
    }
    return str;
  }

  // The model that answers a given surface. Voice wants the small, fast one;
  // the Conversation tab can use a bigger one. An unset per-surface model
  // falls back to the shared cfg.model, so a user who never picks one keeps
  // the single-model behaviour they had before.
  function modelFor(surface) {
    if (surface === 'voice') return cfg.voiceModel || cfg.model;
    if (surface === 'conversation' || surface === 'chat') return cfg.convoModel || cfg.model;
    return cfg.model;
  }

  function ask(text, opts) {
    opts = opts || {};
    if (!text || !String(text).trim()) {
      return Promise.reject(new Error('pertanyaannya kosong'));
    }
    if (!cfg.apiKey) {
      return Promise.reject(new Error('API key 9router belum diisi'));
    }
    var c = getConfigured();
    var model = opts.model || modelFor(opts.surface) || c.model;
    var t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    var userContent;
    if (opts.image) {
      var imgUrl = typeof opts.image === 'string' ? opts.image : (opts.image.url || '');
      if (imgUrl) {
        userContent = [
          { type: 'text', text: String(text) },
          { type: 'image_url', image_url: { url: imgUrl } }
        ];
      } else {
        userContent = String(text);
      }
    } else {
      userContent = String(text);
    }

    var sysPrompt = (opts.surface === 'conversation' || opts.surface === 'chat')
      ? 'Kamu adalah asisten DeskNotch di Windows dalam mode percakapan. Bantu pengguna menjawab, menganalisis gambar/tangkapan layar, dan menjelaskan dengan ramah, jelas, dan akurat dalam bahasa Indonesia.'
      : 'Kamu adalah asisten suara DeskNotch di Windows. Jawabanmu dibacakan langsung lewat suara TTS, jadi jawab sangat singkat dan padat (1-2 kalimat) dalam bahasa Indonesia. Jangan pernah menolak dengan alasan tidak punya izin atau akses ke laptop, karena aplikasi DeskNotch yang menangani integrasi sistem.';

    return httpJson('POST', c.baseUrl + '/v1/chat/completions', {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + c.apiKey
    }, JSON.stringify((function () {
      var chatMessages = [
        { role: 'system', content: sysPrompt }
      ].concat(convoHistory(text), [{ role: 'user', content: userContent }]);
      return { model: model, messages: chatMessages, stream: false };
    })())).then(function (res) {
      if (!res.ok && (res.status === 400 || res.status === 404 || res.status >= 500)) {
        var fb = (cfg.convoModel && cfg.convoModel !== model) ? cfg.convoModel : 'kr/claude-haiku-4.5';
        try { if (window.bridge && window.bridge.send) window.bridge.send('dnptt:log', '9router ' + res.status + ' pada model ' + model + ' -> fallback ' + fb); } catch (_) {}
        return httpJson('POST', c.baseUrl + '/v1/chat/completions', {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + c.apiKey
        }, JSON.stringify({ model: fb, messages: chatMessages, stream: false })).then(function (res2) {
          if (!res2.ok) throw new Error('9router menolak permintaan (kode ' + res2.status + ')');
          var c2 = extractContent(res2.text);
          var t12 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
          if (!opts.noRemember) rememberExchange(String(text), c2.trim());
          return { text: c2.trim(), ms: Math.round(t12 - t0), model: fb };
        });
      }
      if (!res.ok) {
        var note = String(res.text || '').slice(0, 140);
        throw new Error('9router menolak permintaan (kode ' + res.status + (note ? ': ' + note : '') + ')');
      }
      var content = extractContent(res.text);
      var t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      if (!opts.noRemember) rememberExchange(String(text), content.trim());
      return { text: content.trim(), ms: Math.round(t1 - t0), model: model };
    }).catch(function (e) {
      // our own HTTP error vs a transport failure
      if (e && e.message && e.message.indexOf('9router') === 0) throw e;
      throw new Error('tidak bisa menghubungi 9router (pastikan aplikasinya jalan)');
    });
  }

  // ---- action planning ----------------------------------------------------
  // "AI decides, DeskNotch executes". The model cannot press a key or open a
  // window, so the only thing it is allowed to produce is a plan: an ordered
  // list of tool calls. dn-voice-exec.js is the hand that runs them.
  //
  // The tool list may arrive as an array of {name, args, desc} or as an object
  // map keyed by tool name; both are normalised to one JSON shape for the
  // prompt so a caller cannot accidentally change the contract.
  function normalizeTools(tools) {
    var out = [];
    var i;
    if (Array.isArray(tools)) {
      for (i = 0; i < tools.length; i++) {
        var t = tools[i];
        if (!t) continue;
        if (typeof t === 'string') { out.push({ tool: t, args: {} }); continue; }
        if (!t.name) continue;
        out.push({ tool: String(t.name), args: t.args || {}, desc: String(t.desc || '') });
      }
    } else if (tools && typeof tools === 'object') {
      var keys = Object.keys(tools);
      for (i = 0; i < keys.length; i++) {
        var v = tools[keys[i]];
        out.push({
          tool: keys[i],
          args: (v && v.args) || {},
          desc: String((v && v.desc) || '')
        });
      }
    }
    return out;
  }

  function buildActionPrompt(tools) {
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
      '- Untuk membuka situs atau tab web (seperti YouTube, WhatsApp, GitHub, Twitter): gunakan "open_tab" dengan args {"site":"<nama situs atau url>"}. JANGAN gunakan "open_app" untuk YouTube atau situs web.',
      '- Untuk kirim pesan WhatsApp: gunakan "whatsapp" dengan args {"contact":"...","message":"..."}.',
      '- "say": satu kalimat pendek bahasa Indonesia, dibacakan lewat TTS.',
      '- Jika ucapan itu pertanyaan murni, obrolan, atau tidak butuh aksi sistem sama sekali, balas {"steps":[],"say":"<jawaban singkat>"}. Contoh: "siapa presiden indonesia" BUKAN aksi sistem, jadi steps harus kosong dan jawabannya di "say".',
      '- Jangan pernah menolak dengan alasan tidak punya izin atau akses ke laptop; DeskNotch yang mengeksekusi rencanamu.',
      '- search_file mencari NAMA FILE di Desktop/Dokumen/Download dan MENARUHNYA DI SHELF notch (tidak membuka file). Untuk "cari file X", pilih search_file.',
      '- Untuk MENGHAPUS file, WAJIB pakai tool "delete_file" dengan args {"query":"<nama file>"} — JANGAN menulis perintah shell sendiri. delete_file mencari path yang benar dulu lalu menghapus ke Recycle Bin. Jangan pernah menebak nama file.',
      '- Tool "shell" menjalankan perintah di Windows (PowerShell). Gunakan untuk hal yang tidak punya tool khusus: cek disk, ipconfig, buka folder dengan explorer, hapus file ke Recycle Bin, dll. Tulis perintah PowerShell yang valid di Windows — JANGAN pakai perintah Linux seperti find/gio/rm.',
      '- Untuk menghapus file dengan aman, gunakan shell: Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile("PATH","OnlyErrorDialogs","SendToRecycleBin")',
      '',
      'Contoh 1:',
      'User: "putar video windah basudara yang paling baru"',
      '{"steps":[{"tool":"youtube_play","args":{"query":"windah basudara","channel":"windah"}}],"say":"Memutar video terbaru Windah Basudara"}',
      '',
      'Contoh 2:',
      'User: "kirim pesan ke budi di whatsapp halo apa kabar"',
      '{"steps":[{"tool":"whatsapp","args":{"contact":"budi","message":"halo apa kabar"}}],"say":"Menyiapkan pesan WhatsApp untuk Budi"}',
      '',
      'Contoh 3:',
      'User: "buka youtube"',
      '{"steps":[{"tool":"open_tab","args":{"site":"youtube"}}],"say":"Membuka YouTube"}',
      '',
      'Contoh 4:',
      'User: "buka whatsapp di chrome"',
      '{"steps":[{"tool":"open_tab","args":{"site":"whatsapp"}}],"say":"Membuka WhatsApp di Chrome"}',
      '',
      'Contoh 4:',
      'User: "carikan CV saya"',
      '{"steps":[{"tool":"search_file","args":{"query":"CV"}}],"say":"CV kamu masuk ke shelf"}',
      '',
      'Contoh 5:',
      'User: "tolong carikan si visanya di download"',
      '{"steps":[{"tool":"search_file","args":{"query":"visa","hint":"download"}}],"say":"Mencari visa di folder Download"}',
      '',
      'Contoh 6:',
      'User: "buatkan list di notch ngedit"',
      '{"steps":[{"tool":"todo_add","args":{"text":"ngedit"}}],"say":"Ditambahkan ke to do: ngedit"}',
      '',
      'Contoh 7:',
      'User: "ingatkan meeting jam 10 pagi"',
      '{"steps":[{"tool":"reminder_add","args":{"text":"meeting","at":1772000000000}}],"say":"Diingatkan jam 10 pagi"}',
      '',
      'Contoh 8 (perintah shell):',
      'User: "cek sisa disk C"',
      '{"steps":[{"tool":"shell","args":{"cmd":"Get-PSDrive C | Select-Object Used,Free"}}],"say":"Mengecek sisa disk C"}',
      '',
      'Contoh 9 (hapus file):',
      'User: "hapus pas foto Muhammad Zacky Permana1.jpeg"',
      '{"steps":[{"tool":"delete_file","args":{"query":"Muhammad Zacky Permana1.jpeg","hint":"download"}}],"say":"Menghapus foto ke Recycle Bin"}',
      '',
      'Contoh 10:',
      'User: "siapa presiden indonesia"',
      '{"steps":[],"say":"Presiden Indonesia saat ini adalah Prabowo Subianto."}',
      '',
      'Waktu sekarang di komputer pengguna: ' + new Date().toLocaleString('id-ID', {
        weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
        hour: '2-digit', minute: '2-digit' }) + ' (WIB). Gunakan ini untuk',
      'menghitung at (ms unix) pada reminder_add dan timer — jangan menebak tanggal.',
      'Tool yang tersedia (JSON):',
      JSON.stringify(normalizeTools(tools))
    ].join('\n');
  }

  // The gateway is asked for a JSON object but may ignore response_format, and
  // models love code fences. Strip both before parsing; never throw.
  function dnCanonTool(name) {
    var t = String(name == null ? "" : name).trim().toLowerCase();
    if (!t) return "";
    var MAP = {
      powershell: "shell", pwsh: "shell", ps: "shell", terminal: "shell", cmd: "shell",
      command: "shell", run: "shell", exec: "shell", execute: "shell", bash: "shell",
      sh: "shell", shell_command: "shell", run_command: "shell", system: "shell",
      script: "shell", powershell_command: "shell",
      open: "open_app", launch: "open_app", start: "open_app", app: "open_app",
      open_application: "open_app", run_app: "open_app",
      url: "open_tab", browser: "open_tab", tab: "open_tab", open_url: "open_tab",
      open_browser: "open_tab", website: "open_tab", open_site: "open_tab",
      youtube_tab: "open_tab", browser_tab: "open_tab",
      find_file: "search_file", find: "search_file", file_search: "search_file",
      search_files: "search_file", locate: "search_file", file: "search_file",
      volume_set: "volume", sound: "volume", audio: "volume",
      play: "youtube_play", play_video: "youtube_play",
      youtube_search: "youtube", search_youtube: "youtube",
      todo: "todo_add", task: "todo_add", add_todo: "todo_add", add_task: "todo_add",
      reminder: "reminder_add", remind: "reminder_add", alarm: "reminder_add",
      add_reminder: "reminder_add",
      media_control: "media", music: "media", player: "media",
      theme_toggle: "theme", dark_mode: "theme", light_mode: "theme"
    };
    return MAP[t] || t;
  }

  // One raw step -> {tool, args}. Accepts args nested or flat, and the
  // argument spellings models actually emit (command/cmd/script/app/url/query).
  function dnNormalizeStep(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    var tool = dnCanonTool(raw.tool || raw.name || raw.action || raw.type || raw.function || raw.command_name || "");
    // A bare command with no tool name is a shell step.
    if (!tool && (raw.command || raw.cmd || raw.script)) tool = "shell";
    if (!tool) return null;
    var args = {};
    var src = (raw.args && typeof raw.args === "object" && !Array.isArray(raw.args)) ? raw.args : null;
    if (src) { for (var k in src) { if (Object.prototype.hasOwnProperty.call(src, k)) args[k] = src[k]; } }
    var FLAT = ["cmd", "command", "script", "commandline", "command_line", "shell", "app", "site", "url",
                "query", "channel", "level", "delta", "action", "contact", "message", "text", "at",
                "hint", "mode", "key", "path", "file", "name", "value"];
    for (var n = 0; n < FLAT.length; n++) {
      var fk = FLAT[n];
      if (args[fk] === undefined && raw[fk] !== undefined) args[fk] = raw[fk];
    }
    if (tool === "shell") {
      var cmd = args.cmd || args.command || args.script || args.commandline || args.command_line || args.shell || "";
      if (Array.isArray(cmd)) cmd = cmd.join(" ");
      args = { cmd: String(cmd == null ? "" : cmd) };
    }
    if (tool === "open_app" && !args.app && args.name) args.app = args.name;
    if (tool === "open_tab" && !args.site && (args.url || args.app || args.name)) args.site = args.site || args.app || args.name;
    if (tool === "search_file" && !args.query && (args.file || args.name)) args.query = args.file || args.name;
    if (tool === "todo_add" && !args.text && args.message) args.text = args.message;
    if (tool === "reminder_add" && !args.text && args.message) args.text = args.message;
    return { tool: tool, args: args };
  }

  function dnCollectSteps(json) {
    var list = [];
    if (!json) return list;
    if (Array.isArray(json)) list = json;
    else if (Array.isArray(json.steps)) list = json.steps;
    else if (Array.isArray(json.actions)) list = json.actions;
    else if (Array.isArray(json.plan)) list = json.plan;
    else if (Array.isArray(json.tools)) list = json.tools;
    else if (json.tool || json.name || json.action || json.type || json.command || json.cmd) list = [json];
    var out = [];
    for (var i2 = 0; i2 < list.length; i2++) {
      var st = dnNormalizeStep(list[i2]);
      if (st) out.push(st);
    }
    return out;
  }

  function parsePlan(content) {
    var raw = String(content == null ? "" : content).trim();
    if (!raw) return { steps: [], say: null, error: "jawaban AI kosong" };

    // reasoning models wrap their answer in <think>...</think>
    raw = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

    // prefer a fenced block if one exists, otherwise the outermost { } / [ ]
    var candidates = [];
    var fence = raw.match(/```(?:json|JSON)?\s*([\s\S]*?)\s*```/);
    if (fence && fence[1]) candidates.push(fence[1].trim());
    candidates.push(raw);
    var a1 = raw.indexOf("{"); var b1 = raw.lastIndexOf("}");
    if (a1 >= 0 && b1 > a1) candidates.push(raw.slice(a1, b1 + 1));
    var a2 = raw.indexOf("["); var b2 = raw.lastIndexOf("]");
    if (a2 >= 0 && b2 > a2) candidates.push(raw.slice(a2, b2 + 1));

    var json = null;
    for (var ci = 0; ci < candidates.length && json === null; ci++) {
      try { json = JSON.parse(candidates[ci]); } catch (_) {}
    }
    if (json === null) {
      try {
        var bridge = getBridge();
        if (bridge && bridge.send) bridge.send("dnptt:log", "parsePlan fail raw: " + JSON.stringify(raw.slice(0, 200)));
      } catch (_) {}
      return { steps: [], say: null, error: "jawaban AI bukan JSON yang valid" };
    }

    var steps = dnCollectSteps(json);
    var say = null;
    if (json && !Array.isArray(json) && typeof json === "object") {
      var cand = json.say || json.message || json.reply || json.response || json.explanation || null;
      if (typeof cand === "string" && cand.trim()) say = cand.trim();
    }
    return { steps: steps, say: say, error: steps.length ? null : "rencana AI tidak berisi langkah" };
  }

  // Never rejects: the routing layer falls back to ask() on an empty plan, so
  // an error string here is information, not a failure of the voice loop.
  // The third argument is the same options object ask() takes. An action plan
  // is a voice-loop thing, so it defaults to the voice model.
  function askAction(text, tools, opts) {
    opts = opts || {};
    var dnNoRec = !!opts.noRemember;
    var empty = function (err) { return { steps: [], say: null, error: err }; };
    if (!text || !String(text).trim()) return Promise.resolve(empty('perintahnya kosong'));
    if (!cfg.apiKey) return Promise.resolve(empty('API key 9router belum diisi'));

    var c = getConfigured();
    var model = opts.model || modelFor(opts.surface || 'voice') || c.model;
    var body = {
      model: model,
      messages: [
        { role: 'system', content: buildActionPrompt(tools) }
      ].concat(convoHistory(text), [{ role: 'user', content: String(text) }]),
      stream: false,
      // Sent as a hint. Some gateways ignore it; parsePlan copes either way.
      response_format: { type: 'json_object' }
    };

    return httpJson('POST', c.baseUrl + '/v1/chat/completions', {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + c.apiKey
    }, JSON.stringify(body)).then(function (res) {
      if (!res.ok && (res.status === 400 || res.status === 404 || res.status >= 500)) {
        var fb = (cfg.convoModel && cfg.convoModel !== model) ? cfg.convoModel : 'kr/claude-haiku-4.5';
        try { if (window.bridge && window.bridge.send) window.bridge.send('dnptt:log', '9router ' + res.status + ' pada model ' + model + ' -> fallback ' + fb); } catch (_) {}
        var body2 = JSON.parse(JSON.stringify(body)); body2.model = fb;
        return httpJson('POST', c.baseUrl + '/v1/chat/completions', {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + c.apiKey
        }, JSON.stringify(body2)).then(function (res2) {
          if (!res2.ok) return empty('9router menolak permintaan (kode ' + res2.status + ')');
          var c2 = extractContent(res2.text);
          if (!c2) return empty('jawaban 9router tidak bisa dibaca');
          return parsePlan(c2);
        });
      }
      if (!res.ok) {
        var note = String(res.text || '').slice(0, 140);
        return empty('9router menolak permintaan (kode ' + res.status + (note ? ': ' + note : '') + ')');
      }
      var content = extractContent(res.text);
      if (!content) return empty('jawaban 9router tidak bisa dibaca');
      var plan = parsePlan(content);
      try {
        var convo = window.dnConvo;
        // only what is spoken back is worth keeping, not the plan JSON
        if (!dnNoRec && convo && typeof convo.remember === 'function' && plan && plan.say) {
          convo.remember('assistant', plan.say);
        }
      } catch (_) {}
      return plan;
    }).catch(function () {
      return empty('tidak bisa menghubungi 9router (pastikan aplikasinya jalan)');
    });
  }

  // ---- public API ---------------------------------------------------------

  function isConfigured() {
    return loaded && !!cfg.apiKey;
  }

  function configure(next) {
    next = next || {};
    if (next.baseUrl !== undefined) cfg.baseUrl = normalizeBase(next.baseUrl);
    if (next.model !== undefined) cfg.model = String(next.model || '');
    // The per-surface models are independent of the shared fallback: an
    // explicit empty string clears that surface's pick and sends it back to
    // cfg.model.
    if (next.voiceModel !== undefined) cfg.voiceModel = String(next.voiceModel || '');
    if (next.convoModel !== undefined) cfg.convoModel = String(next.convoModel || '');
    // An empty apiKey means "leave the stored key alone", not "delete it".
    // The settings panel cannot show the saved key (it is a password field and
    // peek() masks it), so re-saving the form without retyping the key would
    // otherwise wipe a working configuration.
    var keyProvided = next.apiKey !== undefined && String(next.apiKey || '').trim() !== '';
    if (keyProvided) cfg.apiKey = String(next.apiKey).trim();

    var seal = getBridge();
    // The per-surface models are only written when this call actually set
    // them. A settings-panel save must not wipe a pick that was made earlier
    // through /model-voice or /model-chat.
    var modelPatch = {};
    if (next.voiceModel !== undefined) modelPatch.dnRouterVoiceModel = cfg.voiceModel;
    if (next.convoModel !== undefined) modelPatch.dnRouterConvoModel = cfg.convoModel;
    var persist = Promise.resolve(false);
    if (seal && seal.invoke) {
      persist = Promise.resolve(keyProvided
        ? seal.invoke('dnrouter:seal', cfg.apiKey).catch(function () { return null; })
        : null
      ).then(function (sealed) {
        var patch = {
          dnRouterBaseUrl: cfg.baseUrl,
          dnRouterModel: cfg.model
        };
        for (var mk in modelPatch) {
          if (Object.prototype.hasOwnProperty.call(modelPatch, mk)) patch[mk] = modelPatch[mk];
        }
        if (sealed) patch.dnRouterKeySealed = sealed;
        else if (keyProvided) patch.dnRouterKey = cfg.apiKey;   // fallback: plaintext store
        return writeSettings(patch);
      });
    } else {
      var patch2 = {
        dnRouterBaseUrl: cfg.baseUrl,
        dnRouterModel: cfg.model
      };
      for (var mk2 in modelPatch) {
        if (Object.prototype.hasOwnProperty.call(modelPatch, mk2)) patch2[mk2] = modelPatch[mk2];
      }
      if (keyProvided) patch2.dnRouterKey = cfg.apiKey;
      persist = writeSettings(patch2);
    }
    return persist.then(function () {
      try { console.log('[dnRouter] disimpan, key ' + maskKey(cfg.apiKey)); } catch (_) {}
      return true;
    });
  }

  // Tes koneksi: models list is enough to prove the gateway is up and the key
  // is accepted. Never throws — the result object is the contract.
  function test() {
    if (!cfg.apiKey) return Promise.resolve({ ok: false, error: 'API key 9router belum diisi' });
    var c = getConfigured();
    return httpJson('GET', c.baseUrl + '/v1/models', { 'Authorization': 'Bearer ' + c.apiKey })
      .then(function (res) {
        if (!res.ok) return { ok: false, error: '9router menolak permintaan (kode ' + res.status + ')' };
        var json;
        try { json = JSON.parse(res.text); } catch (_) { return { ok: true, models: [] }; }
        var ids = [];
        var data = json && json.data;
        if (Array.isArray(data)) {
          for (var i = 0; i < data.length; i++) { if (data[i] && data[i].id) ids.push(String(data[i].id)); }
        }
        return { ok: true, models: ids };
      }).catch(function () {
        return { ok: false, error: 'tidak bisa menghubungi 9router (pastikan aplikasinya jalan)' };
      });
  }

  // dnOpenUrlSmart: opens URL with tab reuse for pure-root URLs
  // and navigation for query/path URLs without opening duplicate tabs.
  function isPureRootUrl(u) {
    try {
      var parsed = new URL(u);
      return (parsed.pathname === '/' || parsed.pathname === '') && !parsed.search && !parsed.hash;
    } catch (_) {
      return false;
    }
  }

  function dnOpenUrlSmart(raw) {
    var u = String(raw || '').trim();
    if (!u) return Promise.resolve({ ok: false, error: 'url kosong' });
    if (!/^https?:\/\//i.test(u)) {
      var low = u.toLowerCase();
      var knownMap = {
        youtube: 'https://www.youtube.com',
        whatsapp: 'https://web.whatsapp.com',
        gmail: 'https://mail.google.com',
        github: 'https://github.com',
        telegram: 'https://web.telegram.org',
        instagram: 'https://www.instagram.com',
        twitter: 'https://x.com',
        maps: 'https://maps.google.com',
        drive: 'https://drive.google.com',
        calendar: 'https://calendar.google.com'
      };
      if (knownMap[low]) {
        u = knownMap[low];
      } else if (/^[a-zA-Z0-9._-]+\.[a-z]{2,8}(?:\/[^\s]*)?$/i.test(u)) {
        u = 'https://' + u;
      } else {
        u = 'https://' + u.replace(/\s+/g, '') + '.com';
      }
    }
    var b = getBridge();
    if (b && typeof b.invoke === 'function') {
      return b.invoke('app:open-url', u).then(function (res) {
        var ok = res === true || !!(res && res.ok);
        var reused = !!(res && res.reused);
        var tab = res && res.tab ? res.tab : null;
        var navigated = !!(res && res.navigated);
        return { ok: ok, reused: reused, tab: tab, navigated: navigated, url: u };
      }).catch(function (e) {
        return { ok: false, error: String(e && e.message ? e.message : e) };
      });
    }
    return Promise.resolve({ ok: false, error: 'bridge unavailable' });
  }

  window.dnOpenUrlSmart = dnOpenUrlSmart;

  window.dnRouter = {
    configure: configure,
    isConfigured: isConfigured,
    listModels: listModels,
    ask: ask,
    askAction: askAction,
    parsePlan: parsePlan,
    openUrlSmart: dnOpenUrlSmart,
    test: test,
    DEFAULTS: DEFAULTS,
    // read-back of the in-memory config, key masked — for the settings UI only
    // The optional surface argument resolves to the model that surface would
    // actually use, so a caller can show "voice: X, chat: Y" without
    // repeating the fallback rule.
    peek: function (surface) {
      return {
        baseUrl: cfg.baseUrl,
        model: cfg.model,
        voiceModel: cfg.voiceModel,
        convoModel: cfg.convoModel,
        surfaceModel: modelFor(surface),
        configured: isConfigured()
      };
    }
  };

  loadStored();
})();
