// r72m: privacy sensor (native ConsentStore reader) + PTT log file + Esc hotkey hygiene
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const TAURI = path.join(ROOT, 'src-tauri');
let fail = 0;

function patch(file, edits) {
  const p = path.join(TAURI, file);
  let src = fs.readFileSync(p, 'utf8');
  for (const [name, from, to] of edits) {
    if (!src.includes(from)) { console.error('NOT FOUND [' + file + '/' + name + ']'); fail = 1; continue; }
    src = src.split(from).join(to);
    console.log('OK [' + file + '/' + name + ']');
  }
  fs.writeFileSync(p, src, 'utf8');
}

// ---- Cargo.toml: registry feature ------------------------------------
patch('Cargo.toml', [
  ['windows-sys registry',
    '    "Win32_UI_WindowsAndMessaging",\n    "Win32_Foundation"\n] }',
    '    "Win32_UI_WindowsAndMessaging",\n    "Win32_Foundation",\n    "Win32_System_Registry"\n] }'],
]);

// ---- lib.rs: module + poller ----------------------------------------
patch('src/lib.rs', [
  ['module',
    'pub mod pipe_server;',
    'pub mod pipe_server;\npub mod privacy;'],
]);

// ---- bridge.rs: privacy:get + dnptt:log ------------------------------
patch('src/bridge.rs', [
  ['privacy:get',
    '        "ocr:recognize" => {',
    `        "privacy:get" => {
            Ok(crate::privacy::read_state(300).to_json())
        }
        "ocr:recognize" => {`],
  ['dnptt:log',
    '        "dnvoice:speaking-state" => {\n            // Speech active indicator\n        }',
    `        "dnvoice:speaking-state" => {
            // Speech active indicator
        }
        "dnptt:log" => {
            // Renderer-side PTT trace: without this the log file only shows
            // the Rust side and the session chain is invisible.
            if let Some(line) = data.as_ref().and_then(|v| v.as_str()) {
                crate::logfile::append("[render] " + line);
            }
        }`],
]);

if (fail) process.exit(1);
console.log('r72m patch done');
