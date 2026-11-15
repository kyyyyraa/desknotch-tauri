const fs = require('fs');
const p = 'C:/Users/Asus/.zcode/cli/memories/projects/pet-widget-52821394b91c158d/memory/desknotch-tauri-migration.md';
let md = fs.readFileSync(p, 'utf8');
const note = [
  '',
  '**r72k (2026-11-05): THE "Aksi dibatalkan" ROOT CAUSE.**',
  '   - The planner was never at fault. Harness tools/harness-planner.js proves it: "putar video windah basudara yang lagi hits" -> steps = [{tool:"youtube_play", args:{query:"windah basudara hits", channel:"Windah Basudara"}}].',
  '   - The plan asked for permission over the channel dnai:request-approval, but bridge.rs never implemented that channel -> the Tauri invoke fell through to the JS shim FALLBACKS entry (that channel returns false there) -> the renderer read false as "user rejected" -> "Aksi dibatalkan" on every AI plan.',
  '   - FIX: new Rust module src/approval_gate.rs (ApprovalGate: pending oneshot map + respond()). bridge.rs now registers the request, emits dnai:approval (the card the renderer already renders) and awaits the answer 45 s (deny on timeout). dnai:respond resolves the local gate first, then the pipe.',
  '   - Voice text truncation: the transcript span used vell = whiteSpace:nowrap + textOverflow:ellipsis (one clipped line) -> replaced with whiteSpace:pre-wrap + wordBreak + overflow:visible on the transcript and the step rows; voice card cap 320 -> 480 in the ej size map.',
  '   - PATH TRAP (2026-11-05): the Write/Edit tools take the live tree as D:\project library\...; typing librarian creates a SEPARATE empty tree on D: (two files landed there and had to be moved). bash prints the live tree as "liburan". Always confirm with pwd + ls, and check D:\project librar* for strays.',
  '',
].join('\n');
md = md.replace('**Milestone: DeskNotch Tauri v2 + Rust Port Completed & Refined (2026-11-01)**', '**Milestone: DeskNotch Tauri v2 + Rust Port Completed & Refined (2026-11-01)**' + note);
fs.writeFileSync(p, md, 'utf8');
console.log('memory updated');
