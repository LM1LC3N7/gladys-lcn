# LCN for Gladys Assistant

External integration for [Gladys Assistant](https://gladysassistant.com):
**LCN** building automation (Germany, Austria, Switzerland), **locally**
through **LCN-PCHK**, the coupler software of LCN.

> **Never tested with a real installation.** Unofficial, not affiliated with
> LCN.

- Login to PCHK, scan of the segment couplers and of the modules, with their
  serial number, firmware, type and name.
- One device per module. Outputs and relays: **read only by default**, lights
  or switches only when declared in "Ports"; their "turn on" / "turn off"
  buttons are **off by default**. Binary sensors (input, motion), variables
  (temperature, humidity, illuminance, CO2, raw value), regulator set points
  (read only).
- Keys sent to the host: a scene trigger. LCN scenes: a scene action, **off
  by default**.
- One connection, spaced reconnections, a keep-alive ping; a refused login
  stops the connection (persisted, never a loop); the password is a secret
  field, never logged.

User guides: [français](docs/fr.md), [English](docs/en.md).

## Development

```bash
npm install
npm test               # node --test (Node 22 and 24), against an in-memory PCHK
npm run lint
npm run format:check
npm run audit          # npm audit --omit=dev
npx github:GladysAssistant/integration-store .
```

Layout: `src/lcn/` (PCK lines, line reader, connection), `src/app.js`
(model, devices, states, scene events, commands), `src/devices.js`,
`src/publisher.js` (rate limits), `test/helpers/fakePchk.js` (the simulated
PCHK and bus, and a virtual clock). See `CLAUDE.md` and `TODO.md`.

## Credits and licence

Apache-2.0 (`LICENSE`). The protocol is ported from
[pypck](https://github.com/alengwenus/pypck) by Andre Lengwenus (MIT): see
`THIRD_PARTY_NOTICES.md`.
