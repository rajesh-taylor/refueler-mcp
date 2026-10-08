# PARITY.md — hashSecret() parity check

**Checked at:** SW-MCP-2 · 12 Sep 2026  
**Files compared:** `worker/src/nut11.js` vs `src/crypto.js`

---

## Construction

Both functions implement:

```
SHA-256( UTF-8(passphrase) ) → lowercase hex string
```

No domain tag. No salt. No prefix. Bare SHA-256 only.

## worker/src/nut11.js

```js
export async function hashSecret(passphrase) {
  const encoded = new TextEncoder().encode(passphrase);
  const hash = await crypto.subtle.digest('SHA-256', encoded);
  return bytesToHex(new Uint8Array(hash));
}
```

Uses `crypto.subtle` (Cloudflare Workers global). `bytesToHex` maps each byte
to a two-character lowercase hex string.

## src/crypto.js (this repo)

```js
export async function hashSecret(passphrase) {
  const encoded = new TextEncoder().encode(passphrase);
  const hash = await globalThis.crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}
```

Uses `globalThis.crypto.subtle` (Node WebCrypto). Same output encoding.

Note: BLAKE3 in `src/crypto.js` uses `@noble/hashes/blake3` (pure JS, no WASM).
The `blake3` npm package was rejected — `blake3-wasm@2.1.7` does not exist on npm.

## Result

**✅ MATCH.** Both functions produce identical output for all inputs.  
The `p2sh_secret_hash` value written to the manifest by the Worker and the
hash constructed by the MCP server for NUT-11 passphrase verification are
identical. No fix required.

## Test vector (for reference)

```
Input:   "correct horse battery staple"
SHA-256: c4bbcb1fbec99d65bf59d85c8cb62ee2db963f0fe106f483d9afa73bd4e39a8a
```

Both implementations must produce this value for the above input.

---

# Part crypto + fragment + Merkle parity

**Checked at:** MCP-Fix-1 · 8 Oct 2026
**Files compared:** `src/crypto.js` · `src/fragment.js` · `src/merkle.js`
against refueler-share `frontend/crypto.js` · `frontend/fragment.js` ·
`frontend/merkle.js` (and, for the tree, `worker/src/merkle.js`).

## Part key schedule — link format v2

```
part_key = HKDF-SHA256(K, salt = empty, info = utf8("refueler.share.payload.v2") ‖ 0x00)
nonce_i  = 0x00 ×7 ‖ BE32(i) ‖ last     (last = 0x01 on part N−1, else 0x00)
AAD_i    = BE32(i)
stored   = AES-256-GCM(part_key, nonce_i, AAD_i, P_i) = ciphertext ‖ 16-byte tag
```

`CHUNK_SIZE` is 32 MiB (33,554,432) on every side. A stored part is exactly its
plaintext length + 16; the presigned PUT signs `content-length`, so one extra
byte is refused by R2.

**Before this session** `src/crypto.js` used a different scheme entirely: K
imported directly as an AES-GCM key, a fresh random 12-byte IV per chunk
prepended to each stored object, and an 8 MiB chunk size. That is not nonce
reuse, but it is incompatible with a v2 receiver, 12 bytes too long for a signed
PUT, and the wrong chunk size for `/initiate`'s `total_chunks` check.

## Result

**✅ MATCH, byte-for-byte.** `test/part-crypto.test.js` carries the known-answer
vectors from refueler-share `worker/test/part-crypto.test.js`, which were
produced by the browser's own `frontend/crypto.js`:

| Vector | What it pins |
|---|---|
| HKDF `info` | `72656675656c65722e73686172652e7061796c6f61642e763200` |
| part key for K = 00 01 … 1f | `071ab966413cac37cbf2a65ebe81ad4da4049b2ecf665ce219891f073c231727` |
| T1 | nonces, AADs and the three ciphertexts for N = 3 |
| T2 | the last-flag on index 0 of a single-part transfer |
| T3 | a full 32 MiB part: length 33,554,448, its SHA-256 and its tag |
| T4 | the v2 fragment blob for `test.bin`, z = 33,554,455 |

The same file also runs the check in the other direction — the browser's own
`decryptPart` opening a part this server encrypted, and the browser's own
`assembleFragment` producing the same blob. Those three tests are skipped unless
`REFUELER_SHARE_DIR` points at a refueler-share checkout, so a clean CI without
the sibling repo still passes:

```
REFUELER_SHARE_DIR=/path/to/refueler-share npm test
```

## Merkle root

`src/merkle.js` is a port of the same RFC 6962 unbalanced, domain-separated
(`0x00` leaf / `0x01` node) BLAKE3 tree, `tree_algo:
"rfc6962-unbalanced-blake3-v1"`. `TEST_VECTORS` are the four pinned roots shared
with `frontend/merkle.js` and `worker/src/merkle.js`; `test/merkle.test.js`
gates on them. A wrong root is silent at upload and surfaces only as a 409 wall
at download, so these vectors are a hard gate. Fix the code, never the vectors.

The removed `blake3Root()` (concatenate the per-chunk digests, hash once) was
not a value the Worker reads anywhere.
