const fs = require('fs');
const p = 'C:/Users/Asus/.zcode/cli/memories/projects/pet-widget-52821394b91c158d/memory/desknotch-tauri-migration.md';
let md = fs.readFileSync(p, 'utf8');
const NL = String.fromCharCode(10);
const note = [
  '',
  '**r72s/r72t (2026-11-06): PowerShell popup, 9router retry, session context, clickable notifications, stale-notification round two.**',
  '   - POWERSHELL POPUP ROOT CAUSE: system.rs spawned cmd/powershell/rundll32 without CREATE_NO_WINDOW (only whisper-cli had it). Fix: `silent(&mut Command) -> &mut Command` helper; signature must be &mut because chained .args() returns &mut Command (by-value silent(Command) broke E0308). Closing-paren rule for multi-line chains: silent(&mut Command::new(..).args(..))  then .output()/.spawn() OUTSIDE the silent parens - closing inside made the chain pass a Result/&mut into silent.',
  '   - STALE NOTIFICATIONS round two (Claude appearing late): the r72 seed-all missed toasts whose DB write lands AFTER the first poll (Windows writes late). Unit-agnostic fix: remember max raw ArrivalTime (seed_max_at) at seed; in the diff loop a never-seen key is emitted only if stamped > seed_max_at (stamped==0 falls back to emit). Poll 3s -> 2s. parse_toast_xml now emits the raw launch string as "launch" for click handling.',
  '   - 9ROUTER "kadang konek": the gateway is an SSH tunnel that hiccups. httpJson now retries once after 1.2 s and logs the failure to dnptt.log ("9router retry: ...").',
  '   - SESSION CONTEXT ("buka youtube" lalu "cari windah" harus ke search bar): window.dnCtx {lastSite,lastLabel} recorded on every successful open_tab/youtube/youtube_play (dnCtxRecord in dn-voice-exec); dn-intent tryYoutube got a bare-search fallback - "cari X" with no site marker becomes a YouTube search when dnCtx.lastSite === youtube.com (score 0.8). Voice utterances + AI answers are now remembered into the shared dnConvo thread from the voice loop too (planner convoHistory sees them).',
  '   - CLICKABLE NOTIFICATIONS: the dnV card body click (the old handler only stopPropagation) now opens the related target: notif.site -> dnOpenUrlSmart(https://site), else app:focus-window with the first token of notif.app; cursor:pointer. The X button still dismisses. parse payload gained "launch" for future use.',
  '',
].join(NL);
md = md.replace('**Milestone: DeskNotch Tauri v2 + Rust Port Completed & Refined (2026-11-01)**', '**Milestone: DeskNotch Tauri v2 + Rust Port Completed & Refined (2026-11-01)**' + note);
fs.writeFileSync(p, md, 'utf8');
console.log('memory updated');
