import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

test('GitHub release workflow is tag-only and re-runs every release gate before publishing', async () => {
  const workflow = await fs.readFile(
    new URL('../.github/workflows/release.yml', import.meta.url),
    'utf8',
  );

  assert.match(workflow, /tags:\s*\n\s*-\s*["']v0\.\*\.\*["']/u);
  assert.match(workflow, /contents:\s*write/u);
  assert.match(workflow, /node-version:\s*["']22\.23\.1["']/u);
  assert.match(workflow, /run:\s*npm ci/u);
  assert.match(workflow, /run:\s*npm run quality/u);
  assert.match(workflow, /npm audit --omit=dev --audit-level=high/u);
  assert.match(workflow, /npm run release:check -- --require-tag/u);
  assert.match(workflow, /npm run release:artifacts/u);
  assert.match(workflow, /sha256sum -c SHA256SUMS/u);
  assert.match(workflow, /gh release create "\$GITHUB_REF_NAME"/u);
  assert.match(workflow, /--verify-tag/u);
  assert.match(workflow, /--notes-file "docs\/releases\/\$\{GITHUB_REF_NAME\}\.md"/u);
  assert.match(workflow, /GH_TOKEN:\s*\$\{\{ github\.token \}\}/u);
  assert.doesNotMatch(workflow, /--prerelease/u);
});

test('main CI checks release metadata before package dry-run', async () => {
  const workflow = await fs.readFile(
    new URL('../.github/workflows/ci.yml', import.meta.url),
    'utf8',
  );
  assert.match(workflow, /npm run release:check/u);
  assert.match(workflow, /npm pack --dry-run/u);
});

