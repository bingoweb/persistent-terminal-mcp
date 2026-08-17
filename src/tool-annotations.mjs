const KEYS = Object.freeze([
  'readOnlyHint',
  'destructiveHint',
  'idempotentHint',
  'openWorldHint',
]);

function annotation(readOnlyHint, destructiveHint, idempotentHint, openWorldHint) {
  return Object.freeze({ readOnlyHint, destructiveHint, idempotentHint, openWorldHint });
}

const READ_REMOTE = annotation(true, false, true, true);
const READ_LOCAL = annotation(true, false, true, false);
const MUTATE_REMOTE = annotation(false, true, false, true);
const MUTATE_REMOTE_NONDESTRUCTIVE = annotation(false, false, false, true);
const MUTATE_LOCAL_NONDESTRUCTIVE = annotation(false, false, true, false);

export const LEGACY_LOCAL_TOOL_NAMES = new Set([
  'ssh_exec',
  'ssh_ensure_session',
  'ssh_read_session',
]);

export const LOCAL_TOOL_ANNOTATIONS = Object.freeze({
  admin_transaction: MUTATE_REMOTE,
  remote_exec: MUTATE_REMOTE,
  remote_root_exec: MUTATE_REMOTE,

  ensure_session: annotation(false, false, true, true),
  named_session_list: READ_LOCAL,
  named_session_detach: MUTATE_LOCAL_NONDESTRUCTIVE,
  named_session_close: MUTATE_REMOTE,

  remote_stat: READ_REMOTE,
  remote_list: READ_REMOTE,
  remote_read: READ_REMOTE,
  remote_write: MUTATE_REMOTE,
  remote_patch: MUTATE_REMOTE,
  remote_find: READ_REMOTE,
  remote_grep: READ_REMOTE,
  remote_mkdir: annotation(false, false, true, true),
  remote_move: MUTATE_REMOTE,
  remote_delete: MUTATE_REMOTE,

  remote_upload: MUTATE_REMOTE,
  remote_download: MUTATE_REMOTE,
  remote_sync: MUTATE_REMOTE,

  forward_create: MUTATE_REMOTE_NONDESTRUCTIVE,
  forward_list: READ_REMOTE,
  forward_status: READ_REMOTE,
  forward_close: MUTATE_REMOTE,

  task_start: MUTATE_REMOTE,
  task_status: annotation(false, false, true, true),
  task_output: MUTATE_REMOTE_NONDESTRUCTIVE,
  task_wait: MUTATE_REMOTE_NONDESTRUCTIVE,
  task_cancel: MUTATE_REMOTE,
  task_list: READ_LOCAL,

  system_info: READ_REMOTE,
  process_list: READ_REMOTE,
  port_list: READ_REMOTE,
  service_status: READ_REMOTE,
  journal_read: READ_REMOTE,
  disk_usage: READ_REMOTE,
  gpu_info: READ_REMOTE,
  process_signal: MUTATE_REMOTE,
  service_start: MUTATE_REMOTE,
  service_stop: MUTATE_REMOTE,
  service_restart: MUTATE_REMOTE,

  systemd_unit_status: READ_REMOTE,
  systemd_unit_list: READ_REMOTE,
  systemd_unit_dependencies: READ_REMOTE,
  systemd_unit_action: MUTATE_REMOTE,
  systemd_daemon_reload: MUTATE_REMOTE,

  target_capabilities: READ_REMOTE,
  target_diagnose: READ_REMOTE,
  terminal_health: READ_REMOTE,

  ssh_exec: MUTATE_REMOTE,
  ssh_ensure_session: annotation(false, false, true, true),
  ssh_read_session: READ_REMOTE,
});

function validateAnnotationPolicy(name, value) {
  if (!value || typeof value !== 'object') {
    throw new TypeError(`Missing MCP annotation policy for local tool: ${name}`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...KEYS].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`Invalid MCP annotation policy for local tool: ${name}`);
  }
  for (const key of KEYS) {
    if (typeof value[key] !== 'boolean') {
      throw new TypeError(`Invalid MCP annotation policy for local tool: ${name}.${key}`);
    }
  }
  return value;
}

export function annotationForLocalTool(name) {
  if (typeof name !== 'string' || name === '') {
    throw new TypeError('Local tool name is required for MCP annotation policy');
  }
  return validateAnnotationPolicy(name, LOCAL_TOOL_ANNOTATIONS[name]);
}

export function annotateLocalTool(tool) {
  if (!tool || typeof tool !== 'object' || typeof tool.name !== 'string' || tool.name === '') {
    throw new TypeError('Local tool must have a valid name before annotation');
  }
  return Object.freeze({
    ...tool,
    annotations: annotationForLocalTool(tool.name),
  });
}

export function annotateLocalTools(tools) {
  if (!Array.isArray(tools)) throw new TypeError('Local tools must be an array');
  return Object.freeze(tools.map((tool) => annotateLocalTool(tool)));
}

