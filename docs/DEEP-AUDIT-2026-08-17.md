# Deep audit — 2026-08-17

This audit treats Persistent Terminal MCP as a high-trust remote administration system. The goal is not to weaken correctness controls; it is to remove restrictions and repeated work that do not materially protect operator intent.

## Changes implemented

### Capability without unnecessary privilege friction

- `PTEXT_ROOT_TARGETS=*` now enables root acquisition for every explicitly requested configured OpenSSH target. Exact-alias policies remain supported.
- Controlled process/service mutations now default to `privilege:auto`. They run as the configured user first and retry through the root provider only when the first result is classified as a privilege denial.
- `privilege:user` remains a strict no-escalation mode. `privilege:root` remains an immediate privileged mode.
- `process_signal` accepts signal `0` as a non-delivering PID existence/permission probe, making capability checks possible without sending a real signal.
- Host-key verification, secret isolation, stale-session/PID identity checks, atomic file replacement, checksum preconditions and no-replay-after-ambiguous-side-effect rules remain intact because they protect correctness rather than merely restricting capability.

### Hot-path performance

- Ordinary `remote_exec` no longer launches `ssh -G` before the real SSH process. OpenSSH aliases are passed directly to `ssh`, which already resolves their configuration.
- The remote filesystem Python helper is now installed once per target/content hash under the remote user cache and reused. Concurrent first-use calls share one installation promise.
- The local helper source is memoized after its first read.
- Persistent lifecycle state is held in memory after the first disk read while updates continue to use atomic write/rename semantics.

## Restrictions that should become richer APIs, not simply disappear

- Remote filesystem read/write/patch is UTF-8-text-only. Add binary-safe ranged/chunked I/O instead of making the text API ambiguous.
- `remote_find` / `remote_grep`, process lists and journal reads have hard result caps. Replace large one-shot responses with cursor pagination/streaming before substantially raising limits.
- Systemd mutation tools currently target `.service` units only. Add a generic unit API for socket/timer/path/mount/target units and operations such as reload, enable, disable, mask, unmask and daemon-reload.
- Every non-interactive command still creates a new SSH transport unless the operator's OpenSSH config already multiplexes it. A managed ControlMaster/ControlPersist pool is the next major latency reduction.

## Niche feature backlog

### P0 — high leverage

1. **MCP-native Tasks adapter** — expose the existing persistent task engine through the protocol's task-augmented tool calls, task list/get/cancel semantics, status notifications and progress tokens while retaining ai-tmux recovery underneath.
2. **Managed SSH multiplex pool** — private ControlPath directory, ControlMaster/ControlPersist lifecycle, `ssh -O check/conninfo/channels`, idle expiry and per-target health metrics.
3. **Multi-host fan-out** — one structured request over a target set with bounded concurrency, fail-fast/quorum modes, per-host results and a persistent aggregate task for long jobs.
4. **Generic systemd administration** — all common unit types plus reload/enable/disable/mask/unmask/daemon-reload and optional post-action health verification.
5. **Capability inventory cache** — target-local versions/availability for python3, rsync, sudo, docker, systemd, nvidia-smi and common diagnostics, invalidated on transport identity or TTL.

### P1 — specialist administration

6. **Lease-based forwards** — TTL/renewal, reconnect policy, local/remote TCP plus Unix-domain socket forwarding, and explicit forward ownership.
7. **Structured network diagnostics** — DNS resolution, TCP connect timing, TLS certificate inspection, HTTP probes, routes, neighbors and bounded traceroute/mtr when present.
8. **Binary filesystem layer** — ranged reads, binary writes/uploads, chmod/chown, ACL/xattr, symlink/hardlink, recursive hash manifests and structured diffs.
9. **Journal/tail streams** — persistent cursor-based `journal_follow` / file tail tasks that survive client reconnects without flooding MCP context.
10. **Transactional admin actions** — optional pre-change snapshot/backup, mutation, health gate and automatic rollback for service/config workflows.

### P2 — observability and ergonomics

11. **Tool latency telemetry** — distinguish local queueing, SSH handshake, remote execution, transfer and parsing time; expose cache/multiplex hit ratios without payload data.
12. **Target diagnose** — one bounded report for SSH resolution, reachable auth path, ai-tmux compatibility, available root providers and core remote capabilities.
13. **MCP tool annotations** — publish read-only/destructive/idempotent/open-world hints so clients can reason more accurately about operations.
14. **Task groups / DAGs** — dependency-aware remote jobs with bounded concurrency, cancellation propagation and restart/resume policies.

## Verification

The implementation changes are covered by focused regression tests plus the complete source/test/license quality gate. The audit is not considered deployed until the production extension is rebuilt/restarted and live acceptance exercises the changed paths.
