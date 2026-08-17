# Licensing and Attribution Policy

## Project license

Original Persistent Terminal MCP code is released under the Apache License 2.0.

## Dependency policy

The npm dependency tree is locked by `package-lock.json`. CI runs `npm run licenses:check`, which fails when:

- a dependency lacks license metadata;
- a dependency reports an unknown/unlicensed marker;
- the checked-in `THIRD_PARTY_LICENSES.md` no longer matches the lockfile.

## External executables

OpenSSH, rsync, Docker, `pty-mcp`, and `ai-tmux` are not relicensed by this project. When they are used as external processes/services, their upstream licenses continue to govern those components.

## Copied source policy

Third-party source is not currently vendored into this repository.

If that changes, every copied file/snippet must document:

- upstream project URL;
- exact source revision/tag where practical;
- source path or snippet origin;
- original license;
- required copyright and attribution text;
- local modifications.

Source headers required by the upstream license must be preserved. A reference in a README alone is not sufficient when the upstream license requires source-level retention.
