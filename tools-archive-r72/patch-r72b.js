// r72b: unified Focus side panel — Length + New reminder together, opens with Focus mode
const fs = require('fs');
const p = 'ui/_next/static/chunks/02jdcovrpfbyy.js';
let js = fs.readFileSync(p, 'utf8');
let fail = 0;

function rep(name, from, to) {
  if (!js.includes(from)) {
    console.error('NOT FOUND [' + name + ']: ' + from.slice(0, 90));
    fail = 1;
    return;
  }
  js = js.split(from).join(to);
  console.log('OK [' + name + ']');
}

// R1. cL loses its own panel chrome (becomes a section inside the combined panel)
rep('cL-root',
  'className:"flex h-full w-[200px] shrink-0 flex-col border-l border-white/[0.08] pl-3",onClick:cE,children:[(0,a.jsx)(hD,{children:"New reminder"})',
  'className:"flex shrink-0 flex-col",children:[(0,a.jsx)(hD,{children:"New reminder"})'
);

// R2. Drop the reminder preset chips (time input covers it; keeps the panel within card height)
rep('cL-presets',
  ',(0,a.jsx)("div",{className:"mt-1.5 flex gap-1",children:c$.map(e=>(0,a.jsx)("button",{type:"button",onClick:()=>n(cj(e.ms)),className:"h-[22px] flex-1 rounded-full bg-white/[0.06] text-[10.5px] font-medium text-white/60 transition-colors hover:bg-white/[0.12] hover:text-white",children:e.label},e.label))})',
  ''
);

// R3. K Length panel -> combined panel (Length + New reminder) that opens with Focus mode
const start = js.indexOf('K&&(0,a.jsxs)(sY.div,{initial:{opacity:0,x:8},animate:{opacity:1,x:0},transition:{duration:.2,delay:.08},className:"flex h-full w-[200px] shrink-0 flex-col border-l border-white/[0.08] pl-3",onClick:cE,children:[(0,a.jsx)(hD,{children:"Length"})');
if (start < 0) { console.error('NOT FOUND [K-block head]'); fail = 1; }
const endAnchor = ',cq={type:"spring",stiffness:420,damping:34}';
const end = js.indexOf(endAnchor, start);
if (end < 0) { console.error('NOT FOUND [K-block tail anchor]'); fail = 1; }
if (!fail) {
  const block = js.slice(start, end);
  if (!block.includes('children:"Set"})]})')) { console.error('UNEXPECTED [K-block tail]: ' + block.slice(-80)); fail = 1; }
  else {
    const newBlock = '"focus"===c&&m&&(0,a.jsx)("div",{className:"flex h-full w-[200px] shrink-0 flex-col gap-1.5 overflow-y-auto border-l border-white/[0.08] pl-3 [scrollbar-color:rgba(255,255,255,0.18)_transparent] [scrollbar-width:thin]",onClick:cE,children:(0,a.jsxs)(s.default.Fragment,{children:[(0,a.jsx)(hD,{children:"Length"}),(0,a.jsx)("div",{className:"flex flex-wrap gap-1",children:cS.map(e=>(0,a.jsx)("button",{type:"button","aria-pressed":e===u,onClick:()=>p(e),className:"h-[20px] min-w-[30px] rounded-full px-1.5 text-[10.5px] font-semibold tabular-nums transition-colors",style:e===u?{background:X,color:"black"}:{background:"rgba(255,255,255,0.06)",color:"rgba(255,255,255,0.55)"},children:e},e))}),(0,a.jsxs)("div",{className:"mt-1 flex items-center gap-1",children:[[["min",w,b,3],["sec",M,k,2]].map(([e,t,i,n],r)=>(0,a.jsxs)(s.default.Fragment,{children:[1===r&&(0,a.jsx)("span",{className:"text-[13px] font-semibold text-white/30",children:":"}),(0,a.jsx)("input",{value:t,inputMode:"numeric","aria-label":"min"===e?"Minutes":"Seconds",placeholder:e,onChange:t=>{let a=t.target.value.replace(/[^0-9]/g,"").slice(0,n);i("sec"===e&&Number(a)>59?"59":a)},onKeyDown:e=>{"Enter"===e.key&&A(),"Escape"===e.key&&(b(""),k(""))},className:"h-[26px] w-[46px] rounded-[8px] bg-white/[0.06] text-center text-[13px] font-semibold tabular-nums text-white outline-none transition-colors placeholder:text-[10px] placeholder:font-medium placeholder:text-white/30 focus:bg-white/[0.1]"})]},e)),(0,a.jsx)("button",{type:"button",disabled:!S,onClick:A,className:"ml-auto h-[26px] rounded-full px-3 text-[11px] font-semibold transition-colors disabled:opacity-35",style:S?{background:X,color:"black"}:{background:"rgba(255,255,255,0.08)",color:"rgba(255,255,255,0.6)"},children:"Set"})]})]),n&&(0,a.jsx)(cL,{reminders:n,accent:X})]})})';
    js = js.slice(0, start) + newBlock + js.slice(end);
    console.log('OK [K-block -> combined panel]');
  }
}

// R4. Card width: Focus open -> 468 regardless of timer state
rep('width',
  'width:K?468:"focus"===c&&m&&n&&!K?470:"time"===c&&m?330:236',
  'width:"focus"===c&&m?468:"time"===c&&m?330:236'
);

// R5. Remove the old standalone New-reminder trigger
rep('old-cL-trigger',
  ',"focus"===c&&m&&n&&!K&&(0,a.jsx)(cL,{reminders:n,accent:X})',
  ''
);

// R6. Clicking the companion card toggles it open in Focus mode too
rep('click-open',
  'onClick:"reminder"===c||"time"===c?f:void 0',
  'onClick:"focus"===c||"time"===c?f:void 0'
);

// R7. A11y label
rep('label',
  'm?"Fold the reminders":"Show the reminders"',
  'm?"Fold the timer":"Show the timer"'
);

if (fail) process.exit(1);
fs.writeFileSync(p, js, 'utf8');
console.log('r72b chunk patched');
