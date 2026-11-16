// r72e: single toggle pill — click FOCUS pill -> becomes REMINDER, click again -> back
const fs = require('fs');
const p = 'ui/_next/static/chunks/02jdcovrpfbyy.js';
let js = fs.readFileSync(p, 'utf8');
let fail = 0;

function rep(name, from, to) {
  if (!js.includes(from)) { console.error('NOT FOUND [' + name + ']'); fail = 1; return; }
  js = js.split(from).join(to);
  console.log('OK [' + name + ']');
}

// 1. Two chips -> ONE toggle pill (shows current mode, click swaps; no-op when no reminders store)
rep('single-pill',
  '(0,a.jsxs)("div",{className:"flex items-center gap-1.5",children:[(0,a.jsx)("button",{type:"button",onClick:e=>{e.stopPropagation(),dnSs("timer")},className:"h-[16px] rounded-full px-2 text-[8.5px] font-bold uppercase tracking-[0.12em] leading-none transition-colors",style:"timer"===dnS?{background:X,color:"black"}:{background:"rgba(255,255,255,0.07)",color:"rgba(255,255,255,0.45)"},children:"Focus"}),n&&(0,a.jsx)("button",{type:"button",onClick:e=>{e.stopPropagation(),dnSs("reminder")},className:"h-[16px] rounded-full px-2 text-[8.5px] font-bold uppercase tracking-[0.12em] leading-none transition-colors",style:"reminder"===dnS?{background:X,color:"black"}:{background:"rgba(255,255,255,0.07)",color:"rgba(255,255,255,0.45)"},children:"Reminder"})]})',
  '(0,a.jsx)("button",{type:"button",onClick:e=>{e.stopPropagation(),n&&dnSs("timer"===dnS?"reminder":"timer")},className:"h-[16px] rounded-full px-2 text-[8.5px] font-bold uppercase tracking-[0.12em] leading-none transition-colors",style:{background:X,color:"black"},children:"timer"===dnS?"Focus":"Reminder"})'
);

// 2. Kill the duplicate FOCUS label inside the timer tile
rep('drop-dup-label',
  '(0,a.jsx)(hD,{children:h?"Done":p?"Paused":l?"Focusing":"Focus"}),',
  ''
);

if (fail) process.exit(1);
fs.writeFileSync(p, js, 'utf8');
console.log('r72e chunk patched');
