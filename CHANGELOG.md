# Changelog

This project follows Semantic Versioning. While the major version is `0`, the MCP tool surface may still change between minor releases; patch releases are reserved for compatible fixes within a minor line.

## [0.11.0] - 2026-08-17

High-Trust Power Core: persistent OpenSSH reuse, complete target diagnostics, proof-preserving privilege selection, generic systemd administration, verified transactional rollback, MCP annotations, and bounded runtime health telemetry.

### Added

- managed native OpenSSH ControlMaster reuse with private short ControlPath storage, single-flight creation, bounded master count, stale recovery and `off|auto|required` policy;
- cached `target_capabilities` plus complete `target_diagnose` synthesis for transport, identity, OS/kernel, privilege, `ai-tmux`, disk pressure, failed systemd units, GPU, cache and telemetry evidence;
- Privilege Engine 2.0 with TTL/SSH-identity-bound non-secret provider preference while preserving live UID-0 proof before each privileged dispatch;
- generic systemd status/list/dependency/action/daemon-reload tools across supported unit types, including canonical `\xHH` unit-name escape handling;
- `admin_transaction` for one bounded reversible systemd/file mutation with precheck, health gates, optimistic SHA-256 restore and verified rollback;
- explicit four-boolean MCP annotation policy for all 49 canonical extension tools and three deprecated extension aliases;
- payload-free `terminal_health.runtime` summaries for telemetry, multiplex state, capability cache and privilege cache.
- source-artifact release-integrity validation that rejects a source archive when its committed package version, changelog or release notes do not match the requested artifact version.
- a dependency-free localhost HTTP/SSE guard that rejects non-local Host/Origin values before forwarding to the internal extension backend.

### Changed

- repeated structured remote execution shares one production multiplex/capability/telemetry runtime instead of rebuilding transport knowledge per call;
- generic systemd behavior is the canonical implementation behind compatible legacy service operations;
- diagnostics distinguish unavailable, not-applicable, permission-limited and actual probe failure instead of collapsing those states;
- release/live tests now include disposable Plan A/B/C source acceptance in addition to the existing deployed 15-phase restart/failure-injection suite.
- state-store instances sharing the same path/fs backend now share one coordinator/cache/update queue, preventing stale cached module state from overwriting sessions/tasks/forwards written by another module.

### Compatibility

- public endpoint, OAuth scope and upstream `pty-mcp` passthrough semantics are unchanged; localhost transport is now `9031 guard -> 9032 extension`, with the OAuth gateway on `9022` still targeting `9031`;
- deprecated `ssh_exec`, `ssh_ensure_session` and `ssh_read_session` aliases remain available;
- MCP annotations are advisory only; validation, privilege allowlists, host-key verification and secret-safe prompt boundaries remain authoritative;
- ambiguous mutation transport loss is still never automatically replayed.

### Verified

- 327 deterministic tests, `SOURCE_CHECK_OK (110 files)`, 93-package third-party license inventory and zero production dependency vulnerabilities;
- real `taylan` Plan A/B/C source acceptance including stale ControlMaster recovery, `docker_host_root`, verified transactional rollback, 52 annotated extension-owned tools, complete target diagnostics, disposable cleanup and zero lifecycle growth;
- official MCP Conformance 0.1.16 black-box PASS for `server-initialize`, `ping`, `tools-list`, and `dns-rebinding-protection` after the localhost guard was introduced;
- official MCP Inspector 2.2.0 black-box PASS for production `tools/list` and `terminal_health`;
- deployed 0.10.0 baseline remained healthy behind the guarded transport before the 0.11 runtime deployment phase;
- deployed 0.11.0 passed the full 15-phase restart/failure-injection acceptance, including preservation of named-session remote identity across extension restart;
- official MCP Conformance was rerun after deployment and passed initialize, ping, tools/list, DNS rebinding (`2/2`) and multiple SSE streams (`2/2`) with no failures/warnings in those applicable scenarios;
- official MCP Inspector observed 68 tools, 52 annotated extension-owned tools, 0.11.0 health, zero active lifecycle objects and zero remote sessions;
- eight consecutive black-box health/diagnose burn-in iterations completed with no lifecycle growth and no multiplex fallback;
- 0.10.0 is retained as the production rollback runtime.

## [0.10.0] - 2026-08-17

High-trust administration and hot-path performance audit.

### Changed

- administrative process/service mutations now default to `privilege:auto`, escalating through the existing root provider only after an observed privilege denial; explicit `user` and `root` modes remain available;
- root policy accepts `PTEXT_ROOT_TARGETS=*` for installations where all explicitly requested configured OpenSSH targets are intentionally administrable;
- `process_signal` accepts signal `0` as a non-delivering existence/permission probe;
- ordinary `remote_exec` no longer pays for a redundant `ssh -G` subprocess before each real SSH command;
- the structured remote-filesystem Python helper is content-addressed and cached per target instead of being probed and retransmitted on every filesystem operation;
- lifecycle state is cached in-process after the initial disk read while retaining atomic persisted updates.

### Verified

- complete deterministic quality gate and license inventory;
- direct live source-path execution against the `taylan` target;
- deployed extension `tools/list` reports the new privilege/signal schemas and live signal-0 auto escalation selects `docker_host_root` without delivering a signal.

## [0.9.0] - 2026-08-17

First stable pre-1.0 release.

### Added

- persistent PTY sessions backed by upstream `pty-mcp` and remote `ai-tmux`;
- structured OpenSSH execution, remote filesystem operations, patch/search helpers, upload/download, resumable rsync, and SHA-256 verification;
- managed local, remote, and SOCKS forwards with persistent lifecycle state;
- persistent long-running task start/status/output/wait/cancel/recovery;
- explicit best-effort root execution with already-root, passwordless sudo, Docker host-root, secret-safe sudo password, and secret-safe `su - root` providers;
- normalized system, process, service, journal, disk, port, and NVIDIA GPU helpers;
- bounded diagnostics, redaction, rotating JSONL operational logs, terminal health, single-flight reconnect/backoff, and watchdog-oriented failure-domain separation;
- release artifact verification, clean-install smoke, CycloneDX SBOM, and SHA-256 release checksums.

### Compatibility

- canonical tools use `remote_*`, `ensure_session` / `named_session_*`, `task_*`, `forward_*`, system/service/process names, and `terminal_health`;
- `ssh_exec`, `ssh_ensure_session`, and `ssh_read_session` remain deprecated compatibility aliases;
- ambiguous transport loss never replays arbitrary side-effect calls; only definitive upstream JSON-RPC `-32001 Session not found` is reconnected and retried once.

### Verified

- deterministic extension test suite and third-party license inventory;
- Linux/macOS CI on Node 22 and 24, CodeQL, dependency review, and production dependency audit;
- 15-phase live failure-injection acceptance covering execution, persistence, isolation, filesystem, transfer/resume/sync, forwards, tasks, extension/gateway restart survival, root UID 0, redaction, and reconnect-storm prevention.

