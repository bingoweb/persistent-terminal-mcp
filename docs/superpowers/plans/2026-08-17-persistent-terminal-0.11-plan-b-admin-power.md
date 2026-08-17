# Persistent Terminal MCP 0.11 Plan B — Administrative Power Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make privileged administration faster and broader by adding a proof-preserving privilege provider cache, generic systemd unit administration, and bounded transactional mutation with health-gated rollback.

**Architecture:** `privilege-engine.mjs` sits above the existing secret-safe root providers and may cache only non-secret provider preference; every cached provider is re-proved before a privileged command. `systemd-core.mjs` owns exact unit validation, parse-stable read helpers, and a closed action vocabulary; `systemd-tools.mjs` exposes generic read/mutation tools while legacy service tools route to the same execution core. `admin-transaction.mjs` orchestrates only enumerated canonical mutations (`systemd_action`, `remote_write`, `remote_patch`) with bounded precheck, snapshots, health gates and verified rollback; it is deliberately not a shell workflow DSL.

**Tech Stack:** Node.js >=22.23.1, native OpenSSH/systemd, MCP SDK 1.30.0, existing `remote_exec`, `remote_root_exec`, structured remote filesystem helper, node:test.

## Global Constraints

- Reuse DevSpace workspace `ws_6380abd0cc` and branch `feature/persistent-terminal-extended`; never create another worktree.
- All local source/test/Git changes use DevSpace only.
- Every behavior change follows RED -> GREEN -> REFACTOR and ends in fresh full regression.
- Production remains 0.10.0 until Plan C; Plan B is source-branch work only.
- Public GitHub remains unchanged until the complete 0.11 milestone.
- Root execution remains controlled by `PTEXT_ROOT_TARGETS`; Plan B does not broaden the target policy beyond the existing explicit aliases / `*` policy.
- Secret-based sudo/su providers are never cached as an automatic selection and are never invoked until privilege need is established and the upstream PTY confirms an active password prompt.
- Cached non-secret privilege providers (`direct_root`, `sudo_nopasswd`, `docker_host_root`) are hints only. Every privileged mutation must re-prove the selected provider before command dispatch.
- An ordinary non-permission command failure must never cause privilege escalation.
- Generic systemd unit values must be exact validated unit names; user-controlled unit/action values are not accepted as arbitrary shell syntax.
- Supported unit suffixes: `.service`, `.socket`, `.timer`, `.path`, `.mount`, `.automount`, `.target`, `.slice`, `.scope`.
- Systemd action vocabulary is closed to: `start`, `stop`, `restart`, `reload`, `try-restart`, `reload-or-restart`, `enable`, `disable`, `reenable`, `mask`, `unmask`, `reset-failed` plus separate `systemd_daemon_reload`.
- `admin_transaction` supports one mutation only and is bounded: max 8 health checks, max 1 MiB UTF-8 rollback snapshot per file, no binary rollback snapshot, no arbitrary nested transaction/DAG/loop syntax.
- Transaction rollback is best-effort but may be reported `succeeded=true` only after post-rollback verification.
- Transaction result never returns backed-up file content, password material, private-key material or full arbitrary environment dumps.
- Ambiguous transport loss after a mutation is not replayed automatically; existing at-most-once side-effect rule remains binding.

---

## File structure

New modules:

- `src/privilege-engine.mjs` — TTL provider preference, capability filtering, proof-preserving root execution wrapper.
- `src/systemd-core.mjs` — generic unit validator, read parsers/helpers, action mapping and execution metadata.
- `src/systemd-tools.mjs` — MCP schemas and handlers for generic systemd tools.
- `src/admin-transaction.mjs` — bounded orchestration state machine, snapshot/health/rollback engine.
- `src/admin-tools.mjs` — MCP schema/handler for `admin_transaction`.

Modified modules:

