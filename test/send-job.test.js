/**
 * test/send-job.test.js — refueler_send_file at the tool boundary
 * MCP-Install-1 (job runner) and MCP-Trust-1 (folders, link files, confirmation).
 * node:test only. Test credentials use the rfs_test_ prefix.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createJobRunner } from '../src/jobs.js';
import { handleSendJob, handleSendStatus } from '../src/tools/send-job.js';
import { handleSendFile } from '../src/tools/send.js';
import { createConfirmations } from '../src/confirm.js';
import { CHUNK_SIZE } from '../src/crypto.js';

const parse = (r) => JSON.parse(r.content[0].text);
const text = (v) => [{ type: 'text', text: JSON.stringify(v) }];
const UUID = '11111111-2222-4333-8444-555555555555';
const LINK = `https://share.refueler.io/?uuid=${UUID}#eyJ2IjoyLCJrIjoiU0VDUkVUS0VZIn0`;
const PASSWORD = 'rfs_test correct horse battery';

let jobs, dir, other, linkDir, file;

beforeEach(async () => {
  jobs = createJobRunner();
  dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'rf-sendjob-')));
  other = await realpath(await mkdtemp(path.join(os.tmpdir(), 'rf-sendjob-other-')));
  linkDir = path.join(dir, 'links');
  file = path.join(dir, 'report.pdf');
  await writeFile(file, Buffer.alloc(1000, 7));
});

afterEach(async () => {
  await jobs.abortAll();
  await rm(dir, { recursive: true, force: true });
  await rm(other, { recursive: true, force: true });
});

/** A stand-in send that waits for `gate`, reports progress, and records its input. */
function stubSend({ gate = Promise.resolve(), result = { uuid: UUID, share_url: LINK, passphrase_required: false } } = {}) {
  const calls = [];
  const send = async (input, deps) => {
    calls.push(input);
    deps.onProgress(0, 3);
    deps.onProgress(1, 3);
    await gate;
    return text(result);
  };
  return { send, calls };
}

function depsFor(extra = {}, configExtra = {}) {
  return {
    jobs,
    cwd: dir,
    config: { rootEnv: null, linkDir, linkInChat: false, confirmSend: false, ...configExtra },
    confirmations: createConfirmations(),
    ...extra,
  };
}

describe('send job handle', () => {
  test('a quick send answers in the same call', async () => {
    const r = await handleSendJob({ file_path: file }, depsFor(stubSend()));
    const v = parse(r);
    assert.equal(v.state, 'complete');
    assert.equal(v.uuid, UUID);
    assert.equal(r.isError, undefined);
  });

  test('a long send hands back a job_id, then the status tool gives the result', async () => {
    let open; const gate = new Promise(r => { open = r; });
    const first = parse(await handleSendJob({ file_path: file }, depsFor({ ...stubSend({ gate }), foregroundMs: 5 })));
    assert.equal(first.state, 'running');
    assert.equal(first.parts_done, 1);
    assert.equal(first.parts_total, 3);

    open();
    await jobs.get(first.job_id).done;
    const done = parse(handleSendStatus({ job_id: first.job_id }, { jobs }));
    assert.equal(done.state, 'complete');
    assert.equal(done.uuid, UUID);
    assert.equal(done.share_url, undefined);
  });

  test('a send error ends the job as failed, with the send\'s own envelope', async () => {
    const send = async () => text({ error: 'too_large', detail: 'Too big.', size_bytes: 9 });
    const r = await handleSendJob({ file_path: file }, depsFor({ send }));
    const v = parse(r);
    assert.equal(v.error, 'too_large');
    assert.equal(v.size_bytes, 9);
    assert.ok(v.job_id);
    assert.equal(r.isError, true);
  });

  test('an unexpected throw says nothing specific', async () => {
    const send = async () => { throw new Error('secret detail /Users/x'); };
    const v = parse(await handleSendJob({ file_path: file }, depsFor({ send })));
    assert.equal(v.error, 'send_failed');
    assert.doesNotMatch(JSON.stringify(v), /secret/);
  });

  test('the same file twice at once, by another spelling, is refused with the running job_id', async () => {
    let open; const gate = new Promise(r => { open = r; });
    const deps = depsFor({ ...stubSend({ gate }), foregroundMs: 1 });
    const first = parse(await handleSendJob({ file_path: path.join(dir, 'x', '..', 'report.pdf') }, deps));
    await symlink(file, path.join(dir, 'alias.pdf'));
    const again = parse(await handleSendJob({ file_path: path.join(dir, 'alias.pdf') }, deps));
    assert.equal(again.error, 'already_sending');
    assert.equal(again.job_id, first.job_id);
    open();
  });

  test('sends and fetches have separate limits', async () => {
    let open; const gate = new Promise(r => { open = r; });
    const deps = depsFor({ ...stubSend({ gate }), foregroundMs: 1 });
    for (const n of ['a', 'b', 'c']) await writeFile(path.join(dir, n), 'x');
    await handleSendJob({ file_path: path.join(dir, 'a') }, deps);
    await handleSendJob({ file_path: path.join(dir, 'b') }, deps);
    const busy = parse(await handleSendJob({ file_path: path.join(dir, 'c') }, deps));
    assert.equal(busy.error, 'busy');
    assert.match(busy.detail, /sends/);

    const fetchJob = jobs.start({ kind: 'fetch', key: 'u', work: () => gate });
    assert.equal(fetchJob.state, 'running');
    open();
  });

  test('one kind\'s status tool cannot read the other\'s job', async () => {
    let open; const gate = new Promise(r => { open = r; });
    const fetchJob = jobs.start({ kind: 'fetch', key: 'u', work: () => gate });
    assert.equal(parse(handleSendStatus({ job_id: fetchJob.id }, { jobs })).error, 'unknown_job');
    open();
  });
});

