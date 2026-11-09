#!/usr/bin/env node
/**
 * scripts/live-roundtrip.js — MCP-Fetch-1 live proof
 *
 * Sends four small files of random bytes with the MCP send path and fetches them
 * with refueler_fetch on the live Worker, byte for byte, then runs each cut or
 * edited link. Costs a few credits. Two transfers stay until they expire (7 days).
 *
 *   REFUELER_LIVE_KEY=… REFUELER_SIGN_KEY=… node scripts/live-roundtrip.js
 *
 * Links go to a 0600 file in a private temp folder, removed at the end. This
 * script prints codes and pass or fail only: never a link, a key or a password.
 */

import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApiClient } from '../src/api.js';
import { loadConfig } from '../src/config.js';
import { createJobRunner } from '../src/jobs.js';
import { handleSendFile } from '../src/tools/send.js';
import { handleFetch } from '../src/tools/fetch.js';
import { refuelerBalance } from '../src/tools/balance.js';

const config = loadConfig();
if (!config.hasApiKeys) {
  console.error('Set REFUELER_LIVE_KEY and REFUELER_SIGN_KEY first.');
  process.exit(2);
}

const api = createApiClient(config);
const jobs = createJobRunner();
const sha = (b) => createHash('sha256').update(b).digest('hex');
const SMALL = 1024;
const TWO_PARTS = 33 * 1024 * 1024;

const work = await realpath(await mkdtemp(path.join(os.tmpdir(), 'rf-live-')));
await chmod(work, 0o700);
const inbox = path.join(work, 'in');
await mkdir(inbox);

let failed = 0;
const secrets = [];

function report(ok, label, seen) {
  if (!ok) failed++;
  console.log(`${ok ? 'pass' : 'FAIL'}  ${label.padEnd(46)} ${seen ?? ''}`);
}

async function send(name, size, options = {}) {
  const bytes = randomBytes(size);
  const file = path.join(work, name);
  await writeFile(file, bytes);
  const [{ text }] = await handleSendFile({ file_path: file, ...options }, { api, config });
  const out = JSON.parse(text);
  if (!out.share_url) {
    console.log(`FAIL  send ${name}: ${out.error} (${String(out.detail ?? '').slice(0, 120)})`);
    throw new Error('send failed');
  }
  await rm(file);
  const fragment = out.share_url.split('#')[1];
  const fields = JSON.parse(Buffer.from(fragment, 'base64url').toString());
  secrets.push(fragment, fields.k);
  return { uuid: out.uuid, link: out.share_url, fragment, fields, digest: sha(bytes), cost: out.cost_credits };
}

async function fetchLink(link, input = {}) {
  const linkFile = path.join(work, 'current.link');
  await writeFile(linkFile, link, { mode: 0o600 });
  const raw = await handleFetch({ link_file: linkFile, out_dir: inbox, ...input }, {
    config, jobs, clientRoots: async () => [pathToFileURL(work).href], foregroundMs: 240_000,
  });
  await rm(linkFile);
  const text = JSON.stringify(raw);
  for (const s of secrets) {
    if (text.includes(s)) report(false, 'a secret appeared in a result', '');
  }
  return JSON.parse(raw.content[0].text);
}

const blob = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const rebuilt = (t, fields) => `https://share.refueler.io/?uuid=${t.uuid}#${blob(fields)}`;

async function expectCode(label, link, code, input) {
  const r = await fetchLink(link, input);
  const seen = r.error ?? r.state;
  report(Array.isArray(code) ? code.includes(seen) : seen === code, label, seen);
  if (r.path) await rm(r.path);
}

async function expectBytes(label, t, input, expectedName) {
  const r = await fetchLink(t.link, input);
  if (r.state !== 'complete') return report(false, label, r.error ?? r.state);
  const same = sha(await readFile(r.path)) === t.digest;
  report(same && (!expectedName || r.name === expectedName), label, same ? 'bytes match' : 'BYTES DIFFER');
  await rm(r.path);
}

try {
  const balance = await refuelerBalance({}, { api, config });
  report(!balance.error, 'balance tool reaches auth/ping (api.ping fix)', balance.error ?? 'ok');

  console.log('\nSending four files…');
  const small = await send('small.bin', SMALL);
  const big = await send('two-parts.bin', TWO_PARTS);
  const once = await send('works-once.bin', TWO_PARTS, { destroy_after_download: true });
  const locked = await send('password.bin', SMALL, { passphrase: randomBytes(16).toString('hex') });
  console.log(`Sent. Cost ${small.cost + big.cost + once.cost + locked.cost} credits in all.\n`);

  await expectBytes('small file, byte for byte', small);
  await expectBytes('33 MiB, two parts, byte for byte', big);

  const f = big.fields;
  const [head] = big.link.split('#');
  const otherKey = Buffer.from(f.k, 'base64url');
  otherKey[0] ^= 1;
  const otherUuid = big.uuid.replace(/.$/, (c) => (c === '0' ? '1' : '0'));

  await expectCode('cut before the #', head, 'link_damaged');
  await expectCode('cut half way through the key part', `${head}#${big.fragment.slice(0, 40)}`, 'link_damaged');
  await expectCode('last character cut', big.link.slice(0, -1), 'link_damaged');
  await expectCode('transfer ID removed', `https://share.refueler.io/#${big.fragment}`, 'link_damaged');
  await expectCode('transfer ID edited', big.link.replace(big.uuid, otherUuid), 'not_found');
  await expectCode('host edited', big.link.replace('share.refueler.io', 'share.refueler.io.example.org'), 'link_wrong_host');
  await expectCode('key edited (stops at the first part)', rebuilt(big, { ...f, k: otherKey.toString('base64url') }), 'decrypt_failed');
  await expectCode('size edited, other part count', rebuilt(big, { ...f, z: 5 }), 'link_damaged');
  await expectCode('size edited, same part count', rebuilt(big, { ...f, z: f.z + 1 }), 'integrity_failed');
  await expectCode('version edited to 1', rebuilt(big, { ...f, v: 1 }), 'open_in_browser');
  await expectCode('version edited to 3', rebuilt(big, { ...f, v: 3 }), 'link_v3_not_yet');
  await expectBytes('name edited (stated limit: bytes still match)',
    { ...big, link: rebuilt(big, { ...f, n: 'edited.bin' }) }, undefined, 'edited.bin');

  await expectCode('password link goes to a browser', locked.link, 'open_in_browser');

  await expectCode('works-once link stops and asks', once.link, 'link_works_once');
  await expectBytes('works-once link, after a yes, byte for byte', once, { accept_link_works_once: true });
  await new Promise(r => setTimeout(r, 5000));
  await expectCode('works-once link, second time, is gone', once.link, ['link_gone', 'not_found'], { accept_link_works_once: true });
} catch (e) {
  failed++;
  console.log(`FAIL  stopped early: ${e.name}`);
} finally {
  await jobs.abortAll();
  await rm(work, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
process.exit(failed ? 1 : 0);
