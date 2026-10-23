// -----------------------------------------------------------------------------
// Fixed values: manifest keys, Gladys value enums, protocol limits and timings.
// The SDK exports the Gladys categories and types, not the state values: the
// ones used here mirror server/utils/constants.js of the core.
// -----------------------------------------------------------------------------

/** Manifest keys: frozen, users store them in scenes and dashboards. */
export const ACTIONS = {
  TEST_CONNECTION: 'test_connection',
};

export const SCENE_TRIGGERS = {
  KEY: 'key',
};

export const SCENE_ACTIONS = {
  ACTIVATE_SCENE: 'activate_scene',
};

/** What a key sent to the host did (frozen: scenes compare them). */
export const KEY_ACTIONS = ['hit', 'make', 'break'];

/** The key tables a module can send to the host (A to C). */
export const KEY_TABLES = ['A', 'B', 'C'];

/** What an LCN scene activation reaches (frozen: stored in scenes). */
export const SCENE_TARGETS = ['outputs', 'relays', 'both'];

/** LCN-PCHK dimming modes (frozen: stored in the configuration). */
export const DIM_MODES = ['steps200', 'steps50'];

/** Gladys core values (server/utils/constants.js). */
export const STATE = { OFF: 0, ON: 1 };
/** A pressed push button (button/push). */
export const PRESSED = 1;

/** LCN-PCHK listens on 4114 unless changed. */
export const DEFAULT_PORT = 4114;

/** Firmware from which the variables answer with their type (pypck: 0x170206). */
export const FIRMWARE_TYPED_VARIABLES = 0x170206;

export const LIMITS = {
  /** Module ids on a segment (1 LCN-PRO, 2 LCN-GVS, 4 PCHK: not modules). */
  minModule: 5,
  maxModule: 254,
  /** Segment ids (0 = the local segment, 3 and 4 are broadcast and status). */
  maxSegment: 127,
  /** A PCK line is short: longer ones are dropped whole. */
  maxLine: 512,
  /** Entries of "Ports" at most. */
  maxPorts: 500,
  /** Modules shown at most (the core takes 2000 discovered devices). */
  maxModules: 500,
  /** Background lines waiting (reads): more are refused, nothing sent. */
  maxQueue: 1_000,
  /** Bytes waiting in the socket write buffer before the session is cut. */
  maxPendingWrite: 64 * 1024,
  /** States per minute sent to Gladys (the core admits 300). */
  statesPerMinute: 240,
  /** Part of it only the commanded features (not the measurements) may use. */
  priorityStates: 60,
  /** Scene events per minute (the core admits 300): key events over it are dropped. */
  eventsPerMinute: 120,
  /** Pause after a licence error of PCHK, at most (persisted, read back capped). */
  maxPause: 6 * 60 * 60_000,
};

export const TIMINGS = {
  /** TCP connection to PCHK. */
  connectTimeout: 10_000,
  /** From the connection to the end of the login (prompts, OK, dec-mode). */
  loginTimeout: 15_000,
  /** Waits before reconnecting, in a row (the last one repeats), never under 10 s. */
  backoff: [10_000, 30_000, 60_000, 120_000, 300_000],
  /** After a licence error of PCHK (all its connections taken). */
  licenceBackoff: [300_000, 900_000, 1_800_000, 3_600_000],
  /** Two connection attempts (a restart and the test button included) never closer than this. */
  minAttemptGap: 10_000,
  /** The time of the last attempt is written to /data at most this often. */
  attemptWrite: 60_000,
  /** Between two lines written; and after the last line received (pypck: 50 ms idle). */
  lineGap: 60,
  busIdle: 50,
  /** The wait for an idle bus never holds a line longer than this. */
  idleCap: 250,
  /** Segment couplers: 3 requests, 1.5 s after the last answer (pypck). */
  segmentWait: 1_500,
  segmentTries: 3,
  /** Modules: 3 broadcasts, 3 s after the last answer (pypck). */
  moduleWait: 3_000,
  moduleTries: 3,
  /** The serial number of a module, at most. */
  serialWait: 3_000,
  /** A typeless variable of an old module, at most. */
  variableWait: 3_000,
  /** Keep-alive: PCHK closes an idle connection after 10 min; it answers ^ping. */
  ping: 240_000,
  pingTimeout: 10_000,
  /** A full read of the states at most this often (a reconnection included). */
  fullRead: 60_000,
  /** The states are read again this often (the modules also send their changes). */
  refresh: 600_000,
  /** The variables of old modules (before 170206) send nothing: read this often. */
  variablePoll: 60_000,
  /** The poller looks this often. */
  tick: 15_000,
  /** "Scan" in Gladys scans the bus at most this often (else the devices are sent again). */
  scanGap: 60_000,
  /** At most one warning this often about the lines dropped. */
  dropLog: 60_000,
  /**
   * Gladys waits 5 s for a set_value ack. A command is written by sendBy
   * after it was asked (else refused, nothing sent); a status equal to the
   * value asked is awaited until answerBy (else "sent, without confirmation").
   */
  sendBy: 3_500,
  answerBy: 4_500,
  /** The port is read again this long after an unconfirmed command. */
  readBack: 2_000,
  /** How often the unchanged states get their heartbeat checked. */
  sweep: 60_000,
  /** An unchanged state is sent again this often… */
  stateHeartbeat: 30 * 60_000,
  /** …plus a per-feature offset within this spread. */
  heartbeatSpread: 5 * 60_000,
  /** "Test the connection" waits this long (the manifest allows 30 s). */
  testWait: 25_000,
};

/**
 * Commands waiting, a cap of their own (a full background queue never
 * refuses one): as many as can be written before the deadline of the last
 * one; the deadline already refuses what cannot leave in time.
 */
LIMITS.maxUrgent = Math.ceil(TIMINGS.sendBy / TIMINGS.lineGap) * 2;
