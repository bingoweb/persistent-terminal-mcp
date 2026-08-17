import { ERROR_CATEGORIES, TerminalError, normalizeFailure } from './errors.mjs';
import { callRemoteFs } from './remote-fs-client.mjs';

const FAILURE_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    category: { type: 'string', enum: [...ERROR_CATEGORIES] },
    message: { type: 'string' },
    retryable: { type: 'boolean' },
    details: {},
  },
  required: ['category', 'message', 'retryable'],
  additionalProperties: false,
});

const TARGET = Object.freeze({
  type: 'string',
  minLength: 1,
  description: 'Native OpenSSH host or alias.',
});
const PATH = Object.freeze({ type: 'string', minLength: 1 });
const SHA256 = Object.freeze({ type: 'string', pattern: '^[0-9a-f]{64}$' });
const SEARCH_MAX_DEPTH = 32;
const SEARCH_MAX_RESULTS = 1000;
const SEARCH_MAX_BYTES = 1048576;
const SEARCH_DEFAULT_MAX_DEPTH = 8;
const SEARCH_DEFAULT_MAX_RESULTS = 100;
const SEARCH_DEFAULT_MAX_BYTES = 262144;

const METADATA_PROPERTIES = Object.freeze({
  path: { type: 'string' },
  type: { type: 'string', enum: ['file', 'directory', 'symlink', 'other'] },
  size: { type: 'integer', minimum: 0 },
  mode: { type: 'string', pattern: '^[0-7]{4}$' },
  uid: { type: 'integer', minimum: 0 },
  gid: { type: 'integer', minimum: 0 },
  mtime: { type: 'number' },
});
const METADATA_REQUIRED = Object.freeze(['path', 'type', 'size', 'mode', 'uid', 'gid', 'mtime']);

function outputSchema(success) {
  return { type: 'object', oneOf: [success, FAILURE_SCHEMA] };
}

function objectSchema(properties, required) {
  return { type: 'object', properties, required, additionalProperties: false };
}

const METADATA_SCHEMA = objectSchema(METADATA_PROPERTIES, METADATA_REQUIRED);
const LIST_ENTRY_SCHEMA = objectSchema(
  { name: { type: 'string' }, ...METADATA_PROPERTIES },
  ['name', ...METADATA_REQUIRED],
);

