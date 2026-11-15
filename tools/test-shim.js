#!/usr/bin/env node
/*
 * test-shim.js
 *
 * Contract tests for ui/tauri-bridge-shim.js.
 *
 * The shim is loaded into a fake `window` so the real file is exercised
 * without a browser or a running Tauri host. Run it with:
 *
 *   node tools/test-shim.js
 *
 * The suite covers the three things the renderer depends on:
 *
 *   - every channel the UI dereferences without a guard resolves to a
 *     shape-preserving fallback when the backend is silent or broken,
 *   - `invoke` / `send` never reject, so no call site in the renderer can
 *     produce an unhandled promise rejection,
 *   - `on` / `pathOf` keep the Electron preload contract.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SHIM_PATH = path.join(__dirname, '..', 'ui', 'tauri-bridge-shim.js');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.then(
        () => { passed++; },
        (error) => { failed++; failures.push({ name, error }); }
      );
    }
    passed++;
    return undefined;
  } catch (error) {
    failed++;
    failures.push({ name, error });
    return undefined;
  }
}

/**
 * Loads the shim into a fake window and returns the bridge it installs.
 *
 * `tauri` is whatever the fake `window.__TAURI__` should be; pass null to
 * simulate a renderer that runs without the Tauri host at all.
 */
function loadBridge(tauri) {
  const source = fs.readFileSync(SHIM_PATH, 'utf8');
  const fakeWindow = {};
  if (tauri !== undefined) fakeWindow.__TAURI__ = tauri;
  // eslint-disable-next-line no-new-func
  const factory = new Function('window', 'module', source);
  factory(fakeWindow, undefined);
  assert.ok(fakeWindow.bridge, 'shim did not install window.bridge');
  return fakeWindow.bridge;
}

/** A Tauri stub whose `core.invoke` answers with `reply`. */
function tauriWith(reply, log) {
  const calls = log || [];
  return {
    log: calls,
    core: {
      invoke(command, payload) {
        calls.push({ command, payload });
        return Promise.resolve(reply(command, payload));
      }
    }
  };
}

function tauriRejecting(log) {
  const calls = log || [];
  return {
    log: calls,
    core: {
      invoke(command, payload) {
        calls.push({ command, payload });
        return Promise.reject(new Error('backend exploded'));
      }
    }
  };
}

/** Every channel the renderer dereferences without a null guard. */
const FALLBACK_EXPECTATIONS = [
  ['usage:get', { cpu: 0.05, memory: 0.35, gpu: 0 }],
  ['battery:get', { level: 1.0, charging: true, supported: false }],
  ['privacy:get', { mic: false, camera: false, micApps: [], cameraApps: [], wifi: null, bluetooth: [] }],
  ['ai:limits', []],
  ['smtc:get', null],
  ['apps:top', []],
  ['apps:all', []],
  ['apps:describe', []],
  ['files:describe', []],
  ['desktime:screen-time', { installed: false, ms: null }]
];