- `src/root-exec.mjs` — provider attempts become orderable/filterable internally while public `remote_root_exec` contract stays compatible; each attempted provider still performs proof.
- `src/system-tools.mjs` — legacy service mutations/status route through generic systemd core and shared privilege engine.
- `src/system-helpers.mjs` — retain legacy helper exports but delegate service validation/status where possible.
- `src/tool-registry.mjs` — publish/route generic systemd and admin tools.
- `src/server.mjs` — construct one production privilege engine and inject shared filesystem/systemd/admin dependencies.
- `src/telemetry.mjs` — existing `root_provider` timing is populated by the new engine; no new payload-bearing metric surface.
- `README.md`, `docs/ROADMAP.md` — update only after deterministic + live gates pass.

Tests:

- `test/privilege-engine.test.mjs`
- `test/root-exec.test.mjs`
- `test/systemd-core.test.mjs`
- `test/systemd-tools.test.mjs`
- `test/system-mutation-tools.test.mjs`
- `test/admin-transaction.test.mjs`
- `test/admin-tools.test.mjs`
- `test/server-smoke.test.mjs`
- `test/live/admin-power.mjs`

---

### Task B1: Privilege Engine 2.0 — cached preference, mandatory re-proof

**Files:**
- Create: `persistent-terminal-extended/src/privilege-engine.mjs`
- Create: `persistent-terminal-extended/test/privilege-engine.test.mjs`
- Modify: `persistent-terminal-extended/src/root-exec.mjs`
- Modify: `persistent-terminal-extended/test/root-exec.test.mjs`
- Modify: `persistent-terminal-extended/src/server.mjs`
- Modify: `persistent-terminal-extended/test/server-smoke.test.mjs`

**Interfaces:**

```js
createPrivilegeEngine({
  ttlMs,
  capabilityInventory,
  rootExecImpl,
  now,
  telemetry,
}) -> {
  execute(request, deps),
  invalidate(target?),
  snapshot(),
}
```

`execute({target,command,timeout_ms?,max_output_bytes?}, deps)` returns the existing root result shape plus no new secret-bearing state.

`remoteRootExec(request, deps)` gains internal-only optional dependencies:

```js
providerOrder?: ['direct_root'|'sudo_nopasswd'|'docker_host_root'|'sudo_password'|'su_root_password'][]
capabilityHint?: {
  direct_root?: boolean,
  sudo_nopasswd?: boolean,
  docker_host_root?: boolean,
  sudo_password?: boolean,
  su_root_password?: boolean,
}
```

These alter which provider is tried first/skipped, but they never bypass that provider's live proof.

- [ ] **Step 1: Write RED tests for root provider ordering/filtering.** Prove default order is unchanged, a preferred `docker_host_root` order skips known unavailable sudo only when the capability hint marks it unavailable, and a hinted provider still executes its live UID-0 proof before the requested command.
- [ ] **Step 2: Run `node --test test/root-exec.test.mjs`** and confirm RED because `providerOrder/capabilityHint` are ignored.
- [ ] **Step 3: Refactor root provider dispatch minimally.** Keep current provider-specific proof/secret code, but iterate a validated closed provider order. Do not duplicate interactive password logic.
- [ ] **Step 4: Run root tests GREEN and full `npm test`.**
- [ ] **Step 5: Write privilege-engine RED tests** for first cache miss, cached non-secret strategy preference, TTL expiry, capability identity refresh, cache invalidation after proof failure, password provider never cached, concurrent calls not corrupting cache, and telemetry `root_provider` timing.
- [ ] **Step 6: Add a proof-failure regression:** first call caches `sudo_nopasswd`; second call receives a capability hint that still says sudo available but live sudo proof fails; engine must evict preference and allow the normal chain to select another proven provider rather than execute through stale sudo.
- [ ] **Step 7: Run `node --test test/privilege-engine.test.mjs`** and confirm RED.
- [ ] **Step 8: Implement `createPrivilegeEngine`.** Use `target_capabilities` inventory only as a skip/order hint. Cache only `direct_root|sudo_nopasswd|docker_host_root` and only when the returned strategy was actually selected by `remoteRootExec`.
- [ ] **Step 9: Wire one shared privilege engine into production runtime** so explicit root execution and systemd mutations use the same preference cache while the public `remote_root_exec` tool response remains backward-compatible.
- [ ] **Step 10: Run focused tests, then `npm run quality` and `git diff --check`.**
- [ ] **Step 11: Commit** as `feat: add proof-preserving privilege engine`.