describe('the link goes to a file, not the result (MCP-Trust-1)', () => {
  test('link file 0600 in a 0700 folder; the result names it and carries no link', async () => {
    const v = parse(await handleSendJob({ file_path: file }, depsFor(stubSend())));
    assert.equal(v.link_file, path.join(await realpath(linkDir), `${UUID}.link`));
    assert.equal(await readFile(v.link_file, 'utf8'), `${LINK}\n`);
    assert.equal((await stat(v.link_file)).mode & 0o777, 0o600);
    assert.equal((await stat(linkDir)).mode & 0o777, 0o700);
    assert.equal(v.share_url, undefined);
    assert.equal(v.passphrase_required, undefined);
    assert.equal(v.password_required, false);
    assert.doesNotMatch(JSON.stringify(v), /SECRETKEY|eyJ2/);
  });

  test('REFUELER_LINK_IN_CHAT=1 adds share_url, and still writes the file', async () => {
    const v = parse(await handleSendJob({ file_path: file }, depsFor(stubSend(), { linkInChat: true })));
    assert.equal(v.share_url, LINK);
    assert.equal(await readFile(v.link_file, 'utf8'), `${LINK}\n`);
  });

  test('an existing link folder open to others is made private', async () => {
    await mkdir(linkDir, { mode: 0o755 });
    await chmod(linkDir, 0o755);
    await handleSendJob({ file_path: file }, depsFor(stubSend()));
    assert.equal((await stat(linkDir)).mode & 0o777, 0o700);
  });

  test('a link folder that is a symlink is refused before anything is sent', async () => {
    await symlink(other, linkDir);
    const stub = stubSend();
    const v = parse(await handleSendJob({ file_path: file }, depsFor(stub)));
    assert.equal(v.error, 'link_folder_unusable');
    assert.equal(stub.calls.length, 0);
  });

  test('a transfer ID that is not a UUID never becomes a file name', async () => {
    const stub = stubSend({ result: { uuid: '../../escape', share_url: LINK } });
    const v = parse(await handleSendJob({ file_path: file }, depsFor(stub)));
    assert.equal(v.error, 'link_not_saved');
    assert.doesNotMatch(JSON.stringify(v), /SECRETKEY|eyJ2/);
    assert.deepEqual(await readdir(dir).then(a => a.filter(n => n.includes('escape'))), []);
  });

  test('a link file that cannot be written says so without the link', async () => {
    await mkdir(linkDir, { mode: 0o700 });
    await writeFile(path.join(linkDir, `${UUID}.link`), 'old');
    const v = parse(await handleSendJob({ file_path: file }, depsFor(stubSend())));
    assert.equal(v.error, 'link_not_saved');
    assert.equal(v.uuid, UUID);
    assert.doesNotMatch(JSON.stringify(v), /SECRETKEY|eyJ2/);
  });

  test('on Windows the result says the files rely on the user folder', async () => {
    const v = parse(await handleSendJob({ file_path: file }, depsFor({ ...stubSend(), platform: 'win32' })));
    assert.match(v.note, /Windows/);
  });
});

