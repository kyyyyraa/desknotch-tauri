import sys

CH = "ui/_next/static/chunks/02jdcovrpfbyy.js"
s = open(CH, encoding="utf-8").read()

def rep(old, new, label):
    global s
    n = s.count(old)
    if n != 1:
        print(f"[FAIL] {label}: count={n}"); sys.exit(1)
    s = s.replace(old, new)
    print(f"[OK] {label}")

# P1: tbList — Music SEBELAH KANAN conversation (hormati hiddenViews via tbViews)
rep('let tbList=(Array.isArray(tbViews)?tbViews:[]).slice(0,3).concat([{id:"conversation",label:"Conversation",icon:(0,a.jsx)(dnChat,{size:13,strokeWidth:2.2})}]),',
    'let tbList=(Array.isArray(tbViews)?tbViews:[]).slice(0,3).concat([{id:"conversation",label:"Conversation",icon:(0,a.jsx)(dnChat,{size:13,strokeWidth:2.2})}]'
    '.concat((Array.isArray(tbViews)?tbViews:[]).some(v=>v.id==="music")?[{id:"music",label:"Music",icon:(0,a.jsx)(dnMusicIcon,{size:12,strokeWidth:2.2})}]:[])),',
    "P1 tbList += music after conversation")

# P2: shell component — state untuk re-render saat lirik berubah
rep('V=(0,s.useRef)(null);(0,s.useEffect)(()=>{let e=()=>{if(!P.current)return;',
    'V=(0,s.useRef)(null),[,dnLyWf]=(0,s.useState)(0);'
    '(0,s.useEffect)(()=>{const dnLyF=()=>dnLyWf(e=>e+1);'
    'window.addEventListener("dnlyr:state",dnLyF);'
    'return()=>window.removeEventListener("dnlyr:state",dnLyF)},[]);'
    '(0,s.useEffect)(()=>{let e=()=>{if(!P.current)return;',
    "P2 shell hook dnlyr:state")

# P3: lebar notch tertutup mengikuti lirik
rep('animate:{width:M?i:240',
    'animate:{width:M?i:(globalThis.dnLyrics?globalThis.dnLyrics.shellW(240):240)',
    "P3 shell width -> dnLyrics.shellW")

# P4: revert h0 (pill kanan digantikan layer tengah)
rep('"time"===e?(0,a.jsx)(dnLyricPill,{timeOnLeft:i}):',
    '"time"===e?!i&&(0,a.jsx)(hJ,{}):',
    "P4 revert h0")

# P5: ganti def dnLyricPill -> dnLyricMid + dnLyricStrip
OLD_PILL = ('dnLyricPill=({timeOnLeft:e})=>{const[t,x]=(0,s.useState)(!1);'
    '(0,s.useEffect)(()=>{const f=()=>x(!!(globalThis.dnLyrics&&globalThis.dnLyrics.pillActive()));'
    'window.addEventListener("dnlyr:state",f),f();'
    'return()=>window.removeEventListener("dnlyr:state",f)},[]);'
    'return t?(0,a.jsx)("div",{id:"dn-lyr-pill",className:"min-w-0 max-w-[240px] overflow-hidden '
    'whitespace-nowrap text-[10.5px] font-medium leading-none text-white/75 cursor-pointer",'
    'onClick:()=>{globalThis.dnOpenTab&&globalThis.dnOpenTab("music")}}):e?null:(0,a.jsx)(hJ,{})},')
NEW_DEFS = ('dnLyricMid=()=>{const[t,x]=(0,s.useState)(!1);'
    '(0,s.useEffect)(()=>{const f=()=>x(!!(globalThis.dnLyrics&&globalThis.dnLyrics.midActive()));'
    'window.addEventListener("dnlyr:state",f),f();'
    'return()=>window.removeEventListener("dnlyr:state",f)},[]);'
    'return t?(0,a.jsx)("div",{className:"absolute inset-0 z-10 flex items-center justify-center pointer-events-none",'
    'children:(0,a.jsx)("div",{id:"dn-lyr-mid",className:"min-w-0 max-w-[540px] truncate px-2 text-[10.5px] font-medium leading-none text-white/80"})}):null},'
    'dnLyricStrip=()=>{const[t,x]=(0,s.useState)(!1);'
    '(0,s.useEffect)(()=>{const f=()=>x(!!(globalThis.dnLyrics&&globalThis.dnLyrics.midActive()));'
    'window.addEventListener("dnlyr:state",f),f();'
    'return()=>window.removeEventListener("dnlyr:state",f)},[]);'
    'return t?null:(0,a.jsx)(h_,{})},')
rep(OLD_PILL, NEW_DEFS, "P5 defs dnLyricMid+dnLyricStrip")

# P6: layer tengah dirender di h1 (strip tertutup)
rep('(0,a.jsx)(h0,{right:s,screenMs:r,timeOnLeft:p,limits:o,privacy:l,battery:h})]})',
    '(0,a.jsx)(h0,{right:s,screenMs:r,timeOnLeft:p,limits:o,privacy:l,battery:h}),(0,a.jsx)(dnLyricMid,{})]})',
    "P6 h1 += dnLyricMid")

# P7: EQ diganti dnLyricStrip (sembunyi saat lirik aktif)
rep('(0,a.jsx)(h_,{})]},"playing")}', '(0,a.jsx)(dnLyricStrip,{})]},"playing")}', "P7 h_ -> dnLyricStrip")

# P8: ukuran tab music lebih lega
rep('music:{width:560,height:370}', 'music:{width:620,height:320}', "P8 uA music 620x320")

# P9: kartu musik Home — tombol bubble kiri (buka tab Music)
rep('(0,a.jsx)("div",{className:"-mb-1 mt-1.5 flex justify-center",children:(0,a.jsx)(d9,{isPlaying:e.isPlaying,onPrevious:()=>void window.bridge?.invoke("media:key","previous"),onPlayPause:()=>void window.bridge?.invoke("media:key","play-pause"),onNext:()=>void window.bridge?.invoke("media:key","next")})})',
    '(0,a.jsxs)("div",{className:"-mb-1 mt-1.5 relative flex items-center justify-center",children:['
    '(0,a.jsx)("button",{type:"button","aria-label":"Lirik",title:"Tampilkan lirik",'
    'onClick:t=>{t.stopPropagation(),globalThis.dnOpenTab&&globalThis.dnOpenTab("music")},'
    'className:"absolute left-1.5 top-1/2 -translate-y-1/2 grid h-[24px] w-[24px] place-items-center '
    'rounded-full bg-white/[0.08] text-white/70 hover:bg-white/[0.16] hover:text-white transition-colors",'
    'children:(0,a.jsx)(dnChat,{size:12,strokeWidth:2})}),'
    '(0,a.jsx)(d9,{isPlaying:e.isPlaying,onPrevious:()=>void window.bridge?.invoke("media:key","previous"),'
    'onPlayPause:()=>void window.bridge?.invoke("media:key","play-pause"),'
    'onNext:()=>void window.bridge?.invoke("media:key","next")})]})',
    "P9 Home music card bubble")

open(CH, "w", encoding="utf-8", newline="").write(s)
print("ALL v2 PATCHES APPLIED")
