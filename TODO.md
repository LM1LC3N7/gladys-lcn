# TODO - LCN v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `npm run format:check`, `npm run lint`, `npm test`
  (Node 22 and 24), `npm run audit`, `npx github:GladysAssistant/integration-store .`,
  then update README, `docs/fr.md`, `docs/en.md`, `CHANGELOG.md` and this file.
- No forum topic of its own, no forum post from a module session: lot 14 was
  claimed in /t/10385; the main session posts one recap per wave.
- The `gladys-assistant-integration` topic is added at the first real release only.

## Status

- [x] **Milestone 1 - core** (2026-10-23): own TCP client on `node:net`
      ported from pypck (login, decimal and operation modes, ping, segment
      couplers, module scan, serials, names), outputs, relays, binary
      sensors, variables, set points; one device per module, ports chosen in
      "Ports"; commands confirmed by the status; keys sent to the host as a
      scene trigger; LCN scenes as a scene action. Tested against an
      in-memory PCHK only. The store validator could not be run from the
      development agent: run it before publishing. No end-to-end test in a
      container (no Docker on the development PC).
- [ ] **Milestone 2 - real installation**: run against a real LCN-PCHK;
      capture real lines (anonymised) as fixtures; fix what differs (see
      below).
- [ ] **Milestone 3 - more**: covers (motors on relays, BS4 and module
      positioning), set points from Gladys (opt-in, bounded, decided on a
      fresh read), thresholds, LEDs and logic operations, key locks, regulator
      locks, S0 counters (energy index: take the approved guard of
      gladys-p1-monitor), an opening-sensor kind for the binary sensors (check
      the Gladys meaning of 0 / 1 first), a cache of the scan in `/data`.
- [ ] **Milestone 4 - first release**: Docker image check, Release workflow,
      topic, GHCR package public.

## To check on a real installation

- The login prompts and texts of the PCHK versions in use ("Username:",
  "Password:", "OK", "Authentification failed."), and what PCHK does after a
  refusal (here: stopped at the first refusal or second prompt).
- That `!OM1P` / `!OM0P` is accepted silently, and the status lines in percent.
- That every module answers `>G000003!LEER` with an acknowledgement (the
  scan), and how long a large bus takes (3 broadcasts, 3 s after the last
  answer).
- That a module answers `SMA3` / `SMA4`, `SMR`, `SMB` when the port is not
  wired (A1 and A2 are shown by default, read only).
- That a dim command with ramp 0 brings the status of the output at once, and
  a relay command the relay byte (the confirmation); otherwise every command
  shows "sent, without confirmation".
- The typeless answers of the modules before 170206 (`%M000007.01200`) and
  that no other line comes between the request and the answer.
- The names (`NMN1`, `NMN2`): 10 or 12 characters per block, padding, encoding.
- Segment couplers: the answer to `>G003003.SK` and the addresses of the
  modules of the other segments.
- PCHK's own keep-alive (it closes after 10 minutes without a line): the ping
  every 4 minutes is answered `^ping<n>-`.

## Decisions

- **Version 0.1.0, set by hand once**: the template ships 1.0.0; the sibling
  modules start at 0.1.x, so `package.json`, `package-lock.json`, the
  manifest `version` and the `docker_image` tag
  (`ghcr.io/lm1lc3n7/gladys-lcn:0.1.0`) were set together to 0.1.0 in
  milestone 1, before any release. Every later version comes from
  Actions -> Release (the first patch release gives 0.1.1). The manifest test
  checks that they agree, never a fixed version.
- **Reference**: pypck (MIT, Andre Lengwenus, the library of Home Assistant's
  LCN integration), read at commit `01c95c9` (0.9.15a3, main after 0.9.14);
  its `LICENSE` is MIT without a copyright line, the author comes from
  `pyproject.toml`. Ported, not copied; credited in `THIRD_PARTY_NOTICES.md`,
  shipped in the image with `LICENSE`. Runtime dependency: the SDK only.
- **Neighbours**: LM1LC3N7/gladys-velbus (structure: TCP client, queues,
  waiters, publisher, fake bus, virtual clock) and gladys-qbus (outputs read
  only unless declared safe, gated buttons). Read only, nothing changed in
  them.
- **LCN-PCHK only**, plain TCP (its protocol has no TLS): the password is a
  secret field, sent only to PCHK, never logged, never stored; the docs say
  PCHK receives it in clear text on the network.
- **Login refused** ("Authentification failed.", a second user name or
  password prompt): final, the client stops by itself; persisted in
  `/data/lcn-state.json` as the place and a salted SHA-256 fingerprint of the
  refused user name and password (never of credentials that worked); the
  same credentials are never sent again, even after a restart; other
  credentials are tried; "Test the connection" makes one try (spaced 10 s
  from the last), and only a successful login erases the stop.
