# Persistent Terminal MCP 0.11 Plan C — Protocol Quality and Release Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish Persistent Terminal MCP 0.11.0 by making the local tool catalog protocol-descriptive, completing target diagnostics and health/telemetry synthesis, proving restart/live behavior, then versioning, deploying, publishing, and verifying the exact release tree without changing the public OAuth identity or upstream `pty-mcp` failure domain.

**Architecture:** A central annotation policy decorates only extension-owned local tools; upstream `pty-mcp` tool objects remain byte-for-byte/passthrough-equivalent. `target-diagnostics.mjs` becomes the bounded read-only diagnostic synthesizer, consuming existing capability, multiplex, system, disk, systemd, GPU, cache, and telemetry primitives; `target-tools.mjs` remains the MCP schema/handler boundary. `health-tool.mjs` exposes bounded extension-runtime performance/cache evidence without payloads or secrets. Release integration uses the existing retained runtime/rollback deployment topology and the standalone public-repository subtree only after the exact 0.11 tree passes deterministic, live, deployment, restart-survival, and leak gates.

**Tech Stack:** Node.js >=22.23.1, `@modelcontextprotocol/sdk` 1.30.0, MCP protocol revision 2025-11-25 semantics, native OpenSSH, systemd, launchd, `pty-mcp v0.11.7`, remote `ai-tmux v0.11.7`, node:test, existing release artifact scripts and 15-phase parent acceptance harness.

## Global Constraints

- Reuse DevSpace workspace `ws_6380abd0cc` and branch `feature/persistent-terminal-extended`; do not create another workspace/worktree.
- Local source, tests, docs, Git, deployment scripts, and release preparation use DevSpace as source of truth.
- Production remains `0.10.0` until Task C5 has completed all pre-deployment release gates.
- Public endpoint/OAuth identity remains `https://pty.taylansoylu.com/mcp` with scope `pty`; topology remains gateway `:9022 -> extension :9031 -> upstream :9021`.
- Upstream `pty-mcp` tool definitions/results are passthrough: do not add or rewrite annotations on upstream tools unless upstream already supplied them.
- MCP annotations are advisory metadata only. They never replace validation, privilege policy, allowlists, secret handling, or confirmation/UI behavior.
- Annotation fields are exactly `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`; every extension-owned local tool must have all four booleans.
- `service_restart` and restart-class actions are not declared idempotent.
- No ambiguous side-effect replay. Mutation transport ambiguity remains a visible failure.
- Diagnostic/health output must remain bounded and secret/payload-free. No command text, file contents, passwords, key paths, environment dumps, or terminal scrollback in telemetry/diagnostics.
- Target-diagnostic state must distinguish `available`, `unavailable`, `not_applicable`, `permission_limited`, and actual `failure` where semantically relevant.
- No new general workflow DSL, multi-host fan-out, binary filesystem API, MCP task augmentation, or persistent journal stream in 0.11.0.
- Disposable live tests may create only randomized test units/files/processes and must clean them in `finally`; production services are never destructive fixtures.
- Public GitHub repositories remain unchanged until the complete 0.11.0 source tree has passed local release gates, live acceptance, deployment probes, restart-survival, and final leak checks.
- No force-push and no moving an existing release tag. A failed immutable release is corrected with a new version.

## File / Responsibility Map

