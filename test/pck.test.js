// The PCK lines, read and written, against pypck's patterns and generators.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LineReader } from '../src/lcn/lines.js';
import {
  PCK,
  LOGIN,
  bitsOf,
  convertVariable,
  hardwareName,
  header,
  keyEvents,
  parseLine,
} from '../src/lcn/pck.js';

test('the login lines of PCHK', () => {
  assert.deepEqual(parseLine('Username:'), { kind: 'username' });
  assert.deepEqual(parseLine('Password:'), { kind: 'password' });
  assert.deepEqual(parseLine('OK'), { kind: 'auth_ok' });
  assert.deepEqual(parseLine('Authentification failed.'), { kind: 'auth_failed' });
  assert.deepEqual(parseLine('Authentication failed.'), { kind: 'auth_failed' });
  assert.deepEqual(parseLine('(dec-mode)'), { kind: 'dec_mode' });
  assert.deepEqual(parseLine('$err:(license?)'), { kind: 'licence' });
  assert.deepEqual(parseLine('$io:#LCN:connected'), { kind: 'bus', connected: true });
  assert.deepEqual(parseLine('$io:#LCN:disconnected'), { kind: 'bus', connected: false });
  assert.deepEqual(parseLine('^ping12-'), { kind: 'ping', count: 12 });
  assert.equal(parseLine('LCN-PCK/IP 1.0'), undefined);
});

test('the lines of the modules (pypck inputs)', () => {
  assert.deepEqual(parseLine('-M000005!'), { kind: 'ack', seg: 0, module: 5, code: 0 });
  assert.deepEqual(parseLine('-M000005009'), { kind: 'ack', seg: 0, module: 5, code: 9 });
  assert.deepEqual(parseLine(':M000005A1050'), {
    kind: 'output',
    seg: 0,
    module: 5,
    output: 1,
    percent: 50,
  });
  assert.equal(parseLine(':M000005O2101').percent, 50.5);
  assert.equal(parseLine(':M000005A1101'), undefined, 'over 100 %');
  assert.deepEqual(parseLine(':M000005Rx005').bits.slice(0, 3), [true, false, true]);
  assert.equal(parseLine(':M000005Bx001').kind, 'binaries');
  assert.equal(parseLine(':M000005Rx256'), undefined);
  assert.deepEqual(parseLine('%M000005.A00101215'), {
    kind: 'variable',
    seg: 0,
    module: 5,
    port: 'var1',
    value: 1215,
  });
  assert.equal(parseLine('%M000005.A01301215'), undefined, 'variable 13');
  assert.equal(parseLine('%M000005.S101210').port, 'sp1');
  assert.equal(parseLine('%M000005.01200').port, null);
  assert.equal(parseLine('%M000005.A001999999'), undefined, 'over 0xFFFF');
  assert.deepEqual(parseLine('=M012005.SK012'), { kind: 'segment', seg: 12, module: 5, id: 12 });
  assert.deepEqual(parseLine('=M000005.SN1A2B3C4D5E06FW190B11HW17'), {
    kind: 'serial',
    seg: 0,
    module: 5,
    serial: '1A2B3C4D5E',
    firmware: 0x190b11,
    firmwareText: '190B11',
    hardware: 17,
  });
  assert.deepEqual(parseLine('=M000005.N1Kitchen'), {
    kind: 'name',
    seg: 0,
    module: 5,
    block: 1,
    text: 'Kitchen',
  });
  assert.deepEqual(parseLine('$M000005.STH009006'), {
    kind: 'keys',
    seg: 0,
    module: 5,
    actions: 9,
    keys: 6,
  });
  assert.equal(parseLine('+M004000005.STH001001').kind, 'keys');
  // Anchored: nothing glued before or after.
  assert.equal(parseLine(':M000005A1050x'), undefined);
  assert.equal(parseLine('x:M000005A1050'), undefined);
  assert.equal(parseLine(`:M000005A1${'0'.repeat(400)}`), undefined);
});

test('keys sent to the host and the bits of a byte', () => {
  assert.deepEqual(bitsOf(5).slice(0, 4), [true, false, true, false]);
  assert.deepEqual(keyEvents({ actions: 0b110111, keys: 0b10000001 }), [
    { table: 'A', key: 1, action: 'break' },
    { table: 'A', key: 8, action: 'break' },
    { table: 'B', key: 1, action: 'hit' },
    { table: 'B', key: 8, action: 'hit' },
    { table: 'C', key: 1, action: 'break' },
    { table: 'C', key: 8, action: 'break' },
  ]);
  assert.deepEqual(
    keyEvents({ actions: 0b0111, keys: 1 }).map((e) => `${e.table}${e.key}${e.action}`),
    ['A1break', 'B1hit'],
  );
  assert.deepEqual(keyEvents({ actions: 0, keys: 255 }), []);
});

