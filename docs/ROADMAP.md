# Roadmap

This roadmap distinguishes implemented behavior from planned work. A milestone is complete only after its unit/integration gates and relevant live acceptance tests pass.

## M1 — Core structured execution — implemented

- normalized result/error contracts;
- native OpenSSH target resolution;
- `remote_exec`;
- bounded output / stdin / cwd / env / timeout;
- host-key/auth vs transport classification;
- combined upstream PTY + extension MCP catalog;
- MCP output-schema regression coverage.

## M2 — Named persistent sessions — implemented

- atomic state store — implemented;
- recovery decision engine — implemented;
- canonical `ensure_session` / list / detach / close tools;
- bounded reconnect/backoff/jitter;
- selected deprecated `ssh_*` compatibility aliases;
- live local-process restart / same-remote-ID recovery proof.

## M3 — Structured remote filesystem — implemented

Implemented tools:

```text
remote_stat
remote_list
remote_read
remote_write
remote_patch
remote_mkdir
remote_move
remote_delete
remote_find
remote_grep
```

The filesystem protocol sends paths and text as structured JSON data rather than caller-built shell source. UTF-8 writes use same-directory temporary files, `fsync`, and atomic replace semantics; optional SHA-256 preconditions prevent blind overwrites. `remote_patch` validates every exact hunk before writing. `remote_find` and `remote_grep` use deterministic bounded traversal, do not follow directory symlinks by default, and report truncation explicitly. Text search skips binary files and reports the skipped count.

Live acceptance covers write/read, SHA-256 conflict preservation, patch, grep, find, move, list and cleanup against a real OpenSSH target.

## M4 — Transfer and synchronization — implemented

Implemented tools:

```text
remote_upload
remote_download
remote_sync
```

`remote_upload` and `remote_download` operate on filesystem paths rather than file bytes in MCP payloads. Simple copies can use scp; resumable copies use rsync with partial-file support and bounded progress metadata. Caller-provided paths remain argv/data values rather than generated shell source.

`remote_sync` is explicitly rsync-only and does not silently fall back to scp. It supports upload/download direction, recursive traversal, excludes, dry-run and visible delete semantics. Missing remote rsync is reported as `missing_remote_capability`.

Optional SHA-256 verification streams the local file into a hash and obtains the remote digest with a fixed `sha256sum` command plus structured environment data. Successful transfers expose only `verified_sha256:true`; mismatches raise `checksum_integrity_failure` with both digests for diagnosis. Resume reporting is evidence-based when a pre-existing partial remote file can be observed.

Live acceptance covers a deterministic 32 MiB verified upload/download round-trip, an interrupted 48 MiB rsync resumed from a real partial remote file, and sync dry-run/exclude/delete behavior against a real OpenSSH target.

## M5 — Port-forward lifecycle — implemented

Implemented tools:

```text
forward_create
forward_list
forward_status
forward_close
```

Local `-L`, remote `-R`, and SOCKS `-D` forwards run as independent native `ssh -N` processes with `BatchMode`, `ExitOnForwardFailure` and keepalive options. Each managed forward has a stable generated ID plus an optional unique name.

Lifecycle state is written only after a bounded startup gate and process-identity capture. Closing a forward verifies the recorded PID plus start/process identity before SIGTERM and verifies the identity again before any SIGKILL, so stale state or PID reuse cannot authorize killing an unrelated SSH process.

Health combines process identity with actual listener state. Local and dynamic forwards use a bounded TCP connect probe; remote forwards query the remote target with a fixed `ss -ltnH` command and compare the expected bind/port. Healthy named forwards are reused rather than duplicated.

Live acceptance starts a temporary loopback HTTP service on a real remote target, creates a named local forward, fetches HTTP through it, verifies healthy status and named reuse with the same ID/PID, closes it, confirms the listener is gone and verifies the persistent registry no longer contains the forward.

## M6 — Persistent task manager — implemented

Implemented tools:

```text
task_start
task_status
task_output
task_wait
task_cancel
task_list
```

Each task runs in its own recorded persistent remote PTY and has a stable task ID plus persisted lifecycle state. Command text is carried as base64 data into a fixed wrapper rather than interpolated into generated shell source, and completion is recognized only through an anchored random marker.

