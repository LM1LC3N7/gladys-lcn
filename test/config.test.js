import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  moduleLabel,
  normalizeConfig,
  parseHost,
  parseModuleRef,
  parsePort,
  parsePorts,
  portsOf,
  sessionKey,
} from '../src/config.js';
import { LIMITS } from '../src/constants.js';

test('the defaults are the safe ones', () => {
  const config = normalizeConfig({});
  assert.equal(config.port, 4114);
  assert.equal(config.dim200, true);
  assert.equal(config.allowOutputButtons, false);
  assert.equal(config.allowScenes, false);
  assert.equal(config.language, 'fr');
  // Only true turns an option on.
  for (const value of ['yes', 1, '1', null, 'TRUE ']) {
    assert.equal(normalizeConfig({ allow_output_buttons: value }).allowOutputButtons, false);
  }
  assert.equal(normalizeConfig({ allow_scenes: 'true' }).allowScenes, true);
  assert.equal(normalizeConfig({ dim_mode: 'steps50' }).dim200, false);
  assert.equal(normalizeConfig({ dim_mode: 'odd' }).dim200, true);
});

test('the address of PCHK', () => {
  assert.deepEqual(parseHost(' 192.168.1.4 '), { host: '192.168.1.4', port: undefined });
  assert.deepEqual(parseHost('pchk.lan:4115'), { host: 'pchk.lan', port: 4115 });
  assert.deepEqual(parseHost('tcp://[fe80::1]:4114/x'), { host: 'fe80::1', port: 4114 });
  assert.equal(parseHost('user@host').host, '');
  assert.equal(normalizeConfig({ host: 'h:4200', port: 4114 }).port, 4200);
  assert.equal(normalizeConfig({ port: 99999 }).port, 65535);
});

test('modules and ports as written in LCN-PRO', () => {
  assert.deepEqual(parseModuleRef('M5'), { seg: 0, module: 5 });
  assert.deepEqual(parseModuleRef('m005'), { seg: 0, module: 5 });
  assert.deepEqual(parseModuleRef('5'), { seg: 0, module: 5 });
  assert.deepEqual(parseModuleRef('S12M7'), { seg: 12, module: 7 });
  for (const bad of ['M4', 'M255', 'S3M5', 'S200M5', 'X5', '', 'constructor']) {
    assert.equal(parseModuleRef(bad), undefined, bad);
  }
  assert.equal(moduleLabel(0, 5), 'M5');
  assert.equal(moduleLabel(12, 7), 'S12M7');
  assert.deepEqual(parsePort('a1'), { port: 'a1', family: 'output', number: 1 });
  assert.deepEqual(parsePort('TVAR'), { port: 'var1', family: 'variable', number: 1 });
  assert.deepEqual(parsePort('R2VAR'), { port: 'var3', family: 'variable', number: 3 });
  assert.deepEqual(parsePort('VAR12'), { port: 'var12', family: 'variable', number: 12 });
  assert.deepEqual(parsePort('R2VARSETPOINT'), { port: 'sp2', family: 'setpoint', number: 2 });
  for (const bad of ['A5', 'R9', 'B0', 'VAR13', '__proto__'])
    assert.equal(parsePort(bad), undefined);
});

test('"Ports": kinds, defaults, errors, bounds', () => {
  const { modules, errors } = parsePorts(
    'M5.A1:light; m5/r3:switch\nS12M7.TVAR, M5.B1:motion, M5.A2, M5.A3:pump, x, M5.R1:readonly, __proto__.A1',
  );
  assert.deepEqual(
    [...modules.get('0-5')],
    [
      ['a1', 'light'],
      ['r3', 'switch'],
      ['b1', 'motion'],
      ['a2', 'readonly'],
      ['r1', 'readonly'],
    ],
  );
  assert.deepEqual([...modules.get('12-7')], [['var1', 'temperature']]);
  assert.deepEqual(errors, ['M5.A3:pump', 'x', '__proto__.A1']);
  // A module not listed: A1 and A2, read only.
  const config = normalizeConfig({ ports: 'M5.A1:light' });
  assert.deepEqual(
    [...portsOf(config, '0-9')],
    [
      ['a1', 'readonly'],
      ['a2', 'readonly'],
    ],
  );
  const many = Array.from(
    { length: LIMITS.maxPorts + 10 },
    (_, i) => `M${5 + (i % 200)}.R${1 + (i % 8)}`,
  );
  const big = parsePorts(many.join(','));
  let count = 0;
  for (const ports of big.modules.values()) count += ports.size;
  assert.ok(count <= LIMITS.maxPorts);
});

test('what reconnects: the place and the credentials, not the options', () => {
  const a = normalizeConfig({ host: 'h', username: 'u', password: 'p' });
  const b = normalizeConfig({
    host: 'h',
    username: 'u',
    password: 'p',
    allow_scenes: true,
    ports: 'M5.A1',
  });
  assert.equal(sessionKey(a), sessionKey(b));
  assert.notEqual(
    sessionKey(a),
    sessionKey(normalizeConfig({ host: 'h', username: 'u', password: 'q' })),
  );
});
