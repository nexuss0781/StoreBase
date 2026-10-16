#!/usr/bin/env node
'use strict';

const { createInterface } = require('node:readline/promises');
const { stdin, stdout } = require('node:process');
const {
  CATEGORIES,
  inspectKeystore,
  releaseApp,
  validateInput,
  verifyApkSignature,
} = require('../lib/publisher');

const OPTION_NAMES = new Set([
  'name', 'avatar', 'version', 'apk', 'category', 'description', 'keystore', 'alias', 'catalog', 'assets-dir',
]);

function parseArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--help' || argument === '-h') return { help: true, options };
    if (!argument.startsWith('--')) throw new Error(`Unexpected argument: ${argument}`);
    const equals = argument.indexOf('=');
    const name = argument.slice(2, equals < 0 ? undefined : equals);
    if (!OPTION_NAMES.has(name)) throw new Error(`Unknown option: --${name}`);
    const value = equals < 0 ? args[++index] : argument.slice(equals + 1);
    if (typeof value !== 'string' || !value.trim() || value.startsWith('--')) {
      throw new Error(`Option --${name} requires a value.`);
    }
    options[name] = value;
  }
  return { help: false, options };
}

function showHelp() {
  stdout.write(`StoreBase app publisher\n\nUsage:\n  storebase-publish [options]\n\nOptions (omitted values are prompted interactively):\n  --name <name>            App name\n  --avatar <file>          PNG, JPEG, or WebP avatar file\n  --version <version>      App version\n  --apk <file>             Signed Android APK\n  --category <category>    One of the 13 StoreBase categories\n  --description <text>     App description\n  --keystore <file>        Signing keystore used for the APK\n  --alias <name>           Private-key alias, if the keystore has multiple\n  --catalog <file>         App-list JSON (default: ./storebase-app-list.json)\n  --assets-dir <directory> Artifact directory (default: next to the catalog)\n  -h, --help               Show this help\n\nThe keystore password is entered in a hidden prompt, or read from\nSTOREBASE_KEYSTORE_PASSWORD for unattended use. It is never accepted as a CLI argument.\n`);
}

function askHidden(label) {
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
    return Promise.reject(new Error('Set STOREBASE_KEYSTORE_PASSWORD in the environment for non-interactive use.'));
  }
  return new Promise((resolve, reject) => {
    let value = '';
    let finished = false;
    const cleanup = () => {
      stdin.removeListener('data', onData);
      try { stdin.setRawMode(false); } catch {}
      stdin.pause();
      stdout.write('\n');
    };
    const finish = (error) => {
      if (finished) return;
      finished = true;
      cleanup();
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk) => {
      for (const character of String(chunk)) {
        if (character === '\u0003') return finish(new Error('Cancelled.'));
        if (character === '\r' || character === '\n') return finish();
        if (character === '\u007f' || character === '\b') value = value.slice(0, -1);
        else if (character >= ' ') value += character;
      }
    };
    stdout.write(`${label}: `);
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();
    stdin.on('data', onData);
  });
}

async function collectInput(options) {
  const required = [
    ['name', 'App name'],
    ['avatar', 'Avatar file path'],
    ['version', 'Version'],
    ['apk', 'APK file path'],
    ['category', 'Category'],
    ['description', 'Description'],
    ['keystore', 'Signed keystore file path'],
  ];
  const missing = required.filter(([key]) => !options[key]);
  if (missing.length && (!stdin.isTTY || !stdout.isTTY)) {
    throw new Error(`Missing required options: ${missing.map(([key]) => `--${key}`).join(', ')}. Prompts require an interactive terminal.`);
  }

  const rl = createInterface({ input: stdin, output: stdout });
  try {
    for (const [key, label] of required) {
      if (!options[key]) {
        if (key === 'category') {
          stdout.write('\nAvailable categories:\n');
          CATEGORIES.forEach((category, index) => stdout.write(`  ${index + 1}. ${category}\n`));
        }
        options[key] = (await rl.question(`${label}${key === 'category' ? ' (number or name)' : ''}: `)).trim();
        if (key === 'category' && /^\d+$/.test(options[key])) {
          const category = CATEGORIES[Number(options[key]) - 1];
          if (category) options[key] = category;
        }
      }
    }
  } finally {
    rl.close();
  }
  return {
    name: options.name,
    avatar: options.avatar,
    version: options.version,
    apk: options.apk,
    category: options.category,
    description: options.description,
    keystore: options.keystore,
    alias: options.alias,
  };
}

async function selectEntry(entries, aliasOption) {
  if (aliasOption) {
    const selected = entries.find((entry) => entry.alias === aliasOption);
    if (!selected) throw new Error(`Keystore alias "${aliasOption}" is not a private-key entry. Available aliases: ${entries.map((entry) => entry.alias).join(', ')}.`);
    return selected;
  }
  if (entries.length === 1) return entries[0];
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error(`Keystore has multiple private-key aliases. Select one with --alias: ${entries.map((entry) => entry.alias).join(', ')}.`);
  }
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    stdout.write(`Keystore private-key aliases: ${entries.map((entry) => entry.alias).join(', ')}\n`);
    const alias = (await rl.question('Signing alias: ')).trim();
    const selected = entries.find((entry) => entry.alias === alias);
    if (!selected) throw new Error(`Unknown signing alias: ${alias}`);
    return selected;
  } finally {
    rl.close();
  }
}

async function main() {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.help) return showHelp();
  const options = parsed.options;
  const rawInput = await collectInput(options);
  const input = await validateInput(rawInput);

  const password = process.env.STOREBASE_KEYSTORE_PASSWORD ?? await askHidden('Keystore password (input hidden)');
  const entries = await inspectKeystore(input.keystorePath, password);
  const entry = await selectEntry(entries, input.alias);
  const certificate = verifyApkSignature(input.apkPath, entry);
  const result = await releaseApp(input, {
    catalogPath: options.catalog,
    assetsDir: options['assets-dir'],
    signingCertificateSha256: certificate,
  });

  stdout.write(`\nRelease complete: ${result.app.name} ${result.app.version}\n`);
  stdout.write(`App list: ${result.catalogPath}\n`);
  stdout.write(`APK: ${result.app.apk}\n`);
  stdout.write(`Avatar: ${result.app.avatar}\n`);
  stdout.write('The keystore was used only to verify the APK signature; it was not copied.\n');
}

main().catch((error) => {
  process.stderr.write(`storebase-publish: ${error.message}\n`);
  process.exitCode = 1;
});
