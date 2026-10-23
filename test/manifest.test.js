// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here. They also keep
// the texts clean (no mojibake, no BOM, no control byte) and honest (never
// tested, unofficial, a secret field is not "encrypted").
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DEFAULTS, LANGUAGES, PORT_FAMILIES } from '../src/config.js';
import {
  ACTIONS,
  DEFAULT_PORT,
  DIM_MODES,
  KEY_ACTIONS,
  KEY_TABLES,
  SCENE_ACTIONS,
  SCENE_TARGETS,
  SCENE_TRIGGERS,
} from '../src/constants.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const handlers = read('src/handlers.js');
const app = read('src/app.js');

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, entry] of node.entries()) yield* texts(entry, `${path}[${i}]`);
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) yield* texts(value, `${path}.${key}`);
  }
}

const values = (field) => field.options.map((o) => o.value);
const TEXT_FILES = [
  'gladys-assistant-integration.json',
  'docs/fr.md',
  'docs/en.md',
  'README.md',
  'CHANGELOG.md',
  'TODO.md',
  'CLAUDE.md',
  'THIRD_PARTY_NOTICES.md',
];

const SOURCE_FILES = [
  'index.js',
  ...readdirSync(new URL('../src/', import.meta.url), { recursive: true })
    .filter((f) => String(f).endsWith('.js'))
    .map((f) => `src/${String(f).replace(/\\/g, '/')}`),
];

test('the store basics; the version agrees everywhere, never pinned here', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  assert.ok(manifest.name.length >= 3 && manifest.name.length <= 30);
  assert.equal(manifest.gladys_version, '>=5.1.0', 'scene triggers and actions need Gladys 5.1');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.docker_image, `ghcr.io/lm1lc3n7/gladys-lcn:${manifest.version}`);
  assert.equal(manifest.version, JSON.parse(read('package.json')).version);
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(manifest.version, lock.version);
  assert.equal(manifest.version, lock.packages[''].version);
  assert.deepEqual(manifest.transports, ['local']);
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    const docs = read(`docs/${lang}.md`);
    assert.ok(docs.length >= 300, `docs/${lang}.md is too short for the store`);
    assert.match(docs, /not\s+affiliated\s+with\s+LCN|sans\s+lien\s+avec\s+LCN/i);
    assert.match(
      docs,
      /never\s+tested\s+with\s+a\s+real\s+(?:installation|device)|jamais\s+testée?\s+avec\s+un(?:e)?\s+vrai(?:e)?\s+(?:installation|appareil)/i,
      `docs/${lang}.md`,
    );
  }
  assert.match(manifest.config_schema[0].description.en, /Never tested with a real installation/);
  assert.match(
    manifest.config_schema[0].description.fr,
    /Jamais testé avec une vraie installation/,
  );
});

test('no double-encoded UTF-8 (mojibake), no BOM, no control byte in the texts and the code', () => {
  // U+00C3 U+00A9 for "Ã©", U+00C2 U+00AB for "Â«", U+00E2 U+20AC for "â€":
  // UTF-8 read as Windows-1252 and written again. Built from code points so
  // this file never holds one.
  const c = (code) => String.fromCharCode(code);
  const mojibake = new RegExp(
    `[${c(0xc2)}${c(0xc3)}][${c(0x80)}-${c(0xbf)}${c(0x20ac)}${c(0x201a)}-${c(0x2122)}]|${c(0xe2)}${c(0x20ac)}`,
  );
  assert.match(`caf${c(0xc3)}${c(0xa9)}`, mojibake, 'the guard catches a double encoding');
  assert.match(`${c(0xe2)}${c(0x20ac)}${c(0x201d)}`, mojibake, 'and the dash family');
  // eslint-disable-next-line no-control-regex
  const control = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
  for (const path of [...TEXT_FILES, ...SOURCE_FILES]) {
    const text = read(path);
    assert.doesNotMatch(text, mojibake, path);
    assert.doesNotMatch(text, control, path);
    assert.notEqual(text.charCodeAt(0), 0xfeff, `${path} starts with a BOM`);
  }
});

test('a secret field is never said to be encrypted', () => {
  for (const path of [...TEXT_FILES, 'src/i18n.js']) {
    // "chiffres" (digits) is fine, "chiffré" (encrypted) is not.
    assert.doesNotMatch(read(path), /chiffré|chiffrement|\bencrypt/i, path);
  }
  const password = manifest.config_schema.find((f) => f.key === 'password');
  assert.match(password.description.fr, /Gardé par Gladys dans sa base, jamais réaffiché/);
  assert.match(password.description.en, /Kept by Gladys in its database, never shown again/);
});