describe('passwords come from a file (MCP-Trust-1, decision A)', () => {
  test('password_file is read, passed to the send, and copied to <uuid>.password 0600', async () => {
    const pw = path.join(dir, 'pw.txt');
    await writeFile(pw, `  ${PASSWORD}\n`);
    const stub = stubSend();
    const v = parse(await handleSendJob({ file_path: file, password_file: pw }, depsFor(stub)));
    assert.equal(stub.calls[0].passphrase, PASSWORD);
    assert.equal(v.password_required, true);
    assert.equal(await readFile(v.password_file, 'utf8'), `${PASSWORD}\n`);
    assert.equal((await stat(v.password_file)).mode & 0o777, 0o600);
    assert.ok(!JSON.stringify(v).includes('horse'));
  });

  test('a password in tool input is refused, and not echoed', async () => {
    const stub = stubSend();
    const r = await handleSendJob({ file_path: file, passphrase: PASSWORD }, depsFor(stub));
    assert.equal(parse(r).error, 'password_in_input');
    assert.ok(!JSON.stringify(r).includes('horse'));
    assert.equal(stub.calls.length, 0);
  });

  test('too short, or two lines, is refused without quoting it', async () => {
    const pw = path.join(dir, 'pw.txt');
    for (const bad of ['short', 'rfs_test line one\nline two']) {
      await writeFile(pw, bad);
      const r = await handleSendJob({ file_path: file, password_file: pw }, depsFor(stubSend()));
      assert.equal(parse(r).error, 'password_too_short');
      assert.ok(!JSON.stringify(r).includes('short"') && !JSON.stringify(r).includes('line two'));
      await rm(pw);
    }
  });

  test('a password file outside the folders is refused; one in the link folder is fine', async () => {
    const outsidePw = path.join(other, 'pw.txt');
    await writeFile(outsidePw, PASSWORD);
    assert.equal(parse(await handleSendJob({ file_path: file, password_file: outsidePw }, depsFor(stubSend()))).error,
      'outside_allowed_folders');

    await mkdir(linkDir, { recursive: true, mode: 0o700 });
    const inLinks = path.join(linkDir, 'mine.password');
    await writeFile(inLinks, PASSWORD);
    assert.equal(parse(await handleSendJob({ file_path: file, password_file: inLinks }, depsFor(stubSend()))).state,
      'complete');
  });

  test('a symlinked password file is refused', async () => {
    const real = path.join(dir, 'real.txt');
    await writeFile(real, PASSWORD);
    await symlink(real, path.join(dir, 'pw.txt'));
    assert.equal(parse(await handleSendJob({ file_path: file, password_file: path.join(dir, 'pw.txt') }, depsFor(stubSend()))).error,
      'password_file_unreadable');
  });
});

describe('folders on send (MCP-Trust-1)', () => {
  test('a file outside the folders is refused in plain words naming REFUELER_ROOT', async () => {
    const out = path.join(other, 'secret.txt');
    await writeFile(out, 'x');
    const stub = stubSend();
    const v = parse(await handleSendJob({ file_path: out }, depsFor(stub)));
    assert.equal(v.error, 'outside_allowed_folders');
    assert.match(v.detail, /REFUELER_ROOT/);
    assert.equal(stub.calls.length, 0);
  });

  test('REFUELER_ROOT lets it through, beside the client\'s roots', async () => {
    const out = path.join(other, 'ok.txt');
    await writeFile(out, 'x');
    const v = parse(await handleSendJob({ file_path: out }, depsFor({
      ...stubSend(), clientRoots: async () => [pathToFileURL(dir).href],
    }, { rootEnv: other })));
    assert.equal(v.state, 'complete');
  });

  test('a symlink inside that points outside is refused', async () => {
    const out = path.join(other, 'secret.txt');
    await writeFile(out, 'x');
    await symlink(out, path.join(dir, 'looks-local.txt'));
    assert.equal(parse(await handleSendJob({ file_path: path.join(dir, 'looks-local.txt') }, depsFor(stubSend()))).error,
      'outside_allowed_folders');
  });

  test('client roots win over the start folder; an empty list counts as none', async () => {
    const deps = depsFor({ ...stubSend(), clientRoots: async () => [pathToFileURL(other).href] });
    assert.equal(parse(await handleSendJob({ file_path: file }, deps)).error, 'outside_allowed_folders');
    const empty = depsFor({ ...stubSend(), clientRoots: async () => [] });
    assert.equal(parse(await handleSendJob({ file_path: file }, empty)).state, 'complete');
  });

  test('home as the start folder is refused', async () => {
    const v = parse(await handleSendJob({ file_path: file }, depsFor({ ...stubSend(), cwd: os.homedir() })));
    assert.equal(v.error, 'no_folder_allowed');
    assert.match(v.detail, /REFUELER_ROOT/);
  });

  test('files in the link folder are never sent', async () => {
    await mkdir(linkDir, { mode: 0o700 });
    const key = path.join(linkDir, `${UUID}.link`);
    await writeFile(key, LINK);
    assert.equal(parse(await handleSendJob({ file_path: key }, depsFor(stubSend()))).error, 'file_in_link_folder');
  });

  test('a folder, a missing file and an empty file are refused', async () => {
    await writeFile(path.join(dir, 'empty'), '');
    assert.equal(parse(await handleSendJob({ file_path: dir }, depsFor(stubSend()))).error, 'not_a_file');
    assert.equal(parse(await handleSendJob({ file_path: path.join(dir, 'nope') }, depsFor(stubSend()))).error, 'file_missing');
    assert.equal(parse(await handleSendJob({ file_path: path.join(dir, 'empty') }, depsFor(stubSend()))).error, 'file_empty');
  });
});

