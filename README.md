# Persistent Terminal MCP

An MCP server for remote terminal work where the shell should survive a dropped client connection.

This project started from a fairly simple problem: most SSH MCP wrappers tie the life of the shell to the life of the SSH/MCP connection. That is fine for short commands, but it gets annoying very quickly with builds, downloads, log sessions, interactive tools, or anything that should still be there after a reconnect.

Persistent Terminal MCP keeps those two things separate. Interactive sessions are backed by [`pty-mcp`](https://github.com/raychao-oao/pty-mcp) and remote `ai-tmux`; structured operations use native OpenSSH. If the local MCP process disappears, the remote PTY can stay alive and be attached again later.

The repository is still pre-release. The core is working and tested, but the larger file-transfer, forwarding, task and system-management surface is still being built.

## What works now

- existing `pty-mcp` tools are exposed without maintaining a fork
- persistent remote PTYs through `ai-tmux`
- OpenSSH config/alias resolution through `ssh -G`
- `remote_exec` with separate stdout, stderr and exit status
- cwd, environment variables, stdin, timeouts and output limits
- transport failures kept separate from ordinary non-zero process exits
- host-key/authentication failures kept separate from reconnect failures
- atomic local state storage
- named-session recovery logic
- stale local handle cleanup without killing the remote PTY
- reattach to an existing remote session before creating a replacement
- MCP output-schema checks for both successful and failed calls
- secret-related upstream tools passed through without inspecting or rewriting their result

The next work is tracked in [`docs/ROADMAP.md`](docs/ROADMAP.md). In short: finish the public named-session tools, then add structured remote files, large/resumable transfers, port forwards, persistent tasks, explicit privileged operations, system helpers and deeper fault-injection testing.

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
- `pty-mcp` for persistent/interactive terminal tools
- `ai-tmux` on hosts where persistent remote sessions are used

Some later features will also use `rsync` or Docker when those capabilities are explicitly enabled.

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
