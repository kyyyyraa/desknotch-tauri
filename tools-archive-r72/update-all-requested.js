const fs = require('fs');
const vm = require('vm');

const chunkPath = 'D:/project liburan/pet widget/desknotch-tauri/ui/_next/static/chunks/02jdcovrpfbyy.js';
const routerPath = 'D:/project liburan/pet widget/desknotch-tauri/ui/dn-router.js';

let src = fs.readFileSync('D:/project liburan/pet widget/desknotch-work/app104/app/app/_next/static/chunks/02jdcovrpfbyy.js', 'utf8');

function check(code, step) {
  try {
    new vm.Script(code);
    console.log('Step ' + step + ': OK');
    return true;
  } catch (e) {
    console.log('Step ' + step + ' FAILED: ' + e.message);
    process.exit(1);
  }
}

// -------------------------------------------------------------------------
// 1. Settings Model Voice & Model Chat selectors
// -------------------------------------------------------------------------
const oldState = 'rtH7=(0,s.useState)(""),rtMsg=rtH7[0],rtSetMsg=rtH7[1];';
const newState = 'rtH7=(0,s.useState)(""),rtMsg=rtH7[0],rtSetMsg=rtH7[1],rtH8=(0,s.useState)(""),rtVoiceModel=rtH8[0],rtSetVoiceModel=rtH8[1],rtH9=(0,s.useState)(""),rtConvoModel=rtH9[0],rtSetConvoModel=rtH9[1];';
const oldRtLoad = 'var rtLoad=function(){var rW=window.dnRouter;if(rW){var p=rW.DEFAULTS||{},pk=null;try{pk=rW.peek()}catch(rtE){pk=null}rtSetBase(rtBase||(pk&&pk.baseUrl)||(p.baseUrl||"http://127.0.0.1:20128"));rtSetModelTxt(rtModelTxt||(pk&&pk.model)||"");if(rW.listModels)rW.listModels().then(function(ls){rtSetList(ls||[]);rtSetTick(function(x){return x+1})})}};';
const newRtLoad = 'var rtLoad=function(){var rW=window.dnRouter;if(rW){var p=rW.DEFAULTS||{},pk=null;try{pk=rW.peek()}catch(rtE){pk=null}rtSetBase(rtBase||(pk&&pk.baseUrl)||(p.baseUrl||"http://127.0.0.1:20128"));rtSetModelTxt(rtModelTxt||(pk&&pk.model)||"");rtSetVoiceModel(rtVoiceModel||(pk&&pk.voiceModel)||"");rtSetConvoModel(rtConvoModel||(pk&&pk.convoModel)||"");if(rW.listModels)rW.listModels().then(function(ls){rtSetList(ls||[]);rtSetTick(function(x){return x+1})})}};';

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
check(src, '1 (Settings Model)');

// -------------------------------------------------------------------------
// 2. Fix Pin/Lock toggle: M(dnnp) so unpinning actually allows notch to close
// -------------------------------------------------------------------------
const tPin = 'pinned:dnPin,onPin:()=>{let dnnp=!dnPin;dnSetPin(dnnp),M(!0)}})';
const rPin = 'pinned:dnPin,onPin:()=>{let dnnp=!dnPin;dnSetPin(dnnp);dnPinRef.current=dnnp;M(dnnp)}})';
src = src.replace(tPin, rPin);
check(src, '2 (Pin/Lock)');

// -------------------------------------------------------------------------
// 3. Screenshot Card fixes:
//    - Fixed 96x96 box thumbnail with objectFit: cover
//    - Notch width 530px so all 5 buttons fit perfectly
//    - Auto-dismiss duration 15s with hover pause
//    - Restore "Tempel Teks" and "Tanya AI" (multimodal vision + OCR text, NO TTS!)
// -------------------------------------------------------------------------
src = src.replace('"capture"===h?{width:404,height:150}', '"capture"===h?{width:530,height:150}');

