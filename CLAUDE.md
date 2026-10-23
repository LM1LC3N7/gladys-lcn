# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration**: a Node.js service (Node 22+, ESM,
no build step) that runs in its own sandboxed Docker container and talks to
Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It started from the official JavaScript template.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/app.test.js              # one file
node --test --test-name-pattern "Ports"   # tests whose name matches
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npx github:GladysAssistant/integration-store .   # store admission checks
```

The CI (`.github/workflows/ci.yml`) runs `format:check`, `lint` and `test` on
Node 22 and 24, and builds the Docker image: run the three commands before
pushing.

## Architecture

```
index.js                SDK wiring only: handlers registered before connect()
src/handlers.js         the SDK handlers, shared with the tests
src/app.js              LcnApp: lifecycle, model, scan, reads, states, events, commands, scenes
src/lcn/pck.js          PCK lines read and written (pypck pck_commands / inputs / lcn_defs)
src/lcn/lines.js        the line reader: linear, bounded
src/lcn/client.js       one TCP connection to PCHK: login, ping, queues, waiters, scans
src/devices.js          model -> Gladys devices and states (pure)
src/publisher.js        states and scene events under the Gladys rate limits
src/store.js            /data: refused-login stop (salted fingerprint), licence pause, last attempt
src/config.js           DEFAULTS (mirror the manifest defaults), "Ports", module references
src/constants.js, src/i18n.js     keys, timings, limits; French and English texts
gladys-assistant-integration.json manifest: name, config_schema, actions, scenes, image...
docs/en.md, docs/fr.md  user documentation, re-hosted by Gladys (mandatory)
test/                   node --test, the SDK's fake Gladys + test/helpers/fakePchk.js
.github/scripts/release.mjs       release helpers (manifest bump, changelog), tested in test/
```

Safety rules of this integration (see TODO.md "Decisions"): outputs and
relays are read only unless declared `light` or `switch` in "Ports"; their
"turn on" / "turn off" buttons and the LCN scenes are off by default, checked
on arrival and right before the write; a "turn off" goes before the reads and
cancels a waiting "turn on" of the same port; a command is confirmed only by
a status equal to the value asked, received after the write; a command that
may have left is never reported "not sent"; the ack never waits for the
publication; a refused login stops the connection (persisted), never a loop;
the password is never logged nor stored; Maps only, nothing the bus sends
becomes an object key.

## Rules

- **External ids are forever.** Build them with
  `gladys.externalIds(type, platformId)`; here `module` and `<segment>-<module>`
  (the local segment is always 0), features `<port>_<role>`. Gladys keys
  devices, their history, scenes and dashboards on them: changing one creates
  a new device and orphans the old one. The same goes for every key users
  store: manifest `config_schema`, `actions`, scene keys, feature keys.
- **The container rootfs is read-only.** Write only under `/data`, the one
  writable volume. Never log tokens, passwords or API keys.
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag,
  by hand. `test/manifest.test.js` checks they agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md` (`### Added`, `Changed`, `Fixed`, `Removed`, `Security`).
  Never write a version heading: the Release workflow moves the section, and it
  becomes the notes of the GitHub Release.
- **Manifest.** Texts are multi-language objects `{ "en": ..., "fr": ... }`:
  `label`, `description` and `placeholder` alike, never a plain string. The
  catalog `description` holds 10 to 100 characters per language.
  `test/manifest.test.js` ties the manifest to the code (defaults, actions,
  scene trigger and action): change both sides together.
- **User-facing text** is bilingual (English and French): action messages,
  manifest texts, and `docs/en.md` / `docs/fr.md`, kept in sync.
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network.
