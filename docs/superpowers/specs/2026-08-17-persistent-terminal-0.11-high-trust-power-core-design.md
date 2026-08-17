# Persistent Terminal MCP 0.11 — High-Trust Power Core Design

## Status

Approved design direction for the next Persistent Terminal MCP minor release. Implementation starts only after the written spec checkpoint is recorded in the project tracker.

This design treats the MCP as a high-trust remote-administration system. The goal is maximum legitimate operator capability without weakening target identity, secret isolation, rollback, auditability, or failure-domain boundaries.

## Product principle

The governing rule is:

> Make the highest useful privilege reachable, but make every privileged transition observable, attributable to one target, and recoverable when practical.

Consequences:

- capability must not be removed merely because it is powerful;
- ordinary user execution remains preferred when it is sufficient;
- privilege escalation must be automatic when the operation demonstrably requires it and policy permits it;
- explicit `user` and explicit `root` modes remain available;
- host-key verification, secret-safe password handling, target/session/PID identity checks, atomic writes, checksum preconditions, and no-replay-after-ambiguous-side-effect rules remain mandatory correctness controls;
- destructive or privileged features should gain verification and rollback rather than being disabled.

## Release objective

Version 0.11.0 will improve the execution engine beneath the existing tool catalog and add a focused set of professional administration primitives. It is not a tool-count exercise.

The release has three tightly related workstreams:

1. **Transport and capability core** — managed SSH multiplexing, capability inventory, latency telemetry, and target diagnostics.
2. **Administrative power core** — privilege-engine improvements, generic systemd administration, and transactional administration with verification/rollback.
3. **Protocol-quality core** — MCP tool annotations and richer health/diagnostic metadata.

MCP-native task augmentation, multi-host fan-out, binary filesystem I/O, and persistent journal/tail streams remain the next release family. They are not pulled into 0.11.0 merely because adjacent implementation work makes them convenient.

## 1. Managed SSH multiplex pool

### Goal

Avoid a fresh SSH transport and authentication handshake for every non-interactive operation while preserving native OpenSSH semantics and existing aliases.

### Architecture

Add a dedicated `ssh-multiplex-manager.mjs` responsible only for connection-master lifecycle. `ssh-runner.mjs` remains responsible for executing one remote command.

Each target gets a private control socket under a process-owned directory such as:

```text
~/.local/share/persistent-terminal-extended/controlmasters/
```

Directory mode must be `0700`. Socket names must not contain raw hostnames or user-controlled path fragments; use a stable hash of normalized target identity. Any persisted metadata references the hashed identity, not secret-bearing SSH configuration.

The manager will use native OpenSSH multiplex controls and will never reimplement SSH authentication.

### Lifecycle

For a target:

1. check whether a recorded control master exists;
2. verify it with `ssh -O check` and the expected control path;
3. if healthy, reuse it;
4. if stale, remove only the verified stale socket/metadata and create a new master;
5. if master creation fails, fall back to the existing one-shot SSH path rather than making remote execution unavailable;
6. expire idle masters after a configurable TTL;
7. close only masters owned by this runtime.

### Configuration

Environment/config defaults:

```text
PTEXT_SSH_MULTIPLEX=auto
PTEXT_SSH_CONTROL_PERSIST_SECONDS=300
PTEXT_SSH_CONTROL_MAX_TARGETS=32
```

Modes:

- `off`: preserve one-shot behavior;
- `auto`: use multiplex when supported, fall back safely;
- `required`: fail the request if multiplex cannot be established.

`auto` is the production default.

### Health and metrics

Expose only bounded metadata:

- active master count;
- target-local multiplex state: `hit`, `miss`, `fallback`, `stale_recovered`;
- control-master age and idle age;
- aggregate hit/miss/fallback counters.

Do not expose control socket paths through public MCP results unless needed for local diagnostics.

## 2. Capability inventory cache

### Goal

Stop repeatedly probing the same remote capabilities and make privilege/feature selection deterministic.

### Inventory

Per target, detect and normalize:

- shell/user identity and UID;
- `sudo` availability and passwordless capability;
- Docker CLI availability and host-root proof capability;
- `su` availability;
- `python3`;
- `rsync`;
- `systemctl` / systemd availability;
- `journalctl`;
- `ss`;
- `nvidia-smi`;
- common network diagnostics such as `curl`, `openssl`, `dig/getent`, `ip`, `traceroute/mtr` when present;
- ai-tmux compatibility where applicable.

### Cache semantics

Use a short TTL, default 120 seconds. Cache entries are invalidated when:

- the target's normalized SSH identity changes;
- transport reconnect reveals a different remote host key/identity boundary;
- an administrative action explicitly requests refresh;
- TTL expires.

