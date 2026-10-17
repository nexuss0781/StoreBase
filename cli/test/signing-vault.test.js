'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { SigningVault, vaultPath } = require('../lib/signing-vault');

const PASS = 'correct horse battery staple';
const PROFILE = {
  keystore: Buffer.from('private test keystore bytes').toString('base64'),
  storePassword: 'store-secret-value',
  keyPassword: 'key-secret-value',
  alias: 'release-key',
  fingerprint: 'A'.repeat(64),
};

async function fixture(t, relative = 'vault/signing-vault.json') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'storebase-signing-vault-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, filePath: path.join(root, relative), vault: new SigningVault({ filePath: path.join(root, relative) }) };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test('vaultPath is a fixed OS user-data location under the home directory', () => {
  const result = vaultPath();
  assert.equal(path.isAbsolute(result), true);
  assert.equal(path.dirname(result).endsWith('storebase-cli'), true);
  assert.equal(path.resolve(result).startsWith(path.resolve(os.homedir()) + path.sep), true);
  assert.equal(path.basename(result), 'signing-vault.json');
});

test('reads an absent vault without creating its parent, then mutates and reopens data', async (t) => {
  const f = await fixture(t, 'not-created/yet/vault.json');
  assert.deepEqual(await f.vault.read(PASS), { profiles: {} });
  await assert.rejects(fs.stat(path.dirname(f.filePath)), { code: 'ENOENT' });
  const updated = await f.vault.mutate(PASS, async (data) => {
    data.profiles.release = clone(PROFILE);
  });
  assert.equal(updated, undefined);
  assert.deepEqual(await f.vault.read(PASS), { profiles: { release: PROFILE } });
  if (process.platform !== 'win32') {
    const parentStat = await fs.stat(path.dirname(f.filePath));
    const fileStat = await fs.stat(f.filePath);
    assert.equal(parentStat.mode & 0o777, 0o700);
    assert.equal(fileStat.mode & 0o777, 0o600);
  }
  await assert.rejects(fs.stat(`${f.filePath}.lock`), { code: 'ENOENT' });
});

test('ciphertext hides secrets and each successful write gets a fresh salt and nonce', async (t) => {
  const f = await fixture(t);
  await f.vault.mutate(PASS, (data) => { data.profiles.release = clone(PROFILE); });
  const firstRaw = await fs.readFile(f.filePath, 'utf8');
  const first = JSON.parse(firstRaw);
  for (const secret of [PROFILE.storePassword, PROFILE.keyPassword, PROFILE.alias, PROFILE.fingerprint, PROFILE.keystore]) {
    assert.equal(firstRaw.includes(secret), false);
  }
  assert.equal(first.version, 1);
  assert.deepEqual(first.kdf, {
    name: 'scrypt', N: 32768, r: 8, p: 1, salt: first.kdf.salt,
  });
  assert.equal(Buffer.from(first.kdf.salt, 'base64').length, 16);
  assert.equal(Buffer.from(first.cipher.iv, 'base64').length, 12);
  assert.equal(Buffer.from(first.cipher.tag, 'base64').length, 16);
  assert.equal(first.cipher.name, 'aes-256-gcm');
  await f.vault.mutate(PASS, (data) => { data.profiles.release.alias = 'release-key-2'; });
  const second = JSON.parse(await fs.readFile(f.filePath, 'utf8'));
  assert.notEqual(second.kdf.salt, first.kdf.salt);
  assert.notEqual(second.cipher.iv, first.cipher.iv);
});

test('rekey preserves data and rejects the old passphrase afterward', async (t) => {
  const f = await fixture(t);
  await f.vault.mutate(PASS, (data) => { data.profiles.release = clone(PROFILE); });
  const next = 'an entirely new strong passphrase';
  assert.equal(await f.vault.rekey(PASS, next), undefined);
  assert.deepEqual(await f.vault.read(next), { profiles: { release: PROFILE } });
  await assert.rejects(f.vault.read(PASS), /could not be unlocked/);
});

test('wrong passphrase and modified ciphertext yield the same generic unlock error', async (t) => {
  const f = await fixture(t);
  await f.vault.mutate(PASS, (data) => { data.profiles.release = clone(PROFILE); });
  await assert.rejects(f.vault.read('a different passphrase string'), {
    message: 'Signing vault could not be unlocked; passphrase may be incorrect or vault data is damaged.',
  });
  const envelope = JSON.parse(await fs.readFile(f.filePath, 'utf8'));
  const cipher = Buffer.from(envelope.cipher.data, 'base64');
  cipher[0] ^= 0x01;
  envelope.cipher.data = cipher.toString('base64');
  await fs.writeFile(f.filePath, JSON.stringify(envelope), { mode: 0o600 });
  await assert.rejects(f.vault.read(PASS), {
    message: 'Signing vault could not be unlocked; passphrase may be incorrect or vault data is damaged.',
  });
});

