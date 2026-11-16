// r72f: plumb reminders into the Focus&Tasks view (dl) so the pill actually switches
const fs = require('fs');
const p = 'ui/_next/static/chunks/02jdcovrpfbyy.js';
let js = fs.readFileSync(p, 'utf8');
let fail = 0;

function rep(name, from, to) {
  if (!js.includes(from)) { console.error('NOT FOUND [' + name + ']'); fail = 1; return; }
  js = js.split(from).join(to);
  console.log('OK [' + name + ']');
}

// 1. dl accepts a reminders prop
rep('dl-sig',
  'dl=({avatar:e,photo:t,tasks:i,timer:n,minutes:r,onMinutes:o,accent:l,track:h,playing:c,sleeps:d})=>{',
  'dl=({avatar:e,photo:t,tasks:i,timer:n,minutes:r,onMinutes:o,accent:l,track:h,playing:c,sleeps:d,reminders:dnRem})=>{'
);

// 2. dl forwards it into its embedded companion card
rep('dl-c_',
  'children:(0,a.jsx)(c_,{avatar:e,photo:t,tasks:i,timer:n,track:h,playing:c,mode:"focus",sleeps:d,minutes:r,onMinutes:o,open:u,onToggle:()=>p(e=>!e)})',
  'children:(0,a.jsx)(c_,{avatar:e,photo:t,tasks:i,timer:n,track:h,playing:c,mode:"focus",sleeps:d,minutes:r,onMinutes:o,open:u,onToggle:()=>p(e=>!e),reminders:dnRem})'
);

// 3. The main component passes its reminders store down to dl (unique: dl has no mode:J)
rep('dl-invoke',
  'playing:er,sleeps:_.companionSleeps??"time"})',
  'playing:er,sleeps:_.companionSleeps??"time",reminders:o})'
);

if (fail) process.exit(1);
fs.writeFileSync(p, js, 'utf8');
console.log('r72f chunk patched');
