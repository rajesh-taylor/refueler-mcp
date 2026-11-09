/**
 * src/fetch/files.js — names and files on the way to disk (MCP-Fetch-1)
 *
 * The name comes from the link, so from the sender: it is untrusted. Files are
 * written as <name>.refueler-part (exclusive create, 0600, never executable) and
 * only take their real name once complete. Nothing existing is ever overwritten.
 */

import { open, rename, unlink, constants as fsConstants } from 'node:fs/promises';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { FetchStop } from './stop.js';

export const PART_SUFFIX = '.refueler-part';

const FALLBACK_NAME = 'refueler-download';
const MAX_SUFFIX_TRIES = 1000;

/** Room kept under 255 bytes for " (999)" and ".refueler-part". */
const MAX_NAME_BYTES = 255 - PART_SUFFIX.length - ' (999)'.length;

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(\.|$)/i;

function splitExt(name) {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
}

/** The longest leading part of `s` within `max` UTF-8 bytes, whole characters only. */
function cutToBytes(s, max) {
  let out = '';
  let used = 0;
  for (const ch of s) {
    const size = Buffer.byteLength(ch);
    if (used + size > max) break;
    out += ch;
    used += size;
  }
  return out;
}

/**
 * cleanName(raw) → a name safe to create in one folder, on any platform.
 *
 * A leading dot becomes "_": a sender must not be able to drop .mcp.json, .npmrc
 * or .env, unseen, into a folder an agent reads as configuration.
 */
export function cleanName(raw) {
  let name = String(raw).split(/[\\/]/).pop();

  // Control characters, and the bidirectional marks that can disguise an extension.
  // eslint-disable-next-line no-control-regex
  name = name.replace(/[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/g, '');
  name = name.replace(/[<>:"|?*]/g, '_');
  name = name.replace(/^\s+/, '').replace(/[\s.]+$/, '');

  if (name === '' || name === '.' || name === '..') return FALLBACK_NAME;
  if (name.startsWith('.')) name = `_${name.slice(1)}`;
  if (WINDOWS_RESERVED.test(name)) name = `_${name}`;

  if (Buffer.byteLength(name) > MAX_NAME_BYTES) {
    const [stem, ext] = splitExt(name);
    const keepExt = Buffer.byteLength(ext) <= 32 ? ext : '';
    name = cutToBytes(stem, MAX_NAME_BYTES - Buffer.byteLength(keepExt)) + keepExt;
    name = name.replace(/[\s.]+$/, '') || FALLBACK_NAME;
  }
  return name;
}

export function withSuffix(name, i) {
  if (i === 0) return name;
  const [stem, ext] = splitExt(name);
  return `${stem} (${i})${ext}`;
}

async function exists(p) {
  try { await access(p, fsConstants.F_OK); return true; } catch { return false; }
}

const diskFailed = () => new FetchStop('disk_write_failed',
  'The file could not be written to that folder. Check the drive and try again. Nothing was saved.');

/** Opens a new part file beside no existing name. → { fh, partPath, start } */
export async function openPartFile(dir, name) {
  for (let i = 0; i < MAX_SUFFIX_TRIES; i++) {
    const candidate = withSuffix(name, i);
    if (await exists(path.join(dir, candidate))) continue;
    const partPath = path.join(dir, candidate + PART_SUFFIX);
    try {
      return { fh: await open(partPath, 'wx', 0o600), partPath, start: i };
    } catch (e) {
      if (e.code === 'EEXIST') continue;
      throw diskFailed();
    }
  }
  throw diskFailed();
}

/** Writes all of `bytes` at `position`; a single write may be short. */
export async function writeAll(fh, bytes, position) {
  let offset = 0;
  try {
    while (offset < bytes.length) {
      const { bytesWritten } = await fh.write(bytes, offset, bytes.length - offset, position + offset);
      offset += bytesWritten;
    }
  } catch {
    throw diskFailed();
  }
}

/**
 * commitFile(partPath, dir, name, start) → final path.
 *
 * rename() replaces whatever is at the target, so the target is first claimed by
 * exclusive create. Works on file systems with no hard links (exFAT, FAT32).
 */
export async function commitFile(partPath, dir, name, start) {
  for (let i = start; i < start + MAX_SUFFIX_TRIES; i++) {
    const finalPath = path.join(dir, withSuffix(name, i));
    let claim;
    try {
      claim = await open(finalPath, 'wx', 0o600);
    } catch (e) {
      if (e.code === 'EEXIST') continue;
      throw diskFailed();
    }
    await claim.close();
    try {
      await rename(partPath, finalPath);
    } catch {
      await unlink(finalPath).catch(() => {});
      throw diskFailed();
    }
    await syncFolder(dir);
    return finalPath;
  }
  throw diskFailed();
}

/** Best effort: some platforms can't open a folder for fsync. */
async function syncFolder(dir) {
  let h;
  try {
    h = await open(dir, 'r');
    await h.sync();
  } catch { /* the rename stands */ } finally {
    await h?.close().catch(() => {});
  }
}