### Task B2: Generic systemd read model

**Files:**
- Create: `persistent-terminal-extended/src/systemd-core.mjs`
- Create: `persistent-terminal-extended/test/systemd-core.test.mjs`
- Create: `persistent-terminal-extended/src/systemd-tools.mjs`
- Create: `persistent-terminal-extended/test/systemd-tools.test.mjs`
- Modify: `persistent-terminal-extended/src/system-helpers.mjs`
- Modify: `persistent-terminal-extended/src/system-tools.mjs`
- Modify: `persistent-terminal-extended/src/tool-registry.mjs`

**Interfaces:**

```js
validateSystemdUnit(unit) -> exact string
systemdUnitStatus({target,unit}, {remoteExecImpl}) -> normalized object
systemdUnitList({target,type?,limit?}, {remoteExecImpl}) -> normalized bounded list
systemdUnitDependencies({target,unit}, {remoteExecImpl}) -> {requires,wants,before,after,conflicts}
```

New canonical read-only MCP tools:

```text
systemd_unit_status
systemd_unit_list
systemd_unit_dependencies
```

- [ ] **Step 1: Write unit-validation RED tests** covering every allowed suffix and rejecting whitespace, shell metacharacters, path traversal, no suffix and unsupported suffixes.
- [ ] **Step 2: Write parser RED tests** for representative service/socket/timer/mount/target status, bounded list output and dependency properties containing zero/multiple units.
- [ ] **Step 3: Run `node --test test/systemd-core.test.mjs`** and confirm RED.
- [ ] **Step 4: Implement parse-stable commands.** Status uses fixed `systemctl show --no-pager` properties with `PTEXT_UNIT` in env. Dependencies use fixed `systemctl show` properties (`Requires`, `Wants`, `Before`, `After`, `Conflicts`) rather than parsing tree glyphs. List uses a validated optional unit type and bounded output.
- [ ] **Step 5: Run core tests GREEN.**
- [ ] **Step 6: Write MCP RED tests** for closed schemas, bounded limit, canonical registry publication/routing and secret-safe failures.
- [ ] **Step 7: Implement `systemd-tools.mjs` read handlers and registry routing.**
- [ ] **Step 8: Route legacy `service_status` through the generic status core** and retain its existing public result shape (`service` field) for compatibility.
- [ ] **Step 9: Run generic + legacy tests GREEN, then full `npm test`.**
- [ ] **Step 10: Commit** as `feat: add generic systemd inspection`.

### Task B3: Generic systemd mutation engine and legacy service compatibility

**Files:**
- Modify: `persistent-terminal-extended/src/systemd-core.mjs`
- Modify: `persistent-terminal-extended/src/systemd-tools.mjs`
- Modify: `persistent-terminal-extended/test/systemd-core.test.mjs`
- Modify: `persistent-terminal-extended/test/systemd-tools.test.mjs`
- Modify: `persistent-terminal-extended/src/system-tools.mjs`
- Modify: `persistent-terminal-extended/test/system-mutation-tools.test.mjs`
- Modify: `persistent-terminal-extended/src/server.mjs`

**Interfaces:**

Canonical mutation tools:

```text
systemd_unit_action
systemd_daemon_reload
```

`systemd_unit_action` input:

```js
{
  target: string,
  unit: string,
  action: 'start'|'stop'|'restart'|'reload'|'try-restart'|'reload-or-restart'|
          'enable'|'disable'|'reenable'|'mask'|'unmask'|'reset-failed',
  privilege?: 'auto'|'user'|'root'
}
```

