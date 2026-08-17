import { TerminalError } from './errors.mjs';
import { remoteExec } from './remote-exec.mjs';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_OUTPUT_BYTES = 262_144;
const RAW_CONTEXT_BYTES = 16_384;
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 200;
const DEFAULT_JOURNAL_LINES = 100;
const MAX_JOURNAL_LINES = 500;
const SERVICE_UNIT = /^[A-Za-z0-9_.@:-]+\.service$/u;

const SYSTEM_INFO_COMMAND = [
  `printf 'hostname=%s\\n' "$(hostname)"`,
  `printf 'kernel=%s\\n' "$(uname -r)"`,
  `printf 'architecture=%s\\n' "$(uname -m)"`,
  'if [ -r /etc/os-release ]; then . /etc/os-release; else ID=unknown; VERSION_ID=unknown; PRETTY_NAME=unknown; fi',
  `printf 'os_id=%s\\n' "$ID"`,
  `printf 'os_version=%s\\n' "$VERSION_ID"`,
  `printf 'os_pretty=%s\\n' "$PRETTY_NAME"`,
  `awk '{printf "uptime_seconds=%s\\n", $1}' /proc/uptime`,
].join('; ');

const SERVICE_STATUS_COMMAND = [
  'systemctl show --no-pager',
  '--property=Id',
  '--property=LoadState',
  '--property=ActiveState',
  '--property=SubState',
  '--property=UnitFileState',
  '--property=MainPID',
  '"$PTEXT_SERVICE"',
].join(' ');

const NVIDIA_QUERY_COMMAND = [
  'nvidia-smi',
  '--query-gpu=index,name,uuid,driver_version,memory.total,memory.used,utilization.gpu,temperature.gpu',
  '--format=csv,noheader,nounits',
].join(' ');

function validateRequest(request, label) {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    throw new TerminalError('validation_error', `${label} request must be an object`);
  }
  if (typeof request.target !== 'string' || request.target.trim() === '') {
    throw new TerminalError('validation_error', 'target must be a non-empty string');
  }
  if (request.target.includes('\0')) {
    throw new TerminalError('validation_error', 'target must not contain NUL bytes');
  }
  return request.target.trim();
}

function validateInteger(value, field, fallback, maximum) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new TerminalError(
      'validation_error',
      `${field} must be an integer between 1 and ${maximum}`,
    );
  }
  return value;
}

export function validateServiceUnit(service) {
  if (typeof service !== 'string' || !SERVICE_UNIT.test(service)) {
    throw new TerminalError(
      'validation_error',
      'service must be an exact .service unit name containing only safe systemd unit characters',
    );
  }
  return service;
}

function malformed(label, details) {
  return new TerminalError(
    'local_capability_dependency_error',
    `${label} returned output that could not be normalized`,
    details === undefined ? undefined : { details },
  );
}

function numberField(value, label, { integer = false } = {}) {
  const parsed = integer ? Number.parseInt(value, 10) : Number.parseFloat(value);
  if (!Number.isFinite(parsed)) throw malformed(label, { value });
  return parsed;
}

function rawContext(stdout) {
  const source = typeof stdout === 'string' ? stdout : '';
  const buffer = Buffer.from(source, 'utf8');
  if (buffer.length <= RAW_CONTEXT_BYTES) {
    return { raw: source, raw_truncated: false };
  }
  return {
    raw: buffer.subarray(0, RAW_CONTEXT_BYTES).toString('utf8'),
    raw_truncated: true,
  };
}

async function execute(
  target,
  command,
  {
    env = {},
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
    remoteExecImpl = remoteExec,
    label = 'System helper command',
  } = {},
) {
  const result = await remoteExecImpl({
    target,
    command,
    env: { LC_ALL: 'C', ...env },
    timeout_ms: timeoutMs,
    max_output_bytes: maxOutputBytes,
  });

  if (result?.timed_out === true) {
    throw new TerminalError('timeout', `${label} timed out`, {
      retryable: true,
      details: { target },
    });
  }
  if (result?.truncated === true) {
    throw new TerminalError(
      'local_capability_dependency_error',
      `${label} output exceeded the bounded parse limit`,
      { details: { target, max_output_bytes: maxOutputBytes } },
    );
  }
  if (result?.exit_code !== 0) {
    throw new TerminalError(
      'remote_command_nonzero_exit',
      result?.stderr || `${label} exited with status ${result?.exit_code}`,
      {
        details: {
          target,
          exit_code: result?.exit_code,
          stderr: result?.stderr ?? '',
        },
      },
    );
  }
  return result;
}

function keyValueLines(stdout) {
  const values = new Map();
  for (const line of String(stdout ?? '').split(/\r?\n/u)) {
    if (!line) continue;
    const equals = line.indexOf('=');
    if (equals <= 0) continue;
    values.set(line.slice(0, equals), line.slice(equals + 1));
  }
  return values;
}

