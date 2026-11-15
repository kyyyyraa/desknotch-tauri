// r72t: 9router retry, context memory (dnCtx), notification click-to-open.
const fs = require('fs');
const path = require('path');
const UI = path.join(__dirname, '..', 'ui');
const NL = String.fromCharCode(10);
let fail = 0;

function patch(file, edits) {
  const p = path.join(UI, file);
  let src = fs.readFileSync(p, 'utf8');
  for (const [name, from, to] of edits) {
    if (!src.includes(from)) { console.error('NOT FOUND [' + file + '/' + name + ']'); fail = 1; continue; }
    src = src.split(from).join(to);
    console.log('OK [' + file + '/' + name + ']');
  }
  fs.writeFileSync(p, src, 'utf8');
}

// ---------------- dn-router.js: retry on transient failure ----------------
patch('dn-router.js', [
  ['httpJson retry', (
    '    var payload = { url: url, method: method, headers: headers || {} };' + NL +
    '    if (body != null) payload.body = body;' + NL +
    '    return Promise.resolve(b.invoke("dnrouter:http", payload)).then(function (res) {' +
    '      if (!res || typeof res !== "object") throw new Error("tidak ada jawaban dari 9router");' +
    '      if (!res.ok && !res.status) throw new Error(res.error || "tidak bisa menghubungi 9router");' +
    '      return { ok: !!res.ok, status: Number(res.status) || 0, text: String(res.body || "") };' +
    '    });'
  ), (
    '    var payload = { url: url, method: method, headers: headers || {} };' + NL +
    '    if (body != null) payload.body = body;' + NL +
    '    // The gateway is an SSH tunnel on localhost: it hiccups. One quick' + NL +
    '    // retry turns "kadang konek kadang tidak" into "kadang 1 detik telat".' + NL +
    '    var attempt = function () {' + NL +
    '      return Promise.resolve(b.invoke("dnrouter:http", payload)).then(function (res) {' + NL +
    '        if (!res || typeof res !== "object") throw new Error("tidak ada jawaban dari 9router");' + NL +
    '        if (!res.ok && !res.status) throw new Error(res.error || "tidak bisa menghubungi 9router");' + NL +
    '        return { ok: !!res.ok, status: Number(res.status) || 0, text: String(res.body || "") };' + NL +
    '      });' + NL +
    '    };' + NL +
    '    return attempt().catch(function (e1) {' + NL +
    '      try { if (window.bridge && window.bridge.send) window.bridge.send("dnptt:log", "9router retry: " + (e1 && e1.message ? e1.message : e1)); } catch (_) {}' + NL +
    '      return new Promise(function (r) { setTimeout(r, 1200); }).then(attempt);' + NL +
    '    });'
  )],
]);

// ---------------- dn-voice-exec.js: record context after each success ----
patch('dn-voice-exec.js', [
  ['ctx init', (
    '  // Free-form question: hand it to 9router. If the router is not configured,'
  ), (
    '  // Session context: what the last successful web action opened. The local' + NL +
    '  // parser has no memory of its own, so follow-ups like "buka youtube" then' + NL +
    '  // "cari windah" need this to land in the right place.' + NL +
    '  var dnCtx = { lastSite: "", lastLabel: "" };' + NL +
    '  function dnCtxRecord(site, label) {' + NL +
    '    dnCtx.lastSite = String(site || "").toLowerCase();' + NL +
    '    dnCtx.lastLabel = String(label || "");' + NL +
    '    try { window.dnCtx = dnCtx; } catch (_) {}' + NL +
    '  }' + NL +
    '  try { window.dnCtx = dnCtx; } catch (_) {}' + NL +
    '' + NL +
    '  // Free-form question: hand it to 9router. If the router is not configured,'
  )],
  ['ctx: open_tab success', (
    '      setTimeout(function () {' + NL +
    '        invoke(\'app:focus-window\', key.split(/[^\w-]+/)[0]).then(undefined, function () {});' + NL +
    '      }, 600);' + NL +
    '      return \'Membuka tab \' + name;'
  ), (
    '      setTimeout(function () {' + NL +
    '        invoke(\'app:focus-window\', key.split(/[^\w-]+/)[0]).then(undefined, function () {});' + NL +
    '      }, 600);' + NL +
    '      dnCtxRecord(key, name);' + NL +
    '      return \'Membuka tab \' + name;'
  )],
  ['ctx: youtube_play success', (
    "        var label = v.title ? String(v.title).replace(/\s+/g, ' ').trim() : q;" + NL +
    "        if (label.length > 60) label = label.slice(0, 57) + '...';" + NL +
    "        return 'Memutar: ' + label;"
  ), (
    "        var label = v.title ? String(v.title).replace(/\s+/g, ' ').trim() : q;" + NL +
    "        if (label.length > 60) label = label.slice(0, 57) + '...';" + NL +
    "        dnCtxRecord('youtube.com', 'YouTube');" + NL +
    "        return 'Memutar: ' + label;"
  )],
  ['ctx: youtube search success', (
    "      if (!ok) throw new Error('tidak bisa membuka YouTube');" + NL +
    "      return 'Mencari ' + q + ' di YouTube';"
  ), (
    "      if (!ok) throw new Error('tidak bisa membuka YouTube');" + NL +
    "      dnCtxRecord('youtube.com', 'YouTube');" + NL +
    "      return 'Mencari ' + q + ' di YouTube';"
  )],
]);

if (fail) process.exit(1);
console.log('r72t part 1 done');
