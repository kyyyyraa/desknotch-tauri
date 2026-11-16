p = 'ui/dn-files.js'
s = open(p, encoding='utf-8').read()

def rep(old, new, tag):
    global s
    n = s.count(old)
    assert n == 1, (tag, n)
    s = s.replace(old, new)
    print('OK', tag)

# --- CSS kartu: tanpa border, thumbnail full-bleed, badge waktu pojok kiri atas
rep('      ".dn-fl-card{position:relative;flex:0 0 auto;width:104px;border-radius:12px;background:rgba(255,255,255,0.07);padding:6px;cursor:pointer;transition:background .15s}",',
    '      ".dn-fl-card{position:relative;flex:0 0 auto;width:108px;height:84px;border-radius:12px;background:rgba(255,255,255,0.07);padding:6px;cursor:pointer;overflow:hidden;transition:background .15s}",', 'card box')
rep('      ".dn-fl-thumb{width:100%;height:58px;border-radius:8px;background:rgba(255,255,255,0.06);background-size:cover;background-position:center;display:grid;place-items:center;font-size:20px;color:rgba(255,255,255,0.55);overflow:hidden}",',
    '      ".dn-fl-thumb{width:100%;height:100%;border-radius:8px;background:rgba(255,255,255,0.06);background-size:cover;background-position:center;display:grid;place-items:center;font-size:22px;color:rgba(255,255,255,0.55);overflow:hidden}",'
    '      ".dn-fl-thumb.full{position:absolute;inset:0;border-radius:0}",'
    '      ".dn-fl-time{position:absolute;top:5px;left:6px;font-size:8.5px;font-weight:600;color:rgba(255,255,255,0.75);text-shadow:0 1px 2px rgba(0,0,0,0.5);z-index:2}",'
    '      ".dn-fl-dim{position:absolute;bottom:5px;left:6px;font-size:8px;font-weight:600;color:#fff;background:rgba(0,0,0,0.45);padding:1px 5px;border-radius:9999px;z-index:2}",', 'thumb css')
rep('      ".dn-fl-title{font-size:9.5px;font-weight:600;color:rgba(255,255,255,0.92);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:5px}",',
    '      ".dn-fl-title{font-size:10px;font-weight:700;color:rgba(255,255,255,0.94);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",', 'title css')
rep('      ".dn-fl-sub{font-size:8.5px;color:rgba(255,255,255,0.4);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",',
    '      ".dn-fl-sub{font-size:9px;color:rgba(255,255,255,0.45);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:1px}",', 'sub css')

# --- kartu clipboard: teks/link (tanpa ikon) vs gambar (full-bleed) ---
old_clip = '''    const preview = isImg
      ? '<div class="dn-fl-thumb" style="background-image:url(&quot;' + item.image + '&quot;)"></div>'
      : '<div class="dn-fl-thumb">' + (isLink ? "&#128279;" : "&#128203;") + "</div>";
    const raw = String(item.text || "");
    const title = isImg ? "Gambar" : raw.slice(0, 60).replace(/\s+/g, " ");
    const sub = isImg ? relTime(item.at) : raw.slice(0, 120).replace(/\s+/g, " ");
    const card = cardShell(
      preview +
        '<div class="dn-fl-title">' + esc2(title) + "</div>" +
        '<div class="dn-fl-sub">' + esc2(sub) + "</div>",
      isImg ? "IMG" : ""
    );'''
new_clip = '''    const raw = String(item.text || "");
    const time = relTime(item.at);
    const card = cardShell(
      isImg
        ? '<div class="dn-fl-thumb full" style="background-image:url(&quot;' + item.image + '&quot;)"></div>' +
          '<div class="dn-fl-time">' + esc2(time) + "</div>"
        : '<div class="dn-fl-time">' + esc2(time) + "</div>" +
          '<div style="position:absolute;left:6px;right:6px;bottom:6px">' +
          '<div class="dn-fl-title">' + esc2(raw.slice(0, 60).replace(/\s+/g, " ")) + "</div>" +
          '<div class="dn-fl-sub">' + esc2(raw.slice(0, 120).replace(/\s+/g, " ")) + "</div></div>",
      ""
    );'''
rep(old_clip, new_clip, 'clip card')

# --- kartu file: gambar full-bleed / pdf icon + nama ---
old_file = '''    const thumb = item.thumb
      ? '<div class="dn-fl-thumb" style="background-image:url(&quot;' + item.thumb + '&quot;)"></div>'
      : '<div class="dn-fl-thumb">' +
        (item.isDir ? "&#128193;" : t === "image" ? "&#128444;" : t === "text" ? "T" : "&#128196;") +
        "</div>";
    const card = cardShell(
      thumb +
        '<div class="dn-fl-title">' + esc2(item.name || "") + "</div>" +
        '<div class="dn-fl-sub">' + esc2(String(item.path || "")) + "</div>",
      t === "image" ? "IMG" : t === "text" ? "TXT" : t === "file" ? "DOC" : ""
    );'''
new_file = '''    const time = relTime(item.at || Date.now());
    const isImg = !!item.thumb || t === "image";
    const card = cardShell(
      isImg
        ? '<div class="dn-fl-thumb full" style="background-image:url(&quot;' + (item.thumb || "") + '&quot;)"></div>' +
          '<div class="dn-fl-time">' + esc2(time) + "</div>"
        : '<div class="dn-fl-thumb" style="position:absolute;inset:6px 6px 22px;height:auto">' +
          (item.isDir ? "&#128193;" : t === "text" ? "T" : "&#128196;") + "</div>" +
          '<div class="dn-fl-time">' + esc2(time) + "</div>" +
          '<div style="position:absolute;left:6px;right:6px;bottom:6px">' +
          '<div class="dn-fl-title">' + esc2(item.name || "") + "</div>" +
          '<div class="dn-fl-sub">' + esc2(String(item.path || "")) + "</div></div>",
      ""
    );'''
rep(old_file, new_file, 'file card')

open(p, 'w', encoding='utf-8', newline='').write(s)
print('dn-files patched OK')
