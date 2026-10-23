# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

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

[Unreleased]: https://github.com/LM1LC3N7/gladys-lcn/commits/main
