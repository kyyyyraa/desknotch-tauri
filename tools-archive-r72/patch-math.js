// r72q: raw LaTeX in model answers -> readable plain text.
// Hand-written tokenizer (no regex) so the source needs no backslashes at all.
const fs = require('fs');
const path = require('path');
const UI = path.join(__dirname, '..', 'ui');
let fail = 0;

const HELPER = [
'function dnSupDigits(d) {',
'  var m = { "0":"\u2070","1":"\u00b9","2":"\u00b2","3":"\u00b3","4":"\u2074","5":"\u2075","6":"\u2076","7":"\u2077","8":"\u2078","9":"\u2079","+":"\u207a","-":"\u207b","n":"\u207f","i":"\u2071" };',
'  return String(d).split("").map(function (c) { return m[c] || c; }).join("");',
'}',
'',
'var dnMathSym = { times:"\u00d7", cdot:"\u00b7", div:"\u00f7", pm:"\u00b1", mp:"\u2213", le:"\u2264", leq:"\u2264", ge:"\u2265", geq:"\u2265", ne:"\u2260", neq:"\u2260", approx:"\u2248", sim:"\u223c", infty:"\u221e", sum:"\u03a3", prod:"\u03a0", int:"\u222b", partial:"\u2202", pi:"\u03c0", alpha:"\u03b1", beta:"\u03b2", gamma:"\u03b3", theta:"\u03b8", lambda:"\u03bb", mu:"\u00b5", sigma:"\u03c3", phi:"\u03c6", omega:"\u03c9", Delta:"\u0394", delta:"\u03b4", to:"\u2192", rightarrow:"\u2192", leftarrow:"\u2190", Rightarrow:"\u21d2", ldots:"\u2026", dots:"\u2026", cdots:"\u2026", prime:"\u2032", circ:"\u00b0", quad:" ", qquad:" ", lceil:"\u2308", rceil:"\u2309", lfloor:"\u230a", rfloor:"\u230b" };',
'',
'function dnIsLetter(c) { var k = c.charCodeAt(0); return (k >= 65 && k <= 90) || (k >= 97 && k <= 122); }',
'function dnIsDigit(c) { var k = c.charCodeAt(0); return k >= 48 && k <= 57; }',
'function dnIsWord(c) { return dnIsLetter(c) || dnIsDigit(c) || c === "_"; }',
'',
'// Reads a {..} or (..) argument starting at i; returns the text and the index after it.',
'function dnReadArg(s, i) {',
'  var open = s.charAt(i), close = open === "{" ? "}" : (open === "(" ? ")" : "");',
'  if (!close) return null;',
'  var depth = 0, out = "";',
'  for (var j = i; j < s.length; j++) {',
'    var c = s.charAt(j);',
'    if (c === open) depth++;',
'    else if (c === close) { depth--; if (depth === 0) return { text: out, end: j + 1 }; }',
'    if (depth >= 1 && j > i) out += c;',
'  }',
'  return { text: out, end: s.length };',
'}',
'',
'// LaTeX left in an answer reads as raw markup. Rewrite it into plain text.',
'function dnDeMath(input) {',
'  if (!input) return "";',
'  var s = String(input);',
'  // math delimiters: $$..$$ and $..$ both just carry content',
'  s = s.split("$$").join("");',
'  s = s.split("$").join("");',
'  var out = "";',
'  var i = 0;',
'  while (i < s.length) {',
'    var ch = s.charAt(i);',
'    if (ch === String.fromCharCode(92)) {',
'      var j = i + 1;',
'      while (j < s.length && dnIsLetter(s.charAt(j))) j++;',
'      var name = s.slice(i + 1, j);',
'      if (!name) { i++; continue; }',
'      if (name === "frac" || name === "dfrac" || name === "tfrac") {',
'        var a = dnReadArg(s, j), b = null;',
'        if (a) {',
'          var k = a.end;',
'          while (k < s.length && s.charAt(k) === " ") k++;',
'          b = dnReadArg(s, k);',
'          if (b) { out += "(" + a.text + ") / (" + b.text + ")"; i = b.end; continue; }',
'          out += "(" + a.text + ")"; i = a.end; continue;',
'        }',
'      }',
'      if (name === "sqrt") {',
'        var r = dnReadArg(s, j);',
'        if (r) { out += "\u221a(" + r.text + ")"; i = r.end; continue; }',
'      }',
'      if (name === "text" || name === "mathrm" || name === "mathbf" || name === "mathit" || name === "operatorname" || name === "mbox" || name === "textbf" || name === "textit" || name === "mathsf") {',
'        var q = dnReadArg(s, j);',
'        if (q) { out += q.text; i = q.end; continue; }',
'      }',
'      if (name === "left" || name === "right") { i = j; continue; }',
'      out += (Object.prototype.hasOwnProperty.call(dnMathSym, name) ? dnMathSym[name] : name);',
'      i = j;',
'      continue;',
'    }',
'    // superscript',
'    if (ch === "^") {',
'      var nxt = s.charAt(i + 1);',
'      if (nxt === "{" || nxt === "(") {',
'        var sr = dnReadArg(s, i + 1);',
'        if (sr) { out += dnSupDigits(sr.text); i = sr.end; continue; }',
'      }',
'      if (dnIsDigit(nxt)) { out += dnSupDigits(nxt); i += 2; continue; }',
'    }',
'    // subscript',
'    if (ch === "_") {',
'      var nxt2 = s.charAt(i + 1);',
'      if (nxt2 === "{" || nxt2 === "(") {',
'        var br = dnReadArg(s, i + 1);',
'        if (br) { out += "(" + br.text + ")"; i = br.end; continue; }',
'      }',
'      var w = "", p = i + 1;',
'      while (p < s.length && dnIsWord(s.charAt(p)) && w.length < 4) { w += s.charAt(p); p++; }',
'      if (w) { out += "(" + w + ")"; i = p; continue; }',
'    }',
'    out += ch;',
'    i++;',
'  }',
'  s = out;',
'  // leftover braces and stray backslashes',
'  s = s.split("{").join("").split("}").join("");',
'  s = s.split(String.fromCharCode(92)).join("");',
'  // tidy the spaces the rewrites left behind',
'  s = s.replace(new RegExp("[ " + String.fromCharCode(9) + "]{2,}", "g"), " ");',
'  s = s.replace(new RegExp(String.fromCharCode(10) + "{3,}", "g"), String.fromCharCode(10) + String.fromCharCode(10));',
'  return s.trim();',
'}',
'',
].join('\n');

