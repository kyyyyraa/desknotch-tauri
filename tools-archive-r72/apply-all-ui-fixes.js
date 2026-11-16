const fs = require('fs');
const filePath = 'D:/project liburan/pet widget/desknotch-tauri/ui/_next/static/chunks/02jdcovrpfbyy.js';
let src = fs.readFileSync(filePath, 'utf8');

// =========================================================================
// 1. Settings: Model Voice and Model Chat selectors
// =========================================================================
const oldState = 'rtH7=(0,s.useState)(""),rtMsg=rtH7[0],rtSetMsg=rtH7[1];';
const newState = 'rtH7=(0,s.useState)(""),rtMsg=rtH7[0],rtSetMsg=rtH7[1],rtH8=(0,s.useState)(""),rtVoiceModel=rtH8[0],rtSetVoiceModel=rtH8[1],rtH9=(0,s.useState)(""),rtConvoModel=rtH9[0],rtSetConvoModel=rtH9[1];';

const oldRtLoad = 'var rtLoad=function(){var rW=window.dnRouter;if(rW){var p=rW.DEFAULTS||{},pk=null;try{pk=rW.peek()}catch(rtE){pk=null}rtSetBase(rtBase||(pk&&pk.baseUrl)||(p.baseUrl||"http://127.0.0.1:20128"));rtSetModelTxt(rtModelTxt||(pk&&pk.model)||"");if(rW.listModels)rW.listModels().then(function(ls){rtSetList(ls||[]);rtSetTick(function(x){return x+1})})}};';
const newRtLoad = 'var rtLoad=function(){var rW=window.dnRouter;if(rW){var p=rW.DEFAULTS||{},pk=null;try{pk=rW.peek()}catch(rtE){pk=null}rtSetBase(rtBase||(pk&&pk.baseUrl)||(p.baseUrl||"http://127.0.0.1:20128"));rtSetModelTxt(rtModelTxt||(pk&&pk.model)||"");rtSetVoiceModel(rtVoiceModel||(pk&&pk.voiceModel)||"");rtSetConvoModel(rtConvoModel||(pk&&pk.convoModel)||"");if(rW.listModels)rW.listModels().then(function(ls){rtSetList(ls||[]);rtSetTick(function(x){return x+1})})}};';

if (!src.includes(oldState)) throw new Error('oldState not found');
if (!src.includes(oldRtLoad)) throw new Error('oldRtLoad not found');

src = src.replace(oldState, newState);
src = src.replace(oldRtLoad, newRtLoad);

const oldJsxStart = src.indexOf('below:rtOpen?(0,a.jsxs)("div",{style:{display:"flex",flexDirection:"column",gap:"6px",marginTop:"8px"}');
const oldJsxEnd = src.indexOf('rtMsg?(0,a.jsx)("div",{style:{fontSize:"10.5px",color:"rgba(255,255,255,0.65)",wordBreak:"break-all"},children:rtMsg}):null', oldJsxStart);

