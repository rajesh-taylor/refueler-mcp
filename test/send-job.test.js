/**
 * test/send-job.test.js — refueler_send_file on the job runner (MCP-Install-1)
 * node:test only. Test credentials use the rfs_test_ prefix.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createJobRunner } from '../src/jobs.js';
import { handleSendJob, handleSendStatus } from '../src/tools/send-job.js';
import { handleSendFile } from '../src/tools/send.js';
import { CHUNK_SIZE } from '../src/crypto.js';

const parse = (r) => JSON.parse(r.content[0].text);
const text = (v) => [{ type: 'text', text: JSON.stringify(v) }];
const UUID = '11111111-2222-4333-8444-555555555555';

let jobs;
beforeEach(() => { jobs = createJobRunner(); });
afterEach(async () => { await jobs.abortAll(); });

/** A stand-in send that waits for `gate` and reports progress on the way. */
function slowSend(gate, result = { uuid: UUID, share_url: 'https://share.refueler.io/?uuid=x#y' }) {
  return async (_input, deps) => {
    deps.onProgress(0, 3);
    deps.onProgress(1, 3);
    await gate;
    return text(result);
  };
}

describe('send job handle', () => {
  test('a quick send answers in the same call', async () => {
    const r = await handleSendJob({ file_path: '/f' }, { jobs, send: slowSend(Promise.resolve()) });
    const v = parse(r);
    assert.equal(v.state, 'complete');
    assert.equal(v.uuid, UUID);
    assert.equal(r.isError, undefined);
  });

  test('a long send hands back a job_id, then the status tool gives the result', async () => {
    let open; const gate = new Promise(r => { open = r; });
    const first = parse(await handleSendJob({ file_path: '/f' }, { jobs, send: slowSend(gate), foregroundMs: 5 }));
    assert.equal(first.state, 'running');
    assert.equal(first.parts_done, 1);
    assert.equal(first.parts_total, 3);

    open();
    await jobs.get(first.job_id).done;
    const done = parse(handleSendStatus({ job_id: first.job_id }, { jobs }));
    assert.equal(done.state, 'complete');
    assert.equal(done.uuid, UUID);
  });

  test('a send error ends the job as failed, with the send\'s own envelope', async () => {
    const send = async () => text({ error: 'too_large', detail: 'Too big.', size_bytes: 9 });
    const r = await handleSendJob({ file_path: '/f' }, { jobs, send });
    const v = parse(r);
    assert.equal(v.error, 'too_large');
    assert.equal(v.size_bytes, 9);
    assert.ok(v.job_id);
    assert.equal(r.isError, true);
  });

  test('an unexpected throw says nothing specific', async () => {
    const send = async () => { throw new Error('secret detail /Users/x'); };
    const v = parse(await handleSendJob({ file_path: '/f' }, { jobs, send }));
    assert.equal(v.error, 'send_failed');
    assert.doesNotMatch(JSON.stringify(v), /secret/);
  });

  test('the same file twice at once is refused with the running job_id', async () => {
    let open; const gate = new Promise(r => { open = r; });
    const deps = { jobs, send: slowSend(gate), foregroundMs: 1 };
    const first = parse(await handleSendJob({ file_path: './a/../f' }, deps));
    const again = parse(await handleSendJob({ file_path: 'f' }, deps));
    assert.equal(again.error, 'already_sending');
    assert.equal(again.job_id, first.job_id);
    open();
  });

  test('sends and fetches have separate limits', async () => {
    let open; const gate = new Promise(r => { open = r; });
    const deps = { jobs, send: slowSend(gate), foregroundMs: 1 };
    await handleSendJob({ file_path: '/a' }, deps);
    await handleSendJob({ file_path: '/b' }, deps);
    assert.equal(parse(await handleSendJob({ file_path: '/c' }, deps)).error, 'busy');
    assert.match(parse(await handleSendJob({ file_path: '/c' }, deps)).detail, /sends/);

    const fetchJob = jobs.start({ kind: 'fetch', key: 'u', work: () => gate });
    assert.equal(fetchJob.state, 'running');
    open();
  });

  test('one kind\'s status tool cannot read the other\'s job', async () => {
    let open; const gate = new Promise(r => { open = r; });
    const fetchJob = jobs.start({ kind: 'fetch', key: 'u', work: () => gate });
    assert.equal(parse(handleSendStatus({ job_id: fetchJob.id }, { jobs })).error, 'unknown_job');
    open();
  });
});

describe('handleSendFile progress and stop', () => {
  let dir;
  beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'rf-sendjob-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  function deps(extra = {}) {
    const api = {
      async call(_m, p) {
        if (p.endsWith('/initiate')) {
          return { ok: true, status: 200, body: {
            session_token: 'rfs_test_session',
            urls: [{ index: 0, url: 'https://r2.test/0' }],
            tail_url: { index: 1, url: 'https://r2.test/1' },
          } };
        }
        return { ok: true, status: 200, body: { ok: true } };
      },
    };
    return {
      api,
      config: { liveKey: 'rfs_test_live' },
      issueCredential: async () => ({ uuid: UUID, credential: '{}', commitment: 'rfs_test_c', issuedTier: 'api' }),
      putPart: async () => ({ ok: true, status: 200, etag: '', text: '' }),
      ...extra,
    };
  }

  test('reports each part as it lands', async () => {
    const f = path.join(dir, 'two.bin');
    await writeFile(f, Buffer.alloc(CHUNK_SIZE + 5, 7));
    const seen = [];
    const v = JSON.parse((await handleSendFile({ file_path: f }, deps({ onProgress: (d, t) => seen.push([d, t]) })))[0].text);
    assert.equal(v.uuid, UUID);
    assert.deepEqual(seen, [[0, 2], [1, 2], [2, 2]]);
  });

  test('a stopped send uploads nothing more and does not finalise', async () => {
    const f = path.join(dir, 'two.bin');
    await writeFile(f, Buffer.alloc(CHUNK_SIZE + 5, 7));
    const ac = new AbortController(); ac.abort();
    let puts = 0;
    const v = JSON.parse((await handleSendFile({ file_path: f },
      deps({ signal: ac.signal, putPart: async () => { puts++; return { ok: true, status: 200 }; } })))[0].text);
    assert.equal(v.error, 'stopped');
    assert.equal(puts, 0);
  });
});
