# Security Policy

## Supported versions

The project is pre-release. Security fixes are applied to the latest `main` branch until the first stable release establishes a version-support matrix.

## Reporting a vulnerability

Please do **not** open a public issue for a vulnerability that could expose credentials, enable unintended remote command execution, bypass host-key verification, escalate privilege, or cross session/target boundaries.

Use GitHub private vulnerability reporting / Security Advisories for this repository when available. Include:

- affected commit/version;
- attack prerequisites;
- minimal reproduction;
- expected vs. observed behavior;
- whether credentials, session IDs, files, forwards, or privilege boundaries are affected.

## Security invariants

- Native OpenSSH host-key behavior must not be silently weakened.
- Secrets must not appear in structured tool output, logs, registry state, or terminal metadata.
- Normal commands must not silently become privileged commands.
- A stale local session handle must never cause an unrelated remote session to be closed.
- Transport failure must remain distinct from a remote program's non-zero exit status.
- File writes and state mutations must use atomic or integrity-checked mechanisms where specified.
- Forward/session/task identifiers must not be reused across incompatible targets.

Security-sensitive fixes require regression tests.
