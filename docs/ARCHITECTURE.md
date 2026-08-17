# Architecture

## Design goals

Persistent Terminal MCP is built for remote administration sessions where transport interruptions are expected and must not be confused with remote-process lifecycle.

The architecture separates four responsibilities:

1. **MCP aggregation** — exposes upstream PTY tools and local structured tools through one catalog.
2. **Persistent terminal ownership** — delegated to upstream `pty-mcp` / remote `ai-tmux`.
3. **Structured remote operations** — implemented locally with native OpenSSH and narrowly scoped helpers.
4. **Durable metadata** — local atomic state maps human names to local and remote lifecycle identifiers; it never owns the remote shell itself.

## Component graph

```text
                    +-------------------------+
MCP client -------->| Persistent Terminal MCP |
                    +------------+------------+
                                 |
                    +------------+-------------+
                    |                          |
                    v                          v
          +------------------+       +-------------------+
          | upstream pty-mcp |       | structured ops    |
          +--------+---------+       | ssh/scp/rsync/... |
                   |                 +---------+---------+
                   v                           |
             remote ai-tmux                    v
                   |                     remote operating
                   v                         system
            persistent shell
```

## Why upstream is not forked

The terminal engine is intentionally treated as an adapter dependency. Forking `pty-mcp` would couple terminal persistence upgrades to every file/transfer/system-management feature in this project. The combined server instead forwards upstream tools unchanged and adds extension tools alongside them.

## Target resolution

OpenSSH remains the source of truth for host configuration:

```bash
ssh -G <alias>
```

The project reads effective metadata such as hostname, user, port, identity-file path, proxy jump, and strict host-key mode but does not read private-key bytes or reinterpret OpenSSH policy.

## One-shot execution

`remote_exec` uses native `ssh`. A crucial OpenSSH behavior is explicitly regression-tested: the remote command is sent as **one** command string after `--`. Native OpenSSH does not preserve a local argv array as remote argv boundaries.

Remote exit status is a command result. OpenSSH status `255` is treated separately as a transport/authentication-layer signal.

## Persistent session recovery

Recovery order is fixed:

1. read named-session registry;
2. probe the recorded local PTY handle;
3. if stale, remove only the local handle mapping;
4. list remote `ai-tmux` sessions;
5. match the recorded remote session ID;
6. reattach when present;
7. create a new persistent session only after absence is positively established.

This avoids duplicate remote shells during transient local failures.

## State

Default state location:

```text
~/.local/share/persistent-terminal-extended/state.json
```

Writes use temporary file + file `fsync` + atomic rename. The state contains only lifecycle metadata such as names, targets, IDs, tags, and timestamps. Passwords, private keys, OAuth tokens, secret payloads, and terminal scrollback are forbidden.

## Error model

Structured errors use a closed category vocabulary:

```text
validation_error
target_resolution_error
host_key_authentication_error
transport_reconnect_failure
timeout
remote_command_nonzero_exit
missing_remote_capability
local_capability_dependency_error
stale_session_task_forward_id
permission_privilege_error
checksum_integrity_failure
binary_file
```

The design preserves the difference between **could not execute** and **executed and returned failure**.
