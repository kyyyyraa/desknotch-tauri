// dn-voice.js - DeskNotch Fase 2a: TTS + STT probe, loaded in the notch renderer.
// Exposes window.dnVoice with:
//   speak(text, opts)      - speechSynthesis, prefers an id-ID voice, en fallback
//   voices()               - list {name, lang} of available TTS voices (probe)
//   sttProbe(cb)           - try webkitSpeechRecognition id-ID once, report probe result
//   sttStart(onResult, onEnd) / sttStop() - real push-to-talk session (fase 2c uses it)
// Fallback when speechSynthesis unavailable: main-process PowerShell via
// bridge invoke 'dnvoice:speak-ps' (main uses System.Speech or OneCore). Never
// throws to the notch UI - all errors go to console + optional event.
(function () {
  if (window.dnVoice) return;
  var bridge = null;
  try { bridge = window.bridge || null; } catch (_) {}

  function pickVoice() {
    var syn = window.speechSynthesis;
    if (!syn) return null;
    var vs = syn.getVoices() || [];
    var idVoice = null, enVoice = null;
    for (var i = 0; i < vs.length; i++) {
      var l = (vs[i].lang || '').toLowerCase();
      if (!idVoice && (l === 'id-id' || l === 'id_id' || l.indexOf('id') === 0)) idVoice = vs[i];
      if (!enVoice && (l === 'en-us' || l.indexOf('en') === 0)) enVoice = vs[i];
    }
    return idVoice || enVoice || vs[0] || null;
  }

  // Tracks whether an utterance is in flight so Esc can decide to stop it
  // without having to ask speechSynthesis, which reports stale values right
  // after cancel().
  var speaking = false;
  var speakTimer = null;

  function stopSpeaking() {
    if (speakTimer) { clearTimeout(speakTimer); speakTimer = null; }
    speaking = false;
    try { if (bridge && bridge.send) bridge.send("dnvoice:speaking-state", false); } catch (_) {}
    try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch (_) {}
    try { if (bridge && bridge.invoke) bridge.invoke("dnvoice:stop-onecore").catch(function () {}); } catch (_) {}
  }

  function speak(text, opts) {
    opts = opts || {};
    var str = String(text || '').trim();
    if (!str) return false;

    // Prefer native WinRT OneCore TTS (Microsoft Andika) via bridge
    if (bridge && bridge.invoke) {
      speaking = true;
      try { if (bridge.send) bridge.send("dnvoice:speaking-state", true); } catch (_) {}
      bridge.invoke('dnvoice:speak-onecore', { text: str }).then(function (res) {
        var dur = (res && res.duration_ms) || (str.length * 65 + 600);
        if (speakTimer) clearTimeout(speakTimer);
        speakTimer = setTimeout(function () {
          speakTimer = null;
          speaking = false;
          try { if (bridge && bridge.send) bridge.send("dnvoice:speaking-state", false); } catch (_) {}
        }, dur);
      }).catch(function () {
        speaking = false;
        try { if (bridge && bridge.send) bridge.send("dnvoice:speaking-state", false); } catch (_) {}
      });
      return true;
    }

    try {
      var syn = window.speechSynthesis;
      if (!syn) return false;
      syn.cancel();
      speaking = true;
      try { if (bridge && bridge.send) bridge.send("dnvoice:speaking-state", true); } catch (_) {}
      var u = new SpeechSynthesisUtterance(str);
      var v = pickVoice();
      if (v) u.voice = v;
      u.lang = v && v.lang ? v.lang : 'id-ID';
      u.rate = parseFloat(opts.rate || 1);
      u.pitch = parseFloat(opts.pitch || 1);
      if (typeof opts.volume !== 'undefined') u.volume = opts.volume;
      var beat = null;
      u.onstart = function () {
        if (beat) clearInterval(beat);
        beat = setInterval(function () {
          try { if (syn.speaking) { syn.pause(); syn.resume(); } else { clearInterval(beat); beat = null; } } catch (_) {}
        }, 10000);
      };
      u.onend = u.onerror = function () {
        if (beat) { clearInterval(beat); beat = null; }
        speaking = false;
        try { if (bridge && bridge.send) bridge.send("dnvoice:speaking-state", false); } catch (_) {}
      };
      syn.speak(u);
      return true;
    } catch (e) {
      speaking = false;
      return false;
    }
  }

  function voices() {
    var syn = window.speechSynthesis;
    if (!syn) return [];
    var vs = syn.getVoices() || [];
    return vs.map(function (v) { return { name: v.name, lang: v.lang } });
  }

  var stt = null;
  var sttDone = false;
  function buildRecognizer() {
    var Rec = window.WebSpeechAPIRec || window.SpeechRecognition || window.webkitSpeechRecognition;
    return Rec || null;
  }

  function sttProbe(cb) {
    var Rec = buildRecognizer();
    if (!Rec) { cb && cb({ ok: false, why: 'no SpeechRecognition API' }); return; }
    var r;
    try { r = new Rec(); } catch (e) { cb && cb({ ok: false, why: 'ctor threw: ' + e.message }); return; }
    r.lang = 'id-ID';
    r.continuous = false;
    r.interimResults = false;
    var done = false;
    function finish(res) { if (!done) { done = true; cb && cb(res); } }
    r.onerror = function (e) {
      finish({ ok: false, why: e.error, native: true });
    };
    r.onresult = function (e) {
      var t = '';
      for (var i = e.resultIndex; i < e.results.length; i++) t += e.results[i][0].transcript;
      finish({ ok: true, text: t, native: true });
    };
    r.onend = function () { finish({ ok: false, why: 'ended with no result', native: true }); };
    try { r.start(); } catch (e) { finish({ ok: false, why: 'start threw: ' + e.message }); }
  }

  // ---- engine dispatch ----------------------------------------------------
  // Whisper (local, no network) is the primary engine. The Web Speech API is
  // kept only as a fallback: in Electron it usually fails with "network"
  // because it needs Google's speech backend and the API key Chrome ships.
  function sttEngine() {
    if (window.dnWhisper) return 'whisper';
    if (buildRecognizer()) return 'web';
    return 'none';
  }

  function sttStart(onResult, onEnd) {
    if (window.dnWhisper) {
      // Whisper path: record, then transcribe. Progress is streamed as
      // onResult(..., false) so the UI can show "Memuat model 43%".
      if (sttDone === false) { try { window.dnWhisper.stopRecording(); } catch (_) {} }
      sttDone = false;
      window.dnWhisper.recordAndTranscribe(5000, function (s) {
        if (!sttDone) onResult && onResult(s, false);
      }).then(function (res) {
        if (sttDone) return;
        sttDone = true;
        var txt = res.text || '';
        // When Whisper returns nothing, show what the mic actually captured.
        // Without these numbers "empty text" is indistinguishable from a muted
        // microphone, a wrong sample rate, or a silent device.
        if (!txt && res.info) {
          txt = 'Tidak ada suara [' + res.info.samples + ' sampel, '
            + res.info.rate + 'Hz, puncak ' + res.info.peak.toFixed(4)
            + ', gain x' + (res.info.gain || 1) + ']';
        }
        onResult && onResult(txt, true);
        onEnd && onEnd(null);
      }).catch(function (e) {
        if (sttDone) return;
        sttDone = true;
        onEnd && onEnd((e && e.message) ? e.message : String(e));
      });
      return true;
    }

    var Rec = buildRecognizer();
    if (!Rec) { onEnd && onEnd('no SpeechRecognition API'); return null; }
    try {
      if (stt) { try { stt.abort(); } catch (_) {} stt = null; }
      sttDone = false;
      stt = new Rec();
      stt.lang = 'id-ID';
      stt.continuous = false;
      stt.interimResults = true;
      stt.onresult = function (e) {
        var t = '';
        for (var i = e.resultIndex; i < e.results.length; i++) t += e.results[i][0].transcript;
        onResult && onResult(t, e.results[e.results.length - 1].isFinal);
      };
      // onerror is always followed by onend; deliver exactly one terminal signal.
      stt.onerror = function (e) {
        if (sttDone) return;
        sttDone = true;
        stt = null;
        onEnd && onEnd(e.error);
      };
      stt.onend = function () {
        if (sttDone) return;
        sttDone = true;
        stt = null;
        // No final transcript means the mic heard nothing usable; report that
        // as an end without error so the caller keeps its "coba lagi" hint.
        onEnd && onEnd(null);
      };
      stt.start();
      return true;
    } catch (e) {
      stt = null;
      sttDone = true;
      onEnd && onEnd(e.message);
      return null;
    }
  }

  function sttStop() {
    // An intentional stop must not report "ended with nothing": the caller
    // already has whatever transcript arrived, and a null onEnd would wipe it.
    sttDone = true;
    if (window.dnWhisper) {
      // Whisper: stopping the recorder discards audio, so tell the caller the
      // session ended without a transcript rather than leaving it hanging.
      try { window.dnWhisper.stopRecording(); } catch (_) {}
      return;
    }
    if (stt) { try { stt.stop(); } catch (e) { try { stt.abort(); } catch (_) {} } }
  }

  window.dnVoice = {
    speak: speak,
    stopSpeaking: stopSpeaking,
    isSpeaking: function () { return speaking; },
    voices: voices,
    sttProbe: sttProbe,
    sttEngine: sttEngine,
    sttStart: sttStart,
    sttStop: sttStop,
    _pickVoice: pickVoice
  };

  // listen for global Escape stop from main process
  try { if (bridge && bridge.on) bridge.on("dnvoice:stop", function () { stopSpeaking(); }); } catch (_) {}

  // voices list is async in Chromium: warm it up on load
  try { if (window.speechSynthesis) speechSynthesis.getVoices(); } catch (_) {}
})();
