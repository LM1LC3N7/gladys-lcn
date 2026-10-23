// -----------------------------------------------------------------------------
// The configuration of the manifest `config_schema`, normalized; the module
// references (`M5`, `S12M5`) and the "Ports" field.
// -----------------------------------------------------------------------------

import { DEFAULT_PORT, DIM_MODES, LIMITS } from './constants.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULTS = {
  port: DEFAULT_PORT,
  dim_mode: 'steps200',
  allow_output_buttons: false,
  allow_scenes: false,
  language: 'fr',
};

export const LANGUAGES = ['fr', 'en'];

/** The ports of a module and how each may show (the first kind is the default). */
export const PORT_FAMILIES = {
  output: ['readonly', 'light', 'switch'],
  relay: ['readonly', 'switch', 'light'],
  binary: ['binary', 'motion'],
  variable: ['temperature', 'humidity', 'lux', 'co2', 'value'],
  setpoint: ['setpoint'],
};

/** The ports a module shows when "Ports" lists none of its own. */
export const DEFAULT_PORTS = new Map([
  ['a1', 'readonly'],
  ['a2', 'readonly'],
]);

/** Only `true` turns an option on: a missing or odd value keeps the safe default. */
const strictTrue = (value) => value === true || value === 'true';

const integer = (value, fallback, min, max) => {
  const number = Number(value);
  return value !== null && value !== '' && value !== undefined && Number.isFinite(number)
    ? Math.round(Math.max(min, Math.min(max, number)))
    : fallback;
};

