// -----------------------------------------------------------------------------
// One connection to LCN-PCHK (the coupler software of LCN, TCP 4114 by
// default). Ported from pypck (connection.py; MIT, see THIRD_PARTY_NOTICES.md):
// the login (user name and password asked by PCHK, then the decimal mode and
// the operation mode), the keep-alive ping, the scan of the segment couplers
// and of the modules (an empty command with an acknowledgement asked, sent to
// every module of a segment), the lines paced while the bus is busy.
//
// Changed from pypck:
// - one connection, reconnections spaced 10 s, 30 s, 1 min, 2 min, then 5 min;
//   a licence error of PCHK (all its connections taken) waits 5 min to 1 h;
// - a refused login stops the connection for good (no new try by itself, the
//   app persists it): a refused password is never sent again in a loop;
// - two queues: commands go before the background reads, are never written
//   after their deadline, and their option is checked right before the write
//   (`check`); both queues are bounded;
// - an answer is awaited only from a line received after the request was
//   written, never taken from memory;
// - the local segment keeps the logical id 0, with or without a segment
//   coupler: the ids of the devices never move when a coupler is added.
//
// Events, in the order of the lines: 'attempt', 'up', 'input' (a parsed line
// of a module, `seg` logical), 'bus' { connected }, 'down' { reason, retryIn,
// refused, licence, wasUp }. The user name and the password are never logged.
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';
import { createConnection } from 'node:net';
import { LIMITS, TIMINGS } from '../constants.js';
import { LineReader } from './lines.js';
import { LOGIN, PCK, header, parseLine } from './pck.js';

const silent = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * kind: `offline` (nothing sent), `late` (too late, nothing sent),
 * `withdrawn` (its option was switched off before the write, nothing sent),
 * `cancelled` (an off asked meanwhile, nothing sent), `full` (the queue is
 * full, nothing sent), `timeout` (written, no answer in time), `lost` (the
 * connection ended: `sent` tells whether it was written).
 */
export class LcnError extends Error {
  constructor(message, kind, { sent = false } = {}) {
    super(message);
    this.kind = kind;
    this.sent = sent;
  }
}

function defaultConnect({ host, port }) {
  return createConnection({ host, port });
}

const MODULE_KINDS = new Set([
  'ack',
  'output',
  'relays',
  'binaries',
  'variable',
  'serial',
  'name',
  'keys',
]);

export class LcnClient extends EventEmitter {
  constructor({
    connect = defaultConnect,
    timers = globalThis,
    now = Date.now,
    logger = silent,
  } = {}) {
    super();
    this.connectFn = connect;
    this.timers = timers;
    this.now = now;
    this.logger = logger;
    this.options = { host: '', port: 4114, username: '', password: '', dim200: true };
    this.socket = undefined;
    this.generation = 0;
    this.running = false;
    this.ready = false;
    this.failures = 0;
    this.licenceFailures = 0;
    /** Sessions ended after the password, before PCHK said OK, in a row. */
    this.authDrops = 0;
    /** Turn off, 0 %: before everything else. */
    this.protective = [];
    this.urgent = [];
    this.background = [];
    this.waiters = new Set();
    this.collectors = new Set();
    this.lastWriteAt = -Infinity;
    this.lastReadAt = -Infinity;
    this.localSegment = 0;
    this.couplers = [];
    this.busConnected = undefined;
    this.pingCount = 0;
    this.dropped = 0;
  }

  configure({ host, port, username, password, dim200 }) {
    this.options = {
      host,
      port,
      username: username ?? '',
      password: password ?? '',
      dim200: dim200 !== false,
    };
  }

  get connected() {
    return this.ready;
  }

  /** A socket is open (connecting, logging in or up). */
  get busy() {
    return Boolean(this.socket);
  }

  /** Starts; `delay` (ms) before the first attempt (a restart keeps the spacing). */
  start({ delay = 0 } = {}) {
    this.stop();
    this.running = true;
    this.failures = 0;
    this.licenceFailures = 0;
    this.authDrops = 0;
    if (delay > 0) {
      this.reconnectTimer = this.timers.setTimeout(() => {
        this.reconnectTimer = undefined;
        if (this.running) this.open();
      }, delay);
      return;
    }
    this.open();
  }

