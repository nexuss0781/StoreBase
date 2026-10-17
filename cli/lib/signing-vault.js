'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);
const VERSION = 1;
const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const MAX_FILE_SIZE = 32 * 1024 * 1024;
const MAX_PAYLOAD_SIZE = 31 * 1024 * 1024;
const MAX_KEYSTORE_SIZE = 8 * 1024 * 1024;
const AAD = Buffer.from('storebase-signing-vault:v1:scrypt-32768-8-1:aes-256-gcm', 'utf8');
const UNLOCK_ERROR = 'Signing vault could not be unlocked; passphrase may be incorrect or vault data is damaged.';
const LOCK_ERROR = 'Signing vault is locked by another operation; retry after it finishes.';

function vaultPath() {
  const home = os.homedir();
  if (process.platform === 'win32') return path.join(home, 'AppData', 'Local', 'storebase-cli', 'signing-vault.json');
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'storebase-cli', 'signing-vault.json');
  return path.join(home, '.local', 'share', 'storebase-cli', 'signing-vault.json');
}

function checkPassphrase(passphrase) {
  if (typeof passphrase !== 'string' || [...passphrase].length < 12) {
    throw new Error('Signing vault passphrase must be at least 12 characters.');
  }
}

function validatePayload(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)
      || Object.getPrototypeOf(data) !== Object.prototype
      || Object.keys(data).length !== 1 || !Object.hasOwn(data, 'profiles')) {
    throw new Error('Signing vault data must contain only a profiles object.');
  }
  const profiles = data.profiles;
  if (!profiles || typeof profiles !== 'object' || Array.isArray(profiles)
      || Object.getPrototypeOf(profiles) !== Object.prototype) {
    throw new Error('Signing vault profiles must be an object.');
  }
  for (const [name, profile] of Object.entries(profiles)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)
        || ['constructor', 'prototype', '__proto__'].includes(name)) {
      throw new Error('Signing vault contains an invalid profile name.');
    }
    const fields = ['keystore', 'storePassword', 'keyPassword', 'alias', 'fingerprint'];
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)
        || Object.getPrototypeOf(profile) !== Object.prototype
        || Object.keys(profile).length !== fields.length
        || fields.some((field) => !Object.hasOwn(profile, field))) {
      throw new Error(`Signing profile "${name}" has an invalid schema.`);
    }
    if (typeof profile.keystore !== 'string' || profile.keystore.length === 0
        || profile.keystore.length > Math.ceil(MAX_KEYSTORE_SIZE / 3) * 4
        || /[^A-Za-z0-9+/=]/.test(profile.keystore)) {
      throw new Error(`Signing profile "${name}" has invalid keystore data.`);
    }
    const keystoreBytes = Buffer.from(profile.keystore, 'base64');
    if (!keystoreBytes.length || keystoreBytes.length > MAX_KEYSTORE_SIZE
        || keystoreBytes.toString('base64') !== profile.keystore) {
      keystoreBytes.fill(0);
      throw new Error(`Signing profile "${name}" has invalid keystore data.`);
    }
    keystoreBytes.fill(0);
    for (const field of fields.slice(1)) {
      if (typeof profile[field] !== 'string' || profile[field].length > 4096
          || (field !== 'storePassword' && field !== 'keyPassword' && profile[field].length === 0)
          || (field === 'alias' && /[\x00-\x1f\x7f]/.test(profile[field]))
          || (field === 'fingerprint' && !/^[A-F0-9]{64}$/.test(profile[field]))) {
        throw new Error(`Signing profile "${name}" has an invalid ${field}.`);
      }
    }
  }
  const serialized = JSON.stringify(data);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_PAYLOAD_SIZE) {
    throw new Error('Signing vault data exceeds the maximum supported size.');
  }
  return serialized;
}

function assertSafeStat(stat, { directory = false } = {}) {
  if (directory ? !stat.isDirectory() : !stat.isFile()) {
    throw new Error('Signing vault path has an unsafe file type.');
  }
  if (process.platform !== 'win32') {
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      throw new Error('Signing vault path is not owned by the current user.');
    }
    const mode = stat.mode & 0o777;
    if ((mode & 0o077) !== 0 || (directory && (mode & 0o700) !== 0o700)) {
      throw new Error('Signing vault path has unsafe permissions.');
    }
  }
}

