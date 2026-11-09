/**
 * src/fetch/transport.js — /meta and /download for a recipient (MCP-Fetch-1)
 *
 * Decision 1: DL-3's transport minus resume; DL-3 adds to this file.
 *
 * The transfer ID travels in X-Transfer-UUID and the part in X-Part, never in a
 * path or query. No HMAC header is ever set here and this file has no access to
 * the API keys: fetching must not tie the recipient to an account.
 */

import { CHUNK_SIZE, CHUNK_TAG_BYTES } from '../crypto.js';
import { FetchStop } from './stop.js';

/** frontend/progress.js RETRY_DELAYS_MS: 13 waits, 14 tries, 117 s of waiting. */
export const RETRY_DELAYS_MS = [2000, 5000, 10000, 10000, 10000, 10000, 10000,
                                10000, 10000, 10000, 10000, 10000, 10000];

const META_RETRY_DELAYS_MS = [2000, 5000];
const META_TIMEOUT_MS = 30_000;
const MAX_RETRY_AFTER_S = 300;

/** Download spec §2.1: no bytes for this long → abort and retry. */
export const STALL_MS = 120_000;

/** Parts in flight, as frontend/download-fetch.js DL_IN_FLIGHT. */
export const PARTS_IN_FLIGHT = 2;

/** X-Part is four digits at the Worker. */
const MAX_PARTS = 10_000;

export function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

const integrity = () => new FetchStop('integrity_failed',
  'A part did not arrive as stored. Nothing was saved.');

const rateLimited = () => new FetchStop('rate_limited',
  'Refueler asked this server to slow down for too long. Try again later. Nothing was saved.');

const notReady = () => new FetchStop('not_ready',
  'This transfer is not ready to download yet. Try again later.');

/** Seconds from Retry-After, or null when absent or unreadable. */
function retryAfterMs(res) {
  const raw = res.headers.get('retry-after');
  if (raw === null || !/^\d+$/.test(raw.trim())) return null;
  const seconds = Number(raw);
  if (seconds > MAX_RETRY_AFTER_S) throw rateLimited();
  return seconds * 1000;
}

/**
 * getMeta({ apiBase, uuid, fetchImpl }) → the /meta body.
 * Stops on every answer that means the transfer can't be fetched.
 */