- **Licence error** (`$err:(license?)`): a pause of 5 min, 15 min, 30 min,
  1 h, persisted (end read back capped to 6 h); not final.
- **Spacing**: reconnections 10 s, 30 s, 1 min, 2 min, then 5 min; the time
  of the last attempt goes to `/data` (at most once a minute, before the
  attempt) and a restart waits for the spacing; a full read of the states at
  most once a minute (a reconnection included), one read at a time; "Scan"
  scans the bus at most once a minute, else only sends the devices again; a
  configuration saved unchanged reads nothing; a reconnection to Gladys sends
  the status, the Discovery and the states again, without touching PCHK.
- **Late answers**: the client drops every line and timer of an older
  session (generation); the app checks its epoch before each status, so an
  answer of an old configuration publishes nothing.
- **Identity**: device `module:<segment>-<module>` (logical segment, the
  local one always 0, with or without a segment coupler, so the ids never
  move when a coupler is added), features `<port>_<role>`. The address is
  what LCN-PRO programs and what every module answers to (there is no DHCP
  on the bus). The serial number is shown in the params; a different serial
  at the same address is logged (a replaced module) and keeps the device.
- **Outputs and relays read only by default** (Louis's rule, as Qbus): a
  read-only state (and level), plus "turn on" / "turn off" push buttons gated
  by `allow_output_buttons` (off); only a port declared `light` or `switch`
  in "Ports" becomes a light (with brightness for an output) or a switch. A
  feature created under another kind is kept (never a lost feature), keeps
  its state, and its commands are refused ("not declared as such").
- **Default ports**: a module not listed in "Ports" shows A1 and A2, read
  only (the bus does not say which ports are wired); a module listed shows
  exactly its entries. Modules named in "Ports" are shown even when the scan
  missed them. 500 entries at most, wrong entries listed in the status.
- **Commands**: written within 3.5 s of the request or refused "nothing was
  sent"; a status read of the port is queued right behind; confirmed only by
  a status of that port received after the write and equal to the value
  asked (1 % for an output) until 4.5 s, else "sent, without confirmation"
  and a read back 2 s later. No acknowledgement asked from the module
  (`.` header): acks carry no id and a status equal to the value is a
  stronger proof. Ramp 0. Values validated strictly (`null`, `''` are not 0).
- **Protective commands**: a "turn off" (0 %, relay off) goes to the urgent
  queue (before every read), is never cancelled, and cancels the "turn on" of
  the same port not written yet. The gated "turn off" button stays behind the
  option too (as Qbus): the load of an undeclared port is unknown, an "off"
  may harm too (a freezer).
- **Option checked twice**: on arrival and in the client right before the
  socket write (`check`); a command withdrawn there is "nothing was sent".
- **Ack independent of the publication**: the command resolves on the status
  waiter of the client, never on `publishStates`.
- **LCN scenes**: scene action `activate_scene` (`SZW` register, then `SZA7`
  for the outputs and / or `SZA0…11111111` for the relays), gated by
  `allow_scenes` (off), checked before each line; no confirmation possible
  (written = done); "register changed, scene not sent" when only the first
  line left.
- **Variables**: firmware 170206 and later: `MWT<n>` / `MWS<n>`, typed
  answers, also sent by the modules on big changes (read every 10 min);
  older modules: `MWV`, `MWTA`, `MWTB`, `MWSA`, `MWSB`, one question at a
  time per module (the answer has no type), read every minute; VAR4-VAR12
  do not exist there. Special values (no value 0xFFFF, undefined 0x81xx,
  defective 0x7Fxx) and out-of-range values are never published. Set points:
  bit 15 (locked) dropped. Units of the core only: celsius, percent, lux,
  ppm; none for a raw value.
- **Keys sent to the host** (`$M…STH` / `+M004…STH`): scene trigger `key`
  with `module` (`M5`, `S12M5`: compared as written by the core), `table`,
  `key`, `action` (`hit`, `make`, `break`); 120 events a minute, the rest
  dropped with one log line a minute; no device. Never undefined nor NaN.
- **Parsing**: lines of 512 bytes at most (a longer one is skipped whole,
  never buffered), control characters dropped, UTF-8 or Latin-1; every
  pattern anchored and bounded; Maps only.
- **Budget**: 240 states a minute for the whole integration, 60 of them kept
  for the outputs, relays and sensors (measurements wait).
- **Not checked**: Docker is not installed on this PC, so no image build and
  no end-to-end test in a container; never run against a real installation;
  the store validator was not run by the development agent.
