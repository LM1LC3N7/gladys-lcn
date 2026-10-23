// -----------------------------------------------------------------------------
// The integration: one connection to LCN-PCHK (src/lcn/client.js), the
// modules the scan found and what they say, the Gladys devices and states
// (src/devices.js), the keys sent to the host as scene events, the commands
// and the LCN scenes. index.js only wires the SDK handlers to it.
//
// - The model changes when the client emits a line, in the order of the
//   bus; Gladys gets the result once per turn of the event loop.
// - A command is written within 3.5 s of the request or not at all; it is
//   confirmed only by a status of the port, received after the write, equal
//   to the value asked (until 4.5 s), and is otherwise "sent, without
//   confirmation" with a read back: never "not sent" once it may have left.
//   Its ack never waits for the publication of the states.
// - Outputs and relays not declared safe are read only; their "turn on" /
//   "turn off" buttons, and the LCN scenes, only when the configuration
//   allows them (off by default), checked on arrival and right before the
//   write. A "turn off" goes before the reads and cancels the "turn on" of
//   the same port still waiting.
// - A login refused by PCHK stops the connection (persisted with a salted
//   fingerprint of the refused credentials); never a loop. The password is
//   never logged.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import {
  moduleKey,
  moduleLabel,
  normalizeConfig,
  parseModuleRef,
  placeKey,
  portInfo,
  portsOf,
  sessionKey,
} from './config.js';
import {
  FIRMWARE_TYPED_VARIABLES,
  LIMITS,
  PRESSED,
  SCENE_TARGETS,
  SCENE_TRIGGERS,
  TIMINGS,
} from './constants.js';
import {
  KIND_ROLES,
  buildDevices,
  buildStates,
  parseDeviceId,
  parseFeatureId,
  shownModules,
} from './devices.js';
import { COMMAND_NAMES, T, fill, word } from './i18n.js';
import { LcnClient, LcnError } from './lcn/client.js';
import { PCK, keyEvents } from './lcn/pck.js';
import { StatePublisher } from './publisher.js';
import { fileStore, normalizeMemory, refusedStop, stopHolds } from './store.js';

/** A command refused before anything was sent to the bus. */
export class Refused extends Error {}

const quiet = () => undefined;

const emptyModel = () => ({ modules: new Map(), scanned: false });

function newModule(seg, module) {
  return {
    seg,
    module,
    serial: '',
    firmware: undefined,
    firmwareText: '',
    hardware: undefined,
    name: '',
    nameParts: new Map(),
    /** output number -> percent. */
    outputs: new Map(),
    /** 8 booleans, once read. */
    relays: undefined,
    binaries: undefined,
    /** port (`var1`, `sp1`) -> native value. */
    variables: new Map(),
  };
}

/** A strict 0 / 1 (null, '' and the rest are not 0). */
function binaryOf(value) {
  if (value === 0 || value === '0') return 0;
  if (value === 1 || value === '1') return 1;
  return undefined;
}