test('the licence names nobody; the reference is credited', () => {
  const licence = read('LICENSE');
  assert.match(licence, /Apache License/);
  assert.match(licence, /Copyright \[yyyy\] \[name of copyright owner\]/);
  assert.doesNotMatch(licence, /Copyright (?:\(c\) )?\d{4}/i);
  const notices = read('THIRD_PARTY_NOTICES.md');
  assert.match(notices, /pypck[\s\S]*Andre Lengwenus/);
  assert.match(notices, /MIT License[\s\S]*Permission is hereby granted/);
  assert.match(read('Dockerfile'), /COPY LICENSE THIRD_PARTY_NOTICES\.md/);
});

test('every text is in English and French', () => {
  for (const [path, text] of texts(manifest)) {
    for (const lang of ['en', 'fr']) assert.ok(text[lang]?.trim(), `${path} needs ${lang}`);
  }
});

test('the configuration matches the code; the risky options are off', () => {
  const fields = Object.fromEntries(manifest.config_schema.map((f) => [f.key, f]));
  for (const [key, value] of Object.entries(DEFAULTS)) {
    assert.ok(fields[key], `${key} is not in the config_schema`);
    assert.deepEqual(fields[key].default, value, key);
  }
  assert.equal(fields.allow_output_buttons.default, false);
  assert.equal(fields.allow_scenes.default, false);
  assert.equal(fields.password.type, 'secret', 'the password is never sent back to the browser');
  assert.equal(fields.password.default, undefined);
  assert.equal(fields.port.default, DEFAULT_PORT);
  assert.deepEqual(values(fields.dim_mode), DIM_MODES);
  assert.deepEqual(values(fields.language), LANGUAGES);
  assert.equal(fields.host.required, true);
  // Every kind of "Ports" is explained.
  for (const kind of new Set(Object.values(PORT_FAMILIES).flat())) {
    if (['readonly', 'binary', 'setpoint'].includes(kind)) continue;
    assert.match(fields.ports.description.en, new RegExp(`\\b${kind}\\b`), kind);
  }
  for (const section of manifest.config_schema.filter((f) => f.type === 'section')) {
    assert.equal(section.required ?? section.default ?? section.placeholder, undefined);
    for (const lang of ['en', 'fr']) {
      assert.ok(section.description[lang].length <= 1000, `${section.key}.${lang} too long`);
    }
    assert.ok((section.links ?? []).every((l) => l.url.startsWith('https://')));
  }
});

test('the keys of the manifest are the keys of the code', () => {
  assert.deepEqual(manifest.actions.map((a) => a.key).sort(), Object.values(ACTIONS).sort());
  for (const name of Object.keys(ACTIONS)) {
    assert.ok(handlers.includes(`onAction(ACTIONS.${name}`), `ACTIONS.${name} has no handler`);
  }
  assert.deepEqual(
    manifest.scene_actions.map((a) => a.key).sort(),
    Object.values(SCENE_ACTIONS).sort(),
  );
  for (const name of Object.keys(SCENE_ACTIONS)) {
    assert.ok(handlers.includes(`onSceneAction(SCENE_ACTIONS.${name}`), name);
  }
  const action = manifest.scene_actions[0];
  assert.deepEqual(
    action.fields.map((f) => f.key),
    ['module', 'register', 'scene', 'target'],
  );
  assert.deepEqual(values(action.fields.find((f) => f.key === 'target')), SCENE_TARGETS);
  for (const key of ['module', 'register', 'scene', 'target']) {
    assert.match(app, new RegExp(`fields\\.${key}\\b`), `${key} is never read`);
  }
  assert.deepEqual(
    manifest.scene_triggers.map((t) => t.key).sort(),
    Object.values(SCENE_TRIGGERS).sort(),
  );
  const trigger = manifest.scene_triggers[0];
  assert.deepEqual(
    [...trigger.fields, ...trigger.variables].map((f) => f.key),
    ['module', 'table', 'key', 'action', 'module', 'table', 'key', 'action'],
  );
  assert.deepEqual(values(trigger.fields.find((f) => f.key === 'action')), KEY_ACTIONS);
  assert.deepEqual(values(trigger.fields.find((f) => f.key === 'table')), KEY_TABLES);
});