  stop() {
    this.running = false;
    this.generation += 1;
    if (this.reconnectTimer) {
      this.timers.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.close();
  }

  clearTimers() {
    for (const name of ['connectTimer', 'loginTimer', 'pumpTimer', 'pingTimer', 'segmentTimer']) {
      if (this[name]) {
        this.timers.clearTimeout(this[name]);
        this[name] = undefined;
      }
    }
    if (this.pinger) {
      this.timers.clearInterval(this.pinger);
      this.pinger = undefined;
    }
  }

  /** Ends the socket; every waiting request fails (written or not, as it was). */
  close() {
    this.clearTimers();
    const socket = this.socket;
    this.socket = undefined;
    this.ready = false;
    this.phase = undefined;
    this.busConnected = undefined;
    for (const waiter of [...this.waiters]) {
      waiter.fail(new LcnError('The connection to PCHK ended', 'lost', { sent: true }));
    }
    for (const entry of [
      ...this.protective.splice(0),
      ...this.urgent.splice(0),
      ...this.background.splice(0),
    ]) {
      entry.reject(new LcnError('Not connected to PCHK', 'offline'));
    }
    for (const collect of this.collectors) collect.end?.();
    if (!socket) return;
    socket.removeAllListeners();
    socket.on('error', () => undefined);
    socket.destroy();
  }

  // --- Connection -------------------------------------------------------------

  open() {
    const generation = this.generation;
    const { host, port } = this.options;
    this.reader = new LineReader({
      onLine: (line) => {
        if (generation === this.generation) this.line(generation, line);
      },
      onDrop: (why) => this.noteDrop(why),
    });
    this.phase = 'login';
    this.sentUser = false;
    this.sentPassword = false;
    this.localSegment = 0;
    this.couplers = [];
    this.emit('attempt');
    this.logger.debug(`Connecting to LCN-PCHK at ${host}:${port}`);
    let socket;
    try {
      socket = this.connectFn({ host, port });
    } catch (err) {
      this.lost(generation, `connection failed: ${err.message}`);
      return;
    }
    this.socket = socket;
    socket.setNoDelay?.(true);
    socket.setKeepAlive?.(true, 30_000);
    this.connectTimer = this.timers.setTimeout(
      () => this.lost(generation, 'connection timed out'),
      TIMINGS.connectTimeout,
    );
    socket.on('connect', () => {
      if (generation !== this.generation) return;
      this.timers.clearTimeout(this.connectTimer);
      this.connectTimer = undefined;
      // The whole login (prompts, OK, decimal mode) must end in time.
      this.loginTimer = this.timers.setTimeout(
        () => this.lost(generation, 'no login answer from PCHK'),
        TIMINGS.loginTimeout,
      );
    });
    socket.on('data', (chunk) => {
      if (generation !== this.generation) return;
      this.lastReadAt = this.now();
      this.reader.push(chunk);
    });
    socket.on('error', (err) => this.lost(generation, err.code ?? err.message));
    socket.on('close', () => this.lost(generation, 'connection closed by PCHK'));
  }

  noteDrop(why) {
    this.dropped += 1;
    if (this.dropLoggedAt === undefined || this.now() - this.dropLoggedAt >= TIMINGS.dropLog) {
      this.dropLoggedAt = this.now();
      this.logger.warn(`LCN: lines dropped (${why}; ${this.dropped} since the start)`);
    }
  }

  /** A line during the login or the setup; written at once, never queued. */
  writeRaw(generation, text, { secret = false } = {}) {
    if (generation !== this.generation || !this.socket) return false;
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(text)) {
      // A line break would make two PCK lines: never written.
      this.lost(generation, 'a control character in a line to write', { refused: secret });
      return false;
    }
    try {
      this.socket.write(`${text}\n`);
    } catch (err) {
      this.lost(generation, err.message);
      return false;
    }
    this.lastWriteAt = this.now();
    if (!secret) this.logger.debug(`LCN <- ${text}`);
    return true;
  }