function inject(file, marker, callFrom, callTo, label) {
  const p = path.join(UI, file);
  let src = fs.readFileSync(p, 'utf8');
  // remove a previously injected (possibly mangled) helper
  const hs = src.indexOf('function dnSupDigits(d) {');
  if (hs >= 0) {
    const he = src.indexOf(marker);
    if (he > hs) { src = src.slice(0, hs) + src.slice(he); console.log('cleaned old helper in ' + file); }
  }
  if (!src.includes(callFrom)) { console.error('NOT FOUND [' + label + ']'); fail = 1; return; }
  if (src.indexOf(callTo) !== -1) src = src.replace(callTo, callFrom);
  const mi = src.indexOf(marker);
  if (mi < 0) { console.error('MARKER NOT FOUND [' + label + ']'); fail = 1; return; }
  src = src.slice(0, mi) + HELPER + src.slice(mi);
  fs.writeFileSync(p, src, 'utf8');
  console.log('OK [' + label + ']');
}

inject('dn-conversation.js',
  '  function cleanMarkdown(text) {',
  "    var t = dnDeMath(String(text));",
  "    var t = String(text);",
  'dn-conversation');

inject('_next/static/chunks/02jdcovrpfbyy.js',
  'let dnCleanText=',
  'let s=dnDeMath(String(t)).replace(/',
  'let s=String(t).replace(/',
  'chunk');

if (fail) process.exit(1);
console.log('r72q math-cleaner patch done');
