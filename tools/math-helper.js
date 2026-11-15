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