`task_output` reads bounded incremental output from the stored cursor. `task_wait` drains buffered output and then performs one bounded upstream `wait_for` operation instead of rapid polling. A stale local extension handle reattaches only to the task's recorded live remote session; if that remote session is gone, a running task becomes `lost` rather than silently creating a replacement.

Cancellation sends Ctrl-C only to the verified recorded task PTY. `terminate_session:true` is explicit and closes only that dedicated session, and only after the bounded normal cancellation attempt fails.

Live acceptance starts a roughly 45-second timestamped task, abruptly kills the local extension process, restarts it with the same persisted state, recovers the original remote session, waits for the original task ID to exit successfully, and proves that recovery did not create a second task or remote session.

## M7 — Explicit privilege and system helpers — implemented

Implemented privileged tool:

```text
remote_root_exec
```

`remote_root_exec` is controlled by `PTEXT_ROOT_TARGETS` and performs auditable best-effort root acquisition in this order: already-root SSH, passwordless sudo, Docker host-root, secret-safe interactive sudo, then secret-safe `su - root`. The policy accepts exact aliases or `*` for installations where every configured OpenSSH target is intentionally administrable. Password dialogs are opened only after the upstream PTY confirms that a password prompt is active, so secret bytes do not travel through ordinary tool arguments or AI-visible logs/state.

Implemented read-only helpers:

```text
system_info
process_list
port_list
service_status
journal_read
disk_usage
gpu_info
```

Implemented controlled mutations:

```text
process_signal
service_start
service_stop
service_restart
```

Mutation tools default to `privilege:'auto'`: the configured user is tried first, and only an observed privilege denial enters the same best-effort root provider. `privilege:'user'` is a strict no-escalation override; `privilege:'root'` starts through the root provider immediately. Results always expose the privilege actually used and the selected root strategy when applicable.

Performance hardening removes an unnecessary `ssh -G` subprocess from ordinary non-interactive execution, keeps the structured remote-filesystem helper in a content-addressed per-target cache instead of retransmitting its source for every operation, and caches the process-local lifecycle state after its initial atomic read.

Live acceptance on the `taylan` test target proved ordinary `remote_exec` remained UID 1000, explicit root execution selected `docker_host_root` and returned UID 0, and normalized system, disk, GPU and `ssh.service` inspection succeeded without mutating production services.

## M8 — Observability, fault injection, deployment — implemented

- `terminal_health` reports extension/upstream/gateway health, lifecycle counts, reconnect/failure counters and optional target compatibility/session counts without exposing command/session payloads;
- reconnect uses one in-flight promise with bounded exponential backoff + jitter and resets after successful functional `tools/list`;
- arbitrary upstream tool calls are not replayed after ambiguous response loss, preserving at-most-once behavior for possible side effects; a definitive JSON-RPC `-32001 Session not found` is treated separately because the stale MCP session rejected the request before dispatch, so the client reconnects and retries exactly once;
- structural/pattern secret redaction plus bounded diagnostics and redaction-first rotating JSONL logs are implemented;
- deployed topology is gateway `9022` -> localhost guard `9031` -> extension backend `9032` -> upstream `9021`, preserving the existing public OAuth resource and scope;
- watchdog treats upstream, extension and gateway as separate restart domains;
- the existing upstream persistence smoke also proves the extension recovers its functional tool catalog after upstream restart;
- a 15-phase full acceptance suite verifies structured execution, alias semantics, host-key classification, persistence/reuse, simultaneous session isolation, filesystem, binary checksum transfer, resume/sync, forwarding, long-task wait, extension restart survival, gateway restart survival, root UID 0, redaction and reconnect-storm prevention;
- final acceptance cleanup requires no leaked named sessions, tasks, forwards or remote `ai-tmux` sessions.

## Stable-release gate

The implementation side of the stable-release gate is satisfied: major tools have deterministic tests, the live 15-phase acceptance matrix passes, and no known Critical/Important defect is recorded. The first stable pre-1.0 version was `0.9.0`; the current audited release line is `0.10.0`. Release engineering adds a restricted runtime package, standalone source archive, CycloneDX SBOM, SHA-256 checksums, clean-install smoke, version consistency checks, retained rollback runtime, and a tag-only GitHub Release workflow. A release is not considered published until its exact versioned tree passes deployment, live acceptance, burn-in, and public artifact verification.