- Create `src/tool-annotations.mjs` — closed annotation policy for all 49 current canonical extension-owned local tools plus the three extension-owned deprecated aliases, and helper that returns annotated copies without touching upstream definitions.
- Create `test/tool-annotations.test.mjs` — exhaustive local annotation coverage, conservative behavior assertions, upstream passthrough, legacy alias inheritance.
- Modify `src/tool-registry.mjs` — publish annotated local tool copies while leaving upstream tools unchanged.
- Modify `src/legacy-aliases.mjs` — deprecated aliases inherit canonical annotations exactly.
- Modify `test/tool-registry.test.mjs`, `test/legacy-aliases.test.mjs`, `test/server-smoke.test.mjs` — protocol list assertions and passthrough fidelity.
- Create `src/target-diagnostics.mjs` — bounded diagnostic aggregation and state normalization.
- Create `test/target-diagnostics.test.mjs` — partial-capability, disk/systemd/GPU, permission-limited, failure-state, telemetry/cache tests.
- Modify `src/target-tools.mjs`, `test/target-tools.test.mjs` — closed `target_diagnose` schema and delegation to diagnostic synthesizer.
- Modify `src/server.mjs` — inject shared runtime dependencies into target diagnostics and health.
- Modify `src/telemetry.mjs`, `test/telemetry.test.mjs` only if additional bounded Plan-C counters/timings are required by diagnostics; never add high-cardinality target/command labels.
- Modify `src/health-tool.mjs`, `test/health-tool.test.mjs` — bounded runtime telemetry/cache/multiplex/privilege summaries with existing lifecycle and gateway/upstream health.
- Create `test/live/protocol-release.mjs` — source-path protocol annotation/diagnostic acceptance and final local control-master cleanup assertions.
- Modify `docs/TESTING.md`, `README.md`, `docs/ROADMAP.md`, `CHANGELOG.md` — current 0.11 behavior and acceptance/release evidence.
- Create `docs/releases/v0.11.0.md` — exact release notes required by `release:check`.
- Modify `package.json`, `package-lock.json` — version `0.11.0` only in Task C5.
- Parent workspace files used but not rewritten unless a failing release test proves a defect: `tests/persistent-terminal-extended-acceptance.mjs`, `install-pty-mcp-stack.sh`, `rollback-pty-extended.sh`, `com.taylan.pty-extended.plist`, `com.taylan.pty-gateway.plist`.

---

### Task C1: Exhaustive MCP annotation policy for local tools

**Files:**
- Create: `src/tool-annotations.mjs`
- Create: `test/tool-annotations.test.mjs`
- Modify: `src/tool-registry.mjs`
- Modify: `src/legacy-aliases.mjs`
- Modify: `test/tool-registry.test.mjs`
- Modify: `test/legacy-aliases.test.mjs`
- Modify: `test/server-smoke.test.mjs`

**Interfaces:**
- Produces `LOCAL_TOOL_ANNOTATIONS: Readonly<Record<string, ToolAnnotations>>`.
- Produces `annotateLocalTool(tool) -> frozen tool copy` and `annotateLocalTools(tools) -> frozen array`.
- `buildToolCatalog()` must append annotated extension-owned tools and untouched upstream tool objects.
- Deprecated aliases targeting extension-owned canonical tools inherit the canonical annotation semantics. `ssh_read_session`, whose canonical target `read_output` is upstream-owned, receives an explicit extension-owned alias annotation without modifying the upstream `read_output` definition.

- [ ] **Step 1: Write exhaustive RED coverage** that imports `LOCAL_TOOLS`, requires every canonical local name to have exactly four boolean hints, and rejects missing/unknown canonical policy entries. Separately require all three generated deprecated aliases to have the same four booleans.

```js
for (const tool of LOCAL_TOOLS) {
  assert.deepEqual(Object.keys(tool.annotations).sort(), [
    'destructiveHint', 'idempotentHint', 'openWorldHint', 'readOnlyHint',
  ]);
  for (const value of Object.values(tool.annotations)) assert.equal(typeof value, 'boolean');
}
```

- [ ] **Step 2: Add behavioral RED assertions** for conservative examples:
  - `system_info`, `remote_stat`, `remote_read`, `target_capabilities`, `target_diagnose` => `readOnlyHint:true`, `destructiveHint:false`;
  - `remote_exec`, `remote_root_exec`, `remote_write`, `remote_patch`, `remote_delete`, `process_signal`, `systemd_unit_action`, `admin_transaction` => `readOnlyHint:false`, `destructiveHint:true`;
  - `service_restart` => `idempotentHint:false`;
  - remote/network tools that contact configured targets => `openWorldHint:true`;
  - purely local registry/status views such as `named_session_list`, `task_list`, `forward_list` => `openWorldHint:false` only if their handlers do not contact the remote/upstream at call time.

- [ ] **Step 3: Add upstream fidelity RED test** with a fake upstream tool carrying its own arbitrary `annotations` and assert strict/deep equality before and after `buildToolCatalog()`.

- [ ] **Step 4: Add legacy alias RED test** requiring `ssh_exec` and `ssh_ensure_session` to inherit local canonical annotation semantics. Require `ssh_read_session` to receive an explicit read-output alias policy while the upstream `read_output` object remains unchanged. Preserve all alias deprecation metadata and schemas.

