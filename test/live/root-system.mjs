import process from 'node:process';

import { remoteExec } from '../../src/remote-exec.mjs';
import { remoteRootExec } from '../../src/root-exec.mjs';
import {
  diskUsage,
  gpuInfo,
  serviceStatus,
  systemInfo,
} from '../../src/system-helpers.mjs';
import { PtyUpstreamClient } from '../../src/upstream-pty.mjs';

const HOST = process.env.PTY_MCP_SMOKE_HOST;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  if (!HOST) throw new Error('PTY_MCP_SMOKE_HOST is required');

  const upstreamClient = new PtyUpstreamClient();
  try {
    const ordinary = await remoteExec({
      target: HOST,
      command: 'id -u',
      timeout_ms: 10_000,
      max_output_bytes: 4096,
    });
    assert(ordinary.exit_code === 0, `ordinary id -u failed: ${JSON.stringify(ordinary)}`);
    const ordinaryUid = Number.parseInt(ordinary.stdout.trim(), 10);
    assert(Number.isInteger(ordinaryUid), `ordinary id -u was not numeric: ${JSON.stringify(ordinary)}`);
    assert(ordinaryUid !== 0, `ordinary remote_exec unexpectedly ran as root: ${JSON.stringify(ordinary)}`);

    const root = await remoteRootExec(
      {
        target: HOST,
        command: 'id -u',
        timeout_ms: 30_000,
        max_output_bytes: 65_536,
      },
      {
        env: {
          ...process.env,
          PTEXT_ROOT_TARGETS: HOST,
        },
        upstreamClient,
      },
    );
    assert(root.exit_code === 0, `remote_root_exec failed: ${JSON.stringify(root)}`);
    assert(root.stdout.trim() === '0', `remote_root_exec did not run as UID 0: ${JSON.stringify(root)}`);
    assert(typeof root.strategy === 'string' && root.strategy.length > 0, `missing root strategy: ${JSON.stringify(root)}`);
    assert(Array.isArray(root.attempts) && root.attempts.length > 0, `missing root attempt audit: ${JSON.stringify(root)}`);
    assert(root.attempts.at(-1)?.status === 'selected', `root strategy was not selected explicitly: ${JSON.stringify(root)}`);
    assert(root.attempts.at(-1)?.strategy === root.strategy, `selected strategy mismatch: ${JSON.stringify(root)}`);

    const info = await systemInfo({ target: HOST });
    assert(info.target === HOST, `system_info target mismatch: ${JSON.stringify(info)}`);
    assert(typeof info.hostname === 'string' && info.hostname.length > 0, `system_info hostname missing: ${JSON.stringify(info)}`);
    assert(typeof info.kernel === 'string' && info.kernel.length > 0, `system_info kernel missing: ${JSON.stringify(info)}`);
    assert(info.uptime_seconds >= 0, `system_info uptime invalid: ${JSON.stringify(info)}`);

    const disk = await diskUsage({ target: HOST });
    assert(disk.target === HOST, `disk_usage target mismatch: ${JSON.stringify(disk)}`);
    assert(Array.isArray(disk.filesystems) && disk.filesystems.length > 0, `disk_usage returned no filesystems: ${JSON.stringify(disk)}`);
    assert(disk.filesystems.some((entry) => entry.mountpoint === '/'), `disk_usage did not include root filesystem: ${JSON.stringify(disk)}`);

    const gpu = await gpuInfo({ target: HOST });
    assert(gpu.target === HOST, `gpu_info target mismatch: ${JSON.stringify(gpu)}`);
    assert(gpu.provider === 'nvidia-smi', `gpu_info provider mismatch: ${JSON.stringify(gpu)}`);
    assert(typeof gpu.available === 'boolean', `gpu_info availability missing: ${JSON.stringify(gpu)}`);
    if (gpu.available) assert(gpu.gpus.length > 0, `gpu_info available but no GPUs returned: ${JSON.stringify(gpu)}`);

    const service = await serviceStatus({ target: HOST, service: 'ssh.service' });
    assert(service.target === HOST, `service_status target mismatch: ${JSON.stringify(service)}`);
    assert(service.service === 'ssh.service', `service_status unit mismatch: ${JSON.stringify(service)}`);
    assert(service.load_state === 'loaded', `ssh.service is not loaded: ${JSON.stringify(service)}`);

    process.stdout.write(
      `EXTENDED_ROOT_SYSTEM_OK ordinary_uid=${ordinaryUid} root_strategy=${root.strategy} hostname=${info.hostname} gpu_available=${gpu.available} ssh_state=${service.active_state}\n`,
    );
  } finally {
    await upstreamClient.close().catch(() => {});
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});
