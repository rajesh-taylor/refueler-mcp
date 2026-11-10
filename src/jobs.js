/**
 * src/jobs.js — background jobs for work that outlasts a tool call
 *
 * MCP clients cut a tool call off at a time limit of their own (MCP-Install-1
 * measured each), so a large fetch or send can't be one blocking call. The call
 * waits a short while, then hands back a job_id for the matching _status tool.
 * Jobs and the keys they hold live in memory only and end with the process.
 *
 * Born at MCP-Fetch-1 for fetch; MCP-Install-1 made the limits and the fixed
 * texts per kind, so send runs on the same runner.
 */

import { randomUUID } from 'node:crypto';
import { FetchStop, envelope as fetchEnvelope } from './fetch/stop.js';

/**
 * A thrown JobStop carries its envelope as is. Every field in it must already be
 * safe to show the model.
 */
export class JobStop extends Error {
  constructor(result) {
    super(result?.error ?? 'job_failed');
    this.name = 'JobStop';
    this.result = result;
  }
}

/** Fixed texts and the failure envelope for each kind of job. */
const KINDS = {
  fetch: {
    same: ['already_fetching', 'This transfer is already being fetched.'],
    busy: 'Too many fetches are running. Try again when one has finished.',
    envelope: fetchEnvelope,
  },
  send: {
    same: ['already_sending', 'This file is already being sent.'],
    busy: 'Too many sends are running. Try again when one has finished.',
    envelope: (e) => (e instanceof JobStop
      ? e.result
      : { error: 'send_failed', detail: 'The send stopped on this machine.' }),
  },
};

export function createJobRunner({ maxRunning = 2, keepFinished = 32 } = {}) {
  const jobs = new Map();

  const running = (kind) => [...jobs.values()].filter(j => j.state === 'running' && j.kind === kind);

  function prune() {
    const finished = [...jobs.values()].filter(j => j.state !== 'running');
    for (const job of finished.slice(0, Math.max(0, finished.length - keepFinished))) jobs.delete(job.id);
  }

  /**
   * start({ kind, key, partsTotal, note, work }) → job. Synchronous up to the first
   * await in `work`, so two calls for one key can't both pass the check.
   * @param {'fetch'|'send'} [kind='fetch'] — each kind has its own maxRunning
   * @param {string}   key  — one job per key and kind (transfer ID, or file path)
   * @param {Function} work — async (job) → result object
   */
  function start({ kind = 'fetch', key, partsTotal = null, note, work }) {
    const k = KINDS[kind];
    if (!k) throw new Error(`Unknown job kind: ${kind}`);
    const same = running(kind).find(j => j.key === key);
    if (same) throw new FetchStop(k.same[0], k.same[1], { job_id: same.id });
    if (running(kind).length >= maxRunning) throw new FetchStop('busy', k.busy);

    const job = {
      id: randomUUID(),
      kind,
      key,
      state: 'running',
      parts_done: 0,
      parts_total: partsTotal,
      note,
      result: null,
      failure: null,
      controller: new AbortController(),
    };
    jobs.set(job.id, job);

    job.done = (async () => {
      try {
        job.result = await work(job);
        job.state = 'complete';
      } catch (e) {
        job.failure = k.envelope(e);
        job.state = 'failed';
      } finally {
        prune();
      }
    })();
    return job;
  }

  function view(job) {
    if (job.state === 'complete') return job.result;
    if (job.state === 'failed') return { ...job.failure, job_id: job.id };
    return {
      state: 'running',
      job_id: job.id,
      parts_done: job.parts_done,
      parts_total: job.parts_total,
      ...(job.note ? { note: job.note } : {}),
    };
  }

  /** Resolves when the job ends or after ms, whichever is first. */
  async function waitFor(job, ms) {
    let timer;
    await Promise.race([job.done, new Promise(r => { timer = setTimeout(r, ms); })]);
    clearTimeout(timer);
    return view(job);
  }

  async function abortAll() {
    const active = [...jobs.values()].filter(j => j.state === 'running');
    for (const job of active) job.controller.abort();
    await Promise.allSettled(active.map(j => j.done));
  }

  /** A job of the given kind, or undefined: one kind's status tool can't read another's. */
  function get(id, kind) {
    const job = jobs.get(id);
    return job && (kind === undefined || job.kind === kind) ? job : undefined;
  }

  return { start, view, waitFor, abortAll, get };
}
