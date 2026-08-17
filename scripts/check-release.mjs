import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requireTag = process.argv.slice(2).includes('--require-tag');
const stableZero = /^0\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;

async function readJson(relative) {
  return JSON.parse(await fs.readFile(path.join(root, relative), 'utf8'));
}

async function readText(relative) {
  return fs.readFile(path.join(root, relative), 'utf8');
}

function fail(message) {
  throw new Error(`release check failed: ${message}`);
}

async function main() {
  const packageJson = await readJson('package.json');
  const packageLock = await readJson('package-lock.json');
  const version = packageJson.version;

  if (!stableZero.test(version)) fail(`version must be a stable major-zero SemVer, got ${version}`);
  if (packageJson.private !== true) fail('package must remain private to prevent accidental npm publish');
  if (packageLock.version !== version || packageLock.packages?.['']?.version !== version) {
    fail('package-lock root version does not match package.json');
  }

  const expectedFiles = [
    'src/',
    'helpers/',
    'README.md',
    'LICENSE',
    'NOTICE',
    'SECURITY.md',
    'THIRD_PARTY_LICENSES.md',
    'THIRD_PARTY_NOTICES.md',
    'docs/',
  ];
  if (JSON.stringify(packageJson.files) !== JSON.stringify(expectedFiles)) {
    fail('package files whitelist changed without updating the release contract');
  }

  const changelog = await readText('CHANGELOG.md');
  if (!changelog.includes(`## [${version}] - 2026-08-17`)) {
    fail(`CHANGELOG.md has no ${version} entry for 2026-08-17`);
  }

  const releasePath = `docs/releases/v${version}.md`;
  const releaseNotes = await readText(releasePath);
  if (!releaseNotes.startsWith(`# Persistent Terminal MCP v${version}\n`)) {
    fail(`${releasePath} has the wrong title`);
  }
  for (const marker of ['CycloneDX', 'SHA-256', 'rollback']) {
    if (!releaseNotes.toLowerCase().includes(marker.toLowerCase())) {
      fail(`${releasePath} is missing ${marker} release information`);
    }
  }

  const readme = await readText('README.md');
  if (!/stable pre-1\.0/iu.test(readme) || !readme.includes(version)) {
    fail('README does not declare the stable pre-1.0 release version');
  }
  if (/still pre-release/iu.test(readme)) fail('README still contains stale pre-release wording');

  if (requireTag) {
    const result = spawnSync('git', ['tag', '--points-at', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    });
    if (result.error || result.status !== 0) fail('unable to inspect Git tags');
    const tags = result.stdout.split(/\r?\n/u).filter(Boolean);
    const expectedTag = `v${version}`;
    if (!tags.includes(expectedTag)) {
      fail(`HEAD is not tagged ${expectedTag}`);
    }
  }

  process.stdout.write(`RELEASE_CHECK_OK version=${version}${requireTag ? ' tag=verified' : ''}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

