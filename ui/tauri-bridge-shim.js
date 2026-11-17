/*
 * tauri-bridge-shim.js
 *
 * Reproduces the Electron `preload.js` bridge contract on top of the Tauri v2
 * global API, so the existing frontend keeps working unchanged:
 *
 *   bridge.invoke(channel, ...args) -> Promise<result>
 *   bridge.send(channel, data)       -> Promise<void>
 *   bridge.on(channel, callback)     -> unlisten()
 *   bridge.pathOf(file)              -> string
 *
 * Three rules drive the implementation.
 *
 *   1. `invoke` and `send` never reject. The renderer calls them bare in a
 *      dozen places (`void bridge.invoke("media:key", "next")`,
 *      `bridge.invoke("dnai:respond", ...)` inside a `try` block that cannot
 *      see a promise rejection, `bridge.send("dnptt:log", ...)` whose result
 *      nobody awaits). A rejected promise therefore surfaces as an unhandled
 *      rejection and takes the notch down with it. Every transport failure is
 *      folded into a fallback value instead — but never silently: every error
 *      goes to `console.error` and into the `window.__DN_IPC_ERRORS` ring
 *      buffer (max 50 entries) so debugging is possible.
 *
 *   2. The backend answers unknown channels with `null` (see bridge.rs), and
 *      the renderer dereferences some of those results without a guard
 *      (`apps:describe` -> `e.join("|")`, `privacy:get` -> `D.micApps.join()`,
 *      `desktime:screen-time` -> `Z.installed`). Channels listed in
 *      FALLBACKS get a shape-preserving value so a missing backend feature
 *      can never crash the UI. Each fallback substitution is announced via
 *      `console.warn('[DeskNotch IPC fallback used]', channel)` and recorded
 *      in the same ring buffer.
 *
 *   3. Events are delivered as a single `callback(payload)` argument — the
 *      exact value Rust passed to `emit` (object, scalar or null), not
 *      spread. The ONE documented exception is `store:changed`
 *      (src-tauri/src/store.rs emits it as a raw `[key, value]` array and
 *      three renderer listeners are written as `function (key, value)`);
 *      spread applies only to channels listed in TUPLE_CHANNELS or to an
 *      explicit `{ __tupleArgs: [...] }` envelope.
 *
 * This file must be loaded before any other script: the renderer reads
 * `window.bridge` while it boots.
 */
