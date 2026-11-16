// r72u: model fallback on gateway 400/404/5xx for ask() and askAction().
const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, '..', 'ui', 'dn-router.js');
let s = fs.readFileSync(p, 'utf8');
const NL = String.fromCharCode(10);
let fail = 0;

function rep(name, from, to) {
  if (!s.includes(from)) { console.error('NOT FOUND [' + name + ']'); fail = 1; return; }
  s = s.split(from).join(to);
  console.log('OK [' + name + ']');
}

// ---- ask(): give the messages array a name, add the fallback branch ----
rep('ask messages var',
  "      messages: [" + NL +
  "        { role: 'system', content: sysPrompt }" + NL +
  "      ].concat(convoHistory(text), [{ role: 'user', content: userContent }])," + NL +
  "      stream: false" + NL +
  "    })).then(function (res) {" + NL +
  "      if (!res.ok) {" + NL +
  "        throw new Error('9router menolak permintaan (kode ' + res.status + ')');" + NL +
  "      }" + NL +
  "      var content = extractContent(res.text);",
  "      messages: chatMessages" + NL +
  "    })).then(function (res) {" + NL +
  "      if (!res.ok && (res.status === 400 || res.status === 404 || res.status >= 500)) {" + NL +
  "        // The gateway sometimes 400s one alias while the rest is fine. One" + NL +
  "        // retry on the conversation model keeps voice alive until it heals." + NL +
  "        var fb = (cfg.convoModel && cfg.convoModel !== model) ? cfg.convoModel : 'kr/claude-haiku-4.5';" + NL +
  "        try { if (window.bridge && window.bridge.send) window.bridge.send('dnptt:log', '9router ' + res.status + ' pada model ' + model + ' -> fallback ' + fb); } catch (_) {}" + NL +
  "        return httpJson('POST', c.baseUrl + '/v1/chat/completions', {" + NL +
  "          'Content-Type': 'application/json'," + NL +
  "          'Authorization': 'Bearer ' + c.apiKey" + NL +
  "        }, JSON.stringify({ model: fb, messages: chatMessages, stream: false })).then(function (res2) {" + NL +
  "          if (!res2.ok) throw new Error('9router menolak permintaan (kode ' + res2.status + ')');" + NL +
  "          var c2 = extractContent(res2.text);" + NL +
  "          var t12 = (typeof performance !== 'undefined' ? performance.now() : Date.now());" + NL +
  "          if (!opts.noRemember) rememberExchange(String(text), c2.trim());" + NL +
  "          return { text: c2.trim(), ms: Math.round(t12 - t0), model: fb };" + NL +
  "        });" + NL +
  "      }" + NL +
  "      if (!res.ok) {" + NL +
  "        var note = String(res.text || '').slice(0, 140);" + NL +
  "        throw new Error('9router menolak permintaan (kode ' + res.status + (note ? ': ' + note : '') + ')');" + NL +
  "      }" + NL +
  "      var content = extractContent(res.text);"
);

rep('ask messages hoist',
  "      'Authorization': 'Bearer ' + c.apiKey" + NL +
  "    }, JSON.stringify({" + NL +
  "      model: model," + NL +
  "      messages: [" + NL +
  "        { role: 'system', content: sysPrompt }" + NL +
  "      ].concat(convoHistory(text), [{ role: 'user', content: userContent }]),",
  "      'Authorization': 'Bearer ' + c.apiKey" + NL +
  "    }, JSON.stringify((function () {" + NL +
  "      var chatMessages = [" + NL +
  "        { role: 'system', content: sysPrompt }" + NL +
  "      ].concat(convoHistory(text), [{ role: 'user', content: userContent }]);" + NL +
  "      return { model: model, messages: chatMessages, stream: false };" + NL +
  "    })()),"
);

// ---- askAction(): same fallback ----
rep('askAction fallback',
  "    }).then(function (res) {" + NL +
  "      if (!res.ok) return empty('9router menolak permintaan (kode ' + res.status + ')');",
  "    }).then(function (res) {" + NL +
  "      if (!res.ok && (res.status === 400 || res.status === 404 || res.status >= 500)) {" + NL +
  "        var fb = (cfg.convoModel && cfg.convoModel !== model) ? cfg.convoModel : 'kr/claude-haiku-4.5';" + NL +
  "        try { if (window.bridge && window.bridge.send) window.bridge.send('dnptt:log', '9router ' + res.status + ' pada model ' + model + ' -> fallback ' + fb); } catch (_) {}" + NL +
  "        return httpJson('POST', c.baseUrl + '/v1/chat/completions', {" + NL +
  "          'Content-Type': 'application/json'," + NL +
  "          'Authorization': 'Bearer ' + c.apiKey" + NL +
  "        }, JSON.stringify({ model: fb, messages: body.messages, stream: false })).then(function (res2) {" + NL +
  "          if (!res2.ok) return empty('9router menolak permintaan (kode ' + res2.status + ')');" + NL +
  "          var content2 = extractContent(res2.text);" + NL +
  "          if (!content2) return empty('jawaban 9router tidak bisa dibaca');" + NL +
  "          return parsePlan(content2);" + NL +
  "        });" + NL +
  "      }" + NL +
  "      if (!res.ok) {" + NL +
  "        var note = String(res.text || '').slice(0, 140);" + NL +
  "        return empty('9router menolak permintaan (kode ' + res.status + (note ? ': ' + note : '') + ')');" + NL +
  "      }"
);

if (fail) process.exit(1);
console.log('r72u fallback patch done');
