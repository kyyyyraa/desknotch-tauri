// dn-conversation.js - DeskNotch: memory behind the Conversation tab.
//
// The tab is a thin view; the memory lives here so both the view and the
// planner read the same list. window.dnConvo.remember(role, text) appends an
// exchange, window.dnConvo.recent(n) hands the last n exchanges back oldest
// first, so the planner can prepend them as context.
//
// Persistence uses the bridge store under the key "dnConvo". The store replaces
// a whole value on store:set, so every write is a read-modify-write like the
// settings flag in dn-whisper.js. localStorage is not used: the app:// origin
// is not a registered standard scheme, so it is not guaranteed to persist.
(function () {
  'use strict';

  // Only bail out when a *complete* dnConvo already exists. A partial object
  // (an older build, or one left behind by a failed load) would leave the
  // Conversation tab calling methods that are not there.
  try {
    var prev = window.dnConvo;
    if (prev && typeof prev.all === 'function' && typeof prev.recent === 'function' &&
        typeof prev.remember === 'function' && typeof prev.onChange === 'function') return;
  } catch (_) {}

  var STORE_KEY = 'dnConvo';
  var MAX_ENTRIES = 30;   // keep the last 30 exchanges
  var MAX_TEXT = 8000;    // chars per entry (ample for long explanations)
  var HISTORY_N = 6;      // exchanges handed to the planner as context
  var DEDUPE_MS = 60000;  // window for collapsing the same line recorded twice

  var entries = [];       // newest last
  var listeners = [];
  var wrapped = null;     // the router object we already patched
  var fetchHooked = false;
  var writeQueue = Promise.resolve();   // serialises the read-modify-write
  var selfWrites = [];                  // JSON of our last writes, to spot echoes

  function getBridge() {
    try { return (window && window.bridge) || null; } catch (_) { return null; }
  }

function dnSupDigits(d) {
  var m = { "0":"⁰","1":"¹","2":"²","3":"³","4":"⁴","5":"⁵","6":"⁶","7":"⁷","8":"⁸","9":"⁹","+":"⁺","-":"⁻","n":"ⁿ","i":"ⁱ" };
  return String(d).split("").map(function (c) { return m[c] || c; }).join("");
}

var dnMathSym = {
  times:"×", cdot:"·", div:"÷", pm:"±", mp:"∓",
  le:"≤", leq:"≤", ge:"≥", geq:"≥", ne:"≠", neq:"≠", approx:"≈", sim:"≃",
  infty:"∞", sum:"Σ", prod:"Π", int:"∫", partial:"∂",
  pi:"π", alpha:"α", beta:"β", gamma:"γ", theta:"θ", lambda:"λ", mu:"µ",
  sigma:"σ", phi:"φ", omega:"ω", Delta:"Δ", delta:"δ",
  to:"→", rightarrow:"→", leftarrow:"←", Rightarrow:"⇒",
  ldots:"…", dots:"…", cdots:"…", prime:"′", circ:"°",
  quad:" ", qquad:" ",
  lceil:"⌈", rceil:"⌉", lfloor:"⌊", rfloor:"⌋"
};

function dnIsLetter(c) {
  var k = c.charCodeAt(0);
  return (k >= 65 && k <= 90) || (k >= 97 && k <= 122);
}
function dnIsDigit(c) {
  var k = c.charCodeAt(0);
  return k >= 48 && k <= 57;
}
function dnIsWord(c) {
  return dnIsLetter(c) || dnIsDigit(c) || c === "_";
}

// Reads a {..} or (..) argument starting at i; returns the text and the index after it.
function dnReadArg(s, i) {
  var open = s.charAt(i);
  var close = open === "{" ? "}" : (open === "(" ? ")" : "");
  if (!close) return null;
  var depth = 0, out = "";
  for (var j = i; j < s.length; j++) {
    var c = s.charAt(j);
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return { text: out, end: j + 1 };
    }
    if (depth >= 1 && j > i) out += c;
  }
  return { text: out, end: s.length };
}

// LaTeX left in an answer reads as raw markup ($$..$$, \frac(..)(..), x^2).
// Rewrite it into plain text a person can read in one glance.
function dnDeMath(input, depth) {
  if (!input) return "";
  var lvl = depth || 0;
  var s = String(input);
  // math delimiters: $$..$$ and $..$ both just carry content
  s = s.split("$$").join("");
  s = s.split("$").join("");
  if (lvl > 3) return String(input);
  var out = "";
  var i = 0;
  while (i < s.length) {
    var ch = s.charAt(i);
    if (ch === String.fromCharCode(92)) {
      var j = i + 1;
      while (j < s.length && dnIsLetter(s.charAt(j))) j++;
      var name = s.slice(i + 1, j);
      if (!name) {
        // A double backslash is a line break in LaTeX.
        if (s.charAt(i + 1) === String.fromCharCode(92)) { out += String.fromCharCode(10); i += 2; }
        else { i++; }
        continue;
      }
      // 
      // A bare n or t after a backslash is whitespace, not a command.
      if (name === "n") { out += String.fromCharCode(10); i = j; continue; }
      if (name === "t") { out += " "; i = j; continue; }
      if (name === "frac" || name === "dfrac" || name === "tfrac") {
        var a = dnReadArg(s, j), b = null;
        if (a) {
          var k = a.end;
          while (k < s.length && s.charAt(k) === " ") k++;
          b = dnReadArg(s, k);
          if (b) { out += "(" + dnDeMath(a.text, lvl + 1) + ") / (" + dnDeMath(b.text, lvl + 1) + ")"; i = b.end; continue; }
          out += "(" + a.text + ")"; i = a.end; continue;
        }
      }
      if (name === "sqrt") {
        var r = dnReadArg(s, j);
        if (r) { out += "√(" + dnDeMath(r.text, lvl + 1) + ")"; i = r.end; continue; }
      }
      if (name === "text" || name === "mathrm" || name === "mathbf" || name === "mathit" ||
          name === "operatorname" || name === "mbox" || name === "textbf" ||
          name === "textit" || name === "mathsf") {
        var q = dnReadArg(s, j);
        if (q) { out += q.text; i = q.end; continue; }
      }
      if (name === "left" || name === "right") { i = j; continue; }
      out += (Object.prototype.hasOwnProperty.call(dnMathSym, name) ? dnMathSym[name] : name);
      i = j;
      continue;
    }
    // superscript
    if (ch === "^") {
      var nxt = s.charAt(i + 1);
      if (nxt === "{" || nxt === "(") {
        var sr = dnReadArg(s, i + 1);
        if (sr) { out += dnSupDigits(sr.text); i = sr.end; continue; }
      }
      if (dnIsDigit(nxt)) { out += dnSupDigits(nxt); i += 2; continue; }
      // A single letter superscript (n, i, ...) as well.
      if (dnIsLetter(nxt)) { out += dnSupDigits(nxt); i += 2; continue; }
    }
    // subscript
    if (ch === "_") {
      var nxt2 = s.charAt(i + 1);
      if (nxt2 === "{" || nxt2 === "(") {
        var br = dnReadArg(s, i + 1);
        if (br) { out += "(" + br.text + ")"; i = br.end; continue; }
      }
      var w = "", p = i + 1;
      while (p < s.length && dnIsWord(s.charAt(p)) && w.length < 4) { w += s.charAt(p); p++; }
      if (w) { out += "(" + w + ")"; i = p; continue; }
    }
    out += ch;
    i++;
  }
  s = out;
  // leftover braces and stray backslashes
  s = s.split("{").join("").split("}").join("");
  s = s.split(String.fromCharCode(92)).join("");
  // tidy the spaces the rewrites left behind
  var NL = String.fromCharCode(10), TB = String.fromCharCode(9);
  s = s.replace(new RegExp("[ " + TB + "]{2,}", "g"), " ");
  s = s.replace(new RegExp(NL + "{3,}", "g"), NL + NL);
  return s.trim();
}

  try { window.dnDeMath = dnDeMath; } catch (_) {}

  function cleanMarkdown(text) {
    if (!text) return '';
    var t = dnDeMath(String(text));
    t = t.replace(/\r\n/g, '\n');
    t = t.replace(/```[a-z]*\n?/gi, '').replace(/```/g, '');
    // Replace markdown divider --- with paragraph break
    t = t.replace(/\s*[-*_]{3,}\s*/g, '\n\n');
    // Replace headings (#, ##, ###) anywhere with paragraph break
    t = t.replace(/[ \t]*#{1,6}[ \t]*/g, '\n\n');
    // Replace blockquote > anywhere with newline
    t = t.replace(/(?:^|\n)[ \t]*>[ \t]*/g, '\n');
    t = t.replace(/[ \t]+>[ \t]*/g, '\n');
    // Tables: remove separator rows like |---|---|
    t = t.replace(/\|[-:\s|]+\|/g, '\n');
    t = t.replace(/\|/g, ' ');
    // Bold **text** -> text
    t = t.replace(/\*\*(.+?)\*\*/g, '$1');
    // Italic *text* -> text
    t = t.replace(/(^|[^\w*])\*([^*\n]+)\*(?![\w*])/g, '$1$2');
    // Code `code` -> code
    t = t.replace(/`([^`\n]+)`/g, '$1');
    // Bullet points
    t = t.replace(/^[ \t]*[-*+][ \t]+/gm, '\u2022 ');
    // Collapse whitespace
    t = t.replace(/[ \t]{2,}/g, ' ');
    t = t.replace(/\n{3,}/g, '\n\n');
    return t.trim();
  }

  function clip(text) {
    try {
      text = text === null || text === undefined ? '' : String(text);
      text = cleanMarkdown(text);
      if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT);
      return text;
    } catch (_) {
      // String() throws on objects with a hostile toString
      return '';
    }
  }

  // The tab sends 'user'/'assistant'. Anything else (including 'User', a
  // number or undefined) is coerced to a role the chat API accepts.
  function normalizeRole(role) {
    return (typeof role === 'string' && role.toLowerCase() === 'user') ? 'user' : 'assistant';
  }

  function normalizeEntry(role, text) {
    return {
      role: normalizeRole(role),
      text: clip(text),
      at: Date.now()
    };
  }

  // Accept anything the store might hand back: an array, a JSON string, or
  // nothing at all. Returns null when the value is not a list at all, so a
  // corrupt entry never wipes the list this tab already holds.
  function coerceList(raw) {
    var list = raw;
    if (typeof list === 'string') {
      try { list = JSON.parse(list); } catch (_) { return null; }
    }
    if (!Array.isArray(list)) return null;
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var row = list[i];
      // arrays and primitives are not entries
      if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
      // the tab renders row.text directly; a non-string would survive React
      // but break JSON round-trips and the planner's message shape
      if (typeof row.text !== 'string') continue;
      var text = clip(row.text);
      if (!text) continue;
      out.push({
        role: normalizeRole(row.role),
        text: text,
        at: typeof row.at === 'number' && isFinite(row.at) ? row.at : 0
      });
    }
    return out.slice(-MAX_ENTRIES);
  }

  function notify() {
    // snapshot: a listener may unsubscribe (or subscribe) from inside the call
    var current = listeners.slice();
    for (var i = 0; i < current.length; i++) {
      try { current[i](entries); } catch (_) {}
    }
  }

  function storeGet() {
    var bridge = getBridge();
    if (!bridge || !bridge.invoke) return Promise.resolve(null);
    var res;
    try { res = bridge.invoke('store:get', STORE_KEY); } catch (_) { return Promise.resolve(null); }
    return Promise.resolve(res).then(function (raw) {
      // null/undefined means "never written", which is not the same as "[]":
      // a failed read must not wipe the list this tab already has.
      if (raw === null || raw === undefined) return null;
      return coerceList(raw);
    }).catch(function () { return null; });
  }

  function storeSet(list) {
    var bridge = getBridge();
    if (!bridge || !bridge.invoke) return Promise.resolve(false);
    var res;
    try {
      var json = JSON.stringify(list);
      selfWrites.push(json);
      if (selfWrites.length > 4) selfWrites.shift();
      res = bridge.invoke('store:set', STORE_KEY, list);
    } catch (_) { return Promise.resolve(false); }
    return Promise.resolve(res).then(function () { return true; }).catch(function () { return false; });
  }

  // store:set is a whole-value replace, so two remember() calls in flight
  // would each read the same snapshot and the second write would drop the
  // first entry. Every read-modify-write goes through one chain instead.
  function queueWrite(task) {
    var run = writeQueue.then(task, task);
    writeQueue = run.then(function () {}, function () {});
    return run;
  }

  // The chunk remembers the exchange, the router remembers the exchange and
  // the wrapper below remembers it too. Those calls all happen close together
  // and land on the tail of the list, so only the tail is compared: a genuine
  // repeat of an older line is preceded by its answer and still gets stored.
  function isDuplicate(entry) {
    var last = entries[entries.length - 1];
    if (!last) return false;
    if (last.role !== entry.role || last.text !== entry.text) return false;
    return (entry.at - (last.at || 0)) < DEDUPE_MS;
  }

  // ---- public API ---------------------------------------------------------

  // Append one exchange. Resolves to true when it reached the store.
  //
  // The local list is updated first so a second remember() of the same line
  // (the tab and the router wrapper both record it) collapses into one entry.
  function remember(role, text) {
    var entry = normalizeEntry(role, text);
    if (!entry.text) return Promise.resolve(false);

    // Same role+text already at the tail: the tab and the router both record
    // the same exchange, so the second call is a no-op.
    if (isDuplicate(entry)) return Promise.resolve(true);

    entries = entries.concat([entry]).slice(-MAX_ENTRIES);
    notify();

    return queueWrite(function () {
      return storeGet().then(function (stored) {
        // The store is the source of truth, but a missing store must not lose
        // the line: fall back to what this tab already knows (which already
        // includes this entry).
        var list;
        if (stored) {
          list = stored.slice();
          // A concurrent echo may already carry this line; only the tail
          // counts, so a genuinely repeated older question is still appended.
          var last = list[list.length - 1];
          if (!(last && last.role === entry.role && last.text === entry.text)) {
            list = list.concat([entry]);
          }
        } else {
          list = entries.slice();
        }
        list = list.slice(-MAX_ENTRIES);
        return storeSet(list).then(function (ok) {
          entries = list;
          notify();
          return ok;
        });
      });
    }).catch(function () {
      return false;
    });
  }

  // The last n exchanges, oldest first. Synchronous on purpose: the planner
  // reads it while building a request. recent(0) is empty, not "everything":
  // a caller that computes n=0 must not get the whole history back.
  function recent(n) {
    var count = typeof n === 'number' ? Math.max(0, Math.floor(n)) : entries.length;
    if (!count) return [];
    return entries.slice(Math.max(0, entries.length - count));
  }

  // The same history shaped for a chat API: [{role, content}].
  function context(n) {
    var list = recent(typeof n === 'number' && n > 0 ? n : HISTORY_N);
    var out = [];
    for (var i = 0; i < list.length; i++) {
      out.push({
        role: list[i].role === 'user' ? 'user' : 'assistant',
        content: list[i].text
      });
    }
    return out;
  }

  function all() {
    return entries.slice();
  }

  function clear() {
    entries = [];
    notify();
    return queueWrite(function () { return storeSet([]); }).catch(function () { return false; });
  }

  // Always returns a function: the tab does `cvOff && cvOff()` on unmount.
  function onChange(cb) {
    if (typeof cb !== 'function') return function () {};
    listeners.push(cb);
    var off = false;
    return function () {
      if (off) return;
      off = true;
      var i = listeners.indexOf(cb);
      if (i >= 0) listeners.splice(i, 1);
    };
  }

  // Re-read the store. Used on boot and whenever another window writes.
  function load() {
    return storeGet().then(function (list) {
      if (list) entries = list;
      notify();
      return entries;
    }).catch(function () { return entries; });
  }

  // ---- planner wiring -----------------------------------------------------

  // The planner is a separate script that may load before or after this one.
  // Instead of editing it, wrap ask/askAction once it shows up: the wrapper
  // prepends the recent exchanges when the planner takes a message list, and
  // always records what came back.
  function wrapRouter() {
    var router = null;
    try { router = (window && window.dnRouter) || null; } catch (_) { router = null; }
    if (!router || wrapped === router) return !!router;

    var originalAsk = router.ask;
    var originalAskAction = router.askAction;

    function withHistory(args) {
      var list = args.slice();
      var first = list[0];
      // A message array is the only shape we can prepend to safely. A plain
      // string is passed through untouched.
      if (Array.isArray(first)) {
        var hist = context(HISTORY_N);
        if (hist.length) list[0] = hist.concat(first);
      }
      return list;
    }

    if (typeof originalAsk === 'function') {
      router.ask = function () {
        var args = withHistory(Array.prototype.slice.call(arguments));
        // The conversation tab records the exchange itself (already formatted),
        // so a noRemember ask must not be recorded here either.
        var o0 = args[1];
        if (o0 && o0.noRemember) return originalAsk.apply(this, args);
        var result = originalAsk.apply(this, args);
        var askText = typeof args[0] === 'string' ? args[0] : '';
        return record(result, askText, false);
      };
    }

    if (typeof originalAskAction === 'function') {
      router.askAction = function () {
        var args = withHistory(Array.prototype.slice.call(arguments));
        var o1 = args[2];
        if (o1 && o1.noRemember) return originalAskAction.apply(this, args);
        var result = originalAskAction.apply(this, args);
        var askText = typeof args[0] === 'string' ? args[0] : '';
        return record(result, askText, true);
      };
    }

    wrapped = router;
    return true;
  }

  // Resolve whatever the planner returned, remember the exchange, and hand
  // the original value back to the caller.
  function answerText(answer, isAction) {
    if (typeof answer === 'string') return answer;
    if (answer && typeof answer === 'object') {
      var say = isAction
        ? (answer.say || answer.text || answer.answer || '')
        : (answer.text || answer.say || answer.answer || answer.reply || '');
      return say ? String(say) : '';
    }
    return '';
  }

  // Remembering is a side effect: a failure in the memory must never turn a
  // good answer into a rejected ask() for the caller.
  function safeRemember(role, text) {
    try { remember(role, text); } catch (_) {}
  }

  function record(result, askText, isAction) {
    if (askText) safeRemember('user', askText);
    if (!result || typeof result.then !== 'function') {
      if (typeof result === 'string') safeRemember('assistant', result);
      return result;
    }
    return result.then(function (answer) {
      var say = answerText(answer, isAction);
      if (say) safeRemember('assistant', say);
      return answer;
    });
  }

  // The planner may appear after this file ran, so keep a light watch for it.
  function watchRouter() {
    var tries = 0;
    var timer = setInterval(function () {
      tries++;
      if (wrapRouter() || tries > 60) clearInterval(timer);
    }, 500);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  // ---- transport fallback -------------------------------------------------

  // The planner talks to the model over some transport this file knows
  // nothing about: a message array, a string over IPC, a fetch body. The
  // message array is the one shape where the history can be inserted without
  // guessing, so the fetch body is patched as a fallback. A request that does
  // not carry a message array is passed through untouched.
  function installFetchHook() {
    if (fetchHooked) return false;
    var origFetch = null;
    try { origFetch = window.fetch; } catch (_) { return false; }
    if (typeof origFetch !== 'function') return false;
    fetchHooked = true;
    window.fetch = function (input, init) {
      try {
        var body = init && init.body;
        if (typeof body === 'string' && body.indexOf('"messages"') >= 0) {
          var parsed = JSON.parse(body);
          if (parsed && Array.isArray(parsed.messages) && parsed.messages.length) {
            var last = parsed.messages[parsed.messages.length - 1];
            var hist = context(HISTORY_N).filter(function (h) {
              // The question being asked is already the last message.
              return !(last && h.role === 'user' && h.content === last.content);
            });
            var first = parsed.messages[0];
            var already = hist.length && first && first.content === hist[0].content;
            if (hist.length && !already) {
              parsed.messages = hist.concat(parsed.messages);
              init = Object.assign({}, init, { body: JSON.stringify(parsed) });
            }
          }
        }
      } catch (_) {}
      return origFetch.call(window, input, init);
    };
    return true;
  }

  // ---- boot ---------------------------------------------------------------

  // The export must land even if the bridge is missing or a boot step throws:
  // the tab checks window.dnConvo before rendering, so a missing export is a
  // dead panel, but a throw here would take the whole renderer down.
  window.dnConvo = {
    remember: remember,
    recent: recent,
    clear: clear,
    all: all,
    context: context,
    onChange: onChange,
    load: load,
    wrapRouter: wrapRouter,
    STORE_KEY: STORE_KEY,
    MAX_ENTRIES: MAX_ENTRIES,
    MAX_TEXT: MAX_TEXT
  };

  try {
    var bridge = getBridge();
    if (bridge && typeof bridge.on === 'function') {
      bridge.on('store:changed', function (key, value) {
        try {
          if (key !== STORE_KEY) return;
          // main broadcasts store:changed back to the sender too, and that
          // echo can arrive after a newer write. It never reaches store:set,
          // so it cannot loop; the only risk is an old echo reverting the
          // list, which is why our own recent writes are recognised and
          // ignored (the write already applied that exact list).
          var list = coerceList(value);
          if (!list) return;   // null/garbage: keep what we have
          var json = JSON.stringify(list);
          if (selfWrites.indexOf(json) >= 0) return;
          if (json === JSON.stringify(entries)) return;
          entries = list;
          notify();
        } catch (_) {}
      });
    }
  } catch (_) {}

  try { load(); } catch (_) {}
  try { watchRouter(); } catch (_) {}
  try { installFetchHook(); } catch (_) {}
})();