Capability absence is cached as a valid result, not treated as an error.

### Interface

Add a read-only canonical tool:

```text
target_capabilities
```

Inputs:

```text
target
refresh=false
```

Output contains normalized booleans/versions and root-provider availability, never passwords, keys, raw environment dumps, or command payloads.

## 3. Privilege Engine 2.0

### Goal

Make root access fast and predictable without weakening the existing secret-safe provider chain.

### Provider model

Keep the provider order as a policy preference, not a hard-coded assumption:

```text
direct_root
sudo_nopasswd
docker_host_root
sudo_password
su_root_password
```

The capability inventory can skip providers already known to be unavailable during the current TTL.

Successful non-secret provider selection may be cached per target for the capability TTL. A cached provider must still perform a cheap proof before executing a privileged mutation.

Password-based providers are never automatically invoked unless the operation has already reached a confirmed privilege requirement and the PTY reports an active secret prompt.

### Privilege modes

For administrative mutation tools:

- `auto` — default; try user mode first where meaningful, escalate only on a classified privilege denial;
- `user` — strict no-escalation;
- `root` — use the root engine immediately.

For operations that are inherently root-only, the tool may omit the user attempt but must still expose the requested/actual privilege in its result.

### Error classification

Privilege escalation may occur only for a closed set of privilege-denial evidence. Ordinary application errors, missing units, invalid PIDs, malformed config, or remote command failures must not trigger root retry.

## 4. Generic systemd administration

### Goal

Replace the `.service`-only management boundary with a generic systemd unit API.

### Read-only tools

Add:

```text
systemd_unit_status
systemd_unit_list
systemd_unit_dependencies
```

Supported unit suffixes include:

```text
.service .socket .timer .path .mount .automount .target .slice .scope
```

### Mutation tool

Add one canonical action tool:

```text
systemd_unit_action
```

Actions:

```text
start
stop
restart
reload
try-restart
reload-or-restart
enable
disable
reenable
mask
unmask
reset-failed
```

Additional host-level action:

```text
systemd_daemon_reload
```

All actions use validated exact unit names carried as structured data/environment values rather than interpolated shell source.

Existing `service_start`, `service_stop`, `service_restart`, and `service_status` remain compatibility-oriented canonical tools for now and route to the same core implementation where semantics match.

## 5. Transactional administration

### Goal

Increase practical administrative power by making risky configuration/service changes verifiable and reversible rather than blocked.

### Tool

Add:

```text
admin_transaction
```

This is a structured orchestration primitive, not an arbitrary shell macro language.

### Supported transaction shape

The first 0.11 implementation supports a bounded workflow:

1. optional precheck command;
2. optional file backup/snapshot for explicitly named paths;
3. one mutation step using an existing canonical admin primitive;
4. one or more health checks;
5. success commit or automatic rollback.

The transaction result records:

- target;
- transaction ID;
- requested and actual privilege;
- backup paths/identifiers, without file contents;
- mutation result;
- health-gate results;
- whether rollback ran and whether rollback succeeded.

### Scope constraints

0.11 does not introduce a general remote transaction DSL. Supported mutation types are explicitly enumerated, initially systemd action plus atomic remote-file replacement/patch where rollback material is available.

Rollback is best-effort but must never be reported as successful without verification.

## 6. Tool latency telemetry

### Goal

Measure where time is spent without logging user payloads.

Track bounded aggregate timing for:

- local queue/wait;
- SSH master acquisition;
- SSH handshake when no master exists;
- remote execution;
- result parsing;
- filesystem-helper install/cache hit;
- root-provider selection/proof;
- transfer process runtime.

Expose counts, moving averages, and coarse percentile buckets rather than unbounded per-call history.

Diagnostics must not record command text, stdin, file contents, secret prompts, credentials, or arbitrary environment values.

## 7. Target diagnose

### Goal

Provide one professional bounded diagnostic report before high-impact maintenance.

Add:

```text
target_diagnose
```

The tool combines, without mutating the target:

- OpenSSH alias resolution summary;
- connectivity/auth result;
- multiplex state;
- remote OS/kernel/user identity;
- capability inventory;
- available root providers, without invoking a password dialog;
- ai-tmux status/version;
- disk pressure summary;
- failed systemd unit count;
- optional GPU capability;
- extension-side latency/cache counters relevant to that target.

It must clearly distinguish `unavailable`, `not_applicable`, `permission_limited`, and actual failures.

## 8. MCP tool annotations

### Goal

Make the 60+ tool surface easier for MCP clients to reason about without treating annotations as authorization.

Every local tool will receive appropriate MCP annotations:

- `readOnlyHint`;
- `destructiveHint`;
- `idempotentHint`;
- `openWorldHint`.

