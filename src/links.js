/**
 * src/links.js — the link folder (MCP-Trust-1)
 *
 * A send's link holds the transfer key, so by default it never enters a tool
 * result: it goes to `<uuid>.link`, and any password to `<uuid>.password`, in
 * REFUELER_LINK_DIR (default ~/.refueler/links). The folder is 0700 and each
 * file 0600, created new, never through a symlink. Built to the MCP lane plan §5.
 *
 * What this does and does not do: it puts a key on disk, readable by this user.
 * An agent whose other tools may read that folder can still read it. It closes
 * the default path to the model provider, not a determined agent.
 *
 * Windows has no 0600; files there rely on the user folder's own permissions,
 * and the send result says so (MCP-Trust-1, decision F).
 */

import { constants as fsc } from 'node:fs';
import { chmod, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FetchStop } from './fetch/stop.js';

export const DEFAULT_LINK_DIR = path.join(os.homedir(), '.refueler', 'links');

export const WINDOWS_NOTE =
  'On Windows the link files are protected only by the permissions of your user folder.';

const unusable = () => new FetchStop('link_folder_unusable',
  'The link folder (REFUELER_LINK_DIR) is missing, shared with other users, or not a plain folder, ' +
  'and could not be made private. Nothing was sent.');

/**
 * ensureLinkDir(dir) → the folder's real path, private to this user.
 * Creates it 0700 if missing; tightens an existing one this user owns.
 */
export async function ensureLinkDir(dir, { platform = process.platform } = {}) {
  try { await mkdir(dir, { recursive: true, mode: 0o700 }); } catch { throw unusable(); }

  let info;
  try { info = await lstat(dir); } catch { throw unusable(); }
  if (!info.isDirectory() || info.isSymbolicLink()) throw unusable();

  if (platform !== 'win32') {
    if (typeof process.getuid === 'function' && info.uid !== process.getuid()) throw unusable();
    if ((info.mode & 0o077) !== 0) {
      try { await chmod(dir, 0o700); } catch { throw unusable(); }
    }
  }
  try { return await realpath(dir); } catch { throw unusable(); }
}

/** The real path of the link folder if it exists, else null. Never creates it. */
export async function linkDirIfPresent(dir) {
  if (!dir) return null;
  try { return await realpath(dir); } catch { return null; }
}

/**
 * writeSecretFile(dir, name, text) → full path.
 * Exclusive create, mode 0600, no symlink followed. A half-written file is removed.
 */
export async function writeSecretFile(dir, name, text) {
  if (name !== path.basename(name) || name.startsWith('.')) throw new Error('bad secret file name');
  const file = path.join(dir, name);
  const flags = fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | (fsc.O_NOFOLLOW ?? 0);
  const fh = await open(file, flags, 0o600);
  try {
    await fh.writeFile(text);
    await fh.sync();
  } catch (e) {
    await fh.close().catch(() => {});
    await unlink(file).catch(() => {});
    throw e;
  }
  await fh.close();
  return file;
}
