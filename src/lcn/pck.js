// -----------------------------------------------------------------------------
// LCN-PCK, the text protocol of LCN-PCHK: what a line received means, and the
// lines this integration writes. Ported from pypck (pck_commands.py,
// inputs.py, lcn_defs.py; MIT, see THIRD_PARTY_NOTICES.md).
//
// Changed from pypck:
// - every pattern is anchored at both ends and bounded (a number has a few
//   digits at most): one linear pass per line, nothing from the line becomes
//   an object key;
// - only what this integration uses is ported: outputs, relays, binary
//   sensors, variables, set points, serial numbers, names, keys sent to the
//   host, acknowledgements, segment couplers, the login of PCHK.
// -----------------------------------------------------------------------------

const pad3 = (n) => String(n).padStart(3, '0');

/** One received line -> { kind, ... } (`seg`: the physical segment it came from), or undefined. */
export function parseLine(line) {
  switch (line) {
    case 'Username:':
      return { kind: 'username' };
    case 'Password:':
      return { kind: 'password' };
    case 'OK':
      return { kind: 'auth_ok' };
    case '$io:#LCN:connected':
      return { kind: 'bus', connected: true };
    case '$io:#LCN:disconnected':
      return { kind: 'bus', connected: false };
    case '(dec-mode)':
      return { kind: 'dec_mode' };
    case '$err:(license?)':
      return { kind: 'licence' };
    default:
      break;
  }
  // PCHK writes "Authentification failed." (sic); the usual spelling is taken too.
  if (/^Authenti(?:fi)?cation failed\.?$/i.test(line)) return { kind: 'auth_failed' };
  let m = /^\^ping(\d{0,9})-$/.exec(line);
  if (m) return { kind: 'ping', count: m[1] === '' ? null : Number(m[1]) };
  const first = line[0];
  if (first === '-') {
    m = /^-M(\d{3})(\d{3})(?:(!)|(\d{1,3}))$/.exec(line);
    if (m) return { kind: 'ack', ...addr(m), code: m[3] ? 0 : Number(m[4]) };
    return undefined;
  }
  if (first === ':') {
    m = /^:M(\d{3})(\d{3})([AO])([1-4])(\d{1,3})$/.exec(line);
    if (m) {
      const value = Number(m[5]);
      // A: percent; O: native, 0 to 200 (half percents).
      const percent = m[3] === 'A' ? value : value / 2;
      if (percent > 100) return undefined;
      return { kind: 'output', ...addr(m), output: Number(m[4]), percent };
    }
    m = /^:M(\d{3})(\d{3})(Rx|Bx)(\d{1,3})$/.exec(line);
    if (m) {
      const byte = Number(m[4]);
      if (byte > 255) return undefined;
      return { kind: m[3] === 'Rx' ? 'relays' : 'binaries', ...addr(m), bits: bitsOf(byte) };
    }
    return undefined;
  }
  if (first === '%') {
    m = /^%M(\d{3})(\d{3})\.A(\d{3})(\d{1,5})$/.exec(line);
    if (m) {
      const id = Number(m[3]);
      if (id < 1 || id > 12) return undefined;
      return variable(m, `var${id}`, m[4]);
    }
    m = /^%M(\d{3})(\d{3})\.S([12])(\d{1,5})$/.exec(line);
    if (m) return variable(m, `sp${m[3]}`, m[4]);
    m = /^%M(\d{3})(\d{3})\.(\d{1,5})$/.exec(line);
    // Old modules (before 170206): the answer does not say which variable.
    if (m) return variable(m, null, m[3]);
    return undefined;
  }
  if (first === '=') {
    m = /^=M(\d{3})(\d{3})\.SK(\d{1,3})$/.exec(line);
    if (m) return { kind: 'segment', ...addr(m), id: Number(m[3]) };
    m = /^=M(\d{3})(\d{3})\.SN([0-9A-F]{10})(.{2})FW([0-9A-F]{6})HW(\d{1,3})$/.exec(line);
    if (m) {
      return {
        kind: 'serial',
        ...addr(m),
        serial: m[3],
        firmware: Number.parseInt(m[5], 16),
        firmwareText: m[5],
        hardware: Number(m[6]),
      };
    }
    m = /^=M(\d{3})(\d{3})\.N([12])(.{0,12})$/.exec(line);
    if (m) return { kind: 'name', ...addr(m), block: Number(m[3]), text: m[4] };
    return undefined;
  }
  if (first === '$' || first === '+') {
    m = /^(?:\$M|\+M004)(\d{3})(\d{3})\.STH(\d{3})(\d{3})$/.exec(line);
    if (m) {
      const actions = Number(m[3]);
      const keys = Number(m[4]);
      if (actions > 255 || keys > 255) return undefined;
      return { kind: 'keys', ...addr(m), actions, keys };
    }
  }
  return undefined;
}

function addr(m) {
  return { seg: Number(m[1]), module: Number(m[2]) };
}

function variable(m, port, raw) {
  const value = Number(raw);
  if (value > 0xffff) return undefined;
  return { kind: 'variable', ...addr(m), port, value };
}

/** A byte -> 8 booleans, bit 0 first (pypck get_boolean_value). */
export const bitsOf = (byte) => Array.from({ length: 8 }, (_, i) => (byte & (1 << i)) !== 0);

