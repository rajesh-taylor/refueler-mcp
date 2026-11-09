/**
 * src/fetch/disk.js — will this file fit, and can this drive hold it? (MCP-Fetch-1)
 *
 * Download spec §7: free space first; refuse FAT32 above 4 GiB and NTFS on macOS
 * (read-only there). If the file system can't be named the fetch goes ahead and
 * a write failure reports it.
 */

import { execFile } from 'node:child_process';
import { statfs } from 'node:fs/promises';
import { promisify } from 'node:util';
import { FetchStop } from './stop.js';

const run = promisify(execFile);

const FOUR_GIB = 4 * 1024 ** 3;

/** Linux statfs f_type values for the file systems we care about. */
const LINUX_MAGIC = new Map([
  [0x4d44, 'msdos'],
  [0x2011bab0, 'exfat'],
  [0x5346544e, 'ntfs'],
  [0x7366746e, 'ntfs'],
]);

/** macOS assigns statfs types at load, and Node doesn't expose the name. mount does. */
export function nameFromMountOutput(output, dir) {
  let best = null;
  for (const line of output.split('\n')) {
    const m = /^.+? on (.+) \(([^,)]+)/.exec(line);
    if (!m) continue;
    const [, mountPoint, fsName] = m;
    const prefix = mountPoint.endsWith('/') ? mountPoint : `${mountPoint}/`;
    const matches = dir === mountPoint || dir.startsWith(prefix);
    if (matches && (!best || mountPoint.length > best.mountPoint.length)) best = { mountPoint, fsName };
  }
  return best?.fsName ?? null;
}

async function macMountOutput() {
  const { stdout } = await run('/sbin/mount', [], { timeout: 5000 });
  return stdout;
}

async function filesystemName(dir, info, { platform, mountOutput }) {
  try {
    if (platform === 'darwin') return nameFromMountOutput(await mountOutput(), dir);
    if (platform === 'linux') return LINUX_MAGIC.get(Number(info.type)) ?? null;
  } catch { /* unnamed: the fetch goes ahead */ }
  return null;
}

/** Stops when the file can't fit or the drive can't hold it. */
export async function checkDisk(dir, sizeBytes, {
  statfsImpl = statfs,
  platform = process.platform,
  mountOutput = macMountOutput,
} = {}) {
  let info;
  try {
    info = await statfsImpl(dir);
  } catch {
    return; // no reading on this platform: a write failure reports it
  }

  const free = Number(info.bavail) * Number(info.bsize);
  if (free < sizeBytes) {
    throw new FetchStop('no_space', 'There is not enough free space on that drive.',
      { size_bytes: sizeBytes, free_bytes: free });
  }

  const name = await filesystemName(dir, info, { platform, mountOutput });
  if (name === 'msdos' && sizeBytes >= FOUR_GIB) {
    throw new FetchStop('drive_cannot_hold_file',
      'That drive is FAT32, which cannot hold a file of 4 GiB or more. Choose another drive.',
      { size_bytes: sizeBytes });
  }
  if (name === 'ntfs' && platform === 'darwin') {
    throw new FetchStop('drive_read_only',
      'That drive is NTFS, which macOS can only read. Choose another drive.');
  }
}
