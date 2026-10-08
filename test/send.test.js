/**
 * test/send.test.js — refueler_send_file tool tests (rewritten at MCP-Fix-1)
 *
 * node:test only. No vitest.
 * Test credentials use the rfs_test_ prefix — never rfs_live_ or rfs_sign_.
 *
 * The tool now drives the direct-to-R2 path, so these tests stand in for the
 * three Worker endpoints and for R2 itself:
 *
 *   POST /upload/:uuid/initiate → session token + presigned URLs + tail URL
 *   PUT  <presigned URL>        → captured, with its exact byte length
 *   POST /upload/:uuid/urls     → the next batch
 *   POST /upload/:uuid/finalise → hashes + merkle_root
 *
 * Coverage:
 *   - happy path output shape; share_url carries ?uuid= AND a v2 fragment
 *   - X-File-Name is always "encrypted-payload" (D-1), and the real name,
 *     the key and the passphrase appear ONLY where they should
 *   - parts are v2: decryptable under the derived part key, plaintext + 16 bytes
 *   - the finalise merkle_root equals the tree over the bytes R2 received
 *   - multi-part: the tail URL is used for part N−1 and /urls is not asked for it
 *   - at most two PUTs are open at once
 *   - 402 at issue and at initiate stop before any part is uploaded
 *   - error matrix: 401, 403, 409, 413, 503, finalise 409, R2 403
 *   - permanent_record is refused rather than faked
 *   - vocabulary: no "sats" / "ecash" / "tokens" in any output field
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { handleSendFile, sendFileTool } from '../src/tools/send.js';
import { derivePartKey, decryptPart, blake3Chunk, CHUNK_SIZE } from '../src/crypto.js';
import { buildMerkleTree } from '../src/merkle.js';
import { parseFragment } from '../src/fragment.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const hex = (b) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');
const b64urlToBytes = (s) =>
  new Uint8Array(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));

const TEST_UUID = '11111111-2222-4333-8444-555555555555';

/** Parse the single text block a handler returns. */
function parse(result) {
  assert.ok(Array.isArray(result), 'handler must return a content array');
  assert.equal(result.length, 1);
  assert.equal(result[0].type, 'text');
  return JSON.parse(result[0].text);
}

/** A credential provider that never touches the network. */
function makeCredentialProvider(overrides = {}) {
  return async () => ({
    uuid:         TEST_UUID,
    credential:   JSON.stringify({ id: '00ab', amount: 1, secret: 'ff'.repeat(32), C: '02' + 'bb'.repeat(32) }),
    commitment:   'rfs_test_commitment',
    issuedTier:   'api',
    extraHeaders: {},
    ...overrides,
  });
}

/**
 * makeHarness — stands in for the Worker and R2.
 * Captures every call so a test can assert on headers, bodies and part bytes.
 */
