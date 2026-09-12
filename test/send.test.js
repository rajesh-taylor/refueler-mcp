/**
 * test/send.test.js — refueler_send_file tool tests
 *
 * node:test only. No vitest.
 * Test credentials use rfs_test_ prefix — never rfs_live_ or rfs_sign_.
 *
 * Coverage:
 *   - Happy path: correct output shape, share_url contains #, cost_credits matches rate card
 *   - X-File-Name header is always "encrypted-payload" — D-1 invariant
 *   - 402 stops before any chunk upload (all four codes)
 *   - passphrase → passphrase_required: true
 *   - permanent_record → seal_nonce present in fragment (v1 JSON, s field)
 *   - Error matrix: 401, 415, 400 upload_rejected, 409
 *   - Vocabulary: no "sats" / "ecash" / "tokens" in any output field
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { handleSendFile, sendFileTool } from '../src/tools/send.js';

// ---------------------------------------------------------------------------
// Helpers & mocks
// ---------------------------------------------------------------------------

/** Build a minimal stat response for a file of the given size */
function makeStatResult(sizeBytes = 1024) {
  return {
    size: sizeBytes,
    isFile: () => true,
  };
}

/**
 * Mock the fs/promises.stat and the chunkFile generator used inside send.js.
 *
 * Because send.js imports from src/crypto.js (chunkFile, encryptChunk, etc.)
 * at module load time and Node's test runner does not provide deep mock injection,
 * we test handleSendFile by building a thin harness:
 *   - Inject a mock apiClient that controls HTTP responses
 *   - Patch stat via a wrapper that is passed in config
 *   - Use a real (but tiny) file via Node's tmp mechanism
 *
 * For the unit test layer we stub the internals by passing a custom apiClient
 * that captures calls and returns controlled responses.
 */

/** Minimal apiClient factory */
function makeApiClient({
  issueStatus   = 200,
  issueBody     = { uuid: 'test-uuid-1234', signed_point: 'sp', mint_pubkey: 'pk', commitment: 'cmt', issued_tier: 'api' },
  uploadStatus  = 200,
  uploadBody    = {},
} = {}) {
  const calls = { post: [], put: [] };

  return {
    calls,

    async post(path, body) {
      calls.post.push({ path, body });
      return {
        status: issueStatus,
        ok: issueStatus >= 200 && issueStatus < 300,
        body: issueBody,
      };
    },

    async put(path, data, headers) {
      calls.put.push({ path, data, headers });
      return {
        status: uploadStatus,
        ok: uploadStatus >= 200 && uploadStatus < 300,
        body: uploadBody,
      };
    },
  };
}

/** Minimal config stub (Chartered tier) */
const TEST_CONFIG = {
  liveKey: 'rfs_test_live_abcdef',
  signKey: 'rfs_test_sign_abcdef',
};

// ---------------------------------------------------------------------------
// Because handleSendFile calls real fs/promises.stat and real chunkFile
// (which reads from disk), we use a real temp file for happy-path tests
// and exercise error paths by passing a non-existent path.
// ---------------------------------------------------------------------------

