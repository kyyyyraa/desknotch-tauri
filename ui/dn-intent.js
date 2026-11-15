  function tryWhatsapp(tokens, low) {
    var text = low.join(" ");
    // e.g. "kirim pesan ke pampam morning", "kirim wa untuk budi halo", "buka whatsapp lalu kirim pesan untuk pampam"
    var m = text.match(/^(?:kirim\s+pesan|kirim\s+wa|chat|kirim)(?:\s+di\s+(?:whatsapp|wa))?\s+(?:ke|untuk)\s+([a-zA-Z0-9._-]+(?:\s+[a-zA-Z0-9._-]+)?)(?:\s+di\s+(?:whatsapp|wa))?(?:\s+(?:pesan|yaitu|bilang))?\s+(.+)$/i);
    if (!m) {
      // fallback for "kirim pesan di whatsapp ke/untuk <contact> <message>"
      m = text.match(/^(?:kirim\s+pesan|kirim\s+wa)\s+(?:di|lewat)\s+(?:whatsapp|wa)\s+(?:ke|untuk)\s+([a-zA-Z0-9._-]+(?:\s+[a-zA-Z0-9._-]+)?)(?:\s+(?:pesan|yaitu|bilang))?\s+(.+)$/i);
    }
    if (!m) return null;
    var contact = m[1].trim();
    var message = m[2].trim();
    if (!contact || !message) return null;
    if (/^(?:whatsapp|wa|aplikasi)$/i.test(contact)) return null;
    // find original token casing for contact and message
    return { intent: "whatsapp", raw: null, contact: contact, message: message, label: "WhatsApp", score: 0.9 };
  }

