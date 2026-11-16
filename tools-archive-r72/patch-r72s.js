// r72s part 1: silence every console-spawning process in system.rs.
const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, '..', 'src-tauri', 'src', 'system.rs');
let s = fs.readFileSync(p, 'utf8');
let fail = 0;

// 1. imports + helper
const fromImp = 'use serde_json::Value;\nuse std::process::Command;\nuse std::time::Duration;';
const toImp = [
  'use serde_json::Value;',
  'use std::process::Command;',
  'use std::time::Duration;',
  '',
  '#[cfg(windows)]',
  'use std::os::windows::process::CommandExt;',
  '',
  '/// Windows shows a console window for every cmd/powershell spawn unless',
  '/// CREATE_NO_WINDOW is set. Wrap every headless spawn with this.',
  'pub fn silent(mut cmd: Command) -> Command {',
  '    #[cfg(windows)]',
  '    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW',
  '    cmd',
  '}',
].join('\n');
if (!s.includes(fromImp)) { console.error('NOT FOUND [imports]'); fail = 1; }
else { s = s.replace(fromImp, toImp); console.log('OK [imports]'); }

// 2. wrap all Command::new("...") that are NOT already `silent(`
const lines = s.split('\n');
let hits = 0;
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(/(\s*)(?:let _ = |let mut child = |let output = |)(Command::new\("(?:cmd|powershell\.exe|rundll32\.exe|explorer)"\))/);
  if (m && lines[i].indexOf('silent(') === -1) {
    lines[i] = lines[i].replace('Command::new(', 'silent(Command::new(');
    // find the matching end: the statement ends with `.spawn();` or `.output();` or `.await` chain.
    // Simplest robust approach: append a closing paren at the end of the statement.
    for (let j = i; j < Math.min(i + 30, lines.length); j++) {
      if (/\.spawn\(\);/.test(lines[j])) { lines[j] = lines[j].replace(/\.spawn\(\);/, '.spawn());'); hits++; break; }
      if (/\.output\(\)/.test(lines[j]) && !/output\(\)\s*\.\s*map/.test(lines[j]) && !lines[j].includes('.output());') === false) {
        // .output() may be followed by other chained calls on later lines; only close if this line ends the call
        if (/\)\s*;?\s*$/.test(lines[j]) || /output\(\)\s*$/.test(lines[j])) { lines[j] = lines[j].replace(/\.output\(\)/, '.output())'); hits++; break; }
      }
    }
  }
}
s = lines.join('\n');
console.log('wrapped spawns:', hits);
fs.writeFileSync(p, s, 'utf8');
if (fail) process.exit(1);
