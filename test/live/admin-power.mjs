import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import process from 'node:process';

import { createAdminTransactionEngine } from '../../src/admin-transaction.mjs';
import { getTerminalHealth } from '../../src/health-tool.mjs';
import { createPrivilegeEngine } from '../../src/privilege-engine.mjs';
import { callRemoteFs } from '../../src/remote-fs-client.mjs';
import { remoteExec } from '../../src/remote-exec.mjs';
import { remoteRootExec } from '../../src/root-exec.mjs';
import { createSshMultiplexManager } from '../../src/ssh-multiplex-manager.mjs';
import { runSshCommand } from '../../src/ssh-runner.mjs';
import {
  systemdDaemonReload,
  systemdUnitAction,
  systemdUnitDependencies,
  systemdUnitList,
  systemdUnitStatus,
} from '../../src/systemd-core.mjs';
import { createCapabilityInventory } from '../../src/target-capabilities.mjs';
import { createTelemetry } from '../../src/telemetry.mjs';
import { PtyUpstreamClient } from '../../src/upstream-pty.mjs';

const HOST = process.env.PTY_MCP_SMOKE_HOST;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function quotePosix(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function activeCounts(health) {
  return {
    sessions: health.counts.sessions.active,
    tasks: health.counts.tasks.active,
    forwards: health.counts.forwards.active,
    remote_sessions: health.targets.find((entry) => entry.target === HOST)?.remote_sessions ?? null,
  };
}

function assertNoLifecycleIncrease(before, after) {
  for (const field of ['sessions', 'tasks', 'forwards']) {
    assert(
      after[field] <= before[field],
      `live admin acceptance leaked ${field}: before=${before[field]} after=${after[field]}`,
    );
  }
  if (before.remote_sessions !== null && after.remote_sessions !== null) {
    assert(
      after.remote_sessions <= before.remote_sessions,
      `live admin acceptance leaked remote ai-tmux sessions: before=${before.remote_sessions} after=${after.remote_sessions}`,
    );
  }
}

async function main() {
  if (!HOST) throw new Error('PTY_MCP_SMOKE_HOST is required');

  const id = `ptext-live-${process.pid}-${randomUUID().slice(0, 8)}`;
  assert(/^ptext-live-[0-9]+-[0-9a-f-]+$/u.test(id), `unsafe live fixture id: ${id}`);
  const unit = `${id}.service`;
  const unitPath = `/etc/systemd/system/${unit}`;
  const markerPath = `/tmp/${id}.marker`;
  const configPath = `/tmp/${id}.conf`;
  const unitText = [
    '[Unit]',
    `Description=Persistent Terminal MCP disposable acceptance ${id}`,
    'After=network.target',
    '',
    '[Service]',
    'Type=oneshot',
    `ExecStart=/usr/bin/touch ${markerPath}`,
    'RemainAfterExit=yes',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n');
  const encodedUnit = Buffer.from(unitText, 'utf8').toString('base64');

  const controlDir = await fs.mkdtemp('/tmp/ptext-admin-live-mux-');
  await fs.chmod(controlDir, 0o700);
  const telemetry = createTelemetry();
  const manager = createSshMultiplexManager({
    env: {
      ...process.env,
      PTEXT_SSH_MULTIPLEX: 'auto',
      PTEXT_SSH_CONTROL_PERSIST_SECONDS: '120',
      PTEXT_SSH_CONTROL_MAX_TARGETS: '4',
    },
    controlDir,
    telemetry,
  });
  const sharedRemoteExec = (request) => remoteExec(request, {
    runner: (target, runnerRequest) => runSshCommand(target, runnerRequest, {
      multiplexManager: manager,
      telemetry,
    }),
  });
  const inventory = createCapabilityInventory({
    env: {
      ...process.env,
      PTEXT_CAPABILITY_CACHE_TTL_SECONDS: '120',
    },
    remoteExecImpl: sharedRemoteExec,
    telemetry,
  });
  const upstreamClient = new PtyUpstreamClient();
  const rootProviderExec = (request, deps = {}) => remoteRootExec(request, {
    env: {
      ...process.env,
      PTEXT_ROOT_TARGETS: HOST,
    },
    remoteExecImpl: sharedRemoteExec,
    upstreamClient: deps.upstreamClient ?? upstreamClient,
    providerOrder: deps.providerOrder,
    capabilityHint: deps.capabilityHint,
  });
  const privilegeEngine = createPrivilegeEngine({
    capabilityInventory: inventory,
    rootExecImpl: rootProviderExec,
    telemetry,
  });
  const rootExec = (request) => privilegeEngine.execute(request, { upstreamClient });
  const systemdAction = (request) => systemdUnitAction(request, {
    remoteExecImpl: sharedRemoteExec,
    rootExecImpl: rootExec,
  });
  const systemdStatus = (request) => systemdUnitStatus(request, { remoteExecImpl: sharedRemoteExec });
  const remoteFs = ({ target, ...request }) => callRemoteFs(target, request, { execImpl: sharedRemoteExec });
  const transactionEngine = createAdminTransactionEngine({
    remoteExecImpl: sharedRemoteExec,
    systemdActionImpl: systemdAction,
    systemdStatusImpl: systemdStatus,
    remoteStatImpl: ({ target, path }) => remoteFs({ target, op: 'stat', path }),
    remoteReadImpl: ({ target, path }) => remoteFs({ target, op: 'read', path }),
    remoteWriteImpl: ({ target, path, text, expected_sha256 }) => remoteFs({
      target, op: 'write', path, text, expected_sha256,
    }),
    remotePatchImpl: ({ target, path, hunks, expected_sha256 }) => remoteFs({
      target, op: 'patch', path, hunks, expected_sha256,
    }),
  });

  let baseline = null;
  let finalHealth = null;
  let rootStrategy = null;
  try {
    baseline = await getTerminalHealth(
      { targets: [HOST], include_remote_sessions: true },
      { upstreamClient, remoteExecImpl: sharedRemoteExec },
    );
    assert(baseline.extension.healthy === true, `baseline extension unhealthy: ${JSON.stringify(baseline)}`);
    assert(baseline.upstream.healthy === true, `baseline upstream unhealthy: ${JSON.stringify(baseline)}`);

    const createUnit = await rootExec({
      target: HOST,
      command: `printf %s ${quotePosix(encodedUnit)} | base64 -d > ${quotePosix(unitPath)} && chmod 0644 ${quotePosix(unitPath)}`,
      timeout_ms: 30_000,
      max_output_bytes: 65_536,
    });
    assert(createUnit.exit_code === 0, `disposable unit creation failed: ${JSON.stringify(createUnit)}`);
    rootStrategy = createUnit.strategy;

    const reload = await systemdDaemonReload(
      { target: HOST, privilege: 'root' },
      { remoteExecImpl: sharedRemoteExec, rootExecImpl: rootExec },
    );
    assert(reload.exit_code === 0, `daemon-reload failed: ${JSON.stringify(reload)}`);

    const initial = await systemdStatus({ target: HOST, unit });
    assert(initial.load_state === 'loaded', `disposable unit not loaded: ${JSON.stringify(initial)}`);
    assert(initial.active_state === 'inactive', `disposable unit unexpectedly active: ${JSON.stringify(initial)}`);

    const dependencies = await systemdUnitDependencies(
      { target: HOST, unit },
      { remoteExecImpl: sharedRemoteExec },
    );
    assert(Array.isArray(dependencies.after), `dependency inspection malformed: ${JSON.stringify(dependencies)}`);
    const started = await systemdAction({ target: HOST, unit, action: 'start', privilege: 'root' });
    assert(started.exit_code === 0 && started.actual_privilege === 'root', `start failed: ${JSON.stringify(started)}`);
    const active = await systemdStatus({ target: HOST, unit });
    assert(active.active_state === 'active' && active.sub_state === 'exited', `start status mismatch: ${JSON.stringify(active)}`);
    const listed = await systemdUnitList(
      { target: HOST, type: 'service', limit: 200 },
      { remoteExecImpl: sharedRemoteExec },
    );
    assert(
      listed.units.some((entry) => entry.unit === unit),
      `bounded service list did not include active disposable unit: ${JSON.stringify(listed.units)}`,
    );

    const stopped = await systemdAction({ target: HOST, unit, action: 'stop', privilege: 'root' });
    assert(stopped.exit_code === 0, `stop failed: ${JSON.stringify(stopped)}`);
    const inactive = await systemdStatus({ target: HOST, unit });
    assert(inactive.active_state === 'inactive', `stop status mismatch: ${JSON.stringify(inactive)}`);

    const enabled = await systemdAction({ target: HOST, unit, action: 'enable', privilege: 'root' });
    assert(enabled.exit_code === 0, `enable failed: ${JSON.stringify(enabled)}`);
    const enabledStatus = await systemdStatus({ target: HOST, unit });
    assert(enabledStatus.unit_file_state === 'enabled', `enable state mismatch: ${JSON.stringify(enabledStatus)}`);
    const disabled = await systemdAction({ target: HOST, unit, action: 'disable', privilege: 'root' });
    assert(disabled.exit_code === 0, `disable failed: ${JSON.stringify(disabled)}`);
    const disabledStatus = await systemdStatus({ target: HOST, unit });
    assert(disabledStatus.unit_file_state === 'disabled', `disable state mismatch: ${JSON.stringify(disabledStatus)}`);

    const rootProof1 = await rootExec({ target: HOST, command: 'id -u' });
    const cacheAfterFirstProof = privilegeEngine.snapshot();
    const rootProof2 = await rootExec({ target: HOST, command: 'id -u' });
    const cacheAfterSecondProof = privilegeEngine.snapshot();
    assert(rootProof1.stdout.trim() === '0' && rootProof2.stdout.trim() === '0', 'privilege proof did not run as UID 0');
    assert(rootProof1.strategy === rootProof2.strategy, `root provider preference changed unexpectedly: ${rootProof1.strategy} -> ${rootProof2.strategy}`);
    assert(rootProof2.attempts?.[0]?.strategy === rootProof2.strategy && rootProof2.attempts?.[0]?.status === 'selected', `cached provider was not re-proved live: ${JSON.stringify(rootProof2.attempts)}`);
    assert(cacheAfterFirstProof.entries === 1 && cacheAfterSecondProof.entries === 1, `privilege provider cache was not stable: ${JSON.stringify({ cacheAfterFirstProof, cacheAfterSecondProof })}`);
    rootStrategy = rootProof2.strategy;

    const original = await remoteFs({ target: HOST, op: 'write', path: configPath, text: 'original\n' });
    assert(/^[0-9a-f]{64}$/u.test(original.sha256), `initial config SHA missing: ${JSON.stringify(original)}`);
    const transaction = await transactionEngine.execute({
      target: HOST,
      privilege: 'auto',
      mutation: {
        type: 'remote_write',
        path: configPath,
        text: 'mutated\n',
        expected_sha256: original.sha256,
      },
      health_checks: [{
        type: 'command',
        command: `grep -qx ${quotePosix('this-health-check-must-fail')} ${quotePosix(configPath)}`,
        expected_exit_code: 0,
      }],
      rollback_on_failure: true,
    });
    assert(transaction.state === 'rolled_back', `transaction did not roll back: ${JSON.stringify(transaction)}`);
    assert(transaction.health.passed === false, `transaction health unexpectedly passed: ${JSON.stringify(transaction.health)}`);
    assert(transaction.rollback.attempted === true && transaction.rollback.succeeded === true && transaction.rollback.verified === true, `rollback was not verified: ${JSON.stringify(transaction.rollback)}`);
    const restored = await remoteFs({ target: HOST, op: 'read', path: configPath });
    assert(restored.sha256 === original.sha256, `rollback SHA mismatch: ${JSON.stringify({ original: original.sha256, restored: restored.sha256 })}`);
    assert(restored.text === 'original\n', `rollback content mismatch: ${JSON.stringify(restored)}`);

    finalHealth = await getTerminalHealth(
      { targets: [HOST], include_remote_sessions: true },
      { upstreamClient, remoteExecImpl: sharedRemoteExec },
    );
    assertNoLifecycleIncrease(activeCounts(baseline), activeCounts(finalHealth));

    const metrics = telemetry.snapshot();
    process.stdout.write(`${JSON.stringify({
      marker: 'ADMIN_POWER_LIVE_OK',
      target: HOST,
      unit,
      root_strategy: rootStrategy,
      initial_state: initial.active_state,
      started_state: `${active.active_state}/${active.sub_state}`,
      stopped_state: inactive.active_state,
      enabled_state: enabledStatus.unit_file_state,
      disabled_state: disabledStatus.unit_file_state,
      privilege_cache: cacheAfterSecondProof,
      transaction: {
        state: transaction.state,
        rollback_succeeded: transaction.rollback.succeeded,
        rollback_verified: transaction.rollback.verified,
        restored_sha256: restored.sha256,
      },
      lifecycle_before: activeCounts(baseline),
      lifecycle_after: activeCounts(finalHealth),
      multiplex: {
        miss: metrics.counters.multiplex_miss,
        hit: metrics.counters.multiplex_hit,
        stale_recovered: metrics.counters.multiplex_stale_recovered,
        fallback: metrics.counters.multiplex_fallback,
      },
    })}\n`);
  } finally {
    await systemdAction({ target: HOST, unit, action: 'stop', privilege: 'root' }).catch(() => {});
    await systemdAction({ target: HOST, unit, action: 'disable', privilege: 'root' }).catch(() => {});
    await rootExec({
      target: HOST,
      command: `rm -f ${quotePosix(unitPath)} ${quotePosix(markerPath)} ${quotePosix(configPath)}`,
      timeout_ms: 30_000,
      max_output_bytes: 65_536,
    }).catch(() => {});
    await systemdDaemonReload(
      { target: HOST, privilege: 'root' },
      { remoteExecImpl: sharedRemoteExec, rootExecImpl: rootExec },
    ).catch(() => {});
    await manager.closeAll().catch(() => {});
    await fs.rm(controlDir, { recursive: true, force: true }).catch(() => {});
    await upstreamClient.close().catch(() => {});
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});
