/**
 * test/fetch-transport.test.js — parts, order and status codes (MCP-Fetch-1)
 * node:test only.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  eachPartInOrder, expectedPartBytes, fetchPart, getMeta, partsFromMeta, RETRY_DELAYS_MS,
} from '../src/fetch/transport.js';
import { CHUNK_SIZE } from '../src/crypto.js';

const UUID = '3a4d8828-6812-4eb9-9b5d-e31b60c72fac';
const noWait = async () => {};
const base = { apiBase: 'http://w', uuid: UUID, index: 3, expectedBytes: 4, retryDelays: [1, 1], wait: noWait };
const ok = (bytes = new Uint8Array(4)) => new Response(bytes, { status: 200 });
const status = (code, headers) => new Response(null, { status: code, headers });

function counting(responses) {
  const f = async (url, opts) => {
    f.calls.push({ url, opts });
    const r = responses[Math.min(f.calls.length - 1, responses.length - 1)];
    if (r instanceof Error) throw r;
    return typeof r === 'function' ? r() : r.clone();
  };
  f.calls = [];
  return f;
}

describe('fetchPart — what goes on the wire', () => {
  test('the transfer ID and part are headers; path and query carry neither', async () => {
    const f = counting([ok()]);
    await fetchPart({ ...base, fetchImpl: f });
    const { url, opts } = f.calls[0];
    assert.equal(url, 'http://w/download');
    assert.equal(opts.headers['X-Transfer-UUID'], UUID);
    assert.equal(opts.headers['X-Part'], '0003');
    assert.ok(!url.includes(UUID));
  });

  test('no signature, no token, no Range', async () => {
    const f = counting([ok()]);
    await fetchPart({ ...base, fetchImpl: f });
    assert.deepEqual(Object.keys(f.calls[0].opts.headers).sort(), ['X-Part', 'X-Transfer-UUID']);
  });

  test('redirects are errors, so the API base stays the configured one', async () => {
    const f = counting([ok()]);
    await fetchPart({ ...base, fetchImpl: f });
    assert.equal(f.calls[0].opts.redirect, 'error');
  });
});

describe('fetchPart — status codes', () => {
  for (const code of [400, 401, 410, 416]) {
    test(`${code} is fatal, tried once`, async () => {
      const f = counting([status(code)]);
      await assert.rejects(() => fetchPart({ ...base, fetchImpl: f }), { code: 'refused' });
      assert.equal(f.calls.length, 1);
    });
  }

  test('409 is an integrity failure, never retried', async () => {
    const f = counting([status(409)]);
    await assert.rejects(() => fetchPart({ ...base, fetchImpl: f }), { code: 'integrity_failed' });
    assert.equal(f.calls.length, 1);
  });

  test('425 is "not ready"', async () => {
    const f = counting([status(425)]);
    await assert.rejects(() => fetchPart({ ...base, fetchImpl: f }), { code: 'not_ready' });
    assert.equal(f.calls.length, 1);
  });

  test('an empty body is an integrity failure, never retried', async () => {
    const f = counting([new Response(new Uint8Array(0), { status: 200 })]);
    await assert.rejects(() => fetchPart({ ...base, fetchImpl: f }), { code: 'integrity_failed' });
    assert.equal(f.calls.length, 1);
  });

  test('a short body is an integrity failure', async () => {
    const f = counting([ok(new Uint8Array(3))]);
    await assert.rejects(() => fetchPart({ ...base, fetchImpl: f }), { code: 'integrity_failed' });
    assert.equal(f.calls.length, 1);
  });

  test('a long body is an integrity failure', async () => {
    const f = counting([ok(new Uint8Array(5))]);
    await assert.rejects(() => fetchPart({ ...base, fetchImpl: f }), { code: 'integrity_failed' });
    assert.equal(f.calls.length, 1);
  });

  test('429 honours Retry-After', async () => {
    const waits = [];
    const f = counting([status(429, { 'Retry-After': '7' }), ok()]);
    await fetchPart({ ...base, fetchImpl: f, wait: async (ms) => { waits.push(ms); } });
    assert.deepEqual(waits, [7000]);
  });

  test('429 asking for more than five minutes stops', async () => {
    const f = counting([status(429, { 'Retry-After': '301' })]);
    await assert.rejects(() => fetchPart({ ...base, fetchImpl: f }), { code: 'rate_limited' });
  });

  test('429 with no Retry-After uses the schedule', async () => {
    const waits = [];
    const f = counting([status(429), ok()]);
    await fetchPart({ ...base, retryDelays: [123], fetchImpl: f, wait: async (ms) => { waits.push(ms); } });
    assert.deepEqual(waits, [123]);
  });

  for (const code of [500, 502, 503, 404]) {
    test(`${code} is retried, then succeeds`, async () => {
      const f = counting([status(code), ok()]);
      await fetchPart({ ...base, fetchImpl: f });
      assert.equal(f.calls.length, 2);
    });
  }

  test('a network error is retried', async () => {
    const f = counting([new TypeError('fetch failed'), ok()]);
    await fetchPart({ ...base, fetchImpl: f });
    assert.equal(f.calls.length, 2);
  });

  test('a body cut by the network is retried', async () => {
    const cut = () => new Response(new ReadableStream({
      pull(c) { c.error(new TypeError('terminated')); },
    }), { status: 200 });
    const f = counting([cut, ok()]);
    await fetchPart({ ...base, fetchImpl: f });
    assert.equal(f.calls.length, 2);
  });

  test('after every try it stops as unreachable', async () => {
    const f = counting([status(503)]);
    await assert.rejects(() => fetchPart({ ...base, fetchImpl: f }), { code: 'unreachable' });
    assert.equal(f.calls.length, 3);
  });

  test('a stalled body is aborted and retried', async () => {
    const stalled = () => new Response(new ReadableStream({ start() {} }), { status: 200 });
    let aborted = 0;
    const f = async (url, opts) => {
      f.n = (f.n ?? 0) + 1;
      if (f.n > 1) return ok();
      const res = stalled();
      const reader = res.body.getReader();
      return {
        status: 200,
        body: {
          getReader: () => ({
            read: () => new Promise((_, reject) => {
              opts.signal.addEventListener('abort', () => { aborted++; reject(new Error('aborted')); });
            }),
            cancel: () => reader.cancel(),
          }),
        },
        headers: new Headers(),
      };
    };
    await fetchPart({ ...base, fetchImpl: f, stallMs: 5 });
    assert.equal(aborted, 1);
    assert.equal(f.n, 2);
  });

  test('a stop during retries ends it', async () => {
    const ac = new AbortController();
    const f = counting([status(503)]);
    await assert.rejects(() => fetchPart({
      ...base, signal: ac.signal, fetchImpl: f, wait: async () => { ac.abort(); },
    }), { code: 'stopped' });
    assert.equal(f.calls.length, 1);
  });

  test('the retry schedule is the browser\'s', () => {
    assert.equal(RETRY_DELAYS_MS.length, 13);
    assert.equal(RETRY_DELAYS_MS.reduce((a, b) => a + b), 117_000);
  });
});

describe('expectedPartBytes', () => {
  test('whole parts, and an exact tail', () => {
    const size = 2 * CHUNK_SIZE + 5;
    assert.equal(expectedPartBytes(0, 3, size), CHUNK_SIZE + 16);
    assert.equal(expectedPartBytes(1, 3, size), CHUNK_SIZE + 16);
    assert.equal(expectedPartBytes(2, 3, size), 5 + 16);
  });
  test('a file of exactly N parts has a full tail', () => {
    assert.equal(expectedPartBytes(1, 2, 2 * CHUNK_SIZE), CHUNK_SIZE + 16);
  });
});

describe('eachPartInOrder', () => {
  function harness(n, { failAt = -1 } = {}) {
    const asked = [];
    const used = [];
    const inFlightNow = { value: 0, max: 0 };
    const gate = new Map();
    const getPart = (i, onStart) => {
      asked.push(i);
      inFlightNow.value++;
      inFlightNow.max = Math.max(inFlightNow.max, inFlightNow.value);
      return new Promise((resolve, reject) => {
        gate.set(i, () => {
          onStart();
          inFlightNow.value--;
          if (i === failAt) reject(new Error('boom')); else resolve(i);
        });
      });
    };
    const use = async (bytes, i) => { used.push(i); };
    return { asked, used, inFlightNow, gate, getPart, use };
  }
  const tick = () => new Promise(r => setImmediate(r));

  test('the last part is not asked for until every other has been used', async () => {
    const h = harness(5);
    const run = eachPartInOrder(5, h.getPart, h.use);
    for (let i = 3; i >= 0; i--) {
      // release out of order where possible
      await tick();
      for (const j of [...h.gate.keys()].sort((a, b) => b - a)) {
        if (!h.asked.includes(4)) { h.gate.get(j)(); h.gate.delete(j); }
        await tick();
      }
    }
    await tick();
    assert.deepEqual(h.used, [0, 1, 2, 3]);
    assert.equal(h.asked.at(-1), 4);
    h.gate.get(4)();
    await run;
    assert.deepEqual(h.used, [0, 1, 2, 3, 4]);
  });

  test('never more than two at once', async () => {
    const h = harness(8);
    const run = eachPartInOrder(8, h.getPart, h.use);
    while (h.used.length < 8) {
      await tick();
      for (const [j, go] of [...h.gate]) { h.gate.delete(j); go(); await tick(); }
    }
    await run;
    assert.ok(h.inFlightNow.max <= 2);
  });

  test('part 0 is first; nothing else until it starts', async () => {
    const h = harness(4);
    const run = eachPartInOrder(4, h.getPart, h.use);
    await tick();
    assert.deepEqual(h.asked, [0]);
    while (h.used.length < 4) {
      await tick();
      for (const [j, go] of [...h.gate]) { h.gate.delete(j); go(); await tick(); }
    }
    await run;
  });

  test('a single part is fetched at once', async () => {
    const h = harness(1);
    const run = eachPartInOrder(1, h.getPart, h.use);
    await tick();
    h.gate.get(0)();
    await run;
    assert.deepEqual(h.used, [0]);
  });

  test('a failure means the last part is never asked for', async () => {
    const h = harness(4, { failAt: 1 });
    let aborted = false;
    const run = eachPartInOrder(4, h.getPart, h.use, { abort: () => { aborted = true; } });
    run.catch(() => {});
    for (let k = 0; k < 6; k++) {
      await tick();
      for (const [j, go] of [...h.gate]) { h.gate.delete(j); go(); await tick(); }
    }
    await assert.rejects(run, /boom/);
    assert.equal(aborted, true);
    assert.ok(!h.asked.includes(3));
  });

  test('a failure in use (a bad decrypt) means the last part is never asked for', async () => {
    const h = harness(3);
    h.use = async (b, i) => { if (i === 0) throw new Error('bad key'); };
    const run = eachPartInOrder(3, h.getPart, h.use);
    run.catch(() => {});
    for (let k = 0; k < 6; k++) {
      await tick();
      for (const [j, go] of [...h.gate]) { h.gate.delete(j); go(); await tick(); }
    }
    await assert.rejects(run, /bad key/);
    assert.ok(!h.asked.includes(2));
  });
});

describe('getMeta and partsFromMeta', () => {
  const m = { apiBase: 'http://w', uuid: UUID, retryDelays: [1], wait: noWait };
  const reply = (code, body) => new Response(JSON.stringify(body), { status: code });

  test('the transfer ID is a header; no signature', async () => {
    const f = counting([reply(200, { total_chunks: 1 })]);
    await getMeta({ ...m, fetchImpl: f });
    assert.equal(f.calls[0].url, 'http://w/meta');
    assert.deepEqual(Object.keys(f.calls[0].opts.headers).sort(), ['Accept', 'X-Transfer-UUID']);
  });

  test('404 → not_found', () => assert.rejects(() => getMeta({ ...m, fetchImpl: counting([reply(404, {})]) }), { code: 'not_found' }));
  test('410 deleted → link_gone', () => assert.rejects(() => getMeta({ ...m, fetchImpl: counting([reply(410, { error: 'deleted' })]) }), { code: 'link_gone' }));
  test('410 removed → removed', () => assert.rejects(() => getMeta({ ...m, fetchImpl: counting([reply(410, { error: 'removed' })]) }), { code: 'removed' }));
  test('503 retried, then unreachable', async () => {
    const f = counting([reply(503, {})]);
    await assert.rejects(() => getMeta({ ...m, fetchImpl: f }), { code: 'unreachable' });
    assert.equal(f.calls.length, 2);
  });
  test('a body that is not JSON → meta_unreadable', () => assert.rejects(() => getMeta({ ...m, fetchImpl: counting([new Response('<html>', { status: 200 })]) }), { code: 'meta_unreadable' }));

  const future = Date.now() / 1000 + 1000;
  const past = Date.now() / 1000 - 1000;

  test('ceil(z / CHUNK_SIZE) must equal the part count', () => {
    assert.equal(partsFromMeta({ total_chunks: 2 }, CHUNK_SIZE + 1, UUID), 2);
    assert.throws(() => partsFromMeta({ total_chunks: 2 }, CHUNK_SIZE, UUID), { code: 'link_damaged' });
    assert.throws(() => partsFromMeta({ total_chunks: 1 }, CHUNK_SIZE + 1, UUID), { code: 'link_damaged' });
  });
  test('no part count → gone (a tombstone)', () => assert.throws(() => partsFromMeta({ total_chunks: null }, 1, UUID), { code: 'link_gone' }));
  test('nonsense part counts stop', () => {
    for (const n of [0, -1, 1.5, '2', 10_001]) {
      assert.throws(() => partsFromMeta({ total_chunks: n }, 1, UUID), { code: 'meta_unreadable' });
    }
  });
  test('expired → gone', () => assert.throws(() => partsFromMeta({ total_chunks: 1, expiry_timestamp: past }, 1, UUID), { code: 'link_gone' }));
  test('window closed → gone', () => assert.throws(() => partsFromMeta({ total_chunks: 1, available_until_timestamp: past }, 1, UUID), { code: 'link_gone' }));
  test('window not open → not ready', () => assert.throws(() => partsFromMeta({ total_chunks: 1, available_from_timestamp: future }, 1, UUID), { code: 'not_ready' }));
});
