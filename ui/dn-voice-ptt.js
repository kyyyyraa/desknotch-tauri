// dn-voice-ptt.js - Push-to-talk orchestration for DeskNotch voice.
// Renderer-side: hotkey listener, VAD (silence detection), mode routing.
//
// Hotkeys are registered in main and arrive as IPC events:
//   'dnptt:start' {mode:'command'|'dictate'}
//   'dnptt:abort'
//
// Recording uses window.dnWhisper.startRecording() + stopRecording() for
// audio capture, and a SEPARATE ScriptProcessorNode stream for live VAD.
// The two streams are independent: dnWhisper captures at native rate and
// resamples to 16 kHz for Whisper; the VAD stream only computes RMS and
// is torn down together with the whisper mic on every exit path.
//
// State machine:
//   IDLE -> LISTENING -> RECORDING -> TRANSCRIBING -> IDLE
//   Any state -> IDLE (on abort / error / timeout)
//
// VAD design:
//   - autoGainControl OFF on the VAD stream. Chromium's AGC continuously
//     raises gain during silence and pumps around speech onsets, making a
//     frozen noise floor invalid within seconds. With AGC off the raw mic
//     level is stable and the adaptive threshold holds.
//   - No frozen noise floor. A continuous exponential min-tracker follows
//     the quietest frames over time. The threshold is always
//     max(trackedFloor * 3, 0.0015). The 0.0015 absolute minimum matches
//     trimSilence() in dn-whisper.js for pipeline consistency.
//   - Frame timing: ScriptProcessor(2048) at 48 kHz = 42.7 ms per
//     callback (44.1 kHz = 46.4 ms). The VAD state machine runs inside
//     the audio callback itself, not a setInterval, so it fires exactly
//     once per rendered buffer with no timer-accuracy dependency.
//     Silence window: 1200 ms in command mode, 3000 ms in dictate mode
//     (~28 / ~70 consecutive silent frames at 48 kHz).
//
// Public API: window.dnPtt (see bottom of file).
(function () {
  if (window.dnPtt) return;

  var bridge = null;
  try { bridge = window.bridge || null; } catch (_) {}

  // ---- constants ----------------------------------------------------------

  // Timing is mode-aware (see silenceMs()/hardCapMs()): a command is one
  // short sentence, so 1.2 s of pause ends it and 30 s is plenty. Dictation
  // has thinking time between sentences, so it tolerates 3 s of silence and
  // only caps at 3 minutes. currentMode is set in doStart() before the VAD
  // stream exists, so the very first audio frame already sees the right mode.
  var SILENCE_MS_COMMAND = 1200;   // command mode: silence duration to auto-stop
  var SILENCE_MS_DICTATE = 3000;   // dictate mode: pause between sentences
  var NO_SPEECH_MS = 6000;         // abort if no speech detected within this
  var HARD_CAP_MS_COMMAND = 30000; // command mode: absolute maximum length
  var HARD_CAP_MS_DICTATE = 180000;// dictate mode: 3 minutes

  function silenceMs() {
    return currentMode === 'dictate' ? SILENCE_MS_DICTATE : SILENCE_MS_COMMAND;
  }
  function hardCapMs() {
    return currentMode === 'dictate' ? HARD_CAP_MS_DICTATE : HARD_CAP_MS_COMMAND;
  }
  // ScriptProcessor buffer size. 2048 at 48 kHz = 42.7 ms per callback,
  // at 44.1 kHz = 46.4 ms. Chosen over 4096 (85 ms) for finer VAD
  // granularity: the 1200 ms command-mode silence window is ~28 frames,
  // vs ~14 at 4096.
  var SP_BUFFER_SIZE = 2048;
  var MIN_THRESHOLD = 0.0015;   // absolute floor, matches dn-whisper.js trimSilence
  var FLOOR_MULTIPLIER = 3;     // threshold = max(trackedFloor * 3, MIN_THRESHOLD)
  // Exponential min-tracker decay: how fast the tracked floor rises when
  // the current RMS is above it. 0.002 per frame means ~0.047/s at 48 kHz,
  // so a brief speech burst does not yank the floor up instantly.
  var MIN_TRACK_RISE = 0.002;

  // ---- state --------------------------------------------------------------

  var state = 'idle';           // idle | listening | recording | transcribing
  var currentMode = null;       // 'command' | 'dictate'
  var currentCallback = null;   // onEvent(evt) provided by caller

  // VAD analyser resources (separate from dnWhisper mic)
  var vadStream = null;
  var vadCtx = null;
  var vadSource = null;
  var vadProc = null;

  // timers (only no-speech and hard-cap; silence is callback-driven)
  var noSpeechTimer = null;
  var hardCapTimer = null;

  // VAD state
  var trackedFloor = 0;         // exponential min-tracker
  var threshold = MIN_THRESHOLD;
  var speechDetected = false;
  var silenceStart = 0;         // timestamp when silence began (0 = not silent)
  var startTime = 0;            // when recording started (for hard cap)
  var doubleStartLogged = false;
  var frameCount = 0;           // total frames since start

  // assignable level callback for external visualizer
  var onLevelCb = null;

  // ---- helpers ------------------------------------------------------------

  function rlog(msg) {
    try { console.log("[dnPtt] " + msg); } catch (_) {}
    try {
      if (window.bridge && window.bridge.send) window.bridge.send("dnptt:log", String(msg));
    } catch (_) {}
  }

  function log(msg) {
    try { console.log('[dnPtt] ' + msg); } catch (_) {}
  }

  function emit(evt) {
    // Mirror state into the notch view. The chunk exposes globalThis.dnVoiceUi
    // only while the voice view is mounted, so this is a no-op otherwise.
    try {
      var ui = globalThis.dnVoiceUi;
      if (ui) {
        if (evt && evt.type === 'status') ui({ status: evt.status, text: evt.text || '' });
        else if (evt && evt.type === 'partial') ui({ status: 'Mendengarkan', text: evt.text || '' });
        else if (evt && (evt.type === 'text' || evt.type === 'dictate')) ui({ status: 'Selesai', text: evt.text || '' });
        else if (evt && evt.type === 'intent') ui({ status: 'Perintah', text: evt.label || evt.intent || '' });
      }
    } catch (_) {}
    try { if (currentCallback) currentCallback(evt); } catch (e) { log('onEvent error: ' + e); }
  }

  function clearAllTimers() {
    if (noSpeechTimer) { clearTimeout(noSpeechTimer); noSpeechTimer = null; }
    if (hardCapTimer) { clearTimeout(hardCapTimer); hardCapTimer = null; }
  }

  // ---- VAD audio processing -----------------------------------------------
  // Runs inside the ScriptProcessor callback: no timer dependency.
  // autoGainControl is OFF on this stream. Chromium's AGC continuously
  // raises gain during silence and pumps around speech, so a noise floor
  // measured at any point becomes invalid within seconds. With AGC off
  // the raw mic level is stable and the adaptive threshold holds.

  function computeRmsFromBuffer(input) {
    var sum = 0;
    for (var i = 0; i < input.length; i++) {
      sum += input[i] * input[i];
    }
    return Math.sqrt(sum / input.length);
  }

  function onAudioFrame(rms) {
    frameCount++;

    // Deliver level to external visualizer
    try { if (onLevelCb) onLevelCb(rms); } catch (_) {}

    if (state !== 'listening' && state !== 'recording') return;

    // ---- continuous min-tracker ----
    // Instead of freezing a noise floor from the first 500 ms, track the
    // minimum RMS continuously. The tracker follows the quietest frames
    // and decays upward slowly (MIN_TRACK_RISE per frame) so brief speech
    // does not corrupt the floor estimate. If the user talks immediately
    // after pressing the hotkey, the floor stays low (initialized to the
    // first frame's RMS) and the threshold remains sensible.
    if (frameCount === 1) {
      // Start from the absolute floor rather than the first sample: one loud
      // frame at press time (click, breath) would otherwise raise the
      // threshold to 3x its level and hide normal speech for the whole session.
      trackedFloor = MIN_THRESHOLD;
    } else if (rms < trackedFloor) {
      // New minimum found: snap down immediately
      trackedFloor = rms;
    } else {
      // Current RMS is above floor: let the floor decay upward slowly
      trackedFloor = trackedFloor + (rms - trackedFloor) * MIN_TRACK_RISE;
    }

    threshold = Math.max(trackedFloor * FLOOR_MULTIPLIER, MIN_THRESHOLD);

    if (frameCount % 10 === 0) {
      rlog('lvl rms=' + rms.toFixed(4) + ' floor=' + trackedFloor.toFixed(4) + ' thr=' + threshold.toFixed(4) + (speechDetected ? ' SPEECH' : ''));
    }
    var isSpeech = rms > threshold;

    if (isSpeech) {
      if (!speechDetected) {
        speechDetected = true;
        state = 'recording';
        emit({ type: 'status', status: 'recording' });
      }
      // Reset silence tracking whenever speech is detected
      silenceStart = 0;
    } else {
      // Below threshold
      if (speechDetected) {
        var now = Date.now();
        if (silenceStart === 0) {
          silenceStart = now;
        } else if (now - silenceStart >= silenceMs()) {
          // Silence held long enough after speech: stop recording
          doStop('silence');
          return;
        }
      }
    }

    // Hard cap check inside the callback as well, in case the timer
    // is delayed (though it should not be during recording-only phase)
    if (startTime > 0 && Date.now() - startTime >= hardCapMs()) {
      if (state === 'listening' || state === 'recording') {
        doStop('hardcap');
      }
    }
  }

  // ---- VAD stream ---------------------------------------------------------

  function startVad() {
    return navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        // autoGainControl OFF: Chromium's AGC pumps the noise floor during
        // silence and compresses around speech onsets. This makes any
        // adaptive threshold unreliable — quiet room tone gets amplified
        // to look like speech, and the silence timer never fires. With
        // AGC off the raw mic signal is stable for VAD math.
        autoGainControl: false
      }
    }).then(function (stream) {
      // The session ended while the mic was being opened — close it now.
      if (state !== 'listening' && state !== 'recording') {
        try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (_) {}
        return;
      }
      vadStream = stream;
      var Ctx = window.AudioContext || window.webkitAudioContext;
      vadCtx = new Ctx();
      if (vadCtx.state === 'suspended' && vadCtx.resume) {
        try { vadCtx.resume(); } catch (_) {}
      }
      vadSource = vadCtx.createMediaStreamSource(stream);
      // ScriptProcessor(2048) at 48 kHz = 42.7 ms per callback.
      // The VAD state machine runs entirely inside onaudioprocess,
      // so frame timing depends on the audio graph, not setInterval.
      vadProc = vadCtx.createScriptProcessor(SP_BUFFER_SIZE, 1, 1);
      vadProc.onaudioprocess = function (ev) {
        var input = ev.inputBuffer.getChannelData(0);
        var rms = computeRmsFromBuffer(input);
        onAudioFrame(rms);
      };
      vadSource.connect(vadProc);
      vadProc.connect(vadCtx.destination);
    });
  }

  // Same race as the whisper mic: the VAD stream is opened asynchronously, so
  // an abort during the request would leave it open forever. The epoch tells
  // the pending request that its result is no longer wanted.
  var vadEpoch = 0;

  function releaseVad() {
    vadEpoch++;
    try { if (vadProc) { vadProc.onaudioprocess = null; vadProc.disconnect(); } } catch (_) {}
    try { if (vadSource) vadSource.disconnect(); } catch (_) {}
    try { if (vadCtx && vadCtx.state !== 'closed') vadCtx.close(); } catch (_) {}
    try {
      if (vadStream) {
        var tracks = vadStream.getTracks();
        for (var i = 0; i < tracks.length; i++) { try { tracks[i].stop(); } catch (_) {} }
      }
    } catch (_) {}
    vadStream = null;
    vadCtx = null;
    vadSource = null;
    vadProc = null;
  }

  // ---- core lifecycle -----------------------------------------------------

  function doStart(mode, onEvent) {
    if (state !== 'idle') {
      if (!doubleStartLogged) {
        log('ignoring start: already active (state=' + state + ')');
        doubleStartLogged = true;
      }
      return;
    }
    doubleStartLogged = false;

    rlog('doStart mode=' + mode);
    currentMode = mode;
    currentCallback = onEvent;
    state = 'listening';
    speechDetected = false;
    silenceStart = 0;
    trackedFloor = 0;
    threshold = MIN_THRESHOLD;
    frameCount = 0;
    startTime = Date.now();

    emit({ type: 'status', status: 'listening' });

    // Start both the VAD stream and the whisper recorder in parallel
    var vadReady = startVad();
    var whisperReady = window.dnWhisper
      ? window.dnWhisper.startRecording()
      : Promise.reject(new Error('dnWhisper not available'));

    // The model is not preloaded at launch any more: the ONNX WASM heap holds
    // ~1 GB resident for as long as the pipeline lives, and a session that is
    // never spoken to has no use for it. Warming up here makes the model read
    // overlap with the recording instead of landing after it. The failure is
    // ignored on purpose: doStop() loads the model again and reports any
    // error properly.
    try {
      if (window.dnWhisper && typeof window.dnWhisper.warmUp === 'function') {
        window.dnWhisper.warmUp();
      }
    } catch (_) {}

    rlog('vad+mic ready');
    Promise.all([vadReady, whisperReady]).then(function () {
      if (state !== 'listening' && state !== 'recording') return; // aborted while awaiting

      // No-speech timeout: if nothing is detected within NO_SPEECH_MS, abort.
      noSpeechTimer = setTimeout(function () {
        noSpeechTimer = null;
        if (!speechDetected && (state === 'listening')) {
          rlog('no speech: peak rms never crossed thr=' + threshold.toFixed(4));
          doAbort('tidak ada suara terdeteksi, coba lagi lebih dekat ke mic');
        }
      }, NO_SPEECH_MS);

      // Hard cap timer as a safety net (the callback also checks). Armed with
      // the mode's own cap: 30 s for commands, 180 s for dictation.
      hardCapTimer = setTimeout(function () {
        hardCapTimer = null;
        if (state === 'listening' || state === 'recording') {
          doStop('hardcap');
        }
      }, hardCapMs());

    }).catch(function (e) {
      rlog('start failed: ' + (e && e.message ? e.message : e));
      fullCleanup();
      state = 'idle';
      emit({ type: 'error', error: e && e.message ? e.message : String(e) });
    });
  }

  function doStop(reason) {
    if (state !== 'listening' && state !== 'recording') return;
    rlog('doStop reason=' + reason + ' recMs=' + (startTime ? Date.now() - startTime : 0));

    clearAllTimers();
    state = 'transcribing';
    emit({ type: 'status', status: 'transcribing' });

    releaseVad();

    if (!window.dnWhisper) {
      fullCleanup();
      state = 'idle';
      emit({ type: 'error', error: 'dnWhisper not available' });
      return;
    }

    window.dnWhisper.stopRecording().then(function (rec) {
      var audio = rec.audio;
      rlog('audio ready len=' + (audio ? audio.length : 0) + ' sr=' + (rec && rec.sampleRate));

      if (!audio || !audio.length) {
        state = 'idle';
        currentMode = null;
        currentCallback = null;
        emit({ type: 'error', error: 'mic tidak menghasilkan audio' });
        return;
      }

      return window.dnWhisper.load().then(function () {
        rlog('model ready, transcribe start len=' + audio.length);
        var tTx = Date.now();
        return window.dnWhisper.transcribe(audio).then(function (r) {
          rlog('transcribe done in ' + (Date.now() - tTx) + 'ms text=' + JSON.stringify(String((r && r.text) || '').slice(0, 60)));
          return r;
        }, function (e) {
          rlog('transcribe FAILED after ' + (Date.now() - tTx) + 'ms: ' + (e && e.message ? e.message : e));
          throw e;
        });
      }).then(function (res) {
        var text = res.text || '';
        var mode = currentMode;

        state = 'idle';
        var cb = currentCallback;
        currentMode = null;
        currentCallback = null;

        if (!text) {
          emit({ type: 'error', error: 'suara terdengar tapi tidak ada kata yang dikenali' });
          return;
        }

        routeResult(mode, text, res, cb);
      });
    }).catch(function (e) {
      log('stop/transcribe error: ' + e);
      rlog('CHAIN ERROR: ' + (e && e.message ? e.message : e));
      state = 'idle';
      currentMode = null;
      currentCallback = null;
      emit({ type: 'error', error: e && e.message ? e.message : String(e) });
    });
  }

  function doAbort(reason) {
    log('abort: ' + reason);
    rlog('abort: ' + reason);
    clearAllTimers();
    releaseVad();

    if (window.dnWhisper) {
      try { window.dnWhisper.stopRecording(); } catch (_) {}
    }

    var wasState = state;
    state = 'idle';
    var cb = currentCallback;
    currentMode = null;
    currentCallback = null;

    if (wasState !== 'idle') {
      try {
        if (cb) cb({ type: 'abort', reason: reason });
      } catch (_) {}
    }
  }

  function fullCleanup() {
    clearAllTimers();
    releaseVad();
    if (window.dnWhisper) {
      try { window.dnWhisper.stopRecording(); } catch (_) {}
    }
  }

  // ---- mode routing -------------------------------------------------------

  // Splits "buka zcode lalu tulis halo" into two commands. Only the first
  // is executed as an action; the rest is handed to the next stage as text,
  // which is what the user means by "lalu".
  // Whisper puts a comma before the conjunction: "Chrome, lalu buka Whatsapp".
  // The optional separator and whitespace keep that comma out of `first`.
  // The leading \b keeps the zero-width \s* from matching inside a word
  // ("selalu" ends in "lalu" and would otherwise split mid-word).
  var CHAIN_RE = /[,;]?\s*\b(?:lalu|kemudian|terus|dan\s+lalu)\s+(?=\S)/i;

  function splitChain(text) {
    var m = String(text || '').match(CHAIN_RE);
    if (!m) return null;
    var at = m.index;
    var first = String(text).slice(0, at).trim();
    first = first.replace(/[,;.\s]+$/, '').trim();
    var rest = String(text).slice(at + m[0].length).trim();
    if (!first || !rest) return null;
    return { first: first, rest: rest };
  }

  function routeResult(mode, text, transcribeResult, cb) {
    rlog('routeResult mode=' + mode + ' cb=' + (cb ? 'yes' : 'NULL') + ' text=' + JSON.stringify(String(text).slice(0, 50)));
    if (mode === 'command') {
      var resolveIntent = function (t) {
        // Whisper trails punctuation onto the last word ("buka tab Youtube.")
        // and every regex below is end-anchored, so strip it up front.
        var s = String(t || '').trim().replace(/[.,;!?]+$/, '').trim();
        // "buka tab X" and "buka X di chrome" mean a browser tab for a site,
        // not the desktop app. Decide BEFORE dnIntent.parse: it reads "tab"
        // as a noise word and answers open_app, which would launch the
        // installed app instead. The two forms are matched separately: one
        // regex with both "tab" and "di chrome" optional would also swallow
        // a plain "buka chrome" as open_tab.
        var mTab = s.match(/^\s*buka\s+tab\s+([a-zA-Z0-9._-]+(?:\s+[a-zA-Z0-9._-]+)?)\s*$/i);
        if (mTab && mTab[1]) {
          return { intent: 'open_tab', app: mTab[1].toLowerCase(), label: mTab[1], score: 0.85 };
        }
        var mSite = s.match(/^\s*buka\s+([a-zA-Z0-9._-]+(?:\s+[a-zA-Z0-9._-]+)?)\s+di\s+(?:chrome|browser)\s*$/i);
        if (mSite && mSite[1] && !/^(?:pintu|jendela|mata|file|dokumen|aplikasi|tab)$/i.test(mSite[1])) {
          return { intent: 'open_tab', app: mSite[1].toLowerCase(), label: mSite[1], score: 0.85 };
        }
        var mBareDomain = s.match(/^\s*(?:https?:\/\/)?([a-zA-Z0-9._-]+\.(?:com|org|net|io|id|tv|co)(?:\/[^\s]*)?)\s*$/i);
        if (mBareDomain && mBareDomain[1]) {
          var dom = mBareDomain[1].toLowerCase();
          var hitDom = (window.dnIntent && window.dnIntent.siteKey) ? window.dnIntent.siteKey(dom) : null;
          var domKey = hitDom ? hitDom.key : dom.split('.')[0];
          var domLabel = hitDom ? hitDom.label : mBareDomain[1];
          return { intent: 'open_tab', app: domKey, label: domLabel, url: 'https://' + dom, score: 0.95 };
        }
        var mBukaWeb = s.match(/^\s*buka\s+(?:situs\s+|website\s+)?([a-zA-Z0-9._-]+\.(?:com|org|net|io|id|tv|co)(?:\/[^\s]*)?)\s*$/i);
        if (mBukaWeb && mBukaWeb[1]) {
          var bDom = mBukaWeb[1].toLowerCase();
          var hitBDom = (window.dnIntent && window.dnIntent.siteKey) ? window.dnIntent.siteKey(bDom) : null;
          var bKey = hitBDom ? hitBDom.key : bDom.split('.')[0];
          var bLabel = hitBDom ? hitBDom.label : mBukaWeb[1];
          return { intent: 'open_tab', app: bKey, label: bLabel, url: 'https://' + bDom, score: 0.95 };
        }
        var mBukaYt = s.match(/^\s*buka\s+(?:aplikasi\s+)?(?:tab\s+)?(youtube|yutub|yt)\s*$/i);
        if (mBukaYt) {
          return { intent: 'open_tab', app: 'youtube', label: 'YouTube', score: 0.95 };
        }
        if (window.dnIntent && typeof window.dnIntent.parse === 'function') {
          try {
            var p = window.dnIntent.parse(s);
            if (p && p.intent && p.intent !== 'unknown') return p;
          } catch (_) {}
        }
        // Longest verb phrase first: "buka aplikasi zcode" must capture
        // "zcode", not "aplikasi zcode" (the bare "buka" alternative would
        // otherwise win the alternation and swallow the noun).
        var m = s.match(/^\s*(?:buka\s+aplikasi|buka\s+apk|bukakan|bukain|jalankan|buka)\s+([a-zA-Z0-9._-]+(?:\s+[a-zA-Z0-9._-]+)?)\s*$/i);
        if (m && m[1]) {
          var name = m[1].trim();
          if (!/^(?:pintu|jendela|mata|browser|file|dokumen|tab)$/i.test(name)) {
            return { intent: 'open_app', app: name.toLowerCase(), label: name, score: 0.85 };
          }
        }
        return null;
      };
      // Check chained command FIRST: e.g. "Buka Chrome, lalu buka WhatsApp"
      // If resolveIntent ran first, it would eat the whole sentence as open_app chrome.
      var parts = splitChain(text);
      if (parts) {
        var head = resolveIntent(parts.first);
        if (head) {
          rlog('chain: first=' + head.intent + ' rest=' + JSON.stringify(parts.rest.slice(0, 40)));
          emit({ type: 'intent', intent: head.intent, label: head.label });
          try { if (cb) cb({ type: 'chain', first: head, rest: parts.rest }); } catch (_) {}
          return;
        }
      }
      var parsed = resolveIntent(text);
      if (parsed) {
        emit({ type: 'intent', intent: parsed.intent, label: parsed.label });
        try { if (cb) cb({ type: 'intent', data: parsed }); } catch (_) {}
        return;
      }
      emit({ type: 'status', status: 'Selesai', text: text });
      try { if (cb) cb({ type: 'text', text: text }); } catch (_) {}
    } else if (mode === 'dictate') {
      emit({ type: 'status', status: 'Selesai', text: text });
      try { if (cb) cb({ type: 'dictate', text: text }); } catch (_) {}
    }
  }

  // ---- paste helper -------------------------------------------------------
  // Contract: renderer sends {text:string} to main via 'dnptt:paste'.
  // Main process is expected to:
  //   1. Save the current clipboard contents
  //   2. Set clipboard to text
  //   3. SetForegroundWindow(savedHWND)
  //   4. Simulate Ctrl+V
  //   5. Restore the original clipboard
  //   6. Return {ok:boolean, reason?:string}
  //
  // Known Windows risks the caller must handle:
  //   - SetForegroundWindow from a background process is subject to the
  //     Windows foreground lock. If DeskNotch lost the foreground token,
  //     the call fails silently and the taskbar button flashes instead.
  //     The main handler should detect this (GetForegroundWindow != target)
  //     and return {ok:false, reason:'foreground-lock'}.
  //   - Sending Ctrl+V to an ELEVATED (admin) window from a non-elevated
  //     app is blocked by UIPI (User Interface Privilege Isolation),
  //     silently. The main handler should detect this and return
  //     {ok:false, reason:'uipi-blocked'}.
  //   In both cases this function returns {ok:false, reason} so the UI
  //   can show "teks sudah dicopy, tekan Ctrl+V sendiri" instead of
  //   failing silently.

  function pasteToFocus(text) {
    if (!bridge || !bridge.invoke) {
      return Promise.resolve({ ok: false, reason: 'bridge not available' });
    }
    return bridge.invoke('dnptt:paste', { text: String(text) }).then(function (res) {
      if (res && res.ok === false) {
        return { ok: false, reason: res.reason || 'paste failed' };
      }
      return res || { ok: true };
    }).catch(function (e) {
      return { ok: false, reason: e && e.message ? e.message : String(e) };
    });
  }

  // ---- hotkey config ------------------------------------------------------

  function setHotkeys(cmd, dict) {
    if (!bridge || !bridge.invoke) {
      log('setHotkeys: bridge not available');
      return;
    }
    bridge.invoke('dnptt:set-hotkeys', { command: cmd, dictate: dict }).catch(function (e) {
      log('setHotkeys failed: ' + e);
    });
  }

  // ---- IPC listeners ------------------------------------------------------

  function registerBridgeListeners() {
    if (!bridge || !bridge.on) return;

    // dnptt:start is owned by dn-voice-boot.js, which passes the real callback
    // that runs the intent. Registering a listener here too would win the race
    // (this script loads first) and start the session with a placeholder
    // callback, so the command would transcribe and then do nothing.
    bridge.on('dnptt:abort', function () {
      doAbort('user');
    });
  }

  registerBridgeListeners();

  // ---- public API ---------------------------------------------------------

  window.dnPtt = {
    start: function (mode, onEvent) {
      doStart(mode, onEvent);
    },
    stop: function () {
      doAbort('manual');
    },
    isActive: function () {
      return state !== 'idle';
    },
    pasteToFocus: pasteToFocus,
    onLevel: null,
    setHotkeys: setHotkeys,
    _state: function () { return state; },
    _threshold: function () { return threshold; },
    _noiseFloor: function () { return trackedFloor; },
    _feedFrame: function (rms) { onAudioFrame(rms); }
  };

  Object.defineProperty(window.dnPtt, 'onLevel', {
    get: function () { return onLevelCb; },
    set: function (fn) { onLevelCb = typeof fn === 'function' ? fn : null; },
    enumerable: true,
    configurable: true
  });
})();