function makeHarness({
  initiateStatus = 200,
  initiateBody   = null,
  urlsStatus     = 200,
  finaliseStatus = 200,
  finaliseBody   = { ok: true },
  putStatus      = 200,
  batchSize      = 256,
} = {}) {
  const calls = { initiate: [], urls: [], finalise: [], puts: [], maxInFlight: 0 };
  let inFlight = 0;

  const api = {
    async call(method, path, opts = {}) {
      if (path.endsWith('/initiate')) {
        calls.initiate.push({ method, path, headers: opts.extraHeaders || {} });
        if (initiateStatus !== 200) {
          return { ok: false, status: initiateStatus, body: initiateBody, text: '' };
        }
        const totalChunks = Number(opts.extraHeaders['X-Total-Chunks']);
        const fullCount   = totalChunks - 1;
        const firstCount  = Math.min(fullCount, batchSize);
        const urls = [];
        for (let i = 0; i < firstCount; i++) {
          urls.push({ index: i, url: `https://r2.test/part/${i}`, expires: 0 });
        }
        return {
          ok: true, status: 200, text: '',
          body: initiateBody ?? {
            uuid:          TEST_UUID,
            session_token: 'rfs_test_session',
            part_size:     CHUNK_SIZE,
            total_chunks:  totalChunks,
            urls,
            batch_next:    fullCount > batchSize ? batchSize : null,
            tail_url:      { index: fullCount, url: `https://r2.test/tail/${fullCount}`, expires: 0 },
          },
        };
      }

      if (path.endsWith('/urls')) {
        const body = JSON.parse(opts.body);
        calls.urls.push({ ...body, session: opts.extraHeaders?.['X-Upload-Session'] });
        if (urlsStatus !== 200) return { ok: false, status: urlsStatus, body: null, text: '' };
        const urls = [];
        for (let i = body.from; i < body.from + Math.min(body.count, batchSize); i++) {
          urls.push({ index: i, url: `https://r2.test/part/${i}`, expires: 0 });
        }
        return { ok: true, status: 200, text: '', body: { uuid: TEST_UUID, urls, batch_next: null } };
      }

      if (path.endsWith('/finalise')) {
        calls.finalise.push({
          body:    JSON.parse(opts.body),
          session: opts.extraHeaders?.['X-Upload-Session'],
        });
        return {
          ok:     finaliseStatus >= 200 && finaliseStatus < 300,
          status: finaliseStatus, body: finaliseBody, text: '',
        };
      }

      throw new Error(`harness got an unexpected call: ${method} ${path}`);
    },
  };

  async function putPart(url, bytes) {
    inFlight++;
    calls.maxInFlight = Math.max(calls.maxInFlight, inFlight);
    // Yield once so overlapping PUTs are actually observable.
    await new Promise(r => setImmediate(r));
    calls.puts.push({ url, length: bytes.length, bytes: Uint8Array.from(bytes) });
    inFlight--;
    if (putStatus !== 200) return { ok: false, status: putStatus, etag: '', text: 'rejected' };
    return { ok: true, status: 200, etag: 'rfs_test_etag', text: '' };
  }

  return { api, putPart, calls };
}

const TEST_CONFIG = { liveKey: 'rfs_test_live_key', signKey: 'rfs_test_sign_key', rail: 'identity' };

let tmpDir;
before(async () => { tmpDir = await mkdtemp(join(tmpdir(), 'rfs_test_send_')); });
after(async () => { if (tmpDir) await rm(tmpDir, { recursive: true, force: true }); });

/** Write a deterministic test file and return its path + bytes. */
async function makeFile(name, size) {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 31 + 7) & 0xff;
  const filePath = join(tmpDir, name);
  await writeFile(filePath, bytes);
  return { filePath, bytes };
}

