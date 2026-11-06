# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.3] - 2026-11-06

### Added

- README demo screenshots: the standalone `/plugin-sync` panel and the
  `Settings → Plugins sync` page (per-capability switches, schedule options).

## [0.1.2] - 2026-11-06

### Fixed

- The settings page never showed the real capability state: `statePayload()`
  exposed capabilities only as `config.capabilities`, while the toggles read
  flat `config.cap*` keys, so every switch rendered unchecked even when it was
  on. The payload now carries both shapes and the client falls back through
  draft → nested → flat.
- Unsaved changes are now marked per toggle, and the status card shows when the
  settings were last saved.

### Changed

- `intervalMinutes` is a `Periodic sync` toggle plus a minutes field instead of
  a bare `0 = off` number box; the master switch now says explicitly that it
  stops both automatic and manual syncs.

## [0.1.1] - 2026-11-06

### Added

- Version row in the status card and the panel, so both machines can be
  compared at a glance.

## [0.1.0] - 2026-11-06

First public release.

### Added

- Cross-machine sync of installed bundles, enabled/disabled state, per-row
  config in `cordis.patch.yml`, and `file:` plugin source directories.
- Two transports: direct HTTP, or an on-demand `ssh -N -L` tunnel when the peer
  only listens on loopback.
- Six independent capabilities (`capPlugins`, `capConfig`, `capInstall`,
  `capFiles`, `capRemoteApply`, `capSecrets`), all off except the first and the
  remote-apply switch.
- Settings page (`Settings → Plugins sync`), standalone panel at
  `/plugin-sync`, and agent tools `plugin_sync` / `plugin_sync_config`.
