// r72l: stop the "mic keeps recording after Esc" race (async getUserMedia).
const fs = require('fs');
const path = require('path');
const UI = path.join(__dirname, '..', 'ui');
let fail = 0;

function rep(name, from, to, file) {
  const p = path.join(UI, file);
  if (!fs.existsSync(p)) { console.error('MISSING FILE ' + file); fail = 1; return; }
  let src = fs.readFileSync(p, 'utf8');
  if (!src.includes(from)) { console.error('NOT FOUND [' + name + ']'); fail = 1; return; }
  src = src.split(from).join(to);
  fs.writeFileSync(p, src, 'utf8');
  console.log('OK [' + name + ']');
}

rep('whisper: state vars',
  '  var mediaStream = null;\n  var audioCtx = null;',
  '  var mediaStream = null;\n  var audioCtx = null;\n  // Mic acquisition is async. Every request carries an epoch; when it\n  // resolves we check the epoch again — an abort in between means nobody\n  // wants this stream any more, so it is stopped instead of kept alive.\n  var micEpoch = 0;\n  var wantMic = false;\n  var micWatchdog = null;',
  'dn-whisper.js');

rep('whisper: startRecording guard',
  `    chunks = [];
    recordedSamples = 0;
    peak = 0;
    sumSq = 0;
    nativeRate = 0;

    return navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    }).then(function (stream) {
      mediaStream = stream;`,
  `    chunks = [];
    recordedSamples = 0;
    peak = 0;
    sumSq = 0;
    nativeRate = 0;

    wantMic = true;
    var myEpoch = ++micEpoch;
    startMicWatchdog();

    return navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    }).then(function (stream) {
      // An abort (Esc / Ctrl+Alt+V) landed while the mic was being opened:
      // stop the tracks immediately instead of leaving the device live.
      if (myEpoch !== micEpoch || !wantMic) {
        try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (_) {}
        return null;
      }
      mediaStream = stream;`,
  'dn-whisper.js');

rep('whisper: releaseMic stops + invalidates',
  `      if (mediaStream) {
        try {
          mediaStream.getTracks().forEach(function (t) { t.stop(); });
        } catch (_) {}
      }`,
  `      if (mediaStream) {
        try {
          mediaStream.getTracks().forEach(function (t) { t.stop(); });
        } catch (_) {}
      }
      mediaStream = null;
      wantMic = false;
      micEpoch++;`,
  'dn-whisper.js');

rep('whisper: stopRecording invalidates epoch',
  `  function stopRecording() {
    // Give the audio thread one turn to deliver the last buffer before we tear
    // the graph down; otherwise the final ~256 ms can be lost.
    return new Promise(function (resolve) {`,
  `  function stopRecording() {
    // Nobody wants the mic any more: invalidate any acquisition still in
    // flight and let the watchdog close a stream that slipped through.
    wantMic = false;
    micEpoch++;
    // Give the audio thread one turn to deliver the last buffer before we tear
    // the graph down; otherwise the final ~256 ms can be lost.
    return new Promise(function (resolve) {`,
  'dn-whisper.js');

rep('whisper: watchdog helper',
  '  function stopRecording() {',
  `  // Safety net: a stream that is open while nobody asked for one is a leak.
  // This closes it within ~1.5 s no matter which path opened it.
  function startMicWatchdog() {
    if (micWatchdog) return;
    try {
      micWatchdog = setInterval(function () {
        if (!mediaStream) return;
        if (wantMic) return;
        try { releaseMic(); } catch (_) {}
      }, 1500);
    } catch (_) {}
  }

  function stopRecording() {`,
  'dn-whisper.js');

rep('ptt: vad epoch state',
  '  function releaseVad() {',
  `  // Same race as the whisper mic: the VAD stream is opened asynchronously, so
  // an abort during the request would leave it open forever. The epoch tells
  // the pending request that its result is no longer wanted.
  var vadEpoch = 0;

  function releaseVad() {
    vadEpoch++;`,
  'dn-voice-ptt.js');

rep('ptt: vad acquire guard',
  `    }).then(function (stream) {
      vadStream = stream;`,
  `    }).then(function (stream) {
      // The session ended while the mic was being opened — close it now.
      if (state !== 'listening' && state !== 'recording') {
        try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (_) {}
        return;
      }
      vadStream = stream;`,
  'dn-voice-ptt.js');

if (fail) process.exit(1);
console.log('r72l mic-race patch done');