const newJsx = 'below:rtOpen?(0,a.jsxs)("div",{style:{display:"flex",flexDirection:"column",gap:"6px",marginTop:"8px"},children:[' +
  '(0,a.jsx)("input",{type:"password",placeholder:rtConf()?"Tersimpan \\u2014 isi baru untuk mengganti":"API key 9router",value:rtKey,onChange:e=>rtSetKey(e.target.value),style:{background:"rgba(255,255,255,0.07)",color:"#fff",border:"1px solid rgba(255,255,255,0.15)",borderRadius:"6px",padding:"5px 8px",fontSize:"11.5px",outline:"none"}}),' +
  '(0,a.jsx)("div",{style:{fontSize:"11px",color:"rgba(255,255,255,0.75)",fontWeight:500,marginTop:"2px"},children:"Model Voice (Cepat & Ringkas):"}),' +
  'rtList.length?(0,a.jsxs)("select",{value:rtVoiceModel,onChange:e=>rtSetVoiceModel(e.target.value),style:{background:"#1a1a1a",color:"#fff",border:"1px solid rgba(255,255,255,0.15)",borderRadius:"6px",padding:"5px 8px",fontSize:"11.5px"},children:[(0,a.jsx)("option",{value:"",children:"\\u2014 ikuti model utama \\u2014"}),rtList.map(function(mid){return (0,a.jsx)("option",{value:mid,children:mid},mid)})]}):null,' +
  '(0,a.jsx)("input",{type:"text",placeholder:"model voice (mis. gpt-4o-mini)",value:rtVoiceModel,onChange:e=>rtSetVoiceModel(e.target.value),style:{background:"rgba(255,255,255,0.07)",color:"#fff",border:"1px solid rgba(255,255,255,0.15)",borderRadius:"6px",padding:"5px 8px",fontSize:"11.5px",outline:"none"}}),' +
  '(0,a.jsx)("div",{style:{fontSize:"11px",color:"rgba(255,255,255,0.75)",fontWeight:500,marginTop:"2px"},children:"Model Chat (Percakapan & Analisis):"}),' +
  'rtList.length?(0,a.jsxs)("select",{value:rtConvoModel,onChange:e=>rtSetConvoModel(e.target.value),style:{background:"#1a1a1a",color:"#fff",border:"1px solid rgba(255,255,255,0.15)",borderRadius:"6px",padding:"5px 8px",fontSize:"11.5px"},children:[(0,a.jsx)("option",{value:"",children:"\\u2014 ikuti model utama \\u2014"}),rtList.map(function(mid){return (0,a.jsx)("option",{value:mid,children:mid},mid)})]}):null,' +
  '(0,a.jsx)("input",{type:"text",placeholder:"model chat (mis. claude-3-5-sonnet)",value:rtConvoModel,onChange:e=>rtSetConvoModel(e.target.value),style:{background:"rgba(255,255,255,0.07)",color:"#fff",border:"1px solid rgba(255,255,255,0.15)",borderRadius:"6px",padding:"5px 8px",fontSize:"11.5px",outline:"none"}}),' +
  '(0,a.jsx)("div",{style:{fontSize:"11px",color:"rgba(255,255,255,0.5)",marginTop:"2px"},children:"Model Default (Cadangan):"}),' +
  'rtList.length?(0,a.jsxs)("select",{value:rtModelTxt,onChange:e=>rtSetModelTxt(e.target.value),style:{background:"#1a1a1a",color:"#fff",border:"1px solid rgba(255,255,255,0.15)",borderRadius:"6px",padding:"5px 8px",fontSize:"11.5px"},children:[(0,a.jsx)("option",{value:"",children:"\\u2014 pilih model \\u2014"}),rtList.map(function(mid){return (0,a.jsx)("option",{value:mid,children:mid},mid)})]}):null,' +
  '(0,a.jsx)("input",{type:"text",placeholder:"model default (mis. gpt-4o-mini)",value:rtModelTxt,onChange:e=>rtSetModelTxt(e.target.value),style:{background:"rgba(255,255,255,0.07)",color:"#fff",border:"1px solid rgba(255,255,255,0.15)",borderRadius:"6px",padding:"5px 8px",fontSize:"11.5px",outline:"none"}}),' +
  '(0,a.jsx)("input",{type:"text",placeholder:"http://127.0.0.1:20128",value:rtBase,onChange:e=>rtSetBase(e.target.value),style:{background:"rgba(255,255,255,0.07)",color:"#fff",border:"1px solid rgba(255,255,255,0.15)",borderRadius:"6px",padding:"5px 8px",fontSize:"11.5px",outline:"none"}}),' +
  '(0,a.jsxs)("div",{style:{display:"flex",gap:"6px",alignItems:"center"},children:[' +
    '(0,a.jsx)("button",{type:"button",onClick:()=>{var rW=window.dnRouter;if(rW)rW.configure({baseUrl:rtBase,apiKey:rtKey,model:rtModelTxt,voiceModel:rtVoiceModel,convoModel:rtConvoModel}).then(function(){rtSetMsg(rtKey?"Tersimpan":"Tersimpan (key lama dipakai)");rtSetTick(function(x){return x+1})},function(er){rtSetMsg(er&&er.message||"Gagal")})},style:{background:"rgba(255,255,255,0.14)",color:"#fff",border:"1px solid rgba(255,255,255,0.2)",borderRadius:"6px",padding:"3px 10px",fontSize:"11px",cursor:"pointer"},children:"Simpan"}),' +
    '(0,a.jsx)("button",{type:"button",onClick:()=>{var rW=window.dnRouter;if(!rW)return void rtSetMsg("dnRouter tidak ada");rW.test().then(function(res){rtSetMsg(res&&res.ok?"OK":(res&&res.error)||"Gagal")})},style:{background:"rgba(255,255,255,0.14)",color:"#fff",border:"1px solid rgba(255,255,255,0.2)",borderRadius:"6px",padding:"3px 10px",fontSize:"11px",cursor:"pointer"},children:"Tes"})' +
  ']}),';