- [ ] **Step 5: Run RED gate.**

Run:
```bash
node --test test/tool-annotations.test.mjs test/tool-registry.test.mjs test/legacy-aliases.test.mjs test/server-smoke.test.mjs
```
Expected: FAIL because local tools do not yet expose the complete annotation policy.

- [ ] **Step 6: Implement `tool-annotations.mjs`** as an explicit closed policy keyed by every current local tool name. Do not infer destructive behavior from name substrings at runtime; classification must be reviewable in source.

```js
export const LOCAL_TOOL_ANNOTATIONS = Object.freeze({
  system_info: Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }),
  service_restart: Object.freeze({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }),
  // every remaining canonical local tool and the three legacy alias names are explicitly listed
});
```

- [ ] **Step 7: Annotate only local tools in `tool-registry.mjs`** before adding them to the catalog; do not mutate the source tool object and do not route upstream tools through the annotator.

- [ ] **Step 8: Update legacy alias construction** so aliases copy canonical annotations exactly.

- [ ] **Step 9: Run focused GREEN gate and full regression.**

```bash
node --test test/tool-annotations.test.mjs test/tool-registry.test.mjs test/legacy-aliases.test.mjs test/server-smoke.test.mjs
npm test
```

- [ ] **Step 10: Commit.**

```bash
git add src/tool-annotations.mjs src/tool-registry.mjs src/legacy-aliases.mjs \
  test/tool-annotations.test.mjs test/tool-registry.test.mjs test/legacy-aliases.test.mjs test/server-smoke.test.mjs
git commit -m "feat: annotate local MCP tools"
```

---

### Task C2: Complete bounded `target_diagnose` synthesis

**Files:**
- Create: `src/target-diagnostics.mjs`
- Create: `test/target-diagnostics.test.mjs`
- Modify: `src/target-tools.mjs`
- Modify: `test/target-tools.test.mjs`
- Modify: `src/server.mjs`
- Modify: `test/server-smoke.test.mjs`

**Interfaces:**
- Produces `diagnoseTarget({target,refresh}, deps) -> TargetDiagnostic`.
- Consumes `capabilityInventory.get`, `multiplexManager.inspect`, `systemInfoImpl`, `diskUsageImpl`, `gpuInfoImpl`, fixed failed-systemd summary via `remoteExecImpl`, telemetry snapshot, capability-cache snapshot, privilege-engine snapshot.
- `target_diagnose` remains read-only and must not invoke secret/password UI or privileged mutation.

- [ ] **Step 1: Define RED normalized schema/fixture** covering all design evidence:

```js
{
  target,
  state: 'available'|'degraded'|'failure',
  transport: { state, identity, multiplex, failure? },
  remote_identity: { state, user?, uid? },
  system: { state, hostname?, kernel?, architecture?, os?, uptime_seconds?, failure? },
  privilege: { state:'available'|'permission_limited'|'unavailable'|'failure', root_providers, cache },
  ai_tmux: { state:'available'|'unavailable'|'failure', version },
  disk_pressure: { state:'available'|'unavailable'|'failure', highest_use_percent?, root_use_percent?, filesystem_count? },
  failed_systemd_units: { state:'available'|'unavailable'|'permission_limited'|'failure', count? },
  gpu: { state:'available'|'not_applicable'|'failure', count?, provider? },
  capabilities,
  capability_cache,
  telemetry
}
```

- [ ] **Step 2: Write RED partial-capability tests** proving missing `nvidia-smi` becomes GPU `not_applicable`, missing `systemctl` makes failed-unit summary `unavailable`, and password-only root providers yield `permission_limited` without opening a prompt.

- [ ] **Step 3: Write RED failure-domain tests** proving:
  - capability/transport failure => overall `failure` but still returns bounded multiplex/telemetry evidence;
  - system-info failure => `degraded`, not total failure;
  - disk/systemd/GPU sub-probe failure => only that section `failure` and overall `degraded`;
  - telemetry/cache snapshot failure => safe empty/unavailable summary and never execution failure.

- [ ] **Step 4: Write RED disk-pressure normalization tests** using `diskUsage` fixtures. Compute integer/number use percentages from `used_bytes / size_bytes`, expose root mount separately when present, and expose the highest-use filesystem percentage without raw `df` text.