export async function getMeta({ apiBase, uuid, fetchImpl = fetch, retryDelays = META_RETRY_DELAYS_MS, wait = sleep }) {
  for (let attempt = 0; ; attempt++) {
    let res = null;
    try {
      res = await fetchImpl(`${apiBase}/meta`, {
        headers: { 'X-Transfer-UUID': uuid, Accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(META_TIMEOUT_MS),
      });
    } catch { /* retried below */ }

    if (res?.status === 200) {
      try {
        return await res.json();
      } catch {
        throw new FetchStop('meta_unreadable', 'Refueler’s answer was incomplete. Try again in a minute.');
      }
    }
    if (res?.status === 404 || res?.status === 400) {
      throw new FetchStop('not_found', 'No transfer was found for this link. It may have expired, or the link may be damaged.', { uuid });
    }
    if (res?.status === 410) {
      const body = await res.json().catch(() => null);
      if (body?.error === 'removed') {
        throw new FetchStop('removed', 'This transfer was removed after a report.', { uuid });
      }
      throw new FetchStop('link_gone', 'This transfer has been deleted or has expired.', { uuid });
    }

    let delay = retryDelays[attempt];
    if (delay === undefined) {
      if (res?.status === 429) throw rateLimited();
      throw new FetchStop('unreachable', 'Refueler could not be reached. Try again in a minute.');
    }
    if (res?.status === 429) delay = retryAfterMs(res) ?? delay;
    await wait(delay);
  }
}

/** Checks the fields a fetch relies on. → total parts. */
export function partsFromMeta(meta, sizeBytes, uuid, now = Date.now() / 1000) {
  const n = meta?.total_chunks;
  if (n === null || n === undefined) {
    throw new FetchStop('link_gone', 'This transfer has been deleted or has expired.', { uuid });
  }
  if (!Number.isSafeInteger(n) || n < 1 || n > MAX_PARTS) {
    throw new FetchStop('meta_unreadable', 'Refueler’s answer was incomplete. Try again in a minute.', { uuid });
  }
  const until = meta.available_until_timestamp;
  if ((meta.expiry_timestamp && meta.expiry_timestamp <= now) || (until && until <= now)) {
    throw new FetchStop('link_gone', 'This transfer has been deleted or has expired.', { uuid });
  }
  if (meta.available_from_timestamp && meta.available_from_timestamp > now) throw notReady();
  if (Math.ceil(sizeBytes / CHUNK_SIZE) !== n) {
    throw new FetchStop('link_damaged',
      'This link is not complete or has been changed. Ask the sender to send it again, in full.', { uuid });
  }
  return n;
}

/** Exact stored length of part i of n, for a file of sizeBytes. */
export function expectedPartBytes(i, n, sizeBytes) {
  const plain = i < n - 1 ? CHUNK_SIZE : sizeBytes - (n - 1) * CHUNK_SIZE;
  return plain + CHUNK_TAG_BYTES;
}

/**
 * fetchPart — one whole part, as ciphertext.
 *
 * 409, an empty body or a wrong length: integrity failure, never retried.
 * 400, 401, 410, 416: fatal. 425: not ready. 429 honours Retry-After.
 * Anything else, including a body cut by the network, follows the browser's schedule.
 */
export async function fetchPart({
  apiBase, uuid, index, expectedBytes, signal, onStart,
  fetchImpl = fetch, retryDelays = RETRY_DELAYS_MS, stallMs = STALL_MS, wait = sleep,
}) {
  const headers = { 'X-Transfer-UUID': uuid, 'X-Part': String(index).padStart(4, '0') };

  for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
    if (signal?.aborted) throw new FetchStop('stopped', 'The fetch was stopped. Nothing was saved.');

    const stall = new AbortController();
    let timer;
    const arm = () => { clearTimeout(timer); timer = setTimeout(() => stall.abort(), stallMs); };
    const combined = signal ? AbortSignal.any([signal, stall.signal]) : stall.signal;

    let delay = retryDelays[attempt];
    try {
      arm();
      const res = await fetchImpl(`${apiBase}/download`, { headers, signal: combined, redirect: 'error' });

      if (res.status === 409) throw integrity();
      if ([400, 401, 410, 416].includes(res.status)) {
        throw new FetchStop('refused', 'Refueler did not accept this download. It may have expired or already been collected. Nothing was saved.', { uuid });
      }
      if (res.status === 425) throw notReady();
      if (res.status === 429) delay = retryAfterMs(res) ?? delay;

      if (res.status === 200) {
        onStart?.();
        const buf = new Uint8Array(expectedBytes);
        const reader = res.body.getReader();
        let got = 0;
        for (;;) {
          arm();
          const { done, value } = await reader.read();
          if (done) break;
          if (got + value.byteLength > expectedBytes) {
            reader.cancel().catch(() => {}); // not awaited: a body that won't close can't hold this up
            throw integrity();
          }
          buf.set(value, got);
          got += value.byteLength;
        }
        if (got !== expectedBytes) throw integrity();
        return buf;
      }
    } catch (e) {
      if (e instanceof FetchStop) throw e;
      // a network failure or a stall: retried below
    } finally {
      clearTimeout(timer);
    }

    if (attempt < retryDelays.length) await wait(delay, signal);
  }

  throw new FetchStop('unreachable', 'Refueler could not be reached after several tries. Nothing was saved.', { uuid });
}

/**
 * eachPartInOrder — parts handed to `use` strictly in order, overlapped.
 *
 * As frontend/download-fetch.js _eachPartInOrder: the next part is asked for once
 * the one before starts arriving, part 0 first.
 *
 * D-DAD-1, stricter than the browser: the last part is asked for only after every
 * earlier part has been through `use`. Serving it can start the deletion.
 *
 * @param {number}   n
 * @param {Function} getPart — (index, onStart) → Promise<bytes>
 * @param {Function} use     — async (bytes, index)
 * @param {object}   [opts]
 * @param {Function} [opts.abort] — stops parts still in flight after a failure
 * @param {number}   [opts.inFlight]
 */
export async function eachPartInOrder(n, getPart, use, { abort, inFlight = PARTS_IN_FLIGHT } = {}) {
  const pending = new Map();
  let next = 0;
  let waiting = 0;
  let used = 0;

  const fill = () => {
    while (next < n && waiting === 0 && pending.size < inFlight) {
      if (next === n - 1 && used < n - 1) break;
      waiting++;
      let started = false;
      const begin = () => { if (!started) { started = true; waiting--; fill(); } };
      const p = getPart(next, begin);
      p.then(begin, () => { if (!started) { started = true; waiting--; } });
      pending.set(next++, p);
    }
  };

  try {
    for (let i = 0; i < n; i++) {
      fill();
      const bytes = await pending.get(i);
      pending.delete(i);
      fill();
      await use(bytes, i);
      used++;
    }
  } catch (e) {
    next = n; // nothing further starts
    abort?.();
    await Promise.allSettled(pending.values());
    throw e;
  }
}