function run() {
  // ---------------------------------------------------------------------
  // Fallbacks: no Tauri host at all.
  // ---------------------------------------------------------------------
  const noHost = loadBridge(undefined);

  for (const [channel, expected] of FALLBACK_EXPECTATIONS) {
    test('fallback without a Tauri host: ' + channel, async () => {
      const value = await noHost.invoke(channel);
      assert.deepStrictEqual(value, expected);
    });
  }

  // ---------------------------------------------------------------------
  // Fallbacks: the host is there but the backend answers with null, which is
  // what bridge.rs does for every channel it does not implement.
  // ---------------------------------------------------------------------
  const silentBackend = loadBridge(tauriWith(() => null));

  for (const [channel, expected] of FALLBACK_EXPECTATIONS) {
    test('fallback on a null backend answer: ' + channel, async () => {
      const value = await silentBackend.invoke(channel);
      assert.deepStrictEqual(value, expected);
    });
  }

  // ---------------------------------------------------------------------
  // Fallbacks: the backend fails outright. The promise must still resolve.
  // ---------------------------------------------------------------------
  const brokenBackend = loadBridge(tauriRejecting());

  for (const [channel, expected] of FALLBACK_EXPECTATIONS) {
    test('fallback on a failing backend: ' + channel, async () => {
      const value = await brokenBackend.invoke(channel);
      assert.deepStrictEqual(value, expected);
    });
  }

  test('invoke never rejects when the backend fails', async () => {
    const value = await brokenBackend.invoke('system:stats');
    assert.deepStrictEqual(value, { cpu: 0, memory: 0, gpu: 0 });
  });

  test('the approval gate fails closed', async () => {
    // The renderer treats any answer that is not exactly `false` as
    // "approved", so a silent or broken backend must answer `false`.
    assert.strictEqual(await silentBackend.invoke('dnai:request-approval'), false);
    assert.strictEqual(await brokenBackend.invoke('dnai:request-approval'), false);
    assert.strictEqual(await noHost.invoke('dnai:request-approval'), false);
  });

  test('the approval gate passes a real approval through', async () => {
    const real = loadBridge(tauriWith(() => true));
    assert.strictEqual(await real.invoke('dnai:request-approval'), true);
  });

  test('invoke returns a promise with a catch method', () => {
    const promise = brokenBackend.invoke('usage:get');
    assert.ok(promise && typeof promise.then === 'function', 'no then()');
    assert.ok(promise && typeof promise.catch === 'function', 'no catch()');
    return promise;
  });

  // ---------------------------------------------------------------------
  // A real backend answer wins over the fallback.
  // ---------------------------------------------------------------------
  test('a real backend answer is preserved', async () => {
    const real = loadBridge(tauriWith((command, payload) => {
      if (payload.channel === 'usage:get') return { cpu: 0.42, memory: 0.71, gpu: 12 };
      if (payload.channel === 'ai:limits') return [{ id: 'claude', used: 3 }];
      if (payload.channel === 'store:get') return { theme: 'dark' };
      return null;
    }));
    assert.deepStrictEqual(await real.invoke('usage:get'), { cpu: 0.42, memory: 0.71, gpu: 12 });
    assert.deepStrictEqual(await real.invoke('ai:limits'), [{ id: 'claude', used: 3 }]);
    assert.deepStrictEqual(await real.invoke('store:get', 'settings'), { theme: 'dark' });
  });

  test('store:get stays null because null means "never written"', async () => {
    const real = loadBridge(tauriWith(() => null));
    const value = await real.invoke('store:get', 'missing-key');
    assert.strictEqual(value, null);
  });

  test('fallback objects are fresh on every call', async () => {
    const first = await silentBackend.invoke('usage:get');
    const second = await silentBackend.invoke('usage:get');
    assert.notStrictEqual(first, second, 'the same object was handed out twice');
    first.cpu = 99;
    assert.strictEqual((await silentBackend.invoke('usage:get')).cpu, 0.05);
  });

  // ---------------------------------------------------------------------
  // invoke / send argument forwarding.
  // ---------------------------------------------------------------------
  test('invoke forwards the channel and every argument', async () => {
    const log = [];
    const bridge = loadBridge(tauriWith(() => null, log));
    await bridge.invoke('dn:shell', { cmd: 'dir' });
    await bridge.invoke('store:set', 'settings', { a: 1 });
    assert.strictEqual(log[0].command, 'bridge_invoke');
    assert.deepStrictEqual(log[0].payload, { channel: 'dn:shell', args: [{ cmd: 'dir' }] });
    assert.deepStrictEqual(log[1].payload, { channel: 'store:set', args: ['settings', { a: 1 }] });
  });

  test('send forwards the channel and the payload', async () => {
    const log = [];
    const bridge = loadBridge(tauriWith(() => null, log));
    const result = await bridge.send('notch:bounds', { rects: [] });
    assert.strictEqual(result, undefined, 'send must resolve with undefined');
    assert.strictEqual(log[0].command, 'bridge_send');
    assert.deepStrictEqual(log[0].payload, { channel: 'notch:bounds', data: { rects: [] } });
  });

  test('send turns an undefined payload into null', async () => {
    const log = [];
    const bridge = loadBridge(tauriWith(() => null, log));
    await bridge.send('dnptt:done');
    assert.deepStrictEqual(log[0].payload, { channel: 'dnptt:done', data: null });
  });

  test('send never rejects', async () => {
    const bridge = loadBridge(tauriRejecting());
    const result = await bridge.send('dnptt:log', 'hello');
    assert.strictEqual(result, undefined);
  });

  test('invoke and send survive a host without a core API', async () => {
    const bridge = loadBridge({});
    assert.deepStrictEqual(await bridge.invoke('usage:get'), { cpu: 0.05, memory: 0.35, gpu: 0 });
    assert.strictEqual(await bridge.send('app:quit'), undefined);
  });

  // ---------------------------------------------------------------------
  // bridge.on
  // ---------------------------------------------------------------------
  test('on unpacks an array payload into the callback arguments', async () => {
    let received = null;
    const bridge = loadBridge({
      core: { invoke: () => Promise.resolve(null) },
      event: {
        listen: () => Promise.resolve(() => {})
      }
    });
    const unlisten = bridge.on('store:changed', function (key, value) {
      received = [key, value];
    });
    assert.strictEqual(typeof unlisten, 'function');
    // The listener is registered through the host, which is what the
    // renderer awaits before it ever sees an event.
    await Promise.resolve();
    assert.strictEqual(typeof unlisten, 'function');
  });

  test('on spreads the array payload of store:changed', () => {
    const listeners = [];
    const bridge = loadBridge({
      core: { invoke: () => Promise.resolve(null) },
      event: {
        listen: (channel, handler) => {
          listeners.push({ channel, handler });
          return Promise.resolve(() => {});
        }
      }
    });
    let seen = null;
    bridge.on('store:changed', function (key, value) { seen = [key, value]; });
    const entry = listeners[listeners.length - 1];
    assert.strictEqual(entry.channel, 'store:changed');
    entry.handler({ payload: ['settings', { theme: 'dark' }] });
    assert.deepStrictEqual(seen, ['settings', { theme: 'dark' }]);
  });

  test('on passes a non-array payload through unchanged', () => {
    const listeners = [];
    const bridge = loadBridge({
      core: { invoke: () => Promise.resolve(null) },
      event: {
        listen: (channel, handler) => {
          listeners.push({ channel, handler });
          return Promise.resolve(() => {});
        }
      }
    });
    let seen = 'untouched';
    bridge.on('battery:state', function (state) { seen = state; });
    listeners[listeners.length - 1].handler({ payload: { level: 0.5, charging: false } });
    assert.deepStrictEqual(seen, { level: 0.5, charging: false });
  });

  test('on returns a disposer that removes the listener', async () => {
    let unlistenCalls = 0;
    const bridge = loadBridge({
      core: { invoke: () => Promise.resolve(null) },
      event: {
        listen: () => Promise.resolve(() => { unlistenCalls++; })
      }
    });
    const unlisten = bridge.on('smtc:now-playing', () => {});
    unlisten();
    // The host resolves the unlisten function asynchronously, so the disposer
    // has to wait for it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.strictEqual(unlistenCalls, 1, 'the listener was not removed');
  });

  test('on removes the listener even when disposed before the host resolves', async () => {
    let unlistenCalls = 0;
    const bridge = loadBridge({
      core: { invoke: () => Promise.resolve(null) },
      event: {
        listen: () => Promise.resolve(() => { unlistenCalls++; })
      }
    });
    const unlisten = bridge.on('smtc:now-playing', () => {});
    unlisten();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.strictEqual(unlistenCalls, 1, 'the listener was not removed');
  });

  test('on keeps working with a host that returns the unlisten function directly', () => {
    let unlistenCalls = 0;
    const bridge = loadBridge({
      core: { invoke: () => Promise.resolve(null) },
      event: {
        listen: () => () => { unlistenCalls++; }
      }
    });
    const unlisten = bridge.on('display:changed', () => {});
    unlisten();
    assert.strictEqual(unlistenCalls, 1);
  });

  test('on contains a throwing listener', () => {
    const listeners = [];
    const bridge = loadBridge({
      core: { invoke: () => Promise.resolve(null) },
      event: {
        listen: (channel, handler) => {
          listeners.push({ channel, handler });
          return Promise.resolve(() => {});
        }
      }
    });
    bridge.on('store:changed', () => { throw new Error('listener blew up'); });
    assert.doesNotThrow(() => listeners[0].handler({ payload: ['settings', 1] }));
  });

  test('on swallows a host that refuses to listen', async () => {
    const bridge = loadBridge({
      core: { invoke: () => Promise.resolve(null) },
      event: { listen: () => Promise.reject(new Error('not allowed')) }
    });
    const unlisten = bridge.on('store:changed', () => {});
    assert.strictEqual(typeof unlisten, 'function');
    unlisten();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  test('on without an event API returns a harmless disposer', () => {
    const bridge = loadBridge({ core: { invoke: () => Promise.resolve(null) } });
    const unlisten = bridge.on('store:changed', () => {});
    assert.strictEqual(typeof unlisten, 'function');
    assert.doesNotThrow(() => unlisten());
  });

  // ---------------------------------------------------------------------
  // bridge.pathOf
  // ---------------------------------------------------------------------
  test('pathOf returns the path of a file', () => {
    const bridge = loadBridge(tauriWith(() => null));
    assert.strictEqual(bridge.pathOf({ path: 'C:/Users/test/file.txt' }), 'C:/Users/test/file.txt');
  });

  test('pathOf returns an empty string for a file without a path', () => {
    const bridge = loadBridge(tauriWith(() => null));
    assert.strictEqual(bridge.pathOf({}), '');
  });

  test('pathOf returns an empty string for a missing file', () => {
    const bridge = loadBridge(tauriWith(() => null));
    assert.strictEqual(bridge.pathOf(null), '');
    assert.strictEqual(bridge.pathOf(undefined), '');
  });

  // ---------------------------------------------------------------------
  // Nothing in the suite may leave an unhandled rejection behind.
  // ---------------------------------------------------------------------
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);

  return Promise.resolve()
    .then(() => new Promise((resolve) => setTimeout(resolve, 25)))
    .then(() => {
      process.removeListener('unhandledRejection', onUnhandled);
      test('no unhandled promise rejections', () => {
        assert.deepStrictEqual(unhandled.map(String), []);
      });
    });
}

run().then(() => {
  const total = passed + failed;
  if (failed > 0) {
    console.error('');
    for (const failure of failures) {
      console.error('FAIL  ' + failure.name);
      console.error('      ' + (failure.error && failure.error.message ? failure.error.message : failure.error));
    }
    console.error('');
    console.error(failed + ' of ' + total + ' checks failed.');
    process.exit(1);
  }
  console.log('OK  ' + passed + ' of ' + total + ' checks passed.');
}).catch((error) => {
  console.error('test run crashed: ' + (error && error.stack ? error.stack : error));
  process.exit(1);
});