- [ ] **Step 5: Write RED failed-systemd summary test** using one fixed C-locale command with no user interpolation:

```text
systemctl list-units --failed --no-legend --no-pager --plain
```

Count non-empty rows only; cap remote output and classify missing systemd separately from permission/transport failure.

- [ ] **Step 6: Run RED gate.**

```bash
node --test test/target-diagnostics.test.mjs test/target-tools.test.mjs test/server-smoke.test.mjs
```

- [ ] **Step 7: Implement `target-diagnostics.mjs`** with small pure normalizers (`diskPressureView`, `failedUnitView`, `gpuView`, `privilegeView`) and one orchestrator. Parallelize independent read-only sub-probes with `Promise.allSettled` only after the capability inventory establishes transport/identity.

- [ ] **Step 8: Replace the current in-file `diagnoseTarget` logic** in `target-tools.mjs` with delegation to the new module and replace the loose `telemetry: {type:'object'}` with closed bounded schemas.

- [ ] **Step 9: Inject shared production dependencies** from `server.mjs`, including the same privilege-engine/capability-cache snapshots used by execution rather than constructing diagnostic-only caches.

- [ ] **Step 10: Run focused and full GREEN gates.**

```bash
node --test test/target-diagnostics.test.mjs test/target-tools.test.mjs test/server-smoke.test.mjs
npm test
```

- [ ] **Step 11: Commit.**

```bash
git add src/target-diagnostics.mjs src/target-tools.mjs src/server.mjs \
  test/target-diagnostics.test.mjs test/target-tools.test.mjs test/server-smoke.test.mjs
git commit -m "feat: complete target diagnostics"
```

---

### Task C3: Health and telemetry integration without payload leakage

**Files:**
- Modify: `src/health-tool.mjs`
- Modify: `test/health-tool.test.mjs`
- Modify: `src/server.mjs`
- Modify: `test/server-smoke.test.mjs`
- Modify: `src/telemetry.mjs` and `test/telemetry.test.mjs` only if an exact missing aggregate is required.

**Interfaces:**
- `getTerminalHealth(args,deps)` adds a bounded extension-runtime section while preserving current extension/upstream/gateway/counts/targets/diagnostics fields.
- Health dependencies receive shared `telemetry`, `multiplexManager`, `capabilityInventory`, and `privilegeEngine` snapshots.
- No per-command/per-path/per-secret/high-cardinality labels are added.

- [ ] **Step 1: Write RED health-schema test** requiring one stable runtime summary:

```js
runtime: {
  telemetry: { timings: <closed timing map>, counters: <closed counter map> },
  multiplex: { mode, active_masters },
  capability_cache: { entries },
  privilege_cache: { ttl_ms, entries, providers }
}
```

- [ ] **Step 2: Add RED resilience tests** where each injected snapshot throws independently. Health must remain callable and mark only that summary unavailable/defaulted; it must not throw or leak tool arguments.

- [ ] **Step 3: Add RED compatibility test** that existing lifecycle, gateway, upstream, target ai-tmux, reconnect, and failure counters remain present and semantically unchanged.

- [ ] **Step 4: Run RED gate.**

```bash
node --test test/health-tool.test.mjs test/server-smoke.test.mjs test/telemetry.test.mjs
```

- [ ] **Step 5: Implement secret-safe snapshot adapters** in `health-tool.mjs`; prefer existing snapshot methods, normalize to a closed public shape, and never expose ControlPath, SSH hostname/user details from cache internals, command text, or raw logs.

- [ ] **Step 6: Wire the shared runtime instances** from `createProductionRuntime()` into the health handler.

- [ ] **Step 7: Run focused/full quality.**

```bash
node --test test/health-tool.test.mjs test/server-smoke.test.mjs test/telemetry.test.mjs
npm run quality
git diff --check
```

- [ ] **Step 8: Commit.**

```bash
git add src/health-tool.mjs src/server.mjs test/health-tool.test.mjs test/server-smoke.test.mjs
git add src/telemetry.mjs test/telemetry.test.mjs 2>/dev/null || true
git commit -m "feat: expose bounded runtime health metrics"
```

---

### Task C4: Source-path protocol and full live acceptance before version bump

**Files:**
- Create: `test/live/protocol-release.mjs`
- Modify: `docs/TESTING.md`
- Modify: `README.md`
- Modify: `docs/ROADMAP.md`