/** Run the tool against a harness. */
async function send(input, harnessOpts = {}, depsExtra = {}) {
  const harness = makeHarness(harnessOpts);
  const result = await handleSendFile(input, {
    api:             harness.api,
    config:          TEST_CONFIG,
    issueCredential: makeCredentialProvider(),
    putPart:         harness.putPart,
    ...depsExtra,
  });
  return { out: parse(result), calls: harness.calls, harness };
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

describe('sendFileTool definition', () => {
  test('is named refueler_send_file and requires file_path', () => {
    assert.equal(sendFileTool.name, 'refueler_send_file');
    assert.deepEqual(sendFileTool.inputSchema.required, ['file_path']);
  });

  test('schema no longer offers permanent_record as a send option', () => {
    assert.equal(sendFileTool.inputSchema.properties.permanent_record, undefined);
  });

  test('description and schema never say sats, ecash or tokens', () => {
    const text = JSON.stringify(sendFileTool).toLowerCase();
    for (const word of ['sats', 'ecash', 'tokens']) {
      assert.ok(!text.includes(word), `tool definition must not say "${word}"`);
    }
  });
});

// ---------------------------------------------------------------------------
// Happy path — single part
// ---------------------------------------------------------------------------

describe('happy path — one part', () => {
  test('returns the expected envelope', async () => {
    const { filePath } = await makeFile('one.bin', 4096);
    const { out, calls } = await send({ file_path: filePath });

    assert.equal(out.error, undefined, out.detail);
    assert.equal(out.uuid, TEST_UUID);
    assert.equal(out.size_bytes, 4096);
    assert.equal(out.total_parts, 1);
    assert.equal(out.passphrase_required, false);
    assert.equal(out.tree_algo, 'rfc6962-unbalanced-blake3-v1');
    assert.equal(typeof out.expires_at, 'number');
    // Rate card v1.0: 10 per transfer + 100 per GB band.
    assert.equal(out.cost_credits, 110);

    assert.equal(calls.initiate.length, 1);
    assert.equal(calls.puts.length, 1);
    assert.equal(calls.finalise.length, 1);
    // One part means the tail URL is the only URL; /urls is never called.
    assert.equal(calls.urls.length, 0);
  });

  test('share_url carries ?uuid= and a v2 fragment', async () => {
    const { filePath } = await makeFile('url.bin', 2048);
    const { out } = await send({ file_path: filePath });

    assert.ok(out.share_url.startsWith('https://refueler.io/share/?uuid='),
      `share_url must point at the live receiver: ${out.share_url}`);
    assert.ok(out.share_url.includes(`?uuid=${TEST_UUID}#`), 'uuid must precede the fragment');

    const parsed = parseFragment(out.share_url.split('#')[1]);
    assert.equal(parsed.v, 2);
    assert.equal(parsed.filename, 'url.bin');
    assert.equal(parsed.sizeBytes, 2048);
    assert.equal(parsed.ivBytes, null, 'v2 carries no IV');
    assert.equal(parsed.sealNonce, null);
    assert.equal(parsed.keyBytes.length, 32);
  });

  test('the fragment size agrees with the part count the receiver checks', async () => {
    const { filePath } = await makeFile('size.bin', 9000);
    const { out } = await send({ file_path: filePath });
    const parsed = parseFragment(out.share_url.split('#')[1]);
    assert.equal(Math.ceil(parsed.sizeBytes / CHUNK_SIZE), out.total_parts);
  });
});

// ---------------------------------------------------------------------------
// D-1 and fragment-only secrets
// ---------------------------------------------------------------------------

describe('D-1 invariant and what never reaches the Worker', () => {
  test('X-File-Name is the constant placeholder', async () => {
    const { filePath } = await makeFile('secret-report.pdf', 1234);
    const { calls } = await send({ file_path: filePath });
    assert.equal(calls.initiate[0].headers['X-File-Name'], 'encrypted-payload');
  });

  test('the real filename is in no request the Worker sees', async () => {
    const { filePath } = await makeFile('payroll-2026.xlsx', 1000);
    const { out, calls } = await send({ file_path: filePath });

    const sent = JSON.stringify({ initiate: calls.initiate, urls: calls.urls, finalise: calls.finalise });
    assert.ok(!sent.includes('payroll-2026'), 'the filename must never leave in a request');
    assert.equal(parseFragment(out.share_url.split('#')[1]).filename, 'payroll-2026.xlsx');
  });

  test('the transfer key is in no request the Worker sees', async () => {
    const { filePath } = await makeFile('key.bin', 777);
    const { out, calls } = await send({ file_path: filePath });

    const keyHex = hex(parseFragment(out.share_url.split('#')[1]).keyBytes);
    const sent = JSON.stringify({ initiate: calls.initiate, urls: calls.urls, finalise: calls.finalise });
    assert.ok(!sent.toLowerCase().includes(keyHex), 'the key must never leave this process');
  });

  test('initiate gets the byte count (cap, cost, tail length) and the part count', async () => {
    const { filePath } = await makeFile('bytes.bin', 5555);
    const { calls } = await send({ file_path: filePath });
    assert.equal(calls.initiate[0].headers['X-Total-Bytes'], '5555');
    assert.equal(calls.initiate[0].headers['X-Total-Chunks'], '1');
  });
});

// ---------------------------------------------------------------------------
// Part crypto on the wire
// ---------------------------------------------------------------------------

describe('what R2 actually receives', () => {
  test('each part is v2 ciphertext: plaintext + 16, decryptable at its index', async () => {
    const size = 3000;
    const { filePath, bytes } = await makeFile('v2.bin', size);
    const { out, calls } = await send({ file_path: filePath });

    assert.equal(calls.puts.length, 1);
    assert.equal(calls.puts[0].length, size + 16, 'stored part is plaintext + the 16-byte tag');

    const key = parseFragment(out.share_url.split('#')[1]).keyBytes;
    const decKey = await derivePartKey(key, ['decrypt']);
    const plain = await decryptPart(decKey, calls.puts[0].bytes, 0, 1);
    assert.equal(hex(plain), hex(bytes), 'the recipient gets the original bytes back');
  });

  test('the part is not decryptable with the transfer key itself', async () => {
    const { filePath } = await makeFile('notk.bin', 512);
    const { out, calls } = await send({ file_path: filePath });

    const key = parseFragment(out.share_url.split('#')[1]).keyBytes;
    const kKey = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['decrypt']);
    const nonce = new Uint8Array(12); nonce[11] = 1;
    await assert.rejects(() => crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: new Uint8Array(4) }, kKey, calls.puts[0].bytes));
  });

  test('finalise sends the Merkle root over exactly the bytes R2 stored', async () => {
    const { filePath } = await makeFile('root.bin', 8192);
    const { calls } = await send({ file_path: filePath });

    const digests = [blake3Chunk(calls.puts[0].bytes)];
    const { root } = buildMerkleTree(digests);

    const body = calls.finalise[0].body;
    assert.equal(body.hashes.length, 1);
    assert.equal(hex(b64urlToBytes(body.merkle_root)), hex(root));
    assert.equal(hex(b64urlToBytes(body.hashes[0])), hex(digests[0]));
    assert.equal(calls.finalise[0].session, 'rfs_test_session');
  });
});

