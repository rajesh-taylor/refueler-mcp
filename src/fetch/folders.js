/**
 * src/fetch/folders.js — which folders a fetch may touch (MCP-Fetch-1)
 *
 * Plan §5, as changed at MCP-Trust-1 (decision B): the client's roots and
 * REFUELER_ROOT together; with neither, the start folder, unless that is home or
 * the file-system root, where it refuses. REFUELER_ROOT adds to the client's
 * roots because some clients fix their list at start (Claude desktop), so a
 * refusal that says "set REFUELER_ROOT" must be advice that works. An empty
 * roots list counts as none. Symlinks are resolved before every check.
 *
 * Applies to send (file_path, password_file) and fetch (out_dir, link_file).
 * The link folder is allowed as well for link_file and password_file only.
 */

import { constants as fsc } from 'node:fs';
import { lstat, open, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FetchStop } from './stop.js';
import { MAX_LINK_BYTES } from './link.js';

export const MAX_PASSWORD_FILE_BYTES = 1024;

const noFolder = () => new FetchStop('no_folder_allowed',
  'No folder is open to this server. Start it in a project folder, or have the operator set REFUELER_ROOT.');

const outside = (what) => new FetchStop('outside_allowed_folders',
  `${what} is outside the folders this server may use. To allow a folder, set REFUELER_ROOT ` +
  'to it in this server\'s settings and restart the server.');

const badLinkFile = () => new FetchStop('link_file_unreadable',
  'link_file must be a regular file, not a symlink, of at most 16 KiB.');

async function real(p) {
  try { return await realpath(p); } catch { return null; }
}

function fromUris(uris) {
  const paths = [];
  for (const uri of uris) {
    try { paths.push(fileURLToPath(uri)); } catch { /* not a file: root */ }
  }
  return paths;
}

/**
 * allowedRoots({ clientRoots, rootEnv, cwd }) → real folder paths, never empty.
 * @param {string[]|null} clientRoots — file: URIs from roots/list, null if none
 */
export async function allowedRoots({ clientRoots, rootEnv, cwd = process.cwd() }) {
  const roots = [];
  if (clientRoots?.length) {
    roots.push(...(await Promise.all(fromUris(clientRoots).map(real))).filter(Boolean));
  }

  if (rootEnv) {
    const root = await real(rootEnv);
    if (root) roots.push(root);
    else if (!roots.length) throw noFolder();
  }

  if (roots.length) return [...new Set(roots)];

  const start = await real(cwd);
  const home = await real(os.homedir());
  if (!start || start === home || path.parse(start).root === start) throw noFolder();
  return [start];
}

export function isInside(candidate, root) {
  const rel = path.relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** The real path of an existing folder inside the roots, and not inside any of `notIn`. */
export async function folderInside(dir, roots, { notIn = [] } = {}) {
  const resolved = await real(path.resolve(dir));
  if (!resolved) {
    throw new FetchStop('out_dir_missing', 'out_dir does not exist. Create the folder first.');
  }
  if (!roots.some(root => isInside(resolved, root))) throw outside('out_dir');
  if (notIn.some(d => isInside(resolved, d))) {
    throw new FetchStop('out_dir_is_link_folder', 'out_dir cannot be the link folder. Choose another folder.');
  }
  const info = await stat(resolved);
  if (!info.isDirectory()) throw new FetchStop('out_dir_missing', 'out_dir is not a folder.');
  return resolved;
}

/**
 * fileInside(file, roots, { notIn }) → { path, size, mtimeMs } for a file to send.
 * The real path is checked, so a symlink inside the folders that points out is refused.
 */
export async function fileInside(file, roots, { what = 'file_path', notIn = [] } = {}) {
  if (typeof file !== 'string' || file.length === 0) throw new FetchStop('bad_input', `${what} is required.`);
  const resolved = await real(path.resolve(file));
  if (!resolved) throw new FetchStop('file_missing', `${what} does not exist or cannot be read.`);
  if (!roots.some(root => isInside(resolved, root))) throw outside(what);
  if (notIn.some(d => isInside(resolved, d))) {
    throw new FetchStop('file_in_link_folder',
      'Files in the link folder are never sent: they hold transfer keys and passwords.');
  }
  let info;
  try { info = await stat(resolved); } catch { throw new FetchStop('file_missing', `${what} does not exist or cannot be read.`); }
  if (!info.isFile()) throw new FetchStop('not_a_file', `${what} is not a regular file.`);
  return { path: resolved, size: info.size, mtimeMs: info.mtimeMs };
}

/**
 * readSmallFile(file, roots, { max, bad, what }) → the file's text.
 * Regular file, no symlink, at most `max` bytes. The contents never reach an error.
 */
async function readSmallFile(file, roots, { max, bad, what }) {
  if (typeof file !== 'string' || file.length === 0) throw bad();
  const resolved = path.resolve(file);

  let info;
  try { info = await lstat(resolved); } catch { throw bad(); }
  if (!info.isFile() || info.isSymbolicLink()) throw bad();

  const realFile = await real(resolved);
  if (!realFile) throw bad();
  if (!roots.some(root => isInside(realFile, root))) throw outside(what);

  // lstat then open can race; O_NOFOLLOW and fstat close that where the platform has them.
  const flags = fsc.O_RDONLY | (fsc.O_NOFOLLOW ?? 0) | (fsc.O_NONBLOCK ?? 0);
  let fh;
  try {
    fh = await open(resolved, flags);
    const opened = await fh.stat();
    if (!opened.isFile() || opened.size > max) throw bad();
    const buf = Buffer.alloc(max + 1);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    if (bytesRead > max) throw bad();
    return buf.subarray(0, bytesRead).toString('utf8');
  } catch (e) {
    if (e instanceof FetchStop) throw e;
    throw bad();
  } finally {
    await fh?.close().catch(() => {});
  }
}

/** readLinkFile(file, roots) → the link text. At most 16 KiB. */
export function readLinkFile(file, roots) {
  return readSmallFile(file, roots, { max: MAX_LINK_BYTES, bad: badLinkFile, what: 'link_file' });
}

const badPasswordFile = () => new FetchStop('password_file_unreadable',
  'password_file must be a regular file, not a symlink, of at most 1 KiB.');

const weakPassword = () => new FetchStop('password_too_short',
  'The password in password_file must be at least 8 characters, on one line.');

/**
 * readPasswordFile(file, roots) → the password: NFC, trimmed, at least 8 characters,
 * no control characters. Never quoted in an error.
 */
export async function readPasswordFile(file, roots) {
  const text = await readSmallFile(file, roots,
    { max: MAX_PASSWORD_FILE_BYTES, bad: badPasswordFile, what: 'password_file' });
  const password = text.normalize('NFC').trim();
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(password) || [...password].length < 8) throw weakPassword();
  return password;
}
