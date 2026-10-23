import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIMITS } from '../src/constants.js';
import { cleanEventData } from '../src/publisher.js';
import { fileStore, normalizeMemory, refusedStop, stopHolds } from '../src/store.js';

test('a refused login: a salted fingerprint, never the password', () => {
  const stop = refusedStop('tcp://h:4114', 'lcn', 'wrong', 1);
  assert.ok(!JSON.stringify(stop).includes('wrong'));
  assert.ok(stopHolds(stop, 'tcp://h:4114', 'lcn', 'wrong'));
  assert.ok(!stopHolds(stop, 'tcp://h:4114', 'lcn', 'right'));
  assert.ok(!stopHolds(stop, 'tcp://h:4114', 'admin', 'wrong'));
  assert.ok(!stopHolds(stop, 'tcp://other:4114', 'lcn', 'wrong'));
  // Salted: the same credentials give another fingerprint each time.
  assert.notEqual(
    refusedStop('p', 'lcn', 'wrong', 1).hash,
    refusedStop('p', 'lcn', 'wrong', 1).hash,
  );
});

test('the persisted state is repaired; a pause never longer than the longest', () => {
  const now = 1_000_000;
  assert.deepEqual(normalizeMemory(null, now), { stop: null, pause: null, lastAttemptAt: 0 });
  assert.deepEqual(normalizeMemory({ stop: { place: 'p', kind: 'x' } }, now).stop, null);
  const memory = normalizeMemory(
    { pause: { place: 'p', until: now + 1e12 }, lastAttemptAt: now + 5_000 },
    now,
  );
  assert.equal(memory.pause.until, now + LIMITS.maxPause);
  assert.equal(memory.lastAttemptAt, now, 'a time in the future counts as now');
  const stop = refusedStop('p', 'u', 'w', 3);
  assert.deepEqual(normalizeMemory({ stop }, now).stop, stop);
  assert.equal(normalizeMemory({ stop: { ...stop, hash: 'zz' } }, now).stop, null);
});

test('the file store writes 0600 through a temporary file', async (t) => {
  // Under the repository's data/ (git-ignored), never the system temporary folder.
  const base = fileURLToPath(new URL('../data/', import.meta.url));
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, 'store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json');
  const store = fileStore(path);
  assert.equal(await store.load(), null);
  await Promise.all([store.save({ a: 1 }), store.save({ a: 2 })]);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { a: 2 });
  if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test('a scene event never carries undefined nor NaN', () => {
  assert.deepEqual(cleanEventData({ a: undefined, b: NaN, c: Infinity, d: 1, e: 'x' }), {
    a: null,
    b: null,
    c: null,
    d: 1,
    e: 'x',
  });
});
