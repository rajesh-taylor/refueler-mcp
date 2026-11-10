#!/usr/bin/env node
/**
 * scripts/live-trust.js — MCP-Trust-1 live proof, through the real server over stdio
 *
 * Starts src/index.js as a client would, in a private temp folder, with its own
 * link folder. Sends a small file of random bytes (asked, then confirmed with the
 * code), fetches it through the link_file the send returned, and compares bytes.
 * Then a send with a password_file, and a file outside the folders. Every tool
 * result and the server's stderr are swept for the key, the fragment and the
 * password. Costs a few credits; the two transfers stay until they expire (7 days).
 *
 *   REFUELER_LIVE_KEY=… REFUELER_SIGN_KEY=… node scripts/live-trust.js
 *
 * Prints pass or fail only: never a link, a key or a password.
 */

import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

if (!process.env.REFUELER_LIVE_KEY || !process.env.REFUELER_SIGN_KEY) {
  console.error('Set REFUELER_LIVE_KEY and REFUELER_SIGN_KEY first.');
  process.exit(2);
}

const SERVER = fileURLToPath(new URL('../src/index.js', import.meta.url));
const sha = (b) => createHash('sha256').update(b).digest('hex');
const parse = (r) => JSON.parse(r.content[0].text);

const work = await realpath(await mkdtemp(path.join(os.tmpdir(), 'rf-trust-')));
await chmod(work, 0o700);
const links = path.join(work, 'links');
const inbox = path.join(work, 'in');
await mkdir(inbox);
const elsewhere = await realpath(await mkdtemp(path.join(os.tmpdir(), 'rf-trust-out-')));

let failed = 0;
const outputs = [];
function report(ok, label, seen = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'pass' : 'FAIL'}  ${label.padEnd(52)} ${seen}`);
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [SERVER],
  cwd: work,
  stderr: 'pipe',
  env: {
    PATH: process.env.PATH,
    HOME: process.env.HOME ?? '',
    REFUELER_LIVE_KEY: process.env.REFUELER_LIVE_KEY,
    REFUELER_SIGN_KEY: process.env.REFUELER_SIGN_KEY,
    REFUELER_LINK_DIR: links,
  },
});
const stderr = [];
transport.stderr?.on('data', (d) => stderr.push(String(d)));
const client = new Client({ name: 'live-trust', version: '1' }, { capabilities: {} });
await client.connect(transport);

async function call(name, args, timeout = 240_000) {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout });
  outputs.push(JSON.stringify(r));
  return parse(r);
}

async function untilDone(v, statusTool) {
  while (v.state === 'running') {
    await new Promise((r) => setTimeout(r, 2000));
    v = await call(statusTool, { job_id: v.job_id });
  }
  return v;
}

async function confirmedSend(args) {
  const ask = await call('refueler_send_file', args);
  report(ask.error === 'confirm_send' && Boolean(ask.confirm_id), 'send asks first, and sends nothing', ask.error);
  return untilDone(await call('refueler_send_file', { ...args, accept_send: ask.confirm_id }), 'refueler_send_status');
}

const secrets = [];
try {
  // 1. Plain send → fetch through link_file.
  const bytes = randomBytes(1024);
  const file = path.join(work, 'trust-small.bin');
  await writeFile(file, bytes);

  const sent = await confirmedSend({ file_path: file });
  report(sent.state === 'complete', 'send completes after the yes', sent.error ?? sent.state);
  report(sent.share_url === undefined, 'no share_url in the result');
  report(typeof sent.link_file === 'string' && sent.link_file.startsWith(await realpath(links)), 'result names a link file in the link folder');

  const link = (await readFile(sent.link_file, 'utf8')).trim();
  const fragment = link.split('#')[1];
  const k = JSON.parse(Buffer.from(fragment, 'base64url').toString()).k;
  secrets.push(fragment, k, Buffer.from(k, 'base64url').toString('hex'));
  report(((await stat(sent.link_file)).mode & 0o777) === 0o600, 'link file is 0600');
  report(((await stat(links)).mode & 0o777) === 0o700, 'link folder is 0700');

  const got = await untilDone(await call('refueler_fetch', { link_file: sent.link_file, out_dir: inbox }), 'refueler_fetch_status');
  const same = got.state === 'complete' && sha(await readFile(got.path)) === sha(bytes);
  report(same, 'fetch through link_file, byte for byte', same ? 'bytes match' : (got.error ?? 'BYTES DIFFER'));
  if (got.path) await rm(got.path);
  await rm(file);

  // 2. Send with a password_file.
  const password = `rfs-${randomBytes(12).toString('base64url')}`;
  secrets.push(password);
  const pwFile = path.join(work, 'pw.txt');
  await writeFile(pwFile, `${password}\n`, { mode: 0o600 });
  const file2 = path.join(work, 'trust-password.bin');
  await writeFile(file2, randomBytes(1024));
  const locked = await confirmedSend({ file_path: file2, password_file: pwFile });
  report(locked.state === 'complete' && locked.password_required === true, 'password send completes', locked.error ?? locked.state);
  const pwSaved = locked.password_file ? (await readFile(locked.password_file, 'utf8')).trim() : null;
  report(pwSaved === password, 'password copied to <uuid>.password');
  const lockedLink = (await readFile(locked.link_file, 'utf8')).trim();
  secrets.push(lockedLink.split('#')[1]);
  const browser = await call('refueler_fetch', { link_file: locked.link_file, out_dir: inbox });
  report(browser.error === 'open_in_browser', 'password link goes to a browser', browser.error ?? browser.state);
  await rm(file2);

  // 3. A file outside the folders, and a password as tool input.
  const outside = path.join(elsewhere, 'x.txt');
  await writeFile(outside, 'x');
  const refused = await call('refueler_send_file', { file_path: outside });
  report(refused.error === 'outside_allowed_folders' && /REFUELER_ROOT/.test(refused.detail),
    'file outside the folders refused, naming REFUELER_ROOT', refused.error);
  const inInput = await call('refueler_send_file', { file_path: path.join(work, 'pw.txt'), passphrase: 'rfs_test_x12345' });
  report(inInput.error === 'password_in_input', 'password as tool input refused', inInput.error);
} catch (e) {
  report(false, 'run stopped', e?.name ?? 'error');
} finally {
  await client.close().catch(() => {});
  const everything = [...outputs, stderr.join('')];
  const leaked = everything.some((t) => secrets.some((s) => s && t.includes(s)) || t.includes('share.refueler.io/?uuid'));
  report(secrets.length >= 4 && !leaked, 'no key, fragment, link or password in any result or stderr');
  await rm(work, { recursive: true, force: true });
  await rm(elsewhere, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} failed.` : '\nAll passed.');
process.exit(failed ? 1 : 0);
