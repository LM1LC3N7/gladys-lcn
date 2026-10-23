// -----------------------------------------------------------------------------
// The bus model -> Gladys devices and states (pure).
//
// One device per LCN module, keyed by its logical segment and its module id
// (`ext:<selector>:module:0-5`): the address is what LCN-PRO programs and
// what every module answers to; the local segment is always 0, with or
// without a segment coupler. Its features come from "Ports" (A1 and A2 read
// only when the module is not listed there), keyed `<port>_<role>`:
// - an output (A1 to A4) or a relay (R1 to R8) whose load is unknown is READ
//   ONLY: its state (and the level of an output), plus "turn on" / "turn off"
//   push buttons that work only when the configuration allows them. Only a
//   port declared `light` or `switch` becomes a light (with its brightness
//   for an output) or a switch: a "turn everything off" of a voice assistant,
//   the MCP or a scene reaches every switch and light, and a relay may drive a
//   pump, a heater, a door strike;
// - a binary sensor (B1 to B8): an input, or a motion sensor;
// - a variable (TVAR, R1VAR, R2VAR, VAR1 to VAR12): a temperature (°C), a
//   humidity (%), an illuminance (lux), a CO2 level (ppm) or a raw value;
// - a set point of a regulator (R1VARSETPOINT, R2VARSETPOINT): read only.
// Changing the kind of a port adds features with other keys; the created
// ones are kept (Gladys would mark the device changed, and "Update" would
// drop their history): a device published again never loses a feature.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { moduleKey, moduleLabel, portInfo, portsOf, validAddress } from './config.js';
import { DEVICE_NAME, featureName, word } from './i18n.js';
import { convertVariable, hardwareName } from './lcn/pck.js';

const command = (category, type, extra = {}) => ({
  category,
  type,
  read_only: false,
  has_feedback: true,
  keep_history: true,
  ...extra,
});

const reading = (category, type, extra = {}) => ({
  category,
  type,
  read_only: true,
  has_feedback: false,
  keep_history: true,
  ...extra,
});

const button = () =>
  command(C.BUTTON, T.BUTTON.PUSH, { min: 0, max: 1, has_feedback: false, keep_history: false });

/** Feature definitions by role (the last part of their key). Roles are forever. */
export const ROLE_FEATURES = {
  state: reading(C.UNKNOWN, T.SENSOR.BINARY, { min: 0, max: 1 }),
  level: reading(C.UNKNOWN, T.UNKNOWN.UNKNOWN, { min: 0, max: 100 }),
  on: button(),
  off: button(),
  light: command(C.LIGHT, T.LIGHT.BINARY, { min: 0, max: 1 }),
  brightness: command(C.LIGHT, T.LIGHT.BRIGHTNESS, { min: 0, max: 100 }),
  switch: command(C.SWITCH, T.SWITCH.BINARY, { min: 0, max: 1 }),
  binary: reading(C.UNKNOWN, T.SENSOR.BINARY, { min: 0, max: 1 }),
  motion: reading(C.MOTION_SENSOR, T.SENSOR.BINARY, { min: 0, max: 1 }),
  temperature: reading(C.TEMPERATURE_SENSOR, T.SENSOR.DECIMAL, {
    unit: U.CELSIUS,
    min: -50,
    max: 150,
  }),
  humidity: reading(C.HUMIDITY_SENSOR, T.SENSOR.DECIMAL, { unit: U.PERCENT, min: 0, max: 100 }),
  lux: reading(C.LIGHT_SENSOR, T.SENSOR.DECIMAL, { unit: U.LUX, min: 0, max: 100_000 }),
  co2: reading(C.CO2_SENSOR, T.SENSOR.INTEGER, { unit: U.PPM, min: 0, max: 10_000 }),
  value: reading(C.UNKNOWN, T.UNKNOWN.UNKNOWN, { min: 0, max: 65_535 }),
  // Read only: a temperature sensor, never a thermostat a voice assistant could offer to set.
  setpoint: reading(C.TEMPERATURE_SENSOR, T.SENSOR.DECIMAL, {
    unit: U.CELSIUS,
    min: -50,
    max: 150,
  }),
};

/** The roles of a port by its family and kind. */
export const KIND_ROLES = {
  output: {
    readonly: ['state', 'level', 'on', 'off'],
    light: ['light', 'brightness'],
    switch: ['switch'],
  },
  relay: { readonly: ['state', 'on', 'off'], switch: ['switch'], light: ['light'] },
  binary: { binary: ['binary'], motion: ['motion'] },
  variable: {
    temperature: ['temperature'],
    humidity: ['humidity'],
    lux: ['lux'],
    co2: ['co2'],
    value: ['value'],
  },
  setpoint: { setpoint: ['setpoint'] },
};

/** Every role a port of a family may have (current or kept). */
export const familyRoles = (family) => new Set(Object.values(KIND_ROLES[family] ?? {}).flat());

export const ids = (gladys, seg, module) => gladys.externalIds('module', moduleKey(seg, module));

/** `ext:sel:module:0-5:a1_light` -> { seg, module, port, role, family, number }. */
export function parseFeatureId(externalId, gladys) {
  const text = String(externalId ?? '');
  const match = /:module:(\d{1,3})-(\d{1,3}):([a-z]{1,3}\d{1,2})_([a-z0-9]{1,12})$/.exec(text);
  if (!match) return undefined;
  const seg = Number(match[1]);
  const module = Number(match[2]);
  const info = portInfo(match[3]);
  if (!info || !familyRoles(info.family).has(match[4]) || !validAddress(seg, module)) {
    return undefined;
  }
  // Only a feature of this integration: the exact id it would build.
  if (gladys && ids(gladys, seg, module).feature(`${match[3]}_${match[4]}`) !== text) {
    return undefined;
  }
  return { seg, module, port: match[3], role: match[4], ...info };
}

