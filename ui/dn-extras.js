(function () {
  "use strict";

  try {
    const bridge = window.bridge;
    if (!bridge) return;
    if (window.__dnAIBell && window.__dnAIBell.__dnExtrasActive) return;

    const state = {
      enabled: true,
      settingsReady: false,
      settingsRevision: 0,
      queued: [],
      seenIds: new Set(),
      seenOrder: [],
      audio: { context: null, nodes: new Set(), retry: false, resuming: false },
    };

    function report(label, error) {
      try { console.warn("[dn-extras] " + label, error); } catch (_) {}
    }
    function safe(label, callback) {
      return function () {
        try { return callback.apply(this, arguments); }
        catch (error) { report(label, error); return undefined; }
      };
    }
    function asText(value) {
      if (value === null || value === undefined) return "";
      return String(value);
    }

    function stopActiveNodes() {
      const audio = state.audio;
      for (const node of audio.nodes) {
        try { node.oscillator.onended = null; node.oscillator.stop(); } catch (_) {}
        try { node.oscillator.disconnect(); node.gain.disconnect(); } catch (_) {}
      }
      audio.nodes.clear();
    }
    function stopBell() { stopActiveNodes(); state.audio.retry = false; }

    function audioContext() {
      const audio = state.audio;
      if (audio.context && audio.context.state !== "closed") return audio.context;
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return null;
      audio.context = new AudioContextClass();
      return audio.context;
    }

    function scheduleChime(context) {
      if (!context || context.state !== "running") { state.audio.retry = true; return false; }
      stopActiveNodes();
      const start = context.currentTime + 0.01;
      const notes = [
        { frequency: 783.99, start, end: start + 0.15 },
        { frequency: 1318.51, start: start + 0.17, end: start + 0.39 },
      ];
      for (const note of notes) {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.type = "triangle";
        oscillator.frequency.setValueAtTime(note.frequency, note.start);
        gain.gain.setValueAtTime(0.0001, note.start);
        gain.gain.exponentialRampToValueAtTime(0.13, note.start + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, note.end);
        oscillator.connect(gain); gain.connect(context.destination);
        const node = { oscillator, gain };
        oscillator.onended = function () {
          state.audio.nodes.delete(node);
          try { oscillator.disconnect(); gain.disconnect(); } catch (_) {}
        };
        state.audio.nodes.add(node);
        oscillator.start(note.start);
        oscillator.stop(note.end + 0.02);
      }
      state.audio.retry = false;
      return true;
    }

    function playBell() {
      const audio = state.audio;
      const context = audioContext();
      if (!context) return;
      if (context.state === "running") { scheduleChime(context); return; }
      audio.retry = true;
      if (audio.resuming) return;
      audio.resuming = true;
      let resumed;
      try { resumed = context.resume(); }
      catch (error) { audio.resuming = false; report("resume bell", error); return; }
      Promise.resolve(resumed).then(safe("resume bell", function () {
        audio.resuming = false;
        if (context.state === "running" && audio.retry) scheduleChime(context);
        else if (context.state !== "running") audio.retry = true;
      })).catch(safe("resume bell", function (error) {
        audio.resuming = false; audio.retry = true; report("resume bell", error);
      }));
    }

    function remember(id) {
      if (state.seenIds.has(id)) return false;
      state.seenIds.add(id);
      state.seenOrder.push(id);
      if (state.seenOrder.length > 512) state.seenIds.delete(state.seenOrder.shift());
      return true;
    }

    // The approval UI now lives inside the notch chunk itself; this script only
    // rings the bell so a new request is audible even when the notch is idle.
    function onApproval(payload) {
      if (!state.settingsReady) { state.queued.push({ type: "approval", payload }); return; }
      if (!state.enabled) return;
      if (!payload || typeof payload !== "object") return;
      const id = asText(payload.id).trim();
      if (!id || !remember(id)) return;
      playBell();
    }

    function settingsEnableAi(value) {
      return !(value && typeof value === "object" && value.dnExtrasAi === false);
    }

    function applySettings(settings, revision) {
      if (typeof revision === "number" && revision !== state.settingsRevision) return;
      state.settingsReady = true;
      state.enabled = settingsEnableAi(settings);
      if (!state.enabled) { state.queued.length = 0; stopBell(); return; }
      const queued = state.queued.splice(0);
      for (const event of queued) if (event.type === "approval") onApproval(event.payload);
    }

    function fetchInitialSettings() {
      const revision = state.settingsRevision;
      let response;
      try { response = bridge.invoke("store:get", "settings"); }
      catch (error) { report("read settings", error); applySettings(undefined, revision); return; }
      Promise.resolve(response)
        .then(safe("read settings", function (settings) { applySettings(settings, revision); }))
        .catch(safe("read settings", function (error) { report("read settings", error); applySettings(undefined, revision); }));
    }

    function subscribe(channel, listener) {
      try { bridge.on(channel, safe(channel, listener)); }
      catch (error) { report("subscribe " + channel, error); }
    }

    window.__dnAIBell = {
      __dnExtrasActive: true,
      stop: safe("stop bell", stopBell),
      __testEmit: safe("test approval", function (payload) { onApproval(payload); }),
      __testStatus: safe("test status", function () {}),
    };

    document.addEventListener("click", safe("audio retry", function () {
      if (state.audio.retry) playBell();
    }), true);

    subscribe("dnai:approval", onApproval);
    subscribe("store:changed", function (changedKey, value) {
      if (changedKey === "settings") { state.settingsRevision += 1; applySettings(value, state.settingsRevision); }
    });

    fetchInitialSettings();
  } catch (error) {
    try { console.warn("[dn-extras] init", error); } catch (_) {}
  }
}());