export const REMOTE_FS_TOOLS = Object.freeze([
  Object.freeze({
    name: 'remote_stat',
    description: 'Return normalized metadata for a remote path without shell interpolation.',
    inputSchema: objectSchema({ target: TARGET, path: PATH }, ['target', 'path']),
    outputSchema: outputSchema(METADATA_SCHEMA),
  }),
  Object.freeze({
    name: 'remote_list',
    description: 'List one remote directory with entries sorted by name.',
    inputSchema: objectSchema({ target: TARGET, path: PATH }, ['target', 'path']),
    outputSchema: outputSchema(objectSchema({
      path: { type: 'string' },
      entries: { type: 'array', items: LIST_ENTRY_SCHEMA },
    }, ['path', 'entries'])),
  }),
  Object.freeze({
    name: 'remote_read',
    description: 'Read a remote UTF-8 text file with SHA-256 metadata; binary files are rejected.',
    inputSchema: objectSchema({ target: TARGET, path: PATH }, ['target', 'path']),
    outputSchema: outputSchema(objectSchema({
      path: { type: 'string' },
      text: { type: 'string' },
      size: { type: 'integer', minimum: 0 },
      sha256: SHA256,
      mtime: { type: 'number' },
    }, ['path', 'text', 'size', 'sha256', 'mtime'])),
  }),
  Object.freeze({
    name: 'remote_write',
    description: 'Atomically write UTF-8 text to a remote file, optionally requiring an expected SHA-256.',
    inputSchema: objectSchema({
      target: TARGET,
      path: PATH,
      text: { type: 'string' },
      expected_sha256: SHA256,
    }, ['target', 'path', 'text']),
    outputSchema: outputSchema(objectSchema({
      path: { type: 'string' },
      created: { type: 'boolean' },
      size: { type: 'integer', minimum: 0 },
      sha256: SHA256,
    }, ['path', 'created', 'size', 'sha256'])),
  }),
  Object.freeze({
    name: 'remote_patch',
    description: 'Deterministically patch a remote UTF-8 text file using exact ordered hunks and optional SHA-256 preconditions.',
    inputSchema: objectSchema({
      target: TARGET,
      path: PATH,
      expected_sha256: SHA256,
      hunks: {
        type: 'array',
        minItems: 1,
        items: objectSchema({
          old_text: { type: 'string', minLength: 1 },
          new_text: { type: 'string' },
          expected_count: { type: 'integer', minimum: 1 },
        }, ['old_text', 'new_text', 'expected_count']),
      },
    }, ['target', 'path', 'hunks']),
    outputSchema: outputSchema(objectSchema({
      path: { type: 'string' },
      size: { type: 'integer', minimum: 0 },
      sha256: SHA256,
      hunks_applied: { type: 'integer', minimum: 1 },
    }, ['path', 'size', 'sha256', 'hunks_applied'])),
  }),
  Object.freeze({
    name: 'remote_find',
    description: 'Find remote paths by basename glob with deterministic traversal and bounded results.',
    inputSchema: objectSchema({
      target: TARGET,
      path: PATH,
      name_pattern: { type: 'string', minLength: 1, default: '*' },
      max_depth: { type: 'integer', minimum: 0, maximum: SEARCH_MAX_DEPTH, default: SEARCH_DEFAULT_MAX_DEPTH },
      max_results: { type: 'integer', minimum: 1, maximum: SEARCH_MAX_RESULTS, default: SEARCH_DEFAULT_MAX_RESULTS },
      max_bytes: { type: 'integer', minimum: 1, maximum: SEARCH_MAX_BYTES, default: SEARCH_DEFAULT_MAX_BYTES },
    }, ['target', 'path']),
    outputSchema: outputSchema(objectSchema({
      path: { type: 'string' },
      entries: { type: 'array', items: LIST_ENTRY_SCHEMA },
      result_count: { type: 'integer', minimum: 0 },
      truncated: { type: 'boolean' },
    }, ['path', 'entries', 'result_count', 'truncated'])),
  }),
  Object.freeze({
    name: 'remote_grep',
    description: 'Search UTF-8 remote files with a regular expression and bounded line-level results.',
    inputSchema: objectSchema({
      target: TARGET,
      path: PATH,
      pattern: { type: 'string', minLength: 1 },
      max_depth: { type: 'integer', minimum: 0, maximum: SEARCH_MAX_DEPTH, default: SEARCH_DEFAULT_MAX_DEPTH },
      max_results: { type: 'integer', minimum: 1, maximum: SEARCH_MAX_RESULTS, default: SEARCH_DEFAULT_MAX_RESULTS },
      max_bytes: { type: 'integer', minimum: 1, maximum: SEARCH_MAX_BYTES, default: SEARCH_DEFAULT_MAX_BYTES },
    }, ['target', 'path', 'pattern']),
    outputSchema: outputSchema(objectSchema({
      path: { type: 'string' },
      matches: {
        type: 'array',
        items: objectSchema({
          path: { type: 'string' },
          line_number: { type: 'integer', minimum: 1 },
          line: { type: 'string' },
        }, ['path', 'line_number', 'line']),
      },
      result_count: { type: 'integer', minimum: 0 },
      skipped_binary_files: { type: 'integer', minimum: 0 },
      truncated: { type: 'boolean' },
    }, ['path', 'matches', 'result_count', 'skipped_binary_files', 'truncated'])),
  }),
  Object.freeze({
    name: 'remote_mkdir',
    description: 'Create a remote directory; parents=true also creates missing ancestors.',
    inputSchema: objectSchema({
      target: TARGET,
      path: PATH,
      parents: { type: 'boolean', default: false },
    }, ['target', 'path']),
    outputSchema: outputSchema(objectSchema({
      path: { type: 'string' },
      created: { type: 'boolean' },
    }, ['path', 'created'])),
  }),
  Object.freeze({
    name: 'remote_move',
    description: 'Move or rename one remote path; overwrite defaults to false.',
    inputSchema: objectSchema({
      target: TARGET,
      source_path: PATH,
      destination_path: PATH,
      overwrite: { type: 'boolean', default: false },
    }, ['target', 'source_path', 'destination_path']),
    outputSchema: outputSchema(objectSchema({
      source_path: { type: 'string' },
      destination_path: { type: 'string' },
      moved: { type: 'boolean' },
    }, ['source_path', 'destination_path', 'moved'])),
  }),
  Object.freeze({
    name: 'remote_delete',
    description: 'Delete one remote path; non-empty directories require recursive=true.',
    inputSchema: objectSchema({
      target: TARGET,
      path: PATH,
      recursive: { type: 'boolean', default: false },
    }, ['target', 'path']),
    outputSchema: outputSchema(objectSchema({
      path: { type: 'string' },
      type: { type: 'string', enum: ['file', 'directory', 'symlink', 'other'] },
      deleted: { type: 'boolean' },
    }, ['path', 'type', 'deleted'])),
  }),
]);

export const REMOTE_FS_TOOL_NAMES = new Set(REMOTE_FS_TOOLS.map((tool) => tool.name));

const OPERATIONS = Object.freeze({
  remote_stat: 'stat',
  remote_list: 'list',
  remote_read: 'read',
  remote_write: 'write',
  remote_patch: 'patch',
  remote_find: 'find',
  remote_grep: 'grep',
  remote_mkdir: 'mkdir',
  remote_move: 'move',
  remote_delete: 'delete',
});

