const fs = require('fs');
const filePath = 'D:/project liburan/pet widget/desknotch-tauri/ui/_next/static/chunks/02jdcovrpfbyy.js';
let src = fs.readFileSync(filePath, 'utf8');

// 1. DND state in main component
const p1 = 'let[f,g]=(0,s.useState)(!1),[dnPin,dnSetPin]=(0,s.useState)(!1)';
const r1 = 'let[f,g]=(0,s.useState)(!1),[dnPin,dnSetPin]=(0,s.useState)(!1),[dnDnd,dnSetDnd]=(0,s.useState)(()=>!!(_.dnd)),dnDndRef=(0,s.useRef)(!1);dnDndRef.current=dnDnd';
if (!src.includes(p1)) throw new Error('p1 not found');
src = src.replace(p1, r1);

// 2. dnTopBar definition
const p2 = 'dnTopBar=({views:tbViews,active:tbActive,onChange:tbChange,accent:tbAccent,privacy:tbPriv,pinned:tbPin,onPin:tbOnPin})';
const r2 = 'dnTopBar=({views:tbViews,active:tbActive,onChange:tbChange,accent:tbAccent,privacy:tbPriv,pinned:tbPin,onPin:tbOnPin,dnd:tbDnd,onDnd:tbOnDnd})';
if (!src.includes(p2)) throw new Error('p2 not found');
src = src.replace(p2, r2);

// 3. dnRailTopRight add DND button next to Settings
const p3 = 'children:[tbTool({label:"Settings",onClick:()=>tbChange(tbEvent=>"settings"===tbEvent?"glance":"settings"),children:(0,a.jsx)(s5,{size:13,strokeWidth:2.2})}),dnPrivDots';
const r3 = 'children:[tbTool({label:tbDnd?"Jangan Ganggu (Aktif)":"Jangan Ganggu (Mati)",onClick:tbOnDnd,active:tbDnd,children:(0,a.jsx)("svg",{width:13,height:13,viewBox:"0 0 24 24",fill:tbDnd?"currentColor":"none",stroke:"currentColor",strokeWidth:2.2,strokeLinecap:"round",strokeLinejoin:"round",children:(0,a.jsx)("path",{d:"M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"})})}),tbTool({label:"Settings",onClick:()=>tbChange(tbEvent=>"settings"===tbEvent?"glance":"settings"),children:(0,a.jsx)(s5,{size:13,strokeWidth:2.2})}),dnPrivDots';
if (!src.includes(p3)) throw new Error('p3 not found');
src = src.replace(p3, r3);

// 4. dnTopBar call site
const p4 = '(0,a.jsx)(dnTopBar,{views:ei,active:h,onChange:c,accent:eh,privacy:D,pinned:dnPin,onPin:()=>{let dnnp=!dnPin;dnSetPin(dnnp);dnPinRef.current=dnnp;M(dnnp)}})';
const r4 = '(0,a.jsx)(dnTopBar,{views:ei,active:h,onChange:c,accent:eh,privacy:D,pinned:dnPin,onPin:()=>{let dnnp=!dnPin;dnSetPin(dnnp);dnPinRef.current=dnnp;M(dnnp)},dnd:dnDnd,onDnd:()=>{let nxd=!dnDnd;dnSetDnd(nxd);dnDndRef.current=nxd;q(t=>({...t,dnd:nxd}));window.bridge?.invoke("store:set","settings",{..._,dnd:nxd})}})';
if (!src.includes(p4)) throw new Error('p4 not found');
src = src.replace(p4, r4);

// 5. Suppress notif popup when DND is active
const pNotif = '(0,s.useEffect)(()=>window.bridge?.on("notif:arrived",e=>(dnNotifR(e)';
const rNotif = '(0,s.useEffect)(()=>window.bridge?.on("notif:arrived",e=>{if(dnDndRef.current)return;dnNotifR(e)';
if (src.includes(pNotif)) {
  src = src.replace(pNotif, rNotif);
}

// 6. Companion cycle on avatar click
const p5 = 'ref:N,className:"relative grid h-full w-[96px] shrink-0 place-items-center",children:[(0,a.jsxs)("div",{className:"pointer-events-none relative z-10 grid place-items-center"';
const r5 = 'ref:N,title:"Klik untuk ganti companion",style:{cursor:"pointer"},onClick:cEv=>{cEv.stopPropagation();let cAvList=["ghost","cat","blob","clover","droid","alien","cloud"],curIdx=cAvList.indexOf(e),nextAv=cAvList[(curIdx+1)%cAvList.length];window.bridge?.invoke("store:get","settings").then(st=>{let nxt=Object.assign({},st,{avatar:nextAv});window.bridge?.invoke("store:set","settings",nxt)})},className:"relative grid h-full w-[96px] shrink-0 place-items-center",children:[(0,a.jsxs)("div",{className:"pointer-events-none relative z-10 grid place-items-center"';
if (!src.includes(p5)) throw new Error('p5 not found');
src = src.replace(p5, r5);

// 7. Pass reminders to dl call site
const p6 = '(0,a.jsx)(dl,{avatar:_.avatar,photo:E,tasks:n,timer:i,minutes:_.focusMinutes??25,';
const r6 = '(0,a.jsx)(dl,{avatar:_.avatar,photo:E,tasks:n,reminders:o,timer:i,minutes:_.focusMinutes??25,';
if (!src.includes(p6)) throw new Error('p6 not found');
src = src.replace(p6, r6);

