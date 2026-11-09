/**
 * src/jobs.js — background jobs for work that outlasts a tool call (MCP-Fetch-1)
 *
 * MCP clients default to a 60 s limit, so a large fetch can't be one blocking
 * call. Jobs and the keys they hold live in memory only and end with the process.
 * MCP-Install-1 moves send onto this.
 */

import { randomUUID } from 'node:crypto';
import { FetchStop, envelope } from './fetch/stop.js';

export function createJobRunner({ maxRunning = 2, keepFinished = 32 } = {}) {
  const jobs = new Map();

  const running = () => [...jobs.values()].filter(j => j.state === 'running');

  function prune() {
    const finished = [...jobs.values()].filter(j => j.state !== 'running');
    for (const job of finished.slice(0, Math.max(0, finished.length - keepFinished))) jobs.delete(job.id);
  }

  /**
   * start({ key, partsTotal, note, work }) → job. Synchronous up to the first await
   * in `work`, so two calls for one key can't both pass the check.
   * @param {string}   key  — one job per key (the transfer ID)
   * @param {Function} work — async (job) → result object
   */
  function start({ key, partsTotal, note, work }) {
    const same = running().find(j => j.key === key);
    if (same) {
      throw new FetchStop('already_fetching', 'This transfer is already being fetched.', { job_id: same.id });
    }
    if (running().length >= maxRunning) {
      throw new FetchStop('busy', 'Too many fetches are running. Try again when one has finished.');
    }

    const job = {
      id: randomUUID(),
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
        job.failure = envelope(e);
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
    const active = running();
    for (const job of active) job.controller.abort();
    await Promise.allSettled(active.map(j => j.done));
  }

  return { start, view, waitFor, abortAll, get: id => jobs.get(id) };
}