async function lstatIfExists(target) {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function ensureParent(parent, create) {
  const absolute = path.resolve(parent);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  const components = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (let index = 0; index < components.length; index += 1) {
    current = path.join(current, components[index]);
    let stat = await lstatIfExists(current);
    if (!stat && create) {
      try {
        await fs.mkdir(current, { mode: 0o700 });
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      stat = await lstatIfExists(current);
    }
    if (!stat) return false;
    if (stat.isSymbolicLink()) throw new Error('Signing vault parent directory must not be a symlink.');
    if (!stat.isDirectory()) throw new Error('Signing vault parent path is not a directory.');
    if (index === components.length - 1) assertSafeStat(stat, { directory: true });
  }
  return true;
}

async function checkVaultFile(filePath) {
  const stat = await lstatIfExists(filePath);
  if (!stat) return null;
  if (stat.isSymbolicLink()) throw new Error('Signing vault file must not be a symlink.');
  assertSafeStat(stat);
  if (process.platform !== 'win32' && stat.nlink !== 1) {
    throw new Error('Signing vault file has an unsafe link count.');
  }
  return stat;
}

async function deriveKey(passphrase, salt) {
  const passphraseBytes = Buffer.from(passphrase, 'utf8');
  try {
    return await scrypt(passphraseBytes, salt, 32, {
      N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM,
    });
  } finally {
    passphraseBytes.fill(0);
  }
}

function decodeBase64(value, expectedLength) {
  if (typeof value !== 'string' || /[^A-Za-z0-9+/=]/.test(value)) return null;
  const result = Buffer.from(value, 'base64');
  if (result.toString('base64') !== value || (expectedLength !== undefined && result.length !== expectedLength)) {
    result.fill(0);
    return null;
  }
  return result;
}

function validateEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)
      || Object.getPrototypeOf(envelope) !== Object.prototype
      || Object.keys(envelope).sort().join(',') !== 'cipher,kdf,version'
      || envelope.version !== VERSION) throw new Error(UNLOCK_ERROR);
  const { kdf, cipher } = envelope;
  if (!kdf || typeof kdf !== 'object' || Array.isArray(kdf)
      || Object.keys(kdf).sort().join(',') !== 'N,name,p,r,salt'
      || kdf.name !== 'scrypt' || kdf.N !== SCRYPT_N || kdf.r !== SCRYPT_R || kdf.p !== SCRYPT_P
      || !cipher || typeof cipher !== 'object' || Array.isArray(cipher)
      || Object.keys(cipher).sort().join(',') !== 'data,iv,name,tag' || cipher.name !== 'aes-256-gcm') {
    throw new Error(UNLOCK_ERROR);
  }
  const salt = decodeBase64(kdf.salt, 16);
  const iv = decodeBase64(cipher.iv, 12);
  const tag = decodeBase64(cipher.tag, 16);
  const ciphertext = decodeBase64(cipher.data);
  if (!salt || !iv || !tag || !ciphertext || ciphertext.length > MAX_PAYLOAD_SIZE) {
    for (const buffer of [salt, iv, tag, ciphertext]) buffer?.fill(0);
    throw new Error(UNLOCK_ERROR);
  }
  return { salt, iv, tag, ciphertext };
}

async function decryptEnvelope(raw, passphrase) {
  let plaintext;
  let key;
  let parsed;
  let pieces;
  try {
    if (raw.length > MAX_FILE_SIZE) throw new Error(UNLOCK_ERROR);
    parsed = JSON.parse(raw.toString('utf8'));
    pieces = validateEnvelope(parsed);
    key = await deriveKey(passphrase, pieces.salt);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, pieces.iv);
    decipher.setAAD(AAD);
    decipher.setAuthTag(pieces.tag);
    plaintext = Buffer.concat([decipher.update(pieces.ciphertext), decipher.final()]);
    if (plaintext.length > MAX_PAYLOAD_SIZE) throw new Error(UNLOCK_ERROR);
    const value = JSON.parse(plaintext.toString('utf8'));
    validatePayload(value);
    return value;
  } catch {
    throw new Error(UNLOCK_ERROR);
  } finally {
    key?.fill(0);
    plaintext?.fill(0);
    if (pieces) for (const value of Object.values(pieces)) value.fill(0);
  }
}

async function encryptPayload(data, passphrase) {
  const serialized = validatePayload(data);
  const plaintext = Buffer.from(serialized, 'utf8');
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  let key;
  let ciphertext;
  try {
    key = await deriveKey(passphrase, salt);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(AAD);
    ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const envelope = {
      version: VERSION,
      kdf: { name: 'scrypt', N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, salt: salt.toString('base64') },
      cipher: { name: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: ciphertext.toString('base64') },
    };
    const output = Buffer.from(JSON.stringify(envelope), 'utf8');
    if (output.length > MAX_FILE_SIZE) {
      output.fill(0);
      throw new Error('Signing vault data exceeds the maximum supported size.');
    }
    return output;
  } finally {
    plaintext.fill(0);
    salt.fill(0);
    iv.fill(0);
    key?.fill(0);
    ciphertext?.fill(0);
  }
}