test('values of the variables (pypck VarValue)', () => {
  assert.equal(convertVariable(1215, 'temperature'), 21.5);
  assert.equal(convertVariable(800, 'temperature'), -20);
  assert.equal(convertVariable(0xffff, 'temperature'), undefined, 'no value');
  assert.equal(convertVariable(0x8100, 'temperature'), undefined, 'undefined');
  assert.equal(convertVariable(0x7f05, 'temperature'), undefined, 'defective');
  assert.equal(convertVariable(0x8000 | 1210, 'setpoint'), 21, 'locked set point');
  assert.equal(convertVariable(45, 'humidity'), 45);
  assert.equal(convertVariable(150, 'humidity'), undefined);
  assert.equal(convertVariable(690, 'lux'), Math.round(Math.exp(6.9)));
  assert.equal(convertVariable(1152, 'lux'), 100_000, 'capped to the declared maximum');
  assert.equal(convertVariable(1200, 'lux'), undefined);
  assert.equal(convertVariable(800, 'co2'), 800);
  assert.equal(convertVariable(12345, 'value'), 12345);
  assert.equal(convertVariable(-1, 'value'), undefined);
  assert.equal(convertVariable(1.5, 'value'), undefined);
});

test('the lines written (pypck PckGenerator)', () => {
  assert.equal(header(0, 5), '>M000005.');
  assert.equal(header(3, 3, { group: true, ack: true }), '>G003003!');
  assert.equal(PCK.segmentScan(), '>G003003.SK');
  assert.equal(PCK.moduleScan(0), '>G000003!LEER');
  assert.equal(PCK.dim(1, 50), 'A1DI050000');
  assert.equal(PCK.dim(4, 100), 'A4DI100000');
  assert.equal(PCK.relay(3, true), 'R8--1-----');
  assert.equal(PCK.relay(8, false), 'R8-------0');
  assert.equal(PCK.outputStatus(2), 'SMA2');
  assert.equal(PCK.variable('var1', 0x170206, 0x170206), 'MWT1');
  assert.equal(PCK.variable('var12', 0x190b11, 0x170206), 'MWT12');
  assert.equal(PCK.variable('sp2', 0x190b11, 0x170206), 'MWS2');
  assert.equal(PCK.variable('var1', 0x150101, 0x170206), 'MWV');
  assert.equal(PCK.variable('var3', 0x150101, 0x170206), 'MWTB');
  assert.equal(PCK.variable('sp1', 0x150101, 0x170206), 'MWSA');
  assert.equal(PCK.variable('var4', 0x150101, 0x170206), undefined, 'old modules: 3 variables');
  assert.equal(PCK.sceneRegister(2), 'SZW002');
  assert.equal(PCK.sceneOutputs(5), 'SZA7005');
  assert.equal(PCK.sceneRelays(5), 'SZA000511111111');
  assert.equal(LOGIN.operationMode(true), '!OM1P');
  assert.equal(LOGIN.operationMode(false), '!OM0P');
  assert.equal(hardwareName(17), 'LCN-UPS');
  assert.equal(hardwareName(999), 'LCN');
});

test('the line reader: split, CR LF, bounded, control characters, Latin-1', () => {
  const lines = [];
  const drops = [];
  const reader = new LineReader({
    onLine: (l) => lines.push(l),
    onDrop: (w) => drops.push(w),
    maxLine: 20,
  });
  reader.push(Buffer.from('OK\r\n:M0000'));
  reader.push(Buffer.from('05A1050\n\n'));
  assert.deepEqual(lines, ['OK', ':M000005A1050']);
  // Too long: dropped whole, never kept, the next line is read.
  reader.push(Buffer.from('x'.repeat(15)));
  reader.push(Buffer.from('y'.repeat(15)));
  reader.push(Buffer.from('z'.repeat(5000)));
  reader.push(Buffer.from('\nOK\n'));
  assert.deepEqual(lines.slice(2), ['OK']);
  assert.equal(reader.length, 0);
  reader.push(Buffer.from('a\u0001b\n'));
  reader.push(Buffer.from([0x3d, 0x4e, 0xe9, 0x0a]));
  assert.equal(lines.at(-1), '=Né');
  assert.deepEqual(drops, ['too long', 'control character']);
});

test('the line reader is linear: 4 MB in small chunks', () => {
  let count = 0;
  const reader = new LineReader({ onLine: () => (count += 1) });
  const chunk = Buffer.from(':M000005A1050\n'.repeat(100));
  const started = Date.now();
  for (let i = 0; i < 3000; i += 1) reader.push(chunk);
  assert.equal(count, 300_000);
  assert.ok(Date.now() - started < 5_000);
});
