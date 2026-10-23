// LcnApp with the SDK's fake Gladys (createFakeGladys), the in-memory PCHK
// (test/helpers/fakePchk.js) and a virtual clock: the whole chain from the
// lines of PCHK to the Gladys devices, states, scene events and commands.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { LcnApp } from '../src/app.js';
import { registerHandlers } from '../src/handlers.js';
import { memoryStore } from '../src/store.js';
import { FakeClock, FakePchk, quietLogger, settle, until } from './helpers/fakePchk.js';

const BASE = { host: '192.0.2.40', username: 'lcn', password: 'secret', language: 'en' };
const PORTS =
  'M5.A1:light, M5.A2:switch, M5.R1, M5.R3:switch, M5.B1:motion, M5.TVAR, M5.VAR4:humidity, M5.R1VARSETPOINT, M7.TVAR, M7.R1VAR';

async function setup(
  t,
  { config = {}, pchk: pchkOptions = {}, store, devices, ready = true } = {},
) {
  const clock = new FakeClock();
  const gladys = createFakeGladys({ config: { ...BASE, ...config }, devices });
  const pchk = new FakePchk(pchkOptions);
  const logger = quietLogger();
  const memory = store ?? memoryStore();
  const app = new LcnApp({
    gladys,
    logger,
    connect: pchk.connect,
    store: memory,
    now: clock.now,
    timers: clock,
  });
  registerHandlers(gladys, app, logger);
  await gladys.connect();
  t.after(() => app.stop());
  const ids = gladys.externalIds('module', '0-5');
  const ids7 = gladys.externalIds('module', '0-7');
  const device = (externalId) =>
    gladys.fake.discoveredDevices.find((d) => d.external_id === externalId);
  const ctx = {
    gladys,
    pchk,
    app,
    clock,
    logger,
    store: memory,
    ids,
    ids7,
    device,
    state: (id) => gladys.fake.lastState(id),
    status: () => gladys.fake.connectionStatus,
    feature: (key, deviceIds = ids) => {
      const d = device(deviceIds.device) ?? { external_id: deviceIds.device, features: [] };
      const f = d.features.find((x) => x.external_id === deviceIds.feature(key)) ?? {
        external_id: deviceIds.feature(key),
      };
      return [d, f];
    },
    /** A command while the virtual clock runs (the client paces its lines). */
    command: async (key, value, ms = 6_000, deviceIds = ids) => {
      const [d, f] = ctx.feature(key, deviceIds);
      const pending = gladys.fake.setValue(d, f, value);
      await ctx.clock.advance(ms);
      return pending;
    },
  };
  if (ready) await loggedIn(ctx);
  return ctx;
}

/** Login, segment scan (4.5 s), module scan (3 x 3 s), identities, first read. */
async function loggedIn(ctx) {
  await ctx.clock.advance(6_000);
  await until(() => ctx.app.online);
  await ctx.clock.advance(20_000);
  await until(() => !ctx.app.scanning);
  await ctx.clock.advance(10_000);
  await ctx.app.chain;
  await settle();
}

test('login, scan: one device per module, names, serials, default ports read only', async (t) => {
  const ctx = await setup(t);
  const { pchk, ids, ids7 } = ctx;
  // The login, in order; the password is never in the logs.
  const session = pchk.log.filter((e) => e.session === 1).map((e) => e.line);
  assert.deepEqual(session.slice(0, 4), ['lcn', 'secret', '!CHD', '!OM1P']);
  assert.ok(!ctx.logger.lines.some((l) => l.includes('secret')), 'no password in the logs');
  assert.ok(pchk.lines.includes('>G003003.SK'));
  assert.ok(pchk.lines.includes('>G000003!LEER'));
  const devices = ctx.gladys.fake.discoveredDevices;
  assert.deepEqual(
    devices.map((d) => [d.external_id, d.name, d.model]),
    [
      [ids.device, 'Kitchen Left', 'LCN-UPS'],
      [ids7.device, 'Hall', 'LCN-UPP'],
    ],
  );
  assert.deepEqual(ctx.device(ids.device).params, [
    { name: 'address', value: 'M5' },
    { name: 'serial', value: '1A2B3C4D5E' },
    { name: 'firmware', value: '190B11' },
  ]);
  // Not in "Ports": A1 and A2, read only, with their (refused) buttons.
  assert.deepEqual(
    ctx
      .device(ids.device)
      .features.map((f) => [f.external_id.split(':').at(-1), f.category, f.type, f.read_only]),
    [
      ['a1_state', 'unknown', 'binary', true],
      ['a1_level', 'unknown', 'unknown', true],
      ['a1_on', 'button', 'push', false],
      ['a1_off', 'button', 'push', false],
      ['a2_state', 'unknown', 'binary', true],
      ['a2_level', 'unknown', 'unknown', true],
      ['a2_on', 'button', 'push', false],
      ['a2_off', 'button', 'push', false],
    ],
  );
  assert.ok(!ctx.device(ids.device).features.some((f) => ['switch', 'light'].includes(f.category)));
  assert.equal(ctx.state(ids.feature('a1_level')), 50);
  assert.equal(ctx.state(ids.feature('a1_state')), 1);
  assert.equal(ctx.state(ids7.feature('a2_level')), 100);
  assert.equal(ctx.status().connected, true);
  assert.match(ctx.status().message.en, /Connected to LCN-PCHK: 2 module\(s\)/);
  assert.ok(ctx.gladys.fake.transports.every((entry) => entry.transport === 'local'));
});

