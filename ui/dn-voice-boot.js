// dn-voice-boot.js - wires the voice pieces together.
//
// dn-whisper.js   model + mic
// dn-voice-ptt.js VAD state machine, owns the recording
// dn-intent.js    text -> intent
// dn-router.js    free-form questions -> 9router
// dn-voice-exec.js intent -> action, and the AI fallback
//
// This file is the only place that knows about all of them. Keeping the glue
// separate means each module stays testable on its own and a failure here
// cannot take the recorder down with it.
(function () {
  if (window.dnVoiceBoot) return;

  var started = false;
  var liveActive = false;

  function isExitPhrase(text) {
    if (!text) return false;
    var t = String(text).trim().toLowerCase();
    return /^(selesai|cukup|stop|bye|dadah|tutup|keluar|sudah|berhenti)\b/i.test(t);
  }

  function bridgeOn(channel, cb) {
    try {
      if (window.bridge && typeof window.bridge.on === 'function') {
        return window.bridge.on(channel, cb);
      }
    } catch (_) {}
    return null;
  }

  function startSession(mode) {
    if (!window.dnPtt || typeof window.dnPtt.start !== 'function') {
      try { console.warn("[dnVoiceBoot] dnPtt missing"); } catch (_) {}
      try { if (window.bridge && window.bridge.send) window.bridge.send("dnptt:log", "dnPtt missing at start"); } catch (_) {}
      return;
    }
    if (window.dnPtt.isActive && window.dnPtt.isActive()) return;

    // Simpan window yang sedang aktif SEBELUM notch/UI ambil fokus, supaya
    // hasil dictate ditempel ke tempat yang benar (bukan ke window app kita).
    try {
      if (window.bridge && window.bridge.invoke) {
        window.bridge.invoke('dnptt:capture-target', {}).then(function (r) {
          try {
            if (window.bridge && window.bridge.send) {
              window.bridge.send("dnptt:log", "capture target hwnd=" + ((r && r.hwnd) || 0));
            }
          } catch (_) {}
        }).catch(function () {});
      }
    } catch (_) {}

    if (mode === 'command') {
      liveActive = true;
    } else {
      liveActive = false;
    }

    try { if (window.bridge && window.bridge.send) window.bridge.send("dnptt:log", "startSession " + mode); } catch (_) {}
    window.dnPtt.start(mode, function (evt) {
      if (!evt) return;
      try { if (window.bridge && window.bridge.send) window.bridge.send("dnptt:log", "evt " + evt.type + (evt.error ? (" err=" + evt.error) : "")); } catch (_) {}
      if (evt.type === 'error') {
        liveActive = false;
        try {
          if (window.dnVoice && window.dnVoice.speak) window.dnVoice.speak(evt.error);
        } catch (_) {}
        try {
          if (window.bridge && window.bridge.send) window.bridge.send('dnptt:done', {});
        } catch (_) {}
        return;
      }

      if (evt.type === 'text') {
        if (isExitPhrase(evt.text)) {
          liveActive = false;
          try {
            if (window.dnVoice && window.dnVoice.speak) window.dnVoice.speak("Sampai jumpa!");
          } catch (_) {}
          try {
            if (window.bridge && window.bridge.send) window.bridge.send('dnptt:done', {});
          } catch (_) {}
          return;
        }
      }

      if (window.dnVoiceExec && typeof window.dnVoiceExec.handle === 'function') {
        window.dnVoiceExec.handle(evt, function () {
          if (!liveActive || mode === 'dictate') {
            try {
              if (window.bridge && window.bridge.send) window.bridge.send('dnptt:done', {});
            } catch (_) {}
            return;
          }

          // Continuous Live Voice: wait until speech ends, then re-arm mic for follow-up
          var maxWait = 40; // 40 * 200ms = 8s max
          var loopCheck = setInterval(function () {
            var speaking = false;
            try {
              speaking = window.dnVoice && typeof window.dnVoice.isSpeaking === 'function' && window.dnVoice.isSpeaking();
            } catch (_) {}
            maxWait--;

            if (!speaking || maxWait <= 0) {
              clearInterval(loopCheck);
              if (liveActive) {
                setTimeout(function () {
                  if (liveActive && (!window.dnPtt || !window.dnPtt.isActive())) {
                    startSession('command');
                  }
                }, 350);
              } else {
                try {
                  if (window.bridge && window.bridge.send) window.bridge.send('dnptt:done', {});
                } catch (_) {}
              }
            }
          }, 200);
        });
      }
    });
  }

  function boot() {
    if (started) return;
    started = true;

    bridgeOn('dnptt:start', function (payload) {
      var mode = payload && payload.mode === 'dictate' ? 'dictate' : 'command';
      startSession(mode);
    });

    bridgeOn('dnptt:abort', function () {
      liveActive = false;
      try { if (window.dnVoice && window.dnVoice.stopSpeaking) window.dnVoice.stopSpeaking(); } catch (_) {}
      try { if (window.dnPtt && window.dnPtt.stop) window.dnPtt.stop(); } catch (_) {}
      try {
        if (window.bridge && window.bridge.send) window.bridge.send('dnptt:done', {});
      } catch (_) {}
    });

    // A hotkey that could not be registered must not look like a dead app.
    bridgeOn('dnptt:hotkey-failed', function (payload) {
      var key = payload && payload.key ? payload.key : 'hotkey';
      try {
        if (window.dnVoice && window.dnVoice.speak) {
          window.dnVoice.speak('Tombol ' + key + ' dipakai aplikasi lain');
        }
      } catch (_) {}
    });

    // main broadcasts hotkey failures once at startup, possibly before this
    // page exists. Re-applying the same combos asks again and returns the
    // authoritative answer, so a failure that was missed is still surfaced.
    setTimeout(function () {
      try {
        if (!window.bridge || !window.bridge.invoke) return;
        window.bridge.invoke('dnptt:set-hotkeys', { command: 'Ctrl+Alt+V', dictate: 'Ctrl+Alt+D' })
          .then(function (res) {
            var failed = res && res.failed ? res.failed : [];
            if (!failed.length) return;
            if (window.dnVoice && window.dnVoice.speak) {
              window.dnVoice.speak('Tombol ' + failed.join(' dan ') + ' dipakai aplikasi lain');
            }
          })
          .catch(function () {});
      } catch (_) {}
    }, 4000);

    // Esc cancels an in-flight recording, matching the approval card.
    try {
      document.addEventListener('keydown', function (e) {
        if (e.key !== 'Escape') return;
        liveActive = false;
        // A spoken answer is the most likely thing on screen: cut it first.
        if (window.dnVoice && window.dnVoice.stopSpeaking) {
          window.dnVoice.stopSpeaking();
        }
        if (window.dnPtt && window.dnPtt.stop) {
          window.dnPtt.stop();
        }
        try {
          if (window.bridge && window.bridge.send) window.bridge.send('dnptt:done', {});
        } catch (_) {}
      }, true);
    } catch (_) {}
  }

  window.dnVoiceBoot = { boot: boot, startSession: startSession };
  // The script is deferred, so the DOM is ready; boot immediately.
  boot();
})();
