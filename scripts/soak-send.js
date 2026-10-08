#!/usr/bin/env node
/**
 * scripts/soak-send.js — live end-to-end check of refueler_send_file (MCP-Fix-1)
 *
 *   node scripts/soak-send.js <file> [--verify] [--keep]
 *
 * Why this is a script and not part of src/: it sends on the X-Admin-Key
 * soak path (POST /admin/test-credential → a MAC'd X-Test-Credential that lets
 * /initiate skip the Cashu spend ledger, capped at cap_chunks). That is Rajesh's
 * admin key and a test-only route — it has no place in a published package, so
 * src/ keeps only the production HMAC credential path and this script injects
 * the soak provider through handleSendFile's issueCredential hook.
 *
 * Environment:
 *   REFUELER_ADMIN_KEY   — required. The Worker's X-Admin-Key.
 *   REFUELER_API_BASE    — optional, defaults to https://api.share.refueler.io
 *
 * --verify downloads every part back through the Worker, decrypts with the key
 * from the link fragment, and compares the bytes against the file on disk. That
 * proves the round trip without a browser; the browser check is still the one
 * that matters for behaviour, so the script prints the link to open in Safari.
 *
 * NEVER add this script to bin/sync-share.sh or any public mirror.
 */

import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

import { handleSendFile } from '../src/tools/send.js';
import { createApiClient } from '../src/api.js';
import { generateBlindedCredential, derivePartKey, decryptPart, CHUNK_SIZE } from '../src/crypto.js';
import { parseFragment } from '../src/fragment.js';

// ---------------------------------------------------------------------------
// Arguments and environment
// ---------------------------------------------------------------------------

const args     = process.argv.slice(2);
const filePath = args.find(a => !a.startsWith('--'));
const doVerify = args.includes('--verify');

if (!filePath) {
  console.error('usage: node scripts/soak-send.js <file> [--verify]');
  process.exit(2);
}

const adminKey = process.env.REFUELER_ADMIN_KEY;
if (!adminKey) {
  console.error('REFUELER_ADMIN_KEY is not set — this script sends on the admin soak path.');
  process.exit(2);
}

const apiBase = (process.env.REFUELER_API_BASE ?? 'https://api.share.refueler.io').replace(/\/$/, '');

// No liveKey/signKey: the soak path never calls /api/v1/credential/issue, and
// leaving liveKey unset keeps X-Api-Live-Key off the initiate request entirely.
const config = { liveKey: null, signKey: 'unused-on-the-soak-path', apiBase, rail: 'identity' };
const api    = createApiClient(config);

// ---------------------------------------------------------------------------
// Soak credential provider
// ---------------------------------------------------------------------------

/**
 * Mints a real blind signature plus the MAC'd X-Test-Credential for one UUID.
 *
 * /initiate skips the BDHKE verify and the Supabase spend INSERT when that
 * header checks out, so the X-Cashu-Credential value is not read on this path —
 * it only has to be present. If the MAC did NOT check out, /initiate falls
 * through to the paid path, fails to verify this placeholder and returns 401
 * with nothing spent. Fail-closed either way.
 */
async function issueSoakCredential() {
  const blinded = generateBlindedCredential();

  const res = await api.call('POST', '/admin/test-credential', {
    body: JSON.stringify({
      blinded_message:    blinded.blindedMsg,
      cap_bytes:          8 * 1024 * 1024 * 1024,   // 8 GiB of headroom for the soak
      expires_in_seconds: 3600,
    }),
    extraHeaders: { 'X-Admin-Key': adminKey },
  });

  if (!res.ok) {
    throw new Error(`/admin/test-credential returned HTTP ${res.status}: ${(res.body?.error || res.text || '').slice(0, 200)}`);
  }

  const { uuid, commitment, issued_tier: issuedTier, test_credential } = res.body;
  if (!uuid || !commitment || !issuedTier || !test_credential) {
    throw new Error('/admin/test-credential response was missing a required field.');
  }

  return {
    uuid,
    credential:   'soak-test-credential',   // not read on the test path; see above
    commitment,
    issuedTier,
    extraHeaders: { 'X-Test-Credential': test_credential },
  };
}

