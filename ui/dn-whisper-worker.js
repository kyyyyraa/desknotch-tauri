// dn-whisper-worker.js - Whisper inference off the renderer thread.
//
// Why this file exists: onnxruntime-web with numThreads=1 runs WASM on the
// calling thread, so every transcription froze the notch for 15-30 s. Moving
// the pipeline here keeps the UI at 60fps and lets approval cards appear while
// audio is still being processed.
//
// Loaded as a classic worker. The library and the model are the same ones
// dn-whisper.js used inline; nothing about the model changed.
//
// Protocol (see dn-whisper.js for the other side):
//   in : {cmd:'load'|'transcribe'|'unload', audio?:Float32Array}
//   out: {ev:'status'|'progress'|'token'|'done'|'error', ...}
(function () {
  'use strict';

  var TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0';
  var MODEL_ID = 'whisper-small';
  var MODEL_PATH = '/dn-models/';

  var pipe = null;
  var pipePromise = null;
  var libMod = null;   // kept for WhisperTextStreamer; the pipeline does not expose it

  function post(msg) {
    try { self.postMessage(msg); } catch (_) {}
  }

  // onnxruntime-web version that transformers 4.3.0 pins in package.json
  // ("onnxruntime-web": "1.31.0-dev.20260914-8d85527a0"). The runtime binary
  // lives in the ORT package, not in the transformers bundle.
  var ORT_VERSION = '1.31.0-dev.20260914-8d85527a0';

  // In a worker the ORT runtime binaries are resolved relative to the worker
  // script URL, not the page. For a blob worker that base is meaningless and
  // for a file worker on app:// it 404s, so wasmPaths is pinned to the CDN.
  //
  // The version is read from the ONNX env (ort.versions.web) so it cannot
  // desync from the library, with the pinned constant as the fallback. The
  // path matters: transformers' own env has no 'versions' key at all.
  function configureEnv(mod) {
    var env = mod.env;
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    env.localModelPath = MODEL_PATH;
    env.useBrowserCache = false;
    env.useWasmCache = false;

    try {
      var ort = env.backends && env.backends.onnx;
      if (ort) {
        if (!ort.wasm) ort.wasm = {};
        ort.wasm.numThreads = 1;   // no SharedArrayBuffer: no COOP/COEP headers
        ort.wasm.proxy = false;    // proxy:true would spawn a nested worker
        // Inside a worker ORT resolves the runtime against the worker script
        // URL, which is meaningless for a blob worker and 404s on app://. The
        // library fills this itself only when ONNX_ENV.versions.web exists, so
        // fill it when empty rather than unconditionally.
        if (!ort.wasm.wasmPaths) {
          var ver = (ort.versions && ort.versions.web) || ORT_VERSION;
          var base = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@' + ver + '/dist/';
          ort.wasm.wasmPaths = {
            mjs: base + 'ort-wasm-simd-threaded.asyncify.mjs',
            wasm: base + 'ort-wasm-simd-threaded.asyncify.wasm'
          };
        }
      }
    } catch (_) {}

    return env;
  }

  var libPromise = null;

  function getLib() {
    if (libPromise) return libPromise;
    libPromise = import(TRANSFORMERS_URL).then(function (mod) {
      configureEnv(mod);
      return mod;
    }).catch(function (e) {
      libPromise = null;
      throw e;
    });
    return libPromise;
  }

  function load() {
    if (pipe) { post({ ev: 'status', state: 'ready' }); return Promise.resolve(); }
    if (pipePromise) return pipePromise;

    post({ ev: 'status', state: 'loading' });

    pipePromise = getLib().then(function (mod) {
      libMod = mod;
      return mod.pipeline('automatic-speech-recognition', MODEL_ID, {
        dtype: 'q8',
        device: 'wasm',
        progress_callback: function (p) {
          // The library also emits a 'ready' event with no percentage; only a
          // real download progress is worth a progress message.
          if (!p || p.status !== 'progress') return;
          post({
            ev: 'progress',
            pct: typeof p.progress === 'number' ? p.progress : 0,
            file: p.file ? String(p.file) : ''
          });
        }
      });
    }).then(function (p) {
      pipe = p;
      post({ ev: 'status', state: 'ready' });
      return p;
    }).catch(function (e) {
      pipePromise = null;
      post({ ev: 'status', state: 'error' });
      post({ ev: 'error', msg: (e && e.message) ? e.message : String(e) });
      throw e;
    });

    return pipePromise;
  }

  // Streaming is best-effort. WhisperTextStreamer exists in 4.3.0 and the
  // tokenizer is reachable as pipe.tokenizer (the base Pipeline class stores
  // it), but the streamer still must not be able to lose a transcription: a
  // failure here degrades to plain transcription instead of throwing.
  function makeStreamer(mod) {
    try {
      if (!mod.WhisperTextStreamer || !pipe || !pipe.tokenizer) return null;
      return new mod.WhisperTextStreamer(pipe.tokenizer, {
        skip_prompt: true,
        callback_function: function (t) {
          if (t) post({ ev: 'token', text: String(t) });
        }
      });
    } catch (_) {
      return null;
    }
  }

  function transcribe(audio) {
    // Every early exit must post an error: the renderer keeps a pending job
    // open until it hears done or error, so a silent rejection here would
    // wedge the next transcription with "already running".
    if (!pipe) {
      post({ ev: 'error', msg: 'model not loaded' });
      return Promise.resolve();
    }
    if (!audio || !audio.length) {
      post({ ev: 'error', msg: 'no audio' });
      return Promise.resolve();
    }

    var t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    var streamer = makeStreamer(libMod);

    var opts = {
      language: 'indonesian',
      task: 'transcribe',
      chunk_length_s: 30
    };
    if (streamer) opts.streamer = streamer;

    return pipe(audio, opts).then(function (out) {
      var text = '';
      if (typeof out === 'string') text = out;
      else if (out && typeof out.text === 'string') text = out.text;
      else if (Array.isArray(out) && out[0] && typeof out[0].text === 'string') text = out[0].text;
      var t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      post({ ev: 'done', text: String(text).trim(), raw: String(text).trim(), ms: Math.round(t1 - t0) });
      return text;
    }).catch(function (e) {
      // A session that failed mid-inference is not reusable; drop it so the
      // next attempt reloads cleanly instead of hitting a dead session.
      var p = pipe;
      pipe = null;
      pipePromise = null;
      try { if (p && p.dispose) p.dispose(); } catch (_) {}
      post({ ev: 'error', msg: (e && e.message) ? e.message : String(e) });
      throw e;
    });
  }

  function unload() {
    var p = pipe;
    pipe = null;
    pipePromise = null;
    try { if (p && p.dispose) p.dispose(); } catch (_) {}
    post({ ev: 'status', state: 'idle' });
  }

  self.onmessage = function (e) {
    var d = e && e.data ? e.data : {};
    if (d.cmd === 'load') {
      load().catch(function () {});
    } else if (d.cmd === 'transcribe') {
      // transcribe() now resolves after posting its own error, so there is
      // nothing to catch here; the .catch stays for unexpected throws.
      transcribe(d.audio).catch(function (err) {
        post({ ev: 'error', msg: (err && err.message) ? err.message : String(err) });
      });
    } else if (d.cmd === 'unload') {
      unload();
    }
  };
})();