  line(generation, text) {
    const input = parseLine(text);
    if (!input) return;
    switch (input.kind) {
      case 'username':
        // A second prompt means the first login was refused: never a loop.
        if (this.sentUser) {
          this.lost(generation, 'PCHK asked for the user name again', { refused: true });
          return;
        }
        this.sentUser = true;
        this.writeRaw(generation, this.options.username, { secret: true });
        this.logger.debug('LCN <- user name (hidden)');
        return;
      case 'password':
        if (!this.sentUser || this.sentPassword) {
          this.lost(generation, 'unexpected password prompt', { refused: true });
          return;
        }
        this.sentPassword = true;
        this.writeRaw(generation, this.options.password, { secret: true });
        this.logger.debug('LCN <- password (hidden)');
        return;
      case 'auth_failed':
        this.lost(generation, 'login refused by PCHK', { refused: true });
        return;
      case 'auth_ok':
        if (this.phase !== 'login') return;
        this.phase = 'dec';
        this.authDrops = 0;
        this.writeRaw(generation, LOGIN.decMode);
        return;
      case 'licence':
        this.lost(generation, 'licence error of PCHK (no connection left)', { licence: true });
        return;
      case 'dec_mode':
        if (this.phase !== 'dec') return;
        this.phase = 'segments';
        this.writeRaw(generation, LOGIN.operationMode(this.options.dim200));
        this.startPing(generation);
        this.scanSegments(generation);
        return;
      case 'ping':
        if (this.pingTimer) {
          this.timers.clearTimeout(this.pingTimer);
          this.pingTimer = undefined;
        }
        return;
      case 'bus':
        this.busConnected = input.connected;
        this.emit('bus', { connected: input.connected });
        return;
      case 'segment':
        if (this.phase === 'segments') this.segmentAnswer(input);
        return;
      default:
        break;
    }
    if (!this.ready || !MODULE_KINDS.has(input.kind)) return;
    input.seg = this.toLogical(input.seg);
    for (const collect of this.collectors) collect(input);
    this.emit('input', input);
    for (const waiter of [...this.waiters]) {
      let value;
      try {
        value = waiter.match(input);
      } catch {
        value = undefined;
      }
      if (value !== undefined && value !== false) waiter.done(value);
    }
  }

  /** A physical segment (0 = local, 4 = status messages) -> logical (0 = local). */
  toLogical(seg) {
    if (seg === 0 || seg === 4 || (this.localSegment !== 0 && seg === this.localSegment)) return 0;
    return seg;
  }

  /** The address header of a module, by its logical segment. */
  header(seg, module) {
    const physical = seg === 0 || seg === this.localSegment ? 0 : seg;
    return header(physical, module);
  }

  startPing(generation) {
    this.pinger = this.timers.setInterval(() => {
      if (generation !== this.generation || this.pingTimer) return;
      this.pingCount += 1;
      if (!this.writeRaw(generation, LOGIN.ping(this.pingCount))) return;
      this.pingTimer = this.timers.setTimeout(() => {
        this.pingTimer = undefined;
        this.logger.warn('LCN: PCHK did not answer the ping, reconnecting');
        this.lost(generation, 'no answer to the ping');
      }, TIMINGS.pingTimeout);
    }, TIMINGS.ping);
  }

  /** pypck scan_segment_couplers: 3 requests, 1.5 s after the last answer each. */
  scanSegments(generation) {
    let tries = 0;
    const next = () => {
      this.segmentTimer = undefined;
      if (generation !== this.generation) return;
      if (tries >= TIMINGS.segmentTries) {
        this.setupDone(generation);
        return;
      }
      tries += 1;
      this.writeRaw(generation, PCK.segmentScan());
      this.segmentTimer = this.timers.setTimeout(next, TIMINGS.segmentWait);
    };
    this.segmentNext = next;
    next();
  }

  segmentAnswer({ seg, id }) {
    if (id < 5 || id > LIMITS.maxSegment) return;
    // The coupler of the local segment answers from segment 0 (pypck).
    if (seg === 0) this.localSegment = id;
    if (!this.couplers.includes(id) && this.couplers.length < 64) this.couplers.push(id);
    if (this.segmentTimer) {
      this.timers.clearTimeout(this.segmentTimer);
      this.segmentTimer = this.timers.setTimeout(this.segmentNext, TIMINGS.segmentWait);
    }
  }

  setupDone(generation) {
    if (generation !== this.generation) return;
    this.timers.clearTimeout(this.loginTimer);
    this.loginTimer = undefined;
    this.phase = 'ready';
    this.ready = true;
    this.failures = 0;
    this.licenceFailures = 0;
    this.logger.info(
      `LCN: logged in to PCHK${this.couplers.length ? `, segments ${this.couplers.join(', ')} (local ${this.localSegment})` : ''}`,
    );
    this.emit('up', { couplers: [...this.couplers], localSegment: this.localSegment });
    this.pump();
  }

