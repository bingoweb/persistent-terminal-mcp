# Security Model

## Trust boundary

Persistent Terminal MCP is a high-trust administrative tool. An authorized MCP client may execute commands and, when explicitly enabled in future providers, perform privileged operations on configured remote systems.

This project therefore focuses on preserving operator intent and preventing accidental boundary crossing rather than pretending remote administration is a low-privilege activity.

## Invariants

### Host identity

- Native OpenSSH host-key behavior is preserved.
- Host-key verification is never automatically disabled to “fix” connectivity.
- OpenSSH configuration remains operator-owned.

### Secrets

- Secret payloads are not serialized into registry state.
- Private-key bytes are never read by target resolution.
- Upstream secret-tool results are returned without extension-layer inspection or logging.
- Logs must be bounded and scrubbed of credentials.

### Privilege

- Normal remote execution is unprivileged by default.
- Privileged/root execution will use separately named, explicit tools/providers.
- No generic retry path may silently escalate privileges.

### Session isolation

- A named session is bound to its configured target.
- Stale local handles do not authorize closing a remote PTY.
- Remote reattach is based on the recorded remote lifecycle ID.
- New remote sessions are created only after absence of the recorded session is established.

### Command results

- A remote process exit code is not a transport error.
- Transport/authentication failures are categorized separately.
- Invalid input must be rejected before spawning a process or mutating remote state.

## Future privileged providers

Privileged providers (for example Docker-based host-root access) must be capability-checked, explicitly requested, separately tested, and visible in audit metadata. They must not be implicit fallbacks.

## Dependency and supply-chain controls

- exact npm versions are lockfile-pinned;
- GitHub Actions are commit-SHA pinned;
- CI runs dependency auditing and license checks;
- CodeQL scans JavaScript/TypeScript-compatible source;
- Dependabot monitors npm and GitHub Actions updates;
- public-repository secret scanning is enabled where GitHub supports it.
