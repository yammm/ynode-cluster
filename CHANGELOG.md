# Changelog

All notable changes to this project will be documented in this file.

## 1.3.0 - 2026-03-06

### Added

- Cluster manager lifecycle event API: `on`, `once`, `off`.
- New manager events: `worker_online`, `worker_exit`, `worker_restart_scheduled`, `worker_listening`, `scale_up`,
  `scale_down`, `reload_start`, `reload_end`, `reload_fail`, `shutdown_start`, `shutdown_end`.
- Programmatic graceful shutdown API: `manager.close()`.
- New reload timing options:
    - `reloadOnlineTimeout`
    - `reloadListeningTimeout`
    - `reloadDisconnectWait`
- New feature coverage tests for reload deduplication and feature behavior.
- CI workflow for lint and test across multiple Node.js versions.

### Changed

- `reload()` now deduplicates concurrent calls and shares one in-flight promise.
- Reload and shutdown behavior was hardened for failure and race handling.
- Cluster config parsing/validation and worker orchestration internals were refactored for clarity.
- Metrics now report `uptime` from worker start time, and memory scale-up averaging uses only workers with memory
  samples.
- Published package now includes `index.d.ts`.

### Fixed

- Prevented master crashes from worker IPC send race conditions.
- Removed publish-time test bypass (`prepublishOnly` now strictly runs tests).
- Added bounded backoff for repeated worker crash loops.
- Improved zero-downtime reload readiness gating.
- Stabilized integration tests in sandbox-constrained environments.
- Added validation for invalid `mode` and invalid reload timeout options.
