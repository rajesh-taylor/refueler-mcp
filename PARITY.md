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
