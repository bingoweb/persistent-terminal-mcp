# Persistent Terminal MCP 0.11 Plan A — Transport and Capability Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add managed OpenSSH multiplex reuse, bounded latency telemetry, a TTL capability inventory, and canonical `target_capabilities` / partial `target_diagnose` tools without weakening existing SSH, secret, or persistence guarantees.

**Architecture:** `ssh-multiplex-manager.mjs` owns only ControlMaster lifecycle and returns argv fragments/metadata to `ssh-runner.mjs`; it never reimplements SSH authentication. `telemetry.mjs` stores payload-free bounded aggregate timings. `target-capabilities.mjs` performs one bounded remote probe script and caches normalized results by resolved SSH identity. `target-tools.mjs` publishes/handles read-only MCP tools and synthesizes transport/capability diagnostics. All new behavior is injectable and falls back to the current one-shot SSH path in multiplex `auto` mode.

**Tech Stack:** Node.js >=22.23.1, native OpenSSH, MCP SDK 1.30.0, node:test, existing `remote_exec` / target resolver / diagnostic patterns.

## Global Constraints

- Work only in existing DevSpace workspace `ws_6380abd0cc` on `feature/persistent-terminal-extended`.
- Do not create another worktree or reset/clean/revert unrelated work.
- Every production behavior change follows RED -> GREEN -> REFACTOR.
- `PTEXT_SSH_MULTIPLEX=auto` is the production default; `off` preserves prior semantics; `required` fails rather than silently falling back.
- ControlMaster storage is private (`0700` directory), runtime-owned, and uses hashed target identity rather than raw host/user strings in socket names.
- Existing OpenSSH host-key/authentication semantics remain authoritative; no `StrictHostKeyChecking=no` or equivalent bypass is introduced.
- Multiplex failure in `auto` mode must never make an otherwise valid one-shot command unavailable.
- Telemetry must not store command text, stdin, file contents, credentials, arbitrary environment values, control socket paths, or secret prompts.
- Capability absence is a cacheable result, not a tool failure.
- Capability cache default TTL is 120 seconds; concurrent refreshes for the same identity share one promise.
- Public capability/diagnostic results contain normalized facts only and never raw SSH key material or raw environment dumps.
- Existing 0.10.0 release metadata is not bumped during Plan A; versioning/deployment belongs to Plan C.
- Public GitHub is not updated until the complete 0.11 milestone; local feature commits are allowed for independently reviewable tasks.

---

## File structure

New focused modules:

- `src/telemetry.mjs` — bounded timing/counter aggregation only.
- `src/ssh-multiplex-manager.mjs` — ControlMaster directory, identity hashing, single-flight creation, health, fallback state, idle cleanup.
- `src/target-capabilities.mjs` — target identity key, one bounded remote inventory probe, TTL/single-flight cache, normalized capability result.
- `src/target-tools.mjs` — MCP schemas/validation/handlers for `target_capabilities` and Plan-A `target_diagnose`.

Modified modules:

- `src/config.mjs` — parse multiplex and capability TTL settings.
- `src/ssh-runner.mjs` — ask manager for multiplex argv, record timings, fall back only in `auto`.
- `src/remote-exec.mjs` — preserve normalized result contract while allowing runner metadata to remain internal.
- `src/diagnostics.mjs` — expose aggregate transport/capability telemetry snapshot without payload data.
- `src/tool-registry.mjs` — publish and route target tools locally.
- `src/server.mjs` — create one production multiplex manager/telemetry/capability cache and inject them into the server call path.
- `src/health-tool.mjs` — Plan A adds bounded transport/capability diagnostic metadata only if schema remains stable and tests prove no payload leakage.
- `README.md`, `docs/ROADMAP.md` — document Plan A only after deterministic and live gates pass.

Tests:

- `test/config-transport.test.mjs`
- `test/telemetry.test.mjs`
- `test/ssh-multiplex-manager.test.mjs`
- `test/remote-exec.test.mjs`
- `test/target-capabilities.test.mjs`
- `test/target-tools.test.mjs`
- `test/server-smoke.test.mjs`
- `test/health-tool.test.mjs` if health integration is included during Plan A.
- `test/live/transport-capability.mjs` for disposable live acceptance.

---

### Task 1: Transport configuration and payload-free telemetry foundation

**Files:**
- Create: `persistent-terminal-extended/test/config-transport.test.mjs`
- Create: `persistent-terminal-extended/test/telemetry.test.mjs`
- Modify: `persistent-terminal-extended/src/config.mjs`
- Create: `persistent-terminal-extended/src/telemetry.mjs`

**Interfaces:**
- Produces `readSshMultiplexConfig(env)` -> frozen `{ mode, controlPersistSeconds, maxTargets }`.
- Produces `readCapabilityCacheConfig(env)` -> frozen `{ ttlMs }`.
- Produces `createTelemetry(options?)` with `recordTiming(metric, durationMs)`, `incrementCounter(metric)`, `snapshot()`, and `reset()`.

- [ ] **Step 1: Write config RED tests** for default `auto/300/32`, accepted `off|auto|required`, positive integer bounds, and capability TTL `120000ms` default.
- [ ] **Step 2: Run `node --test test/config-transport.test.mjs`** and confirm failure because the new readers do not exist.
- [ ] **Step 3: Implement minimal config readers** with closed validation; invalid production env must throw a clear `TypeError` rather than silently changing semantics.
- [ ] **Step 4: Run config tests GREEN.**
- [ ] **Step 5: Write telemetry RED tests** proving bounded counter saturation, count/sum/min/max + fixed latency buckets, rejection of unknown metric names, immutable snapshots, and no API accepting arbitrary payload objects.
- [ ] **Step 6: Run `node --test test/telemetry.test.mjs`** and confirm expected missing-module/API failure.
- [ ] **Step 7: Implement minimal telemetry aggregator** using a fixed allowlist of metrics (`ssh_master_acquire`, `ssh_handshake`, `remote_execution`, `capability_probe`, `filesystem_helper`, `root_provider`, `transfer_runtime`) and counters (`multiplex_hit`, `multiplex_miss`, `multiplex_fallback`, `multiplex_stale_recovered`, `capability_cache_hit`, `capability_cache_miss`, `capability_cache_refresh`).
- [ ] **Step 8: Run telemetry tests GREEN, then `npm test`** to prove no regression.
- [ ] **Step 9: Commit** as `feat: add transport telemetry foundation`.

### Task 2: Managed SSH ControlMaster pool

**Files:**
- Create: `persistent-terminal-extended/src/ssh-multiplex-manager.mjs`
- Create: `persistent-terminal-extended/test/ssh-multiplex-manager.test.mjs`
- Modify: `persistent-terminal-extended/src/ssh-runner.mjs`
- Modify: `persistent-terminal-extended/test/remote-exec.test.mjs`

**Interfaces:**
- Produces `createSshMultiplexManager({ env, homeDir, spawnImpl, execFileImpl, fsImpl, now, telemetry })`.
- Manager method `acquire(target)` returns `{ args, state }`, where `args` is either `[]` for one-shot/fallback or `['-o','ControlMaster=no','-o', 'ControlPath=<private-path>']` for reuse; `state` is `off|hit|miss|fallback|stale_recovered`.
- Manager method `snapshot()` returns only bounded aggregate/master metadata without socket paths.
- Manager method `closeIdle()` and `closeAll()` affect only runtime-owned masters.
- `runSshCommand(..., { multiplexManager, telemetry })` prepends manager-provided SSH options before the target while preserving existing remote-command construction.