test('Ports: lights, switches, sensors, variables of new and old modules', async (t) => {
  const ctx = await setup(t, { config: { ports: `${PORTS}, M5.X9, M300.A1, M5.A1:pump` } });
  const { ids, ids7 } = ctx;
  const kinds = ctx
    .device(ids.device)
    .features.map((f) => [f.external_id.split(':').at(-1), f.category, f.type, f.unit ?? null]);
  assert.deepEqual(kinds, [
    ['a1_light', 'light', 'binary', null],
    ['a1_brightness', 'light', 'brightness', null],
    ['a2_switch', 'switch', 'binary', null],
    ['r1_state', 'unknown', 'binary', null],
    ['r1_on', 'button', 'push', null],
    ['r1_off', 'button', 'push', null],
    ['r3_switch', 'switch', 'binary', null],
    ['b1_motion', 'motion-sensor', 'binary', null],
    ['var1_temperature', 'temperature-sensor', 'decimal', 'celsius'],
    ['var4_humidity', 'humidity-sensor', 'decimal', 'percent'],
    ['sp1_setpoint', 'thermostat', 'target-temperature', 'celsius'],
  ]);
  assert.match(ctx.logger.lines.join('\n'), /Ports not understood: M5\.X9, M300\.A1, M5\.A1:pump/);
  assert.match(ctx.status().message.en, /Not understood in "Ports": M5\.X9/);
  assert.equal(ctx.state(ids.feature('a1_brightness')), 50);
  assert.equal(ctx.state(ids.feature('a1_light')), 1);
  assert.equal(ctx.state(ids.feature('a2_switch')), 0);
  assert.equal(ctx.state(ids.feature('r1_state')), 1);
  assert.equal(ctx.state(ids.feature('r3_switch')), 1);
  assert.equal(ctx.state(ids.feature('b1_motion')), 1);
  assert.equal(ctx.state(ids.feature('var1_temperature')), 21.5);
  assert.equal(ctx.state(ids.feature('var4_humidity')), 45);
  assert.equal(ctx.state(ids.feature('sp1_setpoint')), 21);
  // The old module answers without the type: one question at a time.
  assert.equal(ctx.state(ids7.feature('var1_temperature')), 20);
  // "No value" (0xFFFF) is never published.
  assert.equal(ctx.state(ids7.feature('var2_temperature')), undefined);
  assert.ok(ctx.pchk.lines.includes('>M000007.MWV'));
  assert.ok(ctx.pchk.lines.includes('>M000005.MWT1'));
});

