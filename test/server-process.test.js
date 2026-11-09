/**
 * test/server-process.test.js — the real server, over stdio (MCP-Fetch-1)
 * node:test only. Fake Worker on 127.0.0.1.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createFakeWorker, makeTransfer } from './helpers/fake-worker.js';

const SERVER = fileURLToPath(new URL('../src/index.js', import.meta.url));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const parse = (r) => JSON.parse(r.content[0].text);

let dir, open = [];

beforeEach(async () => {
  dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'rf-proc-')));
  open = [];
});

afterEach(async () => {
  for (const close of open) await close().catch(() => {});
  await rm(dir, { recursive: true, force: true });
});

async function connect({ env = {}, capabilities = {}, cwd = dir, setup } = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: { PATH: process.env.PATH, HOME: process.env.HOME ?? '', ...env },
    cwd,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'test', version: '1' }, { capabilities });
  setup?.(client);
  const stderr = [];
  transport.stderr?.on('data', d => stderr.push(String(d)));
  await client.connect(transport);
  open.push(() => client.close());
  return { client, stderr, transport };
}

async function withWorker(t) {
  const worker = createFakeWorker(t);
  const served = await worker.listen();
  open.push(served.close);
  return { worker, apiBase: served.apiBase };
}

describe('keyless start', () => {
  test('starts with no keys and lists every tool', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const names = tools.map(t => t.name);
    assert.ok(names.includes('refueler_fetch'));
    assert.ok(names.includes('refueler_fetch_status'));
    assert.ok(names.includes('refueler_send_file'));
  });

  test('reports the version in package.json', async () => {
    const { client } = await connect();
    assert.equal(client.getServerVersion().version, pkg.version);
  });

  for (const tool of ['refueler_quote', 'refueler_balance', 'refueler_send_file', 'refueler_check_transfer']) {
    test(`${tool} says it needs keys`, async () => {
      const { client } = await connect();
      const r = await client.callTool({ name: tool, arguments: { file_path: '/x', size_bytes: 1, uuid: 'x' } });
      assert.equal(parse(r).error, 'api_keys_required');
      assert.equal(r.isError, true);
    });
  }

  test('one key without the other stops at start', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER],
      env: { PATH: process.env.PATH, REFUELER_LIVE_KEY: 'rfs_live_x' },
      cwd: dir,
      stderr: 'pipe',
    });
    const client = new Client({ name: 'test', version: '1' }, { capabilities: {} });
    await assert.rejects(() => client.connect(transport));
    await client.close().catch(() => {});
  });

  test('share_url is not offered by default', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    assert.equal(tools.find(t => t.name === 'refueler_fetch').inputSchema.properties.share_url, undefined);
  });

  test('REFUELER_LINK_IN_CHAT=1 offers it', async () => {
    const { client } = await connect({ env: { REFUELER_LINK_IN_CHAT: '1' } });
    const { tools } = await client.listTools();
    assert.ok(tools.find(t => t.name === 'refueler_fetch').inputSchema.properties.share_url);
  });
});

describe('fetch through the real server', () => {
  test('keyless, byte for byte, and nothing secret on stderr', async () => {
    const t = await makeTransfer({ size: 70_000 });
    const { worker, apiBase } = await withWorker(t);
    const { client, stderr } = await connect({ env: { REFUELER_API_BASE: apiBase } });

    const linkFile = path.join(dir, 'in.link');
    await writeFile(linkFile, t.link, { mode: 0o600 });

    const r = await client.callTool({ name: 'refueler_fetch', arguments: { link_file: linkFile, out_dir: dir } });
    const out = parse(r);
    assert.equal(out.state, 'complete');
    assert.deepEqual(new Uint8Array(await readFile(out.path)), t.plain);

    const seen = JSON.stringify(r) + stderr.join('');
    assert.ok(!seen.includes(t.fragment));
    assert.ok(!seen.includes(Buffer.from(t.key).toString('base64url')));

    for (const { headers } of worker.requests) {
      assert.equal(headers.authorization, undefined);
      assert.equal(headers['x-api-sign-key'], undefined);
    }
  });

  test('signs nothing even with keys in the environment', async () => {
    const t = await makeTransfer();
    const { worker, apiBase } = await withWorker(t);
    const { client } = await connect({
      env: { REFUELER_API_BASE: apiBase, REFUELER_LIVE_KEY: 'rfs_live_x', REFUELER_SIGN_KEY: 'rfs_sign_x' },
    });
    const linkFile = path.join(dir, 'in.link');
    await writeFile(linkFile, t.link);
    await client.callTool({ name: 'refueler_fetch', arguments: { link_file: linkFile, out_dir: dir } });
    assert.ok(worker.requests.length >= 2);
    for (const { headers } of worker.requests) {
      assert.equal(headers.authorization, undefined);
      assert.equal(headers['x-api-sign-key'], undefined);
    }
  });

  test('uses the client\'s roots when it has them', async () => {
    const t = await makeTransfer();
    const { apiBase } = await withWorker(t);
    const elsewhere = await realpath(await mkdtemp(path.join(os.tmpdir(), 'rf-else-')));
    open.push(() => rm(elsewhere, { recursive: true, force: true }));

    const { client } = await connect({
      env: { REFUELER_API_BASE: apiBase },
      capabilities: { roots: {} },
      setup: (c) => c.setRequestHandler(ListRootsRequestSchema, async () => ({
        roots: [{ uri: pathToFileURL(elsewhere).href }],
      })),
    });

    const linkFile = path.join(elsewhere, 'in.link');
    await writeFile(linkFile, t.link);

    const refused = parse(await client.callTool({ name: 'refueler_fetch', arguments: { link_file: linkFile, out_dir: dir } }));
    assert.equal(refused.error, 'outside_allowed_folders');

    const fine = parse(await client.callTool({ name: 'refueler_fetch', arguments: { link_file: linkFile, out_dir: elsewhere } }));
    assert.equal(fine.state, 'complete');
  });

  test('a client going away ends the fetch and removes the part file', async () => {
    const t = await makeTransfer();
    const worker = createFakeWorker(t);
    let requested;
    const asked = new Promise(r => { requested = r; });
    worker.script.download = () => { requested(); return new Promise(() => {}); };
    const served = await worker.listen();
    open.push(served.close);

    const { client, transport } = await connect({ env: { REFUELER_API_BASE: served.apiBase } });
    const linkFile = path.join(dir, 'in.link');
    await writeFile(linkFile, t.link);

    const call = client.callTool({ name: 'refueler_fetch', arguments: { link_file: linkFile, out_dir: dir } });
    call.catch(() => {});
    await asked;
    assert.equal((await readdir(dir)).filter(f => f.endsWith('.refueler-part')).length, 1);

    const pid = transport.pid;
    await client.close();

    for (let i = 0; i < 100; i++) {
      let alive = true;
      try { process.kill(pid, 0); } catch { alive = false; }
      if (!alive) break;
      await new Promise(r => setTimeout(r, 50));
    }
    assert.throws(() => process.kill(pid, 0));
    assert.equal((await readdir(dir)).filter(f => f.endsWith('.refueler-part')).length, 0);
  });
});