// dn-intent.js - DeskNotch Fase 3e: offline intent parser for voice commands.
// Pure function, zero dependencies, no network. window.dnIntent.parse(text)
// returns {intent, raw, score, ...}; "unknown" always has score 0 so the
// caller can hand the transcript to the AI router.
//
// Matching order, first hit wins. The order is load-bearing:
//   1 time          "sekarang jam berapa" must never reach reminder or timer
//   2 todo_list     before todo_add; a cue word ("apa aja", "lihat") wins even
//                   when an add verb is present: "buat daftar tugas apa saja"
//   3 todo_add      strips command words, keeps the rest of the sentence
//   4 timer         before reminder_add: "timer 10 menit" is a timer
//   5 reminder_add  needs a reminder verb AND a parseable time
//   6 volume
//   7 youtube_play  "putar video X paling baru": the recency marker belongs
//                   to the intent, not to the search query
//   8 youtube       "putar video X [di youtube]", "cari di youtube X"
//   9 whatsapp      "kirim pesan ke X di whatsapp Y" / "kirim wa ke X Y"
//  10 open_tab      "buka tab X" / "buka X di chrome" before open_app: the
//                   desktop app is not installed for web-first apps
//  11 search_file   before open_app: "cari file excel" must not launch Excel.
//                   It also owns the explicit forms "tolong carikan CV saya"
//                   and "carikan si visanya di download" (query + location
//                   hint), so a file request never depends on the AI planner.
//  12 open_app
//  13 unknown
//
// Fuzzy policy: Levenshtein <= 2, only for words of 4+ characters, only for
// app aliases and command verbs. Short words stay exact so "jam" cannot eat
// "jama" and two-letter aliases (wa, yt) cannot drift onto unrelated words.
// A second guard tightens it further: words shorter than 6 characters allow
// only ONE edit, because two edits on a short word ("pintu" -> "paint") is a
// different word far more often than a mishearing. Fuzzy hits are also
// rejected against VERB_SKIP, so "tadi" cannot become "cari".
//
// app  : chrome edge firefox notepad word excel powerpoint spotify youtube
//        whatsapp telegram discord steam vscode explorer kalkulator pengaturan
//        taskmgr paint canva figma notion obsidian zoom teams gmail github
//        -> {app:<key>, label:<TTS label>}; the caller resolves the launch
//        target via apps:describe / apps:launch. No AppUserModelID here.
(function () {
  if (window.dnIntent) return;
  'use strict';

  var MAX_DIST = 2;
  var MIN_FUZZY_LEN = 4;

  // Aliases are spellings Whisper actually produces, not a thesaurus.
  // No AppUserModelID lives here: the caller resolves key -> launch target
  // through the existing apps:describe / apps:launch IPC.
  var APPS = [
    { key: 'chrome', label: 'Chrome', aliases: ['chrome', 'google chrome', 'google', 'krom', 'krome', 'crome'] },
    { key: 'edge', label: 'Edge', aliases: ['edge', 'microsoft edge', 'ms edge', 'bing'] },
    { key: 'firefox', label: 'Firefox', aliases: ['firefox', 'mozilla firefox', 'mozilla', 'mozila'] },
    { key: 'notepad', label: 'Notepad', aliases: ['notepad', 'note pad', 'noteped', 'ngepad', 'nottet', 'nattet'] },
    { key: 'word', label: 'Word', aliases: ['word', 'ms word', 'microsoft word'] },
    { key: 'excel', label: 'Excel', aliases: ['excel', 'ms excel', 'microsoft excel', 'ekcel', 'exsel'] },
    { key: 'powerpoint', label: 'PowerPoint', aliases: ['powerpoint', 'power point', 'ppt', 'microsoft powerpoint'] },
    { key: 'spotify', label: 'Spotify', aliases: ['spotify', 'spotifai', 'spotipai', 'spotifay'] },
    { key: 'youtube', label: 'YouTube', aliases: ['youtube', 'you tube', 'yutub', 'yutube', 'yt'] },
    { key: 'whatsapp', label: 'WhatsApp', aliases: ['whatsapp', 'whatsap', 'watsap', 'wa'] },
    { key: 'telegram', label: 'Telegram', aliases: ['telegram', 'tele gram', 'tg'] },
    { key: 'discord', label: 'Discord', aliases: ['discord', 'diskor'] },
    { key: 'steam', label: 'Steam', aliases: ['steam', 'stim'] },
    { key: 'vscode', label: 'VS Code', aliases: ['vscode', 'vs code', 'visual studio code', 'vscod'] },
    { key: 'explorer', label: 'File Explorer', aliases: ['explorer', 'file explorer', 'windows explorer', 'eksplorer', 'exploler'] },
    { key: 'kalkulator', label: 'Kalkulator', aliases: ['kalkulator', 'calculator', 'kalku', 'calc'] },
    { key: 'pengaturan', label: 'Pengaturan', aliases: ['pengaturan', 'setting', 'settings', 'setelan'] },
    { key: 'taskmgr', label: 'Task Manager', aliases: ['task manager', 'taskmgr', 'task mgr', 'manajer tugas'] },
    { key: 'paint', label: 'Paint', aliases: ['paint', 'ms paint'] },
    { key: 'canva', label: 'Canva', aliases: ['canva', 'kanva', 'canvas'] },
    { key: 'figma', label: 'Figma', aliases: ['figma'] },
    { key: 'notion', label: 'Notion', aliases: ['notion', 'nosion'] },
    { key: 'obsidian', label: 'Obsidian', aliases: ['obsidian', 'obsi'] },
    { key: 'zoom', label: 'Zoom', aliases: ['zoom', 'zoom meeting', 'zum'] },
    { key: 'teams', label: 'Teams', aliases: ['teams', 'ms teams', 'microsoft teams'] },
    { key: 'gmail', label: 'Gmail', aliases: ['gmail', 'g mail', 'google mail'] },
    { key: 'github', label: 'GitHub', aliases: ['github', 'git hub', 'git'] }
  ];

  var APP_ALIASES = [];
  (function buildAliasIndex() {
    for (var i = 0; i < APPS.length; i++) {
      for (var j = 0; j < APPS[i].aliases.length; j++) {
        APP_ALIASES.push({ words: APPS[i].aliases[j].split(' '), app: APPS[i] });
      }
    }
    // Longest phrase first at a given token: "google chrome" before "google".
    APP_ALIASES.sort(function (a, b) { return b.words.length - a.words.length; });
  })();

  // Words that are never the app name, so fuzzy matching cannot grab them.
  var APP_SKIP = {
    aplikasi: 1, aplikasinya: 1, app: 1, program: 1, yang: 1, namanya: 1,
    tolong: 1, coba: 1, ya: 1, dong: 1, deh: 1, saya: 1, aku: 1, gue: 1,
    gua: 1, gw: 1, sekarang: 1, dulu: 1, aja: 1, itu: 1, ini: 1, please: 1,
    // "prom" is one edit from "krom", so "buka zcode lalu prom..." launched
    // Chrome. A prompt is not an app name; never let fuzzy matching see it.
    prom: 1, prompt: 1, promp: 1
  };

  function has(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  function tokenize(input) {
    // Punctuation becomes a space, not a deletion: "to-do" must stay two
    // words so the todo noun table can see it.
    var text = String(input == null ? '' : input).replace(/[^0-9A-Za-z]+/g, ' ');
    text = text.replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
    if (!text) return [];
    var parts = text.split(' ');
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      out.push({ raw: parts[i], low: parts[i].toLowerCase() });
    }
    return out;
  }

  function lows(tokens) {
    var out = [];
    for (var i = 0; i < tokens.length; i++) out.push(tokens[i].low);
    return out;
  }

  function lev(a, b) {
    var la = a.length, lb = b.length;
    if (!la) return lb;
    if (!lb) return la;
    var prev = [], cur = [], i, j;
    for (j = 0; j <= lb; j++) prev[j] = j;
    for (i = 1; i <= la; i++) {
      cur[0] = i;
      for (j = 1; j <= lb; j++) {
        var cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
        var v = prev[j - 1] + cost;
        if (prev[j] + 1 < v) v = prev[j] + 1;
        if (cur[j - 1] + 1 < v) v = cur[j - 1] + 1;
        cur[j] = v;
      }
      for (j = 0; j <= lb; j++) prev[j] = cur[j];
    }
    return prev[lb];
  }

  // Returns the distance, or -1 when the pair is not allowed to match.
  function fuzzy(word, target, maxDist) {
    if (word === target) return 0;
    if (word.length < MIN_FUZZY_LEN || target.length < MIN_FUZZY_LEN) return -1;
    var cap = maxDist == null ? MAX_DIST : maxDist;
    // Two edits on a five-letter word means a different word far more often
    // than a mishearing: "pintu" is two edits from "paint". Longer words get
    // the full budget because that is where Whisper actually drifts.
    if (Math.min(word.length, target.length) < 6 && cap > 1) cap = 1;
    if (Math.abs(word.length - target.length) > cap) return -1;
    var d = lev(word, target);
    return d <= cap ? d : -1;
  }

  // Exact pass over the whole window first, so a fuzzy neighbour can never
  // shadow the verb the user really said.
  function findVerb(low, verbs, from, windowSize) {
    var list = verbs && verbs._list ? verbs._list : verbs;
    var i, j;
    var end = low.length;
    if (windowSize > 0 && from + windowSize < end) end = from + windowSize;
    for (i = from; i < end; i++) {
      for (j = 0; j < list.length; j++) {
        if (low[i] === list[j]) return { index: i, word: list[j], dist: 0 };
      }
    }
    for (i = from; i < end; i++) {
      var best = -1, bestWord = null;
      for (j = 0; j < list.length; j++) {
        // Fuzzy only against 4+ char verbs: a short verb like "add" or "cari"
        // would otherwise match half the sentence.
        var d = fuzzy(low[i], list[j], MAX_DIST);
        if (d >= 0 && (best < 0 || d < best)) { best = d; bestWord = list[j]; }
      }
      if (bestWord) return { index: i, word: bestWord, dist: best };
    }
    return null;
  }

  function findWord(low, words, from) {
    var i, j;
    for (i = from || 0; i < low.length; i++) {
      for (j = 0; j < words.length; j++) {
        if (low[i] === words[j]) return i;
      }
    }
    return -1;
  }

  // Left to right, so the app mentioned first wins; longest alias wins at a
  // token, then exact beats fuzzy.
  function findApp(low, from) {
    var n = low.length, i, k, a, b;
    for (i = from; i < n; i++) {
      if (has(APP_SKIP, low[i])) continue;
      for (a = 0; a < APP_ALIASES.length; a++) {
        var al = APP_ALIASES[a];
        if (i + al.words.length > n) continue;
        var ok = true;
        for (k = 0; k < al.words.length; k++) {
          if (low[i + k] !== al.words[k]) { ok = false; break; }
        }
        if (ok) return { key: al.app.key, label: al.app.label, index: i, len: al.words.length, dist: 0 };
      }
    }
    for (i = from; i < n; i++) {
      var w = low[i];
      if (has(APP_SKIP, w) || w.length < MIN_FUZZY_LEN) continue;
      var best = null;
      for (b = 0; b < APP_ALIASES.length; b++) {
        var single = APP_ALIASES[b];
        if (single.words.length !== 1) continue;
        var d = fuzzy(w, single.words[0], MAX_DIST);
        if (d < 0) continue;
        if (!best || d < best.dist) {
          best = { key: single.app.key, label: single.app.label, index: i, len: 1, dist: d };
        }
      }
      if (best) return best;
    }
    return null;
  }
  // ---- word sets -----------------------------------------------------------

  // Word set: plain object so lookups are exact, plus a "_list" copy for the
  // callers that scan by index (findVerb). An array would collide instead:
  // set['2'] on an array reads index 2, so the token "2" would test as filler.
  // The "_list" key itself can never be a token: tokenize strips underscores.
  function setOf(list) {
    var set = { _list: list };
    for (var i = 0; i < list.length; i++) set[list[i]] = 1;
    return set;
  }

  function unitOf(word) {
    return has(UNIT_MS, word) ? UNIT_MS[word] : 0;
  }

  function periodOf(word) {
    return has(PERIOD_WORDS, word) ? PERIOD_WORDS[word] : null;
  }

  var PRONOUNS = setOf(['saya', 'aku', 'gue', 'gua', 'gw']);
  var WANT = setOf(['mau', 'ingin', 'pengen', 'pingin', 'pengin', 'hendak']);
  var LEAD_FILLER = setOf([
    'tolong', 'mohon', 'minta', 'coba', 'eh', 'halo', 'hai', 'hallo',
    'ya', 'yah', 'dong', 'deh', 'nih', 'sih', 'aja', 'saja', 'bantu', 'bantuin',
    'segera', 'please', 'pls', 'kok', 'kan', 'lah'
  ]);
  var ADD_VERBS = setOf([
    'buat', 'buatkan', 'bikin', 'bikinin', 'tambah', 'tambahkan', 'tambahin',
    'catat', 'catatkan', 'catet', 'tulis', 'tuliskan', 'tulisin',
    'masukkan', 'masukan', 'masukin', 'simpan', 'simpanin', 'daftarkan', 'input',
    'inputkan', 'note', 'add'
  ]);
  // Verbs that already mean "add" without a todo noun next to them. "buat" and
  // "bikin" are deliberately absent: "buat kopi" must not become a todo.
  var ADD_VERBS_STRONG = setOf([
    'buatkan', 'catat', 'catatkan', 'catet', 'tambahkan', 'tambahin', 'tambah',
    'tulis', 'tuliskan', 'tulisin', 'masukkan', 'masukan', 'masukin', 'simpan', 'simpanin',
    'daftarkan', 'input', 'inputkan'
  ]);
  var PREPOSITIONS = setOf(['ke', 'di', 'dalam', 'untuk', 'pada']);

  // Ordered longest first: "to do list" must win before "to do".
  // The tail of the table is what Whisper actually produces for "to do list":
  // "taks", "tuduh", "todus" are mishearings, "list"/"lis" is how people
  // shorten it, and "daftar kerja" is the Indonesian phrasing.
  var TODO_NOUNS = [
    { words: ['to', 'do', 'list'] },
    { words: ['todo', 'list'] },
    { words: ['to', 'do'] },
    { words: ['todolist'] },
    { words: ['todos'] },
    { words: ['todo'] },
    { words: ['tudulis'] },
    { words: ['tu', 'duis'] },
    { words: ['tu', 'du'] },
    { words: ['tu', 'duh'] },
    { words: ['tuh', 'dulis'] },
    { words: ['daftar', 'tugas'] },
    { words: ['daftar', 'kerja'] },
    { words: ['daftar', 'todo'] },
    { words: ['tugas'] },
    { words: ['task'] },
    { words: ['tasks'] },
    { words: ['taks'] },
    { words: ['todus'] },
    { words: ['tuduh'] },
    // "list"/"lis" alone are ordinary English words, so they only count as the
    // todo noun after a preposition or an add verb: "masukin ngedit ke list"
    // is a todo, "cari file list" is still a file search.
    { words: ['list'], needsPrep: true },
    { words: ['lis'], needsPrep: true }
  ];
  // Question words win even when an add verb precedes the noun, because
  // "buat daftar tugas apa saja" asks rather than adds.
  var STRONG_CUES = setOf(['apa', 'apakah', 'aja', 'saja', 'mana', 'gimana', 'bagaimana']);
  var WEAK_CUES = setOf(['lihat', 'liat', 'tampilkan', 'tampil', 'baca', 'cek', 'sebutkan', 'show']);

  var OPEN_VERBS = ['buka', 'bukain', 'bukakan', 'bukak', 'jalanin', 'jalankan', 'launch', 'open', 'start', 'nyalakan'];
  var SEARCH_VERBS = ['cari', 'carikan', 'cariin', 'temukan', 'temuin', 'find', 'search'];
  var REMINDER_VERBS = ['ingatkan', 'ingetin', 'ingat', 'inget', 'reminder', 'pengingat', 'alarm', 'jadwalkan', 'jadwalin'];
  var FILE_CUES = setOf(['file', 'dokumen', 'document', 'folder', 'berkas']);
  var EXTS = setOf(['pdf', 'docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'jpg', 'jpeg', 'png', 'txt', 'mp4', 'mp3', 'zip', 'csv']);
  // Any of these in the query means the user is talking about a document, not
  // about lunch: "cari cv" is a file request, "cari makan siang" is not.
  var FILE_TOPIC = setOf([
    'file', 'dokumen', 'document', 'folder', 'berkas', 'download', 'downloads',
    'desktop', 'pdf', 'docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'txt', 'csv',
    'cv', 'visa', 'surat', 'laporan', 'invoice', 'resume'
  ]);
  // "di download" is where to look, never what to look for.
  var FILE_HINTS = {
    download: 'download', downloads: 'download', unduhan: 'download',
    dokumen: 'documents', document: 'documents', documents: 'documents',
    desktop: 'desktop'
  };
  // Words that are never a filename by themselves. "CV saya" must search CV,
  // not "CV saya". The cue words are here too: "carikan file saya" has no name
  // at all, and the caller falls back to the cue word.
  var QUERY_NOISE = setOf([
    'saya', 'aku', 'gue', 'gua', 'gw', 'ku', 'punya', 'milik',
    'yang', 'itu', 'ini', 'si', 'file', 'dokumen', 'document', 'folder', 'berkas'
  ]);

  var NUM_WORDS = {
    nol: 0, satu: 1, dua: 2, tiga: 3, empat: 4, lima: 5, enam: 6, tujuh: 7,
    delapan: 8, sembilan: 9, sepuluh: 10, sebelas: 11, duabelas: 12
  };
  var PERIOD_WORDS = {
    pagi: 'am', subuh: 'am', dini: 'am',
    siang: 'pm', sore: 'pm', petang: 'pm', malam: 'pm', malem: 'pm'
  };
  var UNIT_MS = { detik: 1000, dtk: 1000, sekon: 1000, menit: 60000, mnt: 60000, jam: 3600000 };

  // Words that must never be read as a command verb through the fuzzy path.
  // Exact matches still pass, so "ingat" stays a reminder word while "tadi"
  // cannot drift into "cari" (distance 2) in an unrelated sentence.
  var VERB_SKIP = setOf([
    'tadi', 'tapi', 'kata', 'juga', 'belum', 'lagi', 'nanti', 'sekarang',
    'untuk', 'dari', 'kami', 'kita', 'kamu', 'bisa', 'harus', 'ingin',
    'sama', 'sana', 'sini', 'kapan', 'kenapa', 'siapa', 'mana', 'apa',
    'jam', 'menit', 'detik', 'persen', 'tolong', 'coba', 'yang', 'dan',
    'dengan', 'tentang', 'kalau', 'agar', 'supaya', 'sedang', 'sudah',
    'dunia', 'perang', 'kabar', 'kapan'
  ]);

  function clamp(n, lo, hi) {
    return n < lo ? lo : (n > hi ? hi : n);
  }

  function cleanText(s) {
    var out = String(s == null ? '' : s).replace(/\s+/g, ' ');
    out = out.replace(/^[\s,;:.!?\-]+/, '').replace(/[\s,;:.!?\-]+$/, '');
    for (var i = 0; i < 4; i++) {
      var next = out.replace(/[\s,]+(?:ya|yah|dong|deh|nih|sih|aja|saja|donk|please|pls)$/i, '');
      if (next === out) break;
      out = next.replace(/[\s,]+$/, '');
    }
    return out.replace(/^[\s,]+/, '').replace(/[\s,]+$/, '');
  }

  function numAt(tokens, i) {
    if (i >= tokens.length) return null;
    var low = tokens[i].low;
    if (/^[0-9]{1,2}$/.test(low)) return { value: parseInt(low, 10), len: 1 };
    if (low === 'dua' && i + 1 < tokens.length && tokens[i + 1].low === 'belas') return { value: 12, len: 2 };
    if (has(NUM_WORDS, low)) return { value: NUM_WORDS[low], len: 1 };
    return null;
  }

  function matchNoun(low, i) {
    for (var n = 0; n < TODO_NOUNS.length; n++) {
      var phrase = TODO_NOUNS[n];
      if (i + phrase.words.length > low.length) continue;
      // "list"/"lis" are ordinary words, so they only count as the todo noun
      // when the sentence frames them as one: after a preposition ("masukin
      // ngedit ke list"), after an add verb, or behind a list cue ("lihat
      // list"). Otherwise "cari file list" would stop being a file search.
      if (phrase.needsPrep) {
        var prev = i > 0 ? low[i - 1] : '';
        if (!(has(PREPOSITIONS, prev) || has(ADD_VERBS, prev) || has(WEAK_CUES, prev))) continue;
      }
      var ok = true;
      for (var k = 0; k < phrase.words.length; k++) {
        if (low[i + k] !== phrase.words[k]) { ok = false; break; }
      }
      if (ok) return phrase;
    }
    return null;
  }

  // Strips filler words, a leading pronoun, and one preposition from the front
  // of the text, then leaves everything else untouched.
  function stripLead(words) {
    var i = 0;
    while (i < words.length && has(LEAD_FILLER, words[i])) i++;
    if (has(WANT, words[i])) i++;
    if (has(PRONOUNS, words[i])) i++;
    while (i < words.length && has(PREPOSITIONS, words[i])) i++;
    if (has(WANT, words[i])) i++;
    if (has(PRONOUNS, words[i])) i++;
    while (i < words.length && has(LEAD_FILLER, words[i])) i++;
    return words.slice(i);
  }

  // Rebuilds the text from tokens [from, to), skipping index marks, then runs
  // the filler strip. Raw casing is kept: "Beli Susu" stays capitalised.
  function finishText(tokens, from, to, skip) {
    var picks = [];
    for (var i = from; i < to; i++) {
      if (skip && skip[i]) continue;
      picks.push(tokens[i]);
    }
    var lowOut = [];
    for (var k = 0; k < picks.length; k++) lowOut.push(picks[k].low);
    var keep = stripLead(lowOut);
    var start = picks.length - keep.length;
    var raws = [];
    for (var j = start; j < picks.length; j++) raws.push(picks[j].raw);
    return cleanText(raws.join(' '));
  }

  function spanSet(start, end) {
    var out = {};
    for (var i = start; i < end; i++) out[i] = 1;
    return out;
  }

  function unknown(raw) {
    return { intent: 'unknown', raw: raw, score: 0 };
  }

  function findVerbGuarded(low, verbs, from, windowSize) {
    var hit = findVerb(low, verbs, from, windowSize);
    if (!hit) return null;
    // The exact pass in findVerb runs over the whole window before any fuzzy
    // pass, so a fuzzy hit here means no exact verb exists: a blacklisted word
    // that only *resembles* a verb is a false positive, always.
    if (hit.dist > 0 && has(VERB_SKIP, low[hit.index])) return null;
    return hit;
  }

  // ---- time ----------------------------------------------------------------
  // Everything is local time: "jam 4 sore" means the clock on the taskbar, not
  // UTC. Date is rebuilt from year/month/day so Windows local rules apply.

  function parseTimeRef(tokens, low, now) {
    var i, j;

    // Relative first: "2 jam lagi" also contains the word "jam", so this pass
    // must run before the absolute one.
    for (i = 0; i < low.length; i++) {
      var unit = unitOf(low[i + 1]);
      if (unit && /^[0-9]{1,4}$/.test(low[i])) {
        j = i + 2;
        // "dalam 45 menit" is relative on its own; "10 menit" alone needs
        // "lagi"/"kemudian" so a stray number in a sentence cannot fire.
        if (low[i - 1] === 'dalam' || low[j] === 'lagi' || low[j] === 'kemudian' ||
            (low[j] === 'dari' && low[j + 1] === 'sekarang')) {
          var rStart = (low[i - 1] === 'dalam') ? i - 1 : i;
          var rEnd = (low[j] === 'dari') ? j + 2 : j + 1;
          return {
            at: { type: 'relative', ms: parseInt(low[i], 10) * unit },
            start: rStart, end: rEnd, dayWords: []
          };
        }
      }
      if (low[i] === 'setengah' && low[i + 1] === 'jam' && (low[i + 2] === 'lagi' || low[i + 2] === 'kemudian')) {
        return {
          at: { type: 'relative', ms: 30 * 60000 },
          start: i, end: i + 3, dayWords: []
        };
      }
    }

    // Absolute: jam/pukul + hour + optional period marker.
    for (i = 0; i < low.length; i++) {
      if (low[i] !== 'jam' && low[i] !== 'pukul') continue;
      var num = numAt(tokens, i + 1);
      if (!num || num.value > 23) continue;
      var hour = num.value;
      j = i + 1 + num.len;
      var period = periodOf(low[j]);
      if (period) j++;
      if (period === 'pm') {
        if (hour === 12) { if (low[j - 1] === 'malam' || low[j - 1] === 'malem') hour = 0; }
        else if (hour < 12) hour += 12;
      } else if (period === 'am' && hour === 12) {
        hour = 0;
      }

      var dayOffset = 0;
      var dayWords = [];
      for (var d = 0; d < low.length; d++) {
        if (low[d] === 'besok') { dayOffset = 1; dayWords.push(d); }
        else if (low[d] === 'lusa') { dayOffset = 2; dayWords.push(d); }
        else if (low[d] === 'nanti') { dayWords.push(d); }
        else if (low[d] === 'hari' && low[d + 1] === 'ini') { dayWords.push(d); dayWords.push(d + 1); }
      }

      // "nanti jam 3" with no hour marker: both 03:00 and 15:00 are plausible,
      // so take the next one that has not passed. The ambiguity flag still
      // tells the caller to confirm; picking the nearer slot just means a
      // confirmation prompt reads "jam 3 sore", not "jam 3 pagi besok".
      var base = new Date(now);
      var day0 = base.getDate() + dayOffset;
      var target = new Date(base.getFullYear(), base.getMonth(), day0, hour, 0, 0, 0);
      var ambiguous = !period && hour >= 1 && hour <= 11;
      if (target.getTime() < now && ambiguous && hour + 12 <= 23) {
        target = new Date(base.getFullYear(), base.getMonth(), day0, hour + 12, 0, 0, 0);
      }
      if (target.getTime() < now) {
        target = new Date(base.getFullYear(), base.getMonth(), day0 + 1, hour, 0, 0, 0);
      }
      var at = { type: 'absolute', ts: target.getTime() };
      // A wrong guess fires a reminder 12 hours off, so the caller is told.
      if (ambiguous) at.ambiguous = true;
      return { at: at, start: i, end: j, dayWords: dayWords };
    }
    return null;
  }

  function parseDuration(tokens, low) {
    var total = 0, found = false, i;
    for (i = 0; i < low.length; i++) {
      if (low[i] === 'setengah' && low[i + 1] === 'jam') { total += 30 * 60000; found = true; i++; continue; }
      if (low[i] === 'seperempat' && low[i + 1] === 'jam') { total += 15 * 60000; found = true; i++; continue; }
      var unit = unitOf(low[i + 1]);
      if (unit && /^[0-9]{1,4}$/.test(low[i])) {
        total += parseInt(low[i], 10) * unit;
        found = true;
        i++;
      }
    }
    // "timer 10" means ten minutes, the only bare-number reading that helps.
    if (!found) {
      for (i = 0; i < low.length; i++) {
        if (/^[0-9]{1,3}$/.test(low[i])) {
          var n = parseInt(low[i], 10);
          if (n > 0 && n <= 180) { total = n * 60000; found = true; break; }
        }
      }
    }
    return found ? total : null;
  }
  // ---- intent handlers -----------------------------------------------------
  // Each returns null when it does not apply. See the order comment at the top.

  function tryTheme(low) {
    var flat = ' ' + low.join(' ') + ' ';
    if (flat.indexOf(' tema ') < 0 && flat.indexOf(' mode ') < 0) return null;
    if (flat.indexOf(' terang ') >= 0 || flat.indexOf(' cerah ') >= 0 || flat.indexOf(' putih ') >= 0 || flat.indexOf(' light ') >= 0) {
      return { intent: 'theme', raw: null, mode: 'light', label: 'Tema Terang', score: 0.95 };
    }
    if (flat.indexOf(' gelap ') >= 0 || flat.indexOf(' hitam ') >= 0 || flat.indexOf(' dark ') >= 0) {
      return { intent: 'theme', raw: null, mode: 'dark', label: 'Tema Gelap', score: 0.95 };
    }
    return null;
  }

  function tryTime(low) {
    var flat = ' ' + low.join(' ') + ' ';
    if (flat.indexOf(' jam ') < 0 && flat.indexOf(' pukul ') < 0) return null;
    if (flat.indexOf('jam berapa') >= 0 || flat.indexOf('pukul berapa') >= 0 ||
        flat.indexOf('berapa jam') >= 0 || flat.indexOf('berapa pukul') >= 0) {
      return { intent: 'time', raw: null, score: 0.95 };
    }
    return null;
  }

  // Finds the first todo noun phrase and returns its index/length, or null.
  function findTodoNoun(low) {
    for (var i = 0; i < low.length; i++) {
      var m = matchNoun(low, i);
      if (m) return { phrase: m, index: i, end: i + m.words.length };
    }
    return null;
  }

  function tryTodoList(tokens, low) {
    var noun = findTodoNoun(low);
    if (!noun) return null;

    var strong = -1, weak = -1, i;
    for (i = 0; i < low.length; i++) {
      // Tokens inside the noun phrase are not cues: "to do list" must not make
      // itself a list request through its own "list" token.
      if (i >= noun.index && i < noun.end) continue;
      if (strong < 0 && has(STRONG_CUES, low[i])) strong = i;
      if (weak < 0 && has(WEAK_CUES, low[i])) weak = i;
    }
    if (strong >= 0) return { intent: 'todo_list', raw: null, score: 0.9 };
    // Content words BEFORE the noun with no query cue ("ngendit dan belanja
    // di to do list") mean the user is adding, not listing. Only a strong
    // query cue above may claim a list intent in that shape.
    if (weak < 0 && noun.index > 0) return null;

    var add = findVerbGuarded(low, ADD_VERBS, 0, 4);
    if (weak >= 0) {
      // "lihat to do list" / "tambah tugas, lihat daftar" -> list. A cue after
      // an add verb still means the user wants to see the list.
      if (!add || weak > add.index) return { intent: 'todo_list', raw: null, score: 0.85 };
    }
    if (!add) {
      // No add verb: "tugas saya" / "daftar tugas" asks. "tugas kirim email"
      // without a verb still reads as a task the user wants recorded, so the
      // list reading only stands when nothing but pronouns follows the noun.
      var after = finishText(tokens, noun.end, low.length, null);
      if (!after) return { intent: 'todo_list', raw: null, score: 0.65 };
      var rest = false;
      for (var k = noun.end; k < low.length; k++) {
        if (has(PRONOUNS, low[k]) || has(LEAD_FILLER, low[k])) continue;
        rest = true;
        break;
      }
      if (!rest) return { intent: 'todo_list', raw: null, score: 0.7 };
    }
    return null;
  }

  function tryTodoAdd(tokens, low) {
    var noun = findTodoNoun(low);
    var add = findVerbGuarded(low, ADD_VERBS, 0, 4);
    // "ngendit dan belanja di to do list" has no add verb at all: real content
    // ahead of the noun is enough to count as an add.
    var leadHasContent = false;
    if (noun && noun.index > 0) {
      for (var q0 = 0; q0 < noun.index; q0++) {
        // The verb and the joining preposition are structure, not content:
        // "masukan ke taks" has an empty item, not the item "ke".
        if (has(ADD_VERBS, low[q0]) || has(LEAD_FILLER, low[q0]) ||
            has(PREPOSITIONS, low[q0])) continue;
        leadHasContent = true; break;
      }
    }
    if (!add && !leadHasContent) return null;
    // "buka task manager" carries an open verb: its "task" is part of an app
    // name, not a todo noun. Open phrases belong to tryOpenApp, not here.
    // EXACT match only — fuzzy would steal "buatkan" (1 edit from "bukakan").
    var openHit = false;
    for (var q1 = 0; q1 < low.length; q1++) {
      if (OPEN_VERBS.indexOf(low[q1]) >= 0) { openHit = true; break; }
    }
    if (openHit) return null;
    // "buat" and "bikin" only count as add verbs with a todo noun present,
    // otherwise "buat kopi" would land in the todo store.
    if (!noun && !has(ADD_VERBS_STRONG, low[add.index])) return null;
    // A reminder or timer phrase also carries an add verb ("tambahkan
    // reminder", "buat timer"); those handlers own it, not the todo store.
    if (findVerbGuarded(low, REMINDER_VERBS, 0, 5)) return null;
    if (findWord(low, ['timer', 'countdown'], 0) >= 0) return null;

    // "ngendit dan belanja di to do list": the content sits BEFORE the noun
    // joined by di/ke. Take the tokens ahead of the noun, but only when at
    // least one of them is real content (not the add verb itself, not a
    // filler) — otherwise "buat to do list beli susu" would steal "buat" as
    // the item text. Fall back to the content after the noun.
    var from = noun ? noun.end : add.index + 1;
    var text = null;
    if (leadHasContent) {
      var leadFrom = 0, leadTo = noun.index;
      while (leadFrom < leadTo && (has(ADD_VERBS, low[leadFrom]) || has(LEAD_FILLER, low[leadFrom]))) leadFrom++;
      while (leadTo > leadFrom && /^(?:di|ke)$/.test(low[leadTo - 1])) leadTo--;
      if (leadTo > leadFrom) text = joinRaw(tokens, leadFrom, leadTo);
    }
    if (!text) text = finishText(tokens, from, low.length, null);
    if (!text) {
      // "buat to do list" with no content is almost always "show it", but an
      // explicit add verb with an empty slot ("masukan ke taks") is a broken
      // request, not a list request: hand it to the AI instead of guessing.
      if (noun && add && has(ADD_VERBS_STRONG, low[add.index])) return null;
      if (noun) return { intent: 'todo_list', raw: null, score: 0.6 };
      return null;
    }
    // "masukan apa ke taks" is a question, not a task: never store the cue.
    if (text.split(' ').length === 1 && has(STRONG_CUES, text.toLowerCase())) return null;
    return { intent: 'todo_add', raw: null, text: text, score: 0.9 };
  }

  function tryTimer(tokens, low) {
    var hit = -1, i;
    for (i = 0; i < low.length; i++) {
      if (low[i] === 'timer' || low[i] === 'countdown' || low[i] === 'mundur') { hit = i; break; }
      if (low[i] === 'hitung' && low[i + 1] === 'mundur') { hit = i; break; }
      // "timmer" is a common Whisper typos; "timur" (east) is not.
      if (low[i] !== 'timur' && fuzzy(low[i], 'timer', 1) >= 0) { hit = i; break; }
    }
    if (hit < 0) return null;
    var ms = parseDuration(tokens, low);
    if (ms == null) return null;
    return { intent: 'timer', raw: null, ms: ms, score: 0.92 };
  }

  function tryReminder(tokens, low, now) {
    var verb = findVerbGuarded(low, REMINDER_VERBS, 0, 5);
    if (!verb) return null;
    var ref = parseTimeRef(tokens, low, now);
    if (!ref) return null;
    var skip = spanSet(ref.start, ref.end);
    for (var d = 0; d < ref.dayWords.length; d++) skip[ref.dayWords[d]] = 1;
    var text = finishText(tokens, verb.index + 1, low.length, skip);
    return {
      intent: 'reminder_add',
      raw: null,
      text: text,
      at: ref.at,
      score: ref.at.ambiguous ? 0.75 : 0.9
    };
  }

  function tryVolume(tokens, low) {
    var vIdx = -1, i;
    var up = setOf(['besarkan', 'besarin', 'naikkan', 'naikin', 'tinggikan', 'keraskan', 'keras']);
    var down = setOf(['kecilkan', 'kecilin', 'turunkan', 'turunin', 'pelankan', 'rendahkan', 'pelan']);
    for (i = 0; i < low.length; i++) {
      if (low[i] === 'volume' || low[i] === 'volum') { vIdx = i; break; }
      if (low[i] === 'mute' || low[i] === 'bisukan') { vIdx = i; break; }
      if (fuzzy(low[i], 'volume', 1) >= 0) { vIdx = i; break; }
    }
    var dir = 0;
    for (i = 0; i < low.length; i++) {
      if (has(up, low[i])) { dir = 1; break; }
      if (has(down, low[i])) { dir = -1; break; }
    }
    if (vIdx < 0) {
      // "kecilkan suara" is a volume command without the word "volume", but
      // only when a direction word makes the meaning unambiguous.
      if (dir && findWord(low, ['suara', 'audio'], 0) >= 0) {
        return { intent: 'volume', raw: null, delta: dir * 10, score: 0.8 };
      }
      return null;
    }
    if (low[vIdx] === 'mute' || low[vIdx] === 'bisukan') {
      return { intent: 'volume', raw: null, level: 0, score: 0.88 };
    }
    var level = -1;
    for (i = vIdx + 1; i < low.length; i++) {
      if (/^[0-9]{1,3}$/.test(low[i])) { level = parseInt(low[i], 10); break; }
    }
    if (level >= 0) return { intent: 'volume', raw: null, level: clamp(level, 0, 100), score: 0.9 };
    for (i = vIdx + 1; i < low.length; i++) {
      if (low[i] === 'maksimal' || low[i] === 'maks' || low[i] === 'penuh') {
        return { intent: 'volume', raw: null, level: 100, score: 0.88 };
      }
    }
    if (dir) return { intent: 'volume', raw: null, delta: dir * 10, score: 0.88 };
    if (low[vIdx + 1] === 'naik') return { intent: 'volume', raw: null, delta: 10, score: 0.85 };
    if (low[vIdx + 1] === 'turun') return { intent: 'volume', raw: null, delta: -10, score: 0.85 };
    return null;
  }

  // ---- deterministic web intents -------------------------------------------
  // YouTube and WhatsApp have no generic slot: "putar video X paling baru"
  // must resolve the NEWEST video (so the recency marker belongs to the
  // intent, not the query), and "kirim pesan ke X di whatsapp Y" carries two
  // fields (contact + message) that open_app/search_file cannot hold. All
  // matching below is exact-token work on purpose: a misheard query must
  // reach YouTube as the user said it, not be silently repaired.

  // Words that mean "no real query was said": "putar video dulu" must stay
  // unknown instead of searching YouTube for the word "dulu".
  var NONQUERY = setOf([
    'dulu', 'dong', 'deh', 'sih', 'aja', 'saja', 'ya', 'yah', 'nih',
    'kok', 'lah', 'lagi', 'nanti', 'sekarang', 'sana', 'situ', 'gitu',
    'yang', 'apa', 'paling', 'baru', 'terbaru'
  ]);
  // "buka tab <site>" hands the site to the browser, so these words are
  // never the site: "buka file explorer di chrome" stays open_app explorer.
  var TAB_SITE_BLOCK = setOf(['tab', 'browser', 'file', 'dokumen', 'pintu', 'jendela', 'aplikasi', 'app']);
  var BROWSER_WORDS = setOf(['chrome', 'browser', 'edge', 'firefox', 'brave', 'opera']);

  function allNonQuery(low, from, to) {
    for (var i = from; i < to; i++) {
      if (!has(NONQUERY, low[i])) return false;
    }
    return true;
  }

  // Joins tokens [from, to) back into text, keeping the raw casing. cleanText
  // only trims edge punctuation and trailing particles; stripLead would eat a
  // leading "di" from messages like "di rumah saja".
  function joinRaw(tokens, from, to) {
    var raws = [];
    for (var i = from; i < to; i++) raws.push(tokens[i].raw);
    return cleanText(raws.join(' '));
  }

  // Resolves a site phrase through the alias table so the answer says
  // "YouTube" and the executor gets its stable key; unknown sites pass
  // through and fall back to https://<name>.com in the executor.
  function siteKey(siteText) {
    var s = String(siteText || '').toLowerCase();
    for (var i = 0; i < APPS.length; i++) {
      for (var j = 0; j < APPS[i].aliases.length; j++) {
        if (APPS[i].aliases[j] === s) return { key: APPS[i].key, label: APPS[i].label };
      }
    }
    return null;
  }

  // Index just past "putar video" (0/1 leading filler allowed), else -1.
  function putarVideoStart(low) {
    var n = low.length;
    if (low[0] === 'putar' && low[1] === 'video') return 2;
    if (n > 2 && has(LEAD_FILLER, low[0]) && low[1] === 'putar' && low[2] === 'video') return 3;
    return -1;
  }

  // putar video <query> [yang] paling (baru|terbaru) / <query> terbaru
  // -> youtube_play. The marker must close the utterance; a bare trailing
  // "baru" is not a marker because "video baru" is a query of its own.
  function tryYoutubePlay(tokens, low) {
    var n = low.length;
    var start = putarVideoStart(low);
    if (start < 0 || start >= n) return null;
    if (low[start] === 'yang' && start + 1 < n) start++;
    var last = low[n - 1];
    if (last !== 'baru' && last !== 'terbaru') return null;
    var k = n - 1;
    var strong = last === 'terbaru';
    if (k - 1 >= start && low[k - 1] === 'paling') { k--; strong = true; }
    if (k - 1 >= start && low[k - 1] === 'yang') k--;
    if (!strong || k <= start || allNonQuery(low, start, k)) return null;
    var rawQuery = joinRaw(tokens, start, k);
    // Clean out trailing "di youtube" or "cari" that user said before "paling baru"
    rawQuery = rawQuery.replace(/\s+di\s+(?:youtube|yt)\b/gi, "").replace(/\s+cari\b/gi, "").trim();
    return { intent: "youtube_play", raw: null, query: rawQuery, label: "YouTube", score: 0.95 };
  }

  // putar video <query> [di youtube] / cari|search di youtube <query>
  // / cari|search <query> di youtube -> youtube search page.
  function tryYoutube(tokens, low) {
    var n = low.length, i, v = -1;
    var start = putarVideoStart(low);
    if (start > 0 && start < n) {
      var end = n;
      // optional trailing "di youtube"
      if (end - 2 >= start && low[end - 2] === 'di' && (low[end - 1] === 'youtube' || low[end - 1] === 'yt')) {
        end -= 2;
      }
      if (low[start] === 'yang' && start + 1 < end) start++;
      if (end > start && !allNonQuery(low, start, end)) {
        return { intent: 'youtube', raw: null, query: joinRaw(tokens, start, end), label: 'YouTube', score: 0.95 };
      }
    }
    for (i = 0; i < n && i < 3; i++) {
      if (low[i] === 'cari' || low[i] === 'carikan' || low[i] === 'cariin' || low[i] === 'search') { v = i; break; }
    }
    if (v < 0) return null;
    // cari di youtube <query>
    if (low[v + 1] === 'di' && (low[v + 2] === 'youtube' || low[v + 2] === 'yt')) {
      if (n > v + 3 && !allNonQuery(low, v + 3, n)) {
        return { intent: 'youtube', raw: null, query: joinRaw(tokens, v + 3, n), label: 'YouTube', score: 0.95 };
      }
      return null;
    }
    // cari <query> di youtube
    if (n - 2 > v + 1 && low[n - 2] === 'di' && (low[n - 1] === 'youtube' || low[n - 1] === 'yt') &&
        !allNonQuery(low, v + 1, n - 2)) {
      return { intent: 'youtube', raw: null, query: joinRaw(tokens, v + 1, n - 2), label: 'YouTube', score: 0.95 };
    }
    // Bare "cari <query>" with no site marker: if the last successful web
    // action opened YouTube, the follow-up belongs there. Anything else
    // stays unknown so the AI gets it with its own context.
    if (typeof window !== 'undefined' && window.dnCtx && window.dnCtx.lastSite === 'youtube.com') {
      if (n > v + 1 && !allNonQuery(low, v + 1, n)) {
        return { intent: 'youtube', raw: null, query: joinRaw(tokens, v + 1, n), label: 'YouTube', score: 0.8 };
      }
    }
    return null;
  }

  // kirim [pesan|wa] ke <contact> [di whatsapp] <message> -> whatsapp.
  // With the "di whatsapp" marker the contact may be several words; without
  // it the contact is the single word after "ke" and the rest is the
  // message. "kirim wa ke budi" with no message stays unknown: the executor
  // refuses empty messages, so the AI should get the utterance instead.
  function tryWhatsapp(tokens, low) {
    var n = low.length, i, v = -1;
    if (low[0] === 'kirim') v = 0;
    else if (n > 2 && has(LEAD_FILLER, low[0]) && low[1] === 'kirim') v = 1;
    if (v < 0) return null;
    i = v + 1;
    if (low[i] === 'pesan' || low[i] === 'wa') i++;
    if (low[i] !== 'ke') return null;
    i++;
    if (i >= n) return null;
    var mark = -1, k;
    for (k = i; k < n - 1; k++) {
      if (low[k] === 'di' && (low[k + 1] === 'whatsapp' || low[k + 1] === 'wa')) { mark = k; break; }
    }
    var contactTo, msgFrom;
    if (mark === i) return null;                 // "ke di whatsapp": no contact
    if (mark > i) { contactTo = mark; msgFrom = mark + 2; }
    else { contactTo = i + 1; msgFrom = i + 1; } // no marker: one-word contact
    if (contactTo > n || msgFrom > n) return null;
    var contact = joinRaw(tokens, i, contactTo);
    var message = joinRaw(tokens, msgFrom, n);
    if (!contact || !message) return null;
    return { intent: 'whatsapp', raw: null, contact: contact, message: message, label: 'WhatsApp', score: 0.9 };
  }

  // "buka tab <site>" / "buka <site> di chrome|browser" open a BROWSER TAB.
  // WhatsApp Web lives in the browser and the desktop app is not installed,
  // so open_app would fail with "tidak ditemukan di aplikasi terinstal".
  // This handler must sit before tryOpenApp in the chain.
  var TAB_WEB_KEYS = {
    youtube: 'YouTube', yutub: 'YouTube', yt: 'YouTube',
    whatsapp: 'WhatsApp', wa: 'WhatsApp',
    gmail: 'Gmail'
  };

  function tryOpenTab(tokens, low, raw) {
    var n = low.length;
    if (n === 0) return null;

    // Bare domain check: "youtube.com", "https://youtube.com", "youtube com"
    var rawText = String(raw || '').trim().toLowerCase();
    var mRaw = rawText.match(/^(?:https?:\/\/)?([a-z0-9._-]+\.(?:com|org|net|io|id|tv|co)(?:\/[^\s]*)?)$/i);
    if (mRaw) {
      var dom = mRaw[1];
      var base = dom.split(/[./]/)[0];
      var hitB = TAB_WEB_KEYS[base] ? { key: (base === 'yt' || base === 'yutub') ? 'youtube' : (base === 'wa' ? 'whatsapp' : base), label: TAB_WEB_KEYS[base] } : null;
      return {
        intent: 'open_tab', raw: null,
        app: hitB ? hitB.key : base,
        label: hitB ? hitB.label : base,
        url: /^https?:\/\//i.test(rawText) ? rawText : ('https://' + dom),
        score: 0.95
      };
    }
    if ((n === 2 || (n === 3 && (low[0] === 'https' || low[0] === 'http'))) && /^(?:com|org|net|id|io|tv|co)$/.test(low[n - 1])) {
      var brand = (n === 3) ? low[1] : low[0];
      var hitB2 = TAB_WEB_KEYS[brand] ? { key: (brand === 'yt' || brand === 'yutub') ? 'youtube' : (brand === 'wa' ? 'whatsapp' : brand), label: TAB_WEB_KEYS[brand] } : null;
      return {
        intent: 'open_tab', raw: null,
        app: hitB2 ? hitB2.key : brand,
        label: hitB2 ? hitB2.label : brand,
        url: 'https://' + brand + '.' + low[n - 1],
        score: 0.95
      };
    }

    if (n < 2 || OPEN_VERBS.indexOf(low[0]) < 0) return null;
    var start = 1;
    var isTab = low[start] === 'tab';
    if (isTab) start++;
    // trailing browser marker: "di chrome" / "di google chrome" / "di browser"
    var end = n;
    var sawBrowser = false;
    if (end - 3 >= start && low[end - 3] === 'di' && low[end - 2] === 'google' && low[end - 1] === 'chrome') {
      end -= 3; sawBrowser = true;
    } else if (end - 2 >= start && low[end - 2] === 'di' && has(BROWSER_WORDS, low[end - 1])) {
      end -= 2; sawBrowser = true;
    }
    if (end <= start || has(TAB_SITE_BLOCK, low[start])) return null;

    var site = joinRaw(tokens, start, end);
    if (!site) return null;
    var siteLow = site.toLowerCase();
    var firstWord = low[start];
    var isWebOnly = has(TAB_WEB_KEYS, firstWord) || has(TAB_WEB_KEYS, siteLow) ||
      (end - start >= 2 && /^(?:com|org|net|id|io|tv|co)$/.test(low[end - 1])) ||
      /\.(?:com|org|net|io|id|tv|co)\b/i.test(rawText);

    if (!isTab && !sawBrowser && !isWebOnly) return null; // plain "buka X" for desktop apps is open_app's job

    var hit = siteKey(site);
    var targetKey = hit ? hit.key : (TAB_WEB_KEYS[firstWord] ? ((firstWord === 'yt' || firstWord === 'yutub') ? 'youtube' : (firstWord === 'wa' ? 'whatsapp' : firstWord)) : site.toLowerCase());
    var targetLabel = hit ? hit.label : (TAB_WEB_KEYS[firstWord] || site);
    return {
      intent: 'open_tab', raw: null,
      app: targetKey,
      label: targetLabel,
      score: 0.95
    };
  }

  // "carikan CV saya" -> {query:"CV"}, "carikan si visanya di download" ->
  // {query:"visa", hint:"download"}, "cari file excel" -> {query:"excel"}.
  //
  // Two shapes qualify as a file request:
  //   a) the explicit request form: carikan / cariin ("carikan CV saya")
  //   b) a file-ish word in the query: file, dokumen, pdf, cv, visa, surat,
  //      laporan, download, desktop, ...
  // A bare "cari <something>" with none of those stays a chat question, so
  // "cari makan siang" still reaches the AI. "cari di youtube X" never gets
  // here at all: tryYoutube runs first.
  function trySearch(tokens, low) {
    var verb = findVerbGuarded(low, SEARCH_VERBS, 0, 4);
    if (!verb) return null;
    var n = low.length;
    var explicit = low[verb.index] === 'carikan' || low[verb.index] === 'cariin';

    // Pass 1: location markers ("di download", "di folder dokumen", "di
    // desktop") say WHERE to look, so they are removed from the query and
    // become the hint the backend uses to bias its folder walk.
    var hint = '';
    var keep = [];
    var i;
    for (i = verb.index + 1; i < n; i++) {
      if (low[i] === 'di') {
        var j = i + 1;
        // "di folder download" / "di dalam dokumen": the folder word is
        // optional filler, the location is the word after it.
        if (low[j] === 'folder' || low[j] === 'dalam') j++;
        if (has(FILE_HINTS, low[j])) {
          hint = FILE_HINTS[low[j]];
          i = j;
          continue;
        }
      }
      keep.push(i);
    }

    // Pass 2: normalise each kept word. "visanya" is how Whisper hears "visa
    // nya"; the possessive suffix is not part of a filename.
    var words = [];
    for (i = 0; i < keep.length; i++) {
      var idx = keep[i];
      var w = low[idx];
      var raw = tokens[idx].raw;
      if (w.length >= 5 && /nya$/.test(w)) {
        var base = w.slice(0, w.length - 3);
        // A 2-letter base is only believable for "cvnya": "kenya" and "tanya"
        // are words of their own, not "ke"/"ta" plus a possessive.
        if (base.length >= 3 || base === 'cv') {
          w = base;
          raw = raw.slice(0, raw.length - 3);
        }
      }
      words.push({ low: w, raw: raw });
    }

    // Pass 3: what kind of request is this? A cue word, an extension, a
    // document topic, or a location marker ("di download") all count. The
    // explicit verb needs none of them — but it still needs something to
    // search for: a bare "carikan" is not a file name.
    if (!words.length && !hint) return null;
    var hasCue = false, hasTopic = false, fallback = '';
    for (i = 0; i < words.length; i++) {
      if (has(FILE_CUES, words[i].low)) {
        hasCue = true;
        if (!fallback) fallback = words[i].raw;
      }
      if (has(EXTS, words[i].low) || has(FILE_TOPIC, words[i].low)) hasTopic = true;
    }
    if (!explicit && !hasCue && !hasTopic && !hint) return null;

    // Pass 4: drop the leading cue phrase ("file", "dokumen namanya", "yang")
    // so the query is the name the user actually said.
    var from = 0;
    while (from < words.length && (has(FILE_CUES, words[from].low) ||
      words[from].low === 'yang' || words[from].low === 'namanya' ||
      words[from].low === 'bernama' || words[from].low === 'nama')) {
      from++;
    }
    // Pass 5: pronouns and other non-name words. They are dropped anywhere
    // because "CV saya" must search CV, not "CV saya".
    var picked = [];
    for (i = from; i < words.length; i++) {
      if (has(QUERY_NOISE, words[i].low)) continue;
      picked.push(words[i].raw);
    }
    // "carikan file saya" names no file at all: the explicit request form
    // still goes to the backend (searching "file" beats asking the AI), but a
    // bare "cari file" with no name stays unknown.
    if (!picked.length) {
      if (!explicit && !hint) return null;
      picked.push(fallback || 'file');
    }

    var query = cleanText(picked.join(' '));
    if (!query) return null;
    var out = { intent: 'search_file', raw: null, query: query, score: 0.88 };
    if (hint) out.hint = hint;
    return out;
  }

  function tryOpenApp(tokens, low) {
    var verb = findVerbGuarded(low, OPEN_VERBS, 0, 4);
    var app;
    if (verb) {
      app = findApp(low, verb.index + 1);
      if (!app) return null;
      var score = (verb.dist === 0 && app.dist === 0) ? 0.95 : 0.85;
      return { intent: 'open_app', raw: null, app: app.key, label: app.label, score: score };
    }
    // Bare "chrome" fallback. Exact alias only, and it must cover the whole
    // utterance, so a stray word cannot launch anything.
    app = findApp(low, 0);
    if (!app || app.dist !== 0 || app.index !== 0) return null;
    if (finishText(tokens, app.index + app.len, low.length, null)) return null;
    return { intent: 'open_app', raw: null, app: app.key, label: app.label, score: 0.7 };
  }

  // ---- entry point ---------------------------------------------------------

  function parse(text) {
    var raw = String(text == null ? '' : text).replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
    var tokens = tokenize(raw);
    var low = lows(tokens);
    if (!low.length) return unknown(raw);
    var now = Date.now();

    var r = tryTheme(low) ||
      tryTime(low) ||
      tryTodoList(tokens, low) ||
      tryTodoAdd(tokens, low) ||
      tryTimer(tokens, low) ||
      tryReminder(tokens, low, now) ||
      tryVolume(tokens, low) ||
      tryYoutubePlay(tokens, low) ||
      tryYoutube(tokens, low) ||
      tryWhatsapp(tokens, low) ||
      tryOpenTab(tokens, low, raw) ||
      trySearch(tokens, low) ||
      tryOpenApp(tokens, low);

    if (!r) return unknown(raw);
    if (r.raw == null) r.raw = raw;
    return r;
  }

  window.dnIntent = {
    parse: parse,
    siteKey: siteKey,
    // Read-only table: keys and TTS labels, nothing to launch with.
    APPS: APPS
  };
})();
