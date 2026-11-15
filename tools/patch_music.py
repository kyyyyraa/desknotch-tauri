import sys, shutil

CH = "ui/_next/static/chunks/02jdcovrpfbyy.js"
s = open(CH, encoding="utf-8").read()
orig = s

def rep(old, new, label):
    global s
    n = s.count(old)
    if n != 1:
        print(f"[FAIL] {label}: count={n}"); sys.exit(1)
    s = s.replace(old, new)
    print(f"[OK] {label}")

# R1 uS += music entry
rep('icon:(0,a.jsx)(sZ,{size:12,strokeWidth:2.2})}]',
    'icon:(0,a.jsx)(sZ,{size:12,strokeWidth:2.2})},{id:"music",label:"Music",icon:(0,a.jsx)(dnMusicIcon,{size:12,strokeWidth:2.2})}]',
    "R1 uS+=music")

# R2 uA += music size
rep('uA={desk:{width:dn,height:da},settings:{width:644,height:370}}',
    'uA={desk:{width:dn,height:da},settings:{width:644,height:370},music:{width:560,height:370}}',
    "R2 uA+=music size")

# R3 content switch: music -> dnMusicTab
rep('desktimeInstalled:Z.installed}):(0,a.jsx)(dl,{',
    'desktimeInstalled:Z.installed}):"music"===h?(0,a.jsx)(dnMusicTab,{accent:eh}):(0,a.jsx)(dl,{',
    "R3 content switch")

# R4 component defs (icon + dnMusicTab + dnLyricPill) sebelum dnVoiceView
DEFS = ('dnMusicIcon=sK({name:"music",size:24,node:[["path",{d:"M9 18V5l12-2v13",key:"dnm1"}],'
        '["circle",{cx:"6",cy:"18",r:"3",key:"dnm2"}],["circle",{cx:"18",cy:"16",r:"3",key:"dnm3"}]]}),'
        'dnMusicTab=({accent:e})=>{const dnMr=(0,s.useRef)(null);'
        '(0,s.useEffect)(()=>{const t=dnMr.current;t&&globalThis.dnLyrics&&globalThis.dnLyrics.render(t,e);'
        'return()=>{globalThis.dnLyrics&&globalThis.dnLyrics.unmount()}},[e]);'
        'return(0,a.jsx)("div",{ref:dnMr,style:{height:"100%",minHeight:0}})},'
        'dnLyricPill=({timeOnLeft:e})=>{const[t,x]=(0,s.useState)(!1);'
        '(0,s.useEffect)(()=>{const f=()=>x(!!(globalThis.dnLyrics&&globalThis.dnLyrics.pillActive()));'
        'window.addEventListener("dnlyr:state",f),f();'
        'return()=>window.removeEventListener("dnlyr:state",f)},[]);'
        'return t?(0,a.jsx)("div",{id:"dn-lyr-pill",className:"min-w-0 max-w-[240px] overflow-hidden '
        'whitespace-nowrap text-[10.5px] font-medium leading-none text-white/75 cursor-pointer",'
        'onClick:()=>{globalThis.dnOpenTab&&globalThis.dnOpenTab("music")}}):e?null:(0,a.jsx)(hJ,{})},'
        )
rep('dnVoiceView=({privacy:vpv})=>{', DEFS + 'dnVoiceView=({privacy:vpv})=>{', "R4 defs insert")

# R5 h0 time branch -> dnLyricPill
rep('"time"===e?!i&&(0,a.jsx)(hJ,{}):',
    '"time"===e?(0,a.jsx)(dnLyricPill,{timeOnLeft:i}):',
    "R5 h0 pill")

# R6 cH default lyricsOnClosed
rep('cH={showMusic:!0,', 'cH={showMusic:!0,lyricsOnClosed:!0,', "R6 cH default")

# R7 settings toggle di section "closed"
rep('disabledTitle:"Needs ScreenWise installed"})}),!n&&',
    'disabledTitle:"Needs ScreenWise installed"})}),'
    '(0,a.jsx)(c1,{title:"Lyrics on closed notch",detail:"Current lyric line replaces the clock while music plays",'
    'children:(0,a.jsx)(cQ,{label:"Lyrics when music plays",on:e.lyricsOnClosed!==!1,onChange:e=>r("lyricsOnClosed",e)})}),!n&&',
    "R7 settings toggle")

# R8 dnOpenTab registration
rep('[h,c]=(0,s.useState)("glance"),',
    '[h,c]=(0,s.useState)("glance"),dnOpenTabReg=globalThis.dnOpenTab=c,',
    "R8 dnOpenTab")

# index.html: load dn-lyrics.js
IH = "ui/index.html"
h = open(IH, encoding="utf-8").read()
if 'dn-lyrics.js' not in h:
    if h.count('<script src="/dn-extras.js" defer=""></script>') != 1:
        print("[FAIL] index.html anchor"); sys.exit(1)
    h = h.replace('<script src="/dn-extras.js" defer=""></script>',
                  '<script src="/dn-lyrics.js" defer=""></script><script src="/dn-extras.js" defer=""></script>')
    open(IH, "w", encoding="utf-8", newline="").write(h)
    print("[OK] index.html script tag")
else:
    print("[SKIP] index.html already patched")

# backup sekali sebelum menulis pertama kali
if s != orig:
    open(CH, "w", encoding="utf-8", newline="").write(s)
    print("[WROTE] chunk")
print("ALL PATCHES APPLIED")
