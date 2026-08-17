export const REDACTED = '[REDACTED]';

const REDACTED_PRIVATE_KEY = '[REDACTED PRIVATE KEY]';
const CIRCULAR = '[Circular]';
const MAX_DEPTH = '[MaxDepth]';

const SECRET_KEYS = new Set([
  'password',
  'passwd',
  'passphrase',
  'secret',
  'preparedsecret',
  'token',
  'accesstoken',
  'refreshtoken',
  'authorization',
  'proxyauthorization',
  'apikey',
  'privatekey',
  'clientsecret',
  'credential',
  'credentials',
  'cookie',
  'setcookie',
]);

const PRIVATE_KEY_BLOCK = /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/giu;
const AUTHORIZATION_HEADER = /\b(authorization|proxy-authorization)\s*:\s*[^\r\n]*/giu;
const SECRET_ASSIGNMENT = /\b(password|passwd|passphrase|secret|token|api[_-]?key)\s*([=:])\s*([^\s,;]+)/giu;
const URI_CREDENTIAL = /([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)([^\s@/]+)(@)/giu;

function normalizeKey(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]/gu, '');
}

function isSecretKey(key) {
  return SECRET_KEYS.has(normalizeKey(key));
}

function replaceLiteral(text, secret) {
  if (typeof secret !== 'string' || secret.length === 0) return text;
  return text.split(secret).join(REDACTED);
}

export function redactText(text, { extraSecrets = [] } = {}) {
  let result = String(text);

  for (const secret of extraSecrets) {
    result = replaceLiteral(result, secret);
  }

  result = result.replace(PRIVATE_KEY_BLOCK, REDACTED_PRIVATE_KEY);
  result = result.replace(AUTHORIZATION_HEADER, (_match, header) => `${header}: ${REDACTED}`);
  result = result.replace(
    SECRET_ASSIGNMENT,
    (_match, field, separator) => `${field}${separator}${REDACTED}`,
  );
  result = result.replace(URI_CREDENTIAL, (_match, prefix, _secret, suffix) => (
    `${prefix}${REDACTED}${suffix}`
  ));

  return result;
}

function errorEntries(error) {
  const result = {
    name: error.name,
    message: error.message,
  };
  if (typeof error.stack === 'string') result.stack = error.stack;

  for (const key of Object.keys(error)) {
    if (!Object.hasOwn(result, key)) result[key] = error[key];
  }
  return result;
}

function redactInternal(value, options, state, depth) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactText(value, options);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'symbol' || typeof value === 'function') return String(value);

  if (state.seen.has(value)) return CIRCULAR;
  if (depth >= options.maxDepth) return MAX_DEPTH;

  state.seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => redactInternal(item, options, state, depth + 1));
    }

    const source = value instanceof Error ? errorEntries(value) : value;
    const result = {};
    for (const [key, item] of Object.entries(source)) {
      result[key] = isSecretKey(key)
        ? REDACTED
        : redactInternal(item, options, state, depth + 1);
    }
    return result;
  } finally {
    state.seen.delete(value);
  }
}

export function redactValue(
  value,
  {
    extraSecrets = [],
    maxDepth = 8,
  } = {},
) {
  if (!Number.isInteger(maxDepth) || maxDepth < 1) {
    throw new TypeError('maxDepth must be a positive integer');
  }
  const options = {
    extraSecrets: Array.isArray(extraSecrets)
      ? extraSecrets.filter((secret) => typeof secret === 'string' && secret.length > 0)
      : [],
    maxDepth,
  };
  return redactInternal(value, options, { seen: new WeakSet() }, 0);
}

