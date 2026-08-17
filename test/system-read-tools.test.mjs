import assert from 'node:assert/strict';
import test from 'node:test';

import {
  diskUsage,
  gpuInfo,
  journalRead,
  parseDiskUsageOutput,
  parseGpuInfoOutput,
  parsePortListOutput,
  parseProcessListOutput,
  parseServiceStatusOutput,
  parseSystemInfoOutput,
  portList,
  processList,
  serviceStatus,
  systemInfo,
} from '../src/system-helpers.mjs';
import {
  SYSTEM_READ_TOOLS,
  SYSTEM_READ_TOOL_NAMES,
  callSystemReadTool,
} from '../src/system-tools.mjs';
import { LOCAL_TOOLS, callTool } from '../src/tool-registry.mjs';

function remoteResult(stdout, overrides = {}) {
  return {
    exit_code: 0,
    stdout,
    stderr: '',
    duration_ms: 5,
    timed_out: false,
    truncated: false,
    ...overrides,
  };
}

test('system_info parser normalizes representative Ubuntu 26.04 host metadata', () => {
  const parsed = parseSystemInfoOutput([
    'hostname=taylan',
    'kernel=6.17.0-10-generic',
    'architecture=x86_64',
    'os_id=ubuntu',
    'os_version=26.04',
    'os_pretty=Ubuntu 26.04 LTS',
    'uptime_seconds=93784.42',
    '',
  ].join('\n'));

  assert.deepEqual(parsed, {
    hostname: 'taylan',
    kernel: '6.17.0-10-generic',
    architecture: 'x86_64',
    os: {
      id: 'ubuntu',
      version: '26.04',
      pretty_name: 'Ubuntu 26.04 LTS',
    },
    uptime_seconds: 93784.42,
  });
});

test('process_list parser normalizes bounded ps output and helper forces C locale', async () => {
  const fixture = [
    '      1       0 root     Ss    0.1  0.0  93822 systemd',
    '   2417       1 bingoweb Sl    2.5  1.2   8123 node',
    '   4112    2417 bingoweb R+   99.9  0.1     12 ffmpeg',
    '',
  ].join('\n');
  assert.deepEqual(parseProcessListOutput(fixture), [
    { pid: 1, ppid: 0, user: 'root', state: 'Ss', cpu_percent: 0.1, memory_percent: 0, elapsed_seconds: 93822, command: 'systemd' },
    { pid: 2417, ppid: 1, user: 'bingoweb', state: 'Sl', cpu_percent: 2.5, memory_percent: 1.2, elapsed_seconds: 8123, command: 'node' },
    { pid: 4112, ppid: 2417, user: 'bingoweb', state: 'R+', cpu_percent: 99.9, memory_percent: 0.1, elapsed_seconds: 12, command: 'ffmpeg' },
  ]);

  const calls = [];
  const result = await processList(
    { target: 'taylan', limit: 2 },
    { remoteExecImpl: async (request) => { calls.push(request); return remoteResult(fixture); } },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].env.LC_ALL, 'C');
  assert.match(calls[0].command, /ps -eo/);
  assert.match(calls[0].command, /head -n 3/);
  assert.equal(result.processes.length, 2);
  assert.equal(result.results_truncated, true);
  assert.equal(typeof result.raw, 'string');
  assert.equal(result.raw_truncated, false);
});

test('process_list preserves a Linux comm value that contains whitespace', () => {
  assert.deepEqual(
    parseProcessListOutput('   501       1 bingoweb S     0.0  0.1     42 render worker\n'),
    [{
      pid: 501,
      ppid: 1,
      user: 'bingoweb',
      state: 'S',
      cpu_percent: 0,
      memory_percent: 0.1,
      elapsed_seconds: 42,
      command: 'render worker',
    }],
  );
});

