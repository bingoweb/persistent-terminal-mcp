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

## M4 — Transfer and synchronization

Planned tools:

```text
remote_upload
remote_download
remote_sync
```

Requirements include recursive transfer, large-file handling, resume when supported, progress metadata, and SHA-256 integrity verification.

## M5 — Port-forward lifecycle

Planned tools:

```text
forward_create
forward_list
forward_status
forward_close
```

Support targets local `-L`, remote `-R`, and SOCKS `-D` forwarding with `ExitOnForwardFailure`, keepalive, and listener/tunnel health checks.

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
