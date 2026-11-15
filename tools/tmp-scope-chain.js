'use strict';
const fs = require('fs');
const src = fs.readFileSync(process.argv[2], 'utf8');
const BS = String.fromCharCode(92);
const DQ = String.fromCharCode(34);
const SQ = String.fromCharCode(39);
const BQ = String.fromCharCode(96);
function scan(limit) {
  const st = []; let i = 0, inStr = null, inC = null;
  while (i < limit) {
    const c = src[i], n = src[i + 1];
    if (inC) { if (inC === '//' && c === '\n') inC = null; else if (inC === '/*' && c === '*' && n === '/') { inC = null; i += 2; continue; } i++; continue; }
    if (inStr) { if (c === BS) { i += 2; continue; } if (c === inStr) inStr = null; i++; continue; }
    if (c === '/' && n === '/') { inC = '//'; i += 2; continue; }
    if (c === '/' && n === '*') { inC = '/*'; i += 2; continue; }
    if (c === DQ || c === SQ || c === BQ) { inStr = c; i++; continue; }
    if (c === '{') st.push(i);
    else if (c === '}') st.pop();
    i++;
  }
  return st;
}
const ident = process.argv[3];
const re = new RegExp('(?:^|[^A-Za-z0-9_$])' + ident.replace(/\$/g, '\$') + '(?=[=;,.)\s])');
const m = re.exec(src);
if (!m) { console.log(ident, 'NOT FOUND'); process.exit(0); }
const pos = m.index + m[0].length;
const st = scan(pos);
console.log('ident', ident, 'offset', pos, 'braceDepth', st.length);
for (const s of st) console.log('  brace', s, '<<', src.slice(Math.max(0, s - 60), s + 1).replace(/\s+/g, ' '));
