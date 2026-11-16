// r72d: Focus<->Reminder as one mode with a slide switch — never side by side
const fs = require('fs');
const p = 'ui/_next/static/chunks/02jdcovrpfbyy.js';
let js = fs.readFileSync(p, 'utf8');
let fail = 0;

function rep(name, from, to) {
  if (!js.includes(from)) { console.error('NOT FOUND [' + name + ']'); fail = 1; return; }
  js = js.split(from).join(to);
  console.log('OK [' + name + ']');
}

// 1. Settings: one "Focus" mode (Timer label -> Focus)
rep('cT-label',
  'cT=[{id:"focus",label:"Timer"},{id:"time",label:"Clock"},{id:"screen",label:"Screen time"}]',
  'cT=[{id:"focus",label:"Focus"},{id:"time",label:"Clock"},{id:"screen",label:"Screen time"}]'
);

// 2. Local sub-mode state inside c_ (timer | reminder)
rep('sub-state',
  '[I,B]=(0,s.useState)(!1);g=',
  '[I,B]=(0,s.useState)(!1),[dnS,dnSs]=(0,s.useState)("timer");g='
);

// 3. Length panel (K) only in timer sub-mode
rep('K-gate',
  'K=m&&"focus"===c&&!r.isRunning&&!(r.remainingMs>0&&!r.finished);',
  'K=m&&"focus"===c&&"timer"===dnS&&!r.isRunning&&!(r.remainingMs>0&&!r.finished);'
);

// 4. Focus content = slide switch chips + timer OR reminder (never both)
rep('focus-branch',
  '"focus"===c&&(0,a.jsx)("div",{className:"flex h-full items-center",children:(0,a.jsx)(cU,{timer:r,minutes:u,accent:X,open:m,onOpen:f})})',
  '"focus"===c&&(0,a.jsxs)("div",{className:"flex h-full min-w-0 flex-col justify-center gap-1.5",children:[(0,a.jsxs)("div",{className:"flex items-center gap-1.5",children:[(0,a.jsx)("button",{type:"button",onClick:e=>{e.stopPropagation(),dnSs("timer")},className:"h-[16px] rounded-full px-2 text-[8.5px] font-bold uppercase tracking-[0.12em] leading-none transition-colors",style:"timer"===dnS?{background:X,color:"black"}:{background:"rgba(255,255,255,0.07)",color:"rgba(255,255,255,0.45)"},children:"Focus"}),n&&(0,a.jsx)("button",{type:"button",onClick:e=>{e.stopPropagation(),dnSs("reminder")},className:"h-[16px] rounded-full px-2 text-[8.5px] font-bold uppercase tracking-[0.12em] leading-none transition-colors",style:"reminder"===dnS?{background:X,color:"black"}:{background:"rgba(255,255,255,0.07)",color:"rgba(255,255,255,0.45)"},children:"Reminder"})]}),"timer"===dnS||!n?(0,a.jsx)(cU,{timer:r,minutes:u,accent:X,open:m,onOpen:f}):(0,a.jsx)(cR,{reminders:n,accent:X,aim:T,open:m})]})'
);

// 5. New reminder panel only in reminder sub-mode
rep('cL-trigger',
  '"focus"===c&&m&&n&&(0,a.jsx)(cL,{reminders:n,accent:X})',
  '"focus"===c&&"reminder"===dnS&&m&&n&&(0,a.jsx)(cL,{reminders:n,accent:X})'
);

// 6. Width: timer+idle 468 (Length), reminder open 520 (New reminder), else original
rep('width',
  'width:"focus"===c&&m?K?668:470:"time"===c&&m?330:236',
  'width:K?468:"focus"===c&&m&&"reminder"===dnS?520:"time"===c&&m?330:236'
);

if (fail) process.exit(1);
fs.writeFileSync(p, js, 'utf8');
console.log('r72d chunk patched');