describe('the user\'s yes before a send (MCP-Trust-1, decision C)', () => {
  const on = { confirmSend: true };

  test('no dialog: the first call asks and sends nothing; the code then sends', async () => {
    const stub = stubSend();
    const deps = depsFor(stub, on);
    const ask = parse(await handleSendJob({ file_path: file }, deps));
    assert.equal(ask.error, 'confirm_send');
    assert.equal(ask.name, 'report.pdf');
    assert.equal(ask.size_bytes, 1000);
    assert.ok(Number.isInteger(ask.cost_credits));
    assert.equal(ask.expires_in_days, 7);
    assert.match(ask.detail, /Ask the user/);
    assert.equal(stub.calls.length, 0);

    const v = parse(await handleSendJob({ file_path: file, accept_send: ask.confirm_id }, deps));
    assert.equal(v.state, 'complete');
    assert.equal(stub.calls.length, 1);
  });

  test('a code works once', async () => {
    const deps = depsFor(stubSend(), on);
    const { confirm_id: id } = parse(await handleSendJob({ file_path: file }, deps));
    assert.equal(parse(await handleSendJob({ file_path: file, accept_send: id }, deps)).state, 'complete');
    const again = parse(await handleSendJob({ file_path: file, accept_send: id }, deps));
    assert.equal(again.error, 'confirm_send');
    assert.match(again.detail, /no longer matches/);
    assert.notEqual(again.confirm_id, id);
  });

  test('a code made up by the model, or for other options, or for a changed file, does not send', async () => {
    const stub = stubSend();
    const deps = depsFor(stub, on);
    assert.equal(parse(await handleSendJob({ file_path: file, accept_send: 'yes' }, deps)).error, 'confirm_send');
    assert.equal(parse(await handleSendJob({ file_path: file, accept_send: true }, deps)).error, 'confirm_send');

    let { confirm_id: id } = parse(await handleSendJob({ file_path: file }, deps));
    assert.equal(parse(await handleSendJob({ file_path: file, accept_send: id, destroy_after_download: true }, deps)).error,
      'confirm_send');

    ({ confirm_id: id } = parse(await handleSendJob({ file_path: file }, deps)));
    await writeFile(file, Buffer.alloc(2000, 1));
    assert.equal(parse(await handleSendJob({ file_path: file, accept_send: id }, deps)).error, 'confirm_send');
    assert.equal(stub.calls.length, 0);
  });

  test('a code expires after ten minutes', async () => {
    let t = 1_000_000;
    const deps = depsFor({ ...stubSend(), confirmations: createConfirmations({ now: () => t }) }, on);
    const { confirm_id: id } = parse(await handleSendJob({ file_path: file }, deps));
    t += 10 * 60_000 + 1;
    assert.equal(parse(await handleSendJob({ file_path: file, accept_send: id }, deps)).error, 'confirm_send');
  });

  test('a dialog yes sends, and the dialog says what will happen', async () => {
    let seen;
    const elicit = async (p) => { seen = p; return { action: 'accept', content: { send: true } }; };
    const v = parse(await handleSendJob({ file_path: file }, depsFor({ ...stubSend(), elicit }, on)));
    assert.equal(v.state, 'complete');
    assert.match(seen.message, /report\.pdf/);
    assert.match(seen.message, /credits/);
  });

  test('a dialog no, cancel, untick or failure stops it, and never falls back to a code', async () => {
    const answers = [
      async () => ({ action: 'decline' }),
      async () => ({ action: 'cancel' }),
      async () => ({ action: 'accept', content: { send: false } }),
      async () => { throw new Error('timed out'); },
    ];
    for (const elicit of answers) {
      const stub = stubSend();
      const deps = depsFor({ ...stub, elicit }, on);
      const r = parse(await handleSendJob({ file_path: file }, deps));
      assert.equal(r.error, 'send_declined');
      assert.equal(r.confirm_id, undefined);
      assert.equal(stub.calls.length, 0);
    }
  });

  test('with a dialog, a valid code alone does not send', async () => {
    const confirmations = createConfirmations();
    const noDialog = depsFor({ ...stubSend(), confirmations }, on);
    const { confirm_id: id } = parse(await handleSendJob({ file_path: file }, noDialog));
    const stub = stubSend();
    const withDialog = depsFor({ ...stub, confirmations, elicit: async () => ({ action: 'decline' }) }, on);
    assert.equal(parse(await handleSendJob({ file_path: file, accept_send: id }, withDialog)).error, 'send_declined');
    assert.equal(stub.calls.length, 0);
  });

  test('REFUELER_CONFIRM_SEND=0 sends without asking', async () => {
    const v = parse(await handleSendJob({ file_path: file }, depsFor(stubSend(), { confirmSend: false })));
    assert.equal(v.state, 'complete');
  });

  test('a file name with control characters is cleaned before it is shown', async () => {
    const odd = path.join(dir, 'a‮b\nc.txt');
    await writeFile(odd, 'x');
    const ask = parse(await handleSendJob({ file_path: odd }, depsFor(stubSend(), on)));
    assert.equal(ask.name, 'abc.txt');
  });
});

