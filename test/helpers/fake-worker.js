/**
 * test/helpers/fake-worker.js — a stand-in Worker for /meta and /download
 *
 * Holds real AES-GCM parts made by the same crypto as a send. `fetch` plugs into
 * the fetch tool directly; `listen` serves the same answers over HTTP for the
 * tests that start the real server process.
 */

import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { derivePartKey, encryptPart, CHUNK_SIZE } from '../../src/crypto.js';
import { assembleFragment } from '../../src/fragment.js';

export async function makeTransfer({ size = 1024, name = 'report.pdf', dad = false, password = false } = {}) {
  const uuid = randomUUID();
  const key = new Uint8Array(randomBytes(32));
  const plain = new Uint8Array(randomBytes(size));
  const n = Math.ceil(size / CHUNK_SIZE);
  const partKey = await derivePartKey(key, ['encrypt']);
  const parts = [];
  for (let i = 0; i < n; i++) {
    parts.push(await encryptPart(partKey, plain.subarray(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE), i, n));
  }
  const fragment = assembleFragment({ keyBytes: key, filename: name, sizeBytes: size });
  return {
    uuid, key, plain, parts, fragment, name, size,
    link: `https://share.refueler.io/?uuid=${uuid}#${fragment}`,
    meta: {
      file_name: 'encrypted-payload',
      total_bytes: null,
      total_chunks: n,
      expiry_timestamp: Math.floor(Date.now() / 1000) + 3600,
      passphrase_protected: password,
      pending_destruction: dad ? false : null,
      available_from_timestamp: null,
      available_until_timestamp: null,
      timestamp_state: null,
    },
  };
}

const json = (body, status, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

/**
 * createFakeWorker(transfer) → { fetch, requests, order, script, listen }
 *
 * `script.download(i, attempt)` may return a Response (or a promise of one) to
 * override a part. `script.meta()` does the same for /meta.
 */
export function createFakeWorker(transfer) {
  const requests = [];
  const order = [];
  const attempts = new Map();
  const script = { download: null, meta: null };

  async function respond(url, headers) {
    const u = new URL(url);
    if (u.pathname === '/meta') {
      if (script.meta) {
        const r = await script.meta();
        if (r) return r;
      }
      return json(transfer.meta, 200);
    }
    if (u.pathname === '/download') {
      const i = parseInt(headers['X-Part'], 10);
      const attempt = attempts.get(i) ?? 0;
      attempts.set(i, attempt + 1);
      order.push(i);
      if (script.download) {
        const r = await script.download(i, attempt);
        if (r) return r;
      }
      return new Response(transfer.parts[i], { status: 200, headers: { 'X-Integrity': 'ciphertext-storage-verified' } });
    }
    return json({ error: 'not_found' }, 404);
  }

  async function fakeFetch(url, opts = {}) {
    requests.push({ url, headers: { ...opts.headers } });
    return respond(url, opts.headers ?? {});
  }

  /** Serves the same answers on 127.0.0.1. → { apiBase, close } */
  async function listen() {
    const server = createServer(async (req, res) => {
      const headers = {
        'X-Transfer-UUID': req.headers['x-transfer-uuid'],
        'X-Part': req.headers['x-part'],
      };
      requests.push({ url: req.url, headers: req.headers });
      const r = await respond(`http://local${req.url}`, headers);
      res.writeHead(r.status, Object.fromEntries(r.headers));
      res.end(Buffer.from(await r.arrayBuffer()));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return {
      apiBase: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }),
    };
  }

  return { fetch: fakeFetch, requests, order, script, listen };
}
