import path from 'node:path';

const DISALLOWED_LICENSE_VALUES = new Set([
  '',
  'UNKNOWN',
  'UNLICENSED',
  'NONE',
  'NOASSERTION',
]);

function packageNameFromLockPath(lockPath) {
  const marker = 'node_modules/';
  const index = lockPath.lastIndexOf(marker);
  if (index < 0) return null;
  return lockPath.slice(index + marker.length);
}

export function collectLockLicenses(lock) {
  if (!lock || typeof lock !== 'object' || !lock.packages || typeof lock.packages !== 'object') {
    throw new TypeError('package-lock.json must contain a packages object');
  }

  const rows = [];

  for (const [lockPath, metadata] of Object.entries(lock.packages)) {
    if (!lockPath.includes('node_modules/')) continue;

    const name = packageNameFromLockPath(lockPath);
    const version = metadata?.version;
    const license = typeof metadata?.license === 'string' ? metadata.license.trim() : '';

    if (!name || typeof version !== 'string' || version.length === 0) {
      throw new Error(`Invalid dependency metadata for ${lockPath}`);
    }
    if (DISALLOWED_LICENSE_VALUES.has(license.toUpperCase())) {
      throw new Error(`Missing license metadata for ${name}@${version}`);
    }

    rows.push({ name, version, license });
  }

  return rows.sort((a, b) =>
    a.name.localeCompare(b.name) || a.version.localeCompare(b.version) || a.license.localeCompare(b.license));
}

export function renderLicenseInventory(rows) {
  const normalized = [...rows].sort((a, b) =>
    a.name.localeCompare(b.name) || a.version.localeCompare(b.version) || a.license.localeCompare(b.license));

  const counts = new Map();
  for (const row of normalized) counts.set(row.license, (counts.get(row.license) ?? 0) + 1);

  const summary = [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([license, count]) => `- \`${license}\`: ${count}`)
    .join('\n');

  const table = normalized
    .map(({ name, version, license }) => `| \`${name}\` | \`${version}\` | \`${license}\` |`)
    .join('\n');

  return `# Third-Party Dependency License Inventory

This file is generated from the committed npm lockfile metadata. It covers packages installed under \`node_modules\` by \`npm ci\` for the current lockfile.

Total production packages: **${normalized.length}**

## License summary

${summary}

## Package inventory

| Package | Version | License |
| --- | --- | --- |
${table}

The packages listed here are not relicensed by Persistent Terminal MCP. Their original license terms remain in effect. See \`THIRD_PARTY_NOTICES.md\` for direct dependencies and external runtime components.
`;
}

export function expectedInventoryPath(rootDir) {
  return path.join(rootDir, 'THIRD_PARTY_LICENSES.md');
}