**Interfaces:**
- `test/live/protocol-release.mjs` runs against source modules/private ControlPath and returns one compact marker `PROTOCOL_RELEASE_LIVE_OK`.
- Parent `tests/persistent-terminal-extended-acceptance.mjs` remains the authoritative 15-phase deployed/restart acceptance later in C6.

- [ ] **Step 1: Write live harness** that takes `PTY_MCP_SMOKE_HOST`, snapshots baseline lifecycle, constructs the production runtime dependencies from source, and verifies `target_capabilities` + completed `target_diagnose` without mutation.

- [ ] **Step 2: Assert real annotation catalog** through an in-memory/source MCP `initialize -> tools/list`: every extension local tool has all four booleans; a supplied fake upstream tool remains unchanged.

- [ ] **Step 3: Assert live diagnostic fields** on `taylan`: transport available, Ubuntu/kernel identity present, disk-pressure available, failed-systemd summary available when systemd exists, GPU either available or `not_applicable`, privilege state available/permission-limited without secret UI, ai-tmux version reported, telemetry/cache shapes bounded.

- [ ] **Step 4: Re-run disposable Plan A and Plan B source acceptances**:

```bash
PTY_MCP_SMOKE_HOST=taylan node test/live/transport-capability.mjs
PTY_MCP_SMOKE_HOST=taylan node test/live/admin-power.mjs
PTY_MCP_SMOKE_HOST=taylan node test/live/protocol-release.mjs
```

- [ ] **Step 5: Run all deterministic pre-version gates**:

```bash
npm run quality
npm audit --omit=dev --audit-level=high
git diff --check
```

- [ ] **Step 6: Verify no disposable remote artifacts** (`ptext-live-*`) and no source-test active session/task/forward/remote-session increase. Close only source-test-owned ControlMasters.

- [ ] **Step 7: Update testing/roadmap docs with exact evidence**, explicitly keeping production on 0.10.0 at this checkpoint.

- [ ] **Step 8: Commit.**

```bash
git add test/live/protocol-release.mjs docs/TESTING.md README.md docs/ROADMAP.md
git commit -m "test: prove protocol quality live"
```

---

### Task C5: Cut the exact 0.11.0 release tree and artifacts before deployment

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `docs/releases/v0.11.0.md`
- Modify: `CHANGELOG.md`
- Modify: `README.md`
- Modify: `docs/ROADMAP.md`
- Test: `test/release-metadata.test.mjs`, `test/release-artifacts.test.mjs`, `test/release-workflow.test.mjs`

**Interfaces:**
- `VERSION` remains single-source from package metadata.
- Release artifact names are `persistent-terminal-mcp-0.11.0.tgz`, `persistent-terminal-mcp-0.11.0-source.tar.gz`, `persistent-terminal-mcp-0.11.0.cdx.json`, plus `SHA256SUMS`.

- [ ] **Step 1: Write/update RED release-metadata expectations** for exact `0.11.0` docs/version consistency before changing package metadata.

- [ ] **Step 2: Run release metadata test and confirm RED.**

```bash
node --test test/release-metadata.test.mjs test/release-artifacts.test.mjs test/release-workflow.test.mjs
```

- [ ] **Step 3: Bump package metadata without creating a Git tag.**

```bash
npm version 0.11.0 --no-git-tag-version
```

- [ ] **Step 4: Write `docs/releases/v0.11.0.md`** with: transport reuse/stale recovery, capability/diagnostic core, Privilege Engine 2.0, generic systemd, verified transaction rollback, MCP annotations, health/telemetry, compatibility notes, live evidence, rollback policy, artifact list, and unchanged OAuth/public topology.

- [ ] **Step 5: Update `CHANGELOG.md`, README release line, and ROADMAP** from “source/not released” to a **release candidate tree** wording; do not claim deployment yet.

- [ ] **Step 6: Run exact pre-commit deterministic release gates.** Source artifacts intentionally come from `git archive` so the versioned candidate must be committed before artifact generation; the artifact builder must fail closed when the working package version and committed source archive version differ.

```bash
npm run quality
npm run release:check
npm audit --omit=dev --audit-level=high
git diff --check
```

- [ ] **Step 7: Commit the immutable release candidate source tree.**

