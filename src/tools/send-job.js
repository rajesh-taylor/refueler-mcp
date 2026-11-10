/**
 * src/tools/send-job.js — refueler_send_file on the job runner (MCP-Install-1)
 *
 * The send itself is handleSendFile in send.js, unchanged in what it returns.
 * This wraps it: the call waits FOREGROUND_MS, then hands back a job_id for
 * refueler_send_status, so a send longer than the client's time limit still ends
 * with its result. Until MCP-Trust-1 that result carries share_url, as before.
 */

import path from 'node:path';
import { JobStop } from '../jobs.js';
import { FetchStop, envelope } from '../fetch/stop.js';
import { handleSendFile } from './send.js';

/** How long a call waits before handing back a job handle; under every measured limit. */
const FOREGROUND_MS = 25_000;

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

/** handleSendJob(input, deps) → MCP tool result. deps: handleSendFile's, plus jobs. */
export async function handleSendJob(input, deps) {
  const { jobs, foregroundMs = FOREGROUND_MS, send = handleSendFile, ...sendDeps } = deps;
  const filePath = input?.file_path;
  try {
    const job = jobs.start({
      kind: 'send',
      key: typeof filePath === 'string' ? path.resolve(filePath) : '',
      work: async (j) => {
        const out = await send(input, {
          ...sendDeps,
          signal: j.controller.signal,
          onProgress: (done, total) => { j.parts_done = done; j.parts_total = total; },
        });
        const value = JSON.parse(out[0].text);
        if (value.error) throw new JobStop(value);
        return { state: 'complete', ...value };
      },
    });
    return toolResult(await jobs.waitFor(job, foregroundMs));
  } catch (e) {
    return toolResult(e instanceof FetchStop
      ? envelope(e)
      : { error: 'send_failed', detail: 'The send stopped on this machine.' });
  }
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
