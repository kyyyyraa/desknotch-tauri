// r72n: wire logfile module, privacy poller, hotkey logging + conditional Esc
const fs = require('fs');
const path = require('path');
const TAURI = path.join(__dirname, '..', 'src-tauri');
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

patch('src/lib.rs', [
  ['module logfile',
    'pub mod notif;',
    'pub mod logfile;\npub mod notif;'],
  ['start privacy poller',
    '    // Start global hotkeys (Ctrl+Alt+V, Ctrl+Alt+D, Escape)',
    `    // Privacy sensor: watch the ConsentStore so the notch can show the
    // mic/camera dots. It only pushes an event when something changed.
    {
        let app_h = app.handle().clone();
        std::thread::spawn(move || {
            let mut last = crate::privacy::read_state(300);
            loop {
                std::thread::sleep(std::time::Duration::from_secs(4));
                if let Some(state) = crate::privacy::poll_changed(&mut last) {
                    use tauri::Emitter;
                    let _ = app_h.emit("privacy:state", state.to_json());
                }
            }
        });
    }

    // Start global hotkeys (Ctrl+Alt+V, Ctrl+Alt+D, Escape)`],
]);

patch('src/voice/hotkey.rs', [
  ['log fires',
    `                            HOTKEY_COMMAND => {
                                let busy = is_busy.load(Ordering::Relaxed);`,
    `                            HOTKEY_COMMAND => {
                                let busy = is_busy.load(Ordering::Relaxed);
                                crate::logfile::append(&format!(
                                    "[hotkey] cmd busy={} -> {}",
                                    busy,
                                    if busy { "abort" } else { "start" }
                                ));`],
  ['log dictate',
    `                            HOTKEY_DICTATE => {
                                let busy = is_busy.load(Ordering::Relaxed);`,
    `                            HOTKEY_DICTATE => {
                                let busy = is_busy.load(Ordering::Relaxed);
                                crate::logfile::append(&format!(
                                    "[hotkey] dictate busy={} -> {}",
                                    busy,
                                    if busy { "abort" } else { "start" }
                                ));`],
  ['log escape',
    `                            HOTKEY_ESCAPE => {
                                is_busy.store(false, Ordering::Relaxed);`,
    `                            HOTKEY_ESCAPE => {
                                is_busy.store(false, Ordering::Relaxed);
                                crate::logfile::append("[hotkey] escape -> abort");`],
  ['log chat',
    `                            HOTKEY_CHAT => {
                                let _ = app.emit("hotkey:chat", serde_json::json!({}));`,
    `                            HOTKEY_CHAT => {
                                crate::logfile::append("[hotkey] alt+c -> open chat");
                                let _ = app.emit("hotkey:chat", serde_json::json!({}));`],
]);

if (fail) process.exit(1);
console.log('r72n patch done');
