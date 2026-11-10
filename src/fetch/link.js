/**
 * src/fetch/link.js — strict reader for a Share link (MCP-Fetch-1)
 *
 * Deliberately not parseFragment (src/fragment.js): its legacy branch reads
 * anything undecodable as a raw key. Here a link is v2 in exactly the shape a
 * sender makes, or it stops.
 *
 * Link text is secret. Nothing thrown from this file quotes it.
 */

import { derivePartKey } from '../crypto.js';
import { FetchStop, OPEN_IN_BROWSER } from './stop.js';

export const MAX_LINK_BYTES = 16 * 1024;

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const V2_KEYS = new Set(['v', 'k', 'n', 's', 'z']);

const damaged = () => new FetchStop('link_damaged',
  'This link is not complete or has been changed. Ask the sender to send it again, in full.');

const notShare = () => new FetchStop('link_wrong_host',
  'This is not a Refueler Share link.');

/** Canonical unpadded base64url → bytes, or null. Buffer alone accepts junk silently. */
function b64urlStrict(s) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]+$/.test(s)) return null;
  const b = Buffer.from(s, 'base64url');
  return b.toString('base64url') === s ? new Uint8Array(b) : null;
}

/**
 * readLink(text, { hosts }) → { v, uuid, keyBytes, name, sizeBytes }
 *
 * The API base never comes from here; `hosts` only says which links are ours.
 */
export function readLink(text, { hosts }) {
  if (typeof text !== 'string') throw damaged();
  const link = text.trim();
  if (!link || Buffer.byteLength(link) > MAX_LINK_BYTES) throw damaged();
  // WHATWG URL quietly strips tabs and rewrites backslashes; refuse them first.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \u007f\\]/.test(link)) throw damaged();

  let url;
  try { url = new URL(link); } catch { throw damaged(); }

  if (url.protocol !== 'https:' || !hosts.includes(url.hostname)) throw notShare();
  if (url.username || url.password || url.port || url.pathname !== '/') throw damaged();

  const raw = url.hash.slice(1);
  if (!raw) throw damaged();

  // v0 links are "#uuid=…&key=…", which is not base64url.
  if (raw.startsWith('uuid=')) throw new FetchStop('open_in_browser', OPEN_IN_BROWSER);

  const bytes = b64urlStrict(raw);
  if (!bytes) throw damaged();

  // A blob starts with "{". Anything else may be a v0 raw key: the browser's call.
  if (bytes[0] !== 0x7b) throw new FetchStop('open_in_browser', OPEN_IN_BROWSER);

  let obj;
  try { obj = JSON.parse(Buffer.from(bytes).toString('utf8')); } catch { throw damaged(); }

  switch (obj.v) {
    case 2:
      return readV2(obj, url.search);
    case 3:
      throw new FetchStop('link_v3_not_yet',
        'This is a newer link that this server cannot fetch yet. Open it at share.refueler.io.');
    default:
      throw new FetchStop('open_in_browser', OPEN_IN_BROWSER);
  }
}

function readV2(obj, search) {
  for (const key of Object.keys(obj)) if (!V2_KEYS.has(key)) throw damaged();

  const match = /^\?uuid=([^&]+)$/.exec(search);
  if (!match || !UUID_RE.test(match[1])) throw damaged();

  const keyBytes = b64urlStrict(obj.k);
  if (!keyBytes || keyBytes.length !== 32) throw damaged();

  if (typeof obj.n !== 'string' || obj.n.length === 0) throw damaged();
  if (!Number.isSafeInteger(obj.z) || obj.z < 1) throw damaged();

  // `s` belongs to the date seal, which this server does not read. Checked, then dropped.
  if (obj.s !== undefined && !b64urlStrict(obj.s)) throw damaged();

  return { v: 2, uuid: match[1], keyBytes, name: obj.n, sizeBytes: obj.z };
}

/**
 * transferKeys(parsed, fetchKc) → the part key.
 *
 * The seam for v3: MCP-Fetch-2 adds a branch that calls fetchKc (POST /key).
 * An explicit case per version, never a `!== 2` test.
 */
export async function transferKeys(parsed, fetchKc) { // eslint-disable-line no-unused-vars
  switch (parsed.v) {
    case 2:
      return derivePartKey(parsed.keyBytes, ['decrypt']);
    default:
      throw new FetchStop('open_in_browser', OPEN_IN_BROWSER);
  }
}