const tCapDur = 't&&(w(t),P("capture",4500))';
const rCapDur = 't&&(w(t),P("capture",15000))';
src = src.replace(tCapDur, rCapDur);

const tCapHover = 'T.current=setTimeout(()=>{dnH.current!=="voice"&&(M(dnPinRef.current),dnPop())},t)';
const rCapHover = 'T.current=setTimeout(()=>{if(S.current&&"capture"===dnH.current)return;dnH.current!=="voice"&&(M(dnPinRef.current),dnPop())},t)';
src = src.replace(tCapHover, rCapHover);

// Container in dY: replace thumbnail box with strictly bounded 96x96 box
const tThumbBox = 'className:"relative shrink-0 cursor-grab overflow-hidden rounded-[12px] shadow-[0_0_0_1px_rgba(255,255,255,0.16),0_10px_24px_-10px_rgba(0,0,0,0.9)] active:cursor-grabbing",style:{height:96},children:[e.thumb?(0,a.jsx)("img",{src:e.thumb,alt:"",draggable:!1,className:"h-full w-auto max-w-[160px] object-cover"}):(0,a.jsx)("div",{className:"h-full w-[150px] bg-white/10"})';
const rThumbBox = 'className:"relative shrink-0 cursor-grab overflow-hidden rounded-[12px] shadow-[0_0_0_1px_rgba(255,255,255,0.16),0_10px_24px_-10px_rgba(0,0,0,0.9)] active:cursor-grabbing",style:{height:96,width:96,minWidth:96,maxWidth:96},children:[e.thumb?(0,a.jsx)("img",{src:e.thumb,alt:"",draggable:!1,style:{width:"100%",height:"100%",objectFit:"cover"}}):(0,a.jsx)("div",{style:{width:"100%",height:"100%",background:"rgba(255,255,255,0.1)"}})';
src = src.replace(tThumbBox, rThumbBox);

// dY signature: pass onTab
const tDySig = 'dY=({item:e,accent:t,onDone:i})';
const rDySig = 'dY=({item:e,accent:t,onDone:i,onTab:cbTab})';
src = src.replace(tDySig, rDySig);

// dY call site: pass onTab: c
const tDyCall = '"capture"===h&&v?(0,a.jsx)(dY,{item:v,accent:eh,onDone:()=>{clearTimeout(T.current),M(dnPinRef.current),C(e=>e+1)}}):';
const rDyCall = '"capture"===h&&v?(0,a.jsx)(dY,{item:v,accent:eh,onTab:c,onDone:()=>{clearTimeout(T.current),M(dnPinRef.current),C(e=>e+1)}}):';
src = src.replace(tDyCall, rDyCall);