function clearData(data) {
  if (!data?.profiles || typeof data.profiles !== 'object') return;
  for (const profile of Object.values(data.profiles)) {
    if (!profile || typeof profile !== 'object') continue;
    for (const field of ['keystore', 'storePassword', 'keyPassword']) if (Object.hasOwn(profile, field)) profile[field] = '';
  }
}

class SigningVault {
  constructor({ filePath } = {}) {
    this.filePath = path.resolve(filePath || vaultPath());
  }

  async _read(passphrase) {
    checkPassphrase(passphrase);
    const parentExists = await ensureParent(path.dirname(this.filePath), false);
    if (!parentExists) return { profiles: {} };
    const stat = await checkVaultFile(this.filePath);
    if (!stat) return { profiles: {} };
    if (stat.size > MAX_FILE_SIZE) throw new Error(UNLOCK_ERROR);
    let handle;
    let raw;
    try {
      const noFollow = fs.constants?.O_NOFOLLOW || 0;
      handle = await fs.open(this.filePath, require('node:fs').constants.O_RDONLY | noFollow);
      const opened = await handle.stat();
      assertSafeStat(opened);
      if (opened.size > MAX_FILE_SIZE) throw new Error(UNLOCK_ERROR);
      raw = await handle.readFile();
      return await decryptEnvelope(raw, passphrase);
    } finally {
      raw?.fill(0);
      await handle?.close();
    }
  }

  async read(passphrase) {
    return this._read(passphrase);
  }

  async _write(data, passphrase) {
    const output = await encryptPayload(data, passphrase);
    const parent = path.dirname(this.filePath);
    let tempPath;
    let handle;
    try {
      // The parent and target are checked immediately before creating the atomic replacement.
      await ensureParent(parent, true);
      await checkVaultFile(this.filePath);
      tempPath = path.join(parent, `.${path.basename(this.filePath)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`);
      handle = await fs.open(tempPath, 'wx', 0o600);
      if (process.platform !== 'win32') await handle.chmod(0o600);
      await handle.writeFile(output);
      await handle.sync();
      await handle.close();
      handle = null;
      await checkVaultFile(this.filePath);
      await fs.rename(tempPath, this.filePath);
      tempPath = null;
      if (process.platform !== 'win32') {
        const dirHandle = await fs.open(parent, 'r');
        try { await dirHandle.sync(); } finally { await dirHandle.close(); }
      }
    } finally {
      output.fill(0);
      await handle?.close().catch(() => {});
      if (tempPath) await fs.unlink(tempPath).catch(() => {});
    }
  }

  async _withLock(callback) {
    await ensureParent(path.dirname(this.filePath), true);
    const lockPath = `${this.filePath}.lock`;
    let handle;
    let lockStat;
    try {
      handle = await fs.open(lockPath, 'wx', 0o600);
      if (process.platform !== 'win32') await handle.chmod(0o600);
      lockStat = await handle.stat();
      assertSafeStat(lockStat);
    } catch (error) {
      await handle?.close().catch(() => {});
      if (error.code === 'EEXIST') throw new Error(LOCK_ERROR);
      throw error;
    }
    try {
      return await callback();
    } finally {
      await handle.close().catch(() => {});
      try {
        const current = await fs.lstat(lockPath);
        if (!current.isSymbolicLink() && current.dev === lockStat.dev && current.ino === lockStat.ino) await fs.unlink(lockPath);
      } catch { /* Best-effort cleanup; never remove a lock we do not own. */ }
    }
  }

  async mutate(passphrase, updater) {
    checkPassphrase(passphrase);
    if (typeof updater !== 'function') throw new Error('Signing vault mutation callback is required.');
    return this._withLock(async () => {
      const data = await this._read(passphrase);
      let updated;
      let detached;
      try {
        const replacement = await updater(data);
        updated = replacement === undefined ? data : replacement;
        const serialized = validatePayload(updated);
        detached = JSON.parse(serialized);
        await this._write(detached, passphrase);
      } finally { clearData(data); clearData(updated); clearData(detached); }
    });
  }

  async rekey(oldPassphrase, newPassphrase) {
    checkPassphrase(oldPassphrase);
    checkPassphrase(newPassphrase);
    return this._withLock(async () => {
      const data = await this._read(oldPassphrase);
      try { await this._write(data, newPassphrase); } finally { clearData(data); }
    });
  }
}

module.exports = { SigningVault, vaultPath };
