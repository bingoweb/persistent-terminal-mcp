import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const packageUrl = new URL('../package.json', import.meta.url);
const lockUrl = new URL('../package-lock.json', import.meta.url);

async function readJson(url) {
  return JSON.parse(await fs.readFile(url, 'utf8'));
}

test('v0.9.0 release version is single-source across package, lock, and runtime metadata', async () => {
  const packageJson = await readJson(packageUrl);
  const packageLock = await readJson(lockUrl);

  assert.equal(packageJson.version, '0.9.0');
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

test('v0.9.0 release documentation and verification command are present and consistent', async () => {
  const packageJson = await readJson(packageUrl);
  const read = async (relative) => fs.readFile(new URL(relative, import.meta.url), 'utf8');

  assert.equal(packageJson.scripts['release:check'], 'node scripts/check-release.mjs');

  const readme = await read('../README.md');
  assert.match(readme, /stable pre-1\.0/iu);
  assert.match(readme, /0\.9\.0/u);
  assert.doesNotMatch(readme, /still pre-release/iu);

  const changelog = await read('../CHANGELOG.md');
  assert.match(changelog, /^## \[0\.9\.0\] - 2026-08-17$/mu);

  const releaseNotes = await read('../docs/releases/v0.9.0.md');
  assert.match(releaseNotes, /^# Persistent Terminal MCP v0\.9\.0$/mu);
  assert.match(releaseNotes, /SHA-256/iu);
  assert.match(releaseNotes, /CycloneDX/iu);
  assert.match(releaseNotes, /rollback/iu);
});

