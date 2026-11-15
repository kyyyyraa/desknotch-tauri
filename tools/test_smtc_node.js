const { SMTCMonitor } = require("D:/project liburan/pet widget/desknotch-work/app104/app/node_modules/@coooookies/windows-smtc-monitor");
console.log("SMTCMonitor class loaded!");
try {
  const all = SMTCMonitor.getMediaSessions();
  console.log("getMediaSessions count:", all ? all.length : 0);
  if (all) {
    all.forEach((s, idx) => {
      console.log(`[${idx}] AppId: ${s.sourceAppId}, Title: ${s.media && s.media.title}, Playing: ${s.playback && s.playback.playbackStatus}`);
    });
  }
} catch (e) {
  console.error("getMediaSessions error:", e);
}

try {
  const cur = SMTCMonitor.getCurrentMediaSession();
  console.log("getCurrentMediaSession:", cur ? cur.sourceAppId : null);
} catch (e) {
  console.error("getCurrentMediaSession error:", e);
}
process.exit(0);