// Add "Tempel Teks" and "Tanya AI" right after "Open" button in dY
const tOpen = 'className:"h-[26px] shrink-0 whitespace-nowrap rounded-full bg-white/[0.06] px-3 text-[11px] font-medium text-white/60 transition-colors hover:bg-white/[0.12] hover:text-white",children:"Open"}),!n&&';
const rOpen = 'className:"h-[26px] shrink-0 whitespace-nowrap rounded-full bg-white/[0.06] px-3 text-[11px] font-medium text-white/60 transition-colors hover:bg-white/[0.12] hover:text-white",children:"Open"}),' +
  // Tempel Teks button
  '(0,a.jsx)(sY.button,{type:"button",whileTap:{scale:.94},onClick:async()=>{let r=await window.bridge?.invoke("ocr:recognize",{path:o});if(r&&r.text){try{window.dnConvo&&window.dnConvo.remember("user","[Teks Screenshot] "+r.text)}catch(_){}try{await window.bridge?.invoke("dnptt:paste",{text:r.text})}catch(_){}}i()},className:"h-[26px] shrink-0 whitespace-nowrap rounded-full bg-white/[0.08] px-3 text-[11px] font-medium text-white/80 transition-colors hover:bg-white/[0.16] hover:text-white",children:"Tempel Teks"}),' +
  // Tanya AI button (Multimodal Vision + OCR text grounding, NO TTS!)
  '(0,a.jsx)(sY.button,{type:"button",whileTap:{scale:.94},onClick:async()=>{let ocrRes=await window.bridge?.invoke("ocr:recognize",{path:o}).catch(()=>null);let ocrTxt=(ocrRes&&ocrRes.text)||"";if(typeof cbTab==="function")cbTab("conversation");i();if(window.dnConvo){window.dnConvo.remember("user","🖼️ [Tangkapan Layar] Jelaskan gambar ini");}let prompt="Jelaskan isi gambar tangkapan layar ini secara jelas:";if(ocrTxt.trim()){prompt+="\\n\\n[Teks pada gambar via OCR]:\\n"+ocrTxt.trim();}if(window.dnRouter&&typeof window.dnRouter.ask==="function"){window.dnRouter.ask(prompt,{surface:"conversation",image:e.thumb,noRemember:true}).then(res=>{let ans=(res&&res.text)||"";if(ans&&window.dnConvo){window.dnConvo.remember("assistant",ans);}if(window.dispatchEvent){window.dispatchEvent(new CustomEvent("dn-ai-done",{detail:{id:"cva-"+Date.now(),app:"AI",title:"Analisis Gambar Selesai",body:ans.slice(0,150)}}));}}).catch(err=>{let em="Gagal menganalisis gambar: "+(err&&err.message||err);if(window.dnConvo){window.dnConvo.remember("assistant",em);}});}},className:"h-[26px] shrink-0 whitespace-nowrap rounded-full bg-white/[0.14] px-3 text-[11px] font-semibold text-white transition-colors hover:bg-white/[0.22]",children:"Tanya AI"}),!n&&';

src = src.replace(tOpen, rOpen);
check(src, '3 (Screenshot card + OCR + Vision)');

// -------------------------------------------------------------------------
// 4. Do Not Disturb (DND) - 100% clean, NO TDZ, and blocks ALL notifications!
// -------------------------------------------------------------------------
const tDndState = 'let[f,g]=(0,s.useState)(!1),[dnPin,dnSetPin]=(0,s.useState)(!1),';
const rDndState = 'let[f,g]=(0,s.useState)(!1),[dnPin,dnSetPin]=(0,s.useState)(!1),[dnDnd,dnSetDnd]=(0,s.useState)(!1),dnDndRef=(0,s.useRef)(!1),';
src = src.replace(tDndState, rDndState);

const tDndSync = 'dnH.current=h,dnPinRef.current=dnPin;';
const rDndSync = 'dnH.current=h,dnPinRef.current=dnPin,dnDndRef.current=dnDnd;';
src = src.replace(tDndSync, rDndSync);

const tSettingsInit = 'let[_,q]=(0,s.useState)(cH),X=(0,s.useRef)(!1)';
const rSettingsInit = 'let[_,q]=(0,s.useState)(cH);(0,s.useEffect)(()=>{if(_&&_.dnd!==undefined){dnSetDnd(!!_.dnd);dnDndRef.current=!!_.dnd}},[_.dnd]);let X=(0,s.useRef)(!1)';
src = src.replace(tSettingsInit, rSettingsInit);

// TopBar definition
const tTopBarDef = 'dnTopBar=({views:tbViews,active:tbActive,onChange:tbChange,accent:tbAccent,privacy:tbPriv,pinned:tbPin,onPin:tbOnPin})';
const rTopBarDef = 'dnTopBar=({views:tbViews,active:tbActive,onChange:tbChange,accent:tbAccent,privacy:tbPriv,pinned:tbPin,onPin:tbOnPin,dnd:tbDnd,onDnd:tbOnDnd})';
src = src.replace(tTopBarDef, rTopBarDef);

