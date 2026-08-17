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

`remote_root_exec` is allowlisted and performs auditable best-effort root acquisition in this order: already-root SSH, passwordless sudo, Docker host-root, secret-safe interactive sudo, then secret-safe `su - root`. Password dialogs are opened only after the upstream PTY confirms that a password prompt is active, so secret bytes do not travel through ordinary tool arguments or AI-visible logs/state.

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

Mutation tools default to `privilege:'user'` and never silently retry as root. The caller must explicitly request `privilege:'root'`, which routes through the same best-effort root provider and reports the selected strategy.

Live acceptance on the `taylan` test target proved ordinary `remote_exec` remained UID 1000, explicit root execution selected `docker_host_root` and returned UID 0, and normalized system, disk, GPU and `ssh.service` inspection succeeded without mutating production services.

## M8 — Observability, fault injection, deployment — implemented

- `terminal_health` reports extension/upstream/gateway health, lifecycle counts, reconnect/failure counters and optional target compatibility/session counts without exposing command/session payloads;
- reconnect uses one in-flight promise with bounded exponential backoff + jitter and resets after successful functional `tools/list`;
- arbitrary upstream tool calls are not replayed after ambiguous response loss, preserving at-most-once behavior for possible side effects; a definitive JSON-RPC `-32001 Session not found` is treated separately because the stale MCP session rejected the request before dispatch, so the client reconnects and retries exactly once;
- structural/pattern secret redaction plus bounded diagnostics and redaction-first rotating JSONL logs are implemented;
- deployed topology is gateway `9022` -> extension `9031` -> upstream `9021`, preserving the existing public OAuth resource and scope;
- watchdog treats upstream, extension and gateway as separate restart domains;
- the existing upstream persistence smoke also proves the extension recovers its functional tool catalog after upstream restart;
- a 15-phase full acceptance suite verifies structured execution, alias semantics, host-key classification, persistence/reuse, simultaneous session isolation, filesystem, binary checksum transfer, resume/sync, forwarding, long-task wait, extension restart survival, gateway restart survival, root UID 0, redaction and reconnect-storm prevention;
- final acceptance cleanup requires no leaked named sessions, tasks, forwards or remote `ai-tmux` sessions.

## Stable-release gate

The implementation side of the stable-release gate is satisfied: major tools have deterministic tests, the live 15-phase acceptance matrix passes, and no known Critical/Important defect is recorded. The first stable pre-1.0 version is `0.9.0`. Release engineering adds a restricted runtime package, standalone source archive, CycloneDX SBOM, SHA-256 checksums, clean-install smoke, version consistency checks, retained rollback runtime, and a tag-only GitHub Release workflow. The release is not considered published until the exact `v0.9.0` tree passes deployment, live acceptance, burn-in, and public artifact verification.
