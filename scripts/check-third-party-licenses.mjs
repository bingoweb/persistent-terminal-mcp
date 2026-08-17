import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  collectLockLicenses,
  expectedInventoryPath,
  renderLicenseInventory,
} from './license-inventory.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lockPath = path.join(rootDir, 'package-lock.json');
const inventoryPath = expectedInventoryPath(rootDir);

const lock = JSON.parse(await fs.readFile(lockPath, 'utf8'));
const expected = renderLicenseInventory(collectLockLicenses(lock));

let actual;
try {
  actual = await fs.readFile(inventoryPath, 'utf8');
} catch (error) {
  if (error?.code === 'ENOENT') {
    throw new Error('THIRD_PARTY_LICENSES.md is missing');
  }
  throw error;
}

if (actual !== expected) {
  throw new Error('THIRD_PARTY_LICENSES.md is out of date with package-lock.json');
}

process.stdout.write(`THIRD_PARTY_LICENSES_OK (${collectLockLicenses(lock).length} packages)\n`);
