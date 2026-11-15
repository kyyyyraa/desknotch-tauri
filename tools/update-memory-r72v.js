const fs = require('fs');
const p = 'C:/Users/Asus/.zcode/cli/memories/projects/pet-widget-52821394b91c158d/memory/desknotch-tauri-migration.md';
let md = fs.readFileSync(p, 'utf8');
const NL = String.fromCharCode(10);
const note = [
  '',
  '**r72v (2026-11-06): workspace consolidated, notif click reverted, 9router 400 fallback.**',
  '   - WORKSPACE: all stray D:' + B2() + 'project* folders deleted (project, project liberate, project libiran, project library, projectドルの). Only D:' + B2() + 'project liburan' + B2() + 'pet widget' + B2() + 'desknotch-tauri remains. CAUTION: the shell cwd silently resets to D:' + B2() + 'project liburan' + B2() + 'pet widget between commands - a relative heredoc/tool path can land one level too high and silently create a stray folder again. After every write, confirm with pwd + ls.',
  '   - NOTIFICATION CLICK REMOVED at the user request (r72t added it, user: "hapus aja") - dnV body back to plain stopPropagation.',
  '   - VOICE 400 FROM 9ROUTER: the gateway intermittently 400s a model alias. ask() and askAction() now retry once on status 400/404/5xx with the conversation model (cfg.convoModel, else kr/claude-haiku-4.5) and surface the gateway note in the error. ask() hoists the messages array into chatMessages so both sends share it.',
  '',
].join(NL);
function B2() { return String.fromCharCode(92); }
md = md.replace('**Milestone: DeskNotch Tauri v2 + Rust Port Completed & Refined (2026-11-01)**', '**Milestone: DeskNotch Tauri v2 + Rust Port Completed & Refined (2026-11-01)**' + note);
fs.writeFileSync(p, md, 'utf8');
console.log('memory updated');
