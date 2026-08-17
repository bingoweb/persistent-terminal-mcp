const STABLE_ZERO_VERSION = /^0\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ARTIFACT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

export function artifactNames(version) {
  if (typeof version !== 'string' || !STABLE_ZERO_VERSION.test(version)) {
    throw new TypeError('release version must be a major-zero stable version such as 0.9.0');
  }
  const stem = `persistent-terminal-mcp-${version}`;
  return Object.freeze({
    runtime: `${stem}.tgz`,
    source: `${stem}-source.tar.gz`,
    sbom: `${stem}.cdx.json`,
    checksums: 'SHA256SUMS',
  });
}

export function normalizeSbomRoot(sbom, { name, version }) {
  if (!sbom || typeof sbom !== 'object' || sbom.bomFormat !== 'CycloneDX') {
    throw new TypeError('SBOM must be a CycloneDX object');
  }
  if (typeof name !== 'string' || name.length === 0) throw new TypeError('package name is required');
  if (typeof version !== 'string' || version.length === 0) throw new TypeError('package version is required');
  const component = sbom.metadata?.component;
  if (!component || typeof component !== 'object') {
    throw new TypeError('SBOM metadata.component is required');
  }

  return {
    ...sbom,
    metadata: {
      ...sbom.metadata,
      component: {
        ...component,
        name,
        version,
      },
    },
  };
}

export function verifyPackEntries(entries) {
  if (!Array.isArray(entries)) throw new TypeError('pack entries must be an array');
  const normalized = entries.map(String);
  const forbiddenPrefixes = ['test/', '.github/', 'node_modules/', 'scripts/'];
  for (const entry of normalized) {
    if (forbiddenPrefixes.some((prefix) => entry.startsWith(prefix))) {
      throw new Error(`runtime package contains forbidden development entry: ${entry}`);
    }
  }

  const required = [
    'package.json',
    'README.md',
    'LICENSE',
    'src/server.mjs',
    'src/version.mjs',
    'helpers/remote_fs.py',
  ];
  for (const entry of required) {
    if (!normalized.includes(entry)) throw new Error(`runtime package is missing required entry: ${entry}`);
  }
}

export function verifySourceEntries(entries, { prefix }) {
  if (!Array.isArray(entries)) throw new TypeError('source entries must be an array');
  if (typeof prefix !== 'string' || prefix.length === 0 || !prefix.endsWith('/')) {
    throw new TypeError('source prefix must be a non-empty directory prefix');
  }
  const normalized = entries.map(String);
  for (const entry of normalized) {
    if (!entry.startsWith(prefix)) throw new Error(`source archive escaped expected prefix: ${entry}`);
    if (entry.startsWith(`${prefix}persistent-terminal-extended/`)) {
      throw new Error(`source archive contains embedded parent path: ${entry}`);
    }
  }

  const required = [
    `${prefix}package.json`,
    `${prefix}README.md`,
    `${prefix}LICENSE`,
    `${prefix}src/server.mjs`,
    `${prefix}test/server-smoke.test.mjs`,
    `${prefix}.github/workflows/ci.yml`,
  ];
  for (const entry of required) {
    if (!normalized.includes(entry)) throw new Error(`source archive is missing required entry: ${entry}`);
  }
}

export function verifySourceReleaseMetadata({
  version,
  prefix,
  entries,
  packageJson,
  changelog,
}) {
  if (typeof version !== 'string' || !STABLE_ZERO_VERSION.test(version)) {
    throw new TypeError('source release version must be a stable major-zero version');
  }
  if (typeof prefix !== 'string' || prefix.length === 0 || !prefix.endsWith('/')) {
    throw new TypeError('source release prefix must be a non-empty directory prefix');
  }
  if (!Array.isArray(entries)) throw new TypeError('source release entries must be an array');
  if (!packageJson || typeof packageJson !== 'object' || Array.isArray(packageJson)) {
    throw new TypeError('source archive package metadata must be an object');
  }
  if (packageJson.version !== version) {
    throw new Error(
      `source archive package version ${String(packageJson.version)} does not match requested artifact version ${version}`,
    );
  }
  const releaseNotes = `${prefix}docs/releases/v${version}.md`;
  if (!entries.map(String).includes(releaseNotes)) {
    throw new Error(`source archive is missing release notes for v${version}: ${releaseNotes}`);
  }
  if (typeof changelog !== 'string' || !changelog.includes(`## [${version}] - 2026-08-17`)) {
    throw new Error(`source archive changelog does not contain release ${version}`);
  }
}

export function renderSha256Sums(records) {
  if (!Array.isArray(records) || records.length === 0) {
    throw new TypeError('checksum records must be a non-empty array');
  }
  return [...records]
    .map(({ name, sha256 }) => {
      if (typeof name !== 'string' || !SAFE_ARTIFACT_NAME.test(name)) {
        throw new TypeError(`invalid artifact name for SHA256SUMS: ${String(name)}`);
      }
      if (typeof sha256 !== 'string' || !SHA256.test(sha256)) {
        throw new TypeError(`invalid SHA-256 for artifact ${name}`);
      }
      return { name, sha256 };
    })
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(({ name, sha256 }) => `${sha256}  ${name}\n`)
    .join('');
}

