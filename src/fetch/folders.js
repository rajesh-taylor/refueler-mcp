/**
 * src/fetch/folders.js — which folders a fetch may touch (MCP-Fetch-1)
 *
 * Plan §5: roots/list if the client has it; else REFUELER_ROOT; else the start
 * folder, unless that is home or the file-system root, where it refuses. Symlinks
 * are resolved before every check. MCP-Trust-1 extends this to send.
 */

import { constants as fsc } from 'node:fs';
import { lstat, open, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FetchStop } from './stop.js';
import { MAX_LINK_BYTES } from './link.js';

const noFolder = () => new FetchStop('no_folder_allowed',
  'No folder is open to this server. Start it in a project folder, or have the operator set REFUELER_ROOT.');

const outside = (what) => new FetchStop('outside_allowed_folders',
  `${what} is outside the folders this server may use.`);

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
  if (clientRoots?.length) {
    const roots = (await Promise.all(fromUris(clientRoots).map(real))).filter(Boolean);
    if (roots.length) return roots;
  }

  if (rootEnv) {
    const root = await real(rootEnv);
    if (!root) throw noFolder();
    return [root];
  }

  const start = await real(cwd);
  const home = await real(os.homedir());
  if (!start || start === home || path.parse(start).root === start) throw noFolder();
  return [start];
}

export function isInside(candidate, root) {
  const rel = path.relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** The real path of an existing folder inside the roots. */
export async function folderInside(dir, roots) {
  const resolved = await real(path.resolve(dir));
  if (!resolved) {
    throw new FetchStop('out_dir_missing', 'out_dir does not exist. Create the folder first.');
  }
  if (!roots.some(root => isInside(resolved, root))) throw outside('out_dir');
  const info = await stat(resolved);
  if (!info.isDirectory()) throw new FetchStop('out_dir_missing', 'out_dir is not a folder.');
  return resolved;
}

/**
 * readLinkFile(file, roots) → the link text.
 * Regular file, no symlink, at most 16 KiB. The contents never reach an error.
 */
export async function readLinkFile(file, roots) {
  if (typeof file !== 'string' || file.length === 0) throw badLinkFile();
  const resolved = path.resolve(file);

  let info;
  try { info = await lstat(resolved); } catch { throw badLinkFile(); }
  if (!info.isFile() || info.isSymbolicLink()) throw badLinkFile();

  const realFile = await real(resolved);
  if (!realFile) throw badLinkFile();
  if (!roots.some(root => isInside(realFile, root))) throw outside('link_file');

  // lstat then open can race; O_NOFOLLOW and fstat close that where the platform has them.
  const flags = fsc.O_RDONLY | (fsc.O_NOFOLLOW ?? 0) | (fsc.O_NONBLOCK ?? 0);
  let fh;
  try {
    fh = await open(resolved, flags);
    const opened = await fh.stat();
    if (!opened.isFile() || opened.size > MAX_LINK_BYTES) throw badLinkFile();
    const buf = Buffer.alloc(MAX_LINK_BYTES + 1);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    if (bytesRead > MAX_LINK_BYTES) throw badLinkFile();
    return buf.subarray(0, bytesRead).toString('utf8');
  } catch (e) {
    if (e instanceof FetchStop) throw e;
    throw badLinkFile();
  } finally {
    await fh?.close().catch(() => {});
  }
}