## M9 — 0.11 High-Trust Power Core / Plan A — implemented in source, not released

The first 0.11 slice strengthens the transport/capability engine without changing the deployed 0.10.0 runtime yet.

Implemented transport core:

- managed OpenSSH ControlMaster reuse with `PTEXT_SSH_MULTIPLEX=off|auto|required` (`auto` default);
- private `0700` control directory, hashed target/socket identity, single-flight first connection and bounded target count;
- native `ssh -O check` lifecycle verification and owned `ssh -O exit` cleanup;
- stale owned socket recovery and one-shot fallback only in `auto` mode;
- portable short ControlPath selection with an 80-byte path budget. Live acceptance exposed a real macOS/OpenSSH Unix-domain path-length failure in the initial long runtime path; the regression now prefers short `~/.ptext-ssh` storage and uses a process-isolated `/tmp` fallback only when the home path itself is too long.

Implemented capability/diagnostic core:

```text
target_capabilities
target_diagnose
```

- capability inventory covers Python, rsync, privilege providers, Docker, systemd/journal/socket/network diagnostics, NVIDIA tooling and `ai-tmux`;
- successful positive and negative capability results use a 120-second TTL by default;
- resolved SSH identity changes invalidate cached capability state;
- transport/probe failures are not cached;
- concurrent first refresh uses a single in-flight probe;
- `target_diagnose` separates transport failure, degraded system inspection, privilege availability, `ai-tmux`, capability cache and payload-free aggregate telemetry rather than collapsing every diagnostic problem into an MCP exception.

Production runtime wiring in the source branch now creates one telemetry instance, one multiplex manager and one capability inventory and shares the multiplex-aware `remote_exec` path with explicit root probes, system helpers, structured remote filesystem calls and terminal-health remote probes.

Deterministic Plan-A gate after the implementation: `261/261 PASS`, `SOURCE_CHECK_OK (92 files)` after the live harness was added, and `THIRD_PARTY_LICENSES_OK (93 packages)`.

Disposable real-target acceptance result:

```text
TRANSPORT_CAPABILITY_LIVE_OK
multiplex: miss=2 hit=3 stale_recovered=1 fallback=0
capability cache: miss=1 hit=2
ai-tmux: available
privilege diagnosis: available
target diagnosis: available
```

The final representative verification run measured 383 ms for initial master establishment plus command, 98 ms for the immediately reused command, and 276 ms for deliberately forced stale-master recovery. These timings are evidence that the intended transport paths executed, not a general performance benchmark. Post-test production health remained clean with active sessions/tasks/forwards and remote `ai-tmux` sessions all at zero.

## M10 — 0.11 High-Trust Power Core / Plan B — implemented in source, not released

The second 0.11 slice broadens controlled administration while preserving the deployed 0.10.0 runtime until Plan C.

Implemented privilege core:

- one shared Privilege Engine 2.0 caches only proven non-secret provider preference (`direct_root`, `sudo_nopasswd`, `docker_host_root`);
- the cache is TTL- and SSH-identity-bound and is only an ordering hint: every privileged command still performs the provider's live proof before dispatch;
- secret-backed sudo/su providers are never cached as automatic preference;
- ordinary non-permission failures do not cause privilege escalation;
- proof failure invalidates stale preference and allows the normal provider chain to select another proven provider.

Implemented generic systemd administration:

```text
systemd_unit_status
systemd_unit_list
systemd_unit_dependencies
systemd_unit_action
systemd_daemon_reload
```

- supported unit types: service, socket, timer, path, mount, automount, target, slice, scope;
- supported actions are closed to start/stop/restart/reload/try-restart/reload-or-restart/enable/disable/reenable/mask/unmask/reset-failed;
- legacy `service_status|start|stop|restart` remain compatibility-oriented and route through the same generic core where semantics match;
- canonical systemd `\\xHH` unit-name escapes are accepted consistently by the core and MCP schemas while arbitrary backslashes/shell syntax remain rejected. This regression was added after the first live Plan B run encountered `systemd-fsck@dev-disk-by\\x2duuid-...service` on the real Ubuntu host.

