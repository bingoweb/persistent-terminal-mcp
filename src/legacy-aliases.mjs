import { annotationForLocalTool } from './tool-annotations.mjs';

export const LEGACY_ALIAS_SPECS = Object.freeze([
  Object.freeze({ name: 'ssh_exec', target: 'remote_exec' }),
  Object.freeze({ name: 'ssh_ensure_session', target: 'ensure_session' }),
  Object.freeze({ name: 'ssh_read_session', target: 'read_output' }),
]);

const LEGACY_ALIAS_BY_NAME = new Map(
  LEGACY_ALIAS_SPECS.map((spec) => [spec.name, spec]),
);

export function buildLegacyAliasTools(canonicalTools = []) {
  const canonicalByName = new Map(
    canonicalTools
      .filter((tool) => tool?.name && typeof tool.name === 'string')
      .map((tool) => [tool.name, tool]),
  );

  const aliases = [];
  for (const spec of LEGACY_ALIAS_SPECS) {
    const canonical = canonicalByName.get(spec.target);
    if (!canonical) continue;

    aliases.push({
      ...canonical,
      name: spec.name,
      description: `DEPRECATED: use ${spec.target}. ${canonical.description ?? ''}`.trim(),
      annotations: annotationForLocalTool(spec.name),
    });
  }
  return aliases;
}

export function resolveLegacyAliasCall(name, args) {
  const spec = LEGACY_ALIAS_BY_NAME.get(name);
  if (!spec) return null;
  return {
    target: spec.target,
    args,
  };
}
