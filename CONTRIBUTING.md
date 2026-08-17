# Contributing

Persistent Terminal MCP is remote-administration software. Contributions are expected to meet a stricter bar than ordinary command wrappers.

## Development rules

1. Add or update a failing test before changing behavior.
2. Preserve native OpenSSH semantics instead of reimplementing SSH policy.
3. Do not add generic full-stack restarts as error recovery.
4. Do not log credentials, private-key material, secret payloads, or terminal scrollback containing secrets.
5. Keep upstream `pty-mcp` integration as an adapter; do not duplicate its terminal engine without an architectural reason.
6. Every new tool needs success-path, validation-path, and failure-path coverage.
7. Live-only behavior must also have deterministic unit/integration coverage where practical.
8. Run `npm run quality` before opening a pull request.

## Third-party code

Do not paste or vendor third-party source without documenting:

- upstream project and URL;
- exact revision/tag when known;
- source file/snippet location;
- upstream license;
- required copyright/attribution notice.

Update `THIRD_PARTY_NOTICES.md` and, when applicable, preserve source-level license headers.

## Pull requests

Pull requests should explain the invariant being changed, tests added, failure modes considered, and any effect on backward compatibility or security boundaries.
