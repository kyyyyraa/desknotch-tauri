// r72g: native GPU STT path — whisper.cpp in Rust; WASM worker stays as fallback
const fs = require('fs');
const p = 'ui/dn-whisper.js';
let js = fs.readFileSync(p, 'utf8');
let fail = 0;

function rep(name, from, to) {
  if (!js.includes(from)) { console.error('NOT FOUND [' + name + ']'); fail = 1; return; }
  js = js.split(from).join(to);
  console.log('OK [' + name + ']');
}

const NATIVE_HELPERS = `  // ---- native GPU path -----------------------------------------------------
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

`;

// 1. Insert helpers + native gate in load()
rep('load-head',
  `  function load(onProgress) {
    // The switch is the only gate: nothing may pull the model in behind the
    // user's back while the service is off.
    if (!enabled) return Promise.reject(new Error(DISABLED_MSG));`,
  NATIVE_HELPERS + `  function load(onProgress) {
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
    if (nativeOk) return Promise.resolve();`
);

// 2. Native gate in transcribe()
rep('transcribe-head',
  `  function transcribe(audio, opts) {
    opts = opts || {};
    if (!enabled) return Promise.reject(new Error(DISABLED_MSG));
    if (!audio || !audio.length) return Promise.reject(new Error('no audio'));`,
  `  function transcribe(audio, opts) {
    opts = opts || {};
    if (!enabled) return Promise.reject(new Error(DISABLED_MSG));
    if (!audio || !audio.length) return Promise.reject(new Error('no audio'));

    // Native GPU path first; the WASM worker below stays as the fallback.
    if (nativeOk === null) {
      return probeNative().then(function (ok) {
        return ok ? transcribeViaNative(audio) : transcribe(audio, opts);
      });
    }
    if (nativeOk && !nativeBroken) return transcribeViaNative(audio);`
);

if (fail) process.exit(1);
fs.writeFileSync(p, js, 'utf8');
console.log('r72g dn-whisper patched');