```bash
git add package.json package-lock.json docs/releases/v0.11.0.md CHANGELOG.md README.md docs/ROADMAP.md \
  scripts/release-lib.mjs scripts/build-release-artifacts.mjs \
  test/release-metadata.test.mjs test/release-artifacts.test.mjs \
  docs/superpowers/plans/2026-08-17-persistent-terminal-0.11-plan-c-protocol-release.md
git commit -m "chore: prepare 0.11.0 release"
```

- [ ] **Step 8: Build artifacts from the exact committed candidate tree and verify them.** The source archive's own `package.json`, changelog entry, and `docs/releases/v0.11.0.md` must match the requested version; a mixed working-tree/runtime versus stale-HEAD source artifact is a release-integrity failure.

```bash
npm run release:artifacts
shasum -a 256 -c dist/SHA256SUMS
```

- [ ] **Step 9: Inspect artifact contents** and require no development-only tree in the runtime package, exact `0.11.0` metadata/release notes in the source archive, and successful clean-install smoke from `release:artifacts`. If this gate discovers a source defect, make a corrective commit and rebuild all artifacts from the new HEAD before deployment.

---

### Task C6: Deploy only extension failure domain, prove restart survival, then publish standalone 0.11.0

**Files / systems:**
- Parent workspace: `install-pty-mcp-stack.sh`, `rollback-pty-extended.sh`, `tests/persistent-terminal-extended-acceptance.mjs`
- Runtime: `~/.local/share/persistent-terminal-extended/app`
- Retained rollback: `~/.local/share/persistent-terminal-extended/rollback`
- LaunchAgents: `com.taylan.pty-extended`, `com.taylan.pty-gateway`, upstream `com.taylan.pty-mcp`
- Public remote: `persistent-terminal-public` (`https://github.com/bingoweb/persistent-terminal-mcp.git`)

**Interfaces / required evidence:**
- Deployed extension reports `0.11.0`; upstream remains `pty-mcp v0.11.7` and gateway identity/scope is unchanged.
- Parent 15-phase harness ends with `PERSISTENT_TERMINAL_EXTENDED_ACCEPTANCE_OK phases=15` and proves extension/gateway restart survival while persistent session/task work exists.
- Final production lifecycle: active test sessions/tasks/forwards and remote test sessions return to baseline; reconnect failures are zero or explicitly explained by injected restart tests and recovered state is healthy.

- [ ] **Step 1: Record pre-deployment production baseline** using `terminal_health(targets:['taylan'], include_remote_sessions:true)`, local LaunchAgent states, current runtime version, and retained rollback version.

- [ ] **Step 2: Run the complete 15-phase acceptance against the currently deployed 0.10 runtime once** to ensure the deployment environment itself is not already broken:

```bash
PTY_MCP_SMOKE_HOST=taylan PTY_MCP_SMOKE_USER=bingoweb node tests/persistent-terminal-extended-acceptance.mjs
```

- [ ] **Step 3: Deploy the exact committed 0.11 tree using the existing stack installer**, which stages a new runtime, retains the previous runtime, restarts only the extension first, probes `9031`, and only then refreshes the gateway when needed:

```bash
./install-pty-mcp-stack.sh
```

If the extension functional probe fails, allow the install script's built-in runtime rollback to execute; do not improvise destructive recovery.

- [ ] **Step 4: Perform immediate functional probes**:
  - local `initialize -> tools/list` on `9031`;
  - verify every new local annotation is present;
  - call `target_diagnose(taylan)`;
  - call a harmless `systemd_unit_status`/`system_info`;
  - call `remote_root_exec({target:'taylan',command:'id -u'})` and require UID 0 through a proven provider;
  - verify public gateway health `9022` and public OAuth identity/scope unchanged.

- [ ] **Step 5: Run the full deployed 15-phase acceptance again** and require exact success marker:

```bash
PTY_MCP_SMOKE_HOST=taylan PTY_MCP_SMOKE_USER=bingoweb node tests/persistent-terminal-extended-acceptance.mjs
```

This is the required extension-restart + gateway-restart + persistent-session/task survival proof.

- [ ] **Step 6: Run deployed disposable Plan B/diagnostic acceptance** against the final runtime/catalog, then final `terminal_health`. No production service mutation is allowed.