- [ ] **Step 1: Write manager RED tests** for private directory `0700`, stable SHA-256-based socket name, `off`, healthy `-O check` hit, miss/create, stale recovery, `auto` fallback, `required` failure, max-target eviction/cleanup, and no raw target name in socket basename.
- [ ] **Step 2: Add concurrency RED test** where two `acquire('test-host')` calls share one master-creation promise.
- [ ] **Step 3: Run manager tests RED** and verify failures are feature absence, not fixture errors.
- [ ] **Step 4: Implement manager minimally** using native `ssh -MNf`, explicit `ControlMaster=yes`, `ControlPersist=<seconds>`, private `ControlPath`, and `ssh -O check/exit`. Never change host-key/auth options.
- [ ] **Step 5: Run manager tests GREEN.**
- [ ] **Step 6: Add runner RED tests**: healthy manager injects control path; `off/fallback` preserves exact previous argv; `required` acquisition failure prevents command spawn; manager metadata never appears in public command result.
- [ ] **Step 7: Run remote-exec tests RED.**
- [ ] **Step 8: Integrate manager into `runSshCommand`** with acquisition timing and fallback semantics. Ordinary command still uses `BatchMode=yes`; multiplex master establishment also remains non-interactive.
- [ ] **Step 9: Run remote-exec + manager tests GREEN, then full `npm test`.**
- [ ] **Step 10: Commit** as `feat: add managed ssh multiplex pool`.

### Task 3: TTL capability inventory and `target_capabilities`

**Files:**
- Create: `persistent-terminal-extended/src/target-capabilities.mjs`
- Create: `persistent-terminal-extended/test/target-capabilities.test.mjs`
- Create/Modify: `persistent-terminal-extended/src/target-tools.mjs`
- Create/Modify: `persistent-terminal-extended/test/target-tools.test.mjs`
- Modify: `persistent-terminal-extended/src/tool-registry.mjs`

**Interfaces:**
- `createCapabilityInventory({ ttlMs, resolveTargetImpl, remoteExecImpl, now, telemetry })` returns `{ get(target,{refresh}), invalidate(target?), snapshot() }`.
- `get()` returns normalized `{ target, identity, user, uid, capabilities, root_providers, collected_at, expires_at, cache }`.
- Capability entries use `{ available:boolean, version:string|null }` where version is safely discoverable; root providers are booleans only and password-based providers are reported as available-capability without opening a prompt.
- Canonical MCP tool `target_capabilities({target,refresh=false})` routes locally.

- [ ] **Step 1: Write inventory RED tests** for target validation, normalized identity key, one probe call, unavailable-command caching, TTL hit/miss, forced refresh, identity-change invalidation, transport failure non-caching, and concurrent single-flight refresh.
- [ ] **Step 2: Define the fixed probe contract in the test**: one C-locale shell script emits line-oriented `key=value` fields for UID/user and command availability/version; it must not dump environment or SSH config.
- [ ] **Step 3: Run inventory tests RED.**
- [ ] **Step 4: Implement parser/cache minimally**; cache only successful normalized inventories, including negative capability results.
- [ ] **Step 5: Run inventory tests GREEN.**
- [ ] **Step 6: Write `target_capabilities` MCP RED tests** for closed schema, refresh validation, canonical catalog presence, local routing, failure normalization, and absence of key/password/control-path fields.
- [ ] **Step 7: Run target-tool tests RED.**
- [ ] **Step 8: Implement target tool schema/handler and registry routing.**
- [ ] **Step 9: Run target-tool + tool-registry + server smoke tests GREEN, then full `npm test`.**
- [ ] **Step 10: Commit** as `feat: add target capability inventory`.

### Task 4: Plan-A `target_diagnose` and production dependency wiring

**Files:**
- Modify: `persistent-terminal-extended/src/target-tools.mjs`
- Modify: `persistent-terminal-extended/test/target-tools.test.mjs`
- Modify: `persistent-terminal-extended/src/server.mjs`
- Modify: `persistent-terminal-extended/test/server-smoke.test.mjs`
- Modify: `persistent-terminal-extended/src/diagnostics.mjs`
- Modify: `persistent-terminal-extended/test/diagnostics.test.mjs`

