// Revert r72b -> back to r72 state (K block untouched, cL untouched)
const fs = require('fs');
const p = 'ui/_next/static/chunks/02jdcovrpfbyy.js';
let js = fs.readFileSync(p, 'utf8');
let fail = 0;

function rep(name, from, to) {
  if (!js.includes(from)) { console.error('NOT FOUND [' + name + ']'); fail = 1; return; }
  js = js.split(from).join(to);
  console.log('OK [' + name + ']');
}

// 1. cL root back to its own panel chrome
rep('cL-root',
  'className:"flex shrink-0 flex-col",children:[(0,a.jsx)(hD,{children:"New reminder"})',
  'className:"flex h-full w-[200px] shrink-0 flex-col border-l border-white/[0.08] pl-3",onClick:cE,children:[(0,a.jsx)(hD,{children:"New reminder"})'
);

// 2. Restore cL preset chips
rep('cL-presets',
  'focus:bg-white/[0.12]"})]})},cF=',
  'focus:bg-white/[0.12]"}),(0,a.jsx)("div",{className:"mt-1.5 flex gap-1",children:c$.map(e=>(0,a.jsx)("button",{type:"button",onClick:()=>n(cj(e.ms)),className:"h-[22px] flex-1 rounded-full bg-white/[0.06] text-[10.5px] font-medium text-white/60 transition-colors hover:bg-white/[0.12] hover:text-white",children:e.label},e.label))})]})},cF='
);

// 3. Combined panel head -> original trigger + original K head
rep('panel-head',
  '"focus"===c&&m&&(0,a.jsx)("div",{className:"flex h-full w-[200px] shrink-0 flex-col gap-1.5 overflow-y-auto border-l border-white/[0.08] pl-3 [scrollbar-color:rgba(255,255,255,0.18)_transparent] [scrollbar-width:thin]",onClick:cE,children:(0,a.jsxs)(s.default.Fragment,{children:[(0,a.jsx)(hD,{children:"Length"}),(0,a.jsx)("div",{className:"flex flex-wrap gap-1",',
  '"focus"===c&&m&&n&&!K&&(0,a.jsx)(cL,{reminders:n,accent:X}),K&&(0,a.jsxs)(sY.div,{initial:{opacity:0,x:8},animate:{opacity:1,x:0},transition:{duration:.2,delay:.08},className:"flex h-full w-[200px] shrink-0 flex-col border-l border-white/[0.08] pl-3",onClick:cE,children:[(0,a.jsx)(hD,{children:"Length"}),(0,a.jsx)("div",{className:"mt-2 flex flex-wrap gap-1",'
);

// 4. Inputs margin back to mt-auto
rep('inputs-margin',
  ',(0,a.jsxs)("div",{className:"mt-1 flex items-center gap-1",children:[[["min",w,b,3],',
  ',(0,a.jsxs)("div",{className:"mt-auto flex items-center gap-1",children:[[["min",w,b,3],'
);

// 5. Tail back to original closers
rep('panel-tail',
  'children:"Set"})]}),n&&(0,a.jsx)(cL,{reminders:n,accent:X})]})})]})})},cq=',
  'children:"Set"})]})]})]})})},cq='
);

if (fail) process.exit(1);
fs.writeFileSync(p, js, 'utf8');
console.log('reverted to r72 state');