// ---------------------------------------------------------------------------
// Verify — download every part back and compare the bytes
// ---------------------------------------------------------------------------

async function verifyDownload(uuid, fragment, originalPath) {
  const { keyBytes, filename, sizeBytes } = parseFragment(fragment);
  const totalParts = Math.ceil(sizeBytes / CHUNK_SIZE);

  console.log(`\n  verify: filename "${filename}", ${sizeBytes} bytes, ${totalParts} part(s)`);

  const meta = await api.call('GET', `/meta/${uuid}`);
  if (!meta.ok) throw new Error(`/meta returned HTTP ${meta.status}`);
  if (meta.body.total_chunks !== totalParts) {
    throw new Error(`/meta says ${meta.body.total_chunks} parts, the link says ${totalParts}`);
  }
  console.log(`  verify: /meta agrees on ${totalParts} part(s); file_name is "${meta.body.file_name}"`);

  const decKey = await derivePartKey(keyBytes, ['decrypt']);
  const out = Buffer.alloc(sizeBytes);
  let offset = 0;

  for (let i = 0; i < totalParts; i++) {
    const url = `${apiBase}/download/${uuid}/${String(i).padStart(4, '0')}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`part ${i}: download returned HTTP ${res.status}`);
    const ct = new Uint8Array(await res.arrayBuffer());
    const plain = new Uint8Array(await decryptPart(decKey, ct, i, totalParts));
    out.set(plain, offset);
    offset += plain.length;
    console.log(`  verify: part ${i} — ${ct.length} ciphertext bytes → ${plain.length} plaintext bytes`);
  }

  if (offset !== sizeBytes) throw new Error(`reassembled ${offset} bytes, expected ${sizeBytes}`);

  const original = await readFile(originalPath);
  const a = createHash('sha256').update(original).digest('hex');
  const b = createHash('sha256').update(out).digest('hex');

  console.log(`  verify: sha256 on disk      ${a}`);
  console.log(`  verify: sha256 round-tripped ${b}`);
  if (a !== b) throw new Error('BYTES DIFFER — the round trip is broken');
  console.log('  verify: ✓ byte-identical');
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const resolved = path.resolve(filePath);
const info = await stat(resolved);
console.log(`soak-send: ${resolved}`);
console.log(`  ${info.size} bytes → ${Math.ceil(info.size / CHUNK_SIZE)} part(s) of ${CHUNK_SIZE} bytes`);
console.log(`  api base: ${apiBase}`);

const started = Date.now();
const result = await handleSendFile(
  { file_path: resolved },
  { api, config, issueCredential: issueSoakCredential },
);
const elapsed = ((Date.now() - started) / 1000).toFixed(1);

const out = JSON.parse(result[0].text);

if (out.error) {
  console.error(`\n✗ send failed after ${elapsed}s: ${out.error}`);
  console.error(`  ${out.detail}`);
  if (out.uuid) console.error(`  uuid: ${out.uuid}`);
  process.exit(1);
}

console.log(`\n✓ sent in ${elapsed}s`);
console.log(`  uuid        ${out.uuid}`);
console.log(`  parts       ${out.total_parts}`);
console.log(`  merkle_root ${out.merkle_root}`);
console.log(`  tree_algo   ${out.tree_algo}`);
console.log(`  cost        ${out.cost_credits} credits`);
console.log(`  expires_at  ${new Date(out.expires_at * 1000).toISOString()}`);
console.log(`\n  link (open this in Safari):\n  ${out.share_url}\n`);

if (doVerify) {
  await verifyDownload(out.uuid, out.share_url.split('#')[1], resolved);
}
