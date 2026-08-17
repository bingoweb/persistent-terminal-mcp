# Persistent Terminal MCP

An MCP server for remote terminal work where the shell should survive a dropped client connection.

This project started from a fairly simple problem: most SSH MCP wrappers tie the life of the shell to the life of the SSH/MCP connection. That is fine for short commands, but it gets annoying very quickly with builds, downloads, log sessions, interactive tools, or anything that should still be there after a reconnect.

Persistent Terminal MCP keeps those two things separate. Interactive sessions are backed by [`pty-mcp`](https://github.com/raychao-oao/pty-mcp) and remote `ai-tmux`; structured operations use native OpenSSH. If the local MCP process disappears, the remote PTY can stay alive and be attached again later.

The repository is still pre-release. The core, structured filesystem, transfer/synchronization, managed-forward and persistent-task layers are working and tested, while explicit privilege and broader system-management surfaces are still being built.

## What works now

- existing `pty-mcp` tools are exposed without maintaining a fork
- persistent remote PTYs through `ai-tmux`
- OpenSSH config/alias resolution through `ssh -G`
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
- MCP output-schema checks for both successful and failed calls
- secret-related upstream tools passed through without inspecting or rewriting their result

The next work is tracked in [`docs/ROADMAP.md`](docs/ROADMAP.md). In short: add explicit privileged operations, system helpers and deeper fault-injection/observability coverage.

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

## Requirements

- Node.js 22.23.1 or newer
- OpenSSH client
- Python 3 on remote hosts where structured filesystem tools are used
- `rsync` locally and remotely for `remote_sync` and resumable transfers
- `sha256sum` on remote hosts when transfer SHA-256 verification is requested
- `pty-mcp` for persistent/interactive terminal tools
- `ai-tmux` on hosts where persistent remote sessions are used

Some later system-management features may also use Docker when those capabilities are explicitly enabled.

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

More detail is in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and [`docs/TESTING.md`](docs/TESTING.md).

## Security

This is an administration tool, so an authorized client is powerful by design. The code does not silently disable SSH host-key checking, read private-key contents, log secret payloads, or turn ordinary commands into root commands.

See [`SECURITY.md`](SECURITY.md) and [`docs/SECURITY-MODEL.md`](docs/SECURITY-MODEL.md).

## License and third-party code

The original code in this repository is Apache-2.0 licensed.

Third-party software keeps its own license. Direct dependencies and external runtime components are listed in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md); the complete locked npm dependency inventory is in [`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md).

No `pty-mcp` or `ai-tmux` source file is vendored here at the moment. They are used as external upstream/runtime components.