Upstream pty-mcp tools are not rewritten unless the upstream schema already provides annotations; passthrough fidelity remains a compatibility requirement.

Annotation policy examples:

- `system_info`, `remote_stat`, `target_diagnose`: read-only;
- `remote_write`, `remote_patch`, `systemd_unit_action`: potentially destructive;
- `service_restart` / restart-class actions: not assumed idempotent for safety metadata even if repeated execution is often operationally equivalent;
- network/open-world operations: `openWorldHint=true` where applicable.

Annotations are advisory metadata only. Runtime validation, privilege policy, and target checks remain authoritative.

## 9. Failure behavior and fallback

The existing failure-domain rules remain binding:

- multiplex failure in `auto` mode falls back to one-shot SSH;
- capability-cache corruption/parse failure falls back to fresh probes;
- telemetry failure never becomes an execution failure;
- root-provider cache failure falls back to the full provider chain;
- admin transaction rollback failure is surfaced prominently and does not get hidden by the original mutation error;
- no ambiguous side-effect replay is introduced;
- persistent ai-tmux sessions/tasks remain independent of extension restart.

## 10. Testing strategy

Every subsystem follows TDD and requires negative/error-path tests.

### Deterministic unit/integration gates

Required coverage includes:

- multiplex hit, miss, stale socket, fallback, required-mode failure, ownership checks;
- concurrent calls share one master-creation promise;
- capability TTL, refresh, invalidation, and absent-capability caching;
- privilege provider cache/proof and no-escalation on ordinary failures;
- generic unit-name validation and every systemd action mapping;
- transaction success, failed health gate, successful rollback, failed rollback, and no false-success reporting;
- tool annotations for every local tool;
- telemetry redaction and bounded memory;
- target diagnose partial-capability behavior.

### Live `taylan` acceptance

The live acceptance extension will verify at minimum:

1. first remote command establishes or observes a master;
2. subsequent commands reuse it;
3. forced master termination is recovered without affecting ai-tmux sessions;
4. `target_capabilities` reports the real host consistently;
5. `target_diagnose` completes without mutation;
6. signal-0 / safe privilege probe still reaches UID 0 through the selected root provider when needed;
7. a disposable systemd test unit can be created, acted upon, verified, and removed;
8. a deliberately failed health gate triggers verified rollback on a disposable config/test service;
9. extension restart preserves persistent task/session state;
10. final lifecycle state contains no leaked test sessions/tasks/forwards/control masters beyond configured idle policy.

Production services are never used as destructive test fixtures.

## 11. Deployment and release

0.11 keeps the existing deployment topology:

```text
ChatGPT
 -> public OAuth gateway :9022
 -> Persistent Terminal Extended :9031
 -> upstream pty-mcp :9021
 -> native OpenSSH / ai-tmux
```

Rollout sequence:

1. complete deterministic quality gates;
2. run disposable live acceptance on `taylan`;
3. build/reuse rollback runtime;
4. deploy only the extension failure domain;
5. functional `initialize -> tools/list -> representative calls` probe;
6. restart gateway only if schema refresh is needed;
7. verify public identity/scope unchanged;
8. burn-in and final leak check;
9. update public standalone repository once the full 0.11 milestone is complete.

No force push or moving an existing release tag.

## 12. Implementation decomposition

This design is intentionally implemented as three independently reviewable plans. No plan may silently expand into the next plan's scope.

### Plan A — Transport and capability core

- managed SSH multiplex pool;
- capability inventory cache;
- telemetry foundations;
- `target_capabilities`;
- `target_diagnose` transport/capability portions.

### Plan B — Administrative power core

- Privilege Engine 2.0;
- generic systemd administration;
- transactional administration;
- disposable live systemd/rollback acceptance.

### Plan C — Protocol-quality and release integration

- MCP annotations;
- complete `target_diagnose` synthesis;
- health/telemetry integration;
- full regression/live acceptance;
- 0.11 versioning, deployment, public-repo update, and release documentation.

Each plan must leave the system working and independently testable before the next begins.

## Success criteria

0.11.0 is complete only when:

- normal repeated remote commands measurably use multiplex reuse when supported;
- disabling multiplex restores the previous semantics;
- root-capable admin work no longer requires unnecessary manual privilege selection;
- all common systemd unit types can be inspected and controlled through validated structured tools;
- supported risky admin workflows can use verified rollback;
- target capability/diagnostic data is available without leaking secrets;
- tool annotations describe the actual behavioral surface;
- all deterministic gates pass;
- disposable live acceptance passes on `taylan`;
- extension/upstream/gateway are healthy after deployment;
- persistent sessions/tasks remain intact across extension restart;
- final test cleanup has no unintended active sessions, tasks, forwards, or test control masters.