describe('the real send through the boundary: nothing secret comes out', () => {
  function engineDeps() {
    const api = {
      async call(_m, p) {
        if (p.endsWith('/initiate')) {
          return { ok: true, status: 200, body: {
            session_token: 'rfs_test_session',
            urls: [{ index: 0, url: 'https://r2.test/0' }],
            tail_url: { index: 1, url: 'https://r2.test/1' },
          } };
        }
        return { ok: true, status: 200, body: { ok: true } };
      },
    };
    return {
      api,
      issueCredential: async () => ({ uuid: UUID, credential: '{}', commitment: 'rfs_test_c', issuedTier: 'api' }),
      putPart: async () => ({ ok: true, status: 200, etag: '', text: '' }),
    };
  }

  test('result, status, errors and stderr hold no key, fragment or password', async () => {
    const big = path.join(dir, 'two.bin');
    await writeFile(big, Buffer.alloc(CHUNK_SIZE + 5, 7));
    const pw = path.join(dir, 'pw.txt');
    await writeFile(pw, PASSWORD);

    const stderr = [];
    const realWrite = process.stderr.write.bind(process.stderr);
    const realError = console.error, realLog = console.log;
    process.stderr.write = (c, ...a) => { stderr.push(String(c)); return realWrite(c, ...a); };
    console.error = (...a) => stderr.push(a.join(' '));
    console.log = (...a) => stderr.push(a.join(' '));

    const outputs = [];
    let v;
    try {
      const deps = depsFor({ ...engineDeps(), send: handleSendFile }, { confirmSend: true, liveKey: 'rfs_test_live' });
      const ask = await handleSendJob({ file_path: big, password_file: pw }, deps);
      outputs.push(JSON.stringify(ask));
      const done = await handleSendJob({ file_path: big, password_file: pw, accept_send: parse(ask).confirm_id }, deps);
      outputs.push(JSON.stringify(done));
      v = parse(done);
      outputs.push(JSON.stringify(handleSendStatus({ job_id: 'nope' }, { jobs })));
      outputs.push(JSON.stringify(await handleSendJob({ file_path: big, password_file: pw, accept_send: 'x' }, deps)));
      outputs.push(JSON.stringify(await handleSendJob({ file_path: v.link_file }, deps)));
      outputs.push(JSON.stringify(await handleSendJob({ file_path: big, passphrase: PASSWORD }, deps)));
    } finally {
      process.stderr.write = realWrite;
      console.error = realError;
      console.log = realLog;
    }

    assert.equal(v.state, 'complete');
    const link = (await readFile(v.link_file, 'utf8')).trim();
    const fragment = link.split('#')[1];
    const key = JSON.parse(Buffer.from(fragment, 'base64url').toString()).k;
    assert.ok(fragment.length > 40 && key.length === 43);
    assert.equal((await readFile(v.password_file, 'utf8')).trim(), PASSWORD);

    for (const seen of [...outputs, stderr.join('\n')]) {
      assert.ok(!seen.includes(fragment), 'fragment leaked');
      assert.ok(!seen.includes(key), 'key leaked');
      assert.ok(!seen.includes(Buffer.from(key, 'base64url').toString('hex')), 'key (hex) leaked');
      assert.ok(!seen.includes('horse battery'), 'password leaked');
      assert.ok(!seen.includes('share.refueler.io/?uuid'), 'link leaked');
    }
  });
});
