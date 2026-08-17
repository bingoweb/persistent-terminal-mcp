import test from 'node:test';
import assert from 'node:assert/strict';

import {
  collectLockLicenses,
  renderLicenseInventory,
} from '../scripts/license-inventory.mjs';

test('collectLockLicenses returns every node_modules package with a known license', () => {
  const lock = {
    packages: {
      '': { name: 'demo', version: '1.0.0' },
      'node_modules/zeta': { version: '2.0.0', license: 'MIT' },
      'node_modules/@scope/alpha': { version: '3.0.0', license: 'ISC' },
    },
  };

  assert.deepEqual(collectLockLicenses(lock), [
    { name: '@scope/alpha', version: '3.0.0', license: 'ISC' },
    { name: 'zeta', version: '2.0.0', license: 'MIT' },
  ]);
});

test('collectLockLicenses rejects missing or unknown license metadata', () => {
  const lock = {
    packages: {
      '': { name: 'demo', version: '1.0.0' },
      'node_modules/bad': { version: '1.0.0' },
    },
  };

  assert.throws(() => collectLockLicenses(lock), /missing license metadata.*bad/i);
});

test('renderLicenseInventory is deterministic and includes package totals', () => {
  const rendered = renderLicenseInventory([
    { name: 'zeta', version: '2.0.0', license: 'MIT' },
    { name: '@scope/alpha', version: '3.0.0', license: 'ISC' },
  ]);

  assert.match(rendered, /Total production packages: \*\*2\*\*/);
  assert.match(rendered, /\| `@scope\/alpha` \| `3\.0\.0` \| `ISC` \|/);
  assert.ok(rendered.indexOf('@scope/alpha') < rendered.indexOf('zeta'));
});