test('port_list parser handles IPv4, wildcard and bracketed IPv6 listeners', () => {
  const parsed = parsePortListOutput([
    'tcp LISTEN 0 4096 127.0.0.1:7676 0.0.0.0:* users:(("node",pid=2417,fd=21))',
    'tcp LISTEN 0 128 [::]:22 [::]:* users:(("sshd",pid=917,fd=3))',
    'udp UNCONN 0 0 0.0.0.0:68 0.0.0.0:* users:(("systemd-network",pid=612,fd=19))',
    '',
  ].join('\n'));

  assert.deepEqual(parsed, [
    {
      protocol: 'tcp', state: 'LISTEN', local_address: '127.0.0.1', local_port: 7676,
      peer_address: '0.0.0.0', peer_port: null, process: 'users:(("node",pid=2417,fd=21))',
    },
    {
      protocol: 'tcp', state: 'LISTEN', local_address: '::', local_port: 22,
      peer_address: '::', peer_port: null, process: 'users:(("sshd",pid=917,fd=3))',
    },
    {
      protocol: 'udp', state: 'UNCONN', local_address: '0.0.0.0', local_port: 68,
      peer_address: '0.0.0.0', peer_port: null, process: 'users:(("systemd-network",pid=612,fd=19))',
    },
  ]);
});

test('service_status parses systemctl show and carries the exact unit through env instead of shell interpolation', async () => {
  const fixture = [
    'Id=ssh.service',
    'LoadState=loaded',
    'ActiveState=active',
    'SubState=running',
    'UnitFileState=enabled',
    'MainPID=917',
    '',
  ].join('\n');
  assert.deepEqual(parseServiceStatusOutput(fixture), {
    service: 'ssh.service',
    load_state: 'loaded',
    active_state: 'active',
    sub_state: 'running',
    unit_file_state: 'enabled',
    main_pid: 917,
  });

  const calls = [];
  const result = await serviceStatus(
    { target: 'taylan', service: 'ssh.service' },
    { remoteExecImpl: async (request) => { calls.push(request); return remoteResult(fixture); } },
  );
  assert.equal(calls[0].env.LC_ALL, 'C');
  assert.equal(calls[0].env.PTEXT_UNIT, 'ssh.service');
  assert.equal(calls[0].command.includes('ssh.service'), false);
  assert.match(calls[0].command, /\$PTEXT_UNIT/);
  assert.equal(result.active_state, 'active');
});

test('journal_read and disk_usage normalize representative Ubuntu output with bounded raw context', async () => {
  const journalFixture = [
    '2026-08-17T08:00:01+0300 taylan sshd[917]: Server listening on 0.0.0.0 port 22.',
    '2026-08-17T08:00:02+0300 taylan sshd[917]: Server listening on :: port 22.',
    '',
  ].join('\n');
  const journalCalls = [];
  const journal = await journalRead(
    { target: 'taylan', service: 'ssh.service', lines: 2 },
    { remoteExecImpl: async (request) => { journalCalls.push(request); return remoteResult(journalFixture); } },
  );
  assert.deepEqual(journal.entries, journalFixture.trimEnd().split('\n'));
  assert.equal(journal.service, 'ssh.service');
  assert.equal(journalCalls[0].env.LC_ALL, 'C');
  assert.equal(journalCalls[0].env.PTEXT_SERVICE, 'ssh.service');
  assert.equal(journalCalls[0].env.PTEXT_LINES, '2');
  assert.equal(journalCalls[0].command.includes('ssh.service'), false);

  const diskFixture = [
    'Filesystem       1-blocks        Used   Available Capacity Mounted on',
    '/dev/nvme0n1p2  998663643136 41234567808 906194124800      5% /',
    'tmpfs             33554432000      8192  33554423808      1% /run',
    '',
  ].join('\n');
  assert.deepEqual(parseDiskUsageOutput(diskFixture), [
    { filesystem: '/dev/nvme0n1p2', size_bytes: 998663643136, used_bytes: 41234567808, available_bytes: 906194124800, use_percent: 5, mountpoint: '/' },
    { filesystem: 'tmpfs', size_bytes: 33554432000, used_bytes: 8192, available_bytes: 33554423808, use_percent: 1, mountpoint: '/run' },
  ]);
  const disk = await diskUsage(
    { target: 'taylan' },
    { remoteExecImpl: async () => remoteResult(diskFixture) },
  );
  assert.equal(disk.filesystems.length, 2);
  assert.equal(disk.raw_truncated, false);
});

