# Persistent Terminal MCP

An MCP server for remote terminal work where the shell should survive a dropped client connection.

This project started from a fairly simple problem: most SSH MCP wrappers tie the life of the shell to the life of the SSH/MCP connection. That is fine for short commands, but it gets annoying very quickly with builds, downloads, log sessions, interactive tools, or anything that should still be there after a reconnect.

Persistent Terminal MCP keeps those two things separate. Interactive sessions are backed by [`pty-mcp`](https://github.com/raychao-oao/pty-mcp) and remote `ai-tmux`; structured operations use native OpenSSH. If the local MCP process disappears, the remote PTY can stay alive and be attached again later.

Current deployed release: **0.11.0 stable pre-1.0**. The High-Trust Power Core is live behind the guarded localhost transport and has passed deterministic tests, real restart/failure-injection acceptance, official MCP Conformance, official MCP Inspector, and bounded burn-in. Major version zero is deliberate: the service is suitable for real deployment, while the public MCP tool surface is still allowed to evolve before a future `1.0.0` API freeze.

## What works now

- existing `pty-mcp` tools are exposed without maintaining a fork
- persistent remote PTYs through `ai-tmux`
- native OpenSSH configuration/aliases remain authoritative; `ssh -G` is used only when structured target identity/capability inspection needs resolved metadata
- `remote_exec` with separate stdout, stderr and exit status
- cwd, environment variables, stdin, timeouts and output limits
- transport failures kept separate from ordinary non-zero process exits
- host-key/authentication failures kept separate from reconnect failures
- atomic local state storage
- canonical named-session create/recover, list, detach and close tools
- stale local handle cleanup without killing the remote PTY
- reattach to an existing remote session before creating a replacement
- structured remote stat/list/read/write/mkdir/move/delete operations without caller-side shell quoting
- atomic UTF-8 text writes with optional SHA-256 overwrite preconditions
- deterministic exact-hunk `remote_patch` with all-hunks-before-write validation
- bounded, deterministic `remote_find` and regex `remote_grep` with binary-file skipping
- path-based `remote_upload` / `remote_download` without embedding ordinary file bytes in MCP payloads
- scp for simple copies and rsync-backed resumable transfers with bounded progress metadata
- explicit rsync-only `remote_sync` with upload/download direction, excludes, dry-run and visible delete semantics
- streaming local/remote SHA-256 verification with mismatch-specific integrity failures
- observed resume reporting when a pre-existing partial remote file is actually present
- managed native OpenSSH local (`-L`), remote (`-R`) and dynamic SOCKS (`-D`) forwards
- stable forward IDs plus optional names with healthy named-forward reuse instead of duplicate SSH processes
- forward lifecycle state persisted only after bounded startup and process-identity capture
- identity-safe close semantics that re-check the recorded process before SIGTERM and before any SIGKILL
- real local TCP and remote `ss` listener health checks rather than PID-only forward status
- persistent long-running remote tasks with stable task IDs and dedicated recorded remote PTY sessions
- canonical `task_start`, `task_status`, `task_output`, `task_wait`, `task_cancel` and `task_list` lifecycle tools
- bounded incremental task output and anchored non-spoofable completion-marker waits
- task recovery after local extension restart by reattaching only to the recorded live remote session
- explicit Ctrl-C cancellation that targets only the task PTY, with optional session termination only after bounded cancellation fails
- live proof that a running task survives an abrupt local extension process loss and completes under the original task ID without creating a duplicate remote session
- explicit `remote_root_exec` with allowlisted best-effort root acquisition: already-root SSH, passwordless sudo, Docker host-root, secret-safe interactive sudo, then secret-safe `su - root`
- root provider audit metadata showing every attempted strategy and the selected provider
- secret-safe password prompts that are opened only after the upstream PTY reports an actual password prompt; password bytes never enter ordinary tool arguments, persisted state, logs or AI context
- canonical read-only system tools: `system_info`, `process_list`, `port_list`, `service_status`, `journal_read`, `disk_usage` and `gpu_info`
- controlled `process_signal` plus `service_start`, `service_stop` and `service_restart` operations with capability-first `privilege:'auto'` plus strict `user` and immediate `root` overrides
- ordinary `remote_exec` never escalates; controlled mutations in `auto` mode retry through the audited root provider only after an observed privilege denial
- live proof on a real Ubuntu target that ordinary execution remains non-root while explicit root execution reaches UID 0 and system inspection tools return normalized data
- structural and pattern-based secret redaction for diagnostic payloads, including authorization/password/private-key markers and known prepared secrets
- bounded reconnect/failure diagnostics that store counters rather than command/session payloads
- a redaction-first JSONL logger with 10 MiB rotation and at most three rotated files
- single-flight upstream reconnect with capped exponential backoff + jitter and reset after a successful functional `tools/list`
- no replay after ambiguous upstream transport loss, avoiding duplicate side effects; the one safe exception is a definitive JSON-RPC `-32001 Session not found`, which proves the stale MCP session rejected the request and is reconnected/retried exactly once
- canonical `terminal_health` for extension/upstream/gateway health, lifecycle counts, reconnect/failure counters, optional remote-session counts and per-target `ai-tmux` compatibility
- live deployment behind the existing Persistent Terminal MCP identity with `9022 gateway -> 9031 localhost guard -> 9032 extension -> 9021 pty-mcp`
- watchdog isolation for upstream, extension and OAuth gateway as three separate failure domains
- a named 15-phase full acceptance suite covering structured exec, persistence/reuse, isolation, filesystem, transfer/resume/sync, forwards, tasks, extension/gateway restart survival, root, host-key classification, redaction and reconnect-storm prevention
- MCP output-schema checks for both successful and failed calls
- secret-related upstream tools passed through without inspecting or rewriting their result

The completed milestone map and remaining stable-release gate are tracked in [`docs/ROADMAP.md`](docs/ROADMAP.md).

## 0.11 release-candidate status — source/live gates complete, deployment not yet claimed

The 0.11.0 tree contains the transport/capability, administrative and protocol-quality **High-Trust Power Core** slices and is now deployed. Production uses `9022 gateway -> 9031 localhost guard -> 9032 extension -> 9021 pty-mcp`; 0.10.0 is retained as the rollback runtime until a later accepted deployment replaces it.

Plan A adds:

- a managed OpenSSH ControlMaster pool with `off`, `auto` and `required` modes;
- private `0700` control storage with hashed target identity and a short Unix-socket path budget;
- single-flight first connection, bounded target count, owned stale-socket recovery and one-shot fallback in `auto` mode;
- payload-free aggregate timing/counter telemetry for SSH acquisition/execution and capability-cache behavior;
- a 120-second default target capability cache that stores both present and absent capabilities, invalidates when resolved SSH identity changes, and never caches transport/probe failures;
- canonical read-only `target_capabilities` and `target_diagnose` tools;
- one production runtime transport instance shared by ordinary execution, root-provider probes, system helpers, structured remote filesystem operations and terminal-health remote probes.

A disposable live acceptance run against a configured Ubuntu target proved first master creation, connection reuse, forced stale-master recovery, capability-cache reuse and successful target diagnosis with **zero multiplex fallback**. In the final representative verification run the first harmless command took 383 ms, the immediately reused command 98 ms, and the deliberately stale-master recovery command 276 ms. Those values demonstrate that the intended paths executed; they are not presented as a general benchmark.

The live test owns a private temporary ControlPath and removes it in `finally`. A separate production `terminal_health` check after the test showed no active named sessions, tasks, forwards or remote `ai-tmux` sessions created by the acceptance run.

Plan B adds:

- a proof-preserving privilege engine that caches only a non-secret provider preference (`direct_root`, `sudo_nopasswd`, or `docker_host_root`) and still re-proves that provider before each privileged command;
- generic systemd inspection for `.service`, `.socket`, `.timer`, `.path`, `.mount`, `.automount`, `.target`, `.slice`, and `.scope` units;
- closed generic systemd mutation actions plus `systemd_daemon_reload`, while legacy service tools continue through the same core behavior;
- bounded `admin_transaction` orchestration for one reversible systemd/file mutation with precheck, 1..8 health gates, in-memory rollback material, optimistic SHA-256 restore, and post-rollback verification;
- truthful rollback failure reporting instead of masking conflicts or guessing after ambiguous transport loss.

The final Plan B disposable acceptance run on `taylan` created only a randomized `ptext-live-*.service` plus `/tmp/ptext-live-*` fixtures. It proved `inactive -> active/exited -> inactive`, `enabled -> disabled`, selected `docker_host_root`, retained one cached non-secret provider preference while re-proving UID 0, and deliberately failed an `admin_transaction` health check so the original UTF-8 file was restored and SHA-256 verified. Lifecycle counts were `sessions=0, tasks=0, forwards=0, remote_sessions=0` both before and after the run; multiplex telemetry recorded `miss=1, hit=42, fallback=0`. Those counts prove the intended paths executed and are not a performance benchmark.

Live testing also exposed a real systemd compatibility defect: Ubuntu returned an escaped unit name such as `systemd-fsck@dev-disk-by\\x2duuid-...service`, while the first generic unit grammar accepted only unescaped names. The core validator, list parser, and MCP schemas now share one closed grammar that accepts canonical systemd `\\xHH` escapes but still rejects arbitrary backslashes and shell syntax.

The Plan B deterministic checkpoint is **303/303 tests passing**, `SOURCE_CHECK_OK (103 files)`, and `THIRD_PARTY_LICENSES_OK (93 packages)`. Disposable server artifacts were verified absent after cleanup. A separate production health check still reported the deployed **0.10.0** extension healthy with zero active sessions/tasks/forwards, zero remote `ai-tmux` sessions, and zero reconnect failures.

Plan C protocol-quality work now adds an explicit annotation policy for every extension-owned tool, a complete bounded `target_diagnose`, and payload-free runtime evidence in `terminal_health`. The source catalog contains 49 canonical extension tools plus three deprecated extension aliases; each publishes exactly `readOnlyHint`, `destructiveHint`, `idempotentHint`, and `openWorldHint`, while upstream `pty-mcp` tool objects and any annotations they already carry remain untouched. These hints are protocol metadata only; validation, privilege policy, target allowlists and secret-safe escalation remain the actual enforcement boundaries.

`target_diagnose` now synthesizes transport/multiplex state, remote identity, OS/kernel/uptime, capability inventory, privilege-provider/cache state, `ai-tmux`, disk pressure, failed-systemd count, optional GPU state, capability-cache state and fixed-vocabulary telemetry. Missing optional capabilities are reported as `unavailable` or `not_applicable`; password-only root paths are `permission_limited`; independent probe failures degrade only their own section. Raw `df`/GPU/system text, command payloads, target-hash lists and ControlPath values are not returned. `terminal_health.runtime` exposes only bounded telemetry aggregates, active master count/mode, capability-cache counts and non-secret privilege-cache provider counts; snapshot failures stay isolated as `unavailable` evidence.

The final source-path Plan C4 acceptance on `taylan` proved all three 0.11 live suites in one run. Transport acceptance observed `miss=2 hit=4 stale_recovered=1 fallback=0`; administrative acceptance selected `docker_host_root`, verified transactional rollback and left no disposable unit/file; protocol acceptance found **52 extension-owned annotated tools**, Ubuntu **26.04 LTS**, kernel **7.0.0-29-generic**, zero failed systemd units, one NVIDIA GPU, available privilege/ai-tmux/disk/cache/telemetry evidence and lifecycle counts `sessions=0 tasks=0 forwards=0 remote_sessions=0` before and after. After external-validation hardening, the release passes **327/327 tests**, `SOURCE_CHECK_OK (110 files)`, `THIRD_PARTY_LICENSES_OK (93 packages)`, production dependency audit with **0 vulnerabilities**, disposable cleanup and `git diff --check`. The deployed runtime then passed **15/15** real restart/failure phases. Official MCP Conformance 0.1.16 independently passes initialize, ping, tools/list, DNS rebinding (`2/2`) and multiple SSE streams (`2/2`) against deployed 0.11.0; MCP Inspector 2.2.0 sees **68 tools**, **52 annotated extension-owned tools**, healthy 0.11.0 state, and zero active/remote sessions after cleanup. Eight black-box health/diagnose burn-in iterations completed with no lifecycle growth and no multiplex fallback.

## How it is put together

```text
MCP client
    |
    v
Persistent Terminal MCP
    |\
    | +-- native OpenSSH / scp / rsync
    |
    +---- pty-mcp ---- ai-tmux ---- persistent remote shell
```

`pty-mcp` stays upstream. This repository adds an aggregation and remote-operations layer around it instead of copying its terminal engine. That keeps terminal-session updates separate from the rest of the remote administration code.

OpenSSH remains the source of truth for host configuration. Aliases, keys, ports, `ProxyJump` and host-key policy come from the user's normal SSH configuration rather than a second SSH config format inside the MCP.

The 0.11 multiplex layer does not weaken those rules. It reuses an already authenticated native OpenSSH connection; it does not disable host-key checking or introduce a second credential store. `PTEXT_SSH_MULTIPLEX=auto` falls back to the previous one-shot SSH transport when a reusable master cannot be established, while `required` fails before the remote command starts.

## Requirements

- Node.js 22.23.1 or newer
- OpenSSH client
- Python 3 on remote hosts where structured filesystem tools are used
- `rsync` locally and remotely for `remote_sync` and resumable transfers
- `sha256sum` on remote hosts when transfer SHA-256 verification is requested
- `pty-mcp` for persistent/interactive terminal tools
- `ai-tmux` on hosts where persistent remote sessions are used

Explicit root execution can use Docker when available and allowlisted. If automatic root providers are unavailable, the PTY upstream may display a secret-safe password dialog for sudo or the root account; those secret values are never passed as ordinary MCP tool arguments.

## Running the checks

```bash
npm ci
npm run quality
```

`npm run quality` checks JavaScript syntax, runs the full test suite and verifies the checked-in third-party license inventory against `package-lock.json`.

CI runs the same checks on Linux and macOS with Node 22 and 24, plus `npm audit`, CodeQL and dependency review.

## Upstream MCP

By default the server expects `pty-mcp` at:

```text
http://127.0.0.1:9021/mcp
```

Use a different endpoint with:

```bash
export PTY_UPSTREAM_URL=http://127.0.0.1:9021/mcp
```

## A note about failure handling

A remote command returning `3` is not the same thing as SSH failing. A stale local PTY handle is not a reason to kill the remote session. A reconnect is not a reason to create a second shell.

Those distinctions are intentional and have regression tests. The recovery path checks the local handle first, then the recorded remote `ai-tmux` session, and creates a new remote session only after the old one is confirmed absent.

New integrations should use canonical names such as `remote_exec`, `ensure_session`, `task_*`, `forward_*` and the structured remote/system tools. `ssh_exec`, `ssh_ensure_session` and `ssh_read_session` exist only as deprecated compatibility aliases for older clients.

More detail is in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and [`docs/TESTING.md`](docs/TESTING.md).

## Security

This is an administration tool, so an authorized client is powerful by design. The code does not silently disable SSH host-key checking, read private-key contents, log secret payloads, or turn ordinary commands into root commands.

See [`SECURITY.md`](SECURITY.md) and [`docs/SECURITY-MODEL.md`](docs/SECURITY-MODEL.md).

## License and third-party code

The original code in this repository is Apache-2.0 licensed.

Third-party software keeps its own license. Direct dependencies and external runtime components are listed in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md); the complete locked npm dependency inventory is in [`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md).

No `pty-mcp` or `ai-tmux` source file is vendored here at the moment. They are used as external upstream/runtime components.