  /** The session ended: reconnect later, unless stopped or refused. */
  lost(generation, reason, { refused = false, licence = false } = {}) {
    if (generation !== this.generation) return;
    this.generation += 1;
    const wasUp = this.ready;
    // Ended after the password and before "OK" (closed, error, timeout): PCHK
    // may be refusing it without saying so. Twice in a row: refused, final.
    if (!refused && !licence && this.sentPassword && this.phase === 'login') {
      this.authDrops += 1;
      if (this.authDrops >= LIMITS.authDrops) {
        refused = true;
        reason = `${reason}, right after the password (${this.authDrops} times in a row)`;
      }
    }
    this.close();
    if (!this.running) return;
    let retryIn;
    if (refused) {
      // Never again by itself: a refused password is not tried in a loop.
      this.running = false;
    } else {
      if (licence) {
        this.licenceFailures += 1;
        retryIn =
          TIMINGS.licenceBackoff[
            Math.min(this.licenceFailures - 1, TIMINGS.licenceBackoff.length - 1)
          ];
      } else {
        this.failures = wasUp ? 1 : this.failures + 1;
        retryIn = TIMINGS.backoff[Math.min(this.failures - 1, TIMINGS.backoff.length - 1)];
      }
      this.reconnectTimer = this.timers.setTimeout(() => {
        this.reconnectTimer = undefined;
        if (this.running) this.open();
      }, retryIn);
    }
    this.emit('down', { reason, retryIn, refused, licence, wasUp });
  }

  // --- Writing ----------------------------------------------------------------

  /**
   * Queues a line (header included, no newline); resolves once written (with
   * the matched value when `wait` is given: { match(input) -> value |
   * undefined, timeout | until }, only lines received after the write count).
   * `protective` (a turn off): before everything else, written without
   * waiting for a quiet bus. `urgent`: before the background reads. `sendBy`
   * (a time): never written after it. `check`: called right before the write,
   * returns a refusal kind ('withdrawn', 'cancelled') or nothing.
   * `ticket.onWritten` is called once it is on the socket.
   */
  send(text, { protective = false, urgent = false, sendBy, check, ticket = {}, wait, label } = {}) {
    return new Promise((resolve, reject) => {
      ticket.written = false;
      if (!this.socket || !this.ready) {
        reject(new LcnError('Not connected to PCHK', 'offline'));
        return;
      }
      // eslint-disable-next-line no-control-regex
      if (/[\u0000-\u001f\u007f]/.test(text)) {
        reject(new LcnError('A control character in the line', 'offline'));
        return;
      }
      if (!urgent && !protective && !wait) {
        // The same background read already waiting: one line for both.
        const twin = this.background.find((e) => !e.wait && e.text === text);
        if (twin) {
          twin.followers.push({ resolve, reject });
          return;
        }
      }
      const queue = protective ? this.protective : urgent ? this.urgent : this.background;
      if (queue.length >= (protective || urgent ? LIMITS.maxUrgent : LIMITS.maxQueue)) {
        reject(new LcnError('Too many lines waiting for PCHK', 'full'));
        return;
      }
      const followers = [{ resolve, reject }];
      queue.push({
        text,
        sendBy,
        check,
        ticket,
        wait,
        label,
        followers,
        resolve: (value) => followers.forEach((f) => f.resolve(value)),
        reject: (err) => followers.forEach((f) => f.reject(err)),
      });
      this.pump();
    });
  }

