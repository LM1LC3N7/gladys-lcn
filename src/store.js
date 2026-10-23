// -----------------------------------------------------------------------------
// What must survive a restart, in /data (the only writable place of the
// container), readable by the container user only (0600):
// - the stop after PCHK refused the login, with the place it belongs to and a
//   salted SHA-256 fingerprint of the REFUSED user name and password (never
//   of a password that worked): a restart never sends the same refused
//   credentials again, other credentials are tried; erased at the first
//   successful login;
// - the pause after a licence error of PCHK (its end, read back capped);
// - the time of the last connection attempt (written at most once a minute):
//   a restart never connects faster than the spacing of the attempts.
// Never the password itself.
// -----------------------------------------------------------------------------

import { createHash, randomBytes } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { LIMITS } from './constants.js';

export const STATE_FILE = '/data/lcn-state.json';

export function fileStore(path = STATE_FILE) {
  // One write at a time: two saves never share the temporary file.
  let chain = Promise.resolve();
  return {
    async load() {
      try {
        const text = await readFile(path, 'utf8');
        return text.length > 64 * 1024 ? null : JSON.parse(text);
      } catch {
        return null;
      }
    },
    save(data) {
      const text = JSON.stringify(data);
      const write = chain.then(async () => {
        const temporary = `${path}.tmp`;
        await writeFile(temporary, text, { mode: 0o600 });
        await rename(temporary, path);
      });
      chain = write.catch(() => {});
      return write;
    },
  };
}

/** In-memory store, for the tests. */
export function memoryStore(initial = null) {
  let data = initial;
  let saves = 0;
  return {
    async load() {
      return data === null ? null : JSON.parse(JSON.stringify(data));
    },
    async save(next) {
      saves += 1;
      data = JSON.parse(JSON.stringify(next));
    },
    get data() {
      return data;
    },
    get saves() {
      return saves;
    },
  };
}

/** The salted fingerprint of a user name and password (refused ones only are kept). */
export function credentialsHash(salt, username, password) {
  return createHash('sha256').update(`${salt}\u0000${username}\u0000${password}`).digest('hex');
}

/** A stop for refused credentials: a fresh salt each time. */
export function refusedStop(place, username, password, at) {
  const salt = randomBytes(16).toString('hex');
  return {
    place,
    kind: 'login_refused',
    salt,
    hash: credentialsHash(salt, username, password),
    at,
  };
}

/** Whether a stop holds for these credentials (the same refused ones). */
export const stopHolds = (stop, place, username, password) =>
  Boolean(stop) &&
  stop.place === place &&
  credentialsHash(stop.salt, username, password) === stop.hash;

const HEX = (length) => new RegExp(`^[0-9a-f]{${length}}$`);

/** The persisted state, repaired: { stop, pause, lastAttemptAt }. */
export function normalizeMemory(raw, now = Date.now()) {
  const stop = raw?.stop;
  const pause = raw?.pause;
  const placeOk = (place) => typeof place === 'string' && place.length > 0 && place.length <= 300;
  const stopValid =
    placeOk(stop?.place) &&
    stop.kind === 'login_refused' &&
    HEX(32).test(stop.salt ?? '') &&
    HEX(64).test(stop.hash ?? '');
  const pauseValid = placeOk(pause?.place) && Number.isFinite(pause?.until);
  const last = Number(raw?.lastAttemptAt);
  return {
    stop: stopValid
      ? {
          place: stop.place,
          kind: stop.kind,
          salt: stop.salt,
          hash: stop.hash,
          at: Number.isFinite(stop.at) ? stop.at : 0,
        }
      : null,
    // A pause read back never lasts longer than the longest one (a clock change, a bad file).
    pause: pauseValid
      ? { place: pause.place, until: Math.min(pause.until, now + LIMITS.maxPause) }
      : null,
    // A time in the future (a clock moved back) counts as now.
    lastAttemptAt: Number.isFinite(last) && last > 0 ? Math.min(last, now) : 0,
  };
}