test('commands: light, brightness, switch, relay; confirmed by the status; strict values', async (t) => {
  const ctx = await setup(t, { config: { ports: PORTS } });
  const { ids } = ctx;
  let ack = await ctx.command('a1_brightness', 30);
  assert.equal(ack.success, true, ack.error);
  assert.ok(ctx.pchk.lines.includes('>M000005.A1DI030000'));
  await settle();
  assert.equal(ctx.state(ids.feature('a1_brightness')), 30);
  ack = await ctx.command('a1_light', 0);
  assert.equal(ack.success, true, ack.error);
  assert.ok(ctx.pchk.lines.includes('>M000005.A1DI000000'));
  ack = await ctx.command('a2_switch', '1');
  assert.equal(ack.success, true, ack.error);
  assert.ok(ctx.pchk.lines.includes('>M000005.A2DI100000'));
  ack = await ctx.command('r3_switch', 0);
  assert.equal(ack.success, true, ack.error);
  assert.equal(ctx.pchk.lines.at(-2), '>M000005.R8--0-----');
  await settle();
  assert.equal(ctx.state(ids.feature('r3_switch')), 0);
  const before = ctx.pchk.lines.length;
  for (const value of [null, '', 2, 'on']) {
    const bad = await ctx.command('a2_switch', value, 100);
    assert.equal(bad.success, false);
    assert.match(bad.error, /nothing was sent/);
  }
  for (const value of [-1, 101, null, 'x']) {
    const bad = await ctx.command('a1_brightness', value, 100);
    assert.equal(bad.success, false);
  }
  assert.equal(ctx.pchk.lines.length, before, 'nothing written for a wrong value');
});

test('read only: a port not declared is never a switch; its buttons are off by default', async (t) => {
  const ctx = await setup(t, { config: { ports: PORTS } });
  const before = ctx.pchk.lines.length;
  let ack = await ctx.command('r1_state', 1, 100);
  assert.match(ack.error, /read only/);
  ack = await ctx.command('r1_on', 1, 100);
  assert.match(ack.error, /disabled in the configuration: nothing was sent/);
  // A switch on a port not declared (an old feature kept, a forged id).
  ack = await ctx.command('r1_switch', 1, 100);
  assert.match(ack.error, /not declared as a light or a switch/);
  ack = await ctx.command('var1_temperature', 20, 100);
  assert.match(ack.error, /read only/);
  assert.equal(ctx.pchk.lines.length, before, 'nothing written');
  assert.match(ctx.logger.lines.join('\n'), /Button M5\.R1 on REFUSED/);
});

test('buttons allowed: turn on and off; off cancels a waiting turn on; the option is read again before the write', async (t) => {
  const ctx = await setup(t, { config: { ports: PORTS, allow_output_buttons: true } });
  const { gladys } = ctx;
  let ack = await ctx.command('r1_off', 1);
  assert.equal(ack.success, true, ack.error);
  assert.ok(ctx.pchk.lines.includes('>M000005.R80-------'));
  ack = await ctx.command('r1_on', 0, 100);
  assert.match(ack.error, /Value 0 not understood/);
  // A command just written keeps the line gap: the next "turn on" waits, an "off" cancels it.
  const [d1, f2] = ctx.feature('a2_switch');
  const [, on] = ctx.feature('r1_on');
  const [, off] = ctx.feature('r1_off');
  const first = gladys.fake.setValue(d1, f2, 1);
  const waiting = gladys.fake.setValue(d1, on, 1);
  const stop = gladys.fake.setValue(d1, off, 1);
  await ctx.clock.advance(6_000);
  assert.equal((await first).success, true);
  const cancelled = await waiting;
  assert.equal(cancelled.success, false);
  assert.match(
    cancelled.error,
    /"turn off" of the same port was asked meanwhile: nothing was sent/,
  );
  assert.equal((await stop).success, true);
  assert.ok(!ctx.pchk.lines.includes('>M000005.R81-------'), 'the turn on never left');
  // Switched off while a command waits: withdrawn before the write.
  const queued = gladys.fake.setValue(d1, f2, 0);
  const late = gladys.fake.setValue(d1, on, 1);
  await gladys.fake.configUpdated({ ...BASE, ports: PORTS, allow_output_buttons: false });
  await ctx.clock.advance(6_000);
  assert.equal((await queued).success, true);
  const withdrawn = await late;
  assert.match(withdrawn.error, /disabled in the configuration: nothing was sent/);
  assert.ok(!ctx.pchk.lines.includes('>M000005.R81-------'));
});

test('a command without the status asked is "sent, without confirmation", read again', async (t) => {
  const ctx = await setup(t, { config: { ports: PORTS } });
  ctx.pchk.hold = (line) => line.startsWith('>M000005.A2DI') || line === '>M000005.SMA2';
  const ack = await ctx.command('a2_switch', 1);
  assert.equal(ack.success, false);
  assert.match(ack.error, /Sent to the bus \(M5\.A2 to 100 %\), without confirmation/);
  ctx.pchk.hold = () => false;
  const reads = ctx.pchk.lines.filter((l) => l === '>M000005.SMA2').length;
  await ctx.clock.advance(3_000);
  assert.equal(ctx.pchk.lines.filter((l) => l === '>M000005.SMA2').length, reads + 1);
});

