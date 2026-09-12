# DEMO.md — Refueler Share MCP on-stage runbook
> **Repo:** `refueler-mcp` · `/Users/rajeshtaylor/Documents/refueler-mcp/docs/DEMO.md`
> **Maintained by:** Rajesh Taylor · **Last updated:** SW-MCP-6 · 12 Sep 2026

---

## Pre-flight checklist

Run through this **before you walk on stage** — not in the green room, not during the intro.

```bash
# 1. Credentials in shell environment
echo $REFUELER_LIVE_KEY   # must print rfs_live_... (not empty, not rfs_test_...)
echo $REFUELER_SIGN_KEY   # must print rfs_sign_...

# 2. Test suite green
cd /Users/rajeshtaylor/Documents/refueler-mcp
node --test 2>&1 | tail -5
# Expected last line: "pass N" with N >= 228, zero failures

# 3. Demo payload readable
cat scripts/demo-payload.txt
# Should print the Refueler Share paragraph — no error

# 4. Dry run (full happy path, silent unless it fails)
node scripts/demo-send.js
# Must exit 0 and print a share_url line
```

If **any** of these fail, do not go on stage. Fix or reschedule.

---

## Happy path script — exact commands

This is what you type, live, in order. Each block is one terminal entry.

### Quote first

```bash
node -e "
import('./src/tools/quote.js').then(m => m.handler(
  { size_bytes: 512, permanent_record: false },
  { apiKey: process.env.REFUELER_LIVE_KEY,
    signKey: process.env.REFUELER_SIGN_KEY,
    baseUrl: 'https://api.share.refueler.io' }
)).then(r => console.log(JSON.parse(r.content[0].text)));
" --input-type=module
```

**What the audience sees:** `cost_credits`, `affordable: true`, reference GBP figure.
**What to say:** *"Before anything is sent, the agent asks: can we afford this transfer? It gets back a cost — in credits — and a live reference rate in GBP. No transfer is attempted until we know the answer is yes."*

### Send the file

```bash
node scripts/demo-send.js
```

**What the audience sees:** three steps printing in sequence — Quote, Lodge, Check.
The final line prints the `share_url`. Takes 3–8 seconds on a live connection.

**What to say:** *"The file is encrypted here, on this machine, before a single byte leaves. The Worker at the other end receives sealed ciphertext — it cannot read the filename, the content, or who sent it. What it hands back is a share link and a signed acceptance receipt."*

### Check the transfer state (standalone, after sending)

```bash
node -e "
import('./src/tools/check.js').then(m => m.handler(
  { transfer_id: 'PASTE_UUID_HERE' },
  { apiKey: process.env.REFUELER_LIVE_KEY,
    signKey: process.env.REFUELER_SIGN_KEY,
    baseUrl: 'https://api.share.refueler.io' }
)).then(r => console.log(JSON.parse(r.content[0].text)));
" --input-type=module
```

**What to say:** *"The agent can poll at any point. State is derived from two cryptographic receipts — acceptance (the server received it) and collection (the recipient collected it). If neither receipt exists yet, the state is simply 'uploaded' — no guessing."*

---

## Failure-mode rehearsal

Practise each failure response once before the session. The goal is a one-sentence pivot, no panic.

### 402 — quota exhausted or insufficient credits

**Terminal output:** `✗ Insufficient credits — N remaining, M required`

**What to say:**
*"That's the quota gate working as designed. In production, an agent would top up credits or escalate to the account manager before retrying. The 402 tells you exactly why — quota, ceiling, or cancellation — so the agent knows which action to take."*

### auth_failed

**Terminal output:** `✗ Authentication failed — check REFUELER_LIVE_KEY and REFUELER_SIGN_KEY`

**What to say:**
*"Every request is HMAC-signed — method, path, timestamp, and body hash together. If the signature doesn't verify, the Worker rejects with auth_failed before doing anything else. The credentials never travel in plaintext."*

### File not found

**Terminal output:** `✗ Cannot read demo payload at .../scripts/demo-payload.txt`

**What to say:**
*"The agent reads and encrypts the file locally before making any network call. If the file path is wrong or unreadable, nothing is sent — there's no half-uploaded transfer to clean up."*

---

## Honesty script — what is live vs designed-not-yet-live

Recite these if asked. One sentence each. Do not wing it.

