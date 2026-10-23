// -----------------------------------------------------------------------------
// An in-memory LCN-PCHK and LCN bus: no socket, no network. `connect` is given
// to the client in place of net; each call opens a session where PCHK asks
// for the user name and the password, answers the decimal mode, the pings
// and the scans, and simulated modules answer the status requests and the
// commands the way pypck expects them (lines written here by hand, not with
// the code under test). Every line the client wrote is recorded.
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';

/** Lets every queued delivery and the promise chains behind it run. */
export async function settle(rounds = 20) {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Settles until `check()` is true (at most `rounds` x 5 turns). */
export async function until(check, rounds = 400) {
  for (let i = 0; i < rounds; i += 1) {
    if (check()) return;
    await settle(5);
  }
  throw new Error('condition never met');
}

const pad3 = (n) => String(n).padStart(3, '0');
const pad5 = (n) => String(n).padStart(5, '0');

class FakeSocket extends EventEmitter {
  constructor(pchk) {
    super();
    this.pchk = pchk;
    this.destroyed = false;
    this.writableLength = 0;
    this.lines = [];
    this.partial = '';
    this.state = 'user';
  }

  setNoDelay() {}

  setKeepAlive() {}

  write(text) {
    if (this.destroyed) throw new Error('write after destroy');
    this.partial += String(text);
    let index = this.partial.indexOf('\n');
    while (index !== -1) {
      const line = this.partial.slice(0, index);
      this.partial = this.partial.slice(index + 1);
      this.lines.push(line);
      queueMicrotask(() => {
        if (!this.destroyed) this.pchk.receive(this, line);
      });
      index = this.partial.indexOf('\n');
    }
    return true;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    queueMicrotask(() => this.emit('close'));
  }

  /** PCHK side: a line to the client. */
  send(line) {
    if (this.destroyed) return;
    queueMicrotask(() => {
      if (!this.destroyed) this.emit('data', Buffer.from(`${line}\r\n`, 'latin1'));
    });
  }

  raw(bytes) {
    queueMicrotask(() => {
      if (!this.destroyed) this.emit('data', Buffer.from(bytes));
    });
  }
}

/**
 * Modules by `seg-module`: { serial, firmware (hex text), hardware, name: [block1,
 * block2], outputs: { n: percent }, relays: byte, binaries: byte, variables:
 * { var1: native, sp1: native } }. A firmware before 170206 answers the
 * variables without saying which.
 */
export const defaultModules = () => ({
  '0-5': {
    serial: '1A2B3C4D5E',
    firmware: '190B11',
    hardware: 17,
    name: ['Kitchen', 'Left'],
    outputs: { 1: 50, 2: 0, 3: 0, 4: 0 },
    relays: 0b00000101,
    binaries: 0b00000001,
    variables: { var1: 1215, var2: 1300, var4: 45, sp1: 1210 },
  },
  '0-7': {
    serial: '0011223344',
    firmware: '150101',
    hardware: 11,
    name: ['Hall', ''],
    outputs: { 1: 0, 2: 100 },
    relays: 0,
    binaries: 0,
    variables: { var1: 1200, var2: 0xffff },
  },
});

export class FakePchk {
  constructor({
    modules = defaultModules(),
    username = 'lcn',
    password = 'secret',
    licence = false,
  } = {}) {
    this.modules = modules;
    this.username = username;
    this.password = password;
    this.licence = licence;
    this.sockets = [];
    /** Every line the client wrote: { session, line }. */
    this.log = [];
    /** (line) -> true: that line gets no answer. */
    this.hold = () => false;
    this.refuseConnections = 0;
    this.silent = false;
    this.connect = this.connect.bind(this);
  }

  connect(options) {
    this.options = options;
    const socket = new FakeSocket(this);
    socket.session = this.sockets.length + 1;
    this.sockets.push(socket);
    if (this.refuseConnections > 0) {
      this.refuseConnections -= 1;
      queueMicrotask(() => {
        const err = new Error('connect ECONNREFUSED');
        err.code = 'ECONNREFUSED';
        socket.emit('error', err);
      });
      return socket;
    }
    queueMicrotask(() => {
      socket.emit('connect');
      if (this.silent) return;
      socket.send('LCN-PCK/IP 1.0');
      socket.send('Username:');
    });
    return socket;
  }

  get current() {
    return this.sockets.at(-1);
  }

  /** The bus lines the client wrote (login lines left out). */
  get lines() {
    return this.log.map((entry) => entry.line).filter((line) => line.startsWith('>'));
  }

  receive(socket, line) {
    this.log.push({ session: socket.session, line });
    if (this.hold(line)) return;
    if (socket.state === 'user') {
      socket.user = line;
      socket.state = 'password';
      socket.send('Password:');
      return;
    }
    if (socket.state === 'password') {
      if (socket.user === this.username && line === this.password) {
        socket.state = 'logged';
        socket.send('OK');
      } else {
        socket.state = 'refused';
        socket.send('Authentification failed.');
        socket.send('Username:');
      }
      return;
    }
    if (socket.state !== 'logged') return;
    if (line === '!CHD') {
      if (this.licence) {
        socket.send('$err:(license?)');
        return;
      }
      socket.send('(dec-mode)');
      socket.send('$io:#LCN:connected');
      return;
    }
    let m = /^\^ping(\d*)$/.exec(line);
    if (m) {
      socket.send(`^ping${m[1]}-`);
      return;
    }
    m = /^>G(\d{3})003!LEER$/.exec(line);
    if (m) {
      for (const key of Object.keys(this.modules)) {
        const [seg, module] = key.split('-').map(Number);
        if (seg === Number(m[1])) socket.send(`-M${pad3(seg)}${pad3(module)}!`);
      }
      return;
    }
    m = /^>M(\d{3})(\d{3})[.!](.+)$/.exec(line);
    if (!m) return;
    const seg = Number(m[1]);
    const id = Number(m[2]);
    const module = this.modules[`${seg}-${id}`];
    if (!module) return;
    this.command(socket, seg, id, module, m[3]);
  }

  command(socket, seg, id, module, body) {
    const head = `M${pad3(seg)}${pad3(id)}`;
    const typed = Number.parseInt(module.firmware, 16) >= 0x170206;
    let m;
    if (body === 'SN') {
      socket.send(`=${head}.SN${module.serial}06FW${module.firmware}HW${module.hardware}`);
      return;
    }
    m = /^NMN([12])$/.exec(body);
    if (m) {
      socket.send(`=${head}.N${m[1]}${module.name[Number(m[1]) - 1] ?? ''}`);
      return;
    }
    m = /^SMA([1-4])$/.exec(body);
    if (m) {
      socket.send(`:${head}A${m[1]}${pad3(module.outputs[m[1]] ?? 0)}`);
      return;
    }
    if (body === 'SMR') {
      socket.send(`:${head}Rx${pad3(module.relays ?? 0)}`);
      return;
    }
    if (body === 'SMB') {
      socket.send(`:${head}Bx${pad3(module.binaries ?? 0)}`);
      return;
    }
    m = /^MWT(\d{1,2})$/.exec(body);
    if (m && typed) {
      const value = module.variables[`var${m[1]}`];
      if (value !== undefined) socket.send(`%${head}.A${pad3(m[1])}${pad5(value)}`);
      return;
    }
    m = /^MWS([12])$/.exec(body);
    if (m && typed) {
      const value = module.variables[`sp${m[1]}`];
      if (value !== undefined) socket.send(`%${head}.S${m[1]}${pad5(value)}`);
      return;
    }
    const old = { MWV: 'var1', MWTA: 'var2', MWTB: 'var3', MWSA: 'sp1', MWSB: 'sp2' }[body];
    if (old && !typed) {
      const value = module.variables[old];
      if (value !== undefined) socket.send(`%${head}.${pad5(value)}`);
      return;
    }
    m = /^A([1-4])DI(\d{3})(\d{3})$/.exec(body);
    if (m) {
      module.outputs[m[1]] = Number(m[2]);
      socket.send(`:${head}A${m[1]}${m[2]}`);
      return;
    }
    m = /^R8([01U-]{8})$/.exec(body);
    if (m) {
      let byte = module.relays ?? 0;
      [...m[1]].forEach((c, i) => {
        if (c === '1') byte |= 1 << i;
        if (c === '0') byte &= ~(1 << i);
      });
      module.relays = byte;
      socket.send(`:${head}Rx${pad3(byte)}`);
    }
  }

  /** A module sends keys to the host. */
  keys(seg, id, actions, keys) {
    this.current.send(`$M${pad3(seg)}${pad3(id)}.STH${pad3(actions)}${pad3(keys)}`);
  }

  /** Any line from PCHK. */
  line(text) {
    this.current.send(text);
  }

  drop() {
    this.current.destroy();
  }
}

/**
 * A virtual clock for the client and the app (`timers` and `now`): nothing
 * waits for real; advance() runs the timers due, in order, letting the
 * promises settle between them.
 */
export class FakeClock {
  constructor(start = 1_000_000_000) {
    this.time = start;
    this.entries = new Map();
    this.ids = 0;
    this.now = () => this.time;
    this.setTimeout = (fn, ms) => this.add(fn, ms, undefined);
    this.setInterval = (fn, ms) => this.add(fn, ms, ms);
    this.clearTimeout = (id) => this.entries.delete(id);
    this.clearInterval = (id) => this.entries.delete(id);
  }

  add(fn, ms, every) {
    this.ids += 1;
    this.entries.set(this.ids, { at: this.time + Math.max(0, ms || 0), fn, every });
    return this.ids;
  }

  async advance(ms) {
    const end = this.time + ms;
    for (;;) {
      await settle(3);
      let next;
      for (const [id, entry] of this.entries) {
        if (entry.at <= end && (!next || entry.at < next[1].at)) next = [id, entry];
      }
      if (!next) break;
      const [id, entry] = next;
      this.time = Math.max(this.time, entry.at);
      if (entry.every) entry.at = this.time + entry.every;
      else this.entries.delete(id);
      entry.fn();
    }
    this.time = end;
    await settle();
  }
}

export const quietLogger = () => {
  const lines = [];
  const log = (level) => (message) => lines.push(`${level} ${message}`);
  return {
    lines,
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
  };
};
