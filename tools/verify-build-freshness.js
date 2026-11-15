const fs = require('fs');
const path = require('path');

const exePath = process.argv[2];
const uiDir = process.argv[3];

if (!exePath || !uiDir) {
  console.error('usage: node verify-build-freshness.js <exe> <ui-dir>');
  process.exit(2);
}

const exeStat = fs.statSync(exePath);

let newest = null;
let newestRel = null;

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
      continue;
    }
    const st = fs.statSync(full);
    if (!newest || st.mtimeMs > newest) {
      newest = st.mtimeMs;
      newestRel = path.relative(uiDir, full);
    }
  }
}

walk(uiDir);

const exeTime = exeStat.mtimeMs;
const fresh = exeTime >= newest;

console.log('exe        : ' + exePath);
console.log('exe mtime  : ' + new Date(exeTime).toISOString());
console.log('newest ui  : ' + (newestRel || '(none)') + ' @ ' + (newest ? new Date(newest).toISOString() : '-'));

if (fresh) {
  console.log('RESULT     : FRESH (exe embeds the current frontend)');
  process.exit(0);
} else {
  console.log('RESULT     : STALE (frontend changed after this build) — rebuild and copy again');
  process.exit(1);
}
