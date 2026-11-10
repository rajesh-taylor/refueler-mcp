/**
 * src/confirm.js — the user's yes before a send (MCP-Trust-1)
 *
 * A send spends credits and puts a file beyond this machine, so nothing starts
 * without the user's own say (decision C, 10 Nov 2026):
 *
 *   - A dialog, where the client offers one (MCP-Install-1: Cursor and Copilot).
 *     Turned down, cancelled or unanswered, the send stops. It never falls back
 *     to the code below, which the model could supply.
 *   - Otherwise a one-time code. The first call answers `confirm_send` with what
 *     will happen and a `confirm_id`; the agent asks the user; only on a yes does
 *     it call again with `accept_send` set to that id. The code is bound to the
 *     file (real path, size, modified time) and the send options, works once,
 *     and lasts ten minutes. A plain boolean could be set on the first call.
 *
 * The operator may turn this off with REFUELER_CONFIRM_SEND=0 (CI, agent-to-agent).
 * Nothing secret goes in a dialog: file name, size, cost and expiry only.
 */

import { createHash, randomBytes } from 'node:crypto';
import { FetchStop } from './fetch/stop.js';

const CONFIRM_MS = 10 * 60_000;
const MAX_PENDING = 32;

/** How long a dialog may wait; under Cursor's 120 s limit (plan §9). */
export const DIALOG_MS = 100_000;

/** One store per server process. */
export function createConfirmations({ now = Date.now } = {}) {
  const pending = new Map();

  function prune() {
    const t = now();
    for (const [id, p] of pending) if (p.expires <= t) pending.delete(id);
    while (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value);
  }

  return {
    issue(binding) {
      prune();
      const id = randomBytes(12).toString('base64url');
      pending.set(id, { binding, expires: now() + CONFIRM_MS });
      return id;
    },
    /** True once, for a live id issued for this exact binding. Any use spends it. */
    take(id, binding) {
      if (typeof id !== 'string') return false;
      const p = pending.get(id);
      if (!p) return false;
      pending.delete(id);
      return p.expires > now() && p.binding === binding;
    },
  };
}

/** The send as the user agreed to it. A password is bound by its hash, held in memory only. */
export function bindingFor(file, input, password) {
  const h = createHash('sha256');
  h.update(JSON.stringify([
    file.path, file.size, file.mtimeMs,
    input.destroy_after_download === true,
    input.available_from ?? null,
    input.available_until ?? null,
    input.transfer_ref ?? null,
    password ? createHash('sha256').update(password).digest('hex') : null,
  ]));
  return h.digest('hex');
}

/** A file name fit to show: no control characters, at most 120 characters. */
export function shownName(name) {
  // eslint-disable-next-line no-control-regex
  const clean = name.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, '');
  return clean.length > 120 ? `${clean.slice(0, 117)}…` : clean;
}

function sizeText(bytes) {
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes, i = 0;
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i++; }
  return i === 0 ? `${bytes} bytes` : `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

function whatHappens(s) {
  return `Send "${s.name}" (${sizeText(s.size_bytes)}) with Refueler Share. ` +
    `Cost: ${s.cost_credits} credits. The link expires in ${s.expires_in_days} days` +
    (s.destroy_after_download ? ' and works once' : '') +
    (s.has_password ? '; it has a password' : '') + '.';
}

/**
 * confirmSend({ summary, binding, acceptSend, elicit, confirmations }) → resolves on a yes.
 * Throws FetchStop `confirm_send` (ask the user) or `send_declined`.
 *
 * @param {Function} elicit — async (params) → { action, content }, or null when the
 *                            client offers no dialog
 */
export async function confirmSend({ summary, binding, acceptSend, elicit, confirmations }) {
  const message = whatHappens(summary);

  let answer = null;
  let offered = false;
  try {
    answer = await elicit({
      message: `${message}\n\nSend this file?`,
      requestedSchema: {
        type: 'object',
        properties: { send: { type: 'boolean', title: 'Send this file', default: true } },
      },
    });
    offered = answer !== null;
  } catch {
    // The client offered a dialog and it failed or timed out: that is not a yes.
    offered = true;
    answer = null;
  }

  if (offered) {
    if (answer?.action === 'accept' && answer.content?.send !== false) return;
    throw new FetchStop('send_declined',
      'The user did not say yes in the dialog, so nothing was sent. Ask the user before trying again.');
  }

  if (acceptSend !== undefined && confirmations.take(acceptSend, binding)) return;

  const stale = acceptSend !== undefined
    ? 'That confirmation no longer matches: it was used, expired, or the file or options changed. '
    : '';
  throw new FetchStop('confirm_send',
    `${stale}Ask the user first: ${message} Only if they say yes, call refueler_send_file again ` +
    'with the same inputs and accept_send set to this confirm_id.',
    { ...summary, confirm_id: confirmations.issue(binding) });
}