test('rejects short passphrases and invalid payload schemas without writing', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.vault.read('too short'), /at least 12 characters/);
  await assert.rejects(f.vault.mutate('too short', () => {}), /at least 12 characters/);
  for (const [name, profile] of [
    ['../escape', PROFILE],
    ['constructor', PROFILE],
    ['bad.name', PROFILE],
    ['invalid-fingerprint', { ...PROFILE, fingerprint: 'a'.repeat(64) }],
    ['extra-field', { ...PROFILE, secret: 'must-not-be-saved' }],
    ['invalid-keystore', { ...PROFILE, keystore: 'not base64!' }],
  ]) {
    await assert.rejects(f.vault.mutate(PASS, (data) => { data.profiles[name] = clone(profile); }));
  }
  await assert.rejects(fs.stat(f.filePath), { code: 'ENOENT' });
});

test('rejects malformed envelope metadata with a generic unlock error', async (t) => {
  const f = await fixture(t);
  await f.vault.mutate(PASS, (data) => { data.profiles.release = clone(PROFILE); });
  const envelope = JSON.parse(await fs.readFile(f.filePath, 'utf8'));
  envelope.unencryptedMetadata = 'should-not-be-accepted';
  await fs.writeFile(f.filePath, JSON.stringify(envelope), { mode: 0o600 });
  await assert.rejects(f.vault.read(PASS), /could not be unlocked/);
});

test('rejects symlinked vaults and symlinked parent directories', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX symlink checks');
  const f = await fixture(t);
  const target = path.join(f.root, 'target.json');
  await fs.writeFile(target, '{}', { mode: 0o600 });
  await fs.mkdir(path.dirname(f.filePath), { mode: 0o700 });
  await fs.symlink(target, f.filePath);
  await assert.rejects(f.vault.read(PASS), /must not be a symlink/);

  const elsewhere = path.join(f.root, 'elsewhere');
  await fs.mkdir(elsewhere, { mode: 0o700 });
  const link = path.join(f.root, 'linked-dir');
  await fs.symlink(elsewhere, link);
  const linkedVault = new SigningVault({ filePath: path.join(link, 'vault.json') });
  await assert.rejects(linkedVault.mutate(PASS, () => {}), /must not be a symlink/);
});

test('refuses directories and vault files with unsafe POSIX permissions', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX permission checks');
  const f = await fixture(t);
  await f.vault.mutate(PASS, (data) => { data.profiles.release = clone(PROFILE); });
  await fs.chmod(path.dirname(f.filePath), 0o755);
  await assert.rejects(f.vault.read(PASS), /unsafe permissions/);
  await fs.chmod(path.dirname(f.filePath), 0o700);
  await fs.chmod(f.filePath, 0o644);
  await assert.rejects(f.vault.read(PASS), /unsafe permissions/);
});

test('exclusive lock prevents concurrent lost updates and is cleaned up', async (t) => {
  const f = await fixture(t);
  let enteredResolve;
  let releaseResolve;
  const entered = new Promise((resolve) => { enteredResolve = resolve; });
  const hold = new Promise((resolve) => { releaseResolve = resolve; });
  const first = f.vault.mutate(PASS, async (data) => {
    data.profiles.first = clone(PROFILE);
    enteredResolve();
    await hold;
  });
  await entered;
  await assert.rejects(f.vault.mutate(PASS, (data) => { data.profiles.second = clone(PROFILE); }), /locked by another operation/);
  releaseResolve();
  await first;
  await f.vault.mutate(PASS, (data) => { data.profiles.second = clone(PROFILE); });
  assert.deepEqual(Object.keys((await f.vault.read(PASS)).profiles).sort(), ['first', 'second']);
  await assert.rejects(fs.stat(`${f.filePath}.lock`), { code: 'ENOENT' });
});

test('an existing stale lock fails safely instead of being removed or overwritten', async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.dirname(f.filePath), { recursive: true, mode: 0o700 });
  const lockPath = `${f.filePath}.lock`;
  await fs.writeFile(lockPath, 'do not replace', { mode: 0o600 });
  await assert.rejects(f.vault.mutate(PASS, () => {}), /locked by another operation/);
  assert.equal(await fs.readFile(lockPath, 'utf8'), 'do not replace');
});


test('vault supports large keystores without regex recursion and clears mutation references', async(t)=>{
  const f=await fixture(t); let retained;
  const large={...PROFILE,keystore:Buffer.alloc(1024*1024,42).toString('base64')};
  await f.vault.mutate(PASS,data=>{retained=data;data.profiles.large=clone(large);});
  assert.equal(retained.profiles.large.keystore,'');
  assert.equal((await f.vault.read(PASS)).profiles.large.keystore,large.keystore);
});


test('profile replacement and removal preserve other profiles and rejected updates preserve ciphertext', async(t)=>{
  const f=await fixture(t);
  await f.vault.mutate(PASS,data=>{data.profiles.one=clone(PROFILE);data.profiles.two=clone(PROFILE);});
  const before=await fs.readFile(f.filePath);
  await assert.rejects(f.vault.mutate(PASS,data=>{data.profiles.one.fingerprint='invalid';}));
  assert.deepEqual(await fs.readFile(f.filePath),before);
  await f.vault.mutate(PASS,data=>{data.profiles.one={...clone(PROFILE),fingerprint:'B'.repeat(64)};});
  assert.equal((await f.vault.read(PASS)).profiles.one.fingerprint,'B'.repeat(64));
  await f.vault.mutate(PASS,data=>{delete data.profiles.one;});
  assert.deepEqual(Object.keys((await f.vault.read(PASS)).profiles),['two']);
});