import { writeFile, unlink, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tmpDir;
let tmpFile;
const FILE_CONTENT = Buffer.from('The quick brown fox — refueler test payload');

async function setup() {
  tmpDir  = await mkdtemp(join(tmpdir(), 'rftest-'));
  tmpFile = join(tmpDir, 'test-file.txt');
  await writeFile(tmpFile, FILE_CONTENT);
}

async function teardown() {
  try { await unlink(tmpFile); } catch {}
}

// ---------------------------------------------------------------------------
// Rate card helper (must match send.js exactly)
// ---------------------------------------------------------------------------
function computeCostLocal(sizeBytes, permanentRecord = false) {
  const gbCredits = Math.ceil(sizeBytes / 1_000_000_000) * 100;
  return 10 + gbCredits + (permanentRecord ? 20 : 0);
}

// ---------------------------------------------------------------------------
// Fragment v1 decoder — for verifying seal_nonce presence
// ---------------------------------------------------------------------------
function decodeFragmentV1(fragmentBlob) {
  // Reverse of assembleFragment: base64url → UTF-8 → JSON
  const base64 = fragmentBlob.replace(/-/g, '+').replace(/_/g, '/');
  const mod     = base64.length % 4;
  const padded  = mod === 0 ? base64 : base64 + '===='.slice(mod);
  const binary  = atob(padded);
  const bytes   = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return JSON.parse(new TextDecoder().decode(bytes));
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('refueler_send_file', async () => {

  // Run setup once before all tests (node:test hooks)
  let setupDone = false;
  beforeEach(async () => {
    if (!setupDone) {
      await setup();
      setupDone = true;
    }
  });

  // ── Tool schema ───────────────────────────────────────────────────────────

  test('tool name is refueler_send_file', () => {
    assert.equal(sendFileTool.name, 'refueler_send_file');
  });

  test('file_path is required in input schema', () => {
    assert.deepEqual(sendFileTool.inputSchema.required, ['file_path']);
  });

  test('schema has no sats/ecash/tokens in description strings', () => {
    const schema = JSON.stringify(sendFileTool);
    assert.ok(!schema.includes('sats'),   'schema must not mention "sats"');
    assert.ok(!schema.includes('ecash'),  'schema must not mention "ecash"');
    assert.ok(!schema.includes('tokens'), 'schema must not mention "tokens"');
  });

  // ── Happy path ────────────────────────────────────────────────────────────

  test('happy path — correct output shape', async () => {
    await setup();
    const client = makeApiClient();
    const result = await handleSendFile(
      { file_path: tmpFile },
      { apiClient: client, config: TEST_CONFIG },
    );

    assert.ok(Array.isArray(result), 'result is MCP content array');
    assert.equal(result[0].type, 'text');
    const data = JSON.parse(result[0].text);

    assert.ok(typeof data.uuid        === 'string', 'uuid present');
    assert.ok(typeof data.share_url   === 'string', 'share_url present');
    assert.ok(typeof data.expires_at  === 'number', 'expires_at present');
    assert.ok(typeof data.size_bytes  === 'number', 'size_bytes present');
    assert.ok(typeof data.cost_credits === 'number', 'cost_credits present');
    assert.ok(typeof data.passphrase_required === 'boolean', 'passphrase_required present');
    assert.equal(data.collection_receipt_available, true, 'collection_receipt_available true');
  });

  test('share_url contains # fragment separator', async () => {
    await setup();
    const client = makeApiClient();
    const result = await handleSendFile(
      { file_path: tmpFile },
      { apiClient: client, config: TEST_CONFIG },
    );
    const data = JSON.parse(result[0].text);
    assert.ok(data.share_url.includes('#'), 'share_url must contain # fragment');
  });

  test('share_url starts with https://share.refueler.io/', async () => {
    await setup();
    const client = makeApiClient();
    const result = await handleSendFile(
      { file_path: tmpFile },
      { apiClient: client, config: TEST_CONFIG },
    );
    const data = JSON.parse(result[0].text);
    assert.ok(data.share_url.startsWith('https://share.refueler.io/'), 'share_url has correct base');
  });

  test('cost_credits matches rate card for file size', async () => {
    await setup();
    const client = makeApiClient();
    const result = await handleSendFile(
      { file_path: tmpFile },
      { apiClient: client, config: TEST_CONFIG },
    );
    const data = JSON.parse(result[0].text);
    const expected = computeCostLocal(FILE_CONTENT.length, false);
    assert.equal(data.cost_credits, expected, 'cost_credits matches rate card v1.0');
  });

  // ── D-1 invariant — X-File-Name is always "encrypted-payload" ────────────

  test('D-1: X-File-Name header on chunk 0000 is always "encrypted-payload"', async () => {
    await setup();
    const client = makeApiClient();
    await handleSendFile(
      { file_path: tmpFile },
      { apiClient: client, config: TEST_CONFIG },
    );
    const firstPut = client.calls.put[0];
    assert.ok(firstPut, 'chunk 0000 PUT must be made');
    assert.equal(
      firstPut.headers['X-File-Name'],
      'encrypted-payload',
      'X-File-Name must be the constant placeholder, never the real filename',
    );
  });

  test('D-1: X-File-Name is "encrypted-payload" regardless of file name', async () => {
    await setup();
    // Use a file with a distinctive name
    const namedFile = join(tmpDir, 'my-secret-contract.pdf');
    await writeFile(namedFile, FILE_CONTENT);

    const client = makeApiClient();
    await handleSendFile(
      { file_path: namedFile },
      { apiClient: client, config: TEST_CONFIG },
    );
    const firstPut = client.calls.put[0];
    assert.equal(firstPut.headers['X-File-Name'], 'encrypted-payload');

    try { await unlink(namedFile); } catch {}
  });

  test('D-1: real filename is NOT "encrypted-payload" — it travels in the URL fragment', async () => {
    await setup();
    const namedFile = join(tmpDir, 'contract.docx');
    await writeFile(namedFile, FILE_CONTENT);

    const client = makeApiClient();
    const result = await handleSendFile(
      { file_path: namedFile },
      { apiClient: client, config: TEST_CONFIG },
    );
    const data     = JSON.parse(result[0].text);
    const fragment = data.share_url.split('#')[1];
    const parsed   = decodeFragmentV1(fragment);

    assert.equal(parsed.v, 1, 'fragment v field is 1');
    assert.equal(parsed.n, 'contract.docx', 'real filename in fragment n field');
    assert.ok(typeof parsed.k === 'string' && parsed.k.length > 0, 'AES key in fragment k field');

    try { await unlink(namedFile); } catch {}
  });

  // ── 402 — stops before any chunk upload ──────────────────────────────────

  test('402 overage_ceiling — stops before upload, returns payment_required envelope', async () => {
    await setup();
    const client = makeApiClient({
      issueStatus: 402,
      issueBody: {
        code: 'overage_ceiling',
        rail: 'identity',
        remaining_credits: 0,
      },
    });
    const result = await handleSendFile(
      { file_path: tmpFile },
      { apiClient: client, config: TEST_CONFIG },
    );
    const data = JSON.parse(result[0].text);

    assert.equal(data.error, 'payment_required');
    assert.equal(data.code,  'overage_ceiling');
    assert.equal(client.calls.put.length, 0, 'no chunk upload on 402');
  });

  test('402 quota_exhausted — stops before upload', async () => {
    await setup();
    const client = makeApiClient({
      issueStatus: 402,
      issueBody: {
        code: 'quota_exhausted',
        rail: 'identity',
        remaining_credits: 0,
      },
    });
    const result = await handleSendFile(
      { file_path: tmpFile },
      { apiClient: client, config: TEST_CONFIG },
    );
    const data = JSON.parse(result[0].text);

    assert.equal(data.error, 'payment_required');
    assert.equal(data.code,  'quota_exhausted');
    assert.equal(client.calls.put.length, 0);
  });

  test('402 account_cancelled — stops before upload', async () => {
    await setup();
    const client = makeApiClient({
      issueStatus: 402,
      issueBody: {
        code: 'account_cancelled',
        rail: 'identity',
      },
    });
    const result = await handleSendFile(
      { file_path: tmpFile },
      { apiClient: client, config: TEST_CONFIG },
    );
    const data = JSON.parse(result[0].text);

    assert.equal(data.error, 'payment_required');
    assert.equal(data.code,  'account_cancelled');
    assert.equal(client.calls.put.length, 0);
  });

  test('402 credit_invalid — stops before upload', async () => {
    await setup();
    const client = makeApiClient({
      issueStatus: 402,
      issueBody: {
        code: 'credit_invalid',
        rail: 'anonymous',
        remaining_credits: 0,
      },
    });
    const result = await handleSendFile(
      { file_path: tmpFile },
      { apiClient: client, config: TEST_CONFIG },
    );
    const data = JSON.parse(result[0].text);

    assert.equal(data.error, 'payment_required');
    assert.equal(data.code,  'credit_invalid');
    assert.equal(client.calls.put.length, 0);
  });

  test('402 payment envelope has out_of_band_v1 method and dashboard_url', async () => {
    await setup();
    const client = makeApiClient({
      issueStatus: 402,
      issueBody: { code: 'overage_ceiling', rail: 'identity', remaining_credits: 0 },
    });
    const result = await handleSendFile(
      { file_path: tmpFile },
      { apiClient: client, config: TEST_CONFIG },
    );
    const data = JSON.parse(result[0].text);

    assert.equal(data.payment.method,        'out_of_band_v1');
    assert.equal(data.payment.dashboard_url, 'https://refueler.io/share/');
    assert.equal(data.payment.offer,         null, 'offer must be null in v1');
  });

  test('402 shortfall_credits is non-negative', async () => {
    await setup();
    const client = makeApiClient({
      issueStatus: 402,
      issueBody: { code: 'overage_ceiling', rail: 'identity', remaining_credits: 5 },
    });
    const result = await handleSendFile(
      { file_path: tmpFile },
      { apiClient: client, config: TEST_CONFIG },
    );
    const data = JSON.parse(result[0].text);
    assert.ok(data.shortfall_credits >= 0, 'shortfall_credits is non-negative');
  });

  // ── passphrase ────────────────────────────────────────────────────────────

  test('passphrase → passphrase_required: true in output', async () => {
    await setup();
    const client = makeApiClient();
    const result = await handleSendFile(
      { file_path: tmpFile, passphrase: 'correct horse battery staple' },
      { apiClient: client, config: TEST_CONFIG },
    );
    const data = JSON.parse(result[0].text);
    assert.equal(data.passphrase_required, true);
  });

  test('passphrase → X-P2SH-Secret-Hash present on chunk 0000', async () => {
    await setup();
    const client = makeApiClient();
    await handleSendFile(
      { file_path: tmpFile, passphrase: 'correct horse battery staple' },
      { apiClient: client, config: TEST_CONFIG },
    );
    const firstPut = client.calls.put[0];
    assert.ok(
      typeof firstPut.headers['X-P2SH-Secret-Hash'] === 'string' &&
      firstPut.headers['X-P2SH-Secret-Hash'].length > 0,
      'X-P2SH-Secret-Hash must be present when passphrase supplied',
    );
  });

  test('no passphrase → passphrase_required: false', async () => {
    await setup();
    const client = makeApiClient();
    const result = await handleSendFile(
      { file_path: tmpFile },
      { apiClient: client, config: TEST_CONFIG },
    );
    const data = JSON.parse(result[0].text);
    assert.equal(data.passphrase_required, false);
  });

  // ── permanent_record ──────────────────────────────────────────────────────

  test('permanent_record → fragment contains s (seal_nonce) field', async () => {
    await setup();
    const client = makeApiClient();
    const result = await handleSendFile(
      { file_path: tmpFile, permanent_record: true },
      { apiClient: client, config: TEST_CONFIG },
    );
    const data     = JSON.parse(result[0].text);
    const fragment = data.share_url.split('#')[1];
    const parsed   = decodeFragmentV1(fragment);

    assert.equal(parsed.v, 1, 'v1 fragment');
    assert.ok(typeof parsed.s === 'string' && parsed.s.length > 0, 'seal_nonce in fragment s field');
  });

  test('no permanent_record → fragment has no s field', async () => {
    await setup();
    const client = makeApiClient();
    const result = await handleSendFile(
      { file_path: tmpFile },
      { apiClient: client, config: TEST_CONFIG },
    );
    const data     = JSON.parse(result[0].text);
    const fragment = data.share_url.split('#')[1];
    const parsed   = decodeFragmentV1(fragment);

    assert.equal(parsed.s, undefined, 'no seal_nonce field when permanent_record not set');
  });

  test('permanent_record → cost_credits includes +20', async () => {
    await setup();
    const client = makeApiClient();
    const result = await handleSendFile(
      { file_path: tmpFile, permanent_record: true },
      { apiClient: client, config: TEST_CONFIG },
    );
    const data    = JSON.parse(result[0].text);
    const withPR  = computeCostLocal(FILE_CONTENT.length, true);
    assert.equal(data.cost_credits, withPR);
  });

  // ── Manifest headers ──────────────────────────────────────────────────────

  test('chunk 0000 has X-Cashu-Credential header', async () => {
    await setup();
    const client = makeApiClient();
    await handleSendFile({ file_path: tmpFile }, { apiClient: client, config: TEST_CONFIG });
    const firstPut = client.calls.put[0];
    assert.ok(firstPut.headers['X-Cashu-Credential'], 'X-Cashu-Credential must be set');
  });

  test('chunk 0000 has X-Total-Chunks and X-Total-Bytes', async () => {
    await setup();
    const client = makeApiClient();
    await handleSendFile({ file_path: tmpFile }, { apiClient: client, config: TEST_CONFIG });
    const firstPut = client.calls.put[0];
    assert.ok(firstPut.headers['X-Total-Chunks'], 'X-Total-Chunks present');
    assert.ok(firstPut.headers['X-Total-Bytes'],  'X-Total-Bytes present');
  });

  test('destroy_after_download → X-Destroy-After-Download: "1"', async () => {
    await setup();
    const client = makeApiClient();
    await handleSendFile(
      { file_path: tmpFile, destroy_after_download: true },
      { apiClient: client, config: TEST_CONFIG },
    );
    const firstPut = client.calls.put[0];
    assert.equal(firstPut.headers['X-Destroy-After-Download'], '1');
  });

  test('no destroy_after_download → header absent', async () => {
    await setup();
    const client = makeApiClient();
    await handleSendFile({ file_path: tmpFile }, { apiClient: client, config: TEST_CONFIG });
    const firstPut = client.calls.put[0];
    assert.equal(firstPut.headers['X-Destroy-After-Download'], undefined);
  });

  test('available_from / available_until forwarded as strings', async () => {
    await setup();
    const client = makeApiClient();
    const from  = 1757000000;
    const until = 1757100000;
    await handleSendFile(
      { file_path: tmpFile, available_from: from, available_until: until },
      { apiClient: client, config: TEST_CONFIG },
    );
    const firstPut = client.calls.put[0];
    assert.equal(firstPut.headers['X-Available-From'],  String(from));
    assert.equal(firstPut.headers['X-Available-Until'], String(until));
  });

  test('transfer_ref truncated to 128 chars', async () => {
    await setup();
    const client  = makeApiClient();
    const longRef = 'x'.repeat(200);
    await handleSendFile(
      { file_path: tmpFile, transfer_ref: longRef },
      { apiClient: client, config: TEST_CONFIG },
    );
    const firstPut = client.calls.put[0];
    assert.ok(
      firstPut.headers['X-Transfer-Ref']?.length <= 128,
      'X-Transfer-Ref must be ≤ 128 chars',
    );
  });

  // ── Error matrix ──────────────────────────────────────────────────────────

  test('file not found returns send_failed error', async () => {
    const client = makeApiClient();
    const result = await handleSendFile(
      { file_path: '/tmp/does-not-exist-rftest-xyz.bin' },
      { apiClient: client, config: TEST_CONFIG },
    );
    const data = JSON.parse(result[0].text);
    assert.equal(data.error, 'send_failed');
    assert.equal(client.calls.post.length, 0, 'no API call on missing file');
    assert.equal(client.calls.put.length, 0);
  });

  test('401 from credential/issue → auth_failed', async () => {
    await setup();
    const client = makeApiClient({
      issueStatus: 401,
      issueBody: { detail: 'HMAC signature mismatch' },
    });
    const result = await handleSendFile(
      { file_path: tmpFile },
      { apiClient: client, config: TEST_CONFIG },
    );
    const data = JSON.parse(result[0].text);
    assert.equal(data.error, 'auth_failed');
    assert.equal(client.calls.put.length, 0);
  });

  test('415 from upload → file_type_denied', async () => {
    await setup();
    const client = makeApiClient({
      uploadStatus: 415,
      uploadBody: { detail: 'application/x-executable' },
    });
    const result = await handleSendFile(
      { file_path: tmpFile },
      { apiClient: client, config: TEST_CONFIG },
    );
    const data = JSON.parse(result[0].text);
    assert.equal(data.error, 'file_type_denied');
  });

  test('400 upload_rejected from upload → upload_rejected', async () => {
    await setup();
    const client = makeApiClient({
      uploadStatus: 400,
      uploadBody: { error: 'upload_rejected', detail: 'Missing X-Cashu-Credential' },
    });
    const result = await handleSendFile(
      { file_path: tmpFile },
      { apiClient: client, config: TEST_CONFIG },
    );
    const data = JSON.parse(result[0].text);
    assert.equal(data.error, 'upload_rejected');
  });

  test('400 integrity_failed from upload → integrity_failed with chunk', async () => {
    await setup();
    const client = makeApiClient({
      uploadStatus: 400,
      uploadBody: { error: 'integrity_failed', chunk: 0 },
    });
    const result = await handleSendFile(
      { file_path: tmpFile },
      { apiClient: client, config: TEST_CONFIG },
    );
    const data = JSON.parse(result[0].text);
    assert.equal(data.error, 'integrity_failed');
    assert.equal(data.chunk, 0);
  });

  test('409 from upload → already_complete with uuid', async () => {
    await setup();
    const client = makeApiClient({
      uploadStatus: 409,
      uploadBody: { error: 'already_complete', uuid: 'test-uuid-1234' },
    });
    const result = await handleSendFile(
      { file_path: tmpFile },
      { apiClient: client, config: TEST_CONFIG },
    );
    const data = JSON.parse(result[0].text);
    assert.equal(data.error, 'already_complete');
  });

  // ── Vocabulary — no "sats"/"ecash"/"tokens" in any output field ───────────

  test('vocabulary: no "sats" in any output on happy path', async () => {
    await setup();
    const client = makeApiClient();
    const result = await handleSendFile(
      { file_path: tmpFile },
      { apiClient: client, config: TEST_CONFIG },
    );
    const text = result[0].text;
    assert.ok(!text.includes('sats'),   'output must not contain "sats"');
  });

  test('vocabulary: no "ecash" in any output', async () => {
    await setup();
    const client = makeApiClient();
    const result = await handleSendFile(
      { file_path: tmpFile },
      { apiClient: client, config: TEST_CONFIG },
    );
    const text = result[0].text;
    assert.ok(!text.includes('ecash'),  'output must not contain "ecash"');
  });

  test('vocabulary: no "tokens" in any output', async () => {
    await setup();
    const client = makeApiClient();
    const result = await handleSendFile(
      { file_path: tmpFile },
      { apiClient: client, config: TEST_CONFIG },
    );
    const text = result[0].text;
    assert.ok(!text.includes('tokens'), 'output must not contain "tokens"');
  });

  test('vocabulary: no "sats" in payment_required envelope', async () => {
    await setup();
    const client = makeApiClient({
      issueStatus: 402,
      issueBody: { code: 'overage_ceiling', rail: 'identity', remaining_credits: 0 },
    });
    const result = await handleSendFile(
      { file_path: tmpFile },
      { apiClient: client, config: TEST_CONFIG },
    );
    const text = result[0].text;
    assert.ok(!text.includes('sats'),   '"sats" must not appear in payment_required envelope');
    assert.ok(!text.includes('ecash'),  '"ecash" must not appear in payment_required envelope');
    assert.ok(!text.includes('tokens'), '"tokens" must not appear in payment_required envelope');
  });

  // ── Fragment v1 grammar ───────────────────────────────────────────────────

  test('fragment v1: has v, k, n fields', async () => {
    await setup();
    const client = makeApiClient();
    const result = await handleSendFile(
      { file_path: tmpFile },
      { apiClient: client, config: TEST_CONFIG },
    );
    const data     = JSON.parse(result[0].text);
    const fragment = data.share_url.split('#')[1];
    const parsed   = decodeFragmentV1(fragment);

    assert.equal(parsed.v, 1);
    assert.ok(typeof parsed.k === 'string' && parsed.k.length > 0, 'k (AES key) present');
    assert.ok(typeof parsed.n === 'string' && parsed.n.length > 0, 'n (filename) present');
  });

  test('fragment v1: AES key is NOT "encrypted-payload"', async () => {
    await setup();
    const client = makeApiClient();
    const result = await handleSendFile(
      { file_path: tmpFile },
      { apiClient: client, config: TEST_CONFIG },
    );
    const data     = JSON.parse(result[0].text);
    const fragment = data.share_url.split('#')[1];
    const parsed   = decodeFragmentV1(fragment);

    assert.notEqual(parsed.k, 'encrypted-payload', 'k must be the actual AES key, not the placeholder');
    assert.notEqual(parsed.n, 'encrypted-payload', 'n must be the real filename, not the placeholder');
  });
});