/** `ext:sel:module:0-5` (a device of this integration, a valid address) -> { seg, module }. */
export function parseDeviceId(externalId, gladys) {
  const text = String(externalId ?? '');
  const match = /:module:(\d{1,3})-(\d{1,3})$/.exec(text);
  if (!match) return undefined;
  const seg = Number(match[1]);
  const module = Number(match[2]);
  if (!validAddress(seg, module)) return undefined;
  if (gladys && ids(gladys, seg, module).device !== text) return undefined;
  return { seg, module };
}

/** What a discovered feature declares (a created one also has ids, values, dates). */
const FEATURE_FIELDS = [
  'name',
  'external_id',
  'category',
  'type',
  'min',
  'max',
  'read_only',
  'has_feedback',
  'keep_history',
  'unit',
];

/** Adds to each device the features of its created twin it no longer has. */
export function keepCreatedFeatures(devices, created = []) {
  const byId = new Map((created ?? []).map((device) => [device.external_id, device]));
  return devices.map((device) => {
    const twin = byId.get(device.external_id);
    if (!twin?.features?.length) return device;
    const have = new Set(device.features.map((f) => f.external_id));
    const kept = twin.features
      .filter((f) => f?.external_id && !have.has(f.external_id))
      .map((f) =>
        Object.fromEntries(
          FEATURE_FIELDS.filter((key) => f[key] !== undefined && f[key] !== null).map((key) => [
            key,
            f[key],
          ]),
        ),
      );
    return kept.length === 0 ? device : { ...device, features: [...device.features, ...kept] };
  });
}

/** Every module to show: the ones the scan found and the ones "Ports" names, in order. */
export function shownModules(config, model) {
  const keys = new Set([...model.modules.keys(), ...config.ports.keys()]);
  return [...keys]
    .map((key) => {
      const [seg, module] = key.split('-').map(Number);
      return { key, seg, module, info: model.modules.get(key) };
    })
    .sort((a, b) => a.seg - b.seg || a.module - b.module);
}

export function buildDevices(gladys, config, model, created = gladys.devices) {
  const { language } = config;
  const devices = [];
  for (const { key, seg, module, info } of shownModules(config, model)) {
    const deviceIds = ids(gladys, seg, module);
    const label = moduleLabel(seg, module);
    const hardware = info?.hardware !== undefined ? hardwareName(info.hardware) : 'LCN';
    const features = [];
    for (const [port, kind] of portsOf(config, key)) {
      const family = portInfo(port)?.family;
      for (const role of KIND_ROLES[family]?.[kind] ?? []) {
        features.push({
          name: featureName(port, role, language),
          external_id: deviceIds.feature(`${port}_${role}`),
          ...ROLE_FEATURES[role],
        });
      }
    }
    devices.push({
      name: info?.name || word(DEVICE_NAME, language)(hardware, label),
      external_id: deviceIds.device,
      model: hardware,
      should_poll: false,
      params: [
        { name: 'address', value: label },
        ...(info?.serial ? [{ name: 'serial', value: info.serial }] : []),
        ...(info?.firmwareText ? [{ name: 'firmware', value: info.firmwareText }] : []),
      ],
      features,
    });
  }
  return keepCreatedFeatures(devices, created);
}

const flag = (value) => (value ? 1 : 0);

/** The value of a role of a port from what the module said, undefined if unknown. */
export function roleValue(info, port, role) {
  const { family, number } = portInfo(port) ?? {};
  if (family === 'output') {
    const percent = info.outputs.get(number);
    if (percent === undefined) return undefined;
    if (role === 'level' || role === 'brightness') return Math.round(percent);
    if (role === 'state' || role === 'light' || role === 'switch') return flag(percent > 0);
    return undefined;
  }
  if (family === 'relay') {
    if (!info.relays || !['state', 'light', 'switch'].includes(role)) return undefined;
    return flag(info.relays[number - 1]);
  }
  if (family === 'binary') {
    if (!info.binaries) return undefined;
    return flag(info.binaries[number - 1]);
  }
  if (family === 'variable' || family === 'setpoint') {
    const native = info.variables.get(port);
    return native === undefined ? undefined : convertVariable(native, role);
  }
  return undefined;
}

/** Every known state: the roles shown, and the ones of the created device (kept). */
export function buildStates(gladys, config, model, created = gladys.devices) {
  const states = [];
  const createdKeys = new Map(
    (created ?? []).map((device) => [
      device.external_id,
      (device.features ?? []).map((f) =>
        String(f?.external_id ?? '')
          .split(':')
          .at(-1),
      ),
    ]),
  );
  for (const { key, seg, module, info } of shownModules(config, model)) {
    if (!info) continue;
    const deviceIds = ids(gladys, seg, module);
    const keys = new Set();
    for (const [port, kind] of portsOf(config, key)) {
      const family = portInfo(port)?.family;
      for (const role of KIND_ROLES[family]?.[kind] ?? []) keys.add(`${port}_${role}`);
    }
    for (const featureKey of createdKeys.get(deviceIds.device) ?? []) keys.add(featureKey);
    for (const featureKey of keys) {
      const match = /^([a-z]{1,3}\d{1,2})_([a-z0-9]{1,12})$/.exec(featureKey);
      if (!match) continue;
      const info2 = portInfo(match[1]);
      if (!info2 || !familyRoles(info2.family).has(match[2])) continue;
      const value = roleValue(info, match[1], match[2]);
      if (value === undefined || value === null || !Number.isFinite(value)) continue;
      states.push({ device_feature_external_id: deviceIds.feature(featureKey), state: value });
    }
  }
  return states;
}
