/**
 * src/tools/send-job.js — refueler_send_file: the tool boundary
 *
 * MCP-Install-1 put the send on the job runner: the call waits FOREGROUND_MS,
 * then hands back a job_id for refueler_send_status.
 *
 * MCP-Trust-1 (plan §5) made this file the place where a send is checked before
 * anything is spent, and where its link is kept out of the model:
 *
 *   1. file_path inside the allowed folders (fetch/folders.js), real path first;
 *      never a file inside the link folder.
 *   2. A password only from password_file, never as tool input.
 *   3. The user's yes (confirm.js): a dialog where the client has one, else a
 *      one-time code. Off only with the operator's REFUELER_CONFIRM_SEND=0.
 *   4. The send itself (send.js), unchanged; it returns share_url to us.
 *   5. The link to <uuid>.link and the password to <uuid>.password in the link
 *      folder (links.js). The result names those files. share_url is in it only
 *      when the operator has set REFUELER_LINK_IN_CHAT=1.
 *
 * Every refusal is fixed text. Neither the link, the key nor the password is in
 * any result, error or log by default.
 */

import { JobStop } from '../jobs.js';
import { FetchStop, envelope } from '../fetch/stop.js';
import { UUID_RE } from '../fetch/link.js';
import { allowedRoots, fileInside, readPasswordFile } from '../fetch/folders.js';
import { ensureLinkDir, writeSecretFile, WINDOWS_NOTE } from '../links.js';
import { bindingFor, confirmSend, createConfirmations, shownName } from '../confirm.js';
import { costCredits } from '../rate-card.js';
import { ENFORCED_EXPIRY_SECS, handleSendFile } from './send.js';
import path from 'node:path';

/** How long a call waits before handing back a job handle; under every measured limit. */
const FOREGROUND_MS = 25_000;

const OPTION_KEYS = ['recipient_hint', 'destroy_after_download', 'available_from', 'available_until', 'transfer_ref'];

/** Tool definition. accept_send is offered only while confirmation is on. */
export function sendToolDefinition(config = {}) {
  const properties = {
    file_path: {
      type: 'string',
      description: 'Path to the file to send. It must be inside the folders this server may use.',
    },
    password_file: {
      type: 'string',
      description:
        'Optional. Path to a local file holding a password for the link (one line, at least 8 characters). ' +
        'The recipient types it in a browser. It stays out of the conversation.',
    },
    recipient_hint: {
      type: 'string',
      description: 'Agent-side prose only (e.g. "Alice at Acme"). Never sent to the Worker or logged anywhere.',
    },
    destroy_after_download: {
      type: 'boolean',
      description: 'If true, the transfer is deleted the moment it is collected.',
    },
    available_from: {
      type: 'integer',
      description: 'Unix timestamp (seconds) — unavailable before this time. Paid tiers only.',
    },
    available_until: {
      type: 'integer',
      description: 'Unix timestamp (seconds) — unavailable after this time. Paid tiers only.',
    },
    transfer_ref: {
      type: 'string',
      maxLength: 128,
      description:
        'Chartered-tier attribution reference (≤128 chars). Never stored in the manifest or shown to the recipient.',
    },
  };
  if (config.confirmSend !== false) {
    properties.accept_send = {
      type: 'string',
      description: 'The confirm_id from a confirm_send answer. Pass it only after the user has said yes to that send.',
    };
  }

  const link = config.linkInChat
    ? 'The result also carries share_url: the operator has allowed the link in the conversation, so the model provider receives the key. '
    : 'The result gives the file paths, never the link: the link carries the key. ';
  const confirm = config.confirmSend !== false
    ? 'The user confirms each send: in a dialog where the client has one; otherwise the answer is confirm_send, ' +
      'and you ask the user and call again with accept_send only if they say yes. '
    : '';

  return {
    name: 'refueler_send_file',
    description:
      'Encrypt a local file on this machine and lodge it on Refueler Share. Cost comes from your credit pool. ' +
      'The link, and any password, are written to owner-only files in this server\'s link folder. ' +
      link + confirm +
      'A long send returns state "running" and a job_id for refueler_send_status; do not send again.',
    inputSchema: { type: 'object', properties, required: ['file_path'] },
  };
}

export const sendStatusToolDefinition = {
  name: 'refueler_send_status',
  description: 'Report on a send that returned state "running". Jobs end when this server stops.',
  inputSchema: {
    type: 'object',
    properties: { job_id: { type: 'string', description: 'The job_id from refueler_send_file.' } },
    required: ['job_id'],
  },
};

function toolResult(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    ...(value.error ? { isError: true } : {}),
  };
}

/** A store for the whole process; index.js passes it, tests make their own. */
const defaultConfirmations = createConfirmations();

