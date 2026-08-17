import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  artifactNames,
  normalizeSbomRoot,
  renderSha256Sums,
  verifyPackEntries,
  verifySourceEntries,
} from './release-lib.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(projectRoot, 'dist');

function run(command, args, { cwd = projectRoot, capture = false } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = capture ? `\n${result.stderr || result.stdout}` : '';
    throw new Error(`${command} ${args.join(' ')} failed with exit ${result.status}${detail}`);
  }
  return capture ? result.stdout : '';
}

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const handle = await fs.open(filePath, 'r');
  try {
    for await (const chunk of handle.createReadStream()) hash.update(chunk);
  } finally {
    await handle.close().catch(() => {});
  }
  return hash.digest('hex');
}

function cleanInstallSmoke(packageDir) {
  run('npm', [
    'install',
    '--omit=dev',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--package-lock=false',
  ], { cwd: packageDir });

  const smoke = `
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from './src/server.mjs';

const upstreamClient = {
  listTools: async () => ({ tools: [
    { name: 'release_upstream_probe', description: 'release probe', inputSchema: { type: 'object' } },
  ] }),
  callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
};
const server = createServer({ upstreamClient });
const client = new Client({ name: 'release-clean-install-smoke', version: '0.9.0' });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
try {
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const listed = await client.listTools();
  const names = new Set(listed.tools.map((tool) => tool.name));
  for (const required of ['release_upstream_probe', 'remote_exec', 'ensure_session', 'terminal_health']) {
    assert(names.has(required), 'missing clean-install tool: ' + required);
  }
  process.stdout.write('RELEASE_CLEAN_INSTALL_SMOKE_OK tools=' + listed.tools.length + '\\n');
} finally {
  await client.close().catch(() => {});
  await server.close().catch(() => {});
}
`;
  run(process.execPath, ['--input-type=module', '--eval', smoke], { cwd: packageDir });
}

async function main() {
  const packageJson = JSON.parse(await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8'));
  const version = packageJson.version;
  const names = artifactNames(version);
  await fs.rm(distDir, { recursive: true, force: true });
  await fs.mkdir(distDir, { recursive: true });

  const packedRaw = run('npm', ['pack', '--json', '--pack-destination', distDir], { capture: true });
  const packed = JSON.parse(packedRaw)[0];
  if (!packed || packed.filename !== names.runtime) {
    throw new Error(`npm pack produced unexpected runtime artifact: ${packed?.filename ?? 'none'}`);
  }
  verifyPackEntries(packed.files.map((entry) => entry.path));
  const runtimePath = path.join(distDir, names.runtime);

  const sbomRaw = run('npm', ['sbom', '--sbom-format=cyclonedx', '--sbom-type=application'], { capture: true });
  const sbom = normalizeSbomRoot(JSON.parse(sbomRaw), {
    name: packageJson.name,
    version,
  });
  if (sbom.bomFormat !== 'CycloneDX') throw new Error('npm sbom did not produce CycloneDX');
  if (
    sbom.metadata?.component?.name !== packageJson.name
    || sbom.metadata?.component?.version !== version
  ) {
    throw new Error('SBOM root identity does not match package metadata');
  }
  await fs.writeFile(path.join(distDir, names.sbom), `${JSON.stringify(sbom, null, 2)}\n`, 'utf8');

  const gitRoot = run('git', ['rev-parse', '--show-toplevel'], { capture: true }).trim();
  const relativeProject = path.relative(gitRoot, projectRoot).split(path.sep).join('/');
  const sourceRef = process.env.RELEASE_SOURCE_REF ?? 'HEAD';
  const treeish = relativeProject === '' ? sourceRef : `${sourceRef}:${relativeProject}`;
  const sourcePrefix = `persistent-terminal-mcp-${version}/`;
  const sourcePath = path.join(distDir, names.source);
  run('git', [
    'archive',
    '--format=tar.gz',
    `--prefix=${sourcePrefix}`,
    `--output=${sourcePath}`,
    treeish,
  ], { cwd: gitRoot });
  const sourceEntries = run('tar', ['-tzf', sourcePath], { capture: true })
    .split('\n')
    .filter(Boolean);
  verifySourceEntries(sourceEntries, { prefix: sourcePrefix });

  const smokeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'persistent-terminal-release-'));
  try {
    run('tar', ['-xzf', runtimePath, '-C', smokeRoot]);
    cleanInstallSmoke(path.join(smokeRoot, 'package'));
  } finally {
    await fs.rm(smokeRoot, { recursive: true, force: true });
  }

  const checksumRecords = [];
  for (const name of [names.runtime, names.source, names.sbom]) {
    checksumRecords.push({ name, sha256: await sha256File(path.join(distDir, name)) });
  }
  const checksumText = renderSha256Sums(checksumRecords);
  await fs.writeFile(path.join(distDir, names.checksums), checksumText, 'utf8');

  for (const record of checksumRecords) {
    const actual = await sha256File(path.join(distDir, record.name));
    if (actual !== record.sha256) throw new Error(`checksum verification failed for ${record.name}`);
  }

  process.stdout.write(
    `RELEASE_ARTIFACTS_OK version=${version} runtime_entries=${packed.files.length} assets=4\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`release artifact build failed: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});

