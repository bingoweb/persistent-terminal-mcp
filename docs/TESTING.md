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
