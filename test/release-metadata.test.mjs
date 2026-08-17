import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const packageUrl = new URL('../package.json', import.meta.url);
const lockUrl = new URL('../package-lock.json', import.meta.url);
const EXPECTED_RELEASE = '0.11.0';

async function readJson(url) {
  return JSON.parse(await fs.readFile(url, 'utf8'));
}

test('current release version is single-source across package, lock, and runtime metadata', async () => {
  const packageJson = await readJson(packageUrl);
  const packageLock = await readJson(lockUrl);

  assert.equal(packageJson.version, EXPECTED_RELEASE);
  assert.equal(packageLock.version, packageJson.version);
  assert.equal(packageLock.packages[''].version, packageJson.version);

  const { VERSION } = await import('../src/version.mjs');
  assert.equal(VERSION, packageJson.version);

  const serverSource = await fs.readFile(new URL('../src/server.mjs', import.meta.url), 'utf8');
  const upstreamSource = await fs.readFile(new URL('../src/upstream-pty.mjs', import.meta.url), 'utf8');
  assert.match(serverSource, /version:\s*VERSION/u);
  assert.match(upstreamSource, /version:\s*VERSION/u);
  assert.doesNotMatch(serverSource, /version:\s*['"]0\.1\.0['"]/u);
  assert.doesNotMatch(upstreamSource, /version:\s*['"]0\.1\.0['"]/u);
});

test('current release documentation and verification command are present and consistent', async () => {
  const packageJson = await readJson(packageUrl);
  const read = async (relative) => fs.readFile(new URL(relative, import.meta.url), 'utf8');

  assert.equal(packageJson.scripts['release:check'], 'node scripts/check-release.mjs');

  const readme = await read('../README.md');
  assert.match(readme, /stable pre-1\.0/iu);
  assert.match(readme, new RegExp(packageJson.version.replaceAll('.', '\\.')));
  assert.doesNotMatch(readme, /still pre-release/iu);

  const changelog = await read('../CHANGELOG.md');
  assert.match(changelog, new RegExp(`^## \\[${packageJson.version.replaceAll('.', '\\.')}\\] - 2026-08-17$`, 'mu'));

  const releaseNotes = await read(`../docs/releases/v${packageJson.version}.md`);
  assert.match(releaseNotes, new RegExp(`^# Persistent Terminal MCP v${packageJson.version.replaceAll('.', '\\.')}$`, 'mu'));
  assert.match(releaseNotes, /SHA-256/iu);
  assert.match(releaseNotes, /CycloneDX/iu);
  assert.match(releaseNotes, /rollback/iu);
  for (const marker of [
    'ControlMaster',
    'target_diagnose',
    'Privilege Engine 2.0',
    'systemd',
    'admin_transaction',
    'readOnlyHint',
    'terminal_health',
    'OAuth',
  ]) assert.match(releaseNotes, new RegExp(marker.replaceAll('.', '\\.'), 'iu'));
});