Implemented bounded transactional administration:

```text
admin_transaction
```

- exactly one enumerated mutation (`systemd_action`, `remote_write`, or `remote_patch`);
- optional precheck and 1..8 health checks;
- UTF-8 file rollback snapshots are capped at 1 MiB and kept only in process memory;
- file rollback uses optimistic SHA-256 conflict detection and a fresh post-restore SHA verification;
- systemd rollback restores only deterministic pre-state mappings and verifies them afterward;
- mutation transport ambiguity is never replayed automatically;
- rollback conflicts/failures remain visible as `rollback_failed` rather than being hidden by the original health failure.

Deterministic Plan-B gate:

```text
303/303 tests PASS
SOURCE_CHECK_OK (103 files)
THIRD_PARTY_LICENSES_OK (93 packages)
git diff --check: clean
```

Disposable real-target acceptance on `taylan`:

```text
ADMIN_POWER_LIVE_OK
root strategy: docker_host_root
unit lifecycle: inactive -> active/exited -> inactive
unit-file lifecycle: enabled -> disabled
privilege cache: entries=1 docker_host_root=1, provider re-proved live
admin transaction: rolled_back, rollback_succeeded=true, rollback_verified=true
multiplex: miss=1 hit=42 stale_recovered=0 fallback=0
lifecycle before: sessions=0 tasks=0 forwards=0 remote_sessions=0
lifecycle after:  sessions=0 tasks=0 forwards=0 remote_sessions=0
```

The acceptance harness owns only randomized `ptext-live-*` unit/config/marker fixtures and removes them in `finally`, followed by daemon-reload. A separate artifact check confirmed no disposable unit or file remained. Production `terminal_health` afterward still reported extension `0.10.0` healthy, upstream `pty-mcp v0.11.7` healthy, gateway healthy, active sessions/tasks/forwards all zero, remote `ai-tmux` sessions zero, and reconnect failures zero.

## M11 — 0.11 High-Trust Power Core / Plan C protocol quality — implemented in source, not released

The protocol-quality portion of Plan C is complete on the source branch while production deliberately remains on 0.10.0.

Implemented MCP metadata policy:

- all 49 canonical extension-owned tools and three deprecated extension aliases publish exactly four boolean MCP annotations: `readOnlyHint`, `destructiveHint`, `idempotentHint`, and `openWorldHint`;
- mutation/arbitrary-execution tools are conservatively marked potentially destructive, restart/transaction-class actions are not claimed idempotent, and local-only registry views are distinguished from target/network operations;
- upstream tool definitions are never rewritten or annotated by the extension; legacy `ssh_read_session` gets its own extension-owned alias policy while upstream `read_output` remains untouched;
- annotations are advisory protocol metadata and do not replace validation, root policy, target allowlists or secret-safe escalation.

Completed target diagnostics:

- transport identity and managed multiplex state;
- remote user/UID and OS/kernel/architecture/uptime;
- full fixed capability inventory;
- root-provider availability plus non-secret provider-cache summary;
- `ai-tmux` version/state;
- disk-pressure summary derived from byte counts rather than trusting display percentages;
- bounded failed-systemd unit count through one fixed C-locale command;
- optional NVIDIA GPU state with explicit `not_applicable` handling;
- capability-cache state and fixed-vocabulary payload-free telemetry;
- section-level `available`, `unavailable`, `not_applicable`, `permission_limited`, or `failure` semantics, with overall `degraded` only when an independent probe actually fails.

`terminal_health` now includes a closed `runtime` summary for bounded telemetry, multiplex mode/active master count, capability-cache counts/TTL and non-secret privilege-cache provider counts. ControlPath values, master lists, target hashes, command text, paths and other high-cardinality payloads are intentionally excluded. Snapshot failure in any one runtime component does not make the health tool fail.

Final pre-version source-path acceptance on `taylan`:

