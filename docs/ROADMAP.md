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

## M6 — Persistent task manager

Planned tools:

```text
task_start
task_status
task_output
task_wait
task_cancel
task_list
```

Tasks must survive local MCP disconnect/restart when backed by a persistent remote session.

## M7 — Explicit privilege and system helpers

Planned privileged tool:

```text
remote_root_exec
```

Planned helpers include process/service/port/journal/disk/GPU operations. Privilege is explicit and never an automatic fallback from ordinary execution.

## M8 — Observability, fault injection, deployment

- server/upstream/remote compatibility health;
- session/task/forward counters;
- reconnect/failure counters;
- bounded rotating logs;
- watchdog targets for extension and upstream separately;
- public OAuth deployment path;
- forced transport-loss and process-restart acceptance suite;
- stable-release checklist.

## Stable-release gate

The first stable release requires all major tools to have deterministic tests and the live acceptance matrix to pass without known Critical/Important defects.
