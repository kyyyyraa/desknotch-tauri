// dn-harness.js - DeskNotch: Claude-Code-style slash commands for the notch
// Conversation tab.
//
// The tab input accepts plain chat (the chunk routes that to dnRouter.ask
// itself) plus a small set of /commands handled here, so the model is never
// asked about things the app can answer locally. Public API (window.dnHarness):
//   parse(line)        -> {kind:"command", name, args, raw} | {kind:"chat", text}
//   format(text)       -> string   tidy AI output for the narrow card
//   runCommand(parsed) -> Promise<string>  never rejects, never throws
//   history(n)         -> array    last n exchanges from dnConvo
//   install()          -> boolean  idempotent marker, no DOM work
//
// Loaded as a classic <script src>, so this file stays ES5: var/function and
// string concat only, one IIFE, no top-level await, no import/export. The
// other dn-* renderer scripts follow the same rule (see dn-intent.js).
(function () {
  'use strict';
  // Scripts here can be injected again on tab remounts; the first one wins,
  // and install() being callable twice is part of the same guarantee.
  if (window.dnHarness) return;

  // ---- optional globals ----------------------------------------------------
  // Every collaborator (bridge, dnRouter, dnConvo) loads independently and may
  // not exist yet, so each lookup is guarded instead of trusted.
  function getBridge() {
    try { return (window && window.bridge) || null; } catch (_) { return null; }
  }

  function getRouter() {
    try { return (window && window.dnRouter) || null; } catch (_) { return null; }
  }

  function getConvo() {
    try { return (window && window.dnConvo) || null; } catch (_) { return null; }
  }

  // ---- parse ---------------------------------------------------------------

  // Leading spaces are tolerated because the input field keeps whatever the
  // user typed; internal spacing of /term args is preserved because a shell
  // command may legitimately contain doubled spaces (quoted args and so on).
  function parse(line) {
    var text = String(line == null ? '' : line);
    var trimmed = text.replace(/^\s+/, '').replace(/\s+$/, '');
    if (trimmed.charAt(0) !== '/') {
      return { kind: 'chat', text: trimmed };
    }
    var m = trimmed.match(/^\/([a-zA-Z0-9_-]+)(?:\s+([\s\S]*))?$/);
    if (!m) {
      // A bare "/" is still an attempt at a command: it must reach the local
      // handler (which answers with the help hint), never the AI.
      return { kind: 'command', name: '', args: '', raw: trimmed };
    }
    return {
      kind: 'command',
      name: m[1].toLowerCase(),   // /HELP and /help are the same command
      args: (m[2] || '').replace(/\s+$/, ''),
      raw: trimmed
    };
  }

  // ---- format --------------------------------------------------------------

  // "Tentu," / "Baik," openers are politeness padding on a 420px card. Only a
  // short first sentence is removed (a filler is short by nature); if nothing
  // would remain, e.g. the answer is just "Tentu, selesai.", the text stays.
  function stripFiller(text) {
    var m = text.match(/^[ \t]*(tentu|baik)\b/i);
    if (!m) return text;
    var rest = text.slice(m[0].length);
    var limit = Math.min(rest.length, 100);
    for (var i = 0; i < limit; i++) {
      var ch = rest.charAt(i);
      if (ch === '.' || ch === '!' || ch === '?' || ch === ':' || ch === '\n') {
        var remainder = rest.slice(i + 1).replace(/^[ \t\n]+/, '');
        return remainder ? remainder : text;
      }
    }
    return text;
  }

  // No truncation here: the card scrolls, cutting an answer silently is worse
  // than a scrollbar. Indentation inside surviving text is kept, so pasted
  // code without fences still reads correctly.
  function format(text) {
    var t = String(text == null ? '' : text);
    var lines = t.split(/\r?\n/);
    var kept = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      // A fence line (``` or ```lang) is structure, not content; skipping the
      // whole line removes the language tag with it.
      if (/^[ \t]*```/.test(line)) continue;
      line = line.replace(/[ \t]+$/, '');
      var m = line.match(/^[ \t]*([#>]+)[ \t]*/);
      if (m) line = line.slice(m[0].length);   // markdown headings and quotes
      kept.push(line);
    }
    t = kept.join('\n');
    // Inline markers (```code```) survive the line filter above.
    // The card renders plain text, so markdown emphasis would appear as
    // literal asterisks. Strip the markers and keep the words.
    t = t.replace(/```/g, '');
    t = t.replace(/\*\*(.+?)\*\*/g, '$1');
    t = t.replace(/(^|[^\w*])\*([^*\n]+)\*(?![\w*])/g, '$1$2');
    t = t.replace(/`([^`\n]+)`/g, '$1');
    t = t.replace(/^[ \t]*[-*+][ \t]+/gm, '\u2022 ');
    t = t.replace(/\n{3,}/g, '\n\n');
    t = stripFiller(t);
    return t.replace(/^[ \t\n]+/, '').replace(/[ \t\n]+$/, '');
  }

  // ---- commands ------------------------------------------------------------

  // One line per command, plain text: this string lands in the chat card, so
  // any markdown would render as literal characters.
  function helpText() {
    return [
      'Perintah yang tersedia:',
      '/help - tampilkan bantuan ini',
      '/model - lihat daftar model AI (model chat ditandai *)',
      '/model <nama> - ganti model AI untuk chat',
      '/model voice <nama> - ganti model AI untuk suara',
      '/model chat <nama> - ganti model AI untuk chat',
      '/model-voice <nama> - sama dengan /model voice',
      '/model-chat <nama> - sama dengan /model chat',
      '/models - sama dengan /model',
      '/clear - hapus memori percakapan',
      '/term <perintah> - jalankan perintah shell (minta izin dulu)'
    ].join('\n');
  }

  // The two surfaces can use different models. The chat model is the one the
  // Conversation tab uses; the voice model is the one the spoken loop uses.
  // An empty per-surface pick falls back to the shared model, so listing both
  // is enough to see what is actually in effect.
  function currentModels() {
    var out = { chat: '', voice: '' };
    try {
      var router = getRouter();
      var p = (router && typeof router.peek === 'function') ? router.peek() : null;
      if (p) {
        out.chat = String(p.convoModel || p.model || '');
        out.voice = String(p.voiceModel || p.model || '');
      }
    } catch (_) {}
    return out;
  }

  function doListModels() {
    var router = getRouter();
    if (!router || typeof router.listModels !== 'function') {
      return Promise.resolve('Router AI belum siap. Isi API key 9router dulu di pengaturan.');
    }
    var cur = currentModels();
    return Promise.resolve().then(function () {
      return router.listModels();
    }).then(function (list) {
      if (!list || !list.length) {
        return 'Tidak ada model yang bisa diambil. Pastikan 9router jalan dan API key sudah diisi.';
      }
      var lines = ['Model yang tersedia:'];
      for (var i = 0; i < list.length; i++) {
        var id = String(list[i] == null ? '' : list[i]);
        if (!id) continue;
        var mark = id === cur.chat ? '* ' : '  ';
        lines.push(mark + id + (id === cur.voice ? '  (suara)' : ''));
      }
      lines.push('');
      lines.push('Chat: ' + (cur.chat || '(model bersama)'));
      lines.push('Suara: ' + (cur.voice || '(model bersama)'));
      return lines.join('\n');
    }).catch(function () {
      return 'Gagal mengambil daftar model.';
    });
  }

  // Which surface a /model command targets. The default is the chat model:
  // this harness lives in the Conversation tab, so a bare /model <nama> means
  // "the model this tab talks to".
  function targetSurface(surface) {
    return surface === 'voice' ? 'voice' : 'chat';
  }

  function doSetModel(name, surface) {
    var router = getRouter();
    if (!router || typeof router.configure !== 'function') {
      return Promise.resolve('Router AI belum siap, model tidak bisa diganti.');
    }
    var target = String(name || '').replace(/^\s+/, '').replace(/\s+$/, '');
    if (!target) return doListModels();
    var which = targetSurface(surface);
    var patch = which === 'voice' ? { voiceModel: target } : { convoModel: target };
    // Persisting happens inside dnRouter.configure; the harness only reports.
    return Promise.resolve().then(function () {
      return router.configure(patch);
    }).then(function (ok) {
      return ok === false
        ? 'Gagal menyimpan model ' + target + '.'
        : 'Model ' + (which === 'voice' ? 'suara' : 'chat') + ' sekarang: ' + target + '.';
    }).catch(function () {
      return 'Gagal mengganti model ke ' + target + '.';
    });
  }

  function doClear() {
    var convo = getConvo();
    if (!convo || typeof convo.clear !== 'function') {
      return Promise.resolve('Memori percakapan tidak tersedia.');
    }
    return Promise.resolve().then(function () {
      return convo.clear();
    }).then(function () {
      return 'Percakapan dihapus.';
    }).catch(function () {
      // dnConvo.clear empties the in-memory list before it persists, so the
      // tab is already clean even when the store write failed.
      return 'Percakapan dihapus (catatan gagal disimpan ke store).';
    });
  }

  // {ok, out} -> "exit N" first line, then the output. A numeric code is
  // honoured when the shell side sends one, because ok alone cannot tell
  // exit 2 from exit 1. 4000 chars keeps a runaway dump from freezing the card.
  function renderShellResult(res) {
    var okFlag = !!(res && res.ok);
    var code = okFlag ? 0 : 1;
    if (res && typeof res.code === 'number' && isFinite(res.code)) code = res.code;
    var out = (res && res.out != null) ? String(res.out) : '';
    if (out.length > 4000) out = out.slice(0, 4000);
    return 'exit ' + code + '\n' + out;
  }

  function doTerm(command) {
    var cmd = String(command == null ? '' : command).replace(/^\s+/, '').replace(/\s+$/, '');
    if (!cmd) return Promise.resolve('Pakai: /term <perintah shell>');
    var bridge = getBridge();
    if (!bridge || typeof bridge.invoke !== 'function') {
      return Promise.resolve('Jembatan aplikasi tidak tersedia.');
    }
    // Approval first, always: the gate is the only thing standing between a
    // chat line and a shell prompt on the user's machine. A broken gate must
    // fall on the safe side (no execution), unlike dn-voice-exec which can
    // assume the card is up because the voice flow just rendered it.
    var asked;
    try {
      asked = Promise.resolve(bridge.invoke('dnai:request-approval', {
        title: 'Jalankan perintah?',
        detail: '$ ' + cmd,
        tool: 'shell'
      }));
    } catch (_) {
      return Promise.resolve('Pintu izin tidak bisa dibuka, perintah tidak dijalankan.');
    }
    return asked.then(function (approved) {
      // Exactly false is the denial value the approval card sends; any other
      // shape counts as approved, same rule dn-voice-exec.js applies.
      if (approved === false) return 'Dibatalkan.';
      var run;
      try {
        run = Promise.resolve(bridge.invoke('dn:shell', { cmd: cmd }));
      } catch (_) {
        return Promise.resolve('Gagal menjalankan perintah.');
      }
      return run.then(renderShellResult).catch(function () {
        return 'Gagal menjalankan perintah.';
      });
    }).catch(function () {
      return 'Pintu izin gagal, perintah tidak dijalankan.';
    });
  }

  // Never rejects: the chunk renders the resolved string straight into the
  // card, so every failure path has to arrive as a short human message.
  function runCommand(parsed) {
    try {
      if (!parsed || parsed.kind !== 'command') {
        // Chat is answered by the chunk through dnRouter.ask, not here.
        return Promise.resolve(parsed && parsed.kind === 'chat' ? parsed.text : '');
      }
      var name = String(parsed.name || '');
      if (name === 'help') return Promise.resolve(helpText());
      if (name === 'model') {
        // "/model voice X" and "/model chat X" pick the surface explicitly;
        // a bare "/model X" means the chat model.
        var argParts = String(parsed.args || '').trim().split(/\s+/);
        var head = String(argParts[0] || '').toLowerCase();
        if (head === 'voice' || head === 'suara' || head === 'chat') {
          var rest = argParts.slice(1).join(' ');
          if (!rest) return doListModels();
          return doSetModel(rest, head === 'voice' || head === 'suara' ? 'voice' : 'chat');
        }
        return parsed.args ? doSetModel(parsed.args, 'chat') : doListModels();
      }
      if (name === 'model-voice') return parsed.args ? doSetModel(parsed.args, 'voice') : doListModels();
      if (name === 'model-chat') return parsed.args ? doSetModel(parsed.args, 'chat') : doListModels();
      if (name === 'models') return doListModels();
      if (name === 'clear') return doClear();
      if (name === 'term') return doTerm(parsed.args);
      // Unknown: answered locally, the AI never sees a mangled command.
      return Promise.resolve('Perintah tidak dikenal. Bantuan: ketik /help');
    } catch (_) {
      return Promise.resolve('Ada yang salah di dalam harness.');
    }
  }

  // The last n exchanges, oldest first, straight from the shared memory so
  // the harness and the tab can never disagree about the thread.
  function history(n) {
    var convo = getConvo();
    if (!convo || typeof convo.recent !== 'function') return [];
    try {
      var list = convo.recent(typeof n === 'number' ? n : undefined);
      return list || [];
    } catch (_) {
      return [];
    }
  }

  // Deliberately a marker only: the harness is pure and stateless, and adding
  // DOM from here would fight the chunk's React rendering.
  var installed = false;
  function install() {
    if (installed) return false;
    installed = true;
    return true;
  }

  window.dnHarness = {
    parse: parse,
    format: format,
    runCommand: runCommand,
    history: history,
    install: install
  };
})();