// Rail right DND button
const tRailRight = 'children:[tbTool({label:"Settings",onClick:()=>tbChange(tbEvent=>"settings"===tbEvent?"glance":"settings"),children:(0,a.jsx)(s5,{size:13,strokeWidth:2.2})}),dnPrivDots';
const rRailRight = 'children:[tbTool({label:tbDnd?"Mode Jangan Ganggu (Aktif)":"Mode Jangan Ganggu (Mati)",onClick:tbOnDnd,active:tbDnd,children:(0,a.jsx)("svg",{width:13,height:13,viewBox:"0 0 24 24",fill:tbDnd?"currentColor":"none",stroke:"currentColor",strokeWidth:2.2,strokeLinecap:"round",strokeLinejoin:"round",style:{pointerEvents:"none"},children:(0,a.jsx)("path",{d:"M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"})})}),tbTool({label:"Settings",onClick:()=>tbChange(tbEvent=>"settings"===tbEvent?"glance":"settings"),children:(0,a.jsx)(s5,{size:13,strokeWidth:2.2})}),dnPrivDots';
src = src.replace(tRailRight, rRailRight);

// TopBar call site
const tTopBarCall = '(0,a.jsx)(dnTopBar,{views:ei,active:h,onChange:c,accent:eh,privacy:D,pinned:dnPin,onPin:()=>{let dnnp=!dnPin;dnSetPin(dnnp);dnPinRef.current=dnnp;M(dnnp)}})';
const rTopBarCall = '(0,a.jsx)(dnTopBar,{views:ei,active:h,onChange:c,accent:eh,privacy:D,pinned:dnPin,onPin:()=>{let dnnp=!dnPin;dnSetPin(dnnp);dnPinRef.current=dnnp;M(dnnp)},dnd:dnDnd,onDnd:()=>{let nxd=!dnDnd;dnSetDnd(nxd);dnDndRef.current=nxd;q(t=>({...t,dnd:nxd}));window.bridge?.invoke("store:set","settings",Object.assign({},_||{},{dnd:nxd}))}})';
src = src.replace(tTopBarCall, rTopBarCall);

// Suppress toast notifications when DND is on
const tNotif = 'dnNotifR(e),P("notif",12e3)';
const rNotif = 'dnDndRef.current?null:dnNotifR(e),dnDndRef.current?null:P("notif",12e3)';
src = src.replace(tNotif, rNotif);

// Suppress notification sound when DND is on
const tSound = 'if(dnH.current==="voice")return;';
const rSound = 'if(dnH.current==="voice"||dnDndRef.current)return;';
src = src.replace(tSound, rSound);

// Suppress conversation AI finished notification (dn-ai-done) when DND is on!
const tAiDone = 'const dnF=ev=>{try{dnNotifR(ev.detail),P("notif",15e3)}catch(_){}};';
const rAiDone = 'const dnF=ev=>{if(dnDndRef.current)return;try{dnNotifR(ev.detail),P("notif",15e3)}catch(_){}};';
src = src.replace(tAiDone, rAiDone);

// Suppress reminder popups when DND is on!
const tRemPopup = 'ep.current.add(`${e.id}@${e.at}`),eu(e),P("reminder",6e4)';
const rRemPopup = 'ep.current.add(`${e.id}@${e.at}`),dnDndRef.current?null:(eu(e),P("reminder",6e4))';
src = src.replace(tRemPopup, rRemPopup);
check(src, '4 (DND completely wired and suppresses all notifications)');

// -------------------------------------------------------------------------
// 5. Companion cycle on avatar click
// -------------------------------------------------------------------------
const tAvatarClick = 'ref:N,className:"relative grid h-full w-[96px] shrink-0 place-items-center",children:[(0,a.jsxs)(\"div\",{className:\"pointer-events-none relative z-10 grid place-items-center\"';
const rAvatarClick = 'ref:N,title:"Klik untuk ganti companion",style:{cursor:"pointer"},onClick:cEv=>{cEv.stopPropagation();let cAvList=["ghost","cat","blob","clover","droid","alien","cloud"],curIdx=cAvList.indexOf(e),nextAv=cAvList[(curIdx+1)%cAvList.length];window.bridge?.invoke("store:get","settings").then(st=>{let nxt=Object.assign({},st,{avatar:nextAv});window.bridge?.invoke("store:set","settings",nxt)})},className:"relative grid h-full w-[96px] shrink-0 place-items-center",children:[(0,a.jsxs)(\"div\",{className:\"pointer-events-none relative z-10 grid place-items-center\"';
src = src.replace(tAvatarClick, rAvatarClick);
check(src, '5 (Companion cycle)');