// ---------------------------------------------------------------------------
// Multi-part
// ---------------------------------------------------------------------------

describe('multi-part transfer', () => {
  test('two parts: tail URL used for N−1, parts reassemble into the original file', async () => {
    const size = CHUNK_SIZE + 100;
    const { filePath, bytes } = await makeFile('two.bin', size);
    const { out, calls } = await send({ file_path: filePath });

    assert.equal(out.error, undefined, out.detail);
    assert.equal(out.total_parts, 2);
    assert.equal(calls.puts.length, 2);

    const byUrl = new Map(calls.puts.map(p => [p.url, p]));
    const part0 = byUrl.get('https://r2.test/part/0');
    const part1 = byUrl.get('https://r2.test/tail/1');
    assert.ok(part0, 'part 0 goes to a batch URL');
    assert.ok(part1, 'part 1 goes to the tail URL issued at initiate');

    assert.equal(part0.length, CHUNK_SIZE + 16);
    assert.equal(part1.length, 100 + 16);

    // /urls is never asked for the tail index.
    for (const u of calls.urls) assert.ok(u.from < 1, `/urls asked for ${u.from}, which is the tail`);

    const key = parseFragment(out.share_url.split('#')[1]).keyBytes;
    const decKey = await derivePartKey(key, ['decrypt']);
    const p0 = await decryptPart(decKey, part0.bytes, 0, 2);
    const p1 = await decryptPart(decKey, part1.bytes, 1, 2);
    const joined = new Uint8Array(size);
    joined.set(p0, 0);
    joined.set(p1, CHUNK_SIZE);
    assert.equal(hex(joined), hex(bytes));

    // A part opened at the wrong index, or as the wrong "last", must fail.
    await assert.rejects(() => decryptPart(decKey, part0.bytes, 1, 2));
    await assert.rejects(() => decryptPart(decKey, part1.bytes, 1, 3));
  });

  test('no more than two parts are ever in flight at once', async () => {
    const { filePath } = await makeFile('flight.bin', 2 * CHUNK_SIZE + 10);
    const { calls } = await send({ file_path: filePath });
    assert.ok(calls.maxInFlight <= 2, `saw ${calls.maxInFlight} parts in flight`);
    assert.equal(calls.puts.length, 3);
  });
});

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

