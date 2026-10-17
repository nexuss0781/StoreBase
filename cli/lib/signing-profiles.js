'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { inspectKeystore, verifyKeystoreKeyPassword } = require('./publisher');

function profileName(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value)) {
    throw new Error('Profile names must be 1–64 letters, numbers, underscores, or hyphens.');
  }
  if (['__proto__', 'constructor', 'prototype'].includes(value)) throw new Error('Reserved profile name.');
  return value;
}

async function importProfile(file, storePassword, keyPassword, alias, options = {}) {
  const handle = await fs.open(path.resolve(file), 'r');
  let bytes;
  let folder;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < 1 || info.size > 8 * 1024 * 1024) throw new Error('Keystore must be a non-empty file of at most 8 MiB.');
    const bounded = Buffer.alloc(8 * 1024 * 1024 + 1);
    let count = 0;
    try {
      while (count < bounded.length) {
        const { bytesRead } = await handle.read(bounded, count, bounded.length - count, null);
        if (!bytesRead) break;
        count += bytesRead;
      }
      if (count > 8 * 1024 * 1024) throw new Error('Keystore exceeds the size limit.');
      if (!count) throw new Error('Keystore is empty.');
      bytes = Buffer.from(bounded.subarray(0, count));
    } finally { bounded.fill(0); }
    folder = await fs.mkdtemp(path.join(os.tmpdir(), 'storebase-signing-import-'));
    await fs.chmod(folder, 0o700);
    const temporary = path.join(folder, 'keystore');
    await fs.writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' });
    const entries = await (options.inspect || inspectKeystore)(temporary, storePassword);
    let selected;
    if (alias) selected = entries.find((entry) => entry.alias === alias);
    else if (entries.length === 1) selected = entries[0];
    if (!selected) throw new Error('Choose a valid private-key alias with --alias (required for multiple entries).');
    await (options.verify || verifyKeystoreKeyPassword)(temporary, storePassword, selected.alias, keyPassword);
    return { keystore: bytes.toString('base64'), storePassword, keyPassword,
      alias: selected.alias, fingerprint: selected.fingerprint };
  } finally {
    await handle.close();
    if (folder) {
      try {
        const file = path.join(folder, 'keystore');
        const handle = await fs.open(file, 'r+');
        try { await handle.write(Buffer.alloc(bytes?.length || 0), 0, bytes?.length || 0, 0); } finally { await handle.close(); }
      } catch {}
      await fs.rm(folder, { recursive: true, force: true });
    }
    bytes?.fill(0);
  }
}

function entryForProfile(data, name) {
  profileName(name);
  if (!Object.hasOwn(data.profiles, name)) throw new Error('Signing profile not found. Import it with storebase-keystore import.');
  const profile = data.profiles[name];
  // Publishing only needs the certificate verified at import time, not a plaintext private key.
  return { alias: profile.alias, fingerprint: profile.fingerprint };
}

function clearProfiles(data) {
  if (!data?.profiles) return;
  for (const profile of Object.values(data.profiles)) {
    profile.keystore = ''; profile.storePassword = ''; profile.keyPassword = '';
  }
}
async function loadProfileEntry(name, options = {}) {
  profileName(name);
  const vault = options.vault || new (require('./signing-vault').SigningVault)();
  const prompt = options.prompt || require('./secure-prompt').hidden;
  let passphrase = await prompt('Vault passphrase');
  let data;
  try { data = await vault.read(passphrase); return entryForProfile(data, name); }
  finally { passphrase = ''; clearProfiles(data); }
}
module.exports = { profileName, importProfile, entryForProfile, clearProfiles, loadProfileEntry };
