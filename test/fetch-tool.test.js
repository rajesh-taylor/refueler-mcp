/**
 * test/fetch-tool.test.js — refueler_fetch against a fake Worker (MCP-Fetch-1)
 * node:test only.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fetchToolDefinition, handleFetch, handleFetchStatus } from '../src/tools/fetch.js';
import { createJobRunner } from '../src/jobs.js';
import { CHUNK_SIZE, CHUNK_TAG_BYTES } from '../src/crypto.js';
import { createFakeWorker, makeTransfer } from './helpers/fake-worker.js';

const noWait = async () => {};
const tuning = { retryDelays: [1, 1], metaRetryDelays: [1], wait: noWait };
const disk = { statfsImpl: async () => ({ bavail: 1e12, bsize: 4096, type: 0 }), platform: 'test' };
const parse = (r) => JSON.parse(r.content[0].text);

let dir, config, jobs;

beforeEach(async () => {
  dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'rf-fetch-')));
  config = {
    apiBase: 'http://worker.test',
    linkHosts: ['share.refueler.io'],
    linkInChat: false,
    rootEnv: null,
    liveKey: 'rfs_live_SHOULD_NEVER_BE_SENT',
    signKey: 'rfs_sign_SHOULD_NEVER_BE_SENT',
    hasApiKeys: true,
  };
  jobs = createJobRunner();
});

afterEach(async () => {
  await jobs.abortAll();
  await rm(dir, { recursive: true, force: true });
});

function depsFor(worker, extra = {}) {
  return {
    config, jobs, disk, tuning,
    fetchImpl: worker.fetch,
    clientRoots: async () => [pathToFileURL(dir).href],
    ...extra,
  };
}

async function saveLink(text, name = 'in.link') {
  const f = path.join(dir, name);
  await writeFile(f, text, { mode: 0o600 });
  return f;
}

async function fetchIt(worker, link, input = {}, extra = {}) {
  return handleFetch({ link_file: await saveLink(link), out_dir: dir, ...input }, depsFor(worker, extra));
}

const blobOf = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const fieldsOf = (t) => JSON.parse(Buffer.from(t.fragment, 'base64url').toString());
const linkWith = (t, obj) => `https://share.refueler.io/?uuid=${t.uuid}#${blobOf(obj)}`;
const leftovers = async () => (await readdir(dir)).filter(f => f.endsWith('.refueler-part'));

describe('round trip', () => {
  test('one part, byte for byte, with the contracted result', async () => {
    const t = await makeTransfer({ size: 4096 });
    const r = parse(await fetchIt(createFakeWorker(t), t.link));
    assert.equal(r.state, 'complete');
    assert.equal(r.path, path.join(dir, 'report.pdf'));
    assert.equal(r.name, 'report.pdf');
    assert.equal(r.size_bytes, 4096);
    assert.equal(r.uuid, t.uuid);
    assert.deepEqual(new Uint8Array(await readFile(r.path)), t.plain);
    assert.deepEqual(await leftovers(), []);
  });

  test('several parts, in order, tail last', async () => {
    const t = await makeTransfer({ size: 2 * CHUNK_SIZE + 100 });
    const w = createFakeWorker(t);
    const r = parse(await fetchIt(w, t.link));
    assert.equal(r.state, 'complete');
    assert.deepEqual(new Uint8Array(await readFile(r.path)), t.plain);
    assert.equal(w.order.at(-1), 2);
    assert.equal(w.order.filter(i => i === 2).length, 1);
  });

  test('a file of exactly one part', async () => {
    const t = await makeTransfer({ size: CHUNK_SIZE });
    const r = parse(await fetchIt(createFakeWorker(t), t.link));
    assert.equal(r.size_bytes, CHUNK_SIZE);
    assert.deepEqual(new Uint8Array(await readFile(r.path)), t.plain);
  });

  test('the saved file is 0600, not executable', { skip: process.platform === 'win32' }, async () => {
    const t = await makeTransfer({ name: 'run.sh' });
    const r = parse(await fetchIt(createFakeWorker(t), t.link));
    assert.equal((await stat(r.path)).mode & 0o777, 0o600);
  });

  test('the result carries a path, never the contents', async () => {
    const t = await makeTransfer({ size: 64 });
    const raw = (await fetchIt(createFakeWorker(t), t.link)).content[0].text;
    assert.ok(!raw.includes(Buffer.from(t.plain).toString('base64')));
    assert.ok(!raw.includes(Buffer.from(t.plain).toString('hex')));
  });

  test('a hostile name is cleaned and stays in the folder', async () => {
    const t = await makeTransfer({ name: '../../.ssh/authorized_keys' });
    const r = parse(await fetchIt(createFakeWorker(t), t.link));
    assert.equal(path.dirname(r.path), dir);
    assert.equal(r.name, 'authorized_keys');
  });

  test('an existing file is never overwritten', async () => {
    const t = await makeTransfer();
    await writeFile(path.join(dir, 'report.pdf'), 'mine');
    const r = parse(await fetchIt(createFakeWorker(t), t.link));
    assert.equal(r.name, 'report (1).pdf');
    assert.equal(await readFile(path.join(dir, 'report.pdf'), 'utf8'), 'mine');
  });
});

describe('never signs', () => {
  test('no request carries a key, signature or token, even with keys set', async () => {
    const t = await makeTransfer({ size: CHUNK_SIZE + 1 });
    const w = createFakeWorker(t);
    await fetchIt(w, t.link);
    assert.ok(w.requests.length >= 3);
    for (const { url, headers } of w.requests) {
      const names = Object.keys(headers).map(h => h.toLowerCase());
      assert.ok(!names.includes('authorization'));
      assert.ok(!names.includes('x-api-sign-key'));
      assert.ok(!url.includes(t.uuid), 'the transfer ID stays out of the path and query');
      assert.ok(!JSON.stringify(headers).includes('SHOULD_NEVER_BE_SENT'));
    }
  });

  test('the link never goes on the wire', async () => {
    const t = await makeTransfer({ size: CHUNK_SIZE + 1 });
    const w = createFakeWorker(t);
    await fetchIt(w, t.link);
    const wire = JSON.stringify(w.requests);
    assert.ok(!wire.includes(t.fragment));
    assert.ok(!wire.includes(fieldsOf(t).k));
    assert.ok(!wire.includes(t.name));
  });
});

describe('link input', () => {
  test('share_url is refused unless the operator allowed it, without echoing it', async () => {
    const t = await makeTransfer();
    const raw = await handleFetch({ share_url: t.link, out_dir: dir }, depsFor(createFakeWorker(t)));
    assert.equal(parse(raw).error, 'link_in_chat_off');
    assert.equal(raw.isError, true);
    assert.ok(!raw.content[0].text.includes(t.fragment));
  });

  test('share_url works with REFUELER_LINK_IN_CHAT=1', async () => {
    config.linkInChat = true;
    const t = await makeTransfer();
    const r = parse(await handleFetch({ share_url: t.link, out_dir: dir }, depsFor(createFakeWorker(t))));
    assert.equal(r.state, 'complete');
  });

  test('the schema offers share_url only when allowed', () => {
    assert.equal(fetchToolDefinition({ linkInChat: false }).inputSchema.properties.share_url, undefined);
    assert.ok(fetchToolDefinition({ linkInChat: true }).inputSchema.properties.share_url);
  });

  test('both inputs, or neither, is refused', async () => {
    config.linkInChat = true;
    const t = await makeTransfer();
    const w = createFakeWorker(t);
    const f = await saveLink(t.link);
    assert.equal(parse(await handleFetch({ link_file: f, share_url: t.link, out_dir: dir }, depsFor(w))).error, 'bad_input');
    assert.equal(parse(await handleFetch({ out_dir: dir }, depsFor(w))).error, 'bad_input');
  });

  test('out_dir is required', async () => {
    const t = await makeTransfer();
    assert.equal(parse(await handleFetch({ link_file: await saveLink(t.link) }, depsFor(createFakeWorker(t)))).error, 'bad_input');
  });

  test('a folder outside the roots is refused before anything is asked of the Worker', async () => {
    const t = await makeTransfer();
    const w = createFakeWorker(t);
    const elsewhere = await realpath(await mkdtemp(path.join(os.tmpdir(), 'rf-else-')));
    const r = parse(await handleFetch({ link_file: await saveLink(t.link), out_dir: elsewhere }, depsFor(w)));
    await rm(elsewhere, { recursive: true });
    assert.equal(r.error, 'outside_allowed_folders');
    assert.equal(w.requests.length, 0);
  });

  test('the API base comes from config, never the link', async () => {
    const t = await makeTransfer();
    const w = createFakeWorker(t);
    await fetchIt(w, t.link);
    assert.ok(w.requests.every(r => r.url.startsWith('http://worker.test/')));
  });
});

describe('links that stop', () => {
  test('v3 is refused before any request', async () => {
    const t = await makeTransfer();
    const w = createFakeWorker(t);
    const link = `https://share.refueler.io/?v=3#${blobOf({ v: 3, u: t.uuid, k: fieldsOf(t).k, n: 'a', z: 1 })}`;
    assert.equal(parse(await fetchIt(w, link)).error, 'link_v3_not_yet');
    assert.equal(w.requests.length, 0);
  });

  test('v1 goes to a browser', async () => {
    const t = await makeTransfer();
    assert.equal(parse(await fetchIt(createFakeWorker(t), linkWith(t, { ...fieldsOf(t), v: 1 }))).error, 'open_in_browser');
  });

  test('a v2 password link goes to a browser, with no part fetched', async () => {
    const t = await makeTransfer({ password: true });
    const w = createFakeWorker(t);
    assert.equal(parse(await fetchIt(w, t.link)).error, 'open_in_browser');
    assert.equal(w.order.length, 0);
  });

  test('a size in another part-count fails before any /download', async () => {
    const t = await makeTransfer({ size: 1000 });
    const w = createFakeWorker(t);
    const r = parse(await fetchIt(w, linkWith(t, { ...fieldsOf(t), z: CHUNK_SIZE + 1 })));
    assert.equal(r.error, 'link_damaged');
    assert.equal(w.order.length, 0);
  });

  test('a changed key fails at part 0: the last part is never asked for', async () => {
    const t = await makeTransfer({ size: 2 * CHUNK_SIZE + 5 });
    const w = createFakeWorker(t);
    const k = Buffer.from(fieldsOf(t).k, 'base64url');
    k[0] ^= 1;
    const r = parse(await fetchIt(w, linkWith(t, { ...fieldsOf(t), k: k.toString('base64url') })));
    assert.equal(r.error, 'decrypt_failed');
    assert.ok(!w.order.includes(2));
    assert.deepEqual(await leftovers(), []);
    assert.deepEqual((await readdir(dir)).filter(f => f === 'report.pdf'), []);
  });

  test('a changed transfer ID: the Worker has no such transfer', async () => {
    const t = await makeTransfer();
    const w = createFakeWorker(t);
    w.script.meta = async () => new Response('{"error":"not_found"}', { status: 404 });
    const edited = t.link.replace(t.uuid, t.uuid.replace(/.$/, c => (c === '0' ? '1' : '0')));
    assert.equal(parse(await fetchIt(w, edited)).error, 'not_found');
  });

  test('a size changed within the same part count stops at the tail, nothing saved', async () => {
    const t = await makeTransfer({ size: CHUNK_SIZE + 100 });
    const w = createFakeWorker(t);
    const r = parse(await fetchIt(w, linkWith(t, { ...fieldsOf(t), z: CHUNK_SIZE + 101 })));
    assert.equal(r.error, 'integrity_failed');
    assert.deepEqual(await leftovers(), []);
    assert.equal((await readdir(dir)).length, 1, 'only the link file remains');
  });

  test('stated limit: a changed name is not caught; the bytes are still right', async () => {
    const t = await makeTransfer();
    const r = parse(await fetchIt(createFakeWorker(t), linkWith(t, { ...fieldsOf(t), n: 'edited.pdf' })));
    assert.equal(r.name, 'edited.pdf');
    assert.deepEqual(new Uint8Array(await readFile(r.path)), t.plain);
  });

  test('a tampered part fails, nothing saved', async () => {
    const t = await makeTransfer({ size: CHUNK_SIZE + 1 });
    t.parts[0][5] ^= 1;
    const r = parse(await fetchIt(createFakeWorker(t), t.link));
    assert.equal(r.error, 'decrypt_failed');
    assert.deepEqual(await leftovers(), []);
  });

  test('swapped parts of the right size fail', async () => {
    const t = await makeTransfer({ size: 3 * CHUNK_SIZE });
    [t.parts[0], t.parts[1]] = [t.parts[1], t.parts[0]];
    assert.equal(parse(await fetchIt(createFakeWorker(t), t.link)).error, 'decrypt_failed');
  });

  test('a transfer cut short by a lying part count fails on the last-part flag', async () => {
    const t = await makeTransfer({ size: 2 * CHUNK_SIZE });
    t.meta.total_chunks = 1;
    const shortened = linkWith(t, { ...fieldsOf(t), z: CHUNK_SIZE });
    assert.equal(parse(await fetchIt(createFakeWorker(t), shortened)).error, 'decrypt_failed');
  });

  test('a 409 mid-way stops, part file removed, last part not asked for', async () => {
    const t = await makeTransfer({ size: 2 * CHUNK_SIZE + 1 });
    const w = createFakeWorker(t);
    w.script.download = async (i) => (i === 1 ? new Response(null, { status: 409 }) : null);
    assert.equal(parse(await fetchIt(w, t.link)).error, 'integrity_failed');
    assert.ok(!w.order.includes(2));
    assert.deepEqual(await leftovers(), []);
  });

  test('a stored part of the wrong length stops without a decrypt', async () => {
    const t = await makeTransfer({ size: 1000 });
    t.parts[0] = t.parts[0].subarray(0, 1000 + CHUNK_TAG_BYTES - 1);
    assert.equal(parse(await fetchIt(createFakeWorker(t), t.link)).error, 'integrity_failed');
  });

  test('not enough space stops before any part', async () => {
    const t = await makeTransfer({ size: 1000 });
    const w = createFakeWorker(t);
    const r = parse(await fetchIt(w, t.link, {}, { disk: { statfsImpl: async () => ({ bavail: 0, bsize: 4096, type: 0 }), platform: 'test' } }));
    assert.equal(r.error, 'no_space');
    assert.equal(w.order.length, 0);
  });
});

describe('a link that works once', () => {
  test('stops and says to ask the user, with no part fetched', async () => {
    const t = await makeTransfer({ dad: true });
    const w = createFakeWorker(t);
    const r = parse(await fetchIt(w, t.link));
    assert.equal(r.error, 'link_works_once');
    assert.match(r.detail, /Ask the user/);
    assert.match(r.detail, /can lose the file/);
    assert.equal(w.order.length, 0);
  });

  test('anything but true is no', async () => {
    const t = await makeTransfer({ dad: true });
    for (const v of ['true', 1, false]) {
      assert.equal(parse(await fetchIt(createFakeWorker(t), t.link, { accept_link_works_once: v })).error, 'link_works_once');
    }
  });

  test('goes ahead on true, tail last', async () => {
    const t = await makeTransfer({ dad: true, size: CHUNK_SIZE + 9 });
    const w = createFakeWorker(t);
    const r = parse(await fetchIt(w, t.link, { accept_link_works_once: true }));
    assert.equal(r.state, 'complete');
    assert.deepEqual(w.order, [0, 1]);
  });

  test('after the flip it still counts as works-once', async () => {
    const t = await makeTransfer({ dad: true });
    t.meta.pending_destruction = true;
    assert.equal(parse(await fetchIt(createFakeWorker(t), t.link)).error, 'link_works_once');
  });

  test('a failure during the tail says the transfer may be gone', async () => {
    const t = await makeTransfer({ dad: true, size: CHUNK_SIZE + 9 });
    const w = createFakeWorker(t);
    w.script.download = async (i) => (i === 1 ? new Response(null, { status: 410 }) : null);
    const r = parse(await fetchIt(w, t.link, { accept_link_works_once: true }));
    assert.equal(r.error, 'refused');
    assert.match(r.detail, /may already be gone/);
  });

  test('a failure before the tail does not', async () => {
    const t = await makeTransfer({ dad: true, size: CHUNK_SIZE + 9 });
    const w = createFakeWorker(t);
    w.script.download = async (i) => (i === 0 ? new Response(null, { status: 409 }) : null);
    const r = parse(await fetchIt(w, t.link, { accept_link_works_once: true }));
    assert.doesNotMatch(r.detail, /may already be gone/);
    assert.ok(!w.order.includes(1));
  });
});

describe('jobs', () => {
  function slowWorker(t) {
    const w = createFakeWorker(t);
    let release;
    const gate = new Promise(r => { release = r; });
    w.script.download = async () => { await gate; return null; };
    return { w, release };
  }

  test('past the wait it hands back a job, and status reports it to the end', async () => {
    const t = await makeTransfer();
    const { w, release } = slowWorker(t);
    const first = parse(await fetchIt(w, t.link, {}, { foregroundMs: 1 }));
    assert.equal(first.state, 'running');
    assert.equal(first.parts_done, 0);
    assert.equal(first.parts_total, 1);

    const running = parse(handleFetchStatus({ job_id: first.job_id }, { jobs }));
    assert.equal(running.state, 'running');

    release();
    await jobs.get(first.job_id).done;
    const done = parse(handleFetchStatus({ job_id: first.job_id }, { jobs }));
    assert.equal(done.state, 'complete');
    assert.deepEqual(new Uint8Array(await readFile(done.path)), t.plain);
  });

  test('a job that fails reports it', async () => {
    const t = await makeTransfer();
    const w = createFakeWorker(t);
    w.script.download = async () => new Response(null, { status: 409 });
    const r = parse(await fetchIt(w, t.link, {}, { foregroundMs: 100_000 }));
    assert.equal(r.error, 'integrity_failed');
    assert.ok(r.job_id);
  });

  test('one job per transfer', async () => {
    const t = await makeTransfer();
    const { w, release } = slowWorker(t);
    const first = parse(await fetchIt(w, t.link, {}, { foregroundMs: 1 }));
    const second = parse(await fetchIt(w, t.link, {}, { foregroundMs: 1 }));
    assert.equal(second.error, 'already_fetching');
    assert.equal(second.job_id, first.job_id);
    release();
    await jobs.get(first.job_id).done;
  });

  test('at most two at once', async () => {
    const [a, b, c] = await Promise.all([makeTransfer(), makeTransfer(), makeTransfer()]);
    const sa = slowWorker(a), sb = slowWorker(b), sc = slowWorker(c);
    const ra = parse(await fetchIt(sa.w, a.link, {}, { foregroundMs: 1 }));
    const rb = parse(await fetchIt(sb.w, b.link, {}, { foregroundMs: 1 }));
    assert.equal(parse(await fetchIt(sc.w, c.link, {}, { foregroundMs: 1 })).error, 'busy');
    sa.release(); sb.release();
    await jobs.get(ra.job_id).done;
    await jobs.get(rb.job_id).done;
  });

  test('stopping removes the part file', async () => {
    const t = await makeTransfer();
    const { w } = slowWorker(t);
    const realFetch = w.fetch;
    const fetchImpl = (url, opts) => (url.endsWith('/download')
      ? new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(new Error('aborted'))))
      : realFetch(url, opts));
    const r = parse(await fetchIt(w, t.link, {}, { foregroundMs: 1, fetchImpl }));
    assert.equal(r.state, 'running');
    assert.equal((await leftovers()).length, 1);
    await jobs.abortAll();
    assert.deepEqual(await leftovers(), []);
  });

  test('an unknown job, or no job id, says so', () => {
    assert.equal(parse(handleFetchStatus({ job_id: 'nope' }, { jobs })).error, 'unknown_job');
    assert.equal(parse(handleFetchStatus({}, { jobs })).error, 'unknown_job');
  });

  test('a job id is not derived from the transfer', async () => {
    const t = await makeTransfer();
    const { w, release } = slowWorker(t);
    const first = parse(await fetchIt(w, t.link, {}, { foregroundMs: 1 }));
    assert.notEqual(first.job_id, t.uuid);
    release();
    await jobs.get(first.job_id).done;
  });

  test('a note above 20 GiB that nothing resumes', async () => {
    const t = await makeTransfer();
    const w = createFakeWorker(t);
    const size = 21 * 1024 ** 3;
    t.meta.total_chunks = Math.ceil(size / CHUNK_SIZE);
    w.script.download = () => new Promise(() => {});
    const realFetch = w.fetch;
    const fetchImpl = (url, opts) => (url.endsWith('/download')
      ? new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(new Error('aborted'))))
      : realFetch(url, opts));
    const r = parse(await fetchIt(w, linkWith(t, { ...fieldsOf(t), z: size }), {}, { foregroundMs: 1, fetchImpl }));
    assert.equal(r.state, 'running');
    assert.match(r.note, /starts again from the beginning/);
  });
});

describe('the sweep: no output carries the key or the link', () => {
  /** Every run of 12 characters of the secret, so a cut-down quote is caught too. */
  function assertClean(text, t) {
    const k = fieldsOf(t).k;
    const hexKey = Buffer.from(t.key).toString('hex');
    for (const secret of [t.fragment, k, hexKey, Buffer.from(t.key).toString('base64')]) {
      for (let i = 0; i + 12 <= secret.length; i++) {
        assert.ok(!text.includes(secret.slice(i, i + 12)), 'output contains part of a secret');
      }
    }
    assert.ok(!text.includes(t.link));
  }

  test('every path, on results, job states, thrown text and stderr', async () => {
    const stderr = [];
    const realWrite = process.stderr.write;
    const realError = console.error;
    const realLog = console.log;
    process.stderr.write = (chunk, ...rest) => { stderr.push(String(chunk)); return true; };
    console.error = (...a) => stderr.push(a.join(' '));
    console.log = (...a) => stderr.push(a.join(' '));

    const outputs = [];
    const t = await makeTransfer({ size: CHUNK_SIZE + 77 });
    const f = fieldsOf(t);
    const flip = (s) => `${s.slice(0, 8)}${s[8] === 'A' ? 'B' : 'A'}${s.slice(9)}`;

    const links = [
      t.link,
      `${t.link}\n`,
      t.link.slice(0, -1),
      t.link.slice(0, t.link.indexOf('#') + 20),
      t.link.slice(0, t.link.indexOf('#')),
      t.link.replace('https', 'http'),
      t.link.replace('share.refueler.io', 'evil.test'),
      t.link.replace('?uuid=', '?x='),
      `not a url ${t.fragment}`,
      `https://share.refueler.io/?uuid=${t.uuid}#{"v":2,"k":"${f.k}"}`,
      `https://share.refueler.io/?uuid=${t.uuid}#${Buffer.from(`{"v":2,"k":"${f.k}"`).toString('base64url')}`,
      `https://share.refueler.io/?uuid=${t.uuid}#${f.k}`,
      linkWith(t, { ...f, k: flip(f.k) }),
      linkWith(t, { ...f, k: `${f.k}x` }),
      linkWith(t, { ...f, v: 1 }),
      linkWith(t, { ...f, v: 3 }),
      linkWith(t, { ...f, z: 1 }),
      linkWith(t, { ...f, z: f.z + 1 }),
      linkWith(t, { ...f, extra: f.k }),
    ];

    const scripts = [
      null,
      async () => new Response(null, { status: 409 }),
      async () => new Response(null, { status: 410 }),
      async () => new Response(null, { status: 425 }),
      async () => new Response(null, { status: 503 }),
      async () => { throw new TypeError('network'); },
      async () => new Response(new Uint8Array(3), { status: 200 }),
    ];

    try {
      for (const link of links) {
        for (const script of scripts) {
          const w = createFakeWorker(t);
          w.script.download = script;
          const raw = await fetchIt(w, link, {}, { foregroundMs: 100_000 });
          outputs.push(JSON.stringify(raw));
          for (const out of await readdir(dir)) {
            if (out === 'in.link') continue;
            assert.ok(!out.includes(f.k.slice(0, 12)), 'a key in a file name');
            await rm(path.join(dir, out));
          }
        }
      }

      // Input refused on the way in, and a status call on a failed job.
      const w = createFakeWorker(t);
      outputs.push(JSON.stringify(await handleFetch({ share_url: t.link, out_dir: dir }, depsFor(w))));
      w.script.download = async () => new Response(null, { status: 409 });
      const failed = parse(await fetchIt(w, t.link, {}, { foregroundMs: 100_000 }));
      outputs.push(JSON.stringify(handleFetchStatus({ job_id: failed.job_id }, { jobs })));
    } finally {
      process.stderr.write = realWrite;
      console.error = realError;
      console.log = realLog;
    }

    assert.ok(outputs.length > 100);
    for (const text of [...outputs, stderr.join('\n')]) assertClean(text, t);
  });
});

