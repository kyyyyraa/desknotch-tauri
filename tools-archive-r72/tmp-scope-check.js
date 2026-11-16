'use strict';
// Temporary helper: reports the brace depth of identifiers inside the bundle
// so we can tell module-scope bindings from nested ones.
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'ui', '_next', 'static', 'chunks', '02jdcovrpfbyy.js');
const src = fs.readFileSync(FILE, 'utf8');

function depthAt(pos) {
  let depth = 0;
  let i = 0;
  let inStr = null;
  let inComment = false;
  while (i < pos) {
    const c = src[i];
    const n = src[i + 1];
    if (inComment) {
      if (c === '\n') inComment = false;
      i++;
      continue;
    }
    if (inStr) {
      if (c === '\\') { i += 2; continue; }
      if (c === inStr) inStr = null;
      i++;
      continue;
    }
    if (c === '/' && n === '/') { inComment = true; i += 2; continue; }
    if (c === '/' && n === '*') { inComment = true; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; i++; continue; }
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') depth--;
    i++;
  }
  return depth;
}

const targets = process.argv.slice(2);
for (const t of targets) {
  const m = new RegExp('(?:^|[^A-Za-z0-9_$])' + t.replace(/\$/g, '\\$') + '(?=[=;,.)\\s])').exec(src);
  if (!m) { console.log(t, 'NOT FOUND'); continue; }
  const pos = m.index + m[0].length;
  console.log(t.padEnd(8), 'pos', pos, 'depth', depthAt(pos), '|', src.slice(pos, pos + 40).replace(/\n/g, ' '));
}