src = src.substring(0, oldJsxStart) + newJsx + src.substring(oldJsxEnd);

// =========================================================================
// 2. Fix Pin/Lock toggle: M(dnnp) so unpinning actually allows notch to close
// =========================================================================
const tPin = 'pinned:dnPin,onPin:()=>{let dnnp=!dnPin;dnSetPin(dnnp),M(!0)}})';
const rPin = 'pinned:dnPin,onPin:()=>{let dnnp=!dnPin;dnSetPin(dnnp);dnPinRef.current=dnnp;M(dnnp)}})';
if (!src.includes(tPin)) throw new Error('tPin not found');
src = src.replace(tPin, rPin);

// =========================================================================
// 3. Fix Screenshot Card: fixed 96x96 box, notch width 460px, 15s duration, hover guard
// =========================================================================
const tCapWidth = '"capture"===h?{width:404,height:150}';
const rCapWidth = '"capture"===h?{width:460,height:150}';
if (!src.includes(tCapWidth)) throw new Error('tCapWidth not found');
src = src.replace(tCapWidth, rCapWidth);

const tCapDur = 't&&(w(t),P("capture",4500))';
const rCapDur = 't&&(w(t),P("capture",15000))';
if (!src.includes(tCapDur)) throw new Error('tCapDur not found');
src = src.replace(tCapDur, rCapDur);

const tCapHover = 'T.current=setTimeout(()=>{dnH.current!=="voice"&&(M(dnPinRef.current),dnPop())},t)';
const rCapHover = 'T.current=setTimeout(()=>{if(S.current&&"capture"===dnH.current)return;dnH.current!=="voice"&&(M(dnPinRef.current),dnPop())},t)';
if (!src.includes(tCapHover)) throw new Error('tCapHover not found');
src = src.replace(tCapHover, rCapHover);

// Container in dY: replace thumbnail box with strictly bounded 96x96 box
const tThumbBox = 'className:"relative shrink-0 cursor-grab overflow-hidden rounded-[12px] shadow-[0_0_0_1px_rgba(255,255,255,0.16),0_10px_24px_-10px_rgba(0,0,0,0.9)] active:cursor-grabbing",style:{height:96},children:[e.thumb?(0,a.jsx)("img",{src:e.thumb,alt:"",draggable:!1,className:"h-full w-auto max-w-[160px] object-cover"}):(0,a.jsx)("div",{className:"h-full w-[150px] bg-white/10"})';
const rThumbBox = 'className:"relative shrink-0 cursor-grab overflow-hidden rounded-[12px] shadow-[0_0_0_1px_rgba(255,255,255,0.16),0_10px_24px_-10px_rgba(0,0,0,0.9)] active:cursor-grabbing",style:{height:96,width:96,minWidth:96,maxWidth:96},children:[e.thumb?(0,a.jsx)("img",{src:e.thumb,alt:"",draggable:!1,style:{width:"100%",height:"100%",objectFit:"cover"}}):(0,a.jsx)("div",{style:{width:"100%",height:"100%",background:"rgba(255,255,255,0.1)"}})';
if (!src.includes(tThumbBox)) throw new Error('tThumbBox not found');
src = src.replace(tThumbBox, rThumbBox);