describe('options', () => {
  test('passphrase → X-P2SH-Secret-Hash set and passphrase_required true', async () => {
    const { filePath } = await makeFile('pass.bin', 100);
    const { out, calls } = await send({ file_path: filePath, passphrase: 'correct horse battery staple' });
    assert.equal(out.passphrase_required, true);
    // The pinned SHA-256 of that phrase (PARITY.md test vector).
    assert.equal(calls.initiate[0].headers['X-P2SH-Secret-Hash'],
      'c4bbcb1fbec99d65bf59d85c8cb62ee2db963f0fe106f483d9afa73bd4e39a8a');
    const everything = JSON.stringify({ calls, url: out.share_url });
    assert.ok(!everything.includes('correct horse'), 'the passphrase must not leave this process');
  });

  test('destroy_after_download → header "1"; absent otherwise', async () => {
    const { filePath } = await makeFile('dad.bin', 100);
    const on  = await send({ file_path: filePath, destroy_after_download: true });
    const off = await send({ file_path: filePath });
    assert.equal(on.calls.initiate[0].headers['X-Destroy-After-Download'], '1');
    assert.equal(off.calls.initiate[0].headers['X-Destroy-After-Download'], undefined);
  });

  test('available_from / available_until forwarded as strings', async () => {
    const { filePath } = await makeFile('tidal.bin', 100);
    const { calls } = await send({
      file_path: filePath, available_from: 1800000000, available_until: 1800003600,
    });
    assert.equal(calls.initiate[0].headers['X-Available-From'], '1800000000');
    assert.equal(calls.initiate[0].headers['X-Available-Until'], '1800003600');
  });

  test('transfer_ref is truncated to 128 characters', async () => {
    const { filePath } = await makeFile('ref.bin', 100);
    const { calls } = await send({ file_path: filePath, transfer_ref: 'r'.repeat(200) });
    assert.equal(calls.initiate[0].headers['X-Transfer-Ref'].length, 128);
  });

  test('expiry requested is 7 days — the ceiling initiate enforces until B12-4a', async () => {
    const { filePath } = await makeFile('exp.bin', 100);
    const { out, calls } = await send({ file_path: filePath });
    const requested = Number(calls.initiate[0].headers['X-Expiry-Timestamp']);
    const window = requested - Math.floor(Date.now() / 1000);
    assert.ok(window <= 7 * 24 * 3600 && window > 7 * 24 * 3600 - 60, `window was ${window}s`);
    assert.equal(out.expires_at, requested);
  });

  test('permanent_record is refused, not faked', async () => {
    const { filePath } = await makeFile('pr.bin', 100);
    const { out, calls } = await send({ file_path: filePath, permanent_record: true });
    assert.equal(out.error, 'not_supported');
    assert.equal(calls.initiate.length, 0, 'nothing is initiated');
    assert.equal(calls.puts.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Failure matrix
// ---------------------------------------------------------------------------

describe('failures before anything is uploaded', () => {
  test('a missing file returns send_failed', async () => {
    const { out, calls } = await send({ file_path: join(tmpDir, 'does-not-exist.bin') });
    assert.equal(out.error, 'send_failed');
    assert.equal(calls.initiate.length, 0);
  });

  test('a path traversal sequence is refused', async () => {
    const { out } = await send({ file_path: '../../etc/passwd' });
    assert.equal(out.error, 'send_failed');
    assert.match(out.detail, /traversal/);
  });

  test('an empty file is refused (initiate needs total_bytes >= 1)', async () => {
    const { filePath } = await makeFile('empty.bin', 0);
    const { out, calls } = await send({ file_path: filePath });
    assert.equal(out.error, 'send_failed');
    assert.equal(calls.initiate.length, 0);
  });

  test('a file over the advertised cap is refused before the credential is issued', async () => {
    const { filePath } = await makeFile('big.bin', 4096);
    const harness = makeHarness();
    let issued = false;
    const result = await handleSendFile({ file_path: filePath }, {
      api:             harness.api,
      config:          TEST_CONFIG,
      capabilities:    { limits: { max_transfer_bytes: 1024 } },
      issueCredential: async () => { issued = true; return makeCredentialProvider()(); },
      putPart:         harness.putPart,
    });
    const out = parse(result);
    assert.equal(out.error, 'too_large');
    assert.equal(out.max_transfer_bytes, 1024);
    assert.equal(issued, false, 'no credential is issued for an over-cap file');
  });

  test('402 at credential issue returns the payment_required envelope, nothing uploaded', async () => {
    const { filePath } = await makeFile('p402.bin', 100);
    const harness = makeHarness();
    const result = await handleSendFile({ file_path: filePath }, {
      api: harness.api, config: TEST_CONFIG, putPart: harness.putPart,
      issueCredential: async () => {
        const e = new Error('payment_required');
        e.paymentRequired = {
          code: 'quota_exhausted', rail: 'identity', remaining_credits: 5, shortfall_credits: 105,
        };
        throw e;
      },
    });
    const out = parse(result);
    assert.equal(out.error, 'payment_required');
    assert.equal(out.code, 'quota_exhausted');
    assert.equal(out.shortfall_credits, 105);
    assert.equal(out.remaining_credits, 5);
    assert.equal(out.payment.method, 'out_of_band_v1');
    assert.equal(harness.calls.initiate.length, 0);
    assert.equal(harness.calls.puts.length, 0);
  });

  test('account_cancelled omits remaining_credits', async () => {
    const { filePath } = await makeFile('cancel.bin', 100);
    const harness = makeHarness();
    const result = await handleSendFile({ file_path: filePath }, {
      api: harness.api, config: TEST_CONFIG, putPart: harness.putPart,
      issueCredential: async () => {
        const e = new Error('payment_required');
        e.paymentRequired = { code: 'account_cancelled', rail: 'identity' };
        throw e;
      },
    });
    const out = parse(result);
    assert.equal(out.code, 'account_cancelled');
    assert.equal(out.remaining_credits, undefined);
  });

  test('an auth failure at issue returns auth_failed', async () => {
    const { filePath } = await makeFile('auth.bin', 100);
    const harness = makeHarness();
    const result = await handleSendFile({ file_path: filePath }, {
      api: harness.api, config: TEST_CONFIG, putPart: harness.putPart,
      issueCredential: async () => {
        const e = new Error('HMAC authentication failed.');
        e.authFailed = true;
        throw e;
      },
    });
    assert.equal(parse(result).error, 'auth_failed');
  });

  test('no API client at all is reported, not thrown', async () => {
    const { filePath } = await makeFile('noapi.bin', 100);
    const out = parse(await handleSendFile({ file_path: filePath }, {}));
    assert.equal(out.error, 'send_failed');
  });
});

describe('failures at initiate', () => {
  const cases = [
    [402, { code: 'quota_exhausted', rail: 'identity', remaining_credits: 0, shortfall_credits: 110 }, 'payment_required'],
    [401, { error: 'Credential commitment mismatch' }, 'credential_invalid'],
    [403, { error: 'Availability scheduling requires a paid subscription' }, 'tier_gate'],
    [409, { error: 'Credential already spent' }, 'already_complete'],
    [413, { error: 'Declared total exceeds cap' }, 'too_large'],
    [503, { error: 'Upload temporarily unavailable' }, 'send_failed'],
  ];

  for (const [status, body, expected] of cases) {
    test(`initiate ${status} → ${expected}, nothing uploaded`, async () => {
      const { filePath } = await makeFile(`init-${status}.bin`, 100);
      const { out, calls } = await send({ file_path: filePath },
        { initiateStatus: status, initiateBody: body });
      assert.equal(out.error, expected, out.detail);
      assert.equal(calls.puts.length, 0);
      assert.equal(calls.finalise.length, 0);
    });
  }

  test('initiate without a session token stops the send', async () => {
    const { filePath } = await makeFile('nosession.bin', 100);
    const { out, calls } = await send({ file_path: filePath }, {
      initiateBody: {
        uuid: TEST_UUID, total_chunks: 1, urls: [],
        tail_url: { index: 0, url: 'https://r2.test/tail/0' },
      },
    });
    assert.equal(out.error, 'send_failed');
    assert.match(out.detail, /session token/);
    assert.equal(calls.puts.length, 0);
  });

  test('a tail URL for the wrong index stops the send', async () => {
    const { filePath } = await makeFile('badtail.bin', 100);
    const { out, calls } = await send({ file_path: filePath }, {
      initiateBody: {
        uuid: TEST_UUID, session_token: 'rfs_test_session', total_chunks: 1, urls: [],
        tail_url: { index: 7, url: 'https://r2.test/tail/7' },
      },
    });
    assert.equal(out.error, 'send_failed');
    assert.match(out.detail, /tail URL/);
    assert.equal(calls.puts.length, 0);
  });
});

describe('failures during upload and finalise', () => {
  test('R2 403 on a part is fatal and is not retried', async () => {
    const { filePath } = await makeFile('r2403.bin', 100);
    const { out, calls } = await send({ file_path: filePath }, { putStatus: 403 });
    assert.equal(out.error, 'part_rejected');
    assert.equal(out.uuid, TEST_UUID);
    assert.equal(calls.puts.length, 1, 'a 403 must not be retried');
    assert.equal(calls.finalise.length, 0, 'never finalise an incomplete set');
  });

  test('finalise 409 incomplete is reported as not collectable, with the missing parts', async () => {
    const { filePath } = await makeFile('incomplete.bin', 100);
    const { out } = await send({ file_path: filePath }, {
      finaliseStatus: 409, finaliseBody: { error: 'incomplete', missing: ['0000'] },
    });
    assert.equal(out.error, 'incomplete');
    assert.deepEqual(out.missing, ['0000']);
    assert.equal(out.uuid, TEST_UUID);
  });

  test('finalise 409 already_complete is reported as such', async () => {
    const { filePath } = await makeFile('already.bin', 100);
    const { out } = await send({ file_path: filePath }, {
      finaliseStatus: 409, finaliseBody: { error: 'already_complete' },
    });
    assert.equal(out.error, 'already_complete');
  });

  test('finalise 401 reports an expired session', async () => {
    const { filePath } = await makeFile('fin401.bin', 100);
    const { out } = await send({ file_path: filePath }, {
      finaliseStatus: 401, finaliseBody: { error: 'Invalid or expired upload session' },
    });
    assert.equal(out.error, 'session_expired');
  });

  test('a failed finalise never produces a share URL', async () => {
    const { filePath } = await makeFile('nourl.bin', 100);
    const { out } = await send({ file_path: filePath }, {
      finaliseStatus: 500, finaliseBody: { error: 'Failed to persist chunk hashes' },
    });
    assert.equal(out.error, 'finalise_failed');
    assert.equal(out.share_url, undefined);
  });

  test('a 401 from /urls on a multi-part send reports an expired session', async () => {
    // Three parts with batchSize 1: part 0 comes from initiate, part 1 needs /urls.
    const { filePath } = await makeFile('urls401.bin', 2 * CHUNK_SIZE + 10);
    const { out, calls } = await send({ file_path: filePath }, { batchSize: 1, urlsStatus: 401 });
    assert.equal(out.error, 'session_expired');
    assert.equal(calls.finalise.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

describe('vocabulary: credits only', () => {
  const forbidden = ['sats', 'ecash', 'tokens'];

  test('the happy-path envelope says none of them', async () => {
    const { filePath } = await makeFile('vocab.bin', 100);
    const { out } = await send({ file_path: filePath });
    const text = JSON.stringify(out).toLowerCase();
    for (const word of forbidden) assert.ok(!text.includes(word), `output said "${word}"`);
    assert.ok('cost_credits' in out);
  });

  test('the payment_required envelope says none of them', async () => {
    const { filePath } = await makeFile('vocab2.bin', 100);
    const { out } = await send({ file_path: filePath }, {
      initiateStatus: 402,
      initiateBody: { code: 'quota_exhausted', rail: 'identity', remaining_credits: 0, shortfall_credits: 110 },
    });
    const text = JSON.stringify(out).toLowerCase();
    for (const word of forbidden) assert.ok(!text.includes(word), `envelope said "${word}"`);
  });

  test('every error envelope says none of them', async () => {
    const { filePath } = await makeFile('vocab3.bin', 100);
    for (const opts of [{ putStatus: 403 }, { finaliseStatus: 500 }, { initiateStatus: 413 }]) {
      const { out } = await send({ file_path: filePath }, opts);
      const text = JSON.stringify(out).toLowerCase();
      for (const word of forbidden) assert.ok(!text.includes(word), `${JSON.stringify(opts)} said "${word}"`);
    }
  });
});
