import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

import {
  artifactNames,
  normalizeSbomRoot,
  renderSha256Sums,
  verifyPackEntries,
  verifySourceEntries,
  verifySourceReleaseMetadata,
} from '../scripts/release-lib.mjs';

test('runtime package whitelist excludes development-only trees', async () => {
  const packageJson = JSON.parse(
    await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'),
  );

  assert.deepEqual(packageJson.files, [
    'src/',
    'helpers/',
    'README.md',
    'LICENSE',
    'NOTICE',
    'SECURITY.md',
    'THIRD_PARTY_LICENSES.md',
    'THIRD_PARTY_NOTICES.md',
    'docs/',
  ]);
});

test('artifactNames produces stable v0 runtime, source, SBOM, and checksum names', () => {
  assert.deepEqual(artifactNames('0.9.0'), {
    runtime: 'persistent-terminal-mcp-0.9.0.tgz',
    source: 'persistent-terminal-mcp-0.9.0-source.tar.gz',
    sbom: 'persistent-terminal-mcp-0.9.0.cdx.json',
    checksums: 'SHA256SUMS',
  });
  assert.throws(() => artifactNames('1.0.0'), /major-zero stable version/u);
  assert.throws(() => artifactNames('0.9.0-rc.1'), /major-zero stable version/u);
});

test('normalizeSbomRoot makes npm CycloneDX root identity match package metadata', () => {
  const sbom = {
    bomFormat: 'CycloneDX',
    metadata: {
      component: {
        'bom-ref': 'persistent-terminal-mcp@0.9.0',
        name: 'persistent-terminal-extended',
        version: '0.9.0',
        purl: 'pkg:npm/persistent-terminal-mcp@0.9.0',
      },
    },
  };

  const normalized = normalizeSbomRoot(sbom, {
    name: 'persistent-terminal-mcp',
    version: '0.9.0',
  });

  assert.equal(normalized.metadata.component.name, 'persistent-terminal-mcp');
  assert.equal(normalized.metadata.component.version, '0.9.0');
  assert.equal(normalized.metadata.component.purl, 'pkg:npm/persistent-terminal-mcp@0.9.0');
  assert.equal(sbom.metadata.component.name, 'persistent-terminal-extended');
});

test('verifyPackEntries requires runtime essentials and rejects development payloads', () => {
  const valid = [
    'package.json',
    'README.md',
    'LICENSE',
    'src/server.mjs',
    'src/version.mjs',
    'helpers/remote_fs.py',
    'docs/ARCHITECTURE.md',
  ];
  assert.doesNotThrow(() => verifyPackEntries(valid));
  assert.throws(() => verifyPackEntries([...valid, 'test/server-smoke.test.mjs']), /forbidden/u);
  assert.throws(() => verifyPackEntries([...valid, '.github/workflows/ci.yml']), /forbidden/u);
  assert.throws(() => verifyPackEntries(valid.filter((entry) => entry !== 'src/server.mjs')), /missing/u);
});

test('verifySourceEntries requires standalone repository root layout', () => {
  const prefix = 'persistent-terminal-mcp-0.9.0/';
  const valid = [
    `${prefix}package.json`,
    `${prefix}README.md`,
    `${prefix}LICENSE`,
    `${prefix}src/server.mjs`,
    `${prefix}test/server-smoke.test.mjs`,
    `${prefix}.github/workflows/ci.yml`,
  ];
  assert.doesNotThrow(() => verifySourceEntries(valid, { prefix }));
  assert.throws(
    () => verifySourceEntries([...valid, `${prefix}persistent-terminal-extended/package.json`], { prefix }),
    /embedded parent path/u,
  );
});

test('verifySourceReleaseMetadata refuses an archive whose committed release identity lags the requested artifact version', () => {
  const prefix = 'persistent-terminal-mcp-0.11.0/';
  const entries = [
    `${prefix}package.json`,
    `${prefix}CHANGELOG.md`,
    `${prefix}docs/releases/v0.11.0.md`,
  ];
  assert.doesNotThrow(() => verifySourceReleaseMetadata({
    version: '0.11.0',
    prefix,
    entries,
    packageJson: { name: 'persistent-terminal-mcp', version: '0.11.0' },
    changelog: '## [0.11.0] - 2026-08-17\n',
  }));
  assert.throws(() => verifySourceReleaseMetadata({
    version: '0.11.0',
    prefix,
    entries,
    packageJson: { name: 'persistent-terminal-mcp', version: '0.10.0' },
    changelog: '## [0.10.0] - 2026-08-17\n',
  }), /source archive package version.*0\.10\.0.*requested.*0\.11\.0/iu);
  assert.throws(() => verifySourceReleaseMetadata({
    version: '0.11.0',
    prefix,
    entries: entries.filter((entry) => !entry.endsWith('docs/releases/v0.11.0.md')),
    packageJson: { name: 'persistent-terminal-mcp', version: '0.11.0' },
    changelog: '## [0.11.0] - 2026-08-17\n',
  }), /source archive is missing release notes.*v0\.11\.0/iu);
  assert.throws(() => verifySourceReleaseMetadata({
    version: '0.11.0',
    prefix,
    entries,
    packageJson: { name: 'persistent-terminal-mcp', version: '0.11.0' },
    changelog: '## [0.10.0] - 2026-08-17\n',
  }), /source archive changelog.*0\.11\.0/iu);
});

test('renderSha256Sums sorts names and emits the standard two-space separator', () => {
  assert.equal(
    renderSha256Sums([
      { name: 'z.tgz', sha256: 'b'.repeat(64) },
      { name: 'a.json', sha256: 'a'.repeat(64) },
    ]),
    `${'a'.repeat(64)}  a.json\n${'b'.repeat(64)}  z.tgz\n`,
  );
  assert.throws(
    () => renderSha256Sums([{ name: '../bad', sha256: 'a'.repeat(64) }]),
    /artifact name/u,
  );
});

