// r72 UI patch: chat 560x340, reminder->focus merge, Alt+C hotkey listener
const fs = require('fs');
const p = 'ui/_next/static/chunks/02jdcovrpfbyy.js';
let js = fs.readFileSync(p, 'utf8');

const patches = [
  // 1. Chat size 640x420 -> 560x340
  ['"conversation"===h?{width:640,height:420}', '"conversation"===h?{width:560,height:340}'],

  // 2. Remove Reminder from companion mode options (remaining options shift up)
  [
    'cT=[{id:"focus",label:"Timer"},{id:"reminder",label:"Reminder"},{id:"time",label:"Clock"},{id:"screen",label:"Screen time"}]',
    'cT=[{id:"focus",label:"Timer"},{id:"time",label:"Clock"},{id:"screen",label:"Screen time"}]',
  ],

  // 3. Legacy stored modes "tasks"/"reminder" map to "focus"
  [
    'companionMode:(e?.companionMode==="ai"?"screen":e?.companionMode==="tasks"?"reminder":e?.companionMode)??',
    'companionMode:(e?.companionMode==="ai"?"screen":e?.companionMode==="tasks"||e?.companionMode==="reminder"?"focus":e?.companionMode)??',
  ],

  // 4. Companion card width: when Focus open with reminders panel (timer active) -> 470
  [
    'width:K?468:"reminder"===c&&m?520:"time"===c&&m?330:236',
    'width:K?468:"focus"===c&&m&&n&&!K?470:"time"===c&&m?330:236',
  ],

  // 5. New-reminder side panel now opens from Focus mode while timer runs
  [
    '"reminder"===c&&m&&n&&(0,a.jsx)(cL,{reminders:n,accent:X})',
    '"focus"===c&&m&&n&&!K&&(0,a.jsx)(cL,{reminders:n,accent:X})',
  ],

  // 6. Settings Mode dropdown: stored "reminder" value displays as Timer
  [
    'value:"screen"!==e.companionMode||n?e.companionMode:"focus"',
    'value:"reminder"===e.companionMode?"focus":"screen"!==e.companionMode||n?e.companionMode:"focus"',
  ],

  // 7. Alt+C global hotkey -> open Conversation and hold the notch open
  [
    'w(t),P("capture",15000))}),[]);',
    'w(t),P("capture",15000))}),[]);(0,s.useEffect)(()=>window.bridge?.on("hotkey:chat",()=>{clearTimeout(T.current),dnH.current="conversation",c("conversation"),M(!0)}),[]);',
  ],
];

let fail = 0;
for (const [from, to] of patches) {
  if (!js.includes(from)) {
    console.error('NOT FOUND: ' + from.slice(0, 80));
    fail = 1;
    continue;
  }
  if (js.includes(to) && from !== to) {
    console.error('ALREADY PATCHED: ' + to.slice(0, 80));
  }
  js = js.split(from).join(to);
  console.log('OK: ' + from.slice(0, 60) + '...');
}

if (fail) process.exit(1);
fs.writeFileSync(p, js, 'utf8');
console.log('r72 chunk patched');
