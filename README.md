# Persistent Terminal MCP

Persistent Terminal MCP is a resilient Model Context Protocol server for remote system administration. It combines persistent interactive terminals from [`pty-mcp`](https://github.com/raychao-oao/pty-mcp) / `ai-tmux` with structured OpenSSH operations, explicit recovery semantics, strict error contracts, and a growing set of remote-management tools.

The project is designed around one rule: **an MCP or SSH transport disconnect must not automatically destroy the remote shell or long-running job**.

> Status: **pre-release / active development**. The implemented core is tested and usable, while the advanced filesystem, transfer, forwarding, task, privileged-operation, and observability layers are still being completed. The roadmap below distinguishes shipped behavior from planned behavior.

## Implemented today

- upstream `pty-mcp` tool passthrough without forking upstream;
- persistent remote PTY ownership through `ai-tmux`;
- native OpenSSH target resolution through `ssh -G`;
- structured `remote_exec` with stdout/stderr/exit-code separation;
- cwd, environment, stdin, timeout, and bounded output support;
- explicit transport vs. remote-process failure classification;
- host-key/authentication failures kept separate from reconnect failures;
- atomic local state store;
- named-session recovery decision engine;
- stale local handle cleanup without killing the remote PTY;
- live-remote reattach before new-session creation;
- MCP schema validation for success and normalized failure results;
- secret-oriented upstream tools passed through without result re-serialization.

## Planned advanced surface

- canonical named-session MCP tools (`ensure_session`, list/detach/close);
- deprecated compatibility aliases for selected historical `ssh_*` workflows;
- structured remote filesystem operations;
- resumable upload/download/sync with SHA-256 integrity checks;
- local, remote, and SOCKS port-forward lifecycle management;
- persistent long-running task registry and wait/output/cancel operations;
- explicit privileged/root execution providers;
- process/service/port/log/disk/GPU helpers;
- health, counters, failure injection, bounded logs, and deployment tooling.

See [`docs/ROADMAP.md`](docs/ROADMAP.md) for the detailed milestone plan.

## Architecture

```text
MCP client
   |
   v
Persistent Terminal MCP
   |---------------------- local structured operations
   |
   +----> upstream pty-mcp ----> ai-tmux on remote host
   |
   +----> native OpenSSH / scp / rsync
```

The extension deliberately does **not** fork `pty-mcp`. Upstream terminal tools remain independently upgradable and are exposed through the combined catalog.

## Requirements

- Node.js `>=22.23.1`
- native OpenSSH client
- a reachable `pty-mcp` upstream for persistent terminal features
- `ai-tmux` on targets used for persistent remote sessions
- optional future capabilities: `rsync`, Docker CLI/Engine, NVIDIA CLI tooling

## Development

```bash
npm ci
npm run quality
```

The quality gate runs syntax validation, the full Node test suite, and license-inventory validation.

## Configuration

The upstream MCP URL defaults to:

```text
http://127.0.0.1:9021/mcp
```

Override with:

```bash
export PTY_UPSTREAM_URL=http://127.0.0.1:9021/mcp
```

OpenSSH aliases, identities, `ProxyJump`, ports, and host-key behavior remain owned by native `~/.ssh/config` semantics.

## Security model

This project intentionally treats remote administration as a high-trust operation. It does not silently bypass host-key checks, does not log private keys or plaintext credential payloads, and does not silently elevate normal commands to root.

See [`SECURITY.md`](SECURITY.md) and [`docs/SECURITY-MODEL.md`](docs/SECURITY-MODEL.md).

## Licensing

Persistent Terminal MCP is licensed under the **Apache License 2.0**.

Third-party dependencies and external runtime components retain their own licenses. See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md), [`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md), and [`docs/LICENSING.md`](docs/LICENSING.md).

No `pty-mcp` / `ai-tmux` source file is currently vendored or copied into this repository; those components are integrated as an external upstream/runtime.
