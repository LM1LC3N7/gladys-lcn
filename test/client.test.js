// LcnClient alone, against the in-memory PCHK and a virtual clock.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIMITS, TIMINGS } from '../src/constants.js';
import { LcnClient } from '../src/lcn/client.js';
import { FakeClock, FakePchk, quietLogger, until } from './helpers/fakePchk.js';

function setup(t, options = {}) {
  const clock = new FakeClock();
  const pchk = new FakePchk(options);
  const logger = quietLogger();
  const client = new LcnClient({ connect: pchk.connect, timers: clock, now: clock.now, logger });
  client.configure({ host: 'h', port: 4114, username: 'lcn', password: 'secret', dim200: true });
  const downs = [];
  client.on('down', (info) => downs.push(info));
  t.after(() => client.stop());
  return { clock, pchk, client, logger, downs };
}

test('PCHK silent after the connection: cut after the login timeout, next try in 10 s', async (t) => {
  const ctx = setup(t);
  ctx.pchk.silent = true;
  ctx.client.start();
  await ctx.clock.advance(TIMINGS.loginTimeout + 100);
  assert.equal(ctx.downs.length, 1);
  assert.equal(ctx.downs[0].reason, 'no login answer from PCHK');
  assert.equal(ctx.downs[0].retryIn, 10_000);
  await ctx.clock.advance(10_000);
  assert.equal(ctx.pchk.sockets.length, 2);
  // The tries are spaced more and more.
  await ctx.clock.advance(TIMINGS.loginTimeout + 100);
  assert.equal(ctx.downs[1].retryIn, 30_000);
});

test('the user name asked twice: refused, never sent a third time', async (t) => {
  const ctx = setup(t, { password: 'other' });
  ctx.client.start();
  await ctx.clock.advance(1_000);
  assert.equal(ctx.downs.length, 1);
  assert.equal(ctx.downs[0].refused, true);
  assert.equal(ctx.downs[0].retryIn, undefined);
  await ctx.clock.advance(3_600_000);
  assert.equal(ctx.pchk.sockets.length, 1);
  assert.equal(ctx.pchk.log.filter((e) => e.line === 'secret').length, 1);
});

test('the ping: answered keeps the session, unanswered cuts it', async (t) => {
  const ctx = setup(t);
  ctx.client.start();
  await ctx.clock.advance(6_000);
  await until(() => ctx.client.connected);
  await ctx.clock.advance(TIMINGS.ping + 1_000);
  assert.ok(ctx.pchk.log.some((e) => e.line === '^ping1'));
  assert.equal(ctx.downs.length, 0);
  ctx.pchk.hold = (line) => line.startsWith('^ping');
  await ctx.clock.advance(TIMINGS.ping + TIMINGS.pingTimeout);
  assert.equal(ctx.downs.length, 1);
  assert.equal(ctx.downs[0].reason, 'no answer to the ping');
});

test('the queue: the check right before the write, the deadline, the bounds', async (t) => {
  const ctx = setup(t);
  ctx.client.start();
  await ctx.clock.advance(6_000);
  await until(() => ctx.client.connected);
  let allowed = true;
  await ctx.client.send('>M000005.A1DI100000', { urgent: true });
  // Written 60 ms after the line before: the option is switched off meanwhile.
  const second = ctx.client.send('>M000005.A2DI100000', {
    urgent: true,
    check: () => (allowed ? undefined : 'withdrawn'),
  });
  const secondResult = second.catch((err) => err);
  allowed = false;
  await ctx.clock.advance(100);
  const err = await secondResult;
  assert.equal(err.kind, 'withdrawn');
  assert.equal(err.sent, false);
  assert.ok(!ctx.pchk.lines.includes('>M000005.A2DI100000'));
  // Too late: never written.
  const late = ctx.client.send('>M000005.A3DI100000', {
    urgent: true,
    sendBy: ctx.clock.now() - 1,
  });
  await assert.rejects(late, (err) => err.kind === 'late');
  // Bounded queues; a full background queue never refuses a command.
  const reads = [];
  for (let i = 0; i < LIMITS.maxQueue + 5; i += 1) {
    reads.push(ctx.client.send(`>M000005.SMA${(i % 4) + 1}x${i}`).catch((err) => err.kind));
  }
  const command = ctx.client.send('>M000005.A4DI000000', { urgent: true });
  await ctx.clock.advance(1_000);
  await command;
  assert.ok(ctx.pchk.lines.includes('>M000005.A4DI000000'));
  ctx.client.stop();
  const kinds = await Promise.all(reads);
  // The first read is written at once: 4 or 5 refused, never queued.
  assert.ok(kinds.filter((k) => k === 'full').length >= 4);
});

test('an answer only from a line received after the write', async (t) => {
  const ctx = setup(t);
  ctx.client.start();
  await ctx.clock.advance(6_000);
  await until(() => ctx.client.connected);
  ctx.pchk.hold = (line) => line === '>M000005.SMA1';
  // A status of that output arrives just before the request: it does not answer it.
  ctx.pchk.line(':M000005A1050');
  await ctx.clock.advance(10);
  const asked = ctx.client
    .send('>M000005.SMA1', {
      wait: { match: (i) => i.kind === 'output' && i.output === 1, timeout: 1_000 },
    })
    .catch((err) => err);
  await ctx.clock.advance(1_500);
  const err = await asked;
  assert.equal(err.kind, 'timeout');
  assert.equal(err.sent, true);
});