// =========================================================================
// 4. Do Not Disturb (DND) button in dnTopBar & notification suppression
// =========================================================================
const tDndState = 'let[f,g]=(0,s.useState)(!1),[dnPin,dnSetPin]=(0,s.useState)(!1),';
const rDndState = 'let[f,g]=(0,s.useState)(!1),[dnPin,dnSetPin]=(0,s.useState)(!1),[dnDnd,dnSetDnd]=(0,s.useState)(()=>!!(_.dnd)),dnDndRef=(0,s.useRef)(!1),';
if (!src.includes(tDndState)) throw new Error('tDndState not found');
src = src.replace(tDndState, rDndState);

const tDndSync = 'dnH.current=h,dnPinRef.current=dnPin;';
const rDndSync = 'dnH.current=h,dnPinRef.current=dnPin,dnDndRef.current=dnDnd;';
if (!src.includes(tDndSync)) throw new Error('tDndSync not found');
src = src.replace(tDndSync, rDndSync);

const tTopBarDef = 'dnTopBar=({views:tbViews,active:tbActive,onChange:tbChange,accent:tbAccent,privacy:tbPriv,pinned:tbPin,onPin:tbOnPin})';
const rTopBarDef = 'dnTopBar=({views:tbViews,active:tbActive,onChange:tbChange,accent:tbAccent,privacy:tbPriv,pinned:tbPin,onPin:tbOnPin,dnd:tbDnd,onDnd:tbOnDnd})';
if (!src.includes(tTopBarDef)) throw new Error('tTopBarDef not found');
src = src.replace(tTopBarDef, rTopBarDef);

const tRailRight = 'children:[tbTool({label:"Settings",onClick:()=>tbChange(tbEvent=>"settings"===tbEvent?"glance":"settings"),children:(0,a.jsx)(s5,{size:13,strokeWidth:2.2})}),dnPrivDots';
const rRailRight = 'children:[tbTool({label:tbDnd?"Jangan Ganggu (Aktif)":"Jangan Ganggu (Mati)",onClick:tbOnDnd,active:tbDnd,children:(0,a.jsx)("svg",{width:13,height:13,viewBox:"0 0 24 24",fill:tbDnd?"currentColor":"none",stroke:"currentColor",strokeWidth:2.2,strokeLinecap:"round",strokeLinejoin:"round",children:(0,a.jsx)("path",{d:"M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"})})}),tbTool({label:"Settings",onClick:()=>tbChange(tbEvent=>"settings"===tbEvent?"glance":"settings"),children:(0,a.jsx)(s5,{size:13,strokeWidth:2.2})}),dnPrivDots';
if (!src.includes(tRailRight)) throw new Error('tRailRight not found');
src = src.replace(tRailRight, rRailRight);

const tTopBarCall = '(0,a.jsx)(dnTopBar,{views:ei,active:h,onChange:c,accent:eh,privacy:D,pinned:dnPin,onPin:()=>{let dnnp=!dnPin;dnSetPin(dnnp);dnPinRef.current=dnnp;M(dnnp)}})';
const rTopBarCall = '(0,a.jsx)(dnTopBar,{views:ei,active:h,onChange:c,accent:eh,privacy:D,pinned:dnPin,onPin:()=>{let dnnp=!dnPin;dnSetPin(dnnp);dnPinRef.current=dnnp;M(dnnp)},dnd:dnDnd,onDnd:()=>{let nxd=!dnDnd;dnSetDnd(nxd);dnDndRef.current=nxd;q(t=>({...t,dnd:nxd}));window.bridge?.invoke("store:set","settings",{..._,dnd:nxd})}})';
if (!src.includes(tTopBarCall)) throw new Error('tTopBarCall not found');
src = src.replace(tTopBarCall, rTopBarCall);