describe('cross-check: the browser\'s own code', () => {
  const shareDir = process.env.REFUELER_SHARE_DIR;
  const opts = { skip: !shareDir && 'REFUELER_SHARE_DIR not set' };

  test('a browser-made fragment and part are fetched here', opts, async () => {
    const feCrypto = await import(`${shareDir}/frontend/crypto.js`);
    const feFrag = await import(`${shareDir}/frontend/fragment.js`);

    const t = await makeTransfer({ size: CHUNK_SIZE + 500 });
    const partKey = await feCrypto.derivePartKey(t.key, ['encrypt']);
    t.parts = [
      new Uint8Array(await feCrypto.encryptPart(partKey, t.plain.subarray(0, CHUNK_SIZE), 0, 2)),
      new Uint8Array(await feCrypto.encryptPart(partKey, t.plain.subarray(CHUNK_SIZE), 1, 2)),
    ];
    const fragment = feFrag.assembleFragment({ keyBytes: t.key, filename: t.name, sizeBytes: t.size });
    const link = `https://share.refueler.io/?uuid=${t.uuid}#${fragment}`;

    const r = parse(await fetchIt(createFakeWorker(t), link));
    assert.equal(r.state, 'complete');
    assert.deepEqual(new Uint8Array(await readFile(r.path)), t.plain);
  });

  test('the retry schedule and parts in flight match the browser', opts, async () => {
    const source = await readFile(`${shareDir}/frontend/progress.js`, 'utf8');
    const m = /RETRY_DELAYS_MS = (\[[^\]]+\])/.exec(source);
    const { RETRY_DELAYS_MS, PARTS_IN_FLIGHT } = await import('../src/fetch/transport.js');
    assert.deepEqual(JSON.parse(m[1].replace(/\s/g, '')), RETRY_DELAYS_MS);
    const fetchSource = await readFile(`${shareDir}/frontend/download-fetch.js`, 'utf8');
    assert.equal(Number(/DL_IN_FLIGHT = (\d+)/.exec(fetchSource)[1]), PARTS_IN_FLIGHT);
  });

  test('every shape the browser reads as a v2 link, this reader reads too', opts, async () => {
    const feFrag = await import(`${shareDir}/frontend/fragment.js`);
    const { readLink } = await import('../src/fetch/link.js');
    const t = await makeTransfer();
    const browser = feFrag.parseFragment(t.fragment);
    const here = readLink(t.link, { hosts: ['share.refueler.io'] });
    assert.equal(here.v, browser.v);
    assert.equal(here.name, browser.filename);
    assert.equal(here.sizeBytes, browser.sizeBytes);
    assert.deepEqual([...here.keyBytes], [...browser.keyBytes]);
  });
});