- [ ] **Step 7: Burn-in/probe loop** for bounded repeated health/list/diagnose calls and confirm no growing active lifecycle counts, no leaked test ControlMasters, no new failed LaunchAgent state, and no rollback trigger.

- [ ] **Step 8: Update release docs with actual deployed evidence** and commit only documentation evidence if values differ from the release-candidate wording. Re-run `npm run quality`, `npm run release:check`, and `git diff --check` after any edit.

- [ ] **Step 9: Build the standalone public tree from the exact monorepo subdirectory and compare before push.**

```bash
git subtree split --prefix=persistent-terminal-extended -b release/persistent-terminal-0.11.0
split_sha="$(git rev-parse release/persistent-terminal-0.11.0)"
git fetch persistent-terminal-public main
git diff --stat persistent-terminal-public/main "$split_sha"
```

Verify the split tree contains package version `0.11.0`, release notes, annotations, diagnostics, Plan B/C code, tests/docs, and no parent workspace secrets/deployment-only files.

- [ ] **Step 10: Push standalone `main` only after all prior gates pass.**

```bash
git push persistent-terminal-public release/persistent-terminal-0.11.0:main
```

- [ ] **Step 11: Create and push the immutable public release tag on the standalone split commit.** First verify no existing tag:

```bash
test -z "$(git ls-remote --tags persistent-terminal-public refs/tags/v0.11.0 refs/tags/v0.11.0^{} )"
git tag -a v0.11.0 "$split_sha" -m "Persistent Terminal MCP v0.11.0"
git push persistent-terminal-public v0.11.0
```

Never move this tag. If the public release workflow fails after publication, diagnose and issue a new patch version rather than rewriting `v0.11.0`.

- [ ] **Step 12: Verify public release artifacts/workflow**: fetch public `main`, verify `package.json` version/tree hash, and verify the tag-triggered GitHub release assets/checksums match the locally built `dist` artifacts.

- [ ] **Step 13: Push the completed development feature branch to parent `origin` only now**, after the whole 0.11 milestone is accepted; do not force-push:

```bash
git push origin feature/persistent-terminal-extended
```

- [ ] **Step 14: Final production leak/health gate** with `terminal_health`, LaunchAgent status, runtime/rollback version, and no disposable artifacts. Record exact evidence in Obsidian.

- [ ] **Step 15: Final milestone checkpoint** in `README.md`/`docs/ROADMAP.md`/Obsidian must distinguish:
  - current deployed/public release `0.11.0`;
  - upstream `pty-mcp v0.11.7`;
  - gateway/public endpoint unchanged;
  - deterministic test/source/license/release counts;
  - full 15-phase restart acceptance success;
  - disposable Plan A/B/C live success;
  - rollback runtime retained;
  - final active session/task/forward/test remote-session leak count.

---

## Plan C final acceptance checklist

- [ ] Every extension-owned local tool has exactly four accurate MCP annotation booleans; upstream tools remain untouched.
- [ ] `target_diagnose` includes transport, identity, OS/kernel, capability inventory, privilege state, ai-tmux, disk pressure, failed-systemd summary, optional GPU state, cache, and bounded telemetry.
- [ ] Diagnostic sections distinguish absence/not-applicable/permission-limit/failure instead of collapsing them.
- [ ] `terminal_health` exposes bounded payload-free runtime telemetry/cache/multiplex/privilege summaries and preserves existing health/lifecycle semantics.
- [ ] All deterministic tests, source checks, license checks, production dependency audit, release metadata checks, artifact build, checksum verification, and clean-install smoke pass on the exact 0.11 tree.
- [ ] Source-path Plan A, Plan B, and Plan C live tests pass on `taylan` with disposable cleanup.
- [ ] Deployed parent 15-phase acceptance passes after 0.11 deployment and proves persistent session/task survival across extension/gateway restart.
- [ ] Production extension reports 0.11.0; upstream/gateway remain healthy and public OAuth identity/scope are unchanged.
- [ ] Retained rollback runtime exists and was not needed after final accepted deployment.
- [ ] No unintended active sessions, tasks, forwards, remote test sessions, disposable units/files, or test ControlMasters remain.
- [ ] Standalone public `main` and immutable `v0.11.0` tag are pushed only after all preceding gates pass, and public release artifacts/checksums are verified.