function result(value, { isError = false } = {}) {
  const response = {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
  };
  if (isError) response.isError = true;
  return response;
}

function validateString(value, field) {
  if (typeof value !== 'string' || value === '') {
    throw new TerminalError('validation_error', `${field} must be a non-empty string`);
  }
  if (value.includes('\0')) {
    throw new TerminalError('validation_error', `${field} must not contain NUL bytes`);
  }
}

function validateArgs(name, args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new TerminalError('validation_error', `${name} arguments must be an object`);
  }
  validateString(args.target, 'target');
  if (name === 'remote_move') {
    validateString(args.source_path, 'source_path');
    validateString(args.destination_path, 'destination_path');
    if (args.overwrite !== undefined && typeof args.overwrite !== 'boolean') {
      throw new TerminalError('validation_error', 'overwrite must be a boolean');
    }
    return;
  }
  validateString(args.path, 'path');
  if (name === 'remote_write') {
    if (typeof args.text !== 'string') {
      throw new TerminalError('validation_error', 'text must be a string');
    }
    if (args.text.includes('\0')) {
      throw new TerminalError('binary_file', 'NUL-containing content is not accepted by remote_write');
    }
    if (args.expected_sha256 !== undefined && !/^[0-9a-f]{64}$/.test(args.expected_sha256)) {
      throw new TerminalError('validation_error', 'expected_sha256 must be 64 lowercase hex characters');
    }
  }
  if (name === 'remote_patch') {
    if (args.expected_sha256 !== undefined && !/^[0-9a-f]{64}$/.test(args.expected_sha256)) {
      throw new TerminalError('validation_error', 'expected_sha256 must be 64 lowercase hex characters');
    }
    if (!Array.isArray(args.hunks) || args.hunks.length === 0) {
      throw new TerminalError('validation_error', 'hunks must be a non-empty array');
    }
    for (let index = 0; index < args.hunks.length; index += 1) {
      const hunk = args.hunks[index];
      if (hunk === null || typeof hunk !== 'object' || Array.isArray(hunk)) {
        throw new TerminalError('validation_error', `hunks[${index}] must be an object`);
      }
      if (typeof hunk.old_text !== 'string' || hunk.old_text.length === 0) {
        throw new TerminalError('validation_error', `hunks[${index}].old_text must be a non-empty string`);
      }
      if (typeof hunk.new_text !== 'string') {
        throw new TerminalError('validation_error', `hunks[${index}].new_text must be a string`);
      }
      if (hunk.old_text.includes('\0') || hunk.new_text.includes('\0')) {
        throw new TerminalError('binary_file', `hunks[${index}] contains NUL text`);
      }
      if (!Number.isInteger(hunk.expected_count) || hunk.expected_count < 1) {
        throw new TerminalError('validation_error', `hunks[${index}].expected_count must be a positive integer`);
      }
    }
  }
  if (name === 'remote_find' || name === 'remote_grep') {
    if (name === 'remote_find' && args.name_pattern !== undefined) {
      validateString(args.name_pattern, 'name_pattern');
    }
    if (name === 'remote_grep') {
      validateString(args.pattern, 'pattern');
    }
    for (const [field, minimum, maximum] of [
      ['max_depth', 0, SEARCH_MAX_DEPTH],
      ['max_results', 1, SEARCH_MAX_RESULTS],
      ['max_bytes', 1, SEARCH_MAX_BYTES],
    ]) {
      const value = args[field];
      if (value !== undefined && (!Number.isInteger(value) || value < minimum || value > maximum)) {
        throw new TerminalError(
          'validation_error',
          `${field} must be an integer between ${minimum} and ${maximum}`,
        );
      }
    }
  }
  if (name === 'remote_mkdir' && args.parents !== undefined && typeof args.parents !== 'boolean') {
    throw new TerminalError('validation_error', 'parents must be a boolean');
  }
  if (name === 'remote_delete' && args.recursive !== undefined && typeof args.recursive !== 'boolean') {
    throw new TerminalError('validation_error', 'recursive must be a boolean');
  }
}

function helperRequest(name, args) {
  const { target: _target, ...request } = args;
  return { op: OPERATIONS[name], ...request };
}

export async function callRemoteFsTool(
  name,
  args = {},
  { callRemoteFsImpl = callRemoteFs } = {},
) {
  try {
    if (!REMOTE_FS_TOOL_NAMES.has(name)) {
      throw new TerminalError('validation_error', `Unknown remote filesystem tool: ${name}`);
    }
    validateArgs(name, args);
    const value = await callRemoteFsImpl(args.target, helperRequest(name, args));
    return result(value);
  } catch (error) {
    return result(normalizeFailure(error), { isError: true });
  }
}