```text
TRANSPORT_CAPABILITY_LIVE_OK
  multiplex: miss=2 hit=4 stale_recovered=1 fallback=0
  capability cache: hit=2 miss=1 refresh=0
  ai-tmux: v0.11.7
  privilege/diagnose: available

ADMIN_POWER_LIVE_OK
  root strategy: docker_host_root
  lifecycle: inactive -> active/exited -> inactive
  unit file: enabled -> disabled
  transaction: rolled_back, rollback_succeeded=true, rollback_verified=true
  lifecycle before/after: sessions=0 tasks=0 forwards=0 remote_sessions=0

PROTOCOL_RELEASE_LIVE_OK
  extension-owned annotated tools: 52
  OS: Ubuntu 26.04 LTS
  kernel: 7.0.0-29-generic
  failed systemd units: 0
  GPU: nvidia-smi, count=1
  disk pressure: filesystems=11 highest=59.628% root=15.958%
  lifecycle before/after: sessions=0 tasks=0 forwards=0 remote_sessions=0
```

Final C4 pre-version gates:

```text
322/322 tests PASS
SOURCE_CHECK_OK (108 files)
THIRD_PARTY_LICENSES_OK (93 packages)
npm audit --omit=dev --audit-level=high: 0 vulnerabilities
DISPOSABLE_CLEANUP_OK
git diff --check: clean
```

The next release steps are **Plan C5/C6**: cut the exact 0.11.0 release tree and artifacts, run release checks/clean-install smoke, record the deployed 0.10.0 baseline, deploy through the retained-runtime installer, prove extension/gateway restart survival with the full 15-phase acceptance, then and only then update the standalone public repository and immutable release tag.

## M12 — 0.11.0 release candidate tree — completed

The package/lock metadata and release documentation were cut as `0.11.0` from the accepted C4 source tree and then hardened by independent black-box validation before deployment.

The candidate release notes document ControlMaster/stale recovery, complete `target_diagnose`, Privilege Engine 2.0, generic systemd administration, `admin_transaction` rollback verification, MCP annotations, bounded `terminal_health` runtime evidence, unchanged public OAuth/topology, versioned runtime/source/SBOM/SHA-256 artifacts, and retained-runtime rollback policy.

After independent-validation hardening the release-candidate gate is **327/327 tests**, `SOURCE_CHECK_OK (110 files)`, `THIRD_PARTY_LICENSES_OK (93 packages)`, `RELEASE_CHECK_OK version=0.11.0`, zero production dependency vulnerabilities, and clean diff validation. The regression set now covers source-artifact release identity, cross-module state-store lost-update prevention, and the localhost Host/Origin guard. Official MCP Conformance 0.1.16 independently passes initialize/ping/tools-list/DNS-rebinding scenarios on the guarded endpoint, and MCP Inspector 2.2.0 independently validates production tools/list plus terminal_health.

The exact versioned tree passed `npm run quality`, `npm run release:check`, production dependency audit, `npm run release:artifacts`, checksum verification and artifact-content/clean-install inspection before deployment. Public update/tag remains after the final post-deployment documentation/artifact rebuild.

## M13 — 0.11.0 production deployment and independent acceptance — completed

Production now runs 0.11.0 behind `9022 gateway -> 9031 localhost guard -> 9032 extension -> 9021 pty-mcp`; 0.10.0 is retained as rollback. The deployed runtime passed the full 15-phase live failure-injection matrix. The exact scenario that had failed on 0.10.0—named-session survival across extension restart—now preserves remote `ai-tmux` identity and leaves no remote-session leak.

Independent gates were rerun after deployment rather than inferred from internal tests. Official MCP Conformance 0.1.16 passed `server-initialize`, `ping`, `tools-list`, `dns-rebinding-protection` (2/2) and `server-sse-multiple-streams` (2/2), with no failures/warnings in those applicable scenarios. MCP Inspector 2.2.0 independently observed 68 tools, 52 annotated extension-owned tools, healthy 0.11.0 runtime, upstream `pty-mcp v0.11.7`, zero active lifecycle objects and zero remote sessions. Eight consecutive black-box health/diagnose burn-in iterations completed with no lifecycle growth and no multiplex fallback. The public ChatGPT/OAuth connector path also returned live 0.11.0 health.

The remaining M13 publication step is mechanical but still gated: commit this deployment evidence, rebuild artifacts from the exact committed source tree, verify SHA-256/source identity again, update the standalone public repository without force, and publish the immutable `v0.11.0` release only after those final checks remain green.