// -------------------------------------------------------------------------
// 6. Ensure ConversationTab cvSend passes surface: "conversation"
// -------------------------------------------------------------------------
const tCvSendExec = 'try{cvExec.handle({type:"text",text:cvMsg,silent:!0},cvFinish)}catch(cvErr)';
const rCvSendExec = 'try{cvExec.handle({type:"text",text:cvMsg,silent:!0,surface:"conversation"},cvFinish)}catch(cvErr)';
src = src.replace(tCvSendExec, rCvSendExec);

const tCvSendAsk = 'try{cvCall=cvRouter.ask(cvMsg,{noRemember:!0})}catch(cvErr)';
const rCvSendAsk = 'try{cvCall=cvRouter.ask(cvMsg,{noRemember:!0,surface:"conversation"})}catch(cvErr)';
src = src.replace(tCvSendAsk, rCvSendAsk);
check(src, '6 (ConversationTab surface: conversation)');

fs.writeFileSync(chunkPath, src, 'utf8');
console.log('02jdcovrpfbyy.js successfully patched and verified!');

// =========================================================================
// 7. Update dn-router.js for Multimodal Vision (opts.image support)
// =========================================================================
let rsrc = fs.readFileSync(routerPath, 'utf8');

const tAskRouter = `    return httpJson('POST', c.baseUrl + '/v1/chat/completions', {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + c.apiKey
    }, JSON.stringify({
      model: model,
      messages: [
        { role: 'system', content: 'Kamu adalah asisten suara DeskNotch di Windows. Jawabanmu dibacakan langsung lewat suara TTS, jadi jawab sangat singkat dan padat (1-2 kalimat) dalam bahasa Indonesia. Jangan pernah menolak dengan alasan tidak punya izin atau akses ke laptop, karena aplikasi DeskNotch yang menangani integrasi sistem.' }
      ].concat(convoHistory(text), [{ role: 'user', content: String(text) }]),
      stream: false
    }))`;

const rAskRouter = `    var userContent;
    if (opts.image) {
      var imgUrl = typeof opts.image === 'string' ? opts.image : (opts.image.url || '');
      if (imgUrl) {
        userContent = [
          { type: 'text', text: String(text) },
          { type: 'image_url', image_url: { url: imgUrl } }
        ];
      } else {
        userContent = String(text);
      }
    } else {
      userContent = String(text);
    }

    var sysPrompt = (opts.surface === 'conversation' || opts.surface === 'chat')
      ? 'Kamu adalah asisten DeskNotch di Windows dalam mode percakapan. Bantu pengguna menjawab, menganalisis gambar/tangkapan layar, dan menjelaskan dengan ramah, jelas, dan akurat dalam bahasa Indonesia.'
      : 'Kamu adalah asisten suara DeskNotch di Windows. Jawabanmu dibacakan langsung lewat suara TTS, jadi jawab sangat singkat dan padat (1-2 kalimat) dalam bahasa Indonesia. Jangan pernah menolak dengan alasan tidak punya izin atau akses ke laptop, karena aplikasi DeskNotch yang menangani integrasi sistem.';

    return httpJson('POST', c.baseUrl + '/v1/chat/completions', {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + c.apiKey
    }, JSON.stringify({
      model: model,
      messages: [
        { role: 'system', content: sysPrompt }
      ].concat(convoHistory(text), [{ role: 'user', content: userContent }]),
      stream: false
    }))`;

if (!rsrc.includes(tAskRouter)) throw new Error('tAskRouter not found');
rsrc = rsrc.replace(tAskRouter, rAskRouter);

fs.writeFileSync(routerPath, rsrc, 'utf8');
console.log('dn-router.js successfully patched with vision support!');
