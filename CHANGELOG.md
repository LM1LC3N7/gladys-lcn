# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [0.1.1] - 2026-10-23

### Added

- LCN through LCN-PCHK: login (user name and password), decimal and
  operation modes, keep-alive ping, scan of the segment couplers and of the
  modules with their serial number, firmware, type and name (ported from
  pypck).
- One device per module; "Ports" chooses its features: outputs and relays
  read only by default (lights or switches only when declared), binary
  sensors (input, motion), variables (temperature, humidity, illuminance,
  CO2, raw value), regulator set points (read only).
- "Turn on" / "turn off" buttons of the read-only outputs and relays, off by
  default; a "turn off" cancels a "turn on" of the same port still waiting.
- Commands confirmed by a status equal to the value asked, else "sent,
  without confirmation" and a read back; never written after 3.5 s.
- Scene trigger: keys sent to the host. Scene action: activate an LCN scene,
  off by default.
- A login refused by PCHK stops the connection, persisted with a salted
  fingerprint of the refused credentials; a licence error pauses, persisted;
  attempts spaced, a restart included; "Test the connection".
- Documentation in English and French.

### Security

- A "turn off" has its own queue, before every other command and every read:
  a "turn everything off" of 40 lights is written within the deadline; it
  also cancels a waiting LCN scene of the same module. The reads after a
  command go in the background, merged.
- A session closed by PCHK right after the password, twice in a row, stops
  the connection like a refused login (persisted).
- LCN scenes and commands only reach a module of this integration with a
  valid address (segment 0 or 5-127, module 5-254): never PCHK nor a
  broadcast; the scan ignores the other addresses.
- Credentials holding a line break are never sent; the test button respects
  the licence pause; a new configuration keeps the spacing of the attempts.

### Changed

- Set points are temperature sensors (read only), not thermostats; the
  illuminance is capped to its declared maximum; catalog categories
  "lighting" and "protocols".

[Unreleased]: https://github.com/LM1LC3N7/gladys-lcn/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/LM1LC3N7/gladys-lcn/releases/tag/v0.1.1