Result includes `action,target,unit,requested_privilege,actual_privilege,strategy,exit_code,...`.

- [ ] **Step 1: Write action-mapping RED tests** proving every allowed action maps to exactly one static systemctl verb and arbitrary action text is rejected before remote execution.
- [ ] **Step 2: Write privilege RED tests:** `auto` executes user mode first; only classified permission denial escalates via shared privilege engine; missing unit/non-permission exit stays user and is not escalated; `user` never escalates; `root` invokes privilege engine immediately.
- [ ] **Step 3: Write `systemd_daemon_reload` RED test** as inherently root-oriented by default but still reporting requested/actual privilege explicitly. `privilege:'user'` may be requested as a strict no-escalation diagnostic/action attempt.
- [ ] **Step 4: Run focused tests RED.**
- [ ] **Step 5: Implement generic mutation execution** with unit passed as structured env for user-mode command and closed validated unit/action when constructing privileged execution metadata. Do not accept arbitrary shell fragments.
- [ ] **Step 6: Route `service_start|stop|restart` through the generic engine** while translating the generic result back to the existing legacy service result schema.
- [ ] **Step 7: Run generic/legacy mutation tests GREEN.**
- [ ] **Step 8: Run `npm run quality` and `git diff --check`.**
- [ ] **Step 9: Commit** as `feat: add generic systemd administration`.

### Task B4: Bounded `admin_transaction` with verified rollback

**Files:**
- Create: `persistent-terminal-extended/src/admin-transaction.mjs`
- Create: `persistent-terminal-extended/test/admin-transaction.test.mjs`
- Create: `persistent-terminal-extended/src/admin-tools.mjs`
- Create: `persistent-terminal-extended/test/admin-tools.test.mjs`
- Modify: `persistent-terminal-extended/src/tool-registry.mjs`
- Modify: `persistent-terminal-extended/src/server.mjs`

**Interfaces:**

Canonical MCP tool:

```text
admin_transaction
```

Bounded public input:

```js
{
  target: string,
  privilege?: 'auto'|'user'|'root',
  precheck?: {
    command: string,
    expected_exit_code?: integer, // default 0
  },
  mutation:
    | { type:'systemd_action', unit:string, action:<systemd action> }
    | { type:'remote_write', path:string, text:string, expected_sha256?:string }
    | { type:'remote_patch', path:string, expected_sha256?:string, hunks:[...] },
  health_checks: [
    | { type:'command', command:string, expected_exit_code?:integer, stdout_regex?:string }
    | { type:'systemd_unit', unit:string, active_state?:string, sub_state?:string }
  ], // 1..8
  rollback_on_failure?: boolean // default true
}
```

Transaction engine dependencies are canonical primitives, not shell adapters:

```js
createAdminTransactionEngine({
  remoteExecImpl,
  systemdActionImpl,
  systemdStatusImpl,
  remoteStatImpl,
  remoteReadImpl,
  remoteWriteImpl,
  remotePatchImpl,
  randomIdImpl,
})
```

