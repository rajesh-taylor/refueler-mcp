/**
 * test/fetch-files.test.js — names, folders, drives (MCP-Fetch-1)
 * node:test only.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { cleanName, commitFile, openPartFile, withSuffix, writeAll, PART_SUFFIX } from '../src/fetch/files.js';
import { allowedRoots, folderInside, isInside, readLinkFile } from '../src/fetch/folders.js';
import { checkDisk, nameFromMountOutput } from '../src/fetch/disk.js';

describe('cleanName', () => {
  const table = [
    ['report.pdf', 'report.pdf'],
    ['../../etc/passwd', 'passwd'],
    ['..\\..\\windows\\system.ini', 'system.ini'],
    ['/abs/path/file.txt', 'file.txt'],
    ['a/b/', 'refueler-download'],
    ['.', 'refueler-download'],
    ['..', 'refueler-download'],
    ['...', 'refueler-download'],
    ['   ', 'refueler-download'],
    ['\u0000', 'refueler-download'],
    ['re\u0000po\nrt\t.pdf', 'report.pdf'],
    ['a\u007fb\u0085c', 'abc'],
    ['photo‮gnp.exe', 'photognp.exe'],
    ['bad<>:"|?*.txt', 'bad_______.txt'],
    ['trailing.dot.', 'trailing.dot'],
    ['trailing space ', 'trailing space'],
    ['  leading', 'leading'],
    ['.mcp.json', '_mcp.json'],
    ['.env', '_env'],
    ['CON', '_CON'],
    ['con.txt', '_con.txt'],
    ['Lpt9.log', '_Lpt9.log'],
    ['COM¹', '_COM¹'],
    ['console.txt', 'console.txt'],
    ['café 東京.mov', 'café 東京.mov'],
  ];
  for (const [input, expected] of table) {
    test(`${JSON.stringify(input)} → ${JSON.stringify(expected)}`, () => assert.equal(cleanName(input), expected));
  }

  test('long names fit with room for a suffix and the part extension', () => {
    const out = cleanName(`${'a'.repeat(400)}.tar.gz`);
    assert.ok(out.endsWith('.gz'));
    assert.ok(Buffer.byteLength(withSuffix(out, 999) + PART_SUFFIX) <= 255);
  });

  test('a long multi-byte name is cut on a character boundary', () => {
    const out = cleanName(`${'東'.repeat(200)}.mov`);
    assert.ok(!out.includes('�'));
    assert.ok(out.endsWith('.mov'));
    assert.ok(Buffer.byteLength(out + PART_SUFFIX) <= 255);
  });

  test('a very long extension is not kept at the cost of the name', () => {
    const out = cleanName(`a.${'b'.repeat(400)}`);
    assert.ok(Buffer.byteLength(out) <= 255);
    assert.ok(out.length > 0);
  });
});

describe('files on disk', () => {
  let dir;
  before(async () => { dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'rf-files-'))); });
  after(async () => { await rm(dir, { recursive: true, force: true }); });

  test('the part file is 0600 and not executable', { skip: process.platform === 'win32' }, async () => {
    const { fh, partPath } = await openPartFile(dir, 'mode.bin');
    await fh.close();
    assert.equal((await stat(partPath)).mode & 0o777, 0o600);
    await rm(partPath);
  });

  test('an existing file is never overwritten; a number is added', async () => {
    await writeFile(path.join(dir, 'taken.txt'), 'original');
    const { fh, partPath, start } = await openPartFile(dir, 'taken.txt');
    await writeAll(fh, new TextEncoder().encode('new'), 0);
    await fh.close();
    const finalPath = await commitFile(partPath, dir, 'taken.txt', start);
    assert.equal(path.basename(finalPath), 'taken (1).txt');
    assert.equal(await readFile(path.join(dir, 'taken.txt'), 'utf8'), 'original');
    assert.equal(await readFile(finalPath, 'utf8'), 'new');
  });

  test('a file that appears while downloading is not overwritten either', async () => {
    const { fh, partPath, start } = await openPartFile(dir, 'race.txt');
    await writeAll(fh, new TextEncoder().encode('new'), 0);
    await fh.close();
    await writeFile(path.join(dir, 'race.txt'), 'arrived first');
    const finalPath = await commitFile(partPath, dir, 'race.txt', start);
    assert.equal(path.basename(finalPath), 'race (1).txt');
    assert.equal(await readFile(path.join(dir, 'race.txt'), 'utf8'), 'arrived first');
  });

  test('an existing part file is left alone', async () => {
    await writeFile(path.join(dir, `busy.bin${PART_SUFFIX}`), 'someone else');
    const { fh, partPath } = await openPartFile(dir, 'busy.bin');
    await fh.close();
    assert.equal(path.basename(partPath), `busy (1).bin${PART_SUFFIX}`);
    assert.equal(await readFile(path.join(dir, `busy.bin${PART_SUFFIX}`), 'utf8'), 'someone else');
  });

  test('a symlink at the part name is not followed', { skip: process.platform === 'win32' }, async () => {
    const target = path.join(dir, 'target.txt');
    await writeFile(target, 'keep');
    await symlink(target, path.join(dir, `sym.bin${PART_SUFFIX}`));
    const { fh, partPath } = await openPartFile(dir, 'sym.bin');
    await fh.close();
    assert.notEqual(partPath, path.join(dir, `sym.bin${PART_SUFFIX}`));
    assert.equal(await readFile(target, 'utf8'), 'keep');
  });

  test('a bad folder is a disk failure, with no path in it', async () => {
    await assert.rejects(() => openPartFile(path.join(dir, 'no-such-folder'), 'a'), (e) => {
      assert.equal(e.code, 'disk_write_failed');
      assert.ok(!e.detail.includes('no-such-folder'));
      return true;
    });
  });
});

describe('folders', () => {
  let base, inside, other;
  before(async () => {
    base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'rf-roots-')));
    inside = path.join(base, 'root');
    other = path.join(base, 'other');
    await mkdir(inside);
    await mkdir(path.join(inside, 'sub'));
    await mkdir(other);
  });
  after(async () => { await rm(base, { recursive: true, force: true }); });

  test('isInside', () => {
    assert.ok(isInside('/a/b', '/a/b'));
    assert.ok(isInside('/a/b/c', '/a/b'));
    assert.ok(!isInside('/a/bc', '/a/b'));
    assert.ok(!isInside('/a', '/a/b'));
    assert.ok(isInside('/a/b/..c', '/a/b'), 'a name starting with dots is still inside');
  });

  test('client roots come first', async () => {
    const roots = await allowedRoots({ clientRoots: [pathToFileURL(inside).href], rootEnv: other, cwd: other });
    assert.deepEqual(roots, [inside]);
  });

  test('then REFUELER_ROOT', async () => {
    assert.deepEqual(await allowedRoots({ clientRoots: null, rootEnv: other, cwd: inside }), [other]);
    assert.deepEqual(await allowedRoots({ clientRoots: [], rootEnv: other, cwd: inside }), [other]);
  });

  test('a REFUELER_ROOT that does not exist stops; it does not fall through', async () => {
    await assert.rejects(() => allowedRoots({ clientRoots: null, rootEnv: path.join(base, 'nope'), cwd: inside }), { code: 'no_folder_allowed' });
  });

  test('then the start folder', async () => {
    assert.deepEqual(await allowedRoots({ clientRoots: null, rootEnv: null, cwd: inside }), [inside]);
  });

  test('home and / are refused as a start folder', async () => {
    await assert.rejects(() => allowedRoots({ clientRoots: null, rootEnv: null, cwd: os.homedir() }), { code: 'no_folder_allowed' });
    await assert.rejects(() => allowedRoots({ clientRoots: null, rootEnv: null, cwd: '/' }), { code: 'no_folder_allowed' });
  });

  test('out_dir inside passes, returning the real path', async () => {
    assert.equal(await folderInside(path.join(inside, 'sub'), [inside]), path.join(inside, 'sub'));
  });

  test('out_dir outside is refused', async () => {
    await assert.rejects(() => folderInside(other, [inside]), { code: 'outside_allowed_folders' });
    await assert.rejects(() => folderInside(path.join(inside, '..', 'other'), [inside]), { code: 'outside_allowed_folders' });
  });

  test('a symlink out of the root is refused', { skip: process.platform === 'win32' }, async () => {
    await symlink(other, path.join(inside, 'escape'));
    await assert.rejects(() => folderInside(path.join(inside, 'escape'), [inside]), { code: 'outside_allowed_folders' });
  });

  test('a missing out_dir, or a file, is refused', async () => {
    await writeFile(path.join(inside, 'afile'), '');
    await assert.rejects(() => folderInside(path.join(inside, 'nope'), [inside]), { code: 'out_dir_missing' });
    await assert.rejects(() => folderInside(path.join(inside, 'afile'), [inside]), { code: 'out_dir_missing' });
  });

  test('link_file: reads a regular file', async () => {
    const f = path.join(inside, 'ok.link');
    await writeFile(f, 'hello');
    assert.equal(await readLinkFile(f, [inside]), 'hello');
  });

  test('link_file: refuses a symlink', { skip: process.platform === 'win32' }, async () => {
    await writeFile(path.join(inside, 'real.link'), 'hello');
    await symlink(path.join(inside, 'real.link'), path.join(inside, 'sym.link'));
    await assert.rejects(() => readLinkFile(path.join(inside, 'sym.link'), [inside]), { code: 'link_file_unreadable' });
  });

  test('link_file: refuses a folder, a missing file, over 16 KiB', async () => {
    const big = path.join(inside, 'big.link');
    await writeFile(big, 'x'.repeat(16 * 1024 + 1));
    await assert.rejects(() => readLinkFile(inside, [inside]), { code: 'link_file_unreadable' });
    await assert.rejects(() => readLinkFile(path.join(inside, 'nope'), [inside]), { code: 'link_file_unreadable' });
    await assert.rejects(() => readLinkFile(big, [inside]), { code: 'link_file_unreadable' });
  });

  test('link_file: refuses a file outside the roots', async () => {
    const f = path.join(other, 'x.link');
    await writeFile(f, 'hello');
    await assert.rejects(() => readLinkFile(f, [inside]), { code: 'outside_allowed_folders' });
  });
});

describe('checkDisk', () => {
  const GiB = 1024 ** 3;
  const free = (bytes) => async () => ({ bavail: bytes / 4096, bsize: 4096, type: 0 });

  test('not enough free space stops', async () => {
    await assert.rejects(() => checkDisk('/x', 100 * 4096, { statfsImpl: free(99 * 4096), platform: 'linux' }), { code: 'no_space' });
  });

  test('exactly enough passes', async () => {
    await checkDisk('/x', 100 * 4096, { statfsImpl: free(100 * 4096), platform: 'linux' });
  });

  const mount = '/dev/disk3s1 on /System/Volumes/Data (apfs, local, journaled)\n' +
                '/dev/disk4s1 on /Volumes/USB DRIVE (msdos, local, nodev)\n' +
                '/dev/disk5s1 on /Volumes/WIN (ntfs, local, read-only)\n' +
                '/dev/disk1 on / (apfs, sealed)\n';
  const mac = { statfsImpl: free(500 * GiB), platform: 'darwin', mountOutput: async () => mount };

  test('mount output: the longest mount point wins, spaces included', () => {
    assert.equal(nameFromMountOutput(mount, '/Volumes/USB DRIVE/a'), 'msdos');
    assert.equal(nameFromMountOutput(mount, '/Volumes/USB DRIVEX'), 'apfs');
    assert.equal(nameFromMountOutput(mount, '/Users/me'), 'apfs');
  });

  test('FAT32: 4 GiB and over is refused, under is fine', async () => {
    await assert.rejects(() => checkDisk('/Volumes/USB DRIVE/a', 4 * GiB, mac), { code: 'drive_cannot_hold_file' });
    await checkDisk('/Volumes/USB DRIVE/a', 4 * GiB - 1, mac);
  });

  test('NTFS on macOS is refused', async () => {
    await assert.rejects(() => checkDisk('/Volumes/WIN/a', 1, mac), { code: 'drive_read_only' });
  });

  test('Linux FAT by statfs type; Linux NTFS is writable', async () => {
    const fat = async () => ({ bavail: 500 * GiB / 4096, bsize: 4096, type: 0x4d44 });
    const ntfs = async () => ({ bavail: 500 * GiB / 4096, bsize: 4096, type: 0x5346544e });
    await assert.rejects(() => checkDisk('/m', 5 * GiB, { statfsImpl: fat, platform: 'linux' }), { code: 'drive_cannot_hold_file' });
    await checkDisk('/m', 5 * GiB, { statfsImpl: ntfs, platform: 'linux' });
  });

  test('a failing statfs or mount does not stop the fetch', async () => {
    await checkDisk('/x', 1, { statfsImpl: async () => { throw new Error('no'); }, platform: 'linux' });
    await checkDisk('/x', 1, { ...mac, mountOutput: async () => { throw new Error('no'); } });
  });
});