/** `192.168.1.9`, `pchk.lan:4114` -> { host, port? }. */
export function parseHost(raw) {
  const text = String(raw ?? '')
    .trim()
    .replace(/^[a-z]+:\/\//i, '')
    .replace(/\/.*$/, '');
  if (text.includes('@')) return { host: '' };
  const match = /^(\[[0-9a-f:.]+\]|[^:\s]+)(?::(\d{1,5}))?$/i.exec(text);
  if (!match || match[1].length > 253) return { host: '' };
  const port = match[2] ? Number(match[2]) : undefined;
  return {
    host: match[1].replace(/^\[|\]$/g, ''),
    port: port >= 1 && port <= 65535 ? port : undefined,
  };
}

/** The key of a module in ids and maps: `0-5` (logical segment, module id). */
export const moduleKey = (seg, module) => `${seg}-${module}`;

/** How a module is written for the user (scene trigger, status, "Ports"): `M5`, `S12M5`. */
export const moduleLabel = (seg, module) => (seg === 0 ? `M${module}` : `S${seg}M${module}`);

/**
 * A module address: segment 0 (local) or 5 to 127 (never 3, the broadcast,
 * nor 4, the status messages), module 5 to 254 (never LCN-PRO, PCHK, an
 * unprogrammed module).
 */
export const validAddress = (seg, module) =>
  Number.isInteger(seg) &&
  Number.isInteger(module) &&
  (seg === 0 || (seg >= 5 && seg <= LIMITS.maxSegment)) &&
  module >= LIMITS.minModule &&
  module <= LIMITS.maxModule;

/** `M5`, `5`, `m005`, `S12M5` -> { seg, module }, undefined if not a module. */
export function parseModuleRef(raw) {
  const match = /^(?:S(\d{1,3}))?M?(\d{1,3})$/i.exec(String(raw ?? '').trim());
  if (!match) return undefined;
  const seg = match[1] === undefined ? 0 : Number(match[1]);
  const module = Number(match[2]);
  return validAddress(seg, module) ? { seg, module } : undefined;
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** A port as written (`A1`, `R3`, `B2`, `TVAR`, `VAR5`, `R1VARSETPOINT`...) -> { port, family }. */
export function parsePort(raw) {
  const text = String(raw ?? '')
    .trim()
    .toUpperCase();
  let m = /^A([1-4])$/.exec(text);
  if (m) return { port: `a${m[1]}`, family: 'output', number: Number(m[1]) };
  m = /^R([1-8])$/.exec(text);
  if (m) return { port: `r${m[1]}`, family: 'relay', number: Number(m[1]) };
  m = /^B([1-8])$/.exec(text);
  if (m) return { port: `b${m[1]}`, family: 'binary', number: Number(m[1]) };
  m = /^VAR(\d{1,2})$/.exec(text);
  if (m && Number(m[1]) >= 1 && Number(m[1]) <= 12) {
    return { port: `var${Number(m[1])}`, family: 'variable', number: Number(m[1]) };
  }
  const alias = { TVAR: 1, R1VAR: 2, R2VAR: 3 }[text];
  if (alias) return { port: `var${alias}`, family: 'variable', number: alias };
  m = /^(?:R([12])VARSETPOINT|SP([12]))$/.exec(text);
  if (m) {
    const number = Number(m[1] ?? m[2]);
    return { port: `sp${number}`, family: 'setpoint', number };
  }
  return undefined;
}

/** A canonical port key (`a1`, `r3`, `b2`, `var5`, `sp1`) -> { family, number }. */
export function portInfo(port) {
  const m = /^(a|r|b|var|sp)(\d{1,2})$/.exec(String(port ?? ''));
  if (!m) return undefined;
  const family = { a: 'output', r: 'relay', b: 'binary', var: 'variable', sp: 'setpoint' }[m[1]];
  const number = Number(m[2]);
  const max = { output: 4, relay: 8, binary: 8, variable: 12, setpoint: 2 }[family];
  return number >= 1 && number <= max ? { family, number } : undefined;
}

/**
 * "Ports": `M5.A1:light, M5.R3:switch, M5.B1:motion, S12M7.TVAR, M5.VAR4:humidity`
 * -> Map(moduleKey -> Map(port -> kind)). No kind: the first of the family
 * (outputs and relays read only, a temperature for a variable). Wrong
 * entries are reported, not fatal; LIMITS.maxPorts entries at most.
 */
export function parsePorts(raw) {
  const modules = new Map();
  const errors = [];
  let count = 0;
  for (const entry of String(raw ?? '')
    .slice(0, 20_000)
    .split(/[,;\n]+/)) {
    const text = entry.trim();
    if (text === '') continue;
    const match = /^([a-z0-9]{1,8})\s*[./]\s*([a-z0-9]{1,14})(?:\s*[:=]\s*([a-z]{1,12}))?$/i.exec(
      text,
    );
    const ref = match ? parseModuleRef(match[1]) : undefined;
    const port = match ? parsePort(match[2]) : undefined;
    const kinds = port ? PORT_FAMILIES[port.family] : undefined;
    const kind = (match?.[3] ?? kinds?.[0] ?? '').toLowerCase();
    if (!ref || !port || !kinds.includes(kind) || count >= LIMITS.maxPorts) {
      if (errors.length < 20) errors.push(text.slice(0, 40));
      continue;
    }
    const key = moduleKey(ref.seg, ref.module);
    if (!modules.has(key)) modules.set(key, new Map());
    modules.get(key).set(port.port, kind);
    count += 1;
  }
  return { modules, errors };
}

export function normalizeConfig(raw = {}) {
  const { host, port: hostPort } = parseHost(raw?.host);
  const language = String(raw?.language ?? DEFAULTS.language)
    .trim()
    .toLowerCase();
  const dimMode = String(raw?.dim_mode ?? DEFAULTS.dim_mode)
    .trim()
    .toLowerCase();
  const ports = parsePorts(raw?.ports);
  const username = typeof raw?.username === 'string' ? raw.username.slice(0, 64) : '';
  const password = typeof raw?.password === 'string' ? raw.password.slice(0, 128) : '';
  return {
    host,
    // A port typed with the address wins over the port field (which has a default).
    port: hostPort ?? integer(raw?.port, DEFAULTS.port, 1, 65535),
    // As typed: PCHK compares them as they are.
    username,
    password,
    // A line break would make two PCK lines: such credentials are never sent.
    credentialsInvalid: CONTROL.test(username) || CONTROL.test(password),
    dim200: (DIM_MODES.includes(dimMode) ? dimMode : DEFAULTS.dim_mode) === 'steps200',
    ports: ports.modules,
    portErrors: ports.errors,
    allowOutputButtons: strictTrue(raw?.allow_output_buttons),
    allowScenes: strictTrue(raw?.allow_scenes),
    language: LANGUAGES.includes(language) ? language : DEFAULTS.language,
  };
}

/** What the session depends on: a change reconnects. */
export const sessionKey = (config) =>
  JSON.stringify([config.host, config.port, config.username, config.password, config.dim200]);

/** Where the session goes, without the credentials: what a persisted stop is tied to. */
export const placeKey = (config) => `tcp://${config.host}:${config.port}`;

/** The ports a module shows: those of "Ports", else A1 and A2 read only. */
export const portsOf = (config, key) => config.ports.get(key) ?? DEFAULT_PORTS;