const tNotifOn = '(0,s.useEffect)(()=>window.bridge?.on("notif:arrived",e=>(dnNotifR(e)';
const rNotifOn = '(0,s.useEffect)(()=>window.bridge?.on("notif:arrived",e=>{if(dnDndRef.current)return;dnNotifR(e)';
if (!src.includes(tNotifOn)) throw new Error('tNotifOn not found');
src = src.replace(tNotifOn, rNotifOn);

// =========================================================================
// 5. Click-to-cycle companion on avatar
// =========================================================================
const tAvatarClick = 'ref:N,className:"relative grid h-full w-[96px] shrink-0 place-items-center",children:[(0,a.jsxs)("div",{className:"pointer-events-none relative z-10 grid place-items-center"';
const rAvatarClick = 'ref:N,title:"Klik untuk ganti companion",style:{cursor:"pointer"},onClick:cEv=>{cEv.stopPropagation();let cAvList=["ghost","cat","blob","clover","droid","alien","cloud"],curIdx=cAvList.indexOf(e),nextAv=cAvList[(curIdx+1)%cAvList.length];window.bridge?.invoke("store:get","settings").then(st=>{let nxt=Object.assign({},st,{avatar:nextAv});window.bridge?.invoke("store:set","settings",nxt)})},className:"relative grid h-full w-[96px] shrink-0 place-items-center",children:[(0,a.jsxs)("div",{className:"pointer-events-none relative z-10 grid place-items-center"';
if (!src.includes(tAvatarClick)) throw new Error('tAvatarClick not found');
src = src.replace(tAvatarClick, rAvatarClick);

// =========================================================================
// 6. Unify Reminders into Focus & Tasks (dl / dr)
// =========================================================================
const tDlCall = '(0,a.jsx)(dl,{avatar:_.avatar,photo:E,tasks:n,timer:i,minutes:_.focusMinutes??25,';
const rDlCall = '(0,a.jsx)(dl,{avatar:_.avatar,photo:E,tasks:n,reminders:o,timer:i,minutes:_.focusMinutes??25,';
if (!src.includes(tDlCall)) throw new Error('tDlCall not found');
src = src.replace(tDlCall, rDlCall);

const tDlSig = 'dl=({avatar:e,photo:t,tasks:i,timer:n,minutes:r,onMinutes:o,accent:l,track:h,playing:c,sleeps:d})';
const rDlSig = 'dl=({avatar:e,photo:t,tasks:i,reminders:rem,timer:n,minutes:r,onMinutes:o,accent:l,track:h,playing:c,sleeps:d})';
if (!src.includes(tDlSig)) throw new Error('tDlSig not found');
src = src.replace(tDlSig, rDlSig);

const tDlBody = '(0,a.jsx)(dr,{tasks:i,accent:l})';
const rDlBody = '(0,a.jsx)(dr,{tasks:i,reminders:rem,accent:l})';
if (!src.includes(tDlBody)) throw new Error('tDlBody not found');
src = src.replace(tDlBody, rDlBody);

const tDrSig = 'dr=({tasks:e,accent:t})=>{let{tasks:i,add:n,toggle:r,remove:o,setTasks:l}=e,[h,c]=(0,s.useState)(""),[d,u]=(0,s.useState)(!1),p=i.filter(e=>!e.done),m=i.filter(e=>e.done);';
const rDrSig = 'dr=({tasks:e,reminders:rem,accent:t})=>{let{tasks:i,add:n,toggle:r,remove:o,setTasks:l}=e,[drTab,setDrTab]=(0,s.useState)("tasks"),[drRemTxt,setDrRemTxt]=(0,s.useState)(""),[h,c]=(0,s.useState)(""),[d,u]=(0,s.useState)(!1),p=i.filter(e=>!e.done),m=i.filter(e=>e.done),remList=(rem&&rem.reminders)?rem.reminders:[];';
if (!src.includes(tDrSig)) throw new Error('tDrSig not found');
src = src.replace(tDrSig, rDrSig);

