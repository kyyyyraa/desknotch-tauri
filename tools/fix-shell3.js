const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, '..', 'src-tauri', 'src', 'system.rs');
let s = fs.readFileSync(p, 'utf8');
const NL = String.fromCharCode(10);
const from = '        let output = silent(&mut Command::new("powershell.exe")' + NL +
             '            .args(&["-NoProfile", "-NonInteractive", "-Command", &cmd_str])' + NL +
             '            .output();';
const to = '        let output = silent(&mut Command::new("powershell.exe")' + NL +
           '            .args(&["-NoProfile", "-NonInteractive", "-Command", &cmd_str]))' + NL +
           '            .output();';
if (!s.includes(from)) { console.error('pattern not found'); process.exit(1); }
s = s.replace(from, to);
fs.writeFileSync(p, s, 'utf8');
console.log('shell site fixed');