  pump() {
    if (this.pumpTimer) {
      this.timers.clearTimeout(this.pumpTimer);
      this.pumpTimer = undefined;
    }
    if (!this.socket || !this.ready) return;
    const now = this.now();
    // Lines too late are dropped before anything else: never written.
    for (const queue of [this.protective, this.urgent, this.background]) {
      for (let i = queue.length - 1; i >= 0; i -= 1) {
        if (queue[i].sendBy !== undefined && now > queue[i].sendBy) {
          const [late] = queue.splice(i, 1);
          late.reject(new LcnError('Not written in time', 'late'));
        }
      }
    }
    const protective = this.protective.length > 0;
    const queue = protective
      ? this.protective
      : this.urgent.length > 0
        ? this.urgent
        : this.background;
    if (queue.length === 0) return;
    // pypck waits for 50 ms of quiet on the bus; a busy bus never holds a line
    // long, and a turn off never waits for it (only the gap between lines).
    const at = protective
      ? this.lastWriteAt + TIMINGS.lineGap
      : Math.max(
          this.lastWriteAt + TIMINGS.lineGap,
          Math.min(this.lastReadAt + TIMINGS.busIdle, this.lastWriteAt + TIMINGS.idleCap),
        );
    if (at > now) {
      this.pumpTimer = this.timers.setTimeout(() => {
        this.pumpTimer = undefined;
        this.pump();
      }, at - now);
      return;
    }
    const entry = queue.shift();
    // Last look before the socket: withdrawn (option off) or cancelled (an off asked).
    const refusal = entry.check?.();
    if (refusal) {
      entry.reject(new LcnError(`Not written: ${refusal}`, refusal));
      this.pump();
      return;
    }
    const generation = this.generation;
    entry.ticket.written = true;
    try {
      this.socket.write(`${entry.text}\n`);
    } catch (err) {
      entry.reject(new LcnError(err.message, 'lost', { sent: true }));
      this.lost(generation, err.message);
      return;
    }
    entry.ticket.onWritten?.();
    this.logger.debug(`LCN <- ${entry.label ?? entry.text}`);
    this.lastWriteAt = this.now();
    if ((this.socket?.writableLength ?? 0) > LIMITS.maxPendingWrite) {
      this.logger.warn('LCN: too much data waiting to be written, session cut');
      entry.reject(new LcnError('Write buffer full', 'lost', { sent: true }));
      this.lost(generation, 'write buffer full');
      return;
    }
    if (entry.wait) this.await(entry);
    else entry.resolve({ written: true });
    this.pump();
  }

  /** Waits for the answer of a written request: lines after the write only. */
  await(entry) {
    const waiter = {
      match: entry.wait.match,
      done: (value) => {
        this.timers.clearTimeout(waiter.timer);
        this.waiters.delete(waiter);
        entry.resolve(value);
      },
      fail: (err) => {
        this.timers.clearTimeout(waiter.timer);
        this.waiters.delete(waiter);
        entry.reject(err);
      },
    };
    const ms = entry.wait.until !== undefined ? entry.wait.until - this.now() : entry.wait.timeout;
    waiter.timer = this.timers.setTimeout(
      () => waiter.fail(new LcnError('No answer in time', 'timeout', { sent: true })),
      Math.max(0, ms),
    );
    this.waiters.add(waiter);
  }

  // --- Scan ---------------------------------------------------------------------

  /**
   * pypck scan_modules: an empty command with an acknowledgement asked, to
   * every module of each segment, 3 times, 3 s after the last answer each.
   * Resolves with the modules that answered (`seg-module`, logical); rejects
   * if the connection ends.
   */
  scanModules() {
    if (this.scanning) return this.scanning;
    const generation = this.generation;
    const found = new Set();
    let lastAnswer = -Infinity;
    let ended = false;
    const collect = (input) => {
      if (input.kind !== 'ack') return;
      if (input.module < LIMITS.minModule || input.module > LIMITS.maxModule) return;
      // Segment 0 (local) or 5 to 127: never 3 (broadcast) nor 4 (status messages).
      if (input.seg !== 0 && (input.seg < 5 || input.seg > LIMITS.maxSegment)) return;
      if (found.size >= LIMITS.maxModules) return;
      found.add(`${input.seg}-${input.module}`);
      lastAnswer = this.now();
    };
    collect.end = () => {
      ended = true;
    };
    this.collectors.add(collect);
    const sleep = (ms) =>
      new Promise((resolve) => {
        this.timers.setTimeout(resolve, ms);
      });
    const run = (async () => {
      const segments = this.couplers.length > 0 ? this.couplers : [0];
      for (let i = 0; i < TIMINGS.moduleTries; i += 1) {
        for (const seg of segments) {
          const physical = seg === this.localSegment ? 0 : seg;
          await this.send(PCK.moduleScan(physical));
        }
        const since = this.now();
        for (;;) {
          const quietUntil = Math.max(since, lastAnswer) + TIMINGS.moduleWait;
          if (this.now() >= quietUntil) break;
          await sleep(quietUntil - this.now());
          if (ended || generation !== this.generation) break;
        }
        if (ended || generation !== this.generation) {
          throw new LcnError('The connection ended during the scan', 'lost');
        }
      }
      return found;
    })();
    this.scanning = run.finally(() => {
      this.collectors.delete(collect);
      this.scanning = undefined;
    });
    return this.scanning;
  }
}
