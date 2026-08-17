import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LEGACY_LOCAL_TOOL_NAMES,
  LOCAL_TOOL_ANNOTATIONS,
  annotateLocalTool,
  annotateLocalTools,
} from '../src/tool-annotations.mjs';
import { buildLegacyAliasTools } from '../src/legacy-aliases.mjs';
import { LOCAL_TOOLS, buildToolCatalog } from '../src/tool-registry.mjs';

const ANNOTATION_KEYS = Object.freeze([
  'destructiveHint',
  'idempotentHint',
  'openWorldHint',
  'readOnlyHint',
]);

function assertCompleteAnnotations(tool) {
  assert.ok(tool?.annotations, `${tool?.name ?? '<unknown>'} is missing annotations`);
  assert.deepEqual(Object.keys(tool.annotations).sort(), [...ANNOTATION_KEYS]);
  for (const key of ANNOTATION_KEYS) {
    assert.equal(typeof tool.annotations[key], 'boolean', `${tool.name}.${key} must be boolean`);
  }
}

test('annotation policy exhaustively covers canonical local tools and exactly three local legacy aliases', () => {
  const canonicalNames = LOCAL_TOOLS.map((tool) => tool.name).sort();
  const policyCanonicalNames = Object.keys(LOCAL_TOOL_ANNOTATIONS)
    .filter((name) => !LEGACY_LOCAL_TOOL_NAMES.has(name))
    .sort();

  assert.equal(canonicalNames.length, 49);
  assert.deepEqual(policyCanonicalNames, canonicalNames);
  assert.deepEqual([...LEGACY_LOCAL_TOOL_NAMES].sort(), [
    'ssh_ensure_session',
    'ssh_exec',
    'ssh_read_session',
  ]);
  for (const name of Object.keys(LOCAL_TOOL_ANNOTATIONS)) {
    const policy = LOCAL_TOOL_ANNOTATIONS[name];
    assert.deepEqual(Object.keys(policy).sort(), [...ANNOTATION_KEYS]);
    for (const key of ANNOTATION_KEYS) assert.equal(typeof policy[key], 'boolean');
  }
});

test('every canonical local tool publishes all four MCP annotation booleans', () => {
  for (const tool of LOCAL_TOOLS) assertCompleteAnnotations(tool);
});

test('read-only diagnostic and filesystem inspection tools are conservatively marked non-destructive', () => {
  for (const name of [
    'system_info',
    'remote_stat',
    'remote_read',
    'target_capabilities',
    'target_diagnose',
    'terminal_health',
  ]) {
    const annotation = LOCAL_TOOL_ANNOTATIONS[name];
    assert.equal(annotation.readOnlyHint, true, `${name} must be read-only`);
    assert.equal(annotation.destructiveHint, false, `${name} must be non-destructive`);
    assert.equal(annotation.idempotentHint, true, `${name} read must be idempotent`);
  }
});

test('arbitrary execution and controlled mutation tools are never misrepresented as read-only', () => {
  for (const name of [
    'admin_transaction',
    'remote_exec',
    'remote_root_exec',
    'remote_write',
    'remote_patch',
    'remote_delete',
    'task_start',
    'task_cancel',
    'process_signal',
    'service_restart',
    'systemd_unit_action',
    'systemd_daemon_reload',
  ]) {
    const annotation = LOCAL_TOOL_ANNOTATIONS[name];
    assert.equal(annotation.readOnlyHint, false, `${name} must not be read-only`);
    assert.equal(annotation.destructiveHint, true, `${name} must be potentially destructive`);
  }
  assert.equal(LOCAL_TOOL_ANNOTATIONS.service_restart.idempotentHint, false);
  assert.equal(LOCAL_TOOL_ANNOTATIONS.systemd_unit_action.idempotentHint, false);
  assert.equal(LOCAL_TOOL_ANNOTATIONS.admin_transaction.idempotentHint, false);
});

test('open-world hints distinguish remote/network operations from local persisted registry views', () => {
  for (const name of [
    'remote_exec',
    'remote_read',
    'remote_upload',
    'forward_create',
    'task_status',
    'system_info',
    'target_diagnose',
    'terminal_health',
  ]) {
    assert.equal(LOCAL_TOOL_ANNOTATIONS[name].openWorldHint, true, `${name} must be open-world`);
  }
  for (const name of ['named_session_list', 'task_list']) {
    assert.equal(LOCAL_TOOL_ANNOTATIONS[name].openWorldHint, false, `${name} is a local registry view`);
  }
});

test('annotator returns frozen copies and fails closed for unknown local names without mutating source tools', () => {
  const source = Object.freeze({
    name: 'system_info',
    description: 'source',
    inputSchema: Object.freeze({ type: 'object' }),
  });
  const annotated = annotateLocalTool(source);
  assert.notStrictEqual(annotated, source);
  assert.equal(source.annotations, undefined);
  assertCompleteAnnotations(annotated);
  assert.equal(Object.isFrozen(annotated), true);
  assert.equal(Object.isFrozen(annotated.annotations), true);
  assert.throws(
    () => annotateLocalTool({ name: 'unknown_local_tool', inputSchema: { type: 'object' } }),
    /annotation policy.*unknown_local_tool/i,
  );
  assert.throws(
    () => annotateLocalTools([{ name: 'system_info' }, { name: 'unknown_local_tool' }]),
    /annotation policy.*unknown_local_tool/i,
  );
});

test('tool catalog leaves upstream tool objects untouched while publishing annotated local tools', () => {
  const upstream = Object.freeze({
    name: 'upstream_probe',
    description: 'upstream untouched',
    inputSchema: Object.freeze({ type: 'object' }),
    annotations: Object.freeze({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
      vendorSentinel: 'keep-me',
    }),
  });

  const catalog = buildToolCatalog({ upstreamTools: [upstream] });
  assert.strictEqual(catalog.find((tool) => tool.name === 'upstream_probe'), upstream);
  assert.equal(upstream.annotations.vendorSentinel, 'keep-me');
  assertCompleteAnnotations(catalog.find((tool) => tool.name === 'system_info'));
});

test('legacy aliases receive local annotation semantics without rewriting upstream read_output', () => {
  const upstreamReadOutput = Object.freeze({
    name: 'read_output',
    description: 'upstream read',
    inputSchema: Object.freeze({ type: 'object' }),
  });
  const catalog = buildToolCatalog({ upstreamTools: [upstreamReadOutput] });
  const aliases = buildLegacyAliasTools(catalog.filter((tool) => !tool.name.startsWith('ssh_')));

  const sshExec = aliases.find((tool) => tool.name === 'ssh_exec');
  const sshEnsure = aliases.find((tool) => tool.name === 'ssh_ensure_session');
  const sshRead = aliases.find((tool) => tool.name === 'ssh_read_session');

  assert.deepEqual(sshExec.annotations, LOCAL_TOOL_ANNOTATIONS.remote_exec);
  assert.deepEqual(sshEnsure.annotations, LOCAL_TOOL_ANNOTATIONS.ensure_session);
  assert.deepEqual(sshRead.annotations, LOCAL_TOOL_ANNOTATIONS.ssh_read_session);
  assert.equal(upstreamReadOutput.annotations, undefined);
  assert.match(sshRead.description, /DEPRECATED: use read_output/u);
});
