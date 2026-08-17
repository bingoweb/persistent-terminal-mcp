import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

import { remoteExec } from '../../src/remote-exec.mjs';
import { runSshCommand } from '../../src/ssh-runner.mjs';
import { createSshMultiplexManager } from '../../src/ssh-multiplex-manager.mjs';
import { createCapabilityInventory } from '../../src/target-capabilities.mjs';
import { callTargetTool } from '../../src/target-tools.mjs';
import { createTelemetry } from '../../src/telemetry.mjs';

const execFileAsync = promisify(execFile);
const HOST = process.env.PTY_MCP_SMOKE_HOST;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  if (!HOST) throw new Error('PTY_MCP_SMOKE_HOST is required');

  const controlDir = await fs.mkdtemp('/tmp/ptext-live-mux-');
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

  try {
    const first = await sharedRemoteExec({
      target: HOST,
      command: "printf 'PTEXT_MUX_FIRST\\n'",
      timeout_ms: 15_000,
      max_output_bytes: 4096,
    });
    assert(first.exit_code === 0 && first.stdout === 'PTEXT_MUX_FIRST\n', `first remote_exec failed: ${JSON.stringify(first)}`);
    const afterFirst = telemetry.snapshot();
    assert(afterFirst.counters.multiplex_miss >= 1, `first command did not create a managed master: ${JSON.stringify(afterFirst)}`);
    assert(manager.inspect(HOST).active === true, `master not active after first command: ${JSON.stringify(manager.inspect(HOST))}`);

    const second = await sharedRemoteExec({
      target: HOST,
      command: "printf 'PTEXT_MUX_SECOND\\n'",
      timeout_ms: 15_000,
      max_output_bytes: 4096,
    });
    assert(second.exit_code === 0 && second.stdout === 'PTEXT_MUX_SECOND\n', `second remote_exec failed: ${JSON.stringify(second)}`);
    const afterSecond = telemetry.snapshot();
    assert(afterSecond.counters.multiplex_hit >= 1, `second command did not reuse managed master: ${JSON.stringify(afterSecond)}`);

    const socketEntries = (await fs.readdir(controlDir)).filter((entry) => entry.startsWith('ctl_'));
    assert(socketEntries.length === 1, `expected exactly one test ControlPath, got ${JSON.stringify(socketEntries)}`);
    const socketPath = path.join(controlDir, socketEntries[0]);

    await execFileAsync('ssh', ['-S', socketPath, '-O', 'exit', HOST], {
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    });
    await fs.rm(socketPath, { force: true });
    await fs.writeFile(socketPath, 'stale-test-owned-control-entry', { mode: 0o600 });

    const recovered = await sharedRemoteExec({
      target: HOST,
      command: "printf 'PTEXT_MUX_RECOVERED\\n'",
      timeout_ms: 15_000,
      max_output_bytes: 4096,
    });
    assert(
      recovered.exit_code === 0 && recovered.stdout === 'PTEXT_MUX_RECOVERED\n',
      `stale-master recovery command failed: ${JSON.stringify(recovered)}`,
    );
    const afterRecovery = telemetry.snapshot();
    assert(
      afterRecovery.counters.multiplex_stale_recovered >= 1,
      `stale master was not classified/recovered: ${JSON.stringify(afterRecovery)}`,
    );

    const capabilitiesFirst = await inventory.get(HOST);
    assert(capabilitiesFirst.cache.status === 'miss', `first capability lookup was not a miss: ${JSON.stringify(capabilitiesFirst.cache)}`);
    const capabilitiesSecond = await inventory.get(HOST);
    assert(capabilitiesSecond.cache.status === 'hit', `second capability lookup was not a hit: ${JSON.stringify(capabilitiesSecond.cache)}`);
    assert(
      capabilitiesSecond.capabilities.python3.available === true,
      `python3 capability unexpectedly unavailable: ${JSON.stringify(capabilitiesSecond.capabilities.python3)}`,
    );

    const diagnosed = await callTargetTool('target_diagnose', { target: HOST }, {
      capabilityInventory: inventory,
      multiplexManager: manager,
      telemetry,
      remoteExecImpl: sharedRemoteExec,
    });
    assert(diagnosed.isError !== true, `target_diagnose returned MCP error: ${JSON.stringify(diagnosed.structuredContent)}`);
    assert(diagnosed.structuredContent.state !== 'failure', `target_diagnose failed: ${JSON.stringify(diagnosed.structuredContent)}`);
    assert(diagnosed.structuredContent.transport.state === 'available', `transport diagnosis unavailable: ${JSON.stringify(diagnosed.structuredContent.transport)}`);
    assert(diagnosed.structuredContent.transport.multiplex.active === true, `diagnosis did not see active multiplex master: ${JSON.stringify(diagnosed.structuredContent.transport)}`);

    const finalTelemetry = telemetry.snapshot();
    assert(finalTelemetry.counters.capability_cache_hit >= 2, `capability cache was not reused by diagnose: ${JSON.stringify(finalTelemetry.counters)}`);

    process.stdout.write(`${JSON.stringify({
      marker: 'TRANSPORT_CAPABILITY_LIVE_OK',
      target: HOST,
      first_duration_ms: first.duration_ms,
      second_duration_ms: second.duration_ms,
      recovered_duration_ms: recovered.duration_ms,
      multiplex: {
        miss: finalTelemetry.counters.multiplex_miss,
        hit: finalTelemetry.counters.multiplex_hit,
        stale_recovered: finalTelemetry.counters.multiplex_stale_recovered,
        fallback: finalTelemetry.counters.multiplex_fallback,
      },
      capability_cache: {
        hit: finalTelemetry.counters.capability_cache_hit,
        miss: finalTelemetry.counters.capability_cache_miss,
        refresh: finalTelemetry.counters.capability_cache_refresh,
      },
      ai_tmux: capabilitiesSecond.capabilities['ai-tmux'],
      privilege_state: diagnosed.structuredContent.privilege.state,
      diagnose_state: diagnosed.structuredContent.state,
    })}\n`);
  } finally {
    await manager.closeAll().catch(() => {});
    await fs.rm(controlDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});

