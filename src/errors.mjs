export const ERROR_CATEGORIES = new Set([
  'validation_error',
  'target_resolution_error',
  'host_key_authentication_error',
  'transport_reconnect_failure',
  'timeout',
  'remote_command_nonzero_exit',
  'missing_remote_capability',
  'local_capability_dependency_error',
  'stale_session_task_forward_id',
  'permission_privilege_error',
  'checksum_integrity_failure',
  'binary_file',
]);

export class TerminalError extends Error {
  constructor(category, message, { details, retryable = false, cause } = {}) {
    if (!ERROR_CATEGORIES.has(category)) {
      throw new TypeError(`Unsupported error category: ${category}`);
    }

    super(message, cause === undefined ? undefined : { cause });
    this.name = 'TerminalError';
    this.category = category;
    this.details = details;
    this.retryable = Boolean(retryable);
  }
}

export function normalizeFailure(error) {
  if (error instanceof TerminalError) {
    const normalized = {
      category: error.category,
      message: error.message,
      retryable: error.retryable,
    };

    if (error.details !== undefined) normalized.details = error.details;
    return normalized;
  }

  return {
    category: 'local_capability_dependency_error',
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
  };
}