const tDrBody = 'return(0,a.jsxs)(sY.div,{variants:di,className:"flex min-h-0 min-w-0 flex-1 flex-col",onClick:ds,children:[';
const rDrBody = 'return(0,a.jsxs)(sY.div,{variants:di,className:"flex min-h-0 min-w-0 flex-1 flex-col",onClick:ds,children:[' +
  '(0,a.jsxs)("div",{style:{display:"flex",alignItems:"center",gap:"14px",marginBottom:"2px",fontSize:"11.5px",fontWeight:600},children:[' +
    '(0,a.jsxs)("button",{type:"button",onClick:()=>setDrTab("tasks"),style:{border:"none",background:"transparent",color:drTab==="tasks"?"#fff":"rgba(255,255,255,0.4)",cursor:"pointer",padding:"2px 0",borderBottom:drTab==="tasks"?("2px solid "+(t||"#fff")):"2px solid transparent"},children:["Tasks (",p.length,")"]}),' +
    '(0,a.jsxs)("button",{type:"button",onClick:()=>setDrTab("reminders"),style:{border:"none",background:"transparent",color:drTab==="reminders"?"#fff":"rgba(255,255,255,0.4)",cursor:"pointer",padding:"2px 0",borderBottom:drTab==="reminders"?("2px solid "+(t||"#fff")):"2px solid transparent"},children:["Reminders (",remList.length,")"]})' +
  ']}),' +
  'drTab==="reminders"?(0,a.jsxs)("div",{style:{display:"flex",flexDirection:"column",height:"100%"},children:[' +
    '(0,a.jsxs)("div",{style:{display:"flex",alignItems:"center",gap:"8px",borderBottom:"1px solid rgba(255,255,255,0.1)",padding:"6px 0"},children:[' +
      '(0,a.jsx)("input",{type:"text",value:drRemTxt,onChange:e=>setDrRemTxt(e.target.value),onKeyDown:e=>{"Enter"===e.key&&(e.preventDefault(),drRemTxt.trim()&&(rem&&rem.add(Date.now()+600000,drRemTxt.trim()),setDrRemTxt(""))) },placeholder:"Tambah pengingat (Enter = 10 mnt)",style:{flex:1,background:"transparent",border:"none",outline:"none",color:"#fff",fontSize:"13px"}}),' +
      '(0,a.jsx)("button",{type:"button",onClick:()=>{drRemTxt.trim()&&(rem&&rem.add(Date.now()+600000,drRemTxt.trim()),setDrRemTxt(""))},style:{background:"rgba(255,255,255,0.1)",color:"#fff",border:"none",borderRadius:"4px",padding:"2px 8px",fontSize:"11px",cursor:"pointer"},children:"Tambah"})' +
    ']}),' +
    '(0,a.jsx)("div",{style:{flex:1,overflowY:"auto",paddingTop:"6px"},children:remList.length?remList.map(rm=>(0,a.jsxs)("div",{key:rm.id,style:{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"6px 4px",borderBottom:"1px solid rgba(255,255,255,0.05)"},children:[' +
      '(0,a.jsxs)("div",{style:{display:"flex",flexDirection:"column"},children:[' +
        '(0,a.jsx)("span",{style:{fontSize:"12.5px",color:"#fff",fontWeight:500},children:rm.message||rm.label||"Pengingat"}),' +
        '(0,a.jsx)("span",{style:{fontSize:"10.5px",color:"rgba(255,255,255,0.45)"},children:new Date(rm.at).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})})' +
      ']}),' +
      '(0,a.jsx)("button",{type:"button",onClick:()=>rem&&rem.remove(rm.id),style:{background:"transparent",border:"none",color:"rgba(255,255,255,0.4)",cursor:"pointer",padding:"2px 6px"},children:"✕"})' +
    ']})):(0,a.jsx)("div",{style:{fontSize:"12px",color:"rgba(255,255,255,0.35)",paddingTop:"10px"},children:"Tidak ada pengingat aktif"})})' +
  ']}):';

if (!src.includes(tDrBody)) throw new Error('tDrBody not found');
src = src.replace(tDrBody, rDrBody);

fs.writeFileSync(filePath, src, 'utf8');
console.log('Successfully applied all UI updates to 02jdcovrpfbyy.js!');
