# Third-Party Notices

Persistent Terminal MCP is licensed under Apache-2.0. The components below retain their original licenses.

## Source code copied or vendored into this repository

**None at this time.** No source file or source-code snippet from `pty-mcp`, `ai-tmux`, OpenSSH, rsync, Docker, or the MCP SDK has been copied into this repository.

If third-party source is copied or vendored later, the contribution must preserve the applicable source-level notices and add the upstream project, exact revision/tag, source location, and license to this file.

## Direct npm dependencies

### `@modelcontextprotocol/sdk` 1.30.0

- Project: Model Context Protocol TypeScript SDK
- Upstream: `https://github.com/modelcontextprotocol/typescript-sdk`
- License: MIT
- Usage: MCP client/server protocol implementation and transports.

### `zod` 4.4.3

- Project: Zod
- Upstream: `https://github.com/colinhacks/zod`
- License: MIT
- Usage: dependency of the MCP SDK and schema/runtime validation ecosystem.

The complete locked npm dependency inventory is recorded in [`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md). The inventory is CI-checked against `package-lock.json`.

## External upstream/runtime components

These programs are **not bundled or redistributed** by this repository. They are invoked or connected to at runtime and retain their own licenses.

### `pty-mcp` and `ai-tmux`

- Upstream: `https://github.com/raychao-oao/pty-mcp`
- License: MIT
- Copyright notice in upstream LICENSE: `Copyright (c) 2026 pty-mcp contributors`
- `ai-tmux` source is maintained in the same upstream repository under `cmd/ai-tmux` and is covered by that repository's MIT license.
- Usage: persistent interactive PTY/session layer.

### OpenSSH Portable

- Upstream: `https://github.com/openssh/openssh-portable`
- License: multi-component BSD/permissive terms described in the upstream `LICENCE` file.
- Upstream summary states that all components are under a BSD licence or a licence more permissive than BSD and that OpenSSH contains no GPL code.
- Usage: native SSH transport and OpenSSH configuration semantics.

### rsync

- Upstream: `https://github.com/RsyncProject/rsync`
- License: GNU GPL version 3 as described in upstream `COPYING`, including the upstream OpenSSL/xxhash dynamic-linking exception.
- Usage: optional future resumable/synchronized file-transfer provider.
- Not bundled.

### Docker CLI / Docker Engine integration

- Docker CLI upstream: `https://github.com/docker/cli`
- Docker CLI license: Apache-2.0
- Usage: optional future explicit privileged/root provider on hosts where the operator deliberately enables Docker-based host access.
- Not bundled.

## License-policy rule

Adding a new dependency is not complete until:

1. `package-lock.json` contains known license metadata;
2. `THIRD_PARTY_LICENSES.md` is updated;
3. direct or externally invoked components are added to this notice when materially relevant;
4. copied/vendored code includes source-level attribution and its required license notice.
