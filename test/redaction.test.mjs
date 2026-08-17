import assert from 'node:assert/strict';
import test from 'node:test';

import { REDACTED, redactText, redactValue } from '../src/redaction.mjs';

test('structural secret keys are redacted recursively without mutating input', () => {
  const input = {
    username: 'taylan',
    password: 'TEST_PASSWORD_VALUE',
    nested: {
      passphrase: 'TEST_PASSPHRASE_VALUE',
      api_key: 'TEST_API_KEY_VALUE',
      accessToken: 'TEST_ACCESS_TOKEN_VALUE',
      authorization: 'Bearer TEST_AUTH_VALUE',
      prepared_secret: 'TEST_PREPARED_SECRET_VALUE',
      safe: 'visible',
    },
    list: [{ token: 'TEST_LIST_TOKEN', value: 'keep-me' }],
  };
  const snapshot = structuredClone(input);
  const redacted = redactValue(input);

  assert.deepEqual(input, snapshot);
  assert.equal(redacted.username, 'taylan');
  assert.equal(redacted.password, REDACTED);
  assert.equal(redacted.nested.passphrase, REDACTED);
  assert.equal(redacted.nested.api_key, REDACTED);
  assert.equal(redacted.nested.accessToken, REDACTED);
  assert.equal(redacted.nested.authorization, REDACTED);
  assert.equal(redacted.nested.prepared_secret, REDACTED);
  assert.equal(redacted.nested.safe, 'visible');
  assert.equal(redacted.list[0].token, REDACTED);
  assert.equal(redacted.list[0].value, 'keep-me');
});

test('text redaction removes authorization, password assignments, and URI credentials', () => {
  const source = [
    'Authorization: Bearer TEST_BEARER_VALUE',
    'proxy-authorization: Basic TEST_BASIC_VALUE',
    'password=TEST_PASSWORD_VALUE',
    'passwd: TEST_PASSWD_VALUE',
    'connect https://admin:TEST_URI_SECRET@example.test/path',
  ].join('\n');
  const redacted = redactText(source);

  for (const secret of [
    'TEST_BEARER_VALUE', 'TEST_BASIC_VALUE', 'TEST_PASSWORD_VALUE',
    'TEST_PASSWD_VALUE', 'TEST_URI_SECRET',
  ]) {
    assert.equal(redacted.includes(secret), false, `fixture leaked: ${secret}`);
  }
  assert.match(redacted, /Authorization: \[REDACTED\]/u);
  assert.match(redacted, /password=\[REDACTED\]/u);
  assert.match(redacted, /https:\/\/admin:\[REDACTED\]@example\.test/u);
});

test('private-key marker blocks are removed from diagnostic text', () => {
  const source = [
    'before',
    '-----BEGIN OPENSSH PRIVATE KEY-----',
    'TEST_PRIVATE_KEY_FIXTURE_ONLY',
    '-----END OPENSSH PRIVATE KEY-----',
    'after',
  ].join('\n');
  const redacted = redactText(source);

  assert.equal(redacted.includes('TEST_PRIVATE_KEY_FIXTURE_ONLY'), false);
  assert.match(redacted, /\[REDACTED PRIVATE KEY\]/u);
  assert.match(redacted, /before/u);
  assert.match(redacted, /after/u);
});

test('explicit extra secrets are removed even inside unrelated strings', () => {
  const knownSecret = 'TEST_EXTRA_SECRET_LITERAL';
  const redacted = redactValue({
    error: `synthetic failure ${knownSecret}`,
    safe: 'not secret',
  }, { extraSecrets: [knownSecret] });

  assert.equal(JSON.stringify(redacted).includes(knownSecret), false);
  assert.equal(redacted.safe, 'not secret');
});

test('Error objects become serializable redacted diagnostic objects', () => {
  const error = new Error('Authorization: Bearer TEST_ERROR_TOKEN');
  error.name = 'RemoteFailure';
  error.category = 'transport_reconnect_failure';
  error.details = { password: 'TEST_ERROR_PASSWORD', target: 'taylan' };
  error.retryable = true;

  const redacted = redactValue(error);
  assert.equal(redacted.name, 'RemoteFailure');
  assert.equal(redacted.category, 'transport_reconnect_failure');
  assert.equal(redacted.retryable, true);
  assert.equal(redacted.details.password, REDACTED);
  assert.equal(redacted.details.target, 'taylan');
  assert.equal(JSON.stringify(redacted).includes('TEST_ERROR_TOKEN'), false);
});

test('circular structures and excessive depth are represented safely', () => {
  const root = { name: 'root' };
  root.self = root;
  root.child = { a: { b: { c: { d: 'deep' } } } };
  const redacted = redactValue(root, { maxDepth: 3 });
  assert.equal(redacted.self, '[Circular]');
  assert.equal(redacted.child.a.b, '[MaxDepth]');
});
