# Testing Strategy

Remote administration software must test failure behavior, not only happy paths.

## Local quality gate

Run:

```bash
npm run quality
```

The command executes:

- syntax validation for all project `.mjs` files;
- the complete `node:test` suite;
- lockfile/license inventory validation.

CI additionally runs `npm audit --omit=dev --audit-level=high`.

## Test layers

### Contract/unit tests

Cover validation, quoting, error categories, result shapes, output bounding, atomic state, and recovery decision logic.

### MCP protocol integration tests

Use the MCP SDK's in-memory transport to perform real initialize / `tools/list` / `tools/call` flows. This catches schema-level defects that ordinary function tests do not.

### Upstream integration tests

Exercise a live loopback `pty-mcp` endpoint when available and verify that upstream tools remain present beside extension tools.

### Live remote acceptance

Live tests are opt-in and must use environment variables rather than committed private target details. They verify actual OpenSSH behavior, persistent `ai-tmux` recovery, transfer integrity, forwarding, task survival, and privileged providers.

Current live acceptance entry points include:

```bash
PTY_MCP_SMOKE_HOST=<ssh-alias> node test/live/session-recovery.mjs
PTY_MCP_SMOKE_HOST=<ssh-alias> node test/live/filesystem-roundtrip.mjs
PTY_MCP_SMOKE_HOST=<ssh-alias> node test/live/transfer-roundtrip.mjs
PTY_MCP_SMOKE_HOST=<ssh-alias> node test/live/forward-roundtrip.mjs
PTY_MCP_SMOKE_HOST=<ssh-alias> node test/live/task-recovery.mjs
PTY_MCP_SMOKE_HOST=<ssh-alias> node test/live/root-system.mjs
PTY_MCP_SMOKE_HOST=<ssh-alias> node test/live/transport-capability.mjs
PTY_MCP_SMOKE_HOST=<ssh-alias> node test/live/admin-power.mjs
PTY_MCP_SMOKE_HOST=<ssh-alias> node test/live/protocol-release.mjs
```

The repository-level end-to-end acceptance harness is run from the parent deployment workspace:

```bash
PTY_MCP_SMOKE_HOST=<ssh-alias> PTY_MCP_SMOKE_USER=<user> node tests/persistent-terminal-extended-acceptance.mjs
```

It contains exactly 15 named phases and additionally failure-injects independent extension and gateway restarts while persistent remote session/task work is active. A successful run ends with `PERSISTENT_TERMINAL_EXTENDED_ACCEPTANCE_OK phases=15` and verifies that the remote-session baseline is restored after cleanup.

The filesystem round-trip goes through the extension MCP's canonical tools and verifies write/read, a rejected SHA-256 conflict with unchanged content, deterministic patching, grep/find, move/list, deletion, and failure-safe cleanup of its unique `/tmp` directory.

The transfer round-trip creates deterministic local files outside the repository, verifies a 32 MiB upload/download with SHA-256, intentionally interrupts a larger rsync so a real partial remote file remains, confirms the canonical resume path reports `resumed:true`, and exercises `remote_sync` dry-run, excludes and delete semantics. Both local and remote temporary artifacts are removed on completion or failure.

The forward round-trip starts a temporary loopback HTTP server on the remote target, creates a named local SSH forward, performs a real HTTP fetch through the local listener, checks canonical health, proves that requesting the same healthy name reuses the same forward ID and PID, closes the forward, confirms the local listener is gone and verifies the persistent registry entry was removed. The temporary remote HTTP process is cleaned up even on failure.

The task-recovery acceptance starts a roughly 45-second task that emits timestamped output, abruptly kills only the local extension process, confirms the recorded remote `ai-tmux` session remains alive, starts a new extension process against the same state file, reattaches to that exact remote session and requires `task_wait` to finish the original task ID with exit code 0. It also asserts that restart/recovery never creates a second task or remote session and cleans up the dedicated remote session afterward.