function numberOf(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** A name read from a module: printable, trimmed, 32 characters at most. */
const cleanName = (text) =>
  String(text ?? '')
    .replace(/[^\p{L}\p{N}\p{P}\p{Zs}\p{S}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 32);

export class LcnApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'lcn' }),
    client,
    connect,
    now = Date.now,
    timers = globalThis,
    store = fileStore(),
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.timers = timers;
    this.store = store;
    this.client = client ?? new LcnClient({ connect, timers, now, logger });
    this.publisher = new StatePublisher({ gladys, logger, now, timers });
    this.config = normalizeConfig();
    this.key = undefined;
    this.epoch = 0;
    this.model = emptyModel();
    this.memory = undefined;
    this.lastStatus = undefined;
    this.lastTransport = undefined;
    this.published = undefined;
    this.started = false;
    this.online = false;
    this.scanning = undefined;
    this.scanError = undefined;
    this.reading = undefined;
    this.lastAttemptAt = -Infinity;
    this.lastScanAt = -Infinity;
    this.lastFullAt = -Infinity;
    this.lastVariablesAt = -Infinity;
    this.readBacks = new Set();
    /** port key -> Set of tokens of the "turn on" commands not yet written. */
    this.pendingOn = new Map();
    this.starting = Promise.resolve();
    this.pendingEvents = [];
    this.flushScheduled = false;
    this.client.on('attempt', () => this.noteAttempt());
    this.client.on('up', () => {
      this.online = true;
      const epoch = this.epoch;
      this.guard(() => this.onUp(epoch));
    });
    this.client.on('down', (info) => {
      this.online = false;
      const epoch = this.epoch;
      this.guard(() => this.onDown(info, epoch));
    });
    this.client.on('bus', () => {
      const epoch = this.epoch;
      this.guard(() => this.refreshStatus(epoch));
    });
    // Applied at once, in the order of the bus.
    this.client.on('input', (input) => this.applyInput(input));
  }

  /** What talks to Gladys runs one after the other, in order. */
  guard(fn) {
    this.chain = (this.chain ?? Promise.resolve())
      .then(fn)
      .catch((err) => this.logger.error(`LCN event failed: ${err.message}`));
    return this.chain;
  }

  get language() {
    return this.config.language;
  }

  error(entry, cause) {
    return new Error(word(entry, this.language), cause ? { cause } : undefined);
  }

  refused(entry) {
    return new Refused(word(entry, this.language));
  }

  // --- Lifecycle -------------------------------------------------------------

  async loadMemory() {
    if (this.memory) return this.memory;
    try {
      this.memory = normalizeMemory(await this.store.load(), this.now());
    } catch {
      this.memory = normalizeMemory(null, this.now());
    }
    return this.memory;
  }

  async saveMemory() {
    try {
      await this.store.save(this.memory);
    } catch (err) {
      this.logger.warn(`Saving the state to /data failed: ${err.message}`);
    }
  }

  /** A connection attempt starts: its time goes to /data first (at most once a minute). */
  noteAttempt() {
    const now = this.now();
    this.lastAttemptAt = now;
    const memory = this.memory;
    if (memory && now - memory.lastAttemptAt >= TIMINGS.attemptWrite) {
      memory.lastAttemptAt = now;
      this.saveMemory();
    }
  }

  /** Starts (or restarts); two starts never overlap (no leaked timer). */
  start(raw = {}) {
    const run = this.starting.then(() => this.startNow(raw));
    this.starting = run.catch(() => undefined);
    return run;
  }

  async startNow(raw = {}) {
    this.stop();
    this.epoch += 1;
    const epoch = this.epoch;
    const next = normalizeConfig(raw);
    if (placeKey(next) !== placeKey(this.config)) {
      // Another PCHK, maybe: what we knew no longer holds.
      this.model = emptyModel();
      this.lastFullAt = -Infinity;
      this.lastScanAt = -Infinity;
    }
    this.config = next;
    this.key = sessionKey(next);
    this.online = false;
    if (next.portErrors.length > 0) {
      this.logger.warn(`Ports not understood: ${next.portErrors.join(', ')}`);
    }
    const memory = await this.loadMemory();
    if (epoch !== this.epoch) return;
    await this.publishDevices();
    await this.publishStates();
    const problem = this.configProblem();
    if (problem) {
      await this.setStatus(false, problem, epoch);
      return;
    }
    const place = placeKey(next);
    if (stopHolds(memory.stop, place, next.username, next.password)) {
      this.logger.warn(
        'LCN: PCHK refused these credentials before: no connection until they change or "Test the connection" is clicked',
      );
      await this.setStatus(false, T.refused, epoch);
      return;
    }
    const now = this.now();
    let delay = 0;
    if (memory.pause && memory.pause.place === place && memory.pause.until > now) {
      delay = memory.pause.until - now;
      await this.setStatus(false, fill(T.licence, Math.ceil(delay / 60_000)), epoch);
    } else {
      await this.setStatus(false, T.connecting, epoch);
    }
    // A restart never connects faster than the spacing of the attempts.
    const spacing = Math.min(
      TIMINGS.minAttemptGap,
      memory.lastAttemptAt + TIMINGS.minAttemptGap - now,
    );
    if (epoch !== this.epoch) return;
    this.connect(Math.max(delay, spacing, 0));
    this.startTimers();
  }

  connect(delay = 0) {
    this.client.configure({
      host: this.config.host,
      port: this.config.port,
      username: this.config.username,
      password: this.config.password,
      dim200: this.config.dim200,
    });
    this.client.start({ delay });
  }

  startTimers() {
    if (!this.sweeper) {
      this.sweeper = this.timers.setInterval(
        () => this.guard(() => this.publishStates()),
        TIMINGS.sweep,
      );
    }
    if (!this.poller) {
      this.poller = this.timers.setInterval(() => this.tick(), TIMINGS.tick);
    }
  }

  stop() {
    this.client.stop();
    this.online = false;
    this.publisher.stop();
    for (const name of ['sweeper', 'poller']) {
      if (this[name]) {
        this.timers.clearInterval(this[name]);
        this[name] = undefined;
      }
    }
    if (this.namesTimer) this.timers.clearTimeout(this.namesTimer);
    this.namesTimer = undefined;
    for (const timer of this.readBacks) this.timers.clearTimeout(timer);
    this.readBacks.clear();
  }

  configProblem() {
    if (!this.config.host) return T.noHost;
    if (!this.config.username) return T.noUser;
    return undefined;
  }

  /** First connection to Gladys: start; a reconnection (Gladys restarted): resend everything. */
  async connected(raw = {}) {
    if (!this.started) {
      this.started = true;
      await this.start(raw);
      return;
    }
    // Gladys keeps the connection status and the discovered devices in memory.
    this.published = undefined;
    this.lastTransport = undefined;
    const status = this.lastStatus;
    this.lastStatus = undefined;
    await this.configUpdated(raw);
    if (status && this.lastStatus === undefined) {
      const [connected, message] = JSON.parse(status);
      await this.setStatus(connected, message ?? undefined);
    }
    this.publisher.forget();
    await this.publishDevices();
    await this.publishStates();
    await this.publishTransports(
      this.online ? DEVICE_TRANSPORTS.LOCAL : DEVICE_TRANSPORTS.UNREACHABLE,
    );
  }

  /** A new place or new credentials reconnect; the rest applies at once (nothing read again unless "Ports" changed). */
  async configUpdated(raw = {}) {
    const next = normalizeConfig(raw);
    if (sessionKey(next) !== this.key) {
      // The options hold at once, even while the restart waits.
      this.config = {
        ...this.config,
        allowOutputButtons: next.allowOutputButtons,
        allowScenes: next.allowScenes,
      };
      return this.start(raw);
    }
    const portsChanged = portsText(next) !== portsText(this.config);
    this.config = next;
    await this.publishDevices();
    await this.publishStates();
    if (this.online && portsChanged) this.loadModules({ full: true, force: true });
    if (this.online && !this.scanning) await this.setStatus(true, this.connectedMessage());
    return undefined;
  }

  async setStatus(connected, message, epoch = this.epoch) {
    if (epoch !== this.epoch) return;
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  connectedMessage() {
    const modules = shownModules(this.config, this.model).length;
    if (this.client.busConnected === false) return fill(T.busDown, modules);
    if (this.scanError) return fill(T.scanFailed, this.scanError);
    const errors = this.config.portErrors;
    const extra = errors.length > 0 ? fill(T.portErrors, errors.slice(0, 5).join(', ')) : {};
    return {
      en: word(T.connected, 'en')(modules, extra.en ?? ''),
      fr: word(T.connected, 'fr')(modules, extra.fr ?? ''),
    };
  }

  async refreshStatus(epoch) {
    if (this.client.connected && !this.scanning) {
      await this.setStatus(true, this.connectedMessage(), epoch);
    }
  }

  // --- Client events ---------------------------------------------------------

  async onUp(epoch) {
    if (epoch !== this.epoch) return;
    const memory = await this.loadMemory();
    if (memory.stop || memory.pause) {
      // The first successful login erases the fingerprint of refused credentials.
      memory.stop = null;
      memory.pause = null;
      await this.saveMemory();
    }
    if (epoch !== this.epoch) return;
    await this.publishTransports(DEVICE_TRANSPORTS.LOCAL);
    if (!this.model.scanned) {
      // The scan runs outside the event chain: lines and commands go on meanwhile.
      this.runScan();
      return;
    }
    this.loadModules({ full: true });
    await this.setStatus(true, this.connectedMessage(), epoch);
  }

  async onDown({ reason, retryIn, refused, licence, wasUp }, epoch) {
    if (epoch !== this.epoch) return;
    const memory = await this.loadMemory();
    const place = placeKey(this.config);
    if (refused) {
      this.logger.error(`LCN: connection stopped (${reason}), no new try`);
      memory.stop = refusedStop(place, this.config.username, this.config.password, this.now());
      await this.saveMemory();
      await this.setStatus(false, T.refused, epoch);
    } else if (licence) {
      this.logger.warn(`LCN: ${reason}; next try in ${Math.round(retryIn / 60_000)} min`);
      memory.pause = { place, until: this.now() + retryIn };
      await this.saveMemory();
      await this.setStatus(false, fill(T.licence, Math.ceil(retryIn / 60_000)), epoch);
    } else {
      const seconds = Math.round((retryIn ?? 0) / 1000);
      this.logger.warn(`LCN: ${reason}; next try in ${seconds} s`);
      await this.setStatus(false, fill(T.unreachable, reason, seconds), epoch);
    }
    if (wasUp || this.lastTransport !== undefined) {
      await this.publishTransports(DEVICE_TRANSPORTS.UNREACHABLE);
    }
  }

  /** The scan of the modules, one at a time; the modules found replace the list. */
  runScan() {
    if (this.scanning) return this.scanning;
    const epoch = this.epoch;
    this.lastScanAt = this.now();
    const run = (async () => {
      await this.guard(() => this.setStatus(true, T.scanning, epoch));
      let found;
      try {
        found = await this.client.scanModules();
        this.scanError = undefined;
      } catch (err) {
        this.logger.warn(`LCN: the scan of the modules failed: ${err.message}`);
        if (this.client.connected) this.scanError = err.message;
        return;
      }
      if (epoch !== this.epoch) return;
      const modules = new Map();
      for (const key of [...found].sort()) {
        const [seg, module] = key.split('-').map(Number);
        modules.set(key, this.model.modules.get(key) ?? newModule(seg, module));
      }
      for (const key of this.model.modules.keys()) {
        if (!modules.has(key)) this.logger.warn(`LCN: module ${key} not found any more`);
      }
      this.model.modules = modules;
      this.model.scanned = true;
      this.logger.info(`LCN: ${modules.size} module(s) found`);
      await this.guard(async () => {
        await this.publishDevices();
        await this.publishTransports(DEVICE_TRANSPORTS.LOCAL, { force: true });
      });
      await this.readIdentities([...modules.values()]);
      this.loadModules({ full: true, force: true });
    })();
    this.scanning = run.finally(async () => {
      this.scanning = undefined;
      if (this.client.connected) await this.guard(() => this.refreshStatus(epoch));
    });
    return this.scanning;
  }

  /** Serial numbers (firmware, hardware) then names, in the background. */
  async readIdentities(modules) {
    await Promise.allSettled(
      modules.map((info) =>
        this.client.send(this.client.header(info.seg, info.module) + PCK.serial(), {
          wait: {
            match: (i) => i.kind === 'serial' && i.seg === info.seg && i.module === info.module,
            timeout: TIMINGS.serialWait,
          },
        }),
      ),
    );
    for (const info of modules) {
      for (const block of [1, 2]) {
        this.client.send(this.client.header(info.seg, info.module) + PCK.name(block)).catch(quiet);
      }
    }
  }

  /** The poller: a full read every 10 min, the variables of old modules every minute. */
  tick() {
    if (!this.client.connected || this.scanning) return;
    const now = this.now();
    if (now - this.lastFullAt >= TIMINGS.refresh) this.loadModules({ full: true });
    else if (now - this.lastVariablesAt >= TIMINGS.variablePoll) this.loadModules({ full: false });
  }

  /**
   * Reads the states of the ports shown. `full`: everything (at most once a
   * minute, a reconnection included, unless `force`); else only the
   * variables of the old modules (they send nothing by themselves). One read
   * at a time: a reconnection during a read starts none.
   */
  loadModules({ full, force = false }) {
    if (this.reading || !this.client.connected) return this.reading;
    const now = this.now();
    if (full && !force && now - this.lastFullAt < TIMINGS.fullRead) return undefined;
    if (full) this.lastFullAt = now;
    this.lastVariablesAt = now;
    const old = [];
    for (const { key, seg, module, info: known } of shownModules(this.config, this.model)) {
      const info = known ?? this.ensureModule(seg, module);
      if (!info) continue;
      const head = this.client.header(seg, module);
      const send = (line) => this.client.send(head + line).catch(quiet);
      const ports = portsOf(this.config, key);
      const variables = [];
      let relays = false;
      let binaries = false;
      for (const port of ports.keys()) {
        const { family, number } = portInfo(port) ?? {};
        if (family === 'output' && full) send(PCK.outputStatus(number));
        if (family === 'relay') relays = true;
        if (family === 'binary') binaries = true;
        if (family === 'variable' || family === 'setpoint') variables.push(port);
      }
      if (full && relays) send(PCK.relayStatus());
      if (full && binaries) send(PCK.binaryStatus());
      if (variables.length === 0) continue;
      if (info.firmware === undefined) {
        // The firmware decides how to ask: read it first, the variables next time.
        if (full) send(PCK.serial());
        continue;
      }
      if (info.firmware >= FIRMWARE_TYPED_VARIABLES) {
        if (full)
          for (const port of variables)
            send(PCK.variable(port, info.firmware, FIRMWARE_TYPED_VARIABLES));
      } else {
        old.push([info, variables]);
      }
    }
    if (old.length === 0) return undefined;
    this.reading = this.readOldVariables(old).finally(() => {
      this.reading = undefined;
    });
    return this.reading;
  }

  /** Old modules answer without saying which variable: one question at a time per module. */
  async readOldVariables(list) {
    await Promise.allSettled(
      list.map(async ([info, ports]) => {
        for (const port of ports) {
          const line = PCK.variable(port, info.firmware, FIRMWARE_TYPED_VARIABLES);
          if (!line || !this.client.connected) continue;
          try {
            const input = await this.client.send(this.client.header(info.seg, info.module) + line, {
              wait: {
                match: (i) =>
                  i.kind === 'variable' &&
                  i.port === null &&
                  i.seg === info.seg &&
                  i.module === info.module
                    ? i
                    : undefined,
                timeout: TIMINGS.variableWait,
              },
            });
            info.variables.set(port, input.value);
            this.noteChange([]);
          } catch {
            // No answer: the value stays unknown until the next read.
          }
        }
      }),
    );
  }

  /** The model entry of a module named in "Ports" (bounded: what the bus says never creates one). */
  ensureModule(seg, module) {
    const key = moduleKey(seg, module);
    let info = this.model.modules.get(key);
    if (info) return info;
    if (!this.config.ports.has(key) || this.model.modules.size >= LIMITS.maxModules) {
      return undefined;
    }
    info = newModule(seg, module);
    this.model.modules.set(key, info);
    return info;
  }

  /** A line of a module, applied to the model at once; what it changes goes to Gladys once per turn. */
  applyInput(input) {
    if (input.kind === 'ack') return;
    if (input.kind === 'keys') {
      const events = [];
      for (const event of keyEvents(input)) {
        // Bounded at the entry: over the budget of the minute, refused here.
        if (this.publisher.reserveEvent()) {
          events.push({ module: moduleLabel(input.seg, input.module), ...event });
        }
      }
      if (events.length > 0) this.noteChange(events);
      return;
    }
    const info = this.ensureModule(input.seg, input.module);
    if (!info) return;
    switch (input.kind) {
      case 'output':
        info.outputs.set(input.output, input.percent);
        break;
      case 'relays':
        info.relays = input.bits;
        break;
      case 'binaries':
        info.binaries = input.bits;
        break;
      case 'variable':
        // A typeless answer (old modules) belongs to the request waiting for it only.
        if (input.port === null) return;
        info.variables.set(input.port, input.value);
        break;
      case 'serial': {
        const changed =
          info.serial !== input.serial ||
          info.firmware !== input.firmware ||
          info.hardware !== input.hardware;
        if (info.serial && info.serial !== input.serial) {
          this.logger.warn(
            `LCN: module ${moduleLabel(input.seg, input.module)} has another serial number now (replaced?)`,
          );
        }
        info.serial = input.serial;
        info.firmware = input.firmware;
        info.firmwareText = input.firmwareText;
        info.hardware = input.hardware;
        if (changed) this.scheduleDevices();
        return;
      }
      case 'name': {
        info.nameParts.set(input.block, input.text);
        if (info.nameParts.size < 2) return;
        const name = cleanName(`${info.nameParts.get(1).padEnd(10)}${info.nameParts.get(2)}`);
        info.nameParts.clear();
        if (name && name !== info.name) {
          info.name = name;
          this.scheduleDevices();
        }
        return;
      }
      default:
        return;
    }
    this.noteChange([]);
  }

  /** New names or serials: the Discovery is published again after 2 s of quiet. */
  scheduleDevices() {
    if (this.namesTimer) this.timers.clearTimeout(this.namesTimer);
    this.namesTimer = this.timers.setTimeout(() => {
      this.namesTimer = undefined;
      this.guard(() => this.publishDevices());
    }, 2_000);
  }

  noteChange(events) {
    this.pendingEvents.push(...events);
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setImmediate(() => {
      this.flushScheduled = false;
      this.guard(() => this.flushChanges());
    });
  }

  async flushChanges() {
    const events = this.pendingEvents.splice(0);
    await this.publishStates();
    for (const event of events) {
      await this.publisher.sceneEvent(SCENE_TRIGGERS.KEY, event, { reserved: true });
    }
  }

  // --- Gladys ----------------------------------------------------------------

  async publishDevices({ force = false } = {}) {
    const devices = buildDevices(this.gladys, this.config, this.model);
    if (devices.length === 0) return;
    const json = JSON.stringify(devices);
    if (json === this.published && !force) return;
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.published = json;
    } catch (err) {
      this.logger.warn(`Publishing the devices failed: ${err.message}`);
    }
  }

  publishStates() {
    return this.publisher.publish(buildStates(this.gladys, this.config, this.model));
  }

  async publishTransports(transport, { force = false } = {}) {
    if (transport === this.lastTransport && !force) return;
    const devices = buildDevices(this.gladys, this.config, this.model);
    if (devices.length === 0) return;
    const entries = devices.map((device) => ({ external_id: device.external_id, transport }));
    try {
      for (let i = 0; i < entries.length; i += 100) {
        await this.gladys.publishTransports(entries.slice(i, i + 100));
      }
      this.lastTransport = transport;
    } catch (err) {
      this.logger.warn(`Publishing the transports failed: ${err.message}`);
    }
  }

  /** "Scan" in Gladys: the devices sent again; the bus scanned again at most once a minute. */
  async scan() {
    await this.publishDevices({ force: true });
    if (this.client.connected && this.now() - this.lastScanAt >= TIMINGS.scanGap) this.runScan();
  }

  /** The user created or updated a device: Gladys has none of its states yet, send them again. */
  async deviceChanged(device) {
    this.publisher.forget(device?.external_id);
    await this.publishStates();
  }

  // --- Commands --------------------------------------------------------------

  checkReachable() {
    if (!this.client.connected) throw this.refused(T.offline);
    if (this.client.busConnected === false) throw this.refused(T.busOffline);
  }

  async setValue(_device, feature, value) {
    const asked = this.now();
    const target = parseFeatureId(feature?.external_id);
    if (!target) throw this.refused(T.readOnly);
    const { seg, module, port, role, family, number } = target;
    if (!['output', 'relay'].includes(family) || role === 'state' || role === 'level') {
      throw this.refused(T.readOnly);
    }
    const id = `${moduleLabel(seg, module)}.${port.toUpperCase()}`;
    let on;
    let percent;
    let gated = false;
    if (role === 'on' || role === 'off') {
      if (numberOf(value) !== PRESSED) throw this.refused(fill(T.badValue, JSON.stringify(value)));
      if (!this.config.allowOutputButtons) {
        this.logger.warn(`Button ${id} ${role} REFUSED: disabled in the configuration`);
        throw this.refused(T.buttonsDisabled);
      }
      gated = true;
      on = role === 'on';
      percent = on ? 100 : 0;
    } else {
      const kind = portsOf(this.config, moduleKey(seg, module)).get(port);
      if (!(KIND_ROLES[family]?.[kind] ?? []).includes(role) || kind === 'readonly') {
        this.logger.warn(`${id} ${role} REFUSED: not declared as such in "Ports"`);
        throw this.refused(T.notDeclared);
      }
      if (role === 'brightness') {
        const level = numberOf(value);
        if (level === undefined || level < 0 || level > 100) {
          throw this.refused(fill(T.badValue, JSON.stringify(value)));
        }
        percent = Math.round(level);
        on = percent > 0;
      } else {
        const bit = binaryOf(value);
        if (bit === undefined) throw this.refused(fill(T.badValue, JSON.stringify(value)));
        on = bit === 1;
        percent = on ? 100 : 0;
      }
    }
    this.checkReachable();
    const gate = gated ? () => this.config.allowOutputButtons : undefined;
    if (family === 'output') {
      return this.command({
        seg,
        module,
        port,
        asked,
        protective: percent === 0,
        gate,
        what: fill(COMMAND_NAMES.output, id, percent),
        line: PCK.dim(number, percent),
        read: PCK.outputStatus(number),
        confirm: (i) =>
          i.kind === 'output' &&
          i.seg === seg &&
          i.module === module &&
          i.output === number &&
          Math.abs(i.percent - percent) <= 1,
      });
    }
    return this.command({
      seg,
      module,
      port,
      asked,
      protective: !on,
      gate,
      what: fill(COMMAND_NAMES.relay, id, on),
      line: PCK.relay(number, on),
      read: PCK.relayStatus(),
      confirm: (i) =>
        i.kind === 'relays' && i.seg === seg && i.module === module && i.bits[number - 1] === on,
    });
  }

  /**
   * One command: written before the deadline (or refused, nothing sent), a
   * status read of the port queued right behind it, confirmed by a status
   * equal to the value asked. A protective one (off, 0 %) cancels the "turn
   * on" of the same port still waiting, and is never cancelled itself.
   */
  async command({ seg, module, port, asked, protective, gate, what, line, read, confirm }) {
    const label = word(what, 'en');
    const portKey = `${moduleKey(seg, module)}:${port}`;
    const token = { cancelled: false };
    if (protective) {
      for (const pending of this.pendingOn.get(portKey) ?? []) pending.cancelled = true;
    } else {
      if (!this.pendingOn.has(portKey)) this.pendingOn.set(portKey, new Set());
      this.pendingOn.get(portKey).add(token);
    }
    const check = () => {
      if (token.cancelled) return 'cancelled';
      if (gate && !gate()) return 'withdrawn';
      return undefined;
    };
    const head = this.client.header(seg, module);
    try {
      if (this.now() > asked + TIMINGS.sendBy) throw new LcnError('too late', 'late');
      this.logger.info(`Command from Gladys: ${label}`);
      const done = this.client.send(head + line, {
        urgent: true,
        sendBy: asked + TIMINGS.sendBy,
        check,
        label,
        wait: { match: confirm, until: asked + TIMINGS.answerBy },
      });
      // Right behind the command: the module tells its state (it also sends it by itself).
      this.client.send(head + read, { urgent: true, sendBy: asked + TIMINGS.sendBy }).catch(quiet);
      await done;
      this.logger.info(`Command confirmed by the module (${label})`);
    } catch (err) {
      throw this.sendError(err, { label, what, seg, module, read });
    } finally {
      const set = this.pendingOn.get(portKey);
      if (set) {
        set.delete(token);
        if (set.size === 0) this.pendingOn.delete(portKey);
      }
    }
  }

  sendError(err, { label, what, seg, module, read, scene = false }) {
    if (err instanceof LcnError && !err.sent) {
      this.logger.warn(`Command NOT sent (${label}): ${err.message}`);
      if (err.kind === 'withdrawn')
        return this.refused(scene ? T.scenesDisabled : T.buttonsDisabled);
      if (err.kind === 'cancelled') return this.refused(T.cancelled);
      if (err.kind === 'late') return this.refused(T.tooLate);
      if (err.kind === 'full') return this.refused(T.queueFull);
      return this.refused(T.offline);
    }
    if (!(err instanceof LcnError)) return err;
    this.logger.warn(`Command sent, NOT confirmed (${label}): ${err.message}`);
    if (read) this.scheduleReadBack(seg, module, read);
    return this.error(fill(T.unconfirmed, word(what, this.language)), err);
  }

  scheduleReadBack(seg, module, read) {
    const timer = this.timers.setTimeout(() => {
      this.readBacks.delete(timer);
      if (!this.client.connected) return;
      this.client.send(this.client.header(seg, module) + read).catch(quiet);
    }, TIMINGS.readBack);
    this.readBacks.add(timer);
  }

  /**
   * The scene action "Activate an LCN scene": the scene register, then the
   * scene for the outputs and / or the relays of the module. Off by default
   * (a scene may switch anything); checked on arrival and before each line.
   */
  async sceneAction(fields = {}) {
    const asked = this.now();
    if (!this.config.allowScenes) {
      this.logger.warn('LCN scene REFUSED: disabled in the configuration');
      throw this.refused(T.scenesDisabled);
    }
    const ref = parseDeviceId(fields.module) ?? parseModuleRef(fields.module);
    const register = numberOf(fields.register);
    const scene = numberOf(fields.scene);
    const target = fields.target ?? 'both';
    if (!ref) throw this.refused(T.badModule);
    for (const value of [register, scene]) {
      if (!Number.isInteger(value) || value < 0 || value > 9) {
        throw this.refused(fill(T.badValue, JSON.stringify(value ?? null)));
      }
    }
    if (!SCENE_TARGETS.includes(target)) {
      throw this.refused(fill(T.badValue, JSON.stringify(target)));
    }
    this.checkReachable();
    const what = fill(COMMAND_NAMES.scene, moduleLabel(ref.seg, ref.module), register, scene);
    const label = word(what, 'en');
    const head = this.client.header(ref.seg, ref.module);
    const options = {
      urgent: true,
      sendBy: asked + TIMINGS.sendBy,
      check: () => (this.config.allowScenes ? undefined : 'withdrawn'),
    };
    const lines = [PCK.sceneRegister(register)];
    if (target !== 'relays') lines.push(PCK.sceneOutputs(scene));
    if (target !== 'outputs') lines.push(PCK.sceneRelays(scene));
    this.logger.info(`LCN scene from Gladys: ${label} (${target})`);
    let written = 0;
    try {
      for (const line of lines) {
        await this.client.send(head + line, { ...options, label });
        written += 1;
      }
    } catch (err) {
      if (written > 0 && err instanceof LcnError && !err.sent)
        throw this.error(T.scenePartial, err);
      throw this.sendError(err, { label, what, scene: true });
    }
    return undefined;
  }

  // --- Configuration button ----------------------------------------------------

  /** Waits for the connection to come up or go down, at most `timeout` ms. */
  waitForLink(timeout) {
    if (this.client.connected) return Promise.resolve('up');
    return new Promise((resolve) => {
      const done = (result) => {
        this.client.off('up', onUp);
        this.client.off('down', onDown);
        this.timers.clearTimeout(timer);
        resolve(result);
      };
      const onUp = () => done('up');
      const onDown = () => done('down');
      const timer = this.timers.setTimeout(() => done('timeout'), timeout);
      this.client.on('up', onUp);
      this.client.on('down', onDown);
    });
  }

  /**
   * "Test the connection": connected, it only tells what is known; else one
   * attempt now (never closer than 10 s to the last one), a refused login
   * included: its stop is erased only by a successful login.
   */
  async testConnection() {
    await this.starting;
    const problem = this.configProblem();
    if (problem) throw this.error(problem);
    if (this.client.connected) return this.connectedMessage();
    const until = this.now() + TIMINGS.testWait;
    if (!this.client.busy) {
      const memory = await this.loadMemory();
      const last = Math.max(this.lastAttemptAt, memory.lastAttemptAt);
      const wait = last + TIMINGS.minAttemptGap - this.now();
      if (wait > 0) throw this.error(fill(T.tooSoon, Math.ceil(wait / 1000)));
      await this.setStatus(false, T.connecting);
      this.connect(0);
      this.startTimers();
    }
    const result = await this.waitForLink(TIMINGS.testWait);
    await this.chain;
    if (result === 'timeout') throw this.error(T.stillConnecting);
    if (result !== 'up') {
      const [, message] = this.lastStatus ? JSON.parse(this.lastStatus) : [];
      throw this.error(message ?? T.offline);
    }
    if (this.scanning) {
      let timer;
      const left = Math.max(0, until - this.now());
      await Promise.race([
        this.scanning,
        new Promise((resolve) => {
          timer = this.timers.setTimeout(resolve, left);
        }),
      ]);
      this.timers.clearTimeout(timer);
    }
    return this.connectedMessage();
  }
}

const portsText = (config) =>
  JSON.stringify([...config.ports].map(([key, ports]) => [key, [...ports]]));
