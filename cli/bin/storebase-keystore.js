#!/usr/bin/env node
'use strict';
const fs = require('node:fs/promises');
const { SigningVault, vaultPath } = require('../lib/signing-vault');
const { hidden, question, newPassphrase } = require('../lib/secure-prompt');
const { profileName, importProfile, clearProfiles } = require('../lib/signing-profiles');

function parseArguments(args) {
  if (!args.length || args.includes('--help') || args.includes('-h')) return { command: 'help' };
  const [command, ...rest] = args;
  if (!['import', 'list', 'remove', 'rekey', 'location'].includes(command)) throw new Error('Unknown keystore command. Use --help.');
  const result = { command };
  if (['import', 'remove'].includes(command)) result.name = profileName(rest.shift());
  while (rest.length) {
    const arg = rest.shift();
    if (command === 'import' && arg === '--replace' && !result.replace) result.replace = true;
    else if (command === 'import' && ['--file', '--alias'].includes(arg)) {
      const key = arg.slice(2);
      if (result[key] !== undefined || !rest[0] || rest[0].startsWith('--')) throw new Error('Invalid or duplicate keystore option.');
      result[key] = rest.shift();
    } else throw new Error('Unexpected keystore argument. Password arguments are not supported.');
  }
  if (command === 'import' && !result.file) throw new Error('Import requires --file <keystore>.');
  return result;
}

async function main(args = process.argv.slice(2)) {
  const opts = parseArguments(args);
  if (opts.command === 'help') {
    process.stdout.write(`StoreBase encrypted signing profiles\n\nCommands:\n  storebase-keystore import <profile> --file <keystore> [--alias <alias>] [--replace]\n  storebase-keystore list\n  storebase-keystore remove <profile>\n  storebase-keystore rekey\n  storebase-keystore location\n\nSecrets are collected only through hidden terminal prompts. The encrypted vault is\noutside the project in your user data directory. Its master passphrase is never saved.\nUse --signing-profile <profile> with storebase-publish to reuse a verified certificate.\nImport --replace replaces a profile; it does not create Android signing lineage.\n`);
    return;
  }
  if (opts.command === 'location') { process.stdout.write(`${vaultPath()}\n`); return; }
  const vault = new SigningVault();
  let exists = true;
  try { await fs.lstat(vaultPath()); } catch (e) { if (e.code === 'ENOENT') exists = false; else throw e; }
  if (!exists && opts.command !== 'import') throw new Error('No signing vault exists. Import a keystore first.');
  let passphrase = exists ? await hidden('Vault passphrase') : await newPassphrase();
  let data;
  let imported;
  try {
    data = await vault.read(passphrase);
    if (opts.command === 'list') {
      for (const name of Object.keys(data.profiles).sort()) {
        const p = data.profiles[name];
        process.stdout.write(`${name}\talias=${JSON.stringify(p.alias)}\tSHA256=${p.fingerprint}\n`);
      }
      if (!Object.keys(data.profiles).length) process.stdout.write('No signing profiles stored.\n');
    } else if (opts.command === 'import') {
      const replacing = Object.hasOwn(data.profiles, opts.name);
      if (replacing && !opts.replace) throw new Error('Profile already exists. Use --replace to explicitly rotate or update it.');
      if (opts.replace) {
        if (!replacing) throw new Error('Cannot replace a profile that does not exist.');
        process.stdout.write('Replacing a signing key may prevent Android updates to existing installs. Keep a secure backup of the old key.\n');
        if (await question(`Type REPLACE ${opts.name} to continue: `) !== `REPLACE ${opts.name}`) throw new Error('Cancelled.');
      }
      let storePassword = await hidden('Keystore password');
      let keyPassword = await hidden('Private-key password (Enter to reuse keystore password)');
      if (!keyPassword) keyPassword = storePassword;
      try { imported = await importProfile(opts.file, storePassword, keyPassword, opts.alias); }
      finally { storePassword = ''; keyPassword = ''; }
      await vault.mutate(passphrase, (current) => {
        if (JSON.stringify(current.profiles[opts.name]) !== JSON.stringify(data.profiles[opts.name])) throw new Error('Profile changed concurrently. Retry.');
        current.profiles[opts.name] = imported;
      });
      process.stdout.write(`Signing profile ${opts.replace ? 'replaced' : 'imported'}. Original keystore was not changed or uploaded.\n`);
    } else if (opts.command === 'remove') {
      if (!Object.hasOwn(data.profiles, opts.name)) throw new Error('Signing profile not found.');
      if (await question(`Type REMOVE ${opts.name} to delete its stored keystore and passwords: `) !== `REMOVE ${opts.name}`) throw new Error('Cancelled.');
      await vault.mutate(passphrase, (current) => {
        if (JSON.stringify(current.profiles[opts.name]) !== JSON.stringify(data.profiles[opts.name])) throw new Error('Profile changed concurrently. Retry.');
        delete current.profiles[opts.name];
      });
      process.stdout.write('Signing profile removed. Original source files and backups are not deleted.\n');
    } else if (opts.command === 'rekey') {
      let replacement = await newPassphrase();
      try { await vault.rekey(passphrase, replacement); } finally { replacement = ''; }
      process.stdout.write('Vault passphrase changed; all profiles re-encrypted.\n');
    }
  } finally {
    passphrase = '';
    clearProfiles(data);
    if (imported) { imported.keystore = ''; imported.storePassword = ''; imported.keyPassword = ''; }
  }
}
if (require.main === module) main().catch((error) => {
  process.stderr.write(`storebase-keystore: ${error.message}\n`); process.exitCode = 1;
});
module.exports = { parseArguments, main };