| Feature | Status | What to say |
|---------|--------|-------------|
| **HMAC authentication** | ✅ **Live** | "Every API request is signed with HMAC-SHA256 over method, path, timestamp, and body hash — verified at the Worker before any storage operation." |
| **Server-side BLAKE3 chunk integrity** | ✅ **Live** | "The Worker verifies the BLAKE3 hash of every encrypted chunk on upload — a corrupted or tampered chunk returns 400 and is never stored." |
| **Acceptance and collection receipts** | ✅ **Live** | "Two signed receipts: one when the transfer is accepted by the server, one when the recipient collects. Both are HMAC-signed and pull-able at any time." |
| **Identity-rail credit pool** | ✅ **Live** | "Monthly allocation, lazy reset on next credential issue, overage ceiling — all live in the Worker against a KV quota record." |
| **Anonymous rail (Lightning / credits)** | 🔒 **Designed, not live** | "The anonymous rail is fully designed — Lightning payment to a credit block, no identity surface. It gates on our self-hosted Lightning node, which goes live at the next infrastructure milestone." |
| **Full end-to-end file integrity (Merkle root)** | 🔒 **Designed, not live** | "Chunk-level BLAKE3 is verified today. Full Merkle-root verification — proving the assembled file matches the chunk tree — is in the next security milestone, not yet built." |
| **Silent Drop (Harbourmaster)** | 🔒 **Designed, not live** | "Silent Drop is a standing encrypted inbox — a recipient publishes a drop link and senders lodge files without the recipient ever responding. Architecture is locked; it builds after the Lightning node is live." |
| **BOLT12 / inline agent payment** | 🔒 **Forward commitment** | "BOLT12 lets an agent pay a Lightning invoice inline during a tool call — no human intervention. That's a forward commitment for a later release, not current." |
| **NUT-11 Mode 2 (keypair-bound credentials)** | 🔒 **Next security milestone** | "That's the cryptographic upgrade that binds a credential to a keypair rather than a secret hash — tighter, but more complex. It's the next security milestone after this one." |

---

## Recovery lines — three most likely on-stage failures

### 1. Network timeout during `demo-send.js`

The script hangs after "Step 2 · Lodge transfer" and produces no output for 10+ seconds.

**Recovery:** Hit Ctrl+C. Then:
```bash
node scripts/demo-send.js
```
Run it again — idempotent, a new credential and UUID are issued each time. While it runs, say: *"The interesting thing about a hung network call in this context is that no file has left the machine yet — encryption happens first, locally, before the first byte is transmitted."*

### 2. Credentials not set in the demo environment

Terminal prints: `✗ REFUELER_LIVE_KEY not set or does not start with rfs_live_`

**Recovery:** Do not fumble with env vars on stage. Say: *"I'll take us straight to the code — let me show you the quote tool directly,"* then pivot to the quote-only inline command using hardcoded `rfs_test_` credentials:
```bash
# This uses sandbox credentials — real Worker, no live billing
REFUELER_LIVE_KEY=rfs_test_demo REFUELER_SIGN_KEY=rfs_test_sign node scripts/demo-send.js
```
The script will exit with `auth_failed` — which is itself a valid demo of the auth gate.

### 3. `node --test` shows failures in pre-flight

One or more tests in the suite are failing. Do not go on stage.

**Recovery if discovered during intro:** pause the technical demo entirely and present the architecture diagram instead. Say: *"I'm going to show you the design first and circle back to the live demo — there's a dependency I want to confirm before we run it."* Use the time to fix the failing test in a second terminal. If you cannot fix it in 5 minutes, cancel the live demo and present screenshots.

---

## Notes for the agent-assisted demo (if showing Claude integration)

When Claude drives the tools rather than the raw script, the conversation should follow this shape:

1. **User:** *"Quote a transfer for a 500-byte file on the identity rail."*
   Claude calls `refueler_quote`. Narrates cost in credits and reference GBP.

2. **User:** *"Send scripts/demo-payload.txt with a 24-hour expiry."*
   Claude calls `refueler_send_file`. Narrates the share URL, cost, expiry.

3. **User:** *"Has the recipient collected it yet?"*
   Claude calls `refueler_check_transfer`. Narrates state as `uploaded` — no collection receipt yet, which is expected.

**Important:** Claude should never narrate raw JSON to the prospect. The tool handlers return structured text strings, not dumps. If Claude does echo raw JSON, say: *"In a production integration the agent would format that for the user — we're seeing the raw tool response here."*

---

*"Nothing stops this train."*