- [ ] **Step 1: Write validation/state RED tests**: exact target, one mutation, 1..8 health checks, regex length bound, UTF-8 snapshot size <=1 MiB, no binary rollback snapshot, no nested/unknown mutation types.
- [ ] **Step 2: Write success RED test** for precheck -> file snapshot -> remote_write mutation -> passing command health -> commit. Verify result contains SHA/path metadata but not original/new file contents.
- [ ] **Step 3: Write failed-health + successful-rollback RED test** for remote_write: capture original text/hash, mutate, fail health, restore original with optimistic expected hash, re-read/re-hash, then report rollback succeeded.
- [ ] **Step 4: Write rollback-conflict RED test**: an external change after mutation causes expected-hash rollback conflict; transaction must return original health failure plus `rollback.attempted=true, succeeded=false` and the rollback failure, never claim success.
- [ ] **Step 5: Write systemd-action rollback RED tests** using pre-status. For start/stop/restart-class operations, restore the pre-transaction active state where meaningful and verify with status. For enable/disable/mask family, snapshot/restore unit-file state only where the mapping is deterministic; unsupported inverse combinations must be rejected before mutation rather than guessed.
- [ ] **Step 6: Run transaction tests RED.**
- [ ] **Step 7: Implement the transaction state machine** with explicit phases (`precheck`, `snapshot`, `mutation`, `health`, `rollback`, `verify`, `committed|rolled_back|rollback_failed`). Keep rollback material in process memory only and exclude it from public result/logging.
- [ ] **Step 8: Implement health checks** with bounded output and regex compilation before mutation. A health check transport failure counts as failed health and follows rollback policy; it is not replayed.
- [ ] **Step 9: Implement `admin-tools.mjs` closed MCP schema/handler and registry routing.**
- [ ] **Step 10: Wire shared production dependencies** so transaction systemd actions use the shared privilege engine and file operations use the structured remote filesystem layer.
- [ ] **Step 11: Run focused tests GREEN, then `npm run quality` and `git diff --check`.**
- [ ] **Step 12: Commit** as `feat: add transactional administration`.

### Task B5: Disposable live systemd + rollback acceptance and Plan B checkpoint

**Files:**
- Create: `persistent-terminal-extended/test/live/admin-power.mjs`
- Modify: `persistent-terminal-extended/README.md`
- Modify: `persistent-terminal-extended/docs/ROADMAP.md`
- Update Obsidian: `MCP Radar/Persistent Terminal MCP v0.11 - High-Trust Power Core.md`

**Interfaces / live fixtures:**

- Unit name is randomized: `ptext-live-<random>.service`.
- Unit/config paths are disposable and contain only the random test ID.
- Creation/removal uses the new shared privilege path or existing explicit root primitive; no production service is modified.
- Every destructive step has `finally` cleanup with daemon-reload after removal.

- [ ] **Step 1: Write live harness** that records baseline MCP lifecycle health and creates one disposable systemd unit under `/etc/systemd/system/` with a harmless `/bin/sh` command.
- [ ] **Step 2: Exercise generic read tools** (`status`, bounded list, dependencies) against the disposable unit.
- [ ] **Step 3: Exercise mutations** start -> status active/succeeded -> stop -> status inactive, plus enable/disable or mask/unmask only on the disposable unit.
- [ ] **Step 4: Re-run safe privilege proof** through the new privilege engine and verify selected non-secret provider preference is reused but re-proved.
- [ ] **Step 5: Exercise `admin_transaction` rollback** on a disposable UTF-8 config file: mutation deliberately makes a health check fail, rollback restores the original SHA/content, and verification proves the rollback rather than trusting the write response.
- [ ] **Step 6: Cleanup in `finally`:** stop/disable/unmask as needed, delete test unit/config, daemon-reload, remove any test-only artifacts. Do not touch unrelated units.
- [ ] **Step 7: Fresh final `npm run quality`, live acceptance, `git diff --check`, and production `terminal_health`.** Require no active session/task/forward/remote ai-tmux leak attributable to the test.
- [ ] **Step 8: Update README/Roadmap and Obsidian** with exact deterministic totals, live root strategy, disposable unit lifecycle, rollback verification and any bug discovered by live testing.
- [ ] **Step 9: Commit** as `test: prove administrative power core live`.

---

## Plan B completion gate

Plan B is complete only when:

- cached provider preference never bypasses live root proof;
- password providers are not cached/auto-selected before confirmed privilege need;
- generic systemd read/action tools support every specified suffix/action with closed validation;
- legacy service tools remain behaviorally compatible;
- ordinary missing-unit/application errors do not trigger root escalation;
- `admin_transaction` demonstrates successful commit, failed health + verified rollback, and rollback-failure truthfulness;
- live acceptance uses only disposable units/config and cleanup is verified;
- deterministic quality, license and source checks are green;
- production 0.10 runtime remains healthy/unchanged until Plan C;
- Obsidian contains the exact Plan B checkpoint before Plan C begins.

