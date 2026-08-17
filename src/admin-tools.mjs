import { ERROR_CATEGORIES, TerminalError, normalizeFailure } from './errors.mjs';

function objectSchema(properties, required = []) {
  return { type: 'object', properties, required, additionalProperties: false };
}

const FAILURE_SCHEMA = objectSchema({
  category: { type: 'string', enum: [...ERROR_CATEGORIES] },
  message: { type: 'string' },
  retryable: { type: 'boolean' },
  details: {},
}, ['category', 'message', 'retryable']);

const SHA_PROPERTY = { type: 'string', pattern: '^[0-9a-f]{64}$' };
const SYSTEMD_TRANSACTION_ACTIONS = [
  'start', 'stop', 'restart', 'reload', 'try-restart', 'reload-or-restart',
  'enable', 'disable', 'reenable',
];
const HUNK_SCHEMA = objectSchema({
  old: { type: 'string' }, new: { type: 'string' },
  expected_count: { type: 'integer', minimum: 1, maximum: 10000, default: 1 },
}, ['old', 'new']);
const MUTATION_SCHEMA = { oneOf: [
  objectSchema({ type: { const: 'remote_write' }, path: { type: 'string', minLength: 1 }, text: { type: 'string', maxLength: 1048576 }, expected_sha256: SHA_PROPERTY }, ['type', 'path', 'text']),
  objectSchema({ type: { const: 'remote_patch' }, path: { type: 'string', minLength: 1 }, expected_sha256: SHA_PROPERTY, hunks: { type: 'array', minItems: 1, maxItems: 128, items: HUNK_SCHEMA } }, ['type', 'path', 'hunks']),
  objectSchema({ type: { const: 'systemd_action' }, unit: { type: 'string', minLength: 1 }, action: { type: 'string', enum: SYSTEMD_TRANSACTION_ACTIONS } }, ['type', 'unit', 'action']),
] };
const HEALTH_CHECK_SCHEMA = { oneOf: [
  objectSchema({ type: { const: 'command' }, command: { type: 'string', minLength: 1, maxLength: 16384 }, expected_exit_code: { type: 'integer', minimum: 0, maximum: 255, default: 0 }, stdout_regex: { type: 'string', maxLength: 256 } }, ['type', 'command']),
  objectSchema({ type: { const: 'systemd_unit' }, unit: { type: 'string', minLength: 1 }, active_state: { type: 'string', minLength: 1 }, sub_state: { type: 'string', minLength: 1 } }, ['type', 'unit']),
] };
const TRANSACTION_RESULT_SCHEMA = objectSchema({
  transaction_id: { type: 'string' }, target: { type: 'string' },
  state: { type: 'string', enum: ['committed', 'precheck_failed', 'snapshot_failed', 'mutation_failed', 'health_failed', 'rolled_back', 'rollback_failed'] },
  precheck: { type: 'object' }, mutation: { oneOf: [{ type: 'object' }, { type: 'null' }] },
  health: { type: 'object' }, rollback: { type: 'object' },
}, ['transaction_id', 'target', 'state', 'precheck', 'mutation', 'health', 'rollback']);

export const ADMIN_TOOLS = Object.freeze([Object.freeze({
  name: 'admin_transaction',
  description: 'Perform one bounded canonical administration mutation with precheck, health gates and verified rollback when supported. This is not a general shell workflow or DAG engine.',
  inputSchema: objectSchema({
    target: { type: 'string', minLength: 1 },
    privilege: { type: 'string', enum: ['auto', 'user', 'root'], default: 'auto' },
    precheck: objectSchema({ command: { type: 'string', minLength: 1, maxLength: 16384 }, expected_exit_code: { type: 'integer', minimum: 0, maximum: 255, default: 0 } }, ['command']),
    mutation: MUTATION_SCHEMA,
    health_checks: { type: 'array', minItems: 1, maxItems: 8, items: HEALTH_CHECK_SCHEMA },
    rollback_on_failure: { type: 'boolean', default: true },
  }, ['target', 'mutation', 'health_checks']),
  outputSchema: { type: 'object', oneOf: [TRANSACTION_RESULT_SCHEMA, FAILURE_SCHEMA] },
})]);

export const ADMIN_TOOL_NAMES = new Set(ADMIN_TOOLS.map((tool) => tool.name));

function result(value, { isError = false } = {}) {
  const response = { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
  if (isError) response.isError = true;
  return response;
}

export async function callAdminTool(name, args, { transactionEngine } = {}) {
  if (!ADMIN_TOOL_NAMES.has(name)) throw new TerminalError('validation_error', `Unknown admin tool: ${name}`);
  try {
    if (!transactionEngine?.execute) throw new TerminalError('local_capability_dependency_error', 'admin transaction engine is not configured');
    return result(await transactionEngine.execute(args ?? {}));
  } catch (error) {
    return result(normalizeFailure(error), { isError: true });
  }
}