export function parseSystemInfoOutput(stdout) {
  const values = keyValueLines(stdout);
  const required = ['hostname', 'kernel', 'architecture', 'os_id', 'os_version', 'os_pretty', 'uptime_seconds'];
  for (const key of required) {
    if (!values.has(key)) throw malformed('system_info', { missing: key });
  }
  return {
    hostname: values.get('hostname'),
    kernel: values.get('kernel'),
    architecture: values.get('architecture'),
    os: {
      id: values.get('os_id'),
      version: values.get('os_version'),
      pretty_name: values.get('os_pretty'),
    },
    uptime_seconds: numberField(values.get('uptime_seconds'), 'system_info uptime'),
  };
}

export function parseProcessListOutput(stdout) {
  const processes = [];
  for (const line of String(stdout ?? '').split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const columns = line.trim().split(/\s+/u);
    if (columns.length < 8) throw malformed('process_list', { line });
    processes.push({
      pid: numberField(columns[0], 'process pid', { integer: true }),
      ppid: numberField(columns[1], 'process ppid', { integer: true }),
      user: columns[2],
      state: columns[3],
      cpu_percent: numberField(columns[4], 'process cpu percent'),
      memory_percent: numberField(columns[5], 'process memory percent'),
      elapsed_seconds: numberField(columns[6], 'process elapsed seconds', { integer: true }),
      command: columns.slice(7).join(' '),
    });
  }
  return processes;
}

function parseEndpoint(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw malformed(label, { value });
  let address;
  let portText;
  if (value.startsWith('[')) {
    const close = value.lastIndexOf(']:');
    if (close < 0) throw malformed(label, { value });
    address = value.slice(1, close);
    portText = value.slice(close + 2);
  } else {
    const colon = value.lastIndexOf(':');
    if (colon < 0) throw malformed(label, { value });
    address = value.slice(0, colon);
    portText = value.slice(colon + 1);
  }
  const port = portText === '*' ? null : numberField(portText, `${label} port`, { integer: true });
  if (port !== null && (port < 0 || port > 65535)) throw malformed(label, { value });
  return { address, port };
}

export function parsePortListOutput(stdout) {
  const listeners = [];
  for (const line of String(stdout ?? '').split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const match = line.trim().match(/^(\S+)\s+(\S+)\s+\S+\s+\S+\s+(\S+)\s+(\S+)(?:\s+(.*))?$/u);
    if (!match) throw malformed('port_list', { line });
    const local = parseEndpoint(match[3], 'local endpoint');
    const peer = parseEndpoint(match[4], 'peer endpoint');
    listeners.push({
      protocol: match[1],
      state: match[2],
      local_address: local.address,
      local_port: local.port,
      peer_address: peer.address,
      peer_port: peer.port,
      process: match[5] ?? '',
    });
  }
  return listeners;
}

export function parseServiceStatusOutput(stdout) {
  const values = keyValueLines(stdout);
  for (const key of ['Id', 'LoadState', 'ActiveState', 'SubState', 'MainPID']) {
    if (!values.has(key)) throw malformed('service_status', { missing: key });
  }
  return {
    service: values.get('Id'),
    load_state: values.get('LoadState'),
    active_state: values.get('ActiveState'),
    sub_state: values.get('SubState'),
    unit_file_state: values.get('UnitFileState') || null,
    main_pid: numberField(values.get('MainPID'), 'service MainPID', { integer: true }),
  };
}

export function parseDiskUsageOutput(stdout) {
  const lines = String(stdout ?? '').split(/\r?\n/u).filter((line) => line.trim());
  if (lines.length === 0) return [];
  const filesystems = [];
  for (const line of lines.slice(1)) {
    const match = line.trim().match(/^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(.+)$/u);
    if (!match) throw malformed('disk_usage', { line });
    filesystems.push({
      filesystem: match[1],
      size_bytes: numberField(match[2], 'disk size', { integer: true }),
      used_bytes: numberField(match[3], 'disk used', { integer: true }),
      available_bytes: numberField(match[4], 'disk available', { integer: true }),
      use_percent: numberField(match[5], 'disk use percent', { integer: true }),
      mountpoint: match[6],
    });
  }
  return filesystems;
}

export function parseGpuInfoOutput(stdout) {
  const gpus = [];
  for (const line of String(stdout ?? '').split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const columns = line.split(',').map((value) => value.trim());
    if (columns.length !== 8) throw malformed('gpu_info', { line });
    gpus.push({
      index: numberField(columns[0], 'gpu index', { integer: true }),
      name: columns[1],
      uuid: columns[2],
      driver_version: columns[3],
      memory_total_mib: numberField(columns[4], 'gpu memory total', { integer: true }),
      memory_used_mib: numberField(columns[5], 'gpu memory used', { integer: true }),
      utilization_percent: numberField(columns[6], 'gpu utilization', { integer: true }),
      temperature_c: numberField(columns[7], 'gpu temperature', { integer: true }),
    });
  }
  return gpus;
}