The root/system acceptance proves that ordinary `remote_exec` remains non-root, then runs `remote_root_exec({command:'id -u'})` with an explicit root allowlist and requires UID 0 plus auditable provider attempts. It also runs `system_info`, `disk_usage`, `gpu_info`, and `service_status` against a harmless known service. The acceptance never starts, stops, restarts, or signals production processes/services. Password-based root providers are unit-tested with a fake upstream that requires `password_prompt`/`awaiting_secret` before `send_secret`; live acceptance uses automatic providers when available so it does not deliberately ask for a real password.

The 0.11 source-path acceptances deliberately stay separate from the deployed 0.10.0 service until the release/deployment phase. `transport-capability.mjs` proves managed ControlMaster reuse, forced stale-master recovery, capability caching, `ai-tmux`, privilege diagnosis and `target_diagnose`. `admin-power.mjs` owns only randomized `ptext-live-*` systemd/file fixtures, proves generic systemd lifecycle and Privilege Engine 2.0 provider reuse with live UID-0 proof, deliberately fails an `admin_transaction` health gate, verifies SHA-256 rollback, and removes every disposable artifact in `finally`. `protocol-release.mjs` verifies all 52 extension-owned canonical/legacy tools expose the four MCP annotation booleans while supplied upstream tool objects remain unchanged, then exercises the completed source `target_capabilities`, `target_diagnose`, runtime health/cache/telemetry summaries and lifecycle leak checks against the real target.

### Independent external release gates

Project-authored tests are necessary regression coverage but are not sufficient release evidence. For 0.11.0 the externally maintained black-box gates are:

- official `@modelcontextprotocol/conformance` 0.1.16 against the real HTTP endpoint;
- official MCP Inspector 2.2.0 for independent `tools/list` and `tools/call` execution;
- `npm audit --omit=dev` for the production dependency graph;
- ShellCheck 0.11.0 plus macOS `plutil` for the deployment/rollback shell and LaunchAgent definitions.

Applicable post-deployment MCP Conformance scenarios pass: `server-initialize`, `ping`, `tools-list`, `dns-rebinding-protection` (2/2), and `server-sse-multiple-streams` (2/2). Scenarios that require conformance-only fixture tools are not presented as product failures or successes; they are reported separately rather than silently counted.

The deployed 0.11.0 runtime also passes the repository's 15-phase real restart/failure-injection acceptance, including extension/gateway restart survival, root UID 0, transfer integrity, session/task/forward cleanup, secret redaction and reconnect-storm prevention. A separate eight-iteration Inspector health/diagnose burn-in verifies no lifecycle growth and no multiplex fallback.

The final pre-version Plan C4 verification on `taylan` produced all three success markers (`TRANSPORT_CAPABILITY_LIVE_OK`, `ADMIN_POWER_LIVE_OK`, and `PROTOCOL_RELEASE_LIVE_OK`). Plan A observed `miss=2 hit=4 stale_recovered=1 fallback=0`; Plan B selected `docker_host_root`, restored the original file with verified SHA-256 after a deliberate failed health gate, and left lifecycle counts at zero; Plan C reported Ubuntu 26.04 LTS / kernel `7.0.0-29-generic`, zero failed systemd units, one NVIDIA GPU, available disk/privilege/ai-tmux/cache/telemetry evidence, 52 annotated extension-owned tools and zero lifecycle growth. The same checkpoint passed `322/322` deterministic tests, `SOURCE_CHECK_OK (108 files)`, `THIRD_PARTY_LICENSES_OK (93 packages)`, `npm audit --omit=dev --audit-level=high` with zero vulnerabilities, disposable cleanup, and `git diff --check`.

## Required negative tests for every new tool

Every externally exposed operation should cover, where relevant:

- invalid input before side effects;
- missing local dependency;
- unreachable target;
- host-key/authentication failure;
- timeout;
- remote non-zero exit;
- stale lifecycle ID;
- permission failure;
- malformed upstream result;
- output/size limits;
- interrupted operation and recovery.

## Failure-injection roadmap

The final acceptance suite will deliberately kill/restart local extension processes, interrupt transports, create stale state IDs, break transfers, and verify that unrelated sessions/tasks/forwards survive.

## No-success-by-settings rule

An implementation is not considered complete because a timeout, retry option, or persistence flag exists. The intended behavior must be observed in tests, and live-only semantics must be verified on a real remote target before stable release.