test('offline and bus disconnected: refused, nothing sent', async (t) => {
  const ctx = await setup(t, { config: { ports: PORTS } });
  ctx.pchk.line('$io:#LCN:disconnected');
  await ctx.clock.advance(100);
  await ctx.app.chain;
  assert.match(ctx.status().message.en, /PCHK says the LCN bus is disconnected/);
  const before = ctx.pchk.lines.length;
  let ack = await ctx.command('a2_switch', 1, 100);
  assert.match(ack.error, /LCN bus is disconnected: nothing was sent/);
  ctx.pchk.line('$io:#LCN:connected');
  await ctx.clock.advance(100);
  ctx.pchk.drop();
  await ctx.clock.advance(100);
  ack = await ctx.command('a2_switch', 1, 100);
  assert.match(ack.error, /not connected: nothing was sent/);
  assert.equal(ctx.pchk.lines.length, before);
  assert.match(
    ctx.status().message.en,
    /unreachable \(connection closed by PCHK\), next try in 10 s/,
  );
});

test('login refused: stopped and persisted with a salted fingerprint, never retried with the same credentials', async (t) => {
  const store = memoryStore();
  const ctx = await setup(t, { config: { password: 'wrong' }, store, ready: false });
  await ctx.clock.advance(6_000);
  await ctx.app.chain;
  assert.match(ctx.status().message.en, /refused the user name or the password/);
  const saved = store.data.stop;
  assert.equal(saved.kind, 'login_refused');
  assert.match(saved.hash, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(store.data).includes('wrong'), 'never the password in /data');
  // No loop: nothing more for an hour.
  await ctx.clock.advance(3_600_000);
  assert.equal(ctx.pchk.sockets.length, 1);
  // A restart with the same credentials: no connection.
  await ctx.app.start({ ...BASE, password: 'wrong' });
  await ctx.clock.advance(60_000);
  assert.equal(ctx.pchk.sockets.length, 1);
  // The test button tries once; still refused.
  let ack = await ctx.gladys.fake.action('test_connection');
  assert.equal(ack.success, false);
  assert.match(ack.error, /refused/);
  assert.equal(ctx.pchk.sockets.length, 2);
  ack = await ctx.gladys.fake.action('test_connection');
  assert.match(ack.error, /try again in \d+ s/);
  assert.equal(ctx.pchk.sockets.length, 2);
  // New credentials: tried; the first success erases the fingerprint.
  await ctx.gladys.fake.configUpdated({ ...BASE });
  await ctx.clock.advance(15_000);
  await until(() => ctx.app.online);
  await ctx.app.chain;
  assert.equal(store.data.stop, null);
});

test('licence error of PCHK: a pause persisted, spaced tries', async (t) => {
  const store = memoryStore();
  const ctx = await setup(t, { pchk: { licence: true }, store, ready: false });
  await ctx.clock.advance(6_000);
  await ctx.app.chain;
  assert.match(ctx.status().message.en, /licence error .* Next try in 5 min/);
  assert.ok(store.data.pause.until > ctx.clock.now());
  await ctx.clock.advance(60_000);
  assert.equal(ctx.pchk.sockets.length, 1);
  // A restart during the pause waits for its end.
  await ctx.app.start({ ...BASE });
  await ctx.clock.advance(60_000);
  assert.equal(ctx.pchk.sockets.length, 1);
  ctx.pchk.licence = false;
  await ctx.clock.advance(300_000);
  await until(() => ctx.app.online);
  await ctx.app.chain;
  assert.equal(store.data.pause, null);
});

test('a restart never connects faster than the spacing of the attempts', async (t) => {
  const clockStart = 1_000_000_000;
  const store = memoryStore({ lastAttemptAt: clockStart - 2_000 });
  const ctx = await setup(t, { store, ready: false });
  await ctx.clock.advance(5_000);
  assert.equal(ctx.pchk.sockets.length, 0, 'waits 10 s after the last attempt');
  await ctx.clock.advance(5_000);
  assert.equal(ctx.pchk.sockets.length, 1);
  await settle();
  // Written at most once a minute: 10 s after the last one, not yet.
  assert.equal(store.data.lastAttemptAt, clockStart - 2_000);
  await ctx.clock.advance(70_000);
  ctx.pchk.drop();
  await ctx.clock.advance(15_000);
  assert.equal(ctx.pchk.sockets.length, 2);
  assert.ok(store.data.lastAttemptAt > clockStart + 60_000);
});