**Interfaces:**
- `target_diagnose({target,refresh=false})` in Plan A returns transport/capability scope only: resolved alias summary (hostname may be included; identity-file path/key bytes may not), connectivity result, multiplex state, remote OS/kernel/user identity, capability inventory, non-interactive root-provider availability, ai-tmux capability, and target-relevant telemetry/cache counters.
- Plan C may extend the result, but Plan A fields are stable and schema-validated.
- Production runtime owns one telemetry instance, one multiplex manager, and one capability inventory instance so cache/pool reuse survives across calls within the extension process.

- [ ] **Step 1: Write diagnose RED tests** for full-capability host, partial-capability host, transport failure, distinction among `available|unavailable|permission_limited|failure`, and payload-leak sentinel rejection.
- [ ] **Step 2: Run target-tool tests RED.**
- [ ] **Step 3: Implement bounded diagnosis synthesis** without mutations or password prompts.
- [ ] **Step 4: Write server-wiring RED test** proving two remote calls share the same injected manager/inventory rather than constructing per-call instances.
- [ ] **Step 5: Run server test RED.**
- [ ] **Step 6: Wire production dependencies** through `createProductionRuntime` -> `createServer` -> `callTool` while preserving dependency injection used by existing tests.
- [ ] **Step 7: Extend diagnostics snapshot only with fixed aggregate telemetry** and update schemas/tests; do not add per-command history.
- [ ] **Step 8: Run target/diagnostics/server tests GREEN, then `npm run quality`.**
- [ ] **Step 9: Commit** as `feat: add target diagnostics and shared transport runtime`.

### Task 5: Disposable live acceptance, docs, and Plan A checkpoint

**Files:**
- Create: `persistent-terminal-extended/test/live/transport-capability.mjs`
- Modify: `persistent-terminal-extended/README.md`
- Modify: `persistent-terminal-extended/docs/ROADMAP.md`
- Update Obsidian: `MCP Radar/Persistent Terminal MCP v0.11 - High-Trust Power Core.md`

**Interfaces:**
- Live test uses `PTY_MCP_SMOKE_HOST` and creates no persistent production configuration on the target.
- Test cleanup closes any runtime-owned ControlMaster created by the fixture and leaves existing ai-tmux/session/task/forward state unchanged.

- [ ] **Step 1: Write live acceptance script** that snapshots remote-session/lifecycle state, performs a first and repeated harmless command, verifies multiplex reuse, force-closes only the test-owned master, verifies stale recovery, calls capability inventory twice to prove cache behavior, runs `target_diagnose`, and performs cleanup in `finally`.
- [ ] **Step 2: Run deterministic `npm run quality` before live work.** Expected: all tests + source + license gates pass.
- [ ] **Step 3: Run live acceptance against `taylan`** with only disposable/read-only operations.
- [ ] **Step 4: Re-run final health/leak checks**: no new named sessions/tasks/forwards/remote ai-tmux sessions; no unintended test ControlMaster remains after explicit cleanup.
- [ ] **Step 5: Update README/Roadmap** with measured behavior and exact caveats. Do not claim benchmark gains from a single sample; record reuse proof and representative latency separately.
- [ ] **Step 6: Update Obsidian checkpoint** with commits, test totals, live evidence, unresolved Plan B work, and any operational setting introduced.
- [ ] **Step 7: Run `git diff --check`, `npm run quality`, and `git status --short`.**
- [ ] **Step 8: Commit Plan A docs/live gate** as `test: prove transport capability core live`.

---

## Plan A completion gate

Plan A is complete only if all of the following are true:

- deterministic suite is fully green;
- multiplex `off`, `auto`, and `required` semantics are covered;
- a repeated real command on `taylan` demonstrably reuses one ControlMaster in `auto` mode;
- killing only the owned master is recovered without touching persistent ai-tmux state;
- `target_capabilities` caches both present and absent capabilities and refresh works;
- `target_diagnose` is read-only and secret-safe;
- telemetry is aggregate/bounded and payload-free;
- cleanup proves no test-owned master/session/task/forward leak;
- Obsidian contains the exact checkpoint before Plan B starts.