(function () {
  'use strict';

  /**
   * Fallback values for channels whose result the renderer uses without a
   * null check. These are factories rather than plain values so every call
   * hands out a fresh object and callers can safely mutate the result.
   *
   * `store:get` is deliberately absent: there, `null` is the honest answer
   * ("this key was never written"), and the renderer already handles it.
   */
  var FALLBACKS = {
    // --- telemetry / status -------------------------------------------
    'usage:get': function () { return { cpu: 0.05, memory: 0.35, gpu: 0 }; },
    'battery:get': function () { return { level: 1.0, charging: true, supported: false }; },
    'privacy:get': function () {
      return {
        mic: false,
        camera: false,
        micApps: [],
        cameraApps: [],
        wifi: null,
        bluetooth: []
      };
    },
    'ai:limits': function () { return []; },
    'smtc:get': function () { return null; },
    'desktime:screen-time': function () { return { installed: false, ms: null }; },
    // Version mirrors src-tauri/tauri.conf.json.
    'update:get': function () { return { status: 'idle', version: '1.0.5' }; },
    'update:check': function () { return { status: 'idle' }; },
    'notch:tucked': function () { return false; },

    // --- app catalogue -------------------------------------------------
    'apps:top': function () { return []; },
    'apps:all': function () { return []; },
    'apps:describe': function () { return []; },
    'apps:launch': function () { return false; },

    // --- files ---------------------------------------------------------
    'files:describe': function () { return []; },
    'files:search': function () { return []; },
    'files:open': function () { return false; },
    'files:reveal': function () { return false; },

    // --- shell ---------------------------------------------------------
    'dn:shell': function () { return { ok: false, code: 1, out: '' }; },

    // --- system --------------------------------------------------------
    'system:lock': function () { return false; },
    'system:theme': function () { return 'system'; },
    'system:volume': function () { return 0; },
    'system:stats': function () { return { cpu: 0, memory: 0, gpu: 0 }; },

    // --- shell / url launchers ----------------------------------------
    'app:open-url': function () { return false; },
    'app:open-uri': function () { return false; },
    'app:open-repo': function () { return false; },
    'app:is-store': function () { return false; },
    'settings:open-startup': function () { return false; },
    // `null` keeps the renderer's own toggle value: it only accepts a
    // boolean answer, anything else leaves the setting alone.
    'settings:start-on-boot': function () { return null; },

    // --- media ---------------------------------------------------------
    'media:key': function () { return false; },
    'media:focus': function () { return false; },

    // --- misc ----------------------------------------------------------
    'photo:pick': function () { return null; },
    'display:get-all': function () { return []; },
    'glass:protect': function () { return false; },
    'glass:source': function () { return null; },
    'dnai:respond': function () { return false; },
    // The approval gate fails closed: the renderer treats every answer that
    // is not exactly `false` as "approved", so a silent backend must never
    // turn into a granted permission.
    'dnai:request-approval': function () { return false; }
  };

  /**
   * Channels whose Rust emitter sends a raw JS array as the payload and whose
   * renderer listeners were written variadic. As of the current emit inventory
   * this is exactly one channel:
   *
   *   store:changed  <- store.rs emits `json!([key, value])`
   *                      (listeners: dn-conversation.js, dn-extras.js,
   *                       dn-files.js — all `function (key, value)`)
   *
   * If a future emitter adopts the explicit envelope, send
   * `{ __tupleArgs: [a, b] }` instead and drop the whitelist entry.
   */
  var TUPLE_CHANNELS = { 'store:changed': true };

  function tauriGlobal() {
    return typeof window !== 'undefined' && window.__TAURI__ ? window.__TAURI__ : null;
  }

  /**
   * Ring buffer of recent IPC problems, exposed as `window.__DN_IPC_ERRORS`
   * (max 50, oldest dropped). Entries: `{ at, kind, channel, message }` where
   * `kind` is 'invoke', 'send' or 'fallback'. Lets debugging answer "why does
   * the battery widget show 100%" without guessing which call failed.
   */
  var MAX_IPC_ERRORS = 50;
  var ipcErrors = [];

  function recordIpcError(kind, channel, error) {
    try {
      var message = error instanceof Error ? error.message : String(error);
      ipcErrors.push({
        at: new Date().toISOString(),
        kind: kind,
        channel: channel,
        message: message
      });
      if (ipcErrors.length > MAX_IPC_ERRORS) {
        ipcErrors.splice(0, ipcErrors.length - MAX_IPC_ERRORS);
      }
    } catch (_) { /* never let bookkeeping break the call */ }
  }

  function hasFallback(channel) {
    return Object.prototype.hasOwnProperty.call(FALLBACKS, channel);
  }

  /**
   * The value a channel resolves to when the backend has nothing to say.
   * `null` for channels without an entry.
   */
  function fallbackFor(channel) {
    if (!hasFallback(channel)) return null;
    try {
      return FALLBACKS[channel]();
    } catch (_) {
      return null;
    }
  }

  function isThenable(value) {
    return !!value &&
      (typeof value === 'object' || typeof value === 'function') &&
      typeof value.then === 'function';
  }

  function warn() {
    try { console.warn.apply(console, arguments); } catch (_) { /* console may be unavailable */ }
  }

  function error() {
    try { console.error.apply(console, arguments); } catch (_) { /* console may be unavailable */ }
  }

  /** Announce + record a fallback substitution (rule 2: never silently). */
  function reportFallback(channel, why) {
    warn('[DeskNotch IPC fallback used]', channel);
    recordIpcError('fallback', channel, why);
  }

  /**
   * Calls a Tauri command. The returned promise rejects only on transport
   * problems; every caller in this file converts that into a fallback.
   */
  function invokeTauri(command, payload) {
    var api = tauriGlobal();
    if (!api || !api.core || typeof api.core.invoke !== 'function') {
      return Promise.reject(new Error('DeskNotch: Tauri IPC is unavailable (' + command + ')'));
    }
    try {
      return Promise.resolve(api.core.invoke(command, payload));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  function noop() {}

  var bridge = {
    /**
     * Calls a backend channel and resolves with its result.
     * Extra arguments are forwarded as-is, matching ipcRenderer.invoke.
     *
     * Never rejects: a failed call resolves with the channel fallback so the
     * caller's `.then(...)` always runs.
     */
    invoke: function (channel) {
      var args = Array.prototype.slice.call(arguments, 1);
      return invokeTauri('bridge_invoke', { channel: channel, args: args })
        .then(function (result) {
          if (result === null || result === undefined) {
            // `null` for channels without a FALLBACKS entry is the honest
            // answer ("backend has nothing for this"); a substituted shape
            // is not, so announce it.
            if (hasFallback(channel)) {
              reportFallback(channel, 'backend returned null; FALLBACK substituted');
            }
            return fallbackFor(channel);
          }
          return result;
        }, function (err) {
          error('[DeskNotch IPC invoke]', channel, err);
          recordIpcError('invoke', channel, err);
          if (hasFallback(channel)) {
            reportFallback(channel, 'invoke failed; FALLBACK substituted');
          }
          return fallbackFor(channel);
        });
    },

    /**
     * Fire-and-forget call. The returned promise resolves with `undefined`
     * and never rejects: most call sites drop the promise on the floor, so a
     * rejection there would surface as an unhandled rejection.
     */
    send: function (channel, data) {
      return invokeTauri('bridge_send', {
        channel: channel,
        data: data === undefined ? null : data
      }).then(function () {}, function (err) {
        error('[DeskNotch IPC send]', channel, err);
        recordIpcError('send', channel, err);
      });
    },

    /**
     * Subscribes to a backend event. The callback receives the emitted
     * payload as a single argument, exactly as Rust serialized it. Spread
     * into separate arguments happens ONLY for the documented tuple
     * channels below (and an explicit `__tupleArgs` envelope).
     *
     * `window.__TAURI__.event.listen` resolves with the unlisten function
     * instead of returning it, so the returned disposer waits for that
     * promise and removes the listener even when it is called immediately.
     * Returns a function that removes the listener again.
     */
    on: function (channel, callback) {
      var api = tauriGlobal();
      if (!api || !api.event || typeof api.event.listen !== 'function') {
        return noop;
      }
      if (typeof callback !== 'function') {
        return noop;
      }

      var disposed = false;
      var unlisten = null;

      function handler(event) {
        var payload = event ? event.payload : undefined;
        try {
          var tuple = null;
          if (payload && typeof payload === 'object' &&
              Array.isArray(payload.__tupleArgs)) {
            tuple = payload.__tupleArgs;
          } else if (TUPLE_CHANNELS[channel] && Array.isArray(payload)) {
            tuple = payload;
          }
          if (tuple) {
            callback.apply(null, tuple);
          } else {
            callback(payload);
          }
        } catch (error) {
          warn('[bridge] listener for "' + channel + '" threw: ' + error);
        }
      }

      var listening;
      try {
        listening = api.event.listen(channel, handler);
      } catch (error) {
        warn('[bridge] cannot listen to "' + channel + '": ' + error);
        return noop;
      }

      if (isThenable(listening)) {
        listening.then(function (fn) {
          if (typeof fn !== 'function') return;
          if (disposed) {
            try { fn(); } catch (_) { /* already gone */ }
            return;
          }
          unlisten = fn;
        }, function (error) {
          warn('[bridge] cannot listen to "' + channel + '": ' + error);
        });
      } else if (typeof listening === 'function') {
        unlisten = listening;
      }

      return function () {
        if (disposed) return;
        disposed = true;
        var fn = unlisten;
        unlisten = null;
        if (typeof fn === 'function') {
          try { fn(); } catch (_) { /* already gone */ }
        }
      };
    },

    /**
     * Resolves the absolute path of a dropped file. Tauri hands paths to the
     * renderer through its own drag-drop events, so this only mirrors the
     * Electron helper for files that already carry a path.
     */
    pathOf: function (file) {
      if (!file) {
        return '';
      }
      return file.path || '';
    }
  };

  if (typeof window !== 'undefined') {
    window.bridge = bridge;
    // Live ring buffer (same array the shim splices) for debugging in devtools.
    window.__DN_IPC_ERRORS = ipcErrors;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = bridge;
  }
})();