test('keys sent to the host: scene events', async (t) => {
  const ctx = await setup(t);
  // Table A hit (01), table B make (10 << 2): keys 2 and 3.
  ctx.pchk.keys(0, 5, 0b1001, 0b110);
  await ctx.clock.advance(100);
  await ctx.app.chain;
  assert.deepEqual(ctx.gladys.fake.sceneEvents, [
    { key: 'key', data: { module: 'M5', table: 'A', key: 2, action: 'hit' } },
    { key: 'key', data: { module: 'M5', table: 'A', key: 3, action: 'hit' } },
    { key: 'key', data: { module: 'M5', table: 'B', key: 2, action: 'make' } },
    { key: 'key', data: { module: 'M5', table: 'B', key: 3, action: 'make' } },
  ]);
});

test('LCN scenes: off by default, then the register and the scene', async (t) => {
  const ctx = await setup(t);
  const fields = { module: ctx.ids.device, register: 1, scene: 3, target: 'both' };
  let ack = await ctx.gladys.fake.sceneAction('activate_scene', fields);
  assert.equal(ack.success, false);
  assert.match(ack.error, /disabled in the configuration/);
  await ctx.gladys.fake.configUpdated({ ...BASE, allow_scenes: true });
  const pending = ctx.gladys.fake.sceneAction('activate_scene', fields);
  await ctx.clock.advance(2_000);
  ack = await pending;
  assert.equal(ack.success, true, ack.error);
  const lines = ctx.pchk.lines.slice(-3);
  assert.deepEqual(lines, ['>M000005.SZW001', '>M000005.SZA7003', '>M000005.SZA000311111111']);
  ack = await ctx.gladys.fake.sceneAction('activate_scene', { ...fields, scene: 12 });
  assert.equal(ack.success, false);
});

test('a kind changed: the created features are kept, a kept light is refused', async (t) => {
  const first = await setup(t, { config: { ports: 'M5.A1:light' } });
  const created = first.gladys.fake.discoveredDevices;
  first.app.stop();
  const ctx = await setup(t, { config: { ports: 'M5.A1' }, devices: created });
  const keys = ctx.device(ctx.ids.device).features.map((f) => f.external_id.split(':').at(-1));
  assert.deepEqual(keys, ['a1_state', 'a1_level', 'a1_on', 'a1_off', 'a1_light', 'a1_brightness']);
  assert.equal(ctx.state(ctx.ids.feature('a1_light')), 1, 'its state still follows the bus');
  const ack = await ctx.command('a1_light', 0, 100);
  assert.match(ack.error, /not declared as a light or a switch/);
});

test('a reconnection to Gladys sends the status and the Discovery again; Scan is spaced', async (t) => {
  const ctx = await setup(t);
  const statuses = ctx.gladys.fake.connectionStatuses.length;
  const discoveries = ctx.gladys.fake.bodies('POST', '/discovered_device').length;
  await ctx.app.connected({ ...BASE });
  assert.equal(ctx.gladys.fake.connectionStatuses.length, statuses + 1);
  assert.equal(ctx.gladys.fake.bodies('POST', '/discovered_device').length, discoveries + 1);
  const scans = ctx.pchk.lines.filter((l) => l.endsWith('!LEER')).length;
  await ctx.gladys.fake.scanRequest();
  await ctx.clock.advance(20_000);
  assert.equal(
    ctx.pchk.lines.filter((l) => l.endsWith('!LEER')).length,
    scans,
    'scanned a minute ago at most',
  );
  await ctx.clock.advance(60_000);
  await ctx.gladys.fake.scanRequest();
  await ctx.clock.advance(20_000);
  assert.ok(ctx.pchk.lines.filter((l) => l.endsWith('!LEER')).length > scans);
});

test('the test button: connected, it only reports', async (t) => {
  const ctx = await setup(t);
  const sockets = ctx.pchk.sockets.length;
  const ack = await ctx.gladys.fake.action('test_connection');
  assert.equal(ack.success, true, ack.error);
  assert.equal(ctx.pchk.sockets.length, sockets);
});
