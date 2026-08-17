# Changelog

This project follows Semantic Versioning. While the major version is `0`, the MCP tool surface may still change between minor releases; patch releases are reserved for compatible fixes within a minor line.

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

