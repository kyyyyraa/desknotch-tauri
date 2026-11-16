"""Patch chunk UI DeskNotch r76: tab Calendar/Ask/Files + ukuran compact + DND merah.
Idempotent:_patch yang sudah ada dilewati. node --check tiap langkah.
"""
import subprocess, sys, os

P = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                 "ui", "_next", "static", "chunks", "02jdcovrpfbyy.js")
s = open(P, encoding="utf-8").read()

def check(tag):
    open(P, "w", encoding="utf-8", newline="").write(s)
    r = subprocess.run(["node", "--check", P], capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    if r.returncode != 0:
        errs = [l for l in (r.stderr or "").splitlines() if "Error" in l]
        print("  !! SYNTAX FAIL after", tag, errs[:1]); sys.exit(1)
    print("  OK", tag)

def rep(old, new, tag, count=1):
    global s
    if s.count(new) >= 1:
        print("  SKIP", tag); return
    n = s.count(old)
    assert n == count, (tag, "count=" + str(n))
    s = s.replace(old, new)
    check(tag)

# 1) uS: notifTab keluar dari rail, cal + ask masuk
rep('},{id:"notifTab",label:"Notif",icon:(0,a.jsx)(dnBellIc,{size:12,strokeWidth:2.2})}]',
    '},{id:"cal",label:"Calendar",icon:(0,a.jsx)(dnCalIc,{size:12,strokeWidth:2.2})},'
    '{id:"ask",label:"Ask",icon:(0,a.jsx)(dnAskIc,{size:12,strokeWidth:2.2})}]',
    "1 uS")

# 2) cG (settings -> daftar tab): notifTab keluar, cal masuk
rep('cG=[{id:"glance",label:"Home"},{id:"desk",label:"Focus & tasks"},{id:"files",label:"Files"},'
    '{id:"music",label:"Music"},{id:"notifTab",label:"Notif"}]',
    'cG=[{id:"glance",label:"Home"},{id:"desk",label:"Focus & tasks"},{id:"files",label:"Files"},'
    '{id:"music",label:"Music"},{id:"cal",label:"Calendar"}]',
    "2 cG")

# 3) uA: ukuran tab
rep('uA={desk:{width:dn,height:da},settings:{width:644,height:370},music:{width:620,height:320},'
    'notifTab:{width:430,height:370}}',
    'uA={desk:{width:dn,height:da},settings:{width:644,height:370},music:{width:620,height:320},'
    'notifTab:{width:430,height:260},cal:{width:520,height:250},ask:{width:520,height:190}}',
    "3 uA")

# 4) tbList: notifTab keluar, cal + ask masuk
rep('.concat((Array.isArray(tbViews)?tbViews:[]).some(v=>v.id==="notifTab")?'
    '[{id:"notifTab",label:"Notif",icon:(0,a.jsx)(dnBellIc,{size:12,strokeWidth:2.2})}]:[])',
    '.concat((Array.isArray(tbViews)?tbViews:[]).some(v=>v.id==="cal")?'
    '[{id:"cal",label:"Calendar",icon:(0,a.jsx)(dnCalIc,{size:12,strokeWidth:2.2})}]:[])'
    '.concat((Array.isArray(tbViews)?tbViews:[]).some(v=>v.id==="ask")?'
    '[{id:"ask",label:"Ask",icon:(0,a.jsx)(dnAskIc,{size:12,strokeWidth:2.2})}]:[])',
    "4 tbList")

# 5) definisi ikon cal + ask
rep('dnMusicIcon=sK({name:"music"',
    'dnCalIc=sK({name:"calendar",size:24,node:[["path",{d:"M8 2v4",key:"dnc1"}],["path",{d:"M16 2v4",key:"dnc2"}],'
    '["rect",{width:"18",height:"18",x:"3",y:"4",rx:"2",key:"dnc3"}],["path",{d:"M3 10h18",key:"dnc4"}]]}),'
    'dnAskIc=sK({name:"sparkles",size:24,node:[["path",{d:"M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z",key:"dna1"}],'
    '["path",{d:"M20 3v4",key:"dna2"}],["path",{d:"M22 5h-4",key:"dna3"}],["path",{d:"M4 17v2",key:"dna4"}],["path",{d:"M5 18H2",key:"dna5"}]]}),'
    'dnMusicIcon=sK({name:"music"',
    "5 ikon defs")

# 6) wrapper tab custom (retry kalau global belum siap)
WRAP = (
 'dnCalTab=()=>{const dnCr=(0,s.useRef)(null);(0,s.useEffect)(()=>{let n=0;const g=()=>{const t=dnCr.current;'
 'if(!t)return;if(globalThis.dnCalendar){try{globalThis.dnCalendar.render(t)}catch(e){'
 'window.bridge&&window.bridge.send&&window.bridge.send("dnptt:log","[dntab] cal err: "+((e&&e.message)||e))}}'
 'else if(n++<50){setTimeout(g,80)}};g();'
 'return()=>{try{globalThis.dnCalendar&&globalThis.dnCalendar.unmount()}catch(e){}}},[]);'
 'return(0,a.jsx)("div",{ref:dnCr,style:{height:"100%",minHeight:0}})},'
 'dnAskTab=()=>{const dnAr=(0,s.useRef)(null);(0,s.useEffect)(()=>{let n=0;const g=()=>{const t=dnAr.current;'
 'if(!t)return;if(globalThis.dnAsk){try{globalThis.dnAsk.render(t)}catch(e){'
 'window.bridge&&window.bridge.send&&window.bridge.send("dnptt:log","[dntab] ask err: "+((e&&e.message)||e))}}'
 'else if(n++<50){setTimeout(g,80)}};g();'
 'return()=>{try{globalThis.dnAsk&&globalThis.dnAsk.unmount()}catch(e){}}},[]);'
 'return(0,a.jsx)("div",{ref:dnAr,style:{height:"100%",minHeight:0}})},'
 'dnFilesTab=()=>{const dnFr=(0,s.useRef)(null);(0,s.useEffect)(()=>{let n=0;const g=()=>{const t=dnFr.current;'
 'if(!t)return;if(globalThis.dnFiles){try{globalThis.dnFiles.render(t)}catch(e){'
 'window.bridge&&window.bridge.send&&window.bridge.send("dnptt:log","[dntab] files err: "+((e&&e.message)||e))}}'
 'else if(n++<50){setTimeout(g,80)}};g();'
 'return()=>{try{globalThis.dnFiles&&globalThis.dnFiles.unmount()}catch(e){}}},[]);'
 'return(0,a.jsx)("div",{ref:dnFr,style:{height:"100%",minHeight:0}})},'
)
rep('dnMusicTab=({accent:e})=>{', WRAP + 'dnMusicTab=({accent:e})=>{', "6 wrappers")

# 7) content switch
rep('"music"===h?(0,a.jsx)(dnMusicTab,{accent:eh}):',
    '"music"===h?(0,a.jsx)(dnMusicTab,{accent:eh}):"cal"===h?(0,a.jsx)(dnCalTab,{}):'
    '"ask"===h?(0,a.jsx)(dnAskTab,{}):',
    "7 switch cal/ask")
rep('"files"===h?(0,a.jsx)(dV,{accent:eh,dragging:d,onCount:m})',
    '"files"===h?(0,a.jsx)(dnFilesTab,{})', "7b switch files")
rep('"files"===h?{width:dF(p),height:150}', '"files"===h?{width:560,height:250}', "7c files size")

# 8) hotkey ask + files:drag + Esc ask
rep('window.bridge?.on("hotkey:chat",()=>{clearTimeout(T.current),dnH.current="conversation",'
    'c("conversation"),M(!0)}),[]);',
    'window.bridge?.on("hotkey:chat",()=>{clearTimeout(T.current),dnH.current="conversation",'
    'c("conversation"),M(!0)}),[]);'
    '(0,s.useEffect)(()=>window.bridge?.on("hotkey:ask",()=>{clearTimeout(T.current),dnH.current="ask",'
    'c("ask"),M(!0)}),[]);'
    '(0,s.useEffect)(()=>window.bridge?.on("files:drag",()=>{clearTimeout(T.current),dnH.current="files",'
    'c("files"),M(!0)}),[]);',
    "8 hotkey ask/files:drag")
rep('if("notif"===dnH.current||"done"===dnH.current||"reminder"===dnH.current||"capture"===dnH.current){',
    'if("notif"===dnH.current||"done"===dnH.current||"reminder"===dnH.current||"capture"===dnH.current'
    '||"ask"===dnH.current){',
    "8b Esc ask")

# 9) ask: auto-height + rail disembunyikan
rep('dnAutoH:"notif"===h||"voice"===h||"done"===h||"reminder"===h||"capture"===h||"approval"===h',
    'dnAutoH:"notif"===h||"voice"===h||"done"===h||"reminder"===h||"capture"===h||"approval"===h||"ask"===h',
    "9 dnAutoH ask")
rep('["capture"===h||"done"===h||"reminder"===h||"notif"===h||"approval"===h||"voice"===h?void 0:',
    '["capture"===h||"done"===h||"reminder"===h||"notif"===h||"approval"===h||"voice"===h||"ask"===h?void 0:',
    "9b rail hide ask")

print("ALL CHUNK PATCHES OK")
