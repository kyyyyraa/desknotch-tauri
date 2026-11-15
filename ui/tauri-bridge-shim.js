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
 * Two rules drive the implementation.
 *
 *   1. `invoke` and `send` never reject. The renderer calls them bare in a
 *      dozen places (`void bridge.invoke("media:key", "next")`,
 *      `bridge.invoke("dnai:respond", ...)` inside a `try` block that cannot
 *      see a promise rejection, `bridge.send("dnptt:log", ...)` whose result
 *      nobody awaits). A rejected promise therefore surfaces as an unhandled
 *      rejection and takes the notch down with it. Every transport failure is
 *      folded into a fallback value instead.
 *
 *   2. The backend answers unknown channels with `null` (see bridge.rs), and
 *      the renderer dereferences some of those results without a guard
 *      (`apps:describe` -> `e.join("|")`, `privacy:get` -> `D.micApps.join()`,
 *      `desktime:screen-time` -> `Z.installed`). Channels listed in
 *      FALLBACKS get a shape-preserving value so a missing backend feature
 *      can never crash the UI.
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
    'update:get': function () { return { status: 'idle', version: '1.0.4' }; },
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

  function tauriGlobal() {
    return typeof window !== 'undefined' && window.__TAURI__ ? window.__TAURI__ : null;
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

  function warn(message) {
    try { console.warn(message); } catch (_) { /* console may be unavailable */ }
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
            return fallbackFor(channel);
          }
          return result;
        }, function () {
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
      }).then(function () {}, function () {});
    },

    /**
     * Subscribes to a backend event. The callback keeps the variadic shape of
     * the original IPC listener: an array payload is spread into the
     * arguments, so `store:changed` still arrives as (key, value).
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
          if (Array.isArray(payload)) {
            callback.apply(null, payload);
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
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = bridge;
  }
})();