test('gpu_info normalizes nvidia-smi CSV and treats an absent binary as an explicit unavailable capability', async () => {
  const fixture = [
    '0, NVIDIA RTX A4000, GPU-aaaa, 590.10, 16376, 2048, 34, 51',
    '1, NVIDIA RTX A4000, GPU-bbbb, 590.10, 16376, 1024, 12, 46',
    '',
  ].join('\n');
  assert.deepEqual(parseGpuInfoOutput(fixture), [
    { index: 0, name: 'NVIDIA RTX A4000', uuid: 'GPU-aaaa', driver_version: '590.10', memory_total_mib: 16376, memory_used_mib: 2048, utilization_percent: 34, temperature_c: 51 },
    { index: 1, name: 'NVIDIA RTX A4000', uuid: 'GPU-bbbb', driver_version: '590.10', memory_total_mib: 16376, memory_used_mib: 1024, utilization_percent: 12, temperature_c: 46 },
  ]);

  const presentCalls = [];
  const present = await gpuInfo(
    { target: 'taylan' },
    {
      remoteExecImpl: async (request) => {
        presentCalls.push(request);
        return presentCalls.length === 1 ? remoteResult('') : remoteResult(fixture);
      },
    },
  );
  assert.equal(present.available, true);
  assert.equal(present.gpus.length, 2);
  assert.equal(presentCalls[1].env.LC_ALL, 'C');

  const absentCalls = [];
  const absent = await gpuInfo(
    { target: 'taylan' },
    {
      remoteExecImpl: async (request) => {
        absentCalls.push(request);
        return remoteResult('', { exit_code: 1 });
      },
    },
  );
  assert.deepEqual(absent, {
    target: 'taylan',
    provider: 'nvidia-smi',
    available: false,
    gpus: [],
    raw: '',
    raw_truncated: false,
  });
  assert.equal(absentCalls.length, 1);
});

test('all seven read-only system tools publish canonical bounded schemas and route locally', async () => {
  const expected = [
    'system_info',
    'process_list',
    'port_list',
    'service_status',
    'journal_read',
    'disk_usage',
    'gpu_info',
  ];
  assert.deepEqual(SYSTEM_READ_TOOLS.map((tool) => tool.name), expected);
  assert.deepEqual([...SYSTEM_READ_TOOL_NAMES], expected);
  for (const name of expected) {
    assert.equal(LOCAL_TOOLS.some((tool) => tool.name === name), true, `missing ${name} in LOCAL_TOOLS`);
    const tool = SYSTEM_READ_TOOLS.find((candidate) => candidate.name === name);
    assert.equal(tool.inputSchema.additionalProperties, false, `${name} input must be closed`);
    assert.equal(tool.outputSchema.oneOf.length, 2, `${name} must advertise success + failure`);
  }

  const calls = [];
  const routed = await callTool(
    'system_info',
    { target: 'taylan' },
    {
      upstreamClient: { callTool: async () => { throw new Error('must not call upstream'); } },
      upstreamToolNames: new Set(),
      systemToolCallImpl: async (name, args) => {
        calls.push({ name, args });
        return {
          content: [{ type: 'text', text: JSON.stringify({ target: 'taylan' }) }],
          structuredContent: { target: 'taylan' },
        };
      },
    },
  );
  assert.deepEqual(calls, [{ name: 'system_info', args: { target: 'taylan' } }]);
  assert.deepEqual(routed.structuredContent, { target: 'taylan' });

  await assert.rejects(
    callSystemReadTool('not-a-system-tool', {}, {}),
    (error) => error?.category === 'validation_error',
  );
});

test('port_list helper uses a bounded command and returns one extra row only to signal truncation', async () => {
  const fixture = [
    'tcp LISTEN 0 4096 127.0.0.1:7676 0.0.0.0:*',
    'tcp LISTEN 0 128 [::]:22 [::]:*',
    '',
  ].join('\n');
  const calls = [];
  const result = await portList(
    { target: 'taylan', limit: 1 },
    { remoteExecImpl: async (request) => { calls.push(request); return remoteResult(fixture); } },
  );
  assert.match(calls[0].command, /ss -H -lntup/);
  assert.match(calls[0].command, /head -n 2/);
  assert.equal(calls[0].env.LC_ALL, 'C');
  assert.equal(result.listeners.length, 1);
  assert.equal(result.results_truncated, true);
});

test('system_info helper execution rejects non-zero command status rather than returning partial normalized data', async () => {
  await assert.rejects(
    systemInfo(
      { target: 'taylan' },
      { remoteExecImpl: async () => remoteResult('', { exit_code: 1, stderr: 'hostname failed\n' }) },
    ),
    (error) => error?.category === 'remote_command_nonzero_exit'
      && error?.details?.target === 'taylan'
      && error?.details?.exit_code === 1,
  );
});