export async function systemInfo(request, { remoteExecImpl = remoteExec } = {}) {
  const target = validateRequest(request, 'system_info');
  const execution = await execute(target, SYSTEM_INFO_COMMAND, {
    remoteExecImpl,
    label: 'system_info',
  });
  return {
    target,
    ...parseSystemInfoOutput(execution.stdout),
    ...rawContext(execution.stdout),
  };
}

export async function processList(request, { remoteExecImpl = remoteExec } = {}) {
  const target = validateRequest(request, 'process_list');
  const limit = validateInteger(request.limit, 'limit', DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
  const command = `bash -lc 'set -o pipefail; ps -eo pid=,ppid=,user=,stat=,pcpu=,pmem=,etimes=,comm= --sort=pid | head -n ${limit + 1}'`;
  const execution = await execute(target, command, { remoteExecImpl, label: 'process_list' });
  const parsed = parseProcessListOutput(execution.stdout);
  return {
    target,
    processes: parsed.slice(0, limit),
    results_truncated: parsed.length > limit,
    ...rawContext(execution.stdout),
  };
}

export async function portList(request, { remoteExecImpl = remoteExec } = {}) {
  const target = validateRequest(request, 'port_list');
  const limit = validateInteger(request.limit, 'limit', DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
  const command = `bash -lc 'set -o pipefail; ss -H -lntup | head -n ${limit + 1}'`;
  const execution = await execute(target, command, { remoteExecImpl, label: 'port_list' });
  const parsed = parsePortListOutput(execution.stdout);
  return {
    target,
    listeners: parsed.slice(0, limit),
    results_truncated: parsed.length > limit,
    ...rawContext(execution.stdout),
  };
}

export async function serviceStatus(request, { remoteExecImpl = remoteExec } = {}) {
  const target = validateRequest(request, 'service_status');
  const service = validateServiceUnit(request.service);
  const execution = await execute(target, SERVICE_STATUS_COMMAND, {
    remoteExecImpl,
    label: 'service_status',
    env: { PTEXT_SERVICE: service },
  });
  return {
    target,
    ...parseServiceStatusOutput(execution.stdout),
    ...rawContext(execution.stdout),
  };
}

export async function journalRead(request, { remoteExecImpl = remoteExec } = {}) {
  const target = validateRequest(request, 'journal_read');
  const lines = validateInteger(request.lines, 'lines', DEFAULT_JOURNAL_LINES, MAX_JOURNAL_LINES);
  const service = request.service === undefined ? null : validateServiceUnit(request.service);
  const command = service === null
    ? 'journalctl --no-pager -o short-iso -n "$PTEXT_LINES"'
    : 'journalctl --no-pager -o short-iso -n "$PTEXT_LINES" -u "$PTEXT_SERVICE"';
  const env = { PTEXT_LINES: String(lines) };
  if (service !== null) env.PTEXT_SERVICE = service;
  const execution = await execute(target, command, {
    remoteExecImpl,
    label: 'journal_read',
    env,
  });
  return {
    target,
    service,
    entries: execution.stdout.split(/\r?\n/u).filter((line) => line.length > 0),
    ...rawContext(execution.stdout),
  };
}

export async function diskUsage(request, { remoteExecImpl = remoteExec } = {}) {
  const target = validateRequest(request, 'disk_usage');
  const execution = await execute(target, 'df -P -B1', {
    remoteExecImpl,
    label: 'disk_usage',
  });
  return {
    target,
    filesystems: parseDiskUsageOutput(execution.stdout),
    ...rawContext(execution.stdout),
  };
}

export async function gpuInfo(request, { remoteExecImpl = remoteExec } = {}) {
  const target = validateRequest(request, 'gpu_info');
  const probe = await remoteExecImpl({
    target,
    command: 'command -v nvidia-smi >/dev/null 2>&1',
    env: { LC_ALL: 'C' },
    timeout_ms: 10_000,
    max_output_bytes: 4_096,
  });
  if (probe?.timed_out === true) {
    throw new TerminalError('timeout', 'gpu_info nvidia-smi capability probe timed out', {
      retryable: true,
      details: { target },
    });
  }
  if (probe?.truncated === true) {
    throw new TerminalError(
      'local_capability_dependency_error',
      'gpu_info capability probe output was unexpectedly truncated',
      { details: { target } },
    );
  }
  if (probe?.exit_code !== 0) {
    return {
      target,
      provider: 'nvidia-smi',
      available: false,
      gpus: [],
      raw: '',
      raw_truncated: false,
    };
  }

  const execution = await execute(target, NVIDIA_QUERY_COMMAND, {
    remoteExecImpl,
    label: 'gpu_info',
  });
  return {
    target,
    provider: 'nvidia-smi',
    available: true,
    gpus: parseGpuInfoOutput(execution.stdout),
    ...rawContext(execution.stdout),
  };
}

