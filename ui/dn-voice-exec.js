// dn-voice-exec.js - turns a parsed intent into an actual action, and routes
// free-form questions to the 9router brain when no intent matches.
//
// Split from dn-voice-ptt.js on purpose: that file owns the microphone and the
// VAD state machine, this one owns what happens after the text exists. Keeping
// them apart means a broken action cannot kill the recorder.
(function () {
  if (window.dnVoiceExec) return;

  var bridge = window.bridge;

  function elog(msg) {
    try { console.log("[dnExec] " + msg); } catch (_) {}
    try { if (bridge && bridge.send) bridge.send("dnptt:log", String(msg)); } catch (_) {}
  }

  // The schema handed to the model. It is the only vocabulary the AI has: if a
  // tool is not here, no plan can name it, and runTool refuses it anyway.
  var TOOLS = [
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
    { name: 'search_file', args: { query: 'string', hint: 'download|documents|desktop?' }, desc: 'cari file di komputer (Desktop/Dokumen/Download) dan buka yang paling cocok, misal CV; hint membatasi folder pencarian' },
    { name: 'todo_add', args: { text: 'string' }, desc: 'tambah satu tugas ke daftar to do di notch' },
    { name: 'reminder_add', args: { text: 'string', at: 'number' }, desc: 'pasang pengingat; at = waktu target ms unix' },
    { name: 'shell', args: { cmd: 'string' }, desc: 'jalankan perintah shell/PowerShell di laptop setelah pengguna menyetujui kartu izin; pakai untuk cek sistem, buka folder, jalankan skrip' }
    ,{ name: 'delete_file', args: { query: 'string', hint: 'download|documents|desktop?' }, desc: 'hapus file ke Recycle Bin; cari dulu berdasarkan nama supaya path-nya tepat' }
  ];

  function setUi(status, text, steps) {
    try {
      var u = { status: status, text: text || "" };
      if (steps) u.steps = steps;
      if (globalThis.dnVoiceUi) globalThis.dnVoiceUi(u);
    } catch (_) {}
  }

  // bridge.invoke forwards every extra argument to ipcMain, so store:set needs
  // both its key and its value. Passing only the payload silently wrote
  // undefined and the todo never appeared.
  function invoke(channel) {
    if (!bridge || typeof bridge.invoke !== 'function') {
      return Promise.reject(new Error('bridge tidak tersedia'));
    }
    var args = Array.prototype.slice.call(arguments, 1);
    try { return Promise.resolve(bridge.invoke.apply(bridge, [channel].concat(args))); }
    catch (e) { return Promise.reject(e); }
  }

  var dnSilent = false;
  function say(text) {
    if (dnSilent) return;
    // TTS is independent of the STT switch: a confirmation must still be
    // spoken when the model has been turned off.
    try {
      if (window.dnVoice && typeof window.dnVoice.speak === 'function') {
        window.dnVoice.speak(String(text));
      }
    } catch (_) {}
  }

  function label(parsed) {
    if (parsed && parsed.label) return parsed.label;
    if (parsed && parsed.app) return parsed.app;
    return '';
  }

  // The parser emits canonical keys (every key in dn-intent.js APPS), but
  // Windows knows apps by display names ("Google Chrome") or AUMIDs, never by
  // those keys. These are the strings to look for instead: brand name plus the
  // display-name variants, including the Indonesian ones Windows ships
  // ("Kalkulator", "Pengaturan") because the app list follows the OS language.
  var APP_TERMS = {
    zcode: ['zcode', 'z code', 'dev.zcode.app'],
    amd: ['amd', 'amd software', 'radeon'],
    chrome: ['chrome', 'google chrome'],
    edge: ['edge', 'microsoft edge'],
    firefox: ['firefox', 'mozilla firefox'],
    notepad: ['notepad', 'notepad++'],
    word: ['word', 'microsoft word'],
    excel: ['excel', 'microsoft excel'],
    powerpoint: ['powerpoint', 'microsoft powerpoint'],
    spotify: ['spotify'],
    youtube: ['youtube'],
    whatsapp: ['whatsapp'],
    telegram: ['telegram'],
    discord: ['discord'],
    steam: ['steam'],
    vscode: ['visual studio code', 'vs code', 'code'],
    explorer: ['file explorer', 'explorer', 'windows explorer'],
    kalkulator: ['calculator', 'kalkulator'],
    pengaturan: ['settings', 'setelan', 'pengaturan'],
    taskmgr: ['task manager', 'taskmgr'],
    paint: ['paint', 'ms paint'],
    canva: ['canva'],
    figma: ['figma'],
    notion: ['notion'],
    obsidian: ['obsidian'],
    zoom: ['zoom'],
    teams: ['teams', 'microsoft teams'],
    gmail: ['gmail', 'google mail'],
    github: ['github', 'github desktop']
  };

  // How well one lowercased name matches one term: 3 exact, 2 prefix, 1
  // substring. Exact must win because "chrome" also prefixes "Chrome Beta",
  // and only the exact tier keeps the plain app ahead of its variants.
  function nameTier(lowName, term) {
    if (!term) return 0;
    if (lowName === term) return 3;
    if (lowName.indexOf(term) === 0) return 2;
    if (lowName.indexOf(term) > 0) return 1;
    return 0;
  }

  // Picks the list item whose name best matches any term. Ties go to the
  // earlier entry, so the shell's own ordering still breaks equal matches.
  function bestMatch(list, terms) {
    if (!Array.isArray(list)) return null;
    var best = null;
    var bestTier = 0;
    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      var lowName = String((item && item.name) || '').toLowerCase();
      if (!lowName) continue;
      for (var j = 0; j < terms.length; j++) {
        var tier = nameTier(lowName, terms[j]);
        if (tier > bestTier) {
          best = item;
          bestTier = tier;
          // an exact name cannot be beaten, stop scanning
          if (tier === 3) return best;
        }
      }
    }
    return best;
  }

  // ---- per-intent handlers -------------------------------------------------
  // Each returns a Promise resolving to a short Indonesian confirmation, or
  // rejecting with a message that is safe to show to the user.

  var handlers = {};

  handlers.open_app = function (p) {
    // The parser emits a canonical key ("chrome"), but apps:describe matches
    // ids exactly and apps:launch only takes a real path or AUMID, so a bare
    // key can never resolve on its own. Search terms widen the first probe;
    // the full app list matches display names when no id did.
    var name = label(p);
    if (!name) return Promise.reject(new Error('nama aplikasi tidak dikenali'));
    var terms = APP_TERMS[p.app] ? APP_TERMS[p.app] : [String(p.app || '').toLowerCase()];
    return invoke('apps:describe', terms).then(function (list) {
      // apps:describe answers only when one of the terms IS a known id, so
      // any hit is already canonical; bestMatch just prefers the best one
      // when several terms resolve at once.
      var hit = bestMatch(list, terms) || (Array.isArray(list) ? list[0] : null);
      if (hit) return hit;
      return invoke('apps:all').then(function (all) {
        return bestMatch(all, terms);
      });
    }).then(function (item) {
      if (!item) {
        // If app is not an installed desktop app but has a known web URL (like WhatsApp, YouTube),
        // seamlessly fall back to open_tab instead of throwing an error!
        if (WEB_URLS && WEB_URLS[p.app]) {
          elog('open_app: "' + p.app + '" not in desktop apps, fallback to open_tab');
          return handlers.open_tab({ app: p.app, label: name });
        }
        throw new Error(name + ' tidak ditemukan di aplikasi terinstal');
      }
      var id = item.id || item.path;
      // launch accepts an id or a path, and some resolvers only fill one of
      // the two; a rejected id gets exactly one retry on the raw path.
      return invoke('apps:launch', id, item.name || name).then(undefined, function (e) {
        if (item.path && item.path !== id) return invoke('apps:launch', item.path, item.name || name);
        throw e;
      });
    }).then(function () {
      return 'Membuka ' + name;
    });
  };

  // "buka tab X" opens a browser tab for a site, so apps:launch is the wrong
  // channel. There was no generic URL channel in main (only the hardcoded
  // app:open-repo and settings:open-startup), so main gained "app:open-url":
  // it guards ^https?:// and calls shell.openExternal. Known sites get their
  // real web URL; everything else falls back to https://<name>.com.
  var WEB_URLS = {
    whatsapp: 'https://web.whatsapp.com',
    youtube: 'https://www.youtube.com',
    gmail: 'https://mail.google.com',
    github: 'https://github.com',
    telegram: 'https://web.telegram.org',
    instagram: 'https://www.instagram.com',
    twitter: 'https://x.com',
    maps: 'https://maps.google.com',
    drive: 'https://drive.google.com',
    calendar: 'https://calendar.google.com'
  };

  handlers.open_tab = function (p) {
    var key = String(p.app || p.site || p.query || '').toLowerCase().trim();
    if (!key && !p.url) return Promise.reject(new Error('nama situs kosong'));
    // runTool('open_tab') hands over a full URL or bare domain it already
    // recognized; a bare site key goes through the WEB_URLS map as before.
    var url = String(p.url || '') || WEB_URLS[key] || (/^[a-zA-Z0-9._-]+\.[a-z]{2,8}/i.test(key) ? ('https://' + key) : ('https://' + key.replace(/\s+/g, '') + '.com'));
    var smartFn = window.dnOpenUrlSmart || function (u) { return invoke('app:open-url', u); };
    return smartFn(url).then(function (res) {
      // main answers {ok, reused, tab}; a bare boolean is an older main, where
      // true means the URL was handed to the shell and false the guard said no.
      var ok = res === true || !!(res && res.ok);
      var name = p.label || key;
      if (!ok) throw new Error('tidak bisa membuka ' + name);
      if (res && res.reused) {
        // "(85) WhatsApp - Memory usage - 490 MB" -> "WhatsApp": the UI suffixes
        // are noise in a spoken confirmation. The tab search in main already
        // selected the tab and brought its window up, so no focus step here.
        var rawTab = String(res.tab || '');
        var tabName = rawTab.split(/\s+-\s+/)[0].replace(/^\(\d+\)\s*/, '').trim() || name;
        if (/youtube/i.test(rawTab) || key === 'youtube') tabName = 'YouTube';
        else if (/whatsapp/i.test(rawTab) || key === 'whatsapp') tabName = 'WhatsApp';
        return 'Tab ' + tabName + ' sudah terbuka';
      }
      // Focus is cosmetic: openExternal already woke the default browser and a
      // failed focus must never fail the command. Fired, not awaited — waiting
      // out the 600 ms would only delay the spoken confirmation.
      setTimeout(function () {
        invoke('app:focus-window', key.split(/[^\w-]+/)[0]).then(undefined, function () {});
      }, 600);
      dnCtxRecord(key, name);
      return 'Membuka tab ' + name;
    });
  };

  handlers.todo_add = function (p) {
    var text = String(p.text || '').trim();
    if (!text) return Promise.reject(new Error('isi tugas kosong'));
    // Read-modify-write: store:set replaces the whole object, so the existing
    // list has to be merged rather than overwritten.
    return invoke('store:get', 'todos').then(function (todos) {
      var list = Array.isArray(todos) ? todos.slice() : [];
      // The notch Tasks panel renders item.label and filters item.done; its
      // own items use crypto.randomUUID ids. Matching that shape is what makes
      // a spoken todo actually appear (r51 and earlier wrote .text and the
      // panel showed "All done" forever).
      list.push({
        id: 'dnv-' + Date.now(),
        label: text,
        done: false
      });
      return invoke('store:set', 'todos', list);
    }).then(function () {
      return 'Ditambahkan ke to do: ' + text;
    });
  };

  handlers.todo_list = function () {
    return invoke('store:get', 'todos').then(function (todos) {
      var list = Array.isArray(todos) ? todos.filter(function (t) { return !t.done; }) : [];
      if (!list.length) return 'Belum ada tugas.';
      var names = list.slice(0, 5).map(function (t) { return t.text; }).join(', ');
      return 'Tugas kamu: ' + names + (list.length > 5 ? ', dan ' + (list.length - 5) + ' lainnya' : '');
    });
  };

  // Runs a shell command through main's dn:shell (approval already happened
  // at plan level). The handler is deliberately thin: main owns the deny-list,
  // timeout and output cap.
  // Deleting by name must resolve the real path first: the model guesses
  // filenames ("...Permana1.jpeg" vs "...Permana.jpeg") and a wrong guess
  // reports "exit 0 File not found" while nothing is deleted.
  handlers.delete_file = function (p) {
    var q = String(p.query || "").trim();
    if (!q) return Promise.reject(new Error("nama file kosong"));
    var req = { query: q };
    if (p.hint) req.hint = String(p.hint);
    return invoke("files:search", req).then(function (hits) {
      if (!hits || !hits.length) throw new Error("file tidak ditemukan: " + q);
      var top = hits[0];
      var ps = "Add-Type -AssemblyName Microsoft.VisualBasic; " +
        "[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile(" +
        JSON.stringify(top.path) + ",'OnlyErrorDialogs','SendToRecycleBin')";
      return invoke("dn:shell", { cmd: ps }).then(function (r) {
        if (r && r.ok) return "Dihapus ke Recycle Bin: " + top.name;
        var o = r && r.out ? String(r.out).trim() : "";
        throw new Error("gagal menghapus " + top.name + (o ? ": " + o.slice(0, 120) : ""));
      });
    });
  };

  handlers.shell = function (p) {
    var cmd = String((p && p.cmd) || '').trim();
    if (!cmd) return Promise.reject(new Error('perintah kosong'));
    return invoke('dn:shell', { cmd: cmd }).then(function (r) {
      if (!r || typeof r !== 'object') return 'perintah selesai';
      var out = String(r.out || '').trim();
      if (r.ok) return out ? ('exit 0\n' + out) : 'perintah selesai tanpa keluaran';
      return 'gagal (exit ' + r.code + ')' + (out ? '\n' + out : '');
    });
  };

  handlers.reminder_add = function (p) {
    var text = String(p.text || '').trim();
    // "Buat reminder jam 2 siang" carries no message and that is fine: the
    // notch form itself marks Message optional. Default the label instead of
    // rejecting, so a bare time reminder still lands in the notch.
    if (!text) text = 'Pengingat';
    var at = p.at || {};
    var due = at.type === 'relative' ? Date.now() + Number(at.ms || 0)
      : (at.ts || Date.now() + 60 * 60 * 1000);
    return invoke('store:get', 'reminders').then(function (rem) {
      var list = Array.isArray(rem) ? rem.slice() : [];
      // The reminder manager sorts by .at and shows due = first at <= now;
      // .message is what the card renders. (.text/.due never fired a card.)
      list.push({ id: 'dnr-' + Date.now(), at: due, message: text });
      return invoke('store:set', 'reminders', list);
    }).then(function () {
      var d = new Date(due);
      var hh = ('0' + d.getHours()).slice(-2);
      var mm = ('0' + d.getMinutes()).slice(-2);
      return 'Diingatkan jam ' + hh + '.' + mm + ': ' + text;
    });
  };

  handlers.timer = function (p) {
    var ms = Number(p.ms || 0);
    if (!ms || ms < 1000) return Promise.reject(new Error('durasi timer tidak valid'));
    var due = Date.now() + ms;
    return invoke('store:get', 'reminders').then(function (rem) {
      var list = Array.isArray(rem) ? rem.slice() : [];
      list.push({ id: 'dnt-' + Date.now(), text: 'Timer', due: due, fired: false });
      return invoke('store:set', 'reminders', list);
    }).then(function () {
      var min = Math.round(ms / 60000);
      return 'Timer ' + min + ' menit dipasang';
    });
  };

  // The notch's files tray. It is a plain array of absolute paths in the
  // store, and the chunk reads it back through files:describe to render the
  // panel, so pushing here is all it takes for the file to show up ready to
  // drag or paste. Capped because the tray is a quick-access strip, not a
  // library.
  var SHELF_KEY = 'shelf';
  var SHELF_MAX = 20;

  // Best effort: a missing store must never fail a search that already opened
  // the right document.
  function addToShelf(path) {
    if (!path) return Promise.resolve(false);
    return invoke('store:get', SHELF_KEY).then(function (cur) {
      var list = Array.isArray(cur) ? cur.slice() : [];
      if (list.indexOf(path) >= 0) return false;
      list.unshift(path);
      if (list.length > SHELF_MAX) list = list.slice(0, SHELF_MAX);
      return invoke('store:set', SHELF_KEY, list).then(function () { return true; });
    }).catch(function () { return false; });
  }

  handlers.search_file = function (p) {
    var q = String(p.query || '').trim();
    if (!q) return Promise.reject(new Error('kata kunci kosong'));
    // files:search walks Desktop/Documents/Downloads on disk. The old version
    // called apps:describe — installed APPS — which is why "carikan CV saya"
    // never found anything. The best hit is opened directly so the user sees
    // the document, not just a spoken list.
    //
    // p.hint narrows the walk ("di download" -> download) and is forwarded as
    // a second field; an older main ignores it and still searches everything.
    var req = { query: q };
    if (p.hint) req.hint = String(p.hint);
    return invoke('files:search', req).then(function (hits) {
      if (!hits || !hits.length) throw new Error('tidak ada file yang cocok dengan ' + q);
      var top = hits[0];
      // "carikan file" means put it on the notch shelf. Opening it hijacked
      // the screen and whatever app was in front, which the user did not ask
      // for; the shelf row is the deliverable.
      return addToShelf(top.path).then(function () {
        var extra = hits.length > 1 ? ' (+' + (hits.length - 1) + ' lain)' : '';
        return 'Masuk shelf: ' + top.name + extra;
      }, function () {
        return 'Ditemukan: ' + top.name;
      });
    });
  };

  handlers.volume = function (p) {
    // system:volume is owned by main.js and may not be in this build yet. Ask
    // for it and translate a missing channel into an honest sentence instead of
    // pretending the volume moved. No level and no delta is a plain read.
    var args = {};
    var level = p && p.level !== undefined && p.level !== null && p.level !== '' ? Number(p.level) : null;
    var delta = p && p.delta !== undefined && p.delta !== null && p.delta !== '' ? Number(p.delta) : null;
    if (level !== null && isFinite(level)) args.level = Math.max(0, Math.min(100, Math.round(level)));
    if (delta !== null && isFinite(delta)) args.delta = Math.round(delta);
    return invoke('system:volume', args).then(function (r) {
      // A stub or an unregistered channel answers null/undefined; that is not
      // evidence the volume changed.
      if (r === null || r === undefined || r === false) {
        throw new Error('kontrol volume belum tersedia');
      }
      // The level read back is what main actually applied, so a clamped or
      // relative request still confirms the real number.
      if (r && typeof r.level === 'number' && isFinite(r.level)) {
        var lvl = Math.round(r.level);
        if (typeof args.delta === 'number' && args.delta !== 0) {
          return (args.delta > 0 ? 'Volume dinaikkan ke ' : 'Volume diturunkan ke ') + lvl + ' persen';
        }
        if (typeof args.level === 'number') return 'Volume ' + lvl + ' persen';
        return 'Volume sekarang ' + lvl + ' persen';
      }
      return 'Volume diubah';
    }, function () {
      throw new Error('kontrol volume belum tersedia');
    });
  };

  // media_control: play/pause/next/previous ride the persistent media-key
  // sender that already lives in main (media:key) — no new IPC channel. Windows
  // has no stop key worth sending, so stop maps to play-pause too.
  var MEDIA_CONFIRM = {
    'play-pause': 'Putar atau jeda media',
    next: 'Lagu berikutnya',
    previous: 'Lagu sebelumnya'
  };
  handlers.media_control = function (p) {
    var action = mediaAction(p && p.action);
    if (!action) return Promise.reject(new Error('aksi media tidak dikenali'));
    return invoke('media:key', action).then(function () {
      return MEDIA_CONFIRM[action];
    });
  };

  // ---- action-plan tool handlers -------------------------------------------
  // These back the tools dn-router.askAction() may choose. Every one returns a
  // short Indonesian confirmation or rejects with a message safe to speak.

  // Resolves the newest video for a channel and opens it directly. The
  // search + parse runs in main.js (the renderer is CORS-blocked), and it
  // sorts by parsed upload age because YouTube pins an undated result at
  // position 1 - taking "the first result" plays the wrong video.
  handlers.youtube_play = function (p) {
    var q = String((p && p.query) || '').trim();
    if (!q) return Promise.reject(new Error('kata kunci YouTube kosong'));
    var ch = String((p && p.channel) || '').trim().toLowerCase();
    return invoke('youtube:search', { query: q, channel: ch, newest: true }).then(function (r) {
      if (!r || !r.ok || !r.video || !r.video.id) {
        throw new Error((r && r.error) || ('tidak ada video untuk ' + q));
      }
      var v = r.video;
      var url = 'https://www.youtube.com/watch?v=' + v.id;
      var smartFn = window.dnOpenUrlSmart || function (u) { return invoke('app:open-url', u); };
      return smartFn(url).then(function () {
        var label = v.title ? String(v.title).replace(/\s+/g, ' ').trim() : q;
        if (label.length > 60) label = label.slice(0, 57) + '...';
        dnCtxRecord('youtube.com', 'YouTube');
        return 'Memutar: ' + label;
      });
    });
  };

  handlers.youtube = function (p) {
    var q = String((p && p.query) || '').trim();
    if (!q) return Promise.reject(new Error('kata kunci YouTube kosong'));
    // Search results only. Auto-clicking the first result is fragile: the layout
    // changes, ads appear, and a misheard query plays the wrong video loudly.
    var url = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(q);
    var smartFn = window.dnOpenUrlSmart || function (u) { return invoke('app:open-url', u); };
    return smartFn(url).then(function (res) {
      var ok = res === true || !!(res && res.ok);
      if (!ok) throw new Error('tidak bisa membuka YouTube');
      dnCtxRecord('youtube.com', 'YouTube');
      return 'Mencari ' + q + ' di YouTube';
    });
  };

  handlers.spotify = function (p) {
    var q = String((p && p.query) || '').trim();
    if (!q) return Promise.reject(new Error('judul lagu kosong'));
    var enc = encodeURIComponent(q);
    // app:open-uri only allowlists spotify: schemes, so it cannot be abused to
    // launch anything else. If main has no such channel (or refuses), the web
    // player is the honest fallback.
    var fallback = function () {
      return invoke('app:open-url', 'https://open.spotify.com/search/' + enc).then(function (ok2) {
        if (!ok2) throw new Error('tidak bisa membuka Spotify');
        return 'Mencari ' + q + ' di Spotify';
      });
    };
    return invoke('app:open-uri', 'spotify:search:' + enc).then(function (ok) {
      if (ok) return 'Memutar ' + q + ' di Spotify';
      return fallback();
    }, fallback);
  };

  handlers.whatsapp = function (p) {
    var message = String((p && p.message) || '').trim();
    if (!message) return Promise.reject(new Error('pesan WhatsApp kosong'));
    var contact = String((p && p.contact) || '').trim();
    var digits = contact.replace(/[^\d]/g, '');
    var isPhone = digits.length >= 8 && /^[+\d\s().-]+$/.test(contact);

    // Request permission from the user via the native DeskNotch approval card!
    var promptTitle = 'Kirim WhatsApp ke ' + (contact || 'Kontak');
    var promptDetail = message;
    var askApproval = function () {
      if (bridge && typeof bridge.invoke === 'function') {
        return invoke('dnai:request-approval', {
          title: promptTitle,
          detail: promptDetail,
          tool: 'whatsapp'
        }).then(function (r) { return r !== false; }).catch(function () { return true; });
      }
      return Promise.resolve(true);
    };

    return askApproval().then(function (approved) {
      if (!approved) {
        elog('WhatsApp message cancelled by user');
        throw new Error('pengiriman WhatsApp dibatalkan');
      }
      // Preferred: drive the EXISTING WhatsApp tab (search contact, open
      // chat, paste message, Enter) — no new tab, no share dialog. Only when
      // no WhatsApp tab is open do we fall back to the send URL.
      var drive = invoke('app:whatsapp-send', { contact: contact, message: message }).then(function (r) {
        if (r && r.ok) return 'Pesan WhatsApp terkirim ke ' + contact;
        // A missing channel (older main.js) or a missing tab both fall back to
        // the send URL; only a concrete mid-send failure surfaces as an error.
        if (!r) return null;
        var why = r.reason || 'failed';
        if (why === 'no-tab' || why === 'nobrowser' || why === 'nowin') return null;
        throw new Error('tidak bisa mengirim lewat tab WhatsApp (' + why + ')');
      });
      return drive.then(function (done2) {
        if (done2) return done2;
        var url = isPhone
          ? 'https://web.whatsapp.com/send?phone=' + digits + '&text=' + encodeURIComponent(message)
          : 'https://web.whatsapp.com/send?text=' + encodeURIComponent(message);
        return invoke('app:open-url', url).then(function (res) {
          var ok = (res === true || (res && res.ok));
          if (!ok) throw new Error('tidak bisa membuka WhatsApp');
          return 'Menyiapkan pesan WhatsApp untuk ' + contact;
        });
      });
    });
  };

  handlers.type_text = function (p) {
    var text = String((p && p.text) || '');
    if (!text.trim()) return Promise.reject(new Error('teks kosong'));
    if (!window.dnPtt || typeof window.dnPtt.pasteToFocus !== 'function') {
      return Promise.reject(new Error('tempel teks belum siap'));
    }
    return window.dnPtt.pasteToFocus(text).then(function (r) {
      if (r && r.ok) return 'Teks ditempel';
      return 'Teks disalin, tekan Ctrl V';
    });
  };

  // main.js allowlist. Deliberately narrow: a misheard command must not be able
  // to fire Alt+F4. Keys outside this list are refused out loud, never dropped.
  var ALLOWED_KEYS = [
    'ctrl+s', 'ctrl+c', 'ctrl+v', 'ctrl+z', 'ctrl+a',
    'enter', 'esc', 'tab', 'space', 'backspace', 'up', 'down', 'left', 'right'
  ];

  function normalizeKey(raw) {
    var k = String(raw || '').toLowerCase().trim()
      .replace(/\s*\+\s*/g, '+')
      .replace(/\s+/g, ' ');
    // "escape" and "return" are what people (and models) say; main knows the
    // short names only. "control+s" is the same combo as "ctrl+s".
    if (k === 'escape') k = 'esc';
    if (k === 'return') k = 'enter';
    k = k.replace(/^control\+/, 'ctrl+');
    return k;
  }

  handlers.press_key = function (p) {
    var key = normalizeKey(p && p.key);
    if (!key) return Promise.reject(new Error('tombol kosong'));
    if (ALLOWED_KEYS.indexOf(key) < 0) {
      return Promise.reject(new Error('tombol "' + key + '" belum didukung'));
    }
    return invoke('app:send-keys', { key: key }).then(function (r) {
      if (r && r.ok) return 'Menekan ' + key;
      var why = r && r.reason ? String(r.reason) : 'kirim tombol belum tersedia';
      if (why === 'tombol tidak diizinkan') why = 'tombol "' + key + '" belum didukung';
      throw new Error(why);
    }, function () {
      // No handler registered in main for this build.
      throw new Error('kirim tombol belum tersedia');
    });
  };

  // ---- action plan runner ---------------------------------------------------
  // Contract: runPlan(plan, onStep) -> Promise<string>
  //   * steps run strictly one after another, ~700 ms apart so the UI settles
  //   * at most MAX_STEPS (6) steps are ever executed
  //   * resolves with a summary sentence; on a failed step it resolves with a
  //     sentence naming that step and never runs the rest
  //   * an empty plan resolves to '' and touches nothing
  var MAX_STEPS = 6;
  var STEP_DELAY = 700;

  function notifyStep(onStep, i, total, tool, status) {
    try { if (typeof onStep === 'function') onStep(i, total, tool, status); } catch (_) {}
  }

  function delay(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function mediaAction(raw) {
    var a = String(raw || '').toLowerCase().trim();
    if (a === 'play' || a === 'pause' || a === 'toggle' || a === 'playpause' || a === 'play-pause' || a === 'stop') return 'play-pause';
    if (a === 'next' || a === 'skip' || a === 'lanjut') return 'next';
    if (a === 'previous' || a === 'prev' || a === 'back' || a === 'sebelumnya') return 'previous';
    return '';
  }

  // One tool -> one promise. handlers are looked up at call time so a handler
  // another build/agent adds later is picked up without touching this map.
  function runTool(tool, args) {
    var a = args || {};
    if (tool === 'shell') return handlers.shell(a);
    if (tool === 'delete_file') return handlers.delete_file(a);
    if (tool === 'open_app') {
      var app = String(a.app || '').trim();
      if (!app) return Promise.reject(new Error('nama aplikasi kosong'));
      return handlers.open_app({ app: app.toLowerCase(), label: a.label || app });
    }
    if (tool === 'open_tab') {
      var site = String(a.site || a.app || '').trim();
      if (!site) return Promise.reject(new Error('nama situs kosong'));
      // The model may hand over a full URL or a bare domain; both must open the
      // right thing instead of becoming https://google.com.com. The invoke goes
      // through handlers.open_tab so reused tabs and the focus step behave the
      // same as the spoken "buka tab X" path.
      var url = a.url ? String(a.url) : '';
      if (!url) {
        if (/^https?:\/\//i.test(site)) url = site;
        else if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(site)) url = 'https://' + site;
      }
      return handlers.open_tab({ app: site.toLowerCase(), label: a.label || site, url: url || undefined });
    }
    if (tool === 'volume') {
      if (typeof handlers.volume !== 'function') return Promise.reject(new Error('kontrol volume belum tersedia'));
      return handlers.volume(a);
    }
    if (tool === 'media') {
      var action = mediaAction(a.action);
      if (!action) return Promise.reject(new Error('aksi media tidak dikenali'));
      if (typeof handlers.media_control === 'function') return handlers.media_control({ action: action });
      // media:key takes the bare action string in main.js.
      return invoke('media:key', action).then(function () {
        var label = action === 'play-pause' ? 'Putar/jeda' : (action === 'next' ? 'Lagu berikutnya' : 'Lagu sebelumnya');
        return label;
      });
    }
    if (tool === 'youtube') return handlers.youtube(args);
    if (tool === 'youtube_play') return handlers.youtube_play(args);
    if (tool === 'spotify') return handlers.spotify(a);
    if (tool === 'whatsapp') return handlers.whatsapp(a);
    if (tool === 'type_text') return handlers.type_text(a);
    if (tool === 'press_key') return handlers.press_key(a);
    if (tool === 'theme') return handlers.theme(a);
    if (tool === 'search_file') return handlers.search_file(a);
    if (tool === 'todo_add') return handlers.todo_add(a);
    if (tool === 'reminder_add') return handlers.reminder_add(a);
    return Promise.reject(new Error('tool ' + tool + ' tidak dikenal'));
  }

  function runPlan(plan, onStep) {
    var steps = plan && Array.isArray(plan.steps) ? plan.steps.slice(0, MAX_STEPS) : [];
    if (!steps.length) return Promise.resolve('');

    var total = steps.length;
    var done = [];

    function next(i) {
      if (i >= total) return Promise.resolve(done.join('. '));
      var step = steps[i] || {};
      var tool = String(step.tool || '');
      var args = (step.args && typeof step.args === 'object') ? step.args : {};
      notifyStep(onStep, i + 1, total, tool, 'start');
      return Promise.resolve().then(function () {
        return runTool(tool, args);
      }).then(function (msg) {
        done.push(String(msg || tool));
        notifyStep(onStep, i + 1, total, tool, 'ok');
        if (i + 1 >= total) return done.join('. ');
        return delay(STEP_DELAY).then(function () { return next(i + 1); });
      }, function (e) {
        // Stop dead. Continuing after a failed step is how a half-broken plan
        // ends up typing into the wrong window.
        notifyStep(onStep, i + 1, total, tool, 'fail');
        var why = e && e.message ? e.message : String(e);
        return 'Gagal di langkah ' + (i + 1) + ' (' + tool + '): ' + why;
      });
    }

    return next(0);
  }

  // Deterministic local commands. These are matched before the AI so the most
  // common media/volume phrases never cost a round trip (and never get
  // "interpreted" into something else). The verb must open the sentence and the
  // sentence must end on the verb or one media noun, so "putar video apa yang
  // bagus" still reaches the AI.
  var MEDIA_RE = /^(?:putar|jeda|pause|play|lanjut|next|stop|sebelumnya|prev(?:ious)?|lagu\s+berikutnya|lagu\s+sebelumnya)(?:\s+(?:lagu|musik|lagi|ya|dong|saja|video|media|spotify))?$/i;

  function parseLocalAction(text) {
    var t = String(text || '').trim().replace(/[.,;!?]+$/, '').trim();
    var low = t.toLowerCase();
    if (!low) return null;

    if (MEDIA_RE.test(low)) {
      var action = 'play-pause';
      if (/^(?:lanjut|next|lagu\s+berikutnya)/.test(low)) action = 'next';
      else if (/^(?:sebelumnya|prev|lagu\s+sebelumnya)/.test(low)) action = 'previous';
      return { tool: 'media', args: { action: action } };
    }

    var mv = low.match(/^(?:(?:naikkan|turunkan|kecilkan|besarkan|set|atur|ubah)\s+)?(?:volume|suara)(?:\s+(?:jadi|ke|sampai))?\s*(\d{1,3})\s*(?:%|persen)?$/);
    if (mv) {
      var level = Number(mv[1]);
      if (level >= 0 && level <= 100) return { tool: 'volume', args: { level: level } };
    }
    if (/^(?:volume|suara)\s+(?:naik|turun|kecil|besar)$/.test(low)) {
      return { tool: 'volume', args: { delta: /naik|besar/.test(low) ? 10 : -10 } };
    }
    return null;
  }

  handlers.theme = function (p) {
    var mode = String((p && (p.mode || p.theme)) || 'light').toLowerCase();
    var isLight = mode === 'light' || mode === 'terang' || mode === 'cerah' || mode === 'putih';
    return invoke('system:theme', { mode: isLight ? 'light' : 'dark' }).then(function (r) {
      if (!r || !r.ok) throw new Error('gagal mengubah tema Windows');
      return 'Tema laptop diubah ke ' + (isLight ? 'terang' : 'gelap');
    });
  };

  handlers.time = function () {
    var d = new Date();
    return Promise.resolve('Sekarang jam ' + d.getHours() + '.' + ('0' + d.getMinutes()).slice(-2));
  };

  // ---- entry point ---------------------------------------------------------

  function run(parsed) {
    elog('run intent=' + (parsed && parsed.intent) + ' app=' + (parsed && parsed.app));
    if (!parsed || !parsed.intent) return Promise.reject(new Error('perintah tidak dikenali'));
    var fn = handlers[parsed.intent];
    if (!fn) return Promise.reject(new Error('perintah ' + parsed.intent + ' belum didukung'));
    return Promise.resolve().then(function () { return fn(parsed); })
      .then(function (msg) { elog('ok: ' + msg); return msg; },
            function (e) { elog('FAIL: ' + (e && e.message ? e.message : e)); throw e; });
  }

  // Session context: what the last successful web action opened. The local
  // parser has no memory of its own, so follow-ups like "buka youtube" then
  // "cari windah" need this to land in the right place.
  var dnCtx = { lastSite: "", lastLabel: "" };
  function dnCtxRecord(site, label) {
    dnCtx.lastSite = String(site || "").toLowerCase();
    dnCtx.lastLabel = String(label || "");
    try { window.dnCtx = dnCtx; } catch (_) {}
  }
  try { window.dnCtx = dnCtx; } catch (_) {}

  // Free-form question: hand it to 9router. If the router is not configured,
  // say that plainly rather than silently doing nothing.
  // The surface is 'voice' because this is the spoken loop: it gets the
  // model the user picked for voice, not the one they picked for the chat tab.
  function ask(text, surface) {
    if (!window.dnRouter || typeof window.dnRouter.ask !== 'function') {
      return Promise.reject(new Error('otak AI belum siap'));
    }
    if (!window.dnRouter.isConfigured()) {
      return Promise.reject(new Error('API key 9router belum diisi di Pengaturan'));
    }
    return window.dnRouter.ask(text, { noRemember: !!dnSilent, surface: surface || 'voice' }).then(function (res) {
      return res && res.text ? res.text : '';
    });
  }

  // Handles whatever dn-voice-ptt emits. Keeps the recorder free of action
  // logic and gives every branch a spoken result.
  var dnActionRetry = false;
  function handle(evt, onDone) {
    elog('handle type=' + (evt && evt.type) + (evt && evt.text ? " text=" + JSON.stringify(String(evt.text).slice(0, 40)) : ""));
    var done = function (msg) { try { if (onDone) onDone(msg); } catch (_) {} };
    if (!evt || !evt.type) return;
    dnSilent = !!evt.silent;
    var curSurface = (evt && evt.surface) || 'voice';

    if (evt.type === 'chain') {
      elog('chain first=' + evt.first.intent + ' rest=' + JSON.stringify(evt.rest.slice(0, 40)));
      var firstLabel = evt.first.label || evt.first.intent;
      setUi('1/2: ' + firstLabel, 'Membuka ' + firstLabel + '...');
      run(evt.first).then(function (firstMsg) {
        say(firstMsg);
        setUi('1/2: Selesai', firstMsg);
        var restText = String(evt.rest || '').trim();
        // Whisper trails punctuation onto the last word ("buka tab Whatsapp.").
        // The intent regexes below are end-anchored, so the period would break
        // every match and push a perfectly good command to the AI. Strip it
        // once so both the prompt branch and the second-intent branch see the
        // same clean text.
        restText = restText.replace(/[.,;!?]+$/, '').trim();
        // "prom"/"promt" are the spoken shorthands for "prompt"; \b keeps
        // unrelated words like "promosi" from reading as the verb.
        var promptMatch = restText.match(/^(?:prompt|promt|prom|tulis|ketik|isi|paste)\b\s*[:.]?\s*(.+)/i);
        if (promptMatch && promptMatch[1]) {
          var toPaste = promptMatch[1].trim();
          setUi('2/2: Tempel', toPaste.slice(0, 45) + '...');
          setTimeout(function () {
            if (window.dnPtt && typeof window.dnPtt.pasteToFocus === 'function') {
              window.dnPtt.pasteToFocus(toPaste).then(function (r) {
                if (r && r.ok) {
                  setUi('2/2: Selesai', 'Teks berhasil ditempel');
                  say('Prompt ditempel');
                  done('Prompt ditempel');
                } else {
                  setUi('2/2: Disalin', 'Tekan Ctrl V untuk tempel');
                  say('Teks sudah dicopy, tekan Ctrl V');
                  done('Teks dicopy');
                }
              }, function (err) { done(String(err)); });
            } else {
              done(firstMsg);
            }
          }, 800);
          return;
        }
        // Chained YouTube search check: e.g. "buka youtube di chrome lalu cari miawaug"
        var isYt = (evt.first.app === 'youtube' || (evt.first.label && /youtube/i.test(evt.first.label)));
        var searchMatch = restText.match(/^(?:cari|search)(?:\s+di\s+youtube)?\s+(.+)$/i);
        if (isYt && searchMatch && searchMatch[1]) {
          var ytQuery = searchMatch[1].trim();
          setUi('2/2: Cari YouTube', ytQuery);
          setTimeout(function () {
            handlers.youtube({ query: ytQuery }).then(function (mYt) {
              setUi('2/2: Selesai', mYt);
              say(mYt);
              done(firstMsg + ', ' + mYt);
            }, function (eYt) { done(firstMsg); });
          }, 800);
          return;
        }

        var second = null;
        try {
          // "buka tab X" must be decided BEFORE dnIntent.parse: the parser
          // reads "tab" as a noise word and answers open_app, which would
          // launch the installed app instead of opening a browser tab.
          var mTab = restText.match(/^\s*buka\s+tab\s+([a-zA-Z0-9._-]+(?:\s+[a-zA-Z0-9._-]+)?)\s*$/i);
          if (mTab && mTab[1]) {
            second = { intent: 'open_tab', app: mTab[1].toLowerCase(), label: mTab[1], score: 0.85 };
          } else {
            if (window.dnIntent && window.dnIntent.parse) {
              second = window.dnIntent.parse(restText);
            }
            if (!second || second.intent === 'unknown') {
              var m = restText.match(/^\s*(?:buka\s+aplikasi|buka\s+apk|bukakan|bukain|jalankan|buka)\s+([a-zA-Z0-9._-]+(?:\s+[a-zA-Z0-9._-]+)?)\s*$/i);
              if (m && m[1]) second = { intent: 'open_app', app: m[1].toLowerCase(), label: m[1], score: 0.85 };
            }
          }
        } catch (_) {}
        if (second && second.intent && second.intent !== 'unknown') {
          var secondLabel = second.label || second.intent;
          setUi('2/2: ' + secondLabel, 'Membuka ' + secondLabel + '...');
          setTimeout(function () {
            run(second).then(function (m2) {
              setUi('2/2: Selesai', m2);
              say(m2);
              done(firstMsg + ', ' + m2);
            }, function (e2) {
              done(firstMsg);
            });
          }, 800);
          return;
        }
        setUi('2/2: AI Memilih Aksi', restText.slice(0, 45) + '...');
        setTimeout(function () {
          // Route through the assistant pipeline, never the raw chatbot: the
          // remainder may contain an action ("kirim pesan untuk Pampam") that
          // needs askAction + the approval card, not a spoken how-to lecture.
          handle({ type: 'text', text: restText, silent: evt.silent, surface: curSurface }, function (m) {
            done(m || firstMsg);
          });
        }, 800);
      }, function (err) {
        var m = err && err.message ? err.message : String(err);
        setUi('Gagal', m);
        say(m);
        done(m);
      });
      return;
    }

    if (evt.type === 'intent') {
      setUi('Perintah: ' + (evt.data && evt.data.label ? evt.data.label : 'Aplikasi'), 'Menjalankan...');
      run(evt.data).then(function (msg) {
        setUi('Selesai', msg);
        say(msg);
        done(msg);
      }, function (e) {
        var m = e && e.message ? e.message : String(e);
        setUi('Gagal', m);
        say(m);
        done(m);
      });
      return;
    }

    if (evt.type === 'text') {
      var text = String(evt.text || '').trim();
      var configured = !!(window.dnRouter && window.dnRouter.isConfigured && window.dnRouter.isConfigured());
      elog('text -> local? configured=' + configured);

      // Spoken answer for anything that is not an action plan.
      // Session memory: every spoken utterance lands in the shared thread
      // so the planner and ask() see the previous exchanges.
      try {
        if (window.dnConvo && typeof window.dnConvo.remember === 'function' && text) {
          window.dnConvo.remember('user', text);
        }
      } catch (_) {}

      var askFallback = function (t) {
        // Questions stay on this path by design; the ask() system prompt keeps
        // the answer to 1-2 sentences so it reads like an assistant, not a page.
        setUi('Menjawab', t.slice(0, 45) + '...');
        ask(t, curSurface).then(function (answer) {
          elog('ai answered len=' + String(answer || '').length);
          try { if (window.dnConvo && typeof window.dnConvo.remember === 'function' && answer) window.dnConvo.remember('assistant', answer); } catch (_) {}
          setUi('AI Menjawab', answer.slice(0, 45) + '...');
          say(answer);
          done(answer);
        }, function (e) {
          var m = e && e.message ? e.message : String(e);
          setUi('AI Gagal', m);
          say(m);
          done(m);
        });
      };

      // 1. Deterministic media/volume first: these are exact phrases with a
      //    known action, so asking a model would only add latency and risk.
      var local = parseLocalAction(text);
      if (local) {
        setUi('Perintah lokal', local.tool + ' ' + JSON.stringify(local.args));
        runPlan({ steps: [local] }).then(function (msg) {
          setUi('Selesai', msg);
          say(msg);
          done(msg);
        });
        return;
      }

      // 2. No router or no askAction -> the plain spoken-answer path.
      if (!configured || !window.dnRouter || typeof window.dnRouter.askAction !== 'function') {
        askFallback(text);
        return;
      }

      // 3. AI chooses the plan, DeskNotch executes it.
      setUi('AI memilih aksi', text.slice(0, 45) + '...');
      window.dnRouter.askAction(text, TOOLS, { noRemember: !!dnSilent, surface: curSurface }).then(function (plan) {
        var steps = (plan && Array.isArray(plan.steps)) ? plan.steps : [];
        if (!steps.length) {
          // A question ("siapa presiden indonesia") lands here by design: no
          // system action, so the answer is spoken instead of executed.
          elog('plan empty, fallback to ask' + (plan && plan.error ? ' err=' + plan.error : ''));
          var spoken = (plan && plan.say) ? String(plan.say) : '';
          // A prose answer to an action request means the planner refused to
          // act. The approval card is the only permission gate, so retry once
          // with an explicit instruction instead of lecturing the user.
          var looksAction = /\b(buka|tutup|jalankan|hapus|pindah|salin|buat|tambah|setel|atur|putar|cari|kirim|pasang|ubah|cek|lihat|unduh|download|install|matikan|nyalakan|restart|shutdown|rename|ganti)\b/i.test(text);
          if (looksAction && !dnActionRetry) {
            dnActionRetry = true;
            elog('empty plan for an action request -> retry with a hard nudge');
            setUi('Menyusun aksi', text.slice(0, 45) + '...');
            handle({ type: 'text', text: text + '\n\n[INSTRUKSI SISTEM] Ini permintaan AKSI, bukan pertanyaan. Jangan menjelaskan caranya, jangan minta konfirmasi, jangan minta output terminal. Balas HANYA JSON berisi langkah tool yang benar-benar menjalankannya di Windows.', silent: evt.silent, surface: curSurface }, function (msg2) {
              dnActionRetry = false;
              done(msg2);
            });
            return;
          }
          dnActionRetry = false;
          if (spoken) {
            setUi('AI Menjawab', spoken.slice(0, 45) + '...');
            say(spoken);
            done(spoken);
            return;
          }
          askFallback(text);
          return;
        }
        elog('plan steps=' + steps.length);
        var planTitle = (plan && plan.say) ? String(plan.say) : 'Izin Aksi AI';
        if (steps.length === 1 && steps[0].tool === 'shell' && steps[0].args && steps[0].args.cmd) {
          var dnCmd0 = String(steps[0].args.cmd).trim();
          planTitle = dnCmd0.length > 46 ? dnCmd0.slice(0, 45) + '…' : dnCmd0;
        }
        var friendlyStep = function (st) {
          var a = st.args || {};
          if (st.tool === 'open_app') return 'Buka aplikasi ' + (a.app || '');
          if (st.tool === 'open_tab') return 'Buka tab ' + (a.site || a.url || '');
          if (st.tool === 'youtube_play') return 'Putar YouTube: ' + (a.query || '');
          if (st.tool === 'youtube') return 'Cari YouTube: ' + (a.query || '');
          if (st.tool === 'whatsapp') return 'WhatsApp ke ' + (a.contact || '') + ': "' + (a.message || '') + '"';
          if (st.tool === 'spotify') return 'Putar Spotify: ' + (a.query || '');
          if (st.tool === 'volume') return 'Volume ' + (a.level != null ? a.level + '%' : a.delta);
          if (st.tool === 'search_file') return 'Cari file: ' + (a.query || '');
          if (st.tool === 'todo_add') return 'Tambah to do: ' + (a.text || '');
          if (st.tool === 'reminder_add') return 'Pengingat: ' + (a.text || '');
          if (st.tool === 'theme') return 'Tema ' + (a.mode || '');
          if (st.tool === 'delete_file') return 'Hapus ke Recycle Bin: ' + (a.query || '');
          if (st.tool === 'shell') { var c0 = String(a.cmd || '').trim(); return 'Jalankan: ' + (c0.length > 54 ? c0.slice(0, 53) + '…' : c0); }
          return st.tool;
        };
        var planDetail = steps.map(function (st, idx) { return (idx + 1) + '. ' + friendlyStep(st); }).join('\n');
        // live rows for the isle-style card: the chunk renders these top-down
        var planRows = steps.map(function (st) { return { label: friendlyStep(st), state: 'pending' }; });

        // Request user approval via DeskNotch approval card before running AI action plan
        setUi('Menunggu Izin...', planTitle, planRows);
        var askApproval = function () {
          if (bridge && typeof bridge.invoke === 'function') {
            return invoke('dnai:request-approval', { title: planTitle, detail: planDetail, tool: 'ai' }).then(function (r) { return r !== false; }).catch(function () { return true; });
          }
          return Promise.resolve(true);
        };

        return askApproval().then(function (approved) {
          if (!approved) {
            elog('AI action plan rejected by user');
            setUi('Ditolak', 'Aksi dibatalkan');
            say('Aksi dibatalkan');
            done('Aksi dibatalkan');
            return;
          }
          return runPlan(plan, function (i, total, tool, status) {
            // i is 1-based; rows before it are done, the current one reflects
            // its status, rows after stay pending.
            for (var k = 0; k < planRows.length; k++) {
              planRows[k].state = k < i - 1 ? 'done' : (k === i - 1 ? (status === 'ok' || status === 'fail' ? 'done' : 'active') : 'pending');
            }
            setUi(i + '/' + total + ': ' + tool, status === 'ok' ? 'Selesai' : (status === 'fail' ? 'Gagal' : 'Menjalankan...'), planRows);
          }).then(function (summary) {
            for (var k2 = 0; k2 < planRows.length; k2++) planRows[k2].state = 'done';
            setUi('Selesai', summary, planRows);
            say(summary);
            done(summary);
          });
        });
      }).catch(function (e) {
        // askAction never rejects by contract, but a broken build must not
        // leave the user without an answer.
        elog('askAction threw: ' + (e && e.message ? e.message : e));
        askFallback(text);
      });
      return;
    }
    if (evt.type === 'dictate') {
      if (window.dnPtt && typeof window.dnPtt.pasteToFocus === 'function') {
        window.dnPtt.pasteToFocus(evt.text).then(function (r) {
          if (r && r.ok) { done(''); return; }
          var why = r && r.reason ? r.reason : 'gagal menempel';
          say('Teks sudah dicopy, tekan Ctrl V sendiri');
          done(why);
        }, function (e) {
          done(e && e.message ? e.message : String(e));
        });
      }
      return;
    }
  }

  window.dnVoiceExec = {
    run: run,
    ask: ask,
    handle: handle,
    runPlan: runPlan,
    parseLocalAction: parseLocalAction,
    TOOLS: TOOLS,
    handlers: handlers
  };
})();