/**
 * handleSendJob(input, deps) → MCP tool result
 *
 * @param {object}   deps.jobs          — from createJobRunner()
 * @param {object}   deps.config        — loadConfig(): rootEnv, linkDir, linkInChat, confirmSend
 * @param {Function} [deps.clientRoots] — async () → file: URIs, or null
 * @param {Function} [deps.elicit]      — async (params) → { action, content }, or null if no dialog
 * @param {object}   [deps.confirmations]
 * @param {string}   [deps.cwd]
 * @param {Function} [deps.send]        — the send itself (tests)
 * @param {string}   [deps.platform]    — process.platform (tests)
 * Everything else goes on to handleSendFile (api, issueCredential, putPart, …).
 */
export async function handleSendJob(input, deps) {
  const {
    jobs, config = {}, clientRoots = async () => null, elicit = async () => null,
    confirmations = defaultConfirmations, cwd, platform = process.platform,
    foregroundMs = FOREGROUND_MS, send = handleSendFile, ...sendDeps
  } = deps;

  try {
    const args = input ?? {};
    if (args.passphrase !== undefined) {
      throw new FetchStop('password_in_input',
        'Passwords are not taken as tool input. Save the password to a local file and pass password_file.');
    }
    if (args.permanent_record) {
      throw new FetchStop('not_supported',
        'A permanent record cannot be created from this server yet. Send without permanent_record, or use share.refueler.io.');
    }

    const roots = await allowedRoots({ clientRoots: await clientRoots(), rootEnv: config.rootEnv, cwd });
    const linkDir = await ensureLinkDir(config.linkDir, { platform });
    const file = await fileInside(args.file_path, roots, { notIn: [linkDir] });
    if (file.size < 1) throw new FetchStop('file_empty', 'The file is empty: there is nothing to send.');

    const password = args.password_file !== undefined
      ? await readPasswordFile(args.password_file, [...roots, linkDir])
      : null;

    if (config.confirmSend !== false) {
      await confirmSend({
        summary: {
          name: shownName(path.basename(file.path)),
          size_bytes: file.size,
          cost_credits: costCredits({ sizeBytes: file.size }).total,
          expires_in_days: Math.round(ENFORCED_EXPIRY_SECS / 86_400),
          destroy_after_download: args.destroy_after_download === true,
          has_password: Boolean(password),
        },
        binding: bindingFor(file, args, password),
        acceptSend: args.accept_send,
        elicit,
        confirmations,
      });
    }

    const sendInput = { file_path: file.path };
    for (const k of OPTION_KEYS) if (args[k] !== undefined) sendInput[k] = args[k];
    if (password) sendInput.passphrase = password;

    const job = jobs.start({
      kind: 'send',
      key: file.path,
      work: async (j) => {
        const out = await send(sendInput, {
          ...sendDeps,
          config,
          signal: j.controller.signal,
          onProgress: (done, total) => { j.parts_done = done; j.parts_total = total; },
        });
        const value = JSON.parse(out[0].text);
        if (value.error) throw new JobStop(value);
        return keepLink(value, { linkDir, password, config, platform });
      },
    });
    return toolResult(await jobs.waitFor(job, foregroundMs));
  } catch (e) {
    return toolResult(e instanceof FetchStop
      ? envelope(e)
      : { error: 'send_failed', detail: 'The send stopped on this machine.' });
  }
}

/**
 * The finished send's result, with the link moved to a file. Password first, so a
 * failure leaves no link file without its password.
 */
async function keepLink(value, { linkDir, password, config, platform }) {
  const { share_url: shareUrl, passphrase_required: _drop, ...rest } = value; // eslint-disable-line no-unused-vars
  const { uuid } = rest;
  const inChat = config.linkInChat ? { share_url: shareUrl } : {};

  if (typeof uuid !== 'string' || !UUID_RE.test(uuid) || typeof shareUrl !== 'string') {
    throw new JobStop({
      error: 'link_not_saved',
      detail: 'The send finished, but the Worker\'s answer was not as expected, so no link was saved.',
      ...inChat,
    });
  }

  let passwordFile = null;
  let linkFile;
  try {
    if (password) passwordFile = await writeSecretFile(linkDir, `${uuid}.password`, `${password}\n`);
    linkFile = await writeSecretFile(linkDir, `${uuid}.link`, `${shareUrl}\n`);
  } catch {
    throw new JobStop({
      error: 'link_not_saved',
      detail: 'The file was sent, but its link could not be saved in the link folder, and it is never shown here. ' +
        'Nobody can open this transfer without the link; it expires on its own. Send the file again.',
      uuid,
      ...(passwordFile ? { password_file: passwordFile } : {}),
      ...inChat,
    });
  }

  return {
    state: 'complete',
    ...rest,
    link_file: linkFile,
    ...(passwordFile ? { password_file: passwordFile } : {}),
    password_required: Boolean(password),
    ...inChat,
    ...(platform === 'win32' ? { note: WINDOWS_NOTE } : {}),
  };
}

/** handleSendStatus(input, deps) → MCP tool result */
export function handleSendStatus(input, { jobs }) {
  const job = typeof input?.job_id === 'string' ? jobs.get(input.job_id, 'send') : undefined;
  if (!job) {
    return toolResult({
      error: 'unknown_job',
      detail: 'No such job. Jobs end when this server stops; if it restarted, check the transfer before sending again.',
    });
  }
  return toolResult(jobs.view(job));
}