// 8. dl signature
const p7 = 'dl=({avatar:e,photo:t,tasks:i,timer:n,minutes:r,onMinutes:o,accent:l,track:h,playing:c,sleeps:d})';
const r7 = 'dl=({avatar:e,photo:t,tasks:i,reminders:rem,timer:n,minutes:r,onMinutes:o,accent:l,track:h,playing:c,sleeps:d})';
if (!src.includes(p7)) throw new Error('p7 not found');
src = src.replace(p7, r7);

// 9. dl body passing reminders to dr
const p8 = '(0,a.jsx)(dr,{tasks:i,accent:l})';
const r8 = '(0,a.jsx)(dr,{tasks:i,reminders:rem,accent:l})';
if (!src.includes(p8)) throw new Error('p8 not found');
src = src.replace(p8, r8);

// 10. dr signature and tab switcher for Reminders
const p9 = 'dr=({tasks:e,accent:t})=>{let{tasks:i,add:n,toggle:r,remove:o,setTasks:l}=e,[h,c]=(0,s.useState)(""),[d,u]=(0,s.useState)(!1),p=i.filter(e=>!e.done),m=i.filter(e=>e.done);';
const r9 = 'dr=({tasks:e,reminders:rem,accent:t})=>{let{tasks:i,add:n,toggle:r,remove:o,setTasks:l}=e,[drTab,setDrTab]=(0,s.useState)("tasks"),[drRemTxt,setDrRemTxt]=(0,s.useState)(""),[h,c]=(0,s.useState)(""),[d,u]=(0,s.useState)(!1),p=i.filter(e=>!e.done),m=i.filter(e=>e.done),remList=(rem&&rem.reminders)?rem.reminders:[];';
if (!src.includes(p9)) throw new Error('p9 not found');
src = src.replace(p9, r9);

// 11. Add tab switcher in dr body
const pDrBody = 'return(0,a.jsxs)(sY.div,{variants:di,className:"flex min-h-0 min-w-0 flex-1 flex-col",onClick:ds,children:[';
const rDrBody = `return(0,a.jsxs)(sY.div,{variants:di,className:"flex min-h-0 min-w-0 flex-1 flex-col",onClick:ds,children:[(0,a.jsxs)("div",{style:{display:"flex",alignItems:"center",gap:"14px",marginBottom:"2px",fontSize:"11.5px",fontWeight:600},children:[(0,a.jsxs)("button",{type:"button",onClick:()=>setDrTab("tasks"),style:{border:"none",background:"transparent",color:drTab==="tasks"?"#fff":"rgba(255,255,255,0.4)",cursor:"pointer",padding:"2px 0",borderBottom:drTab==="tasks"?("2px solid "+(t||"#fff")):"2px solid transparent"},children:["Tasks (",p.length,")"]}),(0,a.jsxs)("button",{type:"button",onClick:()=>setDrTab("reminders"),style:{border:"none",background:"transparent",color:drTab==="reminders"?"#fff":"rgba(255,255,255,0.4)",cursor:"pointer",padding:"2px 0",borderBottom:drTab==="reminders"?("2px solid "+(t||"#fff")):"2px solid transparent"},children:["Reminders (",remList.length,")"]})]}),drTab==="reminders"?(0,a.jsxs)("div",{style:{display:"flex",flexDirection:"column",height:"100%"},children:[(0,a.jsxs)("div",{style:{display:"flex",alignItems:"center",gap:"8px",borderBottom:"1px solid rgba(255,255,255,0.1)",padding:"6px 0"},children:[(0,a.jsx)("input",{type:"text",value:drRemTxt,onChange:e=>setDrRemTxt(e.target.value),onKeyDown:e=>{"Enter"===e.key&&(e.preventDefault(),drRemTxt.trim()&&(rem&&rem.add(Date.now()+600000,drRemTxt.trim()),setDrRemTxt(""))) },placeholder:"Tambah pengingat (Enter = 10 mnt)",style:{flex:1,background:"transparent",border:"none",outline:"none",color:"#fff",fontSize:"13px"}}),(0,a.jsx)("button",{type:"button",onClick:()=>{drRemTxt.trim()&&(rem&&rem.add(Date.now()+600000,drRemTxt.trim()),setDrRemTxt(""))},style:{background:"rgba(255,255,255,0.1)",color:"#fff",border:"none",borderRadius:"4px",padding:"2px 8px",fontSize:"11px",cursor:"pointer"},children:"Tambah"})]}),(0,a.jsx)("div",{style:{flex:1,overflowY:"auto",paddingTop:"6px"},children:remList.length?remList.map(rm=>(0,a.jsxs)("div",{key:rm.id,style:{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"6px 4px",borderBottom:"1px solid rgba(255,255,255,0.05)"},children:[(0,a.jsxs)("div",{style:{display:"flex",flexDirection:"column"},children:[(0,a.jsx)("span",{style:{fontSize:"12.5px",color:"#fff",fontWeight:500},children:rm.message||rm.label||"Pengingat"}),(0,a.jsx)("span",{style:{fontSize:"10.5px",color:"rgba(255,255,255,0.45)"},children:new Date(rm.at).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})})]}),(0,a.jsx)("button",{type:"button",onClick:()=>rem&&rem.remove(rm.id),style:{background:"transparent",border:"none",color:"rgba(255,255,255,0.4)",cursor:"pointer",padding:"2px 6px"},children:"✕"})]})):(0,a.jsx)("div",{style:{fontSize:"12px",color:"rgba(255,255,255,0.35)",paddingTop:"10px"},children:"Tidak ada pengingat aktif"})})]}):`;

if (!src.includes(pDrBody)) throw new Error('pDrBody not found');
src = src.replace(pDrBody, rDrBody);

fs.writeFileSync(filePath, src, 'utf8');
console.log('Successfully patched all UI features in 02jdcovrpfbyy.js!');
