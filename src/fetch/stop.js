/**
 * src/fetch/stop.js — the only way a fetch reports a failure (MCP-Fetch-1)
 *
 * Every message is fixed text written here. A caught error's own message is
 * never passed on: JSON.parse quotes its input, and the input can be the link.
 */

export class FetchStop extends Error {
  /**
   * @param {string} code    — machine-readable reason
   * @param {string} detail  — fixed sentence for the agent; never carries link text
   * @param {object} [extra] — safe fields only (uuid, job_id, byte counts)
   */
  constructor(code, detail, extra = {}) {
    super(code);
    this.name = 'FetchStop';
    this.code = code;
    this.detail = detail;
    this.extra = extra;
  }
}

/** Any thrown value → the tool's error envelope. Unknown errors say nothing specific. */
export function envelope(e) {
  if (e instanceof FetchStop) return { error: e.code, detail: e.detail, ...e.extra };
  return { error: 'fetch_failed', detail: 'The fetch stopped on this machine. Nothing was saved.' };
}

export const OPEN_IN_BROWSER =
  'This link needs a browser. Open it at share.refueler.io.';