/** Keys sent to the host -> [{ table: 'A', key: 1, action: 'hit' }] (pypck ModSendKeysHost). */
export function keyEvents({ actions, keys }) {
  const names = [null, 'hit', 'make', 'break'];
  const events = [];
  for (let table = 0; table < 3; table += 1) {
    const action = names[(actions >> (2 * table)) & 0x03];
    if (!action) continue;
    for (let bit = 0; bit < 8; bit += 1) {
      if ((keys >> bit) & 1) events.push({ table: 'ABC'[table], key: bit + 1, action });
    }
  }
  return events;
}

// --- Values of the variables (pypck VarValue) --------------------------------

/** 0xFFFF: no value yet; 0x81xx: undefined; 0x7Fxx: sensor defective. */
export function isSpecialValue(native) {
  return native === 0xffff || (native & 0xff00) === 0x8100 || (native & 0xff00) === 0x7f00;
}

/** A native value -> the value in the unit of `kind`, or undefined when not usable. */
export function convertVariable(native, kind) {
  if (!Number.isInteger(native) || native < 0 || native > 0xffff || isSpecialValue(native)) {
    return undefined;
  }
  const within = (value, min, max) => (value >= min && value <= max ? value : undefined);
  switch (kind) {
    case 'temperature':
      return within((native - 1000) / 10, -50, 150);
    case 'setpoint':
      // A regulator set point: bit 15 tells it is locked.
      return within(((native & 0x7fff) - 1000) / 10, -50, 150);
    case 'humidity':
      return within(native, 0, 100);
    case 'co2':
      return within(native, 0, 10_000);
    case 'lux':
      // I-port light sensor; over 1152 the hardware gives nothing (pypck).
      return native > 1152 ? undefined : Math.round(Math.exp(native / 100));
    case 'value':
      return native;
    default:
      return undefined;
  }
}

// --- Lines written ------------------------------------------------------------

export const LOGIN = {
  decMode: '!CHD',
  /** 200 dimming steps (modules since 170206) or 50; statuses in percent. */
  operationMode: (dim200) => `!OM${dim200 ? '1' : '0'}P`,
  ping: (count) => `^ping${count}`,
};

/** The address header (`>M000005.`): physical segment, module or group, acknowledgement asked. */
export function header(seg, id, { group = false, ack = false } = {}) {
  return `>${group ? 'G' : 'M'}${pad3(seg)}${pad3(id)}${ack ? '!' : '.'}`;
}

export const PCK = {
  segmentScan: () => `${header(3, 3, { group: true })}SK`,
  /** Every module of a segment answers an empty command with an acknowledgement. */
  moduleScan: (seg) => `${header(seg, 3, { group: true, ack: true })}LEER`,
  serial: () => 'SN',
  name: (block) => `NMN${block}`,
  outputStatus: (output) => `SMA${output}`,
  relayStatus: () => 'SMR',
  binaryStatus: () => 'SMB',
  /** An output to a percentage, at once (ramp 0). */
  dim: (output, percent) => `A${output}DI${pad3(percent)}000`,
  /** One relay on or off, the 7 others unchanged. */
  relay: (relay, on) => {
    const states = Array(8).fill('-');
    states[relay - 1] = on ? '1' : '0';
    return `R8${states.join('')}`;
  },
  /** The variable of a port (`var1`..`var12`, `sp1`, `sp2`) for a module firmware. */
  variable: (port, firmware, typed) => variableRequest(port, firmware, typed),
  sceneRegister: (register) => `SZW${pad3(register)}`,
  sceneOutputs: (scene) => `SZA7${pad3(scene)}`,
  sceneRelays: (scene) => `SZA0${pad3(scene)}11111111`,
};

function variableRequest(port, firmware, typed) {
  const sp = /^sp([12])$/.exec(port);
  const v = /^var(\d{1,2})$/.exec(port);
  if (firmware >= typed) {
    if (sp) return `MWS${sp[1]}`;
    if (v) return `MWT${v[1]}`;
    return undefined;
  }
  // Old modules: three variables and the two set points only.
  if (sp) return sp[1] === '1' ? 'MWSA' : 'MWSB';
  if (v) return { 1: 'MWV', 2: 'MWTA', 3: 'MWTB' }[v[1]];
  return undefined;
}

/** pypck HARDWARE_DESCRIPTIONS (10 is an LCN-UP2 too). */
const HARDWARE = new Map([
  [1, 'LCN-SW1.0'],
  [2, 'LCN-SW1.1'],
  [3, 'LCN-UP1.0'],
  [4, 'LCN-UP2'],
  [5, 'LCN-SW2'],
  [6, 'LCN-UP-Profi1-Plus'],
  [7, 'LCN-DI12'],
  [8, 'LCN-HU'],
  [9, 'LCN-SH'],
  [10, 'LCN-UP2'],
  [11, 'LCN-UPP'],
  [12, 'LCN-SK'],
  [14, 'LCN-LD'],
  [15, 'LCN-SH-Plus'],
  [17, 'LCN-UPS'],
  [18, 'LCN-UPS24V'],
  [19, 'LCN-GTM'],
  [20, 'LCN-SHS'],
  [21, 'LCN-ESD'],
  [22, 'LCN-EB2'],
  [23, 'LCN-MRS'],
  [24, 'LCN-EB11'],
  [25, 'LCN-UMR'],
  [26, 'LCN-UPU'],
  [27, 'LCN-UMR24V'],
  [28, 'LCN-SHD'],
  [29, 'LCN-SHU'],
  [30, 'LCN-SR6'],
  [31, 'LCN-UMF'],
  [32, 'LCN-WBH'],
]);

export const hardwareName = (type) => HARDWARE.get(type) ?? 'LCN';
