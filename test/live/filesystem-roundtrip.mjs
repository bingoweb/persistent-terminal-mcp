import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const HOST = process.env.PTY_MCP_SMOKE_HOST;
const THIS_FILE = fileURLToPath(import.meta.url);
const PACKAGE_ROOT = path.resolve(path.dirname(THIS_FILE), '../..');

function parseToolJson(result) {
  if (result?.structuredContent !== undefined) return result.structuredContent;
  const text = result?.content?.find?.((item) => item?.type === 'text')?.text;
  if (typeof text !== 'string') {
    throw new Error(`tool result has no JSON payload: ${JSON.stringify(result)}`);
  }
  return JSON.parse(text);
}

function assertToolSuccess(result, name) {
  if (result?.isError === true) {
    throw new Error(`${name} failed: ${JSON.stringify(parseToolJson(result))}`);
  }
  return parseToolJson(result);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function run() {
  if (!HOST) {
    throw new Error('PTY_MCP_SMOKE_HOST is required for the live filesystem round-trip test');
  }

  const unique = `${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}`;
  const root = `/tmp/persistent-terminal-extended-${unique}`;
  const originalPath = `${root}/notes with spaces.txt`;
  const movedPath = `${root}/moved notes.txt`;
  const originalText = 'alpha before omega\nneedle original\n';
  const patchedText = 'alpha after omega\nneedle original\n';

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['src/server.mjs'],
    cwd: PACKAGE_ROOT,
    env: {
      ...(process.env.PTY_UPSTREAM_URL ? { PTY_UPSTREAM_URL: process.env.PTY_UPSTREAM_URL } : {}),
    },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  const client = new Client({
    name: 'persistent-terminal-filesystem-live',
    version: '1.0.0',
  });
  let rootCreated = false;

  const call = async (name, arguments_) => client.callTool({ name, arguments: arguments_ });

  try {
    try {
      await client.connect(transport);
    } catch (error) {
      throw new Error(
        `extension failed to start${stderr ? `: ${stderr.trim()}` : ''}`,
        { cause: error },
      );
    }

    const listed = await client.listTools();
    for (const toolName of [
      'remote_mkdir',
      'remote_write',
      'remote_read',
      'remote_patch',
      'remote_grep',
      'remote_find',
      'remote_move',
      'remote_list',
      'remote_delete',
    ]) {
      assert(listed.tools.some((tool) => tool.name === toolName), `missing canonical tool ${toolName}`);
    }

    const created = assertToolSuccess(await call('remote_mkdir', {
      target: HOST,
      path: root,
    }), 'remote_mkdir');
    assert(created.path === root && created.created === true, `unexpected mkdir result: ${JSON.stringify(created)}`);
    rootCreated = true;

    const written = assertToolSuccess(await call('remote_write', {
      target: HOST,
      path: originalPath,
      text: originalText,
    }), 'remote_write');
    assert(written.created === true, `remote_write did not create file: ${JSON.stringify(written)}`);
    assert(/^[0-9a-f]{64}$/.test(written.sha256), `remote_write returned invalid SHA-256: ${JSON.stringify(written)}`);

    const readBefore = assertToolSuccess(await call('remote_read', {
      target: HOST,
      path: originalPath,
    }), 'remote_read before conflict');
    assert(readBefore.text === originalText, `initial read mismatch: ${JSON.stringify(readBefore)}`);
    assert(readBefore.sha256 === written.sha256, 'initial read SHA-256 differs from write result');

    const conflictResult = await call('remote_write', {
      target: HOST,
      path: originalPath,
      text: 'THIS MUST NOT BE WRITTEN\n',
      expected_sha256: '0'.repeat(64),
    });
    assert(conflictResult?.isError === true, `SHA conflict unexpectedly succeeded: ${JSON.stringify(conflictResult)}`);
    const conflict = parseToolJson(conflictResult);
    assert(
      conflict.category === 'checksum_integrity_failure',
      `wrong SHA conflict category: ${JSON.stringify(conflict)}`,
    );

    const readAfterConflict = assertToolSuccess(await call('remote_read', {
      target: HOST,
      path: originalPath,
    }), 'remote_read after conflict');
    assert(readAfterConflict.text === originalText, 'SHA conflict modified remote file contents');
    assert(readAfterConflict.sha256 === written.sha256, 'SHA conflict modified remote file hash');

    const patched = assertToolSuccess(await call('remote_patch', {
      target: HOST,
      path: originalPath,
      expected_sha256: written.sha256,
      hunks: [{ old_text: 'before', new_text: 'after', expected_count: 1 }],
    }), 'remote_patch');
    assert(patched.hunks_applied === 1, `unexpected patch result: ${JSON.stringify(patched)}`);

    const grep = assertToolSuccess(await call('remote_grep', {
      target: HOST,
      path: root,
      pattern: '^needle',
      max_depth: 2,
      max_results: 10,
      max_bytes: 65536,
    }), 'remote_grep');
    assert(grep.truncated === false, `grep unexpectedly truncated: ${JSON.stringify(grep)}`);
    assert(grep.result_count === 1, `grep expected one match: ${JSON.stringify(grep)}`);
    assert(grep.matches[0]?.path === originalPath, `grep path mismatch: ${JSON.stringify(grep)}`);
    assert(grep.matches[0]?.line_number === 2, `grep line number mismatch: ${JSON.stringify(grep)}`);

    const found = assertToolSuccess(await call('remote_find', {
      target: HOST,
      path: root,
      name_pattern: '*.txt',
      max_depth: 2,
      max_results: 10,
      max_bytes: 65536,
    }), 'remote_find');
    assert(found.result_count === 1 && found.entries[0]?.path === originalPath, `find mismatch: ${JSON.stringify(found)}`);

    const moved = assertToolSuccess(await call('remote_move', {
      target: HOST,
      source_path: originalPath,
      destination_path: movedPath,
    }), 'remote_move');
    assert(moved.moved === true && moved.destination_path === movedPath, `move mismatch: ${JSON.stringify(moved)}`);

    const listedDir = assertToolSuccess(await call('remote_list', {
      target: HOST,
      path: root,
    }), 'remote_list');
    assert(
      listedDir.entries.length === 1 && listedDir.entries[0]?.path === movedPath,
      `list mismatch after move: ${JSON.stringify(listedDir)}`,
    );

    const readMoved = assertToolSuccess(await call('remote_read', {
      target: HOST,
      path: movedPath,
    }), 'remote_read moved file');
    assert(readMoved.text === patchedText, `moved file content mismatch: ${JSON.stringify(readMoved)}`);
    assert(readMoved.sha256 === patched.sha256, 'moved file hash differs from patch result');

    const deletedFile = assertToolSuccess(await call('remote_delete', {
      target: HOST,
      path: movedPath,
    }), 'remote_delete file');
    assert(deletedFile.deleted === true && deletedFile.path === movedPath, `file delete mismatch: ${JSON.stringify(deletedFile)}`);

    const deletedRoot = assertToolSuccess(await call('remote_delete', {
      target: HOST,
      path: root,
    }), 'remote_delete root');
    assert(deletedRoot.deleted === true && deletedRoot.path === root, `root delete mismatch: ${JSON.stringify(deletedRoot)}`);
    rootCreated = false;

    process.stdout.write(
      `REMOTE_FILESYSTEM_ROUNDTRIP_OK root=${root} final_sha256=${patched.sha256} conflict_preserved=true\n`,
    );
  } finally {
    if (rootCreated) {
      await call('remote_delete', {
        target: HOST,
        path: root,
        recursive: true,
      }).catch(() => {});
    }
    await client.close().catch(() => {});
  }
}

run().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});
