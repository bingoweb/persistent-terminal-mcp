# Persistent Terminal MCP

An MCP server for remote terminal work where the shell should survive a dropped client connection.

This project started from a fairly simple problem: most SSH MCP wrappers tie the life of the shell to the life of the SSH/MCP connection. That is fine for short commands, but it gets annoying very quickly with builds, downloads, log sessions, interactive tools, or anything that should still be there after a reconnect.

Persistent Terminal MCP keeps those two things separate. Interactive sessions are backed by [`pty-mcp`](https://github.com/raychao-oao/pty-mcp) and remote `ai-tmux`; structured operations use native OpenSSH. If the local MCP process disappears, the remote PTY can stay alive and be attached again later.

The repository is still pre-release. The core, structured filesystem and transfer/synchronization layers are working and tested, while forwarding, task and system-management surfaces are still being built.

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
- MCP output-schema checks for both successful and failed calls
- secret-related upstream tools passed through without inspecting or rewriting their result

The next work is tracked in [`docs/ROADMAP.md`](docs/ROADMAP.md). In short: add managed port forwards, then persistent tasks, explicit privileged operations, system helpers and deeper fault-injection testing.

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
