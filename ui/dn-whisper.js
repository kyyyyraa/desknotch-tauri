// dn-whisper.js - DeskNotch local STT via Whisper (Transformers.js + ONNX Runtime Web).
// Runs entirely in the notch renderer: no server, no API key, no cloud.
// Model files live in the asar at /dn-models/whisper-small/ (served by electron-serve).
//
// Public API (window.dnWhisper):
//   load(onProgress)          -> Promise<void>       memoized; onProgress({status,progress,file})
//   isLoaded() / isLoading()  -> boolean
//   status()                  -> 'idle' | 'loading' | 'ready' | 'error' | 'unsupported'
//   startRecording()          -> Promise<void>       mic on, accumulates mono 16 kHz
//   stopRecording()           -> Promise<Float32Array>  mic off, returns audio
//   transcribe(audio, opts)   -> Promise<{text, ms}>
//   recordAndTranscribe(ms, onStatus) -> Promise<{text, ms}>
//   unload()                  -> void                frees the pipeline
//   setEnabled(on)            -> Promise<void>       STT service switch; persisted
//   isEnabled()               -> boolean             is the STT service on?
//   preloadNow()              -> Promise<boolean>    load the model now; silent, idempotent
(function () {
  if (window.dnWhisper) return;

  // Pinned so a CDN change cannot silently alter behaviour.
  var TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0';
  var MODEL_ID = 'whisper-small';
  // Absolute path, not './dn-models/': a relative path resolves against the
  // page base URL, which may be app://./home/ and would 404.
  var MODEL_PATH = '/dn-models/';
  var SAMPLE_RATE = 16000;               // Whisper requires 16 kHz mono
  // The model read is ~15-20 s. Doing it in the background after the page has
  // settled means the first hotkey press finds a ready pipeline instead of
  // waiting for the load. The delay keeps it out of the way of app startup.
  var PRELOAD_DELAY_MS = 8000;
  // Loading the model is not free: the ONNX Runtime WASM heap reserves about
  // 1 GB the moment the pipeline is resident, and WebView2 holds that
  // reservation for the whole session. Preloading on launch therefore cost
  // ~1 GB of RAM in every session, including the many where the user never
  // speaks. The model now comes up only when it is asked for: the settings
  // switch, a transcription, or an explicit warmUp() when a recording starts.
  var AUTO_PRELOAD = false;

  var state = 'idle';                    // idle | loading | ready | error | unsupported
  var libPromise = null;
  var pipePromise = null;
  var pipe = null;
  var lastError = null;

  // ---- service switch -----------------------------------------------------
  // The user decides when STT is allowed to run. A timer that unloaded the
  // model on its own was the wrong tool: reloading costs ~15 s and a 249 MB
  // re-read, so an automatic unload cost far more than the memory it freed.
  // Now the model stays resident for as long as the service is ON, and the
  // switch is the only thing that tears it down.
  //
  // The flag lives in memory and is mirrored into the app's own settings
  // store through the bridge, next to dnVoiceEnabled. localStorage is not
  // used: the app:// origin is not registered as a standard scheme, so
  // storage there is not guaranteed to exist or to persist.
  var SETTINGS_KEY = 'dnSttEnabled';
  var DISABLED_MSG = 'layanan suara sedang dimatikan';
  var enabled = true;
  // The stored read-back is async, so it can land after the user has already
  // flipped the switch. This flag stops the late read from overwriting an
  // explicit choice.
  var explicitChoice = false;

  function getBridge() {
    try { return (window && window.bridge) || null; } catch (_) { return null; }
  }

  // Read the stored preference once at startup. The bridge call is async, so
  // until it lands the flag keeps its default (on) and callers are not
  // blocked: a missing or failing store must not break STT.
  function loadStoredEnabled() {
    var bridge = getBridge();
    if (!bridge || !bridge.invoke) return Promise.resolve(enabled);
    var res;
    try { res = bridge.invoke('store:get', 'settings'); } catch (_) { return Promise.resolve(enabled); }
    return Promise.resolve(res).then(function (settings) {
      // An explicit switch flip wins over whatever was stored.
      if (explicitChoice) return enabled;
      var raw = settings ? settings[SETTINGS_KEY] : null;
      if (raw === null || raw === undefined || raw === '') enabled = true;
      else enabled = raw !== false && raw !== 0 && raw !== '0' && raw !== 'false';
      return enabled;
    }).catch(function () {
      // No store, or the read failed: keep the current value.
      return enabled;
    });
  }

  // Persist the flag without clobbering the other settings. store:set replaces
  // the whole settings object, so the current one is read and merged.
  function storeEnabled(on) {
    var bridge = getBridge();
    if (!bridge || !bridge.invoke) return Promise.resolve(false);
    var cur;
    try { cur = bridge.invoke('store:get', 'settings'); } catch (_) { return Promise.resolve(false); }
    return Promise.resolve(cur).then(function (settings) {
      var next = (settings && typeof settings === 'object') ? Object.assign({}, settings) : {};
      next[SETTINGS_KEY] = !!on;
      return bridge.invoke('store:set', 'settings', next);
    }).then(function () { return true; }).catch(function () { return false; });
  }

  // ---- the switch ---------------------------------------------------------

  function isEnabled() {
    return enabled;
  }

  function setEnabled(on) {
    on = !!on;
    if (on === enabled) {
      // Already in the requested state. Turning it on again must still make
      // sure the worker exists, because a previous off may have torn it down.
      if (!on) { cancelPreload(); return Promise.resolve(); }
      explicitChoice = true;
      cancelPreload();
      return load().catch(function () {});
    }

    enabled = on;
    explicitChoice = true;

    if (on) {
      // Bring the service up. The model is loaded once and then stays
      // resident: no timer may unload it again, so the next press is fast.
      cancelPreload();
      return load().then(function () {
        return storeEnabled(true);
      }).catch(function (e) {
        // The load failed, but the switch is still on: the next attempt may
        // succeed. Keep the flag and report the failure to the caller.
        storeEnabled(true);
        throw e;
      });
    }

    // Turning the service off: stop everything before the flag flips the
    // gates shut, so nothing new can start while the teardown runs.
    // A pending preload is cancelled here, not left to fire into a closed
    // door: the model must not come up resident with the service off.
    cancelPreload();
    return teardown(DISABLED_MSG, true).then(function () {
      return storeEnabled(false);
    });
  }

  // ---- background preload -------------------------------------------------
  // Nothing was loaded until the user asked for a transcription, so the first
  // press paid the whole model read: ~15-20 s before the mic even opened.
  // Preloading moves that wait off the press and into the idle time after
  // startup, where a slow disk read costs nobody anything.
  var preloadTimer = null;

  function cancelPreload() {
    if (preloadTimer) { clearTimeout(preloadTimer); preloadTimer = null; }
  }

  function preloadScheduled() {
    return !!preloadTimer;
  }

  // A load is already on its way: a worker exists, a pipeline exists, or a
  // promise for one is pending. The memoised workerLoadPromise is what makes
  // a second 'load' post impossible.
  function loadInFlight() {
    return !!(worker || pipe || pipePromise || workerLoadPromise);
  }

  function schedulePreload() {
    if (preloadTimer) return;
    preloadTimer = setTimeout(function () {
      preloadTimer = null;
      // The switch may have flipped while the timer was pending.
      if (!enabled || loadInFlight()) return;
      // Silent on purpose: the user never asked for this load, so a failure
      // has nobody to report to. The next explicit action retries and
      // reports properly.
      load().catch(function () {});
    }, PRELOAD_DELAY_MS);
  }

  // Load now instead of waiting out the delay. The Settings toggle uses it,
  // and the tests use it. Resolves false when the load was skipped or failed.
  // load() is memoised, so calling it while a load is in flight joins that
  // load instead of posting a second 'load'.
  function preloadNow() {
    cancelPreload();
    if (!enabled) return Promise.resolve(false);
    return load().then(function () { return true; }).catch(function () { return false; });
  }

  // Warm the pipeline up in the background while the user is still talking.
  // The recording and the model read then overlap instead of running one
  // after the other, which is the whole reason the preload existed. It is
  // called from the hotkey handler, not from startup, so an app that is
  // never spoken to never pays for the model.
  function warmUp() {
    return preloadNow();
  }

  // ---- worker -------------------------------------------------------------
  // The pipeline runs inside dn-whisper-worker.js. Everything the renderer
  // needs (recording, trimming, normalising, the dictionary) stays here; only
  // inference crosses the thread boundary.
  var worker = null;
  var workerBroken = false;
  var pendingJob = null;     // {resolve, reject} for the in-flight transcription
  var tokenCb = null;        // optional streaming callback for the UI
  var loadWaiters = [];      // resolve/reject pairs waiting on the worker load
  var guardTimer = null;     // the 90 s watchdog for the in-flight job

  function workerFail(why) {
    // A dead worker must not take STT with it: drop to the inline pipeline.
    workerBroken = true;
    // One line, then carry on: the inline path is slower but still works.
    try { console.warn('[dnWhisper] worker gagal, pakai inference langsung: ' + why); } catch (_) {}
    try { if (worker) worker.terminate(); } catch (_) {}
    worker = null;
    if (why) lastError = 'worker: ' + why;
    var p = pendingJob;
    pendingJob = null;
    if (p) { try { p.reject(new Error(why || 'worker failed')); } catch (_) {} }
  }

  function startWorker() {
    if (worker || workerBroken) return worker;
    try {
      worker = new Worker('/dn-whisper-worker.js');
    } catch (e) {
      // File worker rejected (scheme/policy). Try the blob route once; if that
      // also fails the inline path takes over on the next transcribe().
      try {
        var src = null;
        var xhr = new XMLHttpRequest();
        xhr.open('GET', '/dn-whisper-worker.js', false);   // sync: constructor must be sync
        xhr.send(null);
        if (xhr.status === 200 || xhr.status === 0) src = xhr.responseText;
        if (!src) throw new Error('worker source unavailable');
        var blobUrl = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
        worker = new Worker(blobUrl);
      } catch (e2) {
        workerFail((e && e.message) || (e2 && e2.message) || 'cannot create worker');
        return null;
      }
    }

    worker.onmessage = function (ev) {
      var d = ev && ev.data ? ev.data : {};
      if (d.ev === 'status') {
        // The switch may have been flipped off while this worker was still
        // loading. A load cannot be cancelled, so the model would come up
        // resident with nobody waiting for it: kill the worker on arrival
        // instead of leaving the memory behind.
        if (!enabled && (d.state === 'ready' || d.state === 'error')) {
          try { worker.terminate(); } catch (_) {}
          worker = null;
          setState('idle');
          var late = loadWaiters; loadWaiters = [];
          for (var k = 0; k < late.length; k++) { try { late[k](new Error(DISABLED_MSG)); } catch (_) {} }
          return;
        }
        if (d.state === 'ready') { setState('ready'); }
        else if (d.state === 'loading') { setState('loading'); }
        else if (d.state === 'idle') { setState('idle'); }
        else if (d.state === 'error') { setState('error'); }
        if (d.state === 'ready' || d.state === 'error') {
          var wait = loadWaiters; loadWaiters = [];
          for (var i = 0; i < wait.length; i++) { try { wait[i](); } catch (_) {} }
        }
      } else if (d.ev === 'progress') {
        if (loadProgress) {
          try { loadProgress({ status: 'progress', progress: d.pct || 0, file: d.file || '' }); } catch (_) {}
        }
      } else if (d.ev === 'token') {
        if (tokenCb) { try { tokenCb(String(d.text || '')); } catch (_) {} }
      } else if (d.ev === 'done') {
        var job = pendingJob;
        pendingJob = null;
        var raw = String(d.raw || '');
        if (job) {
          try {
            job.resolve({
              // applyFixes must run here too: the worker returns raw text, and
              // the inline path's cleanText() is not part of this route.
              text: applyFixes(cleanFillers(raw)),
              raw: raw,
              ms: d.ms || 0
            });
          } catch (e) { try { job.reject(e); } catch (_) {} }
        }
        resetIdleUnloadTimer();
      } else if (d.ev === 'error') {
        var j = pendingJob;
        pendingJob = null;
        setState('error');
        lastError = d.msg || 'worker error';
        if (j) { try { j.reject(new Error(lastError)); } catch (_) {} }
      }
    };
    worker.onerror = function (e) {
      workerFail((e && e.message) || 'worker runtime error');
    };
    return worker;
  }

  var loadProgress = null;
  var workerLoadPromise = null;   // memoised: a second Uji must not re-post 'load'
  var sessionActive = false;      // one record+transcribe at a time

  function transcribeViaWorker(audio) {
    // Rejecting while busy is correct: the worker is a single-slot pipeline, so
    // queueing would silently attribute the FIRST result to the SECOND request.
    // What must never happen is the flag sticking, so every exit clears it and
    // the 90 s guard is the backstop for a worker that dies without a message.
    if (pendingJob) {
      return Promise.reject(new Error('masih memproses, tunggu sebentar'));
    }
    return new Promise(function (resolve, reject) {
      var settled = false;
      var guard = setTimeout(function () {
        if (settled) return;
        settled = true;
        guardTimer = null;
        pendingJob = null;
        reject(new Error('transkripsi timeout (90 detik)'));
      }, 90000);
      // The handle lives outside the closure so a teardown can cancel the
      // watchdog; otherwise it would fire later against a dead worker.
      guardTimer = guard;

      pendingJob = {
        resolve: function (v) { if (settled) return; settled = true; clearTimeout(guard); guardTimer = null; pendingJob = null; resolve(v); },
        reject: function (e) { if (settled) return; settled = true; clearTimeout(guard); guardTimer = null; pendingJob = null; reject(e); }
      };
      try {
        // Copy before transferring: postMessage moves the buffer, which would
        // leave the caller holding a detached array if it still needs it.
        var copy = new Float32Array(audio.length);
        copy.set(audio);
        worker.postMessage({ cmd: 'transcribe', audio: copy }, [copy.buffer]);
      } catch (e) {
        pendingJob = null;
        clearTimeout(guard);
        reject(e);
      }
    });
  }

  function setState(s) { state = s; }

  function status() { return state; }
  function isLoaded() { return !!pipe || (!!worker && state === 'ready'); }
  function isLoading() { return state === 'loading'; }
  function error() { return lastError; }

  // ---- library + pipeline -------------------------------------------------

  function getLib() {
    if (libPromise) return libPromise;
    libPromise = import(TRANSFORMERS_URL).then(function (mod) {
      var env = mod.env;
      // Never reach out to the HuggingFace hub: the model ships inside the app.
      env.allowRemoteModels = false;
      env.allowLocalModels = true;
      env.localModelPath = MODEL_PATH;
      // C: has ~2 GB free. Every cache path lands in %APPDATA%\DeskNotch, so
      // all of them stay off: the model ships in the asar, and the WASM
      // runtime is fetched fresh (useWasmCache would add ~10 MB to C:).
      env.useBrowserCache = false;
      env.useWasmCache = false;
      // No COOP/COEP headers exist in this app, so SharedArrayBuffer is
      // unavailable; multi-threaded WASM would fail outright.
      try {
        var ort = env.backends && env.backends.onnx;
        if (ort) {
          if (!ort.wasm) ort.wasm = {};
          ort.wasm.numThreads = 1;
          ort.wasm.proxy = false;
          // Only fill this in when the library has not already done so. In a
          // plain renderer transformers sets wasmPaths itself from the ORT env
          // and that value is known-good; overriding it with a guessed shape
          // could break the very fallback path that exists to save us.
          if (!ort.wasm.wasmPaths) {
            var ver = (ort.versions && ort.versions.web) || '1.31.0-dev.20260914-8d85527a0';
            var base = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@' + ver + '/dist/';
            ort.wasm.wasmPaths = {
              mjs: base + 'ort-wasm-simd-threaded.asyncify.mjs',
              wasm: base + 'ort-wasm-simd-threaded.asyncify.wasm'
            };
          }
        }
      } catch (_) {}
      return mod;
    }).catch(function (e) {
      libPromise = null;
      lastError = 'library: ' + (e && e.message ? e.message : e);
      throw e;
    });
    return libPromise;
  }

  // ---- native GPU path -----------------------------------------------------
  // whisper.cpp runs in the Rust process (Vulkan when the build has it, CPU
  // otherwise). The WASM model never loads when this is available, so idle
  // RAM stays at the app baseline and the renderer never holds a pipeline.
  var nativeOk = null;      // null = not probed yet
  var nativeBroken = false; // set after one native failure: fall back for good

  function probeNative() {
    if (nativeOk !== null) return Promise.resolve(nativeOk);
    if (!(window.bridge && typeof window.bridge.invoke === 'function')) {
      nativeOk = false;
      return Promise.resolve(false);
    }
    return window.bridge.invoke('voice:gpu_check').then(function (r) {
      nativeOk = !!(r && r.ok);
      if (nativeOk) { try { setState('ready'); } catch (_) {} }
      return nativeOk;
    }).catch(function () {
      nativeOk = false;
      return false;
    });
  }

  function transcribeViaNative(audio) {
    if (pendingJob) {
      return Promise.reject(new Error('masih memproses, tunggu sebentar'));
    }
    var t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    var f32 = new Float32Array(audio.length);
    f32.set(audio);
    var bytes = new Uint8Array(f32.buffer);
    var bin = '';
    var CH = 0x8000;
    for (var i = 0; i < bytes.length; i += CH) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CH, bytes.length)));
    }
    var pcmB64 = btoa(bin);
    return new Promise(function (resolve, reject) {
      var settled = false;
      var guard = setTimeout(function () {
        if (settled) return;
        settled = true;
        reject(new Error('transkripsi timeout (120 detik)'));
      }, 120000);
      window.bridge.invoke('voice:transcribe', { pcm_b64: pcmB64, lang: 'id' }).then(function (r) {
        if (settled) return;
        settled = true;
        clearTimeout(guard);
        var raw = r && r.text ? String(r.text) : '';
        var t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        resolve({
          text: applyFixes(cleanFillers(raw.trim())),
          raw: raw.trim(),
          ms: Math.round(t1 - t0)
        });
      }).catch(function (e) {
        if (settled) return;
        settled = true;
        clearTimeout(guard);
        reject(e);
      });
    }).catch(function (e) {
      // One native failure stops trusting it: the WASM worker stays as the
      // permanent fallback so STT never dies silently.
      nativeBroken = true;
      if (worker) return transcribeViaWorker(audio);
      return load().then(function () { return transcribeViaWorker(audio); });
    });
  }

  function load(onProgress) {
    // The switch is the only gate: nothing may pull the model in behind the
    // user's back while the service is off.
    if (!enabled) return Promise.reject(new Error(DISABLED_MSG));
    // Native path: nothing to load here — the Rust engine loads its model on
    // the first transcription and unloads it again after five idle minutes.
    if (nativeOk === null) {
      return probeNative().then(function (ok) {
        return ok ? undefined : load(onProgress);
      });
    }
    if (nativeOk) return Promise.resolve();
    // Worker path first. The model is loaded once inside the worker and stays
    // there; the renderer never holds a pipeline of its own unless the worker
    // could not be created at all.
    if (!workerBroken) {
      var w = startWorker();
      if (w) {
        if (onProgress) loadProgress = onProgress;
        if (state === 'ready') return Promise.resolve();
        // Memoised. Without this, every Uji while the model is still loading
        // posts another 'load' and adds another waiter; when 'ready' finally
        // arrives all of them resolve, and two transcriptions race into the
        // single-slot worker — the second one reports "already running".
        if (workerLoadPromise) return workerLoadPromise;
        workerLoadPromise = new Promise(function (resolve, reject) {
          // The waiter takes an optional error: a teardown must reject it, not
          // just drop it, or the caller's load() would never settle.
          loadWaiters.push(function (err) {
            workerLoadPromise = null;
            if (err) { reject(err); return; }
            if (state === 'ready') resolve();
            else reject(new Error(lastError || 'worker load failed'));
          });
          try { w.postMessage({ cmd: 'load' }); } catch (e) {
            workerLoadPromise = null;
            reject(e);
          }
        });
        return workerLoadPromise;
      }
    }

    if (pipe) { setState('ready'); return Promise.resolve(); }
    if (pipePromise) return pipePromise;

    setState('loading');
    lastError = null;

    pipePromise = getLib().then(function (mod) {
      return mod.pipeline('automatic-speech-recognition', MODEL_ID, {
        dtype: 'q8',
        device: 'wasm',
        progress_callback: function (p) {
          if (!onProgress) return;
          try {
            onProgress({
              status: p && p.status ? p.status : 'progress',
              progress: p && typeof p.progress === 'number' ? p.progress : 0,
              file: p && p.file ? String(p.file) : ''
            });
          } catch (_) {}
        }
      });
    }).then(function (p) {
      pipe = p;
      setState('ready');
      return p;
    }).catch(function (e) {
      pipePromise = null;
      lastError = (e && e.message) ? e.message : String(e);
      setState('error');
      throw e;
    });

    return pipePromise;
  }

  // Shared teardown. Everything that can hold a thread, a mic or a model
  // alive has to go, otherwise "service mati" only looks like it worked: the
  // worker would keep its ~250 MB ORT heap, the Windows mic indicator would
  // stay lit, and a pending caller would wait for a result that never comes.
  // hard=true terminates the worker thread; the soft path (plain unload)
  // only asks the worker to release its pipeline and keeps the thread.
  function teardown(reason, hard) {
    // A pending session must not survive: its result would arrive with no
    // model behind it, and sessionActive would stay stuck.
    sessionActive = false;

    if (hard) {
      // The PTT module owns its OWN capture stream (its vadStream and its own
      // AudioContext), which this file cannot reach. It has to be stopped by
      // contract, before the teardown, or its stream stays open and its
      // doStop() would later call load() and transcribe() again.
      try {
        if (window && window.dnPtt && typeof window.dnPtt.stop === 'function') {
          window.dnPtt.stop();
        }
      } catch (_) {}

      // The mic is part of the service: a live capture stream keeps the
      // Windows indicator on, which reads as a privacy bug.
      releaseMic();
      // The captured samples go with it: a half-finished recording must not
      // be handed to the next session.
      chunks = [];
      recordedSamples = 0;
      peak = 0;
      sumSq = 0;
      nativeRate = 0;
    }

    // Cancel the 90 s watchdog so it cannot fire against a dead worker.
    if (guardTimer) { clearTimeout(guardTimer); guardTimer = null; }

    // Drop any in-flight job: after a teardown the worker has no pipeline, so
    // a late 'done' would resolve a caller that no longer has a result.
    if (pendingJob) {
      var stale = pendingJob;
      pendingJob = null;
      try { stale.reject(new Error(reason || 'model di-unload')); } catch (_) {}
    }

    // Reject the load waiters before dropping them: otherwise the caller's
    // load() promise would hang forever, because the 'ready' event that would
    // settle it now arrives against an empty waiter list.
    var wait = loadWaiters;
    loadWaiters = [];
    workerLoadPromise = null;
    for (var i = 0; i < wait.length; i++) {
      try { wait[i](new Error(reason || 'model di-unload')); } catch (_) {}
    }

    if (worker) {
      if (hard) {
        // Terminate, do not just ask nicely: posting {cmd:'unload'} leaves the
        // worker thread and its ORT WASM heap resident.
        var w = worker;
        worker = null;
        try { w.terminate(); } catch (_) {}
        // A terminated worker must not be treated as broken: the next enable
        // starts a fresh one instead of falling back to the inline pipeline.
        workerBroken = false;
      } else {
        try { worker.postMessage({ cmd: 'unload' }); } catch (_) {}
      }
    }

    // The inline fallback pipeline, if it exists, has to go too.
    var p = pipe;
    pipe = null;
    pipePromise = null;

    setState('idle');
    try { if (p && p.dispose) return Promise.resolve(p.dispose()); } catch (_) {}
    return Promise.resolve();
  }

  var idleUnloadTimer = null;
  var IDLE_UNLOAD_MS = 60000; // 60 seconds after last transcription, terminate WASM worker to free ~1GB RAM

  function cancelIdleUnload() {
    if (idleUnloadTimer) { clearTimeout(idleUnloadTimer); idleUnloadTimer = null; }
  }

  function resetIdleUnloadTimer() {
    cancelIdleUnload();
    idleUnloadTimer = setTimeout(function () {
      idleUnloadTimer = null;
      if (worker && !pendingJob) {
        try { console.log('[dnWhisper] Idle 60s: terminating worker to reclaim ~1GB RAM'); } catch (_) {}
        unload();
      }
    }, IDLE_UNLOAD_MS);
  }

  function unload() {
    cancelIdleUnload();
    return teardown('model di-unload', true);
  }

  // Whisper is trained on loud, close-mic speech. A laptop mic 30 cm away
  // yields levels around 0.01-0.05 peak, which the model reads as murmur and
  // answers with invented text. Normalising to a healthy peak fixes most of
  // the "mas kancest ya" style output without touching the model.
  function normalize(audio, targetPeak) {
    var max = 0;
    for (var i = 0; i < audio.length; i++) {
      var v = audio[i] < 0 ? -audio[i]: audio[i];
      if (v > max) max = v;
    }
    if (max < 1e-6) return { audio: audio, gain: 1, peak: max };
    // Gain cap 40 -> 60. At 40 the user still had to lean towards the laptop;
    // speech peaking at 0.012 needs 70x to reach 0.85, so 60 covers "normal
    // sitting distance" without amplifying pure room tone (peak < 0.001 stays
    // below the silence gate in recordAndTranscribe).
    var gain = Math.min(targetPeak / max, 60);
    var out = new Float32Array(audio.length);
    for (var j = 0; j < audio.length; j++) out[j] = audio[j] * gain;
    return { audio: out, gain: gain, peak: max };
  }

  // Drop leading/trailing silence. Whisper invents phrases when a clip starts
  // with 2 seconds of room tone, which is exactly what a 5 s fixed window does.
  // Threshold is adaptive: a fixed 0.008 clips soft speech entirely when the
  // user talks from a metre away, but a fixed low bar keeps hiss in.
  // 12% -> 8% of peak: the old ratio was shaving quiet opening consonants
  // ("buka" heard as "uka"), which cost more than the extra room tone it kept.
  function trimSilence(audio, rate) {
    var peak = 0;
    for (var k = 0; k < audio.length; k++) {
      var v0 = audio[k] < 0 ? -audio[k] : audio[k];
      if (v0 > peak) peak = v0;
    }
    var threshold = Math.max(0.0015, peak * 0.08);
    var i = 0;
    while (i < audio.length && Math.abs(audio[i]) < threshold) i++;
    var j = audio.length - 1;
    while (j > i && Math.abs(audio[j]) < threshold) j--;
    if (j <= i) return audio;
    // keep 150 ms of margin on each side so consonants are not clipped
    var pad = Math.floor(rate * 0.15);
    var from = Math.max(0, i - pad);
    var to = Math.min(audio.length, j + pad);
    return audio.subarray(from, to);
  }

  // ---- filler cleanup -----------------------------------------------------
  // People hesitate while thinking, and Whisper transcribes hesitation
  // faithfully: "suka, mmmm, kamu". The intent parser should receive the
  // sentence, not the thinking noise. Word boundaries keep real words intact
  // (e.g. "umum", "zoom" are untouched).
  //   u+h*m+   um, uhm, uum
  //   u+h+     uh
  //   e+r+m*   er, erm
  //   e+m{2,}  emm, emmm
  //   a+h+     ah
  //   h+m+     hm, hmm
  //   m+h+m+   mhm, mhmm
  //   m{2,}    mm, mmm, mmmm   (DotPal's pattern misses this one)
  //   e{2,}    ee, eee
  //   a{3,}    aaa
  var FILLER_SRC = '\\b(?:u+h*m+|u+h+|e+r+m*|e+m{2,}|a+h+|h+m+|m+h+m+|m{2,}|e{2,}|a{3,})\\b';
  var FILLER_RE = new RegExp('[,;]?\\s*' + FILLER_SRC + '\\s*[,;]?', 'gi');

  // ---- domain corrections ------------------------------------------------
  // whisper-small gets most desktop words right on its own, so these entries
  // are a secondary safety net for the near-misses that survive a bigger
  // model: "buat kan ya tual" for "buatkan jadwal", "toylet" for "toilet".
  // Only whole words are replaced, and only when the model output matches the
  // known wrong form exactly.
  var FIXES = [
    // scheduling / office
    ['tual', 'jadwal'], ['jadual', 'jadwal'], ['schedul', 'jadwal'],
    ['meeting', 'meeting'], ['meting', 'meeting'], ['mitink', 'meeting'],
    // common Indonesian that Whisper splits or misspells
    ['toylet', 'toilet'], ['toilet', 'toilet'],
    ['krom', 'chrome'], ['kroom', 'chrome'], ['crome', 'chrome'],
    // live test 2026-10-24: "Apakah Ferrari meyerek mobil terkenjang?"
    ['meyerek', 'merek'], ['terkenjang', 'terkencang'], ['terkenjan', 'terkencang'],
    // live test 2026-10-25: windah basudara, whatsapp, etc.
    ['winda basuh darah', 'windah basudara'], ['windah basuh darah', 'windah basudara'],
    ['winda basuh udara', 'windah basudara'], ['windah basuh udara', 'windah basudara'],
    ['winda basudara', 'windah basudara'], ['basuh darah', 'basudara'],
    ['watch up', 'whatsapp'], ['wats up', 'whatsapp'], ['wat sap', 'whatsapp'],
    ['di whatsappnya', 'di whatsapp'], ['di whats up', 'di whatsapp'],
    ['yutub', 'youtube'], ['youtube', 'youtube'], ['yutube', 'youtube'],
    ['whatsap', 'whatsapp'], ['watsap', 'whatsapp'], ['whatsapp', 'whatsapp'],
    ['gugel', 'google'], ['gogle', 'google'], ['google', 'google'],
    ['vscod', 'vscode'], ['vs code', 'vscode'],
    ['exploler', 'explorer'], ['explorer', 'explorer'],
    ['apk', 'aplikasi'], ['aplikasion', 'aplikasi'],
    // split words Whisper produces for "buatkan"
    ['buat kan', 'buatkan'], ['buatkan', 'buatkan'],
    // user test r20, 2026-10-21 (8 recorded trials, 5 with mangled words)
    // "buka note pad" -> "Buka ngepad"/"Bukan not bad"/"Buka nattet".
    // "not bad" is legitimate English, so it is deliberately NOT listed.
    ['ngepad', 'notepad'], ['nottet', 'notepad'],
    ['note pad', 'notepad'], ['noteped', 'notepad'], ['nattet', 'notepad'],
    // "putar lagu hindia" -> "Putar Langguh India"
    // Longest-phrase-first. No standalone 'india' entry: the pass is chained,
    // so a second entry would double-replace the result of the first fix.
    ['langguh india', 'hindia'], ['langguh', 'hindia'],
    // "setel lagu balonku" -> "Setelah gua balon puri"
    // Only the full observed phrase is rewritten: "setelah gua pergi" is
    // ordinary Indonesian and must survive untouched.
    ['setelah gua balon puri', 'setel balonku'],
    ['setelah gue balon puri', 'setel balonku'],
    ['balon puri', 'balonku'],
    ['balonku', 'balonku'], ['balon ku', 'balonku'],
    // "buka spotify" came out clean, near-misses still get pre-empted
    ['spotipai', 'spotify'], ['spotipai', 'spotify'], ['spaceteam', 'spotify'],
    ['spotifai', 'spotify'], ['spotify', 'spotify'],
    // "buka aplikasi excel"/"cari file excel" were clean; common near-misses
    ['ekcel', 'excel'], ['exsel', 'excel'], ['excel', 'excel'],
    // fangless "kendalikan" style verbs heard in the same session
    ['putarin', 'putar'], ['putarkan', 'putar'],
    // whisper-small live test 2026-10-21, second round
    // "buatkan saya reminder untuk jam 10" -> "remainder"
    ['remainder', 'reminder'],
    // "bantu saya menulis proposal di Word" -> "Banti ... di war"
    ['banti', 'bantu'],
    // Phrase form only: bare "war" is a real English word, while "di war"
    // is not valid Indonesian at all.
    ['di war', 'di Word'],
    // "buatkan to do list" -> "Buatkan tu duis"
    // Whole phrases, longest first, so "tu du" cannot eat the longer forms.
    ['to due list', 'to do list'], ['tu duis', 'to do list'],
    ['tu du list', 'to do list'], ['tudulis', 'to do list'],
    ['tu duilis', 'to do list'], ['tuh dulis', 'to do list'],
    ['tu dulist', 'to do list'], ['to do lis', 'to do list'],
    ['tu du', 'to do'],
    // third round, 2026-10-21: "siapa presiden Indonesia ke-1" -> "keresiden"
    ['keresiden', 'presiden'],
    // app name normalisation heard in the same round
    ['z-code', 'ZCode'], ['z code', 'ZCode'],
    // live test 2026-10-24: dictation prompts and voice commands
    ['bukatan apitasi', 'buka aplikasi'],
    ['apitasi', 'aplikasi'],
    ['bukein', 'buka'],
    ['bupa prom', 'buka chrome'],
    ['bu ka trom', 'buka chrome'],
    ['dikteknya', 'diktenya'],
    ['diktek', 'dikte'],
    ['lago', 'lagu'],
    // runtime log 2026-10-24: "Putar video windah basuh udara paling
    // terbaru." The surname "basudara" is heard as the split pair
    // "basuh udara". Longest first so the full name wins over the pair.
    ['windah basuh udara', 'windah basudara'],
    ['basuh udara', 'basudara'],
    ['basu udara', 'basudara'],
  ];
  // Build one regex: longest phrases first so "vs code" wins over "code".
  var FIX_MAP = {};
  FIXES.forEach(function (pair) { FIX_MAP[pair[0]] = pair[1]; });
  var FIX_KEYS = Object.keys(FIX_MAP).sort(function (a, b) { return b.length - a.length; });
  var FIX_RE = new RegExp('\\b(?:' + FIX_KEYS.map(function (k) {
    return k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('|') + ')\\b', 'gi');

  // Case-folding must match the /i flags above: 'I'.toLowerCase() in this --
  // runtime folds to 'i' only under the default (non-Turkish) locale, and the
  // locale is user-dependent, so the key is pre-folded there instead of here.
  function applyFixes(text) {
    if (!text) return '';
    return String(text).replace(FIX_RE, function (m) {
      var key = m.charAt(0) + m.slice(1).toLowerCase();
      var fixed = FIX_MAP[key.toLowerCase()];
      if (!fixed) return m;
      // Preserve the original capitalisation of the first letter.
      var isUpper = m.charAt(0) === m.charAt(0).toUpperCase();
      return isUpper ? fixed.charAt(0).toUpperCase() + fixed.slice(1) : fixed;
    });
  }

  function cleanFillers(text) {
    if (!text) return '';
    var out = String(text)
      // Keep one comma when the filler sat between commas: "suka, mmmm, kamu"
      // reads better as "suka, kamu" than "suka kamu".
      .replace(FILLER_RE, function (m) { return /[,;]/.test(m) ? ', ' : ' '; })
      // Indonesian hesitation phrase. This one is position-sensitive:
      //   "hmm apa namanya saya mau pergi"   -> filler, drop it
      //   "hewan terbang apa namanya?"      -> part of the question, keep it
      // So it is only removed when at least two words follow it.
      .replace(/[,;]?\s*\b(?:apa\s+namanya|gimana\s+ya(?:h)?)\b\s*[,;]?\s*(?=\S+\s+\S+)/gi, ' ')
      // Standalone "ya"/"yah" between words is hesitation ("buatkan ya jadwal").
      // At the end of a sentence it is a question tag and must stay.
      .replace(/\s+\b(?:ya|yah)\b\s+(?=\S)/gi, ' ')
      .replace(/\s{2,}/g, ' ')
      .replace(/\s+([,.!?])/g, '$1')
      .replace(/([,;])\s*(?=[,;])/g, '')
      .replace(/([,.!?])\1+/g, '$1')
      .replace(/^[\s,;.]+/, '')
      .replace(/[\s,;]+$/, '')
      .trim();
    if (out) out = out.charAt(0).toUpperCase() + out.slice(1);
    // Dictionary pass runs last so fillers cannot split a known phrase first.
    return applyFixes(out);
  }

  function transcribe(audio, opts) {
    opts = opts || {};
    if (!enabled) return Promise.reject(new Error(DISABLED_MSG));
    if (!audio || !audio.length) return Promise.reject(new Error('no audio'));

    // Native GPU path first; the WASM worker below stays as the fallback.
    if (nativeOk === null) {
      return probeNative().then(function (ok) {
        return ok ? transcribeViaNative(audio) : transcribe(audio, opts);
      });
    }
    if (nativeOk && !nativeBroken) return transcribeViaNative(audio);

    // Worker path: the model lives in dn-whisper-worker.js so inference cannot
    // block the notch. The inline path below is kept as a fallback for the
    // case where Worker construction fails (custom scheme restrictions on an
    // older Electron, or a hardened policy) — STT must never die silently.
    if (worker) return transcribeViaWorker(audio);

    if (!pipe) return Promise.reject(new Error('model not loaded'));
    var t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    return pipe(audio, {
      language: 'indonesian',
      task: 'transcribe',
      chunk_length_s: 30
    }).then(function (out) {
      var text = '';
      if (typeof out === 'string') text = out;
      else if (out && typeof out.text === 'string') text = out.text;
      else if (Array.isArray(out) && out[0] && typeof out[0].text === 'string') text = out[0].text;
      var t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      return { text: cleanFillers(String(text).trim()), raw: String(text).trim(), ms: Math.round(t1 - t0) };
    }).catch(function (e) {
      // An ORT session that failed mid-inference is not reusable: keeping it
      // would make every later press hit the same dead session. Drop it so the
      // next attempt reloads cleanly instead of failing forever.
      unload();
      throw e;
    });
  }

  // ---- microphone ---------------------------------------------------------

  var mediaStream = null;
  var audioCtx = null;
  // Mic acquisition is async. Every request carries an epoch; when it
  // resolves we check the epoch again — an abort in between means nobody
  // wants this stream any more, so it is stopped instead of kept alive.
  var micEpoch = 0;
  var wantMic = false;
  var micWatchdog = null;
  var sourceNode = null;
  var procNode = null;
  var chunks = [];
  var recordedSamples = 0;
  var peak = 0;
  var sumSq = 0;
  var nativeRate = 0;

  function releaseMic() {
    try { if (procNode) { procNode.onaudioprocess = null; procNode.disconnect(); } } catch (_) {}
    try { if (sourceNode) sourceNode.disconnect(); } catch (_) {}
    try { if (audioCtx && audioCtx.state !== 'closed') audioCtx.close(); } catch (_) {}
    try {
      if (mediaStream) {
        var tracks = mediaStream.getTracks();
        for (var i = 0; i < tracks.length; i++) { try { tracks[i].stop(); } catch (_) {} }
      }
    } catch (_) {}
    mediaStream = null;
    audioCtx = null;
    sourceNode = null;
    procNode = null;
    // Nobody wants the mic any more: invalidate an acquisition that is still
    // in flight so it closes itself instead of opening after the fact.
    wantMic = false;
    micEpoch++;
  }

  // Linear resampler: Whisper wants 16 kHz mono. Forcing AudioContext to
  // 16000 Hz is unreliable on Windows (the driver may refuse or the graph may
  // stay suspended), so we capture at the device's native rate and convert.
  function resample(input, from, to) {
    if (!input.length || from === to) return input;
    var ratio = from / to;
    var outLen = Math.floor(input.length / ratio);
    var out = new Float32Array(outLen);
    for (var i = 0; i < outLen; i++) {
      var pos = i * ratio;
      var i0 = Math.floor(pos);
      var i1 = i0 + 1 < input.length ? i0 + 1 : i0;
      var frac = pos - i0;
      out[i] = input[i0] * (1 - frac) + input[i1] * frac;
    }
    return out;
  }

  function startRecording() {
    cancelIdleUnload();
    // The mic is part of the service: opening it while the service is off
    // would keep the Windows capture indicator lit for no reason.
    if (!enabled) return Promise.reject(new Error(DISABLED_MSG));
    if (mediaStream) return Promise.resolve();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setState('unsupported');
      return Promise.reject(new Error('mic API tidak tersedia'));
    }
    chunks = [];
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
      mediaStream = stream;
      var Ctx = window.AudioContext || window.webkitAudioContext;
      // No sampleRate override: some Windows drivers reject 16000 and leave
      // the graph silent. Capture natively, resample afterwards.
      audioCtx = new Ctx();
      nativeRate = audioCtx.sampleRate || SAMPLE_RATE;
      // A context created outside a user gesture starts suspended, and a
      // suspended graph never fires onaudioprocess.
      if (audioCtx.state === 'suspended' && audioCtx.resume) {
        try { audioCtx.resume(); } catch (_) {}
      }
      sourceNode = audioCtx.createMediaStreamSource(stream);
      // ScriptProcessor is deprecated but needs no separate worklet file and
      // works on a plain app:// origin without module bundling.
      procNode = audioCtx.createScriptProcessor(4096, 1, 1);
      procNode.onaudioprocess = function (ev) {
        var input = ev.inputBuffer.getChannelData(0);
        var copy = new Float32Array(input.length);
        copy.set(input);
        chunks.push(copy);
        recordedSamples += copy.length;
        for (var i = 0; i < input.length; i++) {
          var v = input[i] < 0 ? -input[i] : input[i];
          if (v > peak) peak = v;
          sumSq += input[i] * input[i];
        }
      };
      sourceNode.connect(procNode);
      procNode.connect(audioCtx.destination);
    }).catch(function (e) {
      releaseMic();
      var name = e && e.name ? e.name : '';
      var msg = name === 'NotAllowedError' ? 'mic diblokir Windows/Electron'
        : name === 'NotFoundError' ? 'mic tidak ditemukan'
        : (e && e.message) ? e.message : String(e);
      lastError = msg;
      throw new Error(msg);
    });
  }

  // Safety net: a stream that is open while nobody asked for one is a leak.
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

  function stopRecording() {
    // Nobody wants the mic any more: invalidate any acquisition still in
    // flight and let the watchdog close a stream that slipped through.
    wantMic = false;
    micEpoch++;
    // Give the audio thread one turn to deliver the last buffer before we tear
    // the graph down; otherwise the final ~256 ms can be lost.
    return new Promise(function (resolve) {
      setTimeout(function () {
        // Always release the device, even when nothing was captured: the
        // Windows mic indicator must go dark on every path.
        var raw;
        if (recordedSamples > 0) {
          raw = new Float32Array(recordedSamples);
          var off = 0;
          for (var i = 0; i < chunks.length; i++) { raw.set(chunks[i], off); off += chunks[i].length; }
        } else {
          raw = new Float32Array(0);
        }
        var info = {
          samples: raw.length,
          rate: nativeRate || SAMPLE_RATE,
          peak: peak,
          rms: raw.length ? Math.sqrt(sumSq / raw.length) : 0
        };
        chunks = [];
        recordedSamples = 0;
        releaseMic();
        var audio = info.rate === SAMPLE_RATE ? raw : resample(raw, info.rate, SAMPLE_RATE);
        info.outSamples = audio.length;
        resolve({ audio: audio, info: info });
      }, 120);
    });
  }

  function recordAndTranscribe(ms, onStatus) {
    var dur = Math.max(1000, Number(ms) || 5000);
    var say = function (s) { try { onStatus && onStatus(s); } catch (_) {} };
    if (!enabled) return Promise.reject(new Error(DISABLED_MSG));
    // One session at a time. Pressing Uji again while the model is still
    // loading used to start a second recorder against the same single-slot
    // worker, and the loser surfaced as "transcription already running" —
    // which reads like a crash but is just a double start.
    if (sessionActive) {
      return Promise.reject(new Error('masih memproses, tunggu sebentar'));
    }
    sessionActive = true;
    return load(function (p) {
      if (p.status === 'progress' && p.progress) say('Memuat model ' + Math.round(p.progress) + '%');
    }).then(function () {
      say('Mendengarkan...');
      return startRecording();
    }).then(function () {
      return new Promise(function (resolve, reject) {
        setTimeout(function () {
          stopRecording().then(resolve, reject);
        }, dur);
      });
    }).then(function (rec) {
      var audio = rec.audio;
      var info = rec.info;
      if (!audio.length) throw new Error('mic tidak menghasilkan audio');

      // Silence gate: a fixed 5 s window nearly always starts and ends with
      // room tone, and Whisper answers room tone with invented sentences.
      var trimmed = trimSilence(audio, SAMPLE_RATE);
      if (!trimmed.length) {
        throw new Error('tidak ada suara terdeteksi (puncak ' + info.peak.toFixed(4) + ')');
      }
      var loud = normalize(trimmed, 0.85);
      if (loud.peak < 0.002) {
        throw new Error('suara terlalu pelan (puncak ' + info.peak.toFixed(4) + ') - cek mic Windows');
      }
      info.trimmedSamples = trimmed.length;
      info.gain = Number(loud.gain.toFixed(2));
      info.peakBefore = Number(loud.peak.toFixed(4));

      // whisper-small needs ~15-30 s per clip on single-thread wasm, and the
      // renderer is blocked for all of it (that is why a per-second ticker is
      // impossible here: no timer fires while WASM computes). Say it up front
      // so a long wait reads as "working", not "hung".
      say('Mentranskripsi... (10-30 detik)');
      return transcribe(loud.audio).then(function (res) {
        res.info = info;
        return res;
      });
    }).then(function (res) {
      sessionActive = false;
      return res;
    }, function (err) {
      // Errors also end the session: otherwise sessionActive would stay true
      // and every later press would be refused.
      sessionActive = false;
      throw err;
    });
  }

  window.dnWhisper = {
    load: load,
    transcribe: transcribe,
    startRecording: startRecording,
    stopRecording: stopRecording,
    recordAndTranscribe: recordAndTranscribe,
    isLoaded: isLoaded,
    isLoading: isLoading,
    status: status,
    error: error,
    unload: unload,
    // The STT service switch. ON keeps the worker and the model resident for
    // as long as the app runs; OFF tears the worker down completely.
    setEnabled: setEnabled,
    isEnabled: isEnabled,
    // The voice view uses this to append tokens as they arrive. Passing null
    // turns streaming off; it is a single slot because only one transcription
    // can run at a time.
    onToken: function (cb) { tokenCb = (typeof cb === 'function') ? cb : null; },
    usesWorker: function () { return !!worker; },
    // Load immediately instead of waiting out the preload delay. Silent and
    // idempotent; resolves false when the service is off or the load failed.
    preloadNow: preloadNow,
    // Same thing, called by the voice hotkey so the model read overlaps with
    // the recording instead of delaying the first transcription.
    warmUp: warmUp,
    MODEL_ID: MODEL_ID,
    SAMPLE_RATE: SAMPLE_RATE
  };

  // Read the stored preference once. The worker is NOT started here: starting
  // is the caller's job (the settings toggle or the first transcription), so
  // a launch does not pay the model load for a feature the user may never use.
  loadStoredEnabled();
  // Schedule the background load only once the stored flag is known, so a
  // disabled service never pays for a model it is not allowed to run.
  // AUTO_PRELOAD is off: the ONNX WASM heap reserves ~1 GB as soon as the
  // pipeline is resident, and a launch that nobody speaks into has no reason
  // to hold that memory. The model is loaded on demand instead - see warmUp()
  // and the first transcription.
  if (AUTO_PRELOAD) {
    Promise.resolve().then(function () {
      if (enabled) schedulePreload();
    });
  }
})();
